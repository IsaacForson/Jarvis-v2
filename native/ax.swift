// Jarvis's hands inside other apps, through the macOS accessibility interface.
// Usage: ax tree | press PATH ROLE | type TEXT [PATH ROLE] | key COMBO | menus [TITLE] | menu TITLE...
//        | click X Y [right|double] | drag X1 Y1 X2 Y2 | scroll X Y DOWN RIGHT | at X Y | screen
//        | pdftext FILE
// Every command before click takes an optional --app NAME.
// Prints JSON on success; prints a plain sentence to stderr and exits 1 on failure.
import ApplicationServices
import Cocoa
import PDFKit

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
  var value: AnyObject?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func string(_ element: AXUIElement, _ name: String) -> String? {
  guard let value = attribute(element, name) as? String, !value.isEmpty else { return nil }
  return value
}
func children(_ element: AXUIElement) -> [AXUIElement] {
  (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}
func frame(_ element: AXUIElement) -> CGRect? {
  guard let position = attribute(element, kAXPositionAttribute), let size = attribute(element, kAXSizeAttribute) else { return nil }
  var point = CGPoint.zero
  var extent = CGSize.zero
  guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &extent) else { return nil }
  return CGRect(origin: point, size: extent)
}
func actions(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  return AXUIElementCopyActionNames(element, &names) == .success ? (names as? [String] ?? []) : []
}

/// The app to work in: the named one (brought to the front), or whichever is in front now.
func target(_ name: String?) -> NSRunningApplication {
  guard let name = name else {
    guard let front = NSWorkspace.shared.frontmostApplication else { fail("No app is in front.") }
    return front
  }
  let running = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
  guard let app = running.first(where: { $0.localizedName?.lowercased() == name.lowercased() })
    ?? running.first(where: { $0.localizedName?.lowercased().contains(name.lowercased()) ?? false })
  else { fail("\(name) is not running. Open it first.") }
  bringToFront(app)
  return app
}

/// Brings an app to the front and waits until it is. A background program's own request to activate
/// another app is often ignored by macOS, so this goes through `open`, as a double-click would.
func bringToFront(_ app: NSRunningApplication) {
  if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier { return }
  if let bundle = app.bundleURL {
    let open = Process()
    open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    open.arguments = [bundle.path]
    try? open.run()
    open.waitUntilExit()
  } else {
    app.activate()
  }
  for _ in 0..<20 {
    if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier { return }
    RunLoop.current.run(until: Date().addingTimeInterval(0.1)) // lets the frontmost-app value update
  }
}

/// Keystrokes go to whichever app is in front, so nothing is typed unless that is the intended app.
func requireFront(_ app: NSRunningApplication) {
  guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else {
    fail("\(app.localizedName ?? "That app") did not come to the front, so I typed nothing.")
  }
}

func window(of app: NSRunningApplication) -> AXUIElement {
  let element = AXUIElementCreateApplication(app.processIdentifier)
  // Chrome- and Electron-based apps build their accessibility tree only when asked to.
  AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  AXUIElementSetAttributeValue(element, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
  for _ in 0..<10 {
    if let focused = attribute(element, kAXFocusedWindowAttribute) { return focused as! AXUIElement }
    if let first = (attribute(element, kAXWindowsAttribute) as? [AXUIElement])?.first { return first }
    Thread.sleep(forTimeInterval: 0.2)
  }
  fail("\(app.localizedName ?? "That app") has no window open.")
}

let controls: Set<String> = [
  "AXButton", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXLink",
  "AXComboBox", "AXSlider", "AXMenuItem", "AXDisclosureTriangle", "AXIncrementor", "AXTab",
]

/// Walks the window and lists its controls (with the route to each) and its readable text.
func tree(_ app: NSRunningApplication) {
  let root = window(of: app)
  var items: [[String: Any]] = []
  var texts: [String] = []
  var visited = 0
  func walk(_ element: AXUIElement, _ path: String) {
    visited += 1
    if visited > 6000 || items.count >= 200 { return }
    let role = string(element, kAXRoleAttribute) ?? ""
    let label = string(element, kAXTitleAttribute) ?? string(element, kAXDescriptionAttribute) ?? string(element, kAXPlaceholderValueAttribute) ?? string(element, kAXHelpAttribute)
    let value = attribute(element, kAXValueAttribute)
    let valueText = (value as? String) ?? (value as? NSNumber)?.stringValue
    if role == "AXStaticText", let text = valueText ?? label, !text.isEmpty, texts.count < 400 { texts.append(text) }
    if controls.contains(role), let box = frame(element), box.width > 0, box.height > 0 {
      let enabled = (attribute(element, kAXEnabledAttribute) as? Bool) ?? true
      if enabled, label != nil || role == "AXTextField" || role == "AXTextArea" || role == "AXComboBox" {
        var item: [String: Any] = ["path": path, "role": role, "label": label ?? "", "secure": string(element, kAXSubroleAttribute) == "AXSecureTextField"]
        if let valueText = valueText, !valueText.isEmpty { item["value"] = String(valueText.prefix(200)) }
        item["x"] = Int(box.midX)
        item["y"] = Int(box.midY)
        items.append(item)
      }
    }
    for (index, child) in children(element).enumerated() { walk(child, path + "." + String(index)) }
  }
  walk(root, "w")
  let result: [String: Any] = ["app": app.localizedName ?? "", "window": string(root, kAXTitleAttribute) ?? "", "items": items, "texts": texts]
  print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
}

/// Finds an element again by its route, and checks it is still the kind of thing it was.
func resolve(_ app: NSRunningApplication, _ path: String, _ role: String) -> AXUIElement {
  var element = window(of: app)
  for step in path.split(separator: ".").dropFirst() {
    let kids = children(element)
    guard let index = Int(step), index < kids.count else { fail("The window has changed since it was read. Read it again.") }
    element = kids[index]
  }
  guard string(element, kAXRoleAttribute) == role else { fail("The window has changed since it was read. Read it again.") }
  return element
}

func click(at point: CGPoint, right: Bool = false, count: Int = 1) {
  let (down, up, button): (CGEventType, CGEventType, CGMouseButton) = right ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
  for n in 1...count {
    for type in [down, up] {
      let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button)
      event?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
      event?.post(tap: .cghidEventTap)
      Thread.sleep(forTimeInterval: 0.05)
    }
  }
}

func drag(from start: CGPoint, to end: CGPoint) {
  let post = { (type: CGEventType, point: CGPoint) in
    CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
  }
  post(.mouseMoved, start)
  Thread.sleep(forTimeInterval: 0.05)
  post(.leftMouseDown, start)
  for step in 1...20 {
    let t = CGFloat(step) / 20
    post(.leftMouseDragged, CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t))
    Thread.sleep(forTimeInterval: 0.015)
  }
  post(.leftMouseUp, end)
}

/// Scrolls at a point; positive `down` scrolls the content down, as the mouse wheel would.
func scroll(at point: CGPoint, down: Int32, right: Int32) {
  CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
  Thread.sleep(forTimeInterval: 0.05)
  CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: -down, wheel2: -right, wheel3: 0)?.post(tap: .cghidEventTap)
}

func onScreen(_ x: String, _ y: String) -> CGPoint {
  guard let x = Double(x), let y = Double(y), let screen = NSScreen.main?.frame, x >= 0, y >= 0, x <= screen.width, y <= screen.height else { fail("That point is not on the screen.") }
  return CGPoint(x: x, y: y)
}

func press(_ element: AXUIElement) {
  if actions(element).contains(kAXPressAction as String), AXUIElementPerformAction(element, kAXPressAction as CFString) == .success { return }
  // No press action (common in web-based apps): click the middle of it instead.
  guard let box = frame(element) else { fail("That control cannot be pressed.") }
  click(at: CGPoint(x: box.midX, y: box.midY))
}

let keyboard = CGEventSource(stateID: .hidSystemState)
let keyCodes: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
  "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33,
  "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
  "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53, "forwarddelete": 117,
  "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]
let modifiers: [String: CGEventFlags] = [
  "cmd": .maskCommand, "command": .maskCommand, "shift": .maskShift, "alt": .maskAlternate, "option": .maskAlternate, "opt": .maskAlternate, "ctrl": .maskControl, "control": .maskControl,
]

/// Presses one key combination such as "cmd+shift+s" or "return".
func key(_ combo: String) {
  var flags: CGEventFlags = []
  var code: CGKeyCode?
  for part in combo.lowercased().split(separator: "+").map(String.init) {
    if let flag = modifiers[part] { flags.insert(flag) } else if let found = keyCodes[part] { code = found } else { fail("I do not know the key \"\(part)\".") }
  }
  guard let keyCode = code else { fail("That combination names no key.") }
  for down in [true, false] {
    let event = CGEvent(keyboardEventSource: keyboard, virtualKey: keyCode, keyDown: down)
    event?.flags = flags
    event?.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.03)
  }
}

/// Types text as if at the keyboard, whatever the keyboard layout.
func type(_ text: String) {
  for chunk in stride(from: 0, to: text.utf16.count, by: 16).map({ Array(text.utf16.dropFirst($0).prefix(16)) }) {
    for down in [true, false] {
      let event = CGEvent(keyboardEventSource: keyboard, virtualKey: 0, keyDown: down)
      // Explicitly no modifiers: without this, text typed right after a shortcut such as cmd+A
      // arrived as more shortcuts instead of letters.
      event?.flags = []
      event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
      event?.post(tap: .cghidEventTap)
      Thread.sleep(forTimeInterval: 0.02)
    }
  }
}

/// The app's menu bar, as a list of menus.
func menuBar(_ app: NSRunningApplication) -> [AXUIElement] {
  let element = AXUIElementCreateApplication(app.processIdentifier)
  guard let bar = attribute(element, kAXMenuBarAttribute) else { fail("\(app.localizedName ?? "That app") has no menu bar.") }
  return children(bar as! AXUIElement)
}
/// The items inside a menu or submenu (they sit one level down, inside an AXMenu).
func menuItems(_ menu: AXUIElement) -> [AXUIElement] {
  children(menu).flatMap { string($0, kAXRoleAttribute) == "AXMenu" ? children($0) : [$0] }
}
func named(_ items: [AXUIElement], _ title: String) -> AXUIElement {
  let wanted = title.lowercased().replacingOccurrences(of: "...", with: "…")
  let titles = items.map { (string($0, kAXTitleAttribute) ?? "").lowercased() }
  guard let index = titles.firstIndex(of: wanted) ?? titles.firstIndex(where: { !$0.isEmpty && $0.hasPrefix(wanted.replacingOccurrences(of: "…", with: "")) }) else {
    fail("There is no menu item called \"\(title)\". Read the menus to see the exact names.")
  }
  return items[index]
}
/// Lists the menu bar's menus, or the items of one menu.
func menus(_ app: NSRunningApplication, _ title: String?) {
  let items = title == nil ? menuBar(app) : menuItems(named(menuBar(app), title!))
  let listed: [[String: Any]] = items.compactMap { item in
    guard let name = string(item, kAXTitleAttribute) else { return nil } // separators have no title
    return ["title": name, "enabled": (attribute(item, kAXEnabledAttribute) as? Bool) ?? true, "submenu": !children(item).isEmpty && title != nil]
  }
  print(String(data: try! JSONSerialization.data(withJSONObject: ["app": app.localizedName ?? "", "items": listed]), encoding: .utf8)!)
}
/// Chooses a menu item by its route, e.g. ["File", "Export As", "PDF…"].
func chooseMenu(_ app: NSRunningApplication, _ route: [String]) {
  var item = named(menuBar(app), route[0])
  for title in route.dropFirst() { item = named(menuItems(item), title) }
  guard (attribute(item, kAXEnabledAttribute) as? Bool) ?? true else { fail("That menu item is greyed out right now.") }
  guard AXUIElementPerformAction(item, kAXPressAction as CFString) == .success else { fail("That menu item could not be chosen.") }
}

// Reading a PDF's text needs no accessibility permission, so it is answered before that check.
if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "pdftext" {
  guard let document = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[2])) else { fail("That PDF could not be opened.") }
  print(document.string ?? "")
  exit(0)
}

guard AXIsProcessTrusted() else {
  fail("I am not allowed to control other apps. Accessibility must be switched on, in System Settings under Privacy and Security, for the app that started me.")
}
var arguments = Array(CommandLine.arguments.dropFirst())
var appName: String?
if let flag = arguments.firstIndex(of: "--app"), flag + 1 < arguments.count {
  appName = arguments[flag + 1]
  arguments.removeSubrange(flag...flag + 1)
}
switch arguments.first {
case "tree":
  tree(target(appName))
case "press" where arguments.count == 3:
  press(resolve(target(appName), arguments[1], arguments[2]))
  print("{}")
case "type" where arguments.count == 2 || arguments.count == 4:
  let app = target(appName)
  if arguments.count == 4 {
    let field = resolve(app, arguments[2], arguments[3])
    if string(field, kAXSubroleAttribute) == "AXSecureTextField" { fail("That is a password field, which I never type into.") }
    // Put the cursor in the field, select what is there, and type over it.
    requireFront(app)
    if AXUIElementSetAttributeValue(field, kAXFocusedAttribute as CFString, kCFBooleanTrue) != .success { press(field) }
    Thread.sleep(forTimeInterval: 0.15)
    key("cmd+a")
    Thread.sleep(forTimeInterval: 0.1)
  }
  requireFront(app)
  type(arguments[1])
  Thread.sleep(forTimeInterval: 0.1) // let the last keystrokes be delivered before this program exits
  print("{}")
case "key" where arguments.count == 2:
  requireFront(target(appName))
  key(arguments[1])
  Thread.sleep(forTimeInterval: 0.1)
  print("{}")
case "menus" where arguments.count <= 2:
  menus(target(appName), arguments.count == 2 ? arguments[1] : nil)
case "menu" where arguments.count >= 3:
  let app = target(appName)
  requireFront(app)
  chooseMenu(app, Array(arguments.dropFirst()))
  print("{}")
case "click" where arguments.count == 3 || arguments.count == 4:
  let how = arguments.count == 4 ? arguments[3] : "left"
  click(at: onScreen(arguments[1], arguments[2]), right: how == "right", count: how == "double" ? 2 : 1)
  Thread.sleep(forTimeInterval: 0.1)
  print("{}")
case "drag" where arguments.count == 5:
  drag(from: onScreen(arguments[1], arguments[2]), to: onScreen(arguments[3], arguments[4]))
  Thread.sleep(forTimeInterval: 0.1)
  print("{}")
case "scroll" where arguments.count == 5:
  guard let down = Int32(arguments[3]), let right = Int32(arguments[4]) else { fail("Scroll amounts must be whole numbers.") }
  scroll(at: onScreen(arguments[1], arguments[2]), down: down, right: right)
  Thread.sleep(forTimeInterval: 0.1)
  print("{}")
case "at" where arguments.count == 3:
  // What is under a point of the screen: used to check a click before it is made.
  guard let x = Float(arguments[1]), let y = Float(arguments[2]) else { fail("That is not a point.") }
  var found: AXUIElement?
  var result: [String: Any] = ["app": "", "role": "", "label": "", "secure": false]
  if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), x, y, &found) == .success, let element = found {
    var pid: pid_t = 0
    AXUIElementGetPid(element, &pid)
    result["app"] = NSRunningApplication(processIdentifier: pid)?.localizedName ?? ""
    result["role"] = string(element, kAXRoleAttribute) ?? ""
    result["label"] = string(element, kAXTitleAttribute) ?? string(element, kAXDescriptionAttribute) ?? (attribute(element, kAXValueAttribute) as? String).map { String($0.prefix(60)) } ?? ""
    result["secure"] = string(element, kAXSubroleAttribute) == "AXSecureTextField"
  }
  print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
case "screen":
  guard let screen = NSScreen.main?.frame else { fail("No screen found.") }
  print("{\"width\":\(Int(screen.width)),\"height\":\(Int(screen.height))}")
default:
  fail("Usage: ax tree | press PATH ROLE | type TEXT [PATH ROLE] | key COMBO | menus [TITLE] | menu TITLE... | click X Y [right|double] | drag X1 Y1 X2 Y2 | scroll X Y DOWN RIGHT | at X Y | screen")
}
