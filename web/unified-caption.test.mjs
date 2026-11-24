import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

const html=await readFile('./dist/index.html','utf8');
const app=(await readFile('./dist/app.js','utf8')).replace(/^import .*;\n/gm,'');
const senders=[];
const pause=()=>new Promise(resolve=>setTimeout(resolve,35));
function phone(id, language) {
  const {window:w}=new JSDOM(html,{url:'https://yueliao.eu.cc',runScripts:'outside-only'});
  const sent=[],requests=[];
  const track={readyState:'live',enabled:true,stop(){}};
  const stream={getAudioTracks:()=>[track],getTracks:()=>[track]};
  w.localStorage.setItem('yueliao-profile',JSON.stringify({id,language,name:id}));
  w.HTMLMediaElement.prototype.play=async()=>{};
  w.createPeerService=()=>({
    connect:async()=>{},disconnect(){},hangup(){},
    send:async(to,payload)=>{sent.push(payload);const receiver=senders.find(phone=>phone.id===to);if(receiver)await receiver.w.qa.receiveMessage(id,payload)},
  });
  w.createAppleSpeech=({stream:input,onText})=>{
    assert.equal(input,stream,'speech reuses the call stream');
    return {supported:true,start:async()=>true,stop(){},emit:(text,isFinal)=>onText({text,isFinal})};
  };
  w.createAudioTranscriber=()=>assert.fail('cloud ASR must not run');
  w.translationPreferences=()=>({onlineSpeech:false,onlineText:false});
  w.translate=(text,from,to,options)=>new Promise(resolve=>requests.push({text,from,to,options,resolve}));
  w.eval(app+`\nglobalThis.qa={state,makeCallState,receiveMessage,renderCall,toggleSubtitles,finishCallUI,
    selectStream:(stream)=>{callStream=stream;},recognition:()=>callRecognition};`);
  const result={id,w,sent,requests,stream,$:selector=>w.document.querySelector(selector)};
  senders.push(result);return result;
}
const a=phone('a','zh'),b=phone('b','vi');
try {
  for(const [phone,other,language] of [[a,b,'zh'],[b,a,'vi']]){
    const q=phone.w.qa;
    q.state.call=q.makeCallState({id:other.id,name:other.id},'audio',{callId:'call-1',captionLanguage:language});
    q.selectStream(phone.stream);
    q.renderCall();
    await pause();
  }
  a.w.qa.recognition().emit('你好',false);
  a.w.qa.recognition().emit('你好呀',true);
  b.w.qa.recognition().emit('Chào bạn',true);
  await pause();
  assert.equal(a.$('#subtitle-remote [data-caption-original]').textContent,'Chào bạn');
  assert.equal(b.$('#subtitle-remote [data-caption-original]').textContent,'你好呀');
  await pause();
  assert.equal(a.requests.find(r=>r.text==='Chào bạn').options.allowOnline,false);
  assert.equal(b.requests.find(r=>r.text==='你好呀').options.mode,'call');
  assert.equal(b.requests.some(r=>r.text==='你好'),false);
  for(const phone of [a,b]) for(const r of phone.requests) r.resolve({text:r.to==='vi'?'Xin chào!':'你好！'});
  await pause();
  assert.equal(a.$('#subtitle-remote [data-caption-translation]').textContent,'你好！');
  assert.equal(b.$('#subtitle-remote [data-caption-translation]').textContent,'Xin chào!');
  assert.ok(a.sent.filter(p=>p.kind==='subtitle').every(p=>!('translation' in p)));
  const old=a.sent.find(p=>p.kind==='subtitle'&&!p.isFinal);
  await b.w.qa.receiveMessage(a.id,old);
  assert.equal(b.$('#subtitle-remote [data-caption-original]').textContent,'你好呀');
  const final=a.sent.find(p=>p.kind==='subtitle'&&p.isFinal);
  await b.w.qa.receiveMessage(a.id,{...final,id:'next',sequence:2,text:'下一句'});
  await pause();
  const outstanding=b.requests.find(r=>r.text==='下一句');
  b.w.qa.finishCallUI('ended');
  assert.equal(outstanding.options.signal.aborted,true);
  outstanding.resolve({text:'expired'});
  await pause();
  assert.equal(b.$('.call-overlay'),null);
  console.log('PASS unified captions: shared mic track, two-way original text, receiver translation, revision order and call teardown.');
} finally {for(const phone of senders)phone.w.close()}
