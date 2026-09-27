import OverAndOutKit
import SwiftUI

/// The account, whom Talk rings, and diagnostics.
struct SettingsView: View {
    @ObservedObject var controller: ConversationController
    @ObservedObject var account: WatchAccount

    var body: some View {
        List {
            Group {
                Section("Talk to") {
                    if account.friends.isEmpty {
                        Text("Invite a friend from Over&Out on your iPhone.")
                            .font(.footnote)
                            .foregroundStyle(Brand.secondary)
                    }
                    ForEach(account.friends) { friend in
                        Button {
                            account.selectedFriendId = friend.id
                        } label: {
                            HStack {
                                Text(friend.name)
                                Spacer()
                                if friend.id == account.selectedFriend?.id {
                                    Image(systemName: "checkmark").foregroundStyle(Brand.accent)
                                }
                            }
                        }
                    }
                }
                Section("This watch") {
                    LabeledRow(label: "Signed in as", value: account.session?.name ?? "Not signed in")
                    LabeledRow(label: "Server", value: controller.settings.serverHost.isEmpty ? "Not set" : controller.settings.serverHost)
                    Text(controller.registrationStatus)
                        .font(.footnote)
                    LabeledRow(label: "Codec", value: controller.codecDescription)
                }
                #if DEBUG
                Section("Testing") {
                    // For a cold-start test: the app exits once it's in the background, so the
                    // next ring has to launch it.
                    Toggle("Quit when I leave", isOn: $controller.quitWhenBackgrounded)
                    if controller.quitWhenBackgrounded {
                        Text("Press the crown now. The app exits in the background.")
                            .font(.footnote)
                            .foregroundStyle(Brand.secondary)
                    }
                }
                #endif
                Section("Log") {
                    ForEach(controller.logLines.suffix(20).reversed(), id: \.self) { line in
                        Text(line)
                            .font(.system(size: 11, design: .monospaced))
                    }
                }
            }
            .listRowBackground(Brand.surface)
        }
        .brandScreen()
        .navigationTitle("Settings")
        .onAppear { account.refresh() }
    }
}

private struct LabeledRow: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(Brand.secondary)
            Text(value)
                .font(.footnote)
        }
    }
}
