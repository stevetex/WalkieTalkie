import AVFoundation

/// Microphone capture and speaker playback for the duration of a conversation.
///
/// The app owns the audio session (playAndRecord, voiceChat) and activates it before
/// `start()`. Frames received before `start()` are held and played once it runs.
///
/// Who owns what:
/// - The main actor: the public API, every callback, and the engine's lifecycle (start, stop,
///   replacing the engine, restarting after a configuration change).
/// - The audio queue (`AudioQueueState`): the encoder and decoder, the capture buffer, the
///   jitter buffer, and scheduling on the player, so captured and played frames stay in order.
/// - The input tap's block: the capture converter. It hands converted samples to the queue.
@MainActor
public final class AudioPipeline {
    /// Encoded wire frames while capturing, in order.
    public var onFrame: ((Data) -> Void)?
    /// The first buffer of a received burst was handed to the player (time in ms, on the audio
    /// queue: the main thread can hear of it much later while the app comes to the front).
    public var onFirstPlayback: ((Double) -> Void)?
    /// Everything handed to the player has been played. A replayed burst arrives much
    /// faster than it plays, so this, not the burst's end, is when the speaker goes quiet.
    public var onPlaybackDrained: (() -> Void)?
    /// The microphone produced the first frame of a burst (time in ms, on the audio queue).
    public var onFirstCapturedFrame: ((Double) -> Void)?
    /// The engine was restarted after watchOS changed its configuration (for example
    /// another session took the audio hardware).
    public var onRestart: ((String) -> Void)?
    /// A burst's capture ended: how loud the microphone's audio was (before encoding) and how
    /// many frames it made. For Beta telemetry's per-burst levels.
    public var onBurstCaptured: ((AudioLevel, Int) -> Void)?
    /// A received burst ended: how loud the decoded audio handed to the speaker was, and how
    /// many frames. For Beta telemetry's per-burst levels.
    public var onBurstPlayed: ((AudioLevel, Int) -> Void)?

    public var codecDescription: String {
        codec == .opus16k ? "Opus 24 kbps" : "PCM 256 kbps (no Opus encoder)"
    }

    public enum PipelineError: LocalizedError {
        case noInput
        public var errorDescription: String? { "No microphone input available (playback only)" }
    }

    // Replaced (engine stopped) when a playback-only start follows one that used the
    // microphone: merely touching `inputNode` gives an engine an input for good.
    private var engine = AVAudioEngine()
    private var player = AVAudioPlayerNode()
    /// This engine has touched its input node.
    private var engineHasInput = false
    /// The last start's capture choice, for restarts.
    private var wantsCapture = true
    private var configurationObserver: NSObjectProtocol?
    private var attached = false
    /// start() was called and stop() hasn't been since.
    private var wantsRunning = false
    private let codec: VoiceFrame.Codec
    private let state: AudioQueueState

    public init() {
        state = AudioQueueState(player: player)
        codec = state.codec
        observeConfigurationChanges()
        state.async { [weak self] state in
            state.pipeline = self
            // Build the Opus encoder and decoder at launch rather than on the first message.
            state.warmUp()
        }
    }

    private func observeConfigurationChanges() {
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }
        configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.restartAfterConfigurationChange() }
        }
    }

    /// `capture: false` starts the speaker only. For PushToTalk receiving: the system has muted
    /// the microphone then, and starting it anyway makes the hardware reconfigure a moment later,
    /// which stops the engine and loses what was queued to play.
    public func start(capture: Bool = true) throws {
        wantsRunning = true
        wantsCapture = capture
        if !capture, engineHasInput, !engine.isRunning { replaceEngine() }
        if !attached {
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: VoiceFrame.pcmFormat)
            attached = true
        }
        guard capture else {
            engine.prepare()
            try engine.start()
            player.play()
            state.async { $0.started() }
            return
        }
        let input = engine.inputNode
        engineHasInput = true
        let hardware = input.outputFormat(forBus: 0)
        let hasInput = hardware.channelCount > 0 && hardware.sampleRate > 0
        input.removeTap(onBus: 0)
        if hasInput, let converter = AVAudioConverter(from: hardware, to: VoiceFrame.pcmFormat) {
            // The tap delivers ~100 ms buffers; they're re-chunked into 20 ms frames on the queue.
            input.installTap(onBus: 0, bufferSize: 1600, format: hardware, block: Self.captureTap(converter: converter, state: state))
        }
        engine.prepare()
        try engine.start()
        player.play()
        state.async { $0.started() }
        guard hasInput else {
            // Playback still works, so receiving can be tested even without a microphone.
            #if targetEnvironment(simulator)
            state.async { $0.startTestTone() }
            #endif
            throw PipelineError.noInput
        }
    }

    /// The input tap's block, made outside the main actor: the tap calls it on its own
    /// real-time thread. It owns the converter; only the samples go to the audio queue.
    private nonisolated static func captureTap(converter: AVAudioConverter, state: AudioQueueState) -> AVAudioNodeTapBlock {
        { buffer, _ in
            guard let samples = convertCaptured(buffer, with: converter) else { return }
            state.async { $0.captured(samples) }
        }
    }

    /// One tap buffer, in the hardware's format, as 16 kHz mono samples. The converter keeps
    /// its state from one buffer to the next. Internal so the tests can measure it.
    nonisolated static func convertCaptured(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter) -> [Float]? {
        let ratio = VoiceFrame.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let output = AVAudioPCMBuffer(pcmFormat: VoiceFrame.pcmFormat, frameCapacity: capacity) else { return nil }
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
        guard output.frameLength > 0 else { return nil }
        return Array(UnsafeBufferPointer(start: output.floatChannelData![0], count: Int(output.frameLength)))
    }

    public func stop() {
        wantsRunning = false
        if engineHasInput { engine.inputNode.removeTap(onBus: 0) }
        player.stop()
        engine.stop()
        state.async { $0.stopped() }
    }

    /// A new engine and player, attached on the next start. The old engine's connections keep
    /// the hardware format they were made with.
    private func replaceEngine() {
        let fresh = AVAudioEngine()
        let freshPlayer = AVAudioPlayerNode()
        state.replacePlayer(freshPlayer)
        engine = fresh
        player = freshPlayer
        attached = false
        engineHasInput = false
        observeConfigurationChanges()
    }

    /// The system stops the engine when the audio configuration changes: another session takes
    /// the hardware, or the route's format changes (run 57: hearing aids switching to a call
    /// link as PushToTalk activated audio). The stopped engine is rebuilt rather than restarted:
    /// restarted with its old connections, it played static and never reported buffers played.
    /// The stopped engine also threw away what the player had scheduled; that is played again on
    /// the new one, from the burst's start if the change came early in it (runs 87–88: the
    /// hearing aids' switch 150 ms into a message cut its first word).
    func restartAfterConfigurationChange() {
        guard wantsRunning, attached, !engine.isRunning else { return }
        let replay = state.holdScheduledForReplay()
        if engineHasInput { engine.inputNode.removeTap(onBus: 0) }
        replaceEngine()
        do {
            try start(capture: wantsCapture)
            onRestart?("engine restarted: replaying \(replay.buffers) (\(replay.rewound) rewound)")
        } catch {
            // Nothing will play what was held: count it as played, or the speaker never drains.
            state.async { $0.abandonPlayback() }
            onRestart?("engine restart failed: \(error.localizedDescription)")
        }
    }

    /// For the tests: the engine as the system leaves it after a configuration change.
    func stopEngineForTesting() {
        engine.stop()
    }

    // MARK: Capture

    public func beginCapture() {
        state.async { $0.beginCapture() }
    }

    /// Pads and sends the final partial frame, then calls `completion`, after that frame's `onFrame`.
    public func endCapture(completion: @escaping @MainActor @Sendable () -> Void) {
        state.async { state in
            state.endCapture()
            DispatchQueue.main.async { completion() }
        }
    }

    // MARK: Playback

    public func beginPlayback() {
        state.async { $0.beginPlayback() }
    }

    public func enqueue(_ frame: Data) {
        state.async { $0.enqueue(frame) }
    }

    /// End of a received burst: play whatever is still held, even if under the prebuffer.
    public func endPlayback() {
        state.async { $0.endPlayback() }
    }

    // MARK: From the audio queue

    fileprivate func deliver(_ event: AudioQueueState.Event) {
        switch event {
        case .frame(let frame): onFrame?(frame)
        case .firstPlayback(let t): onFirstPlayback?(t)
        case .firstCapturedFrame(let t): onFirstCapturedFrame?(t)
        case .drained: onPlaybackDrained?()
        case .stalled(let buffers, let drained):
            onRestart?("playback stalled: \(buffers) buffers never reported played; counted as played")
            if drained { onPlaybackDrained?() }
        case .captureLevel(let level, let frames): onBurstCaptured?(level, frames)
        case .playbackLevel(let level, let frames): onBurstPlayed?(level, frames)
        }
    }
}

/// The pipeline's state on its serial audio queue.
///
/// `@unchecked Sendable`: every mutable property is read and written only on `queue`. The
/// pipeline reaches it only through `async` and the two methods that wait for the queue
/// (called from the main actor, never from the queue, so they can't deadlock); the player's
/// completion handlers and the watchdog hop onto the queue; `onQueue()` checks the invariant
/// in debug builds. Events for the pipeline go to
/// the main queue in the order they happen. A serial queue rather than an actor: frames arrive
/// from the tap's real-time thread and the player's callbacks, where awaiting isn't possible,
/// and iOS 16/watchOS 9 can't run an actor on this queue.
private final class AudioQueueState: @unchecked Sendable {
    enum Event: Sendable {
        case frame(Data)
        case firstPlayback(Double)
        case firstCapturedFrame(Double)
        case drained
        case stalled(buffers: Int, drained: Bool)
        case captureLevel(AudioLevel, frames: Int)
        case playbackLevel(AudioLevel, frames: Int)
    }

    private let queue = DispatchQueue(label: "walkie.audio", qos: .userInteractive)
    private let encoder = VoiceEncoder()
    private let decoder = VoiceDecoder()
    let codec: VoiceFrame.Codec

    /// Set on the queue by the pipeline's init; weak so the pipeline can go away.
    weak var pipeline: AudioPipeline?
    /// The pipeline's current player (replaced along with its engine).
    private var player: AVAudioPlayerNode
    private var running = false
    private var capturing = false
    private var pendingSamples: [Float] = []
    private var sequence: UInt32 = 0
    /// The current burst's levels, sent and received.
    private var capturedLevel = AudioLevel()
    private var playedLevel = AudioLevel()
    private var playedFrames = 0
    private var held: [AVAudioPCMBuffer] = []
    private var prebuffering = false
    private var reportedFirstPlayback = false
    /// What the current player was given and hasn't played yet, and the start of the burst.
    private var ledger = PlaybackLedger<AVAudioPCMBuffer>()
    /// Bumped when the player is replaced, so a stopped player's late callbacks are ignored.
    private var playerGeneration = 0
    /// When everything scheduled should have finished playing (ms).
    private var expectedDrainAt: Double = 0
    private var drainWatchdog: DispatchWorkItem?

    /// Frames of jitter buffer before a live burst starts playing (4 × 20 ms).
    private static let prebufferFrames = 4

    init(player: AVAudioPlayerNode) {
        self.player = player
        codec = encoder.codec
    }

    func async(_ work: @escaping @Sendable (AudioQueueState) -> Void) {
        queue.async { work(self) }
    }

    /// From the main actor, with the engine stopped: waits for the queue.
    func replacePlayer(_ player: AVAudioPlayerNode) {
        queue.sync {
            self.player = player
            playerGeneration += 1
        }
    }

    private func onQueue() {
        #if DEBUG
        dispatchPrecondition(condition: .onQueue(queue))
        #endif
    }

    /// To the pipeline on the main queue, after everything sent before it.
    private func send(_ event: Event) {
        let pipeline = self.pipeline
        DispatchQueue.main.async { pipeline?.deliver(event) }
    }

    func warmUp() {
        onQueue()
        let silence = [Float](repeating: 0, count: VoiceFrame.samplesPerFrame)
        if let packet = encoder.encode(silence) {
            _ = decoder.decode(codec: encoder.codec, payload: packet)
        }
        encoder.reset()
        decoder.reset()
    }

    func started() {
        onQueue()
        running = true
        if !prebuffering { flushHeld() }
    }

    func stopped() {
        onQueue()
        #if targetEnvironment(simulator)
        toneTimer?.cancel()
        toneTimer = nil
        #endif
        running = false
        capturing = false
        pendingSamples.removeAll()
        capturedLevel = AudioLevel()
        playedLevel = AudioLevel()
        playedFrames = 0
        held.removeAll()
        ledger = PlaybackLedger()
        expectedDrainAt = 0
        drainWatchdog?.cancel()
    }

    /// From the main actor: the engine stopped and threw away what was scheduled, and those
    /// buffers' "played" callbacks never come. Holds them to play again once the new engine
    /// starts (`started()`), after the burst's first moments if the stop came early in it.
    /// Waits for the queue; returns how many buffers will play again, and how many of them had
    /// already played.
    func holdScheduledForReplay() -> (buffers: Int, rewound: Int) {
        queue.sync {
            let replay = ledger.takeForReplay()
            held.insert(contentsOf: replay.buffers, at: 0)
            // Until the new engine runs, frames that arrive wait in `held` behind these.
            running = false
            expectedDrainAt = 0
            drainWatchdog?.cancel()
            return (replay.buffers.count, replay.rewound)
        }
    }

    /// The engine couldn't be restarted: nothing will play what's held.
    func abandonPlayback() {
        onQueue()
        let hadAudio = ledger.scheduledCount > 0 || !held.isEmpty
        held.removeAll()
        ledger = PlaybackLedger()
        expectedDrainAt = 0
        drainWatchdog?.cancel()
        if hadAudio { send(.drained) }
    }

    // MARK: Capture

    func beginCapture() {
        onQueue()
        encoder.reset()
        sequence = 0
        pendingSamples.removeAll()
        capturedLevel = AudioLevel()
        capturing = true
    }

    func endCapture() {
        onQueue()
        if capturing, !pendingSamples.isEmpty {
            let padding = VoiceFrame.samplesPerFrame - pendingSamples.count
            pendingSamples.append(contentsOf: repeatElement(0, count: max(0, padding)))
            emitFrames()
        }
        if capturing, sequence > 0 { send(.captureLevel(capturedLevel, frames: Int(sequence))) }
        capturing = false
        pendingSamples.removeAll()
        capturedLevel = AudioLevel()
    }

    func captured(_ samples: [Float]) {
        onQueue()
        guard capturing else { return }
        // Measured before the padding and the encoder: what the microphone gave.
        capturedLevel.add(samples)
        pendingSamples.append(contentsOf: samples)
        emitFrames()
    }

    private func emitFrames() {
        let size = VoiceFrame.samplesPerFrame
        while pendingSamples.count >= size {
            let frame = Array(pendingSamples.prefix(size))
            pendingSamples.removeFirst(size)
            guard let payload = encoder.encode(frame) else { continue }
            if sequence == 0 { send(.firstCapturedFrame(Clock.nowMs())) }
            send(.frame(VoiceFrame.encode(codec: encoder.codec, seq: sequence, payload: payload)))
            sequence &+= 1
        }
    }

    #if targetEnvironment(simulator)
    /// The watch simulator has no microphone. While capturing, feed a 440 Hz tone in real
    /// time instead, so the send path (Opus encode, framing, relay) can still be exercised.
    private var toneTimer: DispatchSourceTimer?
    private var tonePhase: Float = 0

    func startTestTone() {
        onQueue()
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
            self.capturedLevel.add(samples)
            self.pendingSamples.append(contentsOf: samples)
            self.emitFrames()
        }
        timer.resume()
        toneTimer = timer
    }
    #endif

    // MARK: Playback

    func beginPlayback() {
        onQueue()
        decoder.reset()
        ledger.beginBurst()
        prebuffering = true
        reportedFirstPlayback = false
        playedLevel = AudioLevel()
        playedFrames = 0
    }

    func enqueue(_ frame: Data) {
        onQueue()
        guard let (codec, _, payload) = VoiceFrame.decode(frame),
              let buffer = decoder.decode(codec: codec, payload: payload) else { return }
        playedLevel.add(buffer)
        playedFrames += 1
        held.append(buffer)
        if prebuffering, held.count >= Self.prebufferFrames { prebuffering = false }
        if !prebuffering { flushHeld() }
    }

    func endPlayback() {
        onQueue()
        prebuffering = false
        flushHeld()
        if playedFrames > 0 { send(.playbackLevel(playedLevel, frames: playedFrames)) }
        playedLevel = AudioLevel()
        playedFrames = 0
    }

    private func flushHeld() {
        guard running, !held.isEmpty else { return }
        let now = Clock.nowMs()
        let generation = playerGeneration
        for buffer in held {
            let durationMs = Double(buffer.frameLength) / buffer.format.sampleRate * 1000
            expectedDrainAt = max(expectedDrainAt, now) + durationMs
            ledger.scheduled(buffer, durationMs: durationMs)
            player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                self?.async { $0.played(generation: generation) }
            }
        }
        held.removeAll()
        armDrainWatchdog()
        if !player.isPlaying { player.play() }
        if !reportedFirstPlayback {
            reportedFirstPlayback = true
            send(.firstPlayback(now))
        }
    }

    private func played(generation: Int) {
        onQueue()
        guard generation == playerGeneration, ledger.scheduledCount > 0 else { return }
        ledger.played()
        if ledger.scheduledCount == 0, held.isEmpty { send(.drained) }
    }

    /// If what was scheduled still hasn't been reported played a second after it should have
    /// finished, count it as played: a stalled player must not leave the app "listening"
    /// forever (run 57).
    private func armDrainWatchdog() {
        drainWatchdog?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self, self.ledger.scheduledCount > 0, Clock.nowMs() >= self.expectedDrainAt + 1_000 else { return }
            let stalled = self.ledger.abandonScheduled()
            let drained = self.held.isEmpty
            self.expectedDrainAt = 0
            self.send(.stalled(buffers: stalled, drained: drained))
        }
        drainWatchdog = item
        queue.asyncAfter(deadline: .now() + .milliseconds(Int(max(0, expectedDrainAt - Clock.nowMs())) + 1_000), execute: item)
    }
}
