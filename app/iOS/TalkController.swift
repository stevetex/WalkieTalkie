import AVFoundation
import OverAndOutKit
import SwiftUI
import UIKit

/// Runs the iPhone's conversations (design decisions 2026-09-27). The watch's
/// ConversationController is the reference; this one adds PushToTalk and drops the watch's
/// notification ring and prefetch.
///
///   PushToTalk (in the channel, on a device): a friend's push wakes the app, which joins the
///             conversation in the request that opens the relay stream; the system activates
///             the audio session and the message plays with no tap. Talking asks the system to
///             transmit, from the app or from the system's Talk button. The system activates
///             audio only while transmitting or receiving, so the pipeline starts and stops
///             with it.
///   In app:   (the simulator, or out of the channel) while the app is on screen it keeps a
///             relay stream open, the relay rings over it, and Answer joins. The app runs its
///             own audio session for the whole conversation.
///
/// A conversation ends after `conversationWindow` without audio, when a friend's message has
/// played and the app is in the background (the relay rings this iPhone again for the next
/// one), or when it moves to the watch.
@MainActor
final class TalkController: ObservableObject {
    static let conversationWindow: TimeInterval = 45
    /// An in-app ring stops after this; the relay abandons the ring at 35 s.
    static let inAppRingTimeout: TimeInterval = 30

    enum Phase: Equatable {
        case idle
        case connecting
        case live
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var peerId: String?
    @Published private(set) var peerName: String?
    @Published private(set) var statusLine = ""
    @Published private(set) var isTalking = false
    @Published private(set) var remoteTalking = false
    /// Able to record right now; the mouth shows "waiting" until then.
    @Published private(set) var talkReady = false
    /// A ring over the open relay stream (in-app mode), waiting for Answer or Decline.
    @Published private(set) var incomingRing: Ring?
    /// A conversation someone else started, for the UI to show that friend's Talk screen.
    @Published var arrivedFrom: String?

    let ptt: PushToTalkChannel
    private let client: AccountClient
    private let relayBaseURL: URL?
    private let relay = RelayConnection()
    private let audio = AudioPipeline()

    private struct Conversation {
        let outgoing: Bool
        var conversationId: String?
        var peerId: String
        var peerName: String
        var timeline: Timeline
        var joined = false
    }

    private var conversation: Conversation?
    /// The pipeline is running on an active audio session.
    private var audioActive = false
    private var activatingAudio = false
    private var talkHeld = false
    private var burstId: String?
    private var sentFirstFrame = false
    private var idleTimer: Timer?
    private var incomingRingTimer: Timer?
    private var incomingBurstEnded = false
    private var speakerIdle = true
    private var clockOffsetMs: Double = 0
    private var bestClockRoundTripMs = Double.infinity
    private var inForeground = UIApplication.shared.applicationState != .background
    /// A stream open without a conversation, so the relay can ring the app (in-app mode).
    private var idleStream = false
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    private var usesPushToTalk: Bool { ptt.isJoined }

    init(client: AccountClient, relayHost: String, ptt: PushToTalkChannel) {
        self.client = client
        self.ptt = ptt
        relayBaseURL = AccountClient.baseURL(host: relayHost)

        relay.onReady = { [unowned self] offset in relayReady(clockOffsetMs: offset) }
        relay.onMessage = { [unowned self] message in handle(message) }
        relay.onFrame = { [unowned self] frame in
            if conversation?.timeline.has("firstFrameReceived") == false { conversation?.timeline.mark("firstFrameReceived") }
            speakerIdle = false
            audio.enqueue(frame)
        }
        relay.onClose = { [unowned self] reason in
            idleStream = false
            guard conversation != nil else { return }
            log("Relay closed: \(reason)")
            finish()
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
        audio.onPlaybackDrained = { [weak self] in
            self?.speakerIdle = true
            self?.friendStoppedTalkingIfDone()
        }
        audio.onFirstCapturedFrame = { [weak self] t in
            DispatchQueue.main.async { self?.conversation?.timeline.mark("micFirstFrame", at: t, once: false) }
        }
        audio.onRestart = { [weak self] detail in self?.log("Audio: \(detail)") }
        ptt.onEvent = { [unowned self] event in handle(event) }
        NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            Task { @MainActor in self?.handleAudioInterruption(raw) }
        }
    }

    // MARK: App state

    func appBecameActive() {
        inForeground = true
        openIdleStreamIfNeeded()
    }

    /// In the background only PushToTalk can keep a conversation going, and only while the
    /// system has audio active. Otherwise end it: the relay rings this iPhone for the next message.
    func appEnteredBackground() {
        inForeground = false
        if conversation != nil {
            if !usesPushToTalk || (!audioActive && !talkHeld) { finishInBackground() }
        } else if idleStream {
            idleStream = false
            relay.close()
        }
        clearIncomingRing()
    }

    /// In-app mode on screen: a stream without a conversation, so the relay can ring us.
    func openIdleStreamIfNeeded() {
        guard inForeground, !usesPushToTalk, conversation == nil, !idleStream, !relay.isConnecting else { return }
        guard let baseURL = relayBaseURL else { return }
        idleStream = true
        withToken { [weak self] session in
            guard let self, idleStream, conversation == nil, let session else { return }
            relay.connect(baseURL: baseURL, token: session.token, userId: session.userId)
        }
    }

    /// Joining or leaving the PushToTalk channel changes how rings arrive.
    func pushToTalkChanged() {
        if usesPushToTalk, conversation == nil, idleStream {
            idleStream = false
            relay.close()
        } else {
            openIdleStreamIfNeeded()
        }
    }

    func signedOut() {
        finish()
        idleStream = false
        relay.close()
    }

    // MARK: UI actions

    func talkPressed(to friend: Friend) {
        guard !talkHeld else { return }
        talkHeld = true
        isTalking = true
        idleTimer?.invalidate()
        if let current = conversation, current.peerId != friend.id { finish() }
        if conversation == nil {
            startOutgoingConversation(peerId: friend.id, peerName: friend.name)
        } else {
            conversation?.timeline.mark("talkPressedInWindow", once: false)
        }
        if usesPushToTalk {
            ptt.setFriend(id: friend.id, name: friend.name)
            ptt.beginTransmitting()
        } else {
            activateOwnAudio()
            startBurstIfReady()
        }
    }

    func talkReleased() {
        guard talkHeld else { return }
        if usesPushToTalk {
            // The system ends the transmission; transmitEnded finishes the burst.
            ptt.stopTransmitting()
        }
        endBurst()
    }

    func answerIncomingRing() {
        guard let ring = incomingRing else { return }
        clearIncomingRing()
        answer(ring, via: "in app")
    }

    /// The relay abandons an unanswered ring by itself; nothing to tell it.
    func declineIncomingRing() {
        clearIncomingRing()
    }

    func end() {
        finish()
    }

    // MARK: PushToTalk events

    private func handle(_ event: PushToTalkChannel.Event) {
        switch event {
        case let .ring(ring, receivedAt):
            answer(ring, via: "pushtotalk", receivedAt: receivedAt)
        case let .transmitStarted(fromSystemUI):
            guard fromSystemUI, !talkHeld else { return }
            // The system's Talk button: talk to the channel's friend.
            guard let friend = conversation.map({ ($0.peerId, $0.peerName) }) ?? ptt.channelFriend else {
                ptt.stopTransmitting()
                return
            }
            talkHeld = true
            isTalking = true
            idleTimer?.invalidate()
            if conversation == nil { startOutgoingConversation(peerId: friend.0, peerName: friend.1) }
            conversation?.timeline.mark("talkPressed", detail: "system Talk button", once: false)
        case .transmitEnded:
            endBurst()
        case let .transmitFailed(reason):
            log(reason)
            statusLine = "Couldn't talk right now"
            endBurst()
        case .audioActivated:
            audioSessionActivated()
        case .audioDeactivated:
            audio.stop()
            audioActive = false
            updateTalkReady()
            if !inForeground, conversation != nil, !talkHeld { finishInBackground() }
        }
    }

    // MARK: Answering

    /// A PushToTalk push, or Answer on an in-app ring. The relay stream's request joins, so
    /// the relay starts the replay without another round trip.
    private func answer(_ ring: Ring, via: String, receivedAt: Double? = nil) {
        if let current = conversation {
            if current.conversationId == ring.conversationId, current.joined { return }
            if current.conversationId != ring.conversationId { finish() }
        }
        var timeline = Timeline(role: .receiver)
        if let sentAt = ring.pushSentAt { timeline.mark("pushSentAtServer", detail: String(Int(sentAt))) }
        if let receivedAt { timeline.mark("pttPushReceived", at: receivedAt) }
        timeline.mark("answerTapped", at: receivedAt ?? Clock.nowMs(), detail: via)
        conversation = Conversation(outgoing: false, conversationId: ring.conversationId,
                                    peerId: ring.from, peerName: ring.fromName, timeline: timeline)
        phase = .connecting
        peerId = ring.from
        peerName = ring.fromName
        statusLine = "Connecting to \(ring.fromName)…"
        arrivedFrom = ring.from
        if usesPushToTalk {
            ptt.setFriend(id: ring.from, name: ring.fromName)
            ptt.setServiceStatus(.connecting)
            remoteTalking = true
        } else {
            activateOwnAudio()
        }
        if idleStream, relay.isReady {
            idleStream = false
            conversation?.timeline.mark("joinSent", detail: "over the open stream")
            relay.send(["type": "join", "conversationId": ring.conversationId])
            relayReady(clockOffsetMs: relay.clockOffsetMs)
        } else {
            idleStream = false
            conversation?.timeline.mark("joinSent", detail: "with the stream")
            connectRelay(join: ring.conversationId)
        }
        resetIdleTimer()
    }

    private func clearIncomingRing() {
        incomingRingTimer?.invalidate()
        incomingRing = nil
    }

    // MARK: Outgoing

    private func startOutgoingConversation(peerId: String, peerName: String) {
        var timeline = Timeline(role: .sender)
        timeline.mark("talkPressed")
        conversation = Conversation(outgoing: true, conversationId: nil, peerId: peerId, peerName: peerName, timeline: timeline)
        phase = .connecting
        self.peerId = peerId
        self.peerName = peerName
        statusLine = "Connecting…"
        if idleStream, relay.isReady {
            idleStream = false
            relayReady(clockOffsetMs: relay.clockOffsetMs)
        } else {
            idleStream = false
            connectRelay()
        }
    }

    // MARK: Relay

    private func connectRelay(join: String? = nil) {
        guard let baseURL = relayBaseURL else { return finish(status: "No server configured") }
        let conversationId = conversation?.conversationId
        withToken { [weak self] session in
            guard let self, conversation != nil, conversation?.conversationId == conversationId else { return }
            guard let session else { return finish(status: "You're signed out") }
            relay.connect(baseURL: baseURL, token: session.token, userId: session.userId, join: join)
        }
    }

    /// The session's token, refreshed first only if it has expired (never on a ring for a
    /// token that's merely a day old: that refresh can wait).
    private func withToken(_ body: @escaping @MainActor (AccountSession?) -> Void) {
        let client = client
        if let session = client.session, !session.isExpired { return body(session) }
        Task {
            let refreshed = try? await client.refresh()
            body(refreshed)
        }
    }

    private func updateTalkReady() {
        let relayUp = relay.isReady && conversation != nil
        talkReady = relayUp && (usesPushToTalk || audioActive)
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
    }

    private func refineClockOffset() {
        guard conversation != nil, let baseURL = relayBaseURL, let token = client.session?.token else { return }
        Task {
            for _ in 0..<3 {
                guard let sample = try? await Self.timeSample(baseURL, token: token), conversation != nil else { return }
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
        case "ring":
            guard let conversationId = message.conversationId, let from = message.from else { return }
            let ring = Ring(conversationId: conversationId, from: from, fromName: message.fromName ?? from,
                            burstId: message.burstId, pushSentAt: message.pushSentAt)
            guard conversation?.conversationId != conversationId else { return }
            incomingRing = ring
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
            incomingRingTimer?.invalidate()
            incomingRingTimer = Timer.scheduledTimer(withTimeInterval: Self.inAppRingTimeout, repeats: false) { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.incomingRing == ring else { return }
                    self.clearIncomingRing()
                    self.statusLine = "Missed \(ring.fromName)"
                }
            }
        case "floor-granted":
            conversation?.conversationId = message.conversationId
            conversation?.timeline.mark("floorGranted", detail: message.pushed == true ? "rang recipient" : "recipient live")
        case "floor-denied":
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            statusLine = "\(name) is talking"
            cancelBurst()
        case "talk-refused":
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            cancelBurst()
            finish(status: message.reason == "unavailable" ? "\(name) isn't available" : "Can't reach \(name)")
        case "moved":
            // Answered or talked on the watch: the conversation is there now.
            finish(status: "Continued on your watch")
        case "joined":
            conversation?.joined = true
            conversation?.timeline.mark("joined", detail: "\(message.replayBursts ?? 0) buffered bursts")
            phase = .live
            statusLine = "With \(name)"
            ptt.setServiceStatus(.ready)
            updateTalkReady()
        case "burst-start":
            conversation?.timeline.mark("burstStartReceived", detail: message.replay == true ? "replay" : "live", once: false)
            remoteTalking = true
            incomingBurstEnded = false
            statusLine = "\(name) is talking"
            idleTimer?.invalidate()
            audio.beginPlayback()
            // PushToTalk: the system activates audio for the speaker (a push already did).
            if usesPushToTalk, !audioActive { ptt.setRemoteSpeaker(name) }
        case "burst-end":
            incomingBurstEnded = true
            audio.endPlayback()
            friendStoppedTalkingIfDone()
            resetIdleTimer()
        case "peer-left":
            log("\(name) left")
        case "ring-timeout":
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            statusLine = "\(name) didn't answer"
            conversation?.timeline.mark("ringTimedOut", detail: "\(message.droppedBursts ?? 0) bursts dropped")
        case "error":
            log("Relay error: \(message.message ?? "unknown")")
            if message.message == "unknown conversation", conversation?.outgoing == false, conversation?.joined == false {
                finish(status: "Missed \(name)")
            }
        default:
            break
        }
    }

    // MARK: Talking

    private func startBurstIfReady() {
        guard talkHeld, burstId == nil, relay.isReady, audioActive, let current = conversation else { return }
        let id = UUID().uuidString
        burstId = id
        sentFirstFrame = false
        relay.send(["type": "talk-start", "to": current.peerId, "burstId": id])
        conversation?.timeline.mark("captureStarted", once: false)
        audio.beginCapture()
        // PushToTalk plays the system's own sound; in the app, a tap says "go ahead".
        if !usesPushToTalk { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
    }

    private func endBurst() {
        guard talkHeld else { return }
        talkHeld = false
        isTalking = false
        conversation?.timeline.mark("talkReleased", once: false)
        guard let id = burstId else { return resetIdleTimer() }
        // Flush the last partial frame before telling the relay the burst is over.
        audio.endCapture {
            DispatchQueue.main.async {
                self.relay.send(["type": "talk-end", "burstId": id])
                if self.burstId == id { self.burstId = nil }
                self.resetIdleTimer()
            }
        }
    }

    private func cancelBurst() {
        audio.endCapture {}
        burstId = nil
        if talkHeld, usesPushToTalk { ptt.stopTransmitting() }
    }

    private func sendCaptured(_ frame: Data) {
        guard burstId != nil else { return }
        relay.send(frame: frame)
        if !sentFirstFrame {
            sentFirstFrame = true
            conversation?.timeline.mark("firstFrameSent")
        }
    }

    /// A replayed burst arrives far faster than it plays, so "is talking" lasts until both
    /// the relay's burst-end and the speaker going quiet.
    private func friendStoppedTalkingIfDone() {
        guard remoteTalking, incomingBurstEnded, speakerIdle else { return }
        remoteTalking = false
        statusLine = "With \(conversation?.peerName ?? "your friend")"
        // Lets the system deactivate audio, and the person talk back.
        if usesPushToTalk { ptt.setRemoteSpeaker(nil) }
    }

    // MARK: Conversation window

    private func resetIdleTimer() {
        idleTimer?.invalidate()
        guard conversation != nil else { return }
        idleTimer = Timer.scheduledTimer(withTimeInterval: Self.conversationWindow, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                if self.talkHeld || self.remoteTalking {
                    self.resetIdleTimer()
                } else {
                    self.log("Conversation window ended")
                    self.finish()
                }
            }
        }
    }

    // MARK: Audio session

    /// Speaker by default (it's a walkie-talkie, not a phone call), Bluetooth headsets allowed.
    static func configureAudioSession() {
        try? AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .default,
                                                         options: [.defaultToSpeaker, .allowBluetoothHFP])
    }

    /// In-app mode: the app's own session, for the whole conversation.
    private func activateOwnAudio() {
        guard conversation != nil, !audioActive, !activatingAudio else { return }
        activatingAudio = true
        Self.configureAudioSession()
        Task.detached {
            let result: Result<Void, Error> = Result { try AVAudioSession.sharedInstance().setActive(true) }
            await MainActor.run {
                self.activatingAudio = false
                switch result {
                case .success: self.audioSessionActivated()
                case let .failure(error): self.log("Audio activation failed: \(error.localizedDescription)")
                }
            }
        }
    }

    private func audioSessionActivated() {
        guard conversation != nil, !audioActive else { return }
        conversation?.timeline.mark("audioActivated")
        if usesPushToTalk { Self.configureAudioSession() }
        do {
            try audio.start()
        } catch {
            log("Audio: \(error.localizedDescription)")
        }
        conversation?.timeline.mark("audioEngineStarted", once: false)
        audioActive = true
        updateTalkReady()
        startBurstIfReady()
    }

    private func handleAudioInterruption(_ raw: UInt?) {
        guard conversation != nil, !usesPushToTalk, let raw, let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        switch type {
        case .began:
            audio.stop()
            audioActive = false
            updateTalkReady()
        case .ended:
            activateOwnAudio()
        @unknown default:
            break
        }
    }

    // MARK: Teardown

    private func finishInBackground() {
        if backgroundTask == .invalid {
            backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Over&Out conversation end") { [weak self] in
                self?.endBackgroundTask()
            }
        }
        finish()
    }

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

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
        idleStream = false
        if talkHeld, usesPushToTalk { ptt.stopTransmitting() }
        if usesPushToTalk {
            ptt.setRemoteSpeaker(nil)
        } else {
            audio.stop()
            audioActive = false
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
        ended.timeline.mark("callEnded")

        conversation = nil
        incomingBurstEnded = false
        speakerIdle = true
        talkReady = false
        talkHeld = false
        isTalking = false
        remoteTalking = false
        burstId = nil
        idleTimer?.invalidate()
        phase = .idle
        statusLine = status

        let session = client.session
        guard let conversationId = ended.conversationId, let baseURL = relayBaseURL, let session else {
            endBackgroundTask()
            openIdleStreamIfNeeded()
            return
        }
        let body = ended.timeline.upload(conversationId: conversationId, userId: session.userId, clockOffsetMs: offset)
        Task {
            do {
                try await Self.post(baseURL, "/v1/metrics", body: body, token: session.token)
            } catch {
                log("Metrics upload failed: \(error.localizedDescription)")
            }
            endBackgroundTask()
            openIdleStreamIfNeeded()
        }
    }

    // MARK: Relay HTTPS (clock samples and timelines)

    private static func timeSample(_ baseURL: URL, token: String) async throws -> (offsetMs: Double, roundTripMs: Double) {
        var request = URLRequest(url: baseURL.appendingPathComponent("v1/time"))
        request.timeoutInterval = 10
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let sentAt = Clock.nowMs()
        let (data, _) = try await URLSession.shared.data(for: request)
        let receivedAt = Clock.nowMs()
        let serverTime = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["serverTime"] as? Double ?? 0
        return (serverTime - (sentAt + receivedAt) / 2, receivedAt - sentAt)
    }

    private static func post(_ baseURL: URL, _ path: String, body: [String: Any], token: String) async throws {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (_, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if !(200..<300).contains(status) { throw URLError(.badServerResponse) }
    }

    func log(_ line: String) {
        print("[oao] \(line)")
        conversation?.timeline.mark("log", detail: line, once: false)
    }
}
