import SwiftUI

/// The connection with a friend, beside their name on the Talk screen and in the friends
/// list: one antenna, told apart by its shape as well as its colour (design decision
/// 2026-09-29). None when idle.
struct ConnectionGlyph: View {
    enum Status {
        /// Waves animating outward, yellow.
        case connecting
        /// A conversation is open: the antenna with its waves, green.
        case live
        /// They didn't answer or can't be reached: the antenna struck through, red.
        case unavailable
    }

    let status: Status
    var size: CGFloat = 15

    var body: some View {
        symbol
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(color)
            .accessibilityLabel(label)
    }

    @ViewBuilder
    private var symbol: some View {
        switch status {
        case .connecting:
            Image(systemName: "antenna.radiowaves.left.and.right")
                .symbolEffect(.variableColor.iterative)
        case .live:
            Image(systemName: "antenna.radiowaves.left.and.right")
        case .unavailable:
            Image(systemName: "antenna.radiowaves.left.and.right.slash")
        }
    }

    private var color: Color {
        switch status {
        case .connecting: return .yellow
        case .live: return .green
        case .unavailable: return .red
        }
    }

    private var label: String {
        switch status {
        case .connecting: return "Connecting"
        case .live: return "Connected"
        case .unavailable: return "Unavailable"
        }
    }
}
