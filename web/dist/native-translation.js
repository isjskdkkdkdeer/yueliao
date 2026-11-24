const requests = new Map();
let callbackInstalled = false;

export function nativeChannel(name) {
  return globalThis.window?.webkit?.messageHandlers?.[name];
}

export function nativeTranslation(payload, signal) {
  const channel = nativeChannel('appleTranslate');
  if (!channel) return Promise.reject(Object.assign(Error('此设备没有苹果翻译桥接。'), {code:'NO_NATIVE'}));
  if (!callbackInstalled) {
    const previous = window.__onAppleTranslateResult;
    window.__onAppleTranslateResult = (id, text, error, engine) => {
      const receive = requests.get(id);
      if (receive) receive(text, error, engine);
      else previous?.(id, text, error, engine);
    };
    callbackInstalled = true;
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const requestId = crypto.randomUUID();
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      requests.delete(requestId);
    };
    const cancel = () => {
      try { channel.postMessage({requestId, action:'cancel'}); } catch {}
    };
    const abort = () => { finish(); cancel(); reject(signal.reason); };
    const timer = setTimeout(() => {
      finish(); cancel(); reject(Error('本机翻译超时。'));
    }, payload.action === 'download' ? 300000 : payload.mode === 'call' ? 3200 : 12000);
    requests.set(requestId, (text, error, engine) => {
      finish();
      if (error || typeof text !== 'string') reject(Error(error || '本机翻译不可用。'));
      else resolve({text, provider:engine || 'appleTranslation'});
    });
    signal?.addEventListener('abort', abort, {once:true});
    try { channel.postMessage({...payload,requestId}); }
    catch (error) { finish(); reject(error); }
  });
}
