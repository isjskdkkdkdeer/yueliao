// TURN credentials are issued only to registered devices. Never use a platform identity header here.
const TOKEN_RE = /^[a-f0-9]{64}$/;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 20;
const rateSchemas = new WeakMap();
async function sha256(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function allowRequest(db, actor, now) {
  let schema = rateSchemas.get(db);
  if (!schema) {
    schema = db.prepare('CREATE TABLE IF NOT EXISTS turn_api_rate_limits (actor TEXT PRIMARY KEY NOT NULL, window_start INTEGER NOT NULL, hits INTEGER NOT NULL)').run();
    rateSchemas.set(db,schema);
  }
  try { await schema; } catch (error) { rateSchemas.delete(db); throw error; }
  const bucket = Math.floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS;
  const row = await db.prepare(`INSERT INTO turn_api_rate_limits (actor,window_start,hits) VALUES (?,?,1)
    ON CONFLICT(actor) DO UPDATE SET
      window_start=CASE WHEN turn_api_rate_limits.window_start<? THEN excluded.window_start ELSE turn_api_rate_limits.window_start END,
      hits=CASE WHEN turn_api_rate_limits.window_start<? THEN 1 ELSE turn_api_rate_limits.hits+1 END
    RETURNING hits`).bind(actor,bucket,bucket,bucket).first();
  return Number(row?.hits) <= RATE_LIMIT;
}

// The credential-scoped API key stays in runtime secrets; never use an account secret.
export function createTurnApi({fetchImpl = globalThis.fetch, now = Date.now} = {}) {
  return async function handleTurnApi(request, env = {}) {
    if (new URL(request.url).pathname !== '/api/turn') return null;
    const json = (body, status = 200) => Response.json(body, {status, headers:{'Cache-Control':'no-store'}});
    if (request.method !== 'GET') return json({error:'Method not allowed'},405);
    const username = String(env.METERED_TURN_USERNAME || '').trim();
    const credential = String(env.METERED_TURN_PASSWORD || '').trim();
    const domain = String(env.METERED_DOMAIN || '').trim();
    const key = String(env.METERED_TURN_API_KEY || '').trim();
    const configured = Boolean(username || credential || domain || key);
    if (!configured) return json({configured:false});

    const token = String(request.headers.get('authorization') || '').replace(/^Bearer\s+/i,'').trim();
    if (!TOKEN_RE.test(token)) return json({error:'设备凭证无效'},401);
    if (!env.DB) return json({error:'通话服务暂时不可用'},503);
    let actor;
    try {
      actor = await sha256(token);
      const user = await env.DB.prepare('SELECT id FROM mailbox_users WHERE id=?').bind(actor).first();
      if (!user) return json({error:'请先连接好友服务'},401);
      if (!await allowRequest(env.DB,actor,now())) return json({error:'请求过于频繁，请稍后重试'},429);
    } catch { return json({error:'通话服务暂时不可用'},503); }

    if (username || credential) {
      if (!username || !credential) return json({error:'TURN 配置不完整'},503);
      return json({configured:true,iceServers:[
        {urls:'stun:stun.relay.metered.ca:80'},
        {urls:[
          'turn:global.relay.metered.ca:80',
          'turn:global.relay.metered.ca:80?transport=tcp',
          'turn:global.relay.metered.ca:443',
          'turns:global.relay.metered.ca:443?transport=tcp',
        ],username,credential},
      ]});
    }
    if (!/^[a-z0-9-]+\.metered\.live$/i.test(domain) || !key) return json({error:'TURN 配置不完整'},503);
    try {
      const url = new URL(`https://${domain}/api/v1/turn/credentials`);
      url.searchParams.set('apiKey',key);
      const response = await fetchImpl(url, {signal:AbortSignal.timeout(8000),redirect:'error'});
      if (!response.ok) throw new Error('upstream');
      const entries = await response.json();
      if (!Array.isArray(entries) || !entries.length || entries.length > 32) throw new Error('invalid');
      const iceServers = entries.map(entry => {
        const urls = typeof entry.urls === 'string' ? [entry.urls] : entry.urls;
        if (!Array.isArray(urls) || !urls.length || !urls.every(url => typeof url === 'string' && /^(stun|stuns|turn|turns):/i.test(url))) throw new Error('invalid');
        return {urls, ...(typeof entry.username === 'string' ? {username:entry.username} : {}), ...(typeof entry.credential === 'string' ? {credential:entry.credential} : {})};
      });
      if (!iceServers.some(entry => entry.urls.some(url => /^turns?:/i.test(url)) && entry.username && entry.credential)) throw new Error('missing relay');
      return json({configured:true,iceServers});
    } catch { return json({error:'TURN 中继暂时不可用，请稍后重试。'},502); }
  };
}
export const handleTurnApi = createTurnApi();
