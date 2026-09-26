import Foundation

/// Timing events for one conversation, uploaded to the relay when it ends. Event names
/// match the server's report (server/src/report.ts). These are the spike's diagnostics,
/// kept until the product has its own telemetry.
public struct Timeline {
    public enum Role: String { case sender, receiver }

    public struct Event: Equatable {
        public let name: String
        public let t: Double // ms since epoch, device clock
        public let detail: String?
    }

    public let role: Role
    public private(set) var events: [Event] = []
    private var seen: Set<String> = []

    public init(role: Role) {
        self.role = role
    }

    /// Records the event. Events marked `once` are only kept the first time.
    public mutating func mark(_ name: String, detail: String? = nil, once: Bool = true) {
        mark(name, at: Clock.nowMs(), detail: detail, once: once)
    }

    /// Records an event that happened at `t` (device clock, ms), e.g. on another thread.
    public mutating func mark(_ name: String, at t: Double, detail: String? = nil, once: Bool = true) {
        if once, seen.contains(name) { return }
        seen.insert(name)
        events.append(Event(name: name, t: t, detail: detail))
    }

    public func has(_ name: String) -> Bool { seen.contains(name) }

    /// The body of POST /v1/metrics. `clockOffsetMs` is server time minus device time.
    public func upload(conversationId: String, userId: String, clockOffsetMs: Double) -> [String: Any] {
        [
            "conversationId": conversationId,
            "userId": userId,
            "role": role.rawValue,
            "clockOffsetMs": clockOffsetMs,
            "events": events.map { event -> [String: Any] in
                var e: [String: Any] = ["name": event.name, "t": event.t]
                if let detail = event.detail { e["detail"] = detail }
                return e
            },
        ]
    }
}
