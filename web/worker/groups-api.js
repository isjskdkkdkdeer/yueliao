const ready=new WeakMap();
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
async function schema(db){if(!ready.has(db))ready.set(db,(async()=>{for(const sql of [
'CREATE TABLE IF NOT EXISTS chat_groups (id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, owner TEXT NOT NULL)',
'CREATE TABLE IF NOT EXISTS group_members (group_id TEXT NOT NULL, user_id TEXT NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY(group_id,user_id))',
'CREATE TABLE IF NOT EXISTS group_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL, sender TEXT NOT NULL, message_id TEXT NOT NULL, text TEXT NOT NULL, translation TEXT NOT NULL, lang TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(group_id,sender,message_id))',
'CREATE INDEX IF NOT EXISTS group_messages_read ON group_messages(group_id,seq)',
'CREATE INDEX IF NOT EXISTS group_members_user ON group_members(user_id)',
`CREATE TABLE IF NOT EXISTS meeting_presence (group_id TEXT NOT NULL,user_id TEXT NOT NULL,peer_id TEXT NOT NULL,seen INTEGER NOT NULL,caption TEXT NOT NULL DEFAULT '',PRIMARY KEY(group_id,user_id))`
])await db.prepare(sql).run()})().catch(e=>{ready.delete(db);throw e}));return ready.get(db)}
export async function handleGroups(path,request,db,actor,user,body){
 await schema(db);
 if(request.method!=='POST')return json({error:'请使用 POST'},405);
 const p=await body(request),now=Date.now();
 if(path==='groups-list'){
 const rows=await db.prepare('SELECT g.*, (SELECT COUNT(*) FROM group_members WHERE group_id=g.id) AS memberCount, (SELECT MAX(seq) FROM group_messages WHERE group_id=g.id) AS latest FROM chat_groups g JOIN group_members m ON m.group_id=g.id WHERE m.user_id=? LIMIT 20').bind(actor).all();return json({groups:rows.results.map(g=>({...g,isOwner:g.owner===actor,owner:undefined}))});
 }
 if(path==='groups-create'||path==='groups-join'){
 const count=await db.prepare('SELECT COUNT(*) AS n FROM group_members WHERE user_id=?').bind(actor).first();if(count.n>=20)return json({error:'最多加入 20 个群聊'},400);
 let g;
 if(path==='groups-create'){
 const name=String(p.name||'').trim();if(!name||name.length>30)return json({error:'群名需为 1–30 个字'},400);
 g={id:'group-'+crypto.randomUUID(),code:crypto.randomUUID().replaceAll('-','').slice(0,16).toUpperCase(),name,owner:actor};
 await db.prepare('INSERT INTO chat_groups(id,code,name,owner) VALUES(?,?,?,?)').bind(g.id,g.code,g.name,actor).run();
 }else{g=await db.prepare('SELECT * FROM chat_groups WHERE code=?').bind(String(p.code||'').trim().toUpperCase()).first();if(!g)return json({error:'群号不存在，请检查后重试'},404)}
 await db.prepare('INSERT OR IGNORE INTO group_members(group_id,user_id,joined_at) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM group_members WHERE group_id=?)<50').bind(g.id,actor,now,g.id).run();
 const joined=await db.prepare('SELECT * FROM group_members WHERE group_id=? AND user_id=?').bind(g.id,actor).first();if(!joined)return json({error:'群成员已满（50 人）'},409);
 return json({group:{...g,isOwner:g.owner===actor,owner:undefined}});
 }
 const membership=await db.prepare('SELECT g.*,m.joined_at FROM chat_groups g JOIN group_members m ON m.group_id=g.id WHERE g.id=? AND m.user_id=?').bind(String(p.groupId||''),actor).first();if(!membership)return json({error:'你已不在此群聊中'},403);
 const id=membership.id;
 if(path.startsWith('groups-meeting-')){
 if(path==='groups-meeting-join'){
 await db.prepare('DELETE FROM meeting_presence WHERE seen<?').bind(now-30000).run();
 const existing=await db.prepare('SELECT peer_id FROM meeting_presence WHERE group_id=? AND user_id=?').bind(id,actor).first();if(existing)return json({error:'此设备已加入会议，请先退出原会议或等待 30 秒'},409);
 const peerId='ylmeet-'+crypto.randomUUID();
 await db.prepare('INSERT OR IGNORE INTO meeting_presence(group_id,user_id,peer_id,seen) SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM meeting_presence WHERE group_id=?)<6').bind(id,actor,peerId,now,id).run();
 const own=await db.prepare('SELECT peer_id FROM meeting_presence WHERE group_id=? AND user_id=?').bind(id,actor).first();if(!own)return json({error:'会议已满，最多 6 人'},409);return json({peerId:own.peer_id});
 }
 if(path==='groups-meeting-leave'){await db.prepare('DELETE FROM meeting_presence WHERE group_id=? AND user_id=? AND peer_id=?').bind(id,actor,String(p.peerId||'')).run();return json({ok:true})}
 const own=await db.prepare('SELECT peer_id FROM meeting_presence WHERE group_id=? AND user_id=? AND seen>?').bind(id,actor,now-30000).first();if(!own||own.peer_id!==p.peerId)return json({error:'会议已断开，请重新加入'},409);
 if(path==='groups-meeting-caption'){
 const c=p.caption;if(!c||typeof c.text!=='string'||c.text.length>1800||typeof c.translation!=='string'||c.translation.length>3600)return json({error:'字幕格式错误'},400);
 await db.prepare('UPDATE meeting_presence SET caption=? WHERE group_id=? AND user_id=?').bind(JSON.stringify({id:crypto.randomUUID(),text:c.text,translation:c.translation,lang:c.lang==='vi'?'vi':'zh'}),id,actor).run();return json({ok:true});
 }
 if(path==='groups-meeting-poll'){
 await db.prepare('UPDATE meeting_presence SET seen=? WHERE group_id=? AND user_id=?').bind(now,id,actor).run();
 const rows=await db.prepare('SELECT p.peer_id AS peerId,u.name,p.caption FROM meeting_presence p JOIN group_members m ON m.group_id=p.group_id AND m.user_id=p.user_id JOIN mailbox_users u ON u.id=p.user_id WHERE p.group_id=? AND p.seen>?').bind(id,now-30000).all();return json({participants:rows.results.map(r=>({...r,caption:r.caption?JSON.parse(r.caption):null}))});
 }
 return json({error:'会议接口不存在'},404);
 }
 if(path==='groups-history'){
 const after=Number(p.after)||0;if(!Number.isSafeInteger(after)||after<0)return json({error:'无效游标'},400);
 const rows=await db.prepare(`SELECT m.*,u.name AS senderName FROM group_messages m JOIN mailbox_users u ON u.id=m.sender WHERE m.group_id=? AND m.seq>? AND m.created_at>=? ORDER BY m.seq ${after?'ASC':'DESC'} LIMIT 100`).bind(id,after,Math.max(membership.joined_at,now-30*86400000)).all();
 const messages=rows.results.map(m=>({id:m.message_id,seq:m.seq,kind:'text',text:m.text,translation:m.translation,lang:m.lang,senderName:m.senderName,senderId:m.sender,out:m.sender===actor,createdAt:m.created_at}));if(!after)messages.reverse();return json({messages});
 }
 if(path==='groups-send'){
 const m=p.message;if(!m||typeof m.id!=='string'||!/^[-a-zA-Z0-9_]{4,80}$/.test(m.id)||typeof m.text!=='string'||!m.text.trim()||m.text.length>450||typeof (m.translation??'')!=='string'||(m.translation||'').length>3600)return json({error:'消息格式不正确或内容太长'},400);
 const count=await db.prepare('SELECT COUNT(*) AS n FROM group_messages WHERE sender=? AND created_at>?').bind(actor,now-60000).first();if(count.n>=30)return json({error:'发送太快，请稍后再试'},429);
 await db.prepare('INSERT OR IGNORE INTO group_messages(group_id,sender,message_id,text,translation,lang,created_at) VALUES(?,?,?,?,?,?,?)').bind(id,actor,m.id,m.text,m.translation||'',m.lang==='vi'?'vi':'zh',now).run();
 await db.prepare('DELETE FROM group_messages WHERE seq IN (SELECT seq FROM group_messages WHERE created_at<? LIMIT 100)').bind(now-30*86400000).run();return json({ok:true});
 }
 if(path==='groups-members'){const rows=await db.prepare('SELECT u.name,u.peer_id,m.user_id FROM group_members m JOIN mailbox_users u ON u.id=m.user_id WHERE m.group_id=? ORDER BY m.joined_at').bind(id).all();return json({members:rows.results.map(m=>({name:m.name,peerId:m.peer_id,isOwner:m.user_id===membership.owner}))})}
 if(path==='groups-leave'){
 if(membership.owner===actor)return json({error:'群主请使用解散群聊'},400);
 await db.prepare('DELETE FROM group_members WHERE group_id=? AND user_id=?').bind(id,actor).run();await db.prepare('DELETE FROM meeting_presence WHERE group_id=? AND user_id=?').bind(id,actor).run();return json({ok:true});
 }
 if(path==='groups-dissolve'){
 if(membership.owner!==actor)return json({error:'只有群主可以解散群聊'},403);
 await db.prepare('DELETE FROM chat_groups WHERE id=?').bind(id).run();
 await db.prepare('DELETE FROM group_members WHERE group_id=?').bind(id).run();
 await db.prepare('DELETE FROM group_messages WHERE group_id=?').bind(id).run();return json({ok:true});
 }
 return json({error:'群聊操作不存在'},404);
}
