import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

const html=await readFile('dist/index.html','utf8');
const source=(await readFile('dist/app.js','utf8')).replace(/^import .*;\n/gm,'');
const pages=[];
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};

function browser({supported=true}={}){
  const dom=new JSDOM(html,{url:'https://site.test',runScripts:'outside-only'});
  pages.push(dom);
  const w=dom.window;
  Object.defineProperty(w.navigator,'userAgent',{value:'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1'});
  w.HTMLMediaElement.prototype.play=()=>Promise.resolve();
  const fixture={dom,w,recognitions:[],sent:[],cloudRequests:0,mediaRequests:0};
  const tracks=[{enabled:true,readyState:'live',stop(){this.stopped=true;}}];
  fixture.stream={getAudioTracks:()=>tracks,getVideoTracks:()=>[],getTracks:()=>tracks};
  Object.defineProperty(w.navigator,'mediaDevices',{value:{getUserMedia:async()=>{fixture.mediaRequests++;return fixture.stream;}}});
  w.translationPreferences=()=>({onlineText:false,onlineSpeech:false});
  w.createAppleSpeech=options=>{
    assert.equal(options.stream,fixture.stream);
    const recognition={options,supported,active:false,starts:0,stops:0,
      start(){this.starts++;this.active=true;options.onState('listening');return true;},
      stop(){this.stops++;this.active=false;options.onState('idle');},
    };
    fixture.recognitions.push(recognition);
    return recognition;
  };
  w.createAudioTranscriber=()=>{throw new Error('Removed cloud recognition must not be used');};
  w.fetch=async url=>{if(String(url).includes('/speech'))fixture.cloudRequests++;throw new Error('Removed cloud configuration must not be requested');};
  w.translate=async()=>({text:'Xin chào'});w.speak=async()=>{};
  w.createPeerService=hooks=>{
    fixture.hooks=hooks;
    return {
      connect:async()=>{},resume:async()=>{},addFriend:async()=>{},
      call:async()=>({metadata:{callId:'ios-call'}}),
      answer:async()=>hooks.onCallStream({localStream:fixture.stream,remoteStream:fixture.stream}),
      send:async(id,payload)=>fixture.sent.push({id,payload}),
      hangup(){},setMuted(){},setCamera(){},disconnect(){},
    };
  };
  w.eval(source+'\nglobalThis.qa={state,openChat,startCall,toggleSubtitles,endCall,renderCall};');
  fixture.$=selector=>w.document.querySelector(selector);
  fixture.addFriend=()=>{fixture.hooks.onContact({id:'yueliao-ios-friend',name:'Linh',language:'vi',online:true});w.qa.openChat('yueliao-ios-friend');};
  return fixture;
}

try{
  const caller=browser();caller.addFriend();
  await caller.w.qa.startCall('video',true);
  assert.equal(caller.recognitions.length,0,'opening a call must wait for explicitly granted microphone media');
  assert.equal(caller.$('#subtitle-mode'),null,'there is no cloud/browser mode selector');
  assert.equal(caller.$('#subtitle-login'),null,'removed cloud recognition has no login flow');
  caller.hooks.onCallStream({localStream:caller.stream,remoteStream:null});await flush();
  assert.equal(caller.recognitions.length,1,'video captions start automatically when local call audio is available');
  assert.equal(caller.recognitions[0].starts,1);
  assert.equal(caller.recognitions[0].options.language,'zh-CN');
  assert.equal(caller.$('#subtitle-toggle').getAttribute('aria-pressed'),'true');
  caller.hooks.onCallStream({localStream:caller.stream,remoteStream:caller.stream});await flush();
  assert.equal(caller.recognitions.length,1,'remote streams do not restart active recognition');
  await caller.w.qa.toggleSubtitles();
  assert.equal(caller.recognitions[0].active,false);
  caller.hooks.onCallStream({localStream:caller.stream,remoteStream:caller.stream});await flush();
  assert.equal(caller.recognitions.length,1,'manual caption stop stays stopped after another stream update');
  await caller.w.qa.toggleSubtitles();
  assert.equal(caller.recognitions.length,2,'the user can explicitly restart captions');
  assert.equal(caller.recognitions[1].starts,1);
  caller.$('#call-mic').click();
  assert.equal(caller.recognitions[1].active,false,'muting pauses speech recognition');
  caller.$('#call-mic').click();await flush();
  assert.equal(caller.recognitions.length,3,'unmuting restores captions that the user had left enabled');
  assert.equal(caller.recognitions[2].active,true);
  caller.w.qa.endCall();assert.equal(caller.recognitions[2].active,false,'hanging up stops recognition');
  assert.equal(caller.cloudRequests,0);

  const audio=browser();audio.addFriend();
  await audio.w.qa.startCall('audio',true);audio.hooks.onCallStream({localStream:audio.stream,remoteStream:audio.stream});await flush();
  assert.equal(audio.recognitions.length,1,'audio calls auto-start captions after microphone media');
  audio.w.qa.renderCall();assert.equal(audio.$('#subtitle-toggle').getAttribute('aria-pressed'),'true','UI redraw preserves active subtitles');
  assert.match(audio.$('#subtitle-toggle').textContent,/关闭字幕/);
  await audio.w.qa.toggleSubtitles();assert.equal(audio.recognitions[0].active,false);
  audio.w.qa.endCall();

  const callee=browser();callee.addFriend();
  const incoming={metadata:{kind:'video',callId:'incoming-video'},peer:'yueliao-ios-friend',close(){}};
  callee.hooks.onIncomingCall({peerId:'yueliao-ios-friend',kind:'video',call:incoming});
  assert.equal(callee.recognitions.length,0,'an unanswered incoming call cannot start microphone recognition');
  callee.$('#call-answer').click();await flush();
  assert.equal(callee.recognitions.length,1,'accepting a video call automatically enables local captions');
  assert.equal(callee.recognitions[0].active,true);
  callee.w.qa.endCall();

  const prompt=browser();prompt.addFriend();
  await prompt.w.qa.startCall('video');
  assert.ok(prompt.$('#call-permission-continue'));
  prompt.$('#call-permission-cancel').click();
  assert.equal(prompt.recognitions.length,0);
  assert.equal(prompt.mediaRequests,0);

  const unsupported=browser({supported:false});unsupported.addFriend();
  await unsupported.w.qa.startCall('video',true);
  unsupported.hooks.onCallStream({localStream:unsupported.stream,remoteStream:unsupported.stream});await flush();
  assert.equal(unsupported.recognitions.length,1);
  assert.equal(unsupported.recognitions[0].starts,0,'unsupported recognition cannot be represented as listening');
  assert.equal(unsupported.$('#caption-text-form').hidden,false,'an unsupported browser gets a usable text-caption fallback');
  assert.ok(unsupported.$('#subtitle-status').textContent);
  assert.ok(unsupported.w.qa.state.call,'unsupported speech must not end the video call');
  unsupported.$('#caption-text-input').value='你好';
  unsupported.$('#caption-text-form').dispatchEvent(new unsupported.w.Event('submit',{cancelable:true}));await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(unsupported.$('#subtitle-local [data-caption-original]').textContent,'你好');
  assert.equal(unsupported.$('#subtitle-local [data-caption-translation]').textContent,'Xin chào');
  assert.ok(unsupported.sent.some(({payload})=>payload.kind==='subtitle'&&payload.text==='你好'&&!('translation' in payload)));
  assert.equal(unsupported.cloudRequests,0);
  unsupported.w.qa.endCall();

  console.log('PASS video captions: automatic local recognition after permitted call media, incoming answer and outgoing permission gates, single startup, explicit stop/retry, no cloud flow, and honest unsupported text fallback.');
}finally{
  for(const dom of pages){dom.window.qa.endCall();dom.window.close();}
}
