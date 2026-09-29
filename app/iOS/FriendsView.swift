import OverAndOutKit
import SwiftUI

/// The friends list, with inviting a friend over Messages.
struct FriendsView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var ptt: PushToTalkChannel
    @State private var sharing: InviteLink?
    @State private var creatingInvite = false

    var body: some View {
        List {
            Group {
                walkieTalkieStatus
                if model.friends.isEmpty {
                    Section {
                        VStack(spacing: 12) {
                            Image("OverAndOutMascot")
                                .resizable()
                                .scaledToFit()
                                .frame(height: 96)
                                .accessibilityHidden(true)
                            Text(model.friendsLoaded ? "No friends yet" : "Loading…")
                                .font(.headline)
                            Text("Invite a friend over Messages. When they tap the link, you can talk from your iPhone or Apple Watch.")
                                .font(.callout)
                                .foregroundStyle(Brand.secondary)
                                .multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 24)
                    }
                } else {
                    Section {
                        ForEach(Friend.favoritesFirst(model.friends)) { friend in
                            NavigationLink(value: friend) {
                                FriendRow(friend: friend)
                            }
                        }
                    } footer: {
                        Text("Tap a friend, then hold the mascot's mouth to talk. You can also talk from Over&Out on your watch.")
                    }
                }
                Section {
                    Button(action: invite) {
                        Label {
                            Text(creatingInvite ? "Creating Invite…" : "Invite a Friend")
                        } icon: {
                            Image(systemName: "message.fill").foregroundStyle(Brand.accent)
                        }
                    }
                    .disabled(creatingInvite)
                } footer: {
                    Text("Each invite link works once and expires after 7 days.")
                }
            }
            .listRowBackground(Brand.surface)
        }
        .brandScreen()
        // The masthead, then this screen's title and Settings, in place of a navigation bar.
        .safeAreaInset(edge: .top, spacing: 0) { header }
        .toolbar(.hidden, for: .navigationBar)
        // Light status bar text over the masthead, and on the indigo Talk screens pushed from here.
        .toolbarColorScheme(.dark, for: .navigationBar)
        .navigationTitle("Friends")
        .navigationDestination(for: Friend.self) { friend in
            TalkView(friend: friend)
        }
        .refreshable { await model.refresh() }
        // After an invite, check every 10 s for half an hour for the friend who accepts it.
        .task(id: model.lastInviteAt) {
            guard let since = model.lastInviteAt else { return }
            while Date().timeIntervalSince(since) < 30 * 60 {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                if Task.isCancelled { return }
                await model.refreshFriends()
            }
        }
        .sheet(item: $sharing) { link in
            ShareSheet(items: [InviteMessage(link: link, from: model.displayName)])
                .presentationDetents([.medium, .large])
        }
    }

    /// Walkie-talkie off though not turned off in Settings (the system's Leave button, run 54),
    /// or on without permission to say when that happens.
    @ViewBuilder
    private var walkieTalkieStatus: some View {
        if ptt.isAvailable, !ptt.isJoined, ptt.wanted != false {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    Label("Walkie-talkie is off", systemImage: "iphone.slash")
                        .font(.headline)
                    Text(model.platforms.contains(.watch)
                         ? "Friends' messages ring your Apple Watch instead of playing on this iPhone."
                         : "Friends' messages won't play on this iPhone until you turn it on.")
                        .font(.callout)
                        .foregroundStyle(Brand.secondary)
                    Button("Turn On Walkie-Talkie") { ptt.join() }
                        .buttonStyle(.borderedProminent)
                        .tint(Brand.orange)
                        .foregroundStyle(Brand.ink)
                }
                .padding(.vertical, 6)
            }
        } else if ptt.isJoined, model.notificationsUndetermined {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Allow notifications so Over&Out can tell you if walkie-talkie turns off, for example after the Leave button next to Talk.")
                        .font(.callout)
                        .foregroundStyle(Brand.secondary)
                    Button("Allow Notifications") { Task { await model.allowNotifications() } }
                        .buttonStyle(.bordered)
                }
                .padding(.vertical, 6)
            }
        }
    }

    private var header: some View {
        VStack(spacing: 0) {
            Masthead()
            HStack {
                Text("Friends")
                    .font(.largeTitle.bold())
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                NavigationLink {
                    SettingsView()
                } label: {
                    Image(systemName: "gearshape")
                        .font(.title2)
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("Settings")
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .foregroundStyle(Brand.primary)
            .background(Brand.background)
        }
    }

    private func invite() {
        creatingInvite = true
        Task {
            sharing = await model.createInvite()
            creatingInvite = false
        }
    }
}

extension InviteLink: @retroactive Identifiable {
    public var id: String { code }
}

struct FriendRow: View {
    @EnvironmentObject private var model: AppModel
    let friend: Friend

    var body: some View {
        HStack(spacing: 12) {
            Avatar(friend: friend, size: 40, client: model.client)
            Text(friend.name)
            if friend.isFavorite {
                Image(systemName: "star.fill")
                    .font(.caption)
                    .foregroundStyle(Brand.orange)
                    .accessibilityLabel("Favorite")
            }
        }
        .padding(.vertical, 2)
    }
}

/// The invite as shared: the link as a URL (so Messages shows a link preview), plus a line
/// of text for apps that take text.
final class InviteMessage: NSObject, UIActivityItemSource {
    let link: InviteLink
    let from: String

    init(link: InviteLink, from: String) {
        self.link = link
        self.from = from
    }

    func activityViewControllerPlaceholderItem(_ controller: UIActivityViewController) -> Any { link.url }

    func activityViewController(_ controller: UIActivityViewController, itemForActivityType activityType: UIActivity.ActivityType?) -> Any? {
        if activityType == .message || activityType == .copyToPasteboard { return link.url }
        return "Let's talk on Over&Out, a walkie-talkie for Apple Watch: \(link.url.absoluteString)"
    }

    func activityViewController(_ controller: UIActivityViewController, subjectForActivityType activityType: UIActivity.ActivityType?) -> String {
        "\(from) invited you to Over&Out"
    }
}

struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
