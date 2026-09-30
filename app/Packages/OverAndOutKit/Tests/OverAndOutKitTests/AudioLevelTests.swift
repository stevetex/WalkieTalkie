import AVFoundation
import Foundation
import Testing
@testable import OverAndOutKit

/// Does sound get through the kit's audio code at the level it went in? Known signals go through
/// the Opus encoder and decoder (as the apps use them) and through the capture converter. Each
/// test records its measurements for CI (KitMetrics); the fine thresholds live in
/// server/perf/budgets.json, so here only gross failures fail: silence, the wrong pitch, or a
/// level off by more than 6 dB.
struct AudioLevelTests {
    @Test func levelsOfKnownSignals() {
        // A full-scale sine is −3.01 dBFS RMS and 0 dBFS peak.
        let sine = AudioLevel((0..<16_000).map { Float(sin(2 * Double.pi * 1000 * Double($0) / 16_000)) })
        #expect(abs(sine.rmsDbfs + 3.01) < 0.05)
        #expect(abs(sine.peakDbfs) < 0.01)
        #expect(sine.clipped > 0)
        #expect(AudioLevel([Float](repeating: 0, count: 320)).rmsDbfs == AudioLevel.floorDbfs)
        #expect(AudioLevel().isEmpty)
        let tone = AudioLevel(Signal.tone(440, dbfs: -20, seconds: 1))
        #expect(abs(tone.rmsDbfs + 20) < 0.05)
        #expect(tone.clipped == 0)
        // The timeline mark the server parses (telemetry.ts, parseLevel).
        #expect(tone.detail(frames: 50).hasPrefix("rms=-20.0,peak=-17.0,frames=50,clipped=0"))
    }

    @Test(arguments: [440.0, 1000.0], [-30.0, -20.0, -6.0])
    func opusKeepsAToneAtItsLevel(hz: Double, dbfs: Double) throws {
        let encoder = VoiceEncoder()
        try #require(encoder.codec == .opus16k, "no Opus encoder on this machine")
        let input = Signal.tone(hz, dbfs: dbfs, seconds: 2)
        let (output, _, _, _) = Signal.roundTrip(input, encoder: encoder, decoder: VoiceDecoder())
        let name = "tone\(Int(hz))_m\(Int(-dbfs))"
        let change = Signal.levelChange(input, output)
        let rms = AudioLevel(output.dropFirst(Signal.settleSamples)).rmsDbfs
        KitMetrics.record("kit.codec.opus.level_change_db.\(name)", change, unit: "dB", kind: "level")
        KitMetrics.record("kit.codec.opus.output_rms_dbfs.\(name)", rms, unit: "dBFS", kind: "level")
        #expect(rms > -60, "the decoded tone is silent")
        #expect(abs(change) < 6, "level changed by \(change) dB")
        // One second, whole cycles, after the settling frames.
        let second = output.dropFirst(Signal.settleSamples).prefix(16_000)
        let share = Signal.energyShare(second, at: hz)
        KitMetrics.record("kit.codec.opus.pitch_share.\(name)", share, unit: "share", kind: "quality")
        #expect(share > 0.5, "only \(share) of the energy is at \(hz) Hz")
        if dbfs == -6 {
            KitMetrics.record("kit.codec.opus.clipped_samples.\(name)", Double(AudioLevel(output).clipped), unit: "samples", kind: "level")
        }
    }

    @Test func opusKeepsSpeechAtItsLevel() throws {
        let encoder = VoiceEncoder()
        try #require(encoder.codec == .opus16k, "no Opus encoder on this machine")
        let speech = try Signal.speech()
        let trip = Signal.roundTrip(speech, encoder: encoder, decoder: VoiceDecoder())
        let frames = Double(Signal.frames(speech).count)
        let change = Signal.levelChange(speech, trip.output)
        let snr = Signal.snr(speech, trip.output)
        KitMetrics.record("kit.codec.opus.speech_level_change_db", change, unit: "dB", kind: "level")
        KitMetrics.record("kit.codec.opus.speech_snr_db", snr, unit: "dB", kind: "quality")
        KitMetrics.record("kit.codec.opus.bytes_per_frame", Double(trip.bytes) / frames, unit: "bytes", kind: "info")
        KitMetrics.record("kit.codec.opus.encode_us_per_frame", trip.encodeSeconds / frames * 1e6, unit: "µs", kind: "info")
        KitMetrics.record("kit.codec.opus.decode_us_per_frame", trip.decodeSeconds / frames * 1e6, unit: "µs", kind: "info")
        #expect(AudioLevel(trip.output).rmsDbfs > -60, "the decoded speech is silent")
        #expect(abs(change) < 6, "level changed by \(change) dB")
        // 24 kbps in 20 ms frames is 60 bytes; far more means it isn't the bit rate the apps use.
        #expect(Double(trip.bytes) / frames < 120)

        // Loud speech, its peaks at −3 dBFS: the decoder mustn't push it into clipping.
        let peak = AudioLevel(speech).peak
        let loud = Signal.scaled(speech, by: Float(pow(10, -3.0 / 20)) / peak)
        let loudTrip = Signal.roundTrip(loud, encoder: VoiceEncoder(), decoder: VoiceDecoder())
        KitMetrics.record("kit.codec.opus.clipped_samples.speech_loud", Double(AudioLevel(loudTrip.output).clipped), unit: "samples", kind: "level")
    }

    @Test func pcmFallbackIsExact() throws {
        let speech = try Signal.speech()
        let trip = Signal.roundTrip(speech, encoder: VoiceEncoder(preferOpus: false), decoder: VoiceDecoder())
        let error = zip(speech, trip.output).map { abs($0 - $1) }.max() ?? 1
        KitMetrics.record("kit.codec.pcm.max_error", Double(error), unit: "full scale", kind: "level")
        #expect(trip.output.count >= speech.count)
        #expect(error < 1.0 / 16_000)
    }

    /// The microphone's hardware rate converted to 16 kHz, as the input tap does it: 100 ms
    /// buffers through one converter.
    @Test(arguments: [48_000.0, 44_100.0])
    func captureConverterKeepsLevelAndPitch(rate: Double) throws {
        let hardware = try #require(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false))
        let converter = try #require(AVAudioConverter(from: hardware, to: VoiceFrame.pcmFormat))
        let input = Signal.tone(440, dbfs: -20, seconds: 2, rate: rate)
        let chunk = Int(rate / 10)
        var output: [Float] = []
        for start in stride(from: 0, to: input.count, by: chunk) {
            let samples = input[start..<min(start + chunk, input.count)]
            let buffer = try #require(AVAudioPCMBuffer(pcmFormat: hardware, frameCapacity: AVAudioFrameCount(samples.count)))
            buffer.frameLength = AVAudioFrameCount(samples.count)
            samples.withUnsafeBufferPointer { buffer.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
            output += AudioPipeline.convertCaptured(buffer, with: converter) ?? []
        }
        let name = "\(Int(rate / 1000))k"
        let steady = output.dropFirst(Signal.settleSamples)
        let change = AudioLevel(steady).rmsDbfs - (-20)
        let share = Signal.energyShare(steady.prefix(16_000), at: 440)
        KitMetrics.record("kit.capture.level_change_db.\(name)", change, unit: "dB", kind: "level")
        KitMetrics.record("kit.capture.pitch_share.\(name)", share, unit: "share", kind: "quality")
        // Two seconds in, about two seconds out at 16 kHz.
        #expect(abs(Double(output.count) - 32_000) < 1_600, "\(output.count) samples out")
        #expect(abs(change) < 3, "level changed by \(change) dB")
        #expect(share > 0.8, "only \(share) of the energy is at 440 Hz")
    }
}
