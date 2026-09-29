import OverAndOutKit
import SwiftUI

/// The home screen: friends with their pictures, favorites first, and the friend in a
/// conversation at the top, marked live. Tapping one opens their Talk screen.
struct FriendsListView: View {
    @ObservedObject var controller: ConversationController
    @ObservedObject var account: WatchAccount

    /// The friend in the conversation first, then the account's order (favorites first).
    private var friends: [Friend] {
        var list = account.friends
        if let id = controller.peerId, let index = list.firstIndex(where: { $0.id == id }) {
            list.insert(list.remove(at: index), at: 0)
        }
        return list
    }

    var body: some View {
        Group {
            if account.friends.isEmpty {
                NoFriendsYet(loaded: account.friendsLoaded)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Brand.indigo.ignoresSafeArea())
            } else {
                List(friends) { friend in
                    NavigationLink(value: friend) {
                        FriendRow(friend: friend, live: liveStatus(for: friend), client: account.client)
                    }
                    .listRowBackground(Brand.surface)
                }
            }
        }
        .brandScreen()
        .navigationTitle("Friends")
        .toolbar {
            ToolbarItem(placement: settingsPlacement) {
                NavigationLink {
                    SettingsView(controller: controller, account: account)
                } label: {
                    Image(systemName: "gearshape")
                        .foregroundStyle(Brand.ivory)
                }
                .tint(Brand.surface)
                .accessibilityLabel("Settings")
            }
        }
    }

    /// The conversation's state on its friend's row.
    private func liveStatus(for friend: Friend) -> FriendRow.Live? {
        guard controller.peerId == friend.id, controller.phase != .idle else { return nil }
        if controller.isTalking { return .you }
        if controller.remoteTalking { return .them }
        return controller.phase == .connecting ? .connecting : .live
    }

    private var settingsPlacement: ToolbarItemPlacement {
        if #available(watchOS 10.0, *) { return .topBarTrailing }
        return .automatic
    }
}

struct FriendRow: View {
    enum Live {
        case connecting, live, you, them

        var text: String {
            switch self {
            case .connecting: return "Connecting…"
            case .live: return "Live"
            case .you: return "You're talking"
            case .them: return "Talking"
            }
        }

        var color: Color {
            switch self {
            case .connecting: return Brand.silver
            case .you: return Brand.orange
            case .live, .them: return .green
            }
        }
    }

    let friend: Friend
    let live: Live?
    let client: AccountClient?

    var body: some View {
        HStack(spacing: 8) {
            Avatar(friend: friend, size: 32, client: client)
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 4) {
                    Text(friend.name)
                        .lineLimit(1)
                    if friend.isFavorite {
                        Image(systemName: "star.fill")
                            .font(.caption2)
                            .foregroundStyle(Brand.orange)
                            .accessibilityLabel("Favorite")
                    }
                }
                if let live {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(live.color)
                            .frame(width: 6, height: 6)
                        Text(live.text)
                    }
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(live.color)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}
