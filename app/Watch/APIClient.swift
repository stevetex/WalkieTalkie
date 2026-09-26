import Foundation

/// HTTPS calls to the relay server. Plain HTTPS works on watchOS at any time, unlike
/// WebSockets (TN3135).
struct APIClient {
    let settings: AppSettings

    struct User: Decodable, Identifiable, Hashable {
        let userId: String
        let name: String
        var id: String { userId }
    }

    enum APIError: LocalizedError {
        case notConfigured
        case http(Int, String)

        var errorDescription: String? {
            switch self {
            case .notConfigured: return "The server isn't configured in this build"
            case let .http(status, body): return "HTTP \(status): \(body)"
            }
        }
    }

    /// `pushToken` is an APNs device token, or a pseudo-token for a watch that can't get one
    /// (see ConversationController.registerForRings).
    func registerDevice(pushToken: String) async throws {
        try await send("POST", "/v1/devices", body: [
            "userId": settings.userId,
            "name": settings.displayName,
            "pushToken": pushToken,
            "apnsEnvironment": AppSettings.apnsEnvironment,
        ])
    }

    func users() async throws -> [User] {
        let data = try await send("GET", "/v1/users")
        return try JSONDecoder().decode([User].self, from: data)
    }

    /// One clock sample: (server time minus device time, round trip), both in ms.
    func timeSample() async throws -> (offsetMs: Double, roundTripMs: Double) {
        let sentAt = Date().timeIntervalSince1970 * 1000
        let data = try await send("GET", "/v1/time")
        let receivedAt = Date().timeIntervalSince1970 * 1000
        let serverTime = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["serverTime"] as? Double ?? 0
        return (serverTime - (sentAt + receivedAt) / 2, receivedAt - sentAt)
    }

    func uploadMetrics(_ body: [String: Any]) async throws {
        try await send("POST", "/v1/metrics", body: body)
    }

    @discardableResult
    private func send(_ method: String, _ path: String, body: Any? = nil) async throws -> Data {
        guard let base = settings.baseURL, let url = URL(string: path, relativeTo: base) else {
            throw APIError.notConfigured
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !settings.token.isEmpty {
            request.setValue("Bearer \(settings.token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw APIError.http(status, String(decoding: data, as: UTF8.self))
        }
        return data
    }
}
