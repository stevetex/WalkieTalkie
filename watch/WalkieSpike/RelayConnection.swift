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

/// WebSocket to the relay. watchOS only permits this socket while a CallKit call is
/// active (TN3135), so it's opened after the call starts and closed when it ends.
/// Callbacks arrive on the main queue.
final class RelayConnection: NSObject, URLSessionWebSocketDelegate {
    var onReady: ((_ clockOffsetMs: Double) -> Void)?
    var onMessage: ((RelayMessage) -> Void)?
    var onFrame: ((Data) -> Void)?
    var onClose: ((_ reason: String) -> Void)?

    private(set) var isReady = false
    private(set) var clockOffsetMs: Double = 0
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var helloSentAt: Double = 0

    func connect(url: URL, token: String) {
        close()
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
        let task = session.webSocketTask(with: request)
        self.session = session
        self.task = task
        task.resume()
        receive(on: task)
    }

    func send(_ message: [String: Any]) {
        guard let task, let data = try? JSONSerialization.data(withJSONObject: message),
              let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { error in
            if let error { print("[relay] send failed: \(error.localizedDescription)") }
        }
    }

    /// Safe to call from any queue.
    func send(frame: Data) {
        task?.send(.data(frame)) { _ in }
    }

    func close() {
        isReady = false
        task?.cancel(with: .normalClosure, reason: nil)
        session?.invalidateAndCancel()
        task = nil
        session = nil
    }

    // MARK: URLSessionWebSocketDelegate

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard webSocketTask === task else { return }
        helloSentAt = Timeline.nowMs()
        send(["type": "hello", "clientTime": helloSentAt])
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard webSocketTask === task else { return }
        finish("closed (\(closeCode.rawValue))")
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard task === self.task, let error else { return }
        finish(error.localizedDescription)
    }

    // MARK: Private

    private func receive(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self, task === self.task else { return }
                switch result {
                case let .success(.string(text)):
                    self.handle(text)
                case let .success(.data(data)):
                    self.onFrame?(data)
                case .success:
                    break
                case let .failure(error):
                    self.finish(error.localizedDescription)
                    return
                }
                self.receive(on: task)
            }
        }
    }

    private func handle(_ text: String) {
        guard let message = try? JSONDecoder().decode(RelayMessage.self, from: Data(text.utf8)) else { return }
        if message.type == "hello-ack", let serverTime = message.serverTime {
            let now = Timeline.nowMs()
            clockOffsetMs = serverTime - (helloSentAt + now) / 2
            isReady = true
            onReady?(clockOffsetMs)
            return
        }
        onMessage?(message)
    }

    private func finish(_ reason: String) {
        guard task != nil else { return }
        isReady = false
        task = nil
        session?.invalidateAndCancel()
        session = nil
        onClose?(reason)
    }
}
