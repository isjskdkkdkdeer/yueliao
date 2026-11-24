// Network-only application: never cache authenticated messages, calls, or API responses.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('push',event=>{
 event.waitUntil((async()=>{
  let p;try{p=event.data.json()}catch{p={title:'越聊',body:'你有新的消息'}}
  const call=p.type==='call';
  await self.registration.showNotification(p.title||'越聊',{body:p.body||'你有新的消息',icon:'/assets/pwa-icon-192.png',badge:'/assets/favicon-48.png',tag:call?`call-${p.callId}`:`message-${p.peerId||''}`,data:{type:call?'call':'message',callId:p.callId,peerId:p.peerId},...(call?{requireInteraction:true}:{} )});
 })());
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();const p=event.notification.data||{};
 const u=new URL('/',self.location.origin);if(p.type==='call'&&p.callId)u.searchParams.set('incoming',p.callId);if(p.peerId)u.searchParams.set('chat',p.peerId);
 event.waitUntil((async()=>{const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});for(const client of windows){if(new URL(client.url).origin===u.origin){client.postMessage({type:'notification-open',callId:p.callId,peerId:p.peerId});await client.focus();return}}await self.clients.openWindow(u.href)})());
});
