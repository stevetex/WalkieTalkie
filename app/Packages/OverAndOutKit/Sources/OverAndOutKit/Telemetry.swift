import Foundation

/// Beta telemetry on the device (the "Over&Out Beta telemetry spec" Claude Doc, design
/// decision 2026-09-28). Two things:
///
/// - Events outside conversations (a PushToTalk leave, a crash, a failed registration) go to
///   the API in small batches (`POST /v1/events`), where they become log entries.
/// - A rolling diagnostics log on the device: those events plus every conversation's whole
///   timeline, for about 14 days. It leaves the device only when the person sends Report a
///   Problem, or when the server asks (`diagnosticsRequestedAt` in GET /v1/me). During the
///   TestFlight Beta it's sent without asking; the App Store build must ask first.
///
/// Everything here carries IDs, never names: callers pass friends' account IDs, not their names.
public final class Telemetry: @unchecked Sendable {
    public static let shared = Telemetry()

    /// Sends a batch of events and this device's details; set by the app once signed in.
    public var send: (@Sendable (_ events: [[String: Any]], _ device: [String: String]) async throws -> Void)?
    public private(set) var log: DiagnosticsLog?
    public private(set) var device: [String: String] = [:]

    private let lock = NSLock()
    private var pending: [[String: Any]] = []
    private static let maxPending = 200

    public init() {}

    /// At launch: where the log lives and how big it may grow, and this device's details.
    public func configure(platform: Platform, directory: URL, maxBytes: Int) {
        device = DeviceInfo.current(platform: platform)
        log = DiagnosticsLog(directory: directory, maxBytes: maxBytes)
    }

    /// An event for the server and the device's log. `fields` hold short values only: numbers,
    /// booleans, short strings (the server drops anything else).
    public func event(_ name: String, _ fields: [String: Any] = [:]) {
        let t = Clock.nowMs()
        log?.append(name, fields)
        var event: [String: Any] = ["name": name, "t": t]
        if !fields.isEmpty { event["fields"] = fields }
        lock.withLock {
            pending.append(event)
            if pending.count > Self.maxPending { pending.removeFirst(pending.count - Self.maxPending) }
        }
    }

    /// Only into the device's log (a conversation's timeline, details too long for an event).
    public func note(_ name: String, _ fields: [String: Any] = [:]) {
        log?.append(name, fields)
    }

    /// A finished conversation's whole timeline, into the device's log.
    public func timeline(_ timeline: Timeline, conversationId: String) {
        log?.appendTimeline(timeline, conversationId: conversationId)
    }

    /// Sends what's queued. Events that fail to send are kept for the next try.
    public func flush() async {
        guard let send else { return }
        let batch: [[String: Any]] = lock.withLock {
            let taken = Array(pending.prefix(50))
            pending.removeFirst(taken.count)
            return taken
        }
        guard !batch.isEmpty else { return }
        do {
            try await send(batch, device)
        } catch {
            lock.withLock { pending.insert(contentsOf: batch, at: 0) }
        }
    }

    /// The server asked for this device's log (GET /v1/me) after its last upload: sends it.
    /// Returns true if it uploaded.
    @discardableResult
    public func uploadIfRequested(requestedAt: Double?, upload: (Data) async throws -> Void) async -> Bool {
        let key = "diagnosticsUploadedAt"
        guard let requestedAt, requestedAt > UserDefaults.standard.double(forKey: key),
              let data = log?.compressed() else { return false }
        do {
            try await upload(data)
            UserDefaults.standard.set(Clock.nowMs(), forKey: key)
            event("diagnosticsSent", ["bytes": data.count])
            return true
        } catch {
            note("diagnosticsFailed", ["error": String(describing: error).prefix(120).description])
            return false
        }
    }
}

/// This device, as the server's summaries label it: kind, model identifier, OS version and
/// the app's build number.
public enum DeviceInfo {
    public static func current(platform: Platform) -> [String: String] {
        var system = utsname()
        uname(&system)
        let model = withUnsafeBytes(of: &system.machine) { bytes in
            String(decoding: bytes.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
        let os = ProcessInfo.processInfo.operatingSystemVersion
        var info = [
            "platform": platform.rawValue,
            "os": "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)",
            "model": model,
        ]
        if let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String { info["build"] = build }
        return info
    }

    public static var build: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
    }
}

/// A rolling file of JSON lines (`{"t": ms, "name": …, …}`), newest last. Past `maxBytes` the
/// oldest quarter goes; lines older than 14 days go too.
public final class DiagnosticsLog: @unchecked Sendable {
    public let file: URL
    private let maxBytes: Int
    private let maxAgeMs: Double = 14 * 24 * 3600 * 1000
    private let queue = DispatchQueue(label: "com.cypressoakstudios.overandout.diagnostics")

    public init(directory: URL, maxBytes: Int) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        file = directory.appendingPathComponent("diagnostics.jsonl")
        self.maxBytes = maxBytes
    }

    public func append(_ name: String, _ fields: [String: Any] = [:], at t: Double = Clock.nowMs()) {
        var line = fields
        line["t"] = t
        line["name"] = name
        write([line])
    }

    public func appendTimeline(_ timeline: Timeline, conversationId: String) {
        // Free-text "log" lines can name friends, so they stay out.
        let lines = timeline.events.filter { $0.name != "log" }.map { event -> [String: Any] in
            var line: [String: Any] = ["t": event.t, "name": event.name, "conversationId": conversationId, "role": timeline.role.rawValue]
            if let detail = event.detail { line["detail"] = detail }
            return line
        }
        write(lines)
    }

    /// The whole log, deflated (raw DEFLATE, as NSData's .zlib makes it); the server inflates it.
    public func compressed() -> Data? {
        queue.sync {
            guard let data = try? Data(contentsOf: file), !data.isEmpty else { return nil }
            return try? (data as NSData).compressed(using: .zlib) as Data
        }
    }

    public func contents() -> String {
        queue.sync { (try? String(contentsOf: file, encoding: .utf8)) ?? "" }
    }

    private func write(_ lines: [[String: Any]]) {
        let data = lines.compactMap { line -> Data? in
            guard JSONSerialization.isValidJSONObject(line), var json = try? JSONSerialization.data(withJSONObject: line) else { return nil }
            json.append(0x0A)
            return json
        }.reduce(into: Data()) { $0.append($1) }
        guard !data.isEmpty else { return }
        queue.async { [self] in
            if let handle = try? FileHandle(forWritingTo: file) {
                handle.seekToEndOfFile()
                handle.write(data)
                try? handle.close()
            } else {
                try? data.write(to: file, options: .atomic)
            }
            trimIfNeeded()
        }
    }

    private func trimIfNeeded() {
        let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int) ?? 0
        guard size > maxBytes, let data = try? Data(contentsOf: file) else { return }
        let cutoff = Clock.nowMs() - maxAgeMs
        var lines = data.split(separator: 0x0A)
        lines.removeFirst(lines.count / 4)
        let kept = lines.filter { line in
            guard let json = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
                  let t = json["t"] as? Double else { return false }
            return t >= cutoff
        }
        var out = Data()
        for line in kept {
            out.append(contentsOf: line)
            out.append(0x0A)
        }
        try? out.write(to: file, options: .atomic)
    }
}
