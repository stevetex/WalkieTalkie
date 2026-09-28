import OverAndOutKit
import SwiftUI

/// After the first sign-in: the name friends see, letting rings through Focus (design
/// decision 2026-09-26), talking from the iPhone (2026-09-27), and the watch.
struct OnboardingView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var watch: PhoneWatchLink
    @EnvironmentObject private var ptt: PushToTalkChannel
    @State private var step = 0
    @State private var askedMicrophone = false
    @State private var name = ""
    @State private var saving = false

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ProgressView(value: Double(step + 1), total: 4)
                        .tint(Brand.orange)
                        .padding(.bottom, 32)
                    switch step {
                    case 0: nameStep
                    case 1: focusStep
                    case 2: phoneStep
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

    private var nameStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("What should friends call you?")
                .font(.title.bold())
            Text("Your screen name appears on their iPhone or watch when you talk to them.")
                .foregroundStyle(Brand.secondary)
            ProfilePhotoPicker(size: 56)
            TextField("Screen name", text: $name)
                .font(.title3)
                .textContentType(.givenName)
                .padding(14)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
                .submitLabel(.continue)
                .onSubmit(saveName)
            Spacer()
            Button(action: saveName) {
                Text("Continue").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .foregroundStyle(Brand.ink)
            .controlSize(.large)
            .tint(Brand.orange)
            .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || saving)
        }
    }

    private var focusStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Let rings through Focus")
                .font(.title.bold())
            Text("When Do Not Disturb or another Focus is on, your watch stays silent unless Over&Out is on that Focus's list of allowed apps.")
                .foregroundStyle(Brand.secondary)
            FocusSteps()
            Spacer()
            Button {
                step = 2
            } label: {
                Text("I've Added It").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .foregroundStyle(Brand.ink)
            .controlSize(.large)
            .tint(Brand.orange)
            Button("Skip for Now") { step = 2 }
                .frame(maxWidth: .infinity)
        }
    }

    /// The microphone, then the PushToTalk channel (only on a device with PushToTalk).
    private var phoneStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Talk from your iPhone")
                .font(.title.bold())
            Text("Hold the mascot's mouth to talk. Over&Out uses the microphone only while you hold it.")
                .foregroundStyle(Brand.secondary)
            if ptt.isAvailable {
                Text("Turn on walkie-talkie so friends' messages play on this iPhone right away, even when it's locked. You can turn it off in Settings or from the Lock Screen.")
                    .foregroundStyle(Brand.secondary)
            }
            Spacer()
            Button {
                Task {
                    if !askedMicrophone {
                        askedMicrophone = true
                        await model.requestMicrophone()
                    }
                    if ptt.isAvailable, !ptt.isJoined { ptt.join() }
                    step = 3
                }
            } label: {
                Text(ptt.isAvailable ? "Turn On Walkie-Talkie" : "Allow the Microphone").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .foregroundStyle(Brand.ink)
            .controlSize(.large)
            .tint(Brand.orange)
            Button("Not Now") { step = 3 }
                .frame(maxWidth: .infinity)
        }
    }

    private var watchStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Over&Out on your watch")
                .font(.title.bold())
            if !watch.isPaired {
                Text("With an Apple Watch paired to this iPhone, you can talk from your wrist too. You're ready to invite friends.")
                    .foregroundStyle(Brand.secondary)
            } else if !watch.isWatchAppInstalled {
                Text("Install Over&Out on your watch: open the Watch app on this iPhone, scroll to Available Apps, and tap Install next to Over&Out.")
                    .foregroundStyle(Brand.secondary)
            } else {
                Text("Open Over&Out on your watch. It signs in with this account by itself.")
                    .foregroundStyle(Brand.secondary)
            }
            Spacer()
            Button {
                model.onboarded = true
            } label: {
                Text("Done").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .foregroundStyle(Brand.ink)
            .controlSize(.large)
            .tint(Brand.orange)
        }
    }

    private func saveName() {
        let clean = name.trimmingCharacters(in: .whitespaces)
        guard !clean.isEmpty else { return }
        guard clean != model.displayName else {
            step = 1
            return
        }
        saving = true
        Task {
            if await model.rename(clean) { step = 1 }
            saving = false
        }
    }
}

/// Settings → Focus → (each Focus) → Apps → Allow Notifications From → add Over&Out.
struct FocusSteps: View {
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
