import Foundation
import WatchKit

/// Spike configuration. Server host and token default to the values baked in from
/// Local.xcconfig; the user ID is generated once per install, and the friend is picked
/// from the server's user list, so nothing has to be typed on the watch.
struct SpikeSettings: Equatable {
    var serverHost: String
    var token: String
    var userId: String
    var displayName: String
    var friendId: String
    var friendName: String
    var conversationWindowSeconds: Int

    var isConfigured: Bool { !serverHost.isEmpty && !friendId.isEmpty }

    /// A server on this Mac (for the simulator) is reached over plain HTTP;
    /// everything else uses TLS.
    private var isLocalServer: Bool {
        serverHost.hasPrefix("localhost") || serverHost.hasPrefix("127.0.0.1")
    }

    var baseURL: URL? { URL(string: "\(isLocalServer ? "http" : "https")://\(serverHost)") }

    /// False when built with SPIKE_PUSH_MODE = none (no push entitlement).
    static let pushEnabled = (Bundle.main.object(forInfoDictionaryKey: "SpikePushMode") as? String) != "none"

    /// Without VoIP push (the simulator, or a no-push build), rings are collected by polling
    /// the server while the app is open.
    static var usesPolledRings: Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        return !pushEnabled
        #endif
    }

    #if DEBUG
    static let apnsEnvironment = "sandbox"
    #else
    static let apnsEnvironment = "production"
    #endif

    private enum Key {
        static let serverHost = "serverHost"
        static let token = "token"
        static let userId = "userId"
        static let displayName = "displayName"
        static let friendId = "friendId"
        static let friendName = "friendName"
        static let window = "conversationWindowSeconds"
    }

    static func load(_ defaults: UserDefaults = .standard) -> SpikeSettings {
        let info = Bundle.main.infoDictionary ?? [:]
        let userId = defaults.string(forKey: Key.userId) ?? {
            let generated = "watch-" + UUID().uuidString.prefix(4).lowercased()
            defaults.set(generated, forKey: Key.userId)
            return generated
        }()
        let window = defaults.integer(forKey: Key.window)
        return SpikeSettings(
            serverHost: defaults.string(forKey: Key.serverHost) ?? (info["SpikeServerHost"] as? String ?? ""),
            token: defaults.string(forKey: Key.token) ?? (info["SpikeToken"] as? String ?? ""),
            userId: userId,
            displayName: defaults.string(forKey: Key.displayName) ?? WKInterfaceDevice.current().name,
            friendId: defaults.string(forKey: Key.friendId) ?? "",
            friendName: defaults.string(forKey: Key.friendName) ?? "",
            conversationWindowSeconds: window > 0 ? window : 45
        )
    }

    func save(_ defaults: UserDefaults = .standard) {
        defaults.set(serverHost, forKey: Key.serverHost)
        defaults.set(token, forKey: Key.token)
        defaults.set(userId, forKey: Key.userId)
        defaults.set(displayName, forKey: Key.displayName)
        defaults.set(friendId, forKey: Key.friendId)
        defaults.set(friendName, forKey: Key.friendName)
        defaults.set(conversationWindowSeconds, forKey: Key.window)
    }
}
