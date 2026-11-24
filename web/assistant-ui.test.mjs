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
const translationCalls=[];w.translate=async(text,from,to)=>{translationCalls.push({text,from,to});return {text:from==='vi'?'你好（译文）':'Xin chào (bản dịch)'}};w.speak=async()=>{};
w.createSpeechRecognition=()=>({supported:false,start(){},stop(){}});
w.createPeerService=options=>{hooks=options;return {connect:async profile=>{hooks.onStatus({state:'ready',message:'在线',peerId:profile.id})},resume:async()=>{},addFriend:async id=>hooks.onContact({id,name:'Lan',language:'vi',online:true}),send:async(id,payload)=>sent.push({id,payload}),call:async()=>{},answer:async()=>{},hangup(){},setMuted(){},setCamera(){},disconnect(){}}};
let source=await readFile('./dist/app.js','utf8');
source=source.replace(/^import .*;\n/gm,'');
w.AbortSignal=AbortSignal;w.fetch=async()=>Response.json({text:'你好，我是 AI 助手'});
w.localStorage.setItem('yueliao-contacts',JSON.stringify([{id:'demo-linh',demo:true},{id:'real-friend',name:'真实好友'}]));
w.eval(source+'\nglobalThis.qa={state,openChat,sendText,receiveMessage,recordVoice,stopRecording,endCall,save};');
const $=s=>w.document.querySelector(s),click=s=>$(s).click();
const flush=()=>new Promise(r=>setTimeout(r,10));

assert.equal(w.qa.state.contacts.length,2);
assert.ok(w.qa.state.contacts.some(c=>c.id==='real-friend'));
assert.ok(!w.qa.state.contacts.some(c=>c.id==='demo-linh'));
$('#message-input').value='你好';await w.qa.sendText();
assert.equal(w.qa.state.messages['ai-assistant'].at(-1).text,'你好，我是 AI 助手');
assert.equal(sent.length,0);
assert.equal(w.qa.state.messages['ai-assistant'].at(-1).translation,'Xin chào (bản dịch)');
assert.equal(w.qa.state.messages['ai-assistant'].at(-2).translation,'Xin chào (bản dịch)');
w.fetch=async()=>Response.json({text:'Xin chào, tôi có thể giúp bạn.'});
$('#message-input').value='Xin chào';await w.qa.sendText();
assert.equal(w.qa.state.messages['ai-assistant'].at(-1).lang,'vi');
assert.equal(w.qa.state.messages['ai-assistant'].at(-1).translation,'你好（译文）');
assert.ok(translationCalls.some(x=>x.from==='vi'&&x.to==='zh-CN'));
w.qa.state.auto=false;const before=translationCalls.length;$('#message-input').value='谢谢';await w.qa.sendText();assert.equal(translationCalls.length,before);
w.qa.state.auto=true;w.translate=async()=>{throw Error('offline')};$('#message-input').value='继续';await w.qa.sendText();assert.equal(w.qa.state.messages['ai-assistant'].at(-1).translationError,true);assert.ok($('[data-retry]'));

w.fetch=async()=>Response.json({error:'请登录后使用 AI 助手'},{status:401});
$('#message-input').value='继续';await w.qa.sendText();
assert.ok(w.document.querySelector('a[href="/signin-with-chatgpt"]'));
assert.equal(w.qa.state.messages['ai-assistant'].at(-1).error,true);
w.close();
console.log('Assistant migration, response, auth error and friend preservation passed');
