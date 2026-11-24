enum TranslationWebAdapter {
    // Adapt the live site's same-origin translation endpoint to the native bridge.
    static let source = #"""
    (() => {
      if (location.origin !== 'https://yueliao.eu.cc') return;
      const bridge = window.webkit?.messageHandlers?.appleTranslate;
      if (!bridge) return;
      const originalFetch = window.fetch.bind(window);
      const pending = new Map();
      const previousCallback = window.__onAppleTranslateResult;

      window.__onAppleTranslateResult = (id, text, error, engine) => {
        const callback = pending.get(id);
        if (callback) callback(text, error, engine);
        else previousCallback?.(id, text, error, engine);
      };

      const failure = (error, code, status) => Response.json({error, code}, {status});
      window.fetch = async (input, init) => {
        const existing = input instanceof Request;
        const url = new URL(existing ? input.url : input, location.href);
        const method = String(init?.method ?? (existing ? input.method : 'GET')).toUpperCase();
        if (method !== 'POST' || url.origin !== location.origin || url.pathname !== '/api/translate') {
          return originalFetch(input, init);
        }

        const request = new Request(existing ? input : url, init);
        const signal = request.signal;
        signal.throwIfAborted();
        const data = await request.json().catch(() => null);
        signal.throwIfAborted();
        if (!data || typeof data.text !== 'string' || typeof data.source !== 'string' || typeof data.target !== 'string') {
          return failure('无法读取翻译请求。', 'INVALID_INPUT', 400);
        }
        if (pending.size >= 9) return failure('本机翻译请求过多。', 'RATE_LIMIT', 429);

        return new Promise((resolve, reject) => {
          const requestId = crypto.randomUUID();
          const cleanup = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            pending.delete(requestId);
          };
          const cancelNative = () => {
            try { bridge.postMessage({requestId, action: 'cancel'}); } catch {}
          };
          const abort = () => {
            cleanup();
            cancelNative();
            reject(signal.reason);
          };
          const timer = setTimeout(() => {
            cleanup();
            cancelNative();
            resolve(failure('本机翻译超时，请重试。', 'TIMEOUT', 504));
          }, 12000);

          pending.set(requestId, (text, error, engine) => {
            cleanup();
            if (error || typeof text !== 'string' || !text.trim()) {
              resolve(failure(error || '本机翻译暂不可用。', 'UNAVAILABLE', 503));
            } else {
              resolve(Response.json({text, provider: engine || 'appleTranslation'}));
            }
          });
          signal.addEventListener('abort', abort, {once: true});
          try {
            bridge.postMessage({requestId, sourceText: data.text, fromLang: data.source, toLang: data.target});
          } catch {
            cleanup();
            resolve(failure('本机翻译通道暂不可用。', 'UNAVAILABLE', 503));
          }
        });
      };
    })();
    """#
}
