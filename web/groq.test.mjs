import assert from 'node:assert/strict';
import {createSpeechApi} from './worker/speech-api.js';
const env={GROQ_API_KEY:'groq-test-key',SPEECH_ALLOWED_EMAILS:'test@example.test'};
let called=false;
const api=createSpeechApi({fetchImpl:async(url,options)=>{
 assert.equal(url,'https://api.groq.com/openai/v1/audio/transcriptions');
 assert.equal(options.headers.Authorization,'Bearer groq-test-key');
 assert.equal(options.body.get('model'),'whisper-large-v3-turbo');
 assert.equal(options.body.get('language'),'vi');called=true;return Response.json({text:'Xin chào'});
}});
const headers={'oai-authenticated-user-id':'test','oai-authenticated-user-email':'test@example.test'};
const body=new FormData();body.append('file',new Blob([new Uint8Array([0,0,0,20,102,116,121,112,109,52,97,32,0,0,0,0])],{type:'audio/mp4'}),'audio.m4a');body.append('language','vi');
const response=await api(new Request('https://example.test/api/speech',{method:'POST',headers,body}),env);
assert.equal(response.status,200);assert.deepEqual(await response.json(),{text:'Xin chào'});assert.ok(called);
const config=await api(new Request('https://example.test/api/speech-config',{headers}),env);assert.equal((await config.json()).configured,true);
console.log('PASS Groq routing, model, language, secret and configuration');
