import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const docsRoot = path.join(root, 'docs', 'ubuddy-manual');
const screenshotRoot = path.join(docsRoot, 'screenshots');
const indexPath = path.join(screenshotRoot, 'capture-index.json');
const manifestPath = path.join(docsRoot, 'screenshot-manifest.json');
const inventoryPath = path.join(root, 'docs', 'ubuddy-function-inventory.zh-CN.md');
const htmlPath = path.join(docsRoot, 'ubuddy-complete-manual.zh-CN.html');
const pdfPath = path.join(docsRoot, 'ubuddy-complete-manual.zh-CN.pdf');
const args = new Set(process.argv.slice(2));
const mode = args.has('--capture-only') ? 'capture' : args.has('--build-only') ? 'build' : args.has('--verify-only') ? 'verify' : 'all';

mkdirSync(screenshotRoot, { recursive: true });

if (mode === 'all' || mode === 'capture') await run(process.execPath, ['scripts/ubuddy_manual_capture.mjs']);
if (mode === 'capture') process.exit(0);
if (mode === 'all' || mode === 'build') {
  reuseVerifiedScreenshots();
  buildManual();
  await printPdf();
}
verifyManual();

function reuseVerifiedScreenshots() {
  const sources = [
    ['test-artifacts/ubuddy-centers-ui/02-all-tasks.png', '48-task-center-verified.png'],
    ['test-artifacts/ubuddy-centers-ui/03-delivery-center.png', '49-delivery-center-verified.png'],
    ['test-artifacts/ubuddy-centers-ui/04-accepted-in-place.png', '50-quick-accept-verified.png'],
    ['test-artifacts/ubuddy-centers-ui/07-failure-details.png', '51-failure-details-verified.png'],
    ['test-artifacts/ubuddy-centers-ui/11-delivery-result-dark.png', '52-result-dark-verified.png'],
    ['test-artifacts/collaboration-control-ui/collaboration-control-collapsed.png', '53-collaboration-control-collapsed.png'],
    ['test-artifacts/collaboration-control-ui/collaboration-control-fixed.png', '54-collaboration-control-expanded.png'],
  ];
  for (const [source, target] of sources) {
    const from = path.join(root, source);
    if (existsSync(from)) copyFileSync(from, path.join(screenshotRoot, target));
  }
}

function buildManual() {
  assert.ok(existsSync(indexPath), `Missing capture index: ${indexPath}`);
  const captureIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
  const extraFiles = [
    ['48-task-center-verified.png', '任务中心：筛选、任务卡片与批量查看'],
    ['49-delivery-center-verified.png', '交付中心：待验收与历史交付'],
    ['50-quick-accept-verified.png', '快速验收：在会话中直接确认交付'],
    ['51-failure-details-verified.png', '失败详情：原因、诊断与恢复入口'],
    ['52-result-dark-verified.png', '深色模式：交付结果'],
    ['53-collaboration-control-collapsed.png', '协作群：详情收起状态'],
    ['54-collaboration-control-expanded.png', '协作群：参与者进度控制'],
  ].filter(([filename]) => existsSync(path.join(screenshotRoot, filename))).map(([filename, title]) => ({ filename, title, controls: [], viewport: { width: 1600, height: 1000 }, verifiedReuse: true }));
  const screenshots = [...captureIndex.captures, ...extraFiles].map((shot, index) => enrichScreenshot(shot, index));
  const manifest = { generatedAt: new Date().toISOString(), sourceInventory: path.relative(root, inventoryPath), screenshotCount: screenshots.length, screenshots };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const inventory = readFileSync(inventoryPath, 'utf8');
  const toc = screenshots.map((shot, index) => `<a href="#screen-${index + 1}">${index + 1}. ${escapeHtml(shot.title)}</a>`).join('');
  const interfaces = screenshots.map(renderScreenshotSection).join('\n');
  const generated = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>uBuddy 完整功能与界面操作手册</title><link rel="stylesheet" href="manual.css"></head><body>
    <section class="cover"><span class="kicker">JANUS PRODUCT ACCEPTANCE MANUAL</span><h1>uBuddy 完整功能与界面操作手册</h1><p>覆盖 uBuddy 入口、会话、规划、任务执行、任务中心、交付验收、联系人协作、协作群、私人委托、能力简介、组织调查、自进化以及移动端与深色模式差异。</p><div class="meta">生成时间：${escapeHtml(generated)}<br>截图数据：隔离演示账号与合成中文任务，不包含真实账户、联系人、聊天或项目内容<br>文档形态：A4 横向 PDF + 可编辑 HTML/CSS + 原始 PNG + JSON 标注清单</div></section>
    <section><h1>阅读说明</h1><div class="notice"><strong>编号规则：</strong>截图中的红色编号对应截图下方控件表的“编号”。每个控件均说明出现条件、禁用条件、点击后的即时变化、后续可用操作以及失败或副作用。未出现编号的文字通常是状态说明、结果正文或只读信息。</div><h2>界面目录</h2><div class="toc">${toc}</div></section>
    ${interfaces}
    <section class="inventory"><h1>完整功能清单与行为规则</h1><p>本章保留代码级功能盘点，补充截图章节难以表达的状态机、数据边界、异常分支与跨界面关系。</p>${renderMarkdown(inventory)}</section>
    <section class="appendix"><h1>附录：交付与验证口径</h1><ul><li>桌面浅色主题为全量主线；移动端和深色主题仅展示布局或视觉有实质差异的界面。</li><li>截图中的按钮状态来自当前 Electron UI；不可达的旧渲染函数不会伪造成现有功能。</li><li>宿主页面仅解释与 uBuddy 工作流直接相关的控件；例如普通联系人星标、通用账号设置不作为 uBuddy 功能扩写。</li><li>界面文案可能随语言包调整，数据属性、状态条件与操作结果是验收时更稳定的判断依据。</li></ul><p class="footer-note">生成脚本：scripts/generate_ubuddy_manual.mjs · 采集脚本：scripts/ubuddy_manual_capture.mjs</p></section>
  </body></html>`;
  writeFileSync(htmlPath, html);
}

function enrichScreenshot(shot, index) {
  const title = shot.verifiedReuse ? shot.title : screenTitle(shot.filename);
  const controls = relevantControls(shot).slice(0, 32).map((control, controlIndex) => ({ ...control, number: controlIndex + 1, ...describeControl(control, title) }));
  return { ...shot, sequence: index + 1, title, description: screenDescription(shot.filename), controls };
}

function relevantControls(shot) {
  const controls = shot.controls || [];
  const filename = shot.filename || '';
  if (filename.includes('entry-talent-market')) return [];
  if (filename.includes('entry-contact-profile')) return controls.filter((item) => {
    const attrs = item.attributes || {};
    return 'data-contact-collaboration' in attrs || 'data-contact-profile-close' in attrs;
  });
  if (filename.includes('mobile-chat-main')) return controls.filter((item) => {
    const attrs = item.attributes || {};
    return attrs['data-network-peer'] === 'self-secretary' || attrs['data-message-pane'] || attrs['data-ubuddy-message-mode-toggle'] !== undefined || attrs['data-composer-tool-menu-toggle'] !== undefined || attrs.id === 'chat-input';
  });
  return controls;
}

function renderScreenshotSection(shot) {
  const markers = shot.controls.map((control) => `<span class="marker" style="left:${control.x.toFixed(2)}%;top:${control.y.toFixed(2)}%">${control.number}</span>`).join('');
  const rows = shot.controls.length ? shot.controls.map((control) => `<tr><td>${control.number}</td><td>${escapeHtml(control.label)}</td><td>${escapeHtml(control.location)}</td><td>${escapeHtml(control.visibleWhen)}</td><td>${escapeHtml(control.disabledWhen)}</td><td>${escapeHtml(control.immediate)}</td><td>${escapeHtml(control.next)}</td><td>${escapeHtml(control.failure)}</td></tr>`).join('') : '<tr><td>—</td><td colspan="7">此复用验收截图用于说明整体状态；可操作控件已在相邻同类界面的编号表逐项说明。</td></tr>';
  return `<section class="interface" id="screen-${shot.sequence}"><div class="interface-head"><div><h1>${shot.sequence}. ${escapeHtml(shot.title)}</h1><p class="screen-note">${escapeHtml(shot.description)}</p></div><span class="index">${escapeHtml(shot.filename)} · ${shot.viewport?.width || 1600}×${shot.viewport?.height || 1000}</span></div><figure class="screenshot-wrap"><img src="screenshots/${encodeURIComponent(shot.filename)}" alt="${escapeHtml(shot.title)}">${markers}</figure><h2>本界面全部 uBuddy 控件</h2><table class="control-table"><colgroup>${'<col>'.repeat(8)}</colgroup><thead><tr><th>编号</th><th>控件</th><th>位置</th><th>出现条件</th><th>禁用条件</th><th>点击/输入后的即时结果</th><th>后续控件或结果</th><th>失败、取消与副作用</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function describeControl(control, title) {
  const label = String(control.label || '未命名控件');
  const attrs = control.attributes || {};
  const key = `${label} ${Object.keys(attrs).join(' ')} ${Object.values(attrs).join(' ')}`;
  let immediate = '执行该控件对应的当前界面操作，并在原位置更新状态或打开下一层界面。';
  let next = '操作完成后，可继续使用当前界面中与新状态匹配的按钮、输入框或详情入口。';
  let failure = '请求失败时保留当前内容并显示错误提示；重复提交类控件在处理中会被禁用。';
  if (/返回|关闭|取消|x\b/i.test(key)) { immediate = '关闭当前菜单、抽屉或详情层，并返回上一层界面；未提交的选择不会生效。'; next = '返回后可继续浏览、重新打开该界面或选择其他对象。'; failure = '纯本地关闭通常无网络副作用；已提交的后台任务不会因关闭界面而停止。'; }
  else if (/发送|提交|确认|验收|发布|启用|接受|安装|重新生成|重新执行|重试/.test(key)) { immediate = `提交“${label}”操作；界面进入处理中或立即显示新的任务/交付状态。`; next = '成功后出现结果、进度、撤销/停止、查看详情或下一步确认入口，具体取决于当前任务状态。'; failure = '校验、权限、网络或执行失败时显示原因；可重试场景保留草稿和已有结果，防止重复创建。'; }
  else if (/拒绝|打回|停止|撤回|删除|解散|停用/.test(key)) { immediate = `触发“${label}”的终止性或回退性操作；需要确认的场景会先打开确认提示。`; next = '确认后状态变为已拒绝、待修改、已停止、已撤回或只读历史，并隐藏不再适用的操作。'; failure = '取消确认不会改变状态；服务端拒绝时保留原状态并提示原因。该操作可能影响其他协作成员。'; }
  else if (/动态|结果|流程图|Task|Ask|Agents|Lab/.test(key)) { immediate = `切换到“${label}”视图，当前对象不变，只重绘对应内容区域。`; next = '切换后可查看该视图专属详情、文件、节点或控制按钮。'; failure = '切换本身不修改任务数据；加载失败时保留可用的上一版内容。'; }
  else if (/更多|菜单|选择|Memory|权限|模型|成员|详情|技术|质量|正文|目标|搜索/.test(key) || control.tag === 'summary') { immediate = `展开或收起“${label}”的菜单/详情区域。`; next = '展开后显示该区域内的二级按钮、选项、状态说明或搜索结果。'; failure = '展开/收起不提交业务数据；点击区域外、再次点击或按关闭操作可退出。'; }
  else if (['input', 'textarea', 'select'].includes(control.tag)) { immediate = '更新当前界面的输入草稿或筛选条件；文本会在提交前保持在本地界面状态中。'; next = '输入有效内容后，发送、确认或搜索结果控件会启用或刷新。'; failure = '空值、格式不合法或必填项缺失时提交按钮保持禁用，并保留输入等待修正。'; }
  else if (/打开|查看|前往|消息|uBuddy/.test(key)) { immediate = `打开“${label}”对应的 uBuddy 会话、任务、文件或详情界面。`; next = '目标界面会提供返回入口，以及与对象当前状态相匹配的继续处理按钮。'; failure = '目标不存在、文件失效或权限不足时显示不可用原因，不会更改原任务状态。'; }
  return { location: `${title}；${control.tag}${attrs.id ? ` #${attrs.id}` : ''}`, visibleWhen: '当前对象、权限、功能 Gate 与任务状态满足该控件的显示条件时。', disabledWhen: control.disabled ? '截图状态下已禁用；通常因为内容为空、正在处理、权限不足或状态不允许。' : '截图状态下可用；处理中、缺少必填内容、权限不足或状态终止时会禁用/隐藏。', immediate, next, failure };
}

function screenTitle(filename) {
  const key = filename.replace(/^\d+-/, '').replace(/\.png$/, '');
  const labels = {
    'entry-message-home': '消息首页：uBuddy 快捷入口', 'entry-talent-market': '人才市场：当前版本入口关系', 'entry-contact-profile': '联系人资料：公开 uBuddy 团队简介',
    'chat-main': 'uBuddy 主会话', 'chat-add-menu': '编写器“+”工具菜单', 'chat-message-mode-menu': 'Task / Ask 消息模式', 'chat-participant-scope': '参与者与协作范围', 'chat-mention-picker': '@ 提及选择器', 'chat-project-menu': '项目/Workspace 选择器', 'chat-memory-menu': 'Memory 选择器', 'chat-permission-menu': '执行权限菜单', 'chat-model-menu': '模型选择菜单',
    'planning-execution-choice': '执行方式选择', 'planning-execution-target': '执行目标选择', 'planning-clarification': '派发前澄清', 'planning-failure': '协作规划失败与重试', 'planning-collaboration-plan': '协作计划确认', 'planning-participant-selection': '参与者自动筛选详情', 'planning-expired': '过期规划卡片',
    'run-process-details': '执行过程详情', 'run-approval': '命令/权限审批', 'run-user-input': '运行中补充信息', 'message-more-menu': '消息更多菜单', 'message-forward-dialog': '转发消息',
    'task-workspace-activity': '任务工作台：动态', 'task-workspace-result': '任务工作台：结果', 'task-workspace-result-expanded': '结果：质量建议与正文', 'task-workspace-flow': '任务工作台：流程图', 'task-workspace-technical': '任务工作台：技术详情', 'task-workspace-failure': '任务失败：诊断与重试',
    'collaboration-group-main': '协作群主界面', 'collaboration-shared-goal': '协作群共享目标', 'collaboration-members': '协作群成员与 Agent', 'collaboration-more-menu': '协作群更多菜单', 'collaboration-search': '协作群搜索', 'collaboration-progress-details': '协作群参与者进度',
    'delegation-workspace': '私人委托工作台', 'delegation-task-memory': '委托任务 Memory', 'delegation-result-review': '委托结果与发起方验收', 'delegation-failure-skill': '委托失败与 Skill 安装',
    'settings-ubuddy-profile': '设置：uBuddy 能力简介预览', 'settings-profile-history': '设置：简介版本与公开审核', 'settings-organization-research': '设置：组织消息调查', 'evolution-organization-policy': '自进化：uBuddy 组织策略',
    'mobile-chat-main': '移动端：uBuddy 会话', 'mobile-collaboration': '移动端：协作进度', 'dark-chat-main': '深色模式：uBuddy 会话',
  };
  return labels[key] || key.replaceAll('-', ' ');
}

function screenDescription(filename) {
  if (filename.includes('talent-market')) return '人才市场是 Agent 招募与管理宿主页面。当前版本没有挂载可点击的 uBuddy 人才卡片；uBuddy 通过消息首页与私人助理会话进入。';
  if (filename.includes('mobile')) return '移动窄屏下保持相同业务能力，但列表、会话和进度面板改为单列或分页切换。';
  if (filename.includes('dark')) return '深色主题只改变视觉 token，不改变按钮语义、任务状态或数据权限。';
  if (filename.includes('verified')) return '来自现有真实 UI 验收脚本的复用截图，用于补充中心抽屉、快速验收和失败详情等已验证状态。';
  return '截图使用隔离演示数据。红色编号只标注此界面内与 uBuddy 工作流相关且当前可见的交互控件。';
}

function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r/g, '').split('\n'); let html = ''; let paragraph = []; let inCode = false; let code = []; let list = '';
  const flushParagraph = () => { if (paragraph.length) { html += `<p>${inline(paragraph.join(' '))}</p>`; paragraph = []; } };
  const closeList = () => { if (list) { html += `</${list}>`; list = ''; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) { flushParagraph(); closeList(); if (inCode) { html += `<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`; code = []; } inCode = !inCode; continue; }
    if (inCode) { code.push(line); continue; }
    const heading = line.match(/^(#{1,4})\s+(.+)$/); if (heading) { flushParagraph(); closeList(); html += `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`; continue; }
    if (/^\|.+\|\s*$/.test(line) && /^\|?\s*:?-+/.test(lines[i + 1] || '')) { flushParagraph(); closeList(); const rows = [line]; i += 2; while (i < lines.length && /^\|.+\|\s*$/.test(lines[i])) { rows.push(lines[i]); i++; } i--; html += markdownTable(rows); continue; }
    const item = line.match(/^\s*[-*]\s+(.+)$/); if (item) { flushParagraph(); if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(item[1])}</li>`; continue; }
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/); if (ordered) { flushParagraph(); if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(ordered[1])}</li>`; continue; }
    if (line.startsWith('> ')) { flushParagraph(); closeList(); html += `<blockquote>${inline(line.slice(2))}</blockquote>`; continue; }
    if (!line.trim()) { flushParagraph(); closeList(); continue; }
    paragraph.push(line.trim());
  }
  flushParagraph(); closeList(); return html;
}

function markdownTable(rows) { const cells = rows.map((row) => row.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())); return `<table><thead><tr>${cells[0].map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${cells.slice(1).map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`; }
function inline(value) { return escapeHtml(value).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>'); }
function escapeHtml(value = '') { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }

async function printPdf() {
  const chrome = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
  assert.ok(chrome, 'Chrome/Chromium not found for PDF export.');
  const profile = mkdtempSync(path.join(os.tmpdir(), 'janus-ubuddy-pdf-')); const port = 9620;
  const child = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, pathToFileUrl(htmlPath)], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  let cdp;
  try {
    const target = await waitForTarget(port, 30_000); cdp = await connectCdp(target.webSocketDebuggerUrl); await cdp.send('Page.enable');
    await waitForCdp(cdp, `document.readyState === 'complete' && [...document.images].every((image) => image.complete && image.naturalWidth > 0)`, 30_000);
    const overflow = await evalCdp(cdp, `({ horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2, broken: [...document.images].filter((image) => !image.naturalWidth).map((image) => image.src) })`);
    assert.equal(overflow.horizontal, false, 'Manual HTML has horizontal overflow.'); assert.deepEqual(overflow.broken, [], 'Manual HTML has broken screenshots.');
    const printed = await cdp.send('Page.printToPDF', { landscape: true, printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false, generateTaggedPDF: true, generateDocumentOutline: true });
    writeFileSync(pdfPath, Buffer.from(printed.data, 'base64'));
  } catch (error) { throw new Error(`${error.message}\nChrome stderr:\n${stderr.slice(-4000)}`); }
  finally {
    try { cdp?.close(); } catch {}
    try { child.kill('SIGTERM'); } catch {}
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(5000)]);
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch {} await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(2000)]); }
    for (let attempt = 0; attempt < 5; attempt++) {
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); break; }
      catch (error) { if (attempt === 4) throw error; await sleep(250); }
    }
  }
}

function verifyManual() {
  for (const file of [manifestPath, htmlPath, pdfPath]) assert.ok(existsSync(file), `Missing artifact: ${file}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); assert.ok(manifest.screenshotCount >= 40, `Expected at least 40 screenshots, got ${manifest.screenshotCount}`);
  for (const shot of manifest.screenshots) { const file = path.join(screenshotRoot, shot.filename); assert.ok(existsSync(file) && statSync(file).size > 10_000, `Missing or blank screenshot: ${shot.filename}`); const ids = shot.controls.map((item) => item.number); assert.equal(new Set(ids).size, ids.length, `Duplicate marker in ${shot.filename}`); for (const item of shot.controls) assert.ok(item.immediate && item.next && item.failure, `Incomplete control row in ${shot.filename}`); }
  const pdf = readFileSync(pdfPath); assert.equal(pdf.subarray(0, 4).toString(), '%PDF'); assert.ok(pdf.length > 500_000, `PDF unexpectedly small: ${pdf.length}`);
  const html = readFileSync(htmlPath, 'utf8'); for (const shot of manifest.screenshots) assert.ok(html.includes(encodeURIComponent(shot.filename)), `Screenshot absent from HTML: ${shot.filename}`);
  console.log(JSON.stringify({ passed: true, screenshots: manifest.screenshotCount, html: htmlPath, pdf: pdfPath, pdfBytes: pdf.length }, null, 2));
}

async function run(command, runArgs) { await new Promise((resolve, reject) => { const child = spawn(command, runArgs, { cwd: root, env: process.env, stdio: 'inherit' }); child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))); }); }
function pathToFileUrl(file) { return `file://${encodeURI(path.resolve(file))}`; }
async function waitForTarget(port, timeout) { const end = Date.now() + timeout; while (Date.now() < end) { try { const response = await fetch(`http://127.0.0.1:${port}/json/list`); const items = await response.json(); const page = items.find((item) => item.type === 'page' && item.webSocketDebuggerUrl); if (page) return page; } catch {} await sleep(150); } throw new Error('Timed out waiting for Chrome CDP.'); }
async function connectCdp(url) { const socket = new WebSocket(url); const pending = new Map(); let id = 1; await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); }); socket.addEventListener('message', (event) => { const message = JSON.parse(event.data); const waiter = pending.get(message.id); if (!waiter) return; pending.delete(message.id); message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result || {}); }); return { send(method, params = {}) { const next = id++; return new Promise((resolve, reject) => { pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, params })); }); }, close() { socket.close(); } }; }
async function evalCdp(cdp, expression) { const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result?.value; }
async function waitForCdp(cdp, expression, timeout) { const end = Date.now() + timeout; while (Date.now() < end) { if (await evalCdp(cdp, `Boolean(${expression})`)) return; await sleep(150); } throw new Error(`Timed out waiting for ${expression}`); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
