import Foundation
import OverAndOutKit

/// Prototype: a ring's message that the notification service extension downloaded before
/// the tap (see WatchNotificationService/NotificationService.swift, which writes these
/// files). The app plays it straight away and skips those frames when the relay replays.
///
/// Files are keyed by the ring's ID (contracts/README.md, "Rings"): a tap plays only what was
/// downloaded for that ring, for this account, before the ring's deadline.
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

    /// The files' name for a ring.
    static func key(for ring: Ring) -> String { ring.ringId }

    /// Reads and removes what the extension saved for this ring, and leftovers from rings
    /// never answered. Nil if it saved nothing (no prefetch push yet, or it's still
    /// downloading). No audio if it was saved for another account or another ring, or the
    /// ring has expired: the relay has dropped that message, so it mustn't play now.
    static func take(ring: Ring, userId: String?) -> Prefetched? {
        guard let directory else { return nil }
        let records = directory.appendingPathComponent("\(key(for: ring)).records")
        let metaFile = directory.appendingPathComponent("\(key(for: ring)).json")
        defer {
            try? FileManager.default.removeItem(at: records)
            try? FileManager.default.removeItem(at: metaFile)
            removeLeftovers(in: directory)
        }
        guard let metaData = try? Data(contentsOf: metaFile),
              let meta = try? JSONSerialization.jsonObject(with: metaData) as? [String: Any] else { return nil }
        if let unusable = unusable(meta, ring: ring, userId: userId) {
            var meta = meta
            meta["error"] = "not played: \(unusable)"
            return Prefetched(meta: meta)
        }
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

    /// Saves a held message the app downloaded itself, in the extension's format, for `take`.
    static func save(ring: Ring, records: Data?, meta: [String: Any]) {
        guard let directory else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var meta = meta
        meta["schemaVersion"] = ServiceContract.schemaVersion
        meta["ringId"] = ring.ringId
        if let expiresAt = ring.expiresAt { meta["expiresAt"] = expiresAt }
        if let records { try? records.write(to: directory.appendingPathComponent("\(key(for: ring)).records"), options: .atomic) }
        if let data = try? JSONSerialization.data(withJSONObject: meta) {
            try? data.write(to: directory.appendingPathComponent("\(key(for: ring)).json"), options: .atomic)
        }
    }

    /// The relay gives up on a ring 35 s after sending it.
    static let ringLifetimeMs: Double = 35_000

    /// Why the saved message can't be played, if it can't. The extension records the account,
    /// the ring and when it expires (server clock; the push says).
    private static func unusable(_ meta: [String: Any], ring: Ring, userId: String?) -> String? {
        guard let userId, meta["userId"] as? String == userId else { return "another account's" }
        if meta["ringId"] as? String != ring.ringId { return "another ring's" }
        let expiresAt = meta["expiresAt"] as? Double
            ?? (meta["pushSentAt"] as? Double).map { $0 + ringLifetimeMs }
            ?? (meta["receivedAt"] as? Double).map { $0 + ringLifetimeMs }
        guard let expiresAt, Clock.nowMs() < expiresAt else { return "the ring expired" }
        return nil
    }

    /// Everything saved, on signing out.
    static func removeAll() {
        guard let directory else { return }
        try? FileManager.default.removeItem(at: directory)
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
