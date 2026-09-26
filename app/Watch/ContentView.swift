import SwiftUI

struct ContentView: View {
    @ObservedObject var controller: ConversationController

    private var talkTitle: String {
        if let name = controller.peerName { return name }
        let s = controller.settings
        return s.friendName.isEmpty ? s.friendId : s.friendName
    }

    private var status: String {
        if !controller.statusLine.isEmpty { return controller.statusLine }
        return controller.settings.hasFriend ? "Hold to talk" : "Pick a friend in Settings"
    }

    var body: some View {
        VStack(spacing: 6) {
            if let ring = controller.incomingRing {
                Text("\(ring.fromName) is calling")
                    .font(.footnote)
                HStack {
                    Button("Answer") { controller.answerIncomingRing() }
                        .tint(.green)
                    Button("Decline", role: .destructive) { controller.declineIncomingRing() }
                }
            } else {
                Text(status)
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .foregroundStyle(controller.remoteTalking ? .green : .secondary)

                TalkButton(
                    title: talkTitle.isEmpty ? "Talk" : talkTitle,
                    isTalking: controller.isTalking,
                    isWaiting: controller.phase != .idle && !controller.talkReady,
                    isDisabled: controller.phase == .idle && !controller.settings.hasFriend
                ) { pressed in
                    pressed ? controller.talkPressed() : controller.talkReleased()
                }

                if controller.phase != .idle {
                    Button("End", role: .destructive) { controller.end() }
                        .controlSize(.mini)
                }
            }
        }
        .padding(.horizontal, 4)
        .toolbar {
            ToolbarItem(placement: settingsPlacement) {
                NavigationLink {
                    SettingsView(controller: controller)
                } label: {
                    Image(systemName: "gearshape")
                }
                .accessibilityLabel("Settings")
            }
        }
        .task { controller.requestMicrophone() }
    }

    private var settingsPlacement: ToolbarItemPlacement {
        if #available(watchOS 10.0, *) { return .topBarTrailing }
        return .automatic
    }
}

/// Hold to talk. A zero-distance drag reports both press and release; the main screen has
/// no scroll view that could steal the gesture mid-press.
struct TalkButton: View {
    let title: String
    let isTalking: Bool
    /// In a conversation but not ready to record yet (audio or relay still starting).
    let isWaiting: Bool
    let isDisabled: Bool
    let onPressChange: (Bool) -> Void

    @State private var pressed = false

    var body: some View {
        ZStack {
            Circle()
                .fill(isWaiting ? Color.gray : isTalking ? Color.red : Color.yellow)
                .opacity(isDisabled ? 0.3 : 1)
            VStack(spacing: 2) {
                Image(systemName: isWaiting ? "hourglass" : isTalking ? "waveform" : "mic.fill")
                    .font(.title2)
                Text(isWaiting ? "Wait…" : isTalking ? "Talking" : title)
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
