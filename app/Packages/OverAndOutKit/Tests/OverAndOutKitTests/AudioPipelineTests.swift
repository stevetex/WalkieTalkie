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
        // A CI runner's virtual output device can play faster than real time: the burst is
        // over before the stop, so there's nothing cut short to replay (as without a device).
        guard drainedAt == nil else { return }
        audio.stopEngineForTesting()
        let stoppedAt = Date()
        audio.restartAfterConfigurationChange()
        func waitForDrain() async throws {
            let deadline = Date().addingTimeInterval(3)
            while drainedAt == nil, Date() < deadline {
                try await Task.sleep(nanoseconds: 10_000_000)
            }
        }
        try await waitForDrain()
        // All 25 frames go to the new engine again, not only what was left of them.
        #expect(restarts.count == 1)
        #expect(restarts.first?.hasPrefix("engine restarted: replaying 25") == true)
        let drained = try #require(drainedAt)
        let replayTook = drained.timeIntervalSince(stoppedAt)
        #expect(drained.timeIntervalSince(started) < 2)

        // And the speaker drains only once they've played: 500 ms again after the stop. Only a
        // device that plays in real time can show that. A CI runner's virtual device can play
        // faster, and its speed can change when the engine is replaced (PR #52's CI run: slow
        // before the stop, the replay drained in 20 ms after it). So time the same 500 ms on the
        // new engine, and check the replay only if this device took about that long.
        drainedAt = nil
        let timingStarted = Date()
        audio.beginPlayback()
        for frame in frames { audio.enqueue(frame) }
        audio.endPlayback()
        try await waitForDrain()
        let fiveHundredMsTook = try #require(drainedAt).timeIntervalSince(timingStarted)
        guard fiveHundredMsTook >= 0.45 else { return }
        #expect(replayTook >= 0.45)
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

    /// The raw level reads every channel, so a microphone that delivers sound on a channel the
    /// conversion ignores shows up as raw sound with a silent burst.
    @Test func theRawPeakReadsEveryChannel() throws {
        let format = try #require(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 2, interleaved: false))
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 480))
        buffer.frameLength = 480
        for i in 0..<480 {
            buffer.floatChannelData![0][i] = 0
            buffer.floatChannelData![1][i] = i == 100 ? -0.5 : 0
        }
        #expect(AudioPipeline.rawPeaks(of: buffer) == [0, 0.5])
        #expect(AudioPipeline.describe(format) == "48000 Hz, 2 ch, float32, deinterleaved")
    }

    /// On the watch one channel carries most of the voice: that one is sent, at its own level.
    @Test func theLoudestChannelIsSent() throws {
        let layout = try #require(AVAudioChannelLayout(layoutTag: kAudioChannelLayoutTag_DiscreteInOrder | 3))
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, interleaved: false, channelLayout: layout)
        let mono = try #require(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 1, interleaved: false))
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4_800))
        buffer.frameLength = 4_800
        for i in 0..<4_800 {
            buffer.floatChannelData![0][i] = 0.001
            buffer.floatChannelData![1][i] = 0.3 * sin(Float(i) * 0.05)
            buffer.floatChannelData![2][i] = 0.01 * sin(Float(i) * 0.05)
        }
        let picked = try #require(AudioPipeline.loudestChannel(buffer, as: mono))
        #expect(picked.frameLength == 4_800)
        #expect(picked.floatChannelData![0][100] == buffer.floatChannelData![1][100])
    }
}
