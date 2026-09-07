import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureElectronFailureDiagnostics } from './lib/electronFailureDiagnostics.mjs';

const { app, BrowserWindow } = globalThis.__janusElectron;
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-renderer-ime-'));
const rendererEntry = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app.js')).href;
const rendererStateEntry = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app', 'state.js')).href;
const rendererStyle = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'style.css')).href;
const modelCatalog = {
  models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', contextWindowTokens: 128000, supportedReasoningEfforts: ['medium'], defaultReasoningEffort: 'medium' }],
};
const bootstrap = {
  root: tempRoot, workspaceRoot: tempRoot, org: { departments: [], agents: [], hrs: [] }, sessions: [], projects: [], tasks: [],
  agentStatuses: [], evolution: null, currentUser: { id: 'ime-user', displayName: 'IME User', role: 'member', permissions: {} },
  adminUsers: [], friendOverview: { friends: [], requests: { incoming: [], outgoing: [] } }, socialInbox: [],
  agentDelegations: [], collaborationOverview: { groups: [], tasks: [] }, socialStatus: { enabled: false, connected: false },
  codexConfig: {}, codexConfigFiles: null, cloudSync: null, modelCatalog,
  employeeOverview: { quota: { used: 0, limit: 10 }, roster: [], recruitableFamilies: [] }, userAgentSettings: [],
  personalEvolutionStatus: null, personalEvolutionProposals: [], stage8EvolutionStatus: null,
  clusterEvolutionOverview: { cohorts: [], runs: [], candidates: [] }, privateAssistant: null,
};

const htmlPath = path.join(tempRoot, 'renderer-ime-smoke.html');
writeFileSync(htmlPath, `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><link rel="stylesheet" href="${rendererStyle}"></head><body><div id="app"></div><script>
window.__imeSmoke={modelsListener:null,chatSendCalls:0,errors:[],originalInput:null};
window.addEventListener('error',(event)=>window.__imeSmoke.errors.push(String(event.error?.stack||event.message||event.error)));
window.addEventListener('unhandledrejection',(event)=>window.__imeSmoke.errors.push(String(event.reason?.stack||event.reason)));
const base={
  bootstrap:async()=>(${JSON.stringify(bootstrap)}), updateStatus:async()=>({enabled:false}), agentUpdateStatus:async()=>({enabled:false}),
  onModelsUpdated:(listener)=>{window.__imeSmoke.modelsListener=listener;return()=>{};},
  listSessions:async()=>[], listMessages:async()=>[], chatSend:async()=>{window.__imeSmoke.chatSendCalls+=1;return{};},
};
window.janus=new Proxy(base,{get(target,key){if(key in target)return target[key];if(String(key).startsWith('on'))return()=>()=>{};return async()=>null;}});
</script><script type="module" src="${rendererEntry}"></script></body></html>`, 'utf8');

let browserWindow;
try {
  await app.whenReady();
  browserWindow = new BrowserWindow({ show: false, width: 1200, height: 820,
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false } });
  await browserWindow.loadFile(htmlPath);
  await waitFor(browserWindow, `window.__imeSmoke.modelsListener`);
  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    state.currentTab='chat';state.networkPanelOpen=false;state.networkMessageHomeOpen=false;
    window.__imeSmoke.modelsListener(${JSON.stringify(modelCatalog)});
  })`);
  await waitFor(browserWindow, `document.querySelector('#chat-input')`);

  const duringComposition = await browserWindow.webContents.executeJavaScript(`(() => {
    const input=document.querySelector('#chat-input');
    input.focus();
    input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));
    input.value='zhongwen';
    input.setSelectionRange(input.value.length,input.value.length);
    input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'zhongwen',inputType:'insertCompositionText',isComposing:true}));
    window.__imeSmoke.originalInput=input;
    window.__imeSmoke.modelsListener(${JSON.stringify(modelCatalog)});
    return {same:document.querySelector('#chat-input')===input,value:input.value,focused:document.activeElement===input,composing:input.dataset.imeComposing};
  })()`);
  assert.deepEqual(duringComposition, { same: true, value: 'zhongwen', focused: true, composing: 'true' });

  await browserWindow.webContents.executeJavaScript(`(() => {
    const input=document.querySelector('#chat-input');
    input.value='中文';
    input.setSelectionRange(2,2);
    input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}));
    input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'中文',inputType:'insertText'}));
  })()`);
  await waitFor(browserWindow, `document.querySelector('#chat-input')!==window.__imeSmoke.originalInput && document.querySelector('#chat-input')?.value==='中文'`);
  const afterComposition = await browserWindow.webContents.executeJavaScript(`(() => {
    const input=document.querySelector('#chat-input');
    return {value:input.value,focused:document.activeElement===input,start:input.selectionStart,end:input.selectionEnd,composing:input.dataset.imeComposing||'',errors:window.__imeSmoke.errors};
  })()`);
  assert.deepEqual(afterComposition, { value: '中文', focused: true, start: 2, end: 2, composing: '', errors: [] });

  const enterDuringComposition = await browserWindow.webContents.executeJavaScript(`(() => {
    const input=document.querySelector('#chat-input');
    input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));
    input.value='ceshi';
    input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'ceshi',inputType:'insertCompositionText',isComposing:true}));
    input.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Enter'}));
    document.querySelector('#chat-form').requestSubmit();
    return {calls:window.__imeSmoke.chatSendCalls,value:input.value,composing:input.dataset.imeComposing};
  })()`);
  assert.deepEqual(enterDuringComposition, { calls: 0, value: 'ceshi', composing: 'true' });
  await browserWindow.webContents.executeJavaScript(`(() => {
    const input=document.querySelector('#chat-input');input.value='测试';
    input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'测试'}));
    input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'测试',inputType:'insertText'}));
  })()`);
  await waitFor(browserWindow, `document.querySelector('#chat-input')?.value==='测试'`);

  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    state.currentTab='chat';state.networkPanelOpen=true;state.networkPanelView='messages';state.networkMessageHomeOpen=true;
    state.org={...(state.org||{}),departments:[{id:'ime-department',name:'中文部门'}],agents:[{id:'ime-agent',name:'中文助理',departmentId:'ime-department'}],hrs:[]};
    state.sessions=[{id:'ime-search-session',title:'中文会话',agentId:'ime-agent',departmentId:'ime-department',status:'active'}];
    window.__imeSmoke.modelsListener(${JSON.stringify(modelCatalog)});
  })`);
  await waitFor(browserWindow, `document.querySelector('#sidebar-chat-search-trigger') && document.querySelector('[data-agent-message-row="ime-agent"]')`);
  const messageSearchPresentation = await browserWindow.webContents.executeJavaScript(`(() => {
    const trigger=document.querySelector('#sidebar-chat-search-trigger');
    return {inlineSearchAbsent:!document.querySelector('#network-conversation-search'),insideMessageHeader:Boolean(trigger?.parentElement?.classList.contains('message-panel-head')),insideMessageTitle:Boolean(trigger?.closest('.message-panel-title')),insideBrand:Boolean(trigger?.closest('.brand'))};
  })()`);
  assert.deepEqual(messageSearchPresentation, { inlineSearchAbsent: true, insideMessageHeader: true, insideMessageTitle: false, insideBrand: false });
  const chatSearchShortcut = await browserWindow.webContents.executeJavaScript(`(() => {
    const event=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'f',ctrlKey:true});
    return {dispatchResult:document.dispatchEvent(event),prevented:event.defaultPrevented};
  })()`);
  assert.deepEqual(chatSearchShortcut, { dispatchResult: false, prevented: true });
  await waitFor(browserWindow, `document.querySelector('#chat-search-modal-input')`);
  const searchDuringComposition = await browserWindow.webContents.executeJavaScript(`(() => {
    const input=document.querySelector('#chat-search-modal-input');
    input.focus();
    input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));
    input.value='zhongwen';input.setSelectionRange(input.value.length,input.value.length);
    input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'zhongwen',inputType:'insertCompositionText',isComposing:true}));
    return {same:document.querySelector('#chat-search-modal-input')===input,value:input.value,focused:document.activeElement===input};
  })()`);
  assert.deepEqual(searchDuringComposition, { same: true, value: 'zhongwen', focused: true });
  await browserWindow.webContents.executeJavaScript(`(() => {
    const input=document.querySelector('#chat-search-modal-input');
    input.value='中文';input.setSelectionRange(2,2);
    input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}));
    input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'中文',inputType:'insertText'}));
  })()`);
  await waitFor(browserWindow, `document.querySelector('#chat-search-modal-input')?.value==='中文'`);
  const searchAfterComposition = await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>({
    value:document.querySelector('#chat-search-modal-input')?.value||'',query:state.chatSearchQuery,
    focused:document.activeElement===document.querySelector('#chat-search-modal-input'),
  }))`);
  assert.deepEqual(searchAfterComposition, { value: '中文', query: '中文', focused: true });
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#close-chat-search-btn').click()`);
  await waitFor(browserWindow, `!document.querySelector('#chat-search-overlay')`);

  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    state.currentTab='chat';state.networkPanelOpen=true;state.networkPanelView='friends';state.contactsActivePane='directory';
    window.__imeSmoke.modelsListener(${JSON.stringify(modelCatalog)});
  })`);
  await waitFor(browserWindow, `document.querySelector('#friend-search-query')`);
  const contactSearchShortcut = await browserWindow.webContents.executeJavaScript(`(() => {
    const event=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'f',ctrlKey:true});
    const dispatchResult=document.dispatchEvent(event);
    return {dispatchResult,prevented:event.defaultPrevented,activeId:document.activeElement?.id||''};
  })()`);
  assert.deepEqual(contactSearchShortcut, { dispatchResult: false, prevented: true, activeId: 'friend-search-query' });

  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    state.friendOverview={friends:[{friend:{id:'friend-1',displayName:'联系人'}}],requests:{incoming:[],outgoing:[]}};
    state.currentTab='chat';state.networkPanelOpen=true;state.networkPanelView='messages';state.networkMessageHomeOpen=false;
    state.networkConversationPeerId='friend-1';state.networkConversationMode='person';state.networkConversationGroupId='';
    state.networkConversationMessages=[
      {id:'visible-long',senderUserId:'friend-1',recipientUserId:'ime-user',kind:'friend',content:'长消息排版测试 https://example.com/'+'a'.repeat(220),createdAt:new Date(Date.now()-1000).toISOString(),metadata:{type:'direct_message'}},
      {id:'withdrawn-own',senderUserId:'ime-user',recipientUserId:'friend-1',kind:'friend',content:'撤回后重新编辑的正文',createdAt:new Date().toISOString(),metadata:{type:'direct_message',withdrawn:true}},
    ];
    state.collaborationGroupId='';state.collaborationGroupDetail=null;state.currentSessionId='';state.currentChatKey='social:friend-1';state.chatDraft='';
    window.__imeSmoke.modelsListener(${JSON.stringify(modelCatalog)});
  })`);
  await waitFor(browserWindow, `document.querySelector('#chat-input.social-mention-input')`);
  const keyboardZoomIn = await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    const event=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'+',code:'Equal',ctrlKey:true,shiftKey:true});
    const dispatchResult=document.dispatchEvent(event);
    const list=document.querySelector('#message-list');
    return {dispatchResult,prevented:event.defaultPrevented,percent:state.conversationZoomPercent,dataset:list?.dataset.conversationZoom||'',fontSize:list?.style.getPropertyValue('--conversation-font-size')||''};
  })`);
  assert.deepEqual(keyboardZoomIn, { dispatchResult: false, prevented: true, percent: 110, dataset: '110', fontSize: '15.40px' });

  const wheelZoomIn = await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    const list=document.querySelector('#message-list');
    const event=new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-120,ctrlKey:true});
    const dispatchResult=list.dispatchEvent(event);
    return {dispatchResult,prevented:event.defaultPrevented,percent:state.conversationZoomPercent,dataset:list.dataset.conversationZoom};
  })`);
  assert.deepEqual(wheelZoomIn, { dispatchResult: false, prevented: true, percent: 125, dataset: '125' });

  const macZoomOut = await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    const event=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'-',code:'Minus',metaKey:true});
    const dispatchResult=document.dispatchEvent(event);
    return {dispatchResult,prevented:event.defaultPrevented,percent:state.conversationZoomPercent};
  })`);
  assert.deepEqual(macZoomOut, { dispatchResult: false, prevented: true, percent: 110 });

  const resetConversationZoom = await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    const event=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'0',code:'Digit0',ctrlKey:true});
    const dispatchResult=document.dispatchEvent(event);
    return {dispatchResult,prevented:event.defaultPrevented,percent:state.conversationZoomPercent,stored:localStorage.getItem('janus-conversation-zoom-v1')};
  })`);
  assert.deepEqual(resetConversationZoom, { dispatchResult: false, prevented: true, percent: 100, stored: '100' });

  const maximumConversationZoomLayout = await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    for(let index=0;index<4;index+=1){
      document.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'=',code:'Equal',ctrlKey:true}));
    }
    const list=document.querySelector('#message-list');
    const body=list.querySelector('.message-body');
    const result={percent:state.conversationZoomPercent,fontSize:getComputedStyle(body).fontSize,horizontalOverflow:list.scrollWidth-list.clientWidth};
    document.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'0',code:'Digit0',ctrlKey:true}));
    return result;
  })`);
  assert.equal(maximumConversationZoomLayout.percent, 160);
  assert.equal(maximumConversationZoomLayout.fontSize, '22.4px');
  assert.ok(maximumConversationZoomLayout.horizontalOverflow <= 1, `Conversation zoom caused ${maximumConversationZoomLayout.horizontalOverflow}px horizontal overflow`);

  const socialComposition = await browserWindow.webContents.executeJavaScript(`(() => {
    const input=document.querySelector('#chat-input');
    const overlay=document.querySelector('.social-mention-highlight');
    input.focus();
    input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));
    input.value='联络人';
    input.setSelectionRange(3,3);
    input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'联络人',inputType:'insertCompositionText',isComposing:true}));
    window.__imeSmoke.modelsListener(${JSON.stringify(modelCatalog)});
    const inputStyle=getComputedStyle(input);const overlayStyle=getComputedStyle(overlay);
    return {same:document.querySelector('#chat-input')===input,visible:overlay.textContent,value:input.value,start:input.selectionStart,
      paddingTop:[inputStyle.paddingTop,overlayStyle.paddingTop],fontSize:[inputStyle.fontSize,overlayStyle.fontSize],lineHeight:[inputStyle.lineHeight,overlayStyle.lineHeight]};
  })()`);
  assert.deepEqual(socialComposition, {
    same: true, visible: '联络人', value: '联络人', start: 3,
    paddingTop: ['1px', '1px'], fontSize: ['14px', '14px'], lineHeight: ['22px', '22px'],
  });
  await browserWindow.webContents.executeJavaScript(`(() => {
    const input=document.querySelector('#chat-input');
    input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'联络人'}));
    input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'联络人',inputType:'insertText'}));
  })()`);
  await waitFor(browserWindow, `document.querySelector('.social-mention-highlight')?.textContent==='联络人'`);
  const socialPaste = await browserWindow.webContents.executeJavaScript(`(() => {
    const input=document.querySelector('#chat-input.social-mention-input');
    input.focus();input.setSelectionRange(input.value.length,input.value.length);
    const transfer=new DataTransfer();transfer.setData('text/plain','粘贴文本');
    input.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));
    const overlay=document.querySelector('.social-mention-highlight');
    return {value:input.value,visible:overlay?.textContent||'',selected:input.selectionStart===input.selectionEnd};
  })()`);
  assert.deepEqual(socialPaste, { value: '联络人粘贴文本', visible: '联络人粘贴文本', selected: true },
    'pasted social text must update the visible mention overlay immediately');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-withdrawn-message-edit="withdrawn-own"]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('#chat-input')?.value==='撤回后重新编辑的正文'`);
  const withdrawnReEdit = await browserWindow.webContents.executeJavaScript(`(() => ({
    value:document.querySelector('#chat-input')?.value||'',
    visible:document.querySelector('.social-mention-highlight')?.textContent||'',
    stillWithdrawn:document.querySelector('[data-withdrawn-message-edit="withdrawn-own"]')!==null,
  }))()`);
  assert.deepEqual(withdrawnReEdit, { value: '撤回后重新编辑的正文', visible: '撤回后重新编辑的正文', stillWithdrawn: true },
    're-editing must restore the original text without undoing the withdrawal');

  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    state.networkConversationPeerId='';state.networkConversationGroupId='';state.networkConversationMode='person';
    state.languageMode='zh-CN';state.themeMode='light';
    state.collaborationGroupId='group-1';state.collaborationGroupDetail={group:{id:'group-1',title:'研究协作群',status:'active',ownerUserId:'ime-user',metadata:{taskSummary:{version:1,objective:'形成一份可用于管理层决策的医疗产品用户研究报告',deliverables:['用户研究报告.docx','关键发现摘要.md'],acceptanceCriteria:['结论可追溯到公开研究证据','明确风险和下一步建议'],constraints:['使用中文','不包含任何私人会话或个人 Memory'],deadline:'2026-08-20'},virtualParticipants:[{agentInstanceId:'analysis-agent-1',agentFamilyId:'analysis_agent',displayName:'分析 Agent',status:'queued'}]}},members:[{userId:'ime-user',role:'owner',status:'active',user:{id:'ime-user',displayName:'我'}},{userId:'peer-user',role:'member',status:'active',user:{id:'peer-user',displayName:'小周'}}],tasks:[{id:'group-task-1',title:'整理用户研究结论',instruction:'验证左右双栏布局',status:'working',requesterUserId:'ime-user',recipientUserId:'peer-user',updatedAt:'2026-08-12T09:32:00.000Z',metadata:{executionProgress:{phase:'executing',updatedAt:'2026-08-12T09:32:00.000Z',milestones:[{key:'collect:completed',title:'收集真实案例',detail:'已提取 6 个真实案例',agentName:'研究 Agent',status:'completed',occurredAt:'2026-08-12T09:31:00.000Z',sequence:1},{key:'compare:running',title:'比较设计框架',detail:'正在比较关键维度和已有框架',agentName:'分析 Agent',status:'running',occurredAt:'2026-08-12T09:32:00.000Z',sequence:2}]}}}],messages:[{id:'summary-layout',senderUserId:'ime-user',senderAgentId:'secretary_agent',kind:'agent',content:'研究任务进入方案整理阶段。',createdAt:'2026-08-12T09:32:00.000Z',metadata:{type:'ubuddy_task_summary',taskId:'group-task-1',stage:'started',summaryVersion:1,conclusion:'真实案例已经收集完成，正在归纳隐性需求和框架差异。',highlights:['已提取 6 个真实案例','已确认 4 个比较维度'],risk:'医疗场景样本仍需补充确认。',nextStep:'整理对比结论并提交团队评审。',occurredAt:'2026-08-12T09:32:00.000Z'}}]};
    state.collaborationPaneByGroupId={'group-1':'progress'};state.collaborationMobilePaneByGroupId={'group-1':'group'};
    state.currentChatKey='collaboration:group-1';state.chatDraft='原始文字';
    window.__imeSmoke.modelsListener(${JSON.stringify(modelCatalog)});
  })`);
  await waitFor(browserWindow, `document.querySelector('.collaboration-group-chat-view #chat-input.social-mention-input')`);
  const taskGroupEdit = await browserWindow.webContents.executeJavaScript(`(() => {
    const input=document.querySelector('#chat-input');
    input.focus();input.setSelectionRange(2,4);input.setRangeText('修改',2,4,'end');
    input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'修改',inputType:'insertReplacementText'}));
    return {value:input.value,visible:document.querySelector('.social-mention-highlight')?.textContent||'',start:input.selectionStart,end:input.selectionEnd};
  })()`);
  assert.deepEqual(taskGroupEdit, { value: '原始修改', visible: '原始修改', start: 4, end: 4 });
  await waitFor(browserWindow, `document.querySelector('.collaboration-progress-pane')`);
  const collaborationSplitLayout = await browserWindow.webContents.executeJavaScript(`(() => {
    const panes=document.querySelector('.collaboration-workbench-panes');
    const publicPane=document.querySelector('.collaboration-public-pane');
    const sidePane=document.querySelector('.collaboration-side-pane');
    const left=publicPane?.getBoundingClientRect();const right=sidePane?.getBoundingClientRect();
    return {display:getComputedStyle(panes).display,leftWidth:Math.round(left?.width||0),rightWidth:Math.round(right?.width||0),separated:Boolean(left&&right&&left.right<=right.left+1)};
  })()`);
  assert.equal(collaborationSplitLayout.display, 'grid');
  assert.ok(collaborationSplitLayout.leftWidth >= 250, `public collaboration pane is too narrow: ${collaborationSplitLayout.leftWidth}`);
  assert.ok(collaborationSplitLayout.rightWidth >= 320, `collaboration progress pane is too narrow: ${collaborationSplitLayout.rightWidth}`);
  assert.equal(collaborationSplitLayout.separated, true, 'collaboration panes must not overlap');
  const collaborationHeaderHeight = await browserWindow.webContents.executeJavaScript(`document.querySelector('.collaboration-workbench-header').getBoundingClientRect().height`);
  const collapsedGoalLayout = await browserWindow.webContents.executeJavaScript(`(() => {
    const header=document.querySelector('.collaboration-workbench-header').getBoundingClientRect();
    const summary=document.querySelector('.collaboration-shared-goal > summary').getBoundingClientRect();
    const panes=document.querySelector('.collaboration-workbench-panes').getBoundingClientRect();
    return {headerHeight:Math.round(header.height),summaryHeight:Math.round(summary.height),panesGap:Math.round(panes.top-header.bottom),open:document.querySelector('.collaboration-shared-goal').open};
  })()`);
  assert.equal(collapsedGoalLayout.open, false);
  assert.ok(collapsedGoalLayout.summaryHeight >= 32 && collapsedGoalLayout.summaryHeight <= 44,
    `collapsed shared goal must stay compact: ${JSON.stringify(collapsedGoalLayout)}`);
  assert.ok(collapsedGoalLayout.headerHeight <= 135, `collapsed workgroup header is too tall: ${collapsedGoalLayout.headerHeight}`);
  assert.ok(collapsedGoalLayout.panesGap >= 0, `shared goal overlaps workgroup panes: ${JSON.stringify(collapsedGoalLayout)}`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-collaboration-search-toggle]').click()`);
  await waitFor(browserWindow, `document.querySelector('.collaboration-search-panel')`);
  const searchPlacement = await browserWindow.webContents.executeJavaScript(`(() => {const header=document.querySelector('.collaboration-workbench-header').getBoundingClientRect();const search=document.querySelector('.collaboration-search-panel').getBoundingClientRect();return {gap:Math.round(search.top-header.bottom)};})()`);
  assert.ok(searchPlacement.gap >= 3, `collaboration search must open below the shared-goal header: ${JSON.stringify(searchPlacement)}`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-collaboration-search-toggle]').click()`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-collaboration-members-toggle]').click()`);
  await waitFor(browserWindow, `document.querySelector('.collaboration-member-popover') && document.querySelectorAll('.collaboration-member-row').length===3`);
  const lightMemberPopover = await browserWindow.webContents.executeJavaScript(`(() => {
    const header=document.querySelector('.collaboration-workbench-header');const button=document.querySelector('[data-collaboration-members-toggle]');
    const popover=document.querySelector('.collaboration-member-popover');const buttonRect=button.getBoundingClientRect();const popoverRect=popover.getBoundingClientRect();
    return {headerHeight:header.getBoundingClientRect().height,topGap:Math.round(popoverRect.top-buttonRect.bottom),rightDelta:Math.round(popoverRect.right-buttonRect.right),
      title:popover.querySelector('header strong')?.textContent||'',count:popover.querySelector('header small')?.textContent||'',rows:popover.querySelectorAll('.collaboration-member-row').length,
      peer:popover.textContent.includes('小周的 uBuddy'),background:getComputedStyle(popover).backgroundColor,expanded:button.getAttribute('aria-expanded')};
  })()`);
  assert.equal(lightMemberPopover.headerHeight, collaborationHeaderHeight, 'member popover must not increase the workgroup header height');
  assert.equal(lightMemberPopover.topGap, 8);
  assert.equal(lightMemberPopover.rightDelta, 0);
  assert.equal(lightMemberPopover.title, '工作群成员');
  assert.equal(lightMemberPopover.count, '2 位成员 · 1 个 Agent');
  assert.equal(lightMemberPopover.rows, 3);
  assert.equal(lightMemberPopover.peer, true);
  assert.equal(lightMemberPopover.expanded, 'true');
  if (process.env.JANUS_COLLABORATION_MEMBERS_LIGHT_SCREENSHOT) {
    await browserWindow.webContents.executeJavaScript(`new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    writeFileSync(process.env.JANUS_COLLABORATION_MEMBERS_LIGHT_SCREENSHOT, (await browserWindow.webContents.capturePage()).toPNG());
  }
  await browserWindow.webContents.executeJavaScript(`document.querySelector('.collaboration-public-pane').click()`);
  await waitFor(browserWindow, `!document.querySelector('.collaboration-member-popover')`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-collaboration-members-toggle]').click()`);
  await waitFor(browserWindow, `document.querySelector('.collaboration-member-popover')`);
  await browserWindow.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Escape'}))`);
  await waitFor(browserWindow, `!document.querySelector('.collaboration-member-popover') && document.activeElement===document.querySelector('[data-collaboration-members-toggle]')`);

  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    state.languageMode='en';state.themeMode='dark';state.collaborationMembersOpen=true;window.__imeSmoke.modelsListener(${JSON.stringify(modelCatalog)});
  })`);
  await waitFor(browserWindow, `document.querySelector('.shell.theme-dark .collaboration-member-popover') && document.querySelector('.collaboration-member-popover header strong')?.textContent==='Workgroup Members'`);
  const darkMemberPopover = await browserWindow.webContents.executeJavaScript(`(() => {
    const popover=document.querySelector('.collaboration-member-popover');const text=popover.textContent||'';
    return {text,count:popover.querySelector('header small')?.textContent||'',peer:text.includes("小周's uBuddy"),background:getComputedStyle(popover).backgroundColor,
      role:[...popover.querySelectorAll('.collaboration-member-row em')].map((item)=>item.textContent),headerHeight:document.querySelector('.collaboration-workbench-header').getBoundingClientRect().height};
  })()`);
  assert.equal(darkMemberPopover.peer, true);
  assert.equal(darkMemberPopover.count, '2 members · 1 Agent');
  assert.match(darkMemberPopover.text, /Local Agent · Queued/);
  assert.deepEqual(darkMemberPopover.role, ['Owner','Member','Agent']);
  assert.notEqual(darkMemberPopover.background, lightMemberPopover.background);
  assert.equal(darkMemberPopover.headerHeight, collaborationHeaderHeight);
  if (process.env.JANUS_COLLABORATION_MEMBERS_DARK_SCREENSHOT) {
    await browserWindow.webContents.executeJavaScript(`new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    writeFileSync(process.env.JANUS_COLLABORATION_MEMBERS_DARK_SCREENSHOT, (await browserWindow.webContents.capturePage()).toPNG());
  }
  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    state.languageMode='zh-CN';state.themeMode='light';state.collaborationMembersOpen=false;window.__imeSmoke.modelsListener(${JSON.stringify(modelCatalog)});
  })`);
  await waitFor(browserWindow, `document.querySelector('.shell.theme-light') && !document.querySelector('.collaboration-member-popover')`);
  if (process.env.JANUS_COLLABORATION_WORKBENCH_SCREENSHOT) {
    await browserWindow.webContents.executeJavaScript(`new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await waitFor(browserWindow, `document.querySelector('.collaboration-group-chat-view .collaboration-progress-pane')`);
    writeFileSync(process.env.JANUS_COLLABORATION_WORKBENCH_SCREENSHOT, (await browserWindow.webContents.capturePage()).toPNG());
  }
  if (process.env.JANUS_COLLABORATION_GOAL_EXPANDED_SCREENSHOT) {
    await browserWindow.webContents.executeJavaScript(`document.querySelector('.collaboration-shared-goal > summary').click()`);
    await waitFor(browserWindow, `document.querySelector('.collaboration-shared-goal')?.open`);
    const expandedGoalLayout = await browserWindow.webContents.executeJavaScript(`(() => {const header=document.querySelector('.collaboration-workbench-header').getBoundingClientRect();const panes=document.querySelector('.collaboration-workbench-panes').getBoundingClientRect();const firstValue=document.querySelector('.collaboration-shared-goal dd').getBoundingClientRect();return {headerHeight:Math.round(header.height),panesGap:Math.round(panes.top-header.bottom),valueWidth:Math.round(firstValue.width)};})()`);
    assert.ok(expandedGoalLayout.headerHeight > collaborationHeaderHeight, 'expanded shared goal must reveal its details');
    assert.ok(expandedGoalLayout.headerHeight <= 360, `expanded shared goal is too tall: ${JSON.stringify(expandedGoalLayout)}`);
    assert.ok(expandedGoalLayout.valueWidth >= 500, `expanded shared-goal values are too narrow: ${JSON.stringify(expandedGoalLayout)}`);
    assert.ok(expandedGoalLayout.panesGap >= 0, `expanded shared goal overlaps workgroup panes: ${JSON.stringify(expandedGoalLayout)}`);
    await browserWindow.webContents.executeJavaScript(`new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    writeFileSync(process.env.JANUS_COLLABORATION_GOAL_EXPANDED_SCREENSHOT, (await browserWindow.webContents.capturePage()).toPNG());
    await browserWindow.webContents.executeJavaScript(`document.querySelector('.collaboration-shared-goal > summary').click()`);
  }
  const collaborationPrivateUi = await browserWindow.webContents.executeJavaScript(`({
    sideTabs:document.querySelectorAll('[data-collaboration-side-pane]').length,
    privateForm:Boolean(document.querySelector('#collaboration-private-form')),
    privateMobileTab:Boolean(document.querySelector('[data-collaboration-mobile-pane="private"]')),
  })`);
  assert.deepEqual(collaborationPrivateUi, { sideTabs: 0, privateForm: false, privateMobileTab: false });
  browserWindow.setSize(800, 820);
  await waitFor(browserWindow, `window.innerWidth<=800&&getComputedStyle(document.querySelector('.collaboration-mobile-tabs')).display==='grid'`);
  const compactGroupPane = await browserWindow.webContents.executeJavaScript(`(() => ({
    publicDisplay:getComputedStyle(document.querySelector('.collaboration-public-pane')).display,
    sideDisplay:getComputedStyle(document.querySelector('.collaboration-side-pane')).display,
  }))()`);
  assert.notEqual(compactGroupPane.publicDisplay, 'none');
  assert.equal(compactGroupPane.sideDisplay, 'none');
  if (process.env.JANUS_COLLABORATION_GOAL_NARROW_SCREENSHOT) {
    await browserWindow.webContents.executeJavaScript(`new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    writeFileSync(process.env.JANUS_COLLABORATION_GOAL_NARROW_SCREENSHOT, (await browserWindow.webContents.capturePage()).toPNG());
  }
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-collaboration-mobile-pane="progress"]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.collaboration-progress-pane')&&getComputedStyle(document.querySelector('.collaboration-side-pane')).display!=='none'`);
  const compactProgressPane = await browserWindow.webContents.executeJavaScript(`(() => ({
    publicDisplay:getComputedStyle(document.querySelector('.collaboration-public-pane')).display,
    sideDisplay:getComputedStyle(document.querySelector('.collaboration-side-pane')).display,
    progress:Boolean(document.querySelector('.collaboration-progress-pane')),
  }))()`);
  assert.equal(compactProgressPane.publicDisplay, 'none');
  assert.notEqual(compactProgressPane.sideDisplay, 'none');
  assert.equal(compactProgressPane.progress, true);
  browserWindow.setSize(1200, 820);

  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    const mention='@组织联系人小周';
    state.networkPanelOpen=false;state.networkMessageHomeOpen=false;state.networkConversationPeerId='';state.networkConversationGroupId='';
    state.collaborationGroupId='';state.collaborationGroupDetail=null;state.currentTab='chat';state.currentSessionId='';state.sessions=[];
    state.homeMode='secretary';state.currentChatKey='home';state.chatDraft=mention+' 结尾文字';
    state.friendOverview={friends:[],organizations:[{id:'org-ime',name:'产品组织',members:[{user:{id:'organization-contact-ime',displayName:'组织联系人小周'}}]}],requests:{incoming:[],outgoing:[]}};
    state.composerMentions=[{principalType:'user',userId:'organization-contact-ime',displayText:mention,mentionId:'mention-ime',source:'picker'}];
    state.secretaryMentions=[...state.composerMentions];state.socialMentionMenuOpen=false;
    window.__imeSmoke.modelsListener(${JSON.stringify(modelCatalog)});
  })`);
  await waitFor(browserWindow, `document.querySelector('.home-stage .mention-token-surface #chat-input.mention-token-input')`);
  const mentionSurfaceAlignment = await browserWindow.webContents.executeJavaScript(`(() => {
    const surface=document.querySelector('.mention-token-surface');const input=surface?.querySelector('#chat-input');const overlay=surface?.querySelector('.social-mention-highlight');
    const inputRect=input?.getBoundingClientRect();const overlayRect=overlay?.getBoundingClientRect();
    const inputStyle=getComputedStyle(input);const overlayStyle=getComputedStyle(overlay);
    input.focus();input.setSelectionRange(input.value.length-1,input.value.length);input.setRangeText('',input.value.length-1,input.value.length,'end');
    input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));
    return {
      value:input.value,visible:overlay?.textContent||'',
      leftDelta:Math.abs((inputRect?.left||0)-(overlayRect?.left||0)),topDelta:Math.abs((inputRect?.top||0)-(overlayRect?.top||0)),
      widthDelta:Math.abs((inputRect?.width||0)-(overlayRect?.width||0)),
      paddingTop:[inputStyle.paddingTop,overlayStyle.paddingTop],fontSize:[inputStyle.fontSize,overlayStyle.fontSize],lineHeight:[inputStyle.lineHeight,overlayStyle.lineHeight],
    };
  })()`);
  assert.equal(mentionSurfaceAlignment.value, '@组织联系人小周 结尾文');
  assert.equal(mentionSurfaceAlignment.visible, mentionSurfaceAlignment.value, 'ordinary deletion must immediately clear stale highlight text');
  assert.ok(mentionSurfaceAlignment.leftDelta < .5 && mentionSurfaceAlignment.topDelta < .5 && mentionSurfaceAlignment.widthDelta < .5,
    `mention overlay and caret surface must share one geometry: ${JSON.stringify(mentionSurfaceAlignment)}`);
  assert.deepEqual(mentionSurfaceAlignment.paddingTop, ['1px', '1px']);
  assert.deepEqual(mentionSurfaceAlignment.fontSize, ['15px', '15px']);
  assert.deepEqual(mentionSurfaceAlignment.lineHeight, ['24px', '24px']);
  const mentionDeleteUi = await browserWindow.webContents.executeJavaScript(`(() => {
    const mention='@组织联系人小周';const input=document.querySelector('#chat-input');const overlay=document.querySelector('.mention-token-surface .social-mention-highlight');
    input.value=mention+' ';input.setSelectionRange(0,0);input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));
    input.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Delete'}));
    return {value:input.value,visible:overlay?.textContent||'',start:input.selectionStart,end:input.selectionEnd};
  })()`);
  assert.deepEqual(mentionDeleteUi, { value: ' ', visible: ' ', start: 0, end: 0 },
    'forward Delete must remove the complete mention, keep the space, and update the visible layer');

  browserWindow.setSize(1600, 900);
  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    state.networkPanelOpen=false;state.networkMessageHomeOpen=false;state.networkConversationPeerId='';state.networkConversationGroupId='';
    state.collaborationGroupId='';state.collaborationGroupDetail=null;state.currentTab='chat';state.currentSessionId='alignment-session';
    state.currentChatKey='session:alignment-session';state.sessions=[{id:'alignment-session',title:'多轮布局',status:'active'}];
    state.messages=[
      {id:'align-user-1',role:'user',content:'第一轮问题'},
      {id:'align-assistant-1',role:'assistant',content:'第一轮回答'},
      {id:'align-user-2',role:'user',content:'第二轮问题'},
      {id:'align-assistant-2',role:'assistant',content:'第二轮回答'},
      {id:'align-process',role:'assistant',content:'',metadata:{transient:'process',streaming:true,durationMs:5000,processEvents:[
        {activityId:'reasoning',activityType:'reasoning',status:'running',title:'思考摘要',detail:'检查第二轮上下文',reasoningText:'逐项读取 Codex 原生 reasoning text',protocolEvents:Array.from({length:205},(_,index)=>({protocolEventId:'reasoning:'+index,sequence:index+1,emittedAtMs:1700000000000+index,receivedAtMs:1700000001000+index,method:'item/reasoning/textDelta',params:{delta:'native detail '+index},envelope:{emittedAtMs:1700000000000+index,method:'item/reasoning/textDelta',params:{delta:'native detail '+index}}}))},
        {activityId:'thread-status',activityType:'status',status:'completed',title:'Codex 线程状态更新',detail:'[object Object]',threadId:'thread-private',protocolEvents:[{protocolEventId:'status:1',sequence:206,method:'thread/status/changed',envelope:{method:'thread/status/changed',params:{status:{type:'idle'}}}}]},
        {activityId:'commentary',activityType:'commentary',status:'completed',title:'执行说明',detail:'阶段一开始：检查文件、命令和测试结果。',threadId:'thread-private',protocolEvents:[{protocolEventId:'commentary:1',sequence:207,method:'item/completed',envelope:{method:'item/completed',params:{item:{type:'agentMessage'}}}}]},
        {activityId:'file-change',activityType:'file',status:'completed',title:'文件处理',detail:'update · src/demo.js',changes:[{path:'/repo/src/demo.js',kind:'update',diff:'--- a/src/demo.js\\n+++ b/src/demo.js\\n@@ -1 +1 @@\\n-old\\n+new'}],diff:'--- a/src/demo.js\\n+++ b/src/demo.js\\n@@ -1 +1 @@\\n-old\\n+new'},
        {activityId:'tool-call',activityType:'tool',status:'completed',title:'工具调用',toolServer:'docs',toolName:'search',arguments:{query:'Codex transcript'},result:{hits:1}},
        {activityId:'command-ok',activityType:'command',status:'completed',title:'命令执行',command:'rg -n processEvents src',output:'src/main/runtime.js',exitCode:0,durationMs:120},
        {activityId:'command-failed',activityType:'command',status:'failed',title:'命令执行',command:'node failing-test.mjs',output:'AssertionError',exitCode:1,durationMs:45},
        {activityId:'answer-native',activityType:'answer',status:'completed',title:'回答生成完成',detail:'final_answer',responseText:'第二轮回答',memoryCitation:{source:'fixture-memory'},protocolEvents:[{protocolEventId:'answer:1',sequence:208,emittedAtMs:1700000002000,receivedAtMs:1700000002001,method:'item/completed',params:{item:{id:'answer-native',type:'agentMessage',phase:'final_answer',text:'第二轮回答'}},envelope:{emittedAtMs:1700000002000,method:'item/completed',params:{item:{id:'answer-native',type:'agentMessage',phase:'final_answer',text:'第二轮回答'}}}}]},
      ]}},
      {id:'align-status',role:'assistant',content:'继续处理 · 已处理 5s',metadata:{transient:'run-status',stage:'working'}},
    ];
    window.__imeSmoke.modelsListener(${JSON.stringify(modelCatalog)});
  })`);
  await waitFor(browserWindow, `document.querySelector('#message-list > .process-message .codex-transcript') && document.querySelector('#message-list > .run-status-message')`);
  const transientAlignment = await browserWindow.webContents.executeJavaScript(`(() => {
    const baselineShell=[...document.querySelectorAll('#message-list > .message.assistant:not(.process-message):not(.run-status-message) .message-shell')].at(-1);
    const baselineMessage=baselineShell?.closest('.message');
    const processMessage=document.querySelector('#message-list > .message.process-message');
    const processTranscript=processMessage?.querySelector('.codex-transcript');
    const commandGroup=processMessage?.querySelector('[data-codex-command-group-toggle]');
    const completedCommand=processMessage?.querySelector('[data-codex-command-toggle="align-process::command-ok"]');
    const failedCommand=processMessage?.querySelector('[data-codex-command-toggle="align-process::command-failed"]');
    const commandStatus=completedCommand?.querySelector('.codex-command-item-head b');
    const reasoningLabel=processMessage?.querySelector('.codex-transcript-label');
    const reasoningNarrative=processMessage?.querySelector('.type-reasoning');
    const commentary=processMessage?.querySelector('.type-commentary');
    const statusMessage=document.querySelector('#message-list > .message.run-status-message:not(.collaboration-run-message)');
    const statusContent=statusMessage?.querySelector('.run-inline-status');
    const list=document.querySelector('#message-list');const listRect=list?.getBoundingClientRect();
    const expectedLeft=listRect?listRect.left+parseFloat(getComputedStyle(list).paddingLeft||'0'):0;
    const baselineRect=baselineShell?.getBoundingClientRect();const baselineMessageRect=baselineMessage?.getBoundingClientRect();
    const processMessageRect=processMessage?.getBoundingClientRect();const processRect=processTranscript?.getBoundingClientRect();const statusRect=statusContent?.getBoundingClientRect();
    return {
      processLeftDelta:baselineRect&&processRect?Math.abs(processRect.left-baselineRect.left):-1,
      statusLeftDelta:baselineRect&&statusRect?Math.abs(statusRect.left-baselineRect.left):-1,
      processTrackDelta:baselineMessageRect&&processMessageRect?Math.abs(processMessageRect.width-baselineMessageRect.width):-1,
      assistantTrackLeftDelta:baselineMessageRect?Math.abs(baselineMessageRect.left-expectedLeft):-1,
      processLive:processTranscript?.classList.contains('is-streaming')===true,
      liveItemCount:processMessage?.querySelectorAll('.codex-transcript-narrative,[data-codex-command-group-toggle],[data-codex-operation-toggle],.codex-system-status').length||0,
      commandGroupCollapsed:commandGroup?.open===false,
      completedCommandOpen:completedCommand?.open===true,
      failedCommandOpen:failedCommand?.open===true,
      failedCommandOutput:failedCommand?.textContent.includes('AssertionError')===true,
      commandStatusHorizontal:commandStatus?getComputedStyle(commandStatus).whiteSpace==='nowrap'
        && commandStatus.getBoundingClientRect().height<=parseFloat(getComputedStyle(commandStatus).fontSize||'13')*1.8:false,
      reasoningLabel:reasoningLabel?.textContent.trim()||'',
      reasoningLabelFontSize:reasoningLabel?parseFloat(getComputedStyle(reasoningLabel).fontSize):0,
      reasoningVisible:reasoningNarrative?.textContent.includes('检查第二轮上下文')===true,
      commentaryVisible:commentary?.textContent.includes('阶段一开始')===true,
      commentaryPlain:commentary?getComputedStyle(commentary).backgroundColor==='rgba(0, 0, 0, 0)'
        && parseFloat(getComputedStyle(commentary).paddingLeft)===0
        && getComputedStyle(commentary).borderLeftWidth==='0px':false,
      technicalDetailsHidden:processMessage?.querySelector('.codex-technical-stream')===null,
      protocolNoiseHidden:!processTranscript?.innerText.includes('[object Object]'),
    };
  })()`);
  assert.ok(transientAlignment.processLeftDelta <= 1 && transientAlignment.statusLeftDelta <= 1 && transientAlignment.processTrackDelta <= 1,
    `process and heartbeat rows must share the assistant message left edge: ${JSON.stringify(transientAlignment)}`);
  assert.ok(transientAlignment.assistantTrackLeftDelta <= 1, `assistant messages must use the left-aligned content track: ${JSON.stringify(transientAlignment)}`);
  assert.equal(transientAlignment.processLive, true, 'streaming process items must render as a native linear transcript');
  assert.ok(transientAlignment.liveItemCount >= 5, 'live transcripts must retain reasoning, stage commentary, file, tool, and command activity');
  assert.equal(transientAlignment.commandGroupCollapsed, true, 'command groups must stay compact by default');
  assert.equal(transientAlignment.completedCommandOpen, false, 'completed commands must be collapsed by default');
  assert.equal(transientAlignment.failedCommandOpen, false, 'failed commands should remain available without forcing the full shell output open');
  assert.equal(transientAlignment.failedCommandOutput, true, 'collapsed command details must retain output for manual expansion');
  assert.equal(transientAlignment.commandStatusHorizontal, true, 'command status labels must remain horizontal');
  assert.equal(transientAlignment.reasoningLabel, '', 'the compact process stream must not repeat a reasoning heading');
  assert.equal(transientAlignment.reasoningLabelFontSize, 0);
  assert.equal(transientAlignment.reasoningVisible, true, 'reasoning summary text must remain visible after removing the repeated heading');
  assert.equal(transientAlignment.commentaryVisible, true, 'Codex commentary must remain visible as transcript prose');
  assert.equal(transientAlignment.commentaryPlain, true, 'Codex commentary must render as plain prose without a colored card');
  assert.equal(transientAlignment.technicalDetailsHidden, true,
    `runtime IDs and raw protocol must stay out of the normal transcript: ${JSON.stringify(transientAlignment)}`);
  assert.equal(transientAlignment.protocolNoiseHidden, true, 'thread and turn status objects must not leak into the human transcript');
  const processStabilityBefore=await browserWindow.webContents.executeJavaScript(`(() => {
    const list=document.querySelector('#message-list');
    const stable=document.querySelector('[data-message-id="align-assistant-1"]');
    window.__imeSmoke.messageListNode=list;
    window.__imeSmoke.stableHistoryNode=stable;
    window.__imeSmoke.processNode=document.querySelector('[data-message-id="align-process"]');
    return {processPresent:Boolean(window.__imeSmoke.processNode)};
  })()`);
  await browserWindow.webContents.executeJavaScript(`(() => {
    document.querySelector('[data-codex-command-group-toggle="align-process::command-ok"] > summary')?.click();
    document.querySelector('[data-codex-command-toggle="align-process::command-ok"] > summary')?.click();
    document.querySelector('[data-codex-command-toggle="align-process::command-failed"] > summary')?.click();
    document.querySelector('[data-codex-operation-toggle="align-process::file-change"] > summary')?.click();
    document.querySelector('[data-codex-operation-toggle="align-process::file-change"] .codex-file-change > summary')?.click();
  })()`);
  await waitFor(browserWindow, `document.querySelector('[data-codex-command-group-toggle="align-process::command-ok"]')?.open===true
    && document.querySelector('[data-codex-command-toggle="align-process::command-ok"]')?.open===true
    && document.querySelector('[data-codex-command-toggle="align-process::command-failed"]')?.open===true
    && document.querySelector('[data-codex-operation-toggle="align-process::file-change"]')?.open===true
    && document.querySelector('[data-codex-operation-toggle="align-process::file-change"] .codex-file-change')?.open===true`);
  const expandedDetails=await browserWindow.webContents.executeJavaScript(`(() => {
    const processMessage=document.querySelector('#message-list > .message.process-message');
    const addedLine=processMessage?.querySelector('.codex-diff-line.is-add');
    const deletedLine=processMessage?.querySelector('.codex-diff-line.is-delete');
    const fileHeaderLines=Array.from(processMessage?.querySelectorAll('.codex-diff-line.is-meta code')||[]).map((node)=>node.textContent);
    const addedNumbers=Array.from(addedLine?.querySelectorAll('.codex-diff-line-number')||[]).map((node)=>node.textContent.trim());
    const deletedNumbers=Array.from(deletedLine?.querySelectorAll('.codex-diff-line-number')||[]).map((node)=>node.textContent.trim());
    return {
      richDetailsMounted:processMessage?.textContent.includes('检查第二轮上下文')===true
        && processMessage?.textContent.includes('src/demo.js')===true
        && processMessage?.textContent.includes('Codex transcript')===true
        && processMessage?.textContent.includes('$ rg -n processEvents src')===true
        && processMessage?.textContent.includes('AssertionError')===true,
      rawProtocolHidden:processMessage?.textContent.includes('item/reasoning/textDelta')===false
        && processMessage?.textContent.includes('emittedAtMs')===false,
      coloredDiff:Boolean(addedLine&&deletedLine)
        && getComputedStyle(addedLine).backgroundColor!==getComputedStyle(deletedLine).backgroundColor
        && getComputedStyle(addedLine).backgroundColor!=='rgba(0, 0, 0, 0)'
        && getComputedStyle(deletedLine).backgroundColor!=='rgba(0, 0, 0, 0)',
      lineNumbers:addedNumbers[1]==='1'&&deletedNumbers[0]==='1',
      fileHeadersNeutral:fileHeaderLines.includes('--- a/src/demo.js')&&fileHeaderLines.includes('+++ b/src/demo.js')
        && processMessage?.querySelectorAll('.codex-diff-line.is-add code').length===1
        && processMessage?.querySelectorAll('.codex-diff-line.is-delete code').length===1,
    };
  })()`);
  assert.equal(expandedDetails.richDetailsMounted, true, 'reasoning, file diff, tool IO, and Shell output must remain available');
  assert.equal(expandedDetails.rawProtocolHidden, true, 'raw Codex protocol must stay out of the normal transcript');
  assert.equal(expandedDetails.coloredDiff, true, `file additions and deletions must use distinct colors: ${JSON.stringify(expandedDetails)}`);
  assert.equal(expandedDetails.lineNumbers, true, `file diffs must show old and new line numbers: ${JSON.stringify(expandedDetails)}`);
  assert.equal(expandedDetails.fileHeadersNeutral, true, `unified diff file headers must not be styled as changed lines: ${JSON.stringify(expandedDetails)}`);
  const expandedStability=await browserWindow.webContents.executeJavaScript(`(() => ({
    sameList:window.__imeSmoke.messageListNode===document.querySelector('#message-list'),
    sameHistory:window.__imeSmoke.stableHistoryNode===document.querySelector('[data-message-id="align-assistant-1"]'),
    sameProcess:window.__imeSmoke.processNode===document.querySelector('[data-message-id="align-process"]'),
  }))()`);
  assert.equal(expandedStability.sameList, true, 'expanding process history must not replace the message list');
  assert.equal(expandedStability.sameHistory, true, 'expanding process history must preserve stable history message DOM nodes');
  assert.equal(expandedStability.sameProcess, true, 'expanding native details must preserve the process message DOM node');
  assert.equal(processStabilityBefore.processPresent, true, 'the process message must exist before expansion');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-codex-command-group-toggle="align-process::command-ok"] > summary')?.click()`);
  await waitFor(browserWindow, `document.querySelector('[data-codex-command-group-toggle="align-process::command-ok"]')?.open===false`);
  const collapsedStability=await browserWindow.webContents.executeJavaScript(`(() => ({
    sameList:window.__imeSmoke.messageListNode===document.querySelector('#message-list'),
    sameHistory:window.__imeSmoke.stableHistoryNode===document.querySelector('[data-message-id="align-assistant-1"]'),
    sameProcess:window.__imeSmoke.processNode===document.querySelector('[data-message-id="align-process"]'),
  }))()`);
  assert.equal(collapsedStability.sameList, true, 'collapsing process history must not replace the message list');
  assert.equal(collapsedStability.sameHistory, true, 'collapsing process history must preserve stable history message DOM nodes');
  assert.equal(collapsedStability.sameProcess, true, 'collapsing native details must preserve the process message DOM node');
  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    state.currentSessionId='clarification-ime-session';state.currentChatKey='session:clarification-ime-session';
    state.sessions=[{id:'clarification-ime-session',title:'多人协作确认',status:'active'}];
    state.uBuddyClarificationDrafts={};
    state.messages=[{id:'clarification-ime-message',role:'assistant',content:'请补充确认信息',metadata:{dispatchClarification:true,clarification:{question:'请补充确认信息',options:[]}}}];
    window.__imeSmoke.modelsListener(${JSON.stringify(modelCatalog)});
  })`);
  await waitFor(browserWindow, `document.querySelector('#ubuddy-clarification-input-clarification-ime-message')`);
  await browserWindow.webContents.executeJavaScript(`(() => {
    const input=document.querySelector('#ubuddy-clarification-input-clarification-ime-message');
    input.focus();
    input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));
    input.value='请让 uBuddy 自动完成分工';input.setSelectionRange(input.value.length,input.value.length);
    input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'请让 uBuddy 自动完成分工',inputType:'insertCompositionText',isComposing:true}));
    window.__imeSmoke.modelsListener(${JSON.stringify(modelCatalog)});
    input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'请让 uBuddy 自动完成分工'}));
  })()`);
  await waitFor(browserWindow, `document.querySelector('#ubuddy-clarification-input-clarification-ime-message')?.value==='请让 uBuddy 自动完成分工'
    && document.activeElement===document.querySelector('#ubuddy-clarification-input-clarification-ime-message')`);
  const clarificationImeState=await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>({
    value:document.querySelector('#ubuddy-clarification-input-clarification-ime-message')?.value||'',
    focused:document.activeElement===document.querySelector('#ubuddy-clarification-input-clarification-ime-message'),
    draft:state.uBuddyClarificationDrafts?.['clarification-ime-message']?.text||'',
  }))`);
  assert.deepEqual(clarificationImeState, {
    value: '请让 uBuddy 自动完成分工', focused: true, draft: '请让 uBuddy 自动完成分工',
  }, 'uBuddy clarification input must survive Chinese IME and a deferred full render');
  process.stdout.write('Renderer IME composition guard smoke passed.\n');
} catch (error) {
  await captureElectronFailureDiagnostics({ browserWindow, error, name: 'renderer-ime', stateExpression: 'window.__imeSmoke?.errors || []' });
  throw error;
} finally {
  if (browserWindow && !browserWindow.isDestroyed()) browserWindow.destroy();
  rmSync(tempRoot, { recursive: true, force: true });
}

async function waitFor(window, expression, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for renderer expression: ${expression}`);
}
