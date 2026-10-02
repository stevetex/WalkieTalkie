import Foundation
import Testing
@testable import OverAndOutKit

struct RingTests {
    @Test func readsTheRingFromNotificationUserInfo() throws {
        // As delivered: the aps dictionary plus the ring fields (numbers arrive as NSNumber).
        let userInfo: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "Alice", "body": "Tap to listen"]],
            "ringId": "r_abc", "conversationId": "c1", "from": "alice", "fromName": "Alice",
            "burstId": "b1", "pushSentAt": NSNumber(value: 1_790_000_000_000.0),
        ]
        let ring = try #require(Ring(userInfo: userInfo))
        #expect(ring == Ring(conversationId: "c1", from: "alice", fromName: "Alice", ringId: "r_abc", burstId: "b1",
                             pushSentAt: 1_790_000_000_000))
    }

    @Test func fallsBackToTheUserIdForTheName() throws {
        let ring = try #require(Ring(userInfo: ["ringId": "r_abc", "conversationId": "c1", "from": "alice", "fromName": ""]))
        #expect(ring.fromName == "alice")
    }

    @Test func readsTheEnvelopeAndIgnoresWhatALaterOneAdds() throws {
        let userInfo: [AnyHashable: Any] = [
            "schemaVersion": NSNumber(value: 3), "ringId": "r_abc", "conversationId": "c1", "from": "u_b", "fromName": "Bob",
            "burstId": "b1", "pushSentAt": NSNumber(value: 1000.0), "expiresAt": NSNumber(value: 36_000.0), "priority": "high",
        ]
        let ring = try #require(Ring(userInfo: userInfo))
        #expect(ring.ringId == "r_abc")
        #expect(ring.expiresAt == 36_000)
        #expect(ring.isExpired(nowMs: 35_999) == false)
        #expect(ring.isExpired(nowMs: 35_000, clockOffsetMs: 1_000))
    }

    @Test func ignoresOtherNotifications() {
        #expect(Ring(userInfo: ["aps": ["alert": "hi"]]) == nil)
        #expect(Ring(userInfo: ["ringId": "r_abc", "conversationId": "", "from": "alice"]) == nil)
        // Every ring has an ID, and it must look like one.
        #expect(Ring(userInfo: ["conversationId": "c1", "from": "alice"]) == nil)
        #expect(Ring(userInfo: ["ringId": "x", "conversationId": "c1", "from": "alice"]) == nil)
    }
}
