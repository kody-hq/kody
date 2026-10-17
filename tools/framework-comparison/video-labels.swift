import AppKit
import CoreText

// The label strip is separate from the recorded browser image.
let args = CommandLine.arguments
precondition(args.count == 4, "Usage: video-labels.swift FONT_PATH PANEL_WIDTH OUTPUT_PNG")
let fontURL = URL(fileURLWithPath: args[1])
CTFontManagerRegisterFontsForURL(fontURL as CFURL, .process, nil)
guard let font = NSFont(name: "Arial", size: 32), let panelWidth = Int(args[2]), panelWidth > 0 else {
    fatalError("Explicit Arial font and positive panel width required")
}
let width = panelWidth * 2
let height = 64
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor(calibratedWhite: 17.0 / 255.0, alpha: 1).setFill()
NSBezierPath(rect: NSRect(x: 0, y: 0, width: width, height: height)).fill()
let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white]
for (index, label) in ["Remix", "Start + Query"].enumerated() {
    let text = label as NSString
    let size = text.size(withAttributes: attributes)
    text.draw(at: NSPoint(x: CGFloat(index * panelWidth) + (CGFloat(panelWidth) - size.width) / 2,
        y: (CGFloat(height) - size.height) / 2), withAttributes: attributes)
}
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[3]))
