import OverAndOutKit
import SwiftUI

/// Signed out → the prompt to sign in on the iPhone. Then the friends list, the home screen
/// as on the iPhone (design decision 2026-09-29), with a Talk screen per friend pushed from
/// it and an in-app ring over everything.
struct ContentView: View {
    @ObservedObject var controller: ConversationController
    @ObservedObject var account: WatchAccount
    @Environment(\.scenePhase) private var scenePhase
    @State private var path: [Friend] = []
    @State private var leftAt: Date?

    /// Back after this long with no conversation: the friends list, not the last Talk screen.
    static let homeAfter: TimeInterval = 120

    var body: some View {
        Group {
            if account.session == nil {
                SignInPrompt(phoneSignedIn: account.phoneSignedIn)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Brand.indigo.ignoresSafeArea())
            } else {
                home
            }
        }
        .brandScreen()
        .onChange(of: account.session?.userId) { path = [] }
    }

    private var home: some View {
        NavigationStack(path: $path) {
            FriendsListView(controller: controller, account: account)
                .navigationDestination(for: Friend.self) { friend in
                    TalkView(controller: controller, account: account, friend: friend)
                }
        }
        .accessibilityHidden(controller.incomingRing != nil)
        .overlay {
            if let ring = controller.incomingRing {
                IncomingRingView(controller: controller, account: account, ring: ring)
            }
        }
        .onAppear { showArrived(controller.arrivedFrom) }
        .onChange(of: controller.arrivedFrom) { _, id in showArrived(id) }
        // A friend who's gone (removed, blocked) takes their Talk screen with them.
        .onChange(of: account.friends) { _, friends in
            path.removeAll { shown in shown.id != controller.peerId && !friends.contains { $0.id == shown.id } }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active {
                if leftAt == nil { leftAt = Date() }
                return
            }
            defer { leftAt = nil }
            controller.removeExpiredRingNotifications()
            guard let leftAt, Date().timeIntervalSince(leftAt) >= Self.homeAfter,
                  controller.phase == .idle, controller.incomingRing == nil else { return }
            path = []
        }
        .task { controller.requestMicrophone() }
    }

    /// An answered ring: the caller's Talk screen, with the friends list behind it.
    private func showArrived(_ id: String?) {
        guard let id else { return }
        controller.arrivedFrom = nil
        guard path.last?.id != id else { return }
        // Not in the cached list yet (a new friend): the ring's name will do until it reloads.
        let friend = account.friends.first { $0.id == id }
            ?? Friend(id: id, name: controller.peerName ?? "Your friend", since: 0)
        path = [friend]
    }
}

/// No session yet: the iPhone app signs the watch in.
struct SignInPrompt: View {
    let phoneSignedIn: Bool?

    var body: some View {
        VStack(spacing: 8) {
            SmallMascot()
            if phoneSignedIn == true {
                ProgressView()
                Text("Signing in from your iPhone…")
                    .font(.footnote)
                    .multilineTextAlignment(.center)
            } else {
                Text("Open Over&Out on your iPhone and sign in")
                    .font(.footnote)
                    .multilineTextAlignment(.center)
            }
        }
        .padding()
        .foregroundStyle(Brand.ivory)
    }
}

struct NoFriendsYet: View {
    let loaded: Bool

    var body: some View {
        VStack(spacing: 8) {
            SmallMascot()
            Text(loaded ? "Invite a friend from Over&Out on your iPhone" : "Loading friends…")
                .font(.footnote)
                .multilineTextAlignment(.center)
        }
        .padding()
        .foregroundStyle(Brand.ivory)
    }
}

/// The mascot above a short message, on the screens before the main one.
struct SmallMascot: View {
    var body: some View {
        Image("OverAndOutMascot")
            .resizable()
            .aspectRatio(contentMode: .fit)
            .frame(height: 76)
            .accessibilityHidden(true)
    }
}
