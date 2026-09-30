import Foundation
import os
import Testing
@testable import OverAndOutKit

/// Serves canned responses in order and records the requests. A `held` reply waits for
/// `releaseHeld()`, to finish a request after something else has happened. The suite runs
/// serialized, so one test's replies can't answer another's requests.
///
/// `@unchecked Sendable`: URLProtocol isn't Sendable, and a held reply finishes on the test's
/// task. This subclass adds no stored state; the shared replies and requests are behind `state`.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    struct Reply: Sendable { let status: Int; let json: String; var held = false }

    private struct State {
        var replies: [Reply] = []
        var requests: [URLRequest] = []
        var held: [@Sendable () -> Void] = []
    }

    private static let state = OSAllocatedUnfairLock(initialState: State())

    static var requests: [URLRequest] { state.withLock { $0.requests } }

    static func reset(_ replies: [Reply]) {
        state.withLock { $0 = State(replies: replies) }
    }

    static func waitUntilHeld() async {
        while state.withLock({ $0.held.isEmpty }) { try? await Task.sleep(nanoseconds: 1_000_000) }
    }

    static func releaseHeld() {
        // A named parameter: Swift 6.2 (Xcode 26) rejects $0 inside the defer.
        let replies = state.withLock { locked in
            defer { locked.held = [] }
            return locked.held
        }
        replies.forEach { $0() }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let request = request
        let reply: Reply = Self.state.withLock {
            $0.requests.append(request)
            return $0.replies.isEmpty ? Reply(status: 500, json: "{}") : $0.replies.removeFirst()
        }
        let finish: @Sendable () -> Void = { [self] in
            let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: nil, headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(reply.json.utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
        if reply.held {
            Self.state.withLock { $0.held.append(finish) }
        } else {
            finish()
        }
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

    @Test func ringOnIsSetAndClearedAndPushTypeIsSent() async throws {
        let store = MemorySessionStore()
        store.save(session(expiresIn: 3600))
        StubProtocol.reset([
            .init(status: 200, json: #"{"id":"u_a","name":"Alice","ringOn":"iphone"}"#),
            .init(status: 200, json: #"{"id":"u_a","name":"Alice"}"#),
            .init(status: 200, json: "{}"),
        ])
        let c = client(store)
        #expect(try await c.setRingOn(.iphone).ringOn == .iphone)
        #expect(try await c.setRingOn(nil).ringOn == nil)
        try await c.registerDevice(platform: .iphone, pushToken: "abc", pushType: "pushtotalk", apnsEnvironment: "sandbox")
        let bodies = StubProtocol.requests.map { request -> [String: Any] in
            let data = request.httpBodyStream.map { stream -> Data in
                stream.open()
                defer { stream.close() }
                var data = Data()
                var buffer = [UInt8](repeating: 0, count: 1024)
                while stream.hasBytesAvailable {
                    let n = stream.read(&buffer, maxLength: buffer.count)
                    if n <= 0 { break }
                    data.append(buffer, count: n)
                }
                return data
            } ?? request.httpBody ?? Data()
            return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        }
        #expect(bodies[0]["ringOn"] as? String == "iphone")
        #expect(bodies[1]["ringOn"] is NSNull)
        #expect(bodies[2]["pushType"] as? String == "pushtotalk")
        #expect(StubProtocol.requests[2].httpMethod == "PUT")
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
        #expect(upload.bodyStreamData() == jpeg)
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

    @Test func aRefreshInFlightDoesNotBringBackASessionThatSignedOut() async throws {
        let store = MemorySessionStore(session(expiresIn: 28 * 24 * 3600))
        StubProtocol.reset([
            .init(status: 200, json: #"{"token":"new","expiresAt":1792000000000}"#, held: true),
            .init(status: 200, json: "{}"),
        ])
        let c = client(store)
        let refreshing = Task { try await c.refresh() }
        await StubProtocol.waitUntilHeld()
        await c.signOut()
        #expect(store.load() == nil)
        StubProtocol.releaseHeld()
        _ = try? await refreshing.value
        #expect(store.load() == nil)
        #expect(StubProtocol.requests.map { $0.url!.path } == ["/v1/auth/refresh", "/v1/auth/signout"])
    }

    @Test func aResponseForTheOldSessionLeavesAnotherAccountsSessionAlone() async throws {
        let store = MemorySessionStore(session(expiresIn: 28 * 24 * 3600))
        let other = AccountSession(token: "bob", expiresAt: Date(timeIntervalSince1970: 1_792_000_000),
                                   userId: "u_b", name: "Bob", deviceId: "phone")
        // The refresh finishes after another account's session was stored (by the store's
        // other user, so the client can't know): it isn't saved over Bob's.
        StubProtocol.reset([.init(status: 200, json: #"{"token":"new","expiresAt":1792000000000}"#, held: true)])
        let c = client(store)
        let refreshing = Task { try await c.refresh() }
        await StubProtocol.waitUntilHeld()
        store.save(other)
        StubProtocol.releaseHeld()
        await #expect(throws: AccountAPIError.self) { try await refreshing.value }
        #expect(store.load() == other)

        // Nor does the old session's "signed out" sign Bob out.
        store.save(session(expiresIn: 29 * 24 * 3600))
        StubProtocol.reset([.init(status: 401, json: #"{"error":"session-ended"}"#, held: true)])
        let listing = Task { try await c.friends() }
        await StubProtocol.waitUntilHeld()
        store.save(other)
        StubProtocol.releaseHeld()
        await #expect(throws: AccountAPIError.self) { try await listing.value }
        #expect(store.load() == other)
    }

    @Test func sessionsCrossToTheWatchIntact() {
        let original = session(expiresIn: 1000)
        let data = WatchLink.encode(original)!
        #expect(WatchLink.decode(data) == original)
    }
}

extension URLRequest {
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
