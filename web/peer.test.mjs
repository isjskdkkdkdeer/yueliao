import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';

const source=await readFile(new URL('./dist/peer.js',import.meta.url),'utf8');
const {createPeerService}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const tick=() => new Promise(resolve=>setTimeout(resolve,0));
class Data extends EventEmitter {
  constructor(id) { super(); this.peer=id; this.open=false; this.sent=[]; }
  send(value) { this.sent.push(value); }
  close() { if (this.closed) return; this.closed=true; this.open=false; this.emit('close'); }
}
class Call extends EventEmitter {
  constructor(id,kind) { super(); this.peer=id; this.metadata={kind}; }
  answer(stream) { this.answered=stream; }
  close() { if (this.closed) return; this.closed=true; this.emit('close'); }
}
class Peer extends EventEmitter {
  static current;
  constructor(id) { super(); this.id=id; Peer.current=this; setTimeout(()=>{ this.open=true; this.emit('open',id); },0); }
  connect(id) { this.data=new Data(id); setTimeout(()=>{ this.data.open=true; this.data.emit('open'); this.data.emit('data',{type:'hello',profile:{id,name:'测试好友',language:'vi'}}); },0); return this.data; }
  call(id,stream,{metadata}) { this.media=new Call(id,metadata.kind); this.media.local=stream; return this.media; }
  destroy() { this.destroyed=true; this.open=false; this.emit('close'); }
}
let mediaRequests=0;
const tracks=[];
function stream() {
  const audio={kind:'audio',enabled:true,stop(){this.stopped=true;}};
  const video={kind:'video',enabled:true,stop(){this.stopped=true;}};
  tracks.push(audio,video);
  return {getTracks:()=>[audio,video],getAudioTracks:()=>[audio],getVideoTracks:()=>[video]};
}
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>{mediaRequests++;return stream();}}}});
globalThis.isSecureContext=true;
const events={status:[],contacts:[],messages:[],incoming:[],streams:[],ends:[]};
const service=createPeerService({
  loadPeer:async()=>Peer,
  onStatus:x=>events.status.push(x),onContact:x=>events.contacts.push(x),
  onMessage:x=>events.messages.push(x),onIncomingCall:x=>events.incoming.push(x),
  onCallStream:x=>events.streams.push(x),onCallEnd:x=>events.ends.push(x),
});
assert.equal(await service.connect({id:'yueliao-device-a',name:'我',language:'zh'}),'yueliao-device-a');
assert.equal(mediaRequests,0,'connect must never request microphone');
await assert.rejects(service.addFriend('yueliao-device-a'),/自己的/);
const friend=await service.addFriend('yueliao-device-b');
assert.equal(friend.name,'测试好友');
const data=Peer.current.data;
assert.equal(data.sent[0].type,'hello');
await service.send(friend.id,{text:'你好'});
assert.deepEqual(data.sent.at(-1),{type:'message',payload:{text:'你好'}});
data.emit('data',{type:'message',payload:{text:'Xin chào'}});
assert.equal(events.messages[0].payload.text,'Xin chào');
const outgoing=await service.call(friend.id,'video');
assert.equal(mediaRequests,1);
assert.equal(events.streams.at(-1).remoteStream,null);
const remote=stream(); outgoing.emit('stream',remote);
assert.equal(events.streams.at(-1).remoteStream,remote);
service.setMuted(true); service.setCamera(false);
assert.equal(service.localStream.getAudioTracks()[0].enabled,false);
assert.equal(service.localStream.getVideoTracks()[0].enabled,false);
const local=service.localStream;
service.hangup();
assert.equal(service.localStream,null);
assert.ok(local.getTracks().every(track=>track.stopped));
assert.equal(events.ends.length,1,'close callback must not duplicate end event');
const incoming=new Call(friend.id,'audio'); Peer.current.emit('call',incoming);
assert.equal(mediaRequests,1,'incoming call must never auto-request microphone');
assert.equal(events.incoming[0].call,incoming);
await service.answer(incoming);
assert.equal(mediaRequests,2);
assert.equal(incoming.answered,service.localStream);
service.hangup();
let givePermission;
navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>{givePermission=resolve;});
const pending=service.call(friend.id,'audio');
service.hangup();
const canceledStream=stream(); givePermission(canceledStream);
await assert.rejects(pending,/取消/);
assert.ok(canceledStream.getTracks().every(track=>track.stopped),'late permission must not retain microphone');
service.disconnect();
assert.equal(service.localStream,null);
await tick();
console.log('PASS peer service: handshake, messaging, explicit call permissions, streams, mute/camera, cleanup, and canceled permission.');

// Exercise browser suspension and re-entry without waiting for real retry timers.
async function withClock(run) {
  const originalSetTimeout=globalThis.setTimeout, originalClearTimeout=globalThis.clearTimeout;
  let now=0, nextId=0;
  const scheduled=new Map();
  globalThis.setTimeout=(callback,delay=0,...args)=>{
    const id=++nextId;
    scheduled.set(id,{at:now+Math.max(0,Number(delay)||0),callback:()=>callback(...args)});
    return id;
  };
  globalThis.clearTimeout=id=>scheduled.delete(id);
  const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
  const advance=async duration=>{
    const end=now+duration;
    for(let count=0;count<1000;count++) {
      await flush();
      const first=[...scheduled.entries()].filter(([,job])=>job.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!first){now=end;await flush();return;}
      now=first[1].at;scheduled.delete(first[0]);first[1].callback();
    }
    throw new Error('Retry loop scheduled too many timers.');
  };
  try {await run({flush,advance});}
  finally {globalThis.setTimeout=originalSetTimeout;globalThis.clearTimeout=originalClearTimeout;}
}

function controlledPeers() {
  const instances=[];
  class ControlledPeer extends EventEmitter {
    constructor(id) {super();this.id=id;this.open=false;this.disconnected=false;this.destroyed=false;this.dataConnections=[];instances.push(this);}
    openSignal() {this.open=true;this.disconnected=false;this.emit('open',this.id);}
    disconnect() {this.disconnectCount=(this.disconnectCount||0)+1;this.open=false;this.disconnected=true;this.emit('disconnected');}
    reconnect() {
      this.reconnectCount=(this.reconnectCount||0)+1;
      if(this.failReconnect)throw new Error('The old signaling socket cannot reconnect.');
      if(this.stallReconnect)return;
      queueMicrotask(()=>{if(!this.destroyed)this.openSignal();});
    }
    destroy() {if(this.destroyed)return;this.destroyed=true;this.open=false;this.disconnected=true;this.emit('close');}
    connect(id,options) {const connection=new Data(id);connection.metadata=options?.metadata;this.dataConnections.push(connection);return connection;}
  }
  return {ControlledPeer,instances};
}

await withClock(async ({flush,advance})=>{
  const {ControlledPeer,instances}=controlledPeers(),statuses=[];
  const reconnecting=createPeerService({loadPeer:async()=>ControlledPeer,onStatus:status=>statuses.push(status)});
  const profile={id:'yueliao-reenter-device',name:'重新进入',language:'zh'};
  const first=reconnecting.connect(profile).catch(()=>{});
  await flush();
  instances[0].emit('error',{type:'unavailable-id',message:'ID is still registered'});
  await flush();
  await advance(3000);
  assert.ok(instances.length>=2,'a stale registration must be retried automatically');
  instances.at(-1).openSignal();
  await flush();
  assert.equal(statuses.at(-1).state,'ready','registration retry should return the device online');
  assert.ok(instances.every(peer=>peer.id===profile.id),'retry must preserve the saved friend ID');
  await first;
  reconnecting.disconnect();
  const count=instances.length;
  await advance(60000);
  assert.equal(instances.length,count,'explicit disconnect must cancel pending automatic retries');
  const resume=reconnecting.resume();
  await flush();
  assert.equal(instances.at(-1).id,profile.id,'returning from pagehide must reconnect the saved identity');
  assert.equal(instances.length,count+1);
  instances.at(-1).openSignal();await flush();await resume;
  assert.equal(statuses.at(-1).state,'ready');
  reconnecting.disconnect();
});

await withClock(async ({flush,advance})=>{
  const {ControlledPeer,instances}=controlledPeers(),statuses=[];
  const reconnecting=createPeerService({loadPeer:async()=>ControlledPeer,onStatus:status=>statuses.push(status)});
  const startup=reconnecting.connect({id:'yueliao-suspended-device',name:'后台恢复'});
  await flush();instances[0].openSignal();await startup;
  const readyBefore=statuses.filter(status=>status.state==='ready').length;
  const oldPeer=instances[0];
  // Browsers can restore a suspended page with its old `open` flag still true.
  const resume=reconnecting.resume();
  await flush();
  assert.ok(oldPeer.disconnectCount||oldPeer.reconnectCount||instances.length>1,'resume must verify the stale signaling connection');
  if(instances.length>1)instances.at(-1).openSignal();
  await flush();await resume;
  assert.ok(statuses.filter(status=>status.state==='ready').length>readyBefore,'resume must emit a fresh ready event for friend restoration');
  const current=instances.at(-1);
  current.failReconnect=true;current.disconnect();
  await advance(3000);
  assert.ok(instances.length>1,'a failed PeerJS reconnect must create a fresh signaling peer');
  instances.at(-1).openSignal();await flush();
  assert.equal(statuses.at(-1).state,'ready');
  const currentCount=instances.length;
  current.destroy();
  await advance(3000);
  assert.equal(instances.length,currentCount,'late close from a replaced peer must not restart the current connection');
  reconnecting.disconnect();
});

await withClock(async ({flush,advance})=>{
  const {ControlledPeer,instances}=controlledPeers(),statuses=[];
  const reconnecting=createPeerService({loadPeer:async()=>ControlledPeer,onStatus:status=>statuses.push(status)});
  const profile={id:'yueliao-stalled-socket',name:'网络变化'};
  const startup=reconnecting.connect(profile);
  await flush();instances[0].openSignal();await startup;
  instances[0].stallReconnect=true;
  reconnecting.resume();await flush();
  await advance(15000);
  assert.equal(instances.length,2,'a silent signaling reconnect must be replaced when the watchdog expires');
  assert.equal(instances[1].id,profile.id);
  instances[1].openSignal();await flush();
  assert.equal(statuses.at(-1).state,'ready');
  const friendID='yueliao-not-online';
  const handshake=reconnecting.addFriend(friendID);
  const rejected=assert.rejects(handshake,/暂未上线/);
  instances[1].emit('error',{type:'peer-unavailable',message:`Could not connect to peer ${friendID}`});
  await rejected;
  assert.equal(statuses.at(-1).peerId,friendID,'an offline friend error must stay scoped to that friend');
  assert.equal(statuses.filter(status=>!status.peerId||status.peerId===profile.id).at(-1).state,'ready','offline friends must not mark local signaling offline');
  assert.equal(await reconnecting.connect(profile),profile.id);
  assert.equal(instances.length,2,'an offline friend must not recreate a healthy signaling peer');
  reconnecting.disconnect();
});

await withClock(async ({flush})=>{
  const {ControlledPeer,instances}=controlledPeers();
  const reconnecting=createPeerService({loadPeer:async()=>ControlledPeer});
  const startup=reconnecting.connect({id:'yueliao-data-owner',name:'我'});
  await flush();instances[0].openSignal();await startup;
  const remoteID='yueliao-data-friend';
  const oldHandshake=reconnecting.addFriend(remoteID);
  const oldConnection=instances[0].dataConnections.at(-1);
  oldConnection.open=true;oldConnection.emit('open');
  oldConnection.emit('data',{type:'hello',profile:{id:remoteID,name:'好友',language:'vi'},session:'old-page'});
  await oldHandshake;
  oldConnection.open=false;
  const replacementHandshake=reconnecting.addFriend(remoteID);
  let replacementError;
  replacementHandshake.catch(error=>{replacementError=error;});
  const replacement=instances[0].dataConnections.at(-1);
  replacement.open=true;replacement.emit('open');
  oldConnection.close();
  await flush();
  assert.equal(replacementError,undefined,'an old channel closing must not reject the new handshake');
  replacement.emit('data',{type:'hello',profile:{id:remoteID,name:'好友',language:'vi'},session:'new-page'});
  assert.equal((await replacementHandshake).online,true);
  await reconnecting.send(remoteID,{text:'重连后发送'});
  assert.equal(replacement.sent.at(-1).payload.text,'重连后发送');
  const simultaneousIncoming=new Data(remoteID);
  simultaneousIncoming.metadata={initiator:remoteID,session:'new-page'};
  instances[0].emit('connection',simultaneousIncoming);
  simultaneousIncoming.open=true;simultaneousIncoming.emit('open');
  simultaneousIncoming.emit('data',{type:'hello',profile:{id:remoteID,name:'好友',language:'vi'},session:'new-page'});
  await reconnecting.send(remoteID,{text:'同时重连'});
  assert.equal(simultaneousIncoming.sent.at(-1).payload.text,'同时重连','simultaneous connections must prefer the same lower-ID initiator');
  assert.equal(replacement.closed,true);
  const returningFriend=new Data(remoteID);
  returningFriend.metadata={initiator:remoteID,session:'returned-page'};
  instances[0].emit('connection',returningFriend);
  returningFriend.open=true;returningFriend.emit('open');
  returningFriend.emit('data',{type:'hello',profile:{id:remoteID,name:'好友',language:'vi'},session:'returned-page'});
  await reconnecting.send(remoteID,{text:'好友退出再回来'});
  assert.equal(returningFriend.sent.at(-1).type,'message','a new remote page session must replace its stale open data channel');
  assert.equal(returningFriend.sent.at(-1).payload.text,'好友退出再回来');
  reconnecting.disconnect();
});
await withClock(async ({flush})=>{
  const {ControlledPeer,instances}=controlledPeers();
  const reconnecting=createPeerService({loadPeer:async()=>ControlledPeer});
  const startup=reconnecting.connect({id:'yueliao-aa-device',name:'我'});
  await flush();instances[0].openSignal();await startup;
  const remoteID='yueliao-zz-device',handshake=reconnecting.addFriend(remoteID);
  const outgoing=instances[0].dataConnections.at(-1);
  outgoing.open=true;outgoing.emit('open');
  // The competing channel can receive hello before the preferred channel does.
  const incoming=new Data(remoteID);
  incoming.metadata={initiator:remoteID,session:'same-session'};
  instances[0].emit('connection',incoming);incoming.open=true;incoming.emit('open');
  incoming.emit('data',{type:'hello',profile:{id:remoteID,name:'好友'},session:'same-session'});
  outgoing.emit('data',{type:'hello',profile:{id:remoteID,name:'好友'},session:'same-session'});
  await handshake;
  await reconnecting.send(remoteID,{text:'保留同一条连接'});
  assert.equal(incoming.closed,true,'the lower-ID device must reject the competing remote-initiated connection');
  assert.equal(outgoing.sent.at(-1).payload.text,'保留同一条连接');
  reconnecting.disconnect();
});
console.log('PASS peer reconnection: stable-ID retry, signaling resume/watchdog, canceled retries, friend-scoped errors, remote restart, and simultaneous-dial cleanup.');
