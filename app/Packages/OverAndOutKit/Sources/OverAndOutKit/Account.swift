import Foundation
import Security

// Accounts, shared by the iPhone and watch apps (design decisions 2026-09-27): Sign in with
// Apple on the iPhone, a session token per device, the watch's session minted by the iPhone
// and sent over WatchConnectivity, and the account API at overandout.app/v1 (server/src/api.ts).

public enum Platform: String, Codable, Sendable {
    case watch
    case iphone
}

/// A device's session. The token is a 30-day JWT the relay checks locally; the apps refresh
/// it once it's a day old, and the API still refreshes it up to a year past expiry while
/// the session exists.
public struct AccountSession: Codable, Equatable, Sendable {
    public static let lifetime: TimeInterval = 30 * 24 * 3600

    public var token: String
    public var expiresAt: Date
    public var userId: String
    public var name: String
    public var deviceId: String

    public init(token: String, expiresAt: Date, userId: String, name: String, deviceId: String) {
        self.token = token
        self.expiresAt = expiresAt
        self.userId = userId
        self.name = name
        self.deviceId = deviceId
    }

    public var isExpired: Bool { expiresAt <= Date() }
    /// Issued more than a day ago.
    public var needsRefresh: Bool { expiresAt.timeIntervalSinceNow < Self.lifetime - 24 * 3600 }
}

public struct AccountUser: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    /// When the profile photo last changed (ms since 1970); nil without one.
    public let photoVersion: Double?
    /// A built-in mascot (`Mascot`'s ID) instead of a photo.
    public var avatar: String? = nil
    /// Which device rings: nil = the watch if the account has one, else the iPhone.
    public var ringOn: Platform? = nil
    /// The kinds of device registered for rings (GET /v1/me only).
    public var platforms: [Platform]? = nil
    /// When the server asked this account's devices for their diagnostics logs (ms), while the
    /// request is open (GET /v1/me only; the Beta telemetry spec).
    public var diagnosticsRequestedAt: Double? = nil
}

public struct Friend: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
    /// Milliseconds since 1970.
    public let since: Double
    /// When their profile photo last changed (ms since 1970); nil without one.
    public let photoVersion: Double?
    /// Their built-in mascot (`Mascot`'s ID), when they chose one instead of a photo.
    public let avatar: String?
    /// You starred them: favorites come first in friend lists.
    public var favorite: Bool?
    /// When they last talked to you (ms since 1970), recorded by the relay.
    public let lastMessageAt: Double?

    public init(id: String, name: String, since: Double, photoVersion: Double? = nil, avatar: String? = nil,
                favorite: Bool? = nil, lastMessageAt: Double? = nil) {
        self.id = id
        self.name = name
        self.since = since
        self.photoVersion = photoVersion
        self.avatar = avatar
        self.favorite = favorite
        self.lastMessageAt = lastMessageAt
    }

    public var isFavorite: Bool { favorite == true }

    /// Favorites first, then by name (the server sorts by name only).
    public static func favoritesFirst(_ friends: [Friend]) -> [Friend] {
        friends.enumerated()
            .sorted { a, b in a.element.isFavorite != b.element.isFavorite ? a.element.isFavorite : a.offset < b.offset }
            .map(\.element)
    }
}

public struct BlockedUser: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    /// Nil once their account has been deleted.
    public let name: String?
    public let since: Double
}

public struct InviteLink: Codable, Equatable, Sendable {
    public let code: String
    public let url: URL
    public let expiresAt: Double
}

public struct InviteInfo: Codable, Equatable, Sendable {
    public struct Person: Codable, Equatable, Sendable {
        public let id: String
        public let name: String
    }

    public let code: String
    public let from: Person
    public let expiresAt: Double
    public let alreadyFriends: Bool
}

public enum ReportReason: String, CaseIterable, Identifiable, Sendable {
    case harassment
    case spam
    case inappropriate
    case photo
    case other

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .harassment: return "Harassment or bullying"
        case .spam: return "Spam or unwanted rings"
        case .inappropriate: return "Inappropriate content"
        case .photo: return "Inappropriate profile photo"
        case .other: return "Something else"
        }
    }
}

/// An error from the account API, with the server's stable code.
public struct AccountAPIError: LocalizedError, Equatable, Sendable {
    public let status: Int
    public let code: String
    public let message: String

    public init(status: Int, code: String, message: String = "") {
        self.status = status
        self.code = code
        self.message = message
    }

    public static let notSignedIn = AccountAPIError(status: 401, code: "not-signed-in")

    /// The session is gone (signed out elsewhere, or the account was deleted).
    public var endsSession: Bool {
        (status == 401 && ["unauthorized", "session-ended", "not-signed-in"].contains(code)) ||
            (status == 404 && code == "no-account")
    }

    public var errorDescription: String? {
        switch code {
        case "invite-not-found": return "This invite has expired or has already been used. Ask your friend for a new one."
        case "own-invite": return "That's your own invite. Send it to a friend instead."
        case "photo-too-large", "not-a-jpeg": return "That photo couldn't be used. Try another one."
        case "too-many-invites": return "You've sent a lot of invites today. Try again tomorrow."
        case "apple-token-rejected": return "Sign in with Apple didn't work. Try again."
        case "apple-revoke-failed": return "Couldn't reach Apple to finish deleting your account. Try again in a moment."
        case "wrong-apple-id": return "Sign in with the Apple ID you use for Over&Out."
        case "bad-name": return "Enter a name."
        case "no-account", "not-signed-in", "unauthorized", "session-ended": return "You're signed out. Sign in again."
        default: return message.isEmpty ? "Something went wrong (\(status) \(code))." : message
        }
    }
}

// MARK: - Session storage

public protocol SessionStoring: AnyObject, Sendable {
    func load() -> AccountSession?
    func save(_ session: AccountSession)
    func clear()
}

/// The session in the Keychain. On the watch, the access group is the app group, so the
/// notification service extension can read the token to prefetch a ring's message. If the
/// system refuses that group (a missing entitlement), the session is kept in the app's own
/// Keychain instead: signing in still works, only the prefetch doesn't.
public final class KeychainSessionStore: SessionStoring, @unchecked Sendable {
    public static let service = "com.cypressoakstudios.overandout.session"
    private static let account = "session"
    private var accessGroup: String?
    private let lock = NSLock()

    public init(accessGroup: String? = nil) {
        self.accessGroup = accessGroup
    }

    public func load() -> AccountSession? {
        lock.lock()
        defer { lock.unlock() }
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        var status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecMissingEntitlement, accessGroup != nil {
            accessGroup = nil
            query[kSecAttrAccessGroup as String] = nil
            status = SecItemCopyMatching(query as CFDictionary, &result)
        }
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return try? Self.decoder.decode(AccountSession.self, from: data)
    }

    public func save(_ session: AccountSession) {
        lock.lock()
        defer { lock.unlock() }
        guard let data = try? Self.encoder.encode(session) else { return }
        if add(data) == errSecMissingEntitlement, accessGroup != nil {
            print("[oao] Keychain refused access group \(accessGroup ?? ""); keeping the session in the app's own Keychain")
            accessGroup = nil
            _ = add(data)
        }
    }

    private func add(_ data: Data) -> OSStatus {
        SecItemDelete(baseQuery() as CFDictionary)
        var item = baseQuery()
        item[kSecValueData as String] = data
        // Readable while the watch is locked after its first unlock, so a ring's prefetch works.
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil)
    }

    public func clear() {
        lock.lock()
        defer { lock.unlock() }
        SecItemDelete(baseQuery() as CFDictionary)
    }

    private func baseQuery() -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }

    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        return encoder
    }()

    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        return decoder
    }()
}

public final class MemorySessionStore: SessionStoring, @unchecked Sendable {
    private var session: AccountSession?
    private let lock = NSLock()

    public init(_ session: AccountSession? = nil) {
        self.session = session
    }

    public func load() -> AccountSession? { lock.withLock { session } }
    public func save(_ session: AccountSession) { lock.withLock { self.session = session } }
    public func clear() { lock.withLock { session = nil } }
}

/// A random ID for this install, which the server keys the device's session and push token by.
public enum DeviceIdentity {
    public static func id(_ defaults: UserDefaults = .standard) -> String {
        if let id = defaults.string(forKey: "deviceId") { return id }
        let id = UUID().uuidString.lowercased()
        defaults.set(id, forKey: "deviceId")
        return id
    }
}

// MARK: - The API

/// Calls the account API. Refreshes the token when it's a day old, and once more if the
/// server says it expired. If the server says the session is gone, the stored session is
/// cleared and `signedOutNotification` is posted.
///
/// The actor runs other calls while one waits on the network, so a response only touches the
/// stored session if it's still the one the request was made with: a refresh or an error that
/// finishes after signing out (or into another account) mustn't bring the old one back.
public actor AccountClient {
    public static let signedOutNotification = Notification.Name("OverAndOutSignedOut")

    public nonisolated let baseURL: URL
    private nonisolated let store: SessionStoring
    private let urlSession: URLSession
    private var refreshing: Task<AccountSession, Error>?

    public init(baseURL: URL, store: SessionStoring, urlSession: URLSession = .shared) {
        self.baseURL = baseURL
        self.store = store
        self.urlSession = urlSession
    }

    /// The API host from Info.plist (OAOApiHost). A host on this Mac (for the simulator) is
    /// reached over plain HTTP.
    public static func baseURL(host: String) -> URL? {
        guard !host.isEmpty else { return nil }
        let local = host.hasPrefix("localhost") || host.hasPrefix("127.0.0.1")
        return URL(string: "\(local ? "http" : "https")://\(host)")
    }

    public nonisolated var session: AccountSession? { store.load() }

    // MARK: Sessions

    public struct SignIn: Sendable {
        public let session: AccountSession
        public let created: Bool
    }

    /// `nonce` is the raw value whose SHA-256 went into the Apple request.
    public func signInWithApple(identityToken: String, nonce: String, name: String?, deviceId: String, platform: Platform) async throws -> SignIn {
        struct Response: Decodable { let token: String; let expiresAt: Double; let user: AccountUser; let created: Bool }
        var body: [String: Any] = ["identityToken": identityToken, "nonce": nonce, "deviceId": deviceId, "platform": platform.rawValue]
        if let name, !name.isEmpty { body["name"] = name }
        let response: Response = try await send("POST", "/v1/auth/apple", body: body, token: nil)
        let session = AccountSession(token: response.token, expiresAt: Date(timeIntervalSince1970: response.expiresAt / 1000),
                                     userId: response.user.id, name: response.user.name, deviceId: deviceId)
        sessionChanged()
        store.save(session)
        return SignIn(session: session, created: response.created)
    }

    /// Saves a session made elsewhere (the watch's, from the iPhone).
    public func adopt(_ session: AccountSession) {
        sessionChanged()
        store.save(session)
    }

    /// A session for another of the user's devices (the iPhone makes the watch's).
    public func makeSession(forDevice deviceId: String, platform: Platform) async throws -> AccountSession {
        struct Response: Decodable { let token: String; let expiresAt: Double }
        guard let mine = store.load() else { throw AccountAPIError.notSignedIn }
        let response: Response = try await request("POST", "/v1/auth/device", body: ["deviceId": deviceId, "platform": platform.rawValue])
        // Signed out, or into another account, meanwhile: this session isn't theirs to hand on.
        guard store.load()?.userId == mine.userId else { throw AccountAPIError.notSignedIn }
        return AccountSession(token: response.token, expiresAt: Date(timeIntervalSince1970: response.expiresAt / 1000),
                              userId: mine.userId, name: mine.name, deviceId: deviceId)
    }

    public func refreshIfNeeded() async throws {
        guard let session = store.load(), session.needsRefresh else { return }
        _ = try await refresh()
    }

    /// One refresh at a time; callers share it.
    @discardableResult
    public func refresh() async throws -> AccountSession {
        if let refreshing { return try await refreshing.value }
        let task = Task { () throws -> AccountSession in
            guard let token = store.load()?.token else { throw AccountAPIError.notSignedIn }
            struct Response: Decodable { let token: String; let expiresAt: Double }
            do {
                let response: Response = try await send("POST", "/v1/auth/refresh", body: nil, token: token)
                // Signed out, or into another account, while this was in flight.
                guard var session = store.load(), session.token == token else { throw AccountAPIError.notSignedIn }
                session.token = response.token
                session.expiresAt = Date(timeIntervalSince1970: response.expiresAt / 1000)
                store.save(session)
                return session
            } catch let error as AccountAPIError where error.endsSession {
                signedOut(ifStillUsing: token)
                throw error
            }
        }
        refreshing = task
        defer { if refreshing == task { refreshing = nil } }
        return try await task.value
    }

    /// Forgets this device's session, then ends it on the server (best effort).
    public func signOut() async {
        let session = store.load()
        sessionChanged()
        store.clear()
        if let session {
            let _: Empty? = try? await send("POST", "/v1/auth/signout", body: nil, token: session.token)
        }
    }

    /// `authorizationCode` comes from a fresh Sign in with Apple, so the server can revoke
    /// the Apple token.
    public func deleteAccount(authorizationCode: String) async throws {
        let _: Empty = try await request("DELETE", "/v1/me", body: ["authorizationCode": authorizationCode])
        sessionChanged()
        store.clear()
    }

    // MARK: Profile, friends, invites, blocks, reports

    public func me() async throws -> AccountUser {
        let user: AccountUser = try await request("GET", "/v1/me")
        updateStoredName(user)
        return user
    }

    public func rename(_ name: String) async throws -> AccountUser {
        let user: AccountUser = try await request("PATCH", "/v1/me", body: ["name": name])
        updateStoredName(user)
        return user
    }

    /// Which device rings (nil = the default: the watch if the account has one).
    public func setRingOn(_ platform: Platform?) async throws -> AccountUser {
        try await request("PATCH", "/v1/me", body: ["ringOn": platform?.rawValue ?? NSNull()])
    }

    /// A built-in mascot as the profile picture (replacing any photo); nil removes it.
    public func setAvatar(_ mascot: Mascot?) async throws -> AccountUser {
        try await request("PATCH", "/v1/me", body: ["avatar": mascot?.rawValue ?? NSNull()])
    }

    /// `pushType` "pushtotalk": the token is the iPhone's PushToTalk channel token.
    public func registerDevice(platform: Platform, pushToken: String, pushType: String? = nil, apnsEnvironment: String) async throws {
        var body: [String: Any] = ["platform": platform.rawValue, "pushToken": pushToken, "apnsEnvironment": apnsEnvironment]
        if let pushType { body["pushType"] = pushType }
        let _: Empty = try await request("PUT", "/v1/me/device", body: body)
    }

    // MARK: Profile photo

    /// A square JPEG (see `ProfilePhoto.jpeg(from:)`). Returns the new photo version.
    public func setPhoto(jpeg: Data) async throws -> Double {
        struct Response: Decodable { let photoVersion: Double }
        let data = try await authorized { token in
            try await self.sendData("PUT", "/v1/me/photo", body: jpeg, contentType: "image/jpeg", token: token)
        }
        return try JSONDecoder().decode(Response.self, from: data).photoVersion
    }

    public func removePhoto() async throws {
        let _: Empty = try await request("DELETE", "/v1/me/photo")
    }

    /// Your own photo or a friend's, as JPEG data.
    public func photo(userId: String) async throws -> Data {
        try await authorized { token in
            try await self.sendData("GET", "/v1/users/\(userId)/photo", body: nil, contentType: nil, token: token)
        }
    }

    public func friends() async throws -> [Friend] {
        struct Response: Decodable { let friends: [Friend] }
        let response: Response = try await request("GET", "/v1/friends")
        return response.friends
    }

    /// Your star on a friend.
    public func setFavorite(_ id: String, _ favorite: Bool) async throws {
        let _: Empty = try await request("PATCH", "/v1/friends/\(id)", body: ["favorite": favorite])
    }

    public func removeFriend(_ id: String) async throws {
        let _: Empty = try await request("DELETE", "/v1/friends/\(id)")
    }

    public func createInvite() async throws -> InviteLink {
        try await request("POST", "/v1/invites")
    }

    public func invite(code: String) async throws -> InviteInfo {
        try await request("GET", "/v1/invites/\(code)")
    }

    public func acceptInvite(code: String) async throws -> Friend {
        struct Response: Decodable { let friend: Friend }
        let response: Response = try await request("POST", "/v1/invites/\(code)/accept")
        return response.friend
    }

    public func blocks() async throws -> [BlockedUser] {
        struct Response: Decodable { let blocks: [BlockedUser] }
        let response: Response = try await request("GET", "/v1/blocks")
        return response.blocks
    }

    public func block(_ id: String) async throws {
        let _: Empty = try await request("POST", "/v1/blocks", body: ["userId": id])
    }

    public func unblock(_ id: String) async throws {
        let _: Empty = try await request("DELETE", "/v1/blocks/\(id)")
    }

    public func report(_ id: String, reason: ReportReason, note: String?, alsoBlock: Bool) async throws {
        var body: [String: Any] = ["userId": id, "reason": reason.rawValue, "block": alsoBlock]
        if let note, !note.isEmpty { body["note"] = note }
        let _: Empty = try await request("POST", "/v1/reports", body: body)
    }

    // MARK: Telemetry (the Beta telemetry spec)

    /// Device events outside conversations, which the server logs.
    public func sendEvents(_ events: [[String: Any]], device: [String: String]) async throws {
        let _: Empty = try await request("POST", "/v1/events", body: ["events": events, "device": device])
    }

    /// This device's diagnostics log (DiagnosticsLog.compressed()), when the server asked for it.
    public func uploadDiagnostics(_ data: Data, platform: Platform) async throws {
        let headers = ["x-oao-platform": platform.rawValue, "x-oao-build": DeviceInfo.build]
        _ = try await authorized { token in
            try await self.sendData("POST", "/v1/diagnostics", body: data, contentType: "application/octet-stream", token: token, headers: headers)
        }
    }

    /// Report a Problem. With diagnostics, the account's devices are asked for their logs.
    public func sendFeedback(note: String, diagnostics: Bool, platform: Platform) async throws {
        let body: [String: Any] = ["note": note, "diagnostics": diagnostics, "platform": platform.rawValue, "build": DeviceInfo.build]
        let _: Empty = try await request("POST", "/v1/feedback", body: body)
    }

    // MARK: Plumbing

    private struct Empty: Decodable {}

    /// Only onto the same account's session (another may have signed in meanwhile).
    private func updateStoredName(_ user: AccountUser) {
        guard var session = store.load(), session.userId == user.id, session.name != user.name else { return }
        session.name = user.name
        store.save(session)
    }

    /// Signing in, out or into another account: a refresh in flight is for the old session.
    /// (If its response arrives anyway, it finds a different token and is dropped.)
    private func sessionChanged() {
        refreshing?.cancel()
        refreshing = nil
    }

    /// The server says the session `token` belongs to is gone. Nothing happens if the stored
    /// session isn't that one any more (signed out, or into another account, since).
    private func signedOut(ifStillUsing token: String) {
        guard store.load()?.token == token else { return }
        sessionChanged()
        store.clear()
        NotificationCenter.default.post(name: Self.signedOutNotification, object: nil)
    }

    /// An authenticated call: refreshes an expired token first, and retries once after a
    /// refresh if the server says the token expired.
    private func request<T: Decodable>(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> T {
        try await authorized { token in try await self.send(method, path, body: body, token: token) }
    }

    private func authorized<T>(_ call: (String) async throws -> T) async throws -> T {
        guard var session = store.load() else { throw AccountAPIError.notSignedIn }
        if session.isExpired { session = try await refresh() }
        do {
            return try await call(session.token)
        } catch let error as AccountAPIError where error.code == "token-expired" {
            let refreshed = try await refresh()
            return try await call(refreshed.token)
        } catch let error as AccountAPIError where error.endsSession {
            signedOut(ifStillUsing: session.token)
            throw error
        }
    }

    private func send<T: Decodable>(_ method: String, _ path: String, body: [String: Any]?, token: String?) async throws -> T {
        let json = try body.map { try JSONSerialization.data(withJSONObject: $0) }
        let data = try await sendData(method, path, body: json, contentType: "application/json", token: token)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func sendData(_ method: String, _ path: String, body: Data?, contentType: String?, token: String?, headers: [String: String] = [:]) async throws -> Data {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = method
        request.timeoutInterval = 20
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        request.httpBody = body
        let (data, response) = try await urlSession.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw AccountAPIError(status: status, code: json?["error"] as? String ?? "http-\(status)",
                                  message: json?["message"] as? String ?? "")
        }
        return data
    }
}

// MARK: - iPhone ⇄ watch

/// WatchConnectivity keys. The watch asks for a session with its device ID; the iPhone makes
/// one with the API and sends it back (as a reply, or as queued user info if the watch
/// isn't reachable). Signing out on the iPhone signs the watch out too.
public enum WatchLink {
    /// Watch → iPhone: ["request": "session", "deviceId": …]
    public static let request = "request"
    public static let sessionRequest = "session"
    public static let deviceId = "deviceId"
    /// iPhone → watch: ["session": Data], or ["signedOut": true]
    public static let session = "session"
    public static let signedOut = "signedOut"
    /// Application context, both ways: iPhone ["signedIn": Bool]; watch ["deviceId": …, "needsSession": Bool]
    public static let signedIn = "signedIn"
    public static let needsSession = "needsSession"

    public static func encode(_ session: AccountSession) -> Data? {
        try? KeychainSessionStore.encoder.encode(session)
    }

    public static func decode(_ data: Data) -> AccountSession? {
        try? KeychainSessionStore.decoder.decode(AccountSession.self, from: data)
    }
}
