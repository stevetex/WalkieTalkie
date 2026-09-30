/// What the speaker's player was given and hasn't played yet, in order, and what it has played of
/// the current burst's first moments. When iOS stops the engine for a configuration change, the
/// player throws away everything scheduled; the ledger says what to play again on the new one.
///
/// A change early in a burst (runs 59, 87, 88: Bluetooth hearing aids switching to a call link
/// 105–156 ms into a message) usually means what did play went out over a link that was going
/// away, so the burst starts again from the top: hearing its first half-second twice beats losing
/// its first word. Only once per burst, so a route that keeps changing can't loop.
///
/// Generic over the buffer so the tests can count with plain values. Not thread-safe: the audio
/// queue owns it.
struct PlaybackLedger<Buffer> {
    /// A change within this much of a burst's played audio plays the burst again from its start.
    static var rewindWindowMs: Double { 500 }

    private struct Entry {
        let buffer: Buffer
        let burst: Int
        let durationMs: Double
    }

    /// Scheduled and not yet reported played, oldest first. The player reports buffers played
    /// in the order they were scheduled.
    private var inFlight: [Entry] = []
    /// The current burst's played buffers, while it has played no more than the rewind window.
    private var burstPlayed: [Buffer] = []
    private var burstPlayedMs: Double = 0
    private var burst = 0
    private var rewound = false

    var scheduledCount: Int { inFlight.count }

    /// A new burst from the friend: what plays from here on is its start.
    mutating func beginBurst() {
        burst += 1
        burstPlayed.removeAll()
        burstPlayedMs = 0
        rewound = false
    }

    mutating func scheduled(_ buffer: Buffer, durationMs: Double) {
        inFlight.append(Entry(buffer: buffer, burst: burst, durationMs: durationMs))
    }

    /// The oldest scheduled buffer finished playing.
    mutating func played() {
        guard !inFlight.isEmpty else { return }
        let entry = inFlight.removeFirst()
        // The rest of an earlier burst still playing out isn't this burst's start.
        guard entry.burst == burst, !rewound else { return }
        burstPlayedMs += entry.durationMs
        if burstPlayedMs <= Self.rewindWindowMs {
            burstPlayed.append(entry.buffer)
        } else {
            burstPlayed.removeAll()
        }
    }

    /// The player was stopped and dropped what was scheduled. Returns what to schedule again on
    /// the new player, in order, and how many of those had already played (the rewind).
    mutating func takeForReplay() -> (buffers: [Buffer], rewound: Int) {
        let rewind = !rewound && burstPlayedMs <= Self.rewindWindowMs ? burstPlayed : []
        if !rewind.isEmpty { rewound = true }
        let buffers = rewind + inFlight.map(\.buffer)
        inFlight.removeAll()
        burstPlayed.removeAll()
        return (buffers, rewind.count)
    }

    /// Scheduled buffers that were never reported played: forget them. Returns how many.
    mutating func abandonScheduled() -> Int {
        let count = inFlight.count
        inFlight.removeAll()
        return count
    }
}
