// Draws Jarvis's app icon as a 1024-pixel PNG.
// Usage: swift scripts/make-icon.swift OUT.png [reactor|monogram|sphere]
import AppKit

let size: CGFloat = 1024
let style = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "reactor"
let space = CGColorSpaceCreateDeviceRGB()
let context = CGContext(data: nil, width: Int(size), height: Int(size), bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
let centre = CGPoint(x: size / 2, y: size / 2)
func colour(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor { CGColor(red: r / 255, green: g / 255, blue: b / 255, alpha: a) }
func radial(_ colours: [CGColor], _ stops: [CGFloat], at point: CGPoint = centre, radius: CGFloat) {
  let gradient = CGGradient(colorsSpace: space, colors: colours as CFArray, locations: stops)!
  context.drawRadialGradient(gradient, startCenter: point, startRadius: 0, endCenter: point, endRadius: radius, options: [])
}
func linear(_ colours: [CGColor], from: CGPoint, to: CGPoint) {
  let gradient = CGGradient(colorsSpace: space, colors: colours as CFArray, locations: nil)!
  context.drawLinearGradient(gradient, start: from, end: to, options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
}
func circle(_ radius: CGFloat, at point: CGPoint = centre) -> CGPath { CGPath(ellipseIn: CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2), transform: nil) }
func lit(_ blur: CGFloat, _ glow: CGColor, _ draw: () -> Void) {
  context.saveGState()
  context.setShadow(offset: .zero, blur: blur, color: glow)
  draw()
  context.restoreGState()
}

// The tile: macOS's rounded square, 824 points wide on the 1024 canvas.
context.addPath(CGPath(roundedRect: CGRect(x: 100, y: 100, width: 824, height: 824), cornerWidth: 186, cornerHeight: 186, transform: nil))
context.clip()

switch style {
case "monogram":
  // A bright blue tile with a white J and one orbit around it.
  linear([colour(20, 110, 255), colour(0, 200, 255)], from: CGPoint(x: 100, y: 100), to: CGPoint(x: 924, y: 924))
  radial([colour(255, 255, 255, 0.28), colour(255, 255, 255, 0)], [0, 1], at: CGPoint(x: 330, y: 800), radius: 620)
  lit(40, colour(0, 40, 120, 0.55)) {
    context.setStrokeColor(colour(255, 255, 255))
    context.setLineCap(.round)
    context.setLineWidth(84)
    context.move(to: CGPoint(x: 590, y: 742))
    context.addLine(to: CGPoint(x: 590, y: 440))
    context.addArc(center: CGPoint(x: 470, y: 440), radius: 120, startAngle: 0, endAngle: .pi, clockwise: true)
    context.strokePath()
    context.setLineWidth(84)
    context.move(to: CGPoint(x: 430, y: 742))
    context.addLine(to: CGPoint(x: 590, y: 742))
    context.strokePath()
  }
  context.setStrokeColor(colour(255, 255, 255, 0.5))
  context.setLineWidth(14)
  context.saveGState()
  context.translateBy(x: centre.x, y: centre.y)
  context.rotate(by: -0.45)
  context.scaleBy(x: 1, y: 0.36)
  context.addArc(center: .zero, radius: 372, startAngle: 0.25, endAngle: .pi * 2 - 0.25, clockwise: false)
  context.restoreGState()
  context.strokePath()
case "sphere":
  // A glass ball lit from above on a near-black tile, with a voice wave across it.
  linear([colour(8, 10, 22), colour(28, 22, 60)], from: CGPoint(x: 512, y: 100), to: CGPoint(x: 512, y: 924))
  radial([colour(90, 120, 255, 0.5), colour(90, 120, 255, 0)], [0, 1], radius: 470)
  context.saveGState()
  context.addPath(circle(290))
  context.clip()
  linear([colour(20, 40, 160), colour(60, 150, 255), colour(150, 240, 255)], from: CGPoint(x: 512, y: 222), to: CGPoint(x: 512, y: 802))
  radial([colour(190, 110, 255, 0.75), colour(190, 110, 255, 0)], [0, 1], at: CGPoint(x: 640, y: 380), radius: 300)
  radial([colour(255, 255, 255, 0.9), colour(255, 255, 255, 0)], [0, 1], at: CGPoint(x: 420, y: 690), radius: 190)
  context.restoreGState()
  lit(18, colour(255, 255, 255, 0.8)) {
    context.setFillColor(colour(255, 255, 255))
    for (index, height) in [70.0, 150, 250, 330, 250, 150, 70].enumerated() {
      let x = 512 + CGFloat(index - 3) * 58
      context.addPath(CGPath(roundedRect: CGRect(x: x - 17, y: 512 - height / 2, width: 34, height: height), cornerWidth: 17, cornerHeight: 17, transform: nil))
    }
    context.fillPath()
  }
default:
  // A reactor: a bright core inside a ring of ten lit segments, on brushed dark metal.
  linear([colour(34, 44, 56), colour(8, 12, 18)], from: CGPoint(x: 512, y: 924), to: CGPoint(x: 512, y: 100))
  radial([colour(60, 200, 255, 0.45), colour(60, 200, 255, 0)], [0, 1], radius: 430)
  context.setFillColor(colour(6, 10, 16))
  context.addPath(circle(330))
  context.fillPath()
  context.setStrokeColor(colour(90, 110, 130))
  context.setLineWidth(10)
  context.addPath(circle(330))
  context.strokePath()
  lit(34, colour(60, 210, 255)) {
    context.setStrokeColor(colour(190, 245, 255))
    context.setLineWidth(74)
    for index in 0..<10 {
      let start = CGFloat(index) * 36 + 5
      context.addArc(center: centre, radius: 250, startAngle: start * .pi / 180, endAngle: (start + 26) * .pi / 180, clockwise: false)
      context.strokePath()
    }
    context.setLineWidth(12)
    context.addPath(circle(168))
    context.strokePath()
  }
  radial([colour(255, 255, 255), colour(200, 245, 255), colour(70, 200, 255, 0.9), colour(40, 150, 235, 0)], [0, 0.35, 0.7, 1], radius: 150)
}

let png = NSBitmapImageRep(cgImage: context.makeImage()!).representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
