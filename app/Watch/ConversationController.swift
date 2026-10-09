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
    /// A Talk the relay hasn't answered by then (granted, denied or refused) is given up, so an
    /// answer this build doesn't expect can't leave Talk waiting. Rings answer well within it.
    static let floorDecisionTimeout: TimeInterval = 15
    /// How long to keep trying to rejoin after the stream drops mid-conversation; the relay
    /// keeps a heard message 30 s after it ends for the resume.
    static let reconnectWindowMs: Double = 30_000
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
        /// The friend tapped End.
        case friendEnded

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
    @Published private(set) var securityMark = false
    @Published private(set) var securityNoticeVersion = 0
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
    /// The APNs token (nil without one), registered under the account whenever there's a
    /// session.
    private var pushToken: (token: String?, note: String?)?
    /// Whether notifications are allowed: a watch rung by alerts can't be rung without them.
    private var notifications: DeviceRegistration.Notifications = .unknown
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
        /// Receiving: the ring answered (v2), which the first join names.
        var ringId: String?
        let id = UUID()
    }

    /// Stamps when relay data arrives, off the main queue, for the timeline.
    private let relay = RelayConnection(stampsArrivals: true)
    // The watch's microphone arrives quiet and unleveled (build 140: speech peaking at −35 dBFS),
    // and its small speaker needs received speech louder (2026-10-02: held to the ear to hear).
    private let audio = AudioPipeline(autoGain: true, playbackGain: true)
    private lazy var e2ee = E2EEFlow(store: account.e2ee, trust: account.trust, deviceId: account.deviceId,
                                     userId: { [weak self] in self?.account.session?.userId })
    private var acceptingBurst = true

    private var started = false
    private var conversation: Conversation?
    private var talkHeld = false
    private var burstId: String?
    private var pendingFrames: [Data] = []
    private var pendingBurstId: String?
    private var burstFinished = false
    private var staleRetries = 0
    /// The friends list was fetched again after this press's keys looked missing.
    private var refetchedKeys = false
    private var awaitingFloor = false
    /// Counts talk-starts sent, so only the latest one's floor timeout acts.
    private var floorWaits = 0
    private var sentFirstFrame = false
    private var idleTimer: Timer?
    private var incomingRingTimer: Timer?
    private var activatingAudio = false
    /// Answering already retried on a fresh stream once.
    private var rejoinedOnFreshStream = false
    /// Reconnecting after the stream dropped mid-conversation: since when, and attempts so far.
    private var reconnecting: (since: Double, attempts: Int)?
    /// The next frame expected in the burst being heard, for resuming it after a drop.
    private var nextIncomingSeq: UInt32 = 0
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
    /// few quick /v2/time samples once the network is up (smallest round trip wins).
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
            guard acceptingBurst, let burst = incomingBurstId else { return }
            let opened: Data
            do {
                guard let decrypted = try e2ee.open(frame, burstId: burst, now: Int64(Clock.nowMs())) else { return }
                opened = decrypted
            } catch {
                Telemetry.shared.event("e2eeFailed", ["reason": "decrypt"])
                return
            }
            if let seq = VoiceFrame.decode(opened)?.seq {
                nextIncomingSeq = max(nextIncomingSeq, seq == UInt32.max ? seq : seq + 1)
            }
            if conversation?.timeline.has("firstFrameReceived") == false {
                conversation?.timeline.mark("firstFrameArrived", at: relay.lastArrivalMs)
                conversation?.timeline.mark("firstFrameReceived")
            }
            speakerIdle = false
            audio.enqueue(opened)
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
            reconnectAfterDrop()
        }
        relay.onRefused = { [unowned self] refusal in
            log("Relay refused: \(refusal.code)")
            conversation?.timeline.mark("relayRefused", detail: refusal.code, once: false)
            if refusal.requiresUpgrade {
                NotificationCenter.default.post(name: ServiceContract.upgradeRequiredNotification, object: nil)
            } else if refusal.endsSession {
                // The account API confirms it, and the watch signs out.
                account.refresh()
            }
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
        audio.playbackVolume = Self.storedPlaybackVolume
        audio.onBurstPlayed = { [weak self] level, frames, detail in
            // The system volume, the app's (the crown's) and the speaker, so "played quietly" can
            // be told from "volume turned down" or a Bluetooth route.
            let session = AVAudioSession.sharedInstance()
            let volume = String(format: "%.2f", session.outputVolume)
            let appVolume = String(format: "%.2f", Self.storedPlaybackVolume)
            self?.markLevel("burstLevelPlayed", level, frames: frames,
                            context: ",volume=\(volume),appVolume=\(appVolume),out=\(AudioLevel.outputPort())" + detail)
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
        account.onRefreshed = { [weak self] in self?.registerPushToken() }
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
                self.notifications = granted ? .authorized : .denied
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
    /// conversations; it can be rung only while its relay stream is open (a Talk screen).
    func didFailToRegisterForRemoteNotifications(_ error: Error) {
        log("Push registration failed: \(error.localizedDescription)")
        registerDevice(pushToken: nil, note: "rung only in the app (no push)")
    }

    /// `pushToken` nil: no push token, so only the open stream can ring it.
    private func registerDevice(pushToken: String?, note: String? = nil) {
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
        let delivery: DeviceRegistration.Delivery = token.map { .alert(token: $0, environment: AppSettings.apnsEnvironment) } ?? .foreground
        let keys: E2EEKeyStore.Registration
        do {
            // Registered only with keys (the service refuses a device without them). The iPhone
            // certifies this watch's key; its arrival registers again (onSessionChanged).
            guard let certified = try account.e2ee.registration(userId: account.session!.userId, deviceId: account.deviceId,
                                                                phone: false, now: Int64(Clock.nowMs())) else {
                registrationStatus = "Waiting for keys from your iPhone"
                return
            }
            keys = certified
        } catch {
            Telemetry.shared.event("e2eeFailed", ["reason": "key-storage"])
            return
        }
        let registration = DeviceRegistration(delivery: delivery, notifications: notifications, e2ee: keys)
        Task { @MainActor in
            do {
                try await account.registerDevice(registration)
                if let group = Prefetched.appGroup, let defaults = UserDefaults(suiteName: group) {
                    defaults.set(["token": token ?? "", "environment": AppSettings.apnsEnvironment,
                                  "notifications": notifications.rawValue], forKey: "e2eeWatchRegistration")
                    let last = defaults.string(forKey: "e2eeWatchEncCert")
                    let current = keys.encCert.base64EncodedString()
                    if last != nil && last != current { Telemetry.shared.event("keysRotated", [:]) }
                    defaults.set(current, forKey: "e2eeWatchEncCert")
                }
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
            burstFinished = true
            relay.send(["type": "talk-end", "burstId": id])
            if burstId == id { burstId = nil }
            resetIdleTimer()
        }
    }

    func answerIncomingRing() {
        guard let ring = incomingRing else { return }
        answer(ring, via: "in app", delivered: incomingRingDelivered)
    }

    /// The relay abandons an unanswered ring by itself. Decline tells it, so the ring doesn't
    /// roll over to the iPhone (`byPerson`; not when the ring just ran out here). The decline is
    /// uploaded as a short timeline, so the relay's summaries can tell it from a missed ring.
    func declineIncomingRing(byPerson: Bool = true) {
        let ring = incomingRing
        clearIncomingRing()
        closePreconnect()
        if let friendId = preparingFor { prepare(for: friendId) }
        guard let ring else { return }
        if byPerson { reportDecline(ring) }
        var timeline = Timeline(role: .receiver)
        if let sentAt = ring.pushSentAt { timeline.mark("pushSentAtServer", detail: String(Int(sentAt))) }
        timeline.mark("ringDeclined", detail: "in app")
        uploadTimeline(timeline, conversationId: ring.conversationId, clockOffsetMs: clockOffsetMs)
    }

    /// POST /v2/rings/decline, so a rollover (the recipient's Roll Over to iPhone) doesn't ring
    /// the iPhone. Fire and forget: if it doesn't arrive, the iPhone rings, as without it.
    private func reportDecline(_ ring: Ring) {
        guard let baseURL = settings.baseURL else { return }
        account.withToken { session in
            guard let session else { return }
            let api = RelayAPI(baseURL: baseURL, token: session.token)
            Task {
                var status = 200
                do { try await api.decline(ring) } catch { status = (error as? AccountAPIError)?.status ?? 0 }
                Telemetry.shared.event("declineReported", ["status": status, "failed": status == 0])
            }
        }
    }

    private func clearIncomingRing() {
        incomingRingTimer?.invalidate()
        incomingRing = nil
        incomingRingDelivered = nil
    }

    /// The End button: the friend's app ends the conversation too.
    func end() {
        finish(byPerson: true)
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
                                    peerId: ring.from, peerName: ring.fromName, timeline: timeline, ringId: ring.ringId)
        phase = .connecting
        peerName = ring.fromName
        peerId = ring.from
        outcomes[ring.from] = nil
        rejoinedOnFreshStream = false
        playPrefetched(ring)
        reportAnswer(ring)
        if preconnect != nil, relay.isReady || relay.isConnecting {
            joinOverPreconnectedStream(ring)
        } else {
            conversation?.timeline.mark("joinSent", detail: "with the stream")
            connectRelay(join: ring.conversationId, ring: ring.ringId)
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
    private func playPrefetched(_ ring: Ring) {
        guard let prefetched = Prefetched.take(ring: ring, userId: account.session?.userId) else { return }
        let meta = prefetched.meta
        if let t = meta["receivedAt"] as? Double { conversation?.timeline.mark("nseReceived", at: t) }
        // Which ring the files were downloaded for, and its deadline (they're keyed by the ring).
        if let t = meta["fetchStartedAt"] as? Double {
            let expires = (meta["expiresAt"] as? Double).map { ", expires \(Int($0))" } ?? ""
            conversation?.timeline.mark("nseFetchStarted", at: t, detail: "\(meta["ringId"] as? String ?? "no ring")\(expires)")
        }
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
            guard let conversationId = burst.start.conversationId else { continue }
            let startedAt = Clock.nowMs()
            do {
                _ = try e2ee.receive(burst.start, peer: ring.from, conversationId: conversationId, now: Int64(startedAt))
                securityMark = e2ee.changedSender
                if e2ee.justChanged {
                    securityNoticeVersion += 1
                    Telemetry.shared.event("keyChanged", ["friend": ring.from])
                }
                conversation?.timeline.mark("bundleOpened", detail: "prefetch \(Int(Clock.nowMs() - startedAt)) ms", once: false)
            } catch {
                Telemetry.shared.event("e2eeFailed", ["reason": (error as? E2EE.Failure)?.rawValue
                    ?? (error as? E2EEFlow.FlowError)?.rawValue ?? "bad-bundle"])
                continue
            }
            audio.beginPlayback()
            speakerIdle = false
            var played = 0
            for frame in burst.frames {
                do {
                    if let opened = try e2ee.open(frame, burstId: burst.burstId, now: Int64(Clock.nowMs())) {
                        audio.enqueue(opened)
                        played += 1
                    }
                } catch { Telemetry.shared.event("e2eeFailed", ["reason": "decrypt"]) }
            }
            prefetchedFrames[burst.burstId] = played
            if burst.ended { audio.endPlayback() }
        }
    }

    /// The held message, downloaded by the app when the prefetch push reached it directly
    /// (see willPresent). Saved like the extension's download, so answering plays it at once.
    private func prefetchInApp(_ ring: Ring, receivedAt: Double) {
        guard let baseURL = settings.baseURL else { return }
        account.withToken { session in
            guard let session,
                  let request = RelayAPI(baseURL: baseURL, token: session.token).audioRequest(for: ring) else { return }
            let startedAt = Clock.nowMs()
            URLSession.shared.dataTask(with: request) { data, response, error in
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                var meta: [String: Any] = ["receivedAt": receivedAt, "fetchStartedAt": startedAt, "fetchEndedAt": Clock.nowMs(),
                                           "userId": session.userId, "status": status, "inApp": true]
                if let sentAt = ring.pushSentAt { meta["pushSentAt"] = sentAt }
                if let error { meta["error"] = String(error.localizedDescription.prefix(80)) }
                if status == 200, let data { meta["bytes"] = data.count }
                Prefetched.save(ring: ring, records: status == 200 ? data : nil, meta: meta)
                Telemetry.shared.event("prefetchInApp", ["status": status, "bytes": data?.count ?? 0])
            }.resume()
        }
    }

    /// Tells the relay at once that the ring was answered, so it keeps the message for the
    /// join rather than dropping it when the ring's 35 s run out. The join itself can take
    /// that long after a tap that woke a frozen app (run 103: the stream took 14 s to open,
    /// and the rest of the message was gone by then). A separate request, so it doesn't
    /// wait behind the stream.
    /// It names the ring (v2): an expired ring, or one answered on the iPhone first, is
    /// refused, and the join that follows says so too.
    private func reportAnswer(_ ring: Ring) {
        guard let baseURL = settings.baseURL else { return }
        let conversationId = ring.conversationId
        account.withToken { [weak self] session in
            guard let session else { return }
            let api = RelayAPI(baseURL: baseURL, token: session.token)
            let sentAt = Clock.nowMs()
            Task { @MainActor [weak self] in
                var detail = "HTTP 200"
                do {
                    try await api.answer(ring)
                } catch let error as AccountAPIError {
                    detail = "HTTP \(error.status) \(error.code)"
                } catch {
                    detail = "error: \(error.localizedDescription.prefix(60))"
                }
                // A late tap's conversation has usually ended (the join was refused) before the
                // report comes back: it goes in as an event instead, so the 410 still shows.
                guard let self, self.conversation?.conversationId == conversationId else {
                    Telemetry.shared.event("answerReported", ["conversationId": conversationId, "ringId": ring.ringId, "result": detail,
                                                              "ms": Int(Clock.nowMs() - sentAt)])
                    return
                }
                self.conversation?.timeline.mark("answerReportSent", at: sentAt)
                self.conversation?.timeline.mark("answerReported", detail: detail)
            }
        }
    }

    /// Opens the relay stream without joining while an in-app ring is showing.
    private func preconnectRelay() {
        guard conversation == nil, preconnect == nil, let baseURL = settings.baseURL else { return }
        preconnect = (Clock.nowMs(), nil)
        account.withToken { [unowned self] session in
            guard let session, preconnect != nil, conversation == nil else { return }
            relay.connect(baseURL: baseURL, token: session.token)
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
    private func joinOverPreconnectedStream(_ ring: Ring) {
        let conversationId = ring.conversationId
        conversation?.timeline.mark("joinSent", detail: relay.isReady ? "over the open stream" : "queued on the opening stream")
        relay.send(["type": "join", "conversationId": conversationId, "ringId": ring.ringId])
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
        connectRelay(join: conversationId, ring: conversation?.ringId)
    }

    /// The stream dropped mid-conversation (run 106: the network went away for 20 s). Try for
    /// a while to rejoin on a fresh stream, resuming the message being heard from its first
    /// missed frame, before giving up.
    private func reconnectAfterDrop() {
        guard let current = conversation, let conversationId = current.conversationId else { return finish() }
        if talkHeld || burstId != nil {
            // The relay ended the burst when the stream went; what's said now wouldn't go out.
            audio.endCapture {}
            burstId = nil
            isTalking = false
            talkHeld = false
        }
        if reconnecting == nil { reconnecting = (Clock.nowMs(), 0) }
        phase = .connecting
        updateTalkReady()
        guard let drop = reconnecting, Clock.nowMs() - drop.since < Self.reconnectWindowMs else {
            log("Couldn't reconnect")
            conversation?.timeline.mark("reconnectGaveUp", detail: "\(reconnecting?.attempts ?? 0) attempts", once: false)
            reconnecting = nil
            WKInterfaceDevice.current().play(.failure)
            return finish(outcome: .couldNotConnect)
        }
        // At most 2 s apart, so it's back within about 2 s of the network (run 106's test:
        // with 4 and 8 s it waited 7 s after the network returned).
        let delays: [Double] = [0, 1, 2]
        let delay = delays[min(drop.attempts, delays.count - 1)]
        let id = current.id
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, conversation?.id == id, var attempt = reconnecting else { return }
            attempt.attempts += 1
            reconnecting = attempt
            let resume = incomingBurstId.flatMap { burst in
                incomingBurstEnded && speakerIdle ? nil : RelayResume(burstId: burst, fromSeq: nextIncomingSeq)
            }
            conversation?.timeline.mark("joinSent", detail: "reconnect \(attempt.attempts)" + (resume.map { ", resume from \($0.fromSeq)" } ?? ""), once: false)
            connectRelay(join: conversationId, resume: resume)
        }
    }

    /// The conversation's ring notifications, and the relay's "Missed message" that replaces an
    /// unanswered one (it has no ring ID, so it's matched by the conversation).
    private func removeDeliveredNotifications(for conversationId: String) {
        UNUserNotificationCenter.current().getDeliveredNotifications { notifications in
            let ids = notifications
                .filter { $0.request.content.userInfo["conversationId"] as? String == conversationId }
                .map(\.request.identifier)
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids)
        }
    }

    /// Ring notifications whose deadline has passed: the relay has dropped their message, so
    /// "Tap to listen" would only lead to Missed. Called when the app comes to the front (the
    /// relay also replaces them with "Missed message", but only once it reaches the watch).
    func removeExpiredRingNotifications() {
        let offset = clockOffsetMs
        UNUserNotificationCenter.current().getDeliveredNotifications { notifications in
            let ids = notifications
                .filter { Ring(userInfo: $0.request.content.userInfo)?.isExpired(clockOffsetMs: offset) == true }
                .map(\.request.identifier)
            guard !ids.isEmpty else { return }
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

    /// `ring`: the ring a first join answers. A rejoin after a drop names none.
    private func connectRelay(join: String? = nil, ring: String? = nil, resume: RelayResume? = nil) {
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
            relay.connect(baseURL: baseURL, token: session.token, join: join, ring: ring, resume: resume)
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
            guard awaitingFloor, message.burstId == pendingBurstId else { break }
            conversation?.conversationId = message.conversationId
            if message.burstId == pendingBurstId {
                awaitingFloor = false
                pendingFrames = []
                pendingBurstId = nil
            }
            conversation?.timeline.mark("floorGranted", detail: message.pushed == true ? "rang recipient" : "recipient live")
            if talkHeld { startBurstIfReady() }
        case "floor-denied":
            guard awaitingFloor, message.burstId == pendingBurstId else { break }
            // Your press was refused because they're talking (the mouth shows them talking).
            WKInterfaceDevice.current().play(.failure)
            audio.endCapture {}
            burstId = nil
            pendingFrames = []
            pendingBurstId = nil
            awaitingFloor = false
            e2ee.endSending()
        case "talk-refused":
            guard awaitingFloor, message.burstId == pendingBurstId else { break }
            if message.reason == "keys-stale", let keys = message.keys, retryWithKeys(keys) { break }
            if message.reason == "conversation-changed", retryInConversation(message.conversationId) { break }
            // No longer friends (removed or blocked): nobody was rung.
            WKInterfaceDevice.current().play(.failure)
            audio.endCapture {}
            burstId = nil
            finish(outcome: .unreachable)
            account.refresh()
        case "joined":
            conversation?.timeline.mark("joinedArrived", at: relay.lastArrivalMs)
            conversation?.joined = true
            conversation?.timeline.mark("joined", detail: "\(message.replayBursts ?? 0) buffered bursts", once: false)
            phase = .live
            if let drop = reconnecting {
                reconnecting = nil
                conversation?.timeline.mark("rejoinedAfterDrop", detail: "attempt \(drop.attempts), \(Int(Clock.nowMs() - drop.since)) ms, resumed \(message.resumedFrames ?? 0) frames", once: false)
            }
            if message.replayBursts ?? 0 == 0, !prefetchedFrames.isEmpty, incomingBurstId == nil, remoteTalking {
                // The downloaded start of a message, and the relay has nothing more: it dropped
                // the rest when the ring timed out. Play what's here, then stop listening
                // (run 103: the mouth stayed on "listening" until End).
                conversation?.timeline.mark("prefetchedRestLost")
                incomingBurstEnded = true
                e2ee.endReceiving()
                securityMark = false
                audio.endPlayback()
                friendStoppedTalkingIfDone()
                resetIdleTimer()
            }
        case "burst-start":
            guard let peer = conversation?.peerId, let conversationId = message.conversationId else { return }
            let openedAt = Clock.nowMs()
            do {
                acceptingBurst = try e2ee.receive(message, peer: peer, conversationId: conversationId, now: Int64(openedAt))
                securityMark = e2ee.changedSender
                if e2ee.justChanged {
                    securityNoticeVersion += 1
                    Telemetry.shared.event("keyChanged", ["friend": peer])
                }
                conversation?.timeline.mark("bundleOpened", detail: "\(Int(Clock.nowMs() - openedAt)) ms", once: false)
            } catch {
                acceptingBurst = false
                Telemetry.shared.event("e2eeFailed", ["reason": (error as? E2EE.Failure)?.rawValue
                    ?? (error as? E2EEFlow.FlowError)?.rawValue ?? "bad-bundle"])
                return
            }
            let resumed = message.resumed == true && message.burstId == incomingBurstId
            if !resumed { nextIncomingSeq = 0 }
            incomingBurstId = message.burstId
            let prefetched = message.burstId.flatMap { prefetchedFrames[$0] }
            conversation?.timeline.mark("burstStartReceived",
                                        detail: (resumed ? "resumed" : message.replay == true ? "replay" : "live") + (prefetched.map { ", \($0) frames prefetched" } ?? ""),
                                        once: false)
            remoteTalking = true
            incomingBurstEnded = false
            if let id = conversation?.peerId { outcomes[id] = nil }
            idleTimer?.invalidate()
            // A prefetched or resumed burst is already playing; resetting the decoder would glitch it.
            if prefetched == nil, !resumed { audio.beginPlayback() }
        case "burst-end":
            guard message.burstId == incomingBurstId else { break }
            e2ee.endReceiving()
            securityMark = false
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
            log("\(name) left (\(message.reason ?? "no reason"))")
            // They tapped End ("ended"): it ends here too (Steve and Helen, build 220). Their app
            // leaving by itself ("left") or a dropped stream ("disconnected") keeps it: a new
            // Talk rings them again, or they resume.
            guard message.reason == "ended", message.conversationId == conversation?.conversationId else { return }
            WKInterfaceDevice.current().play(.stop)
            audio.endCapture {}
            burstId = nil
            finish(outcome: .friendEnded)
        case "ring-timeout":
            // The relay dropped what they didn't hear; the next Talk rings them again.
            WKInterfaceDevice.current().play(.failure)
            if let id = conversation?.peerId { outcomes[id] = OutcomeNote(outcome: .didNotAnswer, at: Date()) }
            conversation?.timeline.mark("ringTimedOut", detail: "\(message.droppedBursts ?? 0) bursts dropped")
        case "session-ended":
            // Signed out on the iPhone, or the account was deleted: the API confirms it.
            finish()
            account.refresh()
        case "error":
            log("Relay error: \(message.code ?? message.message ?? "unknown")")
            let receiving = conversation?.outgoing == false && conversation?.joined == false
            if receiving, let code = message.code { conversation?.timeline.mark("joinRefused", detail: code) }
            switch message.code {
            case "ring-expired" where receiving, "unknown-conversation" where receiving:
                // Answered after the relay gave up on the ring (or a newer one replaced it): the
                // message is gone, and nothing downloaded for it plays.
                audio.discardPlayback()
                WKInterfaceDevice.current().play(.failure)
                finish(outcome: .missed)
            case "ring-answered-elsewhere" where receiving:
                finish(outcome: .continuedOnPhone)
            case "unknown-conversation" where reconnecting != nil:
                // Back after a drop, but the relay has ended the conversation meanwhile.
                reconnecting = nil
                WKInterfaceDevice.current().play(.failure)
                finish(outcome: .couldNotConnect)
            default:
                break
            }
        default:
            break
        }
    }

    // MARK: Talking

    /// Doesn't wait for the relay stream: talk-start and the frames queue until it opens.
    private func startBurstIfReady() {
        guard talkHeld, burstId == nil, !awaitingFloor, let current = conversation, current.audioActive else { return }
        let id = UUID().uuidString
        burstId = id
        pendingFrames = []
        pendingBurstId = id
        burstFinished = false
        staleRetries = 0
        awaitingFloor = true
        sentFirstFrame = false
        postsThisBurst = 0
        do {
            let startedAt = Clock.nowMs()
            let fresh = account.friends.first { $0.id == current.peerId }?.keys
            let sealed = try e2ee.start(peer: current.peerId, conversationId: current.conversationId,
                                        burstId: id, codec: audio.codecName, keys: fresh, now: Int64(startedAt))
            conversation?.conversationId = sealed.conversationId
            relay.send(sealed.control)
            awaitFloorDecision()
            conversation?.timeline.mark("bundleSealed", detail: "\(Int(Clock.nowMs() - startedAt)) ms", once: false)
            refetchedKeys = false
        } catch {
            burstId = nil
            // The friends list can predate the friend's new keys (a sign-in, a watch given its
            // keys): fetch it once and try again before giving up.
            if error as? E2EEFlow.FlowError == .noCurrentKey, !refetchedKeys {
                refetchedKeys = true
                pendingBurstId = nil
                awaitingFloor = false
                e2ee.endSending()
                conversation?.timeline.mark("keysRefetched", once: false)
                Task {
                    await account.refreshFriends()
                    startBurstIfReady()
                }
                return
            }
            refetchedKeys = false
            Telemetry.shared.event("e2eeFailed", ["reason": (error as? E2EEFlow.FlowError)?.rawValue ?? "seal"])
            finish(outcome: .unreachable)
            return
        }
        conversation?.timeline.mark("captureStarted", once: false)
        audio.beginCapture()
        // Signal "go ahead" only once the mic is live: anything said before this isn't captured.
        WKInterfaceDevice.current().play(.start)
    }

    private func sendCaptured(_ frame: Data) {
        guard burstId != nil else { return }
        if awaitingFloor { pendingFrames.append(frame) }
        do { relay.send(frame: try e2ee.send(frame)) }
        catch { Telemetry.shared.event("e2eeFailed", ["reason": "encrypt"]); return }
        if !sentFirstFrame {
            sentFirstFrame = true
            conversation?.timeline.mark(relay.isReady ? "firstFrameSent" : "firstFrameQueued")
        }
    }

    private func retryWithKeys(_ keys: FriendKeys) -> Bool {
        guard awaitingFloor, staleRetries < 2, let current = conversation,
              let userId = account.session?.userId else { return false }
        staleRetries += 1
        _ = account.trust.update(account: userId, friend: current.peerId, keys: keys, now: Int64(Clock.nowMs()))
        guard resendPendingBurst(keys: keys) else {
            Telemetry.shared.event("e2eeFailed", ["reason": "stale-key"])
            return false
        }
        // The next press seals to the current keys instead of being refused again.
        Task { await account.refreshFriends() }
        return true
    }

    /// The relay has this friend's conversation under another ID (the iPhone is in it, or the
    /// app started again inside it), or none for an ID it can't use: the same burst is sealed
    /// again for that conversation, or a new one. The signature covers the ID, so the relay can
    /// only name it.
    private func retryInConversation(_ id: String?) -> Bool {
        guard awaitingFloor, staleRetries < 2, let current = conversation else { return false }
        staleRetries += 1
        conversation?.conversationId = id
        conversation?.timeline.mark("conversationChanged", once: false)
        return resendPendingBurst(keys: account.friends.first { $0.id == current.peerId }?.keys)
    }

    /// Seals the waiting burst again (same burst ID) and sends it with the frames captured so far.
    private func resendPendingBurst(keys: FriendKeys?) -> Bool {
        guard let current = conversation, let id = pendingBurstId else { return false }
        do {
            let sealed = try e2ee.start(peer: current.peerId, conversationId: current.conversationId,
                                        burstId: id, codec: audio.codecName, keys: keys, now: Int64(Clock.nowMs()))
            if !burstFinished { burstId = id }
            conversation?.conversationId = sealed.conversationId
            relay.send(sealed.control)
            awaitFloorDecision()
            for frame in pendingFrames { relay.send(frame: try e2ee.send(frame)) }
            if burstFinished { relay.send(["type": "talk-end", "burstId": id]) }
            return true
        } catch {
            return false
        }
    }

    /// Gives up on a talk-start the relay never answers.
    private func awaitFloorDecision() {
        floorWaits += 1
        let wait = floorWaits
        Timer.scheduledTimer(withTimeInterval: Self.floorDecisionTimeout, repeats: false) { [weak self] _ in
            guard let self else { return }
            MainActor.assumeIsolated {
                guard awaitingFloor, floorWaits == wait, conversation != nil else { return }
                conversation?.timeline.mark("floorTimedOut", once: false)
                Telemetry.shared.event("floorTimedOut", [:])
                WKInterfaceDevice.current().play(.failure)
                audio.endCapture {}
                burstId = nil
                finish(outcome: .unreachable)
            }
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

    /// How loud friends' messages play, 0–1, set with the crown on a Talk screen (CrownVolume).
    /// On top of the watch's own volume: 1 is as loud as that allows.
    static let playbackVolumeKey = "playbackVolume"
    static var storedPlaybackVolume: Float {
        UserDefaults.standard.object(forKey: playbackVolumeKey) as? Float ?? 1
    }

    func setPlaybackVolume(_ volume: Float) {
        UserDefaults.standard.set(volume, forKey: Self.playbackVolumeKey)
        audio.playbackVolume = volume
    }

    private func activateOwnAudio() {
        guard conversation != nil, conversation?.audioActive == false, !activatingAudio else { return }
        activatingAudio = true
        let session = AVAudioSession.sharedInstance()
        do {
            // Mode default, not voiceChat: voice chat's call processing played messages so
            // quietly the watch had to be held to the ear (2026-10-02). Talk is half duplex, so
            // its echo cancellation isn't needed.
            try session.setCategory(.playAndRecord, mode: .default, options: [])
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
    /// `byPerson`: the End button. Only then does the leave say "end", which ends the friend's
    /// side too; an idle timeout or a move to the iPhone leaves without it.
    private func finish(outcome: Outcome? = nil, byPerson: Bool = false) {
        guard var ended = conversation else { return }
        if let outcome { outcomes[ended.peerId] = OutcomeNote(outcome: outcome, at: Date()) }
        if let conversationId = ended.conversationId {
            var leave: [String: Any] = ["type": "leave", "conversationId": conversationId]
            if byPerson { leave["reason"] = "end" }
            relay.send(leave)
        }
        let offset = clockOffsetMs
        relay.close()
        audio.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        ended.timeline.mark("callEnded")

        conversation = nil
        preconnect = nil
        prefetchedFrames = [:]
        reconnecting = nil
        nextIncomingSeq = 0
        incomingBurstId = nil
        e2ee.endReceiving()
        e2ee.endSending()
        pendingFrames = []
        pendingBurstId = nil
        awaitingFloor = false
        incomingBurstEnded = false
        speakerIdle = true
        talkReady = false
        talkHeld = false
        isTalking = false
        remoteTalking = false
        securityMark = false
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

    /// The crown on a Talk screen (diagnostics for Helen's Series 9, where it never reached the
    /// app): a mark in the conversation's timeline while there is one.
    func markCrown(_ name: String, detail: String) {
        conversation?.timeline.mark(name, detail: detail, once: false)
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
                    self.declineIncomingRing(byPerson: false)
                    self.outcomes[ring.from] = OutcomeNote(outcome: .missed, at: Date())
                }
            }
            #if DEBUG && targetEnvironment(simulator)
            // The simulator tools' taps don't reach watchOS 10.2: OAO_DEV_AUTO_ANSWER=<seconds>
            // answers an in-app ring after that long, to show the Talk screen in a conversation.
            if let delay = ProcessInfo.processInfo.environment["OAO_DEV_AUTO_ANSWER"].flatMap(Double.init) {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                    if self.incomingRing == ring { self.answerIncomingRing() }
                }
            }
            #endif
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
