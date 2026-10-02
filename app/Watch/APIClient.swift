import Foundation
import OverAndOutKit

/// HTTPS calls to the relay (clock samples and timelines), with the account's session token
/// and this build's admission headers (the kit's RelayAPI). Plain HTTPS works on watchOS at any
/// time, unlike WebSockets (TN3135). Account calls go to the account API through AccountClient
/// instead.
struct APIClient {
    let settings: AppSettings
    let token: String?

    enum APIError: LocalizedError {
        case notConfigured

        var errorDescription: String? {
            switch self {
            case .notConfigured: return "The server isn't configured in this build, or not signed in"
            }
        }
    }

    private func relay() throws -> RelayAPI {
        guard let base = settings.baseURL, let token, !token.isEmpty else { throw APIError.notConfigured }
        return RelayAPI(baseURL: base, token: token)
    }

    /// One clock sample: (server time minus device time, round trip), both in ms.
    func timeSample() async throws -> (offsetMs: Double, roundTripMs: Double) {
        try await relay().timeSample()
    }

    func uploadMetrics(_ body: [String: any Sendable]) async throws {
        try await relay().uploadTimeline(body)
    }
}
