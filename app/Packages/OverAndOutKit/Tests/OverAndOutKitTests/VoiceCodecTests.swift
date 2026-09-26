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

    private func tone() -> [Float] {
        (0..<VoiceFrame.samplesPerFrame).map { 0.3 * sin(Float($0) * 2 * .pi * 440 / Float(VoiceFrame.sampleRate)) }
    }
}
