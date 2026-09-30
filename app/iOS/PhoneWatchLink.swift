import Foundation
import OverAndOutKit
import WatchConnectivity

/// Gives the watch its own session (design decision 2026-09-27). The watch asks with its
/// device ID, by message when the iPhone is reachable and in its application context
/// otherwise; the iPhone makes a watch session with the API and sends it back. Signing out
/// here signs the watch out too.
@MainActor
final class PhoneWatchLink: NSObject, ObservableObject {
    @Published private(set) var isPaired = false
    @Published private(set) var isWatchAppInstalled = false
    @Published private(set) var lastSentAt: Date?

    /// WatchConnectivity's reply handler for a message, called once from the main actor.
    /// `@unchecked Sendable`: WatchConnectivity doesn't annotate it, and it may be called from
    /// any thread; it's called exactly once (`send(to:reply:)` or `handleRequest`).
    struct Reply: @unchecked Sendable {
        let handler: ([String: Any]) -> Void
        func callAsFunction(_ payload: [String: Any]) { handler(payload) }
    }

    /// What the watch asked for, read where it arrived.
    struct Request: Sendable {
        /// The watch's device ID, if it asked for a session.
        let sessionFor: String?

        init(_ payload: [String: Any]) {
            sessionFor = payload[WatchLink.request] as? String == WatchLink.sessionRequest ? payload[WatchLink.deviceId] as? String : nil
        }
    }

    /// Makes a session for the watch's device ID; nil when signed out.
    var makeSession: ((String) async throws -> AccountSession?)?

    private var signedIn = false
    /// Device IDs a session has been sent to since the watch last asked.
    private var answered: Set<String> = []
    /// The watch asks by message, user info and application context, often at once. Each
    /// new session replaces the last, so every request in a burst gets the same one: made
    /// once (in flight) and reused for a minute.
    private var making: [String: Task<AccountSession?, Error>] = [:]
    private var recent: [String: (madeAt: Date, session: AccountSession)] = [:]

    func activate(signedIn: Bool) {
        self.signedIn = signedIn
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func signedInChanged(_ signedIn: Bool) {
        self.signedIn = signedIn
        answered = []
        recent = [:]
        guard WCSession.isSupported(), WCSession.default.activationState == .activated else { return }
        let session = WCSession.default
        try? session.updateApplicationContext([WatchLink.signedIn: signedIn])
        guard session.isPaired, session.isWatchAppInstalled else { return }
        if signedIn {
            // The watch may have asked while we were signed out.
            answerWaitingWatch()
        } else {
            session.transferUserInfo([WatchLink.signedOut: true])
        }
    }

    /// Sends the watch a fresh session now (Settings → Apple Watch).
    func resendSession() {
        let context = WCSession.default.receivedApplicationContext
        guard let deviceId = context[WatchLink.deviceId] as? String else { return }
        answered.remove(deviceId)
        recent[deviceId] = nil
        send(to: deviceId, reply: nil)
    }

    private func answerWaitingWatch() {
        let context = WCSession.default.receivedApplicationContext
        guard let deviceId = context[WatchLink.deviceId] as? String,
              context[WatchLink.needsSession] as? Bool == true else { return }
        send(to: deviceId, reply: nil)
    }

    /// Replies directly if the watch is waiting on a reply, or queues user info otherwise.
    private func send(to deviceId: String, reply: Reply?) {
        guard signedIn, let makeSession else {
            reply?([WatchLink.signedOut: true])
            return
        }
        if reply == nil, answered.contains(deviceId) { return }
        answered.insert(deviceId)
        Task {
            do {
                guard let session = try await session(for: deviceId, using: makeSession), let data = WatchLink.encode(session) else {
                    reply?([WatchLink.signedOut: true])
                    return
                }
                if let reply {
                    reply([WatchLink.session: data])
                } else {
                    WCSession.default.transferUserInfo([WatchLink.session: data])
                }
                lastSentAt = Date()
            } catch {
                answered.remove(deviceId)
                reply?([:])
            }
        }
    }

    private func session(for deviceId: String, using makeSession: @escaping (String) async throws -> AccountSession?) async throws -> AccountSession? {
        if let recent = recent[deviceId], recent.madeAt.timeIntervalSinceNow > -60 { return recent.session }
        if let task = making[deviceId] { return try await task.value }
        let task = Task { try await makeSession(deviceId) }
        making[deviceId] = task
        defer { making[deviceId] = nil }
        let session = try await task.value
        if let session { recent[deviceId] = (Date(), session) }
        return session
    }

    private func updateState(isPaired: Bool, isWatchAppInstalled: Bool) {
        self.isPaired = isPaired
        self.isWatchAppInstalled = isWatchAppInstalled
    }

    private func handleRequest(_ request: Request, reply: Reply?) {
        if let deviceId = request.sessionFor {
            answered.remove(deviceId)
            send(to: deviceId, reply: reply)
        } else {
            reply?([:])
        }
    }
}

/// WatchConnectivity calls these on its own queue; `session` is always `WCSession.default`.
extension PhoneWatchLink: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        let (isPaired, isWatchAppInstalled) = (session.isPaired, session.isWatchAppInstalled)
        Task { @MainActor in
            updateState(isPaired: isPaired, isWatchAppInstalled: isWatchAppInstalled)
            guard activationState == .activated else { return }
            try? WCSession.default.updateApplicationContext([WatchLink.signedIn: signedIn])
            if signedIn { answerWaitingWatch() }
        }
    }

    nonisolated func sessionWatchStateDidChange(_ session: WCSession) {
        let (isPaired, isWatchAppInstalled) = (session.isPaired, session.isWatchAppInstalled)
        Task { @MainActor in updateState(isPaired: isPaired, isWatchAppInstalled: isWatchAppInstalled) }
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    /// Switching to another watch: activate again for it.
    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        let request = Request(message)
        let reply = Reply(handler: replyHandler)
        Task { @MainActor in handleRequest(request, reply: reply) }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        Task { @MainActor in
            answered = []
            if signedIn { answerWaitingWatch() }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        let request = Request(userInfo)
        Task { @MainActor in handleRequest(request, reply: nil) }
    }
}
