import Foundation
import Testing
@testable import OverAndOutKit

/// Serves canned responses in order and records the requests.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    struct Reply { let status: Int; let json: String }
    nonisolated(unsafe) static var replies: [Reply] = []
    nonisolated(unsafe) static var requests: [URLRequest] = []
    static let lock = NSLock()

    static func reset(_ replies: [Reply]) {
        lock.withLock {
            self.replies = replies
            requests = []
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let reply: Reply = Self.lock.withLock {
            Self.requests.append(request)
            return Self.replies.isEmpty ? Reply(status: 500, json: "{}") : Self.replies.removeFirst()
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(reply.json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@Suite(.serialized)
struct AccountTests {
    let base = URL(string: "https://overandout.test")!

    func client(_ store: SessionStoring) -> AccountClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return AccountClient(baseURL: base, store: store, urlSession: URLSession(configuration: config))
    }

    /// Whole milliseconds, as the server and the Keychain encoding keep them.
    func session(expiresIn: TimeInterval) -> AccountSession {
        let ms = ((Date().timeIntervalSince1970 + expiresIn) * 1000).rounded()
        return AccountSession(token: "old", expiresAt: Date(timeIntervalSince1970: ms / 1000), userId: "u_a", name: "Alice", deviceId: "phone")
    }

    @Test func photosUploadAsJPEGAndFriendsCarryTheirVersion() async throws {
        let store = MemorySessionStore()
        store.save(session(expiresIn: 3600))
        StubProtocol.reset([
            .init(status: 200, json: #"{"photoVersion":1790000000000}"#),
            .init(status: 200, json: #"{"friends":[{"id":"u_b","name":"Bob","since":1,"photoVersion":1790000000001},{"id":"u_c","name":"Carol","since":2}]}"#),
            .init(status: 200, json: "jpeg bytes"),
        ])
        let c = client(store)
        let jpeg = Data([0xff, 0xd8, 0xff, 0xd9])
        #expect(try await c.setPhoto(jpeg: jpeg) == 1_790_000_000_000)
        let upload = StubProtocol.requests[0]
        #expect(upload.httpMethod == "PUT")
        #expect(upload.url?.path == "/v1/me/photo")
        #expect(upload.value(forHTTPHeaderField: "Content-Type") == "image/jpeg")
        #expect(try upload.bodyStreamData() == jpeg)
        let friends = try await c.friends()
        #expect(friends.map(\.photoVersion) == [1_790_000_000_001, nil])
        #expect(try await c.photo(userId: "u_b") == Data("jpeg bytes".utf8))
        #expect(StubProtocol.requests[2].url?.path == "/v1/users/u_b/photo")
    }

    @Test func signInStoresTheSession() async throws {
        let store = MemorySessionStore()
        StubProtocol.reset([.init(status: 200, json: #"{"token":"t1","expiresAt":1792000000000,"user":{"id":"u_a","name":"Alice"},"created":true}"#)])
        let result = try await client(store).signInWithApple(identityToken: "id", nonce: "n", name: "Alice", deviceId: "phone", platform: .iphone)
        #expect(result.created)
        #expect(store.load()?.token == "t1")
        #expect(store.load()?.expiresAt == Date(timeIntervalSince1970: 1_792_000_000))
        let body = try JSONSerialization.jsonObject(with: StubProtocol.requests[0].bodyStreamData()) as? [String: Any]
        #expect(body?["platform"] as? String == "iphone")
        #expect(StubProtocol.requests[0].value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test func anExpiredTokenIsRefreshedAndTheCallRetried() async throws {
        let store = MemorySessionStore(session(expiresIn: 29 * 24 * 3600))
        StubProtocol.reset([
            .init(status: 401, json: #"{"error":"token-expired"}"#),
            .init(status: 200, json: #"{"token":"new","expiresAt":1792000000000}"#),
            .init(status: 200, json: #"{"friends":[{"id":"u_b","name":"Bob","since":1}]}"#),
        ])
        let friends = try await client(store).friends()
        #expect(friends.map(\.name) == ["Bob"])
        #expect(store.load()?.token == "new")
        #expect(StubProtocol.requests.map { $0.url!.path } == ["/v1/friends", "/v1/auth/refresh", "/v1/friends"])
        #expect(StubProtocol.requests[2].value(forHTTPHeaderField: "Authorization") == "Bearer new")
    }

    @Test func aDayOldTokenIsRefreshed() async throws {
        let store = MemorySessionStore(session(expiresIn: 28 * 24 * 3600))
        StubProtocol.reset([.init(status: 200, json: #"{"token":"new","expiresAt":1792000000000}"#)])
        try await client(store).refreshIfNeeded()
        #expect(store.load()?.token == "new")

        store.save(session(expiresIn: AccountSession.lifetime - 60))
        StubProtocol.reset([])
        try await client(store).refreshIfNeeded()
        #expect(StubProtocol.requests.isEmpty)
    }

    @Test func anEndedSessionSignsOut() async throws {
        let store = MemorySessionStore(session(expiresIn: 29 * 24 * 3600))
        StubProtocol.reset([.init(status: 401, json: #"{"error":"session-ended"}"#)])
        await #expect(throws: AccountAPIError.self) { try await client(store).friends() }
        #expect(store.load() == nil)
    }

    @Test func errorsCarryTheServersCode() async throws {
        let store = MemorySessionStore(session(expiresIn: 29 * 24 * 3600))
        StubProtocol.reset([.init(status: 404, json: #"{"error":"invite-not-found","message":"invite-not-found"}"#)])
        do {
            _ = try await client(store).acceptInvite(code: "abc")
            Issue.record("expected an error")
        } catch let error as AccountAPIError {
            #expect(error.code == "invite-not-found")
            #expect(error.errorDescription?.contains("expired") == true)
            #expect(!error.endsSession)
        }
        #expect(store.load() != nil)
    }

    @Test func sessionsCrossToTheWatchIntact() {
        let original = session(expiresIn: 1000)
        let data = WatchLink.encode(original)!
        #expect(WatchLink.decode(data) == original)
    }
}

private extension URLRequest {
    /// URLProtocol sees the body as a stream.
    func bodyStreamData() -> Data {
        if let httpBody { return httpBody }
        guard let stream = httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}
