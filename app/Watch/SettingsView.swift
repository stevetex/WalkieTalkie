import OverAndOutKit
import SwiftUI

/// The account and the version; diagnostics in debug builds. Opened from the friends list.
struct SettingsView: View {
    @ObservedObject var controller: ConversationController
    @ObservedObject var account: WatchAccount

    private var version: String {
        let info = Bundle.main.infoDictionary ?? [:]
        return "\(info["CFBundleShortVersionString"] as? String ?? "?") (\(info["CFBundleVersion"] as? String ?? "?"))"
    }

    var body: some View {
        List {
            Group {
                Section {
                    LabeledRow(label: "Signed in as", value: account.session?.name ?? "Not signed in")
                    LabeledRow(label: "Version", value: version)
                } footer: {
                    Text("Change your name and picture in Over&Out on your iPhone.")
                }
                #if DEBUG
                Section("Testing") {
                    LabeledRow(label: "Server", value: controller.settings.serverHost.isEmpty ? "Not set" : controller.settings.serverHost)
                    Text(controller.registrationStatus)
                        .font(.footnote)
                    LabeledRow(label: "Codec", value: controller.codecDescription)
                    // For a cold-start test: the app exits once it's in the background, so the
                    // next ring has to launch it.
                    Toggle("Quit when I leave", isOn: $controller.quitWhenBackgrounded)
                    if controller.quitWhenBackgrounded {
                        Text("Press the crown now. The app exits in the background.")
                            .font(.footnote)
                            .foregroundStyle(Brand.secondary)
                    }
                }
                Section("Log") {
                    ForEach(controller.logLines.suffix(20).reversed(), id: \.self) { line in
                        Text(line)
                            .font(.system(size: 11, design: .monospaced))
                    }
                }
                #endif
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
