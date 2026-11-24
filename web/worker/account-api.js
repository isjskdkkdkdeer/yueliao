import {getSpeechAccess} from './speech-api.js';

export function handleAccountApi(request,env={}){
 if(new URL(request.url).pathname!=='/api/account')return null;
 const headers={'Cache-Control':'private, no-store','Vary':'Cookie','X-Content-Type-Options':'nosniff'};
 if(request.method!=='GET')return Response.json({error:'Method not allowed'},{status:405,headers});
 const id=request.headers.get('oai-authenticated-user-id');
 const email=(request.headers.get('oai-authenticated-user-email')||'').trim();
 let name=request.headers.get('oai-authenticated-user-full-name')||'';
 if(request.headers.get('oai-authenticated-user-full-name-encoding')==='percent-encoded-utf-8'){try{name=decodeURIComponent(name)}catch{name=''}}
 const speech=getSpeechAccess(request,env);
 return Response.json({speechConfigured:speech.configured,speechAuthorized:speech.authorized,authenticated:!!id,email:id?email:null,name:id?name:null,provider:id?'ChatGPT':null,assistantAuthorized:!!id,assistantConfigured:!!env.GROQ_API_KEY,signInUrl:'/signin-with-chatgpt?return_to=%2F%3Faccount%3D1',signOutUrl:'/signout-with-chatgpt?return_to=%2F%3Faccount%3D1'},{headers});
}
