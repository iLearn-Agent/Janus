import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureElectronFailureDiagnostics } from './lib/electronFailureDiagnostics.mjs';

const { app, BrowserWindow } = globalThis.__janusElectron;
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-goal-plan-ui-'));
const rendererEntry = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app.js')).href;
const rendererStyle = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'style.css')).href;
const goalScreenshotPath = process.env.JANUS_GOAL_UI_SCREENSHOT || '/tmp/janus-goal-mode-ui.png';
const planScreenshotPath = process.env.JANUS_PLAN_UI_SCREENSHOT || '/tmp/janus-plan-mode-ui.png';
const planSidebarScreenshotPath = process.env.JANUS_PLAN_SIDEBAR_UI_SCREENSHOT || '/tmp/janus-plan-sidebar-ui.png';
const planStandaloneScreenshotPath = process.env.JANUS_PLAN_STANDALONE_UI_SCREENSHOT || '/tmp/janus-plan-standalone-ui.png';
const planChoiceScreenshotPath = process.env.JANUS_PLAN_CHOICE_UI_SCREENSHOT || '/tmp/janus-plan-user-input-ui.png';
const planExecutionScreenshotPath = process.env.JANUS_PLAN_EXECUTION_UI_SCREENSHOT || '/tmp/janus-plan-execution-ui.png';
const goalSession = {
  id: 'goal_ui_session', title: '\u76ee\u6807\u6a21\u5f0f\u4f1a\u8bdd', departmentId: 'general', agentId: '', interactionMode: 'goal',
  goal: { objective: '\u6574\u7406\u6700\u8fd1\u7684\u63a8\u8350\u7cfb\u7edf\uff0c\u7136\u540e\u7ed9\u6211\u81f3\u5c11 5 \u4e2a\u53ef\u80fd\u7684\u9009\u9898\u65b9\u5411', status: 'active', tokensUsed: 12000, tokenBudget: 100000, timeUsedSeconds: 610 },
  status: 'active', writeState: 'writable', conversationRole: 'standard', updatedAt: '2026-07-30T09:00:00.000Z',
};
const planSession = {
  id: 'plan_ui_session', title: '\u8ba1\u5212\u6a21\u5f0f\u4f1a\u8bdd', departmentId: 'general', agentId: '', interactionMode: 'plan',
  status: 'active', writeState: 'writable', conversationRole: 'standard', updatedAt: '2026-07-30T09:01:00.000Z',
};
const plan = {
  explanation: '\u5148\u5ba1\u67e5\u73b0\u6709\u5b9e\u73b0\uff0c\u518d\u5b8c\u6210\u754c\u9762\u548c\u56de\u5f52\u9a8c\u8bc1\u3002',
  steps: [
    { step: '\u68c0\u67e5\u76ee\u6807\u4e0e\u8ba1\u5212\u6a21\u5f0f\u6570\u636e\u6d41', status: 'completed' },
    { step: '\u5b9e\u73b0\u76ee\u6807\u72b6\u6001\u5361\u548c\u8ba1\u5212\u8fdb\u5ea6\u5361', status: 'inProgress' },
    { step: '\u9a8c\u8bc1\u4e0b\u8f7d\u548c\u5b9e\u65bd\u8ba1\u5212\u6d41\u7a0b', status: 'pending' },
  ],
};
const planMessage = {
  id: 'plan_ui_message', sessionId: planSession.id, role: 'assistant', content: '\u8ba1\u5212\u5df2\u6574\u7406\u5b8c\u6210\u3002\n\n| \u6307\u6807 | \u76ee\u6807 |\n| --- | --- |\n| \u5b66\u751f\u5230\u8bfe\u7387 | >=85% |\n| \u8bfe\u7a0b\u5b8c\u6210\u7387 | >=90% |\n| \u5b66\u751f\u6ee1\u610f\u5ea6 | >=85% |',
  createdAt: '2026-07-30T09:02:00.000Z', metadata: { interactionMode: 'plan', plan },
};
const bootstrap = {
  root: tempRoot, org: { departments: [], agents: [], hrs: [] }, sessions: [goalSession, planSession], projects: [], tasks: [],
  agentStatuses: [], evolution: null, currentUser: { id: 'goal_plan_user', displayName: '\u754c\u9762\u9a8c\u8bc1\u7528\u6237', role: 'member', permissions: {} },
  adminUsers: [], friendOverview: { friends: [], requests: { incoming: [], outgoing: [] } }, socialInbox: [],
  agentDelegations: [], collaborationOverview: { groups: [], tasks: [] }, socialStatus: { enabled: false, connected: false },
  codexConfig: {}, codexConfigFiles: null, cloudSync: null,
  modelCatalog: { models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', contextWindowTokens: 128000, supportedReasoningEfforts: ['medium'], defaultReasoningEffort: 'medium' }] },
  employeeOverview: { capabilities: { multiMemory: { enabled: false, readOnly: true } }, quota: { used: 0, limit: 10 }, roster: [], recruitableFamilies: [] },
  userAgentSettings: [], personalEvolutionStatus: null, personalEvolutionProposals: [], stage8EvolutionStatus: null,
  clusterEvolutionOverview: { cohorts: [], runs: [], candidates: [] }, privateAssistant: null,
};
const htmlPath = path.join(tempRoot, 'renderer-goal-plan-smoke.html');
writeFileSync(htmlPath, `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><link rel="stylesheet" href="${rendererStyle}"></head><body><div id="app"></div><script>
window.__goalPlanSmoke={saveCalls:[],sessionUpdates:[],goalActions:[],sendCalls:[],sendResolvers:[],planQuestionWindowCalls:[],resetContextCalls:[],userInputResolutions:[],errors:[],codexEvent:null};
window.addEventListener('error',(event)=>window.__goalPlanSmoke.errors.push(String(event.error?.stack||event.message||event.error)));
window.addEventListener('unhandledrejection',(event)=>window.__goalPlanSmoke.errors.push(String(event.reason?.stack||event.reason)));
const sessions=${JSON.stringify([goalSession, planSession])};
const base={
 bootstrap:async()=>(${JSON.stringify(bootstrap)}),listSessions:async()=>sessions,
 listMessages:async(sessionId)=>sessionId===${JSON.stringify(planSession.id)}?[${JSON.stringify(planMessage)}]:[],
 listMessagePage:async({sessionId})=>({items:sessionId===${JSON.stringify(planSession.id)}?[${JSON.stringify(planMessage)}]:[],nextCursor:null,hasMore:false}),chatContextStatus:async()=>null,
 updateSession:async(payload)=>{window.__goalPlanSmoke.sessionUpdates.push(payload);const session=sessions.find((item)=>item.id===payload.sessionId);if(session)Object.assign(session,payload);return session||payload;},
 updateGoal:async(payload)=>{window.__goalPlanSmoke.goalActions.push(payload);const session=sessions.find((item)=>item.id===payload.sessionId);if(payload.action==='pause')session.goal.status='paused';if(payload.action==='resume')session.goal.status='active';if(payload.action==='edit')session.goal.objective=payload.objective;if(payload.action==='delete')session.goal=null;return session;},
 saveTextFile:async(payload)=>{window.__goalPlanSmoke.saveCalls.push(payload);return{canceled:false,path:'/tmp/goal-plan.md'};},
 openPlanQuestionWindow:async(payload)=>{window.__goalPlanSmoke.planQuestionWindowCalls.push(payload);return{ok:false,reason:'renderer smoke fallback'};},
 resetChatContext:async(payload)=>{window.__goalPlanSmoke.resetContextCalls.push(payload);return{sessionId:payload.sessionId,stateRevision:2,contextEpoch:2,usedTokens:0,warningLevel:'normal'};},
 resolveChatUserInput:async(payload)=>{window.__goalPlanSmoke.userInputResolutions.push(payload);return{ok:true,answers:payload.answers};},
 sendChat:async(payload)=>{window.__goalPlanSmoke.sendCalls.push(payload);return await new Promise((resolve)=>window.__goalPlanSmoke.sendResolvers.push(resolve));},
 onCodexEvent:(callback)=>{window.__goalPlanSmoke.codexEvent=callback;return()=>{};},
 updateStatus:async()=>({enabled:false}),agentUpdateStatus:async()=>({enabled:false}),pptxPluginStatus:async()=>({installed:true,available:true}),
};
window.janus=new Proxy(base,{get(target,key){if(key in target)return target[key];if(String(key).startsWith('on'))return()=>()=>{};return async()=>null;}});
</script><script type="module" src="${rendererEntry}"></script></body></html>`, 'utf8');

let browserWindow;
try {
  await app.whenReady();
  browserWindow = new BrowserWindow({ show: false, width: 1280, height: 900,
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false } });
  await browserWindow.loadFile(htmlPath);
  await waitFor(browserWindow, `document.querySelector('#sidebar-chat-search-trigger')`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#sidebar-chat-search-trigger').click()`);
  await waitFor(browserWindow, `document.querySelector('[data-session="${goalSession.id}"]')`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-session="${goalSession.id}"]').click()`);
  await waitFor(browserWindow, `document.querySelector('.goal-status-card') && document.querySelector('#chat-form')`);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 250))`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#close-chat-search-btn')?.click()`);
  await waitFor(browserWindow, `!document.querySelector('#chat-search-overlay')`);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 120))`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#close-chat-search-btn')?.click()`);
  await waitFor(browserWindow, `!document.querySelector('#chat-search-overlay')`);
  const goalSnapshot = await browserWindow.webContents.executeJavaScript(`(() => {
    const card=document.querySelector('.goal-status-card');const form=document.querySelector('#chat-form');
    const actions=[...card.querySelectorAll('[data-goal-action]')].map((item)=>item.dataset.goalAction);
    return {text:card?.textContent||'',aria:card?.getAttribute('aria-label')||'',height:card?.getBoundingClientRect().height||0,actions,expand:Boolean(card?.querySelector('[data-goal-expand]')),titleOverflow:getComputedStyle(card?.querySelector('.goal-status-copy strong')).textOverflow,above:Boolean(card?.compareDocumentPosition(form)&Node.DOCUMENT_POSITION_FOLLOWING),errors:window.__goalPlanSmoke.errors};
  })()`);
  assert.match(goalSnapshot.text, /\u8fdb\u884c\u4e2d\u7684\u76ee\u6807/);
  assert.match(goalSnapshot.text, /\u5df2\u7528 12K Token/);
  assert.doesNotMatch(goalSnapshot.text, /100K|Token \u9884\u7b97|\u5df2\u63a8\u8fdb 10 \u5206\u949f/);
  assert.ok(goalSnapshot.height <= 64, `collapsed Goal card is too tall: ${goalSnapshot.height}`);
  assert.deepEqual(goalSnapshot.actions, ['edit', 'pause', 'delete']);
  assert.equal(goalSnapshot.expand, true);
  assert.equal(goalSnapshot.titleOverflow, 'ellipsis');
  assert.equal(goalSnapshot.above, true, '\u76ee\u6807\u72b6\u6001\u5361\u5fc5\u987b\u4f4d\u4e8e\u8f93\u5165\u6846\u4e0a\u65b9');
  assert.deepEqual(goalSnapshot.errors, []);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-goal-expand]').click()`);
  await waitFor(browserWindow, `document.querySelector('.goal-status-details')`);
  const expandedGoalText = await browserWindow.webContents.executeJavaScript(`document.querySelector('.goal-status-details')?.innerText||''`);
  assert.match(expandedGoalText, /\u6b63\u5728\u63a8\u8fdb/);
  assert.match(expandedGoalText, /\u5df2\u63a8\u8fdb 10 \u5206\u949f/);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-goal-expand]').click();document.querySelector('[data-goal-action="pause"]').click()`);
  await waitFor(browserWindow, `window.__goalPlanSmoke.goalActions.some((item)=>item.action==='pause')`);
  await waitFor(browserWindow, `document.querySelector('[data-goal-action="resume"]')`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-goal-action="edit"]').click()`);
  await waitFor(browserWindow, `document.querySelector('[data-goal-editor-input]')`);
  await browserWindow.webContents.executeJavaScript(`(() => {const input=document.querySelector('[data-goal-editor-input]');input.value='\u7f16\u8f91\u540e\u7684\u7d27\u51d1\u76ee\u6807';document.querySelector('[data-goal-editor-form]').requestSubmit();})()`);
  await waitFor(browserWindow, `window.__goalPlanSmoke.goalActions.some((item)=>item.action==='edit'&&item.objective==='\u7f16\u8f91\u540e\u7684\u7d27\u51d1\u76ee\u6807')`);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await browserWindow.capturePage();
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 120))`);
  writeFileSync(goalScreenshotPath, (await browserWindow.capturePage()).toPNG());

  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-composer-tool-menu-toggle]').click()`);
  await waitFor(browserWindow, `document.querySelector('.composer-tool-menu')`);
  assert.equal(await browserWindow.webContents.executeJavaScript(`Boolean(document.querySelector('[data-goal-token-budget],.composer-goal-budget'))`), false);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-composer-tool-menu-toggle]').click();document.querySelector('[data-composer-interaction-indicator]').click()`);
  await waitFor(browserWindow, `window.__goalPlanSmoke.sessionUpdates.some((item)=>item.sessionId==='${goalSession.id}'&&item.interactionMode===''&&item.goal===null)`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-composer-tool-menu-toggle]').click()`);
  await waitFor(browserWindow, `document.querySelector('[data-composer-interaction-mode="goal"]')`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-composer-interaction-mode="goal"]').click()`);
  await waitFor(browserWindow, `window.__goalPlanSmoke.sessionUpdates.filter((item)=>item.sessionId==='${goalSession.id}'&&item.interactionMode==='goal'&&item.goal===null).length>=1`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-composer-tool-menu-toggle]').click()`);
  await waitFor(browserWindow, `document.querySelector('.composer-tool-menu')`);
  assert.equal(await browserWindow.webContents.executeJavaScript(`Boolean(document.querySelector('[data-goal-token-budget],.composer-goal-budget'))`), false);

  await browserWindow.webContents.executeJavaScript(`document.querySelector('#sidebar-chat-search-trigger').click()`);
  await waitFor(browserWindow, `document.querySelector('[data-session="${planSession.id}"]')`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-session="${planSession.id}"]').click()`);
  await waitFor(browserWindow, `document.querySelector('#chat-form') && document.querySelector('#message-list')?.innerText.includes('\u8ba1\u5212\u5df2\u6574\u7406\u5b8c\u6210')`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#close-chat-search-btn')?.click()`);
  await waitFor(browserWindow, `!document.querySelector('#chat-search-overlay')`);
  const planSnapshot = await browserWindow.webContents.executeJavaScript(`({
    answer:document.querySelector('#message-list')?.innerText||'',
    bubble:Boolean(document.querySelector('[data-chat-plan-toggle],[data-implement-chat-plan]')),
    planWorkCard:Boolean(document.querySelector('.composer-stack > .interaction-work-card.mode-plan,.composer-stack > .chat-plan-card.is-live')),
    errors:window.__goalPlanSmoke.errors,
  })`);
  assert.match(planSnapshot.answer, /\u8ba1\u5212\u5df2\u6574\u7406\u5b8c\u6210/);
  assert.equal(planSnapshot.bubble, false, 'completed Plan answers must not append an implementation bubble');
  assert.equal(planSnapshot.planWorkCard, false, 'Plan mode must not add a status card above the composer');
  assert.deepEqual(planSnapshot.errors, []);
  writeFileSync(planScreenshotPath, (await browserWindow.capturePage()).toPNG());
  await browserWindow.webContents.executeJavaScript(`(() => {const input=document.querySelector('#chat-input');input.value='请先制定代码修改计划';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#chat-form').requestSubmit();})()`);
  await waitFor(browserWindow, `window.__goalPlanSmoke.sendCalls.length===1`);

  await browserWindow.webContents.executeJavaScript(`window.__goalPlanSmoke.codexEvent({
    channelId:window.__goalPlanSmoke.sendCalls[0].channelId,
    event:{kind:'answer',content:Array.from({length:24},(_,index)=>'Planning context line '+(index+1)+': keep the conversation pinned while the Agent prepares a question.').join('\\n\\n'),streaming:true}
  })`);
  await waitFor(browserWindow, `document.querySelector('#message-list')?.scrollHeight>document.querySelector('#message-list')?.clientHeight`);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const planQuestionEvent = {
    kind: 'user-input-request', runId: 'inline-plan-run', requestId: 'inline-plan-choice', itemId: 'inline-plan-choice',
    questions: [
      { id: 'audience', header: 'Audience', question: 'Who should this plan serve?', isOther: true, options: [
        { label: 'Primary students', description: 'Focus on foundational learning.' },
        { label: 'Middle school students', description: 'Build practical project skills.' },
        { label: 'Teachers', description: 'Provide reusable teaching resources.' },
        { label: 'Parents', description: 'Support learning outside class.' },
      ] },
      { id: 'theme', header: 'Education theme', question: 'Which education theme should lead?', isOther: true, options: [
        { label: 'Integrated literacy', description: 'Combine science, reading, and arts.' },
        { label: 'Agricultural practice', description: 'Use hands-on rural projects.' },
        { label: 'Community culture', description: 'Build around local cultural assets.' },
        { label: 'Safety education', description: 'Prioritize health and safety.' },
      ] },
      { id: 'delivery', header: 'Delivery', question: 'What should the final delivery emphasize?', isOther: true, options: [
        { label: 'Course package', description: 'Produce ready-to-use lessons.' },
        { label: 'Growth archive', description: 'Track each learner over time.' },
        { label: 'Showcase event', description: 'Conclude with public results.' },
        { label: 'Teacher guide', description: 'Make future reuse straightforward.' },
      ] },
    ],
  };
  const planQuestionChannelId = await browserWindow.webContents.executeJavaScript(`window.__goalPlanSmoke.sendCalls[0].channelId`);
  const planQuestionPayload = JSON.stringify({ channelId: planQuestionChannelId, event: planQuestionEvent });
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#message-list').scrollTop=document.querySelector('#message-list').scrollHeight`);
  await browserWindow.webContents.executeJavaScript(`window.__goalPlanSmoke.codexEvent(JSON.parse(${JSON.stringify(planQuestionPayload)}))`);
  await waitFor(browserWindow, "document.querySelector('.chat-user-input-panel')");
  await browserWindow.webContents.executeJavaScript(`document.querySelector('.chat-user-input-panel').style.minHeight='520px'`);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const questionScrollState = await browserWindow.webContents.executeJavaScript(`(() => {
    const list=document.querySelector('#message-list');
    return {distanceFromBottom:Math.max(0,list.scrollHeight-list.clientHeight-list.scrollTop)};
  })()`);
  assert.ok(questionScrollState.distanceFromBottom <= 2,
    `the conversation must remain pinned to the bottom when the Plan question panel settles: ${questionScrollState.distanceFromBottom}px`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('.chat-user-input-panel').style.removeProperty('min-height')`);
  const inlineQuestionState = await browserWindow.webContents.executeJavaScript(`({
    externalCalls:window.__goalPlanSmoke.planQuestionWindowCalls.length,
    composerHidden:!document.querySelector('#chat-form'),
    overlayAbsent:!document.querySelector('.chat-user-input-overlay'),
    insideComposerStack:Boolean(document.querySelector('.composer-stack > .chat-user-input-panel')),
    skipVisible:Boolean(document.querySelector('[data-chat-user-input-skip]')),
    nextAbsent:!document.querySelector('[data-chat-user-input-next]'),
  })`);
  assert.deepEqual(inlineQuestionState, { externalCalls: 0, composerHidden: true, overlayAbsent: true, insideComposerStack: true, skipVisible: true, nextAbsent: true });
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#sidebar-chat-search-trigger').click()`);
  await waitFor(browserWindow, `document.querySelector('[data-session="${goalSession.id}"]')`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-session="${goalSession.id}"]').click()`);
  await waitFor(browserWindow, `!document.querySelector('.chat-user-input-panel') && document.querySelector('#chat-form')`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#close-chat-search-btn')?.click()`);
  await waitFor(browserWindow, `!document.querySelector('#chat-search-overlay')`);
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.querySelector('.chat-user-input-panel')?.innerText||''`), '',
    'a pending plan question must not leak into another conversation');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#sidebar-chat-search-trigger').click()`);
  await waitFor(browserWindow, `document.querySelector('[data-session="${planSession.id}"]')`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-session="${planSession.id}"]').click()`);
  await waitFor(browserWindow, `document.querySelector('.chat-user-input-panel')?.innerText.includes('Who should this plan serve?')`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#close-chat-search-btn')?.click()`);
  await waitFor(browserWindow, `!document.querySelector('#chat-search-overlay')`);
  let questionSnapshot = await browserWindow.webContents.executeJavaScript(`document.querySelector('.chat-user-input-panel')?.innerText||''`);
  assert.match(questionSnapshot, /Who should this plan serve/);
  assert.doesNotMatch(questionSnapshot, /Which education theme should lead/);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('.chat-user-input-option input[value="Primary students"]').click()`);
  await waitFor(browserWindow, `document.querySelector('.chat-user-input-panel')?.innerText.includes('Which education theme should lead?')`);
  questionSnapshot = await browserWindow.webContents.executeJavaScript(`document.querySelector('.chat-user-input-panel')?.innerText||''`);
  assert.doesNotMatch(questionSnapshot, /Who should this plan serve/);
  assert.doesNotMatch(questionSnapshot, /What should the final delivery emphasize/);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-chat-user-input-skip]').click()`);
  await waitFor(browserWindow, `document.querySelector('.chat-user-input-panel')?.innerText.includes('What should the final delivery emphasize?')`);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 120))`);
  writeFileSync(planChoiceScreenshotPath, (await browserWindow.capturePage()).toPNG());
  const imeOtherState = await browserWindow.webContents.executeJavaScript(`(() => {
    const input=document.querySelector('[data-user-input-other]');input.closest('label').querySelector('input[type="radio"]').click();input.focus();
    input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));
    input.value='zhongwen';input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'zhongwen',inputType:'insertCompositionText',isComposing:true}));
    input.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Enter',keyCode:229}));
    return {question:document.querySelector('.chat-user-input-panel')?.innerText||'',calls:window.__goalPlanSmoke.userInputResolutions.length,composing:input.dataset.imeComposing};
  })()`);
  assert.match(imeOtherState.question, /What should the final delivery emphasize/);
  assert.equal(imeOtherState.calls, 0);
  assert.equal(imeOtherState.composing, 'true');
  await browserWindow.webContents.executeJavaScript(`(() => {
    const input=document.querySelector('[data-user-input-other]');input.value='中文交付方案';
    input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文交付方案'}));
    input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'中文交付方案',inputType:'insertText'}));
    input.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Enter'}));
  })()`);
  await waitFor(browserWindow, `window.__goalPlanSmoke.userInputResolutions.length===1 && !document.querySelector('.chat-user-input-panel') && document.querySelector('#chat-form')`);
  const resolvedInput = await browserWindow.webContents.executeJavaScript(`window.__goalPlanSmoke.userInputResolutions[0]`);
  assert.deepEqual(resolvedInput.answers, {audience:{answers:['Primary students']},theme:{answers:[]},delivery:{answers:['中文交付方案']}});
  assert.deepEqual(resolvedInput.skippedQuestionIds, ['theme']);
  const executablePlanMessage = {
    ...planMessage,
    metadata: { ...planMessage.metadata, plan: { ...plan, executable: true, taskType: 'code_change' } },
  };
  const completedPlanChannelId = await browserWindow.webContents.executeJavaScript(`window.__goalPlanSmoke.sendCalls[0].channelId`);
  const completedPlanEventPayload = JSON.stringify({
    channelId: completedPlanChannelId,
    event: { kind: 'done', answer: planMessage.content, interactionMode: 'plan', plan: executablePlanMessage.metadata.plan },
  });
  const completedPlanResult = JSON.stringify({ session: planSession, message: executablePlanMessage, answer: planMessage.content });
  await browserWindow.webContents.executeJavaScript(`window.__goalPlanSmoke.codexEvent(JSON.parse(${JSON.stringify(completedPlanEventPayload)}))`);
  await browserWindow.webContents.executeJavaScript(`window.__goalPlanSmoke.sendResolvers[0](JSON.parse(${JSON.stringify(completedPlanResult)}))`);
  await waitFor(browserWindow, `document.querySelector('.chat-plan-execution-panel') && !document.querySelector('#chat-form')`);
  const executionPrompt = await browserWindow.webContents.executeJavaScript(`(() => ({
    text:document.querySelector('.chat-plan-execution-panel')?.innerText||'',
    options:document.querySelectorAll('[data-chat-plan-execution]').length,
    bubble:Boolean(document.querySelector('[data-chat-plan-toggle],[data-implement-chat-plan]')),
  }))()`);
  assert.match(executionPrompt.text, /执行此计划/);
  assert.match(executionPrompt.text, /暂时不执行/);
  assert.match(executionPrompt.text, /否，且告诉 Janus 如何做得不同/);
  assert.equal(executionPrompt.options, 3);
  assert.equal(executionPrompt.bubble, false);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 120))`);
  writeFileSync(planExecutionScreenshotPath, (await browserWindow.capturePage()).toPNG());
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-chat-plan-execution="revise"]').click()`);
  await waitFor(browserWindow, `document.querySelector('[data-chat-plan-revision-input]')`);
  await browserWindow.webContents.executeJavaScript(`(() => {const input=document.querySelector('[data-chat-plan-revision-input]');input.value='保留第 1 步，并增加回滚检查';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-chat-plan-revision-submit]').click();})()`);
  await waitFor(browserWindow, `window.__goalPlanSmoke.sendCalls.length===2`);
  const revision = await browserWindow.webContents.executeJavaScript(`window.__goalPlanSmoke.sendCalls[1]`);
  assert.equal(revision.interactionMode, 'plan');
  assert.match(revision.message, /保留第 1 步，并增加回滚检查/);
  const revisedPlanMessage = {
    ...executablePlanMessage,
    id: 'revised_plan_ui_message',
    content: '修订后的计划：保留第 1 步，并增加回滚检查。',
    metadata: { ...executablePlanMessage.metadata, plan: { ...executablePlanMessage.metadata.plan, content: '修订后的计划：保留第 1 步，并增加回滚检查。' } },
  };
  const revisedResult = JSON.stringify({ session: planSession, message: revisedPlanMessage, answer: revisedPlanMessage.content });
  const revisedChannelId = await browserWindow.webContents.executeJavaScript(`window.__goalPlanSmoke.sendCalls[1].channelId`);
  await browserWindow.webContents.executeJavaScript(`window.__goalPlanSmoke.codexEvent(JSON.parse(${JSON.stringify(JSON.stringify({ channelId: revisedChannelId, event: { kind: 'done', answer: revisedPlanMessage.content, interactionMode: 'plan', plan: revisedPlanMessage.metadata.plan } }))}))`);
  await browserWindow.webContents.executeJavaScript(`window.__goalPlanSmoke.sendResolvers[1](JSON.parse(${JSON.stringify(revisedResult)}))`);
  await waitFor(browserWindow, `document.querySelector('.chat-plan-execution-panel') && document.querySelectorAll('[data-chat-plan-execution]').length===3`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-chat-plan-execution="execute"]').click()`);
  await waitFor(browserWindow, `window.__goalPlanSmoke.sendCalls.length===3`);
  const implementation = await browserWindow.webContents.executeJavaScript(`window.__goalPlanSmoke.sendCalls[2]`);
  assert.equal(implementation.interactionMode, '');
  assert.match(implementation.message, /\u8bf7\u6309\u7167\u4e0b\u9762\u5df2\u7ecf\u786e\u8ba4\u7684\u8ba1\u5212\u5f00\u59cb\u5b9e\u65bd/);
  process.stdout.write(`Renderer goal/plan UI smoke passed.\nGoal screenshot: ${goalScreenshotPath}\nPlan screenshot: ${planScreenshotPath}\n`);
} catch (error) {
  await captureElectronFailureDiagnostics({ browserWindow, error, name: 'renderer-goal-plan', stateExpression: 'window.__goalPlanSmoke?.errors || []' });
  throw error;
} finally {
  if (browserWindow && !browserWindow.isDestroyed()) browserWindow.destroy();
  rmSync(tempRoot, { recursive: true, force: true });
}

async function waitFor(window, expression, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const snapshot = await window.webContents.executeJavaScript(`({text:document.body?.innerText?.slice(0,2400)||'',errors:window.__goalPlanSmoke?.errors||[]})`).catch(() => ({}));
  throw new Error(`Timed out waiting for: ${expression}\n${JSON.stringify(snapshot)}`);
}
