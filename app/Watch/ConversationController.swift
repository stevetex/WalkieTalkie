import AVFoundation
import Combine
import OverAndOutKit
import UserNotifications
import WatchKit

/// Runs conversations. Option C in the feasibility doc: no CallKit on the watch.
///
///   Receiver: the relay's time-sensitive notification rings → tapping it opens the app and
///             is the answer → the request that opens the relay stream also joins
///             (?join=<conversationId>) → the buffered message replays → conversation window.
///   Sender:   press Talk → the app's own audio session and the relay stream → talk-start,
///             then frames.
///
/// A conversation ends by itself after `conversationWindow` with no audio either way.
/// Everything here runs on the main queue: the relay and notifications deliver there, and
/// the audio pipeline hops back to it.
final class ConversationController: NSObject, ObservableObject {
    static let shared = ConversationController()

    /// Idle time that ends a conversation (fixed for the MVP; see Design decisions).
    static let conversationWindow: TimeInterval = 45
    /// An in-app ring stops after this; the relay abandons the ring at 35 s.
    static let inAppRingTimeout: TimeInterval = 30

    enum Phase: Equatable {
        case idle
        case connecting
        case live
    }

    @Published var settings = AppSettings.load() {
        didSet { if settings != oldValue { settings.save() } }
    }
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var statusLine = ""
    @Published private(set) var peerName: String?
    @Published private(set) var isTalking = false
    @Published private(set) var remoteTalking = false
    /// In a conversation and able to record right now (relay open and audio on). The Talk
    /// button shows "Wait…" until then.
    @Published private(set) var talkReady = false
    /// A ring that arrived while the app was on screen, waiting for Answer or Decline.
    @Published private(set) var incomingRing: Ring?
    @Published private(set) var registrationStatus = "Not registered yet"
    @Published private(set) var logLines: [String] = []

    var codecDescription: String { audio.codecDescription }

    private struct Conversation {
        let outgoing: Bool
        var conversationId: String?
        var peerId: String
        var peerName: String
        var timeline: Timeline
        var audioActive = false
        /// Receiver: the relay confirmed the join.
        var joined = false
    }

    private let relay = RelayConnection()
    private let audio = AudioPipeline()

    private var started = false
    private var conversation: Conversation?
    private var talkHeld = false
    private var burstId: String?
    private var sentFirstFrame = false
    private var idleTimer: Timer?
    private var incomingRingTimer: Timer?
    private var activatingAudio = false
    /// Answering already retried on a fresh stream once.
    private var rejoinedOnFreshStream = false
    /// Server clock minus watch clock. The relay's hello-ack gives a first estimate, but the
    /// watch's first request is slowed by its network starting up, so it's refined with a
    /// few quick /v1/time samples once the network is up (smallest round trip wins).
    private var clockOffsetMs: Double = 0
    private var bestClockRoundTripMs = Double.infinity
    /// Uplink POSTs logged since the current burst started (only the first few are kept).
    private var postsThisBurst = 0
    private var watchdog: DispatchSourceTimer?

    /// Called from applicationDidFinishLaunching: a notification tap can launch the app, and
    /// its response is only delivered if the notification delegate is set by then.
    func start() {
        guard !started else { return }
        started = true
        UNUserNotificationCenter.current().delegate = self

        relay.onReady = { [unowned self] offset in relayReady(clockOffsetMs: offset) }
        relay.onMessage = { [unowned self] message in handle(message) }
        relay.onFrame = { [unowned self] frame in
            if conversation?.timeline.has("firstFrameReceived") == false { conversation?.timeline.mark("firstFrameReceived") }
            audio.enqueue(frame)
        }
        relay.onClose = { [unowned self] reason in
            guard let current = conversation else { return }
            if !current.outgoing, !current.joined {
                return rejoinOnFreshStream("relay closed before joining: \(reason)")
            }
            log("Relay closed: \(reason)")
            finish()
        }
        relay.onPostFinished = { [unowned self] started, finished, bytes, status in
            guard burstId != nil || talkHeld, postsThisBurst < 3 else { return }
            postsThisBurst += 1
            conversation?.timeline.mark("post\(postsThisBurst)", at: finished,
                                        detail: "\(bytes) bytes, \(Int(finished - started)) ms, HTTP \(status)", once: false)
        }

        audio.onFrame = { [weak self] frame in
            DispatchQueue.main.async { self?.sendCaptured(frame) }
        }
        audio.onFirstPlayback = { [weak self] in
            DispatchQueue.main.async {
                self?.conversation?.timeline.mark("firstAudioScheduled")
                self?.conversation?.timeline.mark("burstAudioStarted", once: false)
            }
        }
        audio.onFirstCapturedFrame = { [weak self] t in
            DispatchQueue.main.async { self?.conversation?.timeline.mark("micFirstFrame", at: t, once: false) }
        }
        audio.onRestart = { [unowned self] detail in log("Audio: \(detail)") }

        NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [unowned self] note in handleAudioInterruption(note) }
        startMainThreadWatchdog()
        log("Codec: \(audio.codecDescription)")
        registerForRings()
    }

    // MARK: Permissions and push registration

    func requestMicrophone() {
        let completion: (Bool) -> Void = { granted in
            DispatchQueue.main.async { if !granted { self.log("Microphone permission denied") } }
        }
        if #available(watchOS 10.0, *) {
            AVAudioApplication.requestRecordPermission(completionHandler: completion)
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission(completion)
        }
    }

    /// Asks to show notifications, then registers for remote notifications. The simulator
    /// can't get an APNs token, so it registers a "simulator:" token instead, which a relay
    /// running on the same Mac delivers with `xcrun simctl push` (SIMULATOR_PUSH=1).
    private func registerForRings() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            DispatchQueue.main.async {
                if !granted { self.log("Notifications aren't allowed, so rings can't reach this watch") }
                #if targetEnvironment(simulator)
                let udid = ProcessInfo.processInfo.environment["SIMULATOR_UDID"] ?? ""
                self.registerDevice(pushToken: "simulator:\(udid):\(Bundle.main.bundleIdentifier ?? "")")
                #else
                WKApplication.shared().registerForRemoteNotifications()
                #endif
            }
        }
    }

    func didRegisterForRemoteNotifications(deviceToken: Data) {
        registerDevice(pushToken: deviceToken.map { String(format: "%02x", $0) }.joined())
    }

    /// No push entitlement (a Personal Team build) or no network. The watch can still start
    /// conversations; it just can't be rung. A "poll:" token keeps it in the user list.
    func didFailToRegisterForRemoteNotifications(_ error: Error) {
        log("Push registration failed: \(error.localizedDescription)")
        registerDevice(pushToken: "poll:\(settings.userId)", note: "can't be rung (no push)")
    }

    private func registerDevice(pushToken: String, note: String? = nil) {
        let api = APIClient(settings: settings)
        Task { @MainActor in
            do {
                try await api.registerDevice(pushToken: pushToken)
                registrationStatus = "Registered as \(settings.userId)" + (note.map { ", \($0)" } ?? "")
            } catch {
                registrationStatus = "Registration failed: \(error.localizedDescription)"
            }
        }
    }

    func fetchUsers() async throws -> [APIClient.User] {
        try await APIClient(settings: settings).users().filter { $0.userId != settings.userId }
    }

    // MARK: UI actions

    func talkPressed() {
        guard !talkHeld, conversation != nil || settings.hasFriend else { return }
        talkHeld = true
        isTalking = true
        idleTimer?.invalidate()
        if conversation == nil {
            startOutgoingConversation()
        } else {
            conversation?.timeline.mark("talkPressedInWindow", once: false)
            startBurstIfReady()
        }
    }

    func talkReleased() {
        guard talkHeld else { return }
        talkHeld = false
        isTalking = false
        conversation?.timeline.mark("talkReleased", once: false)
        guard let id = burstId else {
            resetIdleTimer()
            return
        }
        // Flush the last partial frame before telling the relay the burst is over.
        audio.endCapture {
            DispatchQueue.main.async {
                self.relay.send(["type": "talk-end", "burstId": id])
                if self.burstId == id { self.burstId = nil }
                self.resetIdleTimer()
            }
        }
    }

    func answerIncomingRing() {
        guard let ring = incomingRing else { return }
        answer(ring, via: "in app")
    }

    /// The relay abandons an unanswered ring by itself; nothing to tell it.
    func declineIncomingRing() {
        incomingRingTimer?.invalidate()
        incomingRing = nil
    }

    func end() {
        finish()
    }

    // MARK: Answering

    /// Opening the ring notification (or Answer in the app) is the answer. The request that
    /// opens the relay stream also joins, so the relay starts the replay without waiting
    /// for another round trip on a network that's still waking up.
    private func answer(_ ring: Ring, via: String, delivered: Date? = nil, openedAt: Double = Clock.nowMs()) {
        declineIncomingRing()
        if let current = conversation {
            if current.conversationId == ring.conversationId { return }
            finish()
        }
        var timeline = Timeline(role: .receiver)
        if let delivered {
            let deliveredAt = delivered.timeIntervalSince1970 * 1000
            timeline.mark("notificationDelivered", at: deliveredAt)
            // A process that started after the notification arrived is a cold launch.
            if let launchedAt = Self.processStartMs(), launchedAt >= deliveredAt - 1_000 {
                timeline.mark("appLaunched", at: launchedAt)
            }
            timeline.mark("notificationOpened", at: openedAt)
        }
        if let sentAt = ring.pushSentAt {
            timeline.mark("pushSentAtServer", detail: String(Int(sentAt)))
        }
        timeline.mark("answerTapped", at: openedAt, detail: via)
        conversation = Conversation(outgoing: false, conversationId: ring.conversationId,
                                    peerId: ring.from, peerName: ring.fromName, timeline: timeline)
        phase = .connecting
        peerName = ring.fromName
        statusLine = "Connecting to \(ring.fromName)…"
        rejoinedOnFreshStream = false
        conversation?.timeline.mark("joinSent", detail: "with the stream")
        connectRelay(join: ring.conversationId)
        activateOwnAudio()
        resetIdleTimer()
        removeDeliveredNotifications(for: ring.conversationId)
    }

    /// The stream can fail while the watch's network is waking. Try once more, then give up.
    private func rejoinOnFreshStream(_ why: String) {
        guard !rejoinedOnFreshStream, let conversationId = conversation?.conversationId else {
            log("Couldn't join: \(why)")
            return finish(status: "Couldn't connect")
        }
        rejoinedOnFreshStream = true
        log("Rejoining on a fresh stream (\(why))")
        conversation?.timeline.mark("joinSent", detail: "fresh stream", once: false)
        connectRelay(join: conversationId)
    }

    private func removeDeliveredNotifications(for conversationId: String) {
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { notifications in
            let ids = notifications
                .filter { Ring(userInfo: $0.request.content.userInfo)?.conversationId == conversationId }
                .map(\.request.identifier)
            center.removeDeliveredNotifications(withIdentifiers: ids)
        }
    }

    // MARK: Outgoing

    private func startOutgoingConversation() {
        var timeline = Timeline(role: .sender)
        timeline.mark("talkPressed")
        let name = settings.friendName.isEmpty ? settings.friendId : settings.friendName
        conversation = Conversation(outgoing: true, conversationId: nil,
                                    peerId: settings.friendId, peerName: name, timeline: timeline)
        phase = .connecting
        peerName = name
        statusLine = "Connecting…"
        connectRelay()
        activateOwnAudio()
    }

    // MARK: Relay

    private func connectRelay(join: String? = nil) {
        guard let baseURL = settings.baseURL else {
            log("The server isn't configured in this build")
            return finish(status: "No server configured")
        }
        relay.connect(baseURL: baseURL, token: settings.token, userId: settings.userId, join: join)
    }

    private func updateTalkReady() {
        talkReady = conversation != nil && relay.isReady && conversation?.audioActive == true
    }

    private func relayReady(clockOffsetMs: Double) {
        guard let current = conversation else { return }
        defer { updateTalkReady() }
        conversation?.timeline.mark("socketOpen")
        self.clockOffsetMs = clockOffsetMs
        bestClockRoundTripMs = .infinity
        refineClockOffset()
        if current.outgoing {
            phase = .live
            statusLine = "Talking to \(current.peerName)"
            startBurstIfReady()
            resetIdleTimer()
        }
        // A receiver joined in the stream request itself; "joined" follows.
    }

    private func refineClockOffset() {
        guard conversation != nil else { return }
        let api = APIClient(settings: settings)
        Task { @MainActor in
            for _ in 0..<3 {
                guard let sample = try? await api.timeSample(), conversation != nil else { return }
                if sample.roundTripMs < bestClockRoundTripMs {
                    bestClockRoundTripMs = sample.roundTripMs
                    clockOffsetMs = sample.offsetMs
                }
            }
            conversation?.timeline.mark("clockSynced", detail: "offset \(Int(clockOffsetMs)) ms, round trip \(Int(bestClockRoundTripMs)) ms")
        }
    }

    private func handle(_ message: RelayMessage) {
        let name = conversation?.peerName ?? "Your friend"
        switch message.type {
        case "floor-granted":
            conversation?.conversationId = message.conversationId
            conversation?.timeline.mark("floorGranted", detail: message.pushed == true ? "rang recipient" : "recipient live")
        case "floor-denied":
            WKInterfaceDevice.current().play(.failure)
            statusLine = "\(name) is talking"
            audio.endCapture {}
            burstId = nil
        case "joined":
            conversation?.joined = true
            conversation?.timeline.mark("joined", detail: "\(message.replayBursts ?? 0) buffered bursts")
            phase = .live
            statusLine = "With \(name)"
        case "burst-start":
            conversation?.timeline.mark("burstStartReceived", detail: message.replay == true ? "replay" : "live", once: false)
            remoteTalking = true
            statusLine = "\(name) is talking"
            idleTimer?.invalidate()
            audio.beginPlayback()
        case "burst-end":
            remoteTalking = false
            statusLine = "With \(name)"
            audio.endPlayback()
            resetIdleTimer()
        case "peer-left":
            log("\(name) left")
        case "ring-timeout":
            // The relay dropped what they didn't hear; the next Talk rings them again.
            WKInterfaceDevice.current().play(.failure)
            statusLine = "\(name) didn't answer"
            conversation?.timeline.mark("ringTimedOut", detail: "\(message.droppedBursts ?? 0) bursts dropped")
        case "error":
            log("Relay error: \(message.message ?? "unknown")")
            if message.message == "unknown conversation", conversation?.outgoing == false, conversation?.joined == false {
                // Answered after the relay gave up on the ring: the message is gone.
                WKInterfaceDevice.current().play(.failure)
                finish(status: "Missed \(name)")
            }
        default:
            break
        }
    }

    // MARK: Talking

    private func startBurstIfReady() {
        guard talkHeld, burstId == nil, relay.isReady, let current = conversation, current.audioActive else { return }
        let id = UUID().uuidString
        burstId = id
        sentFirstFrame = false
        postsThisBurst = 0
        relay.send(["type": "talk-start", "to": current.peerId, "burstId": id])
        conversation?.timeline.mark("captureStarted", once: false)
        audio.beginCapture()
        // Signal "go ahead" only once the mic is live: anything said before this isn't captured.
        WKInterfaceDevice.current().play(.start)
    }

    private func sendCaptured(_ frame: Data) {
        guard burstId != nil else { return }
        relay.send(frame: frame)
        if !sentFirstFrame {
            sentFirstFrame = true
            conversation?.timeline.mark("firstFrameSent")
        }
    }

    // MARK: Conversation window

    private func resetIdleTimer() {
        idleTimer?.invalidate()
        guard conversation != nil else { return }
        idleTimer = Timer.scheduledTimer(withTimeInterval: Self.conversationWindow, repeats: false) { [weak self] _ in
            guard let self else { return }
            if talkHeld || remoteTalking {
                resetIdleTimer()
            } else {
                log("Conversation window ended")
                finish()
            }
        }
    }

    // MARK: Audio session

    private func activateOwnAudio() {
        guard conversation != nil, conversation?.audioActive == false, !activatingAudio else { return }
        activatingAudio = true
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [])
        } catch {
            log("Audio session setup failed: \(error.localizedDescription)")
        }
        session.activate(options: []) { success, error in
            DispatchQueue.main.async {
                self.activatingAudio = false
                if success {
                    self.audioSessionActivated()
                } else {
                    self.log("Audio activation failed: \(error?.localizedDescription ?? "unknown")")
                }
            }
        }
    }

    private func audioSessionActivated() {
        guard conversation != nil, conversation?.audioActive == false else { return }
        conversation?.timeline.mark("audioActivated")
        do {
            try audio.start()
        } catch {
            log("Audio: \(error.localizedDescription)")
        }
        // Playback runs even if capture couldn't start.
        conversation?.audioActive = true
        updateTalkReady()
        startBurstIfReady()
    }

    /// Something else (a phone call, Siri) interrupted the app's audio.
    private func handleAudioInterruption(_ note: Notification) {
        guard conversation != nil,
              let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        switch type {
        case .began:
            log("Audio interrupted")
            audio.stop()
            conversation?.audioActive = false
            updateTalkReady()
        case .ended:
            log("Audio interruption ended")
            activateOwnAudio()
        @unknown default:
            break
        }
    }

    // MARK: Teardown

    /// Ends the conversation. `status` stays on screen afterwards (for example "Missed Alice").
    private func finish(status: String = "") {
        guard var ended = conversation else {
            statusLine = status
            return
        }
        if let conversationId = ended.conversationId {
            relay.send(["type": "leave", "conversationId": conversationId])
        }
        let offset = clockOffsetMs
        relay.close()
        audio.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        ended.timeline.mark("callEnded")

        conversation = nil
        talkReady = false
        talkHeld = false
        isTalking = false
        remoteTalking = false
        burstId = nil
        idleTimer?.invalidate()
        phase = .idle
        peerName = nil
        statusLine = status

        guard let conversationId = ended.conversationId else { return }
        let body = ended.timeline.upload(conversationId: conversationId, userId: settings.userId, clockOffsetMs: offset)
        let api = APIClient(settings: settings)
        Task { @MainActor in
            do {
                try await api.uploadMetrics(body)
            } catch {
                log("Metrics upload failed: \(error.localizedDescription)")
            }
        }
    }

    // MARK: Diagnostics

    /// Application state changes (wrist down, app in the background), for the timeline.
    func noteAppState(_ state: String) {
        conversation?.timeline.mark("app", detail: state, once: false)
    }

    func log(_ line: String) {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        let entry = "\(formatter.string(from: Date())) \(line)"
        print("[oao] \(entry)")
        conversation?.timeline.mark("log", detail: line, once: false)
        logLines.append(entry)
        if logLines.count > 60 { logLines.removeFirst(logLines.count - 60) }
    }

    /// Notices when the main thread stalls or the whole process was paused (a late tick),
    /// for example suspended by watchOS during a quiet spell.
    private func startMainThreadWatchdog() {
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + 1, repeating: .milliseconds(250))
        var lastTick = Clock.nowMs()
        timer.setEventHandler { [weak self] in
            let queuedAt = Clock.nowMs()
            let gap = queuedAt - lastTick
            lastTick = queuedAt
            if gap > 1_000 {
                DispatchQueue.main.async {
                    self?.conversation?.timeline.mark("processPaused", at: queuedAt - gap, detail: "\(Int(gap)) ms", once: false)
                }
            }
            DispatchQueue.main.async {
                let lag = Clock.nowMs() - queuedAt
                guard lag > 750, let self, self.conversation != nil else { return }
                self.conversation?.timeline.mark("mainStall", at: queuedAt, detail: "\(Int(lag)) ms", once: false)
            }
        }
        timer.resume()
        watchdog = timer
    }

    /// When this process started (ms since epoch), to spot a cold launch.
    private static func processStartMs() -> Double? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0 else { return nil }
        let start = info.kp_proc.p_un.__p_starttime
        return Double(start.tv_sec) * 1000 + Double(start.tv_usec) / 1000
    }
}

// MARK: - Notifications

extension ConversationController: UNUserNotificationCenterDelegate {
    /// A ring while the app is on screen: ring in the app instead of showing the banner.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        guard let ring = Ring(userInfo: notification.request.content.userInfo) else {
            return completionHandler([.banner, .sound])
        }
        DispatchQueue.main.async {
            defer { completionHandler([]) }
            guard self.conversation?.conversationId != ring.conversationId else { return }
            self.incomingRing = ring
            WKInterfaceDevice.current().play(.notification)
            self.incomingRingTimer?.invalidate()
            self.incomingRingTimer = Timer.scheduledTimer(withTimeInterval: Self.inAppRingTimeout, repeats: false) { _ in
                guard self.incomingRing == ring else { return }
                self.incomingRing = nil
                self.statusLine = "Missed \(ring.fromName)"
            }
        }
    }

    /// Tapping the ring notification answers it.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let openedAt = Clock.nowMs()
        let ring = Ring(userInfo: response.notification.request.content.userInfo)
        let delivered = response.notification.date
        let tapped = response.actionIdentifier == UNNotificationDefaultActionIdentifier
        DispatchQueue.main.async {
            defer { completionHandler() }
            guard let ring, tapped else { return }
            self.answer(ring, via: "notification", delivered: delivered, openedAt: openedAt)
        }
    }
}
