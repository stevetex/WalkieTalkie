import Foundation
import OverAndOutKit

/// Prototype: a ring's message that the notification service extension downloaded before
/// the tap (see WatchNotificationService/NotificationService.swift, which writes these
/// files). The app plays it straight away and skips those frames when the relay replays.
struct Prefetched {
    struct Burst {
        let burstId: String
        var frames: [Data] = []
        var ended = false
    }

    var bursts: [Burst] = []
    /// The extension's timings (ms since epoch, watch clock) and outcome, for the timeline.
    var meta: [String: Any] = [:]

    var frameCount: Int { bursts.reduce(0) { $0 + $1.frames.count } }

    static var appGroup: String? { Bundle.main.object(forInfoDictionaryKey: "OAOAppGroup") as? String }

    private static var directory: URL? {
        guard let group = appGroup,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
        return container.appendingPathComponent("prefetch", isDirectory: true)
    }

    /// Reads and removes what the extension saved for this conversation, and leftovers
    /// from rings never answered. Nil if it saved nothing (no prefetch push yet, or it's
    /// still downloading).
    static func take(conversationId: String) -> Prefetched? {
        guard let directory else { return nil }
        let records = directory.appendingPathComponent("\(conversationId).records")
        let metaFile = directory.appendingPathComponent("\(conversationId).json")
        defer {
            try? FileManager.default.removeItem(at: records)
            try? FileManager.default.removeItem(at: metaFile)
            removeLeftovers(in: directory)
        }
        guard let metaData = try? Data(contentsOf: metaFile),
              let meta = try? JSONSerialization.jsonObject(with: metaData) as? [String: Any] else { return nil }
        var prefetched = Prefetched(meta: meta)
        guard let data = try? Data(contentsOf: records) else { return prefetched }
        var parser = RelayRecord.Parser()
        for record in (try? parser.push(data)) ?? [] {
            if record.type == RelayRecord.audio {
                if !prefetched.bursts.isEmpty { prefetched.bursts[prefetched.bursts.count - 1].frames.append(record.payload) }
            } else if let message = try? JSONDecoder().decode(RelayMessage.self, from: record.payload) {
                if message.type == "burst-start", let burstId = message.burstId {
                    prefetched.bursts.append(Burst(burstId: burstId))
                } else if message.type == "burst-end", message.burstId == prefetched.bursts.last?.burstId {
                    prefetched.bursts[prefetched.bursts.count - 1].ended = true
                }
            }
        }
        return prefetched
    }

    /// A ring's message is only useful until the relay gives up on the ring (35 s).
    private static func removeLeftovers(in directory: URL) {
        let fm = FileManager.default
        let cutoff = Date().addingTimeInterval(-120)
        for file in (try? fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] {
            let modified = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            if modified < cutoff { try? fm.removeItem(at: file) }
        }
    }
}
