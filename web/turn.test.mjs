import assert from 'node:assert/strict';
import {createTurnApi} from './worker/turn-api.js';
const request = new Request('https://example.com/api/turn');
const env = {METERED_DOMAIN:'example.metered.live',METERED_TURN_API_KEY:'test-credential-key'};
let calls = 0;
const api = createTurnApi({fetchImpl:async url => {
  calls++;
  assert.equal(url.hostname,env.METERED_DOMAIN);
  assert.equal(url.searchParams.get('apiKey'),env.METERED_TURN_API_KEY);
  return Response.json([{urls:'turn:global.relay.metered.ca:80',username:'user',credential:'password'}]);
}});
assert.deepEqual(await (await api(request,{})).json(),{configured:false});
assert.equal((await api(request,{...env,METERED_DOMAIN:'evil.example'})).status,503);
assert.equal(calls,0);
const response = await api(request,env);
assert.equal(response.headers.get('cache-control'),'no-store');
const data = await response.json();
assert.equal(data.configured,true);
assert.ok(!JSON.stringify(data).includes(env.METERED_TURN_API_KEY));
assert.equal(data.iceServers[0].username,'user');
for (const fetchImpl of [async()=>{throw Error('private upstream detail')},async()=>Response.json([{urls:'https://evil.example'}]),async()=>new Response('',{status:401})]) {
  const response = await createTurnApi({fetchImpl})(request,env);
  assert.equal(response.status,502);
  assert.ok(!(await response.text()).includes('private upstream'));
}
console.log('PASS TURN: missing/invalid config, credential retrieval, secret redaction, upstream failures.');

const direct = await api(request,{METERED_TURN_USERNAME:'test-user',METERED_TURN_PASSWORD:'test-password'});
const directConfig = await direct.json();
assert.equal(directConfig.configured,true);
assert.equal(directConfig.iceServers[1].urls.length,4);
assert.equal(directConfig.iceServers[1].credential,'test-password');
assert.equal((await api(request,{METERED_TURN_USERNAME:'partial'})).status,503);
console.log('PASS configured static Metered credentials and UDP/TCP/TLS relay routes.');
