import Foundation

/// A rejoin after the relay stream dropped mid-message: the burst being heard and the
/// sequence number of the first frame that didn't arrive.
public struct RelayResume: Sendable, Equatable {
    public let burstId: String
    public let fromSeq: UInt32

    public init(burstId: String, fromSeq: UInt32) {
        self.burstId = burstId
        self.fromSeq = fromSeq
    }
}

/// The relay refused the stream at admission (contracts/README.md, "The relay"): this build is
/// too old (client-upgrade-required), the session ended, or a lookup failed.
public struct RelayRefusal: Sendable, Equatable {
    public let status: Int
    public let code: String
    public let message: String

    public var endsSession: Bool { status == 401 }
    public var requiresUpgrade: Bool { code == "client-upgrade-required" }
}

/// Messages from the relay. See server/src/protocol.ts. Types and fields this build doesn't
/// know are ignored (a later relay may send more).
public struct RelayMessage: Decodable, Sendable {
    public let type: String
    public var clientTime: Double?
    public var serverTime: Double?
    public var burstId: String?
    public var conversationId: String?
    public var pushed: Bool?
    public var holder: String?
    public var peer: String?
    public var replayBursts: Int?
    /// joined, after a rejoin with a resume: how many frames of that burst are replayed.
    public var resumedFrames: Int?
    public var droppedBursts: Int?
    public var from: String?
    /// ring (over the stream, to an app on screen): the caller's name and when it was sent.
    public var fromName: String?
    public var pushSentAt: Double?
    public var replay: Bool?
    /// burst-start: the replay continues a burst this device was hearing when its stream dropped.
    public var resumed: Bool?
    public var message: String?
    /// talk-refused: why ("not-friends", "unavailable": none of their devices can ring, or
    /// "unsupported-codec").
    public var reason: String?
    /// ring and joined: the ring's ID; ring: when it's abandoned (server clock, ms).
    public var ringId: String?
    public var expiresAt: Double?
    /// error: the stable code (ring-expired, ring-answered-elsewhere, unknown-conversation, …).
    public var code: String?
    /// burst-start: the burst's codec.
    public var codec: String?
    public var format: Int?
    public var e2ee: KeyBundle?
    public var keys: FriendKeys?
}

/// Record framing shared with server/src/records.ts:
/// [type: 1 byte][payload length: UInt32 big-endian][payload].
public enum RelayRecord {
    public static let json: UInt8 = 1
    public static let audio: UInt8 = 2
    private static let headerBytes = 5
    public static let maxPayloadBytes = 64 * 1024

    public static func encode(_ type: UInt8, _ payload: Data) -> Data {
        var data = Data(capacity: headerBytes + payload.count)
        data.append(type)
        withUnsafeBytes(of: UInt32(payload.count).bigEndian) { data.append(contentsOf: $0) }
        data.append(payload)
        return data
    }

    public struct Parser {
        private var pending = Data()

        public enum ParseError: Error { case badRecord }

        public init() {}

        public mutating func push(_ data: Data) throws -> [(type: UInt8, payload: Data)] {
            pending.append(data)
            var records: [(UInt8, Data)] = []
            while pending.count >= headerBytes {
                let start = pending.startIndex
                let type = pending[start]
                let length = pending[start + 1 ..< start + 5].reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
                // The contract's limit (contracts/README.md): control messages are small and a frame
                // at most 1280 bytes.
                guard type == json || type == audio, length <= maxPayloadBytes else { throw ParseError.badRecord }
                let end = start + headerBytes + Int(length)
                guard pending.count >= headerBytes + Int(length) else { break }
                records.append((type, pending.subdata(in: start + headerBytes ..< end)))
                pending = pending.subdata(in: end ..< pending.endIndex)
            }
            return records
        }
    }
}

/// Talks to the relay over plain HTTPS, which watchOS allows at any time. Every request carries
/// relay admission's headers (this build's kind, build, relay protocol and codecs). (WebSockets
/// are only allowed during a CallKit call, TN3135, and an active call locks the watch
/// into the system call screen, so conversations happen without one.)
///
///   Downlink: GET /v2/relay/stream, a long-lived response carrying records as they happen.
///   Uplink:   POST /v2/relay/send, one at a time so records arrive in order; whatever
///             queues up while a POST is in flight goes in the next one. A POST that fails
///             closes the connection (onClose): its records are lost, and a lost talk-start or
///             talk-end would leave the two sides disagreeing about the conversation. It isn't
///             retried, since a POST that failed may still have been applied, and resending
///             it would repeat its audio. Closing the stream also ends it on the relay.
///
/// All callbacks and calls happen on the main actor, which owns the connection's state (the
/// parser, the outbox and the stream), so they stay in order. The session's delegate methods
/// are nonisolated and hand what they get to the main actor. With `stampsArrivals`, the
/// session delivers to a queue of its own first, so `lastArrivalMs` says when what a callback
/// is handling actually arrived, however busy the main queue was (the watch's diagnostics).
@MainActor
public final class RelayConnection: NSObject, URLSessionDataDelegate {
    public var onReady: ((_ clockOffsetMs: Double) -> Void)?
    public var onMessage: ((RelayMessage) -> Void)?
    public var onFrame: ((Data) -> Void)?
    public var onClose: ((_ reason: String) -> Void)?
    /// The relay refused the stream at admission; onClose follows.
    public var onRefused: ((RelayRefusal) -> Void)?
    /// Each uplink POST: when it started and finished (ms), bytes, HTTP status (0 = error).
    public var onPostFinished: ((_ startedAt: Double, _ finishedAt: Double, _ bytes: Int, _ status: Int) -> Void)?
    /// The network's own timings for a finished request: `kind` is "stream", "send" or
    /// "warmUp". The stream's arrive when it ends.
    public var onTaskMetrics: ((_ kind: String, _ metrics: URLSessionTaskMetrics) -> Void)?

    public private(set) var isReady = false
    public private(set) var clockOffsetMs: Double = 0
    /// When the data the current callback handles arrived (ms): off the main queue with
    /// `stampsArrivals`, else when the main queue got it.
    public private(set) var lastArrivalMs: Double = 0
    /// A stream request is in flight or open (it may not have answered yet).
    public var isConnecting: Bool { streamTask != nil }

    private var session: URLSession?
    private var streamTask: URLSessionDataTask?
    private var parser = RelayRecord.Parser()
    private var helloSentAt: Double = 0
    private var sendURL: URL?
    private var token = ""
    private var outbox = Data()
    private var posting = false
    private let delegateQueue: OperationQueue
    /// The stream answered with an error: its status, and its body as it arrives.
    private var refused: (status: Int, body: Data)?
    /// This build, as relay admission hears it.
    private let identity: ClientIdentity
    /// Tests serve the relay from a URLProtocol.
    var protocolClasses: [AnyClass]?

    public init(stampsArrivals: Bool = false, identity: ClientIdentity = .current) {
        self.identity = identity
        if stampsArrivals {
            let queue = OperationQueue()
            queue.maxConcurrentOperationCount = 1
            queue.name = "RelayConnection"
            delegateQueue = queue
        } else {
            delegateQueue = .main
        }
        super.init()
    }

    /// Delegate work runs on the main actor, stamped with when it arrived: directly when the
    /// session delivers to the main queue, else after a hop.
    private nonisolated func onMain(_ work: @escaping @MainActor @Sendable () -> Void) {
        let arrived = Clock.nowMs()
        if OperationQueue.current === OperationQueue.main {
            return MainActor.assumeIsolated {
                lastArrivalMs = arrived
                work()
            }
        }
        DispatchQueue.main.async {
            self.lastArrivalMs = arrived
            work()
        }
    }

    /// `join` also answers and joins that conversation in the stream request itself, so
    /// the relay starts replaying the buffered message without another round trip. `ring`
    /// names the ring being answered (none for a rejoin or a move). `resume`, with `join`,
    /// rejoins after the stream dropped mid-message: the relay replays that burst from the
    /// first frame missed.
    public func connect(baseURL: URL, token: String, join: String? = nil, ring: String? = nil, resume: RelayResume? = nil) {
        close()
        self.token = token
        let configuration = URLSessionConfiguration.default
        // Idle timeout for the stream; the relay sends a keepalive every 15 s.
        configuration.timeoutIntervalForRequest = 45
        if let protocolClasses { configuration.protocolClasses = protocolClasses }
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
        self.session = session

        helloSentAt = Clock.nowMs()
        var stream = URLComponents(url: baseURL.appendingPathComponent("v2/relay/stream"), resolvingAgainstBaseURL: false)
        // The session token says who's connecting: no user ID in the query.
        stream?.queryItems = [
            URLQueryItem(name: "clientTime", value: String(Int(helloSentAt))),
        ] + (join.map { [URLQueryItem(name: "join", value: $0)] } ?? [])
            + (join != nil ? ring.map { [URLQueryItem(name: "ring", value: $0)] } ?? [] : [])
            + (join != nil ? resume.map { [URLQueryItem(name: "resumeBurst", value: $0.burstId),
                                          URLQueryItem(name: "resumeFrom", value: String($0.fromSeq))] } ?? [] : [])
        let sendURL = baseURL.appendingPathComponent("v2/relay/send")
        guard let streamURL = stream?.url else { return }
        self.sendURL = sendURL

        let task = session.dataTask(with: request(streamURL))
        task.taskDescription = "stream"
        streamTask = task
        task.resume()
    }

    public func send(_ message: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: message) else { return }
        enqueue(RelayRecord.encode(RelayRecord.json, data))
    }

    public func send(frame: Data) {
        enqueue(RelayRecord.encode(RelayRecord.audio, frame))
    }

    /// An empty POST, on its own beside the queue, so the watch's network is awake by the time
    /// what's said goes out (the first POST after a pause took 0.9 s to arrive, run 67). Only
    /// on an open stream; the relay answers it and applies nothing.
    public func warmUp() {
        guard isReady, let session, let sendURL else { return }
        var request = request(sendURL)
        request.httpMethod = "POST"
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data()
        let task = session.dataTask(with: request) { _, _, _ in }
        task.taskDescription = "warmUp"
        task.resume()
    }

    public func close() {
        isReady = false
        streamTask?.cancel()
        session?.invalidateAndCancel()
        streamTask = nil
        session = nil
        sendURL = nil
        parser = RelayRecord.Parser()
        outbox = Data()
        posting = false
        refused = nil
    }

    // MARK: Uplink

    private func enqueue(_ record: Data) {
        outbox.append(record)
        flush()
    }

    private func flush() {
        // The relay rejects sends until the stream is open, so hold them until hello-ack.
        guard isReady, !posting, !outbox.isEmpty, let session, let sendURL else { return }
        posting = true
        var request = request(sendURL)
        request.httpMethod = "POST"
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.httpBody = outbox
        let bytes = outbox.count
        outbox = Data()
        let startedAt = Clock.nowMs()
        let task = session.dataTask(with: request) { [weak self] _, response, error in
            self?.onMain { [weak self] in
                guard let self, self.session === session else { return }
                posting = false
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                onPostFinished?(startedAt, lastArrivalMs, bytes, error == nil ? status : 0)
                if let error {
                    return finish("send failed: \(error.localizedDescription)")
                } else if status != 200 {
                    return finish("send: HTTP \(status)")
                }
                flush()
            }
        }
        task.taskDescription = "send"
        task.resume()
    }

    private func request(_ url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        for (name, value) in identity.relayHeaders { request.setValue(value, forHTTPHeaderField: name) }
        return request
    }

    // MARK: Downlink (URLSessionDataDelegate)

    public nonisolated func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                                       completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void) {
        onMain { [self] in
            guard dataTask === streamTask else { return completionHandler(.allow) }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            // A refusal's JSON body says why; it's read to the end, then the stream finishes.
            if status != 200 { refused = (status, Data()) }
            completionHandler(.allow)
        }
    }

    public nonisolated func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        onMain { [self] in
            guard dataTask === streamTask else { return }
            if refused != nil {
                refused?.body.append(data)
                return
            }
            do {
                for record in try parser.push(data) {
                    if record.type == RelayRecord.audio {
                        onFrame?(record.payload)
                    } else {
                        handle(record.payload)
                    }
                }
            } catch {
                finish("bad data from relay")
            }
        }
    }

    public nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
        let kind = task.taskDescription ?? "?"
        onMain { [self] in onTaskMetrics?(kind, metrics) }
    }

    public nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        onMain { [self] in
            guard task === streamTask else { return }
            if let refused {
                let error = AccountAPIError(status: refused.status, body: refused.body)
                let refusal = RelayRefusal(status: refused.status, code: error.code, message: error.message)
                onRefused?(refusal)
                return finish("stream HTTP \(refused.status) \(refusal.code)")
            }
            finish(error?.localizedDescription ?? "stream ended")
        }
    }

    private func handle(_ payload: Data) {
        guard let message = try? JSONDecoder().decode(RelayMessage.self, from: payload) else { return }
        switch message.type {
        case "ping":
            break
        case "hello-ack":
            // The stream's first record: estimate the clock offset from the request round trip.
            if let serverTime = message.serverTime {
                clockOffsetMs = serverTime - (helloSentAt + Clock.nowMs()) / 2
            }
            isReady = true
            onReady?(clockOffsetMs)
            flush()
        default:
            onMessage?(message)
        }
    }

    private func finish(_ reason: String) {
        guard streamTask != nil else { return }
        close()
        onClose?(reason)
    }
}
