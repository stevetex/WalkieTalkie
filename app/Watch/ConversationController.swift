import AVFoundation
import Combine
import Network
import os
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
/// Everything here runs on the main actor: the relay and the audio pipeline deliver there,
/// and notification and system callbacks hop to it.
@MainActor
final class ConversationController: NSObject, ObservableObject {
    static let shared = ConversationController()

    /// Idle time that ends a conversation (fixed for the MVP; see Design decisions).
    static let conversationWindow: TimeInterval = 45
    /// An in-app ring stops after this; the relay abandons the ring at 35 s.
    static let inAppRingTimeout: TimeInterval = 30
    /// Talk starts before the relay stream opens; a stream that hasn't opened by then fails.
    static let connectTimeout: TimeInterval = 10
    /// A stream a Talk screen opened ahead of a press closes after this with no conversation.
    static let preconnectIdle: TimeInterval = 60
    /// Main-queue delays at least this long are marked in the timeline (runs 64–65), at most
    /// `maxStallMarks` per conversation.
    static let stallThresholdMs: Double = 200
    static let maxStallMarks = 30
    /// Per-burst audio levels marked per conversation, of each kind (burstLevelSent,
    /// burstLevelPlayed), at most.
    static let maxLevelMarks = 20

    enum Phase: Equatable {
        case idle
        case connecting
        case live
    }

    let settings = AppSettings.load()
    /// Who this watch is (its session) and its friends.
    let account = WatchAccount.shared
    @Published private(set) var phase: Phase = .idle
    /// How a conversation with a friend last ended badly, for their row in the friends list
    /// (the Talk screen shows only the friend it's for). Cleared when a new conversation with
    /// them starts, or they talk.
    enum Outcome: Equatable {
        case missed, didNotAnswer, unreachable, continuedOnPhone, couldNotConnect

        /// The friend couldn't be reached: their dot is red.
        var isUnavailable: Bool { self == .didNotAnswer || self == .unreachable || self == .couldNotConnect }
    }
    struct OutcomeNote: Equatable {
        let outcome: Outcome
        let at: Date
    }
    /// By friend ID.
    @Published private(set) var outcomes: [String: OutcomeNote] = [:]
    @Published private(set) var peerName: String?
    /// Who the conversation is with, for their picture.
    @Published private(set) var peerId: String?
    @Published private(set) var isTalking = false
    @Published private(set) var remoteTalking = false
    /// In a conversation and able to record right now (audio on). What's said before the
    /// relay stream opens is held and sent when it does, so the go-ahead doesn't wait for a
    /// cold connection (2.1 s in run 66). The mouth shows the hourglass until then.
    @Published private(set) var talkReady = false
    /// In a conversation with the relay stream open: the antenna is green, not yellow.
    @Published private(set) var connected = false
    /// A ring that arrived while the app was on screen, waiting for Answer or Decline.
    @Published private(set) var incomingRing: Ring?
    /// Set when a ring is answered (in the app or from its notification), so the app shows
    /// the caller's Talk screen. The view clears it.
    @Published var arrivedFrom: String?
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
        /// The relay stream opened (hello-ack) at least once.
        var relayOpened = false
        let id = UUID()
    }

    /// Stamps when relay data arrives, off the main queue, for the timeline.
    private let relay = RelayConnection(stampsArrivals: true)
    // The watch's microphone arrives quiet and unleveled (build 140: speech peaking at −35 dBFS).
    private let audio = AudioPipeline(autoGain: true)

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
    private var stallMarks = 0
    /// Per-request network timings marked this conversation, by kind (at most 3 of each).
    private var netMarks: [String: Int] = [:]
    /// What NWPathMonitor last said: Wi-Fi, cellular, or "other" (through the iPhone?).
    private let pathMonitor = NWPathMonitor()
    private var networkDescription = "unknown"
    /// The conversation that just ended, for the stream's timings, which come after.
    private var endedConversationId: String?
    /// The friend whose Talk screen is showing, which keeps a stream open ahead of a press.
    private var preparingFor: String?
    private var preconnectTimer: Timer?

    /// Called from applicationDidFinishLaunching: a notification tap can launch the app, and
    /// its response is only delivered if the notification delegate is set by then.
    func start() {
        guard !started else { return }
        started = true
        UNUserNotificationCenter.current().delegate = self
        // Timelines left unsent when the watch was suspended go at the next flush.
        Telemetry.shared.sendTimeline = { [settings] body in
            let token = await WatchAccount.shared.session?.token
            try await APIClient(settings: settings, token: token).uploadMetrics(body)
        }

        relay.onReady = { [unowned self] offset in relayReady(clockOffsetMs: offset, helloAckArrivedAt: relay.lastArrivalMs) }
        relay.onMessage = { [unowned self] message in handle(message) }
        relay.onFrame = { [unowned self] frame in
            // Already played from the prefetch download.
            if let burst = incomingBurstId, let played = prefetchedFrames[burst],
               let seq = VoiceFrame.decode(frame)?.seq, seq < played { return }
            if conversation?.timeline.has("firstFrameReceived") == false {
                conversation?.timeline.mark("firstFrameArrived", at: relay.lastArrivalMs)
                conversation?.timeline.mark("firstFrameReceived")
            }
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
            if current.outgoing, !current.relayOpened {
                // Talk started without the relay, so say it didn't go out.
                log("Couldn't open the relay: \(reason)")
                conversation?.timeline.mark("relayClosed", detail: String(reason.prefix(80)), once: false)
                WKInterfaceDevice.current().play(.failure)
                return finish(outcome: .couldNotConnect)
            }
            log("Relay closed: \(reason)")
            // The stream ended without the app closing it, mid-conversation.
            conversation?.timeline.mark("relayClosed", detail: String(reason.prefix(80)), once: false)
            Telemetry.shared.event("relayDropped", ["reason": String(reason.prefix(80)), "conversationId": current.conversationId ?? ""])
            finish()
        }
        relay.onTaskMetrics = { [unowned self] kind, metrics in
            guard let network = Self.describe(metrics) else { return }
            if conversation != nil, netMarks[kind, default: 0] < 3 {
                netMarks[kind, default: 0] += 1
                conversation?.timeline.mark("net-\(kind)", at: network.requestStartedAt, detail: network.detail, once: false)
            } else if kind == "stream" {
                Telemetry.shared.event("relayStreamMetrics", ["detail": network.detail, "conversationId": endedConversationId ?? ""])
            }
        }
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let description = Self.describe(path)
            DispatchQueue.main.async { self?.networkDescription = description }
        }
        pathMonitor.start(queue: .global(qos: .utility))
        relay.onPostFinished = { [unowned self] started, finished, bytes, status in
            let joining = conversation?.outgoing == false && conversation?.joined == false
            guard burstId != nil || talkHeld || joining, postsThisBurst < 3 else { return }
            postsThisBurst += 1
            conversation?.timeline.mark("post\(postsThisBurst)", at: finished,
                                        detail: "\(bytes) bytes, \(Int(finished - started)) ms, HTTP \(status)", once: false)
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
            self?.markLevel("burstLevelPlayed", level, frames: frames, context: "")
        }
        audio.onRestart = { [unowned self] detail in
            log("Audio: \(detail)")
            conversation?.timeline.mark("audioRestarted", detail: String(detail.prefix(60)), once: false)
            Telemetry.shared.event("audioRestarted", ["detail": String(detail.prefix(80))])
        }

        NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            MainActor.assumeIsolated { self?.handleAudioInterruption(raw) }
        }
        startMainThreadWatchdog()
        log("Codec: \(audio.codecDescription)")
        account.onSessionChanged = { [unowned self] session in
            if session != nil {
                registerPushToken()
            } else {
                registrationStatus = "Signed out"
                if conversation != nil { finish() }
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
        let completion: @Sendable (Bool) -> Void = { granted in
            DispatchQueue.main.async { if !granted { self.log("Microphone permission denied") } }
        }
        AVAudioApplication.requestRecordPermission(completionHandler: completion)
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

    /// Hold on a friend's Talk screen. A conversation with someone else ends first, as on
    /// the iPhone.
    func talkPressed(to friend: Friend) {
        guard !talkHeld else { return }
        // Before holding the new press: finishing clears talkHeld.
        if let current = conversation, current.peerId != friend.id { finish() }
        // Wakes the network over an open stream while the audio starts (runs 67, 69).
        let pressedAt = Clock.nowMs()
        let warmed = relay.isReady
        relay.warmUp()
        defer { if warmed { conversation?.timeline.mark("warmUpSent", at: pressedAt, once: false) } }
        talkHeld = true
        isTalking = true
        idleTimer?.invalidate()
        if conversation == nil {
            startOutgoingConversation(peerId: friend.id, peerName: friend.name)
        } else {
            conversation?.timeline.mark("talkPressedInWindow", once: false)
            outcomes[friend.id] = nil
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
        audio.endCapture { [self] in
            relay.send(["type": "talk-end", "burstId": id])
            if burstId == id { burstId = nil }
            resetIdleTimer()
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
        if let friendId = preparingFor { prepare(for: friendId) }
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
        timeline.mark("network", detail: networkDescription)
        conversation = Conversation(outgoing: false, conversationId: ring.conversationId,
                                    peerId: ring.from, peerName: ring.fromName, timeline: timeline)
        phase = .connecting
        peerName = ring.fromName
        peerId = ring.from
        outcomes[ring.from] = nil
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
        // Last, so showing the caller's screen never delays the relay or the audio.
        arrivedFrom = ring.from
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
            return finish(outcome: .couldNotConnect)
        }
        rejoinedOnFreshStream = true
        log("Rejoining on a fresh stream (\(why))")
        conversation?.timeline.mark("joinSent", detail: "fresh stream", once: false)
        connectRelay(join: conversationId)
    }

    private func removeDeliveredNotifications(for conversationId: String) {
        UNUserNotificationCenter.current().getDeliveredNotifications { notifications in
            let ids = notifications
                .filter { Ring(userInfo: $0.request.content.userInfo)?.conversationId == conversationId }
                .map(\.request.identifier)
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids)
        }
    }

    // MARK: Outgoing

    private func startOutgoingConversation(peerId: String, peerName name: String) {
        var timeline = Timeline(role: .sender)
        timeline.mark("talkPressed")
        timeline.mark("network", detail: networkDescription)
        conversation = Conversation(outgoing: true, conversationId: nil,
                                    peerId: peerId, peerName: name, timeline: timeline)
        phase = .connecting
        peerName = name
        self.peerId = peerId
        outcomes[peerId] = nil
        preconnectTimer?.invalidate()
        if let preconnect, relay.isReady || relay.isConnecting {
            // The stream this friend's Talk screen opened: no cold connection to wait for.
            conversation?.timeline.mark("preconnectStarted", at: preconnect.startedAt)
            if let readyAt = preconnect.readyAt { conversation?.timeline.mark("preconnected", at: readyAt) }
            self.preconnect = nil
            if relay.isReady { relayReady(clockOffsetMs: relay.clockOffsetMs) }
        } else {
            preconnect = nil
            connectRelay()
        }
        activateOwnAudio()
        // Talk has started without the relay; give up if its stream never opens.
        let id = conversation?.id
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.connectTimeout) { [weak self] in
            guard let self, let current = conversation, current.id == id, !current.relayOpened else { return }
            log("The relay didn't open in \(Int(Self.connectTimeout)) s")
            conversation?.timeline.mark("connectTimedOut")
            WKInterfaceDevice.current().play(.failure)
            finish(outcome: .couldNotConnect)
        }
    }

    // MARK: Relay

    private func connectRelay(join: String? = nil) {
        guard let baseURL = settings.baseURL else {
            log("The server isn't configured in this build")
            return finish(outcome: .couldNotConnect)
        }
        // Normally synchronous; an expired token (a watch unused for 30 days) is refreshed first.
        let conversationId = conversation?.conversationId
        account.withToken { [unowned self] session in
            guard conversation != nil, conversation?.conversationId == conversationId else { return }
            guard let session else {
                log("Not signed in")
                // The app shows its sign-in prompt.
                return finish()
            }
            relay.connect(baseURL: baseURL, token: session.token, userId: session.userId, join: join)
        }
    }

    private func updateTalkReady() {
        talkReady = conversation?.audioActive == true
        connected = conversation != nil && relay.isReady
    }

    /// `helloAckArrivedAt`: when the stream's hello-ack arrived, if this is it (not a stream
    /// opened earlier and reused).
    private func relayReady(clockOffsetMs: Double, helloAckArrivedAt: Double? = nil) {
        guard let current = conversation else {
            if preconnect != nil, preconnect?.readyAt == nil { preconnect?.readyAt = Clock.nowMs() }
            return
        }
        defer { updateTalkReady() }
        conversation?.relayOpened = true
        if let helloAckArrivedAt { conversation?.timeline.mark("helloAckArrived", at: helloAckArrivedAt) }
        conversation?.timeline.mark("socketOpen")
        // What was said before the stream opened goes out now (the relay held it).
        if conversation?.timeline.has("firstFrameQueued") == true, conversation?.timeline.has("firstFrameSent") == false {
            conversation?.timeline.mark("firstFrameSent", detail: "queued before the stream opened")
        }
        self.clockOffsetMs = clockOffsetMs
        bestClockRoundTripMs = .infinity
        refineClockOffset()
        if current.outgoing {
            phase = .live
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
            // Your press was refused because they're talking (the mouth shows them talking).
            WKInterfaceDevice.current().play(.failure)
            audio.endCapture {}
            burstId = nil
        case "talk-refused":
            // No longer friends (removed or blocked): nobody was rung.
            WKInterfaceDevice.current().play(.failure)
            audio.endCapture {}
            burstId = nil
            finish(outcome: .unreachable)
            account.refresh()
        case "joined":
            conversation?.timeline.mark("joinedArrived", at: relay.lastArrivalMs)
            conversation?.joined = true
            conversation?.timeline.mark("joined", detail: "\(message.replayBursts ?? 0) buffered bursts")
            phase = .live
        case "burst-start":
            incomingBurstId = message.burstId
            let prefetched = message.burstId.flatMap { prefetchedFrames[$0] }
            conversation?.timeline.mark("burstStartReceived",
                                        detail: (message.replay == true ? "replay" : "live") + (prefetched.map { ", \($0) frames prefetched" } ?? ""),
                                        once: false)
            remoteTalking = true
            incomingBurstEnded = false
            if let id = conversation?.peerId { outcomes[id] = nil }
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
            finish(outcome: .continuedOnPhone)
        case "conversation-ended":
            // A block, an unfriending or a deleted account: the relay dropped the conversation.
            guard message.conversationId == conversation?.conversationId else { return }
            WKInterfaceDevice.current().play(.failure)
            audio.endCapture {}
            burstId = nil
            finish(outcome: .unreachable)
            account.refresh()
        case "peer-left":
            log("\(name) left")
        case "ring-timeout":
            // The relay dropped what they didn't hear; the next Talk rings them again.
            WKInterfaceDevice.current().play(.failure)
            if let id = conversation?.peerId { outcomes[id] = OutcomeNote(outcome: .didNotAnswer, at: Date()) }
            conversation?.timeline.mark("ringTimedOut", detail: "\(message.droppedBursts ?? 0) bursts dropped")
        case "error":
            log("Relay error: \(message.message ?? "unknown")")
            if message.message == "unknown conversation", conversation?.outgoing == false, conversation?.joined == false {
                // Answered after the relay gave up on the ring: the message is gone.
                WKInterfaceDevice.current().play(.failure)
                finish(outcome: .missed)
            }
        default:
            break
        }
    }

    // MARK: Talking

    /// Doesn't wait for the relay stream: talk-start and the frames queue until it opens.
    private func startBurstIfReady() {
        guard talkHeld, burstId == nil, let current = conversation, current.audioActive else { return }
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
            conversation?.timeline.mark(relay.isReady ? "firstFrameSent" : "firstFrameQueued")
        }
    }

    /// A replayed burst arrives far faster than it plays, so "is talking" lasts until both
    /// the relay's burst-end and the speaker going quiet.
    private func friendStoppedTalkingIfDone() {
        guard remoteTalking, incomingBurstEnded, speakerIdle else { return }
        remoteTalking = false
    }

    // MARK: Conversation window

    private func resetIdleTimer() {
        idleTimer?.invalidate()
        guard conversation != nil else { return }
        idleTimer = Timer.scheduledTimer(withTimeInterval: Self.conversationWindow, repeats: false) { [weak self] _ in
            guard let self else { return }
            MainActor.assumeIsolated {
                if talkHeld || remoteTalking {
                    resetIdleTimer()
                } else {
                    log("Conversation window ended")
                    finish()
                }
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
            let returnedAt = Clock.nowMs()
            DispatchQueue.main.async {
                self.activatingAudio = false
                if success {
                    self.conversation?.timeline.mark("audioActivationReturned", at: returnedAt)
                    self.audioSessionActivated()
                } else {
                    self.log("Audio activation failed: \(error?.localizedDescription ?? "unknown")")
                }
            }
        }
    }

    /// Beta telemetry's per-burst levels: numbers only, never audio.
    private func markLevel(_ name: String, _ level: AudioLevel, frames: Int, context: String) {
        guard let timeline = conversation?.timeline, timeline.count(name) < Self.maxLevelMarks else { return }
        conversation?.timeline.mark(name, detail: level.detail(frames: frames) + context, once: false)
    }

    private func audioSessionActivated() {
        guard conversation != nil, conversation?.audioActive == false else { return }
        conversation?.timeline.mark("audioActivated")
        conversation?.timeline.mark("micSetup", detail: AudioLevel.microphoneSetup())
        do {
            try audio.start()
        } catch {
            log("Audio: \(error.localizedDescription)")
        }
        // As on the iPhone: how long the engine takes after the session, before first audio.
        conversation?.timeline.mark("audioEngineStarted", once: false)
        // Playback runs even if capture couldn't start.
        conversation?.audioActive = true
        updateTalkReady()
        startBurstIfReady()
    }

    /// Something else (a phone call, Siri) interrupted the app's audio.
    private func handleAudioInterruption(_ raw: UInt?) {
        guard conversation != nil, let raw, let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
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

    /// Ends the conversation. An `outcome` stays on the friend's row in the friends list.
    private func finish(outcome: Outcome? = nil) {
        guard var ended = conversation else { return }
        if let outcome { outcomes[ended.peerId] = OutcomeNote(outcome: outcome, at: Date()) }
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
        stallMarks = 0
        netMarks = [:]
        endedConversationId = ended.conversationId
        postsThisBurst = 0
        connected = false
        phase = .idle
        peerName = nil
        peerId = nil
        // Still on a Talk screen: ready for the next press.
        if let friendId = preparingFor {
            DispatchQueue.main.async { self.prepare(for: friendId) }
        }

        guard let conversationId = ended.conversationId else { return }
        uploadTimeline(ended.timeline, conversationId: conversationId, clockOffsetMs: offset)
    }

    /// The relay turns the timeline into a summary (outcome, latencies) and keeps only that
    /// (the Beta telemetry spec); the whole timeline stays in the watch's diagnostics log.
    /// Saved to disk before it's sent, in case the watch suspends first (run 63).
    private func uploadTimeline(_ timeline: Timeline, conversationId: String, clockOffsetMs: Double) {
        Telemetry.shared.timeline(timeline, conversationId: conversationId)
        var body = timeline.upload(conversationId: conversationId, userId: account.session?.userId ?? "", clockOffsetMs: clockOffsetMs)
        body["device"] = Telemetry.shared.device
        Task { @MainActor in
            await Telemetry.shared.uploadTimeline(body, conversationId: conversationId)
            await Telemetry.shared.flush()
        }
    }

    // MARK: Diagnostics

    /// Application state changes (wrist down, app in the background), for the timeline.
    func noteAppState(_ state: String) {
        conversation?.timeline.mark("app", detail: state, once: false)
        switch state {
        case "background":
            // A suspended app's stream dies anyway; the Talk screen reopens it when it's back.
            preconnectTimer?.invalidate()
            if incomingRing == nil { closePreconnect() }
        case "active":
            if let friendId = preparingFor { prepare(for: friendId) }
        default:
            break
        }
    }

    // MARK: Network diagnostics

    /// A request's timings from the network stack: its protocol, a new or reused connection
    /// (with DNS, connect and TLS), request → first response byte, and the path's flags.
    private nonisolated static func describe(_ metrics: URLSessionTaskMetrics) -> (requestStartedAt: Double, detail: String)? {
        guard let t = metrics.transactionMetrics.last, let start = t.requestStartDate ?? t.fetchStartDate else { return nil }
        func ms(_ from: Date?, _ to: Date?) -> String {
            guard let from, let to else { return "-" }
            return String(Int(to.timeIntervalSince(from) * 1000))
        }
        var parts = [t.networkProtocolName ?? "?"]
        if t.isReusedConnection {
            parts.append("reused")
        } else {
            parts.append("new: dns \(ms(t.domainLookupStartDate, t.domainLookupEndDate)), connect \(ms(t.connectStartDate, t.connectEndDate)), tls \(ms(t.secureConnectionStartDate, t.secureConnectionEndDate)) ms")
        }
        parts.append("request → response \(ms(t.requestStartDate, t.responseStartDate)) ms")
        if t.isProxyConnection { parts.append("proxy") }
        if t.isCellular { parts.append("cellular") }
        if t.isExpensive { parts.append("expensive") }
        if t.isConstrained { parts.append("constrained") }
        return (start.timeIntervalSince1970 * 1000, parts.joined(separator: ", "))
    }

    /// The interfaces the watch can use, preferred first: "wifi", "cellular", or "other".
    private nonisolated static func describe(_ path: NWPath) -> String {
        let interfaces = path.availableInterfaces.map { interface -> String in
            switch interface.type {
            case .wifi: return "wifi"
            case .cellular: return "cellular"
            case .wiredEthernet: return "ethernet"
            case .loopback: return "loopback"
            case .other: return "other"
            @unknown default: return "unknown"
            }
        }
        var parts = [interfaces.isEmpty ? "none" : interfaces.joined(separator: "+")]
        if path.status != .satisfied { parts.append("\(path.status)") }
        if path.isExpensive { parts.append("expensive") }
        if path.isConstrained { parts.append("constrained") }
        return parts.joined(separator: ", ")
    }

    // MARK: Pre-connecting from a Talk screen

    /// A friend's Talk screen appeared: mark it, and open the relay stream ahead of a press.
    func talkScreenShown(_ friendId: String) {
        conversation?.timeline.mark("talkScreenShown", once: false)
        prepare(for: friendId)
    }

    /// Opens the relay stream while a Talk screen shows, so the first press doesn't wait for
    /// a cold connection. It closes when the screen goes, the app goes to the background, or
    /// after `preconnectIdle` with no conversation.
    func prepare(for friendId: String) {
        preparingFor = friendId
        guard conversation == nil, incomingRing == nil else { return }
        preconnectRelay()
        preconnectTimer?.invalidate()
        preconnectTimer = Timer.scheduledTimer(withTimeInterval: Self.preconnectIdle, repeats: false) { [weak self] _ in
            guard let self else { return }
            MainActor.assumeIsolated {
                guard conversation == nil, incomingRing == nil else { return }
                log("Closing the idle pre-connected stream")
                closePreconnect()
            }
        }
    }

    func stopPreparing(for friendId: String) {
        guard preparingFor == friendId else { return }
        preparingFor = nil
        preconnectTimer?.invalidate()
        if incomingRing == nil { closePreconnect() }
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
        let lastTick = OSAllocatedUnfairLock(initialState: Clock.nowMs())
        // @Sendable, so not main-actor: the timer fires on a global queue.
        timer.setEventHandler { @Sendable [weak self] in
            let queuedAt = Clock.nowMs()
            let gap = lastTick.withLock { lastTick in
                defer { lastTick = queuedAt }
                return queuedAt - lastTick
            }
            if gap > 1_000 {
                DispatchQueue.main.async {
                    self?.conversation?.timeline.mark("processPaused", at: queuedAt - gap, detail: "\(Int(gap)) ms", once: false)
                }
            }
            DispatchQueue.main.async {
                let lag = Clock.nowMs() - queuedAt
                guard lag >= Self.stallThresholdMs, let self, self.conversation != nil, self.stallMarks < Self.maxStallMarks else { return }
                self.stallMarks += 1
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
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping @Sendable (UNNotificationPresentationOptions) -> Void) {
        let info = notification.request.content.userInfo
        guard let ring = Ring(userInfo: info) else {
            return completionHandler([.banner, .sound])
        }
        let receivedAt = Clock.nowMs()
        let isPrefetch = info["prefetch"] != nil
        let delivered = notification.date
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
            self.incomingRingDelivered = delivered
            self.preconnectRelay()
            WKInterfaceDevice.current().play(.notification)
            self.incomingRingTimer?.invalidate()
            self.incomingRingTimer = Timer.scheduledTimer(withTimeInterval: Self.inAppRingTimeout, repeats: false) { _ in
                MainActor.assumeIsolated {
                    guard self.incomingRing == ring else { return }
                    self.declineIncomingRing()
                    self.outcomes[ring.from] = OutcomeNote(outcome: .missed, at: Date())
                }
            }
        }
    }

    /// Tapping the ring notification answers it.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping @Sendable () -> Void) {
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
