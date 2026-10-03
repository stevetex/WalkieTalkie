import AVFoundation

/// How loud a stretch of audio is: RMS and peak in dBFS, and how many samples reached full
/// scale. The pipeline measures each burst it sends (before encoding) and plays (after
/// decoding) for Beta telemetry, as numbers only; the kit's tests measure the codec with it.
public struct AudioLevel: Sendable, Equatable {
    public private(set) var samples = 0
    public private(set) var peak: Float = 0
    /// Samples at (or within a hair of) full scale.
    public private(set) var clipped = 0
    private var sumOfSquares: Double = 0

    /// Silence has no level in dB; it's reported as this.
    public static let floorDbfs: Double = -120

    public init() {}

    public init<C: Collection>(_ values: C) where C.Element == Float {
        add(values)
    }

    public mutating func add<C: Collection>(_ values: C) where C.Element == Float {
        for value in values {
            let magnitude = abs(value)
            sumOfSquares += Double(value) * Double(value)
            if magnitude > peak { peak = magnitude }
            if magnitude >= 0.999 { clipped += 1 }
        }
        samples += values.count
    }

    public mutating func add(_ buffer: AVAudioPCMBuffer) {
        guard let channel = buffer.floatChannelData?[0] else { return }
        add(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
    }

    public var isEmpty: Bool { samples == 0 }

    public var rms: Double { samples == 0 ? 0 : (sumOfSquares / Double(samples)).squareRoot() }

    public var rmsDbfs: Double { Self.dbfs(rms) }

    public var peakDbfs: Double { Self.dbfs(Double(peak)) }

    public static func dbfs(_ amplitude: Double) -> Double {
        amplitude > 0 ? max(floorDbfs, 20 * log10(amplitude)) : floorDbfs
    }

    /// For a timeline mark: "rms=-23.4,peak=-6.1,frames=150,clipped=0". The server parses it
    /// (server/src/telemetry.ts, parseLevel).
    public func detail(frames: Int) -> String {
        "rms=\(Self.oneDecimal(rmsDbfs)),peak=\(Self.oneDecimal(peakDbfs)),frames=\(frames),clipped=\(clipped)"
    }

    private static func oneDecimal(_ value: Double) -> String {
        String(format: "%.1f", value)
    }
}

#if os(iOS) || os(watchOS)
extension AudioLevel {
    /// The microphone's kind ("MicrophoneBuiltIn", "BluetoothHFP"), never a device's name.
    public static func inputPort() -> String {
        AVAudioSession.sharedInstance().currentRoute.inputs.first?.portType.rawValue ?? "none"
    }

    /// The speaker's kind ("Speaker", "BluetoothA2DPOutput"), never a device's name.
    public static func outputPort() -> String {
        AVAudioSession.sharedInstance().currentRoute.outputs.first?.portType.rawValue ?? "none"
    }

    /// The microphone's permission and the session's input, for diagnosing silent capture:
    /// "permission=granted,inputAvailable=1,in=MicrophoneBuiltIn,channels=1,rate=48000,mode=VoiceChat".
    public static func microphoneSetup() -> String {
        let session = AVAudioSession.sharedInstance()
        let permission: String
        switch AVAudioApplication.shared.recordPermission {
        case .granted: permission = "granted"
        case .denied: permission = "denied"
        default: permission = "undetermined"
        }
        let mode = session.mode.rawValue.replacingOccurrences(of: "AVAudioSessionMode", with: "")
        return "permission=\(permission),inputAvailable=\(session.isInputAvailable ? 1 : 0),in=\(inputPort())"
            + ",channels=\(session.inputNumberOfChannels),rate=\(Int(session.sampleRate)),mode=\(mode)"
    }
}
#endif
