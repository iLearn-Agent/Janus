import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const outputRoot = path.join(root, 'docs', 'ubuddy-core-guide');
const screenshotRoot = path.join(outputRoot, 'screenshots');
const fullScreenshotRoot = path.join(root, 'docs', 'ubuddy-manual', 'screenshots');
const fullManifestPath = path.join(root, 'docs', 'ubuddy-manual', 'screenshot-manifest.json');
const latestFullCaptureIndexPath = path.join(fullScreenshotRoot, 'capture-index.json');
const coreCaptureIndexPath = path.join(screenshotRoot, 'capture-index.json');
const manifestPath = path.join(outputRoot, 'core-guide-manifest.json');
const htmlPath = path.join(outputRoot, 'ubuddy-core-interfaces-guide.zh-CN.html');
const pdfPath = path.join(outputRoot, 'ubuddy-core-interfaces-guide.zh-CN.pdf');
const args = new Set(process.argv.slice(2));
const mode = args.has('--capture-only') ? 'capture' : args.has('--build-only') ? 'build' : args.has('--verify-only') ? 'verify' : 'all';

mkdirSync(screenshotRoot, { recursive: true });
if (mode === 'all' || mode === 'capture') await run(process.execPath, ['scripts/ubuddy_core_guide_capture.mjs']);
if (mode === 'capture') process.exit(0);
if (mode === 'all' || mode === 'build') { buildGuide(); await printPdf(); }
verifyGuide();

function buildGuide() {
  assert.ok(existsSync(fullManifestPath), '完整版截图标注清单不存在。');
  assert.ok(existsSync(coreCaptureIndexPath), '精简版新增截图索引不存在。');
  const fullManifest = JSON.parse(readFileSync(fullManifestPath, 'utf8'));
  const latestFullCapture = existsSync(latestFullCaptureIndexPath) ? JSON.parse(readFileSync(latestFullCaptureIndexPath, 'utf8')) : { captures: [] };
  const coreCapture = JSON.parse(readFileSync(coreCaptureIndexPath, 'utf8'));
  const fullByFile = new Map(fullManifest.screenshots.map((item) => [item.filename, item]));
  const latestFullByFile = new Map((latestFullCapture.captures || []).map((item) => [item.filename, item]));
  const coreByFile = new Map(coreCapture.captures.map((item) => [item.filename, item]));

  copyFileSync(path.join(fullScreenshotRoot, '04-chat-main.png'), path.join(screenshotRoot, '01-ubuddy-private-chat.png'));
  copyFileSync(path.join(fullScreenshotRoot, '31-collaboration-group-main.png'), path.join(screenshotRoot, '02-public-group-chat.png'));
  copyFileSync(path.join(fullScreenshotRoot, '17-planning-collaboration-plan.png'), path.join(screenshotRoot, '04-multi-task-publish.png'));
  for (const [source, target] of [
    ['25-task-workspace-activity.png', '06-task-board-activity.png'],
    ['26-task-workspace-result.png', '07-task-board-result.png'],
    ['27-task-workspace-result-expanded.png', '08-task-board-result-details.png'],
    ['28-task-workspace-flow.png', '09-task-board-flow.png'],
    ['29-task-workspace-technical.png', '10-task-board-technical.png'],
    ['30-task-workspace-failure.png', '11-task-board-failure.png'],
  ]) copyFileSync(path.join(fullScreenshotRoot, source), path.join(screenshotRoot, target));

  const chapters = [
    makeChapter(1, 'uBuddy 私聊界面', '01-ubuddy-private-chat.png', fullByFile.get('04-chat-main.png'), '用于直接告诉 uBuddy 目标、切换 Task/Ask、选择 Agent、项目、Memory、权限并发送任务。', '选择 Task 模式 → 输入任务要求 → 根据需要添加联系人、文件或项目 → 检查模型和权限 → 点击发送。'),
    makeChapter(2, '公共任务群聊界面', '02-public-group-chat.png', latestFullByFile.get('31-collaboration-group-main.png') || fullByFile.get('31-collaboration-group-main.png'), '多人协作时的公开沟通区域。群消息、共享目标、成员和公开任务进度对群成员可见。', '查看共享目标和成员 → 在群消息中 @ 对应 uBuddy → 发送公开要求 → 通过“查看任务”进入具体任务。'),
    makeChapter(3, '单个联系人任务发布界面', '03-single-contact-publish.png', coreByFile.get('03-single-contact-publish.png'), '将任务交给一个明确联系人及其 uBuddy。系统不会仅凭聊天历史自动选择接收人。', '选择“@ 联系人完成” → 搜索并点击联系人 → 检查输入框中的任务要求和 @ 对象 → 点击发送。'),
    makeChapter(4, '多人任务发布界面', '04-multi-task-publish.png', fullByFile.get('17-planning-collaboration-plan.png'), 'uBuddy 根据任务目标拆分多人分工，并在真正派发前让发起人确认或修改。', '检查每位参与者的分工 → 必要时修改或改为全员参与 → 点击“确认派发”创建任务。'),
    makeChapter(5, '已发布任务卡及内部节点', '05-published-task-card.png', coreByFile.get('05-published-task-card.png'), '任务发布后显示当前负责人、总体进度和公开节点。截图已展开任务卡内部的“公开节点状态”，可看到已完成节点、执行中节点和完成比例。', '展开公开节点状态查看进度 → 打开任务工作区继续沟通 → 需要时查看流程图或取消任务。'),
    makeChapter(6, '任务执行看板：动态', '06-task-board-activity.png', latestFullByFile.get('25-task-workspace-activity.png') || fullByFile.get('25-task-workspace-activity.png'), '集中展示当前状态、执行节点、过程记录、补充消息和底部任务沟通输入框。', '从任务卡打开任务工作区 → 默认进入“动态” → 查看当前进度或在底部追加要求。'),
    makeChapter(7, '任务执行看板：结果', '07-task-board-result.png', latestFullByFile.get('26-task-workspace-result.png') || fullByFile.get('26-task-workspace-result.png'), '查看当前交付版本、质量检查建议、交付文件和验收入口。', '切换到“结果” → 检查摘要和文件 → 展开质量建议或正文 → 决定验收或继续修改。'),
    makeChapter(8, '任务执行看板：结果内部详情', '08-task-board-result-details.png', latestFullByFile.get('27-task-workspace-result-expanded.png') || fullByFile.get('27-task-workspace-result-expanded.png'), '展示结果卡内部展开后的质量建议、正文和文件详情，便于核对任务卡内部信息。', '在结果页展开“质量检查建议”和“查看正文” → 核对内容与文件 → 返回结果页继续验收。'),
    makeChapter(9, '任务执行看板：流程图', '09-task-board-flow.png', latestFullByFile.get('28-task-workspace-flow.png') || fullByFile.get('28-task-workspace-flow.png'), '按节点展示任务拆解、依赖关系、负责人和每个节点的执行状态。', '切换到“流程图” → 查看节点顺序和状态 → 根据受阻节点返回动态页补充要求。'),
    makeChapter(10, '任务执行看板：技术详情', '10-task-board-technical.png', latestFullByFile.get('29-task-workspace-technical.png') || fullByFile.get('29-task-workspace-technical.png'), '展示任务、节点和执行事件的技术级信息，用于排查执行问题。', '在动态页点击“查看技术详情” → 检查节点状态和事件 → 再次点击收起。'),
    makeChapter(11, '任务执行看板：失败诊断', '11-task-board-failure.png', latestFullByFile.get('30-task-workspace-failure.png') || fullByFile.get('30-task-workspace-failure.png'), '任务失败时显示最后一次报错、失败节点、相关命令和可恢复信息。', '查看最后一次报错 → 展开技术详情确认失败节点 → 修正要求或使用可用的重试入口。'),
  ];
  const manifest = { generatedAt: new Date().toISOString(), chapterCount: chapters.length, controlCount: chapters.reduce((sum, item) => sum + item.controls.length, 0), chapters };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const generated = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>uBuddy 核心界面与任务执行看板指南</title><link rel="stylesheet" href="core-guide.css"></head><body>
    <section class="cover"><span class="kicker">uBuddy CORE INTERFACES</span><h1>uBuddy 核心界面与任务执行看板指南</h1><p>覆盖私聊、正确的公共任务群聊、单联系人任务发布、多人任务发布、任务卡内部节点，以及任务工作区的动态、结果、流程图、技术详情和失败诊断。</p><div class="meta">生成时间：${escapeHtml(generated)}<br>截图数据：隔离演示账号与合成任务，不包含真实聊天、联系人或项目内容<br>完整版手册保持不变</div></section>
    <section class="intro"><h1>本手册包含什么</h1><ol>${chapters.map((item) => `<li><strong>${escapeHtml(item.title)}</strong><br>${escapeHtml(item.purpose)}</li>`).join('')}</ol><p class="note">红色编号与按钮表一一对应。只介绍与 uBuddy 工作流直接相关的按钮，不扩展普通账号设置、星标或备注等宿主功能。</p></section>
    ${chapters.map(renderChapter).join('\n')}
    <section class="sources"><h1>说明</h1><p>本精简版独立生成，不覆盖现有完整版。界面按钮随任务状态变化：例如任务完成后，“取消任务”会隐藏，并出现查看结果或验收按钮。</p><p><code>scripts/ubuddy_core_guide_capture.mjs</code> 负责新增截图，<code>scripts/generate_ubuddy_core_guide.mjs</code> 负责生成 HTML、PDF 和标注清单。</p></section>
  </body></html>`;
  writeFileSync(htmlPath, html);
}

function makeChapter(index, title, filename, source, purpose, flow) {
  assert.ok(source, `Missing source metadata for ${title}`);
  const sourceControls = source.controls?.length ? source.controls : fallbackCoreControls(filename);
  let controls = sourceControls.map((control) => normalizeControl(control));
  if (index === 1) controls = controls.filter((item) => !['复制消息', '复制回答', '更多操作'].includes(item.label));
  if (index === 2) controls = controls.filter((item) => !['复制消息', '更多操作', '查看林然的简介'].includes(item.label));
  if (index === 3) controls = controls.filter((item) => {
    const attrs = item.attributes || {};
    return attrs['data-ubuddy-execution-target'] !== undefined
      || attrs['data-project-reference-query'] !== undefined
      || attrs['data-ubuddy-mention-user'] !== undefined
      || attrs['data-social-mention-toggle'] !== undefined
      || attrs.id === 'chat-input'
      || attrs.type === 'submit';
  });
  controls = controls.map((control, controlIndex) => ({ ...control, number: controlIndex + 1, action: describe(control) }));
  return { index, title, filename, purpose, flow, viewport: source.viewport || { width: 1600, height: 1000 }, controls };
}

function fallbackCoreControls(filename) {
  if (filename === '03-single-contact-publish.png') return [
    { label: '本地完成', tag: 'button', x: 45, y: 31, width: 285, height: 78, attributes: { 'data-ubuddy-execution-target': 'local' } },
    { label: '@ 联系人完成', tag: 'button', x: 65, y: 31, width: 285, height: 78, attributes: { 'data-ubuddy-execution-target': 'contact' } },
    { label: '@ 联系人', tag: 'button', x: 45, y: 90, width: 80, height: 34, attributes: { 'data-social-mention-toggle': '' } },
    { label: '搜索联系人', tag: 'input', x: 54, y: 67, width: 390, height: 36, attributes: { 'data-project-reference-query': '' } },
    { label: '选择联系人：林然', tag: 'button', x: 54, y: 74, width: 380, height: 44, attributes: { 'data-ubuddy-mention-user': 'core-peer-linran' } },
    { label: '选择联系人：周宁', tag: 'button', x: 54, y: 80, width: 380, height: 44, attributes: { 'data-ubuddy-mention-user': 'core-peer-zhouning' } },
    { label: '任务要求输入框', tag: 'textarea', x: 65, y: 86, width: 1000, height: 40, attributes: { id: 'chat-input' } },
    { label: '发送', tag: 'button', x: 95, y: 91, width: 34, height: 34, attributes: { type: 'submit' } },
  ];
  if (filename === '05-published-task-card.png') return [
    { label: '公开节点状态', tag: 'summary', x: 54, y: 45, width: 820, height: 150, attributes: {} },
    { label: '打开任务工作区', tag: 'button', x: 44, y: 56, width: 110, height: 36, attributes: { 'data-task-card-action': 'open_workspace' } },
    { label: '查看流程图', tag: 'button', x: 53, y: 56, width: 90, height: 36, attributes: { 'data-task-card-action': 'open_flow_graph' } },
    { label: '取消任务', tag: 'button', x: 62, y: 56, width: 90, height: 36, attributes: { 'data-task-card-action': 'cancel_task' } },
  ];
  return [];
}

function normalizeControl(control) {
  const attrs = control.attributes || {};
  let label = String(control.label || '').trim();
  if (attrs['data-collaboration-group-workspace'] !== undefined) label = '群共享工作区';
  if (attrs['data-collaboration-group-rename'] !== undefined) label = '修改群名称';
  if (attrs['data-collaboration-group-add-member'] !== undefined) label = '添加成员';
  if (attrs['data-collaboration-group-close'] !== undefined) label = '结束工作群';
  if (attrs['data-ubuddy-mention-user']) label = label.includes('林然') ? '选择联系人：林然' : label.includes('周宁') ? '选择联系人：周宁' : '选择联系人';
  if (attrs['data-ubuddy-execution-target'] === 'local') label = '本地完成';
  if (attrs['data-ubuddy-execution-target'] === 'contact') label = '@ 联系人完成';
  return { ...control, label, attributes: attrs };
}

function describe(control) {
  const label = control.label; const attrs = control.attributes || {};
  if (attrs['data-ubuddy-execution-target'] === 'local') return '改为由 uBuddy 选择一个本机 Agent 执行，不进入联系人选择。';
  if (attrs['data-ubuddy-execution-target'] === 'contact') return '打开联系人选择器，要求用户明确选择任务接收人。';
  if (attrs['data-project-reference-query'] !== undefined) return '按姓名或用户名筛选联系人列表。';
  if (attrs['data-ubuddy-mention-user']) return `把${label.replace('选择联系人：', '')}设为任务接收人，并将 @ 对象加入输入框。`;
  if (attrs['data-task-card-action'] === 'open_workspace') return '进入该任务的独立工作区，查看动态、结果并继续沟通。';
  if (attrs['data-task-card-action'] === 'open_flow_graph') return '直接打开任务流程图，查看节点依赖和执行状态。';
  if (attrs['data-task-card-action'] === 'cancel_task') return '请求取消当前任务；确认后停止尚未完成的执行。';
  if (attrs['data-task-card-action'] === 'return_to_source_chat') return '返回创建该任务的原始 uBuddy 对话。';
  if (attrs['data-task-workspace-view'] === 'activity') return '切换到动态看板，查看当前状态、执行记录和补充消息。';
  if (attrs['data-task-workspace-view'] === 'result') return '切换到结果看板，查看交付版本、文件和质量建议。';
  if (attrs['data-task-workspace-view'] === 'flow') return '切换到流程图看板，查看任务节点和依赖关系。';
  if (attrs['data-preview-file'] !== undefined) return '在应用内预览对应交付文件。';
  if (attrs['data-open-file'] !== undefined) return '使用系统默认应用打开对应文件。';
  if (attrs['data-save-file'] !== undefined) return '选择保存位置并下载对应文件。';
  if (attrs['data-show-file'] !== undefined) return '在系统文件管理器中定位对应文件。';
  if (attrs['data-collaboration-search-toggle'] !== undefined) return '打开群消息和协作进度搜索。';
  if (attrs['data-collaboration-members-toggle'] !== undefined) return '查看群成员、每位成员的 uBuddy 和参与 Agent。';
  if (attrs['data-collaboration-group-workspace'] !== undefined) return '打开群成员共同可见的文件工作区。';
  if (attrs['data-collaboration-group-rename'] !== undefined) return '修改当前工作群名称。';
  if (attrs['data-collaboration-group-add-member'] !== undefined) return '选择新成员加入群聊，并按需要创建对应任务。';
  if (attrs['data-collaboration-group-close'] !== undefined) return '停止未完成任务并结束工作群；历史消息保留为只读记录。';
  if (attrs['data-message-home-back'] !== undefined) return '返回消息列表。';
  if (attrs['data-collaboration-details-toggle'] !== undefined) return '展开右侧任务详情和参与者进度。';
  if (attrs['data-composer-add-files'] !== undefined || /上传文件/.test(label)) return '选择文件并作为当前消息或任务补充材料上传。';
  if (attrs['data-social-mention-toggle'] !== undefined) return '打开 @ 选择器，选择联系人、Agent 或其他可提及对象。';
  if (attrs['data-composer-tool-menu-toggle'] !== undefined) return '打开附件、文件和其他输入工具菜单。';
  if (attrs['data-ubuddy-message-mode-toggle'] !== undefined) return '在 Task 与 Ask 模式之间切换；Task 用于创建和执行任务。';
  if (attrs['data-composer-image-mode'] !== undefined) return '切换到图像生成输入模式。';
  if (attrs.id === 'model-picker-trigger') return '选择模型和推理强度。';
  if (attrs['data-agent-inline-trigger'] !== undefined) return '选择由哪个本机 Agent 直接参与当前任务。';
  if (attrs['data-workspace-menu-toggle'] !== undefined) return '选择任务使用的项目或文件工作区。';
  if (attrs['data-chat-clear-context'] !== undefined) return '整理或清除当前线程上下文，开始新的上下文段。';
  if (attrs['data-composer-memory-toggle'] !== undefined) return '切换、创建或保存当前 uBuddy Memory。';
  if (attrs.id === 'sandbox-permission-trigger') return '设置任务执行权限和审批方式。';
  if (attrs['data-task-card-action'] === 'open_workspace') return '打开对应任务。';
  if (/确认派发/.test(label)) return '按照当前多人分工创建并派发任务。';
  if (label === '修改') return '返回规划流程，补充修改要求并重新生成分工。';
  if (/全员参与/.test(label)) return '覆盖自动筛选，让所有候选参与本次任务。';
  if (label === '取消') return '取消本次多人协作方案，不派发任何任务。';
  if (/公开节点状态/.test(label)) return '展开或收起接收方允许公开的任务节点和完成比例。';
  if (/查看技术详情/.test(label)) return '展开或收起节点状态、执行事件和失败诊断等技术信息。';
  if (/查看正文/.test(label)) return '展开或收起当前交付版本的正文内容。';
  if (/查看任务/.test(label)) return '打开该成员负责的任务工作区。';
  if (/共享目标|形成可用于/.test(label)) return '展开最终目标、交付物、验收标准、约束和截止时间。';
  if (/更多操作/.test(label)) return '打开当前界面的更多操作菜单。';
  if (control.tag === 'textarea' || control.tag === 'input') return '输入任务要求、补充说明或群消息。';
  if (attrs.type === 'submit' || label === '发送') return '发送当前内容；Task 模式下由 uBuddy 继续规划或发布任务。';
  return `执行“${label}”对应的界面操作。`;
}

function renderChapter(chapter) {
  const markers = chapter.controls.map((item) => { const position = markerPosition(item, chapter.viewport); return `<span class="marker" style="left:${position.x.toFixed(2)}%;top:${position.y.toFixed(2)}%">${item.number}</span>`; }).join('');
  const rows = chapter.controls.map((item) => `<tr><td>${item.number}</td><td>${escapeHtml(item.label)}</td><td>${escapeHtml(item.action)}</td></tr>`).join('');
  return `<section class="chapter"><div class="chapter-head"><h1>${chapter.index}. ${escapeHtml(chapter.title)}</h1><span>${escapeHtml(chapter.filename)}</span></div><p class="purpose">${escapeHtml(chapter.purpose)}</p><figure class="shot"><img src="screenshots/${chapter.filename}" alt="${escapeHtml(chapter.title)}">${markers}</figure><h2>按钮说明</h2><table><thead><tr><th>编号</th><th>按钮或控件</th><th>点击后发生什么</th></tr></thead><tbody>${rows}</tbody></table><p class="flow"><strong>最短操作流程：</strong>${escapeHtml(chapter.flow)}</p></section>`;
}

function markerPosition(item, viewport = { width: 1600, height: 1000 }) {
  const width = Number(item.width || 0);
  const height = Number(item.height || 0);
  // x/y in the capture manifest are control centers. Put the marker just
  // outside the control's upper-left corner so the red number never covers
  // the button label or icon (especially in the private-chat composer).
  const x = Number(item.x || 0) - (width ? (width / Number(viewport.width || 1600)) * 50 : 1.2) - 0.95;
  const y = Number(item.y || 0) - (height ? (height / Number(viewport.height || 1000)) * 50 : 1.2) - 1.45;
  return { x: Math.max(1.8, Math.min(98.2, x)), y: Math.max(1.8, Math.min(98.2, y)) };
}

async function printPdf() {
  const chrome = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find(existsSync);
  assert.ok(chrome, 'Chrome/Chromium not found.');
  const profile = mkdtempSync(path.join(os.tmpdir(), 'janus-ubuddy-core-pdf-')); const port = 9628;
  const child = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, `file://${encodeURI(htmlPath)}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let cdp;
  try {
    const target = await waitForTarget(port, 30_000); cdp = await connectCdp(target.webSocketDebuggerUrl); await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await waitForCdp(cdp, `document.readyState === 'complete' && [...document.images].every((image) => image.complete && image.naturalWidth > 0)`, 30_000);
    const probe = await evalCdp(cdp, `({ overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2, broken: [...document.images].filter((image) => !image.naturalWidth).length })`);
    assert.equal(probe.overflow, false); assert.equal(probe.broken, 0);
    const result = await cdp.send('Page.printToPDF', { landscape: true, printBackground: true, preferCSSPageSize: true, generateTaggedPDF: true, generateDocumentOutline: true });
    writeFileSync(pdfPath, Buffer.from(result.data, 'base64'));
  } finally {
    try { cdp?.close(); } catch {} try { child.kill('SIGTERM'); } catch {}
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(5000)]);
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch {} }
    for (let i = 0; i < 5; i++) { try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); break; } catch (error) { if (i === 4) throw error; await sleep(250); } }
  }
}

function verifyGuide() {
  for (const file of [manifestPath, htmlPath, pdfPath]) assert.ok(existsSync(file), `Missing ${file}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.chapterCount, 11); assert.ok(manifest.controlCount >= 50 && manifest.controlCount <= 130, `Unexpected control count: ${manifest.controlCount}`);
  for (const chapter of manifest.chapters) { const image = path.join(screenshotRoot, chapter.filename); assert.ok(existsSync(image) && statSync(image).size > 30_000, `Invalid screenshot: ${chapter.filename}`); assert.ok(chapter.controls.length > 0, `No controls: ${chapter.title}`); assert.equal(new Set(chapter.controls.map((item) => item.number)).size, chapter.controls.length); }
  const pdf = readFileSync(pdfPath); assert.equal(pdf.subarray(0, 4).toString(), '%PDF'); assert.ok(pdf.length > 500_000); assert.equal(pdf.subarray(-6).toString('latin1'), '%%EOF\n');
  console.log(JSON.stringify({ passed: true, chapters: manifest.chapterCount, controls: manifest.controlCount, html: htmlPath, pdf: pdfPath, pdfBytes: pdf.length }, null, 2));
}

function escapeHtml(value = '') { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
async function run(command, commandArgs) { await new Promise((resolve, reject) => { const child = spawn(command, commandArgs, { cwd: root, env: process.env, stdio: 'inherit' }); child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))); }); }
async function waitForTarget(port, timeout) { const end = Date.now() + timeout; while (Date.now() < end) { try { const response = await fetch(`http://127.0.0.1:${port}/json/list`); const pages = await response.json(); const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl); if (page) return page; } catch {} await sleep(150); } throw new Error('Timed out waiting for Chrome.'); }
async function connectCdp(url) { const socket = new WebSocket(url); const pending = new Map(); let id = 1; await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); }); socket.addEventListener('message', (event) => { const message = JSON.parse(event.data); const waiter = pending.get(message.id); if (!waiter) return; pending.delete(message.id); message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result || {}); }); return { send(method, params = {}) { const next = id++; return new Promise((resolve, reject) => { pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, params })); }); }, close() { socket.close(); } }; }
async function evalCdp(cdp, expression) { const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result?.value; }
async function waitForCdp(cdp, expression, timeout) { const end = Date.now() + timeout; while (Date.now() < end) { if (await evalCdp(cdp, `Boolean(${expression})`)) return; await sleep(150); } throw new Error(`Timed out waiting for ${expression}`); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
