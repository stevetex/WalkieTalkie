import OverAndOutKit
import SwiftUI

/// A friend: their star, when they last talked to you, and report, block or remove them
/// (App Review 1.2).
struct FriendDetailView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let initial: Friend

    init(friend: Friend) {
        initial = friend
    }

    /// The latest from the friends list (the star changes here).
    private var friend: Friend { model.friends.first { $0.id == initial.id } ?? initial }
    @State private var reporting = false
    @State private var confirmingBlock = false
    @State private var confirmingRemove = false
    @State private var working = false
    @State private var showChangedCode = false

    private var lastMessaged: String {
        guard let at = friend.lastMessageAt else { return "Not yet" }
        let date = Date(timeIntervalSince1970: at / 1000)
        if Calendar.current.isDateInToday(date) { return "Today, \(date.formatted(date: .omitted, time: .shortened))" }
        if Calendar.current.isDateInYesterday(date) { return "Yesterday, \(date.formatted(date: .omitted, time: .shortened))" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    var body: some View {
        List {
            Group {
                Section {
                    VStack(spacing: 10) {
                        Avatar(friend: friend, size: 96, client: model.client)
                        Text(friend.name)
                            .font(.title2.bold())
                        Text(
                            "Friends since \(Date(timeIntervalSince1970: friend.since / 1000).formatted(date: .abbreviated, time: .omitted))"
                        )
                        .font(.footnote)
                        .foregroundStyle(Brand.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                }
                Section {
                    Toggle(isOn: Binding(
                        get: { friend.isFavorite },
                        set: { value in Task { await model.setFavorite(friend, value) } }
                    )) {
                        Label {
                            Text("Favorite")
                        } icon: {
                            Image(systemName: friend.isFavorite ? "star.fill" : "star").foregroundStyle(Brand.orange)
                        }
                    }
                    LabeledContent("Last messaged you", value: lastMessaged)
                } footer: {
                    Text("Favorites are at the top of your friends list, on your iPhone and your watch.")
                }
                if let account = model.session?.userId {
                    let security = model.trust.state(account: account, friend: friend.id)
                    if security.inviteMismatch || showChangedCode {
                        Section("Security") {
                            if security.inviteMismatch {
                                Label("Couldn't confirm \(friend.name)'s security code", systemImage: "exclamationmark.shield")
                            }
                            if showChangedCode {
                                Label("\(friend.name)'s security code changed. This happens when they sign in on a new iPhone.",
                                      systemImage: "exclamationmark.shield")
                            }
                        }
                    }
                }
                Section {
                    Button("Report \(friend.name)…") { reporting = true }
                    // Red set by hand: the brand's foreground style would override the role's.
                    Button("Block \(friend.name)", role: .destructive) { confirmingBlock = true }
                        .foregroundStyle(.red)
                    Button("Remove Friend", role: .destructive) { confirmingRemove = true }
                        .foregroundStyle(.red)
                } footer: {
                    Text(
                        "Blocking removes \(friend.name) from your friends. They can't ring you or invite you again, and they aren't told.")
                }
            }
            .listRowBackground(Brand.surface)
        }
        .disabled(working)
        .task { await model.refreshFriends() }
        .onAppear(perform: checkSecurityNotice)
        .onChange(of: model.friends) { _, _ in checkSecurityNotice() }
        .brandScreen()
        .navigationTitle(friend.name)
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Block \(friend.name)?", isPresented: $confirmingBlock, titleVisibility: .visible) {
            Button("Block", role: .destructive) { act { await model.block(friend.id) } }
        } message: {
            Text("They'll be removed from your friends and can't ring or invite you. You can unblock them in Settings.")
        }
        .confirmationDialog("Remove \(friend.name)?", isPresented: $confirmingRemove, titleVisibility: .visible) {
            Button("Remove Friend", role: .destructive) { act { await model.removeFriend(friend) } }
        } message: {
            Text("You won't be able to ring each other until one of you sends a new invite.")
        }
        .sheet(isPresented: $reporting) {
            ReportView(friend: friend) { dismiss() }
                .environmentObject(model)
        }
    }

    private func checkSecurityNotice() {
        guard let account = model.session?.userId else { return }
        if model.trust.markNoticeRead(account: account, friend: friend.id, now: Int64(Clock.nowMs())) {
            showChangedCode = true
        }
    }

    private func act(_ action: @escaping () async -> Void) {
        working = true
        Task {
            await action()
            working = false
            dismiss()
        }
    }
}

struct ReportView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let friend: Friend
    /// Called after a report that also blocked, so the friend's page closes too.
    let onBlocked: () -> Void
    @State private var reason: ReportReason = .harassment
    @State private var note = ""
    @State private var alsoBlock = true
    @State private var sending = false
    @State private var sent = false

    var body: some View {
        NavigationStack {
            Form {
                Group {
                    Section("What's wrong?") {
                        Picker("Reason", selection: $reason) {
                            ForEach(ReportReason.allCases) { Text($0.title).tag($0) }
                        }
                        .pickerStyle(.inline)
                        .labelsHidden()
                    }
                    Section {
                        TextField("Anything else we should know (optional)", text: $note, axis: .vertical)
                            .lineLimit(3...6)
                    }
                    Section {
                        Toggle("Also block \(friend.name)", isOn: $alsoBlock)
                    } footer: {
                        Text("We review every report. Over&Out doesn't record conversations, so describe what happened.")
                    }
                }
                .listRowBackground(Brand.surface)
            }
            .brandScreen()
            .navigationTitle("Report \(friend.name)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") { send() }
                        .disabled(sending)
                }
            }
            .alert("Thanks for telling us", isPresented: $sent) {
                Button("OK") {
                    dismiss()
                    if alsoBlock { onBlocked() }
                }
            } message: {
                Text(alsoBlock ? "We'll review your report. \(friend.name) is blocked." : "We'll review your report.")
            }
        }
    }

    private func send() {
        sending = true
        Task {
            sent = await model.report(friend, reason: reason, note: note.trimmingCharacters(in: .whitespacesAndNewlines), alsoBlock: alsoBlock)
            sending = false
        }
    }
}
