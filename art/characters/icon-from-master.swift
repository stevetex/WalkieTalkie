// A character's square icon source (icons/icon-1024.png) composited from its transparent master:
// the master is scaled down (high-quality resampling, never up) so its visible artwork is
// <height> px tall, its top edge sits <top> px from the top, and it is centred horizontally
// (then moved <dx> px, negative = left), on opaque brand indigo #272D50. Prints the result's
// content box and the largest radius of any foreground pixel from the centre, the same
// check as pixel-validation.json (25-channel-value threshold against the background).
//
//   swift art/characters/icon-from-master.swift <master.png> <icon-1024.png> <height> <top> [dx]
//
// Used for 11-fox and 15-morticia (see GENERATION.md); the other characters' icons are
// image-generation adaptations. The exports and app avatars are then made with sips.

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}
guard args.count >= 5, let height = Double(args[3]), let top = Double(args[4]) else {
    fail("usage: icon-from-master.swift <master.png> <icon-1024.png> <height> <top> [dx]")
}
let dx = args.count > 5 ? Double(args[5]) ?? 0 : 0
let side = 1024
let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!
let indigo: (UInt8, UInt8, UInt8) = (0x27, 0x2D, 0x50)

guard let imageSource = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil),
      let master = CGImageSourceCreateImageAtIndex(imageSource, 0, nil) else { fail("Can't read \(args[1])") }

/// RGBA8 (premultiplied) pixels of `image`.
func pixels(_ image: CGImage) -> [UInt8] {
    let w = image.width, h = image.height
    var buffer = [UInt8](repeating: 0, count: w * h * 4)
    guard let context = CGContext(data: &buffer, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                  space: sRGB, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { fail("Can't make a bitmap context") }
    context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    return buffer
}

/// Bounding box (top-left origin) of the pixels `isOn` accepts.
func bounds(_ p: [UInt8], _ w: Int, _ h: Int, _ isOn: (Int) -> Bool) -> (minX: Int, minY: Int, maxX: Int, maxY: Int) {
    var minX = w, minY = h, maxX = -1, maxY = -1
    for y in 0..<h {
        for x in 0..<w where isOn((y * w + x) * 4) {
            minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
        }
    }
    return (minX, minY, maxX, maxY)
}

// The master's visible artwork (alpha above 25 of 255).
let mp = pixels(master)
let art = bounds(mp, master.width, master.height) { mp[$0 + 3] > 25 }
let artW = Double(art.maxX - art.minX + 1), artH = Double(art.maxY - art.minY + 1)
let scale = height / artH
if scale > 1 { fail("Refusing to enlarge the master (scale \(scale))") }

// Place it: CoreGraphics' origin is bottom-left, so flip the top margin.
let left = (Double(side) - artW * scale) / 2 + dx
let drawX = left - Double(art.minX) * scale
let drawTop = top - Double(art.minY) * scale
let drawW = Double(master.width) * scale, drawH = Double(master.height) * scale
let drawY = Double(side) - drawTop - drawH

guard let context = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
                              space: sRGB, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
else { fail("Can't make the icon context") }
context.setFillColor(CGColor(srgbRed: CGFloat(indigo.0) / 255, green: CGFloat(indigo.1) / 255,
                             blue: CGFloat(indigo.2) / 255, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: side, height: side))
context.interpolationQuality = .high
context.draw(master, in: CGRect(x: drawX, y: drawY, width: drawW, height: drawH))
guard let icon = context.makeImage() else { fail("Can't render the icon") }

let output = URL(fileURLWithPath: args[2])
guard let destination = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil)
else { fail("Can't write \(output.path)") }
CGImageDestinationAddImage(destination, icon, nil)
guard CGImageDestinationFinalize(destination) else { fail("Can't write \(output.path)") }

// Report what was drawn.
let ip = pixels(icon)
func isForeground(_ i: Int) -> Bool {
    abs(Int(ip[i]) - Int(indigo.0)) > 25 || abs(Int(ip[i + 1]) - Int(indigo.1)) > 25 || abs(Int(ip[i + 2]) - Int(indigo.2)) > 25
}
let box = bounds(ip, side, side, isForeground)
var radius = 0.0
for y in 0..<side {
    for x in 0..<side where isForeground((y * side + x) * 4) {
        radius = max(radius, ((Double(x) + 0.5 - 512) * (Double(x) + 0.5 - 512) + (Double(y) + 0.5 - 512) * (Double(y) + 0.5 - 512)).squareRoot())
    }
}
print("""
    wrote \(output.path): scale \(String(format: "%.4f", scale)), content \(box.maxX - box.minX + 1)×\(box.maxY - box.minY + 1) \
    at x \(box.minX)–\(box.maxX), y \(box.minY)–\(box.maxY); max foreground radius \(String(format: "%.2f", radius)) px
    """)
