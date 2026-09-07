import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';
import { composePptStyleSkill, resolvePptStyleSkill } from '../src/main/skills.js';
import { parseArtifactMessage } from '../src/main/artifacts.js';
import { buildAttachmentContext, describeFile, extractPptSourceVisuals, renderUploadedFile, uploadFile } from '../src/main/files.js';
import { imageEditSourcesFromAttachments, shouldEditPreviousImage } from '../src/main/imageGeneration.js';
import { renderPptArtifact, shouldAttachPptArtifact, userExplicitlyRequestsPptArtifact } from '../src/main/pptRenderer.js';
import { readZipEntries } from '../src/main/zip.js';
import { setSkillPackageInstalled, skillPackageInstallRoot } from '../src/shared/skillPackages.js';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function startImageServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization || '',
        contentType: req.headers['content-type'] || '',
        body,
      });
      if (req.headers.authorization !== 'Bearer sk-test-image') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Missing API key' } }));
        return;
      }
      if (req.url === '/v1/images/generations') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }));
        return;
      }
      if (req.url === '/v1/images/edits') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => new Promise((closeResolve) => server.close(closeResolve)),
      });
    });
  });
}

function installFakeCodex(tmp) {
  const fakeCodex = path.join(tmp, 'fake-codex.mjs');
  const fakeCodexCmd = path.join(tmp, 'fake-codex.cmd');
  const fakeLog = path.join(tmp, 'fake-codex.log');
  fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex-cli feature-smoke');
  process.exit(0);
}
if (args[0] === 'doctor') {
  console.log(JSON.stringify({ overallStatus: 'pass', codexVersion: 'feature-smoke', checks: { installation: { status: 'pass', summary: 'fake' } } }));
  process.exit(0);
}

let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const outputIndex = args.indexOf('--output-last-message');
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : '';
let response = 'JANUS_FEATURE_SMOKE_OK';
if (stdin.includes('JANUS_REPLY_MECHANISM_TEST')) {
  response = '分层回复最终答案';
} else if (stdin.includes('Janus desktop attachment e2e')) {
  response = 'ATTACHMENT_CONTEXT_OK';
} else if (stdin.includes('把叙事重点调整为方法、证据、局限和下一步，只需文字回答')) {
  response = 'PPT_STYLE_SWITCH_OK';
} else if (stdin.includes('重大项目PPT')) {
  response = [
    '| title | message | visual | speaker_note | time |',
    '| --- | --- | --- | --- | --- |',
    '| 项目目标 | 背景约束 • 总体目标 • 验收口径 | 目标-指标对齐图 | 说明项目要解决的问题和验收方式 | 45s |',
    '| 技术路线 | 数据场景 • 核心模型 • 评估闭环 | 技术路线图 | 展开技术路线与可验证证据 | 60s |',
    '| 交付计划 | 阶段成果 • 风险控制 • 下一步动作 | 里程碑看板 | 收束为交付与协同安排 | 45s |'
  ].join('\\n');
}
if (outputPath) fs.writeFileSync(outputPath, response, 'utf8');
if (process.env.FAKE_CODEX_LOG) {
  fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({
    args,
    stdin,
    hasAttachmentContext: stdin.includes('Private attachment context'),
    hasPptContext: stdin.includes('PPT style:') && stdin.includes('重大项目风'),
    activePptStyleSkill: /Active PPT Style Skill:\\s*([a-z_]+)/.exec(stdin)?.[1] || '',
  }) + '\\n');
}
if (args.includes('--json')) {
  if (stdin.includes('JANUS_REPLY_MECHANISM_TEST')) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'feature-smoke-thread' }));
    console.log(JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: '先给出阶段' } }));
    console.log(JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: '先给出阶段分析' } }));
    console.log(JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: '先给出阶段分析。' } }));
    console.log(JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message_delta', phase: 'final_answer', delta: '分层回复' } }));
    console.log(JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message_delta', phase: 'final_answer', delta: '最终答案' } }));
    console.log(JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: response } }));
  } else {
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'feature-smoke-thread' }));
    console.log(JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: response } }));
    console.log(JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: response } }));
  }
}
`, 'utf8');
  fs.chmodSync(fakeCodex, 0o755);
  if (process.platform === 'win32') {
    fs.writeFileSync(fakeCodexCmd, `@echo off\r\n"${process.execPath}" "${fakeCodex}" %*\r\n`, 'utf8');
  }
  return { bin: process.platform === 'win32' ? fakeCodexCmd : fakeCodex, log: fakeLog };
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function pptSmokeAnswer(style = 'academic') {
  const generalRows = [
    ['motivation_compare', '为什么需要行动', '• 当前体验存在明确摩擦 • 改进机会与用户价值直接相关 • 本次汇报聚焦可执行方案', '现状-目标对比图', '可编辑现状目标对比图', '说明问题和价值。', '45s'],
    ['challenge_map', '关键问题', '• 需求、流程和协同相互影响 • 单点优化难以形成稳定结果 • 需要建立共同判断框架', '问题关系图', '可编辑问题关系图', '解释问题之间的关系。', '60s'],
    ['method_pipeline', '解决路径', '• 先明确输入和目标 • 再拆解关键步骤与责任 • 最后通过反馈持续修正', '方案流程图', '可编辑方案流程图', '讲清整体路径。', '70s'],
    ['evidence_grid', '支撑依据', '• 用户反馈说明主要痛点 • 流程数据定位高频阻塞 • 案例对比验证改进方向', '证据网格', '可编辑证据网格', '说明依据来源。', '60s'],
    ['result_big_numbers', '预期收益', '• 重点指标用于衡量效率改善 • 体验指标用于观察用户感受 • 质量指标用于约束长期稳定性', '收益指标卡', '可编辑指标卡', '说明收益口径。', '55s'],
    ['case_gallery', '应用场景', '• 核心场景展示方案如何落地 • 边界场景验证异常处理 • 典型案例帮助团队形成共识', '场景案例区', '可编辑案例画廊', '展示使用场景。', '60s'],
    ['ablation_matrix', '取舍与风险', '• 优先级取决于价值和成本 • 风险需要对应缓解动作 • 阶段性验证降低一次性投入', '取舍矩阵', '可编辑取舍矩阵', '解释取舍。', '60s'],
    ['summary_takeaways', '下一步', '• 对齐目标和验收标准 • 选择小范围场景验证 • 根据结果决定扩展节奏', '三点总结', '可编辑总结卡片', '收束并提出行动。', '40s'],
  ];
  const academicRows = [
    ['motivation_compare', 'Agentic multimodal generation', '• 生成系统从单次输出转向可规划工作流 • 多模态任务需要同时处理文本、图像和反馈 • 闭环式 agent 能让过程更可检查', '动机对比图', '可编辑动机对比图', '说明为什么 agentic 多模态生成值得关注。', '40s'],
    ['challenge_map', '核心挑战', '• 意图拆解不稳定会放大后续错误 • 图文一致性需要跨模态约束 • 自动评价仍难覆盖真实用户偏好', '挑战关系图', '可编辑挑战关系图', '解释三个挑战之间的关系。', '70s'],
    ['method_pipeline', '方法流程', '• 用户目标先被拆成可执行子任务 • 生成器输出草案后进入评价环节 • 修复器根据反馈迭代文本和视觉', '输入-生成-评价-修复流程', '可编辑方法流程图', '讲清楚整体 pipeline。', '80s'],
    ['method_loop', 'Agent 闭环', '• 规划、工具调用和记忆形成循环 • 每轮输出都要接受一致性检查 • 失败样例反向更新下一轮策略', 'agent loop 图', '可编辑闭环图', '说明闭环机制。', '80s'],
    ['benchmark_metrics', '评价维度', '• 事实性、一致性和可控性需要分开度量 • 自动指标适合规模化筛查 • 人类偏好用于校准最终质量', '指标矩阵', '可编辑指标矩阵', '解释评价维度。', '70s'],
    ['result_big_numbers', '关键收益', '• 工作流化能降低返工成本 • 可追踪中间状态便于定位失败 • 多轮修复提高复杂任务完成率', '关键指标卡', '可编辑大数字指标卡', '说明收益表达。', '60s'],
    ['ablation_matrix', '消融设计', '• 移除规划会降低任务覆盖度 • 移除评价会增加幻觉风险 • 移除记忆会削弱长任务连续性', '消融矩阵', '可编辑消融矩阵', '讲消融逻辑。', '70s'],
    ['summary_takeaways', '总结', '• agentic 框架让多模态生成更可控 • 证据对象应保持可编辑和可追踪 • 下一步聚焦可靠评测与成本控制', '三点总结', '可编辑总结卡片', '收束整套汇报。', '40s'],
  ];
  const projectRows = [
    ['project_target_map', '项目背景与目标', '• 平台建设需要统一数据、模型和应用入口 • 项目目标是形成可验证的智能化能力 • 汇报聚焦技术路线、交付和风险', '目标-证据映射图', '可编辑目标映射图', '交代项目目标。', '50s'],
    ['domain_object_map', '领域对象建模', '• 核心对象包括设备、工单、任务和指标 • 对象关系决定系统调度和评价方式 • 状态变量用于跟踪运行质量', '领域对象图', '可编辑对象关系图', '说明对象模型。', '70s'],
    ['technical_route', '总体技术路线', '• 数据治理为模型训练提供基础 • 模型服务支撑预测、诊断和推荐 • 评测闭环连接上线反馈和持续迭代', '技术路线图', '可编辑技术路线图', '展开路线。', '90s'],
    ['workpackage_matrix', '任务包拆解', '• 数据层负责采集、清洗和标签管理 • 模型层负责训练、推理和监控 • 应用层负责业务流程集成', '任务包矩阵', '可编辑任务包矩阵', '说明分工。', '80s'],
    ['evaluation_dashboard', '评测体系', '• 指标覆盖准确性、稳定性和响应效率 • 场景测试验证真实业务适配性 • 验收口径与交付物直接对应', '评测仪表盘', '可编辑评测仪表盘', '解释验收。', '80s'],
    ['result_big_numbers', '阶段成果', '• 已形成平台原型和核心模块闭环 • 关键场景可进入试点验证 • 后续重点是规模化和稳定性', '成果指标卡', '可编辑成果指标卡', '说明成果。', '60s'],
    ['risk_action_table', '风险与行动', '• 数据质量不足会影响模型稳定性 • 系统集成依赖接口标准化 • 通过分阶段试点降低上线风险', '风险行动表', '可编辑风险行动表', '说明风险控制。', '70s'],
    ['milestone_roadmap', '里程碑计划', '• 第一阶段完成数据和原型验证 • 第二阶段推进试点和评测体系 • 第三阶段形成交付和运维机制', '里程碑路线图', '可编辑里程碑路线图', '收束计划。', '60s'],
  ];
  const rows = style === 'project' ? projectRows : style === 'general' ? generalRows : academicRows;
  const header = '| layout_id | title | message | proof_object | visual | speaker_note | time |\n|---|---|---|---|---|---|---|';
  return `${header}\n${rows.map((row) => `| ${row.join(' | ')} |`).join('\n')}`;
}

function assertNoPlaceholderText(preview) {
  const text = (preview.slides || [])
    .flatMap((slide) => slide.text || [])
    .join('\n')
    .toLowerCase();
  assert(!/(placeholder|debug|todo|lorem|省略号|中间产物|\.\.\.)/.test(text), 'PPT preview leaked placeholder/debug text.');
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-desktop-feature-'));
const imageServer = await startImageServer();
const previousBin = process.env.JANUS_CODEX_BIN;
const previousLog = process.env.FAKE_CODEX_LOG;
const previousHeartbeat = process.env.JANUS_CODEX_HEARTBEAT_MS;
const previousPptImagegen = process.env.JANUS_PPT_ENABLE_IMAGEGEN;
const previousPptComPreview = process.env.JANUS_PPT_PREVIEW_COM;
const previousPptComExport = process.env.JANUS_PPT_COM_EXPORT;
const fakeCodex = installFakeCodex(root);
fs.cpSync(path.join(process.cwd(), 'assets', 'skills', 'ppt_creation'), skillPackageInstallRoot(root, 'ppt_creation'), { recursive: true });
setSkillPackageInstalled(root, 'ppt_creation', true, { source: 'bundled', version: 'smoke' });
process.env.JANUS_CODEX_BIN = fakeCodex.bin;
process.env.FAKE_CODEX_LOG = fakeCodex.log;
process.env.JANUS_CODEX_HEARTBEAT_MS = '100';
process.env.JANUS_PPT_ENABLE_IMAGEGEN = '0';
process.env.JANUS_PPT_PREVIEW_COM = '0';
process.env.JANUS_PPT_COM_EXPORT = '0';

let runtime = null;
try {
  runtime = await createRuntime({ root, isDev: true });
  runtime.saveCodexConfig({
    baseUrl: imageServer.baseUrl,
    apiKey: 'sk-test-image',
    model: 'gpt-5.5',
    reviewModel: 'gpt-5.5',
    reasoningEffort: 'high',
  });

  const boot = await runtime.bootstrap();
  const pptAgents = new Set(
    (boot.org?.agents || [])
      .filter((agent) => agent.departmentId === 'ppt_department' && agent.routable !== false)
      .map((agent) => agent.id),
  );
  assert(pptAgents.size === 1 && pptAgents.has('ppt'), 'Only the unified PPT Agent should be routable.');
  if (!runtime.store.findUserAgentInstance({ userId: runtime.currentUser().id, agentFamilyId: 'ppt' })) {
    runtime.store.recruitUserAgent({
      userId: runtime.currentUser().id,
      agentFamilyId: 'ppt',
      commandId: 'desktop-feature-smoke:recruit-ppt',
    });
  }

  assert(userExplicitlyRequestsPptArtifact('把这些内容导出成 pptx'), 'Explicit PPT artifact request was not detected.');
  assert(!userExplicitlyRequestsPptArtifact('请读一下 lecture.pptx 并总结'), 'PPT analysis-only request should not create a new artifact.');
  assert(!userExplicitlyRequestsPptArtifact('请解析这个 PPT 并生成一份文字摘要'), 'Text-summary generation should not be treated as PPT creation.');
  assert(
    !shouldAttachPptArtifact(
      { departmentId: 'ppt_department', agentId: 'ppt' },
      '请分析这个附件并给出改进建议',
      '这里是分析和改进建议。',
    ),
    'PPT analysis and improvement suggestions should not trigger artifact rendering.',
  );
  assert(
    shouldAttachPptArtifact(
      { departmentId: 'ppt_department', agentId: 'ppt' },
      '帮我做一个3页学术汇报PPT',
      '好的，下面是页面表。',
    ),
    'PPT department creation request did not trigger artifact rendering.',
  );
  assert(
    shouldAttachPptArtifact(
      { departmentId: 'ppt_department', agentId: 'ppt', explicitPptMode: true },
      '你好！帮我绘制一个介绍生成式推荐系统的ppt',
      '好的，下面是页面表。',
    ),
    '“绘制一个 PPT”必须启动 PPTX artifact 渲染。',
  );
  assert(
    shouldAttachPptArtifact(
      { departmentId: 'ppt_department', agentId: 'ppt', explicitPptMode: true, interactionMode: 'plan' },
      '请制作一份三页的项目汇报 PPT。',
      '下面是页面结构。',
    ),
    'legacy Plan mode metadata must be normalized and must not create a host-side read-only branch.',
  );

  const answer = `| title | message | visual | speaker_note | time |
| --- | --- | --- | --- | --- |
| 研究动机 | 问题背景 • 关键缺口 • 本次目标 | 研究问题框架 | 说明研究价值 | 45s |
| 方法路线 | 数据来源 • 方法模块 • 评估指标 | 技术路线图 | 解释方法逻辑 | 60s |
| 结论展望 | 主要发现 • 局限性 • 下一步 | 总结卡片 | 收束讨论 | 45s |`;
  const directPpt = await renderPptArtifact({
    root,
    userId: 'smoke',
    sessionId: 'smoke',
    agentId: 'ppt',
    selectedStyle: 'academic_report',
    userMessage: '帮我做一个3页学术汇报PPT，并附逐页演讲稿',
    assistantAnswer: answer,
    selectedTemplate: 'hitsz',
  });
  assert(fs.existsSync(directPpt.deck), 'PPT deck was not written.');
  assert(fs.existsSync(directPpt.notes), 'PPT speaker notes were not written.');
  assert(fs.existsSync(directPpt.cover), 'PPT cover preview was not written.');
  assert(directPpt.style_id === 'academic_report' && directPpt.slide_count === 3, 'PPT artifact did not expose style/slide metadata.');
  assert(directPpt.template === 'hitsz', 'Direct PPT artifact did not preserve selected template.');
  const speakerNotes = fs.readFileSync(directPpt.notes, 'utf8');
  assert(/- style: .*\(academic_report\)/.test(speakerNotes), 'Selected academic style was reported but not used by the Python renderer.');
  assert(speakerNotes.includes('PPT Render QA - Attempt 1'), 'PPT notes did not include QA trace.');
  const entries = readZipEntries(directPpt.deck);
  assert(entries.has('ppt/presentation.xml'), 'PPTX is missing ppt/presentation.xml.');
  assert([...entries.keys()].some((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)), 'PPTX is missing slide XML entries.');
  const deckPreview = renderUploadedFile(root, { path: directPpt.deck });
  assert(deckPreview.kind === 'pptx' && deckPreview.slides.length === 3, 'PPTX preview did not parse three slides.');
  assert(directPpt.deck_file?.kind === 'pptx' && directPpt.deck_file.download_url, 'PPT artifact file metadata is missing action fields.');
  assert(directPpt.notes_file?.kind === 'markdown' && directPpt.notes_file.render_url, 'PPT notes metadata is missing markdown/render fields.');

  const pptSmokeCases = [
    ['general-none', 'general', 'none', 'general', '请制作一份 8 页左右的通用演示 PPT，主题为 团队协作流程优化，要求结构清晰、图文结合、便于讨论和执行。'],
    ['academic-none', 'academic_report', 'none', 'academic', '请制作一份 8 页左右的学术汇报 PPT，主题为 Agentic multimodal generation，要求图文结合、中文表达、不要大段文字。'],
    ['academic-hitsz', 'academic_report', 'hitsz', 'academic', '请制作一份 8 页左右的学术汇报 PPT，主题为 推荐系统入门与实践，使用哈工深模板，要求每页有标题、核心观点、3-5 个要点和视觉建议。'],
    ['academic-scut', 'academic_report', 'scut', 'academic', '请制作一份 8 页左右的学术汇报 PPT，主题为 推荐系统入门与实践，使用华工模板，整体简洁专业，图文结合。'],
    ['project-hitsz', 'major_project', 'hitsz', 'project', '请制作一份重大项目风格 PPT，主题为 光网络拓扑难题的 Graph-LLM 方法，使用哈工深模板，突出项目背景、技术路线、阶段成果、风险和里程碑。'],
    ['project-scut', 'major_project', 'scut', 'project', '请制作一份重大项目风格 PPT，主题为 智能制造平台建设方案，使用华工模板，突出目标、架构、关键模块、实施计划和预期成效。'],
  ];
  for (const [caseId, styleId, templateId, styleKind, prompt] of pptSmokeCases) {
    const artifact = await renderPptArtifact({
      root,
      userId: 'smoke',
      sessionId: `smoke-${caseId}`,
      agentId: 'ppt',
      selectedStyle: styleId,
      userMessage: `请附逐页演讲稿。${prompt}`,
      assistantAnswer: pptSmokeAnswer(styleKind),
      selectedTemplate: templateId,
    });
    assert(fs.existsSync(artifact.deck), `${caseId}: PPTX was not produced.`);
    assert(fs.existsSync(artifact.notes), `${caseId}: speaker notes were not produced.`);
    assert(fs.existsSync(artifact.cover), `${caseId}: cover preview was not produced.`);
    assert(artifact.template === templateId, `${caseId}: selected template did not reach renderer.`);
    assert(artifact.slide_count === 8, `${caseId}: slide count should be 8.`);
    const templateLoadingFailures = (artifact.preview_warnings || []).filter((warning) => (
      /Slide-library validation|Slide-library renderer failed|Template chrome backgrounds could not be rendered/i.test(String(warning || ''))
    ));
    assert(templateLoadingFailures.length === 0, `${caseId}: selected template did not load through the slide-library renderer: ${templateLoadingFailures.join('; ')}`);
    const previewDeck = renderUploadedFile(root, { path: artifact.deck });
    assert(previewDeck.kind === 'pptx' && previewDeck.slides.length === 8, `${caseId}: PPTX preview did not parse 8 slides.`);
    assert((previewDeck.slides[0]?.text || []).join(' ').trim().length > 0, `${caseId}: first slide is not cover-like/readable.`);
    assertNoPlaceholderText(previewDeck);
  }

  const upload = uploadFile(root, {
    filename: 'notes.md',
    contentType: 'text/markdown',
    dataBase64: Buffer.from('# Notes\n\nJanus desktop attachment e2e.', 'utf8').toString('base64'),
  });
  const preview = renderUploadedFile(root, upload);
  assert(upload.kind === 'markdown' && upload.download_url && upload.render_url && upload.preview_url, 'Upload metadata is missing preview/download fields.');
  assert(preview.kind === 'markdown' && preview.text.includes('attachment e2e'), 'Markdown attachment preview failed.');
  const describedUpload = describeFile(root, upload);
  assert(describedUpload.kind === 'markdown' && describedUpload.path === upload.path, 'File action description failed for uploaded attachment.');
  const context = buildAttachmentContext(root, '请总结附件', [upload]);
  assert(context.includes('已提取正文') && context.includes('attachment e2e'), 'Attachment context extraction failed.');
  const attachmentChat = await runtime.sendChat({
    chatMode: 'normal',
    message: '请总结这个附件',
    attachments: [upload],
    model: 'gpt-5.5',
    reasoningEffort: 'medium',
  });
  assert(attachmentChat.answer === 'ATTACHMENT_CONTEXT_OK', 'Normal chat did not receive attachment context.');
  assert(attachmentChat.session.departmentId === 'general', 'Unselected department should route to normal chat.');

  const replyEvents = [];
  const replyChat = await runtime.sendChat({
    chatMode: 'normal',
    message: 'JANUS_REPLY_MECHANISM_TEST',
    model: 'gpt-5.5',
    reasoningEffort: 'medium',
    onEvent: (event) => replyEvents.push(event),
  });
  const replyKinds = replyEvents.map((event) => event.kind);
  assert(replyChat.answer === '分层回复最终答案', `Reply mechanism final answer changed: ${JSON.stringify(replyChat.answer)}`);
  assert(replyKinds.includes('start'), 'Reply mechanism did not emit start.');
  assert(replyKinds.includes('routing'), 'Reply mechanism did not emit routing.');
  assert(replyKinds.includes('progress'), 'Reply mechanism did not emit progress.');
  assert(replyKinds.includes('heartbeat'), 'Reply mechanism did not emit heartbeat while waiting.');
  assert.equal(replyKinds.includes('draft'), false, 'Reply mechanism must not recreate the removed stage-output event.');
  assert(replyEvents.filter((event) => event.kind === 'token').map((event) => event.content).join('') === '分层回复最终答案', 'Reply mechanism did not stream token chunks.');
  const replyCommentaryEvents = replyEvents.filter((event) => event.kind === 'activity' && event.activityType === 'commentary');
  assert.equal(replyCommentaryEvents.length, 3, 'Reply mechanism did not expose all streaming commentary updates.');
  assert.equal(new Set(replyCommentaryEvents.map((event) => event.activityId)).size, 1, 'Cumulative commentary snapshots did not keep a stable activity ID.');
  const persistedReplyCommentary = replyChat.message.metadata.processEvents.filter((event) => event.activityType === 'commentary');
  assert.equal(persistedReplyCommentary.length, 1, 'Cumulative commentary snapshots were persisted as duplicate process events.');
  assert.equal(persistedReplyCommentary[0].detail, '先给出阶段分析。', 'Persisted commentary did not retain the complete snapshot.');
  assert(replyKinds.includes('done'), 'Reply mechanism did not emit done.');

  const runtimePptBaseSkill = fs.readFileSync(path.join(
    skillPackageInstallRoot(root, 'ppt_creation'),
    'departments', 'ppt_department', 'agents', 'ppt', 'SKILL.md',
  ), 'utf8');
  const runtimeMajorProjectStyle = resolvePptStyleSkill(root, 'major_project');
  assert(runtimeMajorProjectStyle.styleId === 'major_project' && runtimeMajorProjectStyle.content.includes('project_target_map'), 'Runtime could not resolve the installed major-project style Skill.');
  assert(composePptStyleSkill(root, runtimePptBaseSkill, 'major_project').includes('Active PPT Style Skill: major_project'), 'Runtime could not compose the installed major-project style Skill.');

  const pptChat = await runtime.sendChat({
    departmentId: 'ppt_department',
    agentId: 'ppt',
    message: '帮我制作3页重大项目PPT，导出成pptx',
    chatContext: {
      type: 'ppt',
      styleId: 'major_project',
      styleLabel: '重大项目风',
      templateId: 'scut',
      templateLabel: '华工模板',
      templatePath: 'templates/华工多功能PPT模板.pptx',
    },
    model: 'gpt-5.5',
    reasoningEffort: 'high',
  });
  assert(pptChat.ppt && fs.existsSync(pptChat.ppt.deck), 'PPT chat did not generate a deck artifact.');
  assert(pptChat.ppt.template === 'scut', 'PPT chat did not preserve selected template.');
  assert(pptChat.answer.includes('可编辑 PPTX 已生成并完成校验'), 'Completed PPT chat did not replace the temporary rendering status with a completion message.');
  assert(!pptChat.answer.includes('正在生成和校验可编辑 PPTX'), 'Completed PPT chat still looks permanently stuck in rendering.');
  const pptChatPreview = runtime.renderUploadedFile({ path: pptChat.ppt.deck });
  assert(pptChatPreview.kind === 'pptx' && pptChatPreview.slides.length === 3, 'PPT chat deck preview failed.');
  const pptArtifactMessage = runtime.store.listMessages(pptChat.session.id).find((message) => parseArtifactMessage(message.content)?.kind === 'ppt');
  assert(pptArtifactMessage, 'PPT artifact message was not stored in chat history.');

  const explicitNoTemplateChat = await runtime.sendChat({
    sessionId: pptChat.session.id,
    departmentId: 'ppt_department',
    agentId: 'ppt',
    message: '继续制作3页重大项目PPT，这次显式选择无模板并导出成pptx',
    chatContext: {
      type: 'ppt',
      styleId: 'major_project',
      styleLabel: '重大项目风',
      templateId: 'none',
      templateLabel: '无',
    },
    model: 'gpt-5.5',
    reasoningEffort: 'high',
  });
  assert(explicitNoTemplateChat.ppt && fs.existsSync(explicitNoTemplateChat.ppt.deck), 'Explicit no-template PPT chat did not generate an artifact.');
  assert(explicitNoTemplateChat.ppt.template === 'none', 'Explicit template=none incorrectly inherited the previous SCUT template.');

  const hitszTemplatePath = path.join(root, 'departments', 'ppt_department', 'templates', '哈工深多功能PPT模板.pptx');
  fs.renameSync(hitszTemplatePath, `${hitszTemplatePath}.missing-smoke`);
  const missingTemplateArtifact = await renderPptArtifact({
    root,
    userId: 'smoke',
    sessionId: 'smoke-missing-template',
    agentId: 'ppt',
    selectedStyle: 'academic_report',
    userMessage: '请制作一份3页学术汇报 PPT，并验证模板缺失回退。',
    assistantAnswer: answer,
    selectedTemplate: 'hitsz',
  });
  assert(missingTemplateArtifact.template === 'none', 'Missing selected template was reported as active instead of the effective fallback.');
  assert(
    missingTemplateArtifact.preview_warnings.some((warning) => /Requested template .*\(hitsz\).*used .*\(none\)/i.test(String(warning || ''))),
    `Missing-template fallback warning was not exposed: ${JSON.stringify(missingTemplateArtifact.preview_warnings)}`,
  );

  const switchedStyleChat = await runtime.sendChat({
    sessionId: pptChat.session.id,
    departmentId: 'ppt_department',
    agentId: 'ppt',
    message: '请继续，但把叙事重点调整为方法、证据、局限和下一步，只需文字回答。',
    chatContext: {
      type: 'ppt',
      styleId: 'academic_report',
      styleLabel: '学术汇报风',
      templateId: 'scut',
      templateLabel: '华工模板',
      templatePath: 'templates/华工多功能PPT模板.pptx',
    },
    model: 'gpt-5.5',
    reasoningEffort: 'high',
  });
  assert(switchedStyleChat.answer === 'PPT_STYLE_SWITCH_OK', 'PPT style-switch follow-up did not complete as a text-only turn.');

  const imageGenerate = await runtime.sendChat({
    chatMode: 'image',
    message: '生成一张实验室海报',
    imageModel: 'gpt-image-2',
  });
  assert(imageGenerate.image && fs.existsSync(imageGenerate.image.path), 'Image generation did not save an artifact.');

  const imageEditPrevious = await runtime.sendChat({
    chatMode: 'image',
    sessionId: imageGenerate.session.id,
    message: '把上一张图的背景换成深色',
    imageModel: 'gpt-image-2',
  });
  assert(imageEditPrevious.image && fs.existsSync(imageEditPrevious.image.path), 'Previous image edit did not save an artifact.');

  const imageUpload = uploadFile(root, {
    filename: 'reference.png',
    contentType: 'image/png',
    dataBase64: PNG_BASE64,
  });
  const pptSourceVisuals = extractPptSourceVisuals(root, '请把附件图片插入 PPT', [imageUpload]);
  assert(pptSourceVisuals.includes(imageUpload.path), 'PPT source visual extraction did not include direct image attachment.');
  const imageEditUpload = await runtime.sendChat({
    chatMode: 'image',
    sessionId: imageGenerate.session.id,
    message: '参考这张图改成蓝色调',
    attachments: [imageUpload],
    imageAttachments: [imageUpload],
    imageModel: 'gpt-image-2',
  });
  assert(imageEditUpload.image && fs.existsSync(imageEditUpload.image.path), 'Uploaded image edit did not save an artifact.');

  assert(shouldEditPreviousImage('把上一张图的背景换成深色'), 'Previous image edit intent was not detected.');
  const imageSources = imageEditSourcesFromAttachments([{ path: imageUpload.path, type: 'image/png' }]);
  assert(imageSources[0].mediaType === 'image/png', 'Image attachment media type was not accepted.');

  const artifactPayload = parseArtifactMessage(`__JANUS_ARTIFACT__${JSON.stringify({ kind: 'ppt', data: directPpt })}`);
  assert(artifactPayload?.kind === 'ppt', 'Artifact message roundtrip failed.');

  const imageRequests = imageServer.requests;
  assert(imageRequests.filter((item) => item.url === '/v1/images/generations').length >= 1, 'Image generation endpoint was not called.');
  assert(imageRequests.filter((item) => item.url === '/v1/images/edits').length === 2, 'Image edit endpoint was not called twice.');
  assert(imageRequests.every((item) => item.authorization === 'Bearer sk-test-image'), 'Image API key was not sent to every image request.');
  assert(imageRequests.some((item) => item.url === '/v1/images/generations' && item.body.includes('实验室海报')), 'Image generation prompt was not sent.');
  assert(imageRequests.some((item) => item.url === '/v1/images/edits' && item.contentType.includes('multipart/form-data')), 'Image edit did not use multipart form data.');

  const codexLogs = readJsonl(fakeCodex.log);
  assert(codexLogs.some((item) => item.hasAttachmentContext && item.stdin.includes('attachment e2e')), 'Codex prompt did not include extracted attachment context.');
  assert(codexLogs.some((item) => item.hasPptContext && item.stdin.includes('major_project')), 'Codex prompt did not include selected PPT style/template context.');
  assert(
    codexLogs.some((item) => item.activePptStyleSkill === 'major_project'),
    `Codex prompt did not load the selected major-project style Skill: ${JSON.stringify(codexLogs.map((item) => ({
      hasPptContext: item.hasPptContext,
      activePptStyleSkill: item.activePptStyleSkill,
      hasCommonSkill: item.stdin.includes('Style Skill Contract'),
      skillClipMarker: item.stdin.includes('[...clipped...]'),
    })))}`,
  );
  assert(
    codexLogs.some((item) => item.activePptStyleSkill === 'academic_report'),
    'Switching PPT style in an existing session did not rebuild the prompt with the academic-report style Skill.',
  );

  console.log('desktop feature smoke passed');
} finally {
  runtime?.close();
  await imageServer.close();
  if (previousBin === undefined) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousBin;
  if (previousLog === undefined) delete process.env.FAKE_CODEX_LOG;
  else process.env.FAKE_CODEX_LOG = previousLog;
  if (previousHeartbeat === undefined) delete process.env.JANUS_CODEX_HEARTBEAT_MS;
  else process.env.JANUS_CODEX_HEARTBEAT_MS = previousHeartbeat;
  if (previousPptImagegen === undefined) delete process.env.JANUS_PPT_ENABLE_IMAGEGEN;
  else process.env.JANUS_PPT_ENABLE_IMAGEGEN = previousPptImagegen;
  if (previousPptComPreview === undefined) delete process.env.JANUS_PPT_PREVIEW_COM;
  else process.env.JANUS_PPT_PREVIEW_COM = previousPptComPreview;
  if (previousPptComExport === undefined) delete process.env.JANUS_PPT_COM_EXPORT;
  else process.env.JANUS_PPT_COM_EXPORT = previousPptComExport;
  fs.rmSync(root, { recursive: true, force: true });
}
