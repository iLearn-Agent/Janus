import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureElectronFailureDiagnostics } from './lib/electronFailureDiagnostics.mjs';

const { app, BrowserWindow, clipboard } = globalThis.__janusElectron;
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-shortcuts-'));
const rendererEntry = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app.js')).href;
const rendererStateEntry = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app', 'state.js')).href;
const rendererStyle = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'style.css')).href;
const modelCatalog = {
  models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', contextWindowTokens: 128000, supportedReasoningEfforts: ['medium'], defaultReasoningEffort: 'medium' }],
};
const bootstrap = {
  root: tempRoot,
  workspaceRoot: tempRoot,
  org: {
    departments: [{ id: 'general', name: '通用' }],
    agents: [{ id: 'general_agent', name: 'Generalist', departmentId: 'general', routable: true }],
    hrs: [],
  },
  sessions: [], projects: [], tasks: [], agentStatuses: [], evolution: null,
  currentUser: { id: 'shortcut-user', displayName: 'Shortcut User', role: 'admin', permissions: {} },
  adminUsers: [],
  friendOverview: { friends: [], organizations: [], requests: { incoming: [], outgoing: [] } },
  socialInbox: [], agentDelegations: [], collaborationOverview: { groups: [], tasks: [] },
  socialStatus: { enabled: false, connected: false }, codexConfig: {}, codexConfigFiles: null,
  cloudSync: null, modelCatalog,
  employeeOverview: {
    quota: { used: 1, limit: 10 },
    roster: [{ id: 'general-a', agentFamilyId: 'general_agent', displayName: 'Generalist A', employmentState: 'active', routeEligible: true, family: { name: 'Generalist', departmentId: 'general' } }],
    recruitableFamilies: [],
  },
  userAgentSettings: [], personalEvolutionStatus: null, personalEvolutionProposals: [], stage8EvolutionStatus: null,
  clusterEvolutionOverview: { cohorts: [], runs: [], candidates: [] }, privateAssistant: null,
};

const htmlPath = path.join(tempRoot, 'shortcut-layout-smoke.html');
writeFileSync(htmlPath, `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><link rel="stylesheet" href="${rendererStyle}"></head><body><div id="app"></div><script>
window.__shortcutSmoke={modelsListener:null,errors:[]};
window.__measureShortcutLayout=()=>{
  const list=document.querySelector('#message-list');
  const body=list?.querySelector('.message-body');
  const listRect=list?.getBoundingClientRect()||{left:0,right:0};
  const overflowWithin=(element,container)=>{
    if(!element||!container)return 0;
    const rect=element.getBoundingClientRect();const parent=container.getBoundingClientRect();
    return Math.max(0,rect.right-parent.right,parent.left-rect.left);
  };
  const shells=[...(list?.querySelectorAll('.message-shell')||[])];
  const table=list?.querySelector('.message-table-scroll');
  const code=list?.querySelector('.message-code-block');
  const math=list?.querySelector('.message-math-block');
  const katexGlyph=math?.querySelector('.katex .mord');
  const attachment=list?.querySelector('.message-attachment-card');
  const task=list?.querySelector('.ubuddy-published-task-card');
  return {
    percent:Number(list?.dataset.conversationZoom||0),
    bodyFontSize:body?getComputedStyle(body).fontSize:'',
    listOverflow:list?Math.max(0,list.scrollWidth-list.clientWidth):0,
    shellOverflow:shells.reduce((maximum,shell)=>Math.max(maximum,Math.max(0,shell.getBoundingClientRect().right-listRect.right,listRect.left-shell.getBoundingClientRect().left)),0),
    tableOverflow:overflowWithin(table,table?.closest('.message-shell')),
    codeOverflow:overflowWithin(code,code?.closest('.message-shell')),
    mathOverflow:overflowWithin(math,math?.closest('.message-shell')),
    mathScrollOverflow:math?Math.max(0,math.scrollWidth-math.clientWidth):0,
    katexFontFamily:katexGlyph?getComputedStyle(katexGlyph).fontFamily:'',
    katexFontReady:document.fonts.check('16px KaTeX_Main'),
    attachmentOverflow:overflowWithin(attachment,attachment?.closest('.message-shell')),
    taskOverflow:overflowWithin(task,list),
    indicatorPresent:Boolean(document.querySelector('.conversation-zoom-indicator')),
    indicatorText:document.querySelector('.conversation-zoom-indicator')?.textContent||'',
  };
};
window.addEventListener('error',(event)=>window.__shortcutSmoke.errors.push(String(event.error?.stack||event.message||event.error)));
window.addEventListener('unhandledrejection',(event)=>window.__shortcutSmoke.errors.push(String(event.reason?.stack||event.reason)));
const base={
  bootstrap:async()=>(${JSON.stringify(bootstrap)}), updateStatus:async()=>({enabled:false}), agentUpdateStatus:async()=>({enabled:false}),
  onModelsUpdated:(listener)=>{window.__shortcutSmoke.modelsListener=listener;return()=>{};},
  listSessions:async()=>[], listMessages:async()=>[], searchSessions:async()=>[],
};
window.janus=new Proxy(base,{get(target,key){if(key in target)return target[key];if(String(key).startsWith('on'))return()=>()=>{};return async()=>null;}});
</script><script type="module" src="${rendererEntry}"></script></body></html>`, 'utf8');

let browserWindow;
try {
  await app.whenReady();
  browserWindow = new BrowserWindow({ show: false, width: 1200, height: 820,
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false } });
  await browserWindow.loadFile(htmlPath);
  await waitFor(browserWindow, 'window.__shortcutSmoke.modelsListener');

  const normalEscapeMenu = await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    state.currentTab='chat';state.networkPanelOpen=false;state.accountMenuOpen=false;
    window.__shortcutSmoke.modelsListener(${JSON.stringify(modelCatalog)});
    const event=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Escape',code:'Escape'});
    const dispatchResult=document.dispatchEvent(event);
    return {dispatchResult,prevented:event.defaultPrevented,open:state.accountMenuOpen,menu:Boolean(document.querySelector('.account-menu')),menuItemFocused:Boolean(document.activeElement?.closest('.account-menu'))};
  })`);
  assert.deepEqual(normalEscapeMenu, { dispatchResult: false, prevented: true, open: true, menu: true, menuItemFocused: false }, 'plain Escape opens the account menu without highlighting an item');
  assert.deepEqual(await dispatchEscape(browserWindow, `import(${JSON.stringify(rendererStateEntry)}).then(({state})=>!state.accountMenuOpen && !document.querySelector('.account-menu'))`),
    { dispatchResult: false, prevented: true, matched: true }, 'Escape closes the account menu');

  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    state.activeAccountWorkspace={id:'workspace-personal',kind:'personal',name:'个人'};
    state.accountWorkspaces=[state.activeAccountWorkspace,{id:'workspace-team',kind:'organization',name:'测试组织'}];
    state.accountMenuOpen=true;state.accountMenuWorkspaceOpen=true;
    window.__shortcutSmoke.modelsListener(${JSON.stringify(modelCatalog)});
  })`);
  assert.deepEqual(await dispatchEscape(browserWindow, `import(${JSON.stringify(rendererStateEntry)}).then(({state})=>state.accountMenuOpen && !state.accountMenuWorkspaceOpen)`),
    { dispatchResult: false, prevented: true, matched: true }, 'first Escape closes only the account workspace submenu');
  assert.deepEqual(await dispatchEscape(browserWindow, `import(${JSON.stringify(rendererStateEntry)}).then(({state})=>!state.accountMenuOpen)`),
    { dispatchResult: false, prevented: true, matched: true }, 'second Escape closes the account menu');

  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    state.desktopDialog={title:'Escape 弹窗',message:'验证最上层弹窗优先关闭'};
    window.__shortcutSmoke.modelsListener(${JSON.stringify(modelCatalog)});
  })`);
  await waitFor(browserWindow, `document.querySelector('#desktop-dialog-close')`);
  assert.deepEqual(await dispatchEscape(browserWindow, `import(${JSON.stringify(rendererStateEntry)}).then(({state})=>!state.desktopDialog && !state.accountMenuOpen)`),
    { dispatchResult: false, prevented: true, matched: true }, 'Escape closes a modal without opening the account menu');

  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    state.currentTab='settings';state.settingsSearchQuery='模型';
    window.__shortcutSmoke.modelsListener(${JSON.stringify(modelCatalog)});
    document.querySelector('#settings-search-input')?.focus();
  })`);
  await waitFor(browserWindow, `document.activeElement?.id==='settings-search-input'`);
  assert.deepEqual(await dispatchEscape(browserWindow, `import(${JSON.stringify(rendererStateEntry)}).then(({state})=>state.currentTab==='settings' && state.settingsSearchQuery==='' && document.activeElement?.id==='settings-search-input')`),
    { dispatchResult: false, prevented: true, matched: true }, 'Escape clears the focused settings search first');
  assert.deepEqual(await dispatchEscape(browserWindow, `import(${JSON.stringify(rendererStateEntry)}).then(({state})=>state.currentTab==='settings' && document.activeElement?.id!=='settings-search-input')`),
    { dispatchResult: false, prevented: true, matched: true }, 'Escape then blurs an empty search field');
  assert.deepEqual(await dispatchEscape(browserWindow, `import(${JSON.stringify(rendererStateEntry)}).then(({state})=>state.currentTab==='chat' && !state.accountMenuOpen)`),
    { dispatchResult: false, prevented: true, matched: true }, 'Escape then returns from settings');

  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    state.currentTab='settings';state.settingsSearchQuery='输入法';window.__shortcutSmoke.modelsListener(${JSON.stringify(modelCatalog)});
    const input=document.querySelector('#settings-search-input');input.focus();input.dataset.imeComposing='true';
  })`);
  const composingEscape = await browserWindow.webContents.executeJavaScript(`(() => {
    const input=document.querySelector('#settings-search-input');
    const event=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Escape',code:'Escape',isComposing:true});
    const dispatchResult=input.dispatchEvent(event);
    const result={dispatchResult,prevented:event.defaultPrevented,value:input.value,focused:document.activeElement===input};
    delete input.dataset.imeComposing;return result;
  })()`);
  assert.deepEqual(composingEscape, { dispatchResult: true, prevented: false, value: '输入法', focused: true }, 'Escape must not interrupt IME composition');

  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    state.currentTab='chat';state.networkPanelOpen=true;state.networkPanelView='friends';state.contactsActivePane='directory';
    state.contactAddDialogOpen=true;state.contactAddDialogTab='create-organization';
    state.organizationCreateDraft={name:'可复制的组织名称',organizationNumber:'',verificationCode:''};
    window.__shortcutSmoke.modelsListener(${JSON.stringify(modelCatalog)});
    const input=document.querySelector('#organization-create-name');input?.focus();input?.select();
  })`);
  await waitFor(browserWindow, `document.activeElement?.id==='organization-create-name'`);
  const organizationCopyShortcut = await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    const input=document.querySelector('#organization-create-name');
    const event=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'c',code:'KeyC',ctrlKey:true});
    const dispatchResult=input.dispatchEvent(event);
    return {dispatchResult,prevented:event.defaultPrevented,open:state.contactAddDialogOpen,focused:document.activeElement===input,selection:input.value.slice(input.selectionStart,input.selectionEnd)};
  })`);
  assert.deepEqual(organizationCopyShortcut, {
    dispatchResult: true,
    prevented: false,
    open: true,
    focused: true,
    selection: '可复制的组织名称',
  }, 'Ctrl+C must remain a native copy shortcut inside the create-organization dialog');
  clipboard.clear();
  browserWindow.webContents.focus();
  browserWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'C', modifiers: ['control'] });
  browserWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'C', modifiers: ['control'] });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(clipboard.readText(), '可复制的组织名称', 'Ctrl+C must copy the selected organization text through the system clipboard');
  assert.equal(await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>state.contactAddDialogOpen)`), true,
    'native Ctrl+C must leave the create-organization dialog open');
  const modifiedOrganizationEscape = await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    const input=document.querySelector('#organization-create-name');
    const event=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Escape',code:'Escape',ctrlKey:true});
    const dispatchResult=input.dispatchEvent(event);
    return {dispatchResult,prevented:event.defaultPrevented,open:state.contactAddDialogOpen,focused:document.activeElement===input};
  })`);
  assert.deepEqual(modifiedOrganizationEscape, {
    dispatchResult: true,
    prevented: false,
    open: true,
    focused: true,
  }, 'modified Escape combinations must not cancel create-organization');
  assert.deepEqual(await dispatchEscape(browserWindow, `import(${JSON.stringify(rendererStateEntry)}).then(({state})=>!state.contactAddDialogOpen)`),
    { dispatchResult: false, prevented: true, matched: true }, 'plain Escape remains the designated create-organization cancel shortcut');

  const searchCases = [
    { tab: 'settings', selector: '#settings-search-input', modifier: 'ctrlKey' },
    { tab: 'plugins', selector: '#plugin-search-input', modifier: 'metaKey' },
    { tab: 'evolution', selector: '#evolution-search-input', modifier: 'ctrlKey' },
    { tab: 'employees', selector: '#employee-market-search', modifier: 'metaKey' },
  ];
  for (const testCase of searchCases) {
    await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
      state.currentTab=${JSON.stringify(testCase.tab)};state.networkPanelOpen=false;
      window.__shortcutSmoke.modelsListener(${JSON.stringify(modelCatalog)});
    })`);
    await waitFor(browserWindow, `document.querySelector(${JSON.stringify(testCase.selector)})`);
    const result = await dispatchShortcut(browserWindow, {
      key: 'f', code: 'KeyF', [testCase.modifier]: true,
    }, `document.activeElement?.matches(${JSON.stringify(testCase.selector)})`);
    assert.deepEqual(result, { dispatchResult: false, prevented: true, matched: true }, `${testCase.tab} search shortcut`);
  }

  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    state.currentTab='chat';state.networkPanelOpen=true;state.networkPanelView='friends';state.contactsActivePane='directory';
    window.__shortcutSmoke.modelsListener(${JSON.stringify(modelCatalog)});
  })`);
  await waitFor(browserWindow, `document.querySelector('#friend-search-query')`);
  assert.deepEqual(await dispatchShortcut(browserWindow, { key: 'f', code: 'KeyF', ctrlKey: true }, `document.activeElement?.id==='friend-search-query'`),
    { dispatchResult: false, prevented: true, matched: true }, 'contacts search shortcut');

  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    state.currentTab='chat';state.networkPanelOpen=false;state.sidebarCollapsed=false;state.desktopDialog=null;
    window.__shortcutSmoke.modelsListener(${JSON.stringify(modelCatalog)});
  })`);
  assert.deepEqual(await dispatchShortcut(browserWindow, { key: 'b', code: 'KeyB', ctrlKey: true }, `document.querySelector('.shell')?.classList.contains('sidebar-collapsed')`),
    { dispatchResult: false, prevented: true, matched: true }, 'Ctrl+B must toggle the sidebar');
  const disabledBottomPanelShortcut = await dispatchShortcut(browserWindow, { key: 'j', code: 'KeyJ', ctrlKey: true }, `Boolean(document.querySelector('.run-log'))`);
  assert.deepEqual(disabledBottomPanelShortcut, { dispatchResult: true, prevented: false, matched: false }, 'disabled Ctrl+J must remain inert');
  assert.deepEqual(await dispatchShortcut(browserWindow, { key: '?', code: 'Slash', ctrlKey: true, shiftKey: true }, `document.querySelectorAll('.desktop-dialog-row').length > 10`),
    { dispatchResult: false, prevented: true, matched: true }, 'Ctrl+Shift+/ must open the complete keyboard shortcut dialog');
  assert.deepEqual(await dispatchEscape(browserWindow, `!document.querySelector('#desktop-dialog-overlay')`),
    { dispatchResult: false, prevented: true, matched: true }, 'Escape must close the keyboard shortcut dialog');

  const shiftedFind = await browserWindow.webContents.executeJavaScript(`(() => {
    const event=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'f',code:'KeyF',ctrlKey:true,shiftKey:true});
    const dispatchResult=document.dispatchEvent(event);
    return {dispatchResult,prevented:event.defaultPrevented};
  })()`);
  assert.deepEqual(shiftedFind, { dispatchResult: true, prevented: false }, 'Ctrl+Shift+F must remain available');

  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    state.currentTab='chat';state.networkPanelOpen=true;state.networkPanelView='messages';state.networkMessageHomeOpen=true;
    state.sessions=[{id:'shortcut-search-session',title:'快捷键搜索会话',agentId:'general_agent',departmentId:'general',status:'active'}];
    window.__shortcutSmoke.modelsListener(${JSON.stringify(modelCatalog)});
  })`);
  await waitFor(browserWindow, `document.querySelector('#sidebar-chat-search-trigger')`);
  const messageShortcutLayout = await browserWindow.webContents.executeJavaScript(`(() => {
    const container=document.querySelector('.im-message-shortcuts');
    const buttons=[...document.querySelectorAll('.im-message-shortcut')];
    const containerRect=container?.getBoundingClientRect();
    const buttonRect=buttons[0]?.getBoundingClientRect();
    buttons[0]?.classList.add('active');
    const activeShadow=buttons[0]?getComputedStyle(buttons[0]).boxShadow:'';
    buttons[0]?.classList.remove('active');
    return {
      count:buttons.length,
      inline:buttons.length===3&&buttons.every((button)=>Math.abs(button.getBoundingClientRect().top-buttonRect.top)<2),
      topClearance:containerRect&&buttonRect?buttonRect.top-containerRect.top:0,
      activeShadow,
    };
  })()`);
  assert.equal(messageShortcutLayout.count, 3);
  assert.equal(messageShortcutLayout.inline, true);
  assert.ok(messageShortcutLayout.topClearance >= 9, `message shortcuts need more top clearance: ${JSON.stringify(messageShortcutLayout)}`);
  assert.notEqual(messageShortcutLayout.activeShadow, 'none');
  assert.deepEqual(await dispatchShortcut(browserWindow, { key: 'f', code: 'KeyF', metaKey: true }, `Boolean(document.querySelector('#chat-search-modal-input'))`),
    { dispatchResult: false, prevented: true, matched: true }, 'chat search Meta+F shortcut');
  assert.deepEqual(await dispatchEscape(browserWindow, `!document.querySelector('#chat-search-overlay') && !document.querySelector('.account-menu')`),
    { dispatchResult: false, prevented: true, matched: true }, 'Escape closes chat search without opening the account menu');
  await waitFor(browserWindow, `!document.querySelector('#chat-search-overlay')`);

  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    state.currentTab='chat';state.networkPanelOpen=true;state.networkPanelView='messages';state.networkMessageHomeOpen=false;
    state.currentSessionId='shortcut-search-session';state.currentChatKey='session:shortcut-search-session';state.messages=[];
    window.__shortcutSmoke.modelsListener(${JSON.stringify(modelCatalog)});
  })`);
  await waitFor(browserWindow, `document.querySelector('[data-message-home-back]')`);
  assert.deepEqual(await dispatchEscape(browserWindow, `import(${JSON.stringify(rendererStateEntry)}).then(({state})=>state.networkMessageHomeOpen && state.messageActivePane==='list' && !state.accountMenuOpen)`),
    { dispatchResult: false, prevented: true, matched: true }, 'Escape returns from a conversation to the message list');

  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    state.currentTab='chat';state.networkPanelOpen=false;state.renameSessionDialog={type:'session',sessionId:'shortcut-search-session',draft:'快捷键搜索会话'};
    window.__shortcutSmoke.modelsListener(${JSON.stringify(modelCatalog)});
  })`);
  await waitFor(browserWindow, `document.querySelector('#rename-session-close')`);
  assert.deepEqual(await dispatchEscape(browserWindow, `import(${JSON.stringify(rendererStateEntry)}).then(({state})=>!state.renameSessionDialog && !state.accountMenuOpen)`),
    { dispatchResult: false, prevented: true, matched: true }, 'Escape closes rename dialog first');

  const messages = Array.from({ length: 24 }, (_, index) => ({
    id: `zoom-${index}`,
    role: index % 3 === 0 ? 'user' : 'assistant',
    content: index === 4
      ? `### 缩放排版\n\n| 项目 | 说明 | 状态 |\n| --- | --- | --- |\n| 表格 | ${'长内容'.repeat(24)} | 正常 |\n\n\`\`\`js\nconst value = '${'code'.repeat(50)}';\nconsole.log(value);\n\`\`\`\n\n\\[\nT_{spec,P}\\geq\\max\\left(\\frac{W_{spec}}{P},D_{verify},D_{irreversible},L_{max}\\right)\n\\]`
      : index === 7
        ? `长链接 https://example.com/${'a'.repeat(260)}`
        : `第 ${index + 1} 条用于验证缩放锚点和消息排版的内容。${'测试文本'.repeat(10)}`,
    metadata: index === 10
      ? { attachments: [{ name: 'shortcut-layout-report.pdf', kind: 'file', size: 2048, relative_path: 'shortcut-layout-report.pdf' }] }
      : index === 12
        ? { publishedTaskCards: [{ delegationId: 'shortcut-task', title: '验证任务卡片排版', instruction: '确保缩放后按钮与文字不会溢出', status: 'assigned' }] }
        : {},
  }));
  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    state.currentTab='chat';state.networkPanelOpen=false;state.networkMessageHomeOpen=false;
    state.currentSessionId='shortcut-zoom-session';state.currentChatKey='session:shortcut-zoom-session';
    state.currentDepartmentId='general';state.currentAgentId='general_agent';
    state.sessions=[{id:'shortcut-zoom-session',title:'缩放布局验证',agentId:'general_agent',departmentId:'general',status:'active'}];
    state.messages=${JSON.stringify(messages)};state.themeMode='light';state.conversationZoomPercent=100;
    window.__shortcutSmoke.modelsListener(${JSON.stringify(modelCatalog)});
  })`);
  await waitFor(browserWindow, `document.querySelector('#message-list .message-markdown-table') && document.querySelector('#message-list .message-code-block') && document.querySelector('#message-list .message-math-block .katex-display') && document.querySelector('#message-list .message-attachment-card') && document.querySelector('#message-list .ubuddy-published-task-card')`);
  await browserWindow.webContents.executeJavaScript('document.fonts.ready');
  const initialMathLayout = await measureLayout(browserWindow);
  assert.match(initialMathLayout.katexFontFamily, /KaTeX_Main/, 'KaTeX stylesheet and math font must load in the renderer');
  assert.equal(initialMathLayout.katexFontReady, true, 'KaTeX main font must be available to the renderer');
  assert.ok(initialMathLayout.mathOverflow <= 1, `math container overflowed by ${initialMathLayout.mathOverflow}px`);

  const codeCopyResult = await browserWindow.webContents.executeJavaScript(`(()=>{
    window.__shortcutSmoke.copiedCode='';
    window.janus.writeClipboardText=async(text)=>{window.__shortcutSmoke.copiedCode=text;};
    const button=document.querySelector('#message-list [data-copy-code-block]');
    button?.click();
    return new Promise((resolve)=>setTimeout(()=>resolve({
      buttonPresent:Boolean(button),
      copiedCode:window.__shortcutSmoke.copiedCode,
      feedback:button?.textContent||'',
    }),20));
  })()`);
  assert.deepEqual(codeCopyResult, {
    buttonPresent: true,
    copiedCode: `const value = '${'code'.repeat(50)}';\nconsole.log(value);`,
    feedback: '已复制',
  }, 'code blocks expose a working copy button with immediate feedback');

  const composerUndo = await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    const originalInput=document.querySelector('#chat-input');originalInput.focus();
    originalInput.value='可恢复的原稿';originalInput.dispatchEvent(new Event('input',{bubbles:true}));
    originalInput.value='误操作后的内容';originalInput.dispatchEvent(new Event('input',{bubbles:true}));
    window.__shortcutSmoke.modelsListener(${JSON.stringify(modelCatalog)});
    const input=document.querySelector('#chat-input');input.focus();
    const undoEvent=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'z',code:'KeyZ',ctrlKey:true});
    const undoDispatchResult=input.dispatchEvent(undoEvent);
    const undoValue=input.value;
    const undoDraft=state.chatDraft;
    const redoEvent=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'z',code:'KeyZ',metaKey:true,shiftKey:true});
    const redoDispatchResult=input.dispatchEvent(redoEvent);
    return {
      inputWasReplaced:originalInput!==input,
      undoDispatchResult,undoPrevented:undoEvent.defaultPrevented,undoValue,undoDraft,
      redoDispatchResult,redoPrevented:redoEvent.defaultPrevented,redoValue:input.value,redoDraft:state.chatDraft,
    };
  })`);
  assert.deepEqual(composerUndo, {
    inputWasReplaced: true,
    undoDispatchResult: false,
    undoPrevented: true,
    undoValue: '可恢复的原稿',
    undoDraft: '可恢复的原稿',
    redoDispatchResult: false,
    redoPrevented: true,
    redoValue: '误操作后的内容',
    redoDraft: '误操作后的内容',
  }, 'chat composer undo/redo survives textarea replacement');

  const composerEscape = await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    const input=document.querySelector('#chat-input');input.focus();
    const event=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Escape',code:'Escape'});
    const dispatchResult=input.dispatchEvent(event);
    return {dispatchResult,prevented:event.defaultPrevented,blurred:document.activeElement!==input,menuOpen:state.accountMenuOpen};
  })`);
  assert.deepEqual(composerEscape, { dispatchResult: false, prevented: true, blurred: true, menuOpen: false }, 'Escape blurs the composer before opening menus');
  assert.deepEqual(await dispatchEscape(browserWindow, `import(${JSON.stringify(rendererStateEntry)}).then(({state})=>state.accountMenuOpen)`),
    { dispatchResult: false, prevented: true, matched: true }, 'next Escape opens the account menu from a normal conversation');
  await dispatchEscape(browserWindow, `import(${JSON.stringify(rendererStateEntry)}).then(({state})=>!state.accountMenuOpen)`);

  const keyMatrix = await browserWindow.webContents.executeJavaScript(`(async()=>{
    const {state}=await import(${JSON.stringify(rendererStateEntry)});
    const results=[];
    const send=(init)=>{const event=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,...init});const dispatchResult=document.dispatchEvent(event);results.push({dispatchResult,prevented:event.defaultPrevented,percent:state.conversationZoomPercent});};
    send({key:'+',code:'Equal',ctrlKey:true,shiftKey:true});
    send({key:'-',code:'Minus',ctrlKey:true});
    send({key:'=',code:'Equal',metaKey:true});
    send({key:'-',code:'Minus',metaKey:true});
    send({key:'Add',code:'NumpadAdd',ctrlKey:true});
    send({key:'Subtract',code:'NumpadSubtract',ctrlKey:true});
    send({key:'Add',code:'NumpadAdd',metaKey:true});
    send({key:'0',code:'Numpad0',metaKey:true});
    return results;
  })()`);
  assert.deepEqual(keyMatrix.map((item) => item.percent), [110, 100, 110, 100, 110, 100, 110, 100]);
  assert.equal(keyMatrix.every((item) => item.dispatchResult === false && item.prevented === true), true, 'all keyboard zoom shortcuts must be handled');

  const wheelMatrix = await browserWindow.webContents.executeJavaScript(`(async()=>{
    const {state}=await import(${JSON.stringify(rendererStateEntry)});
    const list=document.querySelector('#message-list');
    const initialPercent=state.conversationZoomPercent;
    const event=new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-120,ctrlKey:true});
    const dispatchResult=list.dispatchEvent(event);
    await new Promise((resolve)=>setTimeout(resolve,140));
    return {dispatchResult,prevented:event.defaultPrevented,percent:state.conversationZoomPercent,initialPercent};
  })()`);
  assert.equal(wheelMatrix.dispatchResult, false, 'trackpad pinch wheel must be consumed');
  assert.equal(wheelMatrix.prevented, true, 'trackpad pinch wheel must not reach Chromium page zoom');
  assert.equal(wheelMatrix.percent, wheelMatrix.initialPercent, 'trackpad pinch must not change conversation font size');


  const minimumLayout = await setZoomAndMeasure(browserWindow, { direction: 'out', steps: 4 });
  assert.equal(minimumLayout.percent, 80);
  assert.equal(minimumLayout.bodyFontSize, '11.2px');
  assert.ok(minimumLayout.listOverflow <= 1, `80% layout overflowed by ${minimumLayout.listOverflow}px`);

  await resetZoom(browserWindow);
  const maximumLayout = await setZoomAndMeasure(browserWindow, { direction: 'in', steps: 5, anchor: true });
  assert.equal(maximumLayout.percent, 160);
  assert.equal(maximumLayout.bodyFontSize, '22.4px');
  assert.ok(maximumLayout.listOverflow <= 1, `160% layout overflowed by ${maximumLayout.listOverflow}px`);
  assert.ok(maximumLayout.shellOverflow <= 1, `message shell overflowed by ${maximumLayout.shellOverflow}px`);
  assert.ok(maximumLayout.tableOverflow <= 1, `table container overflowed by ${maximumLayout.tableOverflow}px`);
  assert.ok(maximumLayout.codeOverflow <= 1, `code container overflowed by ${maximumLayout.codeOverflow}px`);
  assert.ok(maximumLayout.mathOverflow <= 1, `math container overflowed by ${maximumLayout.mathOverflow}px`);
  assert.ok(maximumLayout.attachmentOverflow <= 1, `attachment overflowed by ${maximumLayout.attachmentOverflow}px`);
  assert.ok(maximumLayout.taskOverflow <= 1, `task card overflowed by ${maximumLayout.taskOverflow}px`);
  assert.ok(Math.abs(maximumLayout.anchorDelta) <= 3, `message anchor moved by ${maximumLayout.anchorDelta}px: ${JSON.stringify(maximumLayout)}`);
  assert.equal(maximumLayout.indicatorPresent, true);
  assert.match(maximumLayout.indicatorText, /160%/);

  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{state.themeMode='dark';window.__shortcutSmoke.modelsListener(${JSON.stringify(modelCatalog)});})`);
  await waitFor(browserWindow, `document.querySelector('.shell.theme-dark #message-list')?.dataset.conversationZoom==='160'`);
  const darkLayout = await measureLayout(browserWindow);
  assert.equal(darkLayout.percent, 160);
  assert.equal(darkLayout.bodyFontSize, '22.4px');
  assert.ok(darkLayout.listOverflow <= 1, `dark layout overflowed by ${darkLayout.listOverflow}px`);
  assert.ok(darkLayout.mathOverflow <= 1, `dark math container overflowed by ${darkLayout.mathOverflow}px`);

  browserWindow.setSize(720, 760);
  await waitFor(browserWindow, `document.querySelector('.shell')?.classList.contains('layout-single') || document.querySelector('.shell')?.classList.contains('layout-compact')`);
  const narrowLayout = await measureLayout(browserWindow);
  assert.equal(narrowLayout.percent, 160);
  assert.ok(narrowLayout.listOverflow <= 1, `narrow layout overflowed by ${narrowLayout.listOverflow}px`);
  assert.ok(narrowLayout.shellOverflow <= 1, `narrow message shell overflowed by ${narrowLayout.shellOverflow}px`);
  assert.ok(narrowLayout.tableOverflow <= 1, `narrow table container overflowed by ${narrowLayout.tableOverflow}px`);
  assert.ok(narrowLayout.mathOverflow <= 1, `narrow math container overflowed by ${narrowLayout.mathOverflow}px`);

  await resetZoom(browserWindow);
  browserWindow.setSize(1041, 797);
  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    state.themeMode='light';state.currentTab='chat';state.networkPanelOpen=true;state.networkPanelView='messages';state.networkMessageHomeOpen=false;state.messageActivePane='conversation';
    state.chatGroupId='';state.chatGroupDetail=null;state.collaborationGroupId='';state.networkConversationPeerId='table-friend';state.networkConversationMode='person';
    state.currentUser={id:'shortcut-user',displayName:'Shortcut User',role:'admin',permissions:{}};
    state.friendOverview={friends:[{friend:{id:'table-friend',displayName:'测试账号 02',username:'table-friend'}}],organizations:[],requests:{incoming:[],outgoing:[]}};
    state.networkConversationMessages=[{id:'direct-ubuddy-table',senderUserId:'shortcut-user',recipientUserId:'table-friend',senderAgentId:'secretary_agent',kind:'agent',content:'| 任务目标 | 任务内容 | 执行 Agent | 分配状态 |\\n| --- | --- | --- | --- |\\n| 向测试账号 02 询问进度 | 询问其最近的工作进度、当前阻塞事项和下一步工作安排 | 执行 Agent | 接收方 uBuddy 正在等待可用 Agent 完成分配，分配成功后将继续协调执行并同步最新状态 |',createdAt:'2026-08-12T23:55:00.000Z'}];
    window.__shortcutSmoke.modelsListener(${JSON.stringify(modelCatalog)});
  })`);
  await waitFor(browserWindow, `document.querySelector('.direct-social-message.is-agent-message .message-markdown-table')`);
  const directTableLayout = await browserWindow.webContents.executeJavaScript(`(()=>{
    const table=document.querySelector('.direct-social-message.is-agent-message .message-markdown-table');
    const row=table?.tBodies[0]?.rows[0];const cells=[...(row?.cells||[])];const scroll=table?.closest('.message-table-scroll');
    const second=cells[1];const secondText=second?.querySelector('.message-table-cell-content')?.firstChild;const secondLines=[];
    if(secondText?.nodeType===Node.TEXT_NODE){for(let index=0;index<secondText.length;index+=1){const range=document.createRange();range.setStart(secondText,index);range.setEnd(secondText,index+1);const rect=range.getBoundingClientRect();const line=secondLines.find((item)=>Math.abs(item.top-rect.top)<1);if(line)line.count+=1;else secondLines.push({top:rect.top,count:1});}}
    return {columnCount:table?.dataset.columnCount||'',cellWidths:cells.map((cell)=>cell.getBoundingClientRect().width),rowHeight:row?.getBoundingClientRect().height||0,tableLayout:getComputedStyle(table).tableLayout,wordBreak:cells.map((cell)=>getComputedStyle(cell).wordBreak),secondLineCharacterCounts:secondLines.map((item)=>item.count),scrollWidth:scroll?.scrollWidth||0,clientWidth:scroll?.clientWidth||0};
  })()`);
  assert.equal(directTableLayout.columnCount, '4');
  assert.equal(directTableLayout.tableLayout, 'fixed');
  assert.deepEqual(directTableLayout.cellWidths.map(Math.round), [120, 240, 120, 240]);
  assert.ok(directTableLayout.secondLineCharacterCounts.length <= 4, `uBuddy table column two produced too many lines: ${JSON.stringify(directTableLayout)}`);
  assert.ok(directTableLayout.secondLineCharacterCounts.slice(0, -1).every((count) => count >= 8), `uBuddy table column two wrapped one character per line: ${JSON.stringify(directTableLayout)}`);
  assert.ok(directTableLayout.rowHeight <= 160, `uBuddy table row became vertically unreadable: ${JSON.stringify(directTableLayout)}`);
  assert.deepEqual(directTableLayout.wordBreak, ['normal', 'normal', 'normal', 'normal']);
  assert.ok(directTableLayout.scrollWidth >= directTableLayout.clientWidth, 'wide uBuddy tables should remain readable through horizontal scrolling');

  browserWindow.setSize(480, 720);
  await waitFor(browserWindow, `getComputedStyle(document.querySelector('.direct-social-message.is-agent-message .message-markdown-table[data-column-count="4"]')).display==='block'`);
  const stackedDirectTableLayout = await browserWindow.webContents.executeJavaScript(`(()=>{
    const table=document.querySelector('.direct-social-message.is-agent-message .message-markdown-table[data-column-count="4"]');const scroll=table.closest('.message-table-scroll');const row=table.tBodies[0].rows[0];const cells=[...row.cells];const rowRect=row.getBoundingClientRect();
    return {tableDisplay:getComputedStyle(table).display,headerDisplay:getComputedStyle(table.tHead).display,rowDisplay:getComputedStyle(row).display,labels:cells.map((cell)=>cell.dataset.columnLabel),cellDisplays:cells.map((cell)=>getComputedStyle(cell).display),cellWidths:cells.map((cell)=>Math.round(cell.getBoundingClientRect().width)),overflow:Math.max(0,scroll.scrollWidth-scroll.clientWidth),rowWidth:Math.round(rowRect.width),scrollWidth:Math.round(scroll.getBoundingClientRect().width)};
  })()`);
  assert.deepEqual(stackedDirectTableLayout.labels, ['任务目标', '任务内容', '执行 Agent', '分配状态']);
  assert.deepEqual(stackedDirectTableLayout.cellDisplays, ['grid', 'grid', 'grid', 'grid']);
  assert.equal(stackedDirectTableLayout.tableDisplay, 'block');
  assert.equal(stackedDirectTableLayout.headerDisplay, 'none');
  assert.equal(stackedDirectTableLayout.rowDisplay, 'grid');
  assert.equal(stackedDirectTableLayout.overflow, 0);
  assert.ok(stackedDirectTableLayout.cellWidths.every((width)=>Math.abs(width-stackedDirectTableLayout.rowWidth)<=1), `stacked uBuddy cells must fill the row: ${JSON.stringify(stackedDirectTableLayout)}`);

  browserWindow.setSize(1200, 820);
  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state})=>{
    state.themeMode='light';state.currentTab='chat';state.networkPanelOpen=false;state.networkPanelView='messages';state.networkMessageHomeOpen=false;state.messageActivePane='conversation';
    state.networkConversationPeerId='';state.chatGroupId='';state.chatGroupDetail=null;state.collaborationGroupId='shortcut-collaboration';
    state.currentUser={id:'shortcut-user',displayName:'Shortcut User',role:'admin',permissions:{}};
    state.friendOverview={friends:[{friend:{id:'peer-user',displayName:'小周',username:'peer-user'}}],organizations:[],requests:{incoming:[],outgoing:[]}};
    state.collaborationGroupDetail={
      group:{id:'shortcut-collaboration',ownerUserId:'shortcut-user',title:'负责人视觉验证群',status:'active'},
      members:[
        {userId:'shortcut-user',role:'owner',status:'active',user:state.currentUser},
        {userId:'peer-user',role:'member',status:'active',user:{id:'peer-user',displayName:'小周'}},
      ],
      tasks:[
        {id:'task-self',title:'我的子任务',status:'working',requesterUserId:'peer-user',recipientUserId:'shortcut-user',metadata:{}},
        {id:'task-peer',title:'小周的子任务',status:'working',requesterUserId:'shortcut-user',recipientUserId:'peer-user',metadata:{}},
      ],
      messages:[
        {id:'summary-self',senderUserId:'shortcut-user',senderAgentId:'secretary_agent',content:'我的任务正在处理。',createdAt:'2026-08-13T23:57:00.000Z',metadata:{type:'ubuddy_task_summary',taskId:'task-self',stage:'started',conclusion:'我的任务正在处理。'}},
        {id:'summary-peer',senderUserId:'shortcut-user',senderAgentId:'secretary_agent',content:'小周的任务正在处理。',createdAt:'2026-08-13T23:58:00.000Z',metadata:{type:'ubuddy_task_summary',taskId:'task-peer',stage:'started',conclusion:'小周的任务正在处理。'}},
      ],
    };
    state.collaborationGroupWorkspace={id:'shortcut-collaboration',scope:'collaboration_group',revision:1,syncStatus:'synced'};
    window.__shortcutSmoke.modelsListener(${JSON.stringify(modelCatalog)});
  })`);
  await waitFor(browserWindow, `document.querySelectorAll('.collaboration-task-summary').length===2`);
  const collaborationVisuals = await browserWindow.webContents.executeJavaScript(`(()=>{
    const action=document.querySelector('.collaboration-header-actions .collaboration-icon-button');
    const actionIcon=action?.querySelector('svg');
    const back=document.querySelector('.collaboration-workbench-header .social-group-close');
    const backIcon=back?.querySelector('svg');
    const summaries=[...document.querySelectorAll('.collaboration-task-summary')];
    const rect=(element)=>{const value=element?.getBoundingClientRect();return {width:value?.width||0,height:value?.height||0};};
    return {
      action:rect(action),actionIcon:rect(actionIcon),back:rect(back),backIcon:rect(backIcon),
      backBackground:getComputedStyle(back).backgroundColor,
      summaryLabels:summaries.map((item)=>item.querySelector('header small')?.textContent||''),
      summaryAvatarBackgrounds:summaries.map((item)=>getComputedStyle(item.querySelector('.collaboration-task-summary-icon')).backgroundImage),
      summaryIcons:summaries.map((item)=>Boolean(item.querySelector('.collaboration-task-summary-icon svg'))),
    };
  })()`);
  assert.deepEqual(collaborationVisuals.action, { width: 44, height: 44 });
  assert.deepEqual(collaborationVisuals.actionIcon, { width: 24, height: 24 });
  assert.deepEqual(collaborationVisuals.back, { width: 44, height: 44 });
  assert.deepEqual(collaborationVisuals.backIcon, { width: 24, height: 24 });
  assert.notEqual(collaborationVisuals.backBackground, 'rgba(0, 0, 0, 0)');
  assert.deepEqual(collaborationVisuals.summaryLabels, ['Shortcut User的 uBuddy · 任务总结', '小周的 uBuddy · 任务总结']);
  assert.equal(new Set(collaborationVisuals.summaryAvatarBackgrounds).size, 2, 'different uBuddy owners must use different stable avatar colors');
  assert.deepEqual(collaborationVisuals.summaryIcons, [true, true]);
  process.stdout.write('Collaboration uBuddy ownership visuals passed.\n');

  const errors = await browserWindow.webContents.executeJavaScript('window.__shortcutSmoke.errors');
  assert.deepEqual(errors, []);
  process.stdout.write('Renderer shortcut and conversation zoom layout smoke passed.\n');
} catch (error) {
  await captureElectronFailureDiagnostics({ browserWindow, error, name: 'renderer-shortcuts', stateExpression: 'window.__shortcutSmoke?.errors || []' });
  throw error;
} finally {
  if (browserWindow && !browserWindow.isDestroyed()) browserWindow.destroy();
  rmSync(tempRoot, { recursive: true, force: true });
}

async function dispatchShortcut(window, init, matchedExpression) {
  return window.webContents.executeJavaScript(`(() => {
    const event=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,...${JSON.stringify(init)}});
    const dispatchResult=document.dispatchEvent(event);
    return {dispatchResult,prevented:event.defaultPrevented,matched:Boolean(${matchedExpression})};
  })()`);
}

async function dispatchEscape(window, matchedExpression) {
  return dispatchShortcut(window, { key: 'Escape', code: 'Escape' }, matchedExpression);
}

async function setZoomAndMeasure(window, { direction = 'in', steps = 1, anchor = false } = {}) {
  return window.webContents.executeJavaScript(`(async()=>{
    const {state}=await import(${JSON.stringify(rendererStateEntry)});
    const list=document.querySelector('#message-list');
    let anchorId='',anchorTop=0,initialScrollTop=list.scrollTop,initialScrollHeight=list.scrollHeight;
    if(${anchor}){
      list.scrollTop=Math.floor((list.scrollHeight-list.clientHeight)*.45);
      await new Promise((resolve)=>requestAnimationFrame(resolve));
      const listRect=list.getBoundingClientRect();
      const anchor=[...list.querySelectorAll(':scope > [data-message-id]')].find((item)=>item.getBoundingClientRect().bottom>listRect.top+1);
      anchorId=anchor?.dataset.messageId||'';anchorTop=anchor?.getBoundingClientRect().top||0;initialScrollTop=list.scrollTop;initialScrollHeight=list.scrollHeight;
    }
    for(let index=0;index<${Number(steps)};index+=1){
      document.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:${JSON.stringify(direction === 'in' ? '=' : '-')},code:${JSON.stringify(direction === 'in' ? 'Equal' : 'Minus')},ctrlKey:true}));
    }
    await new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const metrics=window.__measureShortcutLayout();
    const anchor=anchorId?[...list.querySelectorAll(':scope > [data-message-id]')].find((item)=>item.dataset.messageId===anchorId):null;
    return {...metrics,anchorId,anchorTop,anchorAfter:anchor?.getBoundingClientRect().top||0,anchorDelta:anchor?anchor.getBoundingClientRect().top-anchorTop:0,initialScrollTop,finalScrollTop:list.scrollTop,initialScrollHeight,finalScrollHeight:list.scrollHeight,percent:state.conversationZoomPercent};
  })()`);
}

async function resetZoom(window) {
  await window.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'0',code:'Digit0',ctrlKey:true}))`);
  await new Promise((resolve) => setTimeout(resolve, 60));
}

async function measureLayout(window) {
  return window.webContents.executeJavaScript('window.__measureShortcutLayout()');
}

async function waitFor(window, expression, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for renderer expression: ${expression}`);
}
