// Paid speech endpoints are available only to explicitly configured Site visitors.
// No credentials are included in the browser bundle or returned by this API.
const MAX_BODY = 2 * 1024 * 1024;
const MIME_TYPES = new Map([
  ['audio/mp4', 'mp4'], ['audio/x-m4a', 'mp4'], ['audio/webm', 'webm'],
  ['audio/ogg', 'ogg'], ['audio/mpeg', 'mpeg'],
]);

function json(value, status = 200, headers = {}) {
  return Response.json(value, {status, headers:{'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', ...headers}});
}
const issue = (error, code, status) => json({error, code}, status);
const emails = value => new Set(String(value || '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean));
const hasGroq = env => Boolean(String(env.GROQ_API_KEY || '').trim());
function speechEmails(env) {
  const allowed = emails(env.SPEECH_ALLOWED_EMAILS);
  if (hasGroq(env)) {
    for (const email of emails(env.SPEECH_GROQ_ALLOWED_EMAILS)) allowed.add(email);
  }
  return allowed;
}
const configured = env => Boolean(hasGroq(env) && speechEmails(env).size);
function identity(request, env) {
  const id = request.headers.get('oai-authenticated-user-id') || '';
  const email = (request.headers.get('oai-authenticated-user-email') || '').trim().toLowerCase();
  return {id, authenticated:Boolean(id), authorized:Boolean(id && email && speechEmails(env).has(email))};
}
export function getSpeechAccess(request, env) {
  return {configured: configured(env), ...identity(request, env)};
}

const boilerplate = [
  /(?:中文\s*)?字幕\s*(?:由\s*|志[愿願]者\s*[:：]?\s*|[制製]作\s*[:：]?\s*)?(?:[杨楊]茜茜|李宗盛|Amara\s*\.\s*org)(?:\s*社[区區])?(?:\s*(?:提供|[制製]作))?/giu,
  /(?:[请請]\s*(?:不要忘[记記]\s*|不吝\s*)?)?[点點][赞贊][\s、，,]*[订訂][阅閱](?:[\s、，,]*[转轉][发發])?(?:[\s、，,]*打[赏賞])?(?:[\s、，,]*支持明[镜鏡][与與][点點][点點][栏欄]目)?/gu,
  /[谢謝][谢謝]\s*[观觀]看|[杨楊]茜茜|明[镜鏡][与與][点點][点點][栏欄]目|Amara\s*\.\s*org/giu,
  /(?:hãy\s+)?subscribe\s+cho\s+kênh(?:\s+ghiền\s+mì\s+gõ)?(?:\s+để\s+không\s+bỏ\s+lỡ\s+(?:những\s+)?video(?:\s+hấp\s+dẫn)?)?|ghiền\s+mì\s+gõ/giu,
  /cảm\s+ơn\s+(?:(?:tất\s+cả\s+)?các\s+)?bạn\s+đã\s+(?:theo\s+dõi|đón\s+xem|xem)(?:\s+video)?/giu,
];

function removeBoilerplate(text) {
  const original = text.trim();
  const normalized = original.normalize('NFC');
  const filtered = boilerplate.reduce((value, pattern) => value.replace(pattern, ''), normalized);
  if (filtered === normalized) return original;
  return filtered.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '').replace(/\s{2,}/gu, ' ');
}

async function boundedBody(request) {
  if (Number(request.headers.get('Content-Length')) > MAX_BODY) throw new RangeError('BODY_TOO_LARGE');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw new RangeError('BODY_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}
function validContainer(bytes, type) {
  if (bytes.length < 8) return false;
  const ascii = (offset, value) => [...value].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  return type === 'mp4' ? ascii(4, 'ftyp')
    : type === 'webm' ? bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
    : type === 'ogg' ? ascii(0, 'OggS')
    : type === 'mpeg' ? ascii(0, 'ID3') || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0
    : false;
}

/** Best-effort per-isolate rate limiting; it is not a globally durable quota. */
export function createSpeechApi({fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 12000, limit = 20} = {}) {
  const usage = new Map();
  function allowed(id) {
    const time = now();
    for (const [key, entry] of usage) if (entry.until <= time) usage.delete(key);
    let entry = usage.get(id);
    if (!entry) {
      if (usage.size >= 10000) return false;
      entry = {until:time + 60000, count:0}; usage.set(id, entry);
    }
    if (entry.count >= limit) return false;
    entry.count++;
    return true;
  }
  return async function handleSpeechApi(request, env = {}) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/speech' && url.pathname !== '/api/speech-config') return null;
    if (url.pathname === '/api/speech-config') {
      if (request.method !== 'GET') return json({error:'不支持此请求方式。', code:'METHOD_NOT_ALLOWED'}, 405, {Allow:'GET'});
      const {configured, authenticated, authorized} = getSpeechAccess(request, env);
      return json({configured, authenticated, authorized, signInUrl:'/signin-with-chatgpt'});
    }
    if (request.method !== 'POST') return json({error:'不支持此请求方式。', code:'METHOD_NOT_ALLOWED'}, 405, {Allow:'POST'});
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return issue('请求来源不受支持。', 'FORBIDDEN', 403);
    if (!configured(env)) return issue('云端语音识别尚未配置。', 'NOT_CONFIGURED', 503);
    const user = identity(request, env);
    if (!user.authenticated) return issue('请先登录，再开启云端字幕。', 'AUTH_REQUIRED', 401);
    if (!user.authorized) return issue('此账号尚未获得云端字幕使用权限。', 'FORBIDDEN', 403);
    if (request.headers.get('X-YueLiao-Consent') !== 'speech') return issue('请先允许云端语音识别。', 'CONSENT_REQUIRED', 403);
    if (!/^multipart\/form-data(?:;|$)/i.test(request.headers.get('Content-Type') || '')) return issue('请提交音频文件。', 'INVALID_AUDIO', 400);
    let form;
    try {
      const body = await boundedBody(request);
      form = await new Request(request.url, {method:'POST', headers:{'Content-Type':request.headers.get('Content-Type')}, body}).formData();
    } catch (error) {
      if (error instanceof RangeError) return issue('音频片段过大，请缩短后重试。', 'TOO_LARGE', 413);
      return issue('无法读取音频文件。', 'INVALID_AUDIO', 400);
    }
    const file = form.get('file'), language = form.get('language');
    if (!['zh', 'vi'].includes(language)) return issue('请选择中文或越南语。', 'INVALID_LANGUAGE', 400);
    if (!file || typeof file === 'string' || !String(file.name || '').trim() || typeof file.arrayBuffer !== 'function' || !file.size || file.size > MAX_BODY) return issue('请提交有效的音频文件。', 'INVALID_AUDIO', 400);
    const mediaType = String(file.type || '').split(';')[0].trim().toLowerCase();
    const container = MIME_TYPES.get(mediaType);
    if (!container || !validContainer(new Uint8Array(await file.slice(0, 16).arrayBuffer()), container)) return issue('暂不支持此音频格式，请使用 MP4、WebM、Ogg 或 MP3。', 'INVALID_AUDIO', 400);
    if (!allowed(user.id)) return json({error:'语音识别请求过于频繁，请稍后重试。', code:'RATE_LIMIT'}, 429, {'Retry-After':'60'});

    const upstream = new FormData();
    upstream.append('file', file, file.name);
    upstream.append('model', 'whisper-large-v3');
    upstream.append('language', language);
    upstream.append('response_format', 'verbose_json');
    upstream.append('temperature', '0');
    const controller = new AbortController();
    let timeout;
    try {
      const result = await Promise.race([
        fetchImpl('https://api.groq.com/openai/v1/audio/transcriptions', {method:'POST', headers:{Authorization:`Bearer ${String(env.GROQ_API_KEY).trim()}`}, body:upstream, signal:controller.signal}),
        new Promise((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error('TIMEOUT')); }, timeoutMs); }),
      ]);
      if (result.status === 429) return issue('语音识别服务额度不足，请稍后重试。', 'RATE_LIMIT', 429);
      if (!result.ok) return issue('语音识别服务暂时不可用。', 'UNAVAILABLE', 502);
      const payload = await result.json();
      if (typeof payload?.text !== 'string') return issue('语音识别服务未返回有效文字。', 'UNAVAILABLE', 502);
      // Keep short or quiet speech when the model has a confident transcript.
      const text = Array.isArray(payload.segments)
        ? payload.segments.filter(segment => typeof segment?.text === 'string' &&
            !(segment.no_speech_prob >= 0.85 ||
              (segment.no_speech_prob >= 0.6 && !(segment.avg_logprob > -1)) ||
              segment.avg_logprob < -1.5 ||
              (segment.compression_ratio > 2.4 && segment.avg_logprob <= -1)))
          .map(segment => segment.text.trim()).filter(Boolean).join(' ')
        : payload.text;
      return json({text:Array.from(removeBoilerplate(text)).slice(0, 450).join('')});
    } catch (error) {
      return error?.message === 'TIMEOUT' ? issue('语音识别超时，请稍后重试。', 'TIMEOUT', 504)
        : issue('语音识别服务暂时不可用。', 'UNAVAILABLE', 502);
    } finally { clearTimeout(timeout); }
  };
}

export const handleSpeechApi = createSpeechApi();
