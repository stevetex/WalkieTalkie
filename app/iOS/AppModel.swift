import AVFoundation
import Foundation
import OverAndOutKit
import SwiftUI

/// The iPhone app's state: the account, friends and blocks, and an invite link being
/// opened. Everything else goes through AccountClient (OverAndOutKit).
@MainActor
final class AppModel: ObservableObject {
    struct PendingInvite: Identifiable, Equatable {
        let code: String
        var info: InviteInfo?
        var error: String?
        var accepting = false
        var accepted: Friend?
        var id: String { code }
    }

    /// One model for the app's life, made at launch by AppDelegate: a PushToTalk push can
    /// launch the app in the background, where SwiftUI doesn't build the scene (or its state
    /// objects), and the channel manager must exist to receive it.
    static let shared = AppModel()

    @Published private(set) var session: AccountSession?
    @Published private(set) var friends: [Friend] = []
    @Published private(set) var friendsLoaded = false
    @Published private(set) var blocks: [BlockedUser] = []
    /// Your own profile photo's version, from /v1/me; nil without one.
    @Published private(set) var photoVersion: Double?
    /// Which device rings, as chosen; nil = the default (see `ringsOn`).
    @Published private(set) var ringOn: Platform?
    @Published private(set) var updatingPhoto = false
    @Published var pendingInvite: PendingInvite?
    @Published var errorMessage: String?
    /// Set by a deletion, so the root shows "Your account is deleted" before signing in again.
    @Published var accountDeleted = false
    @AppStorage("onboarded") var onboarded = false

    let client: AccountClient
    let watch = PhoneWatchLink()
    let pushToTalk = PushToTalkChannel()
    let talk: TalkController
    let deviceId = DeviceIdentity.id()
    let linkDomain: String
    /// A local API (the simulator) accepts "dev:" sign-ins without Apple.
    let isLocalServer: Bool

    private var signedOutObserver: NSObjectProtocol?
    /// The push registration last sent for this session, so it's sent only when it changes.
    private var registered: (token: String, pushType: String?)?
    /// One registration at a time, so an older one can't land after a newer one.
    private var registering = false
    /// How friends reach this iPhone, as last registered, for Settings.
    @Published private(set) var reachability = ""

    #if DEBUG
    static let apnsEnvironment = "sandbox"
    #else
    static let apnsEnvironment = "production"
    #endif

    init() {
        let info = Bundle.main.infoDictionary ?? [:]
        let host = info["OAOApiHost"] as? String ?? ""
        linkDomain = info["OAOLinkDomain"] as? String ?? "overandout.app"
        isLocalServer = host.hasPrefix("localhost") || host.hasPrefix("127.0.0.1")
        let base = AccountClient.baseURL(host: host) ?? URL(string: "https://overandout.app")!
        client = AccountClient(baseURL: base, store: KeychainSessionStore())
        session = client.session
        TalkController.configureAudioSession()
        talk = TalkController(client: client, relayHost: info["OAOServerHost"] as? String ?? "", ptt: pushToTalk)
        // Early, so the system can restore the channel and deliver its pushes.
        pushToTalk.onRegistrationChange = { [weak self] in
            guard let self else { return }
            Task { await self.registerDevice() }
            talk.pushToTalkChanged()
        }
        pushToTalk.start()
        watch.makeSession = { [client] deviceId in
            guard client.session != nil else { return nil }
            return try await client.makeSession(forDevice: deviceId, platform: .watch)
        }
        watch.activate(signedIn: session != nil)
        signedOutObserver = NotificationCenter.default.addObserver(
            forName: AccountClient.signedOutNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.didSignOut() }
        }
    }

    var displayName: String { session?.name ?? "" }

    // MARK: Signing in and out

    func signIn(identityToken: String, nonce: String, name: String?) async {
        do {
            let result = try await client.signInWithApple(identityToken: identityToken, nonce: nonce, name: name,
                                                          deviceId: deviceId, platform: .iphone)
            session = result.session
            if result.created { onboarded = false }
            watch.signedInChanged(true)
            await registerDevice()
            talk.appBecameActive()
            await refresh()
            if pendingInvite != nil { await loadPendingInvite() }
        } catch {
            errorMessage = describe(error)
        }
    }

    func signOut() async {
        watch.signedInChanged(false)
        await client.signOut()
        didSignOut()
    }

    /// `authorizationCode` is from a fresh Sign in with Apple, so the server can revoke it.
    func deleteAccount(authorizationCode: String) async throws {
        try await client.deleteAccount(authorizationCode: authorizationCode)
        watch.signedInChanged(false)
        accountDeleted = true
        didSignOut()
    }

    private func didSignOut() {
        talk.signedOut()
        pushToTalk.leave()
        registered = nil
        session = nil
        photoVersion = nil
        ringOn = nil
        friends = []
        friendsLoaded = false
        blocks = []
        onboarded = false
    }

    // MARK: Profile, friends and blocks

    func refresh() async {
        guard session != nil else { return }
        do {
            try await client.refreshIfNeeded()
            async let me = client.me()
            async let friendList = client.friends()
            async let blockList = client.blocks()
            let (user, loadedFriends, loadedBlocks) = try await (me, friendList, blockList)
            session = client.session
            if user.name != session?.name { session?.name = user.name }
            photoVersion = user.photoVersion
            ringOn = user.ringOn
            friends = loadedFriends
            blocks = loadedBlocks
            friendsLoaded = true
        } catch {
            if session != nil { errorMessage = describe(error) }
        }
    }

    // MARK: Walkie-talkie on the iPhone

    /// The device that rings for this account: the choice, or the watch if there is one.
    var ringsOn: Platform { ringOn ?? (watch.isWatchAppInstalled ? .watch : .iphone) }

    func setRingOn(_ platform: Platform) async {
        let previous = ringOn
        ringOn = platform
        do {
            ringOn = try await client.setRingOn(platform).ringOn
        } catch {
            ringOn = previous
            errorMessage = describe(error)
        }
    }

    /// The channel's token while in it; otherwise "app:", reachable only while on screen.
    /// Registers until what the server has matches the current state (the channel and its
    /// token change while a request is in flight).
    func registerDevice() async {
        guard !registering else { return }
        registering = true
        defer { registering = false }
        while session != nil {
            let joined = pushToTalk.isJoined ? pushToTalk.pushToken : nil
            let token = joined ?? "app:"
            let pushType = joined == nil ? nil : "pushtotalk"
            if let registered, registered.token == token, registered.pushType == pushType { break }
            do {
                try await client.registerDevice(platform: .iphone, pushToken: token, pushType: pushType, apnsEnvironment: Self.apnsEnvironment)
                registered = (token, pushType)
                reachability = joined != nil ? "Walkie-talkie (PushToTalk)" : "Only while Over&Out is open"
            } catch {
                reachability = "Not registered: \(describe(error))"
                print("[oao] Device registration failed: \(error)")
                break
            }
        }
    }

    func requestMicrophone() async {
        guard AVAudioSession.sharedInstance().recordPermission == .undetermined else { return }
        _ = await withCheckedContinuation { continuation in
            AVAudioSession.sharedInstance().requestRecordPermission { continuation.resume(returning: $0) }
        }
    }

    var microphoneAllowed: Bool { AVAudioSession.sharedInstance().recordPermission == .granted }

    func rename(_ name: String) async -> Bool {
        do {
            _ = try await client.rename(name)
            session = client.session
            return true
        } catch {
            errorMessage = describe(error)
            return false
        }
    }

    /// Crops and uploads a new profile photo; friends see it on their next friends refresh.
    func setPhoto(_ image: UIImage) async {
        guard let jpeg = ProfilePhoto.jpeg(from: image), let userId = session?.userId else {
            errorMessage = "That photo couldn't be used. Try another one."
            return
        }
        updatingPhoto = true
        defer { updatingPhoto = false }
        do {
            let version = try await client.setPhoto(jpeg: jpeg)
            await PhotoCache.shared.store(jpeg, userId: userId, version: version)
            photoVersion = version
        } catch {
            errorMessage = describe(error)
        }
    }

    func removePhoto() async {
        updatingPhoto = true
        defer { updatingPhoto = false }
        do {
            try await client.removePhoto()
            photoVersion = nil
        } catch {
            errorMessage = describe(error)
        }
    }

    func createInvite() async -> InviteLink? {
        do {
            return try await client.createInvite()
        } catch {
            errorMessage = describe(error)
            return nil
        }
    }

    func removeFriend(_ friend: Friend) async {
        await perform { try await self.client.removeFriend(friend.id) }
    }

    func block(_ id: String) async {
        await perform { try await self.client.block(id) }
    }

    func unblock(_ id: String) async {
        await perform { try await self.client.unblock(id) }
    }

    func report(_ friend: Friend, reason: ReportReason, note: String, alsoBlock: Bool) async -> Bool {
        do {
            try await client.report(friend.id, reason: reason, note: note, alsoBlock: alsoBlock)
            await refresh()
            return true
        } catch {
            errorMessage = describe(error)
            return false
        }
    }

    private func perform(_ action: @escaping () async throws -> Void) async {
        do {
            try await action()
        } catch {
            errorMessage = describe(error)
        }
        await refresh()
    }

    // MARK: Invite links

    /// https://overandout.app/i/<code>, from Messages (a universal link) or anywhere else.
    func open(_ url: URL) {
        guard url.host == linkDomain || url.host == "www.\(linkDomain)" else { return }
        let parts = url.pathComponents.filter { $0 != "/" }
        guard parts.count == 2, parts[0] == "i", !parts[1].isEmpty else { return }
        if pendingInvite?.code == parts[1] { return }
        pendingInvite = PendingInvite(code: parts[1])
        if session != nil { Task { await loadPendingInvite() } }
    }

    func loadPendingInvite() async {
        guard let code = pendingInvite?.code else { return }
        do {
            let info = try await client.invite(code: code)
            if pendingInvite?.code == code { pendingInvite?.info = info }
        } catch {
            if pendingInvite?.code == code { pendingInvite?.error = describe(error) }
        }
    }

    func acceptPendingInvite() async {
        guard let code = pendingInvite?.code else { return }
        pendingInvite?.accepting = true
        do {
            let friend = try await client.acceptInvite(code: code)
            pendingInvite?.accepted = friend
            await refresh()
        } catch {
            pendingInvite?.error = describe(error)
        }
        pendingInvite?.accepting = false
    }

    func describe(_ error: Error) -> String {
        if let urlError = error as? URLError {
            return urlError.code == .notConnectedToInternet ? "You're offline." : "Couldn't reach Over&Out. Try again."
        }
        return (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}
