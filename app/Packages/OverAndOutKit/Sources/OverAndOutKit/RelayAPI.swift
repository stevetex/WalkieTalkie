import Foundation

/// The relay's v2 ring calls and its small HTTPS endpoints (contracts/README.md, "Rings" and "The
/// relay"), with the session's token and this build's admission headers. A ring is always named
/// by its ID, so an old notification can't answer, prefetch or join a newer ring.
public struct RelayAPI: Sendable {
    public let baseURL: URL
    public let token: String
    public let identity: ClientIdentity

    public init(baseURL: URL, token: String, identity: ClientIdentity = .current) {
        self.baseURL = baseURL
        self.token = token
        self.identity = identity
    }

    /// Answers: this device has the ring, and 30 s to join. ring-expired (410) or
    /// ring-answered-elsewhere (409) otherwise.
    public func answer(_ ring: Ring) async throws {
        try await ringCall("v2/rings/answer", ring)
    }

    /// Declines: the ring doesn't roll over to the iPhone. Harmless to repeat.
    public func decline(_ ring: Ring) async throws {
        try await ringCall("v2/rings/decline", ring)
    }

    /// Rings waiting for this account's answer, newest first: for an app opened without a
    /// notification saying which.
    public func pendingRings() async throws -> [Ring] {
        struct Envelope: Decodable {
            let ringId: String
            let conversationId: String
            let from: String
            let fromName: String?
            let burstId: String?
            let pushSentAt: Double?
            let expiresAt: Double?
        }
        struct Response: Decodable { let rings: [Envelope] }
        let data = try await send(request("GET", "v2/rings/pending"))
        return try JSONDecoder().decode(Response.self, from: data).rings.map {
            Ring(conversationId: $0.conversationId, from: $0.from, fromName: $0.fromName ?? $0.from, ringId: $0.ringId,
                 burstId: $0.burstId, pushSentAt: $0.pushSentAt, expiresAt: $0.expiresAt)
        }
    }

    /// The held message for this ring, as relay records (the watch's prefetch).
    public func audioRequest(for ring: Ring) -> URLRequest? {
        guard var components = URLComponents(url: baseURL.appendingPathComponent("v2/rings/audio"), resolvingAgainstBaseURL: false) else { return nil }
        components.queryItems = [URLQueryItem(name: "conversationId", value: ring.conversationId),
                                 URLQueryItem(name: "ringId", value: ring.ringId)]
        guard let url = components.url else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 20)
        headers(&request)
        return request
    }

    /// GET /v2/time: (server time minus device time, round trip), both in ms.
    public func timeSample() async throws -> (offsetMs: Double, roundTripMs: Double) {
        let sentAt = Clock.nowMs()
        let data = try await send(request("GET", "v2/time"))
        let receivedAt = Clock.nowMs()
        let serverTime = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["serverTime"] as? Double ?? 0
        return (serverTime - (sentAt + receivedAt) / 2, receivedAt - sentAt)
    }

    /// POST /v2/metrics: a conversation's timeline (Timeline.upload).
    public func uploadTimeline(_ body: [String: any Sendable]) async throws {
        var request = request("POST", "v2/metrics")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        try await send(request)
    }

    private func ringCall(_ path: String, _ ring: Ring) async throws {
        var request = request("POST", path)
        request.httpBody = try JSONSerialization.data(withJSONObject: ["conversationId": ring.conversationId, "ringId": ring.ringId])
        try await send(request)
    }

    private func request(_ method: String, _ path: String) -> URLRequest {
        var request = URLRequest(url: baseURL.appendingPathComponent(path), timeoutInterval: 20)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        headers(&request)
        return request
    }

    private func headers(_ request: inout URLRequest) {
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        for (name, value) in identity.relayHeaders { request.setValue(value, forHTTPHeaderField: name) }
    }

    @discardableResult
    private func send(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw AccountAPIError(status: status, body: data) }
        return data
    }
}
