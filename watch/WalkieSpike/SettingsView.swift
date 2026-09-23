import SwiftUI

struct SettingsView: View {
    @ObservedObject var controller: SpikeController
    @State private var users: [APIClient.User] = []
    @State private var usersError: String?

    var body: some View {
        List {
            Section("Me") {
                LabeledContent("ID", value: controller.settings.userId)
                TextField("Name", text: $controller.settings.displayName)
                Text(controller.registrationStatus)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Button("Register again") { controller.registerDevice() }
            }

            Section("Server") {
                TextField("Host", text: $controller.settings.serverHost)
                    .textContentType(.URL)
                LabeledContent("Token", value: controller.settings.token.isEmpty ? "Not set" : "Set")
            }

            Section("Talk to") {
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
                if let usersError {
                    Text(usersError).font(.caption2).foregroundStyle(.red)
                } else if users.isEmpty {
                    Text("No other devices registered yet").font(.caption2).foregroundStyle(.secondary)
                }
                Button("Refresh") { Task { await loadUsers() } }
            }

            Section("Conversation window") {
                Stepper(value: $controller.settings.conversationWindowSeconds, in: 15...120, step: 15) {
                    Text("\(controller.settings.conversationWindowSeconds) s idle")
                }
            }

            if !controller.lastRun.isEmpty {
                Section("Last run") {
                    ForEach(controller.lastRun, id: \.self) { Text($0).font(.caption2) }
                }
            }

            Section("Log") {
                Text(controller.codecDescription).font(.caption2)
                ForEach(controller.logLines.reversed(), id: \.self) { Text($0).font(.caption2) }
            }
        }
        .navigationTitle("Settings")
        .task { await loadUsers() }
        .onDisappear { controller.registerDevice() }
    }

    private func loadUsers() async {
        do {
            users = try await controller.fetchUsers()
            usersError = nil
        } catch {
            usersError = error.localizedDescription
        }
    }
}
