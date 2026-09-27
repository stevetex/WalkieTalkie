import OverAndOutKit
import SwiftUI

/// An invite link was opened: confirm before becoming friends, so nobody is added by accident.
struct InviteAcceptView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 18) {
            Spacer()
            if let invite = model.pendingInvite {
                content(invite)
            }
            Spacer()
        }
        .padding(24)
        .brandScreen()
        .presentationDetents([.medium])
        .task {
            if model.pendingInvite?.info == nil, model.pendingInvite?.error == nil { await model.loadPendingInvite() }
        }
    }

    @ViewBuilder
    private func content(_ invite: AppModel.PendingInvite) -> some View {
        if let friend = invite.accepted {
            icon("checkmark.circle.fill", .green)
            Text("You and \(friend.name) are friends")
                .font(.title2.bold())
                .multilineTextAlignment(.center)
            Text("Ring \(friend.name) from Over&Out on your watch.")
                .foregroundStyle(Brand.secondary)
            primary("Done") { dismiss() }
        } else if let error = invite.error {
            icon("exclamationmark.triangle.fill", Brand.accent)
            Text(error)
                .multilineTextAlignment(.center)
            primary("OK") { dismiss() }
        } else if let info = invite.info {
            icon("person.crop.circle.badge.plus", Brand.accent)
            if info.alreadyFriends {
                Text("You and \(info.from.name) are already friends")
                    .font(.title2.bold())
                    .multilineTextAlignment(.center)
                primary("OK") { dismiss() }
            } else {
                Text("Add \(info.from.name) as a friend?")
                    .font(.title2.bold())
                    .multilineTextAlignment(.center)
                Text("You'll be able to ring each other from your watches.")
                    .foregroundStyle(Brand.secondary)
                    .multilineTextAlignment(.center)
                primary(invite.accepting ? "Adding…" : "Add Friend") {
                    Task { await model.acceptPendingInvite() }
                }
                .disabled(invite.accepting)
                Button("Not Now") { dismiss() }
            }
        } else {
            ProgressView("Opening invite…")
        }
    }

    private func icon(_ name: String, _ color: Color) -> some View {
        Image(systemName: name)
            .font(.system(size: 52))
            .foregroundStyle(color)
    }

    private func primary(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .foregroundStyle(Brand.ink)
        .controlSize(.large)
        .tint(Brand.orange)
    }
}
