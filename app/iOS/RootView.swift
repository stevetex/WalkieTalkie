import SwiftUI

/// Placeholder. The MVP's iPhone app is a companion: sign-in, invites, friends and settings.
struct ContentView: View {
    var body: some View {
        VStack(spacing: 8) {
            Text("Over&Out")
                .font(.largeTitle.bold())
            Text("Walkie-talkie for Apple Watch")
                .foregroundStyle(.secondary)
        }
        .padding()
    }
}

#Preview {
    ContentView()
}
