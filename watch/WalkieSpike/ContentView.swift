import SwiftUI

struct ContentView: View {
    @ObservedObject var controller: SpikeController

    private var friendLabel: String {
        let s = controller.settings
        return s.friendName.isEmpty ? s.friendId : s.friendName
    }

    var body: some View {
        VStack(spacing: 6) {
            Text(controller.settings.isConfigured ? controller.statusLine : "Pick a server and friend in Settings")
                .font(.footnote)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .foregroundStyle(controller.remoteTalking ? .green : .secondary)

            TalkButton(
                title: friendLabel.isEmpty ? "Talk" : friendLabel,
                isTalking: controller.isTalking,
                isDisabled: !controller.settings.isConfigured
            ) { pressed in
                pressed ? controller.talkPressed() : controller.talkReleased()
            }

            if controller.phase == .ringing {
                HStack {
                    Button("Answer") { controller.answer() }
                        .tint(.green)
                    Button("Decline", role: .destructive) { controller.endCall() }
                }
                .controlSize(.mini)
            } else if controller.phase != .idle {
                Button("End", role: .destructive) { controller.endCall() }
                    .controlSize(.mini)
            }
        }
        .padding(.horizontal, 4)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink {
                    SettingsView(controller: controller)
                } label: {
                    Image(systemName: "gearshape")
                }
            }
        }
        .task { controller.requestMicrophone() }
    }
}

/// Hold to talk. Uses a zero-distance drag so press and release are both reported;
/// the main screen has no scroll view that could steal the gesture mid-press.
struct TalkButton: View {
    let title: String
    let isTalking: Bool
    let isDisabled: Bool
    let onPressChange: (Bool) -> Void

    @State private var pressed = false

    var body: some View {
        ZStack {
            Circle()
                .fill(isTalking ? Color.red : Color.yellow)
                .opacity(isDisabled ? 0.3 : 1)
            VStack(spacing: 2) {
                Image(systemName: isTalking ? "waveform" : "mic.fill")
                    .font(.title2)
                Text(isTalking ? "Talking" : title)
                    .font(.caption)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
            }
            .foregroundStyle(.black)
            .padding(8)
        }
        .frame(maxWidth: 120, maxHeight: 120)
        .scaleEffect(pressed ? 0.94 : 1)
        .animation(.easeOut(duration: 0.1), value: pressed)
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    guard !isDisabled, !pressed else { return }
                    pressed = true
                    onPressChange(true)
                }
                .onEnded { _ in
                    guard pressed else { return }
                    pressed = false
                    onPressChange(false)
                }
        )
        .accessibilityLabel("Hold to talk to \(title)")
        .accessibilityAddTraits(.isButton)
    }
}
