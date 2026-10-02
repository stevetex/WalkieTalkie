import Foundation
import os
import Testing
@testable import OverAndOutKit

/// A relay served from a URLProtocol: the stream answers with hello-ack and then `streamRecords`
/// and stays open; each send is recorded and answered with `sendStatus`, or held until
/// `releaseHeldSends()` when `holdSends` is set.
///
/// `@unchecked Sendable`: URLProtocol isn't Sendable, and a held send finishes on the test's
/// task. This subclass adds no stored state; the shared state is behind `state`.
final class RelayStub: URLProtocol, @unchecked Sendable {
    private struct State {
        var streamRecords = Data()
        var sendStatus = 200
        var holdSends = false
        var sends: [Data] = []
        var held: [@Sendable () -> Void] = []
        var streamURLs: [URL] = []
        var streamHeaders: [[String: String]] = []
        /// A refusal at admission instead of the stream: its status and JSON body.
        var streamRefusal: (status: Int, body: String)?
    }

    private static let state = OSAllocatedUnfairLock(initialState: State())

    static func reset(streamRecords: Data = Data(), sendStatus: Int = 200, holdSends: Bool = false, streamRefusal: (status: Int, body: String)? = nil) {
        state.withLock { $0 = State(streamRecords: streamRecords, sendStatus: sendStatus, holdSends: holdSends, streamRefusal: streamRefusal) }
    }

    /// The headers each stream request carried, oldest first.
    static var streamHeaders: [[String: String]] { state.withLock { $0.streamHeaders } }

    /// The records in each send's body.
    static var sends: [[(type: UInt8, payload: Data)]] {
        state.withLock { $0.sends }.map { body in
            var parser = RelayRecord.Parser()
            return (try? parser.push(body)) ?? []
        }
    }

    static var heldSends: Int { state.withLock { $0.held.count } }

    /// The URLs the stream was opened with, oldest first.
    static var streamURLs: [URL] { state.withLock { $0.streamURLs } }

    static func releaseHeldSends() {
        // A named parameter: Swift 6.2 (Xcode 26) rejects $0 inside the defer.
        let held = state.withLock { locked in
            defer { locked.held = [] }
            return locked.held
        }
        held.forEach { $0() }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        if url.path.hasSuffix("/v2/relay/stream") {
            let refusal = Self.state.withLock { state in
                state.streamURLs.append(url)
                state.streamHeaders.append(request.allHTTPHeaderFields ?? [:])
                return state.streamRefusal
            }
            if let refusal {
                let headers = ["Content-Type": "application/json"]
                client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: refusal.status, httpVersion: nil, headerFields: headers)!,
                                    cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: Data(refusal.body.utf8))
                client?.urlProtocolDidFinishLoading(self)
                return
            }
            let hello = RelayRecord.encode(RelayRecord.json, Data(#"{"type":"hello-ack","serverTime":1000}"#.utf8))
            let records = Self.state.withLock { $0.streamRecords }
            // As the relay sends it: with a type, so URLSession doesn't hold data back to sniff one.
            let headers = ["Content-Type": "application/octet-stream", "X-Content-Type-Options": "nosniff"]
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: headers)!,
                                cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: hello + records)
            return // The stream stays open until the connection closes it.
        }
        let body = request.bodyStreamData()
        let (status, hold) = Self.state.withLock { state in
            if !body.isEmpty { state.sends.append(body) }
            return (state.sendStatus, state.holdSends && !body.isEmpty)
        }
        let finish: @Sendable () -> Void = { [self] in
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!,
                                cacheStoragePolicy: .notAllowed)
            client?.urlProtocolDidFinishLoading(self)
        }
        if hold {
            Self.state.withLock { $0.held.append(finish) }
        } else {
            finish()
        }
    }

    override func stopLoading() {}
}

/// Waits on the main actor, so the connection's callbacks can run meanwhile.
@MainActor
private func waitUntil(_ condition: @MainActor () -> Bool, seconds: Double = 3) async throws {
    let deadline = Date().addingTimeInterval(seconds)
    while !condition() {
        guard Date() < deadline else { throw CancellationError() }
        try await Task.sleep(nanoseconds: 2_000_000)
    }
}

@MainActor
@Suite(.serialized)
struct RelayConnectionTests {
    let base = URL(string: "https://relay.test")!

    func connection(stampsArrivals: Bool) -> RelayConnection {
        let relay = RelayConnection(stampsArrivals: stampsArrivals)
        relay.protocolClasses = [RelayStub.self]
        return relay
    }

    static func json(_ text: String) -> Data { RelayRecord.encode(RelayRecord.json, Data(text.utf8)) }

    /// Talk starts before the stream opens (the watch's first press): what's sent meanwhile is
    /// held until hello-ack, then goes out in one POST, in order.
    @Test(arguments: [false, true])
    func sendsBeforeTheStreamOpensGoOutInOrderOnceItDoes(stampsArrivals: Bool) async throws {
        RelayStub.reset()
        let relay = connection(stampsArrivals: stampsArrivals)
        var readyOnMain = false
        relay.onReady = { _ in readyOnMain = Thread.isMainThread }
        relay.connect(baseURL: base, token: "t")
        relay.send(["type": "talk-start", "burstId": "b1"])
        relay.send(frame: Data([1]))
        relay.send(frame: Data([2]))
        #expect(!relay.isReady)
        try await waitUntil { RelayStub.sends.count == 1 }
        #expect(relay.isReady)
        #expect(readyOnMain)
        let records = RelayStub.sends[0]
        #expect(records.map(\.type) == [RelayRecord.json, RelayRecord.audio, RelayRecord.audio])
        #expect(records.dropFirst().map(\.payload) == [Data([1]), Data([2])])
        relay.close()
    }

    /// Run 106: a rejoin after the stream dropped asks, in the stream's own request, for the
    /// burst being heard from its first missed frame. Without a join there's nothing to resume.
    @Test func aRejoinAsksForTheBurstFromItsFirstMissedFrame() async throws {
        RelayStub.reset()
        let relay = connection(stampsArrivals: false)
        relay.connect(baseURL: base, token: "t", join: "c1", resume: RelayResume(burstId: "b1", fromSeq: 42))
        try await waitUntil { relay.isReady }
        relay.connect(baseURL: base, token: "t", resume: RelayResume(burstId: "b1", fromSeq: 42))
        try await waitUntil { RelayStub.streamURLs.count == 2 }
        let query = { (url: URL) in
            Dictionary(uniqueKeysWithValues: (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        }
        let rejoin = query(RelayStub.streamURLs[0])
        #expect(rejoin["join"] == "c1")
        #expect(rejoin["resumeBurst"] == "b1")
        #expect(rejoin["resumeFrom"] == "42")
        #expect(query(RelayStub.streamURLs[1])["resumeBurst"] == nil)
        relay.close()
    }

    /// v2 admission: the stream names the ring it answers and says what this build is.
    @Test func aJoinNamesItsRingAndTheStreamSaysWhatThisBuildIs() async throws {
        RelayStub.reset()
        let relay = RelayConnection(identity: ClientIdentity(kind: .watchos, version: "1.0", build: "170", encodes: ["opus16k"]))
        relay.protocolClasses = [RelayStub.self]
        relay.connect(baseURL: base, token: "t", join: "c1", ring: "r_abc")
        try await waitUntil { relay.isReady }
        let query = Dictionary(uniqueKeysWithValues: (URLComponents(url: RelayStub.streamURLs[0], resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        #expect(query["join"] == "c1")
        #expect(query["ring"] == "r_abc")
        let headers = RelayStub.streamHeaders[0]
        #expect(headers["X-OAO-Client-Kind"] == "watchos")
        #expect(headers["X-OAO-Build"] == "170")
        #expect(headers["X-OAO-Relay-Protocol"] == "2")
        #expect(headers["X-OAO-Decode"] == "opus16k,pcm16le16k")
        #expect(headers["X-OAO-Encode"] == "opus16k")
        relay.close()
    }

    /// A refusal at admission says why: an update is needed, or the session ended.
    @Test func aRefusedStreamSaysWhy() async throws {
        RelayStub.reset(streamRefusal: (409, #"{"error":"client-upgrade-required","message":"Update Over&Out to keep talking.","minimumBuild":200}"#))
        let relay = connection(stampsArrivals: false)
        var refusal: RelayRefusal?
        var closed: String?
        relay.onRefused = { refusal = $0 }
        relay.onClose = { closed = $0 }
        relay.connect(baseURL: base, token: "t")
        try await waitUntil { closed != nil }
        #expect(refusal == RelayRefusal(status: 409, code: "client-upgrade-required", message: "Update Over&Out to keep talking."))
        #expect(refusal?.requiresUpgrade == true)
        #expect(closed == "stream HTTP 409 client-upgrade-required")
        #expect(!relay.isReady)
    }

    /// Records arrive on the main actor in the order the relay sent them, stamped when they arrived.
    @Test(arguments: [false, true])
    func downlinkRecordsArriveInOrderOnTheMainActor(stampsArrivals: Bool) async throws {
        RelayStub.reset(streamRecords: Self.json(#"{"type":"burst-start","burstId":"b1"}"#)
            + RelayRecord.encode(RelayRecord.audio, Data([7]))
            + Self.json(#"{"type":"ping"}"#)
            + RelayRecord.encode(RelayRecord.audio, Data([8]))
            + Self.json(#"{"type":"burst-end","burstId":"b1"}"#))
        let relay = connection(stampsArrivals: stampsArrivals)
        var seen: [String] = []
        var allOnMain = true
        relay.onReady = { _ in seen.append("ready") }
        relay.onMessage = { message in
            allOnMain = allOnMain && Thread.isMainThread
            seen.append(message.type)
        }
        relay.onFrame = { frame in
            allOnMain = allOnMain && Thread.isMainThread
            seen.append("frame \(frame[0])")
        }
        let before = Clock.nowMs()
        relay.connect(baseURL: base, token: "t")
        try await waitUntil { seen.count == 5 }
        // "ping" is the relay's keepalive, handled inside the connection.
        #expect(seen == ["ready", "burst-start", "frame 7", "frame 8", "burst-end"])
        #expect(allOnMain)
        #expect(relay.lastArrivalMs >= before)
        relay.close()
    }

    /// A POST that fails closes the connection once; what it carried isn't retried.
    @Test func aFailedSendClosesTheConnection() async throws {
        RelayStub.reset(sendStatus: 500)
        let relay = connection(stampsArrivals: true)
        var closes: [String] = []
        relay.onClose = { closes.append($0) }
        relay.connect(baseURL: base, token: "t")
        relay.send(["type": "talk-start", "burstId": "b1"])
        try await waitUntil { !closes.isEmpty }
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(closes == ["send: HTTP 500"])
        #expect(!relay.isReady && !relay.isConnecting)
    }

    /// Reconnecting cancels the old connection's POST, whose failure arrives after the new
    /// stream opened: it's ignored, rather than closing the new connection or reporting.
    @Test func aSendFromAnEarlierConnectionIsIgnored() async throws {
        RelayStub.reset(holdSends: true)
        let relay = connection(stampsArrivals: true)
        var statuses: [Int] = []
        var closes = 0
        relay.onPostFinished = { _, _, _, status in statuses.append(status) }
        relay.onClose = { _ in closes += 1 }
        relay.connect(baseURL: base, token: "t")
        relay.send(["type": "talk-start", "burstId": "old"])
        try await waitUntil { RelayStub.heldSends == 1 }

        relay.connect(baseURL: base, token: "t")
        relay.send(["type": "talk-start", "burstId": "new"])
        try await waitUntil { RelayStub.heldSends == 2 && relay.isReady }
        RelayStub.releaseHeldSends()
        try await waitUntil { statuses.count == 1 }
        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(statuses == [200])
        #expect(closes == 0)
        #expect(relay.isReady)
        relay.close()
    }
}
