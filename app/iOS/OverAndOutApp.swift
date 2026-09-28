import SwiftUI

@main
struct OverAndOutApp: App {
    @StateObject private var model = AppModel()
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
