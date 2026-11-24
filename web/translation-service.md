# Translation and speech service

`dist/translate.js` is a browser ESM module. It has no keys or third-party script dependency.

```js
import { translate, speak, createSpeechRecognition } from './translate.js';
const result = await translate('你今天过得怎么样？', 'zh-CN', 'vi');
// {text: 'Hôm nay bạn thế nào?', provider: 'phrasebook'}
await speak(result.text, 'vi');
```

`translate(text, source='zh-CN', target='vi')` supports Chinese and Vietnamese aliases (`zh`, `zh-CN`, `vi`, `vi-VN`). Maximum length is 450 Unicode characters. An exact built-in common phrase returns `provider:'phrasebook'`; other text goes to the real public MyMemory translation service and returns `provider:'mymemory'`. This means user-entered text is sent to MyMemory when it is not in the phrasebook. Make this visible near translation settings. No placeholder translations are returned on failure. A 150-entry memory cache avoids repeat requests within a page session. UTF-8 queries are split to stay below MyMemory's 500-byte query limit. Each query has a 10-second timeout. MyMemory's free quota is shared by public IP and can run out. Display the original message and allow retry when translating fails.

Errors have user-facing Chinese messages and codes `EMPTY`, `TOO_LONG`, `LANGUAGE`, `RATE_LIMIT`, `TIMEOUT`, `NETWORK`, `UNAVAILABLE`, or `TRANSLATION_FAILED`. Render returned text using `textContent`, never raw HTML.

`speak(text, lang='vi')` uses Web Speech synthesis with an installed Chinese or Vietnamese voice when available, then the device's matching language fallback. It returns a Promise resolving at playback end. Starting a second utterance cancels the first; swallow `CANCELLED` errors in the UI. Missing support rejects with `UNSUPPORTED`; device errors reject with `SPEECH`. Available voices and pronunciation depend on the OS.

```js
const recognition = createSpeechRecognition({
  language: 'zh-CN',
  onText({text, isFinal}) { /* render interim; translate/send only final */ },
  onState(state) { /* idle / starting / listening / waiting / error / unsupported */ },
  onError(error) { /* render error.message */ },
});
if (recognition.supported) recognition.start(); // after user permission; handle browser activation requirements
recognition.stop();
```

Recognition never requests permission until `start()`. It recognizes only the local microphone, not remote audio. Each participant recognizes their own audio. Video calls automatically attempt captions after the user grants call microphone access; audio calls retain a manual toggle. Send recognized text over the call's data channel for remote captions. Stop the controller when leaving a call or switching languages. Some browsers require network speech services; iPhone browser support varies. Unsupported browsers keep text translation available. A healthy recognition session restarts after a pause; permission, device, language, and network failures stop it until an explicit user retry.
