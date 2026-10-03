import AVFoundation
import OverAndOutKit
import SwiftUI
import WatchKit

/// The Digital Crown turns the watch's volume on the Talk screen, as in Apple's Walkie-Talkie.
/// The level shows only while it changes: the speaker fades in when the volume moves and out
/// `shownFor` after the last change (Steve, 2026-10-03), so the screen is just the mascot
/// otherwise. Invisible, it still has the crown.
struct CrownVolume: View {
    @State private var changes = 0
    @State private var shown = false

    static let shownFor: Duration = .seconds(2)

    var body: some View {
        VolumeControl()
            .opacity(shown ? 1 : 0)
            .animation(.easeOut(duration: 0.25), value: shown)
            // The volume the crown just set (the first value is the current one, not a change).
            .onReceive(AVAudioSession.sharedInstance().publisher(for: \.outputVolume).dropFirst().receive(on: RunLoop.main)) { _ in
                changes += 1
            }
            // Each change restarts the countdown: a new change cancels the last one's task.
            .task(id: changes) {
                guard changes > 0 else { return }
                shown = true
                guard (try? await Task.sleep(for: Self.shownFor)) != nil else { return }
                shown = false
            }
    }
}

/// WatchKit's volume control (SwiftUI has none on watchOS), focused so the crown turns it. It
/// sets the watch's own output volume (origin .local), the one a friend's message plays at.
private struct VolumeControl: WKInterfaceObjectRepresentable {
    func makeWKInterfaceObject(context: Context) -> WKInterfaceVolumeControl {
        let control = WKInterfaceVolumeControl(origin: .local)
        control.setTintColor(UIColor(Brand.orange))
        return control
    }

    func updateWKInterfaceObject(_ control: WKInterfaceVolumeControl, context: Context) {
        // Nothing else on the Talk screen uses the crown.
        control.focus()
    }
}
