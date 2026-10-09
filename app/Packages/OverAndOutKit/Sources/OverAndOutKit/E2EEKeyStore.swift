import CryptoKit
import Darwin
import Foundation
import os
import Security

/// Private device keys live in the local, after-first-unlock Keychain. The watch uses the
/// session's access group so its notification extension can read them if it needs to rotate.
public final class E2EEKeyStore: @unchecked Sendable {
    public struct Registration: Sendable, Equatable {
        public let phoneCert: Data?
        public let deviceCert: Data
        public let encCert: Data

        public var json: [String: String] {
            var value = ["deviceCert": deviceCert.base64EncodedString(), "encCert": encCert.base64EncodedString()]
            if let phoneCert { value["phoneCert"] = phoneCert.base64EncodedString() }
            return value
        }
    }

    private struct Saved: Codable {
        var userId: String
        var deviceId: String
        var identity: Data?
        var signing: Data
        var phoneCert: Data
        var deviceCert: Data
        var current: Data
        var currentCert: Data
        var previous: Data?
        var previousUntil: Int64?
    }

    private let lock = NSLock()
    private let service: String
    private var accessGroup: String?
    private let interprocessLockURL: URL?
    private let account = "keys"
    private static let week: Int64 = 7 * 86_400_000

    public init(accessGroup: String? = nil, service: String = "com.cypressoakstudios.overandout.e2ee") {
        self.accessGroup = accessGroup
        interprocessLockURL = accessGroup.flatMap {
            FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0)?
                .appendingPathComponent("e2ee-key-store.lock")
        }
        self.service = service
    }

    /// The watch app and its notification extension can rotate at the same time. The
    /// in-process lock protects this instance; a POSIX file lock protects their shared Keychain item
    /// across processes for the whole read/modify/write transaction.
    private func withStoreLock<T>(_ body: () throws -> T) throws -> T {
        lock.lock()
        defer { lock.unlock() }
        guard let url = interprocessLockURL else { return try body() }
        let descriptor = url.path.withCString { Darwin.open($0, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR) }
        guard descriptor >= 0 else { throw StoreError.lockUnavailable }
        defer { _ = Darwin.close(descriptor) }
        guard Darwin.lockf(descriptor, F_LOCK, 0) == 0 else { throw StoreError.lockUnavailable }
        defer { _ = Darwin.lockf(descriptor, F_ULOCK, 0) }
        return try body()
    }

    private func query() -> [String: Any] {
        var value: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service, kSecAttrAccount as String: account]
        if let accessGroup { value[kSecAttrAccessGroup as String] = accessGroup }
        return value
    }

    private func load() -> Saved? {
        var q = query()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: AnyObject?
        var status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecMissingEntitlement, accessGroup != nil {
            accessGroup = nil
            q[kSecAttrAccessGroup as String] = nil
            status = SecItemCopyMatching(q as CFDictionary, &item)
        }
        guard status == errSecSuccess,
              let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(Saved.self, from: data)
    }

    private func save(_ value: Saved) throws {
        let data = try JSONEncoder().encode(value)
        var q = query()
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        var status = SecItemAdd(q as CFDictionary, nil)
        if status == errSecMissingEntitlement, accessGroup != nil {
            accessGroup = nil
            q[kSecAttrAccessGroup as String] = nil
            status = SecItemAdd(q as CFDictionary, nil)
        }
        if status == errSecDuplicateItem {
            let update = SecItemUpdate(query() as CFDictionary, [kSecValueData as String: data] as CFDictionary)
            guard update == errSecSuccess else { throw StoreError.keychain(update) }
        } else if status != errSecSuccess { throw StoreError.keychain(status) }
    }

    public enum StoreError: Error, Sendable { case keychain(OSStatus), notProvisioned, lockUnavailable }

    /// A phone keeps its identity for the same account, but issues fresh device keys after
    /// sign-out. A different account replaces the identity before any registration.
    public func preparePhone(userId: String, deviceId: String, now: Int64) throws -> Registration {
        try withStoreLock {
            if var saved = load(), saved.userId == userId, saved.deviceId == deviceId,
               !saved.signing.isEmpty {
                try rotate(&saved, now: now)
                return registration(saved, phone: true)
            }
            let identity = try load().flatMap { $0.userId == userId && $0.deviceId == deviceId ? $0.identity : nil }
                .map { try Curve25519.Signing.PrivateKey(rawRepresentation: $0) } ?? Curve25519.Signing.PrivateKey()
            let signing = Curve25519.Signing.PrivateKey()
            let phone = try PhoneCertificate.issue(identity: identity, userId: userId, deviceId: deviceId, issuedAt: now)
            let device = try DeviceCertificate.issue(identity: identity, phone: phone, deviceId: deviceId,
                                                      clientKind: "ios", signingKey: signing.publicKey.rawRepresentation, issuedAt: now)
            var saved = Saved(userId: userId, deviceId: deviceId, identity: identity.rawRepresentation,
                              signing: signing.rawRepresentation, phoneCert: phone.raw, deviceCert: device.raw,
                              current: Data(), currentCert: Data(), previous: nil, previousUntil: nil)
            try rotate(&saved, now: now)
            return registration(saved, phone: true)
        }
    }

    /// The watch sends this public key over WatchConnectivity with its session request.
    public func watchSigningKey(deviceId: String) throws -> Data {
        try withStoreLock {
            if let saved = load(), saved.deviceId == deviceId, !saved.signing.isEmpty {
                return try Curve25519.Signing.PrivateKey(rawRepresentation: saved.signing).publicKey.rawRepresentation
            }
            let signing = Curve25519.Signing.PrivateKey()
            try save(Saved(userId: "", deviceId: deviceId, identity: nil, signing: signing.rawRepresentation,
                           phoneCert: Data(), deviceCert: Data(), current: Data(), currentCert: Data(),
                           previous: nil, previousUntil: nil))
            return signing.publicKey.rawRepresentation
        }
    }

    /// Certify only the public key received from this watch, never send the phone private key.
    public func certifyWatch(userId: String, phoneDeviceId: String, watchDeviceId: String,
                             signingKey: Data, now: Int64) throws -> (phone: Data, device: Data) {
        try withStoreLock {
            guard let saved = load(), saved.userId == userId, saved.deviceId == phoneDeviceId,
                  let raw = saved.identity, signingKey.count == 32 else { throw StoreError.notProvisioned }
            let identity = try Curve25519.Signing.PrivateKey(rawRepresentation: raw)
            let phone = try PhoneCertificate(raw: saved.phoneCert)
            let device = try DeviceCertificate.issue(identity: identity, phone: phone, deviceId: watchDeviceId,
                                                      clientKind: "watchos", signingKey: signingKey, issuedAt: now)
            return (phone.raw, device.raw)
        }
    }

    public func prepareWatch(userId: String, deviceId: String, phoneCert: Data, deviceCert: Data,
                             now: Int64) throws -> Registration {
        try withStoreLock {
            guard var saved = load(), saved.deviceId == deviceId, !saved.signing.isEmpty else { throw StoreError.notProvisioned }
            let phone = try PhoneCertificate(raw: phoneCert)
            let cert = try DeviceCertificate(raw: deviceCert, issuer: phone)
            let signing = try Curve25519.Signing.PrivateKey(rawRepresentation: saved.signing)
            guard phone.userId == userId, cert.userId == userId, cert.deviceId == deviceId,
                  cert.signingKey == signing.publicKey.rawRepresentation else { throw StoreError.notProvisioned }
            // A phone can reissue the watch's certificate after an app restart. Its
            // signing key and issuing phone identity are unchanged, so retain the
            // encryption keys that queued and prefetched messages still address.
            let oldPhone = try? PhoneCertificate(raw: saved.phoneCert)
            if saved.userId != userId || oldPhone?.identityKey != phone.identityKey {
                saved.current = Data(); saved.currentCert = Data(); saved.previous = nil; saved.previousUntil = nil
            }
            saved.userId = userId; saved.phoneCert = phoneCert; saved.deviceCert = deviceCert
            try rotate(&saved, now: now)
            return registration(saved, phone: false)
        }
    }

    public func registration(userId: String, deviceId: String, phone: Bool, now: Int64) throws -> Registration? {
        try withStoreLock {
            guard var saved = load(), saved.userId == userId, saved.deviceId == deviceId,
                  !saved.deviceCert.isEmpty else { return nil }
            try rotate(&saved, now: now)
            return registration(saved, phone: phone)
        }
    }

    private func registration(_ saved: Saved, phone: Bool) -> Registration {
        Registration(phoneCert: phone ? saved.phoneCert : nil, deviceCert: saved.deviceCert, encCert: saved.currentCert)
    }

    private func rotate(_ saved: inout Saved, now: Int64) throws {
        if !saved.currentCert.isEmpty,
           let cert = try? EncryptionKeyCertificate(raw: saved.currentCert,
               device: DeviceCertificate(raw: saved.deviceCert, issuer: PhoneCertificate(raw: saved.phoneCert))),
           now - cert.issuedAt < Self.week, cert.notAfter > now {
            if let until = saved.previousUntil, until <= now {
                saved.previous = nil; saved.previousUntil = nil; try save(saved)
            }
            return
        }
        if !saved.current.isEmpty { saved.previous = saved.current; saved.previousUntil = now + Self.week }
        let signing = try Curve25519.Signing.PrivateKey(rawRepresentation: saved.signing)
        let phone = try PhoneCertificate(raw: saved.phoneCert)
        let device = try DeviceCertificate(raw: saved.deviceCert, issuer: phone)
        let key = Curve25519.KeyAgreement.PrivateKey()
        let cert = try EncryptionKeyCertificate.issue(signingKey: signing, device: device,
                                                      encryptionKey: key.publicKey.rawRepresentation, issuedAt: now)
        saved.current = key.rawRepresentation; saved.currentCert = cert.raw
        try save(saved)
    }

    public func sender(userId: String, deviceId: String) throws -> SenderIdentity? {
        try withStoreLock {
            guard let saved = load(), saved.userId == userId, saved.deviceId == deviceId,
                  !saved.deviceCert.isEmpty else { return nil }
            let phone = try PhoneCertificate(raw: saved.phoneCert)
            let device = try DeviceCertificate(raw: saved.deviceCert, issuer: phone)
            let signing = try Curve25519.Signing.PrivateKey(rawRepresentation: saved.signing)
            return SenderIdentity(phoneCertificate: phone, deviceCertificate: device, signingKey: signing)
        }
    }

    public func decryptionKeys(userId: String, deviceId: String, now: Int64) throws -> [String: Curve25519.KeyAgreement.PrivateKey] {
        try withStoreLock {
            guard let saved = load(), saved.userId == userId, saved.deviceId == deviceId,
                  !saved.currentCert.isEmpty else { return [:] }
            let phone = try PhoneCertificate(raw: saved.phoneCert)
            let device = try DeviceCertificate(raw: saved.deviceCert, issuer: phone)
            let current = try EncryptionKeyCertificate(raw: saved.currentCert, device: device)
            var keys = [current.keyId: try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: saved.current)]
            if let previous = saved.previous, let until = saved.previousUntil, until > now {
                keys[E2EE.keyId(try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: previous).publicKey.rawRepresentation)] =
                    try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: previous)
            }
            return keys
        }
    }

    public func signOut(userId: String, keepPhoneIdentity: Bool) {
        try? withStoreLock {
            guard var saved = load(), saved.userId == userId else { return }
            if keepPhoneIdentity {
                // Keep the identity under this account, but no usable device key or certificate.
                saved.signing = Data(); saved.deviceCert = Data(); saved.current = Data(); saved.currentCert = Data()
                saved.previous = nil; saved.previousUntil = nil
                try? save(saved)
            } else { _ = SecItemDelete(query() as CFDictionary) }
        }
    }
}

/// Remember public directory keys across launches: the keys to seal to, and the friend's phone
/// fingerprints, so a change shows the "security code changed" notice. The seen marker outlives
/// a damaged cache, so a friend whose keys were seen isn't taken for a first contact.
public final class E2EETrust: @unchecked Sendable {
    public struct State: Codable, Sendable {
        public var phones: [String] = []
        public var keys: FriendKeys?
        public var changedAt: Int64?
        public var newPhones: [String] = []
        public var noticeReadAt: Int64?
        public var inviteMismatch = false
        public var inviteFingerprint: String?

        public init() {}

        private enum CodingKeys: String, CodingKey {
            case phones, keys, changedAt, newPhones, noticeReadAt, inviteMismatch, inviteFingerprint
        }

        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            phones = try values.decode([String].self, forKey: .phones)
            keys = try values.decodeIfPresent(FriendKeys.self, forKey: .keys)
            changedAt = try values.decodeIfPresent(Int64.self, forKey: .changedAt)
            newPhones = try values.decodeIfPresent([String].self, forKey: .newPhones) ?? []
            noticeReadAt = try values.decodeIfPresent(Int64.self, forKey: .noticeReadAt)
            inviteMismatch = try values.decodeIfPresent(Bool.self, forKey: .inviteMismatch) ?? false
            inviteFingerprint = try values.decodeIfPresent(String.self, forKey: .inviteFingerprint)
        }
    }

    private let lock = OSAllocatedUnfairLock(initialState: ())
    private let defaults: UserDefaults
    private let prefix = "e2ee-trust-v1-"
    private let seenPrefix = "e2ee-seen-v1-"

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    private func key(_ account: String) -> String { prefix + account }
    private func seenKey(_ account: String, _ friend: String) -> String { seenPrefix + account + "-" + friend }
    private func all(_ account: String) -> [String: State] {
        guard let data = defaults.data(forKey: key(account)) else { return [:] }
        return (try? JSONDecoder().decode([String: State].self, from: data)) ?? [:]
    }
    private func save(_ states: [String: State], account: String) {
        if let data = try? JSONEncoder().encode(states) { defaults.set(data, forKey: key(account)) }
    }

    public func state(account: String, friend: String) -> State {
        lock.withLock { _ in all(account)[friend] ?? State() }
    }

    /// A fresh directory result with no keys invalidates cached recipients while retaining
    /// the seen marker and the last known fingerprints for the warning.
    public func missingKeys(account: String, friend: String) {
        lock.withLock { _ in
            var states = all(account)
            guard var state = states[friend], state.keys != nil else { return }
            state.keys = nil
            states[friend] = state
            save(states, account: account)
        }
    }

    @discardableResult
    public func update(account: String, friend: String, keys: FriendKeys, now: Int64) -> Bool {
        lock.withLock { _ in
            var states = all(account)
            var state = states[friend] ?? State()
            let phones = E2EE.usableKeys(of: friend, keys, now: now).phones.map { E2EE.fingerprint($0.identityKey) }.sorted()
            guard !phones.isEmpty else { return false }
            let changed = (defaults.bool(forKey: seenKey(account, friend)) || !state.phones.isEmpty)
                && state.phones != phones
            if changed {
                let added = phones.filter { !state.phones.contains($0) }
                state.newPhones = added.isEmpty ? state.newPhones.filter { phones.contains($0) } : added
                state.changedAt = now
                state.noticeReadAt = nil
            }
            state.phones = phones
            state.keys = keys
            if let expected = state.inviteFingerprint, phones.contains(expected) { state.inviteMismatch = false }
            states[friend] = state
            defaults.set(true, forKey: seenKey(account, friend))
            save(states, account: account)
            return changed
        }
    }

    @discardableResult
    public func observeSender(account: String, friend: String, identityKey: Data, now: Int64) -> Bool {
        lock.withLock { _ in
            var states = all(account)
            var state = states[friend] ?? State()
            let fingerprint = E2EE.fingerprint(identityKey)
            let changed = (defaults.bool(forKey: seenKey(account, friend)) || !state.phones.isEmpty)
                && !state.phones.contains(fingerprint)
            if changed {
                state.newPhones = [fingerprint]
                state.changedAt = now
                state.noticeReadAt = nil
            }
            if !state.phones.contains(fingerprint) { state.phones.append(fingerprint); state.phones.sort() }
            states[friend] = state
            defaults.set(true, forKey: seenKey(account, friend))
            save(states, account: account)
            return changed
        }
    }

    public func checkInvite(account: String, friend: String, fingerprint: String?) {
        guard let fingerprint else { return }
        lock.withLock { _ in
            var states = all(account)
            var state = states[friend] ?? State()
            state.inviteFingerprint = fingerprint
            state.inviteMismatch = !state.phones.contains(fingerprint)
            states[friend] = state
            save(states, account: account)
        }
    }

    public func markNoticeRead(account: String, friend: String, now: Int64) -> Bool {
        lock.withLock { _ in
            var states = all(account)
            guard var state = states[friend], let changed = state.changedAt,
                  state.noticeReadAt == nil else { return false }
            state.noticeReadAt = now
            states[friend] = state
            save(states, account: account)
            return changed <= now
        }
    }
}

/// Each burst is authenticated before playback, and each sequence is played at most once.
/// Retained for ten minutes across reconnects and replay within this process.
public struct E2EEReplayLedger {
    private var seen: [String: (at: Int64, sequences: Set<UInt32>)] = [:]
    public init() {}

    public mutating func accept(burstId: String, sequence: UInt32, now: Int64) -> Bool {
        seen = seen.filter { now - $0.value.at < 600_000 }
        var entry = seen[burstId] ?? (now, [])
        guard entry.sequences.insert(sequence).inserted else { return false }
        seen[burstId] = entry
        return true
    }
}
