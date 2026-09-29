import Foundation
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
}
