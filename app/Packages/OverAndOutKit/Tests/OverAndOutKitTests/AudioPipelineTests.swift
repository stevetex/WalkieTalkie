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
        audio.onFirstPlayback = { _ in
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

    /// Runs 87–88: iOS stops the engine 150 ms into a message. The new engine plays it again from
    /// the start, and the speaker drains only after all of it has played.
    @Test func aBurstStoppedEarlyPlaysInFullOnTheNewEngine() async throws {
        let encoder = VoiceEncoder()
        let silence = [Float](repeating: 0, count: VoiceFrame.samplesPerFrame)
        let frames = try (0..<25).map { seq in
            VoiceFrame.encode(codec: encoder.codec, seq: UInt32(seq), payload: try #require(encoder.encode(silence)))
        }
        let audio = AudioPipeline()
        var drainedAt: Date?
        var restarts: [String] = []
        audio.onPlaybackDrained = { drainedAt = Date() }
        audio.onRestart = { restarts.append($0) }
        do {
            try audio.start(capture: false)
        } catch {
            return
        }
        defer { audio.stop() }
        let started = Date()
        audio.beginPlayback()
        for frame in frames { audio.enqueue(frame) }
        audio.endPlayback()
        try await Task.sleep(nanoseconds: 150_000_000)
        audio.stopEngineForTesting()
        let stoppedAt = Date()
        audio.restartAfterConfigurationChange()
        let deadline = Date().addingTimeInterval(3)
        while drainedAt == nil, Date() < deadline {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        #expect(restarts.count == 1)
        #expect(restarts.first?.hasPrefix("engine restarted: replaying 25") == true)
        let drained = try #require(drainedAt)
        // All 500 ms again after the stop, not only what was left of it.
        #expect(drained.timeIntervalSince(stoppedAt) >= 0.45)
        #expect(drained.timeIntervalSince(started) < 2)
    }

    /// Run 94: a conversation's message arrived but its audio never started, and it played at the
    /// start of the next conversation. Discarded, it doesn't.
    @Test func discardedPlaybackDoesNotPlayOnTheNextStart() async throws {
        let encoder = VoiceEncoder()
        let silence = [Float](repeating: 0, count: VoiceFrame.samplesPerFrame)
        let frames = try (0..<10).map { seq in
            VoiceFrame.encode(codec: encoder.codec, seq: UInt32(seq), payload: try #require(encoder.encode(silence)))
        }
        let audio = AudioPipeline()
        var played = false
        audio.onFirstPlayback = { _ in played = true }
        audio.beginPlayback()
        for frame in frames { audio.enqueue(frame) }
        audio.endPlayback()
        audio.discardPlayback()
        do {
            try audio.start(capture: false)
        } catch {
            return
        }
        defer { audio.stop() }
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(!played)
    }
}
