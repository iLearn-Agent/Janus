import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createDeliverableContract,
  createSingleAgentDeliverableContract,
  deliverableContractInstructions,
  parseTaskOutputDeclaration,
  taskNodeFileDeliveryCheck,
  validateDeliverableContractExecutable,
  validateDeliveryArtifactFormats,
  validateStandaloneDeliverable,
  validateTaskDeliverable,
} from '../src/main/modules/orchestration/domain/deliverableContract.js';
import { ensureDelegationEditableDraftFile } from '../src/main/modules/collaboration/infrastructure/delegationWorkspaceFiles.js';
import { buildPlainChatPrompt } from '../src/main/prompts.js';
import { state } from '../src/renderer/app/state.js';
import { renderMessageList } from '../src/renderer/app/views/chatView.js';
import { renderTaskProgressCard } from '../src/renderer/app/views/taskProgressView.js';
import { createZip } from '../src/main/zip.js';

const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-deliverable-contract-'));
const reportPath = path.join(workspaceRoot, '环境治理报告.md');
const reportBody = `# 环境治理报告

## 摘要
本报告围绕园区环境治理现状，提出污染源管控、资源节约和监督改进方案。

## 现状与主要问题
当前存在排放台账不完整、固废分类执行不一致、能耗监测覆盖不足等问题。

## 治理目标与措施
建立排放台账和月度复核机制，完善固废分类责任制，补齐能耗监测点位，并明确整改责任人与完成期限。

## 实施保障与结论
由环境管理负责人牵头，每月检查治理指标并公开整改进度，确保措施持续落地。`;
await writeFile(reportPath, reportBody, 'utf8');

const contract = createDeliverableContract({
  prompt: '@管理员 写一份环境治理报告给我。',
  objective: { taskType: 'file_generation', summary: '写一份环境治理报告' },
  finalNode: { agentId: 'general_agent', outputFormat: 'Markdown report' },
});
assert.equal(contract.requested_output_type, 'report');
assert.equal(contract.deliverable_title, '环境治理报告');
assert.equal(contract.owner_agent, 'general_agent');
assert.ok(contract.acceptance_criteria.some((item) => item.includes('执行')));

const noFileContract = createDeliverableContract({
  prompt: '解释本地工作区隔离原则，不要创建文件。',
  objective: { taskType: 'file_generation', summary: '解释本地工作区隔离原则，不要创建文件。' },
  finalNode: { agentId: 'secretary_agent' },
});
assert.equal(noFileContract.requested_output_type, 'answer');
const noFileReportContract = createDeliverableContract({
  prompt: '写一份环境治理报告，不要创建文件。',
  objective: { taskType: 'file_generation' },
});
assert.equal(noFileReportContract.requested_output_type, 'report');
assert.equal(noFileReportContract.requires_file, false);
const noFilePptAnalysisContract = createDeliverableContract({
  prompt: '分析这份 PPT 的内容，不要创建文件。',
  objective: { taskType: 'file_generation' },
});
assert.equal(noFilePptAnalysisContract.requested_output_type, 'answer');
assert.equal(noFilePptAnalysisContract.requires_file, false);
assert.equal(createDeliverableContract({ prompt: '分析这份 PPT，不用生成文件' }).requested_output_type, 'answer');
assert.equal(createDeliverableContract({ prompt: '先别创建 PPT 文件，只分析内容' }).requires_file, false);

const singleAgentReportBody = `# 中国环境报告

## 摘要
本报告概述中国环境治理中的污染防治、生态保护、资源利用和碳排放议题。

## 现状与主要问题
部分地区仍面临废气排放、污水治理、固废分类、土壤修复和能耗控制压力，环境监测与责任台账需要持续完善。

## 治理措施
健全排放台账和监测制度，强化污水、废气与固废治理，推进资源节约和节能降碳，并明确整改责任人与完成期限。

## 实施保障与结论
由环境管理责任人按月检查治理指标和整改进度，通过信息公开与持续复核改善生态环境质量。`;
const singleAgentReportContract = createSingleAgentDeliverableContract({
  prompt: '写一份中国环境报告',
  objective: { taskType: 'file_generation', summary: '写一份中国环境报告' },
  finalNode: { agentId: 'general_agent' },
});
assert.equal(singleAgentReportContract.version, 'deliverable_contract_v2');
assert.equal(singleAgentReportContract.declaration_policy, 'host_infer_if_valid');
const inferredSingleAgentReport = validateStandaloneDeliverable({
  contract: singleAgentReportContract,
  prompt: '写一份中国环境报告',
  answer: singleAgentReportBody,
  workspaceRoot,
  ownerAgent: 'general_agent',
});
assert.equal(inferredSingleAgentReport.passed, true, JSON.stringify(inferredSingleAgentReport));
assert.equal(inferredSingleAgentReport.contentTypeSource, 'host_inferred_deliverable');
const invalidSingleAgentReport = validateStandaloneDeliverable({
  contract: singleAgentReportContract,
  prompt: '写一份中国环境报告',
  answer: '# 中国环境报告\n\n任务已经执行完成。',
  workspaceRoot,
  ownerAgent: 'general_agent',
});
assert.equal(invalidSingleAgentReport.passed, false);
assert.notEqual(invalidSingleAgentReport.failureCode, 'content_type_undeclared');

const declared = parseTaskOutputDeclaration(`<!-- janus-content-type: deliverable -->\n${reportBody}\n\n文件：环境治理报告.md`, { final: true });
assert.equal(declared.contentType, 'deliverable');
assert.equal(declared.declared, true);

const task = {
  id: 'task-report',
  title: '环境治理报告',
  prompt: '@管理员 写一份环境治理报告给我。',
  status: 'completed',
  metadata: {
    workspaceRoot,
    finalTaskNodeId: 'node-final',
    deliverableContract: contract,
    nodeOutputDeclarations: {
      'node-final': declared,
    },
  },
  nodes: [{
    id: 'node-final', status: 'completed', title: '环境治理报告交付', agentId: 'general_agent',
    resultText: declared.body, dependencies: [], evidenceRefs: [{ type: 'file', value: '环境治理报告.md' }],
  }],
};
const accepted = validateTaskDeliverable({ task, workspaceRoot });
assert.equal(accepted.passed, true, JSON.stringify(accepted));
assert.equal(accepted.resultState, 'accepted');
assert.equal(accepted.files[0].name, '环境治理报告.md');
assert.match(accepted.body, /治理目标与措施/);
assert.equal(accepted.summary, '本报告围绕园区环境治理现状，提出污染源管控、资源节约和监督改进方案。');

const spacedReportPath = path.join(workspaceRoot, '环境 治理报告.md');
await writeFile(spacedReportPath, reportBody, 'utf8');
const acceptedSpacedPath = validateStandaloneDeliverable({
  contract,
  prompt: '@管理员 写一份环境治理报告给我。',
  answer: `<!-- janus-content-type: deliverable -->\n${reportBody}\n\n交付文件：\`环境 治理报告.md\``,
  workspaceRoot,
  ownerAgent: 'general_agent',
});
assert.equal(acceptedSpacedPath.passed, true, JSON.stringify(acceptedSpacedPath));
assert.equal(acceptedSpacedPath.files[0].name, '环境 治理报告.md');

const diagnosticPath = path.join(workspaceRoot, 'diagnostics.md');
await writeFile(diagnosticPath, '# 诊断信息\n\n已执行任务图和 Agent 调度链路。', 'utf8');
const acceptedWithSourceFile = validateStandaloneDeliverable({
  contract,
  prompt: '@管理员 写一份环境治理报告给我。',
  answer: `<!-- janus-content-type: deliverable -->\n${reportBody}`,
  workspaceRoot,
  fileCandidates: [spacedReportPath, diagnosticPath],
});
assert.equal(acceptedWithSourceFile.passed, true, JSON.stringify(acceptedWithSourceFile));
assert.deepEqual(acceptedWithSourceFile.files.map((file) => file.name), ['环境 治理报告.md']);

const legacyAccepted = validateTaskDeliverable({
  task: {
    id: 'legacy-task-report',
    title: '历史环境治理报告',
    prompt: '写一份环境治理报告。',
    status: 'completed',
    metadata: { finalTaskNodeId: 'legacy-final' },
    nodes: [{
      id: 'legacy-final', status: 'completed', title: '历史报告交付', agentId: 'general_agent',
      resultText: reportBody, dependencies: [], evidenceRefs: [],
    }],
  },
  workspaceRoot,
});
assert.equal(legacyAccepted.passed, true, JSON.stringify(legacyAccepted));
assert.equal(legacyAccepted.resultState, 'legacy_accepted');
assert.equal(legacyAccepted.validationMode, 'legacy_compatible');

const processLog = parseTaskOutputDeclaration('<!-- janus-content-type: process_log -->\n已执行任务图和三个 Agent 节点。', { final: true });
const rejectedType = validateTaskDeliverable({
  task: {
    ...task,
    metadata: { ...task.metadata, nodeOutputDeclarations: { 'node-final': processLog } },
    nodes: [{ ...task.nodes[0], resultText: processLog.body, evidenceRefs: [] }],
  },
  workspaceRoot,
});
assert.equal(rejectedType.passed, false);
assert.equal(rejectedType.resultState, 'needs_revision');
assert.equal(rejectedType.failureCode, 'wrong_content_type');

const fakeDeliverable = parseTaskOutputDeclaration('<!-- janus-content-type: deliverable -->\n# 链路执行结果\n\n## 节点\n已执行任务图、调度链路和 Agent workflow。', { final: true });
const rejectedQuality = validateTaskDeliverable({
  task: {
    ...task,
    metadata: { ...task.metadata, nodeOutputDeclarations: { 'node-final': fakeDeliverable } },
    nodes: [{ ...task.nodes[0], resultText: fakeDeliverable.body, evidenceRefs: [] }],
  },
  workspaceRoot,
});
assert.equal(rejectedQuality.passed, false);
assert.notEqual(rejectedQuality.failureCode, '');

const disguisedProcessLog = validateStandaloneDeliverable({
  contract,
  prompt: '@管理员 写一份环境治理报告给我。',
  answer: `<!-- janus-content-type: deliverable -->
# 环境治理报告

## 摘要
已完成任务图和 Agent 调度链路。

## 执行过程
依次执行规划节点、分析节点和汇总节点。

## 结论
全部链路执行完成。`,
  workspaceRoot,
});
assert.equal(disguisedProcessLog.passed, false);
assert.equal(disguisedProcessLog.failureCode, 'process_log_as_deliverable');

const documentContract = createDeliverableContract({ prompt: '生成一份项目说明文档' });
assert.equal(documentContract.requires_file, false,
  'a generic document request must accept structured body content without forcing an arbitrary file format');
assert.deepEqual(documentContract.required_extensions, []);
const normalizedGenericDocumentPlan = createDeliverableContract({
  prompt: '整理一份大学物理复习文档',
  deliverablePlan: { deliverables: [{
    id: 'physics-review', role: 'primary', type: 'document', title: '大学物理复习文档',
    deliveryMode: 'file', requiredExtensions: ['.docx'],
  }] },
});
assert.equal(normalizedGenericDocumentPlan.requires_file, false,
  'a model plan must not upgrade an unspecified document format to mandatory DOCX');
assert.deepEqual(normalizedGenericDocumentPlan.required_extensions, []);
const undeclaredDocument = validateStandaloneDeliverable({
  contract: documentContract,
  prompt: '生成一份项目说明文档',
  answer: '# 项目说明\n\n这是正文。',
  workspaceRoot,
});
assert.equal(undeclaredDocument.passed, false);
assert.equal(undeclaredDocument.failureCode, 'content_type_undeclared');

const pptContract = createDeliverableContract({ prompt: '制作一份项目汇报 PPT' });
const missingPpt = validateStandaloneDeliverable({
  contract: pptContract,
  prompt: '制作一份项目汇报 PPT',
  answer: '<!-- janus-content-type: deliverable -->\n# 项目汇报\n\n演示文稿已准备。',
  workspaceRoot,
});
assert.equal(missingPpt.passed, false);
assert.equal(missingPpt.failureCode, 'required_file_missing');
assert.deepEqual(pptContract.required_extensions, ['.pptx']);
assert.deepEqual(createDeliverableContract({ prompt: '制作 PPT 并另导出 PDF' }).required_extensions, ['.pptx']);

const invalidPptPath = path.join(workspaceRoot, '项目汇报.pptx');
await writeFile(invalidPptPath, 'not a real pptx', 'utf8');
const invalidPpt = validateStandaloneDeliverable({
  contract: pptContract,
  prompt: '制作一份项目汇报 PPT',
  answer: '<!-- janus-content-type: deliverable -->\n项目汇报已完成。\n\n交付文件：`项目汇报.pptx`',
  workspaceRoot,
});
assert.equal(invalidPpt.passed, false);
assert.equal(invalidPpt.failureCode, 'required_file_invalid');

const validPptPath = path.join(workspaceRoot, '项目汇报-有效.pptx');
await writeFile(validPptPath, createZip([
  { path: '[Content_Types].xml', data: '<Types />' },
  { path: 'ppt/presentation.xml', data: '<p:presentation />' },
  { path: 'ppt/slides/slide1.xml', data: '<p:sld />' },
]));
const validPpt = validateStandaloneDeliverable({
  contract: pptContract,
  prompt: '制作一份项目汇报 PPT',
  answer: '<!-- janus-content-type: deliverable -->\n项目汇报已完成。\n\n交付文件：`项目汇报-有效.pptx`',
  workspaceRoot,
});
assert.equal(validPpt.passed, true, JSON.stringify(validPpt));

const stagedWorkflowPrompt = '让通用Agent写一份中国环境报告，然后交给PPTAgent生成一份5页的PPT';
const stagedFallbackContract = createDeliverableContract({
  prompt: stagedWorkflowPrompt,
  finalNode: { localId: 'deck', agentId: 'ppt', outputFormat: '可编辑 PPTX' },
});
assert.equal(stagedFallbackContract.requested_output_type, 'presentation');
assert.equal(stagedFallbackContract.deliverable_title, '中国环境PPT');
assert.equal(stagedFallbackContract.requires_file, true);
const stagedWorkflowContract = createDeliverableContract({
  prompt: stagedWorkflowPrompt,
  finalNode: { localId: 'deck', agentId: 'ppt', outputFormat: '可编辑 PPTX' },
  deliverablePlan: {
    deliverables: [
      { id: 'source_report', role: 'intermediate', type: 'report', title: '中国环境报告', ownerLocalId: 'report', deliveryMode: 'inline' },
      { id: 'final_deck', role: 'primary', type: 'presentation', title: '中国环境PPT', ownerLocalId: 'deck', deliveryMode: 'file', requiredExtensions: ['.pptx'], constraints: { exactSlideCount: 5 } },
    ],
  },
});
assert.equal(stagedWorkflowContract.version, 'deliverable_contract_v2');
assert.equal(stagedWorkflowContract.requested_output_type, 'presentation');
assert.equal(stagedWorkflowContract.requires_file, true);
assert.deepEqual(stagedWorkflowContract.required_extensions, ['.pptx']);
assert.equal(stagedWorkflowContract.constraints.exact_slide_count, 5);

const fiveSlidePptPath = path.join(workspaceRoot, '中国环境PPT-5页.pptx');
await writeFile(fiveSlidePptPath, createZip([
  { path: '[Content_Types].xml', data: '<Types />' },
  { path: 'ppt/presentation.xml', data: '<p:presentation />' },
  ...Array.from({ length: 5 }, (_item, index) => ({ path: `ppt/slides/slide${index + 1}.xml`, data: '<p:sld />' })),
]));
const inferredWorkflowDelivery = validateStandaloneDeliverable({
  contract: stagedWorkflowContract,
  prompt: stagedWorkflowPrompt,
  answer: '中国环境主题的五页可编辑PPT已经生成。\n\n交付文件：`中国环境PPT-5页.pptx`',
  workspaceRoot,
  ownerAgent: 'ppt',
});
assert.equal(inferredWorkflowDelivery.passed, true, JSON.stringify(inferredWorkflowDelivery));
assert.equal(inferredWorkflowDelivery.contentTypeSource, 'host_inferred_deliverable');

const reportAndDeckContract = createDeliverableContract({
  prompt: '同时交付中国环境报告和5页PPT，PPT作为主交付。',
  finalNode: { localId: 'deck', agentId: 'ppt', outputFormat: '可编辑 PPTX' },
  deliverablePlan: { deliverables: [
    { id: 'supporting_report', role: 'supporting', type: 'report', title: '环境治理报告', ownerLocalId: 'report', deliveryMode: 'inline' },
    { id: 'primary_deck', role: 'primary', type: 'presentation', title: '中国环境PPT', ownerLocalId: 'deck', deliveryMode: 'file', requiredExtensions: ['.pptx'], constraints: { exactSlideCount: 5 } },
  ] },
});
const reportAndDeck = validateTaskDeliverable({
  task: {
    id: 'report-and-deck', title: '报告和PPT', prompt: '同时交付中国环境报告和5页PPT，PPT作为主交付。',
    metadata: { workspaceRoot, finalTaskNodeId: 'deck-node', deliverableContract: reportAndDeckContract },
    nodes: [
      { id: 'report-node', localId: 'report', status: 'completed', agentId: 'general_agent', dependencies: [], resultText: reportBody, evidenceRefs: [] },
      { id: 'deck-node', localId: 'deck', status: 'completed', agentId: 'ppt', dependencies: ['report-node'], resultText: '中国环境主题的五页可编辑PPT已经生成。\n\n交付文件：`中国环境PPT-5页.pptx`', evidenceRefs: [] },
    ],
  },
  workspaceRoot,
});
assert.equal(reportAndDeck.passed, true, JSON.stringify(reportAndDeck));
assert.deepEqual(reportAndDeck.deliverables.map((item) => item.role).sort(), ['primary', 'supporting']);

const fourSlidePptPath = path.join(workspaceRoot, '中国环境PPT-4页.pptx');
await writeFile(fourSlidePptPath, createZip([
  { path: '[Content_Types].xml', data: '<Types />' },
  { path: 'ppt/presentation.xml', data: '<p:presentation />' },
  ...Array.from({ length: 4 }, (_item, index) => ({ path: `ppt/slides/slide${index + 1}.xml`, data: '<p:sld />' })),
]));
const wrongSlideCount = validateStandaloneDeliverable({
  contract: stagedWorkflowContract,
  prompt: stagedWorkflowPrompt,
  answer: '中国环境主题PPT已经生成。\n\n交付文件：`中国环境PPT-4页.pptx`',
  workspaceRoot,
  ownerAgent: 'ppt',
});
assert.equal(wrongSlideCount.passed, false);
assert.equal(wrongSlideCount.failureCode, 'presentation_slide_count_mismatch');

const explicitDraftWorkflow = validateStandaloneDeliverable({
  contract: stagedWorkflowContract,
  prompt: stagedWorkflowPrompt,
  answer: '<!-- janus-content-type: draft -->\nPPT仍在修改中。\n\n交付文件：`中国环境PPT-5页.pptx`',
  workspaceRoot,
  ownerAgent: 'ppt',
});
assert.equal(explicitDraftWorkflow.passed, false);
assert.equal(explicitDraftWorkflow.failureCode, 'wrong_content_type');

const pdfContract = createDeliverableContract({ prompt: '生成一份 PDF 文档' });
assert.equal(pdfContract.requires_file, true);
assert.deepEqual(pdfContract.required_extensions, ['.pdf']);
const docxContract = createDeliverableContract({ prompt: '给我一个 DOCX' });
assert.equal(docxContract.requires_file, true);
assert.deepEqual(docxContract.required_extensions, ['.docx']);
assert.deepEqual(createDeliverableContract({ prompt: '生成一个 doc 文档' }).required_extensions, ['.docx']);
const legacyDocContract = createDeliverableContract({ prompt: '生成一个 Word 97-2003 .doc 文档' });
assert.deepEqual(legacyDocContract.required_extensions, ['.doc']);
assert.deepEqual(createDeliverableContract({ prompt: '生成一个 PowerPoint 97-2003 .ppt 文件' }).required_extensions, ['.ppt']);
assert.match(deliverableContractInstructions(docxContract), /Never put plain text, HTML, JSON, or Markdown/);
assert.match(buildPlainChatPrompt({ userMessage: '生成 Word 文档' }), /Default to \.docx, \.xlsx, and \.pptx/);
const disguisedDocPath = path.join(workspaceRoot, '伪装文档.doc');
await writeFile(disguisedDocPath, 'plain text renamed as a legacy Word file', 'utf8');
const disguisedDocDelivery = validateStandaloneDeliverable({
  contract: legacyDocContract,
  prompt: '生成一个 Word 97-2003 .doc 文档',
  answer: '<!-- janus-content-type: deliverable -->\nWord 文档已经生成。\n\n交付文件：`伪装文档.doc`',
  workspaceRoot,
});
assert.equal(disguisedDocDelivery.passed, false);
assert.equal(disguisedDocDelivery.failureCode, 'required_file_invalid');
assert.deepEqual(createDeliverableContract({ prompt: '生成 CSV 表格' }).required_extensions, ['.csv']);
assert.deepEqual(createDeliverableContract({ prompt: '生成 PNG 海报' }).required_extensions, ['.png']);
assert.deepEqual(createDeliverableContract({ prompt: '生成 Excel 表格' }).required_extensions, ['.xlsx']);
assert.deepEqual(createDeliverableContract({ prompt: '生成一张图片' }).required_extensions, ['.png']);
const alternativeDocumentFormats = createDeliverableContract({ prompt: '生成 DOCX 或 PDF 文件' });
assert.equal(alternativeDocumentFormats.extension_rule, 'one_of');
assert.deepEqual(alternativeDocumentFormats.required_extensions.sort(), ['.docx', '.pdf']);
assert.equal(validateDeliveryArtifactFormats(alternativeDocumentFormats, [], [{ name: 'result.pdf' }]).passed, true);
const combinedDocumentFormats = createDeliverableContract({ prompt: '同时生成 DOCX 和 PDF 文件' });
assert.equal(combinedDocumentFormats.extension_rule, 'all_of');
assert.equal(validateDeliveryArtifactFormats(combinedDocumentFormats, [], [{ name: 'result.pdf' }]).passed, false);
assert.equal(validateDeliveryArtifactFormats(combinedDocumentFormats, [], [{ name: 'result.pdf' }, { name: 'result.docx' }]).passed, true);
assert.equal(validateDeliverableContractExecutable(createDeliverableContract({ prompt: '生成 Word 97-2003 .doc 文档' })).passed, false);
const receiptContract = createDeliverableContract({
  prompt: '生成 DOCX 文件',
  finalNode: { localId: 'final' },
  deliverablePlan: { deliverables: [{
    id: 'report', role: 'primary', type: 'document', title: '报告', ownerLocalId: 'final',
    deliveryMode: 'file', requiredExtensions: ['.docx'],
  }] },
});
receiptContract.deliverables[0].owner_node_id = 'node-final';
assert.equal(taskNodeFileDeliveryCheck(receiptContract, { id: 'node-final' }, {}).passed, false);
assert.equal(taskNodeFileDeliveryCheck(receiptContract, { id: 'node-final' }, {
  'report.docx': { taskNodeId: 'node-final', deliverableId: 'report', relativePath: 'report.docx' },
}).passed, true);
const duplicateFormatContract = {
  deliverables: [
    { id: 'report-a', role: 'primary', requested_output_type: 'document', requires_file: true, owner_node_id: 'node-final', required_extensions: ['.docx'] },
    { id: 'report-b', role: 'supporting', requested_output_type: 'document', requires_file: true, owner_node_id: 'node-final', required_extensions: ['.docx'] },
  ],
};
assert.equal(taskNodeFileDeliveryCheck(duplicateFormatContract, { id: 'node-final' }, {
  'anonymous.docx': { taskNodeId: 'node-final', relativePath: 'anonymous.docx' },
}).passed, false);
assert.equal(taskNodeFileDeliveryCheck(duplicateFormatContract, { id: 'node-final' }, {
  'report-a.docx': { taskNodeId: 'node-final', deliverableId: 'report-a', relativePath: 'report-a.docx' },
  'report-b.docx': { taskNodeId: 'node-final', deliverableId: 'report-b', relativePath: 'report-b.docx' },
}).passed, true);
assert.deepEqual(createDeliverableContract({ prompt: '生成 Excel 97-2003 表格' }).required_extensions, ['.xls']);
assert.deepEqual(createDeliverableContract({ prompt: '生成 JSON 文件' }).required_extensions, ['.json']);
assert.deepEqual(createDeliverableContract({ prompt: '生成 HTML 文档' }).required_extensions, ['.html']);
const jsonContract = createDeliverableContract({ prompt: '生成 JSON 文件' });
await writeFile(path.join(workspaceRoot, '交付数据.json'), '{ invalid json', 'utf8');
const invalidJson = validateStandaloneDeliverable({
  contract: jsonContract,
  prompt: '生成 JSON 文件',
  answer: '<!-- janus-content-type: deliverable -->\n交付数据已整理。\n\n交付文件：`交付数据.json`',
  workspaceRoot,
});
assert.equal(invalidJson.passed, false);
assert.equal(invalidJson.failureCode, 'required_file_invalid');
await writeFile(path.join(workspaceRoot, '交付数据.json'), JSON.stringify({ status: 'ready' }), 'utf8');
const validJson = validateStandaloneDeliverable({
  contract: jsonContract,
  prompt: '生成 JSON 文件',
  answer: '<!-- janus-content-type: deliverable -->\n交付数据已整理。\n\n交付文件：`交付数据.json`',
  workspaceRoot,
});
assert.equal(validJson.passed, true, JSON.stringify(validJson));
const answerContract = createDeliverableContract({ prompt: '中国的首都是哪里？' });
assert.equal(answerContract.requested_output_type, 'answer');
assert.equal(answerContract.requires_content_type_declaration, false);
const pptAgentMessageContract = createDeliverableContract({
  prompt: '告诉我的PPTAgent，让它跟我说“hello”。',
  objective: { taskType: 'file_generation' },
});
assert.equal(pptAgentMessageContract.requested_output_type, 'answer');
assert.equal(pptAgentMessageContract.requires_file, false);
const pptPlanContract = createDeliverableContract({
  prompt: '请跨部门完成论文写作和 PPT 汇报计划。',
  objective: { taskType: 'file_generation' },
});
assert.equal(pptPlanContract.requested_output_type, 'answer');
assert.equal(pptPlanContract.requires_file, false);
assert.equal(createDeliverableContract({ prompt: '写一份 PPT 制作方案' }).requested_output_type, 'answer');
assert.equal(createDeliverableContract({ prompt: '制作 PPT，并附一份讲解方案' }).requested_output_type, 'presentation');
assert.deepEqual(createDeliverableContract({ prompt: '不需要 PPTX，只要 PDF' }).required_extensions, ['.pdf']);
assert.deepEqual(createDeliverableContract({ prompt: '不需要 PDF，只要 DOCX' }).required_extensions, ['.docx']);
assert.equal(createDeliverableContract({ prompt: '生成 CSV 文件，不要只生成文件，还要给出摘要' }).requested_output_type, 'spreadsheet');

const workflowReportContract = createDeliverableContract({ prompt: '写一份 Agent 工作流报告' });
const workflowReport = validateStandaloneDeliverable({
  contract: workflowReportContract,
  prompt: '写一份 Agent 工作流报告',
  answer: `<!-- janus-content-type: deliverable -->
# Agent 工作流报告

## 摘要
本报告梳理 Agent 工作流的输入、处理、校验和交付阶段，并明确各阶段的责任边界、质量标准与异常处理原则。

## 工作流设计
输入阶段确认目标和约束，处理阶段按依赖顺序完成任务，校验阶段对交付内容与用户目标进行对照，避免把调度记录当作交付成果。

## 质量保障与结论
通过内容分类、文件格式校验和失败状态管理，确保每次对外展示的结果都是可验收、可定位且与任务主题一致的正式成果。`,
  workspaceRoot,
});
assert.equal(workflowReport.passed, true, JSON.stringify(workflowReport));

if (process.platform !== 'win32') {
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-deliverable-outside-'));
  const outsideReport = path.join(outsideRoot, '环境治理报告-外部.md');
  const linkedReport = path.join(workspaceRoot, '环境治理报告-外链.md');
  await writeFile(outsideReport, reportBody, 'utf8');
  await symlink(outsideReport, linkedReport);
  const linkedContract = createDeliverableContract({ prompt: '生成一份环境治理报告.md' });
  const linkedResult = validateStandaloneDeliverable({
    contract: linkedContract,
    prompt: '生成一份环境治理报告.md',
    answer: `<!-- janus-content-type: deliverable -->\n${reportBody}\n\n交付文件：\`环境治理报告-外链.md\``,
    workspaceRoot,
  });
  assert.equal(linkedResult.passed, false);
  assert.equal(linkedResult.failureCode, 'required_file_missing');
}

const cleanWorkspace = path.join(workspaceRoot, 'clean-delegation-output');
await mkdir(cleanWorkspace);
const cleanDeliverablePath = ensureDelegationEditableDraftFile({
  workspaceRoot: cleanWorkspace,
  delegation: { title: '环境治理报告', instruction: '写一份环境治理报告' },
  answer: `<!-- janus-content-type: deliverable -->\n${reportBody}\n\n你可以继续告诉我需要修改的地方，或回复“提交到任务群”。`,
  force: true,
});
assert.equal(path.basename(cleanDeliverablePath), '环境治理报告.md');
assert.equal(await readFile(cleanDeliverablePath, 'utf8'), `${reportBody}\n`);

const acceptedCard = renderTaskProgressCard({
  content: '任务已完成：环境治理报告',
  taskRunId: 'task-report',
  taskStatus: 'completed',
  terminal: true,
  progress: { total: 1, completed: 1, percent: 100 },
  nodes: [{ id: 'node-final', title: '执行链路', agentId: 'general_agent', status: 'completed', summary: '过程日志' }],
  deliverable: accepted,
  resultState: 'accepted',
  technicalDetails: { diagnostics: [{ summary: '内部诊断记录' }] },
});
assert.match(acceptedCard, /已交付 · 等待用户确认/);
assert.match(acceptedCard, /环境治理报告\.md/);
assert.match(acceptedCard, />预览</);
assert.match(acceptedCard, />打开</);
assert.match(acceptedCard, />下载</);
assert.match(acceptedCard, />定位</);
assert.match(acceptedCard, /查看技术详情/);
assert.ok(acceptedCard.indexOf('已交付 · 等待用户确认') < acceptedCard.indexOf('查看技术详情'));

const rejectedCard = renderTaskProgressCard({
  content: '任务需要修正：环境治理报告',
  taskRunId: 'task-report-bad',
  taskStatus: 'failed',
  terminal: true,
  progress: { total: 1, completed: 1, failed: 0, percent: 100 },
  deliverable: rejectedQuality,
  resultState: 'needs_revision',
});
assert.match(rejectedCard, /需要修正/);
assert.match(rejectedCard, /class="is-failed"><i>!</);
assert.doesNotMatch(rejectedCard, /aria-label="最终交付"/);

const previousMessages = state.messages;
state.messages = [{
  id: 'assistant-deliverable',
  role: 'assistant',
  content: '内部过程文本',
  metadata: { deliverableResult: accepted, resultState: 'accepted' },
}];
const standardAssistantCard = renderMessageList();
state.messages = previousMessages;
assert.match(standardAssistantCard, /class="final-deliverable-card is-accepted"/);
assert.match(standardAssistantCard, /查看正文/);
assert.match(standardAssistantCard, /<details class="final-deliverable-body"[^>]*>/);
assert.doesNotMatch(standardAssistantCard, /<details class="final-deliverable-body"[^>]*\sopen(?:\s|>)/);
assert.match(standardAssistantCard, /环境治理报告\.md/);

console.log('deliverable contract smoke passed');
