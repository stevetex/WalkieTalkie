import AVFoundation
import CallKit
import Combine
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
    @Published private(set) var registrationStatus = "Waiting for VoIP push token"
    @Published private(set) var lastRun: [String] = []
    @Published private(set) var logLines: [String] = []

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
    /// Set after answering: turn on the app's own audio once CallKit lets go of the session.
    private var awaitingOwnAudio = false

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
            guard call != nil else { return }
            log("Relay closed: \(reason)")
            endCall()
        }

        audio.onFrame = { [weak self] frame in
            DispatchQueue.main.async { self?.sendCaptured(frame) }
        }
        audio.onFirstPlayback = { [weak self] in
            DispatchQueue.main.async { self?.call?.timeline.mark("firstAudioScheduled") }
        }
        log("Codec: \(audio.codecDescription)")
        if SpikeSettings.usesPolledRings { startRingPolling() }
    }

    /// Without VoIP push (the simulator, or a SPIKE_PUSH_MODE = none build), register a
    /// "poll:" token and collect rings from the server every 1.5 s. Each one is handled
    /// exactly like a push. On a watch it rings through CallKit, but only while the app
    /// is running, since timers stop when it's suspended.
    private func startRingPolling() {
        registrationStatus = "No VoIP push: rings arrive while the app is open"
        registerDevice()
        Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            guard let self, call == nil, !settings.serverHost.isEmpty else { return }
            let api = APIClient(settings: settings)
            Task { @MainActor in
                guard let rings = try? await api.polledRings() else { return }
                for payload in rings {
                    self.handleIncomingPush(payload) {}
                }
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
            call?.timeline.mark("talkPressedInWindow")
            startBurstIfReady()
        }
    }

    func talkReleased() {
        guard talkHeld else { return }
        talkHeld = false
        isTalking = false
        call?.timeline.mark("talkReleased")
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

    /// Answer from inside the app. On a watch this goes through CallKit like the system
    /// answer button; the simulator has no CallKit call to answer, so it answers directly.
    func answer() {
        guard let call, !call.outgoing, !call.answered else { return }
        #if targetEnvironment(simulator)
        beginAnswer()
        activateOwnAudio()
        #else
        callController.request(CXTransaction(action: CXAnswerCallAction(call: call.uuid))) { [weak self] error in
            guard let error else { return }
            DispatchQueue.main.async { self?.log("Answer failed: \(error.localizedDescription)") }
        }
        #endif
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

        #if targetEnvironment(simulator)
        // The watch simulator disconnects reported incoming calls immediately (reason 55)
        // because it can't present the incoming-call UI, so simulated rings stay in-app:
        // the Answer button runs the same path CXAnswerCallAction would.
        if call == nil {
            call = ActiveCall(uuid: uuid, outgoing: false, conversationId: conversationId,
                              peerId: from, peerName: fromName, timeline: timeline)
            call?.timeline.mark("callReported", detail: "simulator: in-app ring")
            phase = .ringing
            statusLine = "\(fromName) is calling"
            WKInterfaceDevice.current().play(.notification)
            startRingTimer(for: uuid)
        }
        completion()
        #else

        // Apple requires a reported call for every VoIP push, even if we're already busy.
        let busy = call != nil
        if !busy {
            call = ActiveCall(uuid: uuid, outgoing: false, conversationId: conversationId,
                              peerId: from, peerName: fromName, timeline: timeline)
            phase = .ringing
            statusLine = "\(fromName) is calling"
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
        #endif
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

    private func connectRelay() {
        guard let baseURL = settings.baseURL, !settings.serverHost.isEmpty else {
            log("Server host isn't configured")
            endCall()
            return
        }
        relay.connect(baseURL: baseURL, token: settings.token, userId: settings.userId)
    }

    private func relayReady(clockOffsetMs: Double) {
        guard let current = call else { return }
        self.call?.timeline.mark("socketOpen", detail: "clock offset \(Int(clockOffsetMs)) ms")
        if current.outgoing {
            phase = .live
            statusLine = "Talking to \(current.peerName)"
            startBurstIfReady()
        } else if let conversationId = current.conversationId {
            relay.send(["type": "join", "conversationId": conversationId])
            self.call?.timeline.mark("joinSent")
        }
        resetIdleTimer()
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
            call?.timeline.mark("joined", detail: "\(message.replayBursts ?? 0) buffered bursts")
            phase = .live
            statusLine = "With \(call?.peerName ?? "friend")"
        case "burst-start":
            call?.timeline.mark("burstStartReceived", detail: message.replay == true ? "replay" : "live")
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
        relay.send(["type": "talk-start", "to": current.peerId, "burstId": id])
        call?.timeline.mark("captureStarted")
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
        awaitingOwnAudio = false
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
        guard call != nil, call?.audioActive == false else { return }
        call?.timeline.mark("audioActivated")
        do {
            try audio.start()
        } catch {
            log("Audio: \(error.localizedDescription)")
        }
        // Playback runs even if capture couldn't start.
        call?.audioActive = true
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
        let offset = relay.clockOffsetMs
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

    private func log(_ line: String) {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        let entry = "\(formatter.string(from: Date())) \(line)"
        print("[spike] \(entry)")
        logLines.append(entry)
        if logLines.count > 60 { logLines.removeFirst(logLines.count - 60) }
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
        connectRelay()
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
            self.awaitingOwnAudio = true
            // didDeactivate normally triggers this; don't wait on it forever.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                if self.awaitingOwnAudio, self.call?.uuid == uuid { self.activateOwnAudio() }
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

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        if awaitingOwnAudio { activateOwnAudio() }
    }
}
