import {setupInterfaceLanguage} from './dist/i18n.js';
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
w.createPeerService=options=>{hooks=options;return {connect:async profile=>{hooks.onStatus({state:'ready',message:'在线',peerId:profile.id})},resume:async()=>{},addFriend:async id=>hooks.onContact({id,name:'真实好友',language:'vi',online:true}),send:async(id,payload)=>sent.push({id,payload}),call:async()=>{},answer:async()=>{},hangup(){},setMuted(){},setCamera(){},disconnect(){}}};
let source=await readFile('./dist/app.js','utf8');
source=source.replace(/^import .*;\n/gm,'');
w.AbortSignal=AbortSignal;w.fetch=async()=>Response.json({text:'你好，我是 AI 助手'});
w.localStorage.setItem('yueliao-contacts',JSON.stringify([{id:'demo-linh',demo:true},{id:'real-friend',name:'真实好友'}]));
w.eval(source+'\nglobalThis.qa={state,openChat,sendText,receiveMessage,recordVoice,stopRecording,endCall,save};');
const $=s=>w.document.querySelector(s),click=s=>$(s).click();
const flush=()=>new Promise(r=>setTimeout(r,10));


const controller=setupInterfaceLanguage({document:w.document});controller.setLanguage('vi');await flush();
assert.equal($('.brand strong').textContent,'YueLiao');
assert.equal($('[data-action="create-group"]').textContent,'Tạo nhóm');
assert.equal($('[data-action="join-group"]').textContent,'Tham gia nhóm');
assert.equal($('[data-tab="settings"] span').textContent,'Cá nhân');
assert.match($('[data-contact="ai-assistant"] .contact-name').textContent,/Trợ lý YueLiao/);
assert.equal($('[data-contact="ai-assistant"] .contact-last').textContent,'Trò chuyện, hỏi đáp, dịch Trung – Việt');
assert.equal($('.person h2').textContent,'Trợ lý YueLiaoAI');
assert.match($('[data-contact="real-friend"]').textContent,/真实好友/);
w.fetch=async()=>Response.json({authenticated:true,name:'添加好友',email:'test@example.test',assistantConfigured:true,assistantAuthorized:true});
click('[data-action="account"]');await flush();assert.equal($('[data-action="account"]').textContent,'Đã đăng nhập · Tài khoản');assert.match($('.account-panel').textContent,/添加好友/);click('#modal-close');
click('[data-action="create-group"]');await flush();assert.equal($('.modal h2').textContent,'Tạo nhóm');assert.equal($('#group-value').previousElementSibling.textContent,'Tên nhóm');
controller.setLanguage('zh');assert.equal($('.brand strong').textContent,'越聊');assert.equal($('.modal h2').textContent,'创建群聊');controller.setLanguage('vi');assert.equal($('.modal h2').textContent,'Tạo nhóm');
click('#modal-close');click('[data-action="start-live"]');await flush();assert.ok($('#live-add'));assert.ok($('#live-text'));assert.match($('.modal').textContent,/ChatGPT/);assert.equal($('.side-title small'),null);controller.dispose();await flush();w.close();console.log('PASS current UI: marked labels, assistant identity/preview, account, groups and repeated switching preserve user content');
