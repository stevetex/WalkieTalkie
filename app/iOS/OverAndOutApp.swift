import SwiftUI

/// Makes the model, and so the PushToTalk channel manager, as the app launches, including
/// when a PushToTalk push launches it in the background.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        TalkController.logger.notice("Launched, state \(application.applicationState.rawValue)")
        _ = AppModel.shared
        return true
    }
}

@main
struct OverAndOutApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .environmentObject(model.watch)
                .environmentObject(model.talk)
                .environmentObject(model.pushToTalk)
                // Invite links: universal links from Messages arrive as either of these.
                .onOpenURL { model.open($0) }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL { model.open(url) }
                }
                .onChange(of: scenePhase) { phase in
                    switch phase {
                    case .active:
                        model.talk.appBecameActive()
                        Task {
                            await model.registerDevice()
                            await model.refresh()
                        }
                    case .background:
                        model.talk.appEnteredBackground()
                    default:
                        break
                    }
                }
        }
    }
}
