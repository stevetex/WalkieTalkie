import OverAndOutKit
import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var watch: PhoneWatchLink
    @EnvironmentObject private var ptt: PushToTalkChannel
    @State private var name = ""
    @State private var confirmingSignOut = false
    @AppStorage(Appearance.key) private var appearance = Appearance.system

    var body: some View {
        Form {
            Group {
                Section {
                    ProfilePhotoPicker()
                        .padding(.vertical, 4)
                } header: {
                    Text("Picture")
                } footer: {
                    Text("A photo of yours or one of the mascots. Friends see it on their iPhone and watch.")
                }

                Section {
                    TextField("Screen name", text: $name)
                        .submitLabel(.done)
                        .onSubmit(saveName)
                    if nameChanged {
                        Button("Save Name", action: saveName)
                    }
                } header: {
                    Text("Screen name")
                } footer: {
                    Text("Friends see this when you ring them.")
                }

                WalkieTalkieSection()

                Section("Appearance") {
                    Picker("Appearance", selection: $appearance) {
                        ForEach(Appearance.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }

                Section("Apple Watch") {
                    LabeledContent("Status", value: watchStatus)
                    if watch.isWatchAppInstalled {
                        Button("Sign In on Watch Again") { watch.resendSession() }
                    }
                }

                Section {
                    // Rings are alerts only on the watch; the iPhone plays through PushToTalk.
                    if watch.isPaired {
                        NavigationLink("Let Watch Rings Through Focus") {
                            ScrollView {
                                VStack(alignment: .leading, spacing: 16) {
                                    Text(FocusSteps.explanation)
                                        .foregroundStyle(Brand.secondary)
                                    FocusSteps()
                                }
                                .padding()
                            }
                            .brandScreen()
                            .navigationTitle("Rings and Focus")
                        }
                    }
                    NavigationLink("Blocked People") { BlockedView() }
                }

                Section {
                    Link("Privacy Policy", destination: URL(string: "https://\(model.linkDomain)/privacy")!)
                    Link("Help and Support", destination: URL(string: "https://\(model.linkDomain)/support")!)
                    NavigationLink("About Over&Out") { AboutView() }
                }

                Section {
                    // Each dialog hangs off its own button, so it opens next to the row that was tapped.
                    Button("Sign Out") { confirmingSignOut = true }
                        .confirmationDialog("Sign out of Over&Out?", isPresented: $confirmingSignOut, titleVisibility: .visible) {
                            Button("Sign Out", role: .destructive) { Task { await model.signOut() } }
                        } message: {
                            Text("Your watch is signed out too. Your friends stay.")
                        }
                }

                Section {
                    NavigationLink("Delete Account") { DeleteAccountView() }
                        .foregroundStyle(.red)
                } footer: {
                    Text("Deletes your account, friends, invites and blocks, and removes you from your friends' lists.")
                }
            }
            .listRowBackground(Brand.surface)
        }
        .brandScreen()
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { name = model.displayName }
    }

    private var nameChanged: Bool {
        let clean = name.trimmingCharacters(in: .whitespaces)
        return !clean.isEmpty && clean != model.displayName
    }

    private var watchStatus: String {
        if !watch.isPaired { return "No watch paired" }
        if !watch.isWatchAppInstalled { return "Over&Out isn't installed" }
        if let sent = watch.lastSentAt { return "Signed in \(sent.formatted(.relative(presentation: .named)))" }
        return "Installed"
    }

    private func saveName() {
        guard nameChanged else { return }
        Task {
            if await model.rename(name.trimmingCharacters(in: .whitespaces)) { name = model.displayName }
        }
    }
}

/// Light, dark, or following the system (the iPhone app only; watchOS is always dark).
enum Appearance: String, CaseIterable, Identifiable {
    case system, light, dark

    static let key = "appearance"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: return "System"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

struct BlockedView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        List {
            Group {
                if model.blocks.isEmpty {
                    Text("You haven't blocked anyone.")
                        .foregroundStyle(Brand.secondary)
                }
                ForEach(model.blocks) { blocked in
                    HStack {
                        Text(blocked.name ?? "Deleted account")
                            .foregroundStyle(blocked.name == nil ? Brand.secondary : Brand.primary)
                        Spacer()
                        Button("Unblock") { Task { await model.unblock(blocked.id) } }
                            .buttonStyle(.bordered)
                    }
                }
            }
            .listRowBackground(Brand.surface)
        }
        .brandScreen()
        .navigationTitle("Blocked People")
        .refreshable { await model.refresh() }
    }
}

/// How this iPhone talks (design decisions 2026-09-27): being in the PushToTalk channel, and
/// which device rings.
struct WalkieTalkieSection: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var watch: PhoneWatchLink
    @EnvironmentObject private var ptt: PushToTalkChannel

    var body: some View {
        Section {
            if ptt.isAvailable {
                Toggle("Walkie-Talkie on This iPhone", isOn: Binding(
                    get: { ptt.isJoined },
                    set: { $0 ? ptt.join() : ptt.turnOff() }
                ))
            }
            if model.canChooseRingOn {
                Picker("Ring Me On", selection: Binding(
                    get: { model.ringsOn },
                    set: { platform in Task { await model.setRingOn(platform) } }
                )) {
                    Text("Apple Watch").tag(Platform.watch)
                    Text("iPhone").tag(Platform.iphone)
                }
            }
            if !model.microphoneAllowed {
                Button("Allow the Microphone") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
            }
            #if DEBUG
            // Diagnostics for test builds.
            if !model.reachability.isEmpty {
                LabeledContent("Registered", value: model.reachability)
            }
            LabeledContent("PushToTalk", value: ptt.isAvailable ? (ptt.isJoined ? (ptt.pushToken == nil ? "Joined, no token yet" : "Joined, token received") : "Not joined") : "Unavailable")
            if let error = ptt.lastError {
                Text(error).font(.footnote).foregroundStyle(Brand.secondary)
            }
            #else
            if model.reachability.hasPrefix("Not registered") {
                Text("Friends can't reach this iPhone right now. Check your connection, then open Over&Out again.")
                    .font(.footnote)
                    .foregroundStyle(Brand.secondary)
            }
            #endif
        } header: {
            Text("Walkie-Talkie")
        } footer: {
            Text(footer)
        }
    }

    private var footer: String {
        var lines: [String] = []
        if ptt.isAvailable {
            lines.append(ptt.isJoined
                ? "Friends' messages play on this iPhone right away, even when it's locked. You can talk back from the Lock Screen."
                : "Friends can reach this iPhone only while Over&Out is open.")
        } else {
            lines.append("Friends can reach this iPhone while Over&Out is open.")
        }
        if model.canChooseRingOn {
            lines.append("Only one device rings. If it can't be reached, the other one does.")
        } else if watch.isWatchAppInstalled {
            lines.append("Once Over&Out on your Apple Watch is signed in, you can choose which one rings.")
        }
        return lines.joined(separator: " ")
    }
}
