import Combine
import Foundation
import OverAndOutKit
import WatchConnectivity

/// The watch's account (design decision 2026-09-27): its own session, made by the iPhone and
/// sent over WatchConnectivity, then refreshed with the API directly. The session lives in
/// the Keychain under the app group, so the notification service extension can use the
/// token too. Also the account's friends, and the one picked for the Talk button.
final class WatchAccount: NSObject, ObservableObject {
    static let shared = WatchAccount()

    @Published private(set) var session: AccountSession?
    @Published private(set) var friends: [Friend] = []
    @Published private(set) var friendsLoaded = false
    @Published var selectedFriendId: String? {
        didSet { UserDefaults.standard.set(selectedFriendId, forKey: Key.selectedFriend) }
    }
    /// Waiting for the iPhone: "Open Over&Out on your iPhone" until a session arrives.
    @Published private(set) var phoneSignedIn: Bool?

    /// Called on the main queue whenever the session appears or changes hands, so the push
    /// token can be registered under the account.
    var onSessionChanged: ((AccountSession?) -> Void)?

    let deviceId = DeviceIdentity.id()
    let client: AccountClient?
    private let store: SessionStoring

    private enum Key {
        static let friends = "friends"
        static let selectedFriend = "selectedFriendId"
    }

    override init() {
        let info = Bundle.main.infoDictionary ?? [:]
        let store = KeychainSessionStore(accessGroup: info["OAOAppGroup"] as? String)
        self.store = store
        client = AccountClient.baseURL(host: info["OAOApiHost"] as? String ?? "").map { AccountClient(baseURL: $0, store: store) }
        super.init()
        session = store.load()
        if let data = UserDefaults.standard.data(forKey: Key.friends), let cached = try? JSONDecoder().decode([Friend].self, from: data) {
            friends = cached
        }
        selectedFriendId = UserDefaults.standard.string(forKey: Key.selectedFriend)
        NotificationCenter.default.addObserver(forName: AccountClient.signedOutNotification, object: nil, queue: .main) { [weak self] _ in
            self?.signedOut(askPhone: true)
        }
    }

    var selectedFriend: Friend? {
        friends.first { $0.id == selectedFriendId } ?? (friends.count == 1 ? friends.first : nil)
    }

    func name(of userId: String) -> String? {
        friends.first { $0.id == userId }?.name
    }

    func activate() {
        #if DEBUG
        devSignInIfAsked()
        #endif
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    #if DEBUG
    /// Simulator testing without WatchConnectivity: launched with OAO_DEV_USER=<name>
    /// (`SIMCTL_CHILD_OAO_DEV_USER=… xcrun simctl launch …`) against a local API run with
    /// DEV_APPLE_SIGNIN=1, the watch signs in as that dev user, the same account the
    /// iPhone app's dev sign-in makes for the same name.
    private func devSignInIfAsked() {
        guard session == nil, let user = ProcessInfo.processInfo.environment["OAO_DEV_USER"], !user.isEmpty,
              let client, ["localhost", "127.0.0.1"].contains(client.baseURL.host ?? "") else { return }
        let deviceId = deviceId
        Task {
            do {
                let result = try await client.signInWithApple(identityToken: "dev:\(user.lowercased())", nonce: "dev",
                                                              name: user, deviceId: deviceId, platform: .watch)
                await MainActor.run { self.adopt(result.session) }
            } catch {
                print("[oao] dev sign-in failed: \(error.localizedDescription)")
            }
        }
    }
    #endif

    /// On launch and whenever the app comes to the front: a day-old token is refreshed, and
    /// the friends list reloaded.
    func refresh() {
        guard session != nil, let client else { return askPhoneForSession() }
        Task {
            do {
                try await client.refreshIfNeeded()
                let loaded = try await client.friends()
                await MainActor.run {
                    self.session = self.store.load()
                    self.setFriends(loaded)
                }
                // Download changed photos now, while idle, so a ring never waits on one.
                for friend in loaded {
                    guard let version = friend.photoVersion else { continue }
                    let id = friend.id
                    _ = await PhotoCache.shared.photo(userId: id, version: version) { try await client.photo(userId: id) }
                }
            } catch {
                print("[oao] account refresh failed: \(error.localizedDescription)")
            }
        }
    }

    /// A usable token for the relay, refreshed first only if it has already expired (rare:
    /// the app refreshes day-old tokens whenever it runs).
    func withToken(_ body: @escaping (AccountSession?) -> Void) {
        guard let session, session.isExpired, let client else { return body(self.session) }
        Task {
            let fresh = try? await client.refresh()
            await MainActor.run {
                self.session = fresh ?? self.store.load()
                body(self.session)
            }
        }
    }

    func registerDevice(pushToken: String, apnsEnvironment: String) async throws {
        guard let client else { throw AccountAPIError.notSignedIn }
        try await client.registerDevice(platform: .watch, pushToken: pushToken, apnsEnvironment: apnsEnvironment)
    }

    private func setFriends(_ loaded: [Friend]) {
        friends = loaded
        friendsLoaded = true
        if let data = try? JSONEncoder().encode(loaded) { UserDefaults.standard.set(data, forKey: Key.friends) }
        if let selected = selectedFriendId, !loaded.contains(where: { $0.id == selected }) { selectedFriendId = nil }
    }

    // MARK: Getting a session from the iPhone

    private func adopt(_ new: AccountSession) {
        let changedAccount = session?.userId != new.userId
        store.save(new)
        session = new
        if changedAccount {
            friends = []
            friendsLoaded = false
            selectedFriendId = nil
        }
        updateContext()
        onSessionChanged?(new)
        refresh()
    }

    private func signedOut(askPhone: Bool) {
        let hadSession = session != nil
        store.clear()
        session = nil
        friends = []
        friendsLoaded = false
        selectedFriendId = nil
        UserDefaults.standard.removeObject(forKey: Key.friends)
        if hadSession { onSessionChanged?(nil) }
        updateContext()
        if askPhone { askPhoneForSession() }
    }

    /// Tells the iPhone this watch's device ID and whether it needs a session. If the iPhone
    /// is reachable, also asks straight away and takes the reply.
    func askPhoneForSession() {
        guard session == nil, WCSession.isSupported(), WCSession.default.activationState == .activated else { return }
        updateContext()
        guard WCSession.default.isReachable else { return }
        WCSession.default.sendMessage([WatchLink.request: WatchLink.sessionRequest, WatchLink.deviceId: deviceId]) { [weak self] reply in
            DispatchQueue.main.async { self?.handle(reply) }
        } errorHandler: { error in
            print("[oao] asking the iPhone for a session failed: \(error.localizedDescription)")
        }
    }

    private func updateContext() {
        guard WCSession.isSupported(), WCSession.default.activationState == .activated else { return }
        try? WCSession.default.updateApplicationContext([WatchLink.deviceId: deviceId, WatchLink.needsSession: session == nil])
    }

    private func handle(_ payload: [String: Any]) {
        if let data = payload[WatchLink.session] as? Data, let new = WatchLink.decode(data), new.deviceId == deviceId {
            adopt(new)
        } else if payload[WatchLink.signedOut] as? Bool == true {
            phoneSignedIn = false
            guard session != nil else { return }
            // Signed out on the iPhone: end this watch's session too.
            let client = client
            Task {
                await client?.signOut()
                await MainActor.run { self.signedOut(askPhone: false) }
            }
        }
    }
}

extension WatchAccount: WCSessionDelegate {
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        DispatchQueue.main.async {
            self.phoneSignedIn = session.receivedApplicationContext[WatchLink.signedIn] as? Bool
            self.askPhoneForSession()
        }
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        DispatchQueue.main.async { self.askPhoneForSession() }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        DispatchQueue.main.async {
            let signedIn = applicationContext[WatchLink.signedIn] as? Bool
            self.phoneSignedIn = signedIn
            if signedIn == true { self.askPhoneForSession() }
        }
    }

    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        DispatchQueue.main.async { self.handle(userInfo) }
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        DispatchQueue.main.async { self.handle(message) }
    }
}
