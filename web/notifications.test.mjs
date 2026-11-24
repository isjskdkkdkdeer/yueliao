import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {handleNotifyApi,validEndpoint} from './worker/notify-api.js';
const digest=async s=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))).toString('hex');
const a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64),actor=await digest(a),recipient=await digest(b),other=await digest(c);
const users=new Map([[actor,{id:actor,peer_id:'yueliao-aabbccdd',name:'甲'}],[recipient,{id:recipient,peer_id:'yueliao-ddccbbaa',name:'乙'}],[other,{id:other,peer_id:'yueliao-cccccccc',name:'丙'}]]);
const tables={yl_calls:[],yl_push:[]};
const original=globalThis.fetch;
globalThis.fetch=async(url,options={})=>{
 const u=new URL(url),table=u.pathname.split('/').at(-1);assert.ok(tables[table]);
 function matches(row){for(const [key,v] of u.searchParams){if(['order','limit','select','or'].includes(key))continue;if(v.startsWith('eq.')&&String(row[key])!==v.slice(3))return false;if(v.startsWith('lt.')&&!(row[key]<v.slice(3)))return false;if(v.startsWith('gt.')&&!(row[key]>v.slice(3)))return false;if(v.startsWith('in.')&&!v.slice(4,-1).split(',').includes(row[key]))return false}const or=u.searchParams.get('or');if(or&&!or.slice(1,-1).split(',').some(x=>{const [k,,v]=x.split('.');return row[k]===v}))return false;return true}
 let rows=tables[table].filter(matches);const method=options.method||'GET';
 if(method==='POST'){const row={created_at:new Date().toISOString(),...JSON.parse(options.body)};tables[table].push(row);rows=[row]}
 if(method==='PATCH')rows.forEach(r=>Object.assign(r,JSON.parse(options.body)));
 if(method==='DELETE')tables[table]=tables[table].filter(r=>!rows.includes(r));
 return Response.json(rows);
};
const env={SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'server-only',VAPID_PUBLIC_KEY:'public',VAPID_PRIVATE_KEY:'private',VAPID_SUBJECT:'mailto:test@example.com',DB:{prepare(sql){return {bind(...args){return {async first(){if(sql.includes('mailbox_users'))return users.get(args[0]);if(sql.includes('mailbox_contacts'))return args[0]===recipient&&args[1]===actor?{peer_id:users.get(actor).peer_id}:null}}}}}}};
async function api(path,token=a,data){const r=await handleNotifyApi(new Request(`https://example.test/api/notify/${path}`,{method:data?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined}),env);return {status:r.status,body:await r.json()}}
try{
 const conf=await handleNotifyApi(new Request('https://example.test/api/notify/config'),{});assert.equal((await conf.json()).configured,false);
 assert.equal((await api('calls','bad')).status,401);
 assert.equal((await api('invite',a,{to:other,kind:'video',id:'call-invalid'})).status,403);
 assert.equal((await api('invite',a,{to:recipient,kind:'video',id:'call-test-1'})).status,200);
 assert.equal((await api('update',c,{id:'call-test-1',status:'accepted'})).status,404);
 assert.equal((await api('update',a,{id:'call-test-1',status:'accepted'})).status,409);
 assert.equal((await api('update',b,{id:'call-test-1',status:'accepted'})).status,200);
 assert.equal((await api('update',a,{id:'call-test-1',status:'connected'})).status,200);
 assert.equal((await api('update',b,{id:'call-test-1',status:'ended'})).status,200);
 assert.equal((await api('update',b,{id:'call-test-1',status:'accepted'})).status,409);
 assert.equal((await api('invite',a,{to:recipient,kind:'audio',id:'call-expired'})).status,200);
 tables.yl_calls.at(-1).expires_at=new Date(Date.now()-1000).toISOString();
 const calls=await api('calls',b);assert.equal(calls.body.calls.find(r=>r.id==='call-expired').status,'missed');
 assert.equal((await api('calls',c)).body.calls.length,0);
 for(const value of ['http://web.push.apple.com/x','https://127.0.0.1/x','https://web.push.apple.com.evil.test/x','https://user@web.push.apple.com/x','https://fcm.googleapis.com:444/x'])assert.equal(validEndpoint(value),false);
 assert.equal(validEndpoint('https://web.push.apple.com/a'),true);
 assert.equal((await api('subscribe',a,{subscription:{endpoint:'https://127.0.0.1/a',keys:{}}})).status,400);
 console.log('PASS notification Worker: disabled config, authentication, contact consent, participant isolation, answer permissions, terminal states, durable missed expiry and push SSRF restrictions.');
}finally{globalThis.fetch=original}

const dom=new JSDOM(await readFile('dist/index.html','utf8'),{url:'https://example.test',runScripts:'outside-only'}),w=dom.window;
let callbacks,ringing=0,stops=0,answers=0,updates=[];
w.createRinger=()=>({start:()=>{ringing++;return true},stop:()=>{stops++},unlock(){}});
w.createNotifications=options=>{callbacks=options;return {start(){},poll(){},update:async(id,status)=>updates.push({id,status}),load:async()=>({configured:false}),guidance:()=> 'iPhone 添加到主屏幕'}};
w.createPeerService=options=>({connect:async()=>{},addFriend:async()=>{},send:async()=>{},call:async()=>{},answer:async()=>{answers++},hangup(){},disconnect(){},setMuted(){},setCamera(){}});
w.translate=async()=>({text:''});w.createSpeechRecognition=()=>({supported:false,stop(){}});
w.HTMLMediaElement.prototype.play=async()=>{};
const source=(await readFile('dist/app.js','utf8')).replace(/^import .*;\n/gm,'');w.eval(source+'\nglobalThis.qa={state,syncCloudCalls,endCall,notificationSettings,receiveMessage,startCall};');
w.qa.state.contacts.push({id:'yueliao-aabbccdd',name:'甲',cloudId:actor,demo:false});
const row={id:'call-ui-1',caller:actor,recipient,caller_peer:'yueliao-aabbccdd',recipient_peer:'yueliao-ddccbbaa',kind:'video',status:'ringing',created_at:new Date().toISOString(),expires_at:new Date(Date.now()+60000).toISOString()};
callbacks.onCalls([row],recipient);assert.equal(ringing,1);assert.equal(answers,0,'ringing must never access microphone/auto answer');assert.ok(w.document.querySelector('#call-answer'));assert.match(w.document.querySelector('.call-person').textContent,/甲/);
w.document.querySelector('#call-answer').click();await new Promise(r=>setTimeout(r,0));assert.equal(updates.at(-1).status,'accepted');assert.equal(answers,0,'offline invitation waits for media connection after acceptance');assert.ok(stops);
callbacks.onCalls([{...row,status:'missed'}],recipient);assert.equal(w.qa.state.call,null);assert.equal(w.qa.state.calls[0].status,'missed');assert.equal(JSON.parse(w.localStorage.getItem('yueliao-calls'))[0].id,row.id);
callbacks.onCalls([{...row,status:'missed'}],recipient);assert.equal(w.qa.state.calls.length,1,'cloud/local call records deduplicate');
callbacks.onCalls([{...row,id:'call-ui-2'}],recipient);
await w.qa.receiveMessage('wrong-peer',{kind:'call-end',callId:'call-ui-2'});assert.ok(w.qa.state.call);
await w.qa.receiveMessage(row.caller_peer,{kind:'call-end',callId:'old-call'});assert.ok(w.qa.state.call);
await w.qa.receiveMessage(row.caller_peer,{kind:'call-end',callId:'call-ui-2'});assert.equal(w.qa.state.call,null,'matching remote hangup exits incoming UI');
w.qa.state.active=row.caller_peer;w.qa.state.contacts.at(-1).online=true;
const beforeRing=ringing;await w.qa.startCall('audio');assert.equal(ringing,beforeRing+1,'outgoing call starts ringback');w.qa.endCall();assert.equal(w.qa.state.call,null);
w.qa.notificationSettings();assert.match(w.document.querySelector('.modal').textContent,/主屏幕/);dom.window.close();
console.log('PASS incoming UI: caller identity, accept/reject controls, gesture-gated ringtone, explicit answer, persistent missed records and cloud/local deduplication.');

const events={},shown=[],opened=[];const sw={self:{location:{origin:'https://example.test'},addEventListener:(type,fn)=>events[type]=fn,registration:{showNotification:async(...args)=>shown.push(args)},clients:{matchAll:async()=>[],openWindow:async url=>opened.push(url)}}};vm.runInNewContext(await readFile('dist/sw.js','utf8'),{...sw,URL});let task;
events.push({data:{json:()=>({type:'call',callId:'safe-id',peerId:'friend-123',title:'乙',body:'视频来电'})},waitUntil:p=>task=p});await task;assert.equal(shown[0][1].data.callId,'safe-id');
events.notificationclick({notification:{close(){},data:{type:'call',callId:'safe-id',peerId:'friend-123'}},waitUntil:p=>task=p});await task;assert.equal(new URL(opened[0]).origin,'https://example.test');assert.equal(new URL(opened[0]).searchParams.get('incoming'),'safe-id');
console.log('PASS service worker: visible push notifications and same-origin click-to-open call routing.');
