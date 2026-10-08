import CryptoKit
import Foundation

/// End-to-end encryption (E2EE_SPEC.md; contracts/README.md, "End-to-end encryption"): the
/// certificates that chain a friend's devices to their phone, the key bundle that opens a
/// message on each of the listener's devices, and binary audio format 2. Must make and accept
/// the same bytes as server/src/e2ee.ts; both check contracts/fixtures/e2ee.json.
///
/// Nothing here stores keys or decides what to trust: the apps keep the keys in the Keychain
/// and compare a sender's phone identity key with the ones they've seen for that friend.
public enum E2EE {
    /// Binary audio format 2: format 1's header, the payload encrypted.
    public static let audioFormat: UInt8 = 2
    public static let bundleVersion = 1
    /// A listener plays a message only if its bundle was made at most this long ago by the
    /// listener's clock (a 35 s ring, a 30 s join grace, up to 60 s of queued bursts and a 30 s
    /// resume, plus a minute for clock drift)…
    public static let maxBundleAgeMs: Int64 = 180_000
    /// …and at most this far ahead of it.
    public static let maxClockAheadMs: Int64 = 60_000
    /// How long an encryption key's certificate is good for.
    public static let encryptionKeyLifetimeMs: Int64 = 30 * 86_400_000

    /// RFC 9180 base mode: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305.
    static let ciphersuite = HPKE.Ciphersuite.Curve25519_SHA256_ChachaPoly
    static let keyBytes = 32
    static let signatureBytes = 64
    static let tagBytes = 16

    enum Label {
        static let phone = "oao-phone-v1"
        static let device = "oao-device-v1"
        static let encryptionKey = "oao-enckey-v1"
        static let bundle = "oao-bundle-v1"
        static let messageKey = "oao-message-key-v1"
        static let frames = "oao-frames-v1"
        static let fingerprint = "oao-fingerprint-v1"
    }

    /// Why a bundle, certificate or frame was refused. The server uses the same names.
    public enum Failure: String, Error, Sendable {
        case badBundle = "bad-bundle"
        case badCertificate = "bad-certificate"
        case badSignature = "bad-signature"
        case tooOld = "too-old"
        case fromTheFuture = "from-the-future"
        case noKey = "no-key"
        case decrypt
    }

    /// An encryption key's ID: the first 8 bytes of its SHA-256, in hex.
    public static func keyId(_ encryptionKey: Data) -> String {
        SHA256.hash(data: encryptionKey).prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    /// What people compare, and what invite links carry: the first 16 bytes of SHA-256 over the
    /// context and a phone identity key, base64url without padding (22 characters).
    public static func fingerprint(_ identityKey: Data) -> String {
        var hash = SHA256()
        hash.update(data: Wire.Writer().string(Label.fingerprint).data)
        hash.update(data: identityKey)
        return Data(hash.finalize().prefix(16)).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func verify(_ signature: Data, of body: Data, by publicKey: Data) -> Bool {
        guard publicKey.count == keyBytes, signature.count == signatureBytes,
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey) else { return false }
        return key.isValidSignature(signature, for: body)
    }
}

// MARK: Byte strings

/// Signed and sealed bytes are built from these, never from JSON: a context string, then
/// length-prefixed fields (uint16 big-endian lengths), uint64 big-endian times.
enum Wire {
    struct Writer {
        private(set) var data = Data()

        func string(_ value: String) -> Writer { bytes(Data(value.utf8)) }

        func bytes(_ value: Data) -> Writer {
            precondition(value.count <= 0xFFFF, "field too long")
            return u16(UInt16(value.count)).raw(value)
        }

        func u8(_ value: UInt8) -> Writer { raw(Data([value])) }
        func u16(_ value: UInt16) -> Writer { raw(withUnsafeBytes(of: value.bigEndian) { Data($0) }) }
        func u64(_ value: Int64) -> Writer { raw(withUnsafeBytes(of: UInt64(value).bigEndian) { Data($0) }) }

        func raw(_ value: Data) -> Writer {
            var next = self
            next.data.append(value)
            return next
        }
    }

    struct Reader {
        private let data: Data
        private var offset: Int

        init(_ data: Data) {
            self.data = data
            offset = data.startIndex
        }

        var isAtEnd: Bool { offset == data.endIndex }

        private mutating func take(_ count: Int) throws -> Data {
            guard count <= data.endIndex - offset else { throw E2EE.Failure.badCertificate }
            defer { offset += count }
            return Data(data[offset ..< offset + count])
        }

        mutating func bytes() throws -> Data {
            let length = try take(2).reduce(0) { $0 << 8 | Int($1) }
            return try take(length)
        }

        mutating func key() throws -> Data {
            let key = try bytes()
            guard key.count == E2EE.keyBytes else { throw E2EE.Failure.badCertificate }
            return key
        }

        mutating func string() throws -> String {
            guard let value = String(data: try bytes(), encoding: .utf8) else { throw E2EE.Failure.badCertificate }
            return value
        }

        mutating func u64() throws -> Int64 {
            let value = try take(8).reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
            guard value <= UInt64(Int64.max) else { throw E2EE.Failure.badCertificate }
            return Int64(value)
        }
    }

    /// A certificate's body (its context checked) and signature.
    static func open(_ raw: Data, context: String) throws -> (body: Data, signature: Data, reader: Reader) {
        guard raw.count > E2EE.signatureBytes else { throw E2EE.Failure.badCertificate }
        let body = Data(raw.prefix(raw.count - E2EE.signatureBytes))
        var reader = Reader(body)
        guard try reader.string() == context else { throw E2EE.Failure.badCertificate }
        return (body, Data(raw.suffix(E2EE.signatureBytes)), reader)
    }

    static func finish(_ reader: Reader, body: Data, signature: Data, key: Data) throws {
        guard reader.isAtEnd, E2EE.verify(signature, of: body, by: key) else { throw E2EE.Failure.badCertificate }
    }
}

// MARK: Certificates

/// A phone's identity, self-signed. A friend's "security code" covers their phones' identity keys.
public struct PhoneCertificate: Sendable, Equatable {
    public let userId: String
    public let deviceId: String
    public let identityKey: Data
    public let issuedAt: Int64
    public let raw: Data

    public init(raw: Data) throws {
        let opened = try Wire.open(raw, context: E2EE.Label.phone)
        var reader = opened.reader
        userId = try reader.string()
        deviceId = try reader.string()
        identityKey = try reader.key()
        issuedAt = try reader.u64()
        self.raw = raw
        try Wire.finish(reader, body: opened.body, signature: opened.signature, key: identityKey)
    }

    public static func issue(identity: Curve25519.Signing.PrivateKey, userId: String, deviceId: String, issuedAt: Int64) throws -> PhoneCertificate {
        let body = Wire.Writer().string(E2EE.Label.phone).string(userId).string(deviceId)
            .bytes(identity.publicKey.rawRepresentation).u64(issuedAt).data
        return try PhoneCertificate(raw: body + identity.signature(for: body))
    }
}

/// A device's signing key, certified by one of the account's phones (a phone certifies itself
/// and its watches).
public struct DeviceCertificate: Sendable, Equatable {
    public let userId: String
    public let deviceId: String
    public let clientKind: String
    public let signingKey: Data
    public let issuerKey: Data
    public let issuedAt: Int64
    public let raw: Data

    /// Checks `phone` issued it, for the same account.
    public init(raw: Data, issuer phone: PhoneCertificate) throws {
        let opened = try Wire.open(raw, context: E2EE.Label.device)
        var reader = opened.reader
        userId = try reader.string()
        deviceId = try reader.string()
        clientKind = try reader.string()
        signingKey = try reader.key()
        issuerKey = try reader.key()
        issuedAt = try reader.u64()
        self.raw = raw
        guard issuerKey == phone.identityKey, userId == phone.userId else { throw E2EE.Failure.badCertificate }
        try Wire.finish(reader, body: opened.body, signature: opened.signature, key: phone.identityKey)
    }

    public static func issue(
        identity: Curve25519.Signing.PrivateKey, phone: PhoneCertificate,
        deviceId: String, clientKind: String, signingKey: Data, issuedAt: Int64
    ) throws -> DeviceCertificate {
        let body = Wire.Writer().string(E2EE.Label.device).string(phone.userId).string(deviceId).string(clientKind)
            .bytes(signingKey).bytes(identity.publicKey.rawRepresentation).u64(issuedAt).data
        return try DeviceCertificate(raw: body + identity.signature(for: body), issuer: phone)
    }
}

/// A device's current encryption key, signed by the device. Rotated weekly; good for 30 days.
public struct EncryptionKeyCertificate: Sendable, Equatable {
    public let userId: String
    public let deviceId: String
    public let encryptionKey: Data
    public let keyId: String
    public let issuedAt: Int64
    public let notAfter: Int64
    public let raw: Data

    /// Checks `device` signed it, for the same account and device.
    public init(raw: Data, device: DeviceCertificate) throws {
        let opened = try Wire.open(raw, context: E2EE.Label.encryptionKey)
        var reader = opened.reader
        userId = try reader.string()
        deviceId = try reader.string()
        encryptionKey = try reader.key()
        keyId = E2EE.keyId(encryptionKey)
        issuedAt = try reader.u64()
        notAfter = try reader.u64()
        self.raw = raw
        guard userId == device.userId, deviceId == device.deviceId else { throw E2EE.Failure.badCertificate }
        try Wire.finish(reader, body: opened.body, signature: opened.signature, key: device.signingKey)
    }

    public static func issue(
        signingKey: Curve25519.Signing.PrivateKey, device: DeviceCertificate, encryptionKey: Data,
        issuedAt: Int64, notAfter: Int64? = nil
    ) throws -> EncryptionKeyCertificate {
        let body = Wire.Writer().string(E2EE.Label.encryptionKey).string(device.userId).string(device.deviceId)
            .bytes(encryptionKey).u64(issuedAt).u64(notAfter ?? issuedAt + E2EE.encryptionKeyLifetimeMs).data
        return try EncryptionKeyCertificate(raw: body + signingKey.signature(for: body), device: device)
    }
}

// MARK: A friend's keys

/// A friend's keys as the friends list (and a keys-stale refusal) gives them.
public struct FriendKeys: Codable, Sendable, Equatable {
    public struct Device: Codable, Sendable, Equatable {
        public var deviceId: String
        public var clientKind: String
        public var deviceCert: Data
        public var encCert: Data
    }

    public var phones: [Data]
    public var devices: [Device]
}

/// A device a message key can be sealed to.
public struct RecipientKey: Sendable, Equatable {
    public let deviceId: String
    public let keyId: String
    public let encryptionKey: Data
    public let notAfter: Int64
}

extension E2EE {
    /// What a sender can seal to: every device whose chain checks out (its certificate from one
    /// of the account's phones, its encryption key from the device) and whose key hasn't
    /// expired. A device that doesn't check out is left out, so it can't stop a message to the
    /// others.
    public static func usableKeys(of userId: String, _ keys: FriendKeys, now: Int64) -> (phones: [PhoneCertificate], recipients: [RecipientKey]) {
        let phones = keys.phones.compactMap { try? PhoneCertificate(raw: $0) }.filter { $0.userId == userId }
        let recipients = keys.devices.compactMap { device -> RecipientKey? in
            for phone in phones {
                guard let cert = try? DeviceCertificate(raw: device.deviceCert, issuer: phone) else { continue }
                guard cert.deviceId == device.deviceId,
                      let enc = try? EncryptionKeyCertificate(raw: device.encCert, device: cert),
                      enc.notAfter > now else { return nil }
                return RecipientKey(deviceId: device.deviceId, keyId: enc.keyId, encryptionKey: enc.encryptionKey, notAfter: enc.notAfter)
            }
            return nil
        }
        return (phones, recipients)
    }
}

// MARK: The key bundle

/// Sent with talk-start and given to each listener with burst-start: the message key sealed to
/// each of the listener's devices, and the sender's signature over all of it.
public struct KeyBundle: Codable, Sendable, Equatable {
    public struct Sender: Codable, Sendable, Equatable {
        public var deviceId: String
        public var phoneCert: Data
        public var deviceCert: Data
    }

    public struct Entry: Codable, Sendable, Equatable {
        public var deviceId: String
        public var keyId: String
        public var enc: Data
        public var ct: Data
    }

    public var v: Int
    public var sender: Sender
    public var keys: [Entry]
    public var sentAt: Int64
    public var sig: Data
}

/// What a bundle's signature binds it to.
public struct BundleContext: Sendable, Equatable {
    public var conversationId: String
    public var burstId: String
    public var codec: String
    /// The sender's account.
    public var from: String
    /// The listener's account.
    public var to: String

    public init(conversationId: String, burstId: String, codec: String, from: String, to: String) {
        self.conversationId = conversationId
        self.burstId = burstId
        self.codec = codec
        self.from = from
        self.to = to
    }
}

/// This device as a sender.
public struct SenderIdentity: Sendable {
    public let userId: String
    public let deviceId: String
    public let phoneCertificate: PhoneCertificate
    public let deviceCertificate: DeviceCertificate
    public let signingKey: Curve25519.Signing.PrivateKey

    public init(phoneCertificate: PhoneCertificate, deviceCertificate: DeviceCertificate, signingKey: Curve25519.Signing.PrivateKey) {
        userId = deviceCertificate.userId
        deviceId = deviceCertificate.deviceId
        self.phoneCertificate = phoneCertificate
        self.deviceCertificate = deviceCertificate
        self.signingKey = signingKey
    }
}

/// A bundle this device has checked and opened.
public struct OpenedBundle: Sendable {
    /// The sender's phone identity key: compared with the keys seen for this friend (a new one
    /// is the "security code changed" notice).
    public let senderIdentityKey: Data
    public let senderDeviceId: String
    public let cipher: FrameCipher
}

extension E2EE {
    static func messageKeyInfo(burstId: String, deviceId: String, keyId: String) -> Data {
        Wire.Writer().string(Label.messageKey).string(burstId).string(deviceId).string(keyId).data
    }

    static func signingBytes(_ context: BundleContext, sentAt: Int64, senderDeviceId: String, keys: [KeyBundle.Entry]) -> Data {
        var writer = Wire.Writer().string(Label.bundle).string(context.conversationId).string(context.burstId)
            .u8(audioFormat).string(context.codec).u64(sentAt).string(context.from).string(senderDeviceId)
            .string(context.to).u16(UInt16(keys.count))
        for key in keys {
            writer = writer.string(key.deviceId).string(key.keyId).bytes(key.enc).bytes(key.ct)
        }
        return writer.data
    }

    /// Seals a new message key to each recipient device and signs the bundle.
    public static func seal(_ context: BundleContext, from sender: SenderIdentity, to recipients: [RecipientKey], sentAt: Int64) throws -> (bundle: KeyBundle, cipher: FrameCipher) {
        precondition(sender.userId == context.from, "the sender isn't the bundle's sender")
        let messageKey = SymmetricKey(size: .bits256)
        let keyBytes = messageKey.withUnsafeBytes { Data($0) }
        let keys = try recipients.map { recipient in
            let publicKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: recipient.encryptionKey)
            var hpke = try HPKE.Sender(recipientKey: publicKey, ciphersuite: ciphersuite,
                                       info: messageKeyInfo(burstId: context.burstId, deviceId: recipient.deviceId, keyId: recipient.keyId))
            let ct = try hpke.seal(keyBytes, authenticating: Data())
            return KeyBundle.Entry(deviceId: recipient.deviceId, keyId: recipient.keyId, enc: hpke.encapsulatedKey, ct: ct)
        }
        let signature = try sender.signingKey.signature(for: signingBytes(context, sentAt: sentAt, senderDeviceId: sender.deviceId, keys: keys))
        let bundle = KeyBundle(
            v: bundleVersion,
            sender: .init(deviceId: sender.deviceId, phoneCert: sender.phoneCertificate.raw, deviceCert: sender.deviceCertificate.raw),
            keys: keys, sentAt: sentAt, sig: signature
        )
        return (bundle, FrameCipher(messageKey: keyBytes, burstId: context.burstId))
    }

    /// Checks a bundle for this device and opens its message key. `keys` maps this device's key
    /// IDs (its current and previous encryption keys) to their private keys.
    public static func open(
        _ bundle: KeyBundle, _ context: BundleContext, deviceId: String,
        keys: [String: Curve25519.KeyAgreement.PrivateKey], now: Int64
    ) throws -> OpenedBundle {
        guard bundle.v == bundleVersion else { throw Failure.badBundle }
        let phone = try PhoneCertificate(raw: bundle.sender.phoneCert)
        guard phone.userId == context.from else { throw Failure.badCertificate }
        let device = try DeviceCertificate(raw: bundle.sender.deviceCert, issuer: phone)
        guard device.deviceId == bundle.sender.deviceId else { throw Failure.badCertificate }
        let signed = signingBytes(context, sentAt: bundle.sentAt, senderDeviceId: bundle.sender.deviceId, keys: bundle.keys)
        guard verify(bundle.sig, of: signed, by: device.signingKey) else { throw Failure.badSignature }
        guard now - bundle.sentAt <= maxBundleAgeMs else { throw Failure.tooOld }
        guard bundle.sentAt - now <= maxClockAheadMs else { throw Failure.fromTheFuture }
        guard let entry = bundle.keys.first(where: { $0.deviceId == deviceId }), let key = keys[entry.keyId] else { throw Failure.noKey }
        let messageKey: Data
        do {
            var hpke = try HPKE.Recipient(privateKey: key, ciphersuite: ciphersuite,
                                          info: messageKeyInfo(burstId: context.burstId, deviceId: deviceId, keyId: entry.keyId),
                                          encapsulatedKey: entry.enc)
            messageKey = try hpke.open(entry.ct, authenticating: Data())
        } catch {
            throw Failure.decrypt
        }
        guard messageKey.count == keyBytes else { throw Failure.decrypt }
        return OpenedBundle(senderIdentityKey: phone.identityKey, senderDeviceId: device.deviceId,
                            cipher: FrameCipher(messageKey: messageKey, burstId: context.burstId))
    }
}

// MARK: Frames (binary audio format 2)

/// Encrypts and decrypts one message's frames.
///
///     byte 0      codec (as format 1)
///     bytes 1..4  sequence number, uint32 big-endian (as format 1)
///     bytes 5..   ChaCha20-Poly1305 of the payload, then its 16-byte tag
///
/// Key: HKDF-SHA256 of the message key (no salt, info "oao-frames-v1"). Nonce: 8 zero bytes and
/// the sequence number. Additional data: the format (2), the codec, the sequence number and the
/// burst ID, so a frame can't be moved to another place or burst.
public struct FrameCipher: Sendable {
    private let key: SymmetricKey
    private let burstId: Data

    init(messageKey: Data, burstId: String) {
        key = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: messageKey),
                                     info: Data(E2EE.Label.frames.utf8), outputByteCount: E2EE.keyBytes)
        self.burstId = Data(burstId.utf8)
    }

    private func nonceAndAAD(codec: UInt8, seq: UInt32) throws -> (ChaChaPoly.Nonce, Data) {
        let seqBytes = withUnsafeBytes(of: seq.bigEndian) { Data($0) }
        return (try ChaChaPoly.Nonce(data: Data(count: 8) + seqBytes), Data([E2EE.audioFormat, codec]) + seqBytes + burstId)
    }

    /// A whole format 2 frame.
    public func seal(codec: VoiceFrame.Codec, seq: UInt32, payload: Data) throws -> Data {
        let (nonce, aad) = try nonceAndAAD(codec: codec.rawValue, seq: seq)
        let box = try ChaChaPoly.seal(payload, using: key, nonce: nonce, authenticating: aad)
        return VoiceFrame.encode(codec: codec, seq: seq, payload: box.ciphertext + box.tag)
    }

    /// The frame's codec, sequence number and decrypted payload.
    public func open(_ frame: Data) throws -> (codec: VoiceFrame.Codec, seq: UInt32, payload: Data) {
        guard frame.count >= VoiceFrame.headerBytes + E2EE.tagBytes, let (codec, seq, sealed) = VoiceFrame.decode(frame) else {
            throw E2EE.Failure.decrypt
        }
        do {
            let (nonce, aad) = try nonceAndAAD(codec: codec.rawValue, seq: seq)
            let box = try ChaChaPoly.SealedBox(nonce: nonce, ciphertext: sealed.prefix(sealed.count - E2EE.tagBytes),
                                               tag: sealed.suffix(E2EE.tagBytes))
            return (codec, seq, try ChaChaPoly.open(box, using: key, authenticating: aad))
        } catch {
            throw E2EE.Failure.decrypt
        }
    }
}
