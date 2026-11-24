import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {setupInterfaceLanguage} from './dist/i18n.js';

const flush=async()=>{await new Promise(resolve=>setTimeout(resolve,0));await new Promise(resolve=>setTimeout(resolve,0));};
const dom=new JSDOM(`<!doctype html><html><head><title>越聊</title></head><body>
  <div class="top-right"><span class="language-chip">中文 / Tiếng Việt</span></div>
  <nav><button aria-label="添加好友">添加好友</button><span>消息</span><span>好友</span><span>设置</span></nav>
  <input id="search" placeholder="搜索好友或聊天记录" aria-label="搜索好友或聊天记录">
  <textarea id="typed" placeholder="用你的语言，聊聊今天吧…">设置</textarea>
  <div class="contact-name">发送</div><div class="contact-last">添加好友</div>
  <div class="person"><h2>设置</h2><p>在线 · 可以开始聊天</p></div>
  <div class="bubble"><div id="original">发送</div><div class="translated"><span class="translation-label">中文翻译</span><span id="translated-user">设置</span></div></div>
  <div class="message-footer"><span>已发送</span></div>
  <div id="toast"></div><div id="modal-root"></div>
  <div class="call-overlay"><div id="subtitle-local"><b>我说的</b><span class="caption-field-label">原文</span><p data-caption-original>添加好友</p><span class="caption-field-label">译文</span><p data-caption-translation>发送</p><p data-caption-placeholder>等待我说话…</p></div><div id="subtitle-remote"><b>她说的</b><p data-caption-original>消息</p><p data-caption-placeholder>等待她说话…</p></div><p id="subtitle-status">正在聆听 · 说一句中文或越南语吧</p></div>
  <div class="translation-result" id="translate-result">让每一句，都被听懂。</div>
</body></html>`,{url:'https://test.example',pretendToBeVisual:true});
const doc=dom.window.document,$=selector=>doc.querySelector(selector);
const controller=setupInterfaceLanguage({document:doc});
assert.equal(controller.language,'zh');
assert.equal(doc.querySelectorAll('[data-interface-language]').length,2,'topbar and call page each expose a language switch');
const select=$('[data-interface-language]');
select.value='vi';select.dispatchEvent(new dom.window.Event('change'));
assert.equal(controller.language,'vi');assert.equal(doc.documentElement.lang,'vi');
assert.equal($('nav button').textContent,'Thêm bạn');assert.equal($('nav button').getAttribute('aria-label'),'Thêm bạn');
assert.equal($('#search').placeholder,'Tìm bạn hoặc tin nhắn');assert.equal($('#typed').value,'设置');
assert.equal($('.contact-name').textContent,'发送');assert.equal($('.contact-last').textContent,'添加好友');assert.equal($('.person h2').textContent,'设置');
assert.equal($('#original').textContent,'发送');assert.equal($('#translated-user').textContent,'设置');
assert.equal($('.translation-label').textContent,'Bản dịch tiếng Trung');assert.equal($('.message-footer').textContent,'Đã gửi');
assert.equal($('#subtitle-local [data-caption-original]').textContent,'添加好友');
assert.equal($('#subtitle-local [data-caption-translation]').textContent,'发送');assert.equal($('#subtitle-local b').textContent,'Lời tôi nói');assert.equal($('#subtitle-remote b').textContent,'Lời cô ấy nói');
assert.deepEqual([...doc.querySelectorAll('.caption-field-label')].map(label=>label.textContent),['Nguyên văn','Bản dịch']);
assert.equal($('#subtitle-local [data-caption-placeholder]').textContent,'Đang chờ tôi nói…');assert.equal($('#subtitle-remote [data-caption-placeholder]').textContent,'Đang chờ cô ấy nói…');
assert.equal($('#translate-result').textContent,'Để từng lời đều được thấu hiểu.');
assert.equal(dom.window.localStorage.getItem('yueliao-interface-language'),'vi');

$('#toast').textContent='好友号已复制，发给朋友吧！';
$('#modal-root').innerHTML='<div class="modal"><h2>你好，新朋友。</h2><label>好友的越聊号</label><input placeholder="例如 yueliao-a1b2c3d4"><button>添加并连接</button></div>';
await flush();
assert.equal($('#toast').textContent,'Đã sao chép mã kết bạn, hãy gửi cho bạn bè!');
assert.equal($('.modal h2').textContent,'Xin chào, người bạn mới.');assert.equal($('.modal input').placeholder,'Ví dụ yueliao-a1b2c3d4');

// Machine/user results equal to an interface word must not be translated.
$('#translate-result').textContent='发送';await flush();assert.equal($('#translate-result').textContent,'发送');
// Renders replace nodes; the current interface choice must still apply.
$('.top-right').innerHTML='<span class="language-chip">中文 / Tiếng Việt</span><button>我的资料</button>';
await flush();assert.equal($('.top-right button').textContent,'Hồ sơ của tôi');assert.equal($('.top-right select').value,'vi');
for(let i=0;i<4;i++) {
  controller.setLanguage('zh');assert.equal($('nav button').textContent,'添加好友');assert.equal($('#search').placeholder,'搜索好友或聊天记录');assert.equal($('.modal h2').textContent,'你好，新朋友。');
  controller.setLanguage('vi');assert.equal($('nav button').textContent,'Thêm bạn');assert.equal($('.modal h2').textContent,'Xin chào, người bạn mới.');
}
assert.equal($('#original').textContent,'发送');assert.equal($('#translate-result').textContent,'发送');
assert.equal(setupInterfaceLanguage({document:doc}),controller,'setup must be idempotent');
controller.dispose();dom.window.close();

const vietnamese=new JSDOM('<div class="top-right"></div><button>发送</button>',{url:'https://test.example'});
Object.defineProperty(vietnamese.window.navigator,'language',{value:'vi-VN'});
const automatic=setupInterfaceLanguage({document:vietnamese.window.document});assert.equal(automatic.language,'vi');assert.equal(vietnamese.window.document.querySelector('button').textContent,'Gửi');
automatic.dispose();vietnamese.window.close();

// Exercise the current application, including the newly added call controls.
const actual=new JSDOM(await readFile('./dist/index.html','utf8'),{url:'https://app.example',runScripts:'outside-only'});
const app=actual.window;
app.translate=async text=>({text:'bản dịch: '+text});app.speak=async()=>{};
let browserRequests=0,cloudRequests=0;
app.createSpeechRecognition=()=>{browserRequests++;return {supported:false,start(){},stop(){}}};
app.createPeerService=()=>({connect:async()=>{},addFriend:async()=>{},send:async()=>{},call:async()=>{},answer:async()=>{},hangup(){},setMuted(){},setCamera(){},disconnect(){}});
app.fetch=async()=>{cloudRequests++;throw new Error('The call UI must not request the removed cloud service');};
let appController;
app.setupInterfaceLanguage=()=>{appController=setupInterfaceLanguage({document:app.document});return appController;};
const appSource=(await readFile('./dist/app.js','utf8')).replace(/^import .*;\n/gm,'');
app.eval(appSource+'\nglobalThis.qa={action,state,openChat,startCall,endCall};');
if(!appController)appController=setupInterfaceLanguage({document:app.document});
appController.setLanguage('vi');
const aq=selector=>app.document.querySelector(selector);
function untranslatedUI(root=app.document.body){
  const walker=app.document.createTreeWalker(root,app.NodeFilter.SHOW_TEXT),remaining=[];let node;
  while((node=walker.nextNode())){
    const text=node.nodeValue.trim(),parent=node.parentElement;
    if(!/\p{Script=Han}/u.test(text)||parent.closest('script,style,textarea,.brand,.avatar,.tiny-avatar,.me,.contact-name,.contact-last,.message-label,.person h2,.profile h2,.profile h3,.native-name,.call-person h2,.view-card h3,.call-info h3,.setting-row[data-action="profile"] span,[data-no-i18n],[data-user-content],[data-caption-original],[data-caption-translation]'))continue;
    if(parent.closest('.bubble')&&!parent.closest('.translation-label,.translated[style]'))continue;
    remaining.push(text);
  }
  return remaining;
}
assert.deepEqual(untranslatedUI(),[],'initial Vietnamese UI must not retain Chinese product labels');
assert.equal(aq('[data-tab="friends"] span').textContent,'Bạn bè');
aq('[data-tab="friends"]').click();await flush();assert.equal(aq('.section-view h2').textContent,'Mỗi cuộc gặp đều đáng quý.');assert.deepEqual(untranslatedUI(),[]);
aq('[data-tab="settings"]').click();await flush();assert.equal(aq('.section-view h2').textContent,'YueLiao của tôi');assert.deepEqual(untranslatedUI(),[]);
app.qa.action('help');await flush();assert.equal(aq('.modal h2').textContent,'Để giao tiếp đơn giản hơn.');assert.equal(aq('.modal .my-id strong').textContent,'01 · Trò chuyện thử với Linh');assert.deepEqual(untranslatedUI(aq('.modal')),[]);aq('#modal-close').click();
app.qa.action('add');await flush();assert.equal(aq('.modal h2').textContent,'Xin chào, người bạn mới.');assert.equal(aq('#add-submit').textContent,'Thêm và kết nối');assert.equal(aq('#friend-id').placeholder,'Nhập mã số YueLiao của bạn bè');assert.deepEqual(untranslatedUI(aq('.modal')),[]);aq('#modal-close').click();
app.qa.openChat('demo-linh');await app.qa.startCall('video');await flush();
assert.equal(aq('#subtitle-language').getAttribute('aria-label'),'Ngôn ngữ tôi nói');
assert.equal(aq('#subtitle-mode'),null,'the removed cloud/browser selector must not remain in the call UI');
assert.equal(aq('#subtitle-login'),null,'the removed cloud login entry must not remain in the call UI');
assert.equal(browserRequests,0,'a demo call must not start recognition before media permission');
assert.equal(aq('#caption-text-toggle').textContent.trim(),'Dùng phụ đề văn bản');
assert.equal(aq('#subtitle-local .caption-speaker').firstChild.nodeValue,'Lời tôi nói');
assert.equal(aq('#subtitle-remote .caption-speaker').firstChild.nodeValue,'Lời cô ấy nói');
assert.equal(aq('#subtitle-local [data-caption-placeholder]').textContent,'Đang chờ tôi nói…');
assert.equal(aq('#subtitle-remote [data-caption-placeholder]').textContent,'Đang chờ cô ấy nói…');
assert.deepEqual([...app.document.querySelectorAll('#subtitle-local .caption-field-label')].map(label=>label.textContent),['Nguyên văn','Bản dịch']);
assert.equal(aq('.call-controls [data-interface-language]').value,'vi','call interface switch belongs to bottom controls');
assert.deepEqual(untranslatedUI(aq('.call-overlay')),[],'new call controls and privacy text must be localized');
aq('#subtitle-toggle').click();await flush();
assert.equal(browserRequests,1,'manual retry uses browser recognition directly');
assert.equal(cloudRequests,0,'caption controls never request cloud configuration');
assert.equal(aq('#caption-text-form').hidden,false,'unsupported recognition exposes the text subtitle fallback');
assert.match(aq('#subtitle-status').textContent,/phụ đề|nhận dạng/iu);
assert.deepEqual(untranslatedUI(aq('.call-overlay')),[],'unsupported-browser fallback remains fully localized');
assert.doesNotMatch(aq('.call-overlay').textContent,/OpenAI/u,'call captions no longer advertise the removed cloud speech provider');
app.qa.endCall();appController.dispose();actual.window.close();
console.log('PASS i18n: Chinese/Vietnamese switching, persisted and automatic language, rerenders/modals/toasts/accessibility, repeated switching, and preserving user text and subtitles.');
