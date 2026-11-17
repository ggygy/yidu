// M0 spike:用 AppKit + WKWebView 直接复现 Tauri/tao 在 macOS 上的底层行为
// 1) Overlay 标题栏 + NSVisualEffectView(sidebar/popover)+ 透明 WKWebView
// 2) tao `inset_traffic_lights` 算法 → 红绿灯中线 vs 52pt 工具栏
// 3) NSWindow.appearance(= tauri set_theme)→ WKWebView prefers-color-scheme + change 事件
// 4) NSColor.controlAccentColor vs CSS AccentColor / -apple-system-control-accent
import AppKit
import WebKit

setvbuf(stdout, nil, _IONBF, 0)
let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."

func log(_ s: String) { print(s) }

func hex(_ c: NSColor?) -> String {
    guard let c = c?.usingColorSpace(.sRGB) else { return "nil" }
    return String(format: "#%02x%02x%02x", Int((c.redComponent * 255).rounded()), Int((c.greenComponent * 255).rounded()), Int((c.blueComponent * 255).rounded()))
}

let html = """
<!doctype html><html><head><meta charset=utf-8><style>
html,body{margin:0;height:100%;background:transparent;font:13px -apple-system}
.tb{height:52px;display:flex;align-items:center;padding-left:78px;gap:8px;border-bottom:1px solid rgba(0,0,0,.1)}
.seg{height:24px;padding:0 10px;border-radius:6px;background:rgba(0,0,0,.06);display:flex;align-items:center}
.mid{position:absolute;left:0;right:0;top:26px;height:1px;background:red}
.doc{position:absolute;left:200px;right:0;top:53px;bottom:0;background:#fff;padding:16px}
@media (prefers-color-scheme: dark){.doc{background:#1e1e1e;color:#eee}.seg{background:rgba(255,255,255,.1)}}
#a1{color:AccentColor}#a2{color:-apple-system-control-accent}#a3{accent-color:auto}
</style></head><body>
<div class=tb><div class=seg>译文 | 对照 | 原文</div><b>工具栏 52pt(红线 = 中线 26pt)</b></div><div class=mid></div>
<div class=doc>文档区实底;左侧 200pt 透出材质<p id=a1>AccentColor</p><p id=a2>-apple-system-control-accent</p></div>
<script>
window.__changes=0;
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>window.__changes++);
</script></body></html>
"""

final class Spike: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var windows: [NSWindow] = []
    var web: WKWebView!
    var loaded = false

    func makeWindow(material: NSVisualEffectView.Material, title: String, x: CGFloat, trafficLight: CGPoint?) -> (NSWindow, WKWebView) {
        let w = NSWindow(contentRect: NSRect(x: x, y: 200, width: 640, height: 400),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                         backing: .buffered, defer: false)
        // tao: titleBarStyle Overlay + hiddenTitle
        w.titlebarAppearsTransparent = true
        w.titleVisibility = .hidden
        w.title = title
        // windowEffects 要求 transparent:true → tao 设 isOpaque=false + clear 背景
        w.isOpaque = false
        w.backgroundColor = .clear
        let content = NSView(frame: w.contentView!.bounds)
        content.autoresizingMask = [.width, .height]
        // window-vibrancy:把 NSVisualEffectView 插在 contentView 最底层
        let fx = NSVisualEffectView(frame: content.bounds)
        fx.material = material
        fx.blendingMode = .behindWindow
        fx.state = .followsWindowActiveState
        fx.autoresizingMask = [.width, .height]
        content.addSubview(fx)
        let cfg = WKWebViewConfiguration()
        let wv = WKWebView(frame: content.bounds, configuration: cfg)
        wv.setValue(false, forKey: "drawsBackground") // wry transparent 同法
        wv.autoresizingMask = [.width, .height]
        wv.navigationDelegate = self
        content.addSubview(wv)
        w.contentView = content
        wv.loadHTMLString(html, baseURL: nil)
        w.makeKeyAndOrderFront(nil)
        if let tl = trafficLight { insetTrafficLights(w, x: tl.x, y: tl.y) }
        windows.append(w)
        return (w, wv)
    }

    /// 逐行移植 tao 0.37 `inset_traffic_lights`(platform_impl/macos/window.rs)
    func insetTrafficLights(_ window: NSWindow, x: CGFloat, y: CGFloat) {
        guard let close = window.standardWindowButton(.closeButton),
              let mini = window.standardWindowButton(.miniaturizeButton),
              let zoom = window.standardWindowButton(.zoomButton),
              let container = close.superview?.superview else { return }
        let closeRect = close.frame
        let titleBarFrameHeight = closeRect.size.height + y
        var titleBarRect = container.frame
        titleBarRect.size.height = titleBarFrameHeight
        titleBarRect.origin.y = window.frame.size.height - titleBarFrameHeight
        container.frame = titleBarRect
        let spaceBetween = mini.frame.origin.x - closeRect.origin.x
        for (i, b) in [close, mini, zoom].enumerated() {
            var r = b.frame
            r.origin.x = x + CGFloat(i) * spaceBetween
            b.setFrameOrigin(r.origin)
        }
    }

    func buttonGeometry(_ w: NSWindow) -> String {
        guard let close = w.standardWindowButton(.closeButton), let zoom = w.standardWindowButton(.zoomButton) else { return "?" }
        let r = close.convert(close.bounds, to: nil) // window 坐标(原点左下)
        let winH = w.frame.height
        let top = winH - r.maxY
        let mid = top + r.height / 2
        let zr = zoom.convert(zoom.bounds, to: nil)
        return String(format: "close button: x=%.1f top=%.1f h=%.1f → 中线距顶 %.1fpt;zoom 右缘 x=%.1f", r.minX, top, r.height, mid, zr.maxX)
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        log("macOS \(ProcessInfo.processInfo.operatingSystemVersionString)")
        log("NSColor.controlAccentColor (aqua)    = \(hex(withAppearance(.aqua) { NSColor.controlAccentColor }))")
        log("NSColor.controlAccentColor (darkAqua)= \(hex(withAppearance(.darkAqua) { NSColor.controlAccentColor }))")
        log("AppleAccentColor default = \(UserDefaults.standard.object(forKey: "AppleAccentColor") ?? "unset(多色/蓝)")")

        // 默认(无 trafficLightPosition)几何
        let (w0, _) = makeWindow(material: .sidebar, title: "default", x: 60, trafficLight: nil)
        log("[默认 Overlay] " + buttonGeometry(w0))
        for y: CGFloat in [15, 18, 19, 20, 26] {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 200), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
            w.titlebarAppearsTransparent = true; w.titleVisibility = .hidden
            w.orderFront(nil)
            insetTrafficLights(w, x: 20, y: y)
            log("[trafficLightPosition x=20 y=\(Int(y))] " + buttonGeometry(w))
            w.orderOut(nil)
        }
        let (w1, wv1) = makeWindow(material: .sidebar, title: "sidebar", x: 60, trafficLight: CGPoint(x: 20, y: 19))
        let (w2, _) = makeWindow(material: .popover, title: "popover", x: 720, trafficLight: CGPoint(x: 16, y: 15))
        _ = w2
        web = wv1
        w0.orderOut(nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { self.runThemeTests(w1) }
    }

    func withAppearance<T>(_ name: NSAppearance.Name, _ f: () -> T) -> T {
        var out: T!
        NSAppearance(named: name)!.performAsCurrentDrawingAppearance { out = f() }
        return out
    }

    func js(_ code: String, _ done: @escaping (String) -> Void) {
        web.evaluateJavaScript(code) { v, e in done(e.map { "ERR \($0)" } ?? "\(v ?? "nil")") }
    }

    func snapshot(_ w: NSWindow, _ name: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        p.arguments = ["-x", "-o", "-l", "\(w.windowNumber)", "\(outDir)/\(name).png"]
        try? p.run(); p.waitUntilExit()
        log("screencapture \(name): exit \(p.terminationStatus)")
    }

    func runThemeTests(_ w: NSWindow) {
        let probe = "JSON.stringify({dark:matchMedia('(prefers-color-scheme: dark)').matches,changes:window.__changes,accentCSS:getComputedStyle(document.getElementById('a1')).color,appleAccent:getComputedStyle(document.getElementById('a2')).color,reducedTransparencySupported:matchMedia('(prefers-reduced-transparency: reduce)').media!=='not all',reducedTransparency:matchMedia('(prefers-reduced-transparency: reduce)').matches,ua:navigator.userAgent})"
        snapshot(windows[1], "sidebar-system")
        snapshot(windows[2], "popover-system")
        js(probe) { log("[appearance=nil 系统(初始)] \($0)") }
        let steps: [(String, NSAppearance?)] = [
            ("darkAqua (set_theme(Some(Dark)))", NSAppearance(named: .darkAqua)),
            ("aqua (set_theme(Some(Light)))", NSAppearance(named: .aqua)),
            ("nil (set_theme(None))", nil),
        ]
        var t = 0.5
        for (label, app) in steps {
            DispatchQueue.main.asyncAfter(deadline: .now() + t) {
                w.appearance = app
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                    self.js(probe) { log("[\(label) +150ms] \($0)") }
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                    let suffix = label.split(separator: " ").first.map(String.init) ?? "x"
                    self.snapshot(w, "sidebar-\(suffix)")
                }
            }
            t += 1.2
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + t + 0.5) { NSApp.terminate(nil) }
    }
}

let app = NSApplication.shared
let d = Spike()
app.delegate = d
app.run()
