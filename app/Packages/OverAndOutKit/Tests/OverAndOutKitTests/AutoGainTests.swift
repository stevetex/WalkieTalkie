import AVFoundation
import Testing
@testable import OverAndOutKit

/// The watch's microphone level (build 140: speech peaking at −35 dBFS) brought up to speech level.
struct AutoGainTests {
    private func frames(_ samples: [Float]) -> [[Float]] {
        stride(from: 0, to: samples.count, by: VoiceFrame.samplesPerFrame).map {
            Array(samples[$0..<min($0 + VoiceFrame.samplesPerFrame, samples.count)])
        }
    }

    private func run(_ gain: inout AutoGain, _ samples: [Float]) -> [Float] {
        frames(samples).flatMap { frame -> [Float] in
            var frame = frame
            gain.process(&frame)
            return frame
        }
    }

    @Test func quietSpeechIsBroughtUpToTheTarget() {
        var gain = AutoGain()
        let quiet = Signal.tone(440, dbfs: -54, seconds: 3, rate: VoiceFrame.sampleRate)
        let out = run(&gain, quiet)
        // After the rise (0.5 dB a frame from 20 dB: under a second), within 2 dB of -20.
        let settled = AudioLevel(out.suffix(16_000)).rmsDbfs
        #expect(abs(settled - (-20)) < 2, "settled at \(settled) dBFS")
        #expect(gain.gainDb <= 36)
    }

    @Test func loudSpeechIsNotRaisedOrClipped() {
        var gain = AutoGain()
        let loud = Signal.tone(440, dbfs: -3, seconds: 1, rate: VoiceFrame.sampleRate)
        let out = run(&gain, loud)
        #expect(out.allSatisfy { abs($0) < 1 })
        #expect(gain.gainDb == 0)
    }

    @Test func pausesDontPumpTheGain() {
        var gain = AutoGain()
        _ = run(&gain, Signal.tone(440, dbfs: -40, seconds: 2, rate: VoiceFrame.sampleRate))
        let afterSpeech = gain.gainDb
        let hiss = [Float](repeating: 0.0001, count: 16_000)  // -80 dBFS, below the gate
        let out = run(&gain, hiss)
        #expect(gain.gainDb == afterSpeech)
        #expect(AudioLevel(out).rmsDbfs < -55)
    }

    /// Received speech on the watch (2026-10-02: Helen's watch sent −23.5 dBFS RMS, peaks near −6).
    @Test func playbackBringsQuietSpeechUpWithoutClipping() {
        var gain = AutoGain.playback()
        let speech = Signal.tone(440, dbfs: -23.5, seconds: 3, rate: VoiceFrame.sampleRate)
        let out = run(&gain, speech)
        let settled = AudioLevel(out.suffix(16_000)).rmsDbfs
        #expect(abs(settled - (-14)) < 2, "settled at \(settled) dBFS")
        #expect(out.allSatisfy { abs($0) < 1 })
    }

    /// The Test Bot's greeting (−16.5 dBFS) is already near the target: only a little more.
    @Test func playbackBarelyRaisesLoudSenders() {
        var gain = AutoGain.playback()
        _ = run(&gain, Signal.tone(440, dbfs: -16.5, seconds: 2, rate: VoiceFrame.sampleRate))
        #expect(gain.gainDb <= 3)
    }
}
