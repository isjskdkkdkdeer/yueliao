import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

const html=await readFile('./dist/index.html','utf8');
const source=(await readFile('./dist/app.js','utf8')).replace(/^import .*;\n/gm,'');
const endpoints=[];
let nextCall=0;
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve()};

function browser({id,name,language}) {
  const dom=new JSDOM(html,{url:'https://example.test',runScripts:'outside-only'});
  const w=dom.window;
  const endpoint={id,name,language,dom,w,recognitions:[],translations:[],sent:[],deliveryErrors:[]};
  endpoints.push(endpoint);
  w.localStorage.setItem('yueliao-profile',JSON.stringify({id,name,language}));
  w.HTMLMediaElement.prototype.play=()=>Promise.resolve();
  const stream=()=>{const audio={enabled:true,readyState:'live',stop(){}};return {getTracks:()=>[audio],getAudioTracks:()=>[audio],getVideoTracks:()=>[]};};
  Object.defineProperty(w.navigator,'mediaDevices',{value:{getUserMedia:async()=>stream()}});
  w.speak=async()=>{};
  w.translate=(text,from,to)=>new Promise((resolve,reject)=>{
    endpoint.translations.push({text,from,to,resolve,reject});
  });
  w.createSpeechRecognition=options=>{
    const recognition={options,supported:true,active:false,start(){this.active=true;options.onState('listening');return true},stop(){this.active=false;options.onState('idle')},emit(text,isFinal=true){return options.onText({text,isFinal})}};
    endpoint.recognitions.push(recognition);
    return recognition;
  };
  w.createPeerService=hooks=>{
    endpoint.hooks=hooks;
    return {
      connect:async()=>hooks.onStatus({state:'ready',message:'已连接'}),
      addFriend:async peerId=>{const other=endpoints.find(e=>e.id===peerId);hooks.onContact({id:peerId,name:other?.name||'好友',language:other?.language||'vi',online:true})},
      send:async(peerId,payload)=>{
        if(endpoint.failSends)throw new Error('好友暂未上线');
        const wire=structuredClone(payload);
        endpoint.sent.push(wire);
        const other=endpoints.find(e=>e.id===peerId);
        if(other)Promise.resolve(other.w.qa.receiveMessage(id,wire)).catch(error=>endpoint.deliveryErrors.push(error));
      },
      call:async(peerId,kind,options)=>{
        const other=endpoints.find(e=>e.id===peerId);
        const callId=(typeof options==='string'?options:options?.callId)||endpoint.w.qa.state.call?.callId||`qa-call-${++nextCall}`;
        const connection={connectionId:callId,metadata:{kind,callId},peer:peerId,close(){}};
        const incoming={...connection,peer:id};
        other.hooks.onIncomingCall({peerId:id,kind,callId,call:incoming});
        endpoint.call={connection,other,incoming};
        other.call={connection:incoming,other:endpoint,incoming:connection};
        return connection;
      },
      answer:async()=>{
        const c=endpoint.call;
        for(const e of [endpoint,c.other])e.hooks.onCallStream({peerId:e.call.other.id,kind:'video',callId:e.call.connection.metadata.callId,localStream:stream(),remoteStream:stream()});
      },
      hangup(){},setMuted(){},setCamera(){},disconnect(){},
    };
  };
  w.eval(source+'\nglobalThis.qa={state,openChat,startCall,receiveMessage,endCall};');
  endpoint.$=selector=>w.document.querySelector(selector);
  endpoint.click=selector=>{const element=endpoint.$(selector);assert.ok(element,`missing ${selector}`);element.click()};
  endpoint.slot=(side,field)=>endpoint.$(`#subtitle-${side} [data-caption-${field}]`)?.textContent;
  endpoint.resolve=(text,translation)=>{
    const pending=endpoint.translations.filter(t=>t.text===text&&!t.done);
    assert.ok(pending.length,`expected a pending ${name} translation for ${text}`);
    for(const item of pending){item.done=true;item.resolve({text:translation,provider:'test'})}
  };
  return endpoint;
}

const a=browser({id:'yueliao-test-a',name:'中文朋友',language:'zh'});
const b=browser({id:'yueliao-test-b',name:'Bạn Việt',language:'vi'});

async function connectCall(){
  for(const [self,other] of [[a,b],[b,a]]){
    self.hooks.onContact({id:other.id,name:other.name,language:other.language,online:true});
    self.w.qa.openChat(other.id);
  }
  const beforeA=a.recognitions.length,beforeB=b.recognitions.length;
  await a.w.qa.startCall('video');
  assert.equal(a.recognitions.length,beforeA,'caller waits for permitted microphone media');
  assert.equal(b.recognitions.length,beforeB,'unanswered incoming video does not start speech recognition');
  b.click('#call-answer');
  await flush();
}

try {
  await connectCall();
  for(const endpoint of [a,b]){
    assert.ok(endpoint.$('.caption-lanes'),'both speakers must have a dedicated shared layout');
    for(const [side,speaker,waiting] of [['local','我说的','等待我说话…'],['remote','她说的','等待她说话…']]){
      const lane=endpoint.$(`#subtitle-${side}`);
      assert.ok(lane,`must have independent ${side} caption slot`);
      assert.equal(lane.hidden,false,'both speaker cards remain visible before anyone speaks');
      assert.equal(lane.querySelector('.caption-speaker').textContent.trim(),speaker);
      assert.equal(lane.querySelector('[data-caption-placeholder]').textContent,waiting);
      assert.equal(lane.querySelector('[data-caption-placeholder]').hidden,false);
      assert.equal(lane.querySelector('[data-caption-content]').hidden,true,'empty cards show a waiting state instead of an empty transcript');
      assert.equal(endpoint.slot(side,'original'),'');
      assert.equal(endpoint.slot(side,'translation'),'');
      assert.deepEqual([...lane.querySelectorAll('.caption-field-label')].map(label=>label.textContent),['原文','译文']);
    }
    assert.ok(endpoint.$('#subtitle-language'),'must let each speaker choose recognition language');
    assert.equal(endpoint.recognitions.length,1,'both sides start captions automatically after video audio is ready');
    assert.equal(endpoint.recognitions[0].active,true);
    assert.equal(endpoint.$('#subtitle-mode'),null,'cloud recognition selection is removed');
  }
  a.$('#subtitle-language').value='zh';
  a.$('#subtitle-language').dispatchEvent(new a.w.Event('change'));
  b.$('#subtitle-language').value='vi';
  b.$('#subtitle-language').dispatchEvent(new b.w.Event('change'));
  let ar=a.recognitions.at(-1),br=b.recognitions.at(-1);
  assert.equal(ar.options.language,'zh-CN');
  assert.equal(br.options.language,'vi-VN');

  // One speaker activates only their own card; the other speaker keeps waiting.
  ar.emit('你好，我在这里',false);
  await flush();
  for(const [endpoint,spoken,waiting] of [[a,'local','remote'],[b,'remote','local']]){
    assert.equal(endpoint.$(`#subtitle-${spoken} [data-caption-content]`).hidden,false);
    assert.equal(endpoint.$(`#subtitle-${spoken} [data-caption-placeholder]`).hidden,true);
    assert.equal(endpoint.$(`#subtitle-${waiting}`).hidden,false);
    assert.equal(endpoint.$(`#subtitle-${waiting} [data-caption-content]`).hidden,true);
    assert.equal(endpoint.$(`#subtitle-${waiting} [data-caption-placeholder]`).hidden,false);
    assert.equal(endpoint.slot(waiting,'original'),'');
  }
  // Both devices then speak before either translation returns.
  br.emit('Xin chào, tôi ở đây',false);
  await flush();
  assert.equal(a.slot('local','original'),'你好，我在这里');
  assert.equal(a.slot('remote','original'),'Xin chào, tôi ở đây');
  assert.equal(b.slot('local','original'),'Xin chào, tôi ở đây');
  assert.equal(b.slot('remote','original'),'你好，我在这里');
  assert.ok(a.sent.some(p=>p.kind==='subtitle'&&p.isFinal===false),'send interim text before translating');
  assert.ok(b.sent.some(p=>p.kind==='subtitle'&&p.isFinal===false));

  ar.emit('你好，我在这里');br.emit('Xin chào, tôi ở đây');
  await flush();
  assert.equal(a.slot('remote','original'),'Xin chào, tôi ở đây');
  b.resolve('Xin chào, tôi ở đây','你好，我在这里（越译中）');await flush();
  a.resolve('你好，我在这里','Xin chào, tôi ở đây (中译越)');await flush();
  assert.equal(a.slot('local','translation'),'Xin chào, tôi ở đây (中译越)');
  assert.equal(a.slot('remote','translation'),'你好，我在这里（越译中）');
  assert.equal(b.slot('local','translation'),'你好，我在这里（越译中）');
  assert.equal(b.slot('remote','translation'),'Xin chào, tôi ở đây (中译越)');

  // A slow earlier phrase must never replace a newer phrase on either screen.
  ar.emit('第一句话');await flush();
  ar.emit('第二句话');await flush();
  a.resolve('第二句话','Câu thứ hai');await flush();
  a.resolve('第一句话','Câu thứ nhất');await flush();
  assert.equal(a.slot('local','original'),'第二句话');
  assert.equal(a.slot('local','translation'),'Câu thứ hai');
  assert.equal(b.slot('remote','original'),'第二句话');
  assert.equal(b.slot('remote','translation'),'Câu thứ hai');
  assert.equal(a.slot('remote','original'),'Xin chào, tôi ở đây','local caption updates cannot overwrite the remote original');
  assert.equal(a.slot('remote','translation'),'你好，我在这里（越译中）','local translation updates cannot overwrite the remote translation');
  assert.equal(b.slot('local','translation'),'你好，我在这里（越译中）');

  assert.ok(a.$('#subtitle-local .caption-history').textContent.includes('Câu'), 'previous translations remain in scrolling history');
  assert.ok(b.$('#subtitle-remote .caption-history').textContent.includes('Câu thứ nhất'), 'late translation updates remote history after a newer phrase');
  const markup='<img src=x onerror=alert(1)>';
  ar.emit(markup);await flush();
  a.resolve(markup,'<b>Only text</b>');await flush();
  for(const [endpoint,side] of [[a,'local'],[b,'remote']]){
    assert.equal(endpoint.slot(side,'original'),markup);
    assert.equal(endpoint.slot(side,'translation'),'<b>Only text</b>');
    assert.equal(endpoint.$(`#subtitle-${side} [data-caption-original] img`),null,'spoken text must not become HTML');
    assert.equal(endpoint.$(`#subtitle-${side} [data-caption-translation] b`),null,'translated text must not become HTML');
  }

  ar.emit('失败后重试字幕');await flush();
  a.translations.find(t=>t.text==='失败后重试字幕').reject(new Error('网络暂不可用'));await flush();
  assert.ok(a.$('[data-caption-retry]'),'failed subtitle offers a retry');
  a.click('[data-caption-retry]');await flush();
  a.translations.filter(t=>t.text==='失败后重试字幕').at(-1).resolve({text:'Thử lại phụ đề'});await flush();
  assert.equal(a.slot('local','translation'),'Thử lại phụ đề');
  assert.equal(b.slot('remote','translation'),'Thử lại phụ đề','retry updates the same remote subtitle');
  assert.equal(a.$('[data-caption-retry]'),null);

  // Safari can leave results interim indefinitely; stable text must still translate.
  ar.emit('没有最终识别结果',false);
  await new Promise(resolve=>setTimeout(resolve,950));
  a.resolve('没有最终识别结果','Bản dịch tạm thời');await flush();
  assert.equal(a.slot('local','translation'),'Bản dịch tạm thời');
  assert.equal(b.slot('remote','translation'),'Bản dịch tạm thời');
  ar.emit('没有最终识别结果',true);await flush();
  a.resolve('没有最终识别结果','Bản dịch hoàn chỉnh');await flush();
  assert.equal(b.slot('remote','translation'),'Bản dịch hoàn chỉnh');

  const beforeNotice=a.$('#toast').textContent;
  a.hooks.onStatus({state:'error',peerId:'unrelated-friend',message:'好友暂未上线'});
  assert.equal(a.$('#toast').textContent,beforeNotice,'unrelated background reconnect must not interrupt a call');
  a.failSends=true;
  ar.emit('字幕通道断开时');await flush();
  a.resolve('字幕通道断开时','Bản dịch vẫn thành công');await flush();
  assert.equal(a.slot('local','translation'),'Bản dịch vẫn thành công');
  assert.equal(a.$('[data-caption-retry]'),null,'transport failure is not a translation failure');
  assert.ok(a.w.qa.state.call,'data-channel outage must not end the video call');
  a.failSends=false;
  ar.emit('字幕通道恢复');await flush();
  a.resolve('字幕通道恢复','Kết nối đã khôi phục');await flush();
  assert.equal(b.slot('remote','translation'),'Kết nối đã khôi phục');
  assert.ok(b.$('#subtitle-remote .caption-history').textContent.includes('Bản dịch vẫn thành công'),'queued final caption is sent after recovery');

  // Stopping or muting invalidates asynchronous translation callbacks.
  ar.emit('关闭字幕之前');await flush();
  a.click('#subtitle-toggle');
  const sentAfterStop=a.sent.length;
  a.resolve('关闭字幕之前','Before captions stop');await flush();
  assert.equal(a.sent.length,sentAfterStop,'disabled captions must not send late translations');
  a.click('#subtitle-toggle');ar=a.recognitions.at(-1);
  ar.emit('静音之前');await flush();
  a.click('#call-mic');
  const sentAfterMute=a.sent.length;
  a.resolve('静音之前','Before muting');await flush();
  assert.equal(a.sent.length,sentAfterMute,'muting must cancel pending subtitle delivery');

  const oldPacket=a.sent.find(p=>p.kind==='subtitle'&&p.translation);
  assert.ok(oldPacket,'capture an actual previous-call subtitle packet');
  a.w.qa.endCall();b.w.qa.endCall();
  await connectCall();
  await b.w.qa.receiveMessage(a.id,oldPacket);await flush();
  assert.equal(b.slot('remote','original'),'','old-call captions must not leak into new call');
  assert.equal(a.deliveryErrors.length,0);assert.equal(b.deliveryErrors.length,0);
  console.log('PASS subtitles: visible speaker cards and waiting states, independent original/translation fields, simultaneous Chinese/Vietnamese speech, safe text rendering, reordered translations, per-speaker languages, stop/mute cancellation, and previous-call isolation.');
} finally {
  for(const endpoint of endpoints){endpoint.w.qa.endCall();endpoint.dom.window.close()}
}
