import Foundation

/// Where the relay is. It comes from the build (OAO_SERVER_HOST in the xcconfigs) on every
/// launch. Who this watch is and whom it talks to come from its account (WatchAccount).
struct AppSettings: Equatable {
    let serverHost: String

    /// A server on this Mac (for the simulator) is reached over plain HTTP; everything
    /// else uses TLS.
    var baseURL: URL? {
        guard !serverHost.isEmpty else { return nil }
        let local = serverHost.hasPrefix("localhost") || serverHost.hasPrefix("127.0.0.1")
        return URL(string: "\(local ? "http" : "https")://\(serverHost)")
    }

    #if DEBUG
    static let apnsEnvironment = "sandbox"
    #else
    static let apnsEnvironment = "production"
    #endif

    static func load() -> AppSettings {
        AppSettings(serverHost: Bundle.main.object(forInfoDictionaryKey: "OAOServerHost") as? String ?? "")
    }
}
