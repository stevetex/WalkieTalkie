import AVFoundation
import os
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
    /// Per-burst audio levels marked per conversation, of each kind (burstLevelSent,
    /// burstLevelPlayed), at most.
    static let maxLevelMarks = 20
    /// An in-app ring stops after this; the relay abandons the ring at 35 s.
    static let inAppRingTimeout: TimeInterval = 30
    /// How long to keep trying to rejoin after the stream drops mid-conversation; the relay
    /// keeps a heard message 30 s after it ends for the resume.
    static let reconnectWindowMs: Double = 30_000

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
    /// The friend who didn't answer, can't be reached, or was lost when the connection couldn't
    /// be restored: their Talk screen shows the struck-through antenna, as on the watch, until
    /// the next conversation with them.
    @Published private(set) var unavailablePeer: String?

    let ptt: PushToTalkChannel
    private let client: AccountClient
    /// The relay: the service's approved one (GET /v2/config), else this build's own.
    private let config: ServiceConfigStore
    private var relayBaseURL: URL? { config.relayBaseURL }
    private let relay = RelayConnection()
    private let audio = AudioPipeline()

    private struct Conversation {
        let outgoing: Bool
        var conversationId: String?
        var peerId: String
        var peerName: String
        var timeline: Timeline
        var joined = false
        /// Receiving: the ring answered (v2), which the join names.
        var ringId: String?
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
    /// The burst being heard and the next frame expected in it, for resuming after a drop.
    private var incomingBurstId: String?
    private var nextIncomingSeq: UInt32 = 0
    /// Reconnecting after the stream dropped mid-conversation: since when, and attempts so far.
    private var reconnecting: (since: Double, attempts: Int)?
    private var speakerIdle = true
    private var clockOffsetMs: Double = 0
    private var bestClockRoundTripMs = Double.infinity
    private var inForeground = UIApplication.shared.applicationState != .background
    /// A stream open without a conversation, so the relay can ring the app (in-app mode).
    private var idleStream = false
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    private var usesPushToTalk: Bool { ptt.isJoined }

    init(client: AccountClient, config: ServiceConfigStore, ptt: PushToTalkChannel) {
        self.client = client
        self.config = config
        self.ptt = ptt
        // Timelines left unsent when iOS ended a background launch go at the next flush.
        Telemetry.shared.sendTimeline = { [client, config] body in
            guard let token = client.session?.token, let base = config.relayBaseURL else { throw URLError(.userAuthenticationRequired) }
            try await RelayAPI(baseURL: base, token: token).uploadTimeline(body)
        }

        relay.onReady = { [unowned self] offset in relayReady(clockOffsetMs: offset) }
        relay.onMessage = { [unowned self] message in handle(message) }
        relay.onFrame = { [unowned self] frame in
            if let seq = VoiceFrame.decode(frame)?.seq { nextIncomingSeq = max(nextIncomingSeq, seq + 1) }
            if conversation?.timeline.has("firstFrameReceived") == false { conversation?.timeline.mark("firstFrameReceived") }
            speakerIdle = false
            audio.enqueue(frame)
        }
        relay.onRefused = { [unowned self] refusal in
            log("Relay refused: \(refusal.code)")
            if refusal.requiresUpgrade {
                NotificationCenter.default.post(name: ServiceContract.upgradeRequiredNotification, object: nil)
                finish(status: "Update Over&Out to keep talking")
            } else if refusal.endsSession {
                // The account API confirms it and signs this iPhone out.
                let client = client
                Task { _ = try? await client.me() }
                finish(status: "You're signed out")
            }
        }
        relay.onClose = { [unowned self] reason in
            idleStream = false
            guard conversation != nil else { return }
            log("Relay closed: \(reason)")
            // The stream ended without the app closing it, mid-conversation.
            conversation?.timeline.mark("relayClosed", detail: String(reason.prefix(80)), once: false)
            Telemetry.shared.event("relayDropped", ["reason": String(reason.prefix(80)), "conversationId": conversation?.conversationId ?? ""])
            reconnectAfterDrop()
        }
        audio.onFrame = { [weak self] frame in self?.sendCaptured(frame) }
        audio.onFirstPlayback = { [weak self] t in
            self?.conversation?.timeline.mark("firstAudioScheduled", at: t)
            self?.conversation?.timeline.mark("burstAudioStarted", at: t, once: false)
        }
        audio.onPlaybackDrained = { [weak self] in
            self?.speakerIdle = true
            self?.friendStoppedTalkingIfDone()
        }
        audio.onFirstCapturedFrame = { [weak self] t in
            self?.conversation?.timeline.mark("micFirstFrame", at: t, once: false)
        }
        audio.onBurstCaptured = { [weak self] level, frames, detail in
            self?.markLevel("burstLevelSent", level, frames: frames, context: ",in=\(AudioLevel.inputPort())" + detail)
        }
        audio.onCaptureFormat = { [weak self] format in
            self?.conversation?.timeline.mark("micFormat", detail: format, once: false)
        }
        audio.onBurstPlayed = { [weak self] level, frames in
            // The system volume, so "played quietly" can be told from "volume turned down".
            let volume = String(format: "%.2f", AVAudioSession.sharedInstance().outputVolume)
            self?.markLevel("burstLevelPlayed", level, frames: frames, context: ",volume=\(volume)")
        }
        audio.onRestart = { [weak self] detail in
            let route = Self.routeDescription()
            self?.log("Audio: \(detail), route \(route)")
            self?.conversation?.timeline.mark("audioRestarted", detail: String(detail.prefix(60)), once: false)
            Telemetry.shared.event("audioRestarted", ["detail": String(detail.prefix(80)), "route": String(route.prefix(60))])
        }
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
    /// Signed out, it does nothing (and leaves nothing set), so signing in can open it.
    func openIdleStreamIfNeeded() {
        guard inForeground, !usesPushToTalk, conversation == nil, !idleStream, !relay.isConnecting else { return }
        guard let baseURL = relayBaseURL, client.session != nil else { return }
        idleStream = true
        withToken { [weak self] session in
            guard let self, idleStream, conversation == nil else { return }
            guard let session else {
                // The refresh failed: nothing is open, so the next chance should try again.
                idleStream = false
                return
            }
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
        // Before holding the new press: finishing clears talkHeld.
        if let current = conversation, current.peerId != friend.id { finish() }
        talkHeld = true
        isTalking = true
        idleTimer?.invalidate()
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

    /// The relay abandons an unanswered ring by itself; nothing to tell it. The decline is
    /// uploaded as a short timeline, so the relay's summaries can tell it from a missed ring.
    func declineIncomingRing() {
        let ring = incomingRing
        clearIncomingRing()
        guard let ring, relayBaseURL != nil, let session = client.session else { return }
        var timeline = Timeline(role: .receiver)
        if let sentAt = ring.pushSentAt { timeline.mark("pushSentAtServer", detail: String(Int(sentAt))) }
        timeline.mark("ringDeclined", detail: "in app")
        let offset = clockOffsetMs
        Task { await uploadTimeline(timeline, conversationId: ring.conversationId, clockOffsetMs: offset, session: session) }
    }

    func end() {
        finish()
    }

    // MARK: PushToTalk events

    private func handle(_ event: PushToTalkChannel.Event) {
        switch event {
        case let .ring(ring, receivedAt):
            log("PushToTalk push from \(ring.fromName)")
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
            log("PushToTalk audio activated")
            audioSessionActivated()
        case let .left(reason, byApp):
            log("Left the PushToTalk channel, reason \(reason)\(byApp ? ", by the app" : "")")
            conversation?.timeline.mark("pttLeft", detail: "reason \(reason)\(byApp ? ", app" : "")", once: false)
        case .audioDeactivated:
            log("PushToTalk audio deactivated")
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
        log("Answering \(ring.conversationId) via \(via), PushToTalk \(usesPushToTalk), foreground \(inForeground)")
        if let current = conversation {
            if current.conversationId == ring.conversationId, current.joined { return }
            if current.conversationId != ring.conversationId { finish() }
        }
        var timeline = Timeline(role: .receiver)
        if let sentAt = ring.pushSentAt { timeline.mark("pushSentAtServer", detail: String(Int(sentAt))) }
        if let receivedAt { timeline.mark("pttPushReceived", at: receivedAt) }
        timeline.mark("answerTapped", at: receivedAt ?? Clock.nowMs(), detail: via)
        conversation = Conversation(outgoing: false, conversationId: ring.conversationId,
                                    peerId: ring.from, peerName: ring.fromName, timeline: timeline, ringId: ring.ringId)
        phase = .connecting
        if unavailablePeer == ring.from { unavailablePeer = nil }
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
            relay.send(["type": "join", "conversationId": ring.conversationId, "ringId": ring.ringId])
            relayReady(clockOffsetMs: relay.clockOffsetMs)
        } else {
            idleStream = false
            conversation?.timeline.mark("joinSent", detail: "with the stream")
            connectRelay(join: ring.conversationId, ring: ring.ringId)
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
        if unavailablePeer == peerId { unavailablePeer = nil }
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

    /// `ring`: the ring a first join answers. A rejoin after a drop names none.
    private func connectRelay(join: String? = nil, ring: String? = nil, resume: RelayResume? = nil) {
        guard let baseURL = relayBaseURL else { return finish(status: "No server configured") }
        let conversationId = conversation?.conversationId
        withToken { [weak self] session in
            guard let self, conversation != nil, conversation?.conversationId == conversationId else { return }
            guard let session else {
                log("No session for the relay")
                return finish(status: "You're signed out")
            }
            log(join.map { "Connecting to the relay, joining \($0)" } ?? "Connecting to the relay")
            relay.connect(baseURL: baseURL, token: session.token, userId: session.userId, join: join, ring: ring, resume: resume)
        }
    }

    /// The stream dropped mid-conversation (run 106: airplane mode for 20 s ended it at once).
    /// Try for a while to rejoin on a fresh stream, resuming the message being heard from its
    /// first missed frame, before giving up.
    private func reconnectAfterDrop() {
        guard let current = conversation, let conversationId = current.conversationId else { return finish() }
        if talkHeld || burstId != nil {
            // The relay ended the burst when the stream went; what's said now wouldn't go out.
            cancelBurst()
            talkHeld = false
            isTalking = false
        }
        if reconnecting == nil { reconnecting = (Clock.nowMs(), 0) }
        phase = .connecting
        statusLine = "Reconnecting…"
        updateTalkReady()
        guard let drop = reconnecting, Clock.nowMs() - drop.since < Self.reconnectWindowMs else {
            log("Couldn't reconnect")
            conversation?.timeline.mark("reconnectGaveUp", detail: "\(reconnecting?.attempts ?? 0) attempts", once: false)
            reconnecting = nil
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            unavailablePeer = current.peerId
            return finish(status: "Lost the connection to \(current.peerName)")
        }
        // At most 2 s apart, so it's back within about 2 s of the network (run 106's test:
        // with 4 and 8 s it waited 7 s after the network returned).
        let delays: [Double] = [0, 1, 2]
        let delay = delays[min(drop.attempts, delays.count - 1)]
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, conversation?.conversationId == conversationId, var attempt = reconnecting else { return }
            attempt.attempts += 1
            reconnecting = attempt
            let resume = incomingBurstId.flatMap { burst in
                incomingBurstEnded && speakerIdle ? nil : RelayResume(burstId: burst, fromSeq: nextIncomingSeq)
            }
            conversation?.timeline.mark("joinSent", detail: "reconnect \(attempt.attempts)" + (resume.map { ", resume from \($0.fromSeq)" } ?? ""), once: false)
            connectRelay(join: conversationId, resume: resume)
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
        log("Relay stream open")
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
        let api = RelayAPI(baseURL: baseURL, token: token)
        Task {
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
        case "ring":
            guard let ring = Ring(message: message) else { return }
            guard conversation?.conversationId != ring.conversationId else { return }
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
            unavailablePeer = conversation?.peerId
            finish(status: message.reason == "unavailable" ? "\(name) isn't available" : "Can't reach \(name)")
        case "moved":
            // Answered or talked on the watch: the conversation is there now.
            finish(status: "Continued on your watch")
        case "conversation-ended":
            // A block, an unfriending or a deleted account: the relay dropped the conversation.
            guard message.conversationId == conversation?.conversationId else { return }
            cancelBurst()
            unavailablePeer = conversation?.peerId
            finish(status: "Can't reach \(name)")
        case "joined":
            log("Joined")
            conversation?.joined = true
            conversation?.timeline.mark("joined", detail: "\(message.replayBursts ?? 0) buffered bursts", once: false)
            phase = .live
            if let drop = reconnecting {
                reconnecting = nil
                conversation?.timeline.mark("rejoinedAfterDrop", detail: "attempt \(drop.attempts), \(Int(Clock.nowMs() - drop.since)) ms, resumed \(message.resumedFrames ?? 0) frames", once: false)
            }
            statusLine = "With \(name)"
            ptt.setServiceStatus(.ready)
            updateTalkReady()
        case "burst-start":
            let resumed = message.resumed == true && message.burstId == incomingBurstId
            if !resumed { nextIncomingSeq = 0 }
            incomingBurstId = message.burstId
            unavailablePeer = nil
            conversation?.timeline.mark("burstStartReceived", detail: resumed ? "resumed" : message.replay == true ? "replay" : "live", once: false)
            remoteTalking = true
            incomingBurstEnded = false
            statusLine = "\(name) is talking"
            idleTimer?.invalidate()
            // A resumed burst carries on where it stopped; resetting the decoder would glitch it.
            if !resumed { audio.beginPlayback() }
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
            unavailablePeer = conversation?.peerId
            conversation?.timeline.mark("ringTimedOut", detail: "\(message.droppedBursts ?? 0) bursts dropped")
        case "session-ended":
            // Signed out elsewhere, or the account was deleted: the API confirms it.
            let client = client
            Task { _ = try? await client.me() }
            finish(status: "You're signed out")
        case "error":
            log("Relay error: \(message.code ?? message.message ?? "unknown")")
            let receiving = conversation?.outgoing == false && conversation?.joined == false
            switch message.code {
            case "ring-expired" where receiving:
                // A late push or tap: that ring is over, and nothing of it plays.
                audio.discardPlayback()
                finish(status: "This conversation has expired")
            case "ring-answered-elsewhere" where receiving:
                finish(status: "Answered on your watch")
            case "unknown-conversation" where receiving:
                finish(status: "Missed \(name)")
            case "unknown-conversation" where reconnecting != nil:
                // Back after a drop, but the relay has ended the conversation meanwhile.
                reconnecting = nil
                finish(status: "Lost the connection to \(name)")
            default:
                break
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
        relay.send(["type": "talk-start", "to": current.peerId, "burstId": id, "codec": audio.codecName])
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
        audio.endCapture { [self] in
            relay.send(["type": "talk-end", "burstId": id])
            if burstId == id { burstId = nil }
            resetIdleTimer()
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

    /// Beta telemetry's per-burst levels: numbers only, never audio.
    private func markLevel(_ name: String, _ level: AudioLevel, frames: Int, context: String) {
        guard let timeline = conversation?.timeline, timeline.count(name) < Self.maxLevelMarks else { return }
        conversation?.timeline.mark(name, detail: level.detail(frames: frames) + context, once: false)
    }

    // MARK: Audio session

    /// Where audio goes and comes from now, for timelines: "Speaker, in MicrophoneBuiltIn".
    static func routeDescription() -> String {
        let session = AVAudioSession.sharedInstance()
        let outputs = session.currentRoute.outputs.map(\.portType.rawValue).joined(separator: "+")
        let inputs = session.currentRoute.inputs.map(\.portType.rawValue).joined(separator: "+")
        return "\(outputs), in \(inputs), \(session.category.rawValue.replacingOccurrences(of: "AVAudioSessionCategory", with: "")) \(session.mode.rawValue.replacingOccurrences(of: "AVAudioSessionMode", with: ""))"
    }

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
        // PushToTalk: the category set at launch stands; changing it while active adds delay.
        conversation?.timeline.mark("audioActivated", detail: Self.routeDescription())
        conversation?.timeline.mark("micSetup", detail: AudioLevel.microphoneSetup())
        // PushToTalk activates audio either to receive or to transmit: the microphone only for
        // the latter (see AudioPipeline.start). In the app's own session, both, for the whole window.
        let capture = !usesPushToTalk || talkHeld
        do {
            try audio.start(capture: capture)
        } catch {
            log("Audio: \(error.localizedDescription)")
        }
        conversation?.timeline.mark("audioEngineStarted", detail: capture ? "with microphone" : "speaker only", once: false)
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
            // Whether this conversation ever had audio, not whether it has now: iOS deactivates
            // it once a burst has played, before the conversation ends (run 99).
            if !ended.timeline.has("audioActivated") {
                // iOS never activated the audio (run 94: a phone call), so nothing stops the
                // pipeline: what arrived must not play in the next conversation.
                if ended.timeline.has("firstFrameReceived") { ended.timeline.mark("audioNeverActivated") }
                audio.discardPlayback()
            }
        } else {
            audio.stop()
            audioActive = false
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
        ended.timeline.mark("callEnded")

        conversation = nil
        incomingBurstEnded = false
        incomingBurstId = nil
        nextIncomingSeq = 0
        reconnecting = nil
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
        guard let conversationId = ended.conversationId, relayBaseURL != nil, let session else {
            endBackgroundTask()
            openIdleStreamIfNeeded()
            return
        }
        Task {
            await uploadTimeline(ended.timeline, conversationId: conversationId, clockOffsetMs: offset, session: session)
            endBackgroundTask()
            openIdleStreamIfNeeded()
        }
    }

    // MARK: Relay HTTPS (clock samples and timelines)

    /// The relay turns the timeline into a summary (outcome, latencies) and keeps only that
    /// (the Beta telemetry spec); the whole timeline stays in this iPhone's diagnostics log.
    /// Saved to disk before it's sent, in case iOS ends a background launch first.
    private func uploadTimeline(_ timeline: Timeline, conversationId: String, clockOffsetMs: Double, session: AccountSession) async {
        Telemetry.shared.timeline(timeline, conversationId: conversationId)
        var body = timeline.upload(conversationId: conversationId, userId: session.userId, clockOffsetMs: clockOffsetMs)
        body["device"] = Telemetry.shared.device
        await Telemetry.shared.uploadTimeline(body, conversationId: conversationId)
        await Telemetry.shared.flush()
    }

    /// In Console.app: the iPhone, subsystem com.cypressoakstudios.overandout.
    nonisolated static let logger = Logger(subsystem: "com.cypressoakstudios.overandout", category: "talk")

    func log(_ line: String) {
        Self.logger.notice("\(line, privacy: .public)")
        conversation?.timeline.mark("log", detail: line, once: false)
    }
}
