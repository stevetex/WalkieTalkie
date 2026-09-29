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

    let settings = AppSettings.load()
    /// Who this watch is (its session) and its friends.
    let account = WatchAccount.shared
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var statusLine = ""
    @Published private(set) var peerName: String?
    /// Who the conversation is with, for their picture.
    @Published private(set) var peerId: String?
    @Published private(set) var isTalking = false
    @Published private(set) var remoteTalking = false
    /// In a conversation and able to record right now (relay open and audio on). The Talk
    /// button shows "Wait…" until then.
    @Published private(set) var talkReady = false
    /// A ring that arrived while the app was on screen, waiting for Answer or Decline.
    @Published private(set) var incomingRing: Ring?
    /// When the in-app ring's notification was delivered, for the timeline.
    private var incomingRingDelivered: Date?
    /// A relay stream opened (without joining) while an in-app ring is showing, so the
    /// watch's network wakes up while the person reaches for Answer (run 17).
    private var preconnect: (startedAt: Double, readyAt: Double?)?
    #if DEBUG
    /// Testing: exit when the app goes to the background, so the next ring is a cold start
    /// (watchOS 27 has no app switcher, and quitting in the foreground brings the app back).
    @Published var quitWhenBackgrounded = false
    #endif
    @Published private(set) var registrationStatus = "Not registered yet"
    /// The APNs token (or a pseudo-token), registered under the account whenever there's a
    /// session.
    private var pushToken: (token: String, note: String?)?
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
    /// Prototype: frames of each burst already played from the extension's download, so
    /// the relay's replay of them is skipped (see playPrefetched).
    private var prefetchedFrames: [String: Int] = [:]
    /// The burst the relay is currently sending us.
    private var incomingBurstId: String?
    /// The relay has sent all of the friend's burst (burst-end)…
    private var incomingBurstEnded = false
    /// …and the speaker has played everything queued. Both, and they've stopped talking.
    private var speakerIdle = true
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
            // Already played from the prefetch download.
            if let burst = incomingBurstId, let played = prefetchedFrames[burst],
               let seq = VoiceFrame.decode(frame)?.seq, seq < played { return }
            if conversation?.timeline.has("firstFrameReceived") == false { conversation?.timeline.mark("firstFrameReceived") }
            speakerIdle = false
            audio.enqueue(frame)
        }
        relay.onClose = { [unowned self] reason in
            guard let current = conversation else {
                preconnect = nil
                return
            }
            if !current.outgoing, !current.joined {
                return rejoinOnFreshStream("relay closed before joining: \(reason)")
            }
            log("Relay closed: \(reason)")
            // The stream ended without the app closing it, mid-conversation.
            conversation?.timeline.mark("relayClosed", detail: String(reason.prefix(80)), once: false)
            Telemetry.shared.event("relayDropped", ["reason": String(reason.prefix(80)), "conversationId": current.conversationId ?? ""])
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
        audio.onPlaybackDrained = { [weak self] in
            self?.speakerIdle = true
            self?.friendStoppedTalkingIfDone()
        }
        audio.onFirstCapturedFrame = { [weak self] t in
            DispatchQueue.main.async { self?.conversation?.timeline.mark("micFirstFrame", at: t, once: false) }
        }
        audio.onRestart = { [unowned self] detail in
            log("Audio: \(detail)")
            conversation?.timeline.mark("audioRestarted", detail: String(detail.prefix(60)), once: false)
            Telemetry.shared.event("audioRestarted", ["detail": String(detail.prefix(80))])
        }

        NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [unowned self] note in handleAudioInterruption(note) }
        startMainThreadWatchdog()
        log("Codec: \(audio.codecDescription)")
        account.onSessionChanged = { [unowned self] session in
            if session != nil {
                registerPushToken()
            } else {
                registrationStatus = "Signed out"
                if conversation != nil { finish(status: "Signed out") }
            }
        }
        account.activate()
        scheduleAccountRefresh()
        registerForRings()
    }

    /// Refreshes the token and friends a few seconds after the app comes to the front, and
    /// only if no conversation is starting: a tap on a ring needs the watch's waking network
    /// for the relay, not for the account API.
    func scheduleAccountRefresh() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            guard let self, conversation == nil, incomingRing == nil else { return }
            account.refresh()
        }
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
        registerDevice(pushToken: "poll:\(account.deviceId)", note: "can't be rung (no push)")
    }

    private func registerDevice(pushToken: String, note: String? = nil) {
        self.pushToken = (pushToken, note)
        registerPushToken()
    }

    /// Registers the push token under the account (again after a new session arrives).
    private func registerPushToken() {
        guard let (token, note) = pushToken else { return }
        guard account.session != nil else {
            registrationStatus = "Waiting to sign in"
            return
        }
        Task { @MainActor in
            do {
                try await account.registerDevice(pushToken: token, apnsEnvironment: AppSettings.apnsEnvironment)
                registrationStatus = "Registered" + (note.map { ", \($0)" } ?? "")
            } catch {
                registrationStatus = "Registration failed: \(error.localizedDescription)"
            }
        }
    }

    // MARK: UI actions

    func talkPressed() {
        guard !talkHeld, conversation != nil || account.selectedFriend != nil else { return }
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
        answer(ring, via: "in app", delivered: incomingRingDelivered)
    }

    /// The relay abandons an unanswered ring by itself; nothing to tell it. The decline is
    /// uploaded as a short timeline, so the relay's summaries can tell it from a missed ring.
    func declineIncomingRing() {
        let ring = incomingRing
        clearIncomingRing()
        closePreconnect()
        guard let ring else { return }
        var timeline = Timeline(role: .receiver)
        if let sentAt = ring.pushSentAt { timeline.mark("pushSentAtServer", detail: String(Int(sentAt))) }
        timeline.mark("ringDeclined", detail: "in app")
        uploadTimeline(timeline, conversationId: ring.conversationId, clockOffsetMs: clockOffsetMs)
    }

    private func clearIncomingRing() {
        incomingRingTimer?.invalidate()
        incomingRing = nil
        incomingRingDelivered = nil
    }

    func end() {
        finish()
    }

    // MARK: Answering

    /// Opening the ring notification (or Answer in the app) is the answer. The request that
    /// opens the relay stream also joins, so the relay starts the replay without waiting
    /// for another round trip on a network that's still waking up.
    private func answer(_ ring: Ring, via: String, delivered: Date? = nil, openedAt: Double = Clock.nowMs()) {
        clearIncomingRing()
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
        if let preconnect {
            timeline.mark("preconnectStarted", at: preconnect.startedAt)
            if let readyAt = preconnect.readyAt { timeline.mark("preconnected", at: readyAt) }
        }
        timeline.mark("answerTapped", at: openedAt, detail: via)
        conversation = Conversation(outgoing: false, conversationId: ring.conversationId,
                                    peerId: ring.from, peerName: ring.fromName, timeline: timeline)
        phase = .connecting
        peerName = ring.fromName
        peerId = ring.from
        statusLine = "Connecting to \(ring.fromName)…"
        rejoinedOnFreshStream = false
        playPrefetched(ring.conversationId)
        if preconnect != nil, relay.isReady || relay.isConnecting {
            joinOverPreconnectedStream(ring.conversationId)
        } else {
            conversation?.timeline.mark("joinSent", detail: "with the stream")
            connectRelay(join: ring.conversationId)
        }
        preconnect = nil
        activateOwnAudio()
        resetIdleTimer()
        removeDeliveredNotifications(for: ring.conversationId)
    }

    /// Prototype: plays what the notification service extension downloaded when the
    /// relay's prefetch push arrived, before the relay stream is even open. The join still
    /// replays everything; relay.onFrame skips the frames played here.
    private func playPrefetched(_ conversationId: String) {
        guard let prefetched = Prefetched.take(conversationId: conversationId, userId: account.session?.userId) else { return }
        let meta = prefetched.meta
        if let t = meta["receivedAt"] as? Double { conversation?.timeline.mark("nseReceived", at: t) }
        if let t = meta["fetchStartedAt"] as? Double { conversation?.timeline.mark("nseFetchStarted", at: t) }
        let error = (meta["error"] as? String).map { ", \($0)" } ?? ""
        if let t = meta["fetchEndedAt"] as? Double {
            conversation?.timeline.mark("nseFetchEnded", at: t,
                                        detail: "HTTP \(meta["status"] ?? 0), \(meta["bytes"] ?? 0) bytes, \(prefetched.frameCount) frames\(meta["inApp"] != nil ? ", in app" : "")\(error)")
        } else if !error.isEmpty {
            conversation?.timeline.mark("nseFetchFailed", detail: String(error.dropFirst(2)))
        }
        guard prefetched.frameCount > 0 else { return }
        conversation?.timeline.mark("prefetchedAudioQueued", detail: "\(prefetched.bursts.count) bursts, \(prefetched.frameCount) frames")
        remoteTalking = true
        statusLine = "\(conversation?.peerName ?? "Your friend") is talking"
        // Queued before the audio session is up: the pipeline holds frames until it starts.
        for burst in prefetched.bursts where !burst.frames.isEmpty {
            prefetchedFrames[burst.burstId] = burst.frames.count
            audio.beginPlayback()
            speakerIdle = false
            for frame in burst.frames { audio.enqueue(frame) }
            if burst.ended { audio.endPlayback() }
        }
    }

    /// The held message, downloaded by the app when the prefetch push reached it directly
    /// (see willPresent). Saved like the extension's download, so answering plays it at once.
    private func prefetchInApp(_ ring: Ring, receivedAt: Double) {
        guard let baseURL = settings.baseURL else { return }
        account.withToken { session in
            guard let session,
                  var components = URLComponents(url: baseURL.appendingPathComponent("v1/rings/audio"), resolvingAgainstBaseURL: false) else { return }
            components.queryItems = [URLQueryItem(name: "userId", value: session.userId),
                                     URLQueryItem(name: "conversationId", value: ring.conversationId)]
            guard let url = components.url else { return }
            var request = URLRequest(url: url, timeoutInterval: 20)
            request.setValue("Bearer \(session.token)", forHTTPHeaderField: "Authorization")
            let startedAt = Clock.nowMs()
            URLSession.shared.dataTask(with: request) { data, response, error in
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                var meta: [String: Any] = ["receivedAt": receivedAt, "fetchStartedAt": startedAt, "fetchEndedAt": Clock.nowMs(),
                                           "userId": session.userId, "status": status, "inApp": true]
                if let sentAt = ring.pushSentAt { meta["pushSentAt"] = sentAt }
                if let error { meta["error"] = String(error.localizedDescription.prefix(80)) }
                if status == 200, let data { meta["bytes"] = data.count }
                Prefetched.save(conversationId: ring.conversationId, records: status == 200 ? data : nil, meta: meta)
                Telemetry.shared.event("prefetchInApp", ["status": status, "bytes": data?.count ?? 0])
            }.resume()
        }
    }

    /// Opens the relay stream without joining while an in-app ring is showing.
    private func preconnectRelay() {
        guard conversation == nil, preconnect == nil, let baseURL = settings.baseURL else { return }
        preconnect = (Clock.nowMs(), nil)
        account.withToken { [unowned self] session in
            guard let session, preconnect != nil, conversation == nil else { return }
            relay.connect(baseURL: baseURL, token: session.token, userId: session.userId)
        }
    }

    private func closePreconnect() {
        guard conversation == nil, preconnect != nil else { return }
        preconnect = nil
        relay.close()
    }

    /// Answer sends only "join" over the stream the in-app ring opened. It's queued until
    /// the stream's hello-ack if it's still opening. A stream that went stale without saying
    /// so is replaced by a fresh one that joins in its request.
    private func joinOverPreconnectedStream(_ conversationId: String) {
        conversation?.timeline.mark("joinSent", detail: relay.isReady ? "over the open stream" : "queued on the opening stream")
        relay.send(["type": "join", "conversationId": conversationId])
        if relay.isReady { relayReady(clockOffsetMs: relay.clockOffsetMs) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            guard let self, conversation?.conversationId == conversationId, conversation?.joined == false else { return }
            rejoinOnFreshStream("not joined after 4 s")
        }
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
        guard let friend = account.selectedFriend else { return }
        var timeline = Timeline(role: .sender)
        timeline.mark("talkPressed")
        let name = friend.name
        conversation = Conversation(outgoing: true, conversationId: nil,
                                    peerId: friend.id, peerName: name, timeline: timeline)
        phase = .connecting
        peerName = name
        peerId = friend.id
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
        // Normally synchronous; an expired token (a watch unused for 30 days) is refreshed first.
        let conversationId = conversation?.conversationId
        account.withToken { [unowned self] session in
            guard conversation != nil, conversation?.conversationId == conversationId else { return }
            guard let session else {
                log("Not signed in")
                return finish(status: "Sign in on your iPhone")
            }
            relay.connect(baseURL: baseURL, token: session.token, userId: session.userId, join: join)
        }
    }

    private func updateTalkReady() {
        talkReady = conversation != nil && relay.isReady && conversation?.audioActive == true
    }

    private func relayReady(clockOffsetMs: Double) {
        guard let current = conversation else {
            if preconnect != nil, preconnect?.readyAt == nil { preconnect?.readyAt = Clock.nowMs() }
            return
        }
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
        let api = APIClient(settings: settings, token: account.session?.token)
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
        case "talk-refused":
            // No longer friends (removed or blocked): nobody was rung.
            WKInterfaceDevice.current().play(.failure)
            audio.endCapture {}
            burstId = nil
            finish(status: "Can't reach \(name)")
            account.refresh()
        case "joined":
            conversation?.joined = true
            conversation?.timeline.mark("joined", detail: "\(message.replayBursts ?? 0) buffered bursts")
            phase = .live
            statusLine = "With \(name)"
        case "burst-start":
            incomingBurstId = message.burstId
            let prefetched = message.burstId.flatMap { prefetchedFrames[$0] }
            conversation?.timeline.mark("burstStartReceived",
                                        detail: (message.replay == true ? "replay" : "live") + (prefetched.map { ", \($0) frames prefetched" } ?? ""),
                                        once: false)
            remoteTalking = true
            incomingBurstEnded = false
            statusLine = "\(name) is talking"
            idleTimer?.invalidate()
            // A prefetched burst is already playing; resetting the decoder would glitch it.
            if prefetched == nil { audio.beginPlayback() }
        case "burst-end":
            // Still talking until the speaker has played it all.
            incomingBurstEnded = true
            audio.endPlayback()
            friendStoppedTalkingIfDone()
            resetIdleTimer()
        case "moved":
            // Answered or talked on the iPhone: the conversation is there now. (The relay
            // ignores this device's leave, since it's no longer the one in the conversation.)
            audio.endCapture {}
            burstId = nil
            finish(status: "Continued on your iPhone")
        case "conversation-ended":
            // A block, an unfriending or a deleted account: the relay dropped the conversation.
            guard message.conversationId == conversation?.conversationId else { return }
            WKInterfaceDevice.current().play(.failure)
            audio.endCapture {}
            burstId = nil
            finish(status: "Can't reach \(name)")
            account.refresh()
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

    /// A replayed burst arrives far faster than it plays, so "is talking" lasts until both
    /// the relay's burst-end and the speaker going quiet.
    private func friendStoppedTalkingIfDone() {
        guard remoteTalking, incomingBurstEnded, speakerIdle else { return }
        remoteTalking = false
        statusLine = "With \(conversation?.peerName ?? "Your friend")"
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
        preconnect = nil
        prefetchedFrames = [:]
        incomingBurstId = nil
        incomingBurstEnded = false
        speakerIdle = true
        talkReady = false
        talkHeld = false
        isTalking = false
        remoteTalking = false
        burstId = nil
        idleTimer?.invalidate()
        phase = .idle
        peerName = nil
        peerId = nil
        statusLine = status

        guard let conversationId = ended.conversationId else { return }
        uploadTimeline(ended.timeline, conversationId: conversationId, clockOffsetMs: offset)
    }

    /// The relay turns the timeline into a summary (outcome, latencies) and keeps only that
    /// (the Beta telemetry spec); the whole timeline stays in the watch's diagnostics log.
    private func uploadTimeline(_ timeline: Timeline, conversationId: String, clockOffsetMs: Double) {
        Telemetry.shared.timeline(timeline, conversationId: conversationId)
        var body = timeline.upload(conversationId: conversationId, userId: account.session?.userId ?? "", clockOffsetMs: clockOffsetMs)
        body["device"] = Telemetry.shared.device
        let api = APIClient(settings: settings, token: account.session?.token)
        Task { @MainActor in
            do {
                try await api.uploadMetrics(body)
            } catch {
                log("Metrics upload failed: \(error.localizedDescription)")
            }
            await Telemetry.shared.flush()
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
        let info = notification.request.content.userInfo
        guard let ring = Ring(userInfo: info) else {
            return completionHandler([.banner, .sound])
        }
        let receivedAt = Clock.nowMs()
        let isPrefetch = info["prefetch"] != nil
        DispatchQueue.main.async {
            defer { completionHandler([]) }
            // Which path each ring takes, for the frontmost case (run 60).
            Telemetry.shared.event("ringInApp", ["prefetch": isPrefetch, "state": WKApplication.shared().applicationState.rawValue])
            guard self.conversation?.conversationId != ring.conversationId else { return }
            // The prefetch push reached the app itself: watchOS skips the notification service
            // extension while the app is frontmost, even with the screen off. Download the held
            // message here, as the extension would, and never ring again for it.
            if isPrefetch {
                self.prefetchInApp(ring, receivedAt: receivedAt)
                return
            }
            // The prefetch push for a ring that's already ringing in the app: don't ring again.
            guard self.incomingRing?.conversationId != ring.conversationId else { return }
            self.incomingRing = ring
            self.incomingRingDelivered = notification.date
            self.preconnectRelay()
            WKInterfaceDevice.current().play(.notification)
            self.incomingRingTimer?.invalidate()
            self.incomingRingTimer = Timer.scheduledTimer(withTimeInterval: Self.inAppRingTimeout, repeats: false) { _ in
                guard self.incomingRing == ring else { return }
                self.declineIncomingRing()
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
