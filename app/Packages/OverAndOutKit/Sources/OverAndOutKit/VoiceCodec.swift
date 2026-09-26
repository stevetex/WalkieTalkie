import AVFoundation

/// Audio frames on the wire. Must match server/src/protocol.ts.
///   byte 0      codec
///   bytes 1..4  sequence number within the burst (big-endian UInt32)
///   bytes 5..   one 20 ms packet
public enum VoiceFrame {
    public static let headerBytes = 5
    public static let sampleRate: Double = 16_000
    public static let samplesPerFrame = 320 // 20 ms at 16 kHz

    public enum Codec: UInt8 {
        case opus16k = 1
        case pcm16le16k = 2
    }

    public static let pcmFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false
    )!

    public static func encode(codec: Codec, seq: UInt32, payload: Data) -> Data {
        var data = Data(capacity: headerBytes + payload.count)
        data.append(codec.rawValue)
        withUnsafeBytes(of: seq.bigEndian) { data.append(contentsOf: $0) }
        data.append(payload)
        return data
    }

    public static func decode(_ data: Data) -> (codec: Codec, seq: UInt32, payload: Data)? {
        guard data.count > headerBytes, let codec = Codec(rawValue: data[data.startIndex]) else { return nil }
        let seq = data.subdata(in: data.startIndex + 1 ..< data.startIndex + 5).reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
        return (codec, seq, data.subdata(in: data.startIndex + headerBytes ..< data.endIndex))
    }
}

/// Encodes 20 ms frames of 16 kHz mono float samples. Uses the system Opus encoder,
/// falling back to raw PCM if this device can't create one.
public final class VoiceEncoder {
    public let codec: VoiceFrame.Codec
    private let opusFormat: AVAudioFormat?
    private let converter: AVAudioConverter?

    public init(preferOpus: Bool = true, bitRate: Int = 24_000) {
        if preferOpus, let format = Self.makeOpusFormat(),
           let converter = AVAudioConverter(from: VoiceFrame.pcmFormat, to: format) {
            converter.bitRate = bitRate
            self.opusFormat = format
            self.converter = converter
            self.codec = .opus16k
        } else {
            self.opusFormat = nil
            self.converter = nil
            self.codec = .pcm16le16k
        }
    }

    public static func makeOpusFormat() -> AVAudioFormat? {
        var description = AudioStreamBasicDescription(
            mSampleRate: VoiceFrame.sampleRate, mFormatID: kAudioFormatOpus, mFormatFlags: 0,
            mBytesPerPacket: 0, mFramesPerPacket: UInt32(VoiceFrame.samplesPerFrame), mBytesPerFrame: 0,
            mChannelsPerFrame: 1, mBitsPerChannel: 0, mReserved: 0
        )
        return AVAudioFormat(streamDescription: &description)
    }

    /// Call at the start of each burst; the receiver resets its decoder at the same point.
    public func reset() {
        converter?.reset()
    }

    /// `samples` must hold exactly one frame (320 samples).
    public func encode(_ samples: [Float]) -> Data? {
        switch codec {
        case .pcm16le16k:
            var data = Data(capacity: samples.count * 2)
            for sample in samples {
                let value = Int16(max(-1, min(1, sample)) * Float(Int16.max))
                withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) }
            }
            return data
        case .opus16k:
            guard let converter, let opusFormat,
                  let input = AVAudioPCMBuffer(pcmFormat: VoiceFrame.pcmFormat, frameCapacity: AVAudioFrameCount(samples.count))
            else { return nil }
            input.frameLength = AVAudioFrameCount(samples.count)
            samples.withUnsafeBufferPointer { input.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
            let output = AVAudioCompressedBuffer(
                format: opusFormat, packetCapacity: 1, maximumPacketSize: max(converter.maximumOutputPacketSize, 1)
            )
            var consumed = false
            var error: NSError?
            let status = converter.convert(to: output, error: &error) { _, inputStatus in
                if consumed {
                    inputStatus.pointee = .noDataNow
                    return nil
                }
                consumed = true
                inputStatus.pointee = .haveData
                return input
            }
            guard status != .error, output.packetCount > 0 else { return nil }
            return Data(bytes: output.data, count: Int(output.byteLength))
        }
    }
}

/// Decodes frames of either codec to 16 kHz mono float buffers.
public final class VoiceDecoder {
    public init() {}

    private let opusFormat = VoiceEncoder.makeOpusFormat()
    // Created once and reset per burst; it used to be rebuilt for every burst.
    private lazy var opusConverter: AVAudioConverter? = opusFormat.flatMap {
        AVAudioConverter(from: $0, to: VoiceFrame.pcmFormat)
    }

    /// Call at the start of each burst so Opus state from the previous speaker doesn't leak.
    public func reset() {
        opusConverter?.reset()
    }

    public func decode(codec: VoiceFrame.Codec, payload: Data) -> AVAudioPCMBuffer? {
        let capacity = AVAudioFrameCount(VoiceFrame.samplesPerFrame * 2)
        guard let output = AVAudioPCMBuffer(pcmFormat: VoiceFrame.pcmFormat, frameCapacity: capacity) else { return nil }
        switch codec {
        case .pcm16le16k:
            let count = payload.count / 2
            output.frameLength = AVAudioFrameCount(count)
            let channel = output.floatChannelData![0]
            payload.withUnsafeBytes { raw in
                for i in 0..<count {
                    let value = Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self))
                    channel[i] = Float(value) / Float(Int16.max)
                }
            }
            return output
        case .opus16k:
            guard let opusFormat else { return nil }
            guard let converter = opusConverter else { return nil }
            let input = AVAudioCompressedBuffer(format: opusFormat, packetCapacity: 1, maximumPacketSize: payload.count)
            payload.withUnsafeBytes { input.data.copyMemory(from: $0.baseAddress!, byteCount: payload.count) }
            input.byteLength = UInt32(payload.count)
            input.packetCount = 1
            input.packetDescriptions?[0] = AudioStreamPacketDescription(
                mStartOffset: 0, mVariableFramesInPacket: 0, mDataByteSize: UInt32(payload.count)
            )
            var consumed = false
            var error: NSError?
            let status = converter.convert(to: output, error: &error) { _, inputStatus in
                if consumed {
                    inputStatus.pointee = .noDataNow
                    return nil
                }
                consumed = true
                inputStatus.pointee = .haveData
                return input
            }
            return status == .error || output.frameLength == 0 ? nil : output
        }
    }
}
