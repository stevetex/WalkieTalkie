import OverAndOutKit
import SwiftUI

struct ContentView: View {
    @ObservedObject var controller: ConversationController
    @ObservedObject var account: WatchAccount

    private var talkTitle: String {
        controller.peerName ?? account.selectedFriend?.name ?? ""
    }

    private var mouthState: MascotTalkButton.MouthState {
        if controller.phase == .idle && account.selectedFriend == nil { return .disabled }
        if controller.phase != .idle && !controller.talkReady { return .waiting }
        if controller.isTalking { return .talking }
        if controller.remoteTalking { return .listening }
        return .idle
    }

    private var statusColor: Color {
        switch mouthState {
        case .talking: return Brand.orange
        case .listening: return .green
        default: return Brand.silver
        }
    }

    var body: some View {
        Group {
            if account.session == nil {
                SignInPrompt(phoneSignedIn: account.phoneSignedIn)
            } else if account.friends.isEmpty && controller.phase == .idle && controller.incomingRing == nil {
                NoFriendsYet(loaded: account.friendsLoaded)
            } else {
                main
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Brand.indigo.ignoresSafeArea())
        .brandScreen()
    }

    /// The mascot fills the screen and its mouth is the Talk button. The friend's name and
    /// End sit top left, away from the mouth, so End isn't hit while talking.
    private var main: some View {
        ZStack(alignment: .topLeading) {
            VStack(spacing: 0) {
                MascotTalkButton(
                    state: mouthState,
                    ringing: controller.incomingRing != nil,
                    friendName: talkTitle.isEmpty ? "your friend" : talkTitle
                ) { pressed in
                    pressed ? controller.talkPressed() : controller.talkReleased()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(.top, 18)
                // Clear of the name and End at top left; the orange side button has room.
                .offset(x: 14)

                if controller.incomingRing != nil {
                    // Below the mascot, which shrinks to make room, so nothing covers the mouth.
                    HStack(spacing: 6) {
                        Button("Answer") { controller.answerIncomingRing() }
                            .tint(.green)
                        Button("Decline", role: .destructive) { controller.declineIncomingRing() }
                            .tint(.red)
                    }
                    .buttonStyle(.borderedProminent)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 8)
                    .padding(.bottom, 8)
                } else {
                    Text(controller.statusLine.isEmpty ? idleStatus : controller.statusLine)
                        .font(.footnote)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .foregroundStyle(statusColor)
                        .padding(.bottom, 10)
                }
            }
            // Up under the time, so the antenna rises between the time and Settings, and down
            // to the bottom edge.
            .ignoresSafeArea(edges: [.top, .bottom])

            topLeft
        }
        .padding(.horizontal, 4)
        .toolbar {
            ToolbarItem(placement: settingsPlacement) {
                NavigationLink {
                    SettingsView(controller: controller, account: account)
                } label: {
                    Image(systemName: "gearshape")
                }
                .accessibilityLabel("Settings")
            }
        }
        .task { controller.requestMicrophone() }
    }

    private var idleStatus: String {
        account.selectedFriend != nil ? "Hold the mouth to talk" : "Choose a friend"
    }

    /// The friend Talk rings (a picker when there's a choice), and End during a conversation.
    private var topLeft: some View {
        VStack(alignment: .leading, spacing: 4) {
            if controller.phase == .idle, controller.incomingRing == nil,
               account.friends.count > 1 || account.selectedFriend == nil {
                NavigationLink {
                    FriendPicker(account: account)
                } label: {
                    HStack(spacing: 2) {
                        Text(account.selectedFriend?.name ?? "Choose")
                        Image(systemName: "chevron.right").font(.caption2)
                    }
                }
                .buttonStyle(.plain)
            } else if let ring = controller.incomingRing {
                if let caller = account.friends.first(where: { $0.id == ring.from }) {
                    Avatar(name: caller.name, userId: caller.id, photoVersion: caller.photoVersion, size: 32, client: account.client)
                }
                Text(ring.fromName)
                Text("is calling")
                    .font(.caption2)
                    .foregroundStyle(Brand.silver)
            } else if !talkTitle.isEmpty {
                Text(talkTitle)
            }
            if controller.phase != .idle {
                Button(role: .destructive) { controller.end() } label: {
                    Label("End", systemImage: "xmark")
                        .labelStyle(.titleAndIcon)
                        .font(.caption2.weight(.semibold))
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
                .fixedSize()
            }
        }
        .font(.footnote.weight(.semibold))
        .lineLimit(1)
        .foregroundStyle(Brand.ivory)
        .frame(maxWidth: 110, alignment: .leading)
    }

    private var settingsPlacement: ToolbarItemPlacement {
        if #available(watchOS 10.0, *) { return .topBarTrailing }
        return .automatic
    }
}

/// Where the mouth and antenna ball sit in OverAndOutMascot, as fractions of the image's
/// width and height. Measured on art/masters/mascot-color.png cropped to x 262–1024,
/// y 36–1220 (the asset), where the black speaker is centred at (317, 853) with radius 182.
private enum MascotGeometry {
    static let aspect: CGFloat = 762.0 / 1184.0
    static let mouth = CGPoint(x: 317.0 / 762, y: 853.0 / 1184)
    static let mouthRadius: CGFloat = 182.0 / 762 // the black speaker, of the width
    static let ringRadius: CGFloat = 222.0 / 762 // the silver ring around it: the touch area
    static let ball = CGPoint(x: 540.0 / 762, y: 62.0 / 1184)
    static let ballRadius: CGFloat = 26.0 / 762 // the ball's light centre
}

/// The mascot, whose mouth is hold-to-talk. A zero-distance drag reports both press and
/// release; the main screen has no scroll view that could steal the gesture mid-press.
struct MascotTalkButton: View {
    enum MouthState { case idle, disabled, waiting, talking, listening }

    let state: MouthState
    let ringing: Bool
    let friendName: String
    let onPressChange: (Bool) -> Void

    @State private var pressed = false

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: !animating)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            Image("OverAndOutMascot")
                .resizable()
                .aspectRatio(MascotGeometry.aspect, contentMode: .fit)
                .accessibilityHidden(true)
                .overlay { GeometryReader { geometry in overlays(geometry.size, t: t) } }
                .scaleEffect(pressed ? 0.97 : 1)
                .rotationEffect(.degrees(ringing ? sin(t * 2 * .pi * 5) * 4 : 0), anchor: .bottom)
                .animation(.easeOut(duration: 0.1), value: pressed)
        }
    }

    private var animating: Bool { ringing || state == .waiting || state == .listening }

    @ViewBuilder
    private func overlays(_ size: CGSize, t: TimeInterval) -> some View {
        let w = size.width
        let mouth = CGPoint(x: MascotGeometry.mouth.x * w, y: MascotGeometry.mouth.y * size.height)
        let r = MascotGeometry.mouthRadius * w
        let ring = MascotGeometry.ringRadius * w
        let pulse = 0.5 + 0.5 * sin(t * 2 * .pi * 1.5)

        if state == .talking {
            Circle()
                .fill(Brand.orange)
                .frame(width: MascotGeometry.ballRadius * 2 * w, height: MascotGeometry.ballRadius * 2 * w)
                .position(x: MascotGeometry.ball.x * w, y: MascotGeometry.ball.y * size.height)
            Circle()
                .fill(Brand.orange)
                .frame(width: r * 2, height: r * 2)
                .position(mouth)
        }
        if state == .listening || state == .waiting {
            Circle()
                .stroke(state == .listening ? Color.green : Brand.silver, lineWidth: r * 0.16)
                .opacity(state == .waiting ? 0.3 + 0.7 * pulse : 1)
                .frame(width: (r + ring), height: (r + ring))
                .position(mouth)
        }
        mouthSymbol(size: r * 0.95, t: t)
            .position(mouth)

        // The touch area: the mouth and its ring, nothing else on the mascot.
        Color.clear
            .frame(width: ring * 2, height: ring * 2)
            .contentShape(Circle())
            .position(mouth)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        guard state != .disabled, !ringing, !pressed else { return }
                        pressed = true
                        onPressChange(true)
                    }
                    .onEnded { _ in
                        guard pressed else { return }
                        pressed = false
                        onPressChange(false)
                    }
            )
            .accessibilityElement()
            .accessibilityLabel("Hold to talk to \(friendName)")
            .accessibilityAddTraits(.isButton)
    }

    private func mouthSymbol(size: CGFloat, t: TimeInterval) -> some View {
        let name: String
        let color: Color
        var scale: CGFloat = 1
        switch state {
        case .idle, .disabled: name = "mic.fill"; color = Brand.ivory
        case .waiting: name = "hourglass"; color = Brand.ivory
        case .talking: name = "waveform"; color = Brand.ink
        case .listening:
            name = "waveform"; color = Brand.ivory
            scale = 0.85 + 0.15 * CGFloat(abs(sin(t * 2 * .pi * 2)))
        }
        return Image(systemName: name)
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(color)
            .opacity(state == .disabled ? 0.3 : 1)
            .scaleEffect(scale)
            .allowsHitTesting(false)
    }
}

/// No session yet: the iPhone app signs the watch in.
struct SignInPrompt: View {
    let phoneSignedIn: Bool?

    var body: some View {
        VStack(spacing: 8) {
            SmallMascot()
            if phoneSignedIn == true {
                ProgressView()
                Text("Signing in from your iPhone…")
                    .font(.footnote)
                    .multilineTextAlignment(.center)
            } else {
                Text("Open Over&Out on your iPhone and sign in")
                    .font(.footnote)
                    .multilineTextAlignment(.center)
            }
        }
        .padding()
        .foregroundStyle(Brand.ivory)
    }
}

struct NoFriendsYet: View {
    let loaded: Bool

    var body: some View {
        VStack(spacing: 8) {
            SmallMascot()
            Text(loaded ? "Invite a friend from Over&Out on your iPhone" : "Loading friends…")
                .font(.footnote)
                .multilineTextAlignment(.center)
        }
        .padding()
        .foregroundStyle(Brand.ivory)
    }
}

/// The mascot above a short message, on the screens before the main one.
struct SmallMascot: View {
    var body: some View {
        Image("OverAndOutMascot")
            .resizable()
            .aspectRatio(contentMode: .fit)
            .frame(height: 76)
            .accessibilityHidden(true)
    }
}

struct FriendPicker: View {
    @ObservedObject var account: WatchAccount
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List(account.friends) { friend in
            Button {
                account.selectedFriendId = friend.id
                dismiss()
            } label: {
                HStack {
                    Avatar(name: friend.name, userId: friend.id, photoVersion: friend.photoVersion, size: 28, client: account.client)
                    Text(friend.name)
                    Spacer()
                    if friend.id == account.selectedFriend?.id {
                        Image(systemName: "checkmark").foregroundStyle(Brand.accent)
                    }
                }
            }
            .listRowBackground(Brand.surface)
        }
        .brandScreen()
        .navigationTitle("Friends")
    }
}
