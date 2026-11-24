import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

const [html,appSource,peerSource]=await Promise.all([
  readFile(new URL('./dist/index.html',import.meta.url),'utf8'),
  readFile(new URL('./dist/app.js',import.meta.url),'utf8'),
  readFile(new URL('./dist/peer.js',import.meta.url),'utf8'),
]);

// Only the transport is simulated. Both windows run the actual app and actual
// peer service, including registration, simultaneous dials, hello handshakes,
// channel selection, presence, lifecycle events, and message serialization.
const registered=new Map(),instances=[];
class Channel extends EventEmitter {
  constructor(peer,metadata){super();this.peer=peer;this.metadata=metadata;this.open=false;this.closed=false;}
  send(value){
    if(!this.open||this.closed)throw new Error('Channel is closed');
    const copy=structuredClone(value),remote=this.remote;
    queueMicrotask(()=>{if(remote.open&&!remote.closed)remote.emit('data',copy);});
  }
  close(){
    if(this.closed)return;
    this.closed=true;this.open=false;this.emit('close');
    const remote=this.remote;
    if(remote&&!remote.closed){
      remote.closed=true;remote.open=false;
      queueMicrotask(()=>remote.emit('close'));
    }
  }
}
class TransportPeer extends EventEmitter {
  constructor(id){
    super();this.id=id;this.open=false;this.destroyed=false;this.disconnected=false;this.channels=new Set();
    instances.push(this);
    if(registered.has(id))queueMicrotask(()=>this.emit('error',{type:'unavailable-id',message:'ID is already registered'}));
    else{registered.set(id,this);queueMicrotask(()=>this.openSignal());}
  }
  openSignal(){if(this.destroyed)return;this.open=true;this.disconnected=false;registered.set(this.id,this);this.emit('open',this.id);}
  connect(id,{metadata}={}){
    const local=new Channel(id,metadata);this.channels.add(local);
    queueMicrotask(()=>{
      const other=registered.get(id);
      if(!other?.open||other.destroyed){
        this.emit('error',{type:'peer-unavailable',message:`Could not connect to peer ${id}`});local.close();return;
      }
      const incoming=new Channel(this.id,metadata);other.channels.add(incoming);
      local.remote=incoming;incoming.remote=local;
      other.emit('connection',incoming);
      if(local.closed||incoming.closed)return;
      local.open=incoming.open=true;
      local.emit('open');incoming.emit('open');
    });
    return local;
  }
  disconnect(){
    if(this.destroyed||this.disconnected)return;
    this.open=false;this.disconnected=true;
    if(registered.get(this.id)===this)registered.delete(this.id);
    this.emit('disconnected');
  }
  reconnect(){if(this.destroyed)throw new Error('Destroyed peer');queueMicrotask(()=>this.openSignal());}
  destroy(){
    if(this.destroyed)return;
    this.destroyed=true;this.open=false;this.disconnected=true;
    if(registered.get(this.id)===this)registered.delete(this.id);
    for(const channel of this.channels)channel.close();
    this.emit('close');
  }
}

const profileA={id:'yueliao-reentry-a',name:'小语',language:'zh'};
const profileB={id:'yueliao-reentry-b',name:'Lan',language:'vi'};
const pages=[];
function openPage(profile,friend,saved){
  const dom=new JSDOM(html,{url:'https://example.test',runScripts:'outside-only',pretendToBeVisual:true});
  pages.push(dom);
  const w=dom.window;
  if(saved){for(const [key,value] of Object.entries(saved))w.localStorage.setItem(key,value);}
  else{
    w.localStorage.setItem('yueliao-profile',JSON.stringify(profile));
    w.localStorage.setItem('yueliao-contacts',JSON.stringify([{...friend,online:true}]));
    w.localStorage.setItem('yueliao-messages',JSON.stringify({[friend.id]:[]}));
    w.localStorage.setItem('yueliao-auto','false');
  }
  // Translation and speech are unrelated external capabilities; this test never
  // requests a microphone, a camera, an API, or the real PeerJS network.
  w.translate=async()=>{throw new Error('Unexpected translation request');};
  w.speak=async()=>{};
  w.createSpeechRecognition=()=>({supported:false,start(){},stop(){}});
  w.eval(peerSource.replace('export function createPeerService','function createPeerService')+'\nglobalThis.realCreatePeerService=createPeerService;');
  w.createPeerService=options=>w.realCreatePeerService({...options,loadPeer:async()=>TransportPeer,loadIceConfig:async()=>null});
  w.eval(appSource.replace(/^import .*;\n/gm,'')+'\nglobalThis.qa={state,openChat,sendText,save};');
  return w;
}
async function waitFor(predicate,label){
  for(let turn=0;turn<100;turn++){
    if(predicate())return;
    await new Promise(resolve=>setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const online=(w,id)=>w.qa.state.connection==='ready'&&w.qa.state.contacts.find(c=>c.id===id)?.online===true;
async function exchange(from,to,text){
  const friendID=to.qa.state.profile.id,ownID=from.qa.state.profile.id;
  from.qa.openChat(friendID);
  from.document.querySelector('#message-input').value=text;
  await from.qa.sendText();
  await waitFor(()=>to.qa.state.messages[ownID]?.some(message=>message.text===text&&!message.out),`delivery of ${text}`);
  assert.equal(from.qa.state.messages[friendID].at(-1).status,'已发送');
}
function snapshot(w){return Object.fromEntries(Array.from({length:w.localStorage.length},(_,i)=>{const key=w.localStorage.key(i);return [key,w.localStorage.getItem(key)];}));}

try{
  let a=openPage(profileA,profileB);
  const b=openPage(profileB,profileA);
  await waitFor(()=>online(a,profileB.id)&&online(b,profileA.id),'automatic two-sided hello handshake');
  assert.equal(registered.size,2,'each saved identity has one active registration');
  await exchange(a,b,'首次进入发送');
  await exchange(b,a,'首次回复');

  a.dispatchEvent(new a.PageTransitionEvent('pagehide',{persisted:true}));
  await waitFor(()=>!b.qa.state.contacts.find(c=>c.id===profileA.id).online,'remote friend becomes offline after leaving');
  assert.equal(a.qa.state.connection,'disconnected');
  a.dispatchEvent(new a.PageTransitionEvent('pageshow',{persisted:true}));
  await waitFor(()=>online(a,profileB.id)&&online(b,profileA.id),'both friends reconnect after back-forward cache return');
  assert.equal(a.qa.state.profile.id,profileA.id,'BFCache return preserves the saved identity');
  await exchange(a,b,'返回页面后发送');
  await exchange(b,a,'返回页面后回复');

  a.dispatchEvent(new a.PageTransitionEvent('pagehide'));
  const stored=snapshot(a);
  a.close();
  a=openPage(profileA,profileB,stored);
  await waitFor(()=>online(a,profileB.id)&&online(b,profileA.id),'fresh reopening with the same ID and a new page session');
  assert.equal(a.qa.state.profile.id,profileA.id,'fresh reopening does not generate a replacement friend ID');
  assert.ok(a.qa.state.messages[profileB.id].some(message=>message.text==='首次回复'),'reopening retains the existing conversation');
  await exchange(a,b,'关闭重新进入后发送');
  await exchange(b,a,'关闭重新进入后回复');
  assert.equal(registered.size,2);
  assert.ok(instances.filter(peer=>peer.id===profileA.id).length>=3,'reentry exercised fresh signaling registrations');
  assert.equal(a.document.querySelector('#modal-root').childElementCount,0);
  assert.equal(b.document.querySelector('#modal-root').childElementCount,0);
  console.log('PASS actual app/service reentry: two-sided automatic handshake, simultaneous dials, bidirectional text, BFCache return, fresh same-ID reopening, restored presence, and retained conversation.');
}finally{
  for(const dom of pages){
    const w=dom.window;
    if(w.document){w.dispatchEvent(new w.PageTransitionEvent('pagehide'));w.close();}
  }
  for(const peer of instances)peer.destroy();
}
