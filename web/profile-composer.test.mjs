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


assert.equal($('#send-button').hidden,true);
$('#message-input').value='你好';$('#message-input').dispatchEvent(new w.Event('input'));
assert.equal($('#send-button').hidden,false);assert.equal($('#compose-more').hidden,true);
$('#message-input').value='';$('#message-input').dispatchEvent(new w.Event('input'));
click('#compose-more');assert.equal($('#compose-more-panel').hidden,false);
click('[data-action="emoji"]');click('[data-emoji="😊"]');assert.equal($('#message-input').value,'😊');assert.equal($('#send-button').hidden,false);
hooks.onContact({id:'yueliao-qa-peer',name:'Lan',language:'vi',online:true});w.qa.openChat('yueliao-qa-peer');
$('#message-input').value='谢谢';await w.qa.sendText();assert.equal(sent.at(-1).payload.kind,'text');assert.equal($('#message-input').value,'');assert.equal($('#send-button').hidden,true);
click('[data-tab="settings"]');assert.ok($('.my-profile-card'));assert.match($('.my-profile-id').textContent,/越聊号/);
click('.my-profile-name');assert.ok($('#profile-form'));
console.log('Profile, composer, emoji, more menu and peer message checks passed.');w.close();
