import AVFoundation
import CallKit
import Combine
import WatchKit

/// Coordinates the ring-to-start flow:
///
///   Receiver: VoIP push → report incoming CallKit call (ring) → user answers →
///             open relay socket → join → buffered burst replays → conversation window.
///   Sender:   press Talk → start outgoing CallKit call → open relay socket →
///             audio session active → talk-start + stream frames.
///
/// The call ends by itself after `conversationWindowSeconds` with no audio either way.
/// Everything here runs on the main queue: CallKit, PushKit and the relay all deliver
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
        push.start()

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
        #if targetEnvironment(simulator)
        startSimulatorRingPolling()
        #endif
    }

    #if targetEnvironment(simulator)
    /// The simulator gets no VoIP token and no VoIP pushes. Register a stand-in token and
    /// poll the dry-run server for the pushes it would have sent, then handle each one
    /// exactly as a real push (it still rings through CallKit).
    private func startSimulatorRingPolling() {
        registrationStatus = "Simulator: stand-in push token"
        registerDevice()
        Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            guard let self, call == nil, settings.baseURL != nil, !settings.serverHost.isEmpty else { return }
            let api = APIClient(settings: settings)
            Task { @MainActor in
                guard let rings = try? await api.simulatedRings() else { return }
                for payload in rings {
                    self.handleIncomingPush(payload) {}
                }
            }
        }
    }
    #endif

    // MARK: UI actions

    func requestMicrophone() {
        AVAudioApplication.requestRecordPermission { granted in
            DispatchQueue.main.async { if !granted { self.log("Microphone permission denied") } }
        }
    }

    func registerDevice() {
        #if targetEnvironment(simulator)
        let token = push.token ?? "sim:\(settings.userId)"
        #else
        guard let token = push.token else { return }
        #endif
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
            startOutgoingCall()
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
        activateAudioIfCallKitCannot(for: call.uuid)
        #else
        callController.request(CXTransaction(action: CXAnswerCallAction(call: call.uuid))) { [weak self] error in
            guard let error else { return }
            DispatchQueue.main.async { self?.log("Answer failed: \(error.localizedDescription)") }
        }
        #endif
    }

    func endCall() {
        guard let call else { return }
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
                    self.call?.timeline.mark("callReported")
                    self.startRingTimer(for: uuid)
                }
            }
        }
        #endif
    }

    private func startRingTimer(for uuid: UUID) {
        ringTimer?.invalidate()
        ringTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
            guard let self, let call, call.uuid == uuid, !call.answered else { return }
            log("Ring timed out")
            provider.reportCall(with: uuid, endedAt: Date(), reason: .unanswered)
            finishCall()
        }
    }

    // MARK: Outgoing

    private func startOutgoingCall() {
        var timeline = Timeline(role: .sender)
        timeline.mark("talkPressed")
        let uuid = UUID()
        let peerName = settings.friendName.isEmpty ? settings.friendId : settings.friendName
        call = ActiveCall(uuid: uuid, outgoing: true, conversationId: nil,
                          peerId: settings.friendId, peerName: peerName, timeline: timeline)
        phase = .connecting
        statusLine = "Connecting to \(peerName)…"

        let action = CXStartCallAction(call: uuid, handle: CXHandle(type: .generic, value: settings.friendId))
        callController.request(CXTransaction(action: action)) { [weak self] error in
            guard let error else { return }
            DispatchQueue.main.async {
                self?.log("Start call failed: \(error.localizedDescription)")
                self?.resetCallState()
            }
        }
    }

    // MARK: Relay

    private func connectRelay() {
        guard let url = settings.relayURL else {
            log("Relay URL isn't configured")
            endCall()
            return
        }
        relay.connect(url: url, token: settings.token)
    }

    private func relayReady(clockOffsetMs: Double) {
        guard let current = call else { return }
        self.call?.timeline.mark("socketOpen", detail: "clock offset \(Int(clockOffsetMs)) ms")
        if current.outgoing {
            provider.reportOutgoingCall(with: current.uuid, connectedAt: Date())
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

    // MARK: Teardown

    private func configureAudioSession() {
        do {
            try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: [])
        } catch {
            log("Audio session setup failed: \(error.localizedDescription)")
        }
    }

    private func finishCall() {
        guard var ended = call else { return }
        if let conversationId = ended.conversationId {
            relay.send(["type": "leave", "conversationId": conversationId])
        }
        let offset = relay.clockOffsetMs
        relay.close()
        audio.stop()
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
        relay.close()
        audio.stop()
        resetCallState()
    }

    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        guard call?.uuid == action.callUUID else {
            action.fail()
            return
        }
        call?.timeline.mark("callStarted")
        configureAudioSession()
        provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
        connectRelay()
        action.fulfill()
        activateAudioIfCallKitCannot(for: action.callUUID)
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        guard call?.uuid == action.callUUID else {
            action.fail()
            return
        }
        beginAnswer()
        action.fulfill()
        activateAudioIfCallKitCannot(for: action.callUUID)
    }

    private func beginAnswer() {
        ringTimer?.invalidate()
        call?.answered = true
        call?.timeline.mark("answerTapped")
        phase = .connecting
        statusLine = "Connecting…"
        configureAudioSession()
        connectRelay()
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        if call?.uuid == action.callUUID { finishCall() }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        audioSessionActivated(detail: nil)
    }

    private func audioSessionActivated(detail: String?) {
        guard call != nil, call?.audioActive == false else { return }
        call?.timeline.mark("audioActivated", detail: detail)
        do {
            try audio.start()
        } catch {
            log("Audio: \(error.localizedDescription)")
        }
        // Playback runs even if capture couldn't start.
        call?.audioActive = true
        startBurstIfReady()
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        audio.stop()
        call?.audioActive = false
    }

    /// The simulator's CallKit can't activate call audio ("Unsupported property" from
    /// AVAudioSessionImpl_Simulator), so `didActivate` never arrives there. In simulator
    /// builds only, activate the session ourselves if CallKit hasn't within a second.
    private func activateAudioIfCallKitCannot(for uuid: UUID) {
        #if targetEnvironment(simulator)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            guard self.call?.uuid == uuid, self.call?.audioActive == false else { return }
            AVAudioSession.sharedInstance().activate(options: []) { success, error in
                DispatchQueue.main.async {
                    if success {
                        self.audioSessionActivated(detail: "simulator fallback")
                    } else {
                        self.log("Simulator audio activation failed: \(error?.localizedDescription ?? "unknown")")
                    }
                }
            }
        }
        #endif
    }
}
