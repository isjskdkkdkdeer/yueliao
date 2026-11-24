import AVFoundation
import Foundation
import Speech
import WebKit

@MainActor
final class AppleSpeechBridge: NSObject, WKScriptMessageHandler {
    private struct Feed {
        let id: String
        let frame: WKFrameInfo
        let format: AVAudioFormat
        let recognizer: SFSpeechRecognizer
    }

    private weak var webView: WKWebView?
    private var feed: Feed?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognition: SFSpeechRecognitionTask?
    private var token = UUID()
    private var endTimer: Task<Void, Never>?
    private var trailingSilence = 0.0
    private var utteranceDuration = 0.0
    private var noiseFloor = 0.003
    private var lastText = ""
    private var preRoll: AVAudioPCMBuffer?

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let frame = message.frameInfo
        let origin = frame.securityOrigin
        guard frame.isMainFrame, origin.protocol == "https", origin.host == "yueliao.eu.cc",
              origin.port == 0 || origin.port == 443,
              let webView = message.webView, let body = message.body as? [String: Any],
              let id = body["id"] as? String, UUID(uuidString: id) != nil else { return }
        switch body["action"] as? String {
        case "start":
            close()
            self.webView = webView
            guard let language = body["language"] as? String, ["zh-CN", "vi-VN"].contains(language),
                  let rate = body["sampleRate"] as? Double, (8_000...96_000).contains(rate),
                  let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false),
                  let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)),
                  recognizer.supportsOnDeviceRecognition else {
                send(id: id, frame: frame, event: ["error": "此设备不支持该语言的本机语音识别。"])
                return
            }
            feed = Feed(id: id, frame: frame, format: format, recognizer: recognizer)
            SFSpeechRecognizer.requestAuthorization { [weak self] status in
                Task { @MainActor in
                    guard let self, let feed = self.feed, feed.id == id else { return }
                    guard status == .authorized, feed.recognizer.isAvailable else {
                        self.send(id: id, frame: frame, event: ["error": "本机语音识别权限或服务不可用。"])
                        self.close()
                        return
                    }
                    self.send(id: id, frame: frame, event: ["state": "ready"])
                }
            }
        case "pcm":
            guard let feed, feed.id == id,
                  let pcm = body["pcm"] as? String, pcm.utf8.count <= 12_000,
                  let bytes = Data(base64Encoded: pcm), !bytes.isEmpty,
                  bytes.count <= 8192, bytes.count.isMultiple(of: 2) else { return }
            append(bytes, to: feed)
        case "stop":
            if feed?.id == id { close() }
        default:
            break
        }
    }

    func close() {
        feed = nil
        preRoll = nil
        noiseFloor = 0.003
        clearUtterance()
    }

    private func clearUtterance() {
        token = UUID()
        endTimer?.cancel()
        endTimer = nil
        recognition?.cancel()
        recognition = nil
        request = nil
        trailingSilence = 0
        utteranceDuration = 0
        lastText = ""
    }

    private func append(_ bytes: Data, to feed: Feed) {
        guard endTimer == nil else { return }
        let count = bytes.count / 2
        guard let buffer = AVAudioPCMBuffer(pcmFormat: feed.format, frameCapacity: AVAudioFrameCount(count)),
              let samples = buffer.floatChannelData?[0] else { return }
        buffer.frameLength = AVAudioFrameCount(count)
        var energy = 0.0
        bytes.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            for index in 0..<count {
                let low = UInt16(raw[index * 2])
                let high = UInt16(raw[index * 2 + 1])
                let sample = Float(Int16(bitPattern: low | (high << 8))) / 32768
                samples[index] = sample
                energy += Double(sample * sample)
            }
        }
        let rms = sqrt(energy / Double(count))
        let audible = rms >= max(0.008, noiseFloor * 3)
        let duration = Double(count) / feed.format.sampleRate
        if request == nil {
            guard audible else {
                noiseFloor = noiseFloor * 0.94 + rms * 0.06
                preRoll = buffer
                return
            }
            startUtterance(feed)
            if let preRoll { request?.append(preRoll) }
            preRoll = nil
        }
        request?.append(buffer)
        utteranceDuration += duration
        trailingSilence = audible ? 0 : trailingSilence + duration
        if trailingSilence >= 0.55 || utteranceDuration >= 12 {
            request?.endAudio()
            let ending = token
            endTimer = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(550))
                guard let self, !Task.isCancelled, self.token == ending else { return }
                self.complete(feed)
            }
        }
    }

    private func startUtterance(_ feed: Feed) {
        let audio = SFSpeechAudioBufferRecognitionRequest()
        audio.requiresOnDeviceRecognition = true
        audio.shouldReportPartialResults = true
        audio.addsPunctuation = true
        request = audio
        let current = token
        recognition = feed.recognizer.recognitionTask(with: audio) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let final = result?.isFinal == true
            let failed = error != nil
            Task { @MainActor in
                guard let self, self.token == current, self.feed?.id == feed.id else { return }
                if let text, !text.isEmpty, text != self.lastText {
                    self.lastText = text
                    if !final { self.send(id: feed.id, frame: feed.frame, event: ["text": text, "final": false]) }
                }
                if final || failed { self.complete(feed) }
            }
        }
    }

    private func complete(_ feed: Feed) {
        if !lastText.isEmpty {
            send(id: feed.id, frame: feed.frame, event: ["text": lastText, "final": true])
        }
        clearUtterance()
    }

    private func send(id: String, frame: WKFrameInfo, event: [String: Any]) {
        webView?.callAsyncJavaScript(
            "window.__onYueLiaoSpeech?.(id, event)",
            arguments: ["id": id, "event": event], in: frame, in: .page, completionHandler: { _ in }
        )
    }
}
