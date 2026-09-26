import Foundation
import Testing
@testable import OverAndOutKit

struct TimelineTests {
    @Test func keepsOnceEventsOnlyTheFirstTime() {
        var timeline = Timeline(role: .receiver)
        timeline.mark("joined", at: 1)
        timeline.mark("joined", at: 2)
        timeline.mark("burstStartReceived", at: 3, once: false)
        timeline.mark("burstStartReceived", at: 4, once: false)
        #expect(timeline.events.map(\.t) == [1, 3, 4])
        #expect(timeline.has("joined"))
    }

    @Test func uploadMatchesTheServersMetricsShape() throws {
        var timeline = Timeline(role: .sender)
        timeline.mark("talkPressed", at: 10)
        timeline.mark("floorGranted", at: 20, detail: "rang recipient")
        let body = timeline.upload(conversationId: "c1", userId: "u1", clockOffsetMs: -5)
        #expect(body["role"] as? String == "sender")
        #expect(body["clockOffsetMs"] as? Double == -5)
        let events = try #require(body["events"] as? [[String: Any]])
        #expect(events.count == 2)
        #expect(events[0]["detail"] == nil)
        #expect(events[1]["detail"] as? String == "rang recipient")
        #expect(JSONSerialization.isValidJSONObject(body))
    }
}
