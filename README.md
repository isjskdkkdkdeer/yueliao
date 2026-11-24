# 越聊 iOS

这个仓库使用 GitHub Actions 生成现有 iOS 工程，构建供 SideStore 重签的未签名 IPA。应用通过 WKWebView 加载 `https://yueliao.eu.cc/`，复用网站上的账号、朋友、会话和通话。聊天数据库与网站前后端不在这个仓库中。

`.github/workflows/build-yueliao.yml` 定义打包流程。成功运行后，从 Actions 的 Artifacts 下载 `YueLiao.ipa`。构建日志在 `yueliao-build-log`。

## 原生文字翻译配置

原生翻译支持 iOS 18 或更新版本。自动模式依次尝试端侧 Foundation Models、苹果高保真策略和传统低延迟策略。Foundation Models 需要 iOS 26 或更新版本、模型就绪且支持中越两种语言。策略选择需要 iOS 26.4 和对应 SDK。低延迟模式优先尝试传统策略。苹果系统可能自行选择底层模型，因此桥接将两种策略的结果统一标记为 `appleTranslation`。

Web 调用沿用受信任主页里的 `window.webkit.messageHandlers.appleTranslate`。请求的必填字段是 UUID 格式的 `requestId`、`sourceText`、`fromLang`、`toLang`。语言支持 `zh` 和 `vi`。回调仍为 `window.__onAppleTranslateResult(requestId, translatedText, error)`，第四个可选参数为引擎标签。

- 可选 `engine` 支持 `foundation`、`highFidelity`、`lowLatency`。省略时自动选择。
- 可选 `conversationId` 与 `messageId` 用于隔离本机内存缓存。每次请求只使用调用方显式提供的 `context`。支持 `recent`（最多五条含 `speaker` 与 `text` 的记录）、`style`、`sender`、`recipient`、`relationship` 和 `vocabulary`。没有 `conversationId` 时忽略上下文。
- 可选 `mode: "call"` 优先低延迟策略。此参数可供字幕客户端调用。
- `action: "cancel"` 以原请求 ID 取消，`action: "clearCache"` 清空内存缓存，`action: "download"` 用中越语言方向请求系统安装传统翻译语言包。
- 桥接返回独立译文。失败时返回错误，调用方可继续展示原文。此桥接路径中的原文及上下文只在设备端处理。网站自己发起的在线翻译由网站控制。

## 验收语料

`tests/translation-corpus.tsv` 包含 50 对人工编写的中越参考句，双向评测共 100 条。情侣及亲属称呼需配套明确关系上下文，其他情况下以中性称呼为参考。评测请按引擎、方向和设备记录成功率、完成耗时、语义准确性、口语自然度和涉及称呼的准确率。参考译文允许同义表达。

实机验收应分别测试，两种语言方向、语言包安装前后、飞行模式、关闭 Apple Intelligence、旧款设备、快速切换会话和原有语音及视频通话。

App 壳在主页加载时把站点的同源 `POST /api/translate` 请求接入原生桥。桥接超时或本机不可用时返回错误。当前 App 不自动调用线上翻译，也未接入 GLM。浏览器仍使用站点现有逻辑。网页若在发请求前主动判断离线并退出，壳无法接管该次调用。

## 通话实时字幕

新版托管页面使用 `yueliaoSpeech` 桥把现有 WebRTC 本地麦克风轨的 PCM 送到 Swift。桥要求 Apple Speech 的本机识别能力，不另开麦克风，不请求 Apple 的在线识别。页面通过已有的点对点通道发送字幕原文，接收方调用同一个苹果翻译桥。通话优先低延迟策略。网站在设备不支持本机识别时，可以按用户授权使用 Groq。没有授权时仍可正常通话或手动输入字幕。

GLM 密钥由站点托管环境的 `GLM_API_KEY` Secret 提供。在线文字翻译和云端语音识别在「我的 → 智能翻译」分别授权，初始关闭。点对点通话不会广播译文或播报合成声音。

双设备验收需测试普通话和越南语同时说话、静音、挂断、耳机与扬声器、飞行模式下的引擎能力、权限拒绝、在线回退与弱网恢复。
