import Foundation

/// Automatic gain, applied to each 20 ms frame: for the microphone before encoding, and (with
/// `playback()`) for received speech before it plays. The watch's
/// microphone arrives unleveled and quiet: speech peaked at −35 dBFS on Steve's watch
/// (2026-10-01, build 140), where speech normally peaks near −10. This brings speech up to
/// about `targetDbfs` RMS.
///
/// The gain rises slowly (`riseDbPerFrame`) and falls fast (`fallDbPerFrame`), holds through
/// pauses (frames quieter than `gateDbfs` don't change it, so silence isn't pumped up), and
/// carries over from one burst to the next so a second press starts at the right level. A soft
/// limiter keeps the result below full scale.
struct AutoGain {
    var targetDbfs: Double = -20
    var maxGainDb: Double = 36
    /// Frames quieter than this (before gain) are treated as a pause.
    var gateDbfs: Double = -70
    var riseDbPerFrame: Double = 0.5
    var fallDbPerFrame: Double = 6
    /// The gain now, in dB.
    private(set) var gainDb: Double

    init(startDb: Double = 20) {
        gainDb = startDb
    }

    /// For received speech on the watch's small speaker (2026-10-02: Helen's watch-sent messages
    /// played at −23.5 dBFS RMS with peaks near −6, and Steve had to hold the watch to his ear).
    /// Brings speech up to about −14 dBFS RMS, at most 15 dB, with the limiter taking the peaks;
    /// louder senders (the Test Bot, −16.5) get only a little.
    static func playback() -> AutoGain {
        var gain = AutoGain(startDb: 8)
        gain.targetDbfs = -14
        gain.maxGainDb = 15
        return gain
    }

    /// One frame, in place.
    mutating func process(_ frame: inout [Float]) {
        guard !frame.isEmpty else { return }
        let before = gainDb
        let rmsDbfs = AudioLevel(frame).rmsDbfs
        if rmsDbfs > gateDbfs {
            let wanted = min(maxGainDb, max(0, targetDbfs - rmsDbfs))
            if wanted > gainDb {
                gainDb = min(wanted, gainDb + riseDbPerFrame)
            } else {
                gainDb = max(wanted, gainDb - fallDbPerFrame)
            }
        }
        // Across the frame from the old gain to the new, so a change doesn't click.
        let from = Float(Self.linear(before)), to = Float(Self.linear(gainDb))
        let step = (to - from) / Float(frame.count)
        for i in frame.indices {
            frame[i] = Self.limit(frame[i] * (from + step * Float(i)))
        }
    }

    static func linear(_ db: Double) -> Double {
        pow(10, db / 20)
    }

    /// Unchanged below 0.8 of full scale; above it, eased toward (and never past) 1.
    static func limit(_ x: Float) -> Float {
        let knee: Float = 0.8
        let magnitude = abs(x)
        guard magnitude > knee else { return x }
        let over = magnitude - knee
        let eased = knee + (1 - knee) * (over / (over + (1 - knee)))
        return x < 0 ? -eased : eased
    }
}
