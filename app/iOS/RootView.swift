import AuthenticationServices
import OverAndOutKit
import SwiftUI

/// Signed out → Sign in with Apple. Signed in for the first time → onboarding. Then friends.
struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var talk: TalkController
    @EnvironmentObject private var watch: PhoneWatchLink
    @State private var path: [Friend] = []
    @AppStorage(Appearance.key) private var appearance = Appearance.system

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
                    .masthead(height: 56)
            } else {
                // Inside the stack, so its navigation bar (and the Settings button) stays above it.
                NavigationStack(path: $path) {
                    FriendsView()
                }
                .fullScreenCover(item: ringBinding) { ring in
                    IncomingRingView(ring: ring)
                }
                .overlay(alignment: .top) { BackOnBanner() }
                // A friend started a conversation: show their Talk screen.
                .onChange(of: talk.arrivedFrom) { _, id in
                    guard let id else { return }
                    talk.arrivedFrom = nil
                    guard let friend = model.friends.first(where: { $0.id == id }), path.last?.id != id else { return }
                    path = [friend]
                }
            }
        }
        .brandScreen()
        .preferredColorScheme(appearance.colorScheme)
        .sheet(item: inviteBinding) { _ in
            InviteAcceptView()
                .environmentObject(model)
        }
        // A watch and this iPhone on one account: ask once. Apple Watch only comes first and
        // is the default, bold answer (design decision 2026-10-02).
        .onChange(of: watch.isPaired) { _, _ in model.askRingChoiceIfNeeded() }
        .alert("Where should friends ring you?", isPresented: ringOnBinding) {
            ForEach(RingChoice.allCases) { choice in
                Button(choice.title) { Task { await model.setRingChoice(choice) } }
                    .keyboardShortcut(choice == .watchOnly ? .defaultAction : nil)
            }
        } message: {
            Text("Over&Out is on your Apple Watch and this iPhone. With Apple Watch, Then iPhone, your iPhone rings if you don't answer your watch within 12 seconds. You can change this in Settings.")
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

    private var ringOnBinding: Binding<Bool> {
        Binding(
            get: { model.askingRingOn && model.onboarded && model.session != nil && model.errorMessage == nil },
            set: { if !$0 { model.askingRingOn = false } }
        )
    }

    private var errorBinding: Binding<Bool> {
        Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })
    }
}

/// The wordmark on indigo, running up under the status bar.
struct Masthead: View {
    var height: CGFloat = 96

    var body: some View {
        Image("OverAndOutBrand")
            .resizable()
            .scaledToFit()
            .frame(height: height)
            .frame(maxWidth: .infinity)
            .padding(.bottom, 4)
            .background(Brand.artIndigo.ignoresSafeArea(edges: .top))
            .accessibilityLabel("Over&Out")
            .accessibilityAddTraits(.isHeader)
    }
}

extension View {
    /// The masthead above the screen's content.
    func masthead(height: CGFloat = 96) -> some View {
        safeAreaInset(edge: .top, spacing: 0) { Masthead(height: height) }
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
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 4)
                VStack(alignment: .leading, spacing: 14) {
                    feature("Hold the mascot's mouth on your iPhone or watch to talk, and your friend hears you", symbol: "mic.fill")
                    feature("On a watch they tap the ring to listen; on an iPhone it plays right away", symbol: "bell.and.waves.left.and.right")
                    feature("Only friends you invite can ring you", symbol: "person.2.fill")
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
                // App Review (guideline 1.2): people agree to the community rules before talking.
                Text(agreement)
                    .font(.footnote)
                    .foregroundStyle(Brand.secondary)
                    .tint(Brand.accent)
                    .multilineTextAlignment(.center)
                    .padding(.top, 8)
            }
            .padding(24)
        }
        .overlay {
            if signingIn { ProgressView().controlSize(.large) }
        }
    }

    /// "By signing in you agree to …", with both links.
    private var agreement: AttributedString {
        let site = "https://\(model.linkDomain)"
        let markdown = "By signing in, you agree to the [Terms of Use](\(site)/terms) and [Privacy Policy](\(site)/privacy)."
        return (try? AttributedString(markdown: markdown)) ?? AttributedString(markdown)
    }

    /// A line with its symbol in a fixed-width column, so the lines' text aligns.
    private func feature(_ text: String, symbol: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(Brand.accent)
                .frame(width: 32)
            Text(text)
                .frame(maxWidth: .infinity, alignment: .leading)
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

/// "Walkie-talkie is back on" for a few seconds after the app rejoined the channel by itself
/// (after the system's Leave button, the system, or an update).
struct BackOnBanner: View {
    @EnvironmentObject private var ptt: PushToTalkChannel
    @State private var shown = false

    var body: some View {
        // An always-present base: SwiftUI doesn't attach onChange to an empty view.
        Color.clear
            .frame(height: 1)
            .allowsHitTesting(false)
            .overlay(alignment: .top) {
                if shown {
                    Label("Walkie-talkie is back on", systemImage: "iphone.radiowaves.left.and.right")
                        .font(.callout.weight(.semibold))
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(Brand.orange, in: Capsule())
                        .foregroundStyle(Brand.ink)
                        .padding(.top, 8)
                        .fixedSize()
                        .transition(.move(edge: .top).combined(with: .opacity))
                        .accessibilityAddTraits(.updatesFrequently)
                }
            }
            .animation(.easeOut(duration: 0.25), value: shown)
        .onChange(of: ptt.rejoinedAt) { _, at in
            guard at != nil else { return }
            shown = true
            Task {
                try? await Task.sleep(nanoseconds: 3_500_000_000)
                shown = false
            }
        }
    }
}
