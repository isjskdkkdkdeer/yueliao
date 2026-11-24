import assert from 'node:assert/strict';
import {createAudioTranscriber} from './dist/speech-stream.js';

const original = Object.fromEntries(['MediaRecorder','MediaStream','fetch','setTimeout','clearTimeout'].map(key=>[key,globalThis[key]]));
const timers = new Map(); let clock = 0;
globalThis.setTimeout = (fn,delay) => {const id=++clock;timers.set(id,{fn,delay});return id;};
globalThis.clearTimeout = id => timers.delete(id);
const nextClip = () => {
  const item=[...timers.entries()].find(([,value])=>value.delay===4000);
  assert.ok(item,'a segment timer must exist');
  timers.delete(item[0]);item[1].fn();
};
const flush = async () => {for(let i=0;i<8;i++) await Promise.resolve();};
let stoppedTracks=0;
const audioTrack={kind:'audio',readyState:'live',stop(){stoppedTracks++}};
const callStream={getAudioTracks:()=>[audioTrack]};
class AudioStream {constructor(tracks){this.tracks=tracks}getAudioTracks(){return this.tracks}}
globalThis.MediaStream=AudioStream;
let allRecorders=[];
class Recorder {
  static empty=false;
  static isTypeSupported(type){return type==='audio/mp4'}
  constructor(stream,options){this.stream=stream;this.mimeType=options?.mimeType;this.state='inactive';allRecorders.push(this)}
  start(){this.state='recording'}
  stop(){this.state='inactive';this.ondataavailable({data:new Blob(Recorder.empty?[]:[`header-and-audio-${allRecorders.indexOf(this)}`],{type:this.mimeType})});this.onstop()}
}
globalThis.MediaRecorder=Recorder;
const requests=[];
globalThis.fetch=(url,options)=>new Promise((resolve,reject)=>{requests.push({url,options,resolve,reject});});
const texts=[],states=[],errors=[];
const service=createAudioTranscriber({stream:callStream,language:'vi-VN',onText:x=>texts.push(x),onState:(name,details)=>states.push({name,details}),onError:e=>errors.push(e)});
assert.equal(service.supported,true);assert.equal(service.start(),true);
assert.deepEqual(allRecorders[0].stream.getAudioTracks(),[audioTrack],'recorder reuses the call audio track');
nextClip();assert.equal(requests.length,1);assert.equal(allRecorders.length,2,'each clip has a separate recorder/container');
assert.equal(requests[0].url,'/api/speech');assert.equal(requests[0].options.credentials,'same-origin');
assert.equal(requests[0].options.body.get('language'),'vi');assert.equal(requests[0].options.body.get('file').name,'speech.m4a');
nextClip();nextClip();assert.equal(requests.length,1,'uploads serialize instead of racing');
assert.ok(states.some(s=>s.name==='waiting'&&s.details?.reason==='backpressure'));
requests[0].resolve({ok:true,json:async()=>({text:'Xin chào'})});await flush();
assert.equal(requests.length,2);assert.deepEqual(texts,[{text:'Xin chào',isFinal:true}]);
assert.equal(requests[1].options.body.has('context'),false,'old transcripts must not prompt the next clip');
const newestFile=requests[1].options.body.get('file');assert.match(await newestFile.text(),/header-and-audio-2/,'old queued clip was dropped');
service.stop();assert.equal(requests[1].options.signal.aborted,true,'stop aborts the current network request');
requests[1].resolve({ok:true,json:async()=>({text:'late'})});await flush();
assert.equal(texts.length,1,'late response cannot write captions');assert.equal(stoppedTracks,0,'call tracks remain alive');
assert.equal(timers.size,0);assert.equal(states.at(-1).name,'idle');

// A configured endpoint error stops recording and preserves the API error code.
allRecorders=[];
const failure=createAudioTranscriber({stream:callStream,onError:e=>errors.push(e)});
failure.start();nextClip();requests.at(-1).resolve({ok:false,status:503,json:async()=>({error:'请配置服务',code:'NOT_CONFIGURED'})});await flush();
assert.equal(errors.at(-1).code,'NOT_CONFIGURED');assert.equal(errors.at(-1).message,'请配置服务');assert.equal(timers.size,0);assert.equal(stoppedTracks,0);

// The same controller can restart without consuming a stale response from its old session.
service.start();nextClip();const oldRequest=requests.at(-1);service.stop();service.start();
oldRequest.resolve({ok:true,json:async()=>({text:'old session'})});await flush();assert.equal(texts.length,1);
service.stop();assert.equal(timers.size,0);

const beforeEmpty=requests.length;Recorder.empty=true;
service.start();nextClip();assert.equal(requests.length,beforeEmpty,'empty chunks do not create uploads');service.stop();Recorder.empty=false;

globalThis.fetch=(url,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))));
const timeoutService=createAudioTranscriber({stream:callStream,onError:e=>errors.push(e)});
timeoutService.start();nextClip();
const timeout=[...timers.entries()].find(([,value])=>value.delay===12000);assert.ok(timeout);timers.delete(timeout[0]);timeout[1].fn();await flush();
assert.equal(errors.at(-1).code,'TIMEOUT');timeoutService.stop();assert.equal(timers.size,0);

const realSetInterval=globalThis.setInterval, realClearInterval=globalThis.clearInterval;
let tickMeter, level=0, closed=false, meterUploads=0;
globalThis.setInterval=fn=>{tickMeter=fn;return 1};
globalThis.clearInterval=()=>{tickMeter=undefined};
globalThis.AudioContext=class {
  state='running';
  createMediaStreamSource(){return {connect(){},disconnect(){}}}
  createGain(){return {gain:{},connect(){},disconnect(){}}}
  createAnalyser(){return {connect(){},disconnect(){},getFloatTimeDomainData(buffer){for(let i=0;i<buffer.length;i++)buffer[i]=i%2?level:-level;}}}
  async close(){closed=true}
};
globalThis.fetch=async()=>{meterUploads++;return {ok:true,json:async()=>({text:'你好'})}};
const gated=createAudioTranscriber({stream:callStream});
gated.start();
for(let i=0;i<15;i++)tickMeter();
nextClip();assert.equal(meterUploads,0,'measured silence must not be uploaded');
for(let i=0;i<15;i++){level=0.001;tickMeter();}
nextClip();assert.equal(meterUploads,0,'steady background noise is below the adaptive gate');
for(let i=0;i<15;i++){level=i<3?0.0012:0.0002;tickMeter();}
nextClip();assert.equal(meterUploads,1,'short quiet speech still gets uploaded');
gated.stop();await flush();assert.equal(closed,true);assert.equal(tickMeter,undefined);
delete globalThis.AudioContext;
globalThis.setInterval=realSetInterval;globalThis.clearInterval=realClearInterval;

const invalid=createAudioTranscriber({stream:{getAudioTracks:()=>[]}});assert.throws(()=>invalid.start(),e=>e.code==='NO_AUDIO');
globalThis.MediaRecorder=undefined;const unsupported=createAudioTranscriber({stream:callStream});assert.equal(unsupported.supported,false);assert.throws(()=>unsupported.start(),e=>e.code==='UNSUPPORTED');
Object.assign(globalThis,original);
console.log('PASS speech-stream: existing-track reuse, independent playable clips, serialized bounded queue, backpressure, abort/lifecycle guards, endpoint errors and restart isolation.');
