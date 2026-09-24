import Foundation

/// Messages from the relay. See server/src/protocol.ts.
struct RelayMessage: Decodable {
    let type: String
    var clientTime: Double?
    var serverTime: Double?
    var burstId: String?
    var conversationId: String?
    var pushed: Bool?
    var holder: String?
    var peer: String?
    var replayBursts: Int?
    var droppedBursts: Int?
    var from: String?
    var replay: Bool?
    var message: String?
}

/// Record framing shared with server/src/records.ts:
/// [type: 1 byte][payload length: UInt32 big-endian][payload].
enum RelayRecord {
    static let json: UInt8 = 1
    static let audio: UInt8 = 2
    private static let headerBytes = 5

    static func encode(_ type: UInt8, _ payload: Data) -> Data {
        var data = Data(capacity: headerBytes + payload.count)
        data.append(type)
        withUnsafeBytes(of: UInt32(payload.count).bigEndian) { data.append(contentsOf: $0) }
        data.append(payload)
        return data
    }

    struct Parser {
        private var pending = Data()

        enum ParseError: Error { case badRecord }

        mutating func push(_ data: Data) throws -> [(type: UInt8, payload: Data)] {
            pending.append(data)
            var records: [(UInt8, Data)] = []
            while pending.count >= headerBytes {
                let start = pending.startIndex
                let type = pending[start]
                let length = pending[start + 1 ..< start + 5].reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
                guard type == json || type == audio, length <= 1 << 20 else { throw ParseError.badRecord }
                let end = start + headerBytes + Int(length)
                guard pending.count >= headerBytes + Int(length) else { break }
                records.append((type, pending.subdata(in: start + headerBytes ..< end)))
                pending = pending.subdata(in: end ..< pending.endIndex)
            }
            return records
        }
    }
}

/// Talks to the relay over plain HTTPS, which watchOS allows at any time. (WebSockets
/// are only allowed during a CallKit call, TN3135, and an active call locks the watch
/// into the system call screen, so conversations happen without one.)
///
///   Downlink: GET /v1/relay/stream, a long-lived response carrying records as they happen.
///   Uplink:   POST /v1/relay/send, one at a time so records arrive in order; whatever
///             queues up while a POST is in flight goes in the next one.
///
/// All callbacks and calls happen on the main queue.
final class RelayConnection: NSObject, URLSessionDataDelegate {
    var onReady: ((_ clockOffsetMs: Double) -> Void)?
    var onMessage: ((RelayMessage) -> Void)?
    var onFrame: ((Data) -> Void)?
    var onClose: ((_ reason: String) -> Void)?
    /// Each uplink POST: when it started and finished (ms), bytes, HTTP status (0 = error).
    var onPostFinished: ((_ startedAt: Double, _ finishedAt: Double, _ bytes: Int, _ status: Int) -> Void)?

    private(set) var isReady = false
    private(set) var clockOffsetMs: Double = 0
    /// A stream request is in flight or open (it may not have answered yet).
    var isConnecting: Bool { streamTask != nil }

    private var session: URLSession?
    private var streamTask: URLSessionDataTask?
    private var parser = RelayRecord.Parser()
    private var helloSentAt: Double = 0
    private var sendURL: URL?
    private var token = ""
    private var outbox = Data()
    private var posting = false

    /// `join` also answers and joins that conversation in the stream request itself
    /// ("pending": the user's newest queued ring).
    func connect(baseURL: URL, token: String, userId: String, join: String? = nil) {
        close()
        self.token = token
        let configuration = URLSessionConfiguration.default
        // Idle timeout for the stream; the relay sends a keepalive every 15 s.
        configuration.timeoutIntervalForRequest = 45
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
        self.session = session

        helloSentAt = Timeline.nowMs()
        var stream = URLComponents(url: baseURL.appendingPathComponent("v1/relay/stream"), resolvingAgainstBaseURL: false)
        stream?.queryItems = [
            URLQueryItem(name: "userId", value: userId),
            URLQueryItem(name: "clientTime", value: String(Int(helloSentAt))),
        ] + (join.map { [URLQueryItem(name: "join", value: $0)] } ?? [])
        var send = URLComponents(url: baseURL.appendingPathComponent("v1/relay/send"), resolvingAgainstBaseURL: false)
        send?.queryItems = [URLQueryItem(name: "userId", value: userId)]
        guard let streamURL = stream?.url, let sendURL = send?.url else { return }
        self.sendURL = sendURL

        let task = session.dataTask(with: request(streamURL))
        streamTask = task
        task.resume()
    }

    func send(_ message: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: message) else { return }
        enqueue(RelayRecord.encode(RelayRecord.json, data))
    }

    func send(frame: Data) {
        enqueue(RelayRecord.encode(RelayRecord.audio, frame))
    }

    func close() {
        isReady = false
        streamTask?.cancel()
        session?.invalidateAndCancel()
        streamTask = nil
        session = nil
        sendURL = nil
        parser = RelayRecord.Parser()
        outbox = Data()
        posting = false
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
        let startedAt = Timeline.nowMs()
        session.dataTask(with: request) { [weak self] _, response, error in
            guard let self, self.session === session else { return }
            posting = false
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            onPostFinished?(startedAt, Timeline.nowMs(), bytes, error == nil ? status : 0)
            if let error {
                print("[relay] send failed: \(error.localizedDescription)")
            } else if status != 200 {
                print("[relay] send: HTTP \(status)")
            }
            flush()
        }.resume()
    }

    private func request(_ url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return request
    }

    // MARK: Downlink (URLSessionDataDelegate)

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard dataTask === streamTask else { return completionHandler(.allow) }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 200 {
            completionHandler(.allow)
        } else {
            completionHandler(.cancel)
            finish("stream HTTP \(status)")
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard dataTask === streamTask else { return }
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

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard task === streamTask else { return }
        finish(error?.localizedDescription ?? "stream ended")
    }

    private func handle(_ payload: Data) {
        guard let message = try? JSONDecoder().decode(RelayMessage.self, from: payload) else { return }
        switch message.type {
        case "ping":
            break
        case "hello-ack":
            // The stream's first record: estimate the clock offset from the request round trip.
            if let serverTime = message.serverTime {
                clockOffsetMs = serverTime - (helloSentAt + Timeline.nowMs()) / 2
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
