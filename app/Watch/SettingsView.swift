import SwiftUI

/// Developer settings until the product has accounts: who this watch is, and a friend
/// picked from the relay's user list.
struct SettingsView: View {
    @ObservedObject var controller: ConversationController
    @State private var users: [APIClient.User] = []
    @State private var loadError: String?

    var body: some View {
        List {
            Section("Friend") {
                if users.isEmpty {
                    Text(loadError ?? "Loading…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                ForEach(users) { user in
                    Button {
                        controller.settings.friendId = user.userId
                        controller.settings.friendName = user.name
                    } label: {
                        HStack {
                            Text(user.name)
                            Spacer()
                            if user.userId == controller.settings.friendId {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
            }
            Section("This watch") {
                LabeledRow(label: "User", value: controller.settings.userId)
                LabeledRow(label: "Server", value: controller.settings.serverHost.isEmpty ? "Not set" : controller.settings.serverHost)
                Text(controller.registrationStatus)
                    .font(.footnote)
                LabeledRow(label: "Codec", value: controller.codecDescription)
            }
            Section("Log") {
                ForEach(controller.logLines.suffix(20).reversed(), id: \.self) { line in
                    Text(line)
                        .font(.system(size: 11, design: .monospaced))
                }
            }
        }
        .navigationTitle("Settings")
        .task { await loadUsers() }
    }

    private func loadUsers() async {
        do {
            users = try await controller.fetchUsers()
            loadError = users.isEmpty ? "No one else is registered" : nil
        } catch {
            loadError = error.localizedDescription
        }
    }
}

private struct LabeledRow: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.footnote)
        }
    }
}
