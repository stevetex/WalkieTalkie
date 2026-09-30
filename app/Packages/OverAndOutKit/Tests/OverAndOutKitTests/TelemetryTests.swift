import Foundation
import os
@testable import OverAndOutKit
import XCTest

final class TelemetryTests: XCTestCase {
    private func tempDirectory() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    }

    private func lines(_ log: DiagnosticsLog) -> [[String: Any]] {
        log.contents().split(separator: "\n").compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
    }

    func testEventsAndTimelinesAreLinesWithoutFreeText() {
        let log = DiagnosticsLog(directory: tempDirectory(), maxBytes: 100_000)
        log.append("pttLeft", ["reason": 1, "byApp": false], at: 1000)
        var timeline = Timeline(role: .receiver)
        timeline.mark("pttPushReceived", at: 2000)
        timeline.mark("log", detail: "PushToTalk push from Bob", once: false)
        timeline.mark("joined", at: 2600, detail: "0 buffered bursts")
        log.appendTimeline(timeline, conversationId: "c1")
        let all = lines(log)
        XCTAssertEqual(all.map { $0["name"] as? String }, ["pttLeft", "pttPushReceived", "joined"])
        XCTAssertEqual(all[0]["reason"] as? Int, 1)
        XCTAssertEqual(all[2]["conversationId"] as? String, "c1")
        XCTAssertEqual(all[2]["role"] as? String, "receiver")
        XCTAssertFalse(log.contents().contains("Bob"))
    }

    func testTheOldestLinesGoPastTheLimit() {
        let log = DiagnosticsLog(directory: tempDirectory(), maxBytes: 4_000)
        let now = Clock.nowMs()
        for i in 0..<200 { log.append("event\(i)", ["pad": String(repeating: "x", count: 20)], at: now) }
        // A line older than 14 days goes at the next trim too.
        let all = lines(log)
        XCTAssertLessThan(log.contents().utf8.count, 5_000)
        XCTAssertEqual(all.last?["name"] as? String, "event199")
        XCTAssertNotEqual(all.first?["name"] as? String, "event0")
    }

    func testTheLogCompressesToRawDeflate() throws {
        let log = DiagnosticsLog(directory: tempDirectory(), maxBytes: 100_000)
        for i in 0..<50 { log.append("event", ["i": i]) }
        let compressed = try XCTUnwrap(log.compressed())
        let restored = try (compressed as NSData).decompressed(using: .zlib) as Data
        XCTAssertEqual(String(decoding: restored, as: UTF8.self), log.contents())
        XCTAssertLessThan(compressed.count, restored.count)
    }

    func testDeviceInfoNamesTheKindAndBuild() {
        let info = DeviceInfo.current(platform: .watch)
        XCTAssertEqual(info["platform"], "watch")
        XCTAssertFalse(info["model", default: ""].isEmpty)
        XCTAssertFalse(info["os", default: ""].isEmpty)
    }

    /// Events come from the main actor, MetricKit's queue and PushToTalk's delegate at once.
    func testEventsFromManyThreadsAreAllSentOnce() async throws {
        let telemetry = Telemetry()
        telemetry.configure(platform: .iphone, directory: tempDirectory(), maxBytes: 100_000)
        await withTaskGroup(of: Void.self) { group in
            for task in 0..<8 {
                group.addTask { for i in 0..<20 { telemetry.event("e\(task)-\(i)", ["i": i]) } }
            }
        }
        let sent = SentBox()
        telemetry.send = { events, _ in sent.add(events.compactMap { $0["name"] as? String }) }
        for _ in 0..<4 { await telemetry.flush() }
        XCTAssertEqual(sent.names.count, 160)
        XCTAssertEqual(Set(sent.names).count, 160)
    }

    func testQueuedEventsSurviveARelaunch() async throws {
        let directory = tempDirectory()
        let first = Telemetry()
        first.configure(platform: .iphone, directory: directory, maxBytes: 100_000)
        first.event("pttRestored", ["joined": true])
        first.event("appLaunched")
        // The process ends before a send; a new launch picks the events up and sends them.
        try await Task.sleep(nanoseconds: 200_000_000)
        let second = Telemetry()
        second.configure(platform: .iphone, directory: directory, maxBytes: 100_000)
        let sent = SentBox()
        second.send = { events, _ in sent.add(events.compactMap { $0["name"] as? String }) }
        await second.flush()
        XCTAssertEqual(sent.names, ["pttRestored", "appLaunched"])
        // Sent events don't come back.
        try await Task.sleep(nanoseconds: 200_000_000)
        let third = Telemetry()
        third.configure(platform: .iphone, directory: directory, maxBytes: 100_000)
        let again = SentBox()
        third.send = { events, _ in again.add(events.compactMap { $0["name"] as? String }) }
        await third.flush()
        XCTAssertEqual(again.names, [])
    }

    /// Run 63: the watch was suspended before its timeline upload finished.
    func testAnUnsentTimelineIsSentAfterARelaunch() async throws {
        let directory = tempDirectory()
        let first = Telemetry()
        first.configure(platform: .watch, directory: directory, maxBytes: 100_000)
        first.sendTimeline = { _ in throw URLError(.notConnectedToInternet) }
        var timeline = Timeline(role: .receiver)
        timeline.mark("notificationOpened", at: 1000)
        timeline.mark("firstAudioScheduled", at: 1700)
        await first.uploadTimeline(timeline.upload(conversationId: "c1", userId: "u1", clockOffsetMs: 5), conversationId: "c1")

        let second = Telemetry()
        second.configure(platform: .watch, directory: directory, maxBytes: 100_000)
        let sent = SentBox()
        second.sendTimeline = { body in
            let events = (body["events"] as? [Telemetry.Fields] ?? []).compactMap { $0["name"] as? String }
            sent.add(["\(body["conversationId"] ?? "")"] + events)
        }
        await second.flush()
        XCTAssertEqual(sent.names, ["c1", "notificationOpened", "firstAudioScheduled"])
        // Sent once only.
        await second.flush()
        XCTAssertEqual(sent.names.count, 3)
    }

    func testTimelinesGoOldestFirstAndOnlyTheNewestAreKept() async throws {
        let telemetry = Telemetry()
        telemetry.configure(platform: .iphone, directory: tempDirectory(), maxBytes: 100_000)
        telemetry.sendTimeline = { _ in throw URLError(.timedOut) }
        for i in 0..<25 {
            await telemetry.uploadTimeline(["conversationId": "c\(i)", "events": [Telemetry.Fields]()], conversationId: "c\(i)")
            // Distinct millisecond names, as conversations are in practice.
            try await Task.sleep(nanoseconds: 2_000_000)
        }
        let sent = SentBox()
        telemetry.sendTimeline = { body in sent.add(["\(body["conversationId"] ?? "")"]) }
        await telemetry.flush()
        XCTAssertEqual(sent.names, (5..<25).map { "c\($0)" })
    }
}

private final class SentBox: Sendable {
    private let all = OSAllocatedUnfairLock<[String]>(initialState: [])
    func add(_ names: [String]) { all.withLock { $0 += names } }
    var names: [String] { all.withLock { $0 } }
}
