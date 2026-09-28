import OverAndOutKit
import SwiftUI

/// After the first sign-in (design decision 2026-09-28): your name and picture; how friends
/// reach you (the microphone, walkie-talkie on this iPhone and, with a watch, letting rings
/// through Focus); and, only with a watch paired, Over&Out on the watch.
struct OnboardingView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var watch: PhoneWatchLink
    @EnvironmentObject private var ptt: PushToTalkChannel
    @State private var step = 0
    @State private var name = ""
    @State private var saving = false
    @State private var showingFocusSteps = false

    private var stepCount: Int { watch.isPaired ? 3 : 2 }

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ProgressView(value: Double(step + 1), total: Double(stepCount))
                        .tint(Brand.orange)
                        .padding(.bottom, 28)
                    switch step {
                    case 0: nameStep
                    case 1: reachStep
                    default: watchStep
                    }
                }
                .frame(minHeight: max(0, geometry.size.height - 48), alignment: .topLeading)
                .padding(24)
            }
        }
        .onAppear {
            // "Friend" is the server's stand-in when Apple didn't share a name.
            if name.isEmpty, model.displayName != "Friend" { name = model.displayName }
        }
    }

    // MARK: Steps

    private var nameStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            title("What should friends call you?")
            detail("Your name and picture appear on their iPhone or watch when you talk to them.")
            // The picture fills the middle of the screen.
            VStack(spacing: 16) {
                Avatar(name: name, userId: model.session?.userId ?? "", photoVersion: model.photoVersion,
                       avatar: model.avatar, size: 150, client: model.client)
                ProfilePhotoPicker.ChangeButton()
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            TextField("Screen name", text: $name)
                .font(.title2)
                .textContentType(.givenName)
                .padding(16)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 14))
                .submitLabel(.continue)
                .onSubmit(saveName)
            Spacer(minLength: 24)
            primaryButton("Continue", action: saveName)
                .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || saving)
        }
    }

    /// The microphone, then the PushToTalk channel (only on a device with PushToTalk), and
    /// the Focus tip when there's a watch to ring.
    private var reachStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            title("How you talk")
            Image("OverAndOutMascot")
                .resizable()
                .scaledToFit()
                .frame(height: 200)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .accessibilityHidden(true)
            point("mic.fill", "Hold the mascot's mouth to talk. Over&Out uses the microphone only while you hold it.")
            if ptt.isAvailable {
                point("iphone.radiowaves.left.and.right", "With walkie-talkie on, friends' messages play on this iPhone right away, even when it's locked.")
            }
            if watch.isPaired {
                VStack(alignment: .leading, spacing: 12) {
                    point("moon.fill", "Using Do Not Disturb or another Focus? Add Over&Out to its allowed apps so your watch still rings.")
                    Button(showingFocusSteps ? "Hide the Steps" : "Show Me How") {
                        withAnimation { showingFocusSteps.toggle() }
                    }
                    .foregroundStyle(Brand.accent)
                    .padding(.leading, 44)
                    if showingFocusSteps {
                        FocusSteps()
                            .padding(.leading, 44)
                    }
                }
            }
            Spacer(minLength: 24)
            primaryButton(ptt.isAvailable ? "Turn On Walkie-Talkie" : "Allow the Microphone") {
                Task {
                    await model.requestMicrophone()
                    if ptt.isAvailable, !ptt.isJoined { ptt.join() }
                    next()
                }
            }
            Button("Not Now", action: next)
                .font(.title3)
                .frame(maxWidth: .infinity)
        }
    }

    private var watchStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            title("Over&Out on your watch")
            Image("OAOCoolCat")
                .resizable()
                .scaledToFit()
                .frame(height: 220)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .accessibilityHidden(true)
            if !watch.isWatchAppInstalled {
                detail("Install Over&Out on your watch: open the Watch app on this iPhone, scroll to Available Apps, and tap Install next to Over&Out.")
            } else {
                detail("Open Over&Out on your watch. It signs in with this account by itself, and you can talk from your wrist.")
            }
            Spacer(minLength: 24)
            primaryButton("Done") { model.onboarded = true }
        }
    }

    // MARK: Pieces

    private func title(_ text: String) -> some View {
        Text(text)
            .font(.largeTitle.bold())
            .fixedSize(horizontal: false, vertical: true)
    }

    private func detail(_ text: String) -> some View {
        Text(text)
            .font(.title3)
            .foregroundStyle(Brand.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func point(_ symbol: String, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(Brand.accent)
                .frame(width: 32)
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.title3)
    }

    private func primaryButton(_ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .foregroundStyle(Brand.ink)
        .controlSize(.large)
        .font(.title3.weight(.semibold))
        .tint(Brand.orange)
    }

    private func next() {
        if step + 1 < stepCount {
            step += 1
        } else {
            model.onboarded = true
        }
    }

    private func saveName() {
        let clean = name.trimmingCharacters(in: .whitespaces)
        guard !clean.isEmpty else { return }
        guard clean != model.displayName else {
            next()
            return
        }
        saving = true
        Task {
            if await model.rename(clean) { next() }
            saving = false
        }
    }
}

struct FocusSteps: View {
    /// Only the watch rings with a notification; the iPhone plays through PushToTalk.
    static let explanation = "When Do Not Disturb or another Focus is on, your Apple Watch doesn't ring unless Over&Out is on that Focus's list of allowed apps."

    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            step(1, "Open **Settings** and tap **Focus**.")
            step(2, "Tap a Focus you use, such as **Do Not Disturb** or **Sleep**.")
            step(3, "Under **Allow Notifications**, tap **Apps**, then **Add** and choose **Over&Out**.")
            step(4, "Repeat for each Focus. Your watch follows your iPhone.")
            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
            } label: {
                Label("Open Settings", systemImage: "gear")
            }
            .padding(.top, 4)
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
}
