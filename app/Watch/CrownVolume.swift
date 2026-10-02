import OverAndOutKit
import SwiftUI
import WatchKit

/// The Digital Crown turns the watch's volume on the Talk screen, as in Apple's Walkie-Talkie.
/// SwiftUI has no volume control on watchOS, so this is WatchKit's: a small speaker that shows
/// the level, focused so the crown turns it. It sets the watch's own output volume (origin
/// .local), the one a friend's message plays at.
struct CrownVolume: WKInterfaceObjectRepresentable {
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
