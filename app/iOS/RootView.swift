import AuthenticationServices
import OverAndOutKit
import SwiftUI

/// Signed out → Sign in with Apple. Signed in for the first time → onboarding. Then friends.
struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var talk: TalkController
    @State private var path: [Friend] = []

    var body: some View {
        Group {
            if model.accountDeleted {
                AccountDeletedView()
                    .masthead()
            } else if model.session == nil {
                SignInView()
                    .masthead()
            } else if !model.onboarded {
                OnboardingView()
                    .masthead()
            } else {
                // Inside the stack, so its navigation bar (and the Settings button) stays above it.
                NavigationStack(path: $path) {
                    FriendsView()
                        .masthead()
                }
                .fullScreenCover(item: ringBinding) { ring in
                    IncomingRingView(ring: ring)
                }
                // A friend started a conversation: show their Talk screen.
                .onChange(of: talk.arrivedFrom) { id in
                    guard let id else { return }
                    talk.arrivedFrom = nil
                    guard let friend = model.friends.first(where: { $0.id == id }), path.last?.id != id else { return }
                    path = [friend]
                }
            }
        }
        .brandScreen()
        .sheet(item: inviteBinding) { _ in
            InviteAcceptView()
                .environmentObject(model)
        }
        .alert("Over&Out", isPresented: errorBinding) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.errorMessage ?? "")
        }
    }

    /// An invite link is shown once signed in (and after onboarding for a new account).
    private var inviteBinding: Binding<AppModel.PendingInvite?> {
        Binding(
            get: { model.session != nil && model.onboarded ? model.pendingInvite : nil },
            set: { if $0 == nil { model.pendingInvite = nil } }
        )
    }

    private var ringBinding: Binding<Ring?> {
        Binding(get: { talk.incomingRing }, set: { if $0 == nil { talk.declineIncomingRing() } })
    }

    private var errorBinding: Binding<Bool> {
        Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })
    }
}

private extension View {
    /// The wordmark on indigo, above the screen's content.
    func masthead() -> some View {
        safeAreaInset(edge: .top, spacing: 0) {
            Image("OverAndOutBrand")
                .resizable()
                .scaledToFit()
                .frame(height: 112)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
                .background(Brand.artIndigo)
                .accessibilityLabel("Over&Out")
                .accessibilityAddTraits(.isHeader)
        }
    }
}

struct SignInView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @State private var nonce = ""
    @State private var signingIn = false
    #if DEBUG
    @State private var devName = ""
    #endif

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                Text("A walkie-talkie for iPhone and Apple Watch")
                    .font(.title3)
                    .foregroundStyle(Brand.secondary)
                    .padding(.top, 4)
                VStack(alignment: .leading, spacing: 14) {
                    Label("Hold the mascot's mouth on your iPhone or watch to talk, and your friend hears you", systemImage: "mic.fill")
                    Label("On a watch they tap the ring to listen; on an iPhone it plays right away", systemImage: "bell.and.waves.left.and.right")
                    Label("Only friends you invite can ring you", systemImage: "person.2.fill")
                }
                .font(.callout)
                .padding(.top, 36)
                .padding(.horizontal, 8)
                Spacer(minLength: 32)
                if model.pendingInvite != nil {
                    Text("Sign in to accept your invite.")
                        .font(.callout.weight(.semibold))
                        .padding(.bottom, 12)
                }
                SignInWithAppleButton(.signIn) { request in
                    nonce = AppleNonce.make()
                    request.requestedScopes = [.fullName]
                    request.nonce = AppleNonce.sha256(nonce)
                } onCompletion: { result in
                    handle(result)
                }
                .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
                .frame(height: 52)
                .disabled(signingIn)
                #if DEBUG
                if model.isLocalServer {
                    HStack {
                        TextField("Test user", text: $devName)
                            .textFieldStyle(.roundedBorder)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                        Button("Sign in") {
                            let name = devName.trimmingCharacters(in: .whitespaces)
                            Task { await model.signIn(identityToken: "dev:\(name.lowercased())", nonce: "dev", name: name) }
                        }
                        .disabled(devName.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    .padding(.top, 12)
                }
                #endif
                Text("Your screen name is shown to the friends you invite. We never see your email.")
                    .font(.footnote)
                    .foregroundStyle(Brand.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.top, 12)
            }
            .padding(24)
        }
        .overlay {
            if signingIn { ProgressView().controlSize(.large) }
        }
    }

    private func handle(_ result: Result<ASAuthorization, Error>) {
        switch result {
        case let .success(authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let tokenData = credential.identityToken,
                  let token = String(data: tokenData, encoding: .utf8) else {
                model.errorMessage = "Sign in with Apple didn't return a token. Try again."
                return
            }
            // Apple shares the name only on the first sign-in.
            let name = credential.fullName.map { PersonNameComponentsFormatter().string(from: $0) }
            signingIn = true
            Task {
                await model.signIn(identityToken: token, nonce: nonce, name: name)
                signingIn = false
            }
        case let .failure(error):
            if !ASAuthorizationError.isCancel(error) { model.errorMessage = error.localizedDescription }
        }
    }
}

extension Ring: @retroactive Identifiable {
    public var id: String { conversationId }
}
