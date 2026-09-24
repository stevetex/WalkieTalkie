import AVFoundation
import CallKit
import Combine
import UserNotifications
import WatchKit

/// Coordinates a conversation. CallKit is used only to ring (option B in the
/// feasibility doc), because watchOS locks the screen into the system call UI for as long
/// as a call is active, which would hide the Talk button:
///
///   Receiver: ring (VoIP push, or polled while the app is open) → CallKit incoming call →
///             user answers → the call is ended at once and the app is back on screen →
///             the app turns on its own audio session and reaches the relay over HTTPS →
///             join → buffered burst replays → conversation window.
///   Sender:   press Talk → own audio session + HTTPS relay → talk-start + stream frames.
///
/// The conversation ends by itself after `conversationWindowSeconds` with no audio either
/// way. Everything here runs on the main queue: CallKit, PushKit and the relay all deliver
/// there, and the audio pipeline hops back to it.
final class SpikeController: NSObject, ObservableObject {
    static let shared = SpikeController()

    enum Phase: Equatable {
        case idle
        case ringing
        case connecting
        case live
    }

    @Published var settings = SpikeSettings.load() {
        didSet { if settings != oldValue { settings.save() } }
    }
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var statusLine = "Idle"
    @Published private(set) var isTalking = false
    @Published private(set) var remoteTalking = false
    /// In a conversation and able to record right now (relay open and audio on). The Talk
    /// button shows "Wait…" until then.
    @Published private(set) var talkReady = false
    @Published private(set) var registrationStatus = "Waiting for VoIP push token"
    @Published private(set) var lastRun: [String] = []
    @Published private(set) var logLines: [String] = []
    /// Notification ring test: shown under Settings → Experiments.
    @Published private(set) var notificationTestStatus = ""

    var codecDescription: String { audio.codecDescription }

    private struct ActiveCall {
        let uuid: UUID
        let outgoing: Bool
        var conversationId: String?
        var peerId: String
        var peerName: String
        var timeline: Timeline
        var audioActive = false
        var answered = false
        /// True while the CallKit call (ringing only) is still up.
        var callKitActive = false
    }

    private let push = PushService()
    private let provider: CXProvider
    private let callController = CXCallController()
    private let relay = RelayConnection()
    private let audio = AudioPipeline()

    private var started = false
    private var call: ActiveCall?
    private var talkHeld = false
    private var burstId: String?
    private var sentFirstFrame = false
    private var idleTimer: Timer?
    private var ringTimer: Timer?
    private var activatingAudio = false
    private var watchdog: DispatchSourceTimer?
    /// Server clock minus watch clock. The relay's hello-ack gives a first estimate, but the
    /// watch's first request is slowed by its network starting up, so it's refined with a
    /// few quick /v1/time samples once the network is up (smallest round trip wins).
    private var clockOffsetMs: Double = 0
    private var bestClockRoundTripMs = Double.infinity
    /// Uplink POSTs logged since the current burst started (only the first few are kept).
    private var postsThisBurst = 0
    /// Set after answering: turn on the app's own audio once CallKit lets go of the session.
    private var awaitingOwnAudio = false
    /// Notification ring test (a local notification standing in for option C's push): after
    /// the notification is opened, the next collected ring is answered at once, and these
    /// events (scheduled, delivered, opened, cold launch) go into its timeline.
    private var answerNextRing = false
    /// Answering from the notification already retried on a fresh stream once.
    private var rejoinedOnFreshStream = false
    private var pendingRingEvents: [(name: String, t: Double, detail: String?)] = []

    override init() {
        let configuration = CXProviderConfiguration()
        configuration.maximumCallGroups = 1
        configuration.maximumCallsPerCallGroup = 1
        configuration.supportedHandleTypes = [.generic]
        configuration.includesCallsInRecents = false
        provider = CXProvider(configuration: configuration)
        super.init()
    }

    func start() {
        guard !started else { return }
        started = true
        provider.setDelegate(self, queue: nil)
        UNUserNotificationCenter.current().delegate = self
        if let armedAt = NotificationRingTest.armedAt {
            // Launched while a test notification was pending: a cold launch from it, most likely.
            pendingRingEvents.append(("appLaunched", NotificationRingTest.processStartMs() ?? Timeline.nowMs(), nil))
            pendingRingEvents.append(("appStarted", Timeline.nowMs(), "didFinishLaunching"))
            notificationTestStatus = "Armed at \(NotificationRingTest.clock(armedAt))"
        }

        push.onToken = { [unowned self] _ in
            registrationStatus = "Push token received"
            registerDevice()
        }
        push.onIncomingPush = { [unowned self] payload, completion in
            handleIncomingPush(payload, completion: completion)
        }
        if !SpikeSettings.usesPolledRings { push.start() }

        relay.onReady = { [unowned self] offset in relayReady(clockOffsetMs: offset) }
        relay.onMessage = { [unowned self] message in handle(message) }
        relay.onFrame = { [unowned self] frame in
            if call?.timeline.has("firstFrameReceived") == false { call?.timeline.mark("firstFrameReceived") }
            audio.enqueue(frame)
        }
        relay.onClose = { [unowned self] reason in
            guard let current = call else { return }
            if !current.outgoing, current.answered, current.conversationId == nil {
                return rejoinOnFreshStream("relay closed before joining: \(reason)")
            }
            log("Relay closed: \(reason)")
            endCall()
        }

        audio.onFrame = { [weak self] frame in
            DispatchQueue.main.async { self?.sendCaptured(frame) }
        }
        audio.onFirstPlayback = { [weak self] in
            DispatchQueue.main.async {
                self?.call?.timeline.mark("firstAudioScheduled")
                self?.call?.timeline.mark("burstAudioStarted", once: false)
            }
        }
        audio.onFirstCapturedFrame = { [weak self] t in
            DispatchQueue.main.async { self?.call?.timeline.mark("micFirstFrame", at: t, once: false) }
        }
        audio.onRestart = { [unowned self] detail in log("Audio: \(detail)") }
        relay.onPostFinished = { [unowned self] started, finished, bytes, status in
            guard burstId != nil || talkHeld, postsThisBurst < 3 else { return }
            postsThisBurst += 1
            call?.timeline.mark("post\(postsThisBurst)", at: finished,
                                detail: "\(bytes) bytes, \(Int(finished - started)) ms, HTTP \(status)", once: false)
        }
        NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [unowned self] note in handleAudioInterruption(note) }
        startMainThreadWatchdog()
        log("Codec: \(audio.codecDescription)")
        if SpikeSettings.usesPolledRings { startRingPolling() }
        if NotificationRingTest.armedAt != nil {
            // Most likely launched in the background as the test notification is delivered
            // (watchOS does this before the tap): open the relay stream now, while the app
            // still runs, so the tap only has to send "join" over it.
            pendingRingEvents.append(("preconnectStarted", Timeline.nowMs(), nil))
            connectRelay()
        }
    }

    /// Without VoIP push (the simulator, or a SPIKE_PUSH_MODE = none build), register a
    /// "poll:" token and collect rings from the server every 1.5 s. Each one is handled
    /// exactly like a push. On a watch it rings through CallKit, but only while the app
    /// is running, since timers stop when it's suspended.
    private func startRingPolling() {
        registrationStatus = "No VoIP push: rings arrive while the app is open"
        registerDevice()
        Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            // While a test notification is armed, the ring waits for the notification instead.
            guard NotificationRingTest.armedAt == nil else { return }
            self?.pollRings()
        }
    }

    private func pollRings() {
        guard call == nil, !settings.serverHost.isEmpty else { return }
        let api = APIClient(settings: settings)
        Task { @MainActor in
            guard let rings = try? await api.polledRings() else { return }
            for payload in rings {
                self.handleIncomingPush(payload) {}
            }
        }
    }

    // MARK: UI actions

    func requestMicrophone() {
        AVAudioApplication.requestRecordPermission { granted in
            DispatchQueue.main.async { if !granted { self.log("Microphone permission denied") } }
        }
    }

    func registerDevice() {
        let token: String
        if SpikeSettings.usesPolledRings {
            token = "poll:\(settings.userId)"
        } else if let pushToken = push.token {
            token = pushToken
        } else {
            return
        }
        let api = APIClient(settings: settings)
        Task { @MainActor in
            do {
                try await api.registerDevice(voipToken: token)
                registrationStatus = "Registered as \(settings.userId)"
            } catch {
                registrationStatus = "Registration failed: \(error.localizedDescription)"
            }
        }
    }

    func fetchUsers() async throws -> [APIClient.User] {
        try await APIClient(settings: settings).users().filter { $0.userId != settings.userId }
    }

    func talkPressed() {
        guard settings.isConfigured, !talkHeld else { return }
        talkHeld = true
        isTalking = true
        idleTimer?.invalidate()

        if call == nil {
            startOutgoingConversation()
        } else {
            call?.timeline.mark("talkPressedInWindow", once: false)
            startBurstIfReady()
        }
    }

    func talkReleased() {
        guard talkHeld else { return }
        talkHeld = false
        isTalking = false
        call?.timeline.mark("talkReleased", once: false)
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

    /// Answer from inside the app. A CallKit ring goes through CallKit like the system
    /// answer button; an in-app ring answers directly.
    func answer() {
        guard let call, !call.outgoing, !call.answered else { return }
        guard call.callKitActive else {
            // In-app ring: no CallKit call to answer.
            beginAnswer()
            activateOwnAudio()
            return
        }
        callController.request(CXTransaction(action: CXAnswerCallAction(call: call.uuid))) { [weak self] error in
            guard let error else { return }
            DispatchQueue.main.async { self?.log("Answer failed: \(error.localizedDescription)") }
        }
    }

    func endCall() {
        guard let call else { return }
        // After answering, the CallKit call is already gone; only a ringing call needs ending.
        guard call.callKitActive else { return finishCall() }
        callController.request(CXTransaction(action: CXEndCallAction(call: call.uuid))) { [weak self] error in
            guard let error else { return }
            DispatchQueue.main.async {
                self?.log("End call request failed: \(error.localizedDescription)")
                self?.finishCall()
            }
        }
    }

    // MARK: Incoming

    private func handleIncomingPush(_ payload: [AnyHashable: Any], completion: @escaping () -> Void) {
        let conversationId = payload["conversationId"] as? String
        let from = payload["from"] as? String ?? "unknown"
        let fromName = payload["fromName"] as? String ?? from
        let uuid = UUID()
        var timeline = Timeline(role: .receiver)
        // Opened from the test notification: tapping it is the answer, as in option C.
        let viaNotification = answerNextRing && call == nil
        if viaNotification {
            answerNextRing = false
            for event in pendingRingEvents { timeline.mark(event.name, at: event.t, detail: event.detail) }
            pendingRingEvents = []
        }
        timeline.mark("pushReceived", detail: "from \(fromName)")
        if let sentAt = payload["pushSentAt"] as? Double {
            timeline.mark("pushSentAtServer", detail: String(Int(sentAt)))
        }

        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: from)
        update.localizedCallerName = fromName
        update.hasVideo = false
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false

        // In-app ring: always in the simulator (it disconnects reported incoming calls at
        // once, reason 55); on a watch in polling mode when "Ring with CallKit" is off. The
        // Answer button then runs the same path CXAnswerCallAction would.
        if settings.ringsInApp || viaNotification {
            if call == nil {
                call = ActiveCall(uuid: uuid, outgoing: false, conversationId: conversationId,
                                  peerId: from, peerName: fromName, timeline: timeline)
                call?.timeline.mark("callReported", detail: viaNotification ? "notification ring" : "in-app ring")
                phase = .ringing
                statusLine = "\(fromName) is calling"
                startRingTimer(for: uuid)
                connectRelay()
                if viaNotification {
                    notificationTestStatus = ""
                    answer()
                } else {
                    WKInterfaceDevice.current().play(.notification)
                }
            }
            completion()
            return
        }

        // Apple requires a reported call for every VoIP push, even if we're already busy.
        let busy = call != nil
        if !busy {
            call = ActiveCall(uuid: uuid, outgoing: false, conversationId: conversationId,
                              peerId: from, peerName: fromName, timeline: timeline)
            phase = .ringing
            statusLine = "\(fromName) is calling"
            // Start the watch's network right away; HTTPS needs no call, and CallKit's
            // confirmation of the ring can take seconds. Nothing is joined until answered.
            connectRelay()
        }
        provider.reportNewIncomingCall(with: uuid, update: update) { error in
            DispatchQueue.main.async {
                defer { completion() }
                if let error {
                    // For example Do Not Disturb (the clip fallback is a later spike item).
                    self.log("Incoming call not shown: \(error.localizedDescription)")
                    if self.call?.uuid == uuid { self.resetCallState() }
                } else if busy {
                    self.log("Push while busy; ending the extra call")
                    self.provider.reportCall(with: uuid, endedAt: nil, reason: .unanswered)
                } else {
                    self.call?.callKitActive = true
                    self.call?.timeline.mark("callReported")
                    self.startRingTimer(for: uuid)
                }
            }
        }
    }

    /// Stop ringing after 30 s. The relay abandons the ring (and drops the unheard audio)
    /// at 35 s, so an answer just before this fires still gets the message.
    private func startRingTimer(for uuid: UUID) {
        ringTimer?.invalidate()
        ringTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
            guard let self, let call, call.uuid == uuid, !call.answered else { return }
            log("Ring timed out")
            finishCall(reason: .unanswered)
        }
    }

    // MARK: Outgoing

    /// No CallKit for the sender: the app is on screen, so it can use its own audio session,
    /// and HTTPS to the relay works without a call.
    private func startOutgoingConversation() {
        var timeline = Timeline(role: .sender)
        timeline.mark("talkPressed")
        let peerName = settings.friendName.isEmpty ? settings.friendId : settings.friendName
        call = ActiveCall(uuid: UUID(), outgoing: true, conversationId: nil,
                          peerId: settings.friendId, peerName: peerName, timeline: timeline)
        phase = .connecting
        statusLine = "Connecting to \(peerName)…"
        connectRelay()
        activateOwnAudio()
    }

    // MARK: Relay

    private func connectRelay(join: String? = nil) {
        guard let baseURL = settings.baseURL, !settings.serverHost.isEmpty else {
            log("Server host isn't configured")
            endCall()
            return
        }
        relay.connect(baseURL: baseURL, token: settings.token, userId: settings.userId, join: join)
    }

    private func updateTalkReady() {
        talkReady = call != nil && relay.isReady && call?.audioActive == true
    }

    private func relayReady(clockOffsetMs: Double) {
        guard let current = call else {
            if NotificationRingTest.armedAt != nil || answerNextRing {
                pendingRingEvents.append(("preconnected", Timeline.nowMs(), nil))
            }
            return
        }
        defer { updateTalkReady() }
        self.call?.timeline.mark("socketOpen")
        self.clockOffsetMs = clockOffsetMs
        bestClockRoundTripMs = .infinity
        refineClockOffset()
        if current.outgoing {
            phase = .live
            statusLine = "Talking to \(current.peerName)"
            startBurstIfReady()
            resetIdleTimer()
        } else {
            // Opened while ringing: join once answered (beginAnswer joins if already open).
            joinIfAnswered()
        }
    }

    private func joinIfAnswered() {
        guard let current = call, !current.outgoing, current.answered, relay.isReady,
              let conversationId = current.conversationId, !current.timeline.has("joinSent") else { return }
        relay.send(["type": "join", "conversationId": conversationId])
        call?.timeline.mark("joinSent")
        resetIdleTimer()
    }

    private func refineClockOffset() {
        guard let uuid = call?.uuid else { return }
        let api = APIClient(settings: settings)
        Task { @MainActor in
            for _ in 0..<3 {
                guard let sample = try? await api.timeSample(), call?.uuid == uuid else { return }
                if sample.roundTripMs < bestClockRoundTripMs {
                    bestClockRoundTripMs = sample.roundTripMs
                    clockOffsetMs = sample.serverTime
                }
            }
            call?.timeline.mark("clockSynced", detail: "offset \(Int(clockOffsetMs)) ms, round trip \(Int(bestClockRoundTripMs)) ms")
        }
    }

    private func handle(_ message: RelayMessage) {
        switch message.type {
        case "floor-granted":
            call?.conversationId = message.conversationId
            call?.timeline.mark("floorGranted", detail: message.pushed == true ? "rang recipient" : "recipient live")
        case "floor-denied":
            WKInterfaceDevice.current().play(.failure)
            statusLine = "\(message.holder ?? "They") is talking"
            audio.endCapture {}
            burstId = nil
        case "joined":
            if call?.conversationId == nil {
                // Joined by the stream request after opening the notification.
                call?.conversationId = message.conversationId
                if let peer = message.peer { call?.peerId = peer }
                answerNextRing = false
                pendingRingEvents = []
            }
            call?.timeline.mark("joined", detail: "\(message.replayBursts ?? 0) buffered bursts")
            phase = .live
            statusLine = "With \(call?.peerName ?? "friend")"
        case "burst-start":
            call?.timeline.mark("burstStartReceived", detail: message.replay == true ? "replay" : "live", once: false)
            remoteTalking = true
            statusLine = "\(call?.peerName ?? "Friend") is talking"
            idleTimer?.invalidate()
            audio.beginPlayback()
        case "burst-end":
            remoteTalking = false
            statusLine = "With \(call?.peerName ?? "friend")"
            audio.endPlayback()
            resetIdleTimer()
        case "peer-left":
            log("\(message.peer ?? "Peer") left")
        case "ring-timeout":
            // The relay dropped what they didn't hear; the next Talk rings them again.
            WKInterfaceDevice.current().play(.failure)
            statusLine = "\(call?.peerName ?? "They") didn't answer"
            call?.timeline.mark("ringTimedOut", detail: "\(message.droppedBursts ?? 0) bursts dropped")
            log("Ring unanswered; \(message.droppedBursts ?? 0) unheard bursts dropped")
        case "error":
            log("Relay error: \(message.message ?? "unknown")")
            if message.message == "no pending ring", call?.conversationId == nil, answerNextRing {
                // Opened before the ring was sent: drop this attempt and answer the ring
                // when polling collects it.
                finishCall()
            }
        default:
            break
        }
    }

    // MARK: Talking

    private func startBurstIfReady() {
        guard talkHeld, burstId == nil, relay.isReady, let current = call, current.audioActive else { return }
        let id = UUID().uuidString
        burstId = id
        sentFirstFrame = false
        postsThisBurst = 0
        relay.send(["type": "talk-start", "to": current.peerId, "burstId": id])
        call?.timeline.mark("captureStarted", once: false)
        audio.beginCapture()
        // Signal "go ahead" only once the mic is live: on a cold start the call and audio
        // session take a moment, and anything said before this point isn't captured.
        WKInterfaceDevice.current().play(.start)
    }

    private func sendCaptured(_ frame: Data) {
        guard burstId != nil else { return }
        relay.send(frame: frame)
        if !sentFirstFrame {
            sentFirstFrame = true
            call?.timeline.mark("firstFrameSent")
        }
    }

    // MARK: Conversation window

    private func resetIdleTimer() {
        idleTimer?.invalidate()
        guard call != nil else { return }
        let seconds = TimeInterval(settings.conversationWindowSeconds)
        idleTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            guard let self else { return }
            if talkHeld || remoteTalking {
                resetIdleTimer()
            } else {
                log("Conversation window ended")
                endCall()
            }
        }
    }

    // MARK: Audio session

    /// The app's own audio session, used for every conversation (CallKit's call audio is
    /// never used, since the call ends on answer). Works because the app is on screen.
    private func activateOwnAudio() {
        guard call != nil, call?.audioActive == false, !activatingAudio else { return }
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
                    self.awaitingOwnAudio = false
                    self.audioSessionActivated()
                } else {
                    // Expected if CallKit hasn't released the session yet; didDeactivate retries.
                    self.log("Audio activation failed: \(error?.localizedDescription ?? "unknown")")
                }
            }
        }
    }

    private func audioSessionActivated() {
        guard call != nil, call?.audioActive == false else { return }
        call?.timeline.mark("audioActivated")
        do {
            try audio.start()
        } catch {
            log("Audio: \(error.localizedDescription)")
        }
        // Playback runs even if capture couldn't start.
        call?.audioActive = true
        updateTalkReady()
        startBurstIfReady()
    }

    // MARK: Teardown

    /// Ends the conversation. `reason` also ends a CallKit call that's still ringing.
    private func finishCall(reason: CXCallEndedReason = .remoteEnded) {
        guard var ended = call else { return }
        if ended.callKitActive {
            provider.reportCall(with: ended.uuid, endedAt: Date(), reason: reason)
        }
        if let conversationId = ended.conversationId {
            relay.send(["type": "leave", "conversationId": conversationId])
        }
        let offset = clockOffsetMs
        relay.close()
        audio.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        ended.timeline.mark("callEnded")
        resetCallState()

        lastRun = ended.timeline.localSummary()
        guard let conversationId = ended.conversationId else { return }
        let upload = MetricsUpload(conversationId: conversationId, userId: settings.userId, role: ended.timeline.role,
                                   clockOffsetMs: offset, events: ended.timeline.events)
        let api = APIClient(settings: settings)
        Task { @MainActor in
            do {
                try await api.uploadMetrics(upload)
                log("Metrics uploaded for \(conversationId.prefix(8))")
            } catch {
                log("Metrics upload failed: \(error.localizedDescription)")
            }
        }
    }

    private func resetCallState() {
        call = nil
        talkReady = false
        talkHeld = false
        isTalking = false
        remoteTalking = false
        burstId = nil
        awaitingOwnAudio = false
        idleTimer?.invalidate()
        ringTimer?.invalidate()
        phase = .idle
        statusLine = "Idle"
    }

    /// Diagnostics: application state changes (wrist down, system call screen on top).
    func noteAppState(_ state: String) {
        if call == nil, NotificationRingTest.armedAt != nil {
            pendingRingEvents.append(("app", Timeline.nowMs(), state))
        }
        call?.timeline.mark("app", detail: state, once: false)
    }

    private func log(_ line: String) {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        let entry = "\(formatter.string(from: Date())) \(line)"
        print("[spike] \(entry)")
        call?.timeline.mark("log", detail: line, once: false)
        logLines.append(entry)
        if logLines.count > 60 { logLines.removeFirst(logLines.count - 60) }
    }
}

// MARK: - Notification ring test

extension SpikeController: UNUserNotificationCenterDelegate {
    /// Schedules the test notification. Leave the app (or quit it) before it fires; the ring
    /// sent meanwhile waits on the server, since polling pauses while the test is armed.
    func armNotificationRing(after seconds: TimeInterval) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            DispatchQueue.main.async {
                guard granted else {
                    self.notificationTestStatus = "Notifications aren't allowed"
                    return
                }
                let content = UNMutableNotificationContent()
                content.title = self.settings.friendName.isEmpty ? "Walkie Spike" : self.settings.friendName
                content.body = "Tap to listen"
                content.sound = .default
                // Needs the time-sensitive entitlement (not on a Personal Team); without it
                // the notification is delivered as "active".
                content.interruptionLevel = .timeSensitive
                let trigger = UNTimeIntervalNotificationTrigger(timeInterval: seconds, repeats: false)
                let request = UNNotificationRequest(identifier: NotificationRingTest.identifier, content: content, trigger: trigger)
                center.add(request) { error in
                    DispatchQueue.main.async {
                        if let error {
                            self.notificationTestStatus = "Couldn't schedule: \(error.localizedDescription)"
                            return
                        }
                        let now = Timeline.nowMs()
                        NotificationRingTest.armedAt = now
                        self.notificationTestStatus = "Fires at \(NotificationRingTest.clock(now + seconds * 1000)). Leave the app now."
                    }
                }
            }
        }
    }

    func disarmNotificationRing() {
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [NotificationRingTest.identifier])
        NotificationRingTest.armedAt = nil
        if call == nil { relay.close() } // A stream opened at launch for the test.
        answerNextRing = false
        pendingRingEvents = []
        notificationTestStatus = ""
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let openedAt = Timeline.nowMs()
        let deliveredAt = response.notification.date.timeIntervalSince1970 * 1000
        let isTest = response.notification.request.identifier == NotificationRingTest.identifier
        DispatchQueue.main.async {
            defer { completionHandler() }
            guard isTest, let armedAt = NotificationRingTest.armedAt else { return }
            NotificationRingTest.armedAt = nil
            self.pendingRingEvents += [
                ("notificationScheduled", armedAt, nil),
                ("notificationDelivered", deliveredAt, nil),
                ("notificationOpened", openedAt, nil),
            ]
            self.answerNextRing = true
            self.notificationTestStatus = ""
            self.answerFromNotification()
        }
    }

    /// Opening the notification is the answer. If the stream was opened when the app was
    /// launched for the notification, "join" goes over it; otherwise the request that opens
    /// the stream joins, one round trip on a waking network instead of three (poll, stream,
    /// join). A real option C push would carry the conversation ID; the test asks the
    /// server for the queued ring ("pending") instead.
    private func answerFromNotification() {
        guard call == nil else { return }
        var timeline = Timeline(role: .receiver)
        for event in pendingRingEvents { timeline.mark(event.name, at: event.t, detail: event.detail) }
        let peerName = settings.friendName.isEmpty ? settings.friendId : settings.friendName
        call = ActiveCall(uuid: UUID(), outgoing: false, conversationId: nil,
                          peerId: settings.friendId, peerName: peerName, timeline: timeline)
        call?.answered = true
        call?.timeline.mark("answerTapped", detail: "notification")
        phase = .connecting
        statusLine = "Connecting…"
        rejoinedOnFreshStream = false
        if relay.isReady {
            clockOffsetMs = relay.clockOffsetMs
            bestClockRoundTripMs = .infinity
            relay.send(["type": "join", "conversationId": "pending"])
            call?.timeline.mark("joinSent", detail: "over the open stream")
            refineClockOffset()
            // The stream may have gone stale while the app was suspended without saying so.
            let uuid = call?.uuid
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self, call?.uuid == uuid, call?.conversationId == nil else { return }
                rejoinOnFreshStream("not joined after 3 s")
            }
        } else {
            call?.timeline.mark("joinSent", detail: "with the stream")
            connectRelay(join: "pending")
        }
        activateOwnAudio()
        resetIdleTimer()
    }

    private func rejoinOnFreshStream(_ why: String) {
        guard !rejoinedOnFreshStream else {
            log("Couldn't join: \(why)")
            return endCall()
        }
        rejoinedOnFreshStream = true
        log("Rejoining on a fresh stream (\(why))")
        call?.timeline.mark("joinSent", detail: "fresh stream", once: false)
        connectRelay(join: "pending")
    }
}

/// State for the notification ring test that has to survive the app being quit.
enum NotificationRingTest {
    static let identifier = "notification-ring-test"
    private static let armedKey = "notificationRingArmedAt"

    static var armedAt: Double? {
        get { UserDefaults.standard.object(forKey: armedKey) as? Double }
        set { UserDefaults.standard.set(newValue, forKey: armedKey) }
    }

    static func clock(_ ms: Double) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter.string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    /// When this process started (ms since epoch), to time a cold launch.
    static func processStartMs() -> Double? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0 else { return nil }
        let start = info.kp_proc.p_un.__p_starttime
        return Double(start.tv_sec) * 1000 + Double(start.tv_usec) / 1000
    }
}

// MARK: - CXProviderDelegate (delivered on the main queue)

extension SpikeController: CXProviderDelegate {
    func providerDidReset(_ provider: CXProvider) {
        log("CallKit provider reset")
        call?.callKitActive = false
        finishCall()
    }

    /// Outgoing conversations don't use CallKit.
    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        action.fail()
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        guard call?.uuid == action.callUUID else {
            action.fail()
            return
        }
        beginAnswer()
        action.fulfill()
        handOffFromCallKit(action.callUUID)
    }

    private func beginAnswer() {
        ringTimer?.invalidate()
        call?.answered = true
        call?.timeline.mark("answerTapped")
        phase = .connecting
        statusLine = "Connecting…"
        // Usually already open since the ring; reconnect only if it dropped.
        if relay.isReady { joinIfAnswered() } else if !relay.isConnecting { connectRelay() }
        reportAnswer()
    }

    /// End the CallKit call as soon as it's answered, so watchOS dismisses its call screen
    /// and the app (on screen when the ring arrived) shows its Talk button again. The app
    /// then turns on its own audio once CallKit has released the session.
    private func handOffFromCallKit(_ uuid: UUID) {
        DispatchQueue.main.async {
            guard self.call?.uuid == uuid, self.call?.callKitActive == true else { return }
            self.provider.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded)
            self.call?.callKitActive = false
            self.call?.timeline.mark("callKitEnded")
            // Try right away; if CallKit still holds the session, didDeactivate (or the
            // fallback below) retries.
            self.awaitingOwnAudio = true
            self.activateOwnAudio()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                if self.call?.uuid == uuid, self.call?.audioActive == false { self.activateOwnAudio() }
            }
        }
    }

    /// HTTPS works immediately, so tell the server right away that the ring was answered.
    private func reportAnswer() {
        guard let uuid = call?.uuid, let conversationId = call?.conversationId else { return }
        let api = APIClient(settings: settings)
        Task { @MainActor in
            do {
                try await api.reportAnswer(conversationId: conversationId)
                if call?.uuid == uuid { call?.timeline.mark("answerReported") }
            } catch {
                log("Answer report failed: \(error.localizedDescription)")
            }
        }
    }

    /// Declined, or ended from the system call screen while ringing.
    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        if call?.uuid == action.callUUID {
            call?.callKitActive = false
            finishCall()
        }
        action.fulfill()
    }

    /// CallKit may briefly activate call audio before the hand-off; it isn't used.
    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        call?.timeline.mark("callKitAudioActivated")
    }

    /// CallKit can release (and even activate) call audio seconds after the hand-off. If
    /// the app's audio was already on, it has been taken away: turn it back on.
    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        call?.timeline.mark("callKitAudioDeactivated")
        guard let current = call, !current.callKitActive else { return }
        if current.audioActive {
            log("Reclaiming audio after CallKit released it")
            audio.stop()
            call?.audioActive = false
            updateTalkReady()
        }
        activateOwnAudio()
    }

    /// Something else (a real call, Siri, CallKit) interrupted the app's audio.
    fileprivate func handleAudioInterruption(_ note: Notification) {
        guard call != nil,
              let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        switch type {
        case .began:
            log("Audio interrupted")
            audio.stop()
            call?.audioActive = false
            updateTalkReady()
        case .ended:
            log("Audio interruption ended")
            activateOwnAudio()
        @unknown default:
            break
        }
    }

    /// Diagnostics: notices when the main thread (UI, networking callbacks) stalls, which
    /// happened while Talk was held on a real watch. A tick that arrives late means the whole
    /// process was paused (suspended by the system), not just the main thread.
    fileprivate func startMainThreadWatchdog() {
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + 1, repeating: .milliseconds(250))
        var lastTick = Timeline.nowMs()
        timer.setEventHandler { [weak self] in
            let queuedAt = Timeline.nowMs()
            let gap = queuedAt - lastTick
            lastTick = queuedAt
            if gap > 1_000 {
                DispatchQueue.main.async {
                    self?.call?.timeline.mark("processPaused", at: queuedAt - gap, detail: "\(Int(gap)) ms", once: false)
                }
            }
            DispatchQueue.main.async {
                let lag = Timeline.nowMs() - queuedAt
                guard lag > 750, let self, self.call != nil else { return }
                self.call?.timeline.mark("mainStall", at: queuedAt, detail: "\(Int(lag)) ms", once: false)
            }
        }
        timer.resume()
        watchdog = timer
    }
}
