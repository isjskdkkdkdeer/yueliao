export function createNotifications({onOpen=()=>{},onCalls=()=>{},onError=()=>{}}={}){
 let config=null,registration=null,timer=null,polling=false;
 async function api(path,data){const token=localStorage.getItem('yueliao-mailbox-secret');if(!token)throw Error('请先连接好友服务');const r=await fetch(`/api/notify/${path}`,{method:data===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(data===undefined?{}:{'Content-Type':'application/json'})},body:data===undefined?undefined:JSON.stringify(data),cache:'no-store',signal:AbortSignal.timeout(12000)});const p=await r.json();if(!r.ok)throw Error(p.error||'通知服务暂时不可用');return p}
 async function load(){if(!config){const r=await fetch('/api/notify/config',{cache:'no-store'});if(!r.ok)throw Error('无法获取通知配置');config=await r.json()}return config}
 async function poll(){if(polling||document.visibilityState==='hidden')return;polling=true;try{if((await load()).configured){const p=await api('calls');onCalls(p.calls,p.actor)}}catch{}finally{polling=false}}
 const standalone=()=>matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
 const ios=()=>/iPhone|iPad|iPod/.test(navigator.userAgent)||navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1;
 function guidance(){if(ios()&&!standalone())return 'iPhone 请用 Safari 打开，点“分享”→“添加到主屏幕”，再从主屏幕打开越聊。需要 iOS 16.4 或更新版本。';if(!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window))return '此浏览器暂不支持网页推送，请使用新版 Safari 或 Chrome。';return '允许通知后，可接收锁屏消息及语音／视频来电提醒。锁屏时显示系统通知，打开越聊后接听。'}
 return {
  api,load,poll,guidance,
  async start(){try{if('serviceWorker' in navigator)registration=await navigator.serviceWorker.register('/sw.js',{scope:'/'});navigator.serviceWorker?.addEventListener('message',e=>{if(e.data?.type==='notification-open'){onOpen(e.data);poll()}});await load();if(config.configured){await poll();timer=setInterval(poll,5000);document.addEventListener('visibilitychange',poll)}}catch{}},
  async enable(){if(ios()&&!standalone())throw Error(guidance());if(!('Notification' in window)||!('PushManager' in window))throw Error(guidance());const conf=await load();if(!conf.configured)throw Error('锁屏通知暂时不可用，请在网页打开时使用通话提醒');const permission=await Notification.requestPermission();if(permission!=='granted')throw Error('通知未开启，请在系统设置中允许越聊通知');registration||=await navigator.serviceWorker.ready;const binary=atob(conf.publicKey.replace(/-/g,'+').replace(/_/g,'/'));const key=Uint8Array.from(binary,c=>c.charCodeAt(0));const subscription=await registration.pushManager.getSubscription()||await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});await api('subscribe',{subscription:subscription.toJSON()});return true},
  async disable(){await api('unsubscribe',{});const sub=await registration?.pushManager.getSubscription();if(sub)await sub.unsubscribe()},
  async invite(contact,kind,id){if(!(await load()).configured)return null;return api('invite',{to:contact.cloudId,kind,id})},
  update(id,status){return api('update',{id,status:status==='cancelled'?'ended':status})},
 };
}
// Keep the audio element alive across call UI re-renders.
export function createRinger(){
 const audio=document.createElement('audio');audio.preload='auto';audio.loop=true;
 audio.setAttribute('playsinline','');audio.src='/assets/ringback.wav';
 audio.hidden=true;document.body.appendChild(audio);
 let active=false,serial=0,mode='outgoing';
 function status(value){document.dispatchEvent(new CustomEvent('ringer-status',{detail:value}))}
 function play(){const attempt=++serial;try{const pending=audio.play();Promise.resolve(pending).then(()=>{if(attempt===serial&&active)status('playing')}).catch(()=>{if(attempt===serial&&active)status('blocked')});return true}catch{status('blocked');return false}}
 return {
  unlock(){if(active){audio.muted=false;audio.volume=1;play()}},
  start(kind='incoming'){active=true;audio.muted=false;audio.volume=1;if(mode!==kind){mode=kind;audio.src=kind==='outgoing'?'/assets/ringback.wav':'/assets/ringtone.wav'}return play()},
  stop(){active=false;serial++;audio.pause();try{audio.currentTime=0}catch{}status('stopped')}
 };
}
