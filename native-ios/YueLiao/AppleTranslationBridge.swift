import Foundation
import SwiftUI
import Translation
import Speech
import WebKit

// Use YueLiaoAppleTranslationWebView() in the existing SwiftUI tab.
// UIKit can host the same view with UIHostingController(rootView: ...).
@available(iOS 18.0, *)
struct YueLiaoAppleTranslationWebView: View {
    @StateObject private var bridge = AppleTranslationBridge()

    var body: some View {
        BridgeWebView(bridge: bridge)
            .background {
                if let work = bridge.current {
                    Color.clear.frame(width: 0, height: 0)
                        .modifier(TranslationWork(bridge: bridge, work: work))
                        .id(work.id)
                }
            }
    }

    private struct TranslationWork: ViewModifier {
        let bridge: AppleTranslationBridge
        let work: AppleTranslationBridge.Work

        @ViewBuilder
        func body(content: Content) -> some View {
            if work.engine == .foundation {
                content.task { await bridge.translateUsingFoundation(work) }
            } else {
                content.translationTask(work.configuration) { session in
                    await bridge.translateUsingApple(work, session: session)
                }
            }
        }
    }

    private struct BridgeWebView: UIViewRepresentable {
        let bridge: AppleTranslationBridge

        func makeUIView(context: Context) -> WKWebView {
            let configuration = WKWebViewConfiguration()
            configuration.allowsInlineMediaPlayback = true
            configuration.userContentController.add(bridge, name: "appleTranslate")
            configuration.userContentController.add(bridge.speech, name: "yueliaoSpeech")
            configuration.userContentController.addUserScript(WKUserScript(
                source: TranslationWebAdapter.source, injectionTime: .atDocumentStart, forMainFrameOnly: true
            ))
            let webView = WKWebView(frame: .zero, configuration: configuration)
            webView.scrollView.contentInsetAdjustmentBehavior = .never
            webView.backgroundColor = UIColor(red: 0.035, green: 0.043, blue: 0.055, alpha: 1)
            webView.underPageBackgroundColor = webView.backgroundColor
            // Refresh the HTML entry point without clearing the user's site data.
            let request = URLRequest(url: AppleTranslationBridge.site, cachePolicy: .reloadIgnoringLocalCacheData)
            webView.load(request)
            return webView
        }

        func updateUIView(_ webView: WKWebView, context: Context) {}

        static func dismantleUIView(_ webView: WKWebView, coordinator: ()) {
            let controller = webView.configuration.userContentController
            controller.removeScriptMessageHandler(forName: "appleTranslate")
            controller.removeScriptMessageHandler(forName: "yueliaoSpeech")
        }
    }
}

@available(iOS 18.0, *)
@MainActor
private final class AppleTranslationBridge: NSObject, ObservableObject, WKScriptMessageHandler {
    static let site = URL(string: "https://yueliao.eu.cc/")!

    enum Engine: String, Hashable {
        case foundation, highFidelity, lowLatency
    }

    struct Input: Hashable {
        let text: String
        let from: String
        let to: String
        let conversationID: String
        let messageID: String
        let context: TranslationContext?
        let realtime: Bool
    }

    struct Request {
        let id: String
        let input: Input
        let engines: [Engine]
        let download: Bool
        let frame: WKFrameInfo
    }

    struct Work {
        let request: Request
        let index: Int
        let id = UUID()
        var engine: Engine { request.engines[index] }
        var source: Locale.Language { Locale.Language(identifier: request.input.from) }
        var target: Locale.Language { Locale.Language(identifier: request.input.to) }

        var configuration: TranslationSession.Configuration {
            #if compiler(>=6.3)
            if #available(iOS 26.4, *) {
                return .init(source: source, target: target, preferredStrategy: engine == .highFidelity ? .highFidelity : .lowLatency)
            }
            #endif
            return .init(source: source, target: target)
        }

        func availability() async -> LanguageAvailability.Status {
            #if compiler(>=6.3)
            if #available(iOS 26.4, *) {
                return await LanguageAvailability(preferredStrategy: engine == .highFidelity ? .highFidelity : .lowLatency)
                    .status(from: source, to: target)
            }
            #endif
            return await LanguageAvailability().status(from: source, to: target)
        }
    }

    private struct CacheKey: Hashable {
        let input: Input
        let engine: Engine
    }

    let speech = AppleSpeechBridge()
    @Published private(set) var current: Work?
    private var pending: [Request] = []
    private var cache: [CacheKey: String] = [:]
    private weak var webView: WKWebView?

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let frame = message.frameInfo
        let origin = frame.securityOrigin
        guard message.name == "appleTranslate", frame.isMainFrame,
              origin.protocol == "https", origin.host == Self.site.host,
              origin.port == 0 || origin.port == 443,
              let webView = message.webView,
              let body = message.body as? [String: Any],
              let id = body["requestId"] as? String, UUID(uuidString: id) != nil else { return }
        self.webView = webView

        switch body["action"] as? String {
        case "capabilities":
            Task { @MainActor in
                let low = await LanguageAvailability().status(from: Locale.Language(identifier: "zh-Hans"), to: Locale.Language(identifier: "vi"))
                let capabilities = [
                    "foundation": FoundationModelsEngine.supports(from: "zh-Hans", to: "vi"),
                    "appleInstalled": low == .installed,
                    "appleSupported": low == .installed || low == .supported,
                    "speechChinese": speechAvailable("zh-CN"),
                    "speechVietnamese": speechAvailable("vi-VN"),
                ]
                if let data = try? JSONSerialization.data(withJSONObject: capabilities),
                   let text = String(data: data, encoding: .utf8) { reply(id, frame: frame, text: text) }
            }
            return
        case "cancel":
            pending.removeAll { $0.id == id }
            if current?.request.id == id { nextRequest() }
            return
        case "clearCache":
            cache.removeAll()
            reply(id, frame: frame, text: "")
            return
        default:
            break
        }

        let from = Self.language((body["fromLang"] ?? body["from"]) as? String)
        let to = Self.language((body["toLang"] ?? body["to"]) as? String)
        guard let from, let to, from != to else {
            reply(id, frame: frame, error: "请选择中越互译方向。")
            return
        }
        let download = body["action"] as? String == "download"
        let realtime = body["mode"] as? String == "call"
        let text = (body["sourceText"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard download || (!text.isEmpty && text.unicodeScalars.count <= 450) else {
            reply(id, frame: frame, error: "翻译文字长度须在 1 到 450 字之间。")
            return
        }
        let hasHighFidelity: Bool
        #if compiler(>=6.3)
        if #available(iOS 26.4, *) { hasHighFidelity = true } else { hasHighFidelity = false }
        #else
        hasHighFidelity = false
        #endif
        let engines: [Engine]
        if download {
            engines = [.lowLatency]
        } else if let selected = Engine(rawValue: body["engine"] as? String ?? "") {
            engines = selected == .highFidelity && !hasHighFidelity ? [] : [selected]
        } else {
            let frameworkEngines: [Engine]
            if hasHighFidelity {
                frameworkEngines = realtime ? [.lowLatency, .highFidelity] : [.highFidelity, .lowLatency]
            } else {
                frameworkEngines = [.lowLatency]
            }
            engines = FoundationModelsEngine.supports(from: from, to: to)
                ? [.foundation] + frameworkEngines
                : frameworkEngines
        }
        guard !engines.isEmpty else {
            reply(id, frame: frame, error: "此系统版本不支持所选翻译策略。")
            return
        }
        guard current?.request.id != id, !pending.contains(where: { $0.id == id }) else { return }
        guard pending.count < 8 else {
            reply(id, frame: frame, error: "本机翻译请求过多，请稍后重试。")
            return
        }
        let messageID = String((body["messageId"] as? String ?? "").prefix(120))
        let conversationID = String((body["conversationId"] as? String ?? "").prefix(120))
        let context = conversationID.isEmpty ? nil : TranslationContext.read(body["context"])
        let input = Input(text: text, from: from, to: to, conversationID: conversationID,
                          messageID: messageID, context: context, realtime: realtime)
        let request = Request(id: id, input: input, engines: engines, download: download, frame: frame)
        if current == nil { current = Work(request: request, index: 0) } else { pending.append(request) }
    }

    func translateUsingFoundation(_ work: Work) async {
        guard current?.id == work.id, !Task.isCancelled else { return }
        let input = work.request.input
        let key = CacheKey(input: input, engine: work.engine)
        if let cached = cache[key] {
            finish(work, text: cached)
            return
        }
        let result = await FoundationModelsEngine.translate(input.text, from: input.from, to: input.to, context: input.context)
        guard current?.id == work.id, !Task.isCancelled else { return }
        if let result {
            save(result, for: key)
            finish(work, text: result)
        } else {
            fallback(work, error: "苹果智能暂时无法翻译此消息。")
        }
    }

    func translateUsingApple(_ work: Work, session: TranslationSession) async {
        guard current?.id == work.id, !Task.isCancelled else { return }
        let input = work.request.input
        let key = CacheKey(input: input, engine: work.engine)
        if !work.request.download, let cached = cache[key] {
            finish(work, text: cached)
            return
        }
        let status = await work.availability()
        guard current?.id == work.id, !Task.isCancelled else { return }
        do {
            if work.request.download && (status == .supported || status == .installed) {
                if status != .installed { try await session.prepareTranslation() }
                finish(work, text: "")
                return
            }
            guard status == .installed else {
                fallback(work, error: status == .supported
                    ? "请先下载中越翻译语言包，再重试。"
                    : "此设备的苹果翻译暂不支持该中越翻译方向。")
                return
            }
            let result = try await session.translate(input.text)
            let translated = result.targetText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !translated.isEmpty else {
                fallback(work, error: "苹果翻译未返回译文，请重试。")
                return
            }
            guard current?.id == work.id, !Task.isCancelled else { return }
            save(translated, for: key)
            finish(work, text: translated)
        } catch {
            fallback(work, error: "苹果翻译暂时不可用，请重试。")
        }
    }

    private func save(_ text: String, for key: CacheKey) {
        if cache.count >= 128 { cache.removeAll(keepingCapacity: true) }
        cache[key] = text
    }

    private func fallback(_ work: Work, error: String) {
        guard current?.id == work.id, !Task.isCancelled else { return }
        let index = work.index + 1
        if index < work.request.engines.count {
            current = Work(request: work.request, index: index)
        } else {
            finish(work, error: error)
        }
    }

    private func nextRequest() {
        current = pending.isEmpty ? nil : Work(request: pending.removeFirst(), index: 0)
    }

    private func finish(_ work: Work, text: String? = nil, error: String? = nil) {
        guard current?.id == work.id, !Task.isCancelled else { return }
        let engine = work.engine == .foundation ? "foundation" : "appleTranslation"
        reply(work.request.id, frame: work.request.frame, text: text, error: error, engine: error == nil ? engine : nil)
        nextRequest()
    }

    private func speechAvailable(_ language: String) -> Bool {
        SFSpeechRecognizer(locale: Locale(identifier: language))?.supportsOnDeviceRecognition == true
    }

    private static func language(_ code: String?) -> String? {
        switch code {
        case "zh", "zh-CN", "zh-Hans": return "zh-Hans"
        case "vi", "vi-VN": return "vi"
        default: return nil
        }
    }

    private func reply(_ id: String, frame: WKFrameInfo, text: String? = nil, error: String? = nil, engine: String? = nil) {
        let arguments: [String: Any] = [
            "requestId": id,
            "translatedText": text.map { $0 as Any } ?? NSNull(),
            "error": error.map { $0 as Any } ?? NSNull(),
            "engine": engine.map { $0 as Any } ?? NSNull(),
        ]
        webView?.callAsyncJavaScript(
            "window.__onAppleTranslateResult?.(requestId, translatedText, error, engine)",
            arguments: arguments, in: frame, in: .page, completionHandler: { _ in }
        )
    }
}
