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
w.AbortSignal=AbortSignal;w.fetch=async()=>Response.json({text:'你好，我是 AI 助手'});
w.localStorage.setItem('yueliao-contacts',JSON.stringify([{id:'demo-linh',demo:true},{id:'real-friend',name:'真实好友'}]));
w.eval(source+'\nglobalThis.qa={state,openChat,sendText,receiveMessage,recordVoice,stopRecording,endCall,save};');
const $=s=>w.document.querySelector(s),click=s=>$(s).click();
const flush=()=>new Promise(r=>setTimeout(r,10));

w.fetch=async()=>Response.json({authenticated:true,email:'owner@example.test',name:'测试',assistantAuthorized:true,assistantConfigured:true,signOutUrl:'/signout-with-chatgpt?return_to=%2F'});
click('[data-action="account"]');await flush();
assert.match(w.document.querySelector('[data-account-panel]').textContent,/owner@example.test/);
assert.match(w.document.querySelector('[data-account-panel]').textContent,/可直接使用/);
assert.equal(w.document.querySelector('[data-account-panel] a').target,'_top');
click('#modal-close');
w.fetch=async()=>Response.json({authenticated:false,signInUrl:'/signin-with-chatgpt?return_to=%2F'});
click('[data-action="account"]');await flush();
assert.match(w.document.querySelector('[data-account-panel]').textContent,/未登录/);
assert.ok(!w.document.querySelector('[data-account-panel]').textContent.includes('owner@example.test'));
click('#modal-close');click('[data-action="profile"]');await flush();
assert.ok($('#profile-id'));assert.ok($('#avatar-upload'));
assert.match(w.document.body.textContent,/没有独立密码/);
$('#profile-name').value='新昵称';
$('#profile-form').requestSubmit($('#profile-form button[type="submit"]'));await flush();
assert.equal(JSON.parse(w.localStorage.getItem('yueliao-profile')).name,'新昵称');
click('[data-action="profile"]');$('#profile-name').value='不保存';click('#modal-close');
assert.equal(JSON.parse(w.localStorage.getItem('yueliao-profile')).name,'新昵称');
w.qa.openChat('real-friend');click('[data-action="contact-info"]');click('#delete-friend');click('#delete-cancel');
assert.ok(w.qa.state.contacts.some(c=>c.id==='real-friend'));
click('[data-action="contact-info"]');click('#delete-friend');click('#delete-confirm');await flush();
assert.ok(!w.qa.state.contacts.some(c=>c.id==='real-friend'));
assert.ok(JSON.parse(w.localStorage.getItem('yueliao-removed-friends')).includes('real-friend'));
click('[data-action="create-group"]');assert.ok($('#group-value'));click('#modal-close');
w.qa.state.contacts.push({id:'group-test',name:'中越群',group:true,code:'ABCD1234',isOwner:true});w.qa.openChat('group-test');
assert.ok($('#main').classList.contains('group-chat'));assert.ok($('[data-action="meeting"]'));
assert.match($('.person p').textContent,/文字群聊/);
await flush();w.close();console.log('Account panel signed-in and signed-out UI passed');
