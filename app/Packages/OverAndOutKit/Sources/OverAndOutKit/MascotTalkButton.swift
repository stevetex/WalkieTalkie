import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// Where the mouth and antenna ball sit in OverAndOutMascot, as fractions of the image's
/// width and height. Measured on art/masters/mascot-color.png cropped to x 262–1024,
/// y 36–1220 (the asset), where the black speaker is centred at (317, 853) with radius 182.
public enum MascotGeometry {
    public static let aspect: CGFloat = 762.0 / 1184.0
    static let mouth = CGPoint(x: 317.0 / 762, y: 853.0 / 1184)
    static let mouthRadius: CGFloat = 182.0 / 762 // the black speaker, of the width
    static let ringRadius: CGFloat = 222.0 / 762 // the silver ring around it: the touch area
    static let ball = CGPoint(x: 540.0 / 762, y: 62.0 / 1184)
    static let ballRadius: CGFloat = 26.0 / 762 // the ball's light centre
}

/// The mascot (OverAndOutMascot, in each app's assets), whose mouth is hold-to-talk, on the
/// watch's main screen and the iPhone's Talk screen. A zero-distance drag reports both press
/// and release; neither screen has a scroll view that could steal the gesture mid-press.
/// While `ringing`, the mascot wiggles and its mouth shows a bell and doesn't respond.
public struct MascotTalkButton: View {
    public enum MouthState { case idle, disabled, waiting, talking, listening }

    let state: MouthState
    let ringing: Bool
    let friendName: String
    let onPressChange: (Bool) -> Void

    @State private var pressed = false

    public init(state: MouthState, ringing: Bool, friendName: String, onPressChange: @escaping (Bool) -> Void) {
        self.state = state
        self.ringing = ringing
        self.friendName = friendName
        self.onPressChange = onPressChange
    }

    public var body: some View {
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

        if state == .talking && !ringing {
            Circle()
                .fill(Brand.orange)
                .frame(width: MascotGeometry.ballRadius * 2 * w, height: MascotGeometry.ballRadius * 2 * w)
                .position(x: MascotGeometry.ball.x * w, y: MascotGeometry.ball.y * size.height)
            Circle()
                .fill(Brand.orange)
                .frame(width: r * 2, height: r * 2)
                .position(mouth)
        }
        if ringing || state == .listening || state == .waiting {
            Circle()
                .stroke(ringing ? Brand.orange : state == .listening ? Color.green : Brand.silver, lineWidth: r * 0.16)
                .opacity(state == .waiting || ringing ? 0.3 + 0.7 * pulse : 1)
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
                        #if os(iOS)
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        #endif
                        onPressChange(true)
                    }
                    .onEnded { _ in
                        guard pressed else { return }
                        pressed = false
                        onPressChange(false)
                    }
            )
            .accessibilityElement()
            .accessibilityLabel(ringing ? "\(friendName) is calling" : "Hold to talk to \(friendName)")
            .accessibilityAddTraits(ringing ? [] : .isButton)
    }

    private func mouthSymbol(size: CGFloat, t: TimeInterval) -> some View {
        let name: String
        let color: Color
        var scale: CGFloat = 1
        var angle: Double = 0
        switch state {
        case _ where ringing:
            name = "bell.fill"; color = Brand.ivory
            angle = sin(t * 2 * .pi * 5) * 12
        case .idle, .disabled: name = "mic.fill"; color = Brand.ivory
        case .waiting: name = "hourglass"; color = Brand.ivory
        case .talking: name = "waveform"; color = Brand.ink
        case .listening:
            name = "waveform"; color = Brand.ivory
            scale = 0.85 + 0.15 * CGFloat(abs(sin(t * 2 * .pi * 2)))
        }
        return Image(systemName: name)
            .font(.system(size: size * (ringing ? 0.8 : 1), weight: .semibold))
            .foregroundStyle(color)
            .opacity(state == .disabled && !ringing ? 0.3 : 1)
            .scaleEffect(scale)
            .rotationEffect(.degrees(angle))
            .allowsHitTesting(false)
    }
}
