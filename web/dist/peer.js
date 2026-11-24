/** Browser-only, direct peer chat and calls. No microphone access until call()/answer(). */
export function createPeerService(options = {}) {
  const {
    isRemoved = () => false, onStatus = () => {}, onMessage = () => {}, onContact = () => {},
    onIncomingCall = () => {}, onCallStream = () => {}, onCallEnd = () => {},
    loadIceConfig = async () => {
      // Non-browser test callers can inject a configuration loader.
      if (!globalThis.location?.origin) return null;
      let token = '';
      try { token = globalThis.localStorage?.getItem('yueliao-mailbox-secret') || ''; } catch {}
      const response = await fetch('/api/turn', {cache:'no-store', headers:token ? {Authorization:`Bearer ${token}`} : {}, signal:AbortSignal.timeout(10000)});
      if (!response.ok) throw new Error('TURN 中继暂时不可用，请稍后重试。');
      const data = await response.json();
      return data.configured ? {iceServers:data.iceServers} : null;
    },
    loadPeer = async () => (await import('./vendor/peerjs.js')).default,
  } = options;
  let peer = null, profile = null, connecting = null, startupCancel = null;
  let activeCall = null, localStream = null, remoteStream = null, callTimer = null;
  let reconnectTimer = null, generation = 0, mediaGeneration = 0, mediaPending = false;
  let desired = false, retryAttempt = 0;
  const session = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const candidates = new Set();
  const remoteSessions = new WeakMap();
  const connections = new Map();
  const contacts = new Map();
  const pending = new Map();
  const timers = new Set();
  const emitStatus = (state, message, extra = {}) => onStatus({state, message, ...extra});
  const validID = id => typeof id === 'string' && /^[A-Za-z0-9_-]{4,80}$/.test(id);
  const errorMessage = error => {
    const name = error?.name;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return '没有获得麦克风或摄像头权限，请在浏览器设置中允许后重试。';
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '没有找到可用的麦克风或摄像头。';
    if (name === 'NotReadableError') return '麦克风或摄像头正被其他应用使用，请关闭后重试。';
    if (error?.type === 'peer-unavailable') return '好友暂未上线，请确认好友 ID，并让对方保持页面打开。';
    if (error?.type === 'unavailable-id') return '正在恢复原来的聊天 ID；若另一个页面仍在使用，请关闭重复页面。';
    if (error?.type === 'browser-incompatible') return '此浏览器暂不支持网页通话，请使用新版 Safari 或 Chrome。';
    if (error?.type === 'network' || error?.type === 'server-error' || error?.type === 'socket-error') return '暂时无法连接聊天服务，请检查网络后重试。';
    return error?.message || '连接失败，请稍后重试。';
  };
  function fail(error) { const message = errorMessage(error); emitStatus('error', message); return new Error(message); }
  function stopTracks() {
    localStream?.getTracks().forEach(track => track.stop());
    localStream = null; remoteStream = null;
  }
  function finishCall(reason = 'ended') {
    mediaGeneration++; mediaPending = false;
    clearTimeout(callTimer); callTimer = null;
    const previous = activeCall;
    activeCall = null;
    if(previous&&reason!=='remote-ended'){const connection=connections.get(previous.peer);try{if(connection?.open)connection.send({type:'message',payload:{kind:'call-end',callId:previous.metadata?.callId||previous.connectionId}})}catch{}}
    stopTracks();
    if (previous) {
      try { previous.close(); } catch { /* Already closed. */ }
      onCallEnd({peerId: previous.peer, reason});
    }
  }
  function contactOffline(id) {
    const contact = contacts.get(id);
    if (contact) { contact.online = false; onContact({...contact}); }
  }
  function resolvePending(id, contact) {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer); timers.delete(entry.timer); pending.delete(id);
    entry.resolve(contact);
  }
  function rejectPending(id, message) {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer); timers.delete(entry.timer); pending.delete(id);
    entry.reject(new Error(message));
  }
  function resetData(message = '聊天服务正在重新连接。') {
    const previous = [...candidates];
    candidates.clear(); connections.clear();
    for (const id of pending.keys()) rejectPending(id, message);
    for (const connection of previous) { try { connection.close(); } catch {} }
    for (const id of contacts.keys()) contactOffline(id);
  }
  function setupData(connection) {
    const id = connection.peer;
    if(isRemoved(id)){connection.close();return;}
    let welcomed = false;
    candidates.add(connection);
    if (!connections.get(id)?.open) connections.set(id, connection);
    connection.on('open', () => {
      if (!candidates.has(connection) || !profile) return;
      connection.send({type:'hello', session, profile:{id:profile.id, name:profile.name, language:profile.language, avatarTile:profile.avatarTile, avatarUrl:profile.avatarUrl, cloudId:profile.cloudId}});
    });
    connection.on('data', data => {
      if (!candidates.has(connection) || !data || typeof data !== 'object') return;
      if (data.type === 'hello') {
        const p = data.profile;
        if (!p || p.id !== id || typeof p.name !== 'string') return;
        const old = connections.get(id);
        const remoteSession = typeof data.session === 'string' ? data.session : '';
        if (old && old !== connection && old.open) {
          // A newly opened page has a new session and must replace its stale RTC channel.
          // Concurrent dials within one session choose the same initiator at both ends.
          if (remoteSession && (!remoteSessions.has(old) || remoteSessions.get(old) === remoteSession)) {
            const preferred = profile.id < id ? profile.id : id;
            if (connection.metadata?.initiator !== preferred || old.metadata?.initiator === preferred) {
              connection.close(); return;
            }
          }
          connections.set(id, connection);
          candidates.delete(old);
          try { old.close(); } catch {}
        } else connections.set(id, connection);
        remoteSessions.set(connection, remoteSession);
        welcomed = true;
        const contact = {id,...(typeof p.avatarUrl==='string'&&p.avatarUrl.length<180000&&/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p.avatarUrl)?{avatarUrl:p.avatarUrl}:{}), name:p.name.slice(0,40), language:p.language === 'vi' ? 'vi' : 'zh', online:true,...(Number.isInteger(p.avatarTile)&&p.avatarTile>=0&&p.avatarTile<16?{avatarTile:p.avatarTile}:{}),...(/^[a-f0-9]{64}$/.test(p.cloudId||'')?{cloudId:p.cloudId}:{})};
        contacts.set(id, contact); onContact({...contact}); resolvePending(id, {...contact});
        return;
      }
      if (data.type === 'message' && welcomed && connections.get(id) === connection && data.payload && typeof data.payload === 'object') {
        // UI must render payload fields as text, never as raw HTML.
        let size;
        try { size = JSON.stringify(data.payload).length; } catch { return; }
        if (size <= 900000) onMessage({peerId:id, payload:data.payload});
      }
    });
    connection.on('close', () => {
      candidates.delete(connection);
      if (connections.get(id) === connection) {
        connections.delete(id); contactOffline(id);
        rejectPending(id, '好友已断开连接，正在等待重新上线。');
      }
    });
    connection.on('error', error => {
      if (connections.get(id) !== connection) return;
      rejectPending(id, errorMessage(error));
      connections.delete(id); candidates.delete(connection); contactOffline(id);
      try { connection.close(); } catch {}
      emitStatus('error', errorMessage(error), {peerId:id});
    });
    return connection;
  }
  function restoreContacts() {
    for (const id of contacts.keys()) {
      if (!connections.get(id)?.open) addFriend(id).catch(() => {});
    }
  }
  function scheduleReconnect() {
    if (!desired || reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** Math.min(retryAttempt++, 4), 15000);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; recover(); }, delay);
  }
  function recover() {
    if (!desired || !profile || connecting) return;
    clearTimeout(reconnectTimer); reconnectTimer = null;
    if (peer && !peer.destroyed && peer.disconnected && typeof peer.reconnect === 'function') {
      emitStatus('connecting', '正在恢复聊天服务…');
      try {
        peer.reconnect();
        // A reconnect can silently stall when the mobile network changed while suspended.
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (desired && !peer?.open) connect(profile).catch(() => {});
        }, 15000);
        return;
      } catch { /* Recreate below with the same saved ID. */ }
    }
    if (!peer?.open || peer.destroyed) connect(profile).catch(() => {});
  }
  function notifyStreams(call) {
    if (activeCall !== call) return;
    onCallStream({peerId:call.peer, kind:call.metadata?.kind === 'video' ? 'video' : 'audio', localStream, remoteStream});
  }
  function setupMedia(call) {
    activeCall = call;
    clearTimeout(callTimer);
    callTimer = setTimeout(() => {
      if (activeCall === call) { emitStatus('error','对方未接听或通话连接超时，请稍后重试。'); finishCall('timeout'); }
    }, 45000);
    call.on('stream', stream => {
      if (activeCall !== call) return;
      clearTimeout(callTimer); callTimer = null;
      remoteStream = stream; notifyStreams(call);
      emitStatus('in-call', '通话已连接', {peerId:call.peer});
    });
    call.on('close', () => { if (activeCall === call) finishCall('remote-ended'); });
    call.on('error', error => { if (activeCall === call) { emitStatus('error',errorMessage(error)); finishCall('error'); } });
  }
  async function media(kind) {
    if (!globalThis.isSecureContext || !globalThis.navigator?.mediaDevices?.getUserMedia) {
      throw new Error('此浏览器无法访问麦克风或摄像头，请使用 HTTPS 页面和新版 Safari 或 Chrome。');
    }
    return navigator.mediaDevices.getUserMedia({
      audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:{ideal:true}},
      video:kind === 'video' ? {facingMode:'user', width:{ideal:640}, height:{ideal:480}} : false,
    });
  }
  async function connect(nextProfile) {
    if (!validID(nextProfile?.id)) throw fail(new Error('聊天 ID 格式不正确。'));
    if (profile && profile.id !== nextProfile.id) disconnect();
    desired = true;
    if (peer && profile?.id === nextProfile.id && peer.open && !peer.destroyed && !peer.disconnected) {
      profile = {...nextProfile}; return peer.id;
    }
    if (connecting) return connecting;
    clearTimeout(reconnectTimer); reconnectTimer = null;
    if (peer) { const old=peer; peer=null; resetData(); old.destroy(); }
    profile = {id:nextProfile.id, name:String(nextProfile.name || '新朋友').slice(0,40), language:nextProfile.language === 'vi' ? 'vi' : 'zh',avatarTile:Number.isInteger(nextProfile.avatarTile)&&nextProfile.avatarTile>=0&&nextProfile.avatarTile<16?nextProfile.avatarTile:undefined,avatarUrl:nextProfile.avatarUrl,cloudId:nextProfile.cloudId};
    const version = ++generation;
    emitStatus('connecting','正在连接聊天服务…');
    connecting = (async () => {
      let timer;
      try {
        const [Peer, iceConfig] = await Promise.race([
          Promise.all([loadPeer(), loadIceConfig()]),
          new Promise((_,reject) => { timer=setTimeout(() => reject(new Error('聊天服务加载超时，请检查网络后重试。')),15000); }),
        ]);
        clearTimeout(timer);
        if (version !== generation) throw new Error('连接已取消。');
        return await new Promise((resolve,reject) => {
          const p = new Peer(profile.id, {debug:0, ...(iceConfig ? {config:iceConfig} : {})}); peer = p;
          let settled = false;
          const settleError = error => {
            if (settled) return;
            settled=true; startupCancel=null; clearTimeout(startupTimer); timers.delete(startupTimer); reject(error);
          };
          const startupTimer = setTimeout(() => {
            if (settled || peer !== p) return;
            peer=null; p.destroy();
            settleError(new Error('聊天服务连接超时，正在自动重试。'));
          },15000);
          timers.add(startupTimer);
          startupCancel=() => settleError(new Error('聊天连接已关闭。'));
          p.on('open', id => {
            if (peer !== p || version !== generation) return;
            startupCancel=null;
            clearTimeout(startupTimer); timers.delete(startupTimer);
            clearTimeout(reconnectTimer); reconnectTimer=null; retryAttempt=0;
            emitStatus('ready','聊天服务已连接', {peerId:id});
            restoreContacts();
            if (!settled) { settled=true; resolve(id); }
          });
          p.on('connection', connection => {
            if (peer !== p || version !== generation) { connection.close(); return; }
            setupData(connection);
          });
          p.on('call', call => {
            if(isRemoved(call.peer)){call.close();return;}
            if (peer !== p || version !== generation || activeCall) { call.close(); return; }
            setupMedia(call);
            emitStatus('incoming','收到好友来电', {peerId:call.peer});
            onIncomingCall({peerId:call.peer,kind:call.metadata?.kind === 'video' ? 'video' : 'audio',call});
          });
          p.on('error', error => {
            if (peer !== p || version !== generation) return;
            const message=errorMessage(error);
            if (error?.type === 'peer-unavailable') {
              const id=String(error.message || '').split(' ').at(-1);
              const targets=pending.has(id) ? [id] : [...pending.keys()];
              for (const target of targets) {
                rejectPending(target,message);
                const connection=connections.get(target);
                if (connection && !contacts.get(target)?.online) {
                  connections.delete(target); candidates.delete(connection);
                  try { connection.close(); } catch {}
                }
                contactOffline(target);
                emitStatus('error',message,{peerId:target});
              }
              return;
            }
            const permanent=['browser-incompatible','invalid-id','invalid-key','ssl-unavailable'].includes(error?.type);
            if (permanent) desired=false;
            // Fatal startup failures (notably an ID still held by the old tab) need a new Peer.
            if (!settled || p.destroyed || error?.type === 'unavailable-id') {
              peer=null; resetData(); p.destroy();
            }
            emitStatus(permanent?'error':'disconnected',message);
            settleError(Object.assign(new Error(message),{type:error?.type}));
            if (!permanent) scheduleReconnect();
          });
          p.on('disconnected', () => {
            if (peer !== p || version !== generation || !desired) return;
            emitStatus('disconnected','聊天服务已断开，正在自动重连…');
            scheduleReconnect();
          });
          p.on('close', () => {
            if (peer !== p || version !== generation) return;
            peer=null; resetData();
            settleError(new Error('聊天服务已断开，正在自动重连。'));
            emitStatus('disconnected','聊天服务已断开，正在自动重连…');
            scheduleReconnect();
          });
        });
      } catch(error) {
        clearTimeout(timer);
        if (version === generation && desired) {
          emitStatus('disconnected',errorMessage(error)); scheduleReconnect();
        }
        throw error;
      } finally { if (version === generation) connecting=null; }
    })();
    return connecting;
  }
  function resume() {
    if (!profile) return Promise.resolve();
    desired=true; retryAttempt=0;
    if (connecting) return connecting;
    if (peer && !peer.destroyed && !peer.open && !peer.disconnected && reconnectTimer) return Promise.resolve(peer.id);
    clearTimeout(reconnectTimer); reconnectTimer=null;
    if (!peer || peer.destroyed) return connect(profile);
    // `open` can still be true after iOS freezes a page. Re-register signaling explicitly.
    resetData('正在恢复好友连接。');
    if (!peer.disconnected && typeof peer.disconnect === 'function') peer.disconnect();
    recover();
    if (peer?.open && !peer.disconnected) restoreContacts();
    return Promise.resolve(peer?.id);
  }
  async function addFriend(id) {
    if (!validID(id)) throw fail(new Error('请输入有效的好友聊天 ID。'));
    if (!peer?.open) throw fail(new Error('请先连接聊天服务，再添加好友。'));
    if (id === profile.id) throw fail(new Error('这是你自己的聊天 ID，请输入好友的 ID。'));
    if (connections.get(id)?.open && contacts.has(id)) return {...contacts.get(id)};
    if (pending.has(id)) return pending.get(id).promise;
    let resolve, reject;
    const promise=new Promise((yes,no) => { resolve=yes; reject=no; });
    const timer=setTimeout(() => {
      timers.delete(timer); rejectPending(id,'好友连接超时，请确认好友 ID，并让对方保持页面打开。');
      const connection=connections.get(id); if (connection && !contacts.get(id)?.online) connection.close();
    },15000);
    timers.add(timer); pending.set(id,{resolve,reject,timer,promise});
    try { setupData(peer.connect(id,{reliable:true,serialization:'binary',metadata:{initiator:profile.id,session}})); }
    catch(error) { rejectPending(id,errorMessage(error)); }
    return promise;
  }
  async function send(id,payload) {
    if (!payload || typeof payload !== 'object' || JSON.stringify(payload).length > 900000) throw fail(new Error('消息内容过长，请缩短后发送。'));
    if (!connections.get(id)?.open) await addFriend(id);
    const connection=connections.get(id);
    if (!connection?.open) throw fail(new Error('好友已离线，请重新连接后发送。'));
    connection.send({type:'message',payload});
  }
  async function call(id,kind='audio',options={}) {
    if (!peer?.open) throw fail(new Error('请先连接聊天服务。'));
    if (!validID(id) || id === profile.id) throw fail(new Error('请选择有效的好友。'));
    if (activeCall || localStream || mediaPending) throw fail(new Error('请先结束当前通话。'));
    kind=kind === 'video' ? 'video' : 'audio';
    const attempt=++mediaGeneration;
    mediaPending=true;
    emitStatus('requesting-media','正在请求设备权限…',{peerId:id});
    try {
      const acquired=await media(kind);
      if (attempt !== mediaGeneration) { acquired.getTracks().forEach(track => track.stop()); throw new Error('通话已取消。'); }
      localStream=acquired;
      const connection=peer.call(id,localStream,{metadata:{kind,name:profile.name,callId:typeof options.callId==='string'?options.callId:crypto.randomUUID()}});
      if (!connection) throw new Error('无法发起通话，请确认好友在线后重试。');
      setupMedia(connection); notifyStreams(connection);
      emitStatus('calling','等待好友接听…',{peerId:id});
      return connection;
    } catch(error) { if (attempt === mediaGeneration) stopTracks(); throw fail(error); }
    finally { if (attempt === mediaGeneration) mediaPending=false; }
  }
  async function answer(callToAnswer) {
    const c=callToAnswer?.call || callToAnswer || activeCall;
    if (!c || c !== activeCall) throw fail(new Error('此来电已结束。'));
    const kind=c.metadata?.kind === 'video' ? 'video' : 'audio';
    try {
      const acquired=await media(kind);
      if (c !== activeCall) { acquired.getTracks().forEach(t=>t.stop()); throw new Error('此来电已结束。'); }
      localStream=acquired; c.answer(localStream); notifyStreams(c);
      emitStatus('calling','正在连接通话…',{peerId:c.peer});
    } catch(error) { finishCall('permission-error'); throw fail(error); }
  }
  function disconnect() {
    desired=false; generation++; connecting=null; startupCancel?.(); startupCancel=null;
    clearTimeout(reconnectTimer); reconnectTimer=null; retryAttempt=0;
    for (const timer of timers) clearTimeout(timer); timers.clear();
    for (const id of pending.keys()) rejectPending(id,'聊天连接已关闭。');
    finishCall('disconnected');
    const previous=peer; peer=null;
    resetData('聊天连接已关闭。'); previous?.destroy();
    for (const id of contacts.keys()) contactOffline(id);
    emitStatus('disconnected','聊天服务已断开。');
  }
  return {
    connect,resume,addFriend,send,call,answer,
    async ensureCamera() {
      if(!activeCall||!localStream) throw new Error('请先接听视频通话，再开启摄像头。');
      if(localStream.getVideoTracks().some(t=>t.readyState!=='ended')) return;
      const current=activeCall;
      let acquired;
      try { acquired=await navigator.mediaDevices.getUserMedia({video:true,audio:false}); }
      catch(error){throw new Error(errorMessage(error))}
      if(current!==activeCall){acquired.getTracks().forEach(t=>t.stop());throw new Error('通话已结束。')}
      const track=acquired.getVideoTracks()[0];
      const sender=current.peerConnection?.getSenders().find(s=>s.track?.kind==='video');
      if(!sender){acquired.getTracks().forEach(t=>t.stop());throw new Error('请挂断后重新发起视频通话，以开启摄像头。')}
      try {await sender.replaceTrack(track)}catch(error){track.stop();throw error}
      localStream.getVideoTracks().forEach(t=>{localStream.removeTrack(t);t.stop()});
      localStream.addTrack(track);notifyStreams(current);
    },
    hangup:() => finishCall('ended'),
    setMuted(muted) { localStream?.getAudioTracks().forEach(track => { track.enabled=!muted; }); },
    setCamera(enabled) { localStream?.getVideoTracks().forEach(track => { track.enabled=Boolean(enabled); }); },
    removeFriend(id){contacts.delete(id);rejectPending(id,'好友已删除');const connection=connections.get(id);connections.delete(id);for(const candidate of [...candidates])if(candidate.peer===id){candidates.delete(candidate);candidate.close()}connection?.close();},
    disconnect,
    get localStream() { return localStream; },
  };
}
