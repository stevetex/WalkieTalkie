import Foundation

/// A ring: someone started talking and the relay is holding their message for us. It arrives
/// as the ring envelope (contracts/README.md, "Rings"): custom keys in the ring notification, a
/// PushToTalk push's payload, or a "ring" message over an open relay stream. Each ring has its
/// own ID and deadline; answering names the ring, so a late tap can't hear a newer one.
public struct Ring: Equatable, Sendable {
    public let conversationId: String
    public let from: String
    public let fromName: String
    public let burstId: String?
    /// When the relay sent the push (server clock, ms since epoch).
    public let pushSentAt: Double?
    /// The ring's ID ("r_…"): answering, joining and downloading its message name it.
    public let ringId: String
    /// When the relay abandons it unanswered (server clock, ms since epoch).
    public let expiresAt: Double?

    public init(conversationId: String, from: String, fromName: String, ringId: String, burstId: String? = nil,
                pushSentAt: Double? = nil, expiresAt: Double? = nil) {
        self.conversationId = conversationId
        self.from = from
        self.fromName = fromName
        self.burstId = burstId
        self.pushSentAt = pushSentAt
        self.ringId = ringId
        self.expiresAt = expiresAt
    }

    /// Reads a ring from a notification's `userInfo` or a push's payload; nil if it isn't one.
    /// Fields a later envelope adds are ignored.
    public init?(userInfo: [AnyHashable: Any]) {
        guard let conversationId = userInfo["conversationId"] as? String, !conversationId.isEmpty,
              let from = userInfo["from"] as? String, !from.isEmpty,
              let ringId = userInfo["ringId"] as? String, Self.isRingId(ringId) else { return nil }
        self.init(
            conversationId: conversationId,
            from: from,
            fromName: (userInfo["fromName"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? from,
            ringId: ringId,
            burstId: userInfo["burstId"] as? String,
            pushSentAt: (userInfo["pushSentAt"] as? NSNumber)?.doubleValue,
            expiresAt: (userInfo["expiresAt"] as? NSNumber)?.doubleValue
        )
    }

    /// A "ring" message over the relay stream (an app on screen).
    public init?(message: RelayMessage) {
        guard message.type == "ring", let conversationId = message.conversationId, let from = message.from,
              let ringId = message.ringId, Self.isRingId(ringId) else { return nil }
        self.init(conversationId: conversationId, from: from, fromName: message.fromName ?? from, ringId: ringId,
                  burstId: message.burstId, pushSentAt: message.pushSentAt, expiresAt: message.expiresAt)
    }

    static func isRingId(_ value: String) -> Bool { value.hasPrefix("r_") && value.count > 2 }

    /// The ring's deadline has passed, by this device's clock corrected by `clockOffsetMs`
    /// (server minus device). Only for showing it as expired early: the relay decides.
    public func isExpired(nowMs: Double = Clock.nowMs(), clockOffsetMs: Double = 0) -> Bool {
        guard let expiresAt else { return false }
        return nowMs + clockOffsetMs >= expiresAt
    }
}
