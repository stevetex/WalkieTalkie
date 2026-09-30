import AVFoundation
import Foundation
import Testing
@testable import OverAndOutKit

/// The pipeline's events cross from its audio queue to the main actor. Plays a short burst of
/// silence on the Mac's speaker (playback only: no microphone).
@MainActor
struct AudioPipelineTests {
    @Test func aBurstHeldBeforeStartPlaysAndDrainsOnTheMainActor() async throws {
        let encoder = VoiceEncoder()
        let silence = [Float](repeating: 0, count: VoiceFrame.samplesPerFrame)
        let frames = try (0..<5).map { seq in
            VoiceFrame.encode(codec: encoder.codec, seq: UInt32(seq), payload: try #require(encoder.encode(silence)))
        }
        let audio = AudioPipeline()
        var events: [String] = []
        var allOnMain = true
        audio.onFirstPlayback = {
            allOnMain = allOnMain && Thread.isMainThread
            events.append("firstPlayback")
        }
        audio.onPlaybackDrained = {
            allOnMain = allOnMain && Thread.isMainThread
            events.append("drained")
        }
        // As on the watch: a prefetched burst is queued before the audio session is up.
        audio.beginPlayback()
        for frame in frames { audio.enqueue(frame) }
        audio.endPlayback()
        do {
            try audio.start(capture: false)
        } catch {
            // No output device on this Mac: nothing to play through.
            return
        }
        defer { audio.stop() }
        let deadline = Date().addingTimeInterval(3)
        while !events.contains("drained"), Date() < deadline {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        #expect(events == ["firstPlayback", "drained"])
        #expect(allOnMain)
    }
}
