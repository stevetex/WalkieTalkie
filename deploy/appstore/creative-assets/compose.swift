// Creates draft App Store creative assets from the approved Over&Out artwork and
// current product screenshots. Run from this directory with: swift compose.swift
import AppKit
import ImageIO

let indigo = NSColor(srgbRed: 39 / 255, green: 45 / 255, blue: 80 / 255, alpha: 1)
let deepIndigo = NSColor(srgbRed: 24 / 255, green: 28 / 255, blue: 54 / 255, alpha: 1)
let ivory = NSColor(srgbRed: 255 / 255, green: 246 / 255, blue: 223 / 255, alpha: 1)
let silver = NSColor(srgbRed: 190 / 255, green: 213 / 255, blue: 223 / 255, alpha: 1)
let ink = NSColor(srgbRed: 16 / 255, green: 22 / 255, blue: 27 / 255, alpha: 1)

let headerSize = CGSize(width: 3840, height: 1646)
let searchSize = CGSize(width: 3840, height: 2560)

func rounded(_ size: CGFloat, _ weight: NSFont.Weight) -> NSFont {
    let base = NSFont.systemFont(ofSize: size, weight: weight)
    guard let descriptor = base.fontDescriptor.withDesign(.rounded) else { return base }
    return NSFont(descriptor: descriptor, size: size) ?? base
}

func load(_ path: String) -> NSImage {
    guard let image = NSImage(contentsOfFile: path) else { fatalError("Could not load \(path)") }
    return image
}

func render(_ size: CGSize, to path: String, _ draw: () -> Void) {
    // App Store creative images cannot contain transparency.
    let context = CGContext(
        data: nil,
        width: Int(size.width),
        height: Int(size.height),
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    )!
    context.translateBy(x: 0, y: size.height)
    context.scaleBy(x: 1, y: -1)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: true)
    draw()
    NSGraphicsContext.restoreGraphicsState()

    let url = URL(fileURLWithPath: path) as CFURL
    let destination = CGImageDestinationCreateWithURL(url, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, context.makeImage()!, nil)
    CGImageDestinationFinalize(destination)
    print(path)
}

func background(_ size: CGSize) {
    NSGradient(starting: indigo, ending: deepIndigo)!
        .draw(in: CGRect(origin: .zero, size: size), angle: 90)
}

func drawFlipped(_ image: NSImage, in rect: CGRect, fraction: CGFloat = 1) {
    image.draw(
        in: rect,
        from: .zero,
        operation: .sourceOver,
        fraction: fraction,
        respectFlipped: true,
        hints: [.interpolation: NSImageInterpolation.high]
    )
}

func aspectFit(_ image: NSImage, inside rect: CGRect) -> CGRect {
    let scale = min(rect.width / image.size.width, rect.height / image.size.height)
    let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
    return CGRect(
        x: rect.midX - size.width / 2,
        y: rect.midY - size.height / 2,
        width: size.width,
        height: size.height
    )
}

func phone(_ image: NSImage, width: CGFloat, origin: CGPoint) {
    let screenSize = CGSize(width: width, height: width * image.size.height / image.size.width)
    let bezel = width * 0.028
    let outer = CGRect(
        x: origin.x,
        y: origin.y,
        width: screenSize.width + bezel * 2,
        height: screenSize.height + bezel * 2
    )
    let radius = width * 0.145

    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.45)
    shadow.shadowBlurRadius = 80
    shadow.shadowOffset = NSSize(width: 0, height: 34)
    shadow.set()
    ink.setFill()
    NSBezierPath(roundedRect: outer, xRadius: radius + bezel, yRadius: radius + bezel).fill()
    NSGraphicsContext.restoreGraphicsState()

    let screen = outer.insetBy(dx: bezel, dy: bezel)
    NSGraphicsContext.saveGraphicsState()
    NSBezierPath(roundedRect: screen, xRadius: radius, yRadius: radius).addClip()
    drawFlipped(image, in: screen)
    NSGraphicsContext.restoreGraphicsState()
}

func watch(_ image: NSImage, width: CGFloat, origin: CGPoint) {
    let screenSize = CGSize(width: width, height: width * image.size.height / image.size.width)
    let bezel = width * 0.07
    let outer = CGRect(
        x: origin.x,
        y: origin.y,
        width: screenSize.width + bezel * 2,
        height: screenSize.height + bezel * 2
    )
    let radius = width * 0.24

    let band = CGRect(
        x: outer.minX + outer.width * 0.14,
        y: outer.minY - width * 0.55,
        width: outer.width * 0.72,
        height: outer.height + width * 1.1
    )
    NSColor(srgbRed: 30 / 255, green: 33 / 255, blue: 44 / 255, alpha: 1).setFill()
    NSBezierPath(roundedRect: band, xRadius: width * 0.09, yRadius: width * 0.09).fill()

    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.52)
    shadow.shadowBlurRadius = 70
    shadow.shadowOffset = NSSize(width: 0, height: 28)
    shadow.set()

    NSColor(srgbRed: 120 / 255, green: 128 / 255, blue: 140 / 255, alpha: 1).setFill()
    let crown = CGRect(
        x: outer.maxX - width * 0.02,
        y: outer.minY + outer.height * 0.2,
        width: width * 0.07,
        height: outer.height * 0.16
    )
    NSBezierPath(roundedRect: crown, xRadius: width * 0.02, yRadius: width * 0.02).fill()
    let button = CGRect(
        x: outer.maxX - width * 0.015,
        y: outer.minY + outer.height * 0.48,
        width: width * 0.04,
        height: outer.height * 0.22
    )
    NSBezierPath(roundedRect: button, xRadius: width * 0.015, yRadius: width * 0.015).fill()

    NSColor(srgbRed: 34 / 255, green: 36 / 255, blue: 42 / 255, alpha: 1).setFill()
    NSBezierPath(roundedRect: outer, xRadius: radius + bezel, yRadius: radius + bezel).fill()
    NSGraphicsContext.restoreGraphicsState()

    let screen = outer.insetBy(dx: bezel, dy: bezel)
    NSGraphicsContext.saveGraphicsState()
    NSBezierPath(roundedRect: screen, xRadius: radius, yRadius: radius).addClip()
    drawFlipped(image, in: screen)
    NSGraphicsContext.restoreGraphicsState()
}

func drawSearchHeadline() {
    let style = NSMutableParagraphStyle()
    style.alignment = .left
    style.lineSpacing = 10

    let title = NSAttributedString(
        string: "Walkie-talkie for\niPhone +\nApple Watch",
        attributes: [
            .font: rounded(152, .heavy),
            .foregroundColor: ivory,
            .paragraphStyle: style
        ]
    )
    title.draw(
        with: CGRect(x: 190, y: 735, width: 1420, height: 650),
        options: [.usesLineFragmentOrigin]
    )

    let subtitle = NSAttributedString(
        string: "Hold to talk. Hear them right away.",
        attributes: [
            .font: rounded(66, .medium),
            .foregroundColor: silver,
            .paragraphStyle: style
        ]
    )
    subtitle.draw(
        with: CGRect(x: 200, y: 1460, width: 1290, height: 200),
        options: [.usesLineFragmentOrigin]
    )
}

try? FileManager.default.createDirectory(atPath: "out", withIntermediateDirectories: true)

let mascot = load("../../../art/masters/mascot-color.png")
let phoneTalking = load("../screenshots/raw/phone-talking.png")
let watchListening = load("../screenshots/out/watch-4-listening.png")

// Product page header: one unmistakable brand idea with the focal point kept central.
render(headerSize, to: "out/product-page-header.png") {
    background(headerSize)

    // Quiet radio-wave rings add depth without competing with the mascot.
    for (diameter, alpha, lineWidth) in [(1500.0, 0.12, 18.0), (1900.0, 0.08, 15.0), (2320.0, 0.05, 12.0)] {
        NSColor(srgbRed: 190 / 255, green: 213 / 255, blue: 223 / 255, alpha: alpha).setStroke()
        let ring = CGRect(
            x: headerSize.width / 2 - diameter / 2,
            y: headerSize.height / 2 - diameter / 2,
            width: diameter,
            height: diameter
        )
        let path = NSBezierPath(ovalIn: ring)
        path.lineWidth = lineWidth
        path.stroke()
    }

    let mascotRect = aspectFit(
        mascot,
        inside: CGRect(x: 1230, y: 108, width: 1380, height: 1430)
    )
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.45)
    shadow.shadowBlurRadius = 85
    shadow.shadowOffset = NSSize(width: 0, height: 30)
    shadow.set()
    drawFlipped(mascot, in: mascotRect)
    NSGraphicsContext.restoreGraphicsState()
}

// Search results: purpose, supported devices and real product experience at a glance.
render(searchSize, to: "out/search-results.png") {
    background(searchSize)
    drawSearchHeadline()

    phone(phoneTalking, width: 1110, origin: CGPoint(x: 1585, y: 65))
    watch(watchListening, width: 790, origin: CGPoint(x: 2770, y: 1160))
}
