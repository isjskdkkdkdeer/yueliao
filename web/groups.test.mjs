import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {handleMailboxApi} from './worker/mailbox-api.js';
const sql=new DatabaseSync(':memory:');sql.exec(await readFile('drizzle/0000_offline_mailbox.sql','utf8'));
const DB={prepare(q){let v=[];return{bind(...x){v=x;return this},async run(){return sql.prepare(q).run(...v)},async first(){return sql.prepare(q).get(...v)||null},async all(){return{results:sql.prepare(q).all(...v)}}}}};
async function call(who,path,data={}){return handleMailboxApi(new Request('https://example.com/api/mailbox/'+path,{method:'POST',headers:{Origin:'https://example.com',Authorization:'Bearer '+who.repeat(64),'Content-Type':'application/json'},body:JSON.stringify(data)}),{DB})}
for(const who of ['a','b','c','d','e','f','1','2'])assert.equal((await call(who,'register',{id:'user-'+who,name:'Name '+who})).status,200);
const created=await call('a','groups-create',{name:'中越测试'});assert.equal(created.status,200);const {group:g}=await created.json();
assert.equal((await call('c','groups-history',{groupId:g.id})).status,403);
assert.equal((await call('b','groups-join',{code:'INVALID'})).status,404);
await call('b','groups-join',{code:g.code});
assert.equal((await call('b','groups-dissolve',{groupId:g.id})).status,403);
const message={id:'message-1',text:'你好',translation:'Xin chào',lang:'zh'};
assert.equal((await call('a','groups-send',{groupId:g.id,message})).status,200);
await call('a','groups-send',{groupId:g.id,message});
let history=await (await call('b','groups-history',{groupId:g.id})).json();assert.equal(history.messages.length,1);assert.equal(history.messages[0].senderName,'Name a');assert.equal(history.messages[0].out,false);assert.equal(history.messages[0].translation,'Xin chào');
assert.equal((await (await call('b','groups-history',{groupId:g.id,after:history.messages[0].seq})).json()).messages.length,0);
assert.equal((await call('c','groups-meeting-join',{groupId:g.id})).status,403);
const participants={};for(const who of ['a','b','c','d','e','f']){if(!['a','b'].includes(who))await call(who,'groups-join',{code:g.code});const joined=await call(who,'groups-meeting-join',{groupId:g.id});assert.equal(joined.status,200);participants[who]=(await joined.json()).peerId}
await call('1','groups-join',{code:g.code});assert.equal((await call('1','groups-meeting-join',{groupId:g.id})).status,409);
assert.equal((await call('a','groups-meeting-poll',{groupId:g.id,peerId:participants.b})).status,409);
await call('a','groups-meeting-caption',{groupId:g.id,peerId:participants.a,caption:{text:'你好',translation:'Xin chào',lang:'zh'}});
const roster=await (await call('b','groups-meeting-poll',{groupId:g.id,peerId:participants.b})).json();assert.equal(roster.participants.length,6);assert.equal(roster.participants.find(p=>p.peerId===participants.a).caption.translation,'Xin chào');
await call('b','groups-meeting-leave',{groupId:g.id,peerId:participants.b});assert.equal((await call('1','groups-meeting-join',{groupId:g.id})).status,200);
await call('b','groups-leave',{groupId:g.id});assert.equal((await call('b','groups-history',{groupId:g.id})).status,403);assert.equal((await call('b','groups-send',{groupId:g.id,message})).status,403);
sql.exec('UPDATE meeting_presence SET seen=0');assert.equal((await call('a','groups-meeting-poll',{groupId:g.id,peerId:participants.a})).status,409);
assert.equal((await call('a','groups-dissolve',{groupId:g.id})).status,200);assert.equal((await call('c','groups-history',{groupId:g.id})).status,403);
console.log('PASS groups: membership, message persistence/deduplication, translation, ownership, leave, meeting capacity, session ownership, captions and heartbeat expiry');
