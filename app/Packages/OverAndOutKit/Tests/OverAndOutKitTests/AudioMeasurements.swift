import Accelerate
import AVFoundation
import Foundation
import os
import Testing
@testable import OverAndOutKit

/// Measurements the kit's tests record for CI, one JSON object per line in the file
/// OAO_KIT_METRICS names (nothing otherwise). server/perf/compare.ts --kit-lines judges them
/// against server/perf/budgets.json: during the tuning weeks the fine thresholds only warn, so
/// the tests themselves fail only on gross problems (silence, the wrong pitch, lost frames).
enum KitMetrics {
    private static let lock = OSAllocatedUnfairLock(initialState: ())

    /// `kind`: "level" or "quality" (judged against a budget), "integrity" (must be 0), or
    /// "info" (recorded and watched for drift).
    static func record(_ key: String, _ value: Double, unit: String, kind: String) {
        guard let path = ProcessInfo.processInfo.environment["OAO_KIT_METRICS"], value.isFinite else { return }
        let line = #"{"key":"\#(key)","value":\#(value),"unit":"\#(unit)","kind":"\#(kind)"}"# + "\n"
        lock.withLock { _ in
            if let handle = FileHandle(forWritingAtPath: path) {
                handle.seekToEndOfFile()
                handle.write(Data(line.utf8))
                try? handle.close()
            } else {
                FileManager.default.createFile(atPath: path, contents: Data(line.utf8))
            }
        }
    }
}

/// Test signals and what the tests measure about them.
enum Signal {
    static let rate = VoiceFrame.sampleRate
    static let frame = VoiceFrame.samplesPerFrame
    /// Opus takes a few frames to settle; levels are compared after them.
    static let settleSamples = 5 * VoiceFrame.samplesPerFrame

    /// A sine whose RMS is `dbfs`.
    static func tone(_ hz: Double, dbfs: Double, seconds: Double, rate: Double = Signal.rate) -> [Float] {
        let amplitude = 2.0.squareRoot() * pow(10, dbfs / 20)
        let count = Int(seconds * rate)
        return (0..<count).map { Float(amplitude * sin(2 * .pi * hz * Double($0) / rate)) }
    }

    /// The committed speech clip: 4 s of synthesized speech, 16 kHz mono, RMS −24 dBFS
    /// (Fixtures/speech-16k.wav, made with espeak-ng and resampled).
    static func speech() throws -> [Float] {
        let url = try #require(Bundle.module.url(forResource: "speech-16k", withExtension: "wav", subdirectory: "Fixtures"))
        let file = try AVAudioFile(forReading: url)
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
        try file.read(into: buffer)
        return Array(UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength)))
    }

    /// 20 ms frames; the last one padded with silence, as the pipeline does.
    static func frames(_ samples: [Float]) -> [[Float]] {
        stride(from: 0, to: samples.count, by: frame).map { start in
            let chunk = Array(samples[start..<min(start + frame, samples.count)])
            return chunk + [Float](repeating: 0, count: frame - chunk.count)
        }
    }

    static func scaled(_ samples: [Float], by gain: Float) -> [Float] { samples.map { $0 * gain } }

    static func rms(_ samples: ArraySlice<Float>) -> Double { AudioLevel(samples).rms }

    /// How much louder (+) or quieter (−) `output` is than `input`, in dB, past the settling frames.
    static func levelChange(_ input: [Float], _ output: [Float]) -> Double {
        let n = min(input.count, output.count)
        guard n > settleSamples else { return .nan }
        let a = rms(input[settleSamples..<n])
        let b = rms(output[settleSamples..<n])
        return AudioLevel.dbfs(b) - AudioLevel.dbfs(a)
    }

    /// The share of a stretch's energy at `hz` (Goertzel over whole seconds, so a tone is
    /// close to 1 and noise or the wrong pitch is close to 0).
    static func energyShare(_ samples: ArraySlice<Float>, at hz: Double, rate: Double = Signal.rate) -> Double {
        let x = Array(samples)
        guard !x.isEmpty else { return .nan }
        let w = 2 * Double.pi * hz / rate
        let coefficient = 2 * cos(w)
        var s1 = 0.0, s2 = 0.0
        for sample in x {
            let s0 = Double(sample) + coefficient * s1 - s2
            s2 = s1
            s1 = s0
        }
        let power = s1 * s1 + s2 * s2 - coefficient * s1 * s2
        let energy = x.reduce(0.0) { $0 + Double($1) * Double($1) }
        return energy > 0 ? (2 / Double(x.count)) * power / energy : 0
    }

    /// The delay (samples) at which `output` lines up best with `input`: the codec's lookahead.
    static func bestLag(_ input: [Float], _ output: [Float], maxLag: Int = 1_600) -> Int {
        let length = min(input.count, output.count) - maxLag
        guard length > 0 else { return 0 }
        var best = (lag: 0, score: -Float.infinity)
        input.withUnsafeBufferPointer { a in
            output.withUnsafeBufferPointer { b in
                for lag in 0...maxLag {
                    var dot: Float = 0
                    vDSP_dotpr(a.baseAddress!, 1, b.baseAddress! + lag, 1, &dot, vDSP_Length(length))
                    if dot > best.score { best = (lag, dot) }
                }
            }
        }
        return best.lag
    }

    /// Signal-to-noise ratio of `output` against `input` in dB, after lining them up and
    /// matching their gain (level is measured separately), past the settling frames.
    static func snr(_ input: [Float], _ output: [Float]) -> Double {
        let lag = bestLag(input, output)
        let n = min(input.count, output.count - lag)
        guard n > settleSamples else { return .nan }
        var inOut = 0.0, outOut = 0.0, inIn = 0.0
        for i in settleSamples..<n {
            let a = Double(input[i]), b = Double(output[i + lag])
            inOut += a * b
            outOut += b * b
            inIn += a * a
        }
        guard outOut > 0 else { return -.infinity }
        let gain = inOut / outOut
        var noise = 0.0
        for i in settleSamples..<n {
            let e = Double(input[i]) - gain * Double(output[i + lag])
            noise += e * e
        }
        return 10 * log10(inIn / max(noise, 1e-12))
    }

    /// Through the codec as the apps use it: encoded frame by frame, then decoded.
    static func roundTrip(_ samples: [Float], encoder: VoiceEncoder, decoder: VoiceDecoder) -> (output: [Float], bytes: Int, encodeSeconds: Double, decodeSeconds: Double) {
        var output: [Float] = []
        var bytes = 0
        var encodeSeconds = 0.0, decodeSeconds = 0.0
        encoder.reset()
        decoder.reset()
        for frame in frames(samples) {
            let t0 = Date()
            guard let payload = encoder.encode(frame) else { continue }
            let t1 = Date()
            bytes += payload.count
            if let buffer = decoder.decode(codec: encoder.codec, payload: payload) {
                output += UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength))
            }
            encodeSeconds += t1.timeIntervalSince(t0)
            decodeSeconds += Date().timeIntervalSince(t1)
        }
        return (output, bytes, encodeSeconds, decodeSeconds)
    }

    /// Decodes wire frames as a receiver does (one decoder, reset at the burst's start).
    static func decode(_ frames: [Data]) -> [Float] {
        let decoder = VoiceDecoder()
        decoder.reset()
        var output: [Float] = []
        for frame in frames {
            guard let (codec, _, payload) = VoiceFrame.decode(frame),
                  let buffer = decoder.decode(codec: codec, payload: payload) else { continue }
            output += UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength))
        }
        return output
    }
}
