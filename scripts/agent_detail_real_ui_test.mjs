import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const outputDirectory = '/path/to/ui-pictures/test';
const testHome = mkdtempSync(path.join(os.tmpdir(), 'janus-agent-detail-real-ui-'));
const port = Number(process.env.JANUS_AGENT_DETAIL_UI_PORT || 9477);
const electronBinary = process.platform === 'win32' ? 'electron.exe' : 'electron';
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', electronBinary);
const childEnv = {
  ...process.env,
  ELECTRON_DISABLE_SANDBOX: '1',
  JANUS_LOCAL_EVOLUTION_ENABLED: '0',
  JANUS_MODEL_REFRESH_ENABLED: '0',
  JANUS_CLOUD_AUTO_SYNC_ENABLED: '0',
  JANUS_HOME: testHome,
  JANUS_AUTH_URL: '',
};
delete childEnv.ELECTRON_RUN_AS_NODE;
mkdirSync(outputDirectory, { recursive: true });
for (const name of ['01-agent-overview.png', '02-agent-memory.png', '03-agent-skill-current.png', '04-agent-skill-history.png', '03-agent-skill-versions.png', 'ui-test-result.json']) {
  rmSync(path.join(outputDirectory, name), { force: true });
}

const child = spawn(electronExe, ['--no-sandbox', `--user-data-dir=${path.join(testHome, 'profile')}`, `--remote-debugging-port=${port}`, '.'], {
  cwd: root,
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

try {
  const target = await waitForPageTarget(port, 20_000);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await waitForRenderer(cdp, `document.querySelector('[data-tab="employees"]')`, 20_000);
  await click(cdp, '[data-tab="employees"]');
  await waitForRenderer(cdp, `document.querySelector('.talent-directory-view')`, 20_000);
  await new Promise((resolve) => setTimeout(resolve, 800));

  const actualOverview = await evaluate(cdp, `window.janus.employeeOverview({ refreshCloud: false }).catch(() => null)`);
  const actualEmployee = actualOverview?.roster?.find((item) => item.agentFamilyId !== 'secretary_agent') || null;
  const agentInstanceId = actualEmployee?.id || 'agent-detail-real-ui-fixture';

  await evaluate(cdp, `(async () => {
    const { state } = await import('./app/state.js');
    const versions = [
      { id: 'market-v3-internal', parentVersionId: 'market-v2-internal', createdAt: '2026-07-30T08:30:00.000Z', status: 'released', adoption: { full: 'adopted', sections: {} }, sections: [
        { sectionId: 'task_summary', title: '任务总结', content: '完成任务后先给出结果、风险与下一步，避免输出过程噪声。', contentHash: 'summary-v3', supportCount: 18 },
        { sectionId: 'recovery', title: '失败恢复', content: '失败时保留证据，说明可恢复路径并验证最终状态。', contentHash: 'recovery-v3', supportCount: 14 },
        { sectionId: 'handoff', title: '协作交接', content: '交接时说明边界、依赖和验收标准。', contentHash: 'handoff-v3', supportCount: 11 },
      ] },
      { id: 'market-v2-internal', parentVersionId: 'market-v1-internal', createdAt: '2026-07-24T09:20:00.000Z', status: 'released', adoption: { full: '', sections: {} }, sections: [
        { sectionId: 'task_summary', title: '任务总结', content: '完成任务后提供简短结果。', contentHash: 'summary-v2', supportCount: 9 },
        { sectionId: 'recovery', title: '失败恢复', content: '失败时说明恢复路径。', contentHash: 'recovery-v2', supportCount: 8 },
      ] },
      { id: 'market-v1-internal', parentVersionId: '', createdAt: '2026-07-18T10:00:00.000Z', status: 'released', adoption: { full: '', sections: {} }, sections: [
        { sectionId: 'task_summary', title: '任务总结', content: '完成任务后提供结果。', contentHash: 'summary-v1', supportCount: 5 },
      ] },
    ];
    state.currentTab = 'employees';
    state.employeeOverview = {
      authority: 'local',
      capabilities: {
        recruitment: { enabled: true, code: 'ok' },
        multiMemory: { enabled: true, readOnly: false, code: 'ok' },
      },
      quota: { used: 1, active: 1, reserved: 0, limit: 10, remaining: 9 },
      roster: [{
        id: ${JSON.stringify(agentInstanceId)},
        agentFamilyId: 'general_agent',
        displayName: '通用 Agent A',
        note: '负责综合分析、代码修改和文件任务；交付时优先给出结论。',
        familyInstanceSeq: 1,
        employmentState: 'active',
        routeEligible: true,
        stateRevision: 1,
        queueDepth: 0,
        currentWork: null,
        family: { name: '通用 Agent', departmentId: 'general', metadata: { summary: '处理没有更合适专业 Agent 覆盖的综合任务。' } },
        currentMemory: { id: 'memory-general-ui', scope: 'general', slotNo: 0, displayName: 'memory0.md', lifecycleState: 'active', syncEnabled: true, allowPersonalEvolution: true, content: '# Stable Learnings\\n\\n- 先给结论，再说明关键依据与风险。' },
        currentContext: { activeMemoryDocumentId: 'memory-general-ui' },
        availableMarketVersions: versions,
        marketEffectiveSkill: { marketVersionId: 'market-v3-internal', fullMarketVersionId: 'market-v3-internal', adoptedSections: ['task_summary', 'recovery', 'handoff'], conflicts: [], effectiveSkillHash: 'effective-hash-ui-test' },
        performance: { level: 'P4', score: 82.6, provisional: false },
        leadership: { level: 'L1', status: 'active' },
        recentEvolution: { status: 'applied', summary: '强化任务总结、失败恢复与协作交接', updatedAt: '2026-07-30T08:30:00.000Z' },
      }],
      recruitableFamilies: [],
    };
    state.employeeSelectedInstanceId = '';
    state.employeeDetailTab = 'overview';
    state.employeeMemoryDrawer = null;
    state.employeeMarketDrawer = null;
    state.employeeGrowthDrawer = null;
    document.querySelector('[data-employee-market-department-option="all"]')?.click();
  })()`);
  await waitForRenderer(cdp, `document.querySelector('[data-employee-installed-context="${agentInstanceId}"]')`);

  await evaluate(cdp, `(() => {
    const item = document.querySelector('[data-employee-installed-context="${agentInstanceId}"]');
    const rect = item.getBoundingClientRect();
    item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 16, clientY: rect.bottom + 8 }));
  })()`);
  await waitForRenderer(cdp, `document.querySelector('[data-employee-context-action="profile"]')`);
  await click(cdp, '[data-employee-context-action="profile"]');
  await waitForRenderer(cdp, `document.querySelector('.employee-overview-drawer')`);

  const overviewProbe = await evaluate(cdp, `(() => {
    const drawer = document.querySelector('.employee-overview-drawer');
    const editor = document.querySelector('.employee-profile-editor');
    const visibleText = drawer?.innerText || '';
    return {
      width: drawer?.getBoundingClientRect().width || 0,
      height: drawer?.getBoundingClientRect().height || 0,
      editorCollapsed: Boolean(editor && !editor.open),
      hasCurrentMemory: visibleText.includes('正在使用的记忆') && visibleText.includes('主要记忆'),
      hasCurrentSkill: visibleText.includes('正在使用的 Skill') && visibleText.includes('v3'),
      hasSkillChange: visibleText.includes('新增「协作交接」') || visibleText.includes('调整「任务总结」'),
      internalIdVisible: visibleText.includes('market-v3-internal') || visibleText.includes('effective-hash-ui-test'),
    };
  })()`);
  assert.ok(overviewProbe.width >= 620 && overviewProbe.height >= 900, `overview drawer geometry is invalid: ${JSON.stringify(overviewProbe)}`);
  assert.ok(overviewProbe.editorCollapsed && overviewProbe.hasCurrentMemory && overviewProbe.hasCurrentSkill && overviewProbe.hasSkillChange,
    `overview content is incomplete: ${JSON.stringify(overviewProbe)}`);
  assert.equal(overviewProbe.internalIdVisible, false, 'overview must not expose internal version ids or hashes');
  await captureScreenshot(cdp, '01-agent-overview.png');

  await evaluate(cdp, `(async () => {
    const { state } = await import('./app/state.js');
    state.employeeSelectedInstanceId = ${JSON.stringify(agentInstanceId)};
    state.employeeDetailTab = 'memory';
    state.employeeMarketDrawer = null;
    state.employeeMemoryDrawer = {
      agentInstanceId: ${JSON.stringify(agentInstanceId)},
      loading: false,
      error: '',
      selectedDocumentId: 'memory-task-ui',
      documents: [
        { id: 'memory-general-ui', scope: 'general', slotNo: 0, displayName: 'memory0.md', lifecycleState: 'active', syncEnabled: true, allowPersonalEvolution: true, updatedAt: '2026-07-30T08:00:00.000Z', content: '# Stable Learnings\\n\\n- 先给结论，再说明关键依据与风险。' },
        { id: 'memory-task-ui', scope: 'task', displayName: 'work-progress.md', taskRunId: 'task_72c2016e-internal', lifecycleState: 'active', syncEnabled: true, allowPersonalEvolution: true, updatedAt: '2026-07-30T09:15:00.000Z', content: '# work-progress\\n\\n## Task Updates\\n\\n- 已完成 Agent 详情页重构，当前正在进行真实 UI 回归测试。\\n- 下一步检查折叠交互、版本标识和截图结果。' },
        { id: 'memory-project-ui', scope: 'project', displayName: 'Janus 界面优化.md', projectId: 'project-internal', lifecycleState: 'active', syncEnabled: true, allowPersonalEvolution: false, updatedAt: '2026-07-29T18:30:00.000Z', content: '# Janus 界面优化\\n\\n- 详情页优先展示用户能理解的状态和摘要。' },
      ],
      contexts: { current: { activeContextSpaceId: 'context-task-ui' }, items: [
        { id: 'context-general-ui', contextKind: 'general_memory', memoryDocumentId: 'memory-general-ui' },
        { id: 'context-task-ui', contextKind: 'task', taskRunId: 'task_72c2016e-internal' },
        { id: 'context-project-ui', contextKind: 'project', projectId: 'project-internal' },
      ] },
      sessionHistory: [{ id: 'session-history-ui', title: '详情页方案讨论', updatedAt: '2026-07-29T20:00:00.000Z' }],
      versions: [
        { id: 'memory-version-3-ui', memoryDocumentId: 'memory-task-ui', versionNo: 3, reviewStatus: 'approved', createdAt: '2026-07-30T09:15:00.000Z', content: '# work-progress\\n\\n## Task Updates\\n\\n- 已完成 Agent 详情页重构，当前正在进行真实 UI 回归测试。\\n- 下一步检查折叠交互、版本标识和截图结果。' },
        { id: 'memory-version-2-ui', memoryDocumentId: 'memory-task-ui', versionNo: 2, reviewStatus: 'approved', createdAt: '2026-07-30T08:40:00.000Z', content: '# work-progress\\n\\n## Task Updates\\n\\n- 已完成 Agent 详情页重构。' },
        { id: 'memory-version-1-ui', memoryDocumentId: 'memory-task-ui', versionNo: 1, reviewStatus: 'seeded', createdAt: '2026-07-29T21:10:00.000Z', content: '# work-progress\\n\\n## Task Updates\\n\\n- 开始梳理 Agent 详情页信息层级。' },
      ],
    };
    document.querySelector('[data-employee-market-department-option="all"]')?.click();
  })()`);
  await waitForRenderer(cdp, `document.querySelector('.employee-memory-document-row.is-selected')`);

  const runtimeBefore = await evaluate(cdp, `document.querySelector('.employee-memory-runtime-note')?.getBoundingClientRect().height || 0`);
  const runtimeClickPoint = await click(cdp, '.employee-memory-runtime-note > summary');
  const runtimeExpansion = await evaluate(cdp, `(() => {
    const note = document.querySelector('.employee-memory-runtime-note');
    const content = note?.querySelector('p');
    return { height: note?.getBoundingClientRect().height || 0, open: Boolean(note?.open), contentHeight: content?.getBoundingClientRect().height || 0 };
  })()`);
  assert.ok(runtimeExpansion.open && runtimeExpansion.height > runtimeBefore + 20,
    `runtime explanation did not expand: before=${runtimeBefore}, after=${JSON.stringify(runtimeExpansion)}, click=${JSON.stringify(runtimeClickPoint)}`);
  await click(cdp, '.employee-memory-runtime-note > summary');

  await click(cdp, '.employee-context-panel > summary');
  assert.equal(await evaluate(cdp, `document.querySelector('.employee-context-panel')?.open`), true);
  await click(cdp, '.employee-context-panel > summary');
  const memoryProbe = await evaluate(cdp, `(() => {
    const drawer = document.querySelector('.employee-memory-drawer');
    const selected = document.querySelector('.employee-memory-document-row.is-selected');
    const visibleText = drawer?.innerText || '';
    return {
      selectedHeight: selected?.getBoundingClientRect().height || 0,
      selectedTitle: selected?.querySelector('button strong')?.textContent?.trim() || '',
      selectedSummary: selected?.querySelector('button small')?.textContent?.trim() || '',
      hasVersionSummary: visibleText.includes('新增：已完成 Agent 详情页重构') || visibleText.includes('新增：下一步检查折叠交互'),
      internalTaskIdVisible: visibleText.includes('task_72c2016e-internal'),
      contextCollapsed: !document.querySelector('.employee-context-panel')?.open,
      hasInlineTechnicalDetails: Boolean(selected?.querySelector('.employee-technical-details, .employee-memory-tags, .employee-memory-document-body')),
    };
  })()`);
  assert.ok(memoryProbe.selectedHeight > 48 && memoryProbe.selectedHeight < 82 && memoryProbe.selectedTitle === '任务进展');
  assert.match(memoryProbe.selectedSummary, /真实 UI 回归测试/);
  assert.ok(memoryProbe.hasVersionSummary && memoryProbe.contextCollapsed);
  assert.equal(memoryProbe.internalTaskIdVisible, false, 'task ids must not be visible in the default memory view');
  assert.equal(memoryProbe.hasInlineTechnicalDetails, false, 'memory rows must remain compact and free of inline technical controls');
  await captureScreenshot(cdp, '02-agent-memory.png');

  await evaluate(cdp, `(async () => {
    const { state } = await import('./app/state.js');
    const versions = state.employeeOverview.roster[0].availableMarketVersions;
    state.employeeSelectedInstanceId = '';
    state.employeeMemoryDrawer = null;
    state.employeeMarketDrawer = {
      source: 'employees',
      agentInstanceId: ${JSON.stringify(agentInstanceId)},
      agentFamilyId: 'general_agent',
      familyName: '通用 Agent',
      recruited: true,
      loading: false,
      busy: false,
      error: '',
      conflictPreview: null,
      canary: { optedIn: false, assignments: [] },
      effectiveSkill: { marketVersionId: 'market-v3-internal', fullMarketVersionId: 'market-v3-internal', adoptedSections: ['task_summary', 'recovery', 'handoff'], conflicts: [], effectiveSkillHash: 'effective-hash-ui-test', effectiveSkill: '# 通用 Agent Skill\\n\\n- 优先给出结论。\\n- 失败时说明恢复路径。\\n- 协作交接包含边界和验收标准。' },
      items: versions,
    };
    document.querySelector('[data-employee-market-department-option="all"]')?.click();
  })()`);
  await waitForRenderer(cdp, `document.querySelector('.employee-market-version.is-current')`);
  await evaluate(cdp, `(() => { const drawer = document.querySelector('.employee-market-drawer'); if (drawer) drawer.scrollTop = 0; })()`);
  await new Promise((resolve) => setTimeout(resolve, 180));
  await captureScreenshot(cdp, '03-agent-skill-current.png');
  await click(cdp, '.employee-market-version:not(.is-current) > summary');
  const skillProbe = await evaluate(cdp, `(() => {
    const drawer = document.querySelector('.employee-market-drawer');
    const visibleText = drawer?.innerText || '';
    return {
      currentOpen: Boolean(document.querySelector('.employee-market-version.is-current')?.open),
      expandedHistory: document.querySelectorAll('.employee-market-version[open]').length,
      hasCurrentVersion: visibleText.includes('v3') && visibleText.includes('当前使用'),
      hasChangeSummary: visibleText.includes('新增「协作交接」') && visibleText.includes('调整「任务总结」'),
      internalIdVisible: visibleText.includes('market-v3-internal'),
      versionUseButtons: document.querySelectorAll('[data-market-adopt-full]').length,
      sectionUseButtons: document.querySelectorAll('[data-market-adopt]').length,
      advancedCollapsed: !document.querySelector('.employee-skill-advanced')?.open,
      canaryVisible: visibleText.includes('候选版本会在受控真实任务中临时试用'),
    };
  })()`);
  assert.ok(skillProbe.currentOpen && skillProbe.expandedHistory >= 2 && skillProbe.hasCurrentVersion && skillProbe.hasChangeSummary
    && skillProbe.versionUseButtons === 2 && skillProbe.sectionUseButtons === 0 && skillProbe.advancedCollapsed && !skillProbe.canaryVisible,
    `skill version UI is incomplete: ${JSON.stringify(skillProbe)}`);
  assert.equal(skillProbe.internalIdVisible, false, 'skill ids must remain inside collapsed technical details');
  await captureScreenshot(cdp, '04-agent-skill-history.png');

  writeFileSync(path.join(outputDirectory, 'ui-test-result.json'), `${JSON.stringify({
    passed: true,
    testedAt: new Date().toISOString(),
    electronProcess: child.pid,
    usedRealLocalAgentInstance: Boolean(actualEmployee),
    agentInstanceId,
    screenshots: ['01-agent-overview.png', '02-agent-memory.png', '03-agent-skill-current.png', '04-agent-skill-history.png'],
    probes: { overview: overviewProbe, memory: memoryProbe, skill: skillProbe },
  }, null, 2)}\n`);
  cdp.close();
  console.log(`agent detail real UI test passed; screenshots: ${outputDirectory}`);
} catch (error) {
  throw new Error(`${error.message}\nElectron stderr:\n${stderr.slice(-5000)}`);
} finally {
  if (child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => {
      child.once('exit', resolve);
      setTimeout(resolve, 2_000);
    });
  }
  try { rmSync(testHome, { recursive: true, force: true }); } catch {}
}

async function captureScreenshot(cdp, name) {
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(path.join(outputDirectory, name), Buffer.from(screenshot.data, 'base64'));
}

async function click(cdp, selector) {
  const point = await evaluate(cdp, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
  })()`);
  if (!point || point.width <= 0 || point.height <= 0) throw new Error(`Unable to click selector: ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 180));
  return point;
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed');
  return result.result?.value;
}

async function waitForRenderer(cdp, expression, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, `Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for renderer expression: ${expression}`);
}

async function waitForPageTarget(debugPort, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      const page = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Electron is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for Electron renderer.');
}

function connectCdp(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    if (!payload.id || !pending.has(payload.id)) return;
    const request = pending.get(payload.id);
    pending.delete(payload.id);
    if (payload.error) request.reject(new Error(payload.error.message || 'CDP request failed'));
    else request.resolve(payload.result || {});
  });
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const id = nextId++;
        const response = new Promise((requestResolve, requestReject) => pending.set(id, { resolve: requestResolve, reject: requestReject }));
        socket.send(JSON.stringify({ id, method, params }));
        return response;
      },
      close() { socket.close(); },
    }), { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP connection failed')), { once: true });
  });
}
