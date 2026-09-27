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
    private func send(to deviceId: String, reply: (([String: Any]) -> Void)?) {
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

    private func updateState(_ session: WCSession) {
        isPaired = session.isPaired
        isWatchAppInstalled = session.isWatchAppInstalled
    }

    private func handleRequest(_ payload: [String: Any], reply: (([String: Any]) -> Void)?) {
        if payload[WatchLink.request] as? String == WatchLink.sessionRequest, let deviceId = payload[WatchLink.deviceId] as? String {
            answered.remove(deviceId)
            send(to: deviceId, reply: reply)
        } else {
            reply?([:])
        }
    }
}

extension PhoneWatchLink: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        Task { @MainActor in
            updateState(session)
            guard activationState == .activated else { return }
            try? session.updateApplicationContext([WatchLink.signedIn: signedIn])
            if signedIn { answerWaitingWatch() }
        }
    }

    nonisolated func sessionWatchStateDidChange(_ session: WCSession) {
        Task { @MainActor in updateState(session) }
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    /// Switching to another watch: activate again for it.
    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        let payload = message
        nonisolated(unsafe) let reply = replyHandler
        Task { @MainActor in handleRequest(payload, reply: reply) }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        Task { @MainActor in
            answered = []
            if signedIn { answerWaitingWatch() }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        let payload = userInfo
        Task { @MainActor in handleRequest(payload, reply: nil) }
    }
}
