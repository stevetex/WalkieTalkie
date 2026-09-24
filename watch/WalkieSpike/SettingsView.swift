import SwiftUI

struct SettingsView: View {
    @ObservedObject var controller: SpikeController
    @Environment(\.dismiss) private var dismiss
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
                LabeledContent("Rings", value: SpikeSettings.usesPolledRings ? "Polled (app open)" : "VoIP push")
                #if !targetEnvironment(simulator)
                if SpikeSettings.usesPolledRings {
                    // Off: ring inside the app, with no CallKit (how option C's conversation runs).
                    Toggle("Ring with CallKit", isOn: $controller.settings.ringWithCallKit)
                }
                #endif
            }

            Section("Experiments") {
                // Option C stand-in: a local notification rings, and opening it answers.
                if controller.notificationTestStatus.isEmpty {
                    Button("Notification ring in 30 s") {
                        controller.armNotificationRing(after: 30)
                        dismiss() // Back to the Talk screen, where the notification returns.
                    }
                } else {
                    Button("Cancel notification ring", role: .destructive) { controller.disarmNotificationRing() }
                }
                if !controller.notificationTestStatus.isEmpty {
                    Text(controller.notificationTestStatus)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
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
