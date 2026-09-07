import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { inspectOfficeFile } from '../src/main/officeArtifacts.js';
import {
  createDeliverableContract,
  createTaskArtifact,
  executeTaskNodeAsUnifiedAgentWork,
  validateStandaloneDeliverable,
} from '../src/main/modules/orchestration/index.js';

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-task-artifacts-'));
const pptFixture = path.resolve('assets/departments/ppt_department/templates/通用多功能PPT模板.pptx');
const pngFixture = fs.readFileSync(path.resolve('assets/icons/16x16.png'));
const jpegFixture = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9k=', 'base64');
const webpFixture = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA=', 'base64');
const pdfFixture = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF', 'ascii');

let taskMetadata = {
  workspaceRoot,
  finalTaskNodeId: 'node-final',
  deliverableContract: {
    requested_output_type: 'report',
    requires_file: true,
    required_extensions: ['.md', '.docx', '.xlsx', '.pptx', '.pdf', '.png', '.jpg', '.webp'],
  },
};
const events = [];
const store = {
  getTaskRun: () => ({ id: 'task-artifacts', metadata: taskMetadata }),
  updateTaskRunMetadata: (_id, patch) => {
    taskMetadata = { ...taskMetadata, ...patch };
    return { id: 'task-artifacts', metadata: taskMetadata };
  },
  recordTaskEvent: (event) => events.push(event),
};
const task = () => ({ id: 'task-artifacts', ownerUserId: 'owner', workspaceId: 'workspace_task_artifacts', metadata: taskMetadata });
const node = { id: 'node-final', title: '最终交付', localId: 'final', dependencies: [] };
const agent = { id: 'general_agent' };
const base = () => ({ runtimeRoot: process.cwd(), store, task: task(), node, agent });

try {
  const markdown = await createTaskArtifact({
    ...base(),
    format: 'md',
    relativePath: '未来AI预测报告.md',
    payload: { text: '# 未来 AI 预测报告\n\n## 摘要\n\n未来 AI 将持续发展。\n\n## 技术趋势\n\n模型能力和工程效率继续提升。\n\n## 社会影响\n\n治理、就业与教育需要同步适应。' },
  });
  assert.equal(markdown.status, 'created');
  assert.equal(markdown.relativePath, '未来AI预测报告.md');
  assert.equal(markdown.sha256.length, 64);

  const unchanged = await createTaskArtifact({
    ...base(),
    format: 'md',
    relativePath: '未来AI预测报告.md',
    payload: { text: '# 未来 AI 预测报告\n\n## 摘要\n\n未来 AI 将持续发展。\n\n## 技术趋势\n\n模型能力和工程效率继续提升。\n\n## 社会影响\n\n治理、就业与教育需要同步适应。' },
  });
  assert.equal(unchanged.status, 'unchanged');
  assert.equal(unchanged.deliverableId, 'primary');

  const replaced = await createTaskArtifact({
    ...base(),
    format: 'md',
    relativePath: '未来AI预测报告.md',
    expectedSha256: markdown.sha256,
    payload: { text: '# 未来 AI 预测报告\n\n## 摘要\n\n未来 AI 的应用将进一步普及，并从单点辅助工具逐渐转变为能够执行连续任务的系统。预测需要同时考虑技术进步、部署成本、组织能力和治理约束，不能把单一机构的判断视为确定事实。\n\n## 技术趋势\n\n推理、多模态、长上下文和工具调用能力将继续提升，模型训练与推理效率也会改善。企业采用速度仍将受到数据质量、系统可靠性、评估标准和投入产出比影响，因此不同产业的落地节奏会存在明显差异。\n\n## 社会影响\n\n治理、就业与教育需要同步适应。重复性知识工作会率先发生流程变化，同时人类审核、责任界定、安全评估和再培训的重要性上升。公共部门还需要持续跟踪公平性、能源消耗和高风险场景的实际事故数据。\n\n## 结论\n\n未来 AI 的影响取决于能力、成本、制度和社会选择的共同作用，应当通过可观测指标持续校正预测。' },
  });
  assert.equal(replaced.status, 'replaced');
  await assert.rejects(() => createTaskArtifact({
    ...base(),
    format: 'md',
    relativePath: '未来AI预测报告.md',
    expectedSha256: markdown.sha256,
    payload: { text: 'stale write' },
  }), (error) => error.code === 'task_workspace_file_conflict');

  const docx = await createTaskArtifact({
    ...base(),
    format: 'docx',
    relativePath: '未来AI预测报告.docx',
    payload: {
      title: '未来 AI 预测报告',
      blocks: [
        { type: 'heading', level: 1, text: '摘要' },
        { type: 'paragraph', text: '未来 AI 的能力、应用和治理将共同演进。' },
        { type: 'heading', level: 1, text: '技术趋势' },
        { type: 'list', items: ['推理能力提升', '多模态系统普及'] },
        { type: 'table', rows: [['阶段', '判断'], ['2030 年前', '规模化采用']] },
      ],
    },
  });
  assert.equal(inspectOfficeFile(path.join(workspaceRoot, docx.relativePath), '.docx').valid, true);

  const xlsx = await createTaskArtifact({
    ...base(),
    format: 'xlsx',
    relativePath: '未来AI指标.xlsx',
    payload: { sheets: [{ name: '预测指标', rows: [['年份', '采用率'], [2030, 0.7]], column_widths: [14, 18], frozen_rows: 1 }] },
  });
  assert.equal(inspectOfficeFile(path.join(workspaceRoot, xlsx.relativePath), '.xlsx').valid, true);
  await assert.rejects(() => createTaskArtifact({
    ...base(),
    format: 'xlsx',
    relativePath: '危险公式.xlsx',
    payload: { sheets: [{ name: 'Sheet', rows: [[{ formula: "WEBSERVICE('https://example.com')" }]] }] },
  }), (error) => error.code === 'artifact_payload_invalid');

  const pptx = await createTaskArtifact({
    ...base(),
    format: 'pptx',
    relativePath: '未来AI预测演示.pptx',
    payload: { title: '未来 AI 预测', slides: [{ layout_id: 'basic_content', title: '未来 AI', message: '核心判断', content_spec: { points: ['能力提升'] } }] },
    renderPpt: async (options) => {
      assert.equal(options.accountWorkspaceId, 'workspace_task_artifacts');
      assert.equal(options.userId, 'owner');
      return { deck: pptFixture, slide_count: 1, preview: { title: '未来 AI' } };
    },
  });
  assert.equal(inspectOfficeFile(path.join(workspaceRoot, pptx.relativePath), '.pptx').valid, true);

  const pdf = await createTaskArtifact({
    ...base(),
    format: 'pdf',
    relativePath: '未来AI预测报告.pdf',
    payload: { title: '未来 AI 预测报告', blocks: [{ type: 'paragraph', text: 'PDF 正文' }] },
    renderPdf: async () => pdfFixture,
  });
  assert.equal(fs.readFileSync(path.join(workspaceRoot, pdf.relativePath), 'ascii').startsWith('%PDF-'), true);

  for (const [format, fixture] of [['png', pngFixture], ['jpg', jpegFixture], ['webp', webpFixture]]) {
    const receipt = await createTaskArtifact({
      ...base(),
      format,
      relativePath: `未来AI插图.${format}`,
      payload: { prompt: '未来 AI 应用场景' },
      renderImage: async () => ({ buffer: fixture }),
    });
    assert.equal(receipt.status, 'created');
  }

  for (const relativePath of ['../escape.md', '/absolute.md', 'C:\\Desktop\\escape.md', '\\\\server\\share\\escape.md', 'bad\0name.md']) {
    await assert.rejects(() => createTaskArtifact({
      ...base(), format: 'md', relativePath, payload: { text: 'blocked' },
    }), (error) => ['invalid_task_workspace_path', 'task_workspace_path_escape'].includes(error.code));
  }

  if (process.platform !== 'win32') {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-task-artifacts-outside-'));
    fs.symlinkSync(outside, path.join(workspaceRoot, 'linked'));
    await assert.rejects(() => createTaskArtifact({
      ...base(), format: 'md', relativePath: 'linked/escape.md', payload: { text: 'blocked' },
    }), (error) => error.code === 'task_workspace_symlink_escape');
    fs.rmSync(outside, { recursive: true, force: true });
  }

  await assert.rejects(() => createTaskArtifact({
    ...base(),
    node: { id: 'node-other', title: '其他节点' },
    format: 'md',
    relativePath: '未来AI预测报告.md',
    payload: { text: 'cross-node overwrite' },
  }), (error) => error.code === 'task_workspace_file_owned_by_other_node');

  assert.ok(taskMetadata.generatedTaskFiles.length >= 8);
  assert.ok(taskMetadata.taskArtifactReceipts['未来AI预测报告.docx'].validationText.includes('技术趋势'));
  assert.ok(events.some((event) => event.eventType === 'task_artifact_created'));

  const contract = createDeliverableContract({ prompt: '写一份关于未来AI的预测报告，md格式上交' });
  assert.equal(contract.requested_output_type, 'report');
  assert.equal(contract.deliverable_title, '未来AI预测报告');
  assert.equal(contract.requires_file, true);
  assert.deepEqual(contract.required_extensions, ['.md']);
  const validation = validateStandaloneDeliverable({
    contract,
    prompt: '写一份关于未来AI的预测报告，md格式上交',
    answer: '<!-- janus-content-type: deliverable -->\n未来 AI 预测报告已经完成。\n\n交付文件：未来AI预测报告.md',
    workspaceRoot,
    fileCandidates: [{ path: path.join(workspaceRoot, '未来AI预测报告.md') }],
  });
  assert.equal(validation.passed, true, JSON.stringify(validation));

  const messages = [];
  let capturedSend = null;
  const unifiedStore = {
    createSession: (session) => ({ ...session, id: session.id }),
    listMessages: () => messages,
    addMessage: (message) => {
      const saved = { ...message, id: `message-${messages.length + 1}` };
      messages.push(saved);
      return saved;
    },
  };
  const identityTask = { id: 'task-bound', ownerUserId: 'owner', metadata: { workspaceRoot, finalTaskNodeId: 'node-bound' } };
  const identityNode = { id: 'node-bound', title: 'Final', agentInstanceId: 'instance-bound', attemptCount: 1 };
  const identityAgent = { id: 'general_agent', name: 'General', departmentId: 'general' };
  let boundIdentity = null;
  await executeTaskNodeAsUnifiedAgentWork({
    store: unifiedStore,
    sendChat: async (options) => {
      capturedSend = options;
      return { message: { id: 'response', content: 'done', metadata: {} }, answer: 'done' };
    },
    internalWorkspaceToken: 'token',
    task: identityTask,
    node: identityNode,
    agent: identityAgent,
    prompt: 'Create the final report.',
    finalOutputNode: true,
    deliverableContract: { requested_output_type: 'report', requires_file: true, required_extensions: ['.md'] },
    createArtifact: async (options) => {
      boundIdentity = options;
      return { ok: true, relativePath: options.relativePath, format: options.format, bytes: 10, sha256: 'a'.repeat(64), status: 'created' };
    },
  });
  assert.equal(capturedSend.dynamicTools[0].tools[0].name, 'create_task_artifact');
  assert.ok(capturedSend.dynamicTools[0].tools[0].inputSchema.required.includes('deliverable_id'));
  assert.doesNotMatch(capturedSend.message, /final artifact writer/);
  const toolResult = await capturedSend.onDynamicToolCall({
    namespace: 'janus', tool: 'create_task_artifact',
    arguments: { deliverable_id: 'primary', format: 'md', relative_path: 'bound.md', payload: { text: 'bound' } },
  });
  assert.equal(toolResult.success, true);
  assert.equal(boundIdentity.task.id, 'task-bound');
  assert.equal(boundIdentity.node.id, 'node-bound');
  assert.equal(boundIdentity.agent.id, 'general_agent');
  assert.equal(boundIdentity.deliverableId, 'primary');

  let supportingSend = null;
  await executeTaskNodeAsUnifiedAgentWork({
    store: unifiedStore,
    sendChat: async (options) => {
      supportingSend = options;
      return { message: { id: 'supporting-response', content: 'done', metadata: {} }, answer: 'done' };
    },
    internalWorkspaceToken: 'token',
    task: { id: 'task-supporting', ownerUserId: 'owner', metadata: { workspaceRoot, finalTaskNodeId: 'node-final' } },
    node: { id: 'node-supporting', title: 'Supporting', agentInstanceId: 'instance-bound', attemptCount: 1 },
    agent: identityAgent,
    prompt: 'Create supporting data.',
    finalOutputNode: false,
    deliverableContract: { deliverables: [{
      id: 'supporting-data', role: 'supporting', requested_output_type: 'spreadsheet', requires_file: true,
      owner_node_id: 'node-supporting', required_extensions: ['.xlsx'],
    }] },
    createArtifact: async () => ({ ok: true }),
  });
  assert.equal(supportingSend.dynamicTools[0].tools[0].name, 'create_task_artifact');

  const sharedPathContract = { deliverables: [
    { id: 'shared-a', role: 'primary', requested_output_type: 'document', requires_file: true,
      owner_node_id: 'node-shared', required_extensions: ['.md'] },
    { id: 'shared-b', role: 'supporting', requested_output_type: 'document', requires_file: true,
      owner_node_id: 'node-shared', required_extensions: ['.md'] },
  ] };
  taskMetadata = { ...taskMetadata, finalTaskNodeId: 'node-shared', deliverableContract: sharedPathContract };
  const sharedBase = { ...base(), node: { id: 'node-shared', title: 'Shared format' } };
  await createTaskArtifact({ ...sharedBase, deliverableId: 'shared-a', format: 'md', relativePath: 'shared.md', payload: { text: 'A' } });
  await assert.rejects(() => createTaskArtifact({
    ...sharedBase, deliverableId: 'shared-b', format: 'md', relativePath: 'shared.md', payload: { text: 'B' },
  }), (error) => error.code === 'task_workspace_file_owned_by_other_deliverable');

  let sourceEditSend = null;
  await executeTaskNodeAsUnifiedAgentWork({
    store: unifiedStore,
    sendChat: async (options) => {
      sourceEditSend = options;
      return { message: { id: 'source-response', content: 'done', metadata: {} }, answer: 'done' };
    },
    internalWorkspaceToken: 'token',
    task: { id: 'task-source-bound', ownerUserId: 'owner', metadata: { workspaceRoot, finalTaskNodeId: 'node-source-bound' } },
    node: { id: 'node-source-bound', title: 'Source', agentInstanceId: 'instance-bound', attemptCount: 1 },
    agent: identityAgent,
    prompt: 'Edit source code.',
    finalOutputNode: true,
    deliverableContract: { requested_output_type: 'code_change', requires_file: true, required_extensions: [] },
    createArtifact: async () => { throw new Error('source edit must not receive artifact tool'); },
  });
  assert.deepEqual(sourceEditSend.dynamicTools, []);
  assert.equal(sourceEditSend.onDynamicToolCall, null);

  console.log('task artifact service smoke passed');
} finally {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}
