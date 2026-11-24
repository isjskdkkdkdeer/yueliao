// All authenticated Site users share the same login. Never expose the provider key.
const models=['openai/gpt-oss-20b','openai/gpt-oss-120b'];
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
export function createAssistantApi({fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=18000}={}){
 const usage=new Map(),cooldown=new Map();
 return async function handle(request,env={}){
  const url=new URL(request.url);if(url.pathname!=='/api/assistant')return null;
  if(request.method!=='POST')return json({code:'METHOD_NOT_ALLOWED'},405);
  if(request.headers.get('Origin')&&request.headers.get('Origin')!==url.origin)return json({code:'FORBIDDEN'},403);
  if(!env.GROQ_API_KEY)return json({code:'NOT_CONFIGURED',error:'AI 助手尚未配置'},503);
  const id=request.headers.get('oai-authenticated-user-id');
  if(!id)return json({code:'AUTH_REQUIRED',error:'请登录后使用AI 助手'},401);
  let input;
  try{
   const reader=request.body?.getReader();if(!reader)throw Error();let size=0;const chunks=[];
   while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>40000){await reader.cancel();return json({code:'TOO_LARGE'},413)}chunks.push(value)}
   const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length}input=JSON.parse(new TextDecoder().decode(bytes));
  }catch{return json({code:'INVALID_INPUT'},400)}
  const messages=input?.messages;
  if(!Array.isArray(messages)||!messages.length||messages.length>12||messages.at(-1)?.role!=='user'||messages.some(m=>!['user','assistant'].includes(m?.role)||typeof m.content!=='string'||!m.content.trim()||m.content.length>6000)||messages.reduce((n,m)=>n+m.content.length,0)>18000)return json({code:'INVALID_INPUT',error:'对话过长，请缩短问题'},400);
  const time=now();for(const [key,value] of usage)if(value.until<=time)usage.delete(key);
  if(!usage.has(id)){if(usage.size>=10000)return json({code:'RATE_LIMIT'},429);usage.set(id,{count:0,until:time+60000})}
  const counter=usage.get(id);if(counter.count++>=30)return json({code:'RATE_LIMIT',error:'AI 助手请求过快，请稍后重试'},429);
  for(const model of models){
   if((cooldown.get(model)||0)>time)continue;
   const controller=new AbortController();let timer;
   try{
    const response=await Promise.race([fetchImpl('https://api.groq.com/openai/v1/chat/completions',{
     method:'POST',headers:{Authorization:`Bearer ${env.GROQ_API_KEY}`,'Content-Type':'application/json'},signal:controller.signal,
     body:JSON.stringify({model,temperature:0,max_completion_tokens:2048,reasoning_effort:'low',include_reasoning:false,messages:[{role:'system',content:'You are 越聊助手, a helpful AI assistant for Chinese and Vietnamese speakers. Chat, answer questions, help write text and translate when asked. Reply in the user language unless requested otherwise. Be concise. You cannot call people, access their other conversations, browse live information or change app settings. Be honest about these limitations. Never claim actions you did not perform.'},...messages]})
    }),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('TIMEOUT'))},timeoutMs)})]);
    if(response.status===401||response.status===403)break;
    if(!response.ok){cooldown.set(model,time+(response.status===429?60000:15000));continue}
    const payload=await response.json(),choice=payload.choices?.[0],translated=choice?.message?.content?.trim();
    if(choice?.finish_reason!=='stop'||typeof translated!=='string'||!translated||translated.length>6000)continue;
    return json({text:translated,provider:'groq',model});
   }catch{cooldown.set(model,time+15000)}finally{clearTimeout(timer)}
  }
  return json({code:'UNAVAILABLE',error:'AI 助手暂不可用或额度已用完，请稍后重试'},503);
 };
}
export const handleAssistantApi=createAssistantApi();
