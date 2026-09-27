import AuthenticationServices
import OverAndOutKit
import SwiftUI

/// Says what deleting removes and that Apple's "Sign in to Over&Out" sheet is only the
/// confirmation, then deletes. The server needs that fresh authorization code to revoke
/// Over&Out's access to the Apple ID (design decision 2026-09-27).
struct DeleteAccountView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var reauthorizer = AppleReauthorizer()
    @State private var deleting = false
    @State private var notDeleted = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Deleting your account removes:")
                        .font(.headline)
                    item("person.crop.circle", "Your account and your name")
                    item("person.2", "Your friends. You're removed from their lists, so they can't ring you.")
                    item("envelope", "Your invites and the people you've blocked")
                    item("applewatch", "Over&Out on your watch, which is signed out")
                    Text("This can't be undone.")
                        .font(.callout.weight(.semibold))
                        .padding(.top, 4)
                }

                VStack(alignment: .leading, spacing: 12) {
                    Text("How it works")
                        .font(.headline)
                    step(1, "Tap **Delete Account** below.")
                    step(2, "Apple asks you to confirm with Face ID. Its sheet says **Sign in to Over&Out**: that only confirms it's you, and you won't be signed back in.")
                }

                VStack(spacing: 12) {
                    Button(action: delete) {
                        Text(deleting ? "Deleting…" : "Delete Account")
                            .frame(maxWidth: .infinity)
                            .foregroundStyle(.white) // over .brandScreen()'s text color
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .tint(.red)
                    .disabled(deleting)
                    if notDeleted {
                        Text("Your account wasn't deleted.")
                            .font(.callout)
                            .foregroundStyle(Brand.secondary)
                    }
                    Button("Cancel") { dismiss() }
                        .disabled(deleting)
                }
                .frame(maxWidth: .infinity)
            }
            .padding(24)
        }
        .brandScreen()
        .navigationTitle("Delete Your Account")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(deleting)
    }

    private func item(_ symbol: String, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(Brand.accent)
                .frame(width: 26)
            Text(text)
        }
    }

    private func step(_ number: Int, _ text: LocalizedStringKey) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(number)")
                .font(.callout.bold())
                .frame(width: 26, height: 26)
                .background(Circle().fill(Brand.orange.opacity(0.18)))
            Text(text)
        }
    }

    private func delete() {
        deleting = true
        notDeleted = false
        Task {
            defer { deleting = false }
            do {
                #if DEBUG
                // A local API has no Sign in with Apple key, like the dev sign-in.
                if model.isLocalServer {
                    try await model.deleteAccount(authorizationCode: "dev")
                    return
                }
                #endif
                let code = try await reauthorizer.authorizationCode()
                try await model.deleteAccount(authorizationCode: code)
            } catch {
                notDeleted = true
                if !ASAuthorizationError.isCancel(error) { model.errorMessage = model.describe(error) }
            }
        }
    }
}

/// Shown once after a deletion, so it doesn't look like an ordinary sign-out.
struct AccountDeletedView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 18) {
            Spacer()
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 52))
                .foregroundStyle(.green)
            Text("Your account is deleted")
                .font(.title2.bold())
                .multilineTextAlignment(.center)
            Text("Your friends, invites and blocks are gone, and your watch is signed out. You can sign up again anytime.")
                .foregroundStyle(Brand.secondary)
                .multilineTextAlignment(.center)
            Spacer()
            Button {
                model.accountDeleted = false
            } label: {
                Text("Done").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .foregroundStyle(Brand.ink)
            .controlSize(.large)
            .tint(Brand.orange)
        }
        .padding(24)
    }
}
