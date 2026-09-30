import AVFoundation
import OverAndOutKit
import PushToTalk
import UIKit
import UserNotifications

/// The iPhone's one PushToTalk channel, "Over&Out" (design decision 2026-09-27). Being in the
/// channel is being available: the relay rings this iPhone with a PushToTalk push, the system
/// wakes the app and activates its audio, and the message plays with no tap. The channel's
/// descriptor names the friend of the current conversation, so the system's Talk button (on
/// the Lock Screen and in the Dynamic Island) talks to them.
///
/// PushToTalk isn't available in the simulator (PTChannelManager fails with InvalidPlatform),
/// nor without the Push to Talk entitlement (OAO_PUSH=no builds); `isAvailable` is false then,
/// and the iPhone rings only in the app, while it's on screen.
///
/// Whether the person wants walkie-talkie on (`wanted`) is kept apart from being in the
/// channel (design decision 2026-09-29): the system's Leave button, beside Talk on the Lock
/// Screen and in the Dynamic Island, leaves the channel, and reads like "end this
/// conversation". Only Settings (or signing out) turns walkie-talkie off; anything else that
/// leaves the channel posts a notice, and opening the app joins again.
@MainActor
final class PushToTalkChannel: NSObject, ObservableObject {
    /// Events for the conversation controller, delivered on the main actor.
    enum Event {
        /// A friend's message: the push that rang this iPhone (the audio session follows).
        case ring(Ring, receivedAt: Double)
        case transmitStarted(fromSystemUI: Bool)
        case transmitEnded
        case transmitFailed(String)
        case audioActivated
        case audioDeactivated
        /// The channel was left; `byApp` when the app asked (Settings, signing out).
        case left(reason: Int, byApp: Bool)
    }

    @Published private(set) var isAvailable = false
    @Published private(set) var isJoined = false
    /// The channel's push token (hex). It works only while joined, but it outlives leaving and
    /// rejoining, and iOS doesn't send it again then, so it's kept (in defaults, across launches).
    @Published private(set) var pushToken: String? = UserDefaults.standard.string(forKey: PushToTalkChannel.tokenKey)
    @Published private(set) var lastError: String?
    /// The person wants walkie-talkie on: set by turning it on, cleared only by turning it off
    /// in Settings or signing out. Nil on installs from before build 2 until the channel is
    /// found joined (then true).
    @Published private(set) var wanted: Bool? = UserDefaults.standard.object(forKey: PushToTalkChannel.wantedKey) as? Bool {
        didSet { UserDefaults.standard.set(wanted, forKey: Self.wantedKey) }
    }

    var onEvent: ((Event) -> Void)?
    /// Called when the push token or the joined state changes, to register with the API.
    var onRegistrationChange: (() -> Void)?
    /// The channel was left though the person wants walkie-talkie on (the system's Leave
    /// button, or the system itself), with the PTChannelLeaveReason.
    var onLeftUnexpectedly: ((Int) -> Void)?

    private var manager: PTChannelManager?
    private let channelUUID: UUID
    private nonisolated static let channelKey = "pushToTalkChannel"
    private nonisolated static let tokenKey = "pushToTalkToken"
    private nonisolated static let friendIdKey = "pushToTalkFriendId"
    private nonisolated static let friendNameKey = "pushToTalkFriendName"
    private nonisolated static let wantedKey = "walkieTalkieWanted"
    /// Set just before the app leaves, so the delegate can tell its own leave from the system's.
    private var leavingByApp = false
    /// A rejoin after an unexpected leave is under way; its join shows "back on".
    private var rejoining = false
    /// When the app turned walkie-talkie back on by itself, for a brief confirmation (run 58:
    /// without one, Friends and Settings looked as if nothing had happened).
    @Published private(set) var rejoinedAt: Date?

    override init() {
        let defaults = UserDefaults.standard
        if let saved = defaults.string(forKey: Self.channelKey).flatMap(UUID.init(uuidString:)) {
            channelUUID = saved
        } else {
            channelUUID = UUID()
            defaults.set(channelUUID.uuidString, forKey: Self.channelKey)
        }
        super.init()
    }

    /// The friend the system's Talk button talks to: the current or last conversation's.
    var channelFriend: (id: String, name: String)? {
        let defaults = UserDefaults.standard
        guard let id = defaults.string(forKey: Self.friendIdKey), let name = defaults.string(forKey: Self.friendNameKey) else { return nil }
        return (id, name)
    }

    /// Early at launch: the system restores the channel, and delivers pushes, only once the
    /// manager exists.
    func start() {
        guard manager == nil else { return }
        PTChannelManager.channelManager(delegate: self, restorationDelegate: self) { manager, error in
            Task { @MainActor in
                TalkController.logger.notice("Channel manager: \(manager == nil ? "failed \(String(describing: error))" : "ready, active channel \(String(describing: manager?.activeChannelUUID))", privacy: .public)")
                if let manager {
                    self.manager = manager
                    self.isAvailable = true
                    self.isJoined = manager.activeChannelUUID == self.channelUUID
                    // Whether the channel survived since the last launch (an update, a reinstall).
                    Telemetry.shared.event("pttRestored", ["joined": self.isJoined, "wanted": self.wanted.map { $0 ? "yes" : "no" } ?? "unknown"])
                    // Installs from before `wanted` existed: in the channel means wanted.
                    if self.isJoined, self.wanted == nil { self.wanted = true }
                    self.rejoinIfWanted()
                } else {
                    self.isAvailable = false
                    self.lastError = error.map { "PushToTalk unavailable (\(($0 as NSError).code))" }
                    #if DEBUG
                    // The simulator has no PushToTalk: OAO_PREVIEW_LEFT_CHANNEL=1 shows the
                    // Friends row, and 5 s later the notice, as after the system's Leave button.
                    if ProcessInfo.processInfo.environment["OAO_PREVIEW_LEFT_CHANNEL"] == "1" {
                        self.isAvailable = true
                        self.wanted = true
                        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { self.onLeftUnexpectedly?(1) }
                    }
                    // OAO_PREVIEW_REJOINED=1: the "Walkie-talkie is back on" banner, 2 s after launch.
                    if ProcessInfo.processInfo.environment["OAO_PREVIEW_REJOINED"] == "1" {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.rejoinedAt = Date() }
                    }
                    #endif
                }
                self.onRegistrationChange?()
            }
        }
    }

    /// Turns walkie-talkie on: from a tap while the app is on screen.
    func join() {
        wanted = true
        requestJoin()
        Self.requestNotificationPermission()
    }

    /// Turns walkie-talkie off (Settings, signing out): no notice, no rejoining.
    func turnOff() {
        wanted = false
        guard isJoined else { return }
        leavingByApp = true
        manager?.leaveChannel(channelUUID: channelUUID)
    }

    /// When the app comes on screen (joining needs the foreground): back into the channel if
    /// it was left by the system's Leave button, the system, or an update.
    func rejoinIfWanted() {
        guard wanted == true, !isJoined, manager != nil,
              UIApplication.shared.applicationState == .active else { return }
        TalkController.logger.notice("Rejoining the channel (walkie-talkie is wanted on)")
        Telemetry.shared.event("pttRejoin")
        rejoining = true
        requestJoin()
    }

    private func requestJoin() {
        guard let manager else { return }
        manager.requestJoinChannel(channelUUID: channelUUID, descriptor: descriptor(friendName: channelFriend?.name))
    }

    /// The conversation's friend, shown by the system and talked to by its Talk button.
    func setFriend(id: String, name: String) {
        let defaults = UserDefaults.standard
        guard defaults.string(forKey: Self.friendIdKey) != id || defaults.string(forKey: Self.friendNameKey) != name else { return }
        defaults.set(id, forKey: Self.friendIdKey)
        defaults.set(name, forKey: Self.friendNameKey)
        guard isJoined else { return }
        manager?.setChannelDescriptor(descriptor(friendName: name), channelUUID: channelUUID, completionHandler: nil)
    }

    func beginTransmitting() {
        manager?.requestBeginTransmitting(channelUUID: channelUUID)
    }

    func stopTransmitting() {
        manager?.stopTransmitting(channelUUID: channelUUID)
    }

    /// Who's talking to us; the system activates the audio session for them. Nil when they've
    /// finished, so the system can deactivate it and the person can talk.
    func setRemoteSpeaker(_ name: String?) {
        guard let manager, isJoined else { return }
        let participant = name.map { PTParticipant(name: $0, image: nil) }
        manager.setActiveRemoteParticipant(participant, channelUUID: channelUUID) { error in
            guard let error else { return }
            Task { @MainActor in self.lastError = "Speaker: \(error.localizedDescription)" }
        }
    }

    func setServiceStatus(_ status: PTServiceStatus) {
        guard isJoined else { return }
        manager?.setServiceStatus(status, channelUUID: channelUUID, completionHandler: nil)
    }

    private func descriptor(friendName: String?) -> PTChannelDescriptor {
        PTChannelDescriptor(name: friendName ?? "Over&Out", image: UIImage(named: "OverAndOutMascot"))
    }

    private func emit(_ event: Event) {
        onEvent?(event)
    }
}

extension PushToTalkChannel: PTChannelManagerDelegate {
    nonisolated func channelManager(_ channelManager: PTChannelManager, didJoinChannel channelUUID: UUID, reason: PTChannelJoinReason) {
        TalkController.logger.notice("Joined the channel, reason \(reason.rawValue)")
        Telemetry.shared.event("pttJoined", ["reason": reason.rawValue])
        Task { @MainActor in
            self.isJoined = true
            self.lastError = nil
            if self.rejoining {
                self.rejoining = false
                self.rejoinedAt = Date()
            }
            WalkieTalkieOffNotice.clear()
            self.onRegistrationChange?()
        }
    }

    nonisolated func channelManager(_ channelManager: PTChannelManager, didLeaveChannel channelUUID: UUID, reason: PTChannelLeaveReason) {
        TalkController.logger.notice("Left the channel, reason \(reason.rawValue)")
        Task { @MainActor in
            // The app's own leave comes back as developerRequest; anything else (1 = the
            // system's Leave button) wasn't the person turning walkie-talkie off in Settings.
            let byApp = self.leavingByApp || reason == .developerRequest
            self.leavingByApp = false
            self.isJoined = false
            // 1 = the person (the system's Leave button), 2 = the app, 3 = the session ended.
            Telemetry.shared.event("pttLeft", ["reason": reason.rawValue, "byApp": byApp, "wanted": self.wanted == true])
            self.emit(.left(reason: reason.rawValue, byApp: byApp))
            if !byApp, self.wanted == true { self.onLeftUnexpectedly?(reason.rawValue) }
            self.onRegistrationChange?()
        }
    }

    nonisolated func channelManager(_ channelManager: PTChannelManager, failedToJoinChannel channelUUID: UUID, error: Error) {
        Telemetry.shared.event("pttJoinFailed", ["code": (error as NSError).code])
        Task { @MainActor in self.rejoining = false }
        Task { @MainActor in self.lastError = "Couldn't turn on walkie-talkie (\((error as NSError).code))" }
    }

    nonisolated func channelManager(_ channelManager: PTChannelManager, receivedEphemeralPushToken pushToken: Data) {
        let hex = pushToken.map { String(format: "%02x", $0) }.joined()
        TalkController.logger.notice("PushToTalk token received (\(pushToken.count) bytes)")
        Task { @MainActor in
            UserDefaults.standard.set(hex, forKey: Self.tokenKey)
            self.pushToken = hex
            self.onRegistrationChange?()
        }
    }

    /// A friend is talking. Must return at once: the conversation is set up on the main actor.
    nonisolated func incomingPushResult(channelManager: PTChannelManager, channelUUID: UUID, pushPayload: [String: Any]) -> PTPushResult {
        let receivedAt = Clock.nowMs()
        TalkController.logger.notice("PushToTalk push received: \(pushPayload.keys.sorted().joined(separator: ","), privacy: .public)")
        guard let ring = Ring(userInfo: pushPayload) else {
            TalkController.logger.error("PushToTalk push without a ring; leaving the channel")
            return .leaveChannel
        }
        Task { @MainActor in
            // A push launching the app can arrive before the manager's own callback: a push
            // means we're in the channel.
            if self.manager == nil { self.manager = channelManager }
            self.isAvailable = true
            self.isJoined = true
            self.emit(.ring(ring, receivedAt: receivedAt))
        }
        return .activeRemoteParticipant(PTParticipant(name: ring.fromName, image: nil))
    }

    nonisolated func channelManager(_ channelManager: PTChannelManager, channelUUID: UUID, didBeginTransmittingFrom source: PTChannelTransmitRequestSource) {
        let fromSystemUI = source != .developerRequest
        Task { @MainActor in self.emit(.transmitStarted(fromSystemUI: fromSystemUI)) }
    }

    nonisolated func channelManager(_ channelManager: PTChannelManager, channelUUID: UUID, didEndTransmittingFrom source: PTChannelTransmitRequestSource) {
        Task { @MainActor in self.emit(.transmitEnded) }
    }

    nonisolated func channelManager(_ channelManager: PTChannelManager, failedToBeginTransmittingInChannel channelUUID: UUID, error: Error) {
        Task { @MainActor in self.emit(.transmitFailed("Couldn't talk (\((error as NSError).code))")) }
    }

    nonisolated func channelManager(_ channelManager: PTChannelManager, failedToStopTransmittingInChannel channelUUID: UUID, error: Error) {}

    nonisolated func channelManager(_ channelManager: PTChannelManager, didActivate audioSession: AVAudioSession) {
        Task { @MainActor in self.emit(.audioActivated) }
    }

    nonisolated func channelManager(_ channelManager: PTChannelManager, didDeactivate audioSession: AVAudioSession) {
        Task { @MainActor in self.emit(.audioDeactivated) }
    }
}

extension PushToTalkChannel: PTChannelRestorationDelegate {
    /// Returns at once, from what's cached (no network).
    nonisolated func channelDescriptor(restoredChannelUUID channelUUID: UUID) -> PTChannelDescriptor {
        let name = UserDefaults.standard.string(forKey: Self.friendNameKey) ?? "Over&Out"
        return PTChannelDescriptor(name: name, image: UIImage(named: "OverAndOutMascot"))
    }
}

extension PushToTalkChannel {
    /// Asked when walkie-talkie is turned on, so the app can say if it's turned off.
    static func requestNotificationPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            TalkController.logger.notice("Notifications \(granted ? "allowed" : "not allowed")")
        }
    }
}

/// "Walkie-talkie is off": posted when the channel is left though the person wants it on
/// (run 54: the system's Leave button). Tapping it opens the app, which joins again.
enum WalkieTalkieOffNotice {
    static let identifier = "walkie-talkie-off"

    static func post(ringsWatch: Bool) {
        let content = UNMutableNotificationContent()
        // iOS mirrors a locked iPhone's notifications to the watch, so the words say which device
        // (run 58).
        content.title = "iPhone walkie-talkie is off"
        content.body = ringsWatch
            ? "Friends' messages ring your Apple Watch instead. Open Over&Out on your iPhone to turn it back on."
            : "Friends' messages won't play on your iPhone. Open Over&Out to turn it back on."
        content.sound = .default
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if let error { TalkController.logger.error("Walkie-talkie off notice failed: \(error.localizedDescription, privacy: .public)") }
        }
    }

    static func clear() {
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: [identifier])
        center.removePendingNotificationRequests(withIdentifiers: [identifier])
    }
}
