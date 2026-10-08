import CryptoKit
import Foundation
import Testing
@testable import OverAndOutKit

/// End-to-end encryption: CryptoKit's HPKE against RFC 9180, the shared vectors the server also
/// checks (contracts/fixtures/e2ee.json, made by server/tools/e2ee-vectors.ts), and a round trip
/// sealed here.
struct E2EETests {
    struct Vectors: Decodable {
        struct Limits: Decodable { let maxBundleAgeMs: Int64; let maxClockAheadMs: Int64 }
        struct HPKEVector: Decodable { let skR, pkR, info, enc, aad, pt, ct: String }
        struct Account: Decodable {
            struct Device: Decodable {
                let name, deviceId, clientKind, signingSeed, encSecret, encKey, keyId: String
                let deviceCert, encCert: Data
            }
            let name, userId, identitySeed, identityKey, fingerprint: String
            let phoneCert: Data
            let devices: [Device]
        }
        struct Context: Decodable {
            let conversationId, burstId, codec, from, to: String
            var bundleContext: BundleContext { BundleContext(conversationId: conversationId, burstId: burstId, codec: codec, from: from, to: to) }
        }
        struct FriendKeysVector: Decodable { let userId: String; let keys: FriendKeys; let usableDeviceIds: [String] }
        struct Frame: Decodable { let seq: UInt32; let payload: String; let frame: String }
        struct Message: Decodable {
            let context: Context
            let messageKey: String
            let bundle: KeyBundle
            let recipients: [String]
            let frames: [Frame]
        }
        struct Bad: Decodable {
            struct Opener: Decodable { let deviceId: String; let keys: [String: String] }
            let name, failure: String
            let context: Context
            let now: Int64
            let open: Opener
            let bundle: KeyBundle
        }
        struct BadFrame: Decodable { let name, failure, frame: String }

        let limits: Limits
        let hpke: HPKEVector
        let now: Int64
        let accounts: [Account]
        let friendKeys: FriendKeysVector
        let message: Message
        let bad: [Bad]
        let badFrames: [BadFrame]
    }

    static func vectors() throws -> Vectors {
        try JSONDecoder().decode(Vectors.self, from: ContractTests.data("fixtures/e2ee.json"))
    }

    @Test func hpkeMatchesRFC9180() throws {
        let v = try Self.vectors().hpke
        let key = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(v.skR))
        #expect(key.publicKey.rawRepresentation == hex(v.pkR))
        var recipient = try HPKE.Recipient(privateKey: key, ciphersuite: E2EE.ciphersuite, info: hex(v.info), encapsulatedKey: hex(v.enc))
        #expect(try recipient.open(hex(v.ct), authenticating: hex(v.aad)) == hex(v.pt))
    }

    @Test func limitsMatchTheServer() throws {
        let v = try Self.vectors()
        #expect(v.limits.maxBundleAgeMs == E2EE.maxBundleAgeMs)
        #expect(v.limits.maxClockAheadMs == E2EE.maxClockAheadMs)
    }

    @Test func certificatesFingerprintsAndKeyIdsMatch() throws {
        for account in try Self.vectors().accounts {
            let phone = try PhoneCertificate(raw: account.phoneCert)
            #expect(phone.userId == account.userId)
            #expect(phone.identityKey == hex(account.identityKey))
            #expect(try Curve25519.Signing.PrivateKey(rawRepresentation: hex(account.identitySeed)).publicKey.rawRepresentation == phone.identityKey)
            #expect(E2EE.fingerprint(phone.identityKey) == account.fingerprint)
            for d in account.devices {
                let device = try DeviceCertificate(raw: d.deviceCert, issuer: phone)
                #expect(device.deviceId == d.deviceId && device.clientKind == d.clientKind)
                #expect(try Curve25519.Signing.PrivateKey(rawRepresentation: hex(d.signingSeed)).publicKey.rawRepresentation == device.signingKey)
                let enc = try EncryptionKeyCertificate(raw: d.encCert, device: device)
                #expect(enc.encryptionKey == hex(d.encKey))
                #expect(enc.keyId == d.keyId)
                #expect(E2EE.keyId(try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(d.encSecret)).publicKey.rawRepresentation) == d.keyId)
            }
        }
    }

    @Test func aSenderSealsOnlyToDevicesThatCheckOut() throws {
        let v = try Self.vectors()
        let usable = E2EE.usableKeys(of: v.friendKeys.userId, v.friendKeys.keys, now: v.now)
        #expect(usable.recipients.map(\.deviceId) == v.friendKeys.usableDeviceIds)
        #expect(usable.phones.count == 1)
        #expect(E2EE.usableKeys(of: "u_someoneElse", v.friendKeys.keys, now: v.now).recipients.isEmpty)
    }

    @Test func theVectorMessageOpensOnEachRecipientAndItsFramesDecrypt() throws {
        let v = try Self.vectors()
        let devices = Dictionary(uniqueKeysWithValues: v.accounts.flatMap(\.devices).map { ($0.name, $0) })
        let sender = try #require(v.accounts.first { $0.userId == v.message.context.from })
        for name in v.message.recipients {
            let device = try #require(devices[name])
            let key = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(device.encSecret))
            let opened = try E2EE.open(v.message.bundle, v.message.context.bundleContext, deviceId: device.deviceId,
                                       keys: [device.keyId: key], now: v.now)
            #expect(opened.senderIdentityKey == hex(sender.identityKey))
            for frame in v.message.frames {
                let decrypted = try opened.cipher.open(hex(frame.frame))
                #expect(decrypted.codec == .opus16k && decrypted.seq == frame.seq && decrypted.payload == hex(frame.payload))
            }
            for bad in v.badFrames {
                #expect(failure { _ = try opened.cipher.open(hex(bad.frame)) } == bad.failure, "\(bad.name)")
            }
        }
        // The same message key makes the same frames here as on the server.
        let cipher = FrameCipher(messageKey: hex(v.message.messageKey), burstId: v.message.context.burstId)
        let first = try #require(v.message.frames.first)
        #expect(try cipher.seal(codec: .opus16k, seq: first.seq, payload: hex(first.payload)) == hex(first.frame))
    }

    @Test func refusedBundlesAreRefusedForTheSameReason() throws {
        for bad in try Self.vectors().bad {
            let keys = try bad.open.keys.mapValues { try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex($0)) }
            let got = failure { _ = try E2EE.open(bad.bundle, bad.context.bundleContext, deviceId: bad.open.deviceId, keys: keys, now: bad.now) }
            #expect(got == bad.failure, "\(bad.name)")
        }
    }

    /// Made here, end to end: a phone certifies itself and its watch; the watch seals to a
    /// friend's two devices; each opens it; a bundle older than the limit is refused.
    @Test func aBundleSealedHereOpensOnEachRecipient() throws {
        let now: Int64 = 1_791_400_000_000
        func account(_ userId: String, _ kinds: [String]) throws -> (phone: PhoneCertificate, devices: [(id: String, cert: DeviceCertificate, signing: Curve25519.Signing.PrivateKey, enc: Curve25519.KeyAgreement.PrivateKey, encCert: EncryptionKeyCertificate)]) {
            let identity = Curve25519.Signing.PrivateKey()
            let phone = try PhoneCertificate.issue(identity: identity, userId: userId, deviceId: "\(userId)-0", issuedAt: now)
            let devices = try kinds.enumerated().map { i, kind in
                let signing = Curve25519.Signing.PrivateKey()
                let enc = Curve25519.KeyAgreement.PrivateKey()
                let cert = try DeviceCertificate.issue(identity: identity, phone: phone, deviceId: "\(userId)-\(i)", clientKind: kind,
                                                       signingKey: signing.publicKey.rawRepresentation, issuedAt: now)
                let encCert = try EncryptionKeyCertificate.issue(signingKey: signing, device: cert, encryptionKey: enc.publicKey.rawRepresentation, issuedAt: now)
                return (id: "\(userId)-\(i)", cert: cert, signing: signing, enc: enc, encCert: encCert)
            }
            return (phone, devices)
        }
        let alice = try account("u_alice", ["ios", "watchos"])
        let bob = try account("u_bob", ["ios", "watchos"])
        let bobKeys = FriendKeys(phones: [bob.phone.raw], devices: bob.devices.map {
            FriendKeys.Device(deviceId: $0.id, clientKind: $0.cert.clientKind, deviceCert: $0.cert.raw, encCert: $0.encCert.raw)
        })
        let recipients = E2EE.usableKeys(of: "u_bob", bobKeys, now: now).recipients
        #expect(recipients.count == 2)

        let watch = alice.devices[1]
        let sender = SenderIdentity(phoneCertificate: alice.phone, deviceCertificate: watch.cert, signingKey: watch.signing)
        let context = BundleContext(conversationId: "c1", burstId: "b1", codec: "opus16k", from: "u_alice", to: "u_bob")
        let (bundle, cipher) = try E2EE.seal(context, from: sender, to: recipients, sentAt: now)
        let payload = Data((0..<60).map { UInt8($0) })
        let frame = try cipher.seal(codec: .opus16k, seq: 3, payload: payload)
        #expect(frame.count == VoiceFrame.headerBytes + 60 + 16)

        // Through JSON, as the relay carries it.
        let carried = try JSONDecoder().decode(KeyBundle.self, from: JSONEncoder().encode(bundle))
        for device in bob.devices {
            let opened = try E2EE.open(carried, context, deviceId: device.id, keys: [device.encCert.keyId: device.enc], now: now + 1_000)
            #expect(opened.senderIdentityKey == alice.phone.identityKey)
            #expect(opened.senderDeviceId == watch.id)
            #expect(try opened.cipher.open(frame).payload == payload)
        }
        let bobPhone = bob.devices[0]
        #expect(failure { _ = try E2EE.open(carried, context, deviceId: bobPhone.id, keys: [bobPhone.encCert.keyId: bobPhone.enc], now: now + E2EE.maxBundleAgeMs + 1) } == "too-old")
        #expect(failure { _ = try E2EE.open(carried, context, deviceId: bobPhone.id, keys: [:], now: now) } == "no-key")
    }

    @Test func anExpiredKeyIsntSealedTo() throws {
        let now: Int64 = 1_791_400_000_000
        let identity = Curve25519.Signing.PrivateKey()
        let signing = Curve25519.Signing.PrivateKey()
        let phone = try PhoneCertificate.issue(identity: identity, userId: "u_bob", deviceId: "p", issuedAt: now)
        let cert = try DeviceCertificate.issue(identity: identity, phone: phone, deviceId: "p", clientKind: "ios",
                                               signingKey: signing.publicKey.rawRepresentation, issuedAt: now)
        let expired = try EncryptionKeyCertificate.issue(signingKey: signing, device: cert,
                                                         encryptionKey: Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation,
                                                         issuedAt: now - 31 * 86_400_000)
        #expect(expired.notAfter == expired.issuedAt + E2EE.encryptionKeyLifetimeMs)
        let keys = FriendKeys(phones: [phone.raw], devices: [.init(deviceId: "p", clientKind: "ios", deviceCert: cert.raw, encCert: expired.raw)])
        #expect(E2EE.usableKeys(of: "u_bob", keys, now: now).recipients.isEmpty)
    }

    private func failure(_ body: () throws -> Void) -> String {
        do {
            try body()
            return "none"
        } catch let failure as E2EE.Failure {
            return failure.rawValue
        } catch {
            return "\(error)"
        }
    }

    private func hex(_ string: String) -> Data {
        var data = Data(capacity: string.count / 2)
        var index = string.startIndex
        while index < string.endIndex {
            let next = string.index(index, offsetBy: 2)
            data.append(UInt8(string[index ..< next], radix: 16)!)
            index = next
        }
        return data
    }
}
