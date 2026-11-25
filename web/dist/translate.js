import {nativeChannel,nativeTranslation} from './native-translation.js?v=apple-quality-1';

const languageCode = lang => /^vi(?:-|$)/i.test(lang || '') ? 'vi' : /^zh(?:-|$)/i.test(lang || '') ? 'zh-CN' : null;
const cache = new Map();
const pending = new Map();
const preferencesKey = 'yueliao-translation-preferences';

export function translationPreferences() {
  try {
    const preferences = JSON.parse(localStorage.getItem(preferencesKey)) || {};
    return {onlineText:preferences.onlineText === true, onlineSpeech:preferences.onlineSpeech === true};
  } catch { return {onlineText:false, onlineSpeech:false}; }
}

export function setTranslationPreferences(preferences) {
  localStorage.setItem(preferencesKey, JSON.stringify(preferences));
  cache.clear();
}

export async function prepareLocalLanguages(signal) {
  for (const [fromLang,toLang] of [['zh-CN','vi'],['vi','zh-CN']]) {
    await nativeTranslation({action:'download',fromLang,toLang},signal);
  }
}

export async function translationCapabilities() {
  if (!nativeChannel('yueliaoSpeech')) return null;
  const {text}=await nativeTranslation({action:'capabilities'});
  return JSON.parse(text);
}

const fail = (message, code) => Object.assign(new Error(message), {code});

async function performTranslation(text, source, target, options, online) {
  let localError;
  if (nativeChannel('appleTranslate')) {
    try {
      const result = await nativeTranslation({
        sourceText:text, fromLang:source, toLang:target, mode:options.mode,
        conversationId:options.conversationId, messageId:options.messageId, context:options.context,
      }, options.signal);
      if (result.text.trim()) return result;
    } catch (error) {
      options.signal?.throwIfAborted();
      localError = error;
    }
  }
  if (!online || !translationPreferences().onlineText) {
    throw localError || fail('本机翻译不可用。可在智能翻译设置中允许在线备用。','OFFLINE_ONLY');
  }
  if (globalThis.navigator?.onLine === false) throw fail('当前离线，连接网络后可重试翻译。','NETWORK');
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  options.signal?.throwIfAborted();
  options.signal?.addEventListener('abort', abort, {once:true});
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch('/api/translate', {
      method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json','X-YueLiao-Consent':'translation'},
      body:JSON.stringify({text,source,target}),signal:controller.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw fail(result.error || '在线翻译暂不可用，请重试。',result.code || 'UNAVAILABLE');
    if (typeof result.text !== 'string' || !result.text.trim()) throw fail('在线翻译未返回有效内容。','UNAVAILABLE');
    return {text:result.text.trim(),provider:result.provider,model:result.model};
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

export async function translate(text, source='zh-CN', target='vi', options={}) {
  options.signal?.throwIfAborted();
  const original = typeof text === 'string' ? text.trim() : '';
  if (!original) throw fail('请输入需要翻译的内容。','EMPTY');
  if (Array.from(original).length > 450) throw fail('每条翻译最多支持 450 个字。','TOO_LONG');
  const from=languageCode(source), to=languageCode(target);
  if (!from || !to || from===to) throw fail('请选择中越互译方向。','LANGUAGE');
  const online=options.allowOnline!==false&&translationPreferences().onlineText;
  const key=JSON.stringify([from,to,original,online,options.mode,options.conversationId,options.messageId,options.context]);
  if (cache.has(key)) return {...cache.get(key)};
  if (!options.signal && pending.has(key)) return {...await pending.get(key)};
  const task=performTranslation(original,from,to,options,online);
  if (!options.signal) pending.set(key,task);
  try {
    const result=await task;
    if (options.mode!=='call') {
      if (cache.size>=150) cache.delete(cache.keys().next().value);
      cache.set(key,result);
    }
    return {...result};
  } finally { if (!options.signal) pending.delete(key); }
}

let activeSpeechReject;

/** Speaks using available device voices; resolves after playback. A new call cancels the previous call. */
export function speak(text, lang = 'vi') {
  if (!globalThis.speechSynthesis || !globalThis.SpeechSynthesisUtterance) {
    return Promise.reject(fail('当前浏览器不支持朗读，请使用 Safari 或 Chrome。', 'UNSUPPORTED'));
  }
  if (!String(text || '').trim()) return Promise.reject(fail('没有可朗读的内容。', 'EMPTY'));
  if (activeSpeechReject) activeSpeechReject(fail('已停止上一段朗读。', 'CANCELLED'));
  globalThis.speechSynthesis.cancel();
  return new Promise((resolve, reject) => {
    activeSpeechReject = reject;
    const utterance = new globalThis.SpeechSynthesisUtterance(String(text));
    utterance.lang = languageCode(lang) === 'vi' ? 'vi-VN' : 'zh-CN';
    utterance.rate = 0.9;
    const voices = globalThis.speechSynthesis.getVoices();
    const voice = voices.find(item => item.lang.toLowerCase() === utterance.lang.toLowerCase()) || voices.find(item => item.lang.toLowerCase().startsWith(utterance.lang.slice(0, 2)));
    if (voice) utterance.voice = voice;
    const clean = () => { if (activeSpeechReject === reject) activeSpeechReject = undefined; };
    utterance.onend = () => { clean(); resolve(); };
    utterance.onerror = event => {
      clean();
      reject(fail(event.error === 'canceled' || event.error === 'interrupted' ? '朗读已停止。' : '朗读不可用，请检查设备语音或音量设置。', event.error === 'canceled' || event.error === 'interrupted' ? 'CANCELLED' : 'SPEECH'));
    };
    globalThis.speechSynthesis.speak(utterance);
  });
}
