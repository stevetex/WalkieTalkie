import Foundation
import Testing
@testable import OverAndOutKit

struct VoiceCodecTests {
    @Test func frameHeaderRoundTrips() throws {
        let frame = VoiceFrame.encode(codec: .opus16k, seq: 0x0102_0304, payload: Data([0xAA, 0xBB]))
        #expect(Array(frame.prefix(VoiceFrame.headerBytes)) == [1, 1, 2, 3, 4])
        let decoded = try #require(VoiceFrame.decode(frame))
        #expect(decoded.codec == .opus16k)
        #expect(decoded.seq == 0x0102_0304)
        #expect(decoded.payload == Data([0xAA, 0xBB]))
    }

    @Test func rejectsFramesWithoutPayloadOrWithUnknownCodec() {
        #expect(VoiceFrame.decode(Data([1, 0, 0, 0, 0])) == nil)
        #expect(VoiceFrame.decode(Data([9, 0, 0, 0, 0, 1])) == nil)
    }

    @Test func pcmRoundTrips() throws {
        let encoder = VoiceEncoder(preferOpus: false)
        let samples = tone()
        let payload = try #require(encoder.encode(samples))
        #expect(payload.count == VoiceFrame.samplesPerFrame * 2)
        let buffer = try #require(VoiceDecoder().decode(codec: .pcm16le16k, payload: payload))
        let decoded = Array(UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength)))
        #expect(decoded.count == samples.count)
        #expect(zip(decoded, samples).allSatisfy { abs($0 - $1) < 0.001 })
    }

    /// A 1,282-byte PCM payload (641 samples) used to overrun the 640-sample buffer and crash.
    @Test func rejectsPayloadsOfTheWrongSize() {
        let decoder = VoiceDecoder()
        for count in [0, 2, 638, 642, 1282, 64 * 1024] {
            #expect(decoder.decode(codec: .pcm16le16k, payload: Data(count: count)) == nil)
        }
        #expect(decoder.decode(codec: .opus16k, payload: Data(count: 0)) == nil)
        #expect(decoder.decode(codec: .opus16k, payload: Data(count: 1276)) == nil)
    }

    @Test func opusEncodesAndDecodesAFrame() throws {
        let encoder = VoiceEncoder()
        try #require(encoder.codec == .opus16k, "no Opus encoder on this machine")
        let decoder = VoiceDecoder()
        // Opus needs a few frames of history before it emits full-length output.
        var decodedSamples = 0
        for _ in 0..<5 {
            let payload = try #require(encoder.encode(tone()))
            #expect(payload.count < VoiceFrame.samplesPerFrame * 2)
            decodedSamples += Int(decoder.decode(codec: .opus16k, payload: payload)?.frameLength ?? 0)
        }
        #expect(decodedSamples > 0)
    }

    /// Constant bitrate: silence, a tone, noise and near-silence all encode to the same packet
    /// size, so packet sizes don't show when someone speaks or pauses (E2EE_SPEC.md). Under the
    /// default variable bitrate these ranged from 8 to 107 bytes.
    @Test func opusPacketsAreAllTheSameSize() throws {
        let encoder = VoiceEncoder()
        try #require(encoder.codec == .opus16k, "no Opus encoder on this machine")
        var sizes = Set<Int>()
        for frame in 0..<200 {
            let samples: [Float] = switch (frame / 25) % 4 {
            case 0: Array(repeating: 0, count: VoiceFrame.samplesPerFrame)
            case 1: tone()
            case 2: (0..<VoiceFrame.samplesPerFrame).map { _ in Float.random(in: -0.3...0.3) }
            default: (0..<VoiceFrame.samplesPerFrame).map { _ in Float.random(in: -0.01...0.01) }
            }
            sizes.insert(try #require(encoder.encode(samples)).count)
        }
        #expect(sizes == [60])
    }

    private func tone() -> [Float] {
        (0..<VoiceFrame.samplesPerFrame).map { 0.3 * sin(Float($0) * 2 * .pi * 440 / Float(VoiceFrame.sampleRate)) }
    }
}
