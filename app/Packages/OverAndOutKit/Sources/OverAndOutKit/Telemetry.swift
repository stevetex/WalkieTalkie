import Foundation
import os

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
/// Safe to use from any thread: its state is behind one lock, and file writes are serial.
public final class Telemetry: Sendable {
    public static let shared = Telemetry()

    /// An event's fields: numbers, booleans and short strings.
    public typealias Fields = [String: any Sendable]
    /// Sends a batch of events and this device's details.
    public typealias Sender = @Sendable (_ events: [Fields], _ device: [String: String]) async throws -> Void
    /// Sends one conversation's timeline to the relay (the body of POST /v1/metrics).
    public typealias TimelineSender = @Sendable (_ body: Fields) async throws -> Void

    private struct State {
        var send: Sender?
        var log: DiagnosticsLog?
        var device: [String: String] = [:]
        var pending: [Fields] = []
        /// Events not yet sent, kept on disk: a PushToTalk push can launch the app in the
        /// background and iOS can end it before the next send (run 56).
        var pendingFile: URL?
        var sendTimeline: TimelineSender?
        /// Timelines not yet sent, a file each: the watch can be suspended before an upload
        /// finishes (run 63), and the conversation's summary then had no watch side.
        var timelineDirectory: URL?
        /// Timeline files being sent now, so a flush and an upload don't send one twice.
        var sendingTimelines: Set<String> = []
    }

    private let state = OSAllocatedUnfairLock(initialState: State())
    private static let maxPending = 200
    /// Unsent timelines kept at most: the newest, and none older than 3 days.
    private static let maxPendingTimelines = 20
    private static let maxTimelineAgeMs: Double = 3 * 24 * 3600 * 1000
    private let saveQueue = DispatchQueue(label: "com.cypressoakstudios.overandout.telemetry")

    public init() {}

    /// Set by the app once signed in.
    public var send: Sender? {
        get { state.withLock { $0.send } }
        set { state.withLock { $0.send = newValue } }
    }
    /// Set by the app once it knows the relay and has a session.
    public var sendTimeline: TimelineSender? {
        get { state.withLock { $0.sendTimeline } }
        set { state.withLock { $0.sendTimeline = newValue } }
    }
    public var log: DiagnosticsLog? { state.withLock { $0.log } }
    public var device: [String: String] { state.withLock { $0.device } }

    /// At launch: where the log lives and how big it may grow, and this device's details.
    public func configure(platform: Platform, directory: URL, maxBytes: Int) {
        let device = DeviceInfo.current(platform: platform)
        let log = DiagnosticsLog(directory: directory, maxBytes: maxBytes)
        let file = directory.appendingPathComponent("pending-events.json")
        let saved = (try? Data(contentsOf: file)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [[String: Any]] } ?? []
        let events = saved.map(Self.fields)
        state.withLock {
            $0.device = device
            $0.log = log
            $0.pendingFile = file
            $0.timelineDirectory = directory.appendingPathComponent("pending-timelines")
            $0.pending = events + $0.pending
            if $0.pending.count > Self.maxPending { $0.pending.removeFirst($0.pending.count - Self.maxPending) }
        }
        savePending()
    }

    /// Parsed JSON as fields: strings, numbers, and arrays and objects of them.
    public static func fields(_ json: [String: Any]) -> Fields {
        json.compactMapValues(sendable)
    }

    private static func sendable(_ value: Any) -> (any Sendable)? {
        switch value {
        case let value as String: value
        case let value as NSNumber: value
        case let value as [Any]: value.compactMap(sendable)
        case let value as [String: Any]: value.compactMapValues(sendable)
        default: nil
        }
    }

    private func savePending() {
        let (file, snapshot) = state.withLock { ($0.pendingFile, $0.pending) }
        guard let file else { return }
        saveQueue.async {
            guard JSONSerialization.isValidJSONObject(snapshot), let data = try? JSONSerialization.data(withJSONObject: snapshot) else { return }
            try? data.write(to: file, options: .atomic)
        }
    }

    /// An event for the server and the device's log. `fields` hold short values only: numbers,
    /// booleans, short strings (the server drops anything else).
    public func event(_ name: String, _ fields: Fields = [:]) {
        let t = Clock.nowMs()
        log?.append(name, fields)
        var fresh: Fields = ["name": name, "t": t]
        if !fields.isEmpty { fresh["fields"] = fields }
        let event = fresh
        state.withLock {
            $0.pending.append(event)
            if $0.pending.count > Self.maxPending { $0.pending.removeFirst($0.pending.count - Self.maxPending) }
        }
        savePending()
    }

    /// The app came to the front, at most once an hour: daily and monthly users who open the app
    /// without talking (the spec's usage analytics).
    public func foreground() {
        let key = "telemetryForegroundAt"
        let now = Clock.nowMs()
        guard now - UserDefaults.standard.double(forKey: key) >= 3_600_000 else { return }
        UserDefaults.standard.set(now, forKey: key)
        event("appForeground")
    }

    /// Only into the device's log (a conversation's timeline, details too long for an event).
    public func note(_ name: String, _ fields: Fields = [:]) {
        log?.append(name, fields)
    }

    /// A finished conversation's whole timeline, into the device's log.
    public func timeline(_ timeline: Timeline, conversationId: String) {
        log?.appendTimeline(timeline, conversationId: conversationId)
    }

    /// Sends what's queued: events, then timelines. What fails to send is kept for the next try.
    public func flush() async {
        await sendPendingTimelines()
        guard let send else { return }
        let batch: [Fields] = state.withLock {
            let taken = Array($0.pending.prefix(50))
            $0.pending.removeFirst(taken.count)
            return taken
        }
        guard !batch.isEmpty else { return }
        do {
            try await send(batch, device)
        } catch {
            state.withLock { $0.pending.insert(contentsOf: batch, at: 0) }
        }
        savePending()
    }

    // MARK: Timelines

    /// A finished conversation's timeline for the relay: onto disk first, then sent with
    /// `sendTimeline`, and removed once the relay has it. Unsent ones go at the next flush.
    public func uploadTimeline(_ body: Fields, conversationId: String) async {
        guard let directory = state.withLock({ $0.timelineDirectory }) else { return }
        let name = "\(Int(Clock.nowMs()))-\(conversationId.prefix(64)).json"
        let file = directory.appendingPathComponent(name)
        guard JSONSerialization.isValidJSONObject(body), let data = try? JSONSerialization.data(withJSONObject: body) else { return }
        // Before the request starts, so a suspension mid-upload leaves it on disk.
        saveQueue.sync {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try? data.write(to: file, options: .atomic)
        }
        await sendPendingTimelines()
    }

    /// Sends every saved timeline, oldest first, that isn't being sent already. Stops at the
    /// first failure: the relay is out of reach, and the rest can wait for the next try.
    private func sendPendingTimelines() async {
        let (directory, send) = state.withLock { ($0.timelineDirectory, $0.sendTimeline) }
        guard let directory, let send else { return }
        for file in pruneTimelines(in: directory) {
            let name = file.lastPathComponent
            let claimed = state.withLock { $0.sendingTimelines.insert(name).inserted }
            guard claimed else { continue }
            defer { state.withLock { _ = $0.sendingTimelines.remove(name) } }
            guard let data = try? Data(contentsOf: file),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                try? FileManager.default.removeItem(at: file)
                continue
            }
            do {
                try await send(Self.fields(json))
                try? FileManager.default.removeItem(at: file)
            } catch {
                note("timelineUploadFailed", ["error": String(describing: error).prefix(120).description])
                return
            }
        }
    }

    /// The saved timelines, oldest first, after dropping the oldest past the limits.
    private func pruneTimelines(in directory: URL) -> [URL] {
        let files = ((try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
        let now = Clock.nowMs()
        var kept: [URL] = []
        for (index, file) in files.enumerated() {
            let savedAt = Double(file.lastPathComponent.prefix { $0 != "-" }) ?? 0
            if files.count - index > Self.maxPendingTimelines || now - savedAt > Self.maxTimelineAgeMs {
                try? FileManager.default.removeItem(at: file)
            } else {
                kept.append(file)
            }
        }
        return kept
    }

    /// The server asked for this device's log (GET /v1/me) after its last upload: sends it.
    /// Returns true if it uploaded.
    @discardableResult
    public func uploadIfRequested(requestedAt: Double?, upload: @Sendable (Data) async throws -> Void) async -> Bool {
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
public final class DiagnosticsLog: Sendable {
    public let file: URL
    private let maxBytes: Int
    private let maxAgeMs: Double = 14 * 24 * 3600 * 1000
    private let queue = DispatchQueue(label: "com.cypressoakstudios.overandout.diagnostics")

    public init(directory: URL, maxBytes: Int) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        file = directory.appendingPathComponent("diagnostics.jsonl")
        self.maxBytes = maxBytes
    }

    public func append(_ name: String, _ fields: Telemetry.Fields = [:], at t: Double = Clock.nowMs()) {
        var line: [String: Any] = fields
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
