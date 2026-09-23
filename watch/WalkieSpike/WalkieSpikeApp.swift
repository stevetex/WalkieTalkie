import SwiftUI
import WatchKit

@main
struct WalkieSpikeApp: App {
    @WKApplicationDelegateAdaptor private var delegate: AppDelegate

    var body: some Scene {
        WindowGroup {
            NavigationStack {
                ContentView(controller: .shared)
            }
        }
    }
}

final class AppDelegate: NSObject, WKApplicationDelegate {
    // A VoIP push can launch the app in the background with no UI, so the push
    // registry and CallKit provider must exist before any view does.
    func applicationDidFinishLaunching() {
        SpikeController.shared.start()
    }
}
