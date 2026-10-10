// Frames the raw simulator captures in raw/ as App Store screenshots in out/: the iPhone set
// at 6.9" (1320 × 2868) on the brand indigo with a headline, and the watch set as is (they're
// already the 46mm size, 416 × 496). Run from this directory: swift compose.swift
import AppKit

let indigo = NSColor(srgbRed: 39 / 255, green: 45 / 255, blue: 80 / 255, alpha: 1)
let deepIndigo = NSColor(srgbRed: 24 / 255, green: 28 / 255, blue: 54 / 255, alpha: 1)
let ivory = NSColor(srgbRed: 255 / 255, green: 246 / 255, blue: 223 / 255, alpha: 1)
let silver = NSColor(srgbRed: 190 / 255, green: 213 / 255, blue: 223 / 255, alpha: 1)
let orange = NSColor(srgbRed: 255 / 255, green: 139 / 255, blue: 26 / 255, alpha: 1)
let ink = NSColor(srgbRed: 16 / 255, green: 22 / 255, blue: 27 / 255, alpha: 1)

let canvas = CGSize(width: 1320, height: 2868)

func rounded(_ size: CGFloat, _ weight: NSFont.Weight) -> NSFont {
    let base = NSFont.systemFont(ofSize: size, weight: weight)
    guard let descriptor = base.fontDescriptor.withDesign(.rounded) else { return base }
    return NSFont(descriptor: descriptor, size: size) ?? base
}

func load(_ name: String) -> NSImage {
    guard let image = NSImage(contentsOfFile: "raw/\(name).png") else { fatalError("no raw/\(name).png") }
    return image
}

/// The watch simulator's clock can't be overridden, so paint 9:41 over it to match the iPhone:
/// the time (x from `clockMinX` to `clockMaxX`, y 40–62) is covered with the background beside
/// it and the new time drawn in the same place and size.
func watchCapture(_ name: String, clockMinX: CGFloat, clockMaxX: CGFloat, centered: Bool) -> NSImage {
    let rep = NSBitmapImageRep(data: try! Data(contentsOf: URL(fileURLWithPath: "raw/\(name).png")))!
    let size = CGSize(width: 416, height: 496)
    let image = NSImage(size: size)
    image.lockFocusFlipped(true)
    NSGraphicsContext.current?.imageInterpolation = .none
    load(name).draw(in: CGRect(origin: .zero, size: size), from: .zero, operation: .copy, fraction: 1, respectFlipped: true, hints: nil)
    // Background pixels from the same rows, just beside the time (left of a centered time, right
    // of one at the left edge), so the patch matches exactly.
    let patch = CGRect(x: clockMinX - 3, y: 36, width: clockMaxX - clockMinX + 6, height: 31)
    let sourceX = centered ? patch.minX - patch.width - 1 : patch.maxX + 1
    let strip = rep.cgImage!.cropping(to: CGRect(x: sourceX, y: patch.minY, width: patch.width, height: patch.height))!
    NSImage(cgImage: strip, size: patch.size).draw(in: patch, from: .zero, operation: .copy, fraction: 1, respectFlipped: true, hints: nil)
    let style = NSMutableParagraphStyle()
    style.alignment = centered ? .center : .left
    let text = NSAttributedString(string: "9:41", attributes: [.font: rounded(31.5, .semibold), .foregroundColor: NSColor.white, .paragraphStyle: style])
    let box = centered ? CGRect(x: clockMinX - 40, y: 31, width: clockMaxX - clockMinX + 80, height: 40) : CGRect(x: clockMinX - 1, y: 31, width: 120, height: 40)
    text.draw(with: box, options: [.usesLineFragmentOrigin])
    image.unlockFocus()
    return image
}

/// The Lock Screen's PushToTalk UI from Steve's iPhone (raw/phone-locked.png, 921 × 2000) shows
/// the Test Bot and the real time. Paint Jess (her name and mascot) over the Test Bot, 9:41 over
/// the time, and remove the Silent Mode bell, each over background copied from the same rows.
func lockScreenShot() -> NSImage {
    let name = "phone-locked"
    let rep = NSBitmapImageRep(data: try! Data(contentsOf: URL(fileURLWithPath: "raw/\(name).png")))!
    let source = rep.cgImage!
    let size = CGSize(width: rep.pixelsWide, height: rep.pixelsHigh)
    func copy(_ from: CGRect, to: CGRect) {
        NSImage(cgImage: source.cropping(to: from)!, size: from.size).draw(in: to, from: .zero, operation: .copy, fraction: 1, respectFlipped: true, hints: nil)
    }
    func cover(_ rect: CGRect, fromX: CGFloat) {
        copy(CGRect(x: fromX, y: rect.minY, width: rect.width, height: rect.height), to: rect)
    }
    /// Text whose capitals run from `capTop` down `capHeight` pixels, starting at `x`.
    func text(_ string: String, x: CGFloat, capTop: CGFloat, capHeight: CGFloat) {
        let unit = NSFont.systemFont(ofSize: 100, weight: .semibold)
        let font = NSFont.systemFont(ofSize: 100 * capHeight / unit.capHeight, weight: .semibold)
        NSAttributedString(string: string, attributes: [.font: font, .foregroundColor: NSColor.white])
            .draw(with: CGRect(x: x, y: capTop - (font.ascender - font.capHeight), width: 600, height: font.ascender - font.descender), options: [.usesLineFragmentOrigin])
    }
    let image = NSImage(size: size)
    image.lockFocusFlipped(true)
    NSGraphicsContext.current?.imageInterpolation = .high
    copy(CGRect(origin: .zero, size: size), to: CGRect(origin: .zero, size: size))

    // The time and the bell (x 105–243, y 52–83).
    cover(CGRect(x: 98, y: 46, width: 154, height: 44), fromX: 320)
    text("9:41", x: 105, capTop: 55, capHeight: 26)

    // The name (x 211–494, y 328–384).
    cover(CGRect(x: 204, y: 318, width: 300, height: 76), fromX: 560)
    text("Jess", x: 211, capTop: 328, capHeight: 56)

    // The picture: a circle centred at (121, 388), with the app's badge at x 140–183, y 408–451.
    let avatar = CGRect(x: 121 - 66, y: 388 - 66, width: 132, height: 132)
    let badge = CGRect(x: 140, y: 408, width: 43, height: 44)
    cover(avatar.insetBy(dx: -4, dy: -4), fromX: 600)
    NSGraphicsContext.saveGraphicsState()
    NSBezierPath(ovalIn: avatar.insetBy(dx: 2, dy: 2)).addClip()
    NSImage(contentsOfFile: "../../../app/iOS/Assets.xcassets/Mascots/MascotCoolCat.imageset/MascotCoolCat.png")!
        .draw(in: avatar.insetBy(dx: 2, dy: 2), from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    NSGraphicsContext.restoreGraphicsState()
    NSGraphicsContext.saveGraphicsState()
    NSBezierPath(roundedRect: badge, xRadius: 10, yRadius: 10).addClip()
    copy(badge, to: badge)
    NSGraphicsContext.restoreGraphicsState()

    image.unlockFocus()
    return image
}

func watchShot(_ name: String) -> NSImage {
    switch name {
    case "watch-talking", "watch-listening": return watchCapture(name, clockMinX: 175, clockMaxX: 240, centered: true)
    default: return watchCapture(name, clockMinX: 33, clockMaxX: 99, centered: false)
    }
}

/// Draws into a bitmap of exactly `size` pixels, with a flipped (top-left origin) context.
func render(_ size: CGSize, to path: String, _ draw: () -> Void) {
    // No alpha channel: App Store Connect rejects screenshots that have one.
    let cg = CGContext(data: nil, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8, bytesPerRow: 0,
                       space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    cg.translateBy(x: 0, y: size.height)
    cg.scaleBy(x: 1, y: -1)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)
    draw()
    NSGraphicsContext.restoreGraphicsState()
    let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, cg.makeImage()!, nil)
    CGImageDestinationFinalize(destination)
    print(path)
}

func background() {
    NSGradient(starting: indigo, ending: deepIndigo)!
        .draw(in: CGRect(origin: .zero, size: canvas), angle: 90) // flipped: indigo at the top
}

func drawFlipped(_ image: NSImage, in rect: CGRect) {
    image.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: [.interpolation: NSImageInterpolation.high])
}

func headline(_ title: String, _ subtitle: String?, size: CGFloat = 112) {
    let style = NSMutableParagraphStyle()
    style.alignment = .center
    style.lineSpacing = 4
    let titleAttributes: [NSAttributedString.Key: Any] = [.font: rounded(size, .heavy), .foregroundColor: ivory, .paragraphStyle: style]
    let box = CGRect(x: 90, y: 170, width: canvas.width - 180, height: 420)
    let text = NSAttributedString(string: title, attributes: titleAttributes)
    let height = text.boundingRect(with: box.size, options: [.usesLineFragmentOrigin]).height
    text.draw(with: CGRect(x: box.minX, y: box.minY, width: box.width, height: height), options: [.usesLineFragmentOrigin])
    if let subtitle {
        let subAttributes: [NSAttributedString.Key: Any] = [.font: rounded(54, .medium), .foregroundColor: silver, .paragraphStyle: style]
        NSAttributedString(string: subtitle, attributes: subAttributes)
            .draw(with: CGRect(x: box.minX, y: box.minY + height + 28, width: box.width, height: 140), options: [.usesLineFragmentOrigin])
    }
}

/// An iPhone: the capture inside a dark bezel with the display's rounded corners.
func phone(_ image: NSImage, width: CGFloat, origin: CGPoint) {
    let screenSize = CGSize(width: width, height: width * canvas.height / canvas.width)
    let bezel = width * 0.028
    let outer = CGRect(x: origin.x, y: origin.y, width: screenSize.width + bezel * 2, height: screenSize.height + bezel * 2)
    let radius = width * 0.145
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.45)
    shadow.shadowBlurRadius = 60
    shadow.shadowOffset = NSSize(width: 0, height: 24)
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

/// An Apple Watch: the capture in a rounded case with a crown and side button.
func watch(_ image: NSImage, width: CGFloat, origin: CGPoint) {
    let screenSize = CGSize(width: width, height: width * 496 / 416)
    let bezel = width * 0.07
    let outer = CGRect(x: origin.x, y: origin.y, width: screenSize.width + bezel * 2, height: screenSize.height + bezel * 2)
    let radius = width * 0.24
    // Band, behind the case.
    let band = CGRect(x: outer.minX + outer.width * 0.14, y: outer.minY - width * 0.5, width: outer.width * 0.72, height: outer.height + width)
    NSColor(srgbRed: 30 / 255, green: 33 / 255, blue: 44 / 255, alpha: 1).setFill()
    NSBezierPath(roundedRect: band, xRadius: width * 0.08, yRadius: width * 0.08).fill()
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.5)
    shadow.shadowBlurRadius = 50
    shadow.shadowOffset = NSSize(width: 0, height: 20)
    shadow.set()
    // Crown and side button.
    let crown = CGRect(x: outer.maxX - width * 0.02, y: outer.minY + outer.height * 0.2, width: width * 0.07, height: outer.height * 0.16)
    NSColor(srgbRed: 120 / 255, green: 128 / 255, blue: 140 / 255, alpha: 1).setFill()
    NSBezierPath(roundedRect: crown, xRadius: width * 0.02, yRadius: width * 0.02).fill()
    let button = CGRect(x: outer.maxX - width * 0.015, y: outer.minY + outer.height * 0.48, width: width * 0.04, height: outer.height * 0.22)
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

/// One iPhone slide: the headline above a phone that runs off the bottom edge.
func slide(_ file: String, _ title: String, _ subtitle: String?, _ capture: String) {
    render(canvas, to: "out/\(file).png") {
        background()
        headline(title, subtitle)
        let width: CGFloat = 1000
        phone(capture == "phone-locked" ? lockScreenShot() : load(capture), width: width, origin: CGPoint(x: (canvas.width - width * 1.056) / 2, y: subtitle == nil ? 560 : 680))
    }
}

try? FileManager.default.createDirectory(atPath: "out", withIntermediateDirectories: true)

// iPhone, in App Store order. The first three show in search results.
render(canvas, to: "out/iphone-1-hero.png") {
    background()
    headline("A walkie-talkie for\niPhone and Apple Watch", nil, size: 98)
    phone(load("phone-talking"), width: 860, origin: CGPoint(x: 90, y: 600))
    watch(watchShot("watch-listening"), width: 470, origin: CGPoint(x: 700, y: 1500))
}
slide("iphone-2-locked", "Talk without\nunlocking", "Friends play right away, even when it's locked", "phone-locked")
slide("iphone-3-talk", "Hold to talk.\nLet go to listen.", nil, "phone-talking")
slide("iphone-4-listen", "Hear them\nright away", "Back and forth, as long as you like", "phone-listening")
slide("iphone-5-friends", "Only friends\ncan ring you", "Invite them with a link in Messages", "phone-friends")
slide("iphone-6-picture", "Pick a photo\nor a mascot", "Friends see it when you ring", "phone-picture")
slide("iphone-7-ring-choice", "Your watch\nrings first", "Or choose your iPhone. Only one rings.", "phone-ring-choice")

// Watch: the captures as they are, in App Store order.
for (index, name) in ["watch-talking", "watch-ring", "watch-friends", "watch-listening"].enumerated() {
    let image = watchShot(name)
    render(CGSize(width: 416, height: 496), to: "out/watch-\(index + 1)-\(name.dropFirst(6)).png") {
        drawFlipped(image, in: CGRect(x: 0, y: 0, width: 416, height: 496))
    }
}
