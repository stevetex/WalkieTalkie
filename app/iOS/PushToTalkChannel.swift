import AVFoundation
import OverAndOutKit
import PushToTalk
import UIKit

/// The iPhone's one PushToTalk channel, "Over&Out" (design decision 2026-09-27). Being in the
/// channel is being available: the relay rings this iPhone with a PushToTalk push, the system
/// wakes the app and activates its audio, and the message plays with no tap. The channel's
/// descriptor names the friend of the current conversation, so the system's Talk button (on
/// the Lock Screen and in the Dynamic Island) talks to them.
///
/// PushToTalk isn't available in the simulator (PTChannelManager fails with InvalidPlatform),
/// nor without the Push to Talk entitlement (OAO_PUSH=no builds); `isAvailable` is false then,
/// and the iPhone rings only in the app, while it's on screen.
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
    }

    @Published private(set) var isAvailable = false
    @Published private(set) var isJoined = false
    /// The channel's push token (hex). Valid only while joined.
    @Published private(set) var pushToken: String?
    @Published private(set) var lastError: String?

    var onEvent: ((Event) -> Void)?
    /// Called when the push token or the joined state changes, to register with the API.
    var onRegistrationChange: (() -> Void)?

    private var manager: PTChannelManager?
    private let channelUUID: UUID
    private static let channelKey = "pushToTalkChannel"
    private static let friendIdKey = "pushToTalkFriendId"
    private static let friendNameKey = "pushToTalkFriendName"

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
                if let manager {
                    self.manager = manager
                    self.isAvailable = true
                    self.isJoined = manager.activeChannelUUID == self.channelUUID
                } else {
                    self.isAvailable = false
                    self.lastError = error.map { "PushToTalk unavailable (\(($0 as NSError).code))" }
                }
                self.onRegistrationChange?()
            }
        }
    }

    /// Must come from a tap while the app is on screen.
    func join() {
        guard let manager else { return }
        manager.requestJoinChannel(channelUUID: channelUUID, descriptor: descriptor(friendName: channelFriend?.name))
    }

    func leave() {
        manager?.leaveChannel(channelUUID: channelUUID)
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
        Task { @MainActor in
            self.isJoined = true
            self.lastError = nil
            self.onRegistrationChange?()
        }
    }

    nonisolated func channelManager(_ channelManager: PTChannelManager, didLeaveChannel channelUUID: UUID, reason: PTChannelLeaveReason) {
        Task { @MainActor in
            self.isJoined = false
            self.pushToken = nil
            self.onRegistrationChange?()
        }
    }

    nonisolated func channelManager(_ channelManager: PTChannelManager, failedToJoinChannel channelUUID: UUID, error: Error) {
        Task { @MainActor in self.lastError = "Couldn't turn on walkie-talkie (\((error as NSError).code))" }
    }

    nonisolated func channelManager(_ channelManager: PTChannelManager, receivedEphemeralPushToken pushToken: Data) {
        let hex = pushToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in
            self.pushToken = hex
            self.onRegistrationChange?()
        }
    }

    /// A friend is talking. Must return at once: the conversation is set up on the main actor.
    nonisolated func incomingPushResult(channelManager: PTChannelManager, channelUUID: UUID, pushPayload: [String: Any]) -> PTPushResult {
        let receivedAt = Clock.nowMs()
        guard let ring = Ring(userInfo: pushPayload) else { return .leaveChannel }
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
