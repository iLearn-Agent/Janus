import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installLocalizedNativeDialogs, translateUiText } from '../src/renderer/app/i18n.js';
import { roleLabel, state as moduleState } from '../src/renderer/app/state.js';

assert.equal(translateUiText('创建者', 'en'), 'Owner');
assert.equal(translateUiText('管理员', 'en'), 'Administrator');
assert.equal(translateUiText('成员', 'en'), 'Member');
assert.equal(translateUiText('组织内联系人', 'en'), 'Members');
assert.equal(translateUiText('外部联系人', 'en'), 'External');
assert.equal(translateUiText('新的联系人', 'en'), 'Requests');
assert.equal(translateUiText('星标联系人', 'en'), 'Starred');
assert.equal(translateUiText('联系人群聊', 'en'), 'Chats');
assert.equal(translateUiText('创建群聊', 'en'), 'New Group');
assert.equal(translateUiText('通用问答与分析', 'en'), 'General Q&A & Analysis');
assert.equal(translateUiText('已招募 2 名 · 可继续招募', 'en'), '2 hired · Can hire more');
assert.equal(translateUiText('已招募 2 名 · 当前额度已满', 'en'), '2 hired · Limit reached');
assert.equal(translateUiText('格式化 JSON', 'en'), 'Format JSON');
assert.equal(translateUiText('重新读取', 'en'), 'Reload');
assert.equal(translateUiText('15 秒后重发', 'en'), 'Resend in 15s');
assert.equal(translateUiText('3 条新进展 ↓', 'en'), '3 new updates ↓');
assert.equal(translateUiText('1 条申请等待验证', 'en'), '1 request awaiting verification');
assert.equal(translateUiText('2 条申请等待验证', 'en'), '2 requests awaiting verification');
assert.equal(translateUiText('1 条申请等待处理', 'en'), '1 request awaiting review');
assert.equal(translateUiText('对话缩放 125% · Ctrl/⌘+0 重置', 'en'), 'Conversation zoom 125% · Ctrl/⌘+0 to reset');
assert.equal(translateUiText('正在下载最新软件，进度 42%；下载期间仍可继续使用。', 'en'), 'Downloading the latest update · 42%. You can keep using Janus during the download.');
assert.equal(translateUiText('使用头像', 'en'), 'Use Avatar');
assert.equal(translateUiText('正在重新生成…', 'en'), 'Regenerating…');
assert.equal(translateUiText('任务未完成', 'en'), 'Task Not Completed');
assert.equal(translateUiText('查看失败原因', 'en'), 'View Failure Details');
assert.equal(translateUiText('运行时长', 'en'), 'Runtime');
assert.equal(translateUiText('发送时间', 'en'), 'Sent At');
assert.equal(translateUiText('完成文件', 'en'), 'Completed Files');
assert.equal(
  translateUiText('打开任务可查看最后一次报错和失败节点。', 'en'),
  'Open the task to view the latest error and failed node.',
);
assert.equal(translateUiText('模型服务响应较慢，继续等待（2/5）', 'en'), 'The model service is responding slowly; continuing to wait (2/5)');
assert.equal(
  translateUiText('上游模型服务尚未返回输出；已等待约 120 秒，Janus 将保留当前请求并继续等待模型运行时恢复连接。', 'en'),
  'The upstream model service has not returned output. Janus has waited about 120 seconds and will keep the current request open while the model runtime reconnects.',
);
assert.equal(
  translateUiText('执行失败：JanusUnavailable: Janus 已连接本地模型运行时，但上游模型服务在连续 5 个等待周期内（每次 60 秒，累计约 300 秒）始终未返回任何模型输出。当前请求已停止；请检查网络或代理连接、API 配额以及模型服务状态后重试。', 'en'),
  'Execution failed: JanusUnavailable: Janus connected to the local model runtime, but the upstream model service returned no output across 5 consecutive wait periods (60 seconds each, about 300 seconds total). The current request has been stopped. Check the network or proxy connection, API quota, and model service status, then try again.',
);
assert.equal(translateUiText('推理', 'en'), 'Reasoning');
assert.equal(translateUiText('模型', 'en'), 'Models');
assert.equal(translateUiText('1 个活跃 · 0 个归档', 'en'), '1 active · 0 archived');
assert.equal(translateUiText('所选：Primary Memory · 活跃上下文 · 2 条消息', 'en'), 'Selected: Primary Memory · Active Context · 2 messages');
assert.equal(translateUiText('上下文边界：epoch 1', 'en'), 'Context boundary: epoch 1');
assert.equal(translateUiText('下一等级 L2', 'en'), 'Next Level L2');
assert.equal(translateUiText('拆解 88', 'en'), 'Decomposition 88');
assert.equal(translateUiText('Janus 下次启动时自动进入', 'en'), 'Open automatically the next time Janus starts');
assert.equal(translateUiText('设该组织为默认工作空间', 'en'), 'Set This Organization as the Default Workspace');
assert.equal(translateUiText('最近使用', 'en'), 'Recently Used');
assert.equal(translateUiText('更多工作空间', 'en'), 'More Workspaces');
assert.equal(translateUiText('其他工作空间', 'en'), 'Other Workspaces');
assert.equal(translateUiText('工作群已归档。', 'en'), 'Work group archived.');
assert.equal(translateUiText('已停止 2 项任务并归档工作群。', 'en'), 'Stopped 2 tasks and archived the work group.');
assert.equal(translateUiText('默认组织已设为 Test Group。', 'en'), 'Default organization set to Test Group.');
assert.equal(translateUiText('当前账号已经加入组织“Test Group”。', 'en'), 'This account has already joined organization “Test Group”.');
assert.equal(translateUiText('最近使用的组织', 'en'), 'Recently Used Organizations');
assert.equal(translateUiText('更多组织', 'en'), 'More Organizations');
assert.equal(translateUiText('其他组织', 'en'), 'Other Organizations');
assert.equal(translateUiText('组织消息调查', 'en'), 'Org Research');
assert.equal(translateUiText('诊断与日志', 'en'), 'Diagnostics');
assert.equal(translateUiText('加入后立即切换，并在下次启动时默认进入', 'en'), 'Switch immediately after joining and open it by default the next time Janus starts.');
assert.equal(translateUiText('组织已加入，但保存默认工作空间失败。', 'en'), 'The organization was joined, but the default workspace could not be saved.');
assert.equal(translateUiText('保存默认组织失败。', 'en'), 'Could not save the default organization.');
assert.equal(translateUiText('组织“Acme”已创建，可从组织详情或左下角切换。', 'en'), 'Organization “Acme” was created. Switch to it from Organization Details or the lower-left workspace menu.');
assert.equal(translateUiText('组织“Acme”已创建，但工作空间列表刷新失败，请稍后重试。', 'en'), 'Organization “Acme” was created, but the workspace list could not be refreshed. Try again later.');
assert.equal(translateUiText('已加入并切换到组织“Acme”，已设为默认工作空间。', 'en'), 'Joined and switched to organization “Acme” and set it as the default workspace.');
assert.equal(translateUiText('已加入并切换到组织“Acme”。', 'en'), 'Joined and switched to organization “Acme”.');
assert.equal(translateUiText('已加入组织“Acme”，但未能自动切换工作空间。', 'en'), 'Joined organization “Acme”, but could not switch to its workspace automatically.');
assert.equal(translateUiText('方式一', 'en'), 'Method 1');
assert.equal(translateUiText('方式二', 'en'), 'Method 2');
assert.equal(translateUiText('或者', 'en'), 'or');
assert.equal(translateUiText('分享链接', 'en'), 'Share Link');
assert.equal(translateUiText('链接管理', 'en'), 'Link Management');
assert.equal(translateUiText('前往安装', 'en'), 'Install Skill');
assert.equal(translateUiText('安装 Skill', 'en'), 'Install Skill');
assert.equal(translateUiText('Skill 暂不可安装', 'en'), 'Skill Currently Unavailable');
assert.equal(translateUiText('查看 Skill', 'en'), 'View Skill');
assert.equal(translateUiText('必须先安装该 Skill，安装完成后才可招募此 Agent。', 'en'), 'Install this Skill before hiring the Agent.');
assert.equal(translateUiText('需先安装 PPT 制作技能，安装后才可招募', 'en'), 'Install PPT Creation Skill before hiring');
assert.equal(translateUiText('安装 PPT 制作 Skill', 'en'), 'Install PPT Creation Skill');
assert.equal(translateUiText('Skill 已安装，重新调度 Agent', 'en'), 'Skill Installed, Dispatch Again');
assert.equal(translateUiText('正在刷新 Skill 状态…', 'en'), 'Refreshing Skill Status…');
assert.equal(translateUiText('Skill 已安装，正在刷新招募状态', 'en'), 'Skill installed · Refreshing hiring status');
assert.equal(translateUiText('状态同步中…', 'en'), 'Syncing Status…');
assert.equal(translateUiText('同步中', 'en'), 'Syncing');
assert.equal(translateUiText('状态未知', 'en'), 'Unknown');
assert.equal(translateUiText('在线', 'en'), 'Online');
assert.equal(translateUiText('离线', 'en'), 'Offline');
assert.equal(translateUiText('暂不可招募', 'en'), 'Hiring Unavailable');
assert.equal(translateUiText('登录后招募', 'en'), 'Sign In to Hire');
assert.equal(translateUiText('招募服务同步中…', 'en'), 'Syncing Hiring Service…');
assert.equal(
  translateUiText('请先在本机安装该 Agent 所需的 Skill，安装完成后再招募。', 'en'),
  'Install the required Skill on this device before hiring the Agent.',
);
assert.equal(translateUiText('打个招呼', 'en'), 'Say Hello');
assert.equal(translateUiText('选填，最多 200 字', 'en'), 'Optional, up to 200 characters');
assert.equal(translateUiText('申请添加 Alice', 'en'), 'Add Alice as a Contact');
assert.equal(translateUiText('申请好友', 'en'), 'Send Request');
assert.equal(translateUiText('今日额度 8%', 'en'), 'Today’s Allowance 8%');
assert.equal(translateUiText('今日 Token 额度 8%', 'en'), 'Today’s Token Allowance 8%');
assert.equal(translateUiText('默认模型服务', 'en'), 'Default Model Service');
assert.equal(translateUiText('当前使用 Janus 默认模型服务，Token 用量受软件额度限制。', 'en'), 'The Janus default model service is active and subject to Janus token limits.');
assert.equal(translateUiText('当前使用已通过连接测试的自定义 Provider，不受 Janus Token 限额。', 'en'), 'The validated custom Provider is active and is not subject to Janus token limits.');
assert.equal(translateUiText('如需使用自己的模型服务，请在下方填写 config.toml 和 auth.json；保存并测试通过后生效。自定义 Provider 不受 Janus Token 限额。', 'en'), 'To use your own model service, enter config.toml and auth.json below. The custom Provider takes effect after the files are saved and pass the connection test, and is not subject to Janus token limits.');
assert.equal(translateUiText('AI 自动审查', 'en'), 'AI Review');
assert.equal(translateUiText('完全开放', 'en'), 'Full Access');
assert.equal(translateUiText('今日 41,312 / 500,000 tokens', 'en'), 'Today 41,312 / 500,000 tokens');
assert.equal(translateUiText('剩余 458,688 tokens', 'en'), '458,688 tokens remaining');
assert.equal(translateUiText('458,688 tokens 可用 · 北京时间 00:00 重置', 'en'), '458,688 tokens Available · Resets at 00:00 Beijing Time');
assert.equal(translateUiText('输入 100 tokens（缓存命中 20 tokens） · 输出 50 tokens', 'en'), 'Input 100 tokens (cached 20 tokens) · Output 50 tokens');
assert.equal(translateUiText('2 次 · 等价 Token', 'en'), '2 images · Token equivalent');
assert.equal(translateUiText('今日图片生成用量', 'en'), 'Today’s Image Generation Usage');
assert.equal(translateUiText('当前使用自定义图片服务，仅按当前 Provider 记录用量，不设 Janus 每日额度。', 'en'), 'A custom image service is active. Usage is tracked for the current Provider only, with no Janus daily limit.');
assert.equal(translateUiText('北京时间每日 00:00 恢复；输入与输出 Token 按每轮实际 usage 累加。', 'en'), 'Resets daily at 00:00 Beijing time. Input and output tokens are counted from each turn’s actual usage.');
assert.equal(translateUiText('检测规则', 'en'), 'Detection Rules');
assert.equal(translateUiText('空同步 / 长期无有效上传', 'en'), 'Empty Sync / Prolonged Upload Inactivity');
assert.equal(translateUiText('Janus 将继续运行并保留在通知区域', 'en'), 'Janus will keep running in the notification area.');
assert.equal(translateUiText('Janus 将继续运行并保留在菜单栏', 'en'), 'Janus will keep running in the menu bar.');
assert.equal(translateUiText('Janus 将继续运行并保留在系统托盘', 'en'), 'Janus will keep running in the system tray.');
assert.equal(translateUiText('Janus 将继续运行，可从 Dock 重新打开', 'en'), 'Janus will keep running and can be reopened from the Dock.');
assert.equal(translateUiText('后台运行当前不可用，关闭最后一个窗口时 Janus 将退出', 'en'), 'Background mode is currently unavailable. Janus will quit when its last window is closed.');
assert.equal(translateUiText('通知区域图标不可用：indicator unavailable', 'en'), 'Notification area icon unavailable: indicator unavailable');
assert.equal(translateUiText('菜单栏图标不可用：indicator unavailable', 'en'), 'Menu bar icon unavailable: indicator unavailable');
assert.equal(translateUiText('系统托盘不可用：indicator unavailable', 'en'), 'System tray unavailable: indicator unavailable');
assert.equal(
  translateUiText('安装更新需要关闭并重启 Janus。是否现在安装？', 'en'),
  'Installing the update will close and restart Janus. Install now?',
);
assert.equal(
  translateUiText('确认归档项目“Roadmap”？这个项目下的所有对话都会一起归档。', 'en'),
  'Archive project “Roadmap”? All conversations in this project will be archived with it.',
);
const nativeDialogCalls = [];
const nativeDialogWindow = {
  confirm: (message) => { nativeDialogCalls.push(['confirm', message]); return true; },
  alert: (message) => { nativeDialogCalls.push(['alert', message]); },
  prompt: (message, defaultValue) => { nativeDialogCalls.push(['prompt', message, defaultValue]); return defaultValue; },
};
let nativeDialogLanguage = 'en';
const restoreNativeDialogs = installLocalizedNativeDialogs(nativeDialogWindow, () => nativeDialogLanguage);
assert.equal(nativeDialogWindow.confirm('安装更新需要关闭并重启 Janus。是否现在安装？'), true);
assert.equal(nativeDialogWindow.prompt('修改群聊名称', '用户填写的名称'), '用户填写的名称');
nativeDialogLanguage = 'zh-CN';
nativeDialogWindow.alert('确定删除这个好友吗？');
assert.deepEqual(nativeDialogCalls, [
  ['confirm', 'Installing the update will close and restart Janus. Install now?'],
  ['prompt', 'Rename Group Chat', '用户填写的名称'],
  ['alert', '确定删除这个好友吗？'],
]);
restoreNativeDialogs();
moduleState.languageMode = 'en';
assert.equal(roleLabel('member'), 'Member');
assert.equal(roleLabel('admin'), 'Administrator');

const { app, BrowserWindow } = globalThis.__janusElectron;
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-renderer-language-'));
app.setPath('userData', path.join(tempRoot, 'user-data'));
const htmlPath = path.join(tempRoot, 'renderer-language-smoke.html');
const rendererEntry = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app.js')).href;
const rendererStyle = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'style.css')).href;
const rendererStateEntry = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app', 'state.js')).href;
const rendererFormatEntry = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app', 'utils', 'format.js')).href;
const rendererI18nEntry = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app', 'i18n.js')).href;
const rendererTranscriptEntry = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app', 'views', 'codexTranscriptView.js')).href;
const screenshotDir = String(process.env.JANUS_LANGUAGE_SCREENSHOT_DIR || '').trim();
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });

const bootstrap = {
  appVersion: 'language-smoke', root: tempRoot, workspaceRoot: tempRoot,
  desktopLifecycle: { closeBehavior: 'background', defaultCloseBehavior: 'quit', platform: 'win32', traySupported: true, trayActive: true, backgroundAvailable: true, lastError: '' },
  org: {
    departments: [{ id: 'general', name: 'General' }, { id: 'ppt_department', name: '演示设计' }],
    agents: [
      { id: 'general_agent', name: 'Generalist A', departmentId: 'general', routable: true },
      { id: 'ppt', name: 'PPT Designer', departmentId: 'ppt_department', routable: true },
    ],
    hrs: [],
  },
  sessions: [{ id: 'ppt-session', title: 'PPT Agent A', agentId: 'ppt', agentInstanceId: 'ppt-agent-a', departmentId: 'ppt_department', status: 'active', updatedAt: '2026-08-07T01:00:00.000Z' }], projects: [], tasks: [], agentStatuses: [], evolution: null,
  currentUser: { id: 'language_user', displayName: 'Language User', role: 'member', permissions: {} },
  accountWorkspaces: [
    { id: 'workspace_personal', kind: 'personal', name: 'Personal', role: 'owner' },
    ...[1, 2, 3, 4, 5].map((index) => ({ id: `workspace_org_language_${index}`, kind: 'organization', organizationId: `organization_language_${index}`, name: `Language Org ${index}`, role: 'member' })),
  ],
  activeAccountWorkspace: { id: 'workspace_personal', kind: 'personal', name: 'Personal', role: 'owner' },
  startupAccountWorkspace: { id: 'workspace_personal', kind: 'personal', name: 'Personal', role: 'owner' },
  adminUsers: [], friendOverview: { friends: [{ friend: { id: 'sijie-liu', displayName: '刘思杰', username: 'sijie' } }], requests: { incoming: [], outgoing: [] } },
  socialInbox: [], agentDelegations: [], collaboration: { groups: [], tasks: [] },
  chatGroups: { groups: [], capability: 'chat-groups-v2' }, socialStatus: { enabled: true, connected: true },
  codexConfig: {}, codexConfigFiles: null, cloudSync: null, userAgentSettings: [],
  managedProviderUsage: {
    managedProvider: true,
    dailyTokensUsed: 41312,
    dailyTokenLimit: 500000,
    dailyTokensRemaining: 458688,
    usagePercent: 8,
    exhausted: false,
    dailyImageLimit: 5,
    dailyImagesUsed: 2,
    dailyImagesRemaining: 3,
    imageGenerationExhausted: false,
    lastTurnTokens: 150,
    lastTurnInputTokens: 100,
    lastTurnCachedInputTokens: 20,
    lastTurnOutputTokens: 50,
  },
  employees: {
    roster: [{
      id: 'ppt-agent-a', agentFamilyId: 'ppt', familyInstanceSeq: 1, displayName: 'PPT Agent A', note: 'User notes remain unchanged',
      routeEligible: true, employmentState: 'active', currentMemory: { id: 'memory-active', displayName: 'Primary Memory' },
      family: { name: 'PPT Designer', departmentId: 'ppt_department' },
      performance: { level: 'P2', score: 82, quality: 85, reliability: 80, firstPass: 78, efficiency: 84, collaborationSafety: 92, completedTaskCount: 18, terminalAttemptCount: 20, contributionWeight: 0.75, peerBaselineKind: 'family', windowStartedAt: '2026-05-01T00:00:00.000Z', windowEndedAt: '2026-08-01T00:00:00.000Z' },
      leadership: { level: 'L1', score: 76, status: 'active', nextLevel: 'L2', reviewState: 'stable', leadershipTaskCount: 12, crossDepartmentTaskCount: 3, teamLeadTrialCount: 2, crossTeamTrialCount: 1, metrics: { deliveryQuality: 82, decompositionMatching: 79, reviewReworkControl: 75, dependencyCoordination: 77, teamEfficiencyUplift: 72, safety: 95 }, promotion: { ready: false, reasons: ['team_lead_trials_insufficient', 'cross_team_trials_insufficient'] } },
    }],
    recruitableFamilies: [
      { id: 'ppt', agentFamilyId: 'ppt', name: 'PPT Designer', departmentId: 'ppt_department', metadata: { description: '将内容整理为清晰、可编辑的演示文稿。', skillTags: ['通用PPT', '重大项目风'] } },
      { id: 'general_agent', agentFamilyId: 'general_agent', name: 'Generalist', departmentId: 'general', canRecruit: true, activeInstanceCount: 2, metadata: { description: '系统通用回退执行 Agent；当没有更合适的专业 Agent 时，由 Generalist 按 Janus 默认执行工作流完成任务并验证结果。', capabilityTags: ['通用问答与分析', '文件和代码任务处理'] } },
    ],
    quota: { used: 1, limit: 10 }, capabilities: { multiMemory: { enabled: true, readOnly: false } },
  },
  uBuddyFeatureFlags: { profilePreviewV1: true, profileHistory: true },
  modelCatalog: { models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 SOL', supportedReasoningEfforts: ['medium'], defaultReasoningEffort: 'medium' }] },
  personalEvolutionStatus: null, personalEvolutionProposals: [], stage8EvolutionStatus: null,
  clusterEvolutionOverview: { cohorts: [], runs: [], candidates: [] }, privateAssistant: null, plugins: [], pptxPluginStatus: { installed: true, available: true },
};

writeFileSync(htmlPath, `<!doctype html><html lang="en" data-default-language="en"><head><meta charset="UTF-8"><link rel="stylesheet" href="${rendererStyle}"></head><body><div id="app"></div><script>
window.__languageSmoke={errors:[],agentAvailabilityListener:null,workspaceSwitchCalls:[]};
window.addEventListener('error',(event)=>window.__languageSmoke.errors.push(String(event.error?.stack||event.message||event.error)));
window.addEventListener('unhandledrejection',(event)=>window.__languageSmoke.errors.push(String(event.reason?.stack||event.reason)));
const fixtureBootstrap=location.hash.includes('auth=1')?{...${JSON.stringify(bootstrap)},currentUser:null,accountWorkspaces:[],activeAccountWorkspace:null,startupAccountWorkspace:null}:${JSON.stringify(bootstrap)};
const base={
 bootstrap:async()=>fixtureBootstrap,listSessions:async()=>fixtureBootstrap.sessions||[],listMessages:async()=>[],listMessagePage:async()=>({items:[],nextCursor:null,hasMore:false}),
 switchAccountWorkspace:({workspaceId})=>new Promise((resolve)=>{const activeWorkspace=fixtureBootstrap.accountWorkspaces.find((item)=>item.id===workspaceId);window.__languageSmoke.workspaceSwitchCalls.push(workspaceId);setTimeout(()=>resolve({activeWorkspace,bootstrap:{...fixtureBootstrap,activeAccountWorkspace:activeWorkspace}}),250);}),
  employeeOverview:async()=>(${JSON.stringify(bootstrap.employees)}),updateStatus:async()=>({enabled:false}),agentUpdateStatus:async()=>({enabled:false}),
 employeeMemoryDocuments:async()=>[
   {id:'memory-active',scope:'general',lifecycleState:'active',displayName:'Primary Memory',summary:'Current working context',messageCount:2,fileCount:1,lastUsedAt:'2026-08-07T03:00:00.000Z'},
   {id:'memory-archived',scope:'general',lifecycleState:'archived',displayName:'Archived Memory',summary:'Previous project context',messageCount:1,fileCount:0,lastUsedAt:'2026-08-06T03:00:00.000Z'},
 ],
 employeeContextSpaces:async()=>({account:{stateRevision:1},items:[]}),
 employeeMemoryDetails:async({memoryDocumentId})=>({document:{id:memoryDocumentId,scope:'general',lifecycleState:memoryDocumentId==='memory-archived'?'archived':'active',displayName:memoryDocumentId==='memory-archived'?'Archived Memory':'Primary Memory',messageCount:2},messages:[{role:'assistant',content:'Model response remains unchanged.',createdAt:'2026-08-07T03:00:00.000Z'}],attachments:[],contextStates:[{contextEpoch:1}]}),
 employeeLeadershipHistory:async()=>({items:[{level:'L1',score:76,status:'active',windowEndedAt:'2026-08-01T00:00:00.000Z',leadershipTaskCount:12,metrics:{deliveryQuality:82,decompositionMatching:79,reviewReworkControl:75,dependencyCoordination:77,teamEfficiencyUplift:72,safety:95}}]}),
 marketVersions:async()=>({agentFamilyId:'ppt',items:[],effectiveSkill:{marketVersionId:'',fullMarketVersionId:'',effectiveSkill:'Active skill content'}}),
 personalEvolutionVersions:async()=>({items:[]}),
  onAgentAvailabilityChanged:(listener)=>{window.__languageSmoke.agentAvailabilityListener=listener;return()=>{if(window.__languageSmoke.agentAvailabilityListener===listener)window.__languageSmoke.agentAvailabilityListener=null;}},
 pptxPluginStatus:async()=>({installed:true,available:true}),applicationLoggingStatus:async()=>({enabled:true,directory:'',fileCount:0,totalBytes:0}),loggingStatus:async()=>({enabled:true,level:'info',retentionDays:14,fileCount:2,totalBytes:2048,lastWriteAt:'2026-08-07T01:00:00.000Z',droppedCount:0}),
 uBuddyCapabilityProfilePreview:async()=>({enabled:true,source:'generated',profile:{introduction:'我的 uBuddy 是专业私人秘书与任务协调入口，擅长上下文意图理解、直接问答与轻量分析以及任务澄清与需求整理，并遵守确认、隐私与真实状态边界。',supportedTaskTypes:['上下文意图理解','直接问答与轻量分析','任务澄清与需求整理'],deliverableTypes:['answer','report','presentation'],capabilityTags:['需求整理','意图理解','分析与问答'],preferredTasks:['把口头需求整理为目标、约束、交付物和验收要点。','结合当前上下文理解指代、版本和真实操作意图。'],unsupportedTasks:['未经所有者明确确认的对外发布、正式承诺或结果提交。','要求披露私有对话、Memory、凭据、未发布材料或无关本地信息的任务。'],improvementDirections:['减少不必要澄清，同时保持关键约束完整。','提升复杂任务路由和执行者匹配的一致性。'],collaborationModes:['uBuddy 直接处理','转交单个 specialist Agent','协调多 Agent 任务'],privacyConstraints:['简介仅根据当前有效 Skill 生成，不读取私有 Memory、私聊或附件内容。','对外发布、正式承诺和共享结果前需要所有者明确确认。'],evidenceSummary:'当前有效 Skill 可验证地覆盖上下文意图理解、直接问答与轻量分析以及任务澄清与需求整理；同时规定uBuddy 直接处理、转交单个 specialist Agent以及协调多 Agent 任务，并要求保护私有信息、核验结果状态和避免未经确认的对外承诺。',version:'v1',sourceEffectiveSkillHash:'abcdef1234567890',generatedAt:'2026-08-07T01:00:00.000Z'}}),
 uBuddyCapabilityProfileHistory:async()=>({profiles:[],preference:{enabled:false,visibility:'friends'}}),
 socialConversationSummaries:async()=>({threads:[{friend:{id:'sijie-liu',displayName:'刘思杰',username:'sijie'},messages:[{id:'hello-sijie',senderUserId:'sijie-liu',recipientUserId:'language_user',content:'This user message stays unchanged.',status:'sent',updatedAt:'2026-08-07T02:00:00.000Z'}]}]}),
 socialConversation:async()=>[{id:'hello-sijie',senderUserId:'sijie-liu',recipientUserId:'language_user',content:'This user message stays unchanged.',status:'sent',updatedAt:'2026-08-07T02:00:00.000Z'}],
};
window.janus=new Proxy(base,{get(target,key){if(key in target)return target[key];if(String(key).startsWith('on'))return()=>()=>{};return async()=>null;}});
</script><script type="module">import {state} from '${rendererStateEntry}';window.__languageState=state;state.socialThreads=[{friend:{id:'sijie-liu',displayName:'刘思杰',username:'sijie'},messages:[{id:'hello-sijie',senderUserId:'sijie-liu',recipientUserId:'language_user',content:'This user message stays unchanged.',status:'sent',updatedAt:'2026-08-07T02:00:00.000Z'}]}];</script><script type="module" src="${rendererEntry}"></script></body></html>`);

function waitFor(browserWindow, expression, message, timeout = 10_000) {
  return browserWindow.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const end=Date.now()+${timeout};const tick=()=>{try{if(${expression})return resolve(true);}catch{}if(Date.now()>end)return reject(new Error(${JSON.stringify(message)}));setTimeout(tick,25);};tick();})`);
}

function visibleChinese(browserWindow, rootSelector, { exclude = '' } = {}) {
  return browserWindow.webContents.executeJavaScript(`(()=>{
    const root=document.querySelector(${JSON.stringify(rootSelector)});if(!root)return['missing:${rootSelector}'];
    const selector='button,h1,h2,h3,label,small,p,strong,span,input[placeholder],[title],[aria-label]';
    const values=[];
    for(const item of root.querySelectorAll(selector)){
      if(item.offsetParent===null||item.closest('[data-no-localize]')${exclude ? `||item.closest(${JSON.stringify(exclude)})` : ''})continue;
      for(const text of [...item.childNodes].filter((node)=>node.nodeType===Node.TEXT_NODE).map((node)=>node.nodeValue.trim()).filter(Boolean))values.push(text);
      for(const attribute of ['placeholder','title','aria-label']){const value=item.getAttribute(attribute);if(value)values.push(value.trim());}
    }
    return [...new Set(values.filter((text)=>/[\\u3400-\\u9fff]/.test(text)))].slice(0,120);
  })()`);
}

async function assertEnglishSurface(browserWindow, label, rootSelector = 'body') {
  const untranslated = await visibleChinese(browserWindow, rootSelector, { exclude: '[data-language-choice="zh-CN"]' });
  assert.deepEqual(untranslated, [], `untranslated ${label}: ${JSON.stringify(untranslated)}`);
}

let browserWindow;
let authWindow;
try {
  await app.whenReady();
  browserWindow = new BrowserWindow({ show: false, width: 1180, height: 780, webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false } });
  await browserWindow.loadFile(htmlPath);
  await waitFor(browserWindow, `document.querySelector('#language-toggle-btn')?.textContent.trim()==='EN'`, 'English did not load by default');
  const initial = await browserWindow.webContents.executeJavaScript(`({
    language:document.documentElement.lang,
    stored:localStorage.getItem('janus-language-mode'),
    messages:[...document.querySelectorAll('button')].some((item)=>item.textContent.trim()==='Messages'),
    untranslated:[...document.querySelectorAll('button, nav, h1, h2, h3, label, input[placeholder]')]
      .filter((item)=>item.offsetParent!==null && !item.closest('[data-no-localize]'))
      .map((item)=>item.getAttribute('placeholder')||item.textContent.trim()).filter((text)=>/[\\u3400-\\u9fff]/.test(text)).slice(0,30),
    errors:window.__languageSmoke.errors,
  })`);
  assert.equal(initial.language, 'en');
  assert.equal(initial.stored, null);
  assert.equal(initial.messages, true);
  assert.deepEqual(initial.untranslated, [], `untranslated primary controls: ${JSON.stringify(initial.untranslated)}`);
  assert.deepEqual(initial.errors, []);
  const codeCopyControl = await browserWindow.webContents.executeJavaScript(`Promise.all([
    import(${JSON.stringify(rendererFormatEntry)}),import(${JSON.stringify(rendererI18nEntry)})
  ]).then(([format,i18n])=>{const fence=String.fromCharCode(96).repeat(3);const root=document.createElement('div');root.innerHTML=format.renderMarkdown([fence+'js','const answer = 42;',fence].join('\\n'));document.body.append(root);i18n.localizeDom(root,'en');const button=root.querySelector('[data-copy-code-block]');const result={text:button?.textContent.trim()||'',title:button?.title||'',aria:button?.getAttribute('aria-label')||'',icon:Boolean(button?.querySelector('svg'))};root.remove();return result;})`);
  assert.deepEqual(codeCopyControl, { text: 'Copy', title: 'Copy Code', aria: 'Copy Code', icon: true });
  const waitingModelStatus = await browserWindow.webContents.executeJavaScript(`Promise.all([
    import(${JSON.stringify(rendererTranscriptEntry)}),import(${JSON.stringify(rendererI18nEntry)})
  ]).then(([transcript,i18n])=>{const root=document.createElement('div');root.innerHTML=transcript.renderCodexTranscript([{activityId:'model-first-response-waiting-language-smoke',activityType:'model',eventOrigin:'codex',status:'running',title:'模型服务响应较慢，继续等待（2/5）',detail:'上游模型服务尚未返回输出；已等待约 120 秒，Janus 将保留当前请求并继续等待响应。'}],{messageId:'language-waiting'});document.body.append(root);i18n.localizeDom(root,'en');const item=root.querySelector('[data-model-waiting]');const result={title:item?.querySelector('summary strong')?.textContent.trim()||'',detail:item?.querySelector('summary span')?.textContent.trim()||'',animationName:getComputedStyle(item?.querySelector('summary strong')).animationName};root.remove();return result;})`);
  assert.deepEqual(waitingModelStatus, {
    title: 'The model service is responding slowly; continuing to wait (2/5)',
    detail: 'The upstream model service has not returned output. Janus has waited about 120 seconds and will keep the current request open while waiting for a response.',
    animationName: 'janusModelReconnectBlink',
  });
  await assertEnglishSurface(browserWindow, 'initial application surface');
  if (screenshotDir) writeFileSync(path.join(screenshotDir, '01-home.png'), (await browserWindow.webContents.capturePage()).toPNG());
  const messagePanelTitleLayout = await browserWindow.webContents.executeJavaScript(`(()=>{const title=document.querySelector('.message-panel-title h2');const style=getComputedStyle(title);return{text:title?.textContent.trim()||'',paddingBottom:style.paddingBottom,clipped:Boolean(title&&title.scrollHeight>title.clientHeight+1)};})()`);
  assert.deepEqual(messagePanelTitleLayout, { text: 'Messages', paddingBottom: '1px', clipped: false });
  const workspaceSelectionGeometry = await browserWindow.webContents.executeJavaScript(`(()=>{const button=document.querySelector('.account-dock-workspace.is-active');const mark=button?.querySelector('.account-dock-workspace-mark');const buttonRect=button?.getBoundingClientRect();const markRect=mark?.getBoundingClientRect();const selectionStyle=button?getComputedStyle(button,'::after'):null;return{buttonSize:[buttonRect?.width||0,buttonRect?.height||0],markSize:[markRect?.width||0,markRect?.height||0],insets:buttonRect&&markRect?[markRect.left-buttonRect.left,buttonRect.right-markRect.right,markRect.top-buttonRect.top,buttonRect.bottom-markRect.bottom].map((value)=>Math.round(value*10)/10):[],selectionBoxSizing:selectionStyle?.boxSizing||'',selectionInsets:[selectionStyle?.top||'',selectionStyle?.right||'',selectionStyle?.bottom||'',selectionStyle?.left||'']};})()`);
  assert.deepEqual(workspaceSelectionGeometry, { buttonSize: [32, 32], markSize: [26, 26], insets: [3, 3, 3, 3], selectionBoxSizing: 'border-box', selectionInsets: ['0px', '0px', '0px', '0px'] });
  const privateShortcutLayout = await browserWindow.webContents.executeJavaScript(`(()=>{const label=document.querySelector('.im-message-shortcut.is-private .im-message-shortcut-copy strong');const reference=document.querySelector('.im-message-shortcut.is-ubuddy .im-message-shortcut-copy strong');const rect=label?.getBoundingClientRect();const style=getComputedStyle(label);const lineHeight=parseFloat(style.lineHeight)||0;return{text:label?.textContent.trim(),clipped:label?.scrollWidth>label?.clientWidth+1,lineCount:Math.round((rect?.height||0)/lineHeight),fontSize:style.fontSize,referenceFontSize:getComputedStyle(reference).fontSize};})()`);
  assert.deepEqual(privateShortcutLayout, { text: 'Private', clipped: false, lineCount: 1, fontSize: '11px', referenceFontSize: '11px' });

  for (const menu of ['file', 'edit', 'view', 'help']) {
    await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-desktop-menu-trigger="${menu}"]')?.click()`);
    await waitFor(browserWindow, `document.querySelector('[data-desktop-menu="${menu}"] .desktop-menu-popover')?.offsetParent!==null`, `desktop ${menu} menu did not open`);
    await assertEnglishSurface(browserWindow, `desktop ${menu} menu`);
    await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-desktop-menu-trigger="${menu}"]')?.click()`);
  }

  await browserWindow.webContents.executeJavaScript(`window.__languageState.appVersion='0.3.0';document.querySelector('[data-desktop-menu-trigger="help"]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('[data-desktop-menu="help"] .desktop-menu-popover')?.offsetParent!==null`, 'Help menu did not open for release notes');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-desktop-menu-action="whats-new"]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.update-announcement-dialog')?.offsetParent!==null`, 'Update announcement did not open');
  await assertEnglishSurface(browserWindow, 'update announcement summary', '.update-announcement-dialog');
  const updateNoticeChoiceLayout = await browserWindow.webContents.executeJavaScript(`(()=>{const label=document.querySelector('.update-announcement-popup-choice span');const rect=label?.getBoundingClientRect();const style=getComputedStyle(label);const lineHeight=parseFloat(style.lineHeight)||parseFloat(style.fontSize)||0;return{text:label?.textContent.trim()||'',lineCount:Math.round((rect?.height||0)/lineHeight),clipped:Boolean(label&&label.scrollWidth>label.clientWidth+1)};})()`);
  assert.deepEqual(updateNoticeChoiceLayout, { text: 'Show update notices', lineCount: 1, clipped: false });
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-update-announcement-details]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.update-announcement-dialog.is-detailed')?.offsetParent!==null`, 'Detailed release notes did not open');
  await assertEnglishSurface(browserWindow, 'detailed release notes', '.update-announcement-dialog');
  const releaseCopy = await browserWindow.webContents.executeJavaScript(`document.querySelector('.update-announcement-dialog')?.innerText||''`);
  assert.match(releaseCopy, /Complete Task Collaboration and Delivery Review/);
  if (screenshotDir) {
    await browserWindow.webContents.executeJavaScript(`new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    writeFileSync(path.join(screenshotDir, '02-release-notes.png'), (await browserWindow.webContents.capturePage()).toPNG());
  }
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-update-announcement-close]')?.click()`);

  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-message-groups-toggle]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.message-group-sidebar')`, 'message group sidebar did not open');
  await assertEnglishSurface(browserWindow, 'message group sidebar');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-message-groups-toggle]')?.click()`);

  await browserWindow.webContents.executeJavaScript(`document.querySelector('#sidebar-chat-search-trigger')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.chat-search-modal')`, 'chat search modal did not open');
  await assertEnglishSurface(browserWindow, 'chat search modal');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#close-chat-search-btn')?.click()`);

  for (let variant = 0; variant < 3; variant += 1) {
    await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-message-default-variant="${variant}"]')?.click()`);
    await waitFor(browserWindow, `document.querySelector('[data-message-default-variant-index="${variant}"]')`, `message home variant ${variant} did not render`);
    const defaultPageUntranslated = await visibleChinese(browserWindow, '[data-message-default-page]');
    assert.deepEqual(defaultPageUntranslated, [], `untranslated message home variant ${variant}: ${JSON.stringify(defaultPageUntranslated)}`);
  }

  await waitFor(browserWindow, `document.querySelector('[data-agent-message-row="ppt"][data-agent-instance-row="ppt-agent-a"]')`, 'PPT Agent conversation did not render');
  const pptAgentRow = await browserWindow.webContents.executeJavaScript(`(()=>{const row=document.querySelector('[data-agent-message-row="ppt"][data-agent-instance-row="ppt-agent-a"]');const messageLine=row.querySelector('.network-message-line');const time=messageLine.querySelector('time');const titleLine=row.querySelector('.im-conversation-title-line');const title=row.querySelector('.im-conversation-title-line strong');const preview=row.querySelector('.network-message-preview');return{title:title?.textContent.trim(),preview:preview?.textContent.trim(),timeText:time?.textContent||'',messageGrid:getComputedStyle(messageLine).gridTemplateColumns,messageGap:getComputedStyle(messageLine).columnGap,titleClipped:title?.scrollWidth>title?.clientWidth+1,titleScrollWidth:title?.scrollWidth||0,titleClientWidth:title?.clientWidth||0,titleLineClientWidth:titleLine?.clientWidth||0,previewClipped:preview?.scrollWidth>preview?.clientWidth+1,titleSingleLine:Boolean(titleLine&&titleLine.scrollHeight<=titleLine.clientHeight+1),previewSingleLine:Boolean(preview&&preview.scrollHeight<=Math.ceil(parseFloat(getComputedStyle(preview).lineHeight)||16)+1),chinese:[...row.querySelectorAll('*')].filter((item)=>!item.closest('[data-no-localize]')).map((item)=>item.textContent.trim()).filter((text)=>/[\\u3400-\\u9fff]/.test(text)).slice(0,20)};})()`);
  assert.equal(pptAgentRow.title, 'PPT Designer A');
  assert.equal(pptAgentRow.preview, 'Idle · PPT Designer A');
  assert.equal(pptAgentRow.titleClipped, false, `PPT Agent title is clipped: ${JSON.stringify(pptAgentRow)}`);
  assert.equal(pptAgentRow.previewClipped, false);
  assert.equal(pptAgentRow.titleSingleLine, true);
  assert.equal(pptAgentRow.previewSingleLine, true);
  assert.deepEqual(pptAgentRow.chinese, [], `untranslated PPT Agent row: ${JSON.stringify(pptAgentRow.chinese)}`);
  await browserWindow.webContents.executeJavaScript(`window.__languageSmoke.agentAvailabilityListener?.({statuses:[{agentInstanceId:'ppt-agent-a',availability:'working',workState:'reserved',currentWork:'Preparing deck'}]})`);
  await waitFor(browserWindow, `document.querySelector('[data-agent-instance-row="ppt-agent-a"] .network-message-preview')?.textContent.trim()==='Reserved · Preparing deck · PPT Designer A'`, 'English Agent status patch used the wrong language');
  await browserWindow.webContents.executeJavaScript(`window.__languageSmoke.agentAvailabilityListener?.({statuses:[{agentInstanceId:'ppt-agent-a',availability:'idle',workState:'',currentWork:''}]})`);
  await waitFor(browserWindow, `document.querySelector('[data-agent-instance-row="ppt-agent-a"] .network-message-preview')?.textContent.trim()==='Idle · PPT Designer A'`, 'English Agent status did not remain stable');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-agent-instance-row="ppt-agent-a"]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('#ppt-style-trigger')`, 'PPT style picker did not render');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#model-picker-trigger')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.model-menu .model-menu-label')?.textContent.trim()==='Reasoning'`, 'Reasoning label did not translate');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-model-submenu-toggle]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.model-submenu .model-menu-label')?.textContent.trim()==='Models'`, 'Model submenu label did not translate to Models');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#model-picker-trigger')?.click()`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#ppt-style-trigger')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.ppt-style-menu')`, 'PPT style menu did not open');
  const pptStyleCards = await browserWindow.webContents.executeJavaScript(`(()=>Object.fromEntries([...document.querySelectorAll('[data-ppt-style-option]')].map((item)=>{const small=item.querySelector('small');return[item.dataset.pptStyleOption,{label:item.querySelector('strong')?.textContent.trim(),description:small?.textContent.trim(),height:Math.round(item.getBoundingClientRect().height),chinese:/[\\u3400-\\u9fff]/.test(item.textContent)}]})))()`);
  assert.equal(pptStyleCards.academic_report.label, 'Academic Report');
  assert.equal(pptStyleCards.academic_report.description, 'For coursework, papers, and technical talks, emphasizing structure, methods, and evidence.');
  assert.equal(pptStyleCards.major_project.label, 'Major Project');
  assert.equal(pptStyleCards.major_project.description, 'For proposals, implementation plans, and project reviews, emphasizing goals, delivery routes, outcomes, and risks.');
  assert.equal(pptStyleCards.academic_report.chinese, false);
  assert.equal(pptStyleCards.major_project.chinese, false);
  assert.ok(Math.abs(pptStyleCards.academic_report.height - pptStyleCards.major_project.height) <= 1, `PPT style cards are visually unbalanced: ${JSON.stringify(pptStyleCards)}`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#ppt-style-trigger')?.click();document.querySelector('[data-message-home-back]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('[data-message-default-page]')`, 'message home did not reopen after PPT style inspection');

  await browserWindow.webContents.executeJavaScript(`window.__languageState.socialThreads=[{friend:{id:'sijie-liu',displayName:'刘思杰',username:'sijie'},messages:[{id:'hello-sijie',senderUserId:'sijie-liu',recipientUserId:'language_user',content:'This user message stays unchanged.',status:'sent',updatedAt:'2026-08-07T02:00:00.000Z'}]}];document.querySelector('[data-network-view="messages"]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('[data-network-peer="sijie-liu"]')`, 'localized contact conversation did not render');
  const localizedContact = await browserWindow.webContents.executeJavaScript(`(()=>{const row=document.querySelector('[data-network-peer="sijie-liu"]');return{name:row.querySelector('.im-conversation-title-line strong')?.textContent.trim(),avatar:row.querySelector('.avatar-fallback-label')?.textContent.trim(),preview:row.querySelector('.network-message-preview')?.textContent.trim(),aria:row.querySelector('.network-user-avatar')?.getAttribute('aria-label')};})()`);
  assert.deepEqual(localizedContact, { name: 'Sijie Liu', avatar: 'Sijie', preview: 'Sijie Liu · This user message stays unchanged.', aria: 'Sijie Liu avatar' });
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-network-peer="sijie-liu"]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.chat-view') && document.querySelector('.chat-message-avatar')`, 'localized direct conversation did not open');
  await assertEnglishSurface(browserWindow, 'direct conversation');
  const chatIdentity = await browserWindow.webContents.executeJavaScript(`(()=>{const avatar=document.querySelector('.chat-message-avatar.is-peer');return{label:avatar?.querySelector('.avatar-fallback-label')?.textContent.trim(),title:avatar?.getAttribute('title'),aria:avatar?.getAttribute('aria-label')};})()`);
  assert.deepEqual(chatIdentity, { label: 'Sijie', title: 'Sijie Liu', aria: 'Sijie Liu avatar' });
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-message-home-back]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('[data-message-default-page]')`, 'message home did not reopen after direct conversation');

  await browserWindow.webContents.executeJavaScript(`document.querySelector('#account-card').click()`);
  await waitFor(browserWindow, `document.querySelector('.account-menu [data-account-menu-action="settings"]')?.textContent.trim()==='Settings'`, 'account menu did not open in English');
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.querySelector('#account-card')?.getAttribute('aria-label')`), 'Account Menu');
  const expandedAccountMenuLayout = await browserWindow.webContents.executeJavaScript(`(()=>{const menu=document.querySelector('.sidebar-profile-area .account-menu');const rect=menu?.getBoundingClientRect();const labels=[...menu.querySelectorAll('.account-menu-item strong')];return{width:Math.round(rect?.width||0),labels:labels.map((item)=>item.textContent.trim()),rightGaps:labels.map((item)=>Math.round((rect?.right||0)-item.getBoundingClientRect().right))};})()`);
  assert.equal(expandedAccountMenuLayout.width, 152);
  assert.deepEqual(expandedAccountMenuLayout.labels, ['Settings', 'Sign Out']);
  assert.ok(expandedAccountMenuLayout.rightGaps.every((gap) => gap >= 12), `expanded account menu lacks right spacing: ${JSON.stringify(expandedAccountMenuLayout)}`);
  assert.deepEqual(await visibleChinese(browserWindow, '.account-menu'), [], 'untranslated account menu controls');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#account-card').click()`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#collapse-sidebar-btn')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.shell')?.classList.contains('sidebar-collapsed')`, 'sidebar did not collapse');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#account-card')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.sidebar-profile-area .account-menu [data-account-menu-action="settings"] strong')?.getBoundingClientRect().width>0`, 'collapsed account menu labels are hidden');
  const collapsedAccountMenuLayout = await browserWindow.webContents.executeJavaScript(`(()=>{const menu=document.querySelector('.sidebar-profile-area .account-menu');const rect=menu?.getBoundingClientRect();const labels=[...menu.querySelectorAll('.account-menu-item strong')];return{width:Math.round(rect?.width||0),labels:labels.map((item)=>item.textContent.trim()),rightGaps:labels.map((item)=>Math.round((rect?.right||0)-item.getBoundingClientRect().right))};})()`);
  assert.equal(collapsedAccountMenuLayout.width, 152);
  assert.deepEqual(collapsedAccountMenuLayout.labels, ['Settings', 'Sign Out']);
  assert.ok(collapsedAccountMenuLayout.rightGaps.every((gap) => gap >= 12), `collapsed account menu lacks right spacing: ${JSON.stringify(collapsedAccountMenuLayout)}`);
  assert.deepEqual(await visibleChinese(browserWindow, '.sidebar-profile-area .account-menu'), [], 'untranslated collapsed account menu controls');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#account-card')?.click();document.querySelector('#collapse-sidebar-btn')?.click()`);
  await waitFor(browserWindow, `!document.querySelector('.shell')?.classList.contains('sidebar-collapsed')`, 'sidebar did not expand after account menu inspection');
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-account-workspace-source="account-dock-personal"]')?.getAttribute('title')`), 'Personal Workspace');
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-account-workspace-account-toggle]')?.getAttribute('aria-label')`), 'More Workspaces');
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.querySelector('#account-workspace-tooltip-more')?.textContent.trim()`), 'More Workspaces');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-account-workspace-account-toggle]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.account-workspace-dock-menu')?.textContent.includes('Choose Workspace')`, 'workspace menu did not open');
  const workspaceMenuLayout = await browserWindow.webContents.executeJavaScript(`(()=>{const dock=document.querySelector('.account-dock')?.getBoundingClientRect();const menu=document.querySelector('.account-workspace-dock-menu')?.getBoundingClientRect();return{visible:Boolean(menu?.width&&menu?.height),opensAbove:Boolean(dock&&menu&&menu.bottom<=dock.top),withinViewport:Boolean(menu&&menu.top>=0&&menu.right<=innerWidth&&menu.bottom<=innerHeight),personalLabel:document.querySelector('.account-workspace-dock-menu [data-account-workspace-id="workspace_personal"] strong')?.textContent.trim()};})()`);
  assert.deepEqual(workspaceMenuLayout, { visible: true, opensAbove: true, withinViewport: true, personalLabel: 'Personal Workspace' });
  assert.deepEqual(await visibleChinese(browserWindow, '.account-workspace-dock-menu'), [], 'untranslated workspace menu controls');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-account-workspace-account-toggle]')?.click()`);

  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-account-workspace-account-toggle]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.account-workspace-dock-menu [data-account-workspace-id="workspace_org_language_1"]')`, 'workspace menu did not reopen for switching');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('.account-workspace-dock-menu [data-account-workspace-id="workspace_org_language_1"]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.workspace-switch-progress strong')?.textContent.includes('Switching to Language Org 1')`, 'organization switch progress did not paint');
  await waitFor(browserWindow, `window.__languageState.activeAccountWorkspace?.id==='workspace_org_language_1'&&!document.querySelector('.workspace-switch-progress')`, 'organization switch did not complete');
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-account-workspace-shortcut][data-account-workspace-id="workspace_org_language_1"]')?.classList.contains('is-active')`), true);

  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-account-workspace-shortcut][data-account-workspace-id="workspace_personal"]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.workspace-switch-progress strong')?.textContent.includes('Switching to Personal Workspace')`, 'Personal switch progress did not paint');
  await waitFor(browserWindow, `window.__languageState.activeAccountWorkspace?.id==='workspace_personal'&&!document.querySelector('.workspace-switch-progress')`, 'Personal shortcut switch did not complete');
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-account-workspace-shortcut][data-account-workspace-id="workspace_personal"]')?.classList.contains('is-active')`), true);

  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-account-workspace-shortcut][data-account-workspace-id="workspace_org_language_1"]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.workspace-switch-progress strong')?.textContent.includes('Switching to Language Org 1')`, 'organization shortcut switch progress did not paint');
  await waitFor(browserWindow, `window.__languageState.activeAccountWorkspace?.id==='workspace_org_language_1'&&!document.querySelector('.workspace-switch-progress')`, 'organization shortcut switch did not complete');
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-account-workspace-shortcut][data-account-workspace-id="workspace_org_language_1"]')?.classList.contains('is-active')`), true);
  assert.deepEqual(await browserWindow.webContents.executeJavaScript(`window.__languageSmoke.workspaceSwitchCalls`), [
    'workspace_org_language_1', 'workspace_personal', 'workspace_org_language_1',
  ]);

  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-network-view="friends"]').click()`);
  await waitFor(browserWindow, `document.querySelector('[data-page-kind="friends"]')`, 'English contacts view did not open');
  const contactsUntranslated = await browserWindow.webContents.executeJavaScript(`[...document.querySelectorAll('.network-panel button, .network-panel h1, .network-panel h2, .network-panel h3, .network-panel label, .network-panel small, .network-panel input[placeholder]')]
    .filter((item)=>item.offsetParent!==null && !item.closest('[data-no-localize]'))
    .map((item)=>item.getAttribute('placeholder')||item.textContent.trim()).filter((text)=>/[\\u3400-\\u9fff]/.test(text)).slice(0,40)`);
  assert.deepEqual(contactsUntranslated, [], `untranslated contacts controls: ${JSON.stringify(contactsUntranslated)}`);
  await assertEnglishSurface(browserWindow, 'contacts workspace');
  await browserWindow.webContents.executeJavaScript(`window.__languageState.friendOverview={...(window.__languageState.friendOverview||{}),organizations:[1,2,3,4,5].map((index)=>({id:'organization_language_'+index,name:'Language Org '+index,organizationNumber:'LANG-'+index,role:index===1?'owner':'member',members:[],memberCount:1}))}`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-account-organization-action="manage"]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.contacts-organizations-pane')?.textContent.includes('Language Org 1')`, 'organization settings pane did not open');
  await assertEnglishSurface(browserWindow, 'organization settings pane');
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.querySelectorAll('[data-organization-settings-workspace-location="primary"]').length`), 3);
  assert.equal(await browserWindow.webContents.executeJavaScript(`Boolean(document.querySelector('.organization-settings-pane [data-account-workspace-id="workspace_personal"]'))`), false);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-organization-settings-workspace-more-toggle]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.organization-settings-workspace-more-submenu')?.textContent.includes('Other Organizations')`, 'Other Organizations submenu did not open');
  const organizationSubmenuLayout = await browserWindow.webContents.executeJavaScript(`(()=>{const toggle=document.querySelector('[data-organization-settings-workspace-more-toggle]')?.getBoundingClientRect();const submenu=document.querySelector('.organization-settings-workspace-more-submenu')?.getBoundingClientRect();return{visible:Boolean(submenu?.width&&submenu?.height),opensRight:Boolean(toggle&&submenu&&submenu.left>=toggle.right),withinViewport:Boolean(submenu&&submenu.top>=0&&submenu.right<=innerWidth&&submenu.bottom<=innerHeight),moreCount:document.querySelectorAll('[data-organization-settings-workspace-location="more"]').length,containsPersonal:Boolean(document.querySelector('.organization-settings-workspace-more-submenu [data-account-workspace-id="workspace_personal"]'))};})()`);
  assert.deepEqual(organizationSubmenuLayout, { visible: true, opensRight: true, withinViewport: true, moreCount: 1, containsPersonal: false });
  await assertEnglishSurface(browserWindow, 'other organizations submenu', '.organization-settings-workspace-more-submenu');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-contacts-pane="directory"]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('[data-contact-add-open="contact"]')`, 'contact directory did not reopen');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-contact-add-open="contact"]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('[data-contact-add-dialog]')`, 'contact add dialog did not open');
  await assertEnglishSurface(browserWindow, 'contact add dialog');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-contact-add-tab="join-organization"]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('#organization-join-default')`, 'join organization dialog did not open');
  assert.deepEqual(await browserWindow.webContents.executeJavaScript(`(()=>{const checkbox=document.querySelector('#organization-join-default');const option=checkbox?.closest('.organization-workspace-default-option');return{checked:checkbox?.checked===true,title:option?.querySelector('strong')?.textContent.trim()||'',description:option?.querySelector('small')?.textContent.trim()||''};})()`), {
    checked: true,
    title: 'Set This Organization as the Default Workspace',
    description: 'Switch immediately after joining and open it by default the next time Janus starts.',
  });
  await assertEnglishSurface(browserWindow, 'join organization dialog');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-contact-add-close]')?.click()`);
  for (const category of ['internal', 'new', 'starred', 'groups']) {
    await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-friend-directory-category="${category}"]')?.click()`);
    await waitFor(browserWindow, `document.querySelector('[data-friend-directory-category="${category}"].active')`, `contact category ${category} did not open`);
    await assertEnglishSurface(browserWindow, `contact category ${category}`);
  }
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-friend-directory-category="external"]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('[data-contact-profile="sijie-liu"]')`, 'external contact list did not render');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-contact-profile="sijie-liu"]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.contact-profile-drawer')`, 'contact profile did not open');
  await assertEnglishSurface(browserWindow, 'contact profile drawer');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-contact-profile-close]')?.click()`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-tab="employees"]').click()`);
  await waitFor(browserWindow, `document.querySelector('[data-page-kind="employees"]')`, 'English talent view did not open');
  const generalistCapability = await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-employee-market-candidate-open="general_agent"] .talent-directory-compact-tags span')?.textContent.trim()||''`);
  assert.equal(generalistCapability, 'General Q&A & Analysis');
  const generalistRecruitmentMeta = await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-employee-market-candidate-open="general_agent"] .talent-directory-card-meta')?.textContent.trim()||''`);
  assert.equal(generalistRecruitmentMeta, '2 hired · Can hire more');
  const talentUntranslated = await browserWindow.webContents.executeJavaScript(`[...document.querySelectorAll('.employees-view button, .employees-view h1, .employees-view h2, .employees-view h3, .employees-view label, .employees-view small, .employees-view p, .employees-view input[placeholder]')]
    .filter((item)=>item.offsetParent!==null && !item.closest('[data-no-localize]'))
    .map((item)=>item.getAttribute('placeholder')||item.textContent.trim()).filter((text)=>/[\\u3400-\\u9fff]/.test(text)).slice(0,40)`);
  assert.deepEqual(talentUntranslated, [], `untranslated talent controls: ${JSON.stringify(talentUntranslated)}`);
  await assertEnglishSurface(browserWindow, 'talent workspace');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-employee-market-candidate-open]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.talent-candidate-drawer')`, 'talent candidate drawer did not open');
  await assertEnglishSurface(browserWindow, 'talent candidate drawer');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-employee-market-candidate-close]')?.click()`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-employee-installed-context]')?.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:180,clientY:220}))`);
  await waitFor(browserWindow, `document.querySelector('.employee-context-menu')`, 'employee context menu did not open');
  await assertEnglishSurface(browserWindow, 'employee context menu');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-employee-context-action="profile"]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.employee-overview-drawer')`, 'employee overview drawer did not open');
  await assertEnglishSurface(browserWindow, 'employee overview drawer');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('.employee-overview-drawer [data-employee-detail-tab="memory"]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.employee-memory-drawer:not(.employee-overview-drawer):not(.employee-market-drawer):not(.employee-growth-drawer) .employee-drawer-toolbar')`, 'employee Memory drawer did not load');
  await assertEnglishSurface(browserWindow, 'employee Memory drawer');
  const memoryCopy = await browserWindow.webContents.executeJavaScript(`document.querySelector('.employee-memory-drawer:not(.employee-overview-drawer):not(.employee-market-drawer):not(.employee-growth-drawer)')?.innerText||''`);
  assert.match(memoryCopy, /1 active · 1 archived/);
  assert.match(memoryCopy, /Memory Content Preview/);
  assert.match(memoryCopy, /Click to Collapse/);
  assert.match(memoryCopy, /Context boundary: epoch 1/);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('.employee-memory-drawer [data-employee-detail-tab="skill"]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.employee-market-drawer .employee-skill-combination')`, 'employee Skill drawer did not load');
  await assertEnglishSurface(browserWindow, 'employee Skill drawer');
  const skillCopy = await browserWindow.webContents.executeJavaScript(`document.querySelector('.employee-market-drawer')?.innerText||''`);
  assert.match(skillCopy, /Current Combination/);
  assert.match(skillCopy, /Use Only the Selected Market Base/);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('.employee-market-drawer [data-employee-detail-tab="growth"]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.employee-growth-drawer .employee-growth-section')`, 'employee Growth drawer did not load');
  await assertEnglishSurface(browserWindow, 'employee Growth drawer');
  const growthCopy = await browserWindow.webContents.executeJavaScript(`document.querySelector('.employee-growth-drawer')?.innerText||''`);
  assert.match(growthCopy, /P measures professional performance; L measures leadership eligibility\./);
  assert.match(growthCopy, /Next Level L2/);
  assert.match(growthCopy, /Team Trials/);
  assert.match(growthCopy, /Cross-Team Trials/);
  assert.match(growthCopy, /Role/);
  assert.match(growthCopy, /Decomposition 79/);
  assert.match(growthCopy, /Rework 75/);
  assert.match(growthCopy, /Coordination 77/);
  assert.match(growthCopy, /Uplift 72/);
  assert.match(growthCopy, /Safety 95/);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-employee-detail-close]')?.click()`);

  await browserWindow.webContents.executeJavaScript(`document.querySelector('#language-toggle-btn').click()`);
  await waitFor(browserWindow, `document.querySelector('.global-language-menu')`, 'language menu did not open');
  await assertEnglishSurface(browserWindow, 'global language menu');
  const menuLayout = await browserWindow.webContents.executeJavaScript(`(()=>{const r=document.querySelector('.global-language-menu').getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width};})()`);
  assert.ok(menuLayout.left >= 0 && menuLayout.right <= 1180 && menuLayout.top >= 0 && menuLayout.bottom <= 780);
  assert.ok(menuLayout.width >= 145 && menuLayout.width <= 170);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('.global-language-menu [data-language-choice="zh-CN"]').click()`);
  await waitFor(browserWindow, `document.documentElement.lang==='zh-CN' && document.querySelector('#language-toggle-btn')?.textContent.trim()==='中'`, 'Chinese switch did not apply');
  const chineseDesktopMenus = await browserWindow.webContents.executeJavaScript(`(() => ({
    triggers:[...document.querySelectorAll('[data-desktop-menu-trigger]')].map((item)=>item.textContent.trim()),
    labels:[...document.querySelectorAll('.desktop-menu-item > span')].map((item)=>item.textContent.trim()),
    disabled:[...document.querySelectorAll('.desktop-menu-item:disabled')].map((item)=>item.dataset.desktopMenuAction).sort(),
  }))()`);
  assert.deepEqual(chineseDesktopMenus.triggers, ['文件', '编辑', '视图', '帮助']);
  for (const label of ['新建窗口', '打开文件夹...', '撤销', '切换侧边栏', '文档', '发送反馈']) {
    assert.ok(chineseDesktopMenus.labels.includes(label), `Chinese desktop menu is missing ${label}`);
  }
  assert.deepEqual(chineseDesktopMenus.disabled, ['focus-browser-address', 'open-browser-tab', 'open-terminal', 'toggle-bottom-panel', 'toggle-file-tree', 'toggle-pinned-summary']);
  await browserWindow.webContents.executeJavaScript(`window.__languageState.socialThreads=[{friend:{id:'sijie-liu',displayName:'刘思杰',username:'sijie'},messages:[{id:'hello-sijie',senderUserId:'sijie-liu',recipientUserId:'language_user',content:'This user message stays unchanged.',status:'sent',updatedAt:'2026-08-07T02:00:00.000Z'}]}];document.querySelector('[data-network-view="messages"]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('[data-network-peer="sijie-liu"] .im-conversation-title-line strong')?.textContent.trim()==='刘思杰'`, 'Chinese contact identity did not restore');
  await browserWindow.webContents.executeJavaScript(`window.__languageSmoke.agentAvailabilityListener?.({statuses:[{agentInstanceId:'ppt-agent-a',availability:'working',workState:'queued',currentWork:''}]})`);
  await waitFor(browserWindow, `document.querySelector('[data-agent-instance-row="ppt-agent-a"] .network-message-preview')?.textContent.trim()==='排队中 · PPT Agent A'`, 'Chinese Agent status patch used the wrong language');
  const chineseContact = await browserWindow.webContents.executeJavaScript(`(()=>{const row=document.querySelector('[data-network-peer="sijie-liu"]');return{name:row.querySelector('.im-conversation-title-line strong')?.textContent.trim(),avatar:row.querySelector('.avatar-fallback-label')?.textContent.trim(),preview:row.querySelector('.network-message-preview')?.textContent.trim()};})()`);
  assert.deepEqual(chineseContact, { name: '刘思杰', avatar: '思杰', preview: '刘思杰 · This user message stays unchanged.' });
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-agent-message-row="ppt"][data-agent-instance-row="ppt-agent-a"] .im-conversation-title-line strong')?.textContent.trim()`), 'PPT Agent A');
  assert.equal(await browserWindow.webContents.executeJavaScript(`localStorage.getItem('janus-language-mode')`), 'zh-CN');

  await browserWindow.reload();
  await waitFor(browserWindow, `document.documentElement.lang==='zh-CN' && document.querySelector('#language-toggle-btn')?.textContent.trim()==='中'`, 'Chinese preference did not survive reload');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#language-toggle-btn').click();document.querySelector('.global-language-menu [data-language-choice="en"]').click()`);
  await waitFor(browserWindow, `document.documentElement.lang==='en'`, 'English switch did not reapply');

  await browserWindow.webContents.executeJavaScript(`document.querySelector('#account-card').click();document.querySelector('[data-account-menu-action="settings"]').click()`);
  await waitFor(browserWindow, `document.querySelector('[data-settings-section="preferences"]')`, 'settings did not open');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-settings-section="preferences"]').click()`);
  await waitFor(browserWindow, `document.querySelector('.settings-language-panel') && document.querySelector('.desktop-lifecycle-settings') && document.querySelector('.settings-section-head h1')?.textContent.trim()==='Preferences'`, 'Preferences settings did not render in English');
  const diagnosticsNavLayout = await browserWindow.webContents.executeJavaScript(`(()=>{const label=document.querySelector('[data-settings-section="diagnostics"] strong');const rect=label?.getBoundingClientRect();const lineHeight=parseFloat(getComputedStyle(label).lineHeight)||0;return{text:label?.textContent.trim()||'',lineCount:Math.round((rect?.height||0)/lineHeight)};})()`);
  assert.deepEqual(diagnosticsNavLayout, { text: 'Diagnostics', lineCount: 1 });
  const organizationResearchNavLayout = await browserWindow.webContents.executeJavaScript(`(()=>{const label=document.querySelector('[data-settings-section="organization-research"] strong');const rect=label?.getBoundingClientRect();const lineHeight=parseFloat(getComputedStyle(label).lineHeight)||0;return{text:label?.textContent.trim()||'',lineCount:Math.round((rect?.height||0)/lineHeight)};})()`);
  assert.deepEqual(organizationResearchNavLayout, { text: 'Org Research', lineCount: 1 });

  const layout = await browserWindow.webContents.executeJavaScript(`(()=>{
    const shell=document.querySelector('.settings-shell');
    const orphanCounts=[...document.querySelectorAll('.settings-choice small')].map((element)=>{
      const words=element.textContent.trim().split(/\\s+/).filter(Boolean);if(words.length<4)return words.length;
      const text=element.firstChild;const lines=[];for(let i=0;i<words.length;i++){const start=words.slice(0,i).join(' ').length+(i?1:0);const range=document.createRange();range.setStart(text,start);range.setEnd(text,start+words[i].length);const top=Math.round(range.getBoundingClientRect().top);const line=lines.find((item)=>item.top===top);if(line)line.count+=1;else lines.push({top,count:1});}return lines.at(-1)?.count||0;
    });
    return{
      noHorizontalOverflow:shell.scrollWidth<=shell.clientWidth+1,
      title:document.querySelector('.settings-section-head h1')?.textContent.trim(),
      theme:document.querySelector('.settings-panel h2')?.textContent.trim(),
      language:document.querySelector('.settings-language-panel h2')?.textContent.trim(),
      closeBehavior:document.querySelector('.desktop-lifecycle-row strong')?.textContent.trim(),
      closeBehaviorDescription:document.querySelector('.desktop-lifecycle-row small')?.textContent.trim(),
      panelOrder:[...document.querySelectorAll('.settings-preferences-view .settings-panel')].map((panel)=>panel.querySelector('h2')?.textContent.trim()||panel.querySelector('.desktop-lifecycle-row strong')?.textContent.trim()),
      orphanCounts,
      englishActive:document.querySelector('.settings-language-panel [data-language-choice="en"]')?.classList.contains('active'),
      stored:localStorage.getItem('janus-language-mode'),
      untranslated:[...document.querySelectorAll('.settings-shell button, .settings-shell h1, .settings-shell h2, .settings-shell h3, .settings-shell label, .settings-shell small, .settings-shell p, .settings-shell input[placeholder]')]
        .filter((item)=>item.offsetParent!==null && !item.closest('[data-no-localize], [data-language-choice="zh-CN"]'))
        .map((item)=>item.getAttribute('placeholder')||item.textContent.trim()).filter((text)=>/[\\u3400-\\u9fff]/.test(text)).slice(0,30),
      errors:window.__languageSmoke.errors,
    };
  })()`);
  assert.equal(layout.noHorizontalOverflow, true);
  assert.equal(layout.title, 'Preferences');
  assert.equal(layout.theme, 'Theme');
  assert.equal(layout.language, 'Language');
  assert.equal(layout.closeBehavior, 'When closing the last window');
  assert.equal(layout.closeBehaviorDescription, 'Janus will keep running in the notification area.');
  assert.deepEqual(layout.panelOrder, ['Theme', 'Language', 'When closing the last window']);
  assert.equal(layout.englishActive, true);
  assert.equal(layout.stored, 'en');
  assert.deepEqual(layout.untranslated, [], `untranslated Preferences controls: ${JSON.stringify(layout.untranslated)}`);
  assert.ok(layout.orphanCounts.every((count) => count === 0 || count >= 3), `English descriptions left orphan words: ${JSON.stringify(layout.orphanCounts)}`);
  assert.deepEqual(layout.errors, []);
  assert.doesNotMatch(await browserWindow.webContents.executeJavaScript(`document.body.innerText`), /\bCodex\b/, 'English UI must not expose the internal Codex brand');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-settings-section="account"]').click()`);
  await waitFor(browserWindow, `document.querySelector('.settings-section-head h1')?.textContent.trim()==='Account'`, 'Account settings did not render in English');
  await browserWindow.webContents.executeJavaScript(`window.__languageState.currentUser={...window.__languageState.currentUser,permissions:{...window.__languageState.currentUser.permissions,canEditCodexConfig:true}};window.__languageState.codexConfig={...window.__languageState.codexConfig,configurationMode:'embedded-with-user-override',userProviderOverrideValidated:true,providerName:'custom-provider',model:'gpt-5.6-sol',authEnvKey:'CUSTOM_API_KEY',baseUrl:'https://provider.example/v1',hasApiKey:true};window.__languageState.codexConfigFiles={configToml:'model_provider = "custom-provider"',authJson:'{"CUSTOM_API_KEY":"test-key"}'};window.__languageState.codexConnectionTest={status:'pass',title:'自定义 Provider 已启用',message:'网络、鉴权和模型 gpt-5.6-sol 路由检查通过。'};window.__languageState.advancedModelServiceOpen=true;document.querySelector('[data-settings-section="account"]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('[data-advanced-model-service-disclosure][open]')`, 'enabled custom Provider details did not render');
  assert.deepEqual(await browserWindow.webContents.executeJavaScript(`(()=>{const bar=document.querySelector('.model-service-mode-bar');return{title:bar?.querySelector('strong')?.textContent.trim()||'',description:bar?.querySelector('small')?.textContent.trim()||'',status:bar?.querySelector('.model-service-mode-status')?.textContent.trim()||''};})()`), {
    title: 'Custom Provider',
    description: 'The validated custom Provider is active and is not subject to Janus token limits.',
    status: 'Validated',
  });
  assert.deepEqual(await browserWindow.webContents.executeJavaScript(`(()=>{const disclosure=document.querySelector('[data-advanced-model-service-disclosure]');const summary=disclosure?.querySelector('.advanced-model-service-summary');const notice=disclosure?.querySelector('.model-config-notice-row');const action=disclosure?.querySelector('.model-service-action');const button=action?.querySelector('button');return{summaryTitle:summary?.querySelector('strong')?.textContent.trim()||'',summaryDescription:summary?.querySelector('small')?.textContent.trim()||'',badge:summary?.querySelector('b')?.textContent.trim()||'',noticeTitle:notice?.querySelector('strong')?.textContent.trim()||'',noticeDescription:notice?.querySelector('small')?.textContent.trim()||'',testTitle:action?.querySelector('strong')?.textContent.trim()||'',testDescription:action?.querySelector('small')?.textContent.trim()||'',button:button?.textContent.trim()||'',buttonClipped:Boolean(button&&button.scrollWidth>button.clientWidth+1),shellOverflow:document.querySelector('.settings-shell').scrollWidth>document.querySelector('.settings-shell').clientWidth+1};})()`), {
    summaryTitle: 'Custom Provider Enabled',
    summaryDescription: 'This custom Provider passed the network, authentication, and model-routing checks. Expand to review or edit config.toml and auth.json; any change must be saved and tested again.',
    badge: 'Validated',
    noticeTitle: 'Using Custom Provider',
    noticeDescription: 'The current config.toml and auth.json passed the connection test. Editing either file disables the custom Provider until you save and test the configuration again.',
    testTitle: 'Custom Provider Enabled',
    testDescription: 'Network access, authentication, and routing for model gpt-5.6-sol passed.',
    button: 'Save Advanced Config & Test',
    buttonClipped: false,
    shellOverflow: false,
  });
  const accountUntranslated = await browserWindow.webContents.executeJavaScript(`[...document.querySelectorAll('.settings-shell button, .settings-shell h1, .settings-shell h2, .settings-shell h3, .settings-shell label, .settings-shell small, .settings-shell p, .settings-shell input[placeholder]')]
    .filter((item)=>item.offsetParent!==null && !item.closest('[data-no-localize]'))
    .map((item)=>item.getAttribute('placeholder')||item.textContent.trim()).filter((text)=>/[\\u3400-\\u9fff]/.test(text)).slice(0,40)`);
  assert.deepEqual(accountUntranslated, [], `untranslated account controls: ${JSON.stringify(accountUntranslated)}`);
  await assertEnglishSurface(browserWindow, 'account settings', '.settings-shell');
  assert.match(await browserWindow.webContents.executeJavaScript(`document.querySelector('.default-model-usage-value')?.textContent||''`), /tokens$/);
  assert.deepEqual(await browserWindow.webContents.executeJavaScript(`(()=>{const metric=document.querySelector('.default-model-image-usage');const progress=metric?.querySelector('[role="progressbar"]');return{title:metric?.querySelector('strong')?.textContent.trim()||'',value:metric?.querySelector('.default-model-usage-value')?.textContent.trim()||'',foot:metric?.querySelector('.default-model-usage-foot')?.textContent.trim()||'',aria:progress?.getAttribute('aria-label')||'',now:Number(progress?.getAttribute('aria-valuenow')),width:progress?.querySelector('i')?.style.width||''};})()`), {
    title: 'Daily Image Allowance',
    value: '2 / 5 images',
    foot: '3 remaining40%',
    aria: 'Daily Image Allowance',
    now: 40,
    width: '40%',
  });
  const darkUsageColors = await browserWindow.webContents.executeJavaScript(`(()=>{const shell=document.querySelector('.settings-shell');const originalClass=shell.className;shell.classList.remove('theme-light');shell.classList.add('theme-dark');const token=document.querySelector('.default-model-token-usage');const image=document.querySelector('.default-model-image-usage');const tokenTrack=getComputedStyle(token.querySelector('.default-model-usage-progress'));const imageTrack=getComputedStyle(image.querySelector('.default-model-usage-progress'));const result={tokenTrack:tokenTrack.backgroundColor,tokenBorder:tokenTrack.borderTopColor,tokenFill:getComputedStyle(token.querySelector('.default-model-usage-progress i')).backgroundImage,imageTrack:imageTrack.backgroundColor,imageFill:getComputedStyle(image.querySelector('.default-model-usage-progress i')).backgroundImage,divider:getComputedStyle(image).borderTopColor,tokenValue:getComputedStyle(token.querySelector('.default-model-usage-value')).color,imageValue:getComputedStyle(image.querySelector('.default-model-usage-value')).color,foot:getComputedStyle(token.querySelector('.default-model-usage-foot')).color};shell.className=originalClass;return result;})()`);
  assert.equal(darkUsageColors.tokenTrack, 'rgb(16, 22, 29)');
  assert.equal(darkUsageColors.imageTrack, 'rgb(16, 22, 29)');
  assert.equal(darkUsageColors.tokenBorder, 'rgb(58, 73, 88)');
  assert.equal(darkUsageColors.divider, 'rgb(52, 65, 77)');
  assert.match(darkUsageColors.tokenFill, /rgb\(78, 142, 255\).*rgb\(45, 201, 211\)/);
  assert.match(darkUsageColors.imageFill, /rgb\(49, 185, 138\).*rgb\(131, 207, 104\)/);
  assert.notEqual(darkUsageColors.tokenFill, darkUsageColors.imageFill);
  assert.deepEqual([darkUsageColors.tokenValue, darkUsageColors.imageValue, darkUsageColors.foot], ['rgb(134, 182, 255)', 'rgb(112, 214, 178)', 'rgb(167, 179, 194)']);
  if (screenshotDir) {
    await browserWindow.webContents.executeJavaScript(`new Promise((resolve)=>{const shell=document.querySelector('.settings-shell');const frame=document.querySelector('.app-frame');const region=document.querySelector('.settings-section-view');window.__languageSmokeDarkClasses={shell:shell.className,frame:frame.className,scrollTop:region.scrollTop};shell.classList.remove('theme-light');shell.classList.add('theme-dark');frame.classList.remove('theme-light');frame.classList.add('theme-dark');document.querySelector('.default-model-usage-card')?.scrollIntoView({block:'center'});requestAnimationFrame(()=>requestAnimationFrame(resolve));})`);
    writeFileSync(path.join(screenshotDir, '03-account-settings-dark-usage.png'), (await browserWindow.webContents.capturePage()).toPNG());
    await browserWindow.webContents.executeJavaScript(`(()=>{const shell=document.querySelector('.settings-shell');const frame=document.querySelector('.app-frame');const region=document.querySelector('.settings-section-view');shell.className=window.__languageSmokeDarkClasses.shell;frame.className=window.__languageSmokeDarkClasses.frame;region.scrollTop=window.__languageSmokeDarkClasses.scrollTop;delete window.__languageSmokeDarkClasses;})()`);
  }
  await browserWindow.webContents.executeJavaScript(`window.__languageState.managedProviderUsage={...window.__languageState.managedProviderUsage,managedProvider:false,imageGenerationLimited:false,dailyImagesUsed:7};document.querySelector('[data-settings-section="preferences"]')?.click();document.querySelector('[data-settings-section="account"]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.default-model-image-usage.is-unlimited')`, 'custom image Provider usage did not render');
  assert.deepEqual(await browserWindow.webContents.executeJavaScript(`(()=>{const metric=document.querySelector('.default-model-image-usage');return{title:metric?.querySelector('strong')?.textContent.trim()||'',description:metric?.querySelector('small')?.textContent.trim()||'',value:metric?.querySelector('.default-model-usage-value')?.textContent.trim()||'',hasProgress:Boolean(metric?.querySelector('[role="progressbar"]'))};})()`), {
    title: 'Today’s Image Generation Usage',
    description: 'A custom image service is active. Usage is tracked for the current Provider only, with no Janus daily limit.',
    value: '7 images · Unlimited',
    hasProgress: false,
  });
  await assertEnglishSurface(browserWindow, 'custom image Provider usage', '.settings-shell');
  if (screenshotDir) writeFileSync(path.join(screenshotDir, '03-account-settings.png'), (await browserWindow.webContents.capturePage()).toPNG());
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.querySelector('.account-role-pill')?.textContent.trim()`), 'Member');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-profile-avatar-preview]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.avatar-viewer-modal')`, 'Avatar viewer did not open');
  assert.deepEqual(await browserWindow.webContents.executeJavaScript(`(()=>{const modal=document.querySelector('.avatar-viewer-modal');const close=modal?.querySelector('.avatar-viewer-close');return{modal:modal?.getAttribute('aria-label'),close:close?.getAttribute('aria-label')};})()`), { modal: 'View Avatar', close: 'Close' });
  await browserWindow.webContents.executeJavaScript(`document.querySelector('.avatar-viewer-close')?.click()`);

  for (const section of ['ubuddy-profile', 'evolution-sync', 'skills', 'diagnostics', 'archived']) {
    await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-settings-section=${JSON.stringify(section)}]')?.click()`);
    await waitFor(browserWindow, `document.querySelector('[data-settings-section=${JSON.stringify(section)}].active') && document.querySelector('.settings-section-view')`, `settings section ${section} did not render`);
    await browserWindow.webContents.executeJavaScript(`new Promise((resolve)=>setTimeout(resolve,150))`);
    const untranslated = await visibleChinese(browserWindow, '.settings-shell', { exclude: '[data-language-choice="zh-CN"]' });
    assert.deepEqual(untranslated, [], `untranslated settings section ${section}: ${JSON.stringify(untranslated)}`);
    const noHorizontalOverflow = await browserWindow.webContents.executeJavaScript(`(()=>{const shell=document.querySelector('.settings-shell');return shell.scrollWidth<=shell.clientWidth+1;})()`);
    assert.equal(noHorizontalOverflow, true, `settings section ${section} overflowed horizontally`);
    if (section === 'evolution-sync') {
      const copy = await browserWindow.webContents.executeJavaScript(`document.querySelector('.settings-section-body')?.textContent||''`);
      assert.match(copy, /After checking the cloud, all Agent Skills from the Talent catalog will appear here\./);
      assert.match(copy, /Cloud updates have not been checked yet\./);
    }
    await assertEnglishSurface(browserWindow, `settings section ${section}`);
  }

  authWindow = new BrowserWindow({ show: false, width: 980, height: 720, webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false } });
  await authWindow.loadURL(`${pathToFileURL(htmlPath).href}#auth=1`);
  await waitFor(authWindow, `document.querySelector('#login-identifier') && document.documentElement.lang==='en'`, 'English auth screen did not render');
  const auth = await authWindow.webContents.executeJavaScript(`({
    title:document.querySelector('.auth-card h2')?.textContent.trim()||'',
    signIn:document.querySelector('.auth-primary-btn')?.textContent.trim()||'',
    languageLabel:document.querySelector('.auth-language-label')?.textContent.trim()||'',
    languageTarget:document.querySelector('#auth-language-toggle')?.getAttribute('aria-label')||'',
    languageInHeading:Boolean(document.querySelector('.auth-card-heading .auth-language-toggle')),
    languageAlignedWithRegister:(()=>{const register=document.querySelector('#show-register-btn')?.getBoundingClientRect();const toggle=document.querySelector('.auth-language-toggle')?.getBoundingClientRect();return Boolean(register&&toggle&&toggle.left>register.right&&Math.abs(toggle.top-register.top)<8);})(),
    languageWidth:Math.round(document.querySelector('.auth-language-toggle')?.getBoundingClientRect().width||0),
    noHorizontalOverflow:document.querySelector('.auth-shell').scrollWidth<=document.querySelector('.auth-shell').clientWidth+1,
    untranslated:[...document.querySelectorAll('.auth-shell button, .auth-shell h1, .auth-shell h2, .auth-shell h3, .auth-shell label, .auth-shell small, .auth-shell p, .auth-shell input[placeholder]')]
      .filter((item)=>item.offsetParent!==null && !item.closest('[data-no-localize]'))
      .map((item)=>item.getAttribute('placeholder')||item.textContent.trim()).filter((text)=>/[\\u3400-\\u9fff]/.test(text)).slice(0,30),
    errors:window.__languageSmoke.errors,
  })`);
  assert.equal(auth.signIn, 'Sign In');
  assert.equal(auth.languageLabel, 'EN');
  assert.equal(auth.languageTarget, '切换至中文');
  assert.equal(auth.languageInHeading, false);
  assert.equal(auth.languageAlignedWithRegister, true);
  assert.ok(auth.languageWidth >= 56 && auth.languageWidth <= 68, `auth language toggle is not compact: ${auth.languageWidth}px`);
  assert.equal(auth.noHorizontalOverflow, true);
  assert.deepEqual(auth.untranslated, [], `untranslated auth controls: ${JSON.stringify(auth.untranslated)}`);
  assert.deepEqual(auth.errors, []);
  await assertEnglishSurface(authWindow, 'authentication screen');
  await authWindow.webContents.executeJavaScript(`document.querySelector('#auth-language-toggle')?.click()`);
  await waitFor(authWindow, `document.documentElement.lang==='zh-CN' && document.querySelector('.auth-primary-btn')?.textContent.trim()==='登录'`, 'Chinese did not apply to the login screen');
  await authWindow.webContents.executeJavaScript(`document.querySelector('#show-register-btn').click()`);
  await waitFor(authWindow, `document.querySelector('#register-form') && document.querySelector('.auth-language-label')?.textContent.trim()==='中'`, 'language toggle did not remain on the registration screen');
  assert.equal(await authWindow.webContents.executeJavaScript(`Boolean(document.querySelector('.auth-card-language-footer > .auth-language-toggle') && !document.querySelector('.auth-card-heading .auth-language-toggle'))`), true);
  await authWindow.webContents.executeJavaScript(`document.querySelector('#auth-language-toggle')?.click()`);
  await waitFor(authWindow, `document.documentElement.lang==='en' && document.querySelector('#register-form .auth-primary-btn')?.textContent.trim()==='Create Account & Sign In'`, 'English did not apply to the registration screen');
  if (screenshotDir) {
    await authWindow.webContents.executeJavaScript(`new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    writeFileSync(path.join(screenshotDir, '04-auth.png'), (await authWindow.webContents.capturePage()).toPNG());
  }
  authWindow.setSize(420, 720);
  await authWindow.webContents.executeJavaScript(`new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const narrowAuth = await authWindow.webContents.executeJavaScript(`(()=>{
    const shell=document.querySelector('.auth-shell');
    const card=document.querySelector('.auth-card');
    const title=document.querySelector('.auth-card h2')?.getBoundingClientRect();
    const toggle=document.querySelector('.auth-language-toggle')?.getBoundingClientRect();
    const overlaps=Boolean(title&&toggle&&title.left<toggle.right&&title.right>toggle.left&&title.top<toggle.bottom&&title.bottom>toggle.top);
    return {noHorizontalOverflow:shell.scrollWidth<=shell.clientWidth+1&&card.scrollWidth<=card.clientWidth+1,overlaps};
  })()`);
  assert.deepEqual(narrowAuth, { noHorizontalOverflow: true, overlaps: false });
  console.log('renderer language switch smoke passed');
} finally {
  try { authWindow?.destroy(); } catch {}
  try { browserWindow?.destroy(); } catch {}
  rmSync(tempRoot, { recursive: true, force: true });
}
