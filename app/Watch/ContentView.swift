import OverAndOutKit
import SwiftUI

struct ContentView: View {
    @ObservedObject var controller: ConversationController
    @ObservedObject var account: WatchAccount

    private var talkTitle: String {
        controller.peerName ?? account.selectedFriend?.name ?? ""
    }

    private var mouthState: MascotTalkButton.MouthState {
        if controller.phase == .idle && account.selectedFriend == nil { return .disabled }
        if controller.phase != .idle && !controller.talkReady { return .waiting }
        if controller.isTalking { return .talking }
        if controller.remoteTalking { return .listening }
        return .idle
    }

    private var statusColor: Color {
        switch mouthState {
        case .talking: return Brand.orange
        case .listening: return .green
        default: return Brand.silver
        }
    }

    var body: some View {
        Group {
            if account.session == nil {
                SignInPrompt(phoneSignedIn: account.phoneSignedIn)
            } else if account.friends.isEmpty && controller.phase == .idle && controller.incomingRing == nil {
                NoFriendsYet(loaded: account.friendsLoaded)
            } else {
                main
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Brand.indigo.ignoresSafeArea())
        .brandScreen()
    }

    /// The mascot fills the screen and its mouth is the Talk button. The friend's name and
    /// End sit top left, away from the mouth, so End isn't hit while talking.
    private var main: some View {
        ZStack(alignment: .topLeading) {
            VStack(spacing: 0) {
                MascotTalkButton(
                    state: mouthState,
                    ringing: controller.incomingRing != nil,
                    friendName: talkTitle.isEmpty ? "your friend" : talkTitle
                ) { pressed in
                    pressed ? controller.talkPressed() : controller.talkReleased()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                // The antenna ball clear of Settings above it.
                .padding(.top, 30)
                // Clear of the name and End (or the caller) at top left; the orange side
                // button has room.
                .offset(x: ringing ? 22 : 14)

                if ringing {
                    // Below the mascot, which shrinks to make room, so nothing covers the mouth.
                    // Decline on the left and Answer on the right, as on the iPhone.
                    HStack(spacing: 6) {
                        Button("Decline") { controller.declineIncomingRing() }
                            .buttonStyle(.bordered)
                            .tint(.gray)
                        Button("Answer") { controller.answerIncomingRing() }
                            .buttonStyle(.borderedProminent)
                            .tint(Brand.orange)
                            .foregroundStyle(Brand.ink)
                    }
                    .padding(.horizontal, 8)
                    .padding(.bottom, 8)
                } else {
                    Text(controller.statusLine.isEmpty ? idleStatus : controller.statusLine)
                        .font(.footnote)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .foregroundStyle(statusColor)
                        .padding(.bottom, 10)
                }
            }
            // Up under the time, so the antenna rises between the time and Settings, and down
            // to the bottom edge.
            .ignoresSafeArea(edges: [.top, .bottom])

            topLeft
        }
        .padding(.horizontal, 4)
        .toolbar {
            ToolbarItem(placement: settingsPlacement) {
                NavigationLink {
                    SettingsView(controller: controller, account: account)
                } label: {
                    Image(systemName: "gearshape")
                        .foregroundStyle(Brand.ivory)
                }
                // Quiet, so it doesn't compete with the mascot's orange.
                .tint(Brand.surface)
                .accessibilityLabel("Settings")
            }
        }
        .task { controller.requestMicrophone() }
    }

    private var ringing: Bool { controller.incomingRing != nil }

    private var idleStatus: String {
        account.selectedFriend != nil ? "Hold the mouth to talk" : "Choose a friend"
    }

    /// The friend Talk rings (a picker when there's a choice), and End during a conversation.
    private var topLeft: some View {
        VStack(alignment: .leading, spacing: 4) {
            if controller.phase == .idle, controller.incomingRing == nil,
               account.friends.count > 1 || account.selectedFriend == nil {
                NavigationLink {
                    FriendPicker(account: account)
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        if let friend = account.selectedFriend {
                            Avatar(friend: friend, size: 28, client: account.client)
                        }
                        HStack(spacing: 2) {
                            Text(account.selectedFriend?.name ?? "Choose")
                            Image(systemName: "chevron.right").font(.caption2)
                        }
                    }
                }
                .buttonStyle(.plain)
            } else if let ring = controller.incomingRing {
                if let caller = account.friends.first(where: { $0.id == ring.from }) {
                    Avatar(friend: caller, size: 32, client: account.client)
                }
                Text(ring.fromName)
                    .minimumScaleFactor(0.7)
                Text("is calling")
                    .font(.caption2)
                    .foregroundStyle(Brand.silver)
            } else if let friend = currentFriend {
                Avatar(friend: friend, size: 28, client: account.client)
                Text(friend.name)
            } else if !talkTitle.isEmpty {
                Text(talkTitle)
            }
            if controller.phase != .idle {
                Button(role: .destructive) { controller.end() } label: {
                    Label("End", systemImage: "xmark")
                        .labelStyle(.titleAndIcon)
                        .font(.caption2.weight(.semibold))
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
                .fixedSize()
            }
        }
        .font(.footnote.weight(.semibold))
        .lineLimit(1)
        .foregroundStyle(Brand.ivory)
        // Narrower while ringing, when the mascot moves right to make room.
        .frame(maxWidth: ringing ? 64 : 110, alignment: .leading)
    }

    /// The friend in the conversation, or the one Talk rings.
    private var currentFriend: Friend? {
        if let id = controller.peerId { return account.friends.first { $0.id == id } }
        return account.selectedFriend
    }

    private var settingsPlacement: ToolbarItemPlacement {
        if #available(watchOS 10.0, *) { return .topBarTrailing }
        return .automatic
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

struct FriendPicker: View {
    @ObservedObject var account: WatchAccount
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List(account.friends) { friend in
            Button {
                account.selectedFriendId = friend.id
                dismiss()
            } label: {
                HStack {
                    Avatar(friend: friend, size: 28, client: account.client)
                    Text(friend.name)
                    Spacer()
                    if friend.id == account.selectedFriend?.id {
                        Image(systemName: "checkmark").foregroundStyle(Brand.accent)
                    }
                }
            }
            .listRowBackground(Brand.surface)
        }
        .brandScreen()
        .navigationTitle("Friends")
    }
}
