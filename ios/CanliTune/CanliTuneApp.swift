import SwiftUI
import WebKit

@main
struct CanliTuneApp: App {
    var body: some Scene {
        WindowGroup {
            WebHost()
                .ignoresSafeArea()
                .background(Color(red: 13 / 255, green: 15 / 255, blue: 20 / 255))
                .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        }
    }
}

/// Hosts the shared CanlıTune UI (index.html) and routes the mic to the native RemoteIO engine.
struct WebHost: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.userContentController.add(context.coordinator, name: "canli")
        let web = WKWebView(frame: .zero, configuration: cfg)
        web.isOpaque = false
        web.backgroundColor = UIColor(red: 13 / 255, green: 15 / 255, blue: 20 / 255, alpha: 1)
        web.scrollView.contentInsetAdjustmentBehavior = .never
        context.coordinator.web = web
        if let url = Bundle.main.url(forResource: "index", withExtension: "html") {
            web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKScriptMessageHandler {
        weak var web: WKWebView?
        let engine = CTAudioEngine()
        var timer: Timer?

        func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
            switch cmd {
            case "start":
                engine.start { [weak self] json in
                    self?.web?.evaluateJavaScript("window.__canliStarted && window.__canliStarted(\(json))")
                    if json.contains("\"ok\":true") { self?.startTelemetry() }
                }
            case "stop":
                timer?.invalidate(); timer = nil
                engine.stop()
            case "params":
                if let p = body["p"] as? [String: Any] { engine.setParams(p) }
            case "measure":
                engine.measure()
            default: break
            }
        }

        private func startTelemetry() {
            timer?.invalidate()
            timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
                guard let self = self else { return }
                let t = self.engine.telemetry().map { String(format: "%.4f", $0.doubleValue) }.joined(separator: ",")
                self.web?.evaluateJavaScript("window.__canliTelem([\(t)])")
            }
        }
    }
}
