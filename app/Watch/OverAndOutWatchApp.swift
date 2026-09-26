import SwiftUI
import WatchKit

@main
struct OverAndOutWatchApp: App {
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
    // Tapping a ring can launch the app, so the controller (and its notification delegate)
    // must exist before any view does.
    func applicationDidFinishLaunching() {
        ConversationController.shared.start()
    }

    func didRegisterForRemoteNotifications(withDeviceToken deviceToken: Data) {
        ConversationController.shared.didRegisterForRemoteNotifications(deviceToken: deviceToken)
    }

    func didFailToRegisterForRemoteNotificationsWithError(_ error: Error) {
        ConversationController.shared.didFailToRegisterForRemoteNotifications(error)
    }

    // Diagnostics for the timeline: wrist down, app in the background.
    func applicationDidBecomeActive() { ConversationController.shared.noteAppState("active") }
    func applicationWillResignActive() { ConversationController.shared.noteAppState("inactive") }
    func applicationDidEnterBackground() { ConversationController.shared.noteAppState("background") }
    func applicationWillEnterForeground() { ConversationController.shared.noteAppState("foreground") }
}
