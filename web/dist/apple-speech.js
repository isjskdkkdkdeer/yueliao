import {nativeChannel} from './native-translation.js?v=unified-1';

const sessions = new Map();
let installCallback = false;

export function createAppleSpeech({stream,language,onText,onState,onError}) {
  const channel=nativeChannel('yueliaoSpeech');
  const Audio=globalThis.AudioContext || globalThis.webkitAudioContext;
  const track=stream?.getAudioTracks().find(t=>t.readyState==='live');
  const supported=Boolean(channel && Audio && track);
  let context,source,processor,id,running,startResult,startTimer,stopped;
  const stop=()=>{
    stopped=true;
    if (!id) return;
    const closing=id; id=null; running=false;
    clearTimeout(startTimer);
    sessions.delete(closing);
    startResult?.(false);
    processor?.disconnect(); source?.disconnect();
    if (processor) processor.onaudioprocess=null;
    context?.close().catch(()=>{});
    try { channel.postMessage({action:'stop',id:closing}); } catch {}
  };

  return {supported,stop, async start() {
    if (!supported || id || stopped) return false;
    try {
      context=new Audio();
      source=context.createMediaStreamSource(new MediaStream([track]));
      processor=context.createScriptProcessor(4096,1,1);
      await context.resume();
      if(stopped){await context.close();return false;}
      id=crypto.randomUUID();
      if (!installCallback) {
        window.__onYueLiaoSpeech=(session,event)=>sessions.get(session)?.(event);
        installCallback=true;
      }
      const ready=new Promise(resolve=>{startResult=resolve;});
      startTimer=setTimeout(stop,8000);
      sessions.set(id,event=>{
        if (event.state==='ready') {
          clearTimeout(startTimer);
          running=true;
          onState('listening');
          startResult(true);
        } else if (event.error) {
          const wasRunning=running;
          stop();
          if (wasRunning) onError(Object.assign(Error(event.error),{code:'LOCAL_SPEECH'}));
        } else if (typeof event.text==='string') {
          onText({text:event.text,isFinal:event.final===true});
        }
      });
      processor.onaudioprocess=event=>{
        // The graph must remain live, but must never output captured samples.
        event.outputBuffer.getChannelData(0).fill(0);
        if (!running || !track.enabled || track.muted) return;
        const input=event.inputBuffer.getChannelData(0);
        const pcm=new Int16Array(input.length);
        for(let i=0;i<input.length;i++) pcm[i]=Math.round(Math.min(1,Math.max(-1,input[i]))*32767);
        const bytes=new Uint8Array(pcm.buffer);
        try { channel.postMessage({action:'pcm',id,pcm:btoa(String.fromCharCode(...bytes))}); }
        catch (error) { stop(); onError(error); }
      };
      source.connect(processor);
      processor.connect(context.destination);
      channel.postMessage({action:'start',id,language,sampleRate:context.sampleRate});
      return await ready;
    } catch {
      if (id) stop(); else context?.close().catch(()=>{});
      return false;
    }
  }};
}
