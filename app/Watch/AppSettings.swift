import Foundation
import OverAndOutKit

/// Where the relay is. It comes from the build (OAO_SERVER_HOST in the xcconfigs) on every
/// launch. Who this watch is and whom it talks to come from its account (WatchAccount).
struct AppSettings: Equatable {
    let serverHost: String

    /// This build's own relay. A server on this Mac (for the simulator) is reached over plain
    /// HTTP; everything else uses TLS.
    var bundledURL: URL? {
        guard !serverHost.isEmpty else { return nil }
        let local = serverHost.hasPrefix("localhost") || serverHost.hasPrefix("127.0.0.1")
        return URL(string: "\(local ? "http" : "https")://\(serverHost)")
    }

    /// The relay to use: the service's approved one (GET /v2/config, kept in the app group so the
    /// notification extension uses it too), else this build's own.
    var baseURL: URL? { Self.config.relayBaseURL }

    /// GET /v2/config's last good answer.
    static let config = ServiceConfigStore(bundledRelay: AppSettings.load().bundledURL,
                                           suiteName: Bundle.main.object(forInfoDictionaryKey: "OAOAppGroup") as? String)

    #if DEBUG
    static let apnsEnvironment = "sandbox"
    #else
    static let apnsEnvironment = "production"
    #endif

    static func load() -> AppSettings {
        AppSettings(serverHost: Bundle.main.object(forInfoDictionaryKey: "OAOServerHost") as? String ?? "")
    }
}
