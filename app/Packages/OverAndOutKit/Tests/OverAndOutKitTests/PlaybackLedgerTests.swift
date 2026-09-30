import Testing
@testable import OverAndOutKit

/// What plays again after iOS stops the engine mid-burst (runs 87–88).
struct PlaybackLedgerTests {
    /// Schedules buffers `range` of 20 ms each.
    private func schedule(_ range: Range<Int>, on ledger: inout PlaybackLedger<Int>) {
        for buffer in range { ledger.scheduled(buffer, durationMs: 20) }
    }

    @Test func anEarlyStopPlaysTheBurstAgainFromItsStart() {
        var ledger = PlaybackLedger<Int>()
        ledger.beginBurst()
        schedule(0..<20, on: &ledger)
        for _ in 0..<8 { ledger.played() }  // 160 ms in, as in run 87
        let replay = ledger.takeForReplay()
        #expect(replay.buffers == Array(0..<20))
        #expect(replay.rewound == 8)
        #expect(ledger.scheduledCount == 0)
    }

    @Test func aLateStopReplaysOnlyWhatHadNotPlayed() {
        var ledger = PlaybackLedger<Int>()
        ledger.beginBurst()
        schedule(0..<50, on: &ledger)
        for _ in 0..<30 { ledger.played() }  // 600 ms in: past the rewind window
        let replay = ledger.takeForReplay()
        #expect(replay.buffers == Array(30..<50))
        #expect(replay.rewound == 0)
    }

    @Test func aBurstRewindsOnlyOnce() {
        var ledger = PlaybackLedger<Int>()
        ledger.beginBurst()
        schedule(0..<20, on: &ledger)
        for _ in 0..<5 { ledger.played() }
        let first = ledger.takeForReplay()
        #expect(first.rewound == 5)
        // The route changes again while the replay plays.
        for buffer in first.buffers { ledger.scheduled(buffer, durationMs: 20) }
        for _ in 0..<3 { ledger.played() }
        let second = ledger.takeForReplay()
        #expect(second.buffers == Array(3..<20))
        #expect(second.rewound == 0)
    }

    @Test func aNewBurstCanRewindAgain() {
        var ledger = PlaybackLedger<Int>()
        ledger.beginBurst()
        schedule(0..<10, on: &ledger)
        for _ in 0..<2 { ledger.played() }
        _ = ledger.takeForReplay()
        ledger.beginBurst()
        schedule(100..<110, on: &ledger)
        for _ in 0..<4 { ledger.played() }
        let replay = ledger.takeForReplay()
        #expect(replay.buffers == Array(100..<110))
        #expect(replay.rewound == 4)
    }

    @Test func theTailOfTheLastBurstIsNotRewound() {
        var ledger = PlaybackLedger<Int>()
        ledger.beginBurst()
        schedule(0..<10, on: &ledger)
        // A replayed burst arrives faster than it plays: the next one begins before it's heard.
        ledger.beginBurst()
        schedule(100..<105, on: &ledger)
        for _ in 0..<3 { ledger.played() }
        let replay = ledger.takeForReplay()
        #expect(replay.buffers == Array(3..<10) + Array(100..<105))
        #expect(replay.rewound == 0)
    }

    @Test func abandoningForgetsWhatWasScheduled() {
        var ledger = PlaybackLedger<Int>()
        ledger.beginBurst()
        schedule(0..<6, on: &ledger)
        ledger.played()
        #expect(ledger.abandonScheduled() == 5)
        #expect(ledger.scheduledCount == 0)
    }
}
