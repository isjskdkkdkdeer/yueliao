import assert from 'node:assert/strict';
import {createAssistantApi} from './worker/assistant-api.js';
const env={GROQ_API_KEY:'test',SPEECH_ALLOWED_EMAILS:'test@example.test'};
let calls=0;
const handler=createAssistantApi({fetchImpl:async(u,o)=>{calls++;const body=JSON.parse(o.body);assert.equal(body.messages.at(-1).content,'你好');return Response.json({choices:[{finish_reason:'stop',message:{content:'你好！'}}]})}});
const request=(headers={},messages=[{role:'user',content:'你好'}])=>new Request('https://example.test/api/assistant',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({messages})});
assert.equal((await handler(request(),env)).status,401);
const headers={'oai-authenticated-user-id':'u','oai-authenticated-user-email':'test@example.test'};
assert.equal((await handler(request(headers,[{role:'system',content:'bad'}]),env)).status,400);
assert.equal((await (await handler(request(headers),env)).json()).text,'你好！');
assert.equal(calls,1);
const ordinary={'oai-authenticated-user-id':'ordinary-user','oai-authenticated-user-email':'other@example.test'};
assert.equal((await handler(request(ordinary),env)).status,200);
assert.equal((await handler(request({'oai-authenticated-user-id':'no-email-user'}),env)).status,200);
for(let i=0;i<29;i++)assert.equal((await handler(request(ordinary),env)).status,200);
assert.equal((await handler(request(ordinary),env)).status,429);

console.log('Assistant API auth, role validation and response passed');
