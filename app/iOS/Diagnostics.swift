import Foundation
import MetricKit
import OverAndOutKit

/// The iPhone's crash and hang reports (the Beta telemetry spec): MetricKit hands the app its
/// diagnostics, usually at the next launch. Each becomes a short event for the server (the
/// kind, the exception or signal, the top frames' binaries and offsets, nothing the person
/// said or typed), and the whole payload goes into the device's diagnostics log. MetricKit
/// calls it on a queue of its own; it keeps no state.
final class Diagnostics: NSObject, MXMetricManagerSubscriber, Sendable {
    static let shared = Diagnostics()

    /// At launch, so reports held since the last run are delivered.
    func start() {
        MXMetricManager.shared.add(self)
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        for payload in payloads {
            for crash in payload.crashDiagnostics ?? [] {
                var fields = Self.common(crash.metaData)
                if let type = crash.exceptionType { fields["exceptionType"] = type.intValue }
                if let code = crash.exceptionCode { fields["exceptionCode"] = code.intValue }
                if let signal = crash.signal { fields["signal"] = signal.intValue }
                if let reason = crash.terminationReason { fields["terminationReason"] = String(reason.prefix(160)) }
                fields["frames"] = Self.topFrames(crash.callStackTree)
                Telemetry.shared.event("crash", fields)
            }
            for hang in payload.hangDiagnostics ?? [] {
                var fields = Self.common(hang.metaData)
                fields["hangSeconds"] = hang.hangDuration.converted(to: .seconds).value
                fields["frames"] = Self.topFrames(hang.callStackTree)
                Telemetry.shared.event("hang", fields)
            }
            for exception in payload.cpuExceptionDiagnostics ?? [] {
                Telemetry.shared.event("cpuException", Self.common(exception.metaData))
            }
            for exception in payload.diskWriteExceptionDiagnostics ?? [] {
                Telemetry.shared.event("diskWriteException", Self.common(exception.metaData))
            }
            // The whole report stays on the device unless it's asked for.
            if let json = String(data: payload.jsonRepresentation(), encoding: .utf8) {
                Telemetry.shared.note("metricKitDiagnostics", ["payload": String(json.prefix(60_000))])
            }
        }
        Task { await Telemetry.shared.flush() }
    }

    func didReceive(_ payloads: [MXMetricPayload]) {
        // Daily metrics: launch time and hang rate, into the device's log only.
        for payload in payloads {
            if let json = String(data: payload.jsonRepresentation(), encoding: .utf8) {
                Telemetry.shared.note("metricKitMetrics", ["payload": String(json.prefix(30_000))])
            }
        }
    }

    private static func common(_ meta: MXMetaData) -> Telemetry.Fields {
        ["appBuild": meta.applicationBuildVersion, "os": meta.osVersion, "model": meta.deviceType]
    }

    /// "OverAndOut+0x1a2b3c < AVFAudio+0x44 < …": the first few frames of the crashed thread,
    /// as binary and offset (symbolicated later with the archive's dSYMs).
    private static func topFrames(_ tree: MXCallStackTree) -> String {
        guard let json = try? JSONSerialization.jsonObject(with: tree.jsonRepresentation()) as? [String: Any],
              let stacks = json["callStacks"] as? [[String: Any]] else { return "" }
        let thread = stacks.first { ($0["threadAttributed"] as? Bool) == true } ?? stacks.first
        var frames: [String] = []
        var level = (thread?["callStackRootFrames"] as? [[String: Any]])?.first
        while let frame = level, frames.count < 6 {
            let binary = frame["binaryName"] as? String ?? "?"
            let offset = frame["offsetIntoBinaryTextSegment"] as? Int ?? 0
            frames.append("\(binary)+0x\(String(offset, radix: 16))")
            level = (frame["subFrames"] as? [[String: Any]])?.first
        }
        return String(frames.joined(separator: " < ").prefix(200))
    }
}
