import {buildPushPayload} from '@block65/webcrypto-web-push';
const json=(v,s=200)=>Response.json(v,{status:s,headers:{'Cache-Control':'no-store'}});
const hash=async s=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(x=>x.toString(16).padStart(2,'0')).join('');
export const configured=env=>!!(env.SUPABASE_URL&&env.SUPABASE_SERVICE_ROLE_KEY&&env.VAPID_PUBLIC_KEY&&env.VAPID_PRIVATE_KEY&&env.VAPID_SUBJECT);
export async function store(env,table,query='',method='GET',body){
  if(!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(env.SUPABASE_URL||''))throw Error('Supabase URL');
  const r=await fetch(`${env.SUPABASE_URL.replace(/\/$/,'')}/rest/v1/${table}${query}`,{method,headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,'Content-Type':'application/json',Prefer:'return=representation'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
  if(!r.ok)throw Error('Supabase unavailable');return r.status===204?[]:r.json();
}
export function validEndpoint(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&(u.hostname==='web.push.apple.com'||u.hostname.endsWith('.push.apple.com')||u.hostname==='fcm.googleapis.com'||u.hostname==='updates.push.services.mozilla.com'||u.hostname.endsWith('.notify.windows.com'))}catch{return false}}
export async function sendPush(env,recipient,data){
  if(!configured(env))return;
  const subscriptions=await store(env,'yl_push',`?owner=eq.${recipient}&limit=5`);
  await Promise.allSettled(subscriptions.map(async row=>{
    if(!validEndpoint(row.subscription?.endpoint))return;
    const payload=await buildPushPayload({data:JSON.stringify(data),options:{ttl:data.type==='call'?60:86400}},row.subscription,{subject:env.VAPID_SUBJECT,publicKey:env.VAPID_PUBLIC_KEY,privateKey:env.VAPID_PRIVATE_KEY});
    const r=await fetch(row.subscription.endpoint,{...payload,redirect:'error',signal:AbortSignal.timeout(8000)});
    if(r.status===404||r.status===410)await store(env,'yl_push',`?id=eq.${row.id}`,'DELETE');
  }));
}
export async function handleNotifyApi(request,env){
 const u=new URL(request.url);if(!u.pathname.startsWith('/api/notify/'))return null;
 if(u.pathname==='/api/notify/config')return json({configured:configured(env),publicKey:configured(env)?env.VAPID_PUBLIC_KEY:null});
 if(!configured(env)||!env.DB)return json({error:'推送和云端来电尚未配置，请查看通知设置'},503);
 if(request.headers.get('origin')&&request.headers.get('origin')!==u.origin)return json({error:'禁止跨站请求'},403);
 const secret=(request.headers.get('authorization')||'').replace(/^Bearer /,'');if(!/^[a-f0-9]{64}$/.test(secret))return json({error:'设备凭证无效'},401);
 const actor=await hash(secret),user=await env.DB.prepare('SELECT id,peer_id,name,language FROM mailbox_users WHERE id=?').bind(actor).first();if(!user)return json({error:'请先连接聊天服务'},401);
 try{
  let p={};if(request.method==='POST'){const reader=request.body?.getReader();let size=0,parts=[];if(reader){while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>12000){await reader.cancel();return json({error:'请求过大'},413)}parts.push(value)}}const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length}p=JSON.parse(new TextDecoder().decode(bytes))}
  const path=u.pathname.slice('/api/notify/'.length);
  if(path==='subscribe'&&request.method==='POST'){
   const s=p.subscription;if(!validEndpoint(s?.endpoint)||!/^B[A-Za-z0-9_-]{86}$/.test(s.keys?.p256dh||'')||!/^[A-Za-z0-9_-]{22}$/.test(s.keys?.auth||''))return json({error:'推送订阅无效'},400);
   const id=await hash(s.endpoint);const previous=await store(env,'yl_push',`?id=eq.${id}`);if(previous.length&&previous[0].owner!==actor)return json({error:'订阅已属于其他设备'},403);
   if(!previous.length){const rows=await store(env,'yl_push',`?owner=eq.${actor}&select=id`);if(rows.length>=5)return json({error:'订阅数量已满'},429);await store(env,'yl_push','','POST',{id,owner:actor,subscription:s})}else await store(env,'yl_push',`?id=eq.${id}`,'PATCH',{subscription:s});
   return json({ok:true});
  }
  if(path==='unsubscribe'&&request.method==='POST'){await store(env,'yl_push',`?owner=eq.${actor}`,'DELETE');return json({ok:true})}
  if(path==='calls'&&request.method==='GET'){
   const time=new Date().toISOString();await store(env,'yl_calls',`?or=(caller.eq.${actor},recipient.eq.${actor})&status=in.(ringing,accepted)&expires_at=lt.${encodeURIComponent(time)}`,'PATCH',{status:'missed'});
   return json({calls:await store(env,'yl_calls',`?or=(caller.eq.${actor},recipient.eq.${actor})&order=created_at.desc&limit=40`),actor});
  }
  if(path==='invite'&&request.method==='POST'){
   if(!/^[a-f0-9]{64}$/.test(p.to)||!['audio','video'].includes(p.kind)||!/^[a-zA-Z0-9_-]{4,80}$/.test(p.id))return json({error:'来电格式无效'},400);
   const allowed=await env.DB.prepare('SELECT peer_id FROM mailbox_contacts WHERE owner=? AND sender=?').bind(p.to,actor).first();if(!allowed||allowed.peer_id!==user.peer_id)return json({error:'请双方先打开新版并连接一次'},403);
   const target=await env.DB.prepare('SELECT peer_id,name FROM mailbox_users WHERE id=?').bind(p.to).first();if(!target)return json({error:'好友未登记'},404);
   const recent=await store(env,'yl_calls',`?caller=eq.${actor}&created_at=gt.${encodeURIComponent(new Date(Date.now()-60000).toISOString())}&select=id`);if(recent.length>=5)return json({error:'呼叫太频繁，请稍后再试'},429);
   const existing=await store(env,'yl_calls',`?id=eq.${p.id}`);if(existing.length)return json({error:'重复呼叫'},409);
   const row={id:p.id,caller:actor,recipient:p.to,caller_peer:user.peer_id,caller_name:user.name,recipient_peer:target.peer_id,recipient_name:target.name,kind:p.kind,status:'ringing',expires_at:new Date(Date.now()+60000).toISOString()};
   await store(env,'yl_calls','','POST',row);
   await sendPush(env,p.to,{type:'call',callId:p.id,peerId:user.peer_id,title:user.name,body:p.kind==='video'?'视频来电 · 点击进入接听页面':'语音来电 · 点击进入接听页面'}).catch(()=>{});
   return json({call:row});
  }
  if(path==='update'&&request.method==='POST'){
   if(!/^[a-zA-Z0-9_-]{4,80}$/.test(p.id))return json({error:'通话无效'},400);
   const [row]=await store(env,'yl_calls',`?id=eq.${p.id}`);if(!row||![row.caller,row.recipient].includes(actor))return json({error:'通话不存在'},404);
   const recipient=row.recipient===actor;
   const allowed=p.status==='accepted'?recipient&&row.status==='ringing':p.status==='declined'?recipient&&row.status==='ringing':p.status==='connected'?['accepted','connected'].includes(row.status):p.status==='ended'?['ringing','accepted','connected'].includes(row.status):p.status==='missed'?['ringing','accepted'].includes(row.status):false;
   if(!allowed)return json({error:'来电已结束或状态无效'},409);
   if(['accepted','connected'].includes(p.status)&&Date.parse(row.expires_at)<Date.now()&&row.status!=='connected')return json({error:'来电已过期'},409);
   const status=p.status==='ended'&&row.status!=='connected'?'cancelled':p.status;
   await store(env,'yl_calls',`?id=eq.${p.id}&status=eq.${row.status}`,'PATCH',{status});return json({ok:true});
  }
  return json({error:'接口不存在'},404);
 }catch{return json({error:'通知服务暂时不可用，请稍后重试'},503)}
}
