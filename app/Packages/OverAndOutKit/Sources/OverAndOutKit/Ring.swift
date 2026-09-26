import Foundation

/// A ring: someone started talking and the relay is holding their message for us. It
/// arrives as custom keys in the ring notification (see ringAlert in server/src/apns.ts).
public struct Ring: Equatable {
    public let conversationId: String
    public let from: String
    public let fromName: String
    public let burstId: String?
    /// When the relay sent the push (server clock, ms since epoch).
    public let pushSentAt: Double?

    public init(conversationId: String, from: String, fromName: String, burstId: String? = nil, pushSentAt: Double? = nil) {
        self.conversationId = conversationId
        self.from = from
        self.fromName = fromName
        self.burstId = burstId
        self.pushSentAt = pushSentAt
    }

    /// Reads a ring from a notification's `userInfo`; nil if it isn't one.
    public init?(userInfo: [AnyHashable: Any]) {
        guard let conversationId = userInfo["conversationId"] as? String, !conversationId.isEmpty,
              let from = userInfo["from"] as? String, !from.isEmpty else { return nil }
        self.init(
            conversationId: conversationId,
            from: from,
            fromName: (userInfo["fromName"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? from,
            burstId: userInfo["burstId"] as? String,
            pushSentAt: (userInfo["pushSentAt"] as? NSNumber)?.doubleValue
        )
    }
}
