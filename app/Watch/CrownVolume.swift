import OverAndOutKit
import SwiftUI
import WatchKit

/// The Digital Crown sets how loud friends' messages play, on a Talk screen, as in Apple's
/// Walkie-Talkie. It works whether or not a message is playing. The level shows only while it
/// changes: a speaker with a ring fades in when the crown turns and out `shownFor` after the last
/// change (Steve, 2026-10-03), so the screen is just the mascot otherwise.
///
/// The app reads the crown itself (SwiftUI's digitalCrownRotation) and sets its own playback
/// volume, on top of the watch's. WatchKit's volume control, used before, never got the crown on
/// Helen's Series 9 (builds 220 and 225: no change, no indicator), even focused every second.
/// The loudest this can be is the watch's own volume (Settings → Sounds & Haptics).
///
/// Diagnostics (build 232: Helen's crown still did nothing, up or down): each visit reports
/// whether the screen got the crown's focus, lost it, and how many crown events reached it
/// (`crownScreen`, with the accessibility settings the app can see), and the first focus and
/// crown event are marked in a conversation's timeline. Focus is also asked for again shortly
/// after the screen appears, in case the first request comes before the screen can take it.
struct CrownVolume: View {
    @ObservedObject var controller: ConversationController
    @State private var level = Double(ConversationController.storedPlaybackVolume)
    @State private var changes = 0
    @State private var shown = false
    @FocusState private var hasCrown: Bool
    @State private var visit = CrownVisit()

    static let shownFor: Duration = .seconds(2)

    var body: some View {
        // The focusable frame is always there; only the indicator inside fades.
        Color.clear
            .overlay {
                VolumeIndicator(level: level)
                    .opacity(shown ? 1 : 0)
                    .animation(.easeOut(duration: 0.25), value: shown)
            }
            .contentShape(Rectangle())
            .focusable()
            .focusEffectDisabled()
            .focused($hasCrown)
            .digitalCrownRotation(detent: $level, from: 0, through: 1, by: 0.05, sensitivity: .low,
                                  isContinuous: false, isHapticFeedbackEnabled: true,
                                  onChange: { _ in crownTurned() }, onIdle: {})
            .onChange(of: level) { _, new in
                controller.setPlaybackVolume(Float(new))
                visit.levelChanges += 1
                changes += 1
            }
            // Each change restarts the countdown: a new change cancels the last one's task.
            .task(id: changes) {
                guard changes > 0 else { return }
                shown = true
                guard (try? await Task.sleep(for: Self.shownFor)) != nil else { return }
                shown = false
            }
            // Nothing else on the Talk screen uses the crown, so it always comes back here.
            .onAppear {
                visit = CrownVisit()
                hasCrown = true
            }
            .task {
                for delay in [Duration.milliseconds(300), .seconds(1)] {
                    guard (try? await Task.sleep(for: delay)) != nil else { return }
                    if !hasCrown { visit.lateRequests += 1 }
                    hasCrown = true
                }
            }
            .onChange(of: hasCrown) { _, has in
                if has {
                    visit.focusGains += 1
                    if visit.focusGains == 1 { controller.markCrown("crownFocus", detail: "after \(visit.elapsedMs) ms") }
                } else {
                    visit.focusLosses += 1
                    controller.markCrown("crownFocusLost", detail: "after \(visit.elapsedMs) ms")
                    hasCrown = true
                }
            }
            .onDisappear { visit.report(level: level) }
            .accessibilityElement()
            .accessibilityLabel("Volume")
            .accessibilityValue("\(Int((level * 100).rounded())) percent")
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment: level = min(1, level + 0.1)
                case .decrement: level = max(0, level - 0.1)
                @unknown default: break
                }
            }
    }
}

extension CrownVolume {
    /// Any crown movement, also at 0 or 100% where the level can't change: the ring shows, so a
    /// turn past the end still says where the volume is.
    private func crownTurned() {
        visit.crownEvents += 1
        if visit.crownEvents == 1 { controller.markCrown("crownTurned", detail: "after \(visit.elapsedMs) ms, level \(String(format: "%.2f", level))") }
        changes += 1
    }
}

/// One Talk screen visit's crown, reported when it closes.
private struct CrownVisit {
    let appearedAt = Date()
    var focusGains = 0
    var focusLosses = 0
    var lateRequests = 0
    var crownEvents = 0
    var levelChanges = 0

    var elapsedMs: Int { Int(Date().timeIntervalSince(appearedAt) * 1000) }

    func report(level: Double) {
        Telemetry.shared.event("crownScreen", [
            "seconds": Int(Date().timeIntervalSince(appearedAt)),
            "focusGains": focusGains,
            "focusLosses": focusLosses,
            "lateRequests": lateRequests,
            "crownEvents": crownEvents,
            "levelChanges": levelChanges,
            "level": (level * 100).rounded() / 100,
            "voiceOver": WKAccessibilityIsVoiceOverRunning(),
            "reduceMotion": WKAccessibilityIsReduceMotionEnabled(),
            "screenWidth": Int(WKInterfaceDevice.current().screenBounds.width),
        ])
    }
}

/// A speaker inside a ring that fills with the level.
private struct VolumeIndicator: View {
    let level: Double

    var body: some View {
        ZStack {
            Circle()
                .fill(Brand.indigo.opacity(0.85))
            Circle()
                .stroke(Brand.ivory.opacity(0.25), lineWidth: 3)
            Circle()
                .trim(from: 0, to: level)
                .stroke(Brand.orange, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Image(systemName: level == 0 ? "speaker.slash.fill" : "speaker.wave.2.fill")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Brand.ivory)
        }
        .padding(1.5)
    }
}
