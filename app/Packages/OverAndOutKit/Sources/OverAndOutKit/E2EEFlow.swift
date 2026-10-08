import Foundation

/// The format choice and active burst ciphers for one device. Controllers own one on their
/// main actor; only authenticated plaintext frames are handed to AudioPipeline.
@MainActor
public final class E2EEFlow {
    public enum FlowError: String, Error {
        case noCurrentKey = "no-current-key"
        case notProvisioned = "not-provisioned"
        case downgrade
        case missingBundle = "bad-bundle"
        case invalidFormat = "invalid-format"
        case replayed
    }

    private let store: E2EEKeyStore
    private let trust: E2EETrust
    private let userId: () -> String?
    private let deviceId: String
    private let replayDefaults: UserDefaults
    private var sending: FrameCipher?
    private var receiving: FrameCipher?
    private var incomingBurstId: String?
    private var ledger = E2EEReplayLedger()
    public private(set) var changedSender = false
    public private(set) var justChanged = false

    public init(store: E2EEKeyStore, trust: E2EETrust, deviceId: String,
                replayDefaults: UserDefaults = .standard, userId: @escaping () -> String?) {
        self.store = store; self.trust = trust; self.deviceId = deviceId
        self.replayDefaults = replayDefaults; self.userId = userId
    }

    /// Nil means the friend has not registered keys yet and format 1 is still allowed in PR C.
    /// Any previously seen key makes missing or expired directory keys a hard failure.
    public func start(peer: String, conversationId: String?, burstId: String, codec: String,
                      keys freshKeys: FriendKeys? = nil, now: Int64) throws -> (control: [String: Any], conversationId: String)? {
        guard let userId = userId() else { throw FlowError.notProvisioned }
        let state = trust.state(account: userId, friend: peer)
        let keys = freshKeys ?? state.keys
        let hasSeenKeys = trust.hasSeenKeys(account: userId, friend: peer)
        guard let keys else {
            if hasSeenKeys { throw FlowError.noCurrentKey }
            sending = nil
            return nil
        }
        if keys.allDevicesHaveKeys != true {
            if !hasSeenKeys && keys.phones.isEmpty && keys.devices.isEmpty { sending = nil; return nil }
            throw FlowError.noCurrentKey
        }
        let usable = E2EE.usableKeys(of: peer, keys, now: now)
        guard usable.recipients.count == keys.devices.count,
              Set(usable.recipients.map(\.deviceId)).count == keys.devices.count else { throw FlowError.noCurrentKey }
        guard !usable.recipients.isEmpty else {
            if hasSeenKeys || !keys.phones.isEmpty { throw FlowError.noCurrentKey }
            sending = nil
            return nil
        }
        guard let sender = try store.sender(userId: userId, deviceId: deviceId) else { throw FlowError.notProvisioned }
        let id = conversationId ?? UUID().uuidString.lowercased()
        guard Self.fitsWire([id, burstId, codec, userId, peer, sender.deviceId]),
              usable.recipients.count <= Int(UInt16.max),
              usable.recipients.allSatisfy({ Self.fitsWire([$0.deviceId, $0.keyId]) })
        else { throw FlowError.noCurrentKey }
        let context = BundleContext(conversationId: id, burstId: burstId, codec: codec, from: userId, to: peer)
        let sealed = try E2EE.seal(context, from: sender, to: usable.recipients, sentAt: now)
        sending = sealed.cipher
        let encoded = try JSONEncoder().encode(sealed.bundle)
        let bundle = try JSONSerialization.jsonObject(with: encoded)
        return (["type": "talk-start", "to": peer, "burstId": burstId, "codec": codec,
                 "format": Int(E2EE.audioFormat), "conversationId": id, "e2ee": bundle], id)
    }

    public func send(_ frame: Data) throws -> Data {
        guard let sending else { return frame }
        guard let decoded = VoiceFrame.decode(frame) else { throw E2EE.Failure.decrypt }
        return try sending.seal(codec: decoded.codec, seq: decoded.seq, payload: decoded.payload)
    }

    /// Returns false when a burst must be dropped. Call before AudioPipeline.beginPlayback.
    @discardableResult
    public func receive(_ message: RelayMessage, peer: String, conversationId: String, now: Int64) throws -> Bool {
        guard let userId = userId(), let burstId = message.burstId else { throw FlowError.missingBundle }
        incomingBurstId = burstId
        receiving = nil
        changedSender = false
        justChanged = false
        if message.format != Int(E2EE.audioFormat) {
            guard message.format == nil || message.format == 1 else { throw FlowError.invalidFormat }
            if trust.hasSeenKeys(account: userId, friend: peer) { throw FlowError.downgrade }
            return true
        }
        guard let bundle = message.e2ee, let codec = message.codec else { throw FlowError.missingBundle }
        guard Self.fitsWire([conversationId, burstId, codec, peer, userId, deviceId, bundle.sender.deviceId]),
              bundle.keys.count <= Int(UInt16.max),
              bundle.keys.allSatisfy({ Self.fitsWire([$0.deviceId, $0.keyId]) &&
                  $0.enc.count <= Int(UInt16.max) && $0.ct.count <= Int(UInt16.max) })
        else { throw FlowError.missingBundle }
        let context = BundleContext(conversationId: conversationId, burstId: burstId, codec: codec, from: peer, to: userId)
        let opened = try E2EE.open(bundle, context, deviceId: deviceId,
                                   keys: store.decryptionKeys(userId: userId, deviceId: deviceId, now: now), now: now)
        justChanged = trust.observeSender(account: userId, friend: peer, identityKey: opened.senderIdentityKey, now: now)
        let state = trust.state(account: userId, friend: peer)
        changedSender = state.newPhones.contains(E2EE.fingerprint(opened.senderIdentityKey)) &&
            state.changedAt.map { now - $0 < 86_400_000 } == true
        receiving = opened.cipher
        return true
    }

    /// Nil is a repeated frame. Throws on authentication failure. A failed frame never reaches
    /// the playback ledger, so a valid retransmission of it can still play.
    public func open(_ frame: Data, burstId: String, now: Int64) throws -> Data? {
        guard burstId == incomingBurstId else { throw FlowError.missingBundle }
        let decoded: (codec: VoiceFrame.Codec, seq: UInt32, payload: Data)
        if let receiving { decoded = try receiving.open(frame) }
        else {
            guard let plain = VoiceFrame.decode(frame) else { throw E2EE.Failure.decrypt }
            decoded = plain
        }
        guard ledger.accept(burstId: burstId, sequence: decoded.seq, now: now) else { return nil }
        if receiving != nil {
            guard let account = userId(), try rememberPlayedSequence(account: account, burstId: burstId,
                                                                      sequence: decoded.seq, now: now) else { return nil }
        }
        return VoiceFrame.encode(codec: decoded.codec, seq: decoded.seq, payload: decoded.payload)
    }

    public func endSending() { sending = nil }
    public func endReceiving() { receiving = nil; incomingBurstId = nil; changedSender = false; justChanged = false }

    private static func fitsWire(_ fields: [String]) -> Bool {
        fields.allSatisfy { $0.utf8.count <= Int(UInt16.max) }
    }

    private struct Played: Codable {
        var at: Int64
        var bits: [UInt8]
    }

    /// Persist played sequences, rather than the bundle alone: a process restart during a
    /// prefetch or a live burst must still allow its unheard frames to play on resume.
    private func rememberPlayedSequence(account: String, burstId: String, sequence: UInt32, now: Int64) throws -> Bool {
        // The relay caps a burst at 60 seconds of 20 ms frames. Bound storage even when an
        // authenticated peer sends a malicious sequence number.
        guard sequence < 10_000 else { throw FlowError.replayed }
        let key = "e2ee-played-sequences-v1-\(account)-\(deviceId)"
        let saved: [String: Played]
        if let data = replayDefaults.data(forKey: key) {
            guard let decoded = try? JSONDecoder().decode([String: Played].self, from: data) else {
                throw FlowError.replayed
            }
            saved = decoded
        } else { saved = [:] }
        var recent = saved.filter { $0.value.at >= now - 600_000 }
        var entry = recent[burstId] ?? Played(at: now, bits: [])
        let byte = Int(sequence / 8)
        if entry.bits.count <= byte { entry.bits.append(contentsOf: repeatElement(0, count: byte + 1 - entry.bits.count)) }
        let mask = UInt8(1 << (sequence % 8))
        guard entry.bits[byte] & mask == 0 else { return false }
        entry.bits[byte] |= mask
        recent[burstId] = entry
        guard let data = try? JSONEncoder().encode(recent) else { throw FlowError.replayed }
        replayDefaults.set(data, forKey: key)
        return true
    }
}
