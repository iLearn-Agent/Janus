import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { app, BrowserWindow } = globalThis.__janusElectron;
const root = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-message-workspace-evidence-'));
const screenshotDir = path.join(root, 'outputs', 'message-workspace-evidence');
mkdirSync(screenshotDir, { recursive: true });
const htmlPath = path.join(tempRoot, 'evidence.html');
const stateUrl = pathToFileURL(path.join(root, 'src/renderer/app/state.js')).href;
const chatUrl = pathToFileURL(path.join(root, 'src/renderer/app/views/chatView.js')).href;
const styleUrl = pathToFileURL(path.join(root, 'src/renderer/style.css')).href;
const orgMessage = { id: 'org-unread-1', senderUserId: 'evidence-contact', recipientUserId: 'evidence-user', kind: 'friend', content: '组织空间未读消息：请查看本周发布计划。', status: 'unread', createdAt: '2026-09-02T08:30:00.000Z', metadata: { type: 'direct_message' } };
const personalMessage = { id: 'personal-history-1', senderUserId: 'evidence-contact', recipientUserId: 'evidence-user', kind: 'friend', content: '个人空间历史消息：这是可正常打开的历史记录。', status: 'read', createdAt: '2026-09-01T08:30:00.000Z', metadata: { type: 'direct_message' } };

writeFileSync(htmlPath, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="${styleUrl}"><style>
html,body,#app{margin:0;width:100%;height:100%;overflow:hidden}body{background:#edf3fb;font-family:Arial,"Microsoft YaHei",sans-serif}.evidence{display:grid;grid-template-columns:250px 330px 1fr;height:100%;gap:8px;padding:12px;box-sizing:border-box}.evidence>aside,.evidence>section,.evidence>main{background:#fff;border:1px solid #d7e0ec;border-radius:14px;overflow:hidden}.evidence-head{padding:18px 20px;border-bottom:1px solid #e8edf4}.evidence-head strong{display:block;font-size:20px}.evidence-head small{color:#64748b}.workspace-tag{margin:16px;padding:12px 14px;border-radius:10px;background:#eaf2ff;color:#1746ad;font-weight:700}.conversation{display:flex;align-items:center;gap:12px;padding:16px;border-bottom:1px solid #eef2f7}.conversation.active{background:#edf5ff}.conversation .badge{margin-left:auto;padding:3px 8px;border-radius:999px;background:#ef4444;color:white;font-size:12px}.message-host{height:calc(100% - 0px);overflow:auto}.message-host .chat-view{height:100%}.evidence-caption{padding:10px 16px;background:#f8fafc;border-top:1px solid #e8edf4;color:#475569;font-size:13px}.evidence-error{color:#b42318;padding:12px;font-family:monospace;white-space:pre-wrap}
</style></head><body><div id="app"></div><script type="module">
import { state } from ${JSON.stringify(stateUrl)};
import { renderChat } from ${JSON.stringify(chatUrl)};
const app=document.querySelector('#app');
const user={id:'evidence-user',displayName:'证据用户'};
const orgMessage={id:'org-unread-1',senderUserId:'evidence-contact',recipientUserId:user.id,kind:'friend',content:'组织空间未读消息：请查看本周发布计划。',status:'unread',createdAt:'2026-09-02T08:30:00.000Z',metadata:{type:'direct_message'}};
const personalMessage={id:'personal-history-1',senderUserId:'evidence-contact',recipientUserId:user.id,kind:'friend',content:'个人空间历史消息：这是可正常打开的历史记录。',status:'read',createdAt:'2026-09-01T08:30:00.000Z',metadata:{type:'direct_message'}};
const sticker='data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"%3E%3Crect width="96" height="96" rx="22" fill="%23fde68a"/%3E%3Ccircle cx="34" cy="39" r="5" fill="%23334155"/%3E%3Ccircle cx="62" cy="39" r="5" fill="%23334155"/%3E%3Cpath d="M27 58c8 13 34 13 42 0" fill="none" stroke="%23334155" stroke-width="6" stroke-linecap="round"/%3E%3C/svg%3E';
function base(){Object.assign(state,{languageMode:'zh-CN',currentUser:user,friendOverview:{friends:[{friend:{id:'evidence-contact',displayName:'测试联系人'}}],organizations:[]},collaborationOverview:{groups:[]},networkPanelOpen:true,networkPanelView:'messages',networkMessageHomeOpen:false,messageActivePane:'conversation',networkConversationMode:'person',networkConversationPeerId:'evidence-contact',networkConversationMessages:[],chatGroupId:'',chatGroupDetail:null,collaborationGroupId:'',networkConversationBusy:false,networkConversationDrafts:{},chatDraft:'',messages:[],attachments:[],composerMentions:[],secretaryMentions:[],composerFavoriteEmojis:[{id:'sticker',kind:'image',value:sticker,url:sticker,name:'sticker.png',filename:'sticker.png'}],messageReactionPicker:null,org:{departments:[],agents:[]},sessions:[],projects:[],tasks:[],agentDelegations:[],employeeOverview:{roster:[]},uBuddyFeatureFlags:{}})}
function paint(name,label,messages,unread,attachment=false){base();state.networkConversationMessages=messages.map((m)=>attachment?({...m,content:'',metadata:{...m.metadata,favoriteEmoji:true,attachments:[{name:'sticker.png',filename:'sticker.png',kind:'image',value:sticker,url:sticker}]}}):m);app.innerHTML='<div class="evidence"><aside><div class="evidence-head"><strong>消息</strong><small>空间隔离回归证据</small></div><div class="workspace-tag">'+label+'</div><div class="evidence-caption">已选中当前会话</div></aside><section><div class="evidence-head"><strong>会话列表</strong><small>点击后详情已加载</small></div><div class="conversation active"><span>测试联系人</span>'+(unread?'<b class="badge">'+unread+'</b>':'<span class="badge" style="background:#22a06b">已读</span>')+'</div><div class="conversation"><span>其他历史会话</span></div><div class="evidence-caption">未读只在详情成功渲染后清除</div></section><main class="message-host">'+renderChat()+'</main></div>';document.title=name}
window.paint=paint;window.getErrors=()=>[];
</script></body></html>`, 'utf8');

try {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false } });
  await win.loadFile(htmlPath);
  await win.webContents.executeJavaScript(`paint('organization-unread-opened','组织空间 · 未读消息已打开',[${JSON.stringify(orgMessage)}],1,false)`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  writeFileSync(path.join(screenshotDir, 'organization-unread-opened.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`paint('organization-unread-cleared-after-render','组织空间 · 详情加载后已读',[${JSON.stringify({ ...orgMessage, status: 'read' })}],0,false)`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  writeFileSync(path.join(screenshotDir, 'organization-unread-cleared-after-render.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`paint('personal-history-opened','个人空间 · 历史消息已打开',[${JSON.stringify(personalMessage)}],0,false)`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  writeFileSync(path.join(screenshotDir, 'personal-history-opened.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`paint('attachment-render-no-error','组织空间 · 附件消息正常渲染',[${JSON.stringify(orgMessage)}],0,true)`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  writeFileSync(path.join(screenshotDir, 'attachment-render-no-error.png'), (await win.webContents.capturePage()).toPNG());
  win.close();
  console.log(`message workspace evidence screenshots written to ${screenshotDir}`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
