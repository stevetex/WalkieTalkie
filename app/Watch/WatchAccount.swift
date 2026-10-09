import Combine
import Foundation
import OverAndOutKit
import WatchConnectivity

/// The watch's account (design decision 2026-09-27): its own session, made by the iPhone and
/// sent over WatchConnectivity, then refreshed with the API directly. The session lives in
/// the Keychain under the app group, so the notification service extension can use the
/// token too. Also the account's friends. Owned by the main actor; WatchConnectivity's
/// callbacks hand what they carry to it.
@MainActor
final class WatchAccount: NSObject, ObservableObject {
    static let shared = WatchAccount()

    @Published private(set) var session: AccountSession?
    @Published private(set) var friends: [Friend] = []
    @Published private(set) var friendsLoaded = false
    /// Waiting for the iPhone: "Open Nowza on your iPhone" until a session arrives.
    @Published private(set) var phoneSignedIn: Bool?
    /// The service no longer supports this build: the friends list asks for an update (which
    /// comes with the iPhone app's). The session stays.
    @Published private(set) var upgradeRequired = AppSettings.config.upgradeRequired

    /// Called whenever the session appears or changes hands, so the push token can be
    /// registered under the account.
    var onSessionChanged: ((AccountSession?) -> Void)?
    var onRefreshed: (() -> Void)?

    let deviceId = DeviceIdentity.id()
    let e2ee = E2EEKeyStore(accessGroup: Bundle.main.object(forInfoDictionaryKey: "OAOAppGroup") as? String)
    let trust = E2EETrust()
    let client: AccountClient?
    private let store: SessionStoring
    /// The request for a session the iPhone is answering, so asking again (by message, user
    /// info and context, or after a retry) gets the same session.
    private var sessionRequestId: String?

    private enum Key {
        static let friends = "friends"
        /// Whom Talk rang before the friends list (2026-09-29); removed on launch.
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
            friends = Friend.favoritesFirst(cached)
        }
        UserDefaults.standard.removeObject(forKey: Key.selectedFriend)
        NotificationCenter.default.addObserver(forName: AccountClient.signedOutNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.signedOut(askPhone: true) }
        }
        NotificationCenter.default.addObserver(forName: ServiceContract.upgradeRequiredNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.upgradeRequired = true }
        }
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
                                                              name: user, deviceId: deviceId)
                adopt(result.session)
            } catch {
                print("[oao] dev sign-in failed: \(error.localizedDescription)")
            }
        }
    }
    #endif

    /// On launch and whenever the app comes to the front: a day-old token is refreshed, the
    /// friends list reloaded, and the service's config read again (never on the ring path).
    func refresh() {
        guard session != nil, let client else { return askPhoneForSession() }
        if !hasKeys { askPhoneForSession() }
        Task {
            await AppSettings.config.refresh(apiBase: client.baseURL)
            upgradeRequired = upgradeRequired || AppSettings.config.upgradeRequired
            do {
                try await client.refreshIfNeeded()
                let loaded = try await client.friends()
                session = store.load()
                setFriends(loaded)
                onRefreshed?()
                await Self.whileIdle(client: client, friends: loaded)
            } catch {
                print("[oao] account refresh failed: \(error.localizedDescription)")
            }
        }
    }

    /// Only the friends list (and so their keys), for a Talk whose keys looked stale.
    func refreshFriends() async {
        guard session != nil, let client, let loaded = try? await client.friends() else { return }
        setFriends(loaded)
    }

    /// Off the main actor, after a refresh. Telemetry: queued events, and the diagnostics log
    /// if the server asked for it (tools/beta.ts pull, or Report a Problem on the iPhone).
    private nonisolated static func whileIdle(client: AccountClient, friends: [Friend]) async {
        Telemetry.shared.send = { events, device in try await client.sendEvents(events, device: device) }
        WatchDiagnostics.collectExtensionLines()
        await Telemetry.shared.flush()
        if let me = try? await client.me() {
            await Telemetry.shared.uploadIfRequested(requestedAt: me.diagnosticsRequestedAt) { data in
                try await client.uploadDiagnostics(data, platform: .watch)
            }
        }
        // Download changed photos now, while idle, so a ring never waits on one.
        for friend in friends {
            guard let version = friend.photoVersion else { continue }
            let id = friend.id
            _ = await PhotoCache.shared.photo(userId: id, version: version) { try await client.photo(userId: id) }
        }
    }

    /// A usable token for the relay, refreshed first only if it has already expired (rare:
    /// the app refreshes day-old tokens whenever it runs).
    func withToken(_ body: @escaping (AccountSession?) -> Void) {
        guard let session, session.isExpired, let client else { return body(self.session) }
        Task {
            let fresh = try? await client.refresh()
            self.session = fresh ?? store.load()
            body(self.session)
        }
    }

    func registerDevice(_ registration: DeviceRegistration) async throws {
        guard let client else { throw AccountAPIError.notSignedIn }
        try await client.registerDevice(registration)
    }

    private func setFriends(_ loaded: [Friend]) {
        // Favorites (starred on the iPhone) first in the friends list.
        friends = Friend.favoritesFirst(loaded)
        if let account = session?.userId {
            for friend in loaded {
                if let keys = friend.keys, trust.update(account: account, friend: friend.id, keys: keys, now: Int64(Clock.nowMs())) {
                    Telemetry.shared.event("keyChanged", ["friend": friend.id])
                } else if friend.keys == nil {
                    trust.missingKeys(account: account, friend: friend.id)
                }
            }
        }
        friendsLoaded = true
        if let data = try? JSONEncoder().encode(loaded) { UserDefaults.standard.set(data, forKey: Key.friends) }
    }

    // MARK: Getting a session from the iPhone

    private func adopt(_ new: AccountSession) {
        sessionRequestId = nil
        let changedAccount = session?.userId != new.userId
        store.save(new)
        session = new
        if changedAccount {
            friends = []
            friendsLoaded = false
        }
        updateContext()
        onSessionChanged?(new)
        refresh()
    }

    private func signedOut(askPhone: Bool) {
        let hadSession = session != nil
        if let old = session { e2ee.signOut(userId: old.userId, keepPhoneIdentity: false) }
        store.clear()
        // Messages the notification extension downloaded for this account.
        Prefetched.removeAll()
        session = nil
        friends = []
        friendsLoaded = false
        UserDefaults.standard.removeObject(forKey: Key.friends)
        if hadSession { onSessionChanged?(nil) }
        updateContext()
        if askPhone { askPhoneForSession() }
    }

    /// Signed in with this watch's device certificate. A watch signed in before E2EE (build
    /// 246) has a session but no certificate; it registers without keys, and friends' senders
    /// then refuse the whole account (`no-current-key`).
    private var hasKeys: Bool {
        guard let session else { return false }
        return (try? e2ee.sender(userId: session.userId, deviceId: deviceId)) != nil
    }

    /// Signed in without keys: the account whose certificates the iPhone is asked for (only
    /// those, so this session stays).
    private var needsKeysFor: String? {
        guard let session, !hasKeys else { return nil }
        return session.userId
    }

    /// Tells the iPhone this watch's device ID and whether it needs a session, or only its
    /// certificates. If the iPhone is reachable, also asks straight away and takes the reply.
    func askPhoneForSession() {
        guard session == nil || needsKeysFor != nil, WCSession.isSupported(),
              WCSession.default.activationState == .activated else { return }
        updateContext()
        guard WCSession.default.isReachable else { return }
        let signingKey = try? e2ee.watchSigningKey(deviceId: deviceId)
        var request: [String: Any] = [WatchLink.deviceId: deviceId, WatchLink.schemaVersion: WatchLink.currentSchemaVersion]
        if let account = needsKeysFor {
            request[WatchLink.request] = WatchLink.keysRequest
            request[WatchLink.keysFor] = account
        } else {
            let requestId = sessionRequestId ?? UUID().uuidString.lowercased()
            sessionRequestId = requestId
            request[WatchLink.request] = WatchLink.sessionRequest
            request[WatchLink.requestId] = requestId
        }
        request[WatchLink.signingKey] = signingKey
        // Both handlers run on a WatchConnectivity queue, so they're @Sendable, not main-actor.
        WCSession.default.sendMessage(request) { @Sendable [weak self] reply in
            let message = PhoneMessage(reply)
            DispatchQueue.main.async { self?.handle(message) }
        } errorHandler: { @Sendable error in
            print("[oao] asking the iPhone for a session failed: \(error.localizedDescription)")
        }
    }

    private func updateContext() {
        guard WCSession.isSupported(), WCSession.default.activationState == .activated else { return }
        var context: [String: Any] = [WatchLink.deviceId: deviceId, WatchLink.needsSession: session == nil,
                                      WatchLink.schemaVersion: WatchLink.currentSchemaVersion]
        context[WatchLink.keysFor] = needsKeysFor
        context[WatchLink.signingKey] = try? e2ee.watchSigningKey(deviceId: deviceId)
        try? WCSession.default.updateApplicationContext(context)
    }

    private func handle(_ message: PhoneMessage) {
        if let new = message.session, new.deviceId == deviceId {
            guard let phone = message.phoneCert, let device = message.deviceCert else {
                // Signed in already: keep that session, and don't ask in a loop (the next
                // launch or foreground asks again).
                if session == nil { askPhoneForSession() }
                return
            }
            do {
                _ = try e2ee.prepareWatch(userId: new.userId, deviceId: deviceId, phoneCert: phone,
                                          deviceCert: device, now: Int64(Clock.nowMs()))
            } catch {
                print("[oao] watch key provisioning failed: \(error)")
                return
            }
            adopt(new)
        } else if message.session == nil, let phone = message.phoneCert, let device = message.deviceCert,
                  let current = session, needsKeysFor == current.userId {
            // Only the certificates, for this session: register again, now with keys.
            do {
                _ = try e2ee.prepareWatch(userId: current.userId, deviceId: deviceId, phoneCert: phone,
                                          deviceCert: device, now: Int64(Clock.nowMs()))
            } catch {
                print("[oao] watch key provisioning failed: \(error)")
                return
            }
            Telemetry.shared.event("watchKeysProvisioned", [:])
            updateContext()
            onSessionChanged?(current)
        } else if message.signedOut {
            phoneSignedIn = false
            guard session != nil else { return }
            // Signed out on the iPhone: end this watch's session too.
            let client = client
            Task {
                await client?.signOut()
                signedOut(askPhone: false)
            }
        }
    }
}

/// What the iPhone sent (a reply, user info or a message), read where it arrived.
private struct PhoneMessage: Sendable {
    let session: AccountSession?
    let signedOut: Bool
    let phoneCert: Data?
    let deviceCert: Data?

    init(_ payload: [String: Any]) {
        session = (payload[WatchLink.session] as? Data).flatMap(WatchLink.decode)
        signedOut = payload[WatchLink.signedOut] as? Bool == true
        phoneCert = payload[WatchLink.phoneCert] as? Data
        deviceCert = payload[WatchLink.deviceCert] as? Data
    }
}

/// WatchConnectivity calls these on its own queue.
extension WatchAccount: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        let signedIn = session.receivedApplicationContext[WatchLink.signedIn] as? Bool
        DispatchQueue.main.async {
            self.phoneSignedIn = signedIn
            self.askPhoneForSession()
        }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        DispatchQueue.main.async { self.askPhoneForSession() }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        let signedIn = applicationContext[WatchLink.signedIn] as? Bool
        DispatchQueue.main.async {
            self.phoneSignedIn = signedIn
            if signedIn == true { self.askPhoneForSession() }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        let message = PhoneMessage(userInfo)
        DispatchQueue.main.async { self.handle(message) }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        let message = PhoneMessage(message)
        DispatchQueue.main.async { self.handle(message) }
    }
}
