import Foundation

/// HTTPS calls to the spike server. Plain HTTPS is allowed on watchOS at any time,
/// unlike the relay socket, which only works during a CallKit call (TN3135).
struct APIClient {
    let settings: SpikeSettings

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
            case .notConfigured: return "Server host isn't set"
            case let .http(status, body): return "HTTP \(status): \(body)"
            }
        }
    }

    func registerDevice(voipToken: String) async throws {
        try await send("POST", "/v1/devices", body: [
            "userId": settings.userId,
            "name": settings.displayName,
            "voipToken": voipToken,
            "apnsEnvironment": SpikeSettings.apnsEnvironment,
        ])
    }

    func users() async throws -> [User] {
        let data = try await send("GET", "/v1/users")
        return try JSONDecoder().decode([User].self, from: data)
    }

    /// Rings queued for this device when it registered without VoIP push.
    func polledRings() async throws -> [[String: Any]] {
        let data = try await send("GET", "/v1/rings/poll?userId=\(settings.userId)")
        return (try JSONSerialization.jsonObject(with: data) as? [[String: Any]]) ?? []
    }

    func uploadMetrics(_ upload: MetricsUpload) async throws {
        try await send("POST", "/v1/metrics", body: upload.json)
    }

    @discardableResult
    private func send(_ method: String, _ path: String, body: Any? = nil) async throws -> Data {
        guard let base = settings.baseURL, !settings.serverHost.isEmpty,
              let url = URL(string: path, relativeTo: base) else { throw APIError.notConfigured }
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
