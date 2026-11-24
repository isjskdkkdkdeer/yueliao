import {handleGroups} from './groups-api.js';
import {sendPush,configured} from './notify-api.js';
const validID = value => typeof value==='string' && /^[A-Za-z0-9_-]{4,80}$/.test(value);
const validCloud = value => typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
const json = (data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');
async function body(request){
  if(Number(request.headers.get('content-length'))>950000)throw Error('请求太大');
  const reader=request.body?.getReader();if(!reader)return {};
  let size=0;const parts=[];
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>950000){await reader.cancel();throw Error('请求太大')}parts.push(value)}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length}return JSON.parse(new TextDecoder().decode(bytes));
}
export async function handleMailboxApi(request,env={},ctx){
  const url=new URL(request.url);if(!url.pathname.startsWith('/api/mailbox/'))return null;
  if(!env.DB)return json({error:'离线消息服务尚未启用'},503);
  const origin=request.headers.get('origin');
  if(origin&&origin!==url.origin)return json({error:'禁止跨站请求'},403);
  const token=(request.headers.get('authorization')||'').replace(/^Bearer /,'');
  if(!/^[a-f0-9]{64}$/.test(token))return json({error:'设备凭证无效'},401);
  const actor=await hash(token), db=env.DB;
  try{
    const path=url.pathname.slice('/api/mailbox/'.length);
    if(path==='register'&&request.method==='POST'){
      const p=await body(request);
      if(!validID(p.id)||typeof p.name!=='string')return json({error:'资料格式不正确'},400);
      await db.prepare('INSERT INTO mailbox_users (id,peer_id,name,language) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET peer_id=excluded.peer_id,name=excluded.name,language=excluded.language').bind(actor,p.id,p.name.slice(0,40),p.language==='vi'?'vi':'zh').run();
      return json({cloudId:actor});
    }
    const user=await db.prepare('SELECT id,peer_id,name,language FROM mailbox_users WHERE id=?').bind(actor).first();
    if(!user)return json({error:'请先登记当前设备'},401);
    if(path.startsWith('groups-'))return await handleGroups(path,request,db,actor,user,body);
    if(path==='remove-contact'&&request.method==='POST'){
      const p=await body(request);if(!validCloud(p.cloudId))return json({error:'好友格式不正确'},400);
      await db.prepare('DELETE FROM mailbox_contacts WHERE owner=? AND sender=?').bind(actor,p.cloudId).run();
      return json({ok:true});
    }
    if(path==='contacts'&&request.method==='POST'){
      const p=await body(request);if(!validCloud(p.cloudId)||!validID(p.id)||p.cloudId===actor)return json({error:'好友格式不正确'},400);
      await db.prepare('INSERT INTO mailbox_contacts (owner,sender,peer_id) VALUES (?,?,?) ON CONFLICT(owner,sender) DO UPDATE SET peer_id=excluded.peer_id').bind(actor,p.cloudId,p.id).run();
      return json({ok:true});
    }
    if(path==='send'&&request.method==='POST'){
      const p=await body(request),m=p.message;
      if(!validCloud(p.to)||!m||!validID(m.id)||!['text','image','audio'].includes(m.kind)||typeof m.text!=='string'&&m.kind==='text')return json({error:'消息格式不正确'},400);
      if((m.text||'').length>1800||(m.translation||'').length>3600)return json({error:'消息太长'},400);
      if(m.kind!=='text'&&(typeof m.url!=='string'||!/^data:(image\/(jpeg|png|webp)|audio\/(webm|ogg|mp4));/i.test(m.url)||m.url.length>900000))return json({error:'附件格式不正确'},400);
      const permitted=await db.prepare('SELECT peer_id FROM mailbox_contacts WHERE owner=? AND sender=?').bind(p.to,actor).first();
      if(!permitted||permitted.peer_id!==user.peer_id)return json({error:'请双方先打开新版并连接一次，再使用离线消息'},403);
      const count=await db.prepare('SELECT COUNT(*) AS total FROM mailbox_messages WHERE recipient=?').bind(p.to).first();
      if(count.total>=300)return json({error:'对方待收消息已满，请等对方上线'},429);
      const payload=JSON.stringify({id:m.id,kind:m.kind,text:String(m.text||''),translation:String(m.translation||''),url:m.kind==='text'?undefined:m.url,lang:m.lang==='vi'?'vi':'zh'});
      const inserted=await db.prepare('INSERT INTO mailbox_messages (sender,recipient,message_id,payload,created_at) VALUES (?,?,?,?,?) ON CONFLICT(sender,recipient,message_id) DO NOTHING').bind(actor,p.to,m.id,payload,Date.now()).run();
      if(configured(env)&&inserted.meta?.changes){const task=sendPush(env,p.to,{type:'message',peerId:user.peer_id,title:user.name,body:m.kind==='image'?'[图片]':m.kind==='audio'?'[语音消息]':'你收到一条新消息'}).catch(()=>{});if(ctx?.waitUntil)ctx.waitUntil(task);else await task}
      return json({stored:true});
    }
    if(path==='inbox'&&request.method==='GET'){
      // Indexed, bounded expiry cleanup. The server retains only pending messages.
      await db.prepare('DELETE FROM mailbox_messages WHERE seq IN (SELECT seq FROM mailbox_messages WHERE created_at<? LIMIT 100)').bind(Date.now()-30*86400000).run();
      const rows=await db.prepare('SELECT m.seq,m.payload,m.created_at,u.peer_id,u.name,u.language,m.sender FROM mailbox_messages m JOIN mailbox_users u ON u.id=m.sender WHERE m.recipient=? ORDER BY m.seq LIMIT 20').bind(actor).all();
      return json({messages:rows.results.map(row=>({seq:row.seq,sender:{id:row.peer_id,name:row.name,language:row.language,cloudId:row.sender},message:JSON.parse(row.payload),createdAt:row.created_at}))});
    }
    if(path==='ack'&&request.method==='POST'){
      const p=await body(request);if(!Array.isArray(p.ids)||p.ids.length>20||!p.ids.every(Number.isSafeInteger))return json({error:'确认格式不正确'},400);
      if(p.ids.length)await db.prepare(`DELETE FROM mailbox_messages WHERE recipient=? AND seq IN (${p.ids.map(()=>'?').join(',')})`).bind(actor,...p.ids).run();
      return json({ok:true});
    }
    return json({error:'接口不存在'},404);
  }catch{return json({error:'离线消息暂时不可用，请稍后重试'},503)}
}
