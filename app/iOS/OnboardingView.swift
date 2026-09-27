import OverAndOutKit
import SwiftUI

/// After the first sign-in: the name friends see, letting rings through Focus (design
/// decision 2026-09-26), and the watch.
struct OnboardingView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var watch: PhoneWatchLink
    @State private var step = 0
    @State private var name = ""
    @State private var saving = false

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ProgressView(value: Double(step + 1), total: 3)
                        .tint(Brand.orange)
                        .padding(.bottom, 32)
                    switch step {
                    case 0: nameStep
                    case 1: focusStep
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
            Text("Your name appears on their watch when you ring them.")
                .foregroundStyle(Brand.secondary)
            TextField("Your name", text: $name)
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

    private var watchStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Over&Out on your watch")
                .font(.title.bold())
            if !watch.isPaired {
                Text("Over&Out needs an Apple Watch paired with this iPhone. You can still invite friends now.")
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
