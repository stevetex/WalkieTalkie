import OverAndOutKit
import SwiftUI

/// Talking to one friend (design decision 2026-09-27): the mascot on indigo, its mouth is
/// hold-to-talk, as on the watch. The friend's photo and name are at the top, with End during
/// a conversation and the friend page (report, block, remove) behind the info button.
struct TalkView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var talk: TalkController
    @EnvironmentObject private var ptt: PushToTalkChannel
    let friend: Friend

    /// This screen's friend is in the conversation (or nobody is).
    private var isCurrent: Bool { talk.peerId == nil || talk.peerId == friend.id }

    private var mouthState: MascotTalkButton.MouthState {
        guard isCurrent else { return .idle }
        if talk.isTalking { return talk.talkReady ? .talking : .waiting }
        if talk.phase != .idle && !talk.talkReady { return .waiting }
        if talk.remoteTalking { return .listening }
        return .idle
    }

    private var statusColor: Color {
        switch mouthState {
        case .talking: return Brand.orange
        case .listening: return .green
        default: return Brand.silver
        }
    }

    private var status: String {
        if let other = talk.peerName, !isCurrent { return "In a conversation with \(other)" }
        if !talk.statusLine.isEmpty { return talk.statusLine }
        return "Hold the mouth to talk to \(friend.name)"
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            MascotTalkButton(state: mouthState, ringing: false, friendName: friend.name) { pressed in
                pressed ? talk.talkPressed(to: friend) : talk.talkReleased()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.horizontal, 40)
            .padding(.vertical, 12)
            Text(status)
                .font(.callout.weight(.semibold))
                .foregroundStyle(statusColor)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .padding(.horizontal, 24)
                .padding(.bottom, 12)
            availabilityNote
                .padding(.bottom, 16)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Brand.indigo.ignoresSafeArea())
        .foregroundStyle(Brand.ivory)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .toolbarBackground(Brand.indigo, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                NavigationLink {
                    FriendDetailView(friend: friend)
                } label: {
                    Image(systemName: "info.circle")
                }
                .accessibilityLabel("About \(friend.name)")
            }
        }
        .task { await model.requestMicrophone() }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Avatar(name: friend.name, userId: friend.id, photoVersion: friend.photoVersion, size: 44, client: model.client)
            Text(friend.name)
                .font(.title3.weight(.semibold))
                .lineLimit(1)
            Spacer()
            if talk.phase != .idle, isCurrent {
                Button(role: .destructive) { talk.end() } label: {
                    Label("End", systemImage: "xmark")
                        .font(.callout.weight(.semibold))
                }
                .buttonStyle(.bordered)
                .tint(.red)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
    }

    /// How friends reach this iPhone, when it isn't through the walkie-talkie channel.
    @ViewBuilder
    private var availabilityNote: some View {
        if ptt.isAvailable && !ptt.isJoined {
            Text("Walkie-talkie is off on this iPhone, so friends reach it only while Over&Out is open. Turn it on in Settings.")
                .font(.footnote)
                .foregroundStyle(Brand.silver)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
        }
    }
}

/// A ring over the open relay stream while the app is on screen (in-app mode): the mascot
/// wiggles, with Answer and Decline below it, as on the watch.
struct IncomingRingView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var talk: TalkController
    let ring: Ring

    var body: some View {
        VStack(spacing: 20) {
            if let friend = model.friends.first(where: { $0.id == ring.from }) {
                Avatar(name: friend.name, userId: friend.id, photoVersion: friend.photoVersion, size: 64, client: model.client)
            }
            VStack(spacing: 4) {
                Text(ring.fromName)
                    .font(.largeTitle.bold())
                Text("is calling")
                    .font(.title3)
                    .foregroundStyle(Brand.silver)
            }
            MascotTalkButton(state: .idle, ringing: true, friendName: ring.fromName) { _ in }
                .frame(maxHeight: 320)
                .allowsHitTesting(false)
            HStack(spacing: 16) {
                Button(role: .destructive) { talk.declineIncomingRing() } label: {
                    Text("Decline").frame(maxWidth: .infinity)
                }
                .tint(.red)
                Button { talk.answerIncomingRing() } label: {
                    Text("Answer").frame(maxWidth: .infinity)
                }
                .tint(.green)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .foregroundStyle(.white)
            .padding(.horizontal, 24)
        }
        .padding(.vertical, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Brand.indigo.ignoresSafeArea())
        .foregroundStyle(Brand.ivory)
    }
}

/// Where the mouth and antenna ball sit in OverAndOutMascot, as fractions of the image's
/// width and height. The same art and numbers as the watch's (Watch/ContentView.swift).
private enum MascotGeometry {
    static let aspect: CGFloat = 762.0 / 1184.0
    static let mouth = CGPoint(x: 317.0 / 762, y: 853.0 / 1184)
    static let mouthRadius: CGFloat = 182.0 / 762
    static let ringRadius: CGFloat = 222.0 / 762
    static let ball = CGPoint(x: 540.0 / 762, y: 62.0 / 1184)
    static let ballRadius: CGFloat = 26.0 / 762
}

/// The mascot, whose mouth is hold-to-talk: a copy of the watch's, so the watch's code stays
/// as measured (backlog: share it through the kit).
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
                .frame(width: r + ring, height: r + ring)
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
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
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
