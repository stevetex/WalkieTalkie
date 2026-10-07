// Encodes 16 kHz mono PCM16 (little-endian, raw) into 20 ms Opus packets with the system's
// encoder, the same settings as the apps (OverAndOutKit's VoiceEncoder: 24 kbps), so the
// Test Bot sends what a watch sends. bot.ts runs it; it needs macOS.
//
//   swift tools/opus-frames.swift <in.pcm> <out.packets>
//
// The output is each packet as [length: UInt16 big-endian][packet].

import AVFoundation

let arguments = CommandLine.arguments
guard arguments.count == 3 else {
    FileHandle.standardError.write("usage: swift opus-frames.swift <in.pcm> <out.packets>\n".data(using: .utf8)!)
    exit(2)
}
let pcm = try Data(contentsOf: URL(fileURLWithPath: arguments[1]))
let sampleRate = 16_000.0
let samplesPerFrame = 320

let pcmFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)!
var description = AudioStreamBasicDescription(
    mSampleRate: sampleRate, mFormatID: kAudioFormatOpus, mFormatFlags: 0,
    mBytesPerPacket: 0, mFramesPerPacket: UInt32(samplesPerFrame), mBytesPerFrame: 0,
    mChannelsPerFrame: 1, mBitsPerChannel: 0, mReserved: 0
)
guard let opusFormat = AVAudioFormat(streamDescription: &description),
      let converter = AVAudioConverter(from: pcmFormat, to: opusFormat) else {
    FileHandle.standardError.write("This Mac has no Opus encoder\n".data(using: .utf8)!)
    exit(1)
}
converter.bitRate = 24_000
// Constant bitrate, as the apps encode (VoiceEncoder): every packet 60 bytes.
converter.bitRateStrategy = AVAudioBitRateStrategy_Constant

let samples: [Float] = pcm.withUnsafeBytes { raw in
    let values = raw.bindMemory(to: Int16.self)
    return values.map { Float(Int16(littleEndian: $0)) / Float(Int16.max) }
}

var output = Data()
var frameStart = 0
while frameStart < samples.count {
    // The last frame is padded with silence, as the apps do.
    var frame = Array(samples[frameStart ..< min(frameStart + samplesPerFrame, samples.count)])
    frame += Array(repeating: 0, count: samplesPerFrame - frame.count)
    frameStart += samplesPerFrame

    let input = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: AVAudioFrameCount(samplesPerFrame))!
    input.frameLength = AVAudioFrameCount(samplesPerFrame)
    frame.withUnsafeBufferPointer { input.floatChannelData![0].update(from: $0.baseAddress!, count: samplesPerFrame) }
    let packet = AVAudioCompressedBuffer(format: opusFormat, packetCapacity: 1,
                                         maximumPacketSize: max(converter.maximumOutputPacketSize, 1))
    var consumed = false
    var error: NSError?
    let status = converter.convert(to: packet, error: &error) { _, inputStatus in
        if consumed {
            inputStatus.pointee = .noDataNow
            return nil
        }
        consumed = true
        inputStatus.pointee = .haveData
        return input
    }
    guard status != .error, packet.packetCount > 0 else { continue }
    let bytes = Data(bytes: packet.data, count: Int(packet.byteLength))
    withUnsafeBytes(of: UInt16(bytes.count).bigEndian) { output.append(contentsOf: $0) }
    output.append(bytes)
}
try output.write(to: URL(fileURLWithPath: arguments[2]))
