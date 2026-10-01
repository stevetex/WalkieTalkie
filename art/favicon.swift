// The website's favicons from the transparent mascot master: cropped to the mascot, centered
// on a square with a little margin, and drawn at each size from the full-resolution art (not
// scaled down step by step), so the small sizes stay crisp.
//
//   swift art/favicon.swift [art/masters/mascot-color.png] [web/public]
//
// Writes favicon.ico (16, 32 and 48 px PNGs inside), img/favicon-32.png and img/favicon-192.png.

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
let source = URL(fileURLWithPath: args.count > 1 ? args[1] : "art/masters/mascot-color.png")
let output = URL(fileURLWithPath: args.count > 2 ? args[2] : "web/public")

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

guard let imageSource = CGImageSourceCreateWithURL(source as CFURL, nil),
      let master = CGImageSourceCreateImageAtIndex(imageSource, 0, nil) else { fail("Can't read \(source.path)") }

/// The smallest rectangle holding every pixel that isn't (nearly) transparent.
func opaqueBounds(_ image: CGImage) -> CGRect {
    let width = image.width, height = image.height
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    guard let context = CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fail("No bitmap context") }
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    var minX = width, minY = height, maxX = -1, maxY = -1
    for y in 0..<height {
        for x in 0..<width where pixels[(y * width + x) * 4 + 3] > 8 {
            minX = min(minX, x); maxX = max(maxX, x)
            minY = min(minY, y); maxY = max(maxY, y)
        }
    }
    guard maxX >= 0 else { fail("The image is empty") }
    // Rows counted from the top, as CGImage cropping expects.
    return CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)
}

/// The mascot, cropped and centered on a transparent square `size` pixels across.
func render(_ mascot: CGImage, size: Int, margin: Double) -> CGImage {
    guard let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fail("No bitmap context") }
    context.interpolationQuality = .high
    let inner = Double(size) * (1 - 2 * margin)
    let scale = inner / Double(max(mascot.width, mascot.height))
    let w = Double(mascot.width) * scale, h = Double(mascot.height) * scale
    context.draw(mascot, in: CGRect(x: (Double(size) - w) / 2, y: (Double(size) - h) / 2, width: w, height: h))
    return context.makeImage()!
}

func png(_ image: CGImage) -> Data {
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { fail("No PNG encoder") }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { fail("PNG encoding failed") }
    return data as Data
}

/// An .ico holding PNG images (supported by every current browser), smallest first.
func ico(_ images: [(size: Int, png: Data)]) -> Data {
    var data = Data()
    func le16(_ v: Int) { data.append(contentsOf: [UInt8(v & 0xff), UInt8(v >> 8 & 0xff)]) }
    func le32(_ v: Int) { le16(v & 0xffff); le16(v >> 16 & 0xffff) }
    le16(0); le16(1); le16(images.count)
    var offset = 6 + 16 * images.count
    for image in images {
        data.append(UInt8(image.size % 256)); data.append(UInt8(image.size % 256))
        data.append(0); data.append(0)
        le16(1); le16(32)
        le32(image.png.count); le32(offset)
        offset += image.png.count
    }
    for image in images { data.append(image.png) }
    return data
}

guard let mascot = master.cropping(to: opaqueBounds(master)) else { fail("Crop failed") }
// A thin margin at tab sizes, where every pixel counts; more room for the large ones.
let small = [16, 32, 48].map { (size: $0, png: png(render(mascot, size: $0, margin: 0.02))) }
try ico(small).write(to: output.appendingPathComponent("favicon.ico"))
try small[1].png.write(to: output.appendingPathComponent("img/favicon-32.png"))
try png(render(mascot, size: 192, margin: 0.06)).write(to: output.appendingPathComponent("img/favicon-192.png"))
print("Wrote favicon.ico, img/favicon-32.png and img/favicon-192.png to \(output.path)")
