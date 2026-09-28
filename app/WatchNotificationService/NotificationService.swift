import Foundation
import Security
import UserNotifications

/// Prototype: downloads a ring's message before it's tapped.
///
/// A tap on the ring notification took 2.4–3.7 s to first audio, most of it the watch's
/// network waking up for the first request after the tap (runs 27–30 in the feasibility
/// doc). When the relay's second, "prefetch" push arrives (prefetchAlert in
/// server/src/apns.ts), the network has just carried it, so this extension downloads the
/// buffered message then, into the app group. The app plays it as soon as the ring is
/// tapped (ConversationController.playPrefetched) and skips those frames in the replay.
///
/// Kept free of OverAndOutKit so the extension stays small: it only moves bytes. The file
/// layout is shared with Watch/Prefetch.swift, and the session (the account's token) is the
/// one WatchAccount keeps in the Keychain under the app group (KeychainSessionStore).
final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var content: UNNotificationContent?
    private var task: URLSessionDataTask?
    private var meta: [String: Any] = [:]
    private var files: (records: URL, meta: URL)?

    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        content = request.content
        meta["receivedAt"] = Self.nowMs()
        let info = request.content.userInfo
        guard info["prefetch"] != nil,
              let conversationId = info["conversationId"] as? String,
              let group = Bundle.main.object(forInfoDictionaryKey: "OAOAppGroup") as? String,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
              let session = Self.session(accessGroup: group),
              let url = Self.audioURL(userId: session.userId, conversationId: conversationId)
        else { return deliver() }

        // Whose message this is, and when the relay drops it: the app plays it only for this
        // account, and only before then (Watch/Prefetch.swift).
        meta["userId"] = session.userId
        if let expiresAt = info["ringExpiresAt"] as? Double { meta["ringExpiresAt"] = expiresAt }
        if let sentAt = info["pushSentAt"] as? Double { meta["pushSentAt"] = sentAt }

        let directory = container.appendingPathComponent("prefetch", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        files = (directory.appendingPathComponent("\(conversationId).records"),
                 directory.appendingPathComponent("\(conversationId).json"))

        var request = URLRequest(url: url, timeoutInterval: 20)
        request.setValue("Bearer \(session.token)", forHTTPHeaderField: "Authorization")
        meta["fetchStartedAt"] = Self.nowMs()
        task = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self else { return }
            meta["fetchEndedAt"] = Self.nowMs()
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            meta["status"] = status
            if let error { meta["error"] = error.localizedDescription }
            if status == 200, let data, let files {
                meta["bytes"] = data.count
                meta["frames"] = Int((response as? HTTPURLResponse)?.value(forHTTPHeaderField: "x-frames") ?? "") ?? 0
                try? data.write(to: files.records, options: .atomic)
            }
            deliver()
        }
        task?.resume()
    }

    /// The extension's time is nearly up (about 30 s): show the ring without the audio.
    override func serviceExtensionTimeWillExpire() {
        meta["error"] = "extension time expired"
        task?.cancel()
        deliver()
    }

    private func deliver() {
        guard let contentHandler, let content else { return }
        self.contentHandler = nil
        if let files, let data = try? JSONSerialization.data(withJSONObject: meta) {
            try? data.write(to: files.meta, options: .atomic)
        }
        contentHandler(content)
    }

    private static func audioURL(userId: String, conversationId: String) -> URL? {
        guard let host = Bundle.main.object(forInfoDictionaryKey: "OAOServerHost") as? String, !host.isEmpty else { return nil }
        // A server on this Mac (for the simulator) is reached over plain HTTP.
        let scheme = host.hasPrefix("localhost") || host.hasPrefix("127.0.0.1") ? "http" : "https"
        var components = URLComponents(string: "\(scheme)://\(host)/v1/rings/audio")
        components?.queryItems = [URLQueryItem(name: "userId", value: userId),
                                  URLQueryItem(name: "conversationId", value: conversationId)]
        return components?.url
    }

    private static func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

    /// The watch's session. An expired token is left to the app to refresh: without it the
    /// ring still works, just without the prefetch.
    private static func session(accessGroup: String) -> (token: String, userId: String)? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.cypressoakstudios.overandout.session",
            kSecAttrAccount as String: "session",
            kSecAttrAccessGroup as String: accessGroup,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = json["token"] as? String, let userId = json["userId"] as? String,
              let expiresAt = json["expiresAt"] as? Double, expiresAt > nowMs()
        else { return nil }
        return (token, userId)
    }
}
