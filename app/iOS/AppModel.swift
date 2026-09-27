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

    @Published private(set) var session: AccountSession?
    @Published private(set) var friends: [Friend] = []
    @Published private(set) var friendsLoaded = false
    @Published private(set) var blocks: [BlockedUser] = []
    @Published var pendingInvite: PendingInvite?
    @Published var errorMessage: String?
    @AppStorage("onboarded") var onboarded = false

    let client: AccountClient
    let watch = PhoneWatchLink()
    let deviceId = DeviceIdentity.id()
    let linkDomain: String
    /// A local API (the simulator) accepts "dev:" sign-ins without Apple.
    let isLocalServer: Bool

    private var signedOutObserver: NSObjectProtocol?

    init() {
        let info = Bundle.main.infoDictionary ?? [:]
        let host = info["OAOApiHost"] as? String ?? ""
        linkDomain = info["OAOLinkDomain"] as? String ?? "overandout.app"
        isLocalServer = host.hasPrefix("localhost") || host.hasPrefix("127.0.0.1")
        let base = AccountClient.baseURL(host: host) ?? URL(string: "https://overandout.app")!
        client = AccountClient(baseURL: base, store: KeychainSessionStore())
        session = client.session
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
        didSignOut()
    }

    private func didSignOut() {
        session = nil
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
            friends = loadedFriends
            blocks = loadedBlocks
            friendsLoaded = true
        } catch {
            if session != nil { errorMessage = describe(error) }
        }
    }

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
