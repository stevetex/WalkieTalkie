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
/// While `ringing`, the mascot wiggles and its mouth shows a bell and doesn't respond. A
/// `hint` ("Hold to talk" on the watch) curves along the bottom of the mouth while it's idle.
public struct MascotTalkButton: View {
    public enum MouthState { case idle, disabled, waiting, talking, listening }

    let state: MouthState
    let ringing: Bool
    let friendName: String
    let hint: String?
    let onPressChange: (Bool) -> Void

    @State private var pressed = false

    public init(state: MouthState, ringing: Bool, friendName: String, hint: String? = nil,
                onPressChange: @escaping (Bool) -> Void) {
        self.state = state
        self.ringing = ringing
        self.friendName = friendName
        self.hint = hint
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
        if let hint, state == .idle, !ringing {
            // The microphone moves up to make room for the words below it.
            mouthSymbol(size: r * 0.62, t: t)
                .position(x: mouth.x, y: mouth.y - r * 0.2)
            ArcText(text: hint.uppercased(), radius: r * 0.68, fontSize: r * 0.26, tracking: 0.04)
                .foregroundStyle(Brand.ivory)
                .position(mouth)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        } else {
            mouthSymbol(size: r * 0.95, t: t)
                .position(mouth)
        }

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

/// Text along the bottom of a circle, reading left to right with each letter's top toward
/// the centre, centred on the lowest point. Letters are spaced by their measured widths.
struct ArcText: View {
    let text: String
    let radius: CGFloat
    let fontSize: CGFloat
    var tracking: CGFloat = 0.08

    var body: some View {
        let letters = Array(text).map(String.init)
        let widths = letters.map { Self.width(of: $0, size: fontSize) + fontSize * tracking }
        let total = widths.reduce(0, +)
        // Angles in degrees, clockwise from the positive x axis (y points down): 90 is the bottom.
        let start = 90 + Double(total / radius) * 90 / .pi
        ZStack {
            ForEach(letters.indices, id: \.self) { i in
                let before = widths[..<i].reduce(0, +)
                let angle = start - Double((before + widths[i] / 2) / radius) * 180 / .pi
                Text(letters[i])
                    .font(.system(size: fontSize, weight: .bold))
                    .fixedSize()
                    .rotationEffect(.degrees(angle - 90))
                    .offset(x: radius * CGFloat(cos(angle * .pi / 180)), y: radius * CGFloat(sin(angle * .pi / 180)))
            }
        }
        .frame(width: radius * 2, height: radius * 2)
    }

    private static func width(of letter: String, size: CGFloat) -> CGFloat {
        #if canImport(UIKit)
        return (letter as NSString).size(withAttributes: [.font: UIFont.systemFont(ofSize: size, weight: .bold)]).width
        #else
        return size * 0.6
        #endif
    }
}
