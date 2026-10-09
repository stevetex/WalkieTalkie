import Foundation
import Testing
@testable import OverAndOutKit

@MainActor
struct E2EEFlowTests {
    @Test func phoneIdentitySurvivesSameAccountSignInAndKeysRotate() throws {
        let store = E2EEKeyStore(service: "oao-e2ee-test-\(UUID().uuidString)")
        let now: Int64 = 1_791_000_000_000
        defer { store.signOut(userId: "u_alice", keepPhoneIdentity: false) }
        let first = try store.preparePhone(userId: "u_alice", deviceId: "alice-phone", now: now)
        let phone = try PhoneCertificate(raw: first.phoneCert!)
        let second = try store.preparePhone(userId: "u_alice", deviceId: "alice-phone", now: now + 7 * 86_400_000 + 1)
        #expect(first.encCert != second.encCert)
        #expect(try store.decryptionKeys(userId: "u_alice", deviceId: "alice-phone", now: now + 7 * 86_400_000 + 1).count == 2)
        store.signOut(userId: "u_alice", keepPhoneIdentity: true)
        let third = try store.preparePhone(userId: "u_alice", deviceId: "alice-phone", now: now + 7 * 86_400_000 + 2)
        #expect(try PhoneCertificate(raw: third.phoneCert!).identityKey == phone.identityKey)
        #expect(first.deviceCert != third.deviceCert)
    }

    @Test func sealedFramesReplayAndDowngrade() throws {
        let alice = E2EEKeyStore(service: "oao-e2ee-test-\(UUID().uuidString)")
        let bob = E2EEKeyStore(service: "oao-e2ee-test-\(UUID().uuidString)")
        let suite = "oao-e2ee-trust-test-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer {
            alice.signOut(userId: "u_alice", keepPhoneIdentity: false)
            bob.signOut(userId: "u_bob", keepPhoneIdentity: false)
            defaults.removePersistentDomain(forName: suite)
        }
        let now: Int64 = 1_791_000_000_000
        let a = try alice.preparePhone(userId: "u_alice", deviceId: "alice-phone", now: now)
        let b = try bob.preparePhone(userId: "u_bob", deviceId: "bob-phone", now: now)
        let trust = E2EETrust(defaults: defaults)
        let bobKeys = FriendKeys(phones: [b.phoneCert!], devices: [
            .init(deviceId: "bob-phone", clientKind: "ios", deviceCert: b.deviceCert, encCert: b.encCert)
        ], allDevicesHaveKeys: true)
        _ = trust.update(account: "u_alice", friend: "u_bob", keys: bobKeys, now: now)
        let sender = E2EEFlow(store: alice, trust: trust, deviceId: "alice-phone", userId: { "u_alice" })
        let receiver = E2EEFlow(store: bob, trust: trust, deviceId: "bob-phone",
                                replayDefaults: defaults, userId: { "u_bob" })
        // Format 1 is retired: a friend without keys (never seen, or none listed) can't be
        // talked to, and nothing goes out unsealed.
        let legacy = FriendKeys(phones: [], devices: [], allDevicesHaveKeys: false)
        #expect(throws: E2EEFlow.FlowError.noCurrentKey) {
            try sender.start(peer: "u_legacy", conversationId: nil, burstId: "old", codec: "opus16k", keys: legacy, now: now)
        }
        #expect(throws: E2EEFlow.FlowError.noCurrentKey) {
            try sender.start(peer: "u_stranger", conversationId: nil, burstId: "old", codec: "opus16k", now: now)
        }
        #expect(throws: E2EEFlow.FlowError.noCurrentKey) {
            try sender.send(VoiceFrame.encode(codec: .opus16k, seq: 0, payload: Data(repeating: 0x55, count: 60)))
        }
        var incomplete = bobKeys
        incomplete.allDevicesHaveKeys = false
        #expect(throws: E2EEFlow.FlowError.noCurrentKey) {
            try sender.start(peer: "u_bob", conversationId: nil, burstId: "partial",
                             codec: "opus16k", keys: incomplete, now: now)
        }
        let started = try sender.start(peer: "u_bob", conversationId: nil, burstId: "burst-a",
                                       codec: "opus16k", keys: bobKeys, now: now)
        var start = started.control
        start["type"] = "burst-start"
        start["from"] = "u_alice"
        let message = try JSONDecoder().decode(RelayMessage.self, from: JSONSerialization.data(withJSONObject: start))
        #expect(try receiver.receive(message, peer: "u_alice", conversationId: started.conversationId, now: now))
        var oversized = start
        oversized["burstId"] = String(repeating: "x", count: 65_536)
        let oversizedMessage = try JSONDecoder().decode(RelayMessage.self, from: JSONSerialization.data(withJSONObject: oversized))
        #expect(throws: E2EEFlow.FlowError.missingBundle) {
            try receiver.receive(oversizedMessage, peer: "u_alice", conversationId: started.conversationId, now: now)
        }
        #expect(try receiver.receive(message, peer: "u_alice", conversationId: started.conversationId, now: now))
        let frame = VoiceFrame.encode(codec: .opus16k, seq: 0, payload: Data(repeating: 0x55, count: 60))
        let sealed = try sender.send(frame)
        #expect(try receiver.open(sealed, burstId: "burst-a", now: now) == frame)
        #expect(try receiver.open(sealed, burstId: "burst-a", now: now) == nil)
        #expect(try receiver.receive(message, peer: "u_alice", conversationId: started.conversationId, now: now))
        #expect(try receiver.open(sealed, burstId: "burst-a", now: now) == nil)
        let restarted = E2EEFlow(store: bob, trust: trust, deviceId: "bob-phone",
                                 replayDefaults: defaults, userId: { "u_bob" })
        #expect(try restarted.receive(message, peer: "u_alice", conversationId: started.conversationId, now: now))
        #expect(try restarted.open(sealed, burstId: "burst-a", now: now) == nil)
        let second = VoiceFrame.encode(codec: .opus16k, seq: 1, payload: Data(repeating: 0x66, count: 60))
        #expect(try restarted.open(sender.send(second), burstId: "burst-a", now: now) == second)
        var tampered = sealed
        tampered[tampered.index(after: tampered.startIndex)] ^= 1
        #expect(throws: E2EE.Failure.decrypt) {
            try receiver.open(tampered, burstId: "burst-a", now: now)
        }
        _ = trust.observeSender(account: "u_bob", friend: "u_alice",
                                identityKey: try PhoneCertificate(raw: a.phoneCert!).identityKey, now: now)
        let plain = try JSONDecoder().decode(RelayMessage.self,
            from: Data(#"{"type":"burst-start","burstId":"plain","format":1}"#.utf8))
        // Never played, even from a friend whose keys this device hasn't seen.
        #expect(throws: E2EEFlow.FlowError.downgrade) {
            try receiver.receive(plain, peer: "u_carol", conversationId: started.conversationId, now: now)
        }
        #expect(throws: E2EEFlow.FlowError.missingBundle) {
            try receiver.open(frame, burstId: "plain", now: now)
        }
        #expect(throws: E2EEFlow.FlowError.downgrade) {
            try receiver.receive(plain, peer: "u_alice", conversationId: started.conversationId, now: now)
        }
        defaults.set(Data("damaged".utf8), forKey: "e2ee-trust-v1-u_bob")
        #expect(throws: E2EEFlow.FlowError.downgrade) {
            try receiver.receive(plain, peer: "u_alice", conversationId: started.conversationId, now: now)
        }
        let unknown = try JSONDecoder().decode(RelayMessage.self,
            from: Data(#"{"type":"burst-start","burstId":"unknown","format":3}"#.utf8))
        #expect(throws: E2EEFlow.FlowError.invalidFormat) {
            try receiver.receive(unknown, peer: "u_alice", conversationId: started.conversationId, now: now)
        }
        trust.missingKeys(account: "u_alice", friend: "u_bob")
        #expect(throws: E2EEFlow.FlowError.noCurrentKey) {
            try sender.start(peer: "u_bob", conversationId: nil, burstId: "missing",
                             codec: "opus16k", now: now)
        }
    }

    @Test func aDeviceWithoutACurrentKeyIsLeftOutAndNoneLeftFails() throws {
        let alice = E2EEKeyStore(service: "oao-e2ee-test-\(UUID().uuidString)")
        let bob = E2EEKeyStore(service: "oao-e2ee-test-\(UUID().uuidString)")
        let bobOld = E2EEKeyStore(service: "oao-e2ee-test-\(UUID().uuidString)")
        let suite = "oao-e2ee-trust-test-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer {
            alice.signOut(userId: "u_alice", keepPhoneIdentity: false)
            bob.signOut(userId: "u_bob", keepPhoneIdentity: false)
            bobOld.signOut(userId: "u_bob", keepPhoneIdentity: false)
            defaults.removePersistentDomain(forName: suite)
        }
        let now: Int64 = 1_791_000_000_000
        _ = try alice.preparePhone(userId: "u_alice", deviceId: "alice-phone", now: now)
        let b = try bob.preparePhone(userId: "u_bob", deviceId: "bob-phone", now: now)
        // A second phone of Bob's, last opened 31 days ago: its key has expired.
        let old = try bobOld.preparePhone(userId: "u_bob", deviceId: "bob-old", now: now - 31 * 86_400_000)
        let current = FriendKeys.Device(deviceId: "bob-phone", clientKind: "ios", deviceCert: b.deviceCert, encCert: b.encCert)
        let expired = FriendKeys.Device(deviceId: "bob-old", clientKind: "ios", deviceCert: old.deviceCert, encCert: old.encCert)
        let sender = E2EEFlow(store: alice, trust: E2EETrust(defaults: defaults), deviceId: "alice-phone", userId: { "u_alice" })
        let both = FriendKeys(phones: [b.phoneCert!, old.phoneCert!], devices: [current, expired, current], allDevicesHaveKeys: true)
        let started = try sender.start(peer: "u_bob", conversationId: nil, burstId: "b1", codec: "opus16k", keys: both, now: now)
        let bundle = try #require(started.control["e2ee"] as? [String: Any])
        #expect((bundle["keys"] as? [[String: Any]])?.compactMap { $0["deviceId"] as? String } == ["bob-phone"])
        let onlyExpired = FriendKeys(phones: [old.phoneCert!], devices: [expired], allDevicesHaveKeys: true)
        #expect(throws: E2EEFlow.FlowError.noCurrentKey) {
            try sender.start(peer: "u_bob", conversationId: nil, burstId: "b2", codec: "opus16k", keys: onlyExpired, now: now)
        }
    }

    @Test func reissuedWatchCertificateRetainsEncryptionKeys() throws {
        let phone = E2EEKeyStore(service: "oao-e2ee-test-\(UUID().uuidString)")
        let watch = E2EEKeyStore(service: "oao-e2ee-test-\(UUID().uuidString)")
        let now: Int64 = 1_791_000_000_000
        defer {
            phone.signOut(userId: "u_alice", keepPhoneIdentity: false)
            watch.signOut(userId: "u_alice", keepPhoneIdentity: false)
        }
        _ = try phone.preparePhone(userId: "u_alice", deviceId: "alice-phone", now: now)
        let signingKey = try watch.watchSigningKey(deviceId: "alice-watch")
        let firstCerts = try phone.certifyWatch(userId: "u_alice", phoneDeviceId: "alice-phone",
                                                watchDeviceId: "alice-watch", signingKey: signingKey, now: now)
        let first = try watch.prepareWatch(userId: "u_alice", deviceId: "alice-watch",
                                           phoneCert: firstCerts.phone, deviceCert: firstCerts.device, now: now)
        let secondCerts = try phone.certifyWatch(userId: "u_alice", phoneDeviceId: "alice-phone",
                                                 watchDeviceId: "alice-watch", signingKey: signingKey, now: now + 1)
        #expect(firstCerts.device != secondCerts.device)
        let second = try watch.prepareWatch(userId: "u_alice", deviceId: "alice-watch",
                                            phoneCert: secondCerts.phone, deviceCert: secondCerts.device, now: now + 1)
        #expect(first.encCert == second.encCert)
        #expect(try watch.decryptionKeys(userId: "u_alice", deviceId: "alice-watch", now: now + 1).count == 1)
    }
}
