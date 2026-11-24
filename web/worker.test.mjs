import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createSpeechApi} from './worker/speech-api.js';

const origin='https://example.test';
const env={GROQ_API_KEY:'test-secret-never-published',SPEECH_ALLOWED_EMAILS:'friend@example.test,OWNER@example.test'};
const user={'oai-authenticated-user-id':'visitor-1','oai-authenticated-user-email':'Friend@Example.Test'};
const audio=new Uint8Array([0,0,0,20,0x66,0x74,0x79,0x70,0x6d,0x34,0x61,0x20,0,0,0,0]);
function request({headers=user,bytes=audio,mime='audio/mp4',language='vi',filename='speech.m4a'}={}){
  const body=new FormData();body.append('file',new Blob([bytes],{type:mime}),filename);body.append('language',language);
  return new Request(origin+'/api/speech',{method:'POST',headers:{'X-YueLiao-Consent':'speech',...headers},body});
}
const result=async response=>({status:response.status,...await response.json()});
let calls=[];
const api=createSpeechApi({fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json({text:' Xin chào '})}});

assert.equal(await api(new Request(origin+'/unrelated'),env),null);
assert.deepEqual(await (await api(new Request(origin+'/api/speech-config'),{})).json(),{configured:false,authenticated:false,authorized:false,signInUrl:'/signin-with-chatgpt'});
assert.deepEqual(await (await api(new Request(origin+'/api/speech-config',{headers:user}),env)).json(),{configured:true,authenticated:true,authorized:true,signInUrl:'/signin-with-chatgpt'});
assert.equal((await api(new Request(origin+'/api/speech-config',{method:'POST'}),env)).status,405);
assert.equal((await api(new Request(origin+'/api/speech'),env)).status,405);
assert.equal((await result(await api(request(),{}))).code,'NOT_CONFIGURED');
assert.equal((await result(await api(request({headers:{}}),env))).code,'AUTH_REQUIRED');
assert.equal((await result(await api(request({headers:{...user,'oai-authenticated-user-email':'stranger@example.test'}}),env))).code,'FORBIDDEN');
assert.equal((await result(await api(request({headers:{...user,Origin:'https://attacker.test'}}),env))).code,'FORBIDDEN');
assert.equal((await result(await api(request(),{...env,GROQ_API_KEY:'',OPENAI_API_KEY:'openai-only'}))).code,'NOT_CONFIGURED');
assert.equal(calls.length,0,'reject authentication/config/origin before paid requests');
assert.deepEqual(await result(await api(request({headers:{...user,Origin:origin}}),env)),{status:200,text:'Xin chào'});
assert.equal(calls.length,1);
assert.equal(calls[0].url,'https://api.groq.com/openai/v1/audio/transcriptions');
assert.equal(calls[0].options.body.get('language'),'vi');
assert.equal(calls[0].options.body.get('model'),'whisper-large-v3');
assert.equal(calls[0].options.body.get('file').size,audio.length);
assert.equal(calls[0].options.headers.Authorization,'Bearer '+env.GROQ_API_KEY);
const groqEnv={...env,GROQ_API_KEY:'test-groq-key'};
const groq=createSpeechApi({fetchImpl:async (_url, options)=>{
  assert.equal(options.body.get('response_format'),'verbose_json');
  assert.equal(options.body.get('model'),'whisper-large-v3');
  assert.equal(options.body.get('temperature'),'0');
  assert.equal(options.body.has('prompt'),false);
  return Response.json({text:'凭空出现 说话 好',segments:[
    {text:'凭空出现',no_speech_prob:0.94,avg_logprob:-0.2},
    {text:'说话',no_speech_prob:0.08,avg_logprob:-1.2},
    {text:'好',no_speech_prob:0.65,avg_logprob:-0.3},
    {text:'字幕志愿者 杨茜茜',no_speech_prob:0.02,avg_logprob:-0.2},
    {text:'请点赞订阅转发',no_speech_prob:0.02,avg_logprob:-0.2},
    {text:'低可信片段',no_speech_prob:0.05,avg_logprob:-1.7},
  ]});
}});
assert.deepEqual(await result(await groq(request(),groqEnv)),{status:200,text:'说话 好'});
const silent=createSpeechApi({fetchImpl:async()=>Response.json({
  text:'凭空出现',segments:[{text:'凭空出现',no_speech_prob:0.93,avg_logprob:-1.6}],
})});
assert.deepEqual(await result(await silent(request(),groqEnv)),{status:200,text:''});
for (const [language, fragments, expected] of [
  ['zh', ['字幕志愿者 杨茜茜'], ''],
  ['zh', ['谢谢观看'], ''],
  ['zh', ['字幕由Amara.org社区提供'], ''],
  ['zh', ['中文字幕志愿者 李宗盛'], ''],
  ['zh', ['你好，请不吝', '点赞订阅…'], '你好'],
  ['zh', ['你好。请不吝点赞、订阅、转发、打赏支持明镜与点点栏目。'], '你好'],
  ['vi', ['Hãy subscribe cho kênh Ghiền Mì Gõ…'], ''],
  ['vi', ['Cảm ơn các bạn đã theo dõi…'], ''],
  ['vi', ['Xin chào. Cảm ơn các bạn đã theo dõi…'.normalize('NFD')], 'Xin chào'],
  ['vi', ['Cảm ơn bạn đã gọi cho tôi.'], 'Cảm ơn bạn đã gọi cho tôi.'],
  ['zh', ['你好，我刚刚看完视频。'], '你好，我刚刚看完视频。'],
]) {
  const caption = createSpeechApi({fetchImpl:async () => Response.json({
    text:fragments.join(' '),
    segments:fragments.map(text => ({text, no_speech_prob:0.05, avg_logprob:-0.1})),
  })});
  assert.deepEqual(await result(await caption(request({language}), groqEnv)), {status:200,text:expected});
}

assert.equal((await result(await api(request({language:'en'}),env))).code,'INVALID_LANGUAGE');
assert.equal((await result(await api(request({mime:'text/plain'}),env))).code,'INVALID_AUDIO');
assert.equal((await result(await api(request({bytes:new Uint8Array(16)}),env))).code,'INVALID_AUDIO');
assert.equal((await result(await api(request({filename:''}),env))).code,'INVALID_AUDIO');
const plain=new Request(origin+'/api/speech',{method:'POST',headers:{...user,'X-YueLiao-Consent':'speech'},body:'not multipart'});
assert.equal((await result(await api(plain,env))).code,'INVALID_AUDIO');
const large=request();large.headers.set('Content-Length',String(3*1024*1024));
assert.equal((await result(await api(large,env))).code,'TOO_LARGE');
const streamed=new Request(origin+'/api/speech',{method:'POST',headers:{...user,'X-YueLiao-Consent':'speech','Content-Type':'multipart/form-data; boundary=qa'},duplex:'half',body:new ReadableStream({start(controller){controller.enqueue(new Uint8Array(2*1024*1024+1));controller.close()}})});
assert.equal((await result(await api(streamed,env))).code,'TOO_LARGE');

const providers=[
  [async()=>new Response('upstream secret',{status:429}),429,'RATE_LIMIT'],
  [async()=>new Response('upstream secret',{status:401}),502,'UNAVAILABLE'],
  [async()=>Response.json({wrong:'shape'}),502,'UNAVAILABLE'],
  [async()=>new Response('invalid json'),502,'UNAVAILABLE'],
  [async()=>{throw Error('secret error')},502,'UNAVAILABLE'],
  [async()=>new Promise(()=>{}),504,'TIMEOUT'],
];
for(const [fetchImpl,status,code] of providers){
  const value=await result(await createSpeechApi({fetchImpl,timeoutMs:5})(request(),env));
  assert.equal(value.status,status);assert.equal(value.code,code);
  assert.ok(!JSON.stringify(value).includes('secret'),'never expose upstream credentials/errors');
}
let time=1000;
const limited=createSpeechApi({fetchImpl:async()=>Response.json({text:'你好'}),now:()=>time,limit:2});
assert.equal((await limited(request(),env)).status,200);
assert.equal((await limited(request(),env)).status,200);
assert.equal((await result(await limited(request(),env))).code,'RATE_LIMIT');
time+=60001;assert.equal((await limited(request(),env)).status,200);

await import('./scripts/build-worker.mjs?qa='+Date.now());
const worker=(await import('./dist/server/index.js?qa='+Date.now())).default;
const homepage=await worker.fetch(new Request(origin+'/'),{});
assert.equal(homepage.status,200);assert.match(homepage.headers.get('Content-Type'),/text\/html/);
assert.match(await homepage.text(),/越聊/);
const javascript=await worker.fetch(new Request(origin+'/app.js'),{});
assert.match(javascript.headers.get('Content-Type'),/javascript/);
const image=await worker.fetch(new Request(origin+'/assets/linh.jpg'),{});
assert.equal(image.status,200);assert.equal(image.headers.get('Content-Type'),'image/jpeg');
assert.equal((await worker.fetch(new Request(origin+'/server/index.js'),{})).status,404);
assert.equal((await worker.fetch(new Request(origin+'/.openai/hosting.json'),{})).status,404);
assert.equal((await worker.fetch(new Request(origin+'/missing'),{})).status,404);
const head=await worker.fetch(new Request(origin+'/app.js',{method:'HEAD'}),{});assert.equal(head.status,200);assert.equal(await head.text(),'');
assert.equal((await worker.fetch(new Request(origin+'/',{method:'POST'}),{})).status,405);
assert.equal((await (await worker.fetch(new Request(origin+'/api/speech-config'),{})).json()).configured,false);
const built=await readFile('./dist/server/index.js','utf8');assert.ok(!built.includes(env.GROQ_API_KEY));
console.log('PASS Worker: config/auth/allowlist/origin, bounded multipart and audio validation, provider mapping/timeout/rate limit, secret isolation, embedded static assets and HTTP methods.');
