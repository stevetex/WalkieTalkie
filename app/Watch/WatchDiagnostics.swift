import Foundation
import OverAndOutKit

/// Crashes on the watch, without MetricKit (it isn't on watchOS; the Beta telemetry spec):
///
/// - The app marks when it comes to the front and clears the mark when it goes to the
///   background. A mark still there at the next launch means the app ended while in use: a
///   crash or a system kill. That's reported as `uncleanExit`.
/// - The notification service extension writes a line when it starts and when it finishes
///   (NotificationService.swift) to a file in the app group. A start with no finish after a
///   minute is reported as `extensionUnfinished`; every line also goes into the watch's log.
///
/// TestFlight's symbolicated crash reports (deploy/appstore/asc.ts crashes) say why.
enum WatchDiagnostics {
    private static let activeKey = "diagnosticsActiveSince"

    static func launched() {
        let defaults = UserDefaults.standard
        let since = defaults.double(forKey: activeKey)
        if since > 0 {
            Telemetry.shared.event("uncleanExit", ["activeForSeconds": Int((Clock.nowMs() - since) / 1000)])
            defaults.removeObject(forKey: activeKey)
        }
        Telemetry.shared.event("appLaunched")
    }

    static func becameActive() {
        UserDefaults.standard.set(Clock.nowMs(), forKey: activeKey)
        Telemetry.shared.foreground()
    }

    static func enteredBackground() {
        UserDefaults.standard.removeObject(forKey: activeKey)
    }

    /// The extension's lines, into the watch's log; starts still unfinished after a minute are
    /// reported. Recent starts stay in the file for next time.
    static func collectExtensionLines() {
        guard let group = Prefetched.appGroup,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return }
        let file = container.appendingPathComponent("diagnostics/extension.jsonl")
        guard let data = try? Data(contentsOf: file), !data.isEmpty else { return }
        try? FileManager.default.removeItem(at: file)
        let lines = data.split(separator: 0x0A).compactMap { try? JSONSerialization.jsonObject(with: Data($0)) as? [String: Any] }
        let finished = Set(lines.filter { $0["name"] as? String == "nseFinished" }.compactMap { $0["requestId"] as? String })
        var keep: [[String: Any]] = []
        let now = Clock.nowMs()
        for line in lines {
            guard let name = line["name"] as? String, let t = line["t"] as? Double else { continue }
            if name == "nseStarted", let id = line["requestId"] as? String, !finished.contains(id) {
                if now - t < 60_000 {
                    keep.append(line)
                    continue
                }
                Telemetry.shared.event("extensionUnfinished", ["conversationId": line["conversationId"] as? String ?? ""])
            }
            var fields = line
            fields.removeValue(forKey: "name")
            fields.removeValue(forKey: "t")
            Telemetry.shared.log?.append(name, fields, at: t)
        }
        guard !keep.isEmpty else { return }
        let rest = keep.compactMap { try? JSONSerialization.data(withJSONObject: $0) }.reduce(into: Data()) { out, line in
            out.append(line)
            out.append(0x0A)
        }
        try? rest.write(to: file, options: .atomic)
    }
}
