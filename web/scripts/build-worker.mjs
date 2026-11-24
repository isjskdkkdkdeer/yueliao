import {readFile, readdir, mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {build} from 'esbuild';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = path.join(root, 'dist');
const types = {'.wav':'audio/wav','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.webmanifest':'application/manifest+json; charset=utf-8','.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8','.xml':'application/xml; charset=utf-8'};
const assets = {};
async function collect(directory, prefix = '') {
  for (const entry of await readdir(directory, {withFileTypes:true})) {
    if (entry.name.startsWith('.') || (!prefix && entry.name === 'server')) continue;
    const relative = prefix + '/' + entry.name, absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(absolute, relative);
    else if (entry.isFile()) assets[relative] = {data:(await readFile(absolute)).toString('base64'), type:types[path.extname(entry.name)] || 'application/octet-stream'};
  }
}
await collect(dist);
if (!assets['/index.html']) throw new Error('dist/index.html is required');
const source = `import {handleAccountApi} from './worker/account-api.js';
import {handleAssistantApi} from './worker/assistant-api.js';
import {handleTranslationApi} from './worker/translation-api.js';
import {handleNotifyApi} from './worker/notify-api.js';
import {handleMailboxApi} from './worker/mailbox-api.js';
import {handleTurnApi} from './worker/turn-api.js';
import {handleSpeechApi} from './worker/speech-api.js';
const assets=${JSON.stringify(assets)};
export default {async fetch(request,env,ctx){
  const account=handleAccountApi(request,env);if(account)return account;
  const assistant=await handleAssistantApi(request,env);if(assistant)return assistant;
  const translation=await handleTranslationApi(request,env);if(translation)return translation;
  const notify=await handleNotifyApi(request,env);if(notify)return notify;
  const mailbox=await handleMailboxApi(request,env,ctx);
  if(mailbox)return mailbox;
  const turn=await handleTurnApi(request,env);
  if(turn)return turn;
  const response=await handleSpeechApi(request,env);
  if(response)return response;
  if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405,headers:{Allow:'GET, HEAD'}});
  let name=new URL(request.url).pathname;if(name==='/')name='/index.html';
  const asset=assets[name];
  if(!asset)return new Response('Not found',{status:404});
  const bytes=Uint8Array.from(atob(asset.data),character=>character.charCodeAt(0));
  return new Response(request.method==='HEAD'?null:bytes,{headers:{'Content-Type':asset.type,'Content-Length':String(bytes.byteLength),'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'}});
}};`;
await mkdir(path.join(dist, 'server'), {recursive:true});
await build({stdin:{contents:source, resolveDir:root, sourcefile:'worker-entry.js'}, outfile:path.join(dist,'server/index.js'), bundle:true, platform:'browser', format:'esm', target:'es2022', minify:true});
await writeFile(path.join(dist,'server/build-info.json'),JSON.stringify({assetCount:Object.keys(assets).length})+'\n');
console.log(`Built Worker ESM with ${Object.keys(assets).length} embedded static assets.`);
