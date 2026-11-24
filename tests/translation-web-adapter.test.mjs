import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const swift = await readFile(new URL('../native-ios/YueLiao/TranslationWebAdapter.swift', import.meta.url), 'utf8');
const script = swift.split('#"""')[1].split('"""#')[0];
const messages = [];
const network = [];
const origin = 'https://yueliao.eu.cc';
const window = {
  webkit: { messageHandlers: { appleTranslate: { postMessage(message) { messages.push(message); } } } },
  async fetch(input) { network.push(input); return Response.json({ ok: true }); },
};
runInNewContext(script, {
  window, location: { origin, href: origin + '/' }, crypto: webcrypto, URL, Request, Response, setTimeout, clearTimeout,
});

const post = (signal) => window.fetch('/api/translate', {
  method: 'POST', body: JSON.stringify({ text: '你好', source: 'zh-CN', target: 'vi' }), signal,
});
const tick = () => new Promise(resolve => setImmediate(resolve));

const successful = post();
await tick();
const { requestId, sourceText, fromLang, toLang } = messages.at(-1);
assert.equal(sourceText, '你好');
assert.equal(fromLang, 'zh-CN');
assert.equal(toLang, 'vi');
window.__onAppleTranslateResult(requestId, 'Xin chào', null, 'foundation');
assert.deepEqual(await (await successful).json(), { text: 'Xin chào', provider: 'foundation' });

const unavailable = post();
await tick();
window.__onAppleTranslateResult(messages.at(-1).requestId, null, '缺少语言包');
assert.equal((await unavailable).status, 503);
assert.deepEqual(network, []);

const controller = new AbortController();
const cancelled = post(controller.signal);
await tick();
const abortId = messages.at(-1).requestId;
controller.abort();
await assert.rejects(cancelled, { name: 'AbortError' });
assert.equal(messages.at(-1).requestId, abortId);
assert.equal(messages.at(-1).action, 'cancel');

await window.fetch('/api/mailbox/test');
assert.deepEqual(network, ['/api/mailbox/test']);
console.log('PASS native adapter: local result, no cloud fallback, cancellation, unrelated request passthrough');
