import Foundation

/// Timing events for one conversation, uploaded to the server when the call ends.
/// Event names match the server's report (server/src/report.ts).
struct Timeline {
    enum Role: String { case sender, receiver }

    struct Event {
        let name: String
        let t: Double // ms since epoch, device clock
        let detail: String?
    }

    let role: Role
    private(set) var events: [Event] = []
    private var seen: Set<String> = []

    init(role: Role) {
        self.role = role
    }

    static func nowMs() -> Double {
        Date().timeIntervalSince1970 * 1000
    }

    /// Records the event. Events marked `once` are only kept the first time.
    mutating func mark(_ name: String, detail: String? = nil, once: Bool = true) {
        if once, seen.contains(name) { return }
        seen.insert(name)
        events.append(Event(name: name, t: Self.nowMs(), detail: detail))
    }

    /// Records an event that happened at `t` (device clock, ms), e.g. on another thread.
    mutating func mark(_ name: String, at t: Double, detail: String? = nil, once: Bool = true) {
        if once, seen.contains(name) { return }
        seen.insert(name)
        events.append(Event(name: name, t: t, detail: detail))
    }

    func has(_ name: String) -> Bool { seen.contains(name) }

    /// Local-only intervals for the on-watch readout; the server computes the cross-device ones.
    func localSummary() -> [String] {
        func t(_ name: String) -> Double? { events.first { $0.name == name }?.t }
        var lines: [String] = []
        func add(_ label: String, _ from: String, _ to: String) {
            if let a = t(from), let b = t(to) { lines.append("\(label): \(Int(b - a)) ms") }
        }
        switch role {
        case .receiver:
            add("Push → ring", "pushReceived", "callReported")
            add("Ring → answer", "callReported", "answerTapped")
            add("Answer → socket", "answerTapped", "socketOpen")
            add("Answer → audio", "answerTapped", "firstAudioScheduled")
        case .sender:
            add("Press → call up", "talkPressed", "audioActivated")
            add("Press → socket", "talkPressed", "socketOpen")
            add("Press → first frame", "talkPressed", "firstFrameSent")
        }
        return lines
    }
}

struct MetricsUpload {
    let conversationId: String
    let userId: String
    let role: Timeline.Role
    let clockOffsetMs: Double
    let events: [Timeline.Event]

    var json: [String: Any] {
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
