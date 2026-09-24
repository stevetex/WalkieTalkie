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

    // Diagnostics: the app looked paused for seconds at a time on a real watch.
    func applicationDidBecomeActive() { SpikeController.shared.noteAppState("active") }
    func applicationWillResignActive() { SpikeController.shared.noteAppState("inactive") }
    func applicationDidEnterBackground() { SpikeController.shared.noteAppState("background") }
    func applicationWillEnterForeground() { SpikeController.shared.noteAppState("foreground") }
}
