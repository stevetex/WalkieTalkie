import OverAndOutKit
import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var watch: PhoneWatchLink
    @State private var name = ""
    @State private var confirmingSignOut = false

    var body: some View {
        Form {
            Group {
                Section {
                    ProfilePhotoPicker()
                        .padding(.vertical, 4)
                } header: {
                    Text("Photo")
                } footer: {
                    Text("Friends see your photo on their iPhone and watch.")
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

                Section("Apple Watch") {
                    LabeledContent("Status", value: watchStatus)
                    if watch.isWatchAppInstalled {
                        Button("Sign In on Watch Again") { watch.resendSession() }
                    }
                }

                Section {
                    NavigationLink("Let Rings Through Focus") {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 16) {
                                Text(
                                    "When Do Not Disturb or another Focus is on, your watch stays silent unless Over&Out is on that Focus's list of allowed apps."
                                )
                                .foregroundStyle(Brand.secondary)
                                FocusSteps()
                            }
                            .padding()
                        }
                        .brandScreen()
                        .navigationTitle("Rings and Focus")
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
