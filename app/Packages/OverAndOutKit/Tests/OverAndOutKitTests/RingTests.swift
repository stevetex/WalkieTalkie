import Foundation
import Testing
@testable import OverAndOutKit

struct RingTests {
    @Test func readsTheRingFromNotificationUserInfo() throws {
        // As delivered: the aps dictionary plus the ring fields (numbers arrive as NSNumber).
        let userInfo: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "Alice", "body": "Tap to listen"]],
            "conversationId": "c1", "from": "alice", "fromName": "Alice",
            "burstId": "b1", "pushSentAt": NSNumber(value: 1_790_000_000_000.0),
        ]
        let ring = try #require(Ring(userInfo: userInfo))
        #expect(ring == Ring(conversationId: "c1", from: "alice", fromName: "Alice", burstId: "b1", pushSentAt: 1_790_000_000_000))
    }

    @Test func fallsBackToTheUserIdForTheName() throws {
        let ring = try #require(Ring(userInfo: ["conversationId": "c1", "from": "alice", "fromName": ""]))
        #expect(ring.fromName == "alice")
    }

    @Test func ignoresOtherNotifications() {
        #expect(Ring(userInfo: ["aps": ["alert": "hi"]]) == nil)
        #expect(Ring(userInfo: ["conversationId": "", "from": "alice"]) == nil)
    }
}
