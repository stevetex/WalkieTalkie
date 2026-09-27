import OverAndOutKit
import SwiftUI

/// The friends list, with inviting a friend over Messages.
struct FriendsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var sharing: InviteLink?
    @State private var creatingInvite = false

    var body: some View {
        List {
            Group {
                if model.friends.isEmpty {
                    Section {
                        VStack(spacing: 12) {
                            Image(systemName: "person.2.wave.2")
                                .font(.system(size: 44))
                                .foregroundStyle(Brand.accent)
                            Text(model.friendsLoaded ? "No friends yet" : "Loading…")
                                .font(.headline)
                            Text("Invite a friend over Messages. When they tap the link, you can ring each other from your watches.")
                                .font(.callout)
                                .foregroundStyle(Brand.secondary)
                                .multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 24)
                    }
                } else {
                    Section {
                        ForEach(model.friends) { friend in
                            NavigationLink(value: friend) {
                                FriendRow(friend: friend)
                            }
                        }
                    } footer: {
                        Text("Ring a friend from Over&Out on your watch.")
                    }
                }
                Section {
                    Button(action: invite) {
                        Label(creatingInvite ? "Creating Invite…" : "Invite a Friend", systemImage: "message.fill")
                    }
                    .disabled(creatingInvite)
                } footer: {
                    Text("Each invite link works once and expires after 7 days.")
                }
            }
            .listRowBackground(Brand.surface)
        }
        .brandScreen()
        .navigationTitle("Friends")
        .navigationDestination(for: Friend.self) { friend in
            FriendDetailView(friend: friend)
        }
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                NavigationLink {
                    SettingsView()
                } label: {
                    Image(systemName: "gearshape")
                }
                .accessibilityLabel("Settings")
            }
        }
        .refreshable { await model.refresh() }
        .sheet(item: $sharing) { link in
            ShareSheet(items: [InviteMessage(link: link, from: model.displayName)])
                .presentationDetents([.medium, .large])
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
    let friend: Friend

    var body: some View {
        HStack(spacing: 12) {
            Text(String(friend.name.prefix(1)).uppercased())
                .font(.headline)
                .foregroundStyle(Brand.ink)
                .frame(width: 36, height: 36)
                .background(Circle().fill(Brand.orange.gradient))
            Text(friend.name)
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
