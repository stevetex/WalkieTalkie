// Usage: swiftc -O art/upscale-art.swift -o upscale && ./upscale <in.png> <out.png> <x> <y> <w> <h> <factor>
// Crops the input, then upscales it with MetalFX's spatial scaler. The scaler only keeps
// colour, so the alpha channel is upscaled in a second pass and the two are recombined.
import AppKit
import CoreImage
import Metal
import MetalFX

let a = CommandLine.arguments
let (input, output) = (a[1], a[2])
let crop = CGRect(x: Double(a[3])!, y: Double(a[4])!, width: Double(a[5])!, height: Double(a[6])!)
let factor = Int(a[7])!

guard let src = NSImage(contentsOfFile: input)?.cgImage(forProposedRect: nil, context: nil, hints: nil),
      let cropped = src.cropping(to: crop) else { fatalError("can't read \(input)") }
let device = MTLCreateSystemDefaultDevice()!
let queue = device.makeCommandQueue()!
let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!
let ci = CIContext(mtlDevice: device, options: [.workingColorSpace: sRGB])
let w = cropped.width, h = cropped.height, W = w * factor, H = h * factor

func texture(_ width: Int, _ height: Int, _ usage: MTLTextureUsage, _ storage: MTLStorageMode = .shared) -> MTLTexture {
    let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba16Float, width: width, height: height, mipmapped: false)
    d.usage = usage
    d.storageMode = storage
    return device.makeTexture(descriptor: d)!
}

/// RGBA8 pixels of `image` upscaled by MetalFX.
func upscale(_ image: CIImage) -> [UInt8] {
    let inTex = texture(w, h, [.shaderRead, .shaderWrite])
    ci.render(image, to: inTex, commandBuffer: nil, bounds: CGRect(x: 0, y: 0, width: w, height: h), colorSpace: sRGB)
    let outTex = texture(W, H, [.renderTarget, .shaderRead], .private)
    let sd = MTLFXSpatialScalerDescriptor()
    sd.inputWidth = w; sd.inputHeight = h; sd.outputWidth = W; sd.outputHeight = H
    sd.colorTextureFormat = .rgba16Float; sd.outputTextureFormat = .rgba16Float
    sd.colorProcessingMode = .perceptual
    guard let scaler = sd.makeSpatialScaler(device: device) else { fatalError("MetalFX spatial scaler unavailable") }
    scaler.colorTexture = inTex
    scaler.outputTexture = outTex
    let cb = queue.makeCommandBuffer()!
    scaler.encode(commandBuffer: cb)
    cb.commit(); cb.waitUntilCompleted()
    var pixels = [UInt8](repeating: 0, count: W * H * 4)
    let result = CIImage(mtlTexture: outTex, options: [.colorSpace: sRGB])!
    ci.render(result, toBitmap: &pixels, rowBytes: W * 4, bounds: CGRect(x: 0, y: 0, width: W, height: H), format: .RGBA8, colorSpace: sRGB)
    return pixels
}

let source = CIImage(cgImage: cropped)
// Colour over opaque black (premultiplied), and alpha as grey.
let color = upscale(source.composited(over: CIImage(color: .black).cropped(to: source.extent)))
let alphaAsGrey = source.applyingFilter("CIColorMatrix", parameters: [
    "inputRVector": CIVector(x: 0, y: 0, z: 0, w: 1), "inputGVector": CIVector(x: 0, y: 0, z: 0, w: 1),
    "inputBVector": CIVector(x: 0, y: 0, z: 0, w: 1), "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 0),
    "inputBiasVector": CIVector(x: 0, y: 0, z: 0, w: 1),
])
let alpha = upscale(alphaAsGrey)

// Straight (unpremultiplied) RGBA.
var out = [UInt8](repeating: 0, count: W * H * 4)
for i in stride(from: 0, to: out.count, by: 4) {
    let al = Int(alpha[i])
    out[i + 3] = UInt8(al)
    guard al > 0 else { continue }
    for c in 0..<3 { out[i + c] = UInt8(min(255, Int(color[i + c]) * 255 / al)) }
}
let provider = CGDataProvider(data: Data(out) as CFData)!
let cg = CGImage(width: W, height: H, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: W * 4, space: sRGB,
                 bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue), provider: provider,
                 decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
try! NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
print("wrote \(output) \(W)x\(H)")
