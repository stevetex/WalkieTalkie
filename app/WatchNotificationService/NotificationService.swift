import Foundation
import os
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
    /// The download's completion and `serviceExtensionTimeWillExpire` run on different threads
    /// and either can finish the request, so everything they share is behind one lock and the
    /// notification is delivered exactly once, by whichever comes first.
    private struct State: Sendable {
        var delivery: Delivery?
        var task: URLSessionDataTask?
        var meta: [String: any Sendable] = [:]
        var files: (records: URL, meta: URL)?
        var conversationId = ""
    }

    /// The system's content handler and the content to deliver.
    /// `@unchecked Sendable`: UserNotifications doesn't annotate either. The handler may be
    /// called from any thread, `State` hands it out once, and the content isn't changed.
    private struct Delivery: @unchecked Sendable {
        let handler: (UNNotificationContent) -> Void
        let content: UNNotificationContent

        func deliver() { handler(content) }
    }

    private let state = OSAllocatedUnfairLock(initialState: State())
    /// This run, for its started and finished lines (the watch reports runs that never finish).
    private let requestId = UUID().uuidString

    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        let info = request.content.userInfo
        let conversationId = info["conversationId"] as? String ?? ""
        let delivery = Delivery(handler: contentHandler, content: request.content)
        let receivedAt = Self.nowMs()
        state.withLock {
            $0.delivery = delivery
            $0.meta["receivedAt"] = receivedAt
            $0.conversationId = conversationId
        }
        Self.diagnostics(["name": "nseStarted", "prefetch": info["prefetch"] != nil], requestId: requestId, conversationId: conversationId)
        guard info["prefetch"] != nil, info["conversationId"] is String,
              let group = Bundle.main.object(forInfoDictionaryKey: "OAOAppGroup") as? String,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
              let session = Self.session(accessGroup: group),
              let url = Self.audioURL(userId: session.userId, conversationId: conversationId)
        else { return finish() }

        let directory = container.appendingPathComponent("prefetch", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let files = (records: directory.appendingPathComponent("\(conversationId).records"),
                     meta: directory.appendingPathComponent("\(conversationId).json"))

        var request = URLRequest(url: url, timeoutInterval: 20)
        request.setValue("Bearer \(session.token)", forHTTPHeaderField: "Authorization")
        let state = state
        let requestId = requestId
        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            let http = response as? HTTPURLResponse
            let status = http?.statusCode ?? 0
            let delivery = state.withLock { state -> Delivery? in
                guard state.delivery != nil else { return nil }
                state.meta["fetchEndedAt"] = Self.nowMs()
                state.meta["status"] = status
                if let error { state.meta["error"] = error.localizedDescription }
                if status == 200, let data, let files = state.files {
                    state.meta["bytes"] = data.count
                    state.meta["frames"] = Int(http?.value(forHTTPHeaderField: "x-frames") ?? "") ?? 0
                    try? data.write(to: files.records, options: .atomic)
                }
                return Self.take(&state, requestId: requestId)
            }
            delivery?.deliver()
        }
        let expiresAt = info["ringExpiresAt"] as? Double
        let sentAt = info["pushSentAt"] as? Double
        state.withLock {
            // Whose message this is, and when the relay drops it: the app plays it only for this
            // account, and only before then (Watch/Prefetch.swift).
            $0.meta["userId"] = session.userId
            if let expiresAt { $0.meta["ringExpiresAt"] = expiresAt }
            if let sentAt { $0.meta["pushSentAt"] = sentAt }
            $0.files = files
            $0.meta["fetchStartedAt"] = Self.nowMs()
            $0.task = task
        }
        task.resume()
    }

    /// The extension's time is nearly up (about 30 s): show the ring without the audio.
    override func serviceExtensionTimeWillExpire() {
        let requestId = requestId
        let (task, delivery) = state.withLock { state -> (URLSessionDataTask?, Delivery?) in
            guard state.delivery != nil else { return (nil, nil) }
            state.meta["error"] = "extension time expired"
            return (state.task, Self.take(&state, requestId: requestId))
        }
        task?.cancel()
        delivery?.deliver()
    }

    /// Finishes without a download.
    private func finish() {
        let requestId = requestId
        state.withLock { Self.take(&$0, requestId: requestId) }?.deliver()
    }

    /// Takes the delivery, the first time only, after recording how the request ended. Under
    /// the lock, so the finished line and the metadata are written once, before delivery.
    private static func take(_ state: inout State, requestId: String) -> Delivery? {
        guard let delivery = state.delivery else { return nil }
        state.delivery = nil
        var finished: [String: any Sendable] = ["name": "nseFinished"]
        if let status = state.meta["status"] { finished["status"] = status }
        if let error = state.meta["error"] as? String { finished["error"] = String(error.prefix(80)) }
        if let bytes = state.meta["bytes"] { finished["bytes"] = bytes }
        diagnostics(finished, requestId: requestId, conversationId: state.conversationId)
        if let files = state.files, let data = try? JSONSerialization.data(withJSONObject: state.meta) {
            try? data.write(to: files.meta, options: .atomic)
        }
        return delivery
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

    /// One line in the app group's diagnostics/extension.jsonl, which the watch app moves into
    /// its own log (Watch/WatchDiagnostics.swift). IDs and times only.
    private static func diagnostics(_ fields: [String: any Sendable], requestId: String, conversationId: String) {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "OAOAppGroup") as? String,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return }
        var line = fields
        line["t"] = nowMs()
        line["requestId"] = requestId
        line["conversationId"] = conversationId
        guard var data = try? JSONSerialization.data(withJSONObject: line) else { return }
        data.append(0x0A)
        let directory = container.appendingPathComponent("diagnostics", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent("extension.jsonl")
        if let handle = try? FileHandle(forWritingTo: file) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? data.write(to: file)
        }
    }

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
