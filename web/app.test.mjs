import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {translate} from './dist/translate.js';

const dom=new JSDOM(await readFile('./dist/index.html','utf8'),{url:'https://example.test',runScripts:'outside-only'});
const w=dom.window;
let hooks,mediaRequests=0,stopped=0,sent=[];
w.HTMLMediaElement.prototype.play=()=>Promise.resolve();
w.MediaRecorder=class {
  static isTypeSupported(){return true}
  constructor(){this.mimeType='audio/webm';this.state='inactive'}
  start(){this.state='recording'}
  stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable({data:new w.Blob(['recorded audio'])});this.onstop()})}
};
Object.defineProperty(w.navigator,'mediaDevices',{value:{getUserMedia:async()=>{mediaRequests++;const audio={stop:()=>stopped++,enabled:true};return {getTracks:()=>[audio],getAudioTracks:()=>[audio],getVideoTracks:()=>[]}}}});
w.translate=translate;w.speak=async()=>{};
w.createSpeechRecognition=()=>({supported:false,start(){},stop(){}});
w.createPeerService=options=>{hooks=options;return {connect:async profile=>{hooks.onStatus({state:'ready',message:'在线',peerId:profile.id})},resume:async()=>{},addFriend:async id=>hooks.onContact({id,name:'Lan',language:'vi',online:true}),send:async(id,payload)=>sent.push({id,payload}),call:async()=>{},answer:async()=>{},hangup(){},setMuted(){},setCamera(){},disconnect(){}}};
let source=await readFile('./dist/app.js','utf8');
source=source.replace(/^import .*;\n/gm,'');
w.eval(source+'\nglobalThis.qa={state,openChat,sendText,receiveMessage,recordVoice,stopRecording,endCall,save};');
const $=s=>w.document.querySelector(s),click=s=>$(s).click();
const flush=()=>new Promise(r=>setTimeout(r,10));

assert.equal(w.document.querySelectorAll('.contact').length,4);
assert.equal(w.document.querySelectorAll('.message').length,5);
click('[data-filter="friends"]');assert.match($('#contacts').textContent,/还没有添加好友/);
click('[data-filter="all"]');assert.equal(w.document.querySelectorAll('.contact').length,4);
$('#contact-search').value='Linh';$('#contact-search').dispatchEvent(new w.Event('input'));assert.equal(w.document.querySelectorAll('.contact').length,1);
$('#contact-search').value='';$('#contact-search').dispatchEvent(new w.Event('input'));
$('#message-input').value='你好';await w.qa.sendText();assert.equal(w.qa.state.messages['demo-linh'].at(-1).translation,'Xin chào');assert.equal($('#message-input').value,'');
click('.translation-strip [data-action="toggle"]');assert.equal(w.document.querySelectorAll('.translated').length,0);
click('.translation-strip [data-action="toggle"]');assert.ok(w.document.querySelectorAll('.translated').length>0);
click('[data-action="translate"]');click('#translate-submit');await flush();assert.match($('#translate-result').textContent,/Ngày mai/);click('#modal-close');
click('[data-action="audio"]');assert.equal(mediaRequests,0);assert.match($('.call-overlay').textContent,/没有远程好友/);
click('#subtitle-toggle');assert.match($('#toast').textContent,/不支持.*语音识别/);
click('#preview-media');await flush();assert.equal(mediaRequests,1);click('#call-hangup');assert.equal(stopped,1);assert.equal($('.call-overlay'),null);assert.equal(w.qa.state.calls.length,1);
await w.qa.recordVoice();assert.equal(w.qa.state.recording,true);w.qa.stopRecording(true);await flush();await flush();assert.equal(w.qa.state.recording,false);assert.equal(w.qa.state.messages['demo-linh'].at(-1).kind,'audio');assert.equal(stopped,2);
let resolvePermission;
w.navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>{resolvePermission=resolve});
const pendingRecording=w.qa.recordVoice();w.qa.stopRecording(false);
resolvePermission({getTracks:()=>[{stop:()=>stopped++}]});await pendingRecording;
assert.equal(w.qa.state.recording,false);assert.equal(stopped,3);
hooks.onContact({id:'yueliao-qa-peer',name:'Lan <img src=x>',language:'vi',online:true});w.qa.openChat('yueliao-qa-peer');assert.equal($('.person h2 img'),null);
$('#message-input').value='谢谢';await w.qa.sendText();assert.equal(sent.at(-1).payload.kind,'text');assert.equal(sent.at(-1).payload.translation,'Cảm ơn');assert.equal(w.qa.state.messages['yueliao-qa-peer'].at(-1).status,'已发送');
await w.qa.receiveMessage('yueliao-qa-peer',{id:'r1',kind:'text',text:'Xin chào',translation:'<img src=x onerror=alert(1)>',lang:'vi'});assert.equal($('#messages .translated img'),null);assert.match($('#messages').textContent,/<img src=x/);
const len=w.qa.state.messages['yueliao-qa-peer'].length;
await w.qa.receiveMessage('yueliao-qa-peer',{id:'r2',kind:'image',url:'javascript:alert(1)'});assert.equal(w.qa.state.messages['yueliao-qa-peer'].length,len);
await w.qa.receiveMessage('yueliao-qa-peer',{id:'r1',kind:'text',text:'dup'});assert.equal(w.qa.state.messages['yueliao-qa-peer'].length,len);
click('.mobile-back');assert.equal($('#shell').classList.contains('chat-open'),false);
click('[data-tab="friends"]');assert.match($('.section-view').textContent,/每一次相遇/);click('[data-tab="calls"]');assert.match($('.section-view').textContent,/语音通话/);
click('[data-tab="settings"]');assert.match($('.section-view').textContent,/聊天记录保存在当前浏览器/);
let finishTranslation;
w.translate=()=>new Promise(resolve=>{finishTranslation=resolve});
const received=w.qa.receiveMessage('yueliao-qa-peer',{id:'notify-pending',kind:'text',text:'Tin nhắn mới',lang:'vi'});
assert.equal(w.qa.state.messages['yueliao-qa-peer'].at(-1).text,'Tin nhắn mới','deliver before translation completes');
assert.equal($('#contacts [data-contact]').dataset.contact,'yueliao-qa-peer','real conversation precedes demo robots');
assert.equal($('#message-alert').hidden,false);
assert.equal($('#message-alert img'),null,'contact name is safely rendered');
assert.ok(w.qa.state.contacts.find(c=>c.id==='yueliao-qa-peer').unread>0);
assert.match(w.document.title,/新消息/);
const beforeDuplicate=w.qa.state.messages['yueliao-qa-peer'].length;
await w.qa.receiveMessage('yueliao-qa-peer',{id:'notify-pending',kind:'text',text:'duplicate'});
assert.equal(w.qa.state.messages['yueliao-qa-peer'].length,beforeDuplicate);
finishTranslation({text:'新消息'});await received;
click('#message-alert');
assert.equal(w.qa.state.active,'yueliao-qa-peer');
assert.equal(w.qa.state.contacts.find(c=>c.id==='yueliao-qa-peer').unread,0);
assert.equal($('#message-alert').hidden,true);
assert.ok(!w.document.title.includes('新消息'));
console.log('PASS new messages: immediate delivery before translation, real-contact priority, safe clickable banner, unread count and clear-on-open, in-flight deduplication.');
console.log('PASS app: contacts/search, demo send/translation, translation modal/toggle, permission-gated local preview and cleanup, real peer send/receive, HTML escaping/media filtering/deduplication, mobile navigation, call logs/settings.');
dom.window.close();

// Reopening a saved page must restore the stable identity and existing friends
// without requiring the user to press Connect or add the friend again.
const reopened=new JSDOM(await readFile('./dist/index.html','utf8'),{url:'https://example.test',runScripts:'outside-only'});
const rw=reopened.window;
const storedProfile={id:'yueliao-returning',name:'Returning user',language:'zh'};
const storedFriend={id:'yueliao-saved-friend',name:'Lan',language:'vi',online:true};
rw.localStorage.setItem('yueliao-profile',JSON.stringify(storedProfile));
rw.localStorage.setItem('yueliao-contacts',JSON.stringify([
  {id:'demo-linh',name:'Linh',language:'vi',demo:true,online:true},storedFriend,
]));
rw.localStorage.setItem('yueliao-messages',JSON.stringify({'demo-linh':[]}));
rw.translate=translate;rw.speak=async()=>{};
rw.createSpeechRecognition=()=>({supported:false,start(){},stop(){}});
let lifecycleHooks,connected=false,lastProfile,connections=0,resumes=0,disconnects=0;
const restoredFriends=[];
function ready(){connected=true;lifecycleHooks.onStatus({state:'ready',message:'在线',peerId:lastProfile?.id});}
rw.createPeerService=options=>{
  lifecycleHooks=options;
  return {
    async connect(profile){
      lastProfile={...profile};connections++;
      lifecycleHooks.onStatus({state:'connecting',message:'连接中'});
      await Promise.resolve();ready();return profile.id;
    },
    async resume(){resumes++;if(!connected){await Promise.resolve();ready();}return lastProfile?.id;},
    async addFriend(id){restoredFriends.push(id);},
    disconnect(){
      disconnects++;connected=false;
      lifecycleHooks.onContact({...storedFriend,online:false});
      lifecycleHooks.onStatus({state:'disconnected',message:'已断开'});
    },
    send:async()=>{},call:async()=>{},answer:async()=>{},hangup(){},setMuted(){},setCamera(){},
  };
};
try{
  rw.eval(source+'\nglobalThis.qa={state};');
  await flush();
  assert.equal(connections,1,'opening the saved website automatically starts signaling');
  assert.equal(lastProfile.id,storedProfile.id,'reopening preserves the saved friend ID');
  assert.equal(lastProfile.name,storedProfile.name);
  assert.equal(lastProfile.language,storedProfile.language);
  assert.ok(Number.isInteger(lastProfile.avatarTile)&&lastProfile.avatarTile>=0&&lastProfile.avatarTile<16,'legacy profiles receive a persisted avatar');
  assert.equal(rw.qa.state.connection,'ready');
  assert.deepEqual(restoredFriends,['yueliao-saved-friend'],'saved real friends reconnect automatically; demo friends are excluded');
  assert.equal(rw.qa.state.contacts.find(c=>c.id===storedFriend.id).online,false,'signaling alone must not mark a friend online');
  assert.equal(rw.document.querySelector('#modal-root').childElementCount,0,'automatic connection does not open the add-friend dialog');
  assert.equal(rw.document.querySelector('#toast').textContent,'','automatic connection does not show a success toast');
  lifecycleHooks.onContact({...storedFriend,online:true});
  assert.equal(rw.qa.state.contacts.find(c=>c.id===storedFriend.id).online,true);

  rw.dispatchEvent(new rw.PageTransitionEvent('pagehide',{persisted:true}));
  assert.equal(disconnects,1,'leaving the page releases the old signaling session');
  assert.equal(rw.qa.state.contacts.find(c=>c.id===storedFriend.id).online,false);
  const attemptsBeforeReturn=restoredFriends.length;
  rw.dispatchEvent(new rw.PageTransitionEvent('pageshow',{persisted:true}));
  await flush();
  assert.equal(rw.qa.state.connection,'ready','a page restored from the back-forward cache reconnects');
  assert.ok(restoredFriends.length>attemptsBeforeReturn,'returning to the page restores saved friend connections');
  assert.equal(lastProfile.id,storedProfile.id);
  assert.equal(rw.document.querySelector('#modal-root').childElementCount,0);

  Object.defineProperty(rw.navigator,'onLine',{value:false,configurable:true});
  rw.dispatchEvent(new rw.Event('offline'));
  assert.equal(connected,false,'network loss releases the unusable session');
  assert.equal(rw.qa.state.contacts.find(c=>c.id===storedFriend.id).online,false);
  const attemptsBeforeOnline=restoredFriends.length;
  Object.defineProperty(rw.navigator,'onLine',{value:true,configurable:true});
  rw.dispatchEvent(new rw.Event('online'));
  await flush();
  assert.equal(rw.qa.state.connection,'ready','the online event restores signaling');
  assert.ok(restoredFriends.length>attemptsBeforeOnline,'network recovery restores saved friends');

  const callsBeforeHidden=connections+resumes;
  Object.defineProperty(rw.document,'visibilityState',{value:'hidden',configurable:true});
  rw.document.dispatchEvent(new rw.Event('visibilitychange'));
  await flush();
  assert.equal(connections+resumes,callsBeforeHidden,'hiding a tab does not start another connection');
  Object.defineProperty(rw.document,'visibilityState',{value:'visible',configurable:true});
  rw.document.dispatchEvent(new rw.Event('visibilitychange'));
  await flush();
  assert.ok(connections+resumes>callsBeforeHidden,'returning to the foreground checks the connection');
  assert.equal(rw.qa.state.profile.id,storedProfile.id);
  assert.equal(rw.document.querySelector('#modal-root').childElementCount,0);
  console.log('PASS app lifecycle: automatic startup, stable saved identity, honest friend presence, BFCache return, network recovery, and foreground resume without dialogs or success toasts.');
}finally{
  rw.dispatchEvent(new rw.PageTransitionEvent('pagehide'));
  reopened.window.close();
}
