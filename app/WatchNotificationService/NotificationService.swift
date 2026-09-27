import Foundation
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
/// layout is shared with Watch/Prefetch.swift.
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
              let userId = UserDefaults(suiteName: group)?.string(forKey: "userId"),
              let url = Self.audioURL(userId: userId, conversationId: conversationId)
        else { return deliver() }

        let directory = container.appendingPathComponent("prefetch", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        files = (directory.appendingPathComponent("\(conversationId).records"),
                 directory.appendingPathComponent("\(conversationId).json"))

        var request = URLRequest(url: url, timeoutInterval: 20)
        if let token = Bundle.main.object(forInfoDictionaryKey: "OAOServerToken") as? String, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
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
}
