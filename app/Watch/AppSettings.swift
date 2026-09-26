import Foundation
import WatchKit

/// Who this watch is and whom it talks to, until the product has accounts (Sign in with
/// Apple, invites and friends). The server host and token come from the build
/// (Local.xcconfig) on every launch; the user ID is generated once per install, and the
/// friend is picked from the relay's user list in Settings.
struct AppSettings: Equatable {
    var userId: String
    var displayName: String
    var friendId: String
    var friendName: String

    let serverHost: String
    let token: String

    var hasFriend: Bool { !friendId.isEmpty }

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

    private enum Key {
        static let userId = "userId"
        static let displayName = "displayName"
        static let friendId = "friendId"
        static let friendName = "friendName"
    }

    static func load(_ defaults: UserDefaults = .standard) -> AppSettings {
        let info = Bundle.main.infoDictionary ?? [:]
        let userId = defaults.string(forKey: Key.userId) ?? {
            let generated = "watch-" + UUID().uuidString.prefix(4).lowercased()
            defaults.set(generated, forKey: Key.userId)
            return generated
        }()
        return AppSettings(
            userId: userId,
            displayName: defaults.string(forKey: Key.displayName) ?? WKInterfaceDevice.current().name,
            friendId: defaults.string(forKey: Key.friendId) ?? "",
            friendName: defaults.string(forKey: Key.friendName) ?? "",
            serverHost: info["OAOServerHost"] as? String ?? "",
            token: info["OAOServerToken"] as? String ?? ""
        )
    }

    func save(_ defaults: UserDefaults = .standard) {
        defaults.set(userId, forKey: Key.userId)
        defaults.set(displayName, forKey: Key.displayName)
        defaults.set(friendId, forKey: Key.friendId)
        defaults.set(friendName, forKey: Key.friendName)
    }
}
