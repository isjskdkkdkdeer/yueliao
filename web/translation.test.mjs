import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {translate,setTranslationPreferences} from './dist/translate.js';

globalThis.crypto ??= webcrypto;
const settings = new Map();
globalThis.localStorage = {getItem:key=>settings.get(key),setItem:(key,value)=>settings.set(key,value)};
let uploaded=0;
globalThis.fetch=async (url,request)=>{
  uploaded++;
  assert.equal(url,'/api/translate');
  assert.equal(request.headers['X-YueLiao-Consent'],'translation');
  assert.deepEqual(Object.keys(JSON.parse(request.body)).sort(),['source','target','text']);
  return Response.json({text:'Xin chào',provider:'glm'});
};
await assert.rejects(translate('你好'),{code:'OFFLINE_ONLY'});
assert.equal(uploaded,0);
let received;
globalThis.window={webkit:{messageHandlers:{appleTranslate:{postMessage(data){
  received=data;
  queueMicrotask(()=>window.__onAppleTranslateResult(data.requestId,'Xin chào',null,'foundation'));
}}}}};
assert.equal((await translate('你好','zh','vi',{conversationId:'a',context:{recent:[{text:'context'}]}})).provider,'foundation');
assert.equal(received.context.recent[0].text,'context');
assert.equal(uploaded,0);
delete globalThis.window;
setTranslationPreferences({onlineText:true,onlineSpeech:false});
await assert.rejects(translate('你好','zh','vi',{allowOnline:false}),{code:'OFFLINE_ONLY'});
assert.equal(uploaded,0);
const requests=await Promise.all([translate('你好'),translate('你好')]);
assert.equal(requests[0].provider,'glm');
assert.deepEqual(...requests);
assert.equal(uploaded,1);
console.log('PASS translation: local priority, sender/receiver cloud consent, minimal cloud payload and deduplication.');
