import OverAndOutKit
import SwiftUI
import WatchKit

@main
struct OverAndOutWatchApp: App {
    @WKApplicationDelegateAdaptor private var delegate: AppDelegate

    var body: some Scene {
        WindowGroup {
            NavigationStack {
                ContentView(controller: .shared, account: .shared)
            }
        }
    }
}

final class AppDelegate: NSObject, WKApplicationDelegate {
    // Tapping a ring can launch the app, so the controller (and its notification delegate)
    // must exist before any view does.
    func applicationDidFinishLaunching() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        Telemetry.shared.configure(platform: .watch, directory: support.appendingPathComponent("Diagnostics"), maxBytes: 1_000_000)
        WatchDiagnostics.launched()
        ConversationController.shared.start()
    }

    func didRegisterForRemoteNotifications(withDeviceToken deviceToken: Data) {
        ConversationController.shared.didRegisterForRemoteNotifications(deviceToken: deviceToken)
    }

    func didFailToRegisterForRemoteNotificationsWithError(_ error: Error) {
        ConversationController.shared.didFailToRegisterForRemoteNotifications(error)
    }

    // Diagnostics for the timeline: wrist down, app in the background.
    func applicationDidBecomeActive() {
        WatchDiagnostics.becameActive()
        ConversationController.shared.noteAppState("active")
        ConversationController.shared.scheduleAccountRefresh()
    }
    func applicationWillResignActive() { ConversationController.shared.noteAppState("inactive") }
    func applicationDidEnterBackground() {
        WatchDiagnostics.enteredBackground()
        ConversationController.shared.noteAppState("background")
        #if DEBUG
        if ConversationController.shared.quitWhenBackgrounded { exit(0) }
        #endif
    }
    func applicationWillEnterForeground() { ConversationController.shared.noteAppState("foreground") }
}
