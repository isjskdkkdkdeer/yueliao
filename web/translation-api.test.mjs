import assert from 'node:assert/strict';
import {createTranslationApi} from './worker/translation-api.js';

const url='https://example.test/api/translate';
const env={GLM_API_KEY:'private-test-key',GROQ_API_KEY:'speech-test-key',
  SPEECH_ALLOWED_EMAILS:'owner@example.test',SPEECH_GROQ_ALLOWED_EMAILS:'tester@example.test'};
const auth={'oai-authenticated-user-id':'1','oai-authenticated-user-email':'tester@example.test'};
const translation={text:'你好',source:'zh-CN',target:'vi'};
const request=(headers=auth,body=translation)=>new Request(url,{method:'POST',headers:{'X-YueLiao-Consent':'translation',...headers},body:JSON.stringify(body)});
let calls=0;
const api=createTranslationApi({fetchImpl:async (endpoint,options)=>{
  calls++;
  assert.equal(endpoint,'https://api.z.ai/api/paas/v4/chat/completions');
  assert.equal(options.headers.Authorization,'Bearer '+env.GLM_API_KEY);
  const body=JSON.parse(options.body);
  assert.deepEqual(body.messages[1],{role:'user',content:'你好'});
  assert.equal(body.thinking.type,'disabled');
  assert.match(body.messages[0].content,/Simplified Chinese to Vietnamese/);
  return Response.json({choices:[{finish_reason:'stop',message:{content:'Xin chào'}}]});
}});
assert.equal((await api(request(),{})).status,503);
assert.equal((await api(request({}),env)).status,401);
assert.equal((await api(request({...auth,'oai-authenticated-user-email':'other@example.test'}),env)).status,403);
assert.equal((await api(request({...auth,Origin:'https://other.example.test'}),env)).status,403);
assert.equal((await api(request(auth,{...translation,text:'字'.repeat(451)}),env)).status,400);
assert.equal((await api(request({...auth,'X-YueLiao-Consent':''}),env)).status,403);
assert.equal(calls,0);
assert.deepEqual(await (await api(request(),env)).json(),{text:'Xin chào',provider:'glm',model:'glm-4.7-flash'});
assert.equal(calls,1);
const quota=createTranslationApi({fetchImpl:async()=>new Response('',{status:429})});
assert.equal((await quota(request(),env)).status,429);
const invalid=createTranslationApi({fetchImpl:async()=>Response.json({data:{translations:[]}})});
assert.equal((await invalid(request(),env)).status,502);
const slow=createTranslationApi({timeoutMs:1,fetchImpl:()=>new Promise(()=>{})});
assert.equal((await slow(request(),env)).status,504);
console.log('PASS GLM translation: server-only key, validation, access, quota, malformed responses and timeout.');

const models=[];
const fallback=createTranslationApi({fetchImpl:async (_url,options)=>{
  models.push(JSON.parse(options.body).model);
  return models.length===1?new Response('',{status:429}):Response.json({choices:[{finish_reason:'stop',message:{content:'Xin chào'}}]});
}});
assert.equal((await (await fallback(request(),env)).json()).model,'glm-4-flash');
assert.deepEqual(models,['glm-4.7-flash','glm-4-flash']);

const malformedModels=[];
const malformedFallback=createTranslationApi({fetchImpl:async (_url,options)=>{
  malformedModels.push(JSON.parse(options.body).model);
  return malformedModels.length===1
    ? new Response('not JSON')
    : Response.json({choices:[{finish_reason:'stop',message:{content:'Xin chào'}}]});
}});
const recovered=await malformedFallback(request(),env);
assert.equal(recovered.status,200);
assert.deepEqual(await recovered.json(),{text:'Xin chào',provider:'glm',model:'glm-4-flash'});
assert.deepEqual(malformedModels,['glm-4.7-flash','glm-4-flash']);

const malformed=createTranslationApi({fetchImpl:async()=>new Response('not JSON')});
assert.equal((await malformed(request(),env)).status,502);

const networkModels=[];
const networkFallback=createTranslationApi({fetchImpl:async (_url,options)=>{
  networkModels.push(JSON.parse(options.body).model);
  if(networkModels.length===1)throw new TypeError('fetch failed');
  return Response.json({choices:[{finish_reason:'stop',message:{content:'Xin chào'}}]});
}});
const networkResult=await networkFallback(request(),env);
assert.equal(networkResult.status,200);
assert.deepEqual(await networkResult.json(),{text:'Xin chào',provider:'glm',model:'glm-4-flash'});
assert.deepEqual(networkModels,['glm-4.7-flash','glm-4-flash']);

let timeoutCalls=0;
const abortable=createTranslationApi({timeoutMs:1,fetchImpl:(_url,{signal})=>{
  timeoutCalls++;
  return new Promise((_,reject)=>{
    signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  });
}});
assert.equal((await abortable(request(),env)).status,504);
assert.equal(timeoutCalls,1);

const hostedEnv={
  ...env,
  AZURE_TRANSLATOR_KEY:'azure-test-key',
  AZURE_TRANSLATOR_REGION:'eastasia',
  CLOUDFLARE_AI_ACCOUNT_ID:'cloudflare-test-account',
  CLOUDFLARE_AI_TOKEN:'cloudflare-test-token',
};
const hostedCalls=[];
const hosted=createTranslationApi({fetchImpl:async (endpoint,options)=>{
  const address=new URL(endpoint);
  hostedCalls.push(address.hostname);
  const body=JSON.parse(options.body);
  if(address.hostname==='api.cognitive.microsofttranslator.com'){
    assert.equal(address.pathname,'/translate');
    assert.equal(address.searchParams.get('api-version'),'3.0');
    assert.equal(options.headers['Ocp-Apim-Subscription-Key'],hostedEnv.AZURE_TRANSLATOR_KEY);
    assert.equal(options.headers['Ocp-Apim-Subscription-Region'],hostedEnv.AZURE_TRANSLATOR_REGION);
    if(address.searchParams.get('from')==='zh-Hans'){
      assert.equal(address.searchParams.get('to'),'vi');
      assert.deepEqual(body,[{Text:'你好'}]);
      return Response.json([{translations:[{text:'Xin chào',to:'vi'}]}]);
    }
    assert.equal(address.searchParams.get('from'),'vi');
    assert.equal(address.searchParams.get('to'),'zh-Hans');
    assert.deepEqual(body,[{Text:'Xin chào'}]);
    return new Response(null,{status:429});
  }
  assert.equal(address.href,'https://api.cloudflare.com/client/v4/accounts/cloudflare-test-account/ai/run/@cf/meta/m2m100-1.2b');
  assert.equal(options.headers.Authorization,'Bearer '+hostedEnv.CLOUDFLARE_AI_TOKEN);
  assert.deepEqual(body,{text:'Xin chào',source_lang:'vi',target_lang:'zh'});
  return Response.json({success:true,result:{translated_text:'你好'}});
}});
assert.deepEqual(await (await hosted(request(),hostedEnv)).json(),{text:'Xin chào',provider:'azure'});
assert.deepEqual(await (await hosted(request(auth,{text:'Xin chào',source:'vi',target:'zh-CN'}),hostedEnv)).json(),{text:'你好',provider:'cloudflare'});
assert.deepEqual(hostedCalls,['api.cognitive.microsofttranslator.com','api.cognitive.microsofttranslator.com','api.cloudflare.com']);

const failoverHosts=[];
const hostedFallback=createTranslationApi({timeoutMs:40,fetchImpl:async (endpoint,{signal})=>{
  const {hostname}=new URL(endpoint);
  failoverHosts.push(hostname);
  if(hostname==='api.cognitive.microsofttranslator.com'){
    return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }
  if(hostname==='api.cloudflare.com')return new Response('not JSON');
  return Response.json({choices:[{finish_reason:'stop',message:{content:'Xin chào'}}]});
}});
assert.equal((await (await hostedFallback(request(),hostedEnv)).json()).provider,'glm');
assert.deepEqual(failoverHosts,['api.cognitive.microsofttranslator.com','api.cloudflare.com','api.z.ai']);
console.log('PASS hosted translation: Azure language mapping, Cloudflare fallback and timeout isolation.');
