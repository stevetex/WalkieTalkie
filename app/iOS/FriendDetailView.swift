import OverAndOutKit
import SwiftUI

/// A friend: report, block or remove them (App Review 1.2).
struct FriendDetailView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let friend: Friend
    @State private var reporting = false
    @State private var confirmingBlock = false
    @State private var confirmingRemove = false
    @State private var working = false

    var body: some View {
        List {
            Section {
                VStack(spacing: 10) {
                    Text(String(friend.name.prefix(1)).uppercased())
                        .font(.largeTitle.bold())
                        .foregroundStyle(.white)
                        .frame(width: 80, height: 80)
                        .background(Circle().fill(.orange.gradient))
                    Text(friend.name)
                        .font(.title2.bold())
                    Text("Friends since \(Date(timeIntervalSince1970: friend.since / 1000).formatted(date: .abbreviated, time: .omitted))")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .listRowBackground(Color.clear)
            }
            Section {
                Button("Report \(friend.name)…") { reporting = true }
                Button("Block \(friend.name)", role: .destructive) { confirmingBlock = true }
                Button("Remove Friend", role: .destructive) { confirmingRemove = true }
            } footer: {
                Text("Blocking removes \(friend.name) from your friends. They can't ring you or invite you again, and they aren't told.")
            }
        }
        .disabled(working)
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
