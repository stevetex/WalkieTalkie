import AVFoundation

/// Microphone capture and speaker playback for the duration of a conversation.
///
/// The app owns the audio session (playAndRecord, voiceChat) and activates it before
/// `start()`. Frames received before `start()` are held and played once it runs. All
/// state lives on `queue`; only the capture converter runs on the tap's thread.
public final class AudioPipeline {
    /// Encoded wire frames while capturing. Called on the audio queue.
    public var onFrame: ((Data) -> Void)?
    /// The first buffer of a received burst was handed to the player. Called on the audio queue.
    public var onFirstPlayback: (() -> Void)?
    /// The microphone produced the first frame of a burst (time in ms). Called on the audio queue.
    public var onFirstCapturedFrame: ((Double) -> Void)?
    /// The engine was restarted after watchOS changed its configuration (for example
    /// another session took the audio hardware). Called on the main queue.
    public var onRestart: ((String) -> Void)?

    public var codecDescription: String {
        encoder.codec == .opus16k ? "Opus 24 kbps" : "PCM 256 kbps (no Opus encoder)"
    }

    public enum PipelineError: LocalizedError {
        case noInput
        public var errorDescription: String? { "No microphone input available (playback only)" }
    }

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let queue = DispatchQueue(label: "walkie.audio", qos: .userInteractive)
    private let encoder = VoiceEncoder()
    private let decoder = VoiceDecoder()
    private var attached = false
    /// Main thread only: start() was called and stop() hasn't been since.
    private var wantsRunning = false

    // Tap thread only.
    private var captureConverter: AVAudioConverter?

    // Audio queue only.
    private var running = false
    private var capturing = false
    private var pendingSamples: [Float] = []
    private var sequence: UInt32 = 0
    private var held: [AVAudioPCMBuffer] = []
    private var prebuffering = false
    private var reportedFirstPlayback = false

    /// Frames of jitter buffer before a live burst starts playing (4 × 20 ms).
    private static let prebufferFrames = 4

    public init() {
        NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { [weak self] _ in self?.restartAfterConfigurationChange() }
        // Build the Opus encoder and decoder at launch rather than on the first message.
        queue.async {
            let silence = [Float](repeating: 0, count: VoiceFrame.samplesPerFrame)
            if let packet = self.encoder.encode(silence) {
                _ = self.decoder.decode(codec: self.encoder.codec, payload: packet)
            }
            self.encoder.reset()
            self.decoder.reset()
        }
    }

    public func start() throws {
        wantsRunning = true
        if !attached {
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: VoiceFrame.pcmFormat)
            attached = true
        }
        let input = engine.inputNode
        let hardware = input.outputFormat(forBus: 0)
        let hasInput = hardware.channelCount > 0 && hardware.sampleRate > 0
        input.removeTap(onBus: 0)
        if hasInput {
            captureConverter = AVAudioConverter(from: hardware, to: VoiceFrame.pcmFormat)
            // The tap delivers ~100 ms buffers; they're re-chunked into 20 ms frames below.
            input.installTap(onBus: 0, bufferSize: 1600, format: hardware) { [weak self] buffer, _ in
                self?.captured(buffer)
            }
        }
        engine.prepare()
        try engine.start()
        player.play()
        queue.async {
            self.running = true
            if !self.prebuffering { self.flushHeld() }
        }
        guard hasInput else {
            // Playback still works, so receiving can be tested even without a microphone.
            #if targetEnvironment(simulator)
            startTestTone()
            #endif
            throw PipelineError.noInput
        }
    }

    #if targetEnvironment(simulator)
    /// The watch simulator has no microphone. While capturing, feed a 440 Hz tone in real
    /// time instead, so the send path (Opus encode, framing, relay) can still be exercised.
    private var toneTimer: DispatchSourceTimer?
    private var tonePhase: Float = 0

    private func startTestTone() {
        guard toneTimer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(20))
        timer.setEventHandler { [weak self] in
            guard let self, self.capturing else { return }
            let step = 2 * Float.pi * 440 / Float(VoiceFrame.sampleRate)
            let samples = (0..<VoiceFrame.samplesPerFrame).map { i -> Float in
                0.3 * sin(self.tonePhase + Float(i) * step)
            }
            self.tonePhase = fmodf(self.tonePhase + Float(VoiceFrame.samplesPerFrame) * step, 2 * Float.pi)
            self.pendingSamples.append(contentsOf: samples)
            self.emitFrames()
        }
        timer.resume()
        toneTimer = timer
    }
    #endif

    public func stop() {
        wantsRunning = false
        #if targetEnvironment(simulator)
        toneTimer?.cancel()
        toneTimer = nil
        #endif
        engine.inputNode.removeTap(onBus: 0)
        player.stop()
        engine.stop()
        queue.async {
            self.running = false
            self.capturing = false
            self.pendingSamples.removeAll()
            self.held.removeAll()
        }
    }

    /// watchOS stops the engine when the audio configuration changes, for instance when
    /// another session takes the audio hardware.
    private func restartAfterConfigurationChange() {
        guard wantsRunning, attached, !engine.isRunning else { return }
        do {
            try start()
            onRestart?("engine restarted after configuration change")
        } catch {
            onRestart?("engine restart failed: \(error.localizedDescription)")
        }
    }

    // MARK: Capture

    public func beginCapture() {
        queue.async {
            self.encoder.reset()
            self.sequence = 0
            self.pendingSamples.removeAll()
            self.capturing = true
        }
    }

    /// Pads and sends the final partial frame, then calls `completion` on the audio queue.
    public func endCapture(completion: @escaping () -> Void) {
        queue.async {
            if self.capturing, !self.pendingSamples.isEmpty {
                let padding = VoiceFrame.samplesPerFrame - self.pendingSamples.count
                self.pendingSamples.append(contentsOf: repeatElement(0, count: max(0, padding)))
                self.emitFrames()
            }
            self.capturing = false
            self.pendingSamples.removeAll()
            completion()
        }
    }

    private func captured(_ buffer: AVAudioPCMBuffer) {
        guard let converter = captureConverter else { return }
        let ratio = VoiceFrame.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let output = AVAudioPCMBuffer(pcmFormat: VoiceFrame.pcmFormat, frameCapacity: capacity) else { return }
        var consumed = false
        var error: NSError?
        _ = converter.convert(to: output, error: &error) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        guard output.frameLength > 0 else { return }
        let samples = Array(UnsafeBufferPointer(start: output.floatChannelData![0], count: Int(output.frameLength)))
        queue.async {
            guard self.capturing else { return }
            self.pendingSamples.append(contentsOf: samples)
            self.emitFrames()
        }
    }

    private func emitFrames() {
        let size = VoiceFrame.samplesPerFrame
        while pendingSamples.count >= size {
            let frame = Array(pendingSamples.prefix(size))
            pendingSamples.removeFirst(size)
            guard let payload = encoder.encode(frame) else { continue }
            if sequence == 0 { onFirstCapturedFrame?(Clock.nowMs()) }
            onFrame?(VoiceFrame.encode(codec: encoder.codec, seq: sequence, payload: payload))
            sequence &+= 1
        }
    }

    // MARK: Playback

    public func beginPlayback() {
        queue.async {
            self.decoder.reset()
            self.prebuffering = true
            self.reportedFirstPlayback = false
        }
    }

    public func enqueue(_ frame: Data) {
        queue.async {
            guard let (codec, _, payload) = VoiceFrame.decode(frame),
                  let buffer = self.decoder.decode(codec: codec, payload: payload) else { return }
            self.held.append(buffer)
            if self.prebuffering, self.held.count >= Self.prebufferFrames { self.prebuffering = false }
            if !self.prebuffering { self.flushHeld() }
        }
    }

    /// End of a received burst: play whatever is still held, even if under the prebuffer.
    public func endPlayback() {
        queue.async {
            self.prebuffering = false
            self.flushHeld()
        }
    }

    private func flushHeld() {
        guard running, !held.isEmpty else { return }
        for buffer in held {
            player.scheduleBuffer(buffer, completionHandler: nil)
        }
        held.removeAll()
        if !player.isPlaying { player.play() }
        if !reportedFirstPlayback {
            reportedFirstPlayback = true
            onFirstPlayback?()
        }
    }
}
