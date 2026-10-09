import AVFoundation
import Foundation
import OverAndOutKit
import SwiftUI
import UserNotifications

/// The iPhone app's state: the account, friends and blocks, and an invite link being
/// opened. Everything else goes through AccountClient (OverAndOutKit).
@MainActor
final class AppModel: ObservableObject {
    struct PendingInvite: Identifiable, Equatable {
        let code: String
        let fingerprint: String?
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
    /// Your own profile photo's version, from /v2/me; nil without one.
    @Published private(set) var photoVersion: Double?
    /// Your built-in mascot picture, when you chose one instead of a photo.
    @Published private(set) var avatar: String?
    /// Which kind of device rings first, as chosen; nil = automatic (see `ringsOn`).
    @Published private(set) var preferredFormFactor: FormFactor?
    /// A ring the watch doesn't answer rolls over to this iPhone (design decision 2026-10-01).
    @Published private(set) var rollOver = false
    /// The kinds of device registered for rings on this account, from /v2/me (only the kinds
    /// this build knows).
    @Published private(set) var formFactors: [FormFactor] = []
    /// A watch and this iPhone can both ring: ask once which one (design decision 2026-09-28).
    @Published var askingRingOn = false
    /// When an invite was last made, so the friends list checks for the new friend meanwhile.
    @Published private(set) var lastInviteAt: Date?
    @Published private(set) var updatingPhoto = false
    @Published var pendingInvite: PendingInvite?
    @Published var errorMessage: String?
    /// The service no longer supports this build (GET /v2/config, or a client-upgrade-required
    /// answer): Friends asks for an update. The session stays.
    @Published private(set) var upgradeRequired = false
    /// Set by a deletion, so the root shows "Your account is deleted" before signing in again.
    @Published var accountDeleted = false
    /// Notifications not yet asked for, so Friends offers them (the walkie-talkie off notice).
    @Published private(set) var notificationsUndetermined = false
    /// Notifications turned off for Nowza, so the walkie-talkie-off notice can't show.
    @Published private(set) var notificationsDenied = false
    @AppStorage("onboarded") var onboarded = false

    let client: AccountClient
    /// GET /v2/config's last good answer: the relay to use, and the lowest supported build.
    let config: ServiceConfigStore
    let watch = PhoneWatchLink()
    let e2ee = E2EEKeyStore()
    let trust = E2EETrust()
    let pushToTalk = PushToTalkChannel()
    let talk: TalkController
    let deviceId = DeviceIdentity.id()
    let linkDomain: String
    /// A local API (the simulator) accepts "dev:" sign-ins without Apple.
    let isLocalServer: Bool

    private var signedOutObserver: NSObjectProtocol?
    private var upgradeObserver: NSObjectProtocol?
    /// The push registration last sent for this session, so it's sent only when it changes.
    private var registered: DeviceRegistration?
    /// Whether notifications are allowed, as the registration reports it.
    private var notificationPermission: DeviceRegistration.Notifications = .unknown
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
        linkDomain = info["OAOLinkDomain"] as? String ?? "nowza.app"
        isLocalServer = host.hasPrefix("localhost") || host.hasPrefix("127.0.0.1")
        let base = AccountClient.baseURL(host: host) ?? URL(string: "https://nowza.app")!
        client = AccountClient(baseURL: base, store: KeychainSessionStore())
        config = ServiceConfigStore(bundledRelay: AccountClient.baseURL(host: info["OAOServerHost"] as? String ?? ""))
        session = client.session
        upgradeRequired = config.upgradeRequired
        TalkController.configureAudioSession()
        talk = TalkController(client: client, config: config, ptt: pushToTalk,
                              e2ee: e2ee, trust: trust, deviceId: deviceId)
        if let session {
            _ = try? e2ee.preparePhone(userId: session.userId, deviceId: deviceId, now: Int64(Clock.nowMs()))
        }
        // Early, so the system can restore the channel and deliver its pushes.
        pushToTalk.onRegistrationChange = { [weak self] in
            guard let self else { return }
            Task { await self.registerDevice() }
            talk.pushToTalkChanged()
        }
        Telemetry.shared.send = { [client] events, device in try await client.sendEvents(events, device: device) }
        pushToTalk.onLeftUnexpectedly = { [weak self] _ in
            guard let self else { return }
            // On screen, Friends and Settings show it; otherwise say so at once (run 54).
            if UIApplication.shared.applicationState != .active {
                WalkieTalkieOffNotice.post(ringsWatch: watchCanRing)
            }
        }
        pushToTalk.start()
        watch.makeSession = { [client] deviceId, requestId in
            guard client.session != nil else { return nil }
            return try await client.makeSession(forDevice: deviceId, requestId: requestId)
        }
        watch.certifyWatch = { [e2ee] deviceId, account, signingKey in
            guard let session = self.client.session, account == nil || account == session.userId else {
                throw E2EEKeyStore.StoreError.notProvisioned
            }
            return try e2ee.certifyWatch(userId: session.userId, phoneDeviceId: session.deviceId,
                                         watchDeviceId: deviceId, signingKey: signingKey, now: Int64(Clock.nowMs()))
        }
        watch.activate(signedIn: session != nil)
        signedOutObserver = NotificationCenter.default.addObserver(
            forName: AccountClient.signedOutNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.didSignOut() }
        }
        upgradeObserver = NotificationCenter.default.addObserver(
            forName: ServiceContract.upgradeRequiredNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.upgradeRequired = true }
        }
        let config = config
        Task { [weak self] in
            await config.refresh(apiBase: base)
            self?.upgradeRequired = config.upgradeRequired
        }
    }

    var displayName: String { session?.name ?? "" }

    // MARK: Signing in and out

    func signIn(identityToken: String, nonce: String, name: String?) async {
        do {
            let result = try await client.signInWithApple(identityToken: identityToken, nonce: nonce, name: name, deviceId: deviceId)
            session = result.session
            if result.created { onboarded = false }
            await registerDevice()
            watch.signedInChanged(true)
            talk.appBecameActive()
            await refresh()
            if pendingInvite != nil { await loadPendingInvite() }
        } catch {
            errorMessage = describe(error)
        }
    }

    func signOut() async {
        watch.signedInChanged(false)
        if let session { e2ee.signOut(userId: session.userId, keepPhoneIdentity: true) }
        await client.signOut()
        didSignOut()
    }

    /// `authorizationCode` is from a fresh Sign in with Apple, so the server can revoke it.
    func deleteAccount(authorizationCode: String) async throws {
        let deleted = session
        try await client.deleteAccount(authorizationCode: authorizationCode)
        if let deleted { e2ee.signOut(userId: deleted.userId, keepPhoneIdentity: false) }
        watch.signedInChanged(false)
        accountDeleted = true
        didSignOut()
    }

    private func didSignOut() {
        if let session { e2ee.signOut(userId: session.userId, keepPhoneIdentity: true) }
        talk.signedOut()
        pushToTalk.turnOff()
        registered = nil
        session = nil
        photoVersion = nil
        avatar = nil
        preferredFormFactor = nil
        rollOver = false
        formFactors = []
        askingRingOn = false
        lastInviteAt = nil
        friends = []
        friendsLoaded = false
        blocks = []
        onboarded = false
    }

    // MARK: Profile, friends and blocks

    /// `quietly`: the refresh on coming to the foreground, which the person didn't ask for. Its
    /// failure (often the network not back yet after unlocking) goes to telemetry, not an alert.
    func refresh(quietly: Bool = false) async {
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
            avatar = user.avatar
            preferredFormFactor = user.preferredFormFactor.flatMap { $0.isKnown ? $0 : nil }
            rollOver = user.rollOver ?? false
            formFactors = user.knownFormFactors
            friends = loadedFriends
            if let account = session?.userId {
                for friend in loadedFriends {
                    if let keys = friend.keys, trust.update(account: account, friend: friend.id, keys: keys, now: Int64(Clock.nowMs())) {
                        Telemetry.shared.event("keyChanged", ["friend": friend.id])
                    } else if friend.keys == nil {
                        trust.missingKeys(account: account, friend: friend.id)
                    }
                }
            }
            blocks = loadedBlocks
            friendsLoaded = true
            askRingChoiceIfNeeded()
            // Apple Watch only keeps walkie-talkie off, also if it was turned on meanwhile (with
            // the watch unpaired, when the choice showed iPhone only).
            if askedRingOn, ringChoice == .watchOnly, pushToTalk.isAvailable, pushToTalk.isJoined || pushToTalk.wanted == true {
                pushToTalk.turnOff()
            }
            // The server asked for this iPhone's diagnostics log (tools/beta.ts pull).
            let client = client
            await Telemetry.shared.uploadIfRequested(requestedAt: user.diagnosticsRequestedAt) { data in
                try await client.uploadDiagnostics(data, platform: .iphone)
            }
        } catch {
            guard session != nil else { return }
            if quietly {
                Telemetry.shared.event("refreshFailed", ["error": Self.errorCode(error)])
            } else {
                errorMessage = describe(error)
            }
        }
    }

    /// Only the friends list, for the check after an invite.
    func refreshFriends() async {
        guard session != nil, let loaded = try? await client.friends() else { return }
        if let account = session?.userId {
            for friend in loaded {
                if let keys = friend.keys, trust.update(account: account, friend: friend.id, keys: keys, now: Int64(Clock.nowMs())) {
                    Telemetry.shared.event("keyChanged", ["friend": friend.id])
                } else if friend.keys == nil {
                    trust.missingKeys(account: account, friend: friend.id)
                }
            }
        }
        if loaded != friends { friends = loaded }
    }

    // MARK: Walkie-talkie on the iPhone

    /// On screen: back into the channel if the system's Leave button (or an update) left it,
    /// and whether notifications are still to be asked for.
    func becameActive() async {
        pushToTalk.rejoinIfWanted()
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        notificationsUndetermined = status == .notDetermined
        notificationsDenied = status == .denied
        let permission: DeviceRegistration.Notifications = status == .denied ? .denied : status == .notDetermined ? .unknown : .authorized
        if permission != notificationPermission {
            notificationPermission = permission
            await registerDevice()
        }
        await config.refresh(apiBase: client.baseURL)
        upgradeRequired = upgradeRequired || config.upgradeRequired
        if session != nil { await Telemetry.shared.flush() }
    }

    /// Settings → Report a Problem. With diagnostics, this iPhone sends its log at once; the
    /// server asks the watch for its own.
    func reportProblem(note: String, diagnostics: Bool) async -> Bool {
        do {
            try await client.sendFeedback(note: note, diagnostics: diagnostics, platform: .iphone)
            if diagnostics, let data = Telemetry.shared.log?.compressed() {
                try? await client.uploadDiagnostics(data, platform: .iphone)
                UserDefaults.standard.set(Clock.nowMs(), forKey: "diagnosticsUploadedAt")
            }
            return true
        } catch {
            errorMessage = describe(error)
            return false
        }
    }

    func allowNotifications() async {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
        await becameActive()
    }

    /// The kind of device that rings for this account, as the server decides it: the choice, or
    /// the watch if one is registered, else this iPhone.
    var ringsOn: FormFactor { preferredFormFactor ?? (formFactors.contains(.watch) ? .watch : .phone) }

    /// A watch that can ring: paired with this iPhone, with Nowza on it signed in.
    var watchCanRing: Bool { watch.isPaired && formFactors.contains(.watch) }

    /// "When Friends Ring You" (design decision 2026-10-02): the server's preferredFormFactor
    /// and rollOver as one choice. Without a watch that can ring, always iPhone only; with one
    /// and no choice made, Apple Watch only (the server rings the watch first, no rollover).
    var ringChoice: RingChoice {
        guard watchCanRing else { return .phoneOnly }
        if ringsOn == .phone { return .phoneOnly }
        return rollOver ? .watchThenPhone : .watchOnly
    }

    /// Whether this iPhone has asked (or the person chose in Settings) since a watch appeared.
    /// A new key for the three-way choice, so people who answered the old two-way question
    /// are asked once more.
    private var askedRingOn: Bool {
        get { session.map { UserDefaults.standard.bool(forKey: "askedRingChoice-\($0.userId)") } ?? true }
        set { if let session { UserDefaults.standard.set(newValue, forKey: "askedRingChoice-\(session.userId)") } }
    }

    /// Asks once where friends ring you: after a refresh, and when this iPhone's watch pairing
    /// becomes known (WatchConnectivity activates after launch). Only with a watch paired to this
    /// iPhone; the account can have a watch that isn't.
    func askRingChoiceIfNeeded() {
        if watchCanRing, formFactors.contains(.phone), !askedRingOn { askingRingOn = true }
    }

    func setRingChoice(_ choice: RingChoice) async {
        askedRingOn = true
        askingRingOn = false
        let previous = (choice: ringChoice, formFactor: preferredFormFactor, rollOver: rollOver)
        let formFactor: FormFactor = choice == .phoneOnly ? .phone : .watch
        preferredFormFactor = formFactor
        rollOver = choice == .watchThenPhone
        do {
            let user = try await client.setRingPreference(formFactor, rollOver: choice == .watchThenPhone)
            preferredFormFactor = user.preferredFormFactor.flatMap { $0.isKnown ? $0 : nil }
            rollOver = user.rollOver ?? false
            applyWalkieTalkie(for: choice, from: previous.choice)
        } catch {
            preferredFormFactor = previous.formFactor
            rollOver = previous.rollOver
            errorMessage = describe(error)
        }
    }

    /// Apple Watch only leaves the PushToTalk channel, so this iPhone can't ring while locked
    /// (Settings shows "Allow iPhone to Ring When Locked" off). Moving from it to a choice with
    /// the iPhone joins again; otherwise the toggle stays as the person set it.
    private func applyWalkieTalkie(for choice: RingChoice, from previous: RingChoice) {
        guard pushToTalk.isAvailable else { return }
        if choice == .watchOnly {
            pushToTalk.turnOff()
        } else if previous == .watchOnly, !pushToTalk.isJoined {
            pushToTalk.join()
        }
    }

    /// The channel's token while in it; otherwise rung only over the open stream while on screen.
    /// With it, whether notifications are allowed (the walkie-talkie-off notice needs them).
    /// Registers until what the server has matches the current state (the channel and its
    /// token change while a request is in flight).
    func registerDevice() async {
        guard !registering else { return }
        registering = true
        defer { registering = false }
        while session != nil {
            let joined = pushToTalk.isJoined ? pushToTalk.pushToken : nil
            let delivery: DeviceRegistration.Delivery = joined.map { .pushToTalk(token: $0, environment: Self.apnsEnvironment) } ?? .foreground
            let keys: E2EEKeyStore.Registration
            do {
                keys = try e2ee.preparePhone(userId: session!.userId, deviceId: deviceId, now: Int64(Clock.nowMs()))
            } catch {
                Telemetry.shared.event("e2eeFailed", ["reason": "key-storage"])
                reachability = "Not registered: this iPhone's keys couldn't be stored"
                break
            }
            let registration = DeviceRegistration(delivery: delivery, notifications: notificationPermission, e2ee: keys)
            if registered == registration { break }
            do {
                try await client.registerDevice(registration)
                if let userId = session?.userId {
                    let marker = "e2eePhoneEncCert-\(userId)"
                    let current = keys.encCert.base64EncodedString()
                    if let previous = UserDefaults.standard.string(forKey: marker), previous != current {
                        Telemetry.shared.event("keysRotated", [:])
                    }
                    UserDefaults.standard.set(current, forKey: marker)
                }
                registered = registration
                reachability = joined != nil ? "Walkie-talkie (PushToTalk)" : "Only while Nowza is open"
            } catch {
                reachability = "Not registered: \(describe(error))"
                print("[oao] Device registration failed: \(error)")
                Telemetry.shared.event("registrationFailed", ["pushType": delivery.label, "error": Self.errorCode(error)])
                break
            }
        }
    }

    func requestMicrophone() async {
        guard AVAudioApplication.shared.recordPermission == .undetermined else { return }
        _ = await AVAudioApplication.requestRecordPermission()
    }

    var microphoneAllowed: Bool { AVAudioApplication.shared.recordPermission == .granted }

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
            avatar = nil
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

    /// A built-in mascot as your picture, replacing any photo.
    func setAvatar(_ mascot: Mascot) async {
        updatingPhoto = true
        defer { updatingPhoto = false }
        do {
            let user = try await client.setAvatar(mascot)
            avatar = user.avatar
            photoVersion = user.photoVersion
        } catch {
            errorMessage = describe(error)
        }
    }

    func createInvite() async -> InviteLink? {
        do {
            guard let session, let sender = try e2ee.sender(userId: session.userId, deviceId: deviceId) else {
                throw E2EEKeyStore.StoreError.notProvisioned
            }
            var link = try await client.createInvite()
            guard var parts = URLComponents(url: link.url, resolvingAgainstBaseURL: false) else {
                throw E2EEKeyStore.StoreError.notProvisioned
            }
            parts.fragment = "k=" + E2EE.fingerprint(sender.phoneCertificate.identityKey)
            guard let url = parts.url else { throw E2EEKeyStore.StoreError.notProvisioned }
            link.url = url
            lastInviteAt = Date()
            return link
        } catch {
            errorMessage = describe(error)
            return nil
        }
    }

    /// Stars or unstars a friend, showing it at once.
    func setFavorite(_ friend: Friend, _ favorite: Bool) async {
        func apply(_ value: Bool) {
            guard let i = friends.firstIndex(where: { $0.id == friend.id }) else { return }
            friends[i].favorite = value ? true : nil
        }
        apply(favorite)
        do {
            try await client.setFavorite(friend.id, favorite)
        } catch {
            apply(!favorite)
            errorMessage = describe(error)
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

    /// https://nowza.app/i/<code>, from Messages (a universal link) or anywhere else.
    func open(_ url: URL) {
        guard url.host == linkDomain || url.host == "www.\(linkDomain)" else { return }
        let parts = url.pathComponents.filter { $0 != "/" }
        guard parts.count == 2, parts[0] == "i", !parts[1].isEmpty else { return }
        let fragment = URLComponents(url: url, resolvingAgainstBaseURL: false)?.fragment
        let fingerprint = fragment?.hasPrefix("k=") == true ? String(fragment!.dropFirst(2)) : nil
        if pendingInvite?.code == parts[1], pendingInvite?.fingerprint == fingerprint { return }
        pendingInvite = PendingInvite(code: parts[1], fingerprint: fingerprint)
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
        guard let invite = pendingInvite, let account = session?.userId else { return }
        let code = invite.code
        pendingInvite?.accepting = true
        do {
            let friend = try await client.acceptInvite(code: code)
            await refresh()
            if session?.userId == account {
                trust.checkInvite(account: account, friend: friend.id, fingerprint: invite.fingerprint)
            }
            if pendingInvite?.code == code, pendingInvite?.fingerprint == invite.fingerprint {
                pendingInvite?.accepted = friend
            }
        } catch {
            if pendingInvite?.code == code, pendingInvite?.fingerprint == invite.fingerprint {
                pendingInvite?.error = describe(error)
            }
        }
        if pendingInvite?.code == code, pendingInvite?.fingerprint == invite.fingerprint {
            pendingInvite?.accepting = false
        }
    }

    /// A short, name-free code for telemetry: the API's error code, or the error's domain and code.
    static func errorCode(_ error: Error) -> String {
        if let api = error as? AccountAPIError { return api.code }
        let ns = error as NSError
        return "\(ns.domain) \(ns.code)"
    }

    func describe(_ error: Error) -> String {
        if let urlError = error as? URLError {
            return urlError.code == .notConnectedToInternet ? "You're offline." : "Couldn't reach Nowza. Try again."
        }
        return (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}

/// How friends ring you, in Settings and asked once when a watch appears.
enum RingChoice: CaseIterable, Identifiable {
    case watchOnly, watchThenPhone, phoneOnly

    var id: Self { self }

    var title: String {
        switch self {
        case .watchOnly: return "Apple Watch Only"
        case .watchThenPhone: return "Apple Watch, Then iPhone"
        case .phoneOnly: return "iPhone Only"
        }
    }
}
