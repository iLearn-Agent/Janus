import fs from 'node:fs';
import path from 'node:path';
import { readZipEntries } from '../../../zip.js';
import { OFFICE_FILE_EXTENSIONS, inspectOfficeFile } from '../../../officeArtifacts.js';

const CONTENT_TYPES = new Set([
  'deliverable',
  'draft',
  'process_log',
  'diagnostic',
  'intermediate_artifact',
]);

const TEXT_FILE_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.html', '.htm', '.json', '.csv', '.tsv', '.svg', '.mmd', '.mermaid', '.drawio']);
const REPORT_BODY_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.html', '.htm']);
const PROCESS_LANGUAGE = /(?:执行链路|链路执行|任务图|节点执行|调度过程|过程日志|诊断信息|task\s*graph|process\s*log|execution\s*(?:chain|trace)|agent\s*(?:routing|workflow))/i;
const PROCESS_TOPIC = /(?:执行链路|任务图|节点执行|调度|工作流|task\s*graph|execution\s*(?:chain|trace)|agent\s*(?:routing|workflow)|workflow)/i;
const PROCESS_TERMS = /(?:已完成|执行|链路|节点|调度|路由|工作流|任务图|agent|workflow|task\s*graph|diagnostic|日志)/gi;
const ENVIRONMENT_TERMS = /(?:污染|排放|生态|固废|污水|废水|废气|能耗|碳排|资源|土壤|噪声|监测|整改|合规|制度|责任|指标|风险|治理措施|实施保障)/g;
const FILE_TYPE_EXTENSIONS = {
  presentation: new Set(['.pptx']),
  spreadsheet: new Set(['.xlsx', '.xls', '.csv', '.tsv']),
  image: new Set(['.png', '.jpg', '.jpeg', '.webp']),
};
const DEFAULT_FILE_EXTENSION = Object.freeze({
  presentation: '.pptx',
  spreadsheet: '.xlsx',
  image: '.png',
});
const HOST_WRITABLE_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.json', '.csv', '.tsv', '.html', '.htm', '.svg', '.mmd', '.mermaid', '.drawio',
  '.docx', '.xlsx', '.pptx', '.pdf', '.png', '.jpg', '.jpeg', '.webp',
]);
const PLANNED_DELIVERABLE_TYPES = new Set(['answer', 'report', 'document', 'presentation', 'spreadsheet', 'image', 'code_change']);
const PLANNED_DELIVERABLE_ROLES = new Set(['primary', 'supporting', 'intermediate']);

export function createDeliverableContract({ prompt = '', objective = null, finalNode = null, deliverablePlan = null } = {}) {
  const request = String(prompt || objective?.summary || '').replace(/\s+/g, ' ').trim();
  const plannedDeliverables = normalizePlannedDeliverables(deliverablePlan?.deliverables || deliverablePlan, { request, finalNode });
  const primary = plannedDeliverables.find((item) => item.role === 'primary') || null;
  const requestedOutputType = primary?.type || inferRequestedOutputType(request, objective?.taskType || '', finalNode);
  const deliverableTitle = primary?.title || inferDeliverableTitle(request, requestedOutputType);
  const ownerAgent = String(finalNode?.agentId || '').trim();
  const version = primary ? 'deliverable_contract_v2' : 'deliverable_contract_v1';
  const requiresContentTypeDeclaration = requestedOutputType !== 'answer';
  const requiresFileValue = primary
    ? primary.delivery_mode === 'file' || Boolean(FILE_TYPE_EXTENSIONS[requestedOutputType])
    : requiresFile(request, requestedOutputType);
  const requiredExtensions = primary
    ? normalizeRequiredExtensions(primary.required_extensions, requestedOutputType)
    : inferRequiredExtensions(request, requestedOutputType);
  const deliverables = primary ? plannedDeliverables.map((item) => plannedDeliverableContract(item, request)) : [];
  return {
    version,
    source: primary ? 'ubuddy_task_graph' : 'prompt_inference',
    requested_output_type: requestedOutputType,
    deliverable_title: deliverableTitle,
    expected_format: expectedFormat(requestedOutputType, finalNode?.outputFormat || ''),
    acceptance_criteria: acceptanceCriteria(requestedOutputType, deliverableTitle),
    owner_agent: ownerAgent,
    owner_local_id: primary?.owner_local_id || '',
    owner_node_id: primary?.owner_node_id || '',
    final_file_candidates: [],
    requires_content_type_declaration: requiresContentTypeDeclaration,
    declaration_policy: primary ? 'host_infer_if_valid' : 'strict',
    requires_file: requiresFileValue,
    required_extensions: requiredExtensions,
    extension_rule: primary?.extension_rule || inferExtensionRule(request, requiredExtensions),
    format_source: primary?.format_source || (explicitRequiredExtensions(request, requestedOutputType).length ? 'user_explicit' : 'system_default'),
    constraints: primary?.constraints || {},
    deliverables,
  };
}

export function validateDeliverableContractExecutable(contract = {}) {
  const unsupported = [];
  for (const deliverable of formalDeliverableContracts(contract)) {
    if (!deliverable.requires_file || deliverable.requested_output_type === 'code_change') continue;
    const extensions = (deliverable.required_extensions || []).map(normalizeExtension).filter(Boolean);
    if (!extensions.length) {
      unsupported.push({ id: deliverable.id || '', extension: '', reason: 'missing_format' });
      continue;
    }
    for (const extension of extensions) {
      if (!HOST_WRITABLE_EXTENSIONS.has(extension)) {
        unsupported.push({ id: deliverable.id || '', extension, reason: 'unsupported_format' });
      }
    }
  }
  return {
    passed: unsupported.length === 0,
    unsupported,
    summary: unsupported.length
      ? `当前任务发布器无法生成这些交付格式：${[...new Set(unsupported.map((item) => item.extension || '未指定'))].join('、')}。`
      : '交付格式可由任务发布器生成。',
  };
}

export function contractRequiresHostArtifactWriter(contract = {}) {
  return formalDeliverableContracts(contract).some((deliverable) => (
    deliverable.requires_file === true
    && deliverable.requested_output_type !== 'code_change'
  ));
}

export function taskNodeFileDeliverables(contract = {}, node = {}) {
  const nodeIds = new Set([node.id, node.localId].map((item) => String(item || '')).filter(Boolean));
  return formalDeliverableContracts(contract).filter((item) => {
    if (!item.requires_file || item.requested_output_type === 'code_change') return false;
    const ownerIds = [item.owner_node_id, item.ownerNodeId, item.owner_local_id, item.ownerLocalId]
      .map((value) => String(value || '')).filter(Boolean);
    if (ownerIds.length) return ownerIds.some((value) => nodeIds.has(value));
    const contractOwner = String(contract.owner_node_id || contract.owner_local_id || '');
    return item.role === 'primary' && (!contractOwner || nodeIds.has(contractOwner));
  });
}

export function taskNodeFileDeliveryCheck(contract = {}, node = {}, receipts = {}) {
  const deliverables = taskNodeFileDeliverables(contract, node);
  const receiptList = Object.values(receipts && typeof receipts === 'object' ? receipts : {})
    .filter((receipt) => String(receipt?.taskNodeId || '') === String(node.id || ''));
  const validation = validateDeliveryArtifactFormats({ deliverables }, [], receiptList);
  return { passed: validation.passed, deliverables, missing: validation.missing };
}

export function validateDeliveryArtifactFormats(contract = {}, plannedDeliverables = [], files = []) {
  const formal = formalDeliverableContracts(contract, plannedDeliverables);
  const fileDeliverables = formal.filter((item) => item.requires_file && item.requested_output_type !== 'code_change');
  const anonymousExtensionOwners = new Map();
  for (const deliverable of fileDeliverables) {
    for (const extension of (deliverable.required_extensions || []).map(normalizeExtension).filter(Boolean)) {
      anonymousExtensionOwners.set(extension, Number(anonymousExtensionOwners.get(extension) || 0) + 1);
    }
  }
  const missing = [];
  for (const deliverable of fileDeliverables) {
    const required = (deliverable.required_extensions || []).map(normalizeExtension).filter(Boolean);
    const candidates = (Array.isArray(files) ? files : []).filter((file) => (
      String(file?.deliverableId || file?.deliverable_id || '') === String(deliverable.id || '')
      || (!String(file?.deliverableId || file?.deliverable_id || '') && (
        fileDeliverables.length === 1
        || anonymousExtensionOwners.get(normalizeExtension(path.extname(file.name || file.relativePath || file.path || ''))) === 1
      ))
    ));
    const present = new Set(candidates.map((file) => normalizeExtension(path.extname(file.name || file.relativePath || file.path || ''))).filter(Boolean));
    const rule = String(deliverable.extension_rule || deliverable.extensionRule || 'one_of') === 'all_of' ? 'all_of' : 'one_of';
    const satisfied = required.length
      ? rule === 'all_of' ? required.every((extension) => present.has(extension)) : required.some((extension) => present.has(extension))
      : candidates.length > 0;
    if (!satisfied) {
      const missingExtensions = rule === 'all_of' ? required.filter((extension) => !present.has(extension)) : required;
      missing.push({
        id: deliverable.id || '',
        title: deliverable.deliverable_title || deliverable.title || '交付物',
        rule,
        requiredExtensions: required,
        required_extensions: missingExtensions,
        missingExtensions,
      });
    }
  }
  return { passed: missing.length === 0, missing };
}

export function synthesizeDeliverablePlan({ contract = {}, finalNode = {}, prompt = '' } = {}) {
  const exactSlideCount = contract.requested_output_type === 'presentation'
    ? Math.max(0, Number(/(\d{1,3})\s*页.{0,8}(?:ppt|演示文稿|幻灯片)/i.exec(String(prompt || ''))?.[1] || 0))
    : 0;
  return {
    version: 'deliverable_plan_v2',
    confidence: 0.8,
    deliverables: [{
      id: 'primary',
      role: 'primary',
      type: contract.requested_output_type,
      title: contract.deliverable_title,
      ownerLocalId: finalNode.localId || '',
      deliveryMode: contract.requires_file ? 'file' : 'inline',
      requiredExtensions: contract.required_extensions || [],
      constraints: exactSlideCount > 0 ? { exactSlideCount } : {},
    }],
  };
}

export function createSingleAgentDeliverableContract({ prompt = '', objective = null, finalNode = null } = {}) {
  const resolvedFinalNode = {
    ...(finalNode || {}),
    localId: String(finalNode?.localId || 'single_agent_delivery'),
  };
  const inferred = createDeliverableContract({ prompt, objective, finalNode: resolvedFinalNode });
  if (!deliverableContractRequiresValidation(inferred)) return inferred;
  return createDeliverableContract({
    prompt,
    objective,
    finalNode: resolvedFinalNode,
    deliverablePlan: synthesizeDeliverablePlan({ contract: inferred, finalNode: resolvedFinalNode, prompt }),
  });
}

export function deliverableContractRequiresValidation(contract = {}) {
  return Boolean(contract && contract.requested_output_type && contract.requested_output_type !== 'answer');
}

export function deliverableContractInstructions(contract = {}, { allowEscalationControl = false } = {}) {
  if (!deliverableContractRequiresValidation(contract)) return '';
  return [
    '## Final deliverable contract',
    JSON.stringify(contract, null, 2),
    '',
    'The first non-empty line of the final response must be exactly:',
    '<!-- janus-content-type: deliverable -->',
    allowEscalationControl ? 'Exception: if the host prompt requires an exact escalation control block, return that control block alone and do not add a content-type marker.' : '',
    'Use draft, process_log, diagnostic, or intermediate_artifact instead of deliverable when the requested result is not actually complete.',
    'Never label execution traces, routing notes, Agent/node summaries, or diagnostics as deliverable.',
    contract.requires_file ? 'A real file with an accepted extension must exist in the task workspace, and its exact workspace-relative path must be listed under “交付文件：”.' : 'If a file was generated, list its exact workspace-relative path under “交付文件：”.',
    'For Word, Excel, or PowerPoint deliverables, create a structurally valid Office file. Never put plain text, HTML, JSON, or Markdown into a file and merely rename it to .doc, .docx, .xls, .xlsx, .ppt, or .pptx. Default to .docx, .xlsx, and .pptx; use legacy .doc, .xls, or .ppt only when explicitly requested and a compatible exporter is available.',
  ].filter(Boolean).join('\n');
}

export function parseTaskOutputDeclaration(value = '', { final = false } = {}) {
  const text = String(value || '').trim();
  const patterns = [
    /^<!--\s*janus-content-type\s*:\s*([a-z_]+)\s*-->\s*/i,
    /^\[\s*content[_ -]?type\s*:\s*([a-z_]+)\s*\]\s*/i,
    /^content[_ -]?type\s*:\s*([a-z_]+)\s*\n+/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const type = String(match?.[1] || '').toLowerCase();
    if (!match || !CONTENT_TYPES.has(type)) continue;
    return { contentType: type, declared: true, body: text.slice(match[0].length).trim() };
  }
  return {
    contentType: 'undeclared',
    declared: false,
    body: text,
  };
}

export function validateStandaloneDeliverable({
  contract = null,
  prompt = '',
  objective = null,
  answer = '',
  workspaceRoot = '',
  ownerAgent = '',
  fileCandidates = [],
  declaredContentType = '',
  contentTypeDeclared = null,
} = {}) {
  const resolvedContract = contract || createDeliverableContract({ prompt, objective, finalNode: { agentId: ownerAgent } });
  const parsed = parseTaskOutputDeclaration(answer, { final: true });
  const declaration = declaredContentType ? {
    contentType: declaredContentType,
    declared: contentTypeDeclared == null ? true : Boolean(contentTypeDeclared),
    body: parsed.declared ? parsed.body : String(answer || '').trim(),
  } : parsed;
  const task = {
    title: resolvedContract.deliverable_title,
    prompt,
    metadata: {
      workspaceRoot,
      finalTaskNodeId: 'standalone-final',
      deliverableContract: {
        ...resolvedContract,
        final_file_candidates: [...new Set([...(resolvedContract.final_file_candidates || []), ...fileCandidates.map(fileCandidatePath).filter(Boolean)])],
      },
      nodeOutputDeclarations: { 'standalone-final': declaration },
    },
    nodes: [{
      id: 'standalone-final',
      status: 'completed',
      title: resolvedContract.deliverable_title,
      agentId: ownerAgent,
      dependencies: [],
      resultText: declaration.body,
      evidenceRefs: fileCandidates.map((item) => ({ type: 'file', value: fileCandidatePath(item) })).filter((item) => item.value),
    }],
  };
  return validateTaskDeliverable({ task, workspaceRoot });
}

export function validateTaskDeliverable({ task = {}, workspaceRoot = '' } = {}) {
  const contract = task.metadata?.deliverableContract || createDeliverableContract({
    prompt: task.metadata?.routingPrompt || task.prompt || task.title,
    objective: task.metadata?.objective || null,
  });
  const finalNode = finalTaskNode(task);
  if (!finalNode) return failedResult(contract, 'deliverable_missing', '没有找到最终交付节点。');
  const validationMode = task.metadata?.deliverableValidationMode
    || (task.metadata?.deliverableContractVersion || task.metadata?.deliverableContract?.version ? 'strict' : 'legacy_compatible');
  const legacyCompatible = validationMode === 'legacy_compatible';
  const formalDeliverables = Array.isArray(contract.deliverables) && contract.deliverables.length
    ? contract.deliverables.filter((item) => ['primary', 'supporting'].includes(item.role))
    : [singleDeliverableContract(contract)];
  const results = [];
  for (const deliverable of formalDeliverables) {
    const ownerNode = task.nodes?.find((node) => node.id === deliverable.owner_node_id)
      || task.nodes?.find((node) => node.localId && node.localId === deliverable.owner_local_id)
      || (deliverable.role === 'primary' ? finalNode : null);
    if (!ownerNode) {
      return failedResult(contract, 'deliverable_owner_missing', `没有找到“${deliverable.title || '附属交付物'}”对应的任务节点。`);
    }
    const result = validateOneDeliverable({
      task,
      node: ownerNode,
      contract: deliverable,
      workspaceRoot,
      validationMode,
      legacyCompatible,
      hostInferenceAllowed: String(contract.version || '') === 'deliverable_contract_v2'
        && contract.declaration_policy === 'host_infer_if_valid',
    });
    if (!result.passed) return failedResult(contract, result.failureCode, result.summary, {
      contentType: result.contentType,
      files: result.files,
      checks: result.checks,
      deliverables: [...results, result],
    });
    results.push(result);
  }
  const primaryResult = results.find((item) => item.role === 'primary') || results[0];
  const files = uniqueFiles(results.flatMap((item) => item.files || []));
  return {
    passed: true,
    resultState: legacyCompatible ? 'legacy_accepted' : 'accepted',
    validationState: 'passed',
    failureCode: '',
    summary: primaryResult.summary,
    contentType: 'deliverable',
    contentTypeSource: primaryResult.contentTypeSource || '',
    title: primaryResult.title,
    body: primaryResult.body,
    validationMode,
    files,
    deliverables: results,
    contract: { ...contract, final_file_candidates: files.map((file) => file.relative_path || file.path) },
    checks: primaryResult.checks || [],
  };
}

// Phase 9 deliberately separates evidence collection from quality judgment.
// This function may report objective file facts, but it must never decide
// whether the user's requirements were satisfied; that decision belongs to
// the awakened uBuddy review model.
export function collectTaskDeliveryEvidence({ task = {}, workspaceRoot = '' } = {}) {
  const contract = task.metadata?.deliverableContract || createDeliverableContract({
    prompt: task.metadata?.routingPrompt || task.prompt || task.title,
    objective: task.metadata?.objective || null,
  });
  const finalNode = finalTaskNode(task);
  const declaration = finalNode
    ? task.metadata?.nodeOutputDeclarations?.[finalNode.id]
      || parseTaskOutputDeclaration(finalNode.resultText, { final: true })
    : { contentType: 'undeclared', declared: false, body: '' };
  const body = String(declaration.body ?? finalNode?.resultText ?? '').trim();
  const files = finalNode ? collectFinalFileCandidates({
    task,
    finalNode,
    body,
    workspaceRoot,
    contract,
    allowAllSafeFiles: true,
  }).map((file) => ({
    ...file,
    readable: true,
    structurallyValid: validDeliverableFile(file),
    slideCount: path.extname(file.path || file.name || '').toLowerCase() === '.pptx'
      ? pptSlideCount(file.path) : 0,
  })) : [];
  return {
    version: 'delivery_evidence_v1',
    taskRunId: String(task.id || ''),
    taskNodeId: String(finalNode?.id || ''),
    originalRequest: String(task.metadata?.routingPrompt || task.prompt || task.title || ''),
    objective: task.metadata?.objective || null,
    plannedDeliverables: task.metadata?.deliverablePlan?.deliverables || contract.deliverables || [],
    advisoryContract: contract,
    declaration: {
      contentType: declaration.contentType || 'undeclared',
      declared: Boolean(declaration.declared),
    },
    body,
    files,
    facts: [
      ...(!finalNode ? [{ code: 'final_node_not_found', summary: 'No final task node was identified.' }] : []),
      ...(!body && !files.length ? [{ code: 'submission_empty', summary: 'The submission contains no body or registered files.' }] : []),
      ...files.filter((file) => !file.structurallyValid).map((file) => ({
        code: 'artifact_structure_unreadable',
        summary: `${file.name || 'Artifact'} could not be structurally verified.`,
        artifact: file.relative_path || file.name || '',
      })),
    ],
  };
}

function validateOneDeliverable({ task = {}, node = {}, contract = {}, workspaceRoot = '', validationMode = 'strict', legacyCompatible = false, hostInferenceAllowed = false } = {}) {
  const declaration = task.metadata?.nodeOutputDeclarations?.[node.id]
    || parseTaskOutputDeclaration(node.resultText, { final: contract.role === 'primary' });
  const effectiveDeclaration = legacyCompatible && !declaration.declared
    ? { ...declaration, contentType: 'deliverable' }
    : hostInferenceAllowed && !declaration.declared
      ? { ...declaration, contentType: 'deliverable', declarationSource: 'host_inferred_deliverable' }
    : declaration;
  const body = String(effectiveDeclaration.body ?? node.resultText ?? '').trim();
  if (!legacyCompatible && !hostInferenceAllowed && contract.requires_content_type_declaration !== false && !effectiveDeclaration.declared) {
    return validationFailure(contract, 'content_type_undeclared', '最终结果没有声明内容类型，不能确认它是正式交付物。');
  }
  if (effectiveDeclaration.contentType !== 'deliverable') {
    return validationFailure(contract, 'wrong_content_type', `最终节点声明为 ${effectiveDeclaration.contentType || 'unknown'}，不是 deliverable。`, {
      contentType: effectiveDeclaration.contentType || 'unknown',
    });
  }

  const files = collectFinalFileCandidates({ task, finalNode: node, body, workspaceRoot, contract });
  const candidateBodies = [{ source: 'answer', content: body, file: null }];
  for (const file of files) {
    const ext = path.extname(file.path || file.name || '').toLowerCase();
    const receipt = task.metadata?.taskArtifactReceipts?.[file.relative_path] || null;
    const content = TEXT_FILE_EXTENSIONS.has(ext)
      ? readTextFile(file.path)
      : String(receipt?.validationText || '');
    if (content) candidateBodies.push({ source: file.name, content, file });
  }
  if (!candidateBodies.some((item) => String(item.content || '').trim())) {
    return validationFailure(contract, 'deliverable_missing', '最终节点没有可验收的交付正文或文件。', { files });
  }

  const requiredExtensions = new Set((contract.required_extensions || []).map((item) => String(item).toLowerCase()));
  const requiredFiles = contract.requires_file
    ? files.filter((file) => !requiredExtensions.size || requiredExtensions.has(path.extname(file.path || file.name || '').toLowerCase()))
    : [];
  if (contract.requires_file && !requiredFiles.length) {
    return validationFailure(contract, 'required_file_missing', requiredExtensions.size
      ? `没有找到要求格式的交付文件：${[...requiredExtensions].join('、')}。`
      : '没有找到用户要求的真实交付文件。', { files });
  }
  if (contract.requires_file && !requiredFiles.some((file) => validDeliverableFile(file))) {
    return validationFailure(contract, 'required_file_invalid', '找到了目标扩展名的文件，但文件为空、结构损坏或实际格式不匹配。', { files });
  }
  const exactSlideCount = Math.max(0, Number(contract.constraints?.exact_slide_count || 0));
  if (contract.requested_output_type === 'presentation' && exactSlideCount > 0) {
    const matchingPpt = requiredFiles.find((file) => path.extname(file.path || file.name || '').toLowerCase() === '.pptx');
    const actualSlideCount = matchingPpt ? pptSlideCount(matchingPpt.path) : 0;
    if (actualSlideCount !== exactSlideCount) {
      return validationFailure(contract, 'presentation_slide_count_mismatch', `PPT 页数不符合要求：需要 ${exactSlideCount} 页，实际 ${actualSlideCount} 页。`, { files });
    }
  }

  const checks = candidateBodies.map((candidate) => validateCandidateBody(candidate.content, contract));
  const validBodyIndex = checks.findIndex((check) => check.passed);
  const invalidReportFiles = contract.requested_output_type === 'report'
    ? checks.map((check, index) => ({ check, file: candidateBodies[index].file })).filter((item) => (
        item.file
        && REPORT_BODY_EXTENSIONS.has(path.extname(item.file.path || item.file.name || '').toLowerCase())
        && !item.check.passed
      ))
    : [];
  if (validBodyIndex < 0 || invalidReportFiles.length) {
    const firstFailure = invalidReportFiles[0]?.check || checks[0];
    return validationFailure(contract, firstFailure?.code || 'deliverable_quality_failed', firstFailure?.summary || '最终交付物未通过内容验收。', {
      files,
      checks,
    });
  }

  const acceptedBody = candidateBodies[validBodyIndex].content.trim();
  const summary = deliverableSummary(acceptedBody, contract.deliverable_title);
  return {
    passed: true,
    role: contract.role || 'primary',
    requestedOutputType: contract.requested_output_type,
    summary,
    contentType: 'deliverable',
    contentTypeSource: effectiveDeclaration.declarationSource || (effectiveDeclaration.declared ? 'agent' : legacyCompatible ? 'legacy' : ''),
    title: contract.deliverable_title,
    body: acceptedBody,
    files,
    checks,
  };
}

function normalizePlannedDeliverables(value = [], { request = '', finalNode = null } = {}) {
  const source = Array.isArray(value) ? value : [];
  const normalized = source.slice(0, 12).map((item, index) => {
    if (!item || typeof item !== 'object') return null;
    const role = String(item.role || (index === 0 ? 'primary' : 'intermediate')).trim().toLowerCase();
    const type = String(item.type || item.requested_output_type || '').trim().toLowerCase();
    if (!PLANNED_DELIVERABLE_ROLES.has(role) || !PLANNED_DELIVERABLE_TYPES.has(type)) return null;
    const exactSlideCount = Math.max(0, Math.min(500, Number(item.constraints?.exactSlideCount
      ?? item.constraints?.exact_slide_count ?? item.exactSlideCount ?? item.exact_slide_count ?? 0) || 0));
    const explicitExtensions = explicitRequiredExtensions(request, type);
    const genericTextDocument = ['document', 'report'].includes(type) && explicitExtensions.length === 0;
    const requestedExtensions = explicitExtensions.length
      ? explicitExtensions
      : normalizeRequiredExtensions([], type);
    return {
      id: String(item.id || `deliverable_${index + 1}`).trim().slice(0, 80),
      role,
      type,
      title: String(item.title || '').trim().slice(0, 160) || inferDeliverableTitle(request, type),
      owner_local_id: String(item.ownerLocalId || item.owner_local_id || '').trim().slice(0, 80),
      owner_node_id: String(item.ownerNodeId || item.owner_node_id || '').trim().slice(0, 120),
      delivery_mode: genericTextDocument
        ? 'inline'
        : ['inline', 'file'].includes(String(item.deliveryMode || item.delivery_mode || '').toLowerCase())
          ? String(item.deliveryMode || item.delivery_mode).toLowerCase()
          : FILE_TYPE_EXTENSIONS[type] ? 'file' : 'inline',
      required_extensions: genericTextDocument
        ? []
        : requestedExtensions,
      extension_rule: inferExtensionRule(request, explicitExtensions),
      format_source: explicitExtensions.length ? 'user_explicit' : 'system_default',
      constraints: exactSlideCount > 0 ? { exact_slide_count: exactSlideCount } : {},
    };
  }).filter(Boolean);
  if (normalized.filter((item) => item.role === 'primary').length !== 1) return [];
  const primary = normalized.find((item) => item.role === 'primary');
  if (!primary.owner_local_id && !primary.owner_node_id && finalNode?.localId) primary.owner_local_id = String(finalNode.localId);
  return normalized;
}

function plannedDeliverableContract(item = {}, request = '') {
  const requiresFileValue = item.delivery_mode === 'file' || Boolean(FILE_TYPE_EXTENSIONS[item.type]);
  return {
    id: item.id,
    role: item.role,
    requested_output_type: item.type,
    deliverable_title: item.title,
    expected_format: expectedFormat(item.type, ''),
    acceptance_criteria: acceptanceCriteria(item.type, item.title),
    owner_local_id: item.owner_local_id || '',
    owner_node_id: item.owner_node_id || '',
    final_file_candidates: [],
    requires_content_type_declaration: item.type !== 'answer',
    requires_file: requiresFileValue,
    required_extensions: normalizeRequiredExtensions(item.required_extensions, item.type),
    extension_rule: item.extension_rule || 'one_of',
    format_source: item.format_source || 'system_default',
    constraints: item.constraints || {},
    source_request: request.slice(0, 500),
  };
}

function normalizeRequiredExtensions(value = [], type = '') {
  const defaultExtension = DEFAULT_FILE_EXTENSION[type] || '';
  const allowed = new Set(['.md', '.markdown', '.txt', '.html', '.htm', '.json', '.csv', '.tsv', '.svg', '.mmd', '.mermaid', '.drawio', '.xlsx', '.xls', '.doc', '.docx', '.pdf', '.ppt', '.pptx', '.png', '.jpg', '.jpeg', '.webp']);
  const explicit = [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim().toLowerCase())
    .map((item) => item && !item.startsWith('.') ? `.${item}` : item)
    .filter((item) => allowed.has(item)))];
  if (!defaultExtension) return explicit;
  if (type === 'presentation' && explicit.includes('.ppt')) return ['.ppt'];
  const compatible = explicit.filter((item) => FILE_TYPE_EXTENSIONS[type]?.has(item));
  return compatible.length ? compatible : [defaultExtension];
}

function inferFinalNodeOutputType(finalNode = null, request = '') {
  if (!finalNode) return '';
  const nodeText = [finalNode.title, finalNode.objective, finalNode.outputFormat].filter(Boolean).join(' ');
  const agentText = `${finalNode.agentId || ''} ${finalNode.departmentId || ''}`;
  const presentationRequested = /(?:pptx?|演示文稿|幻灯片|\bdeck\b|\bpresentation\b)/i.test(request);
  const presentationCreation = /(?:制作|生成|创建|输出|导出|做一份|做一个|做成).{0,20}(?:pptx?|演示文稿|幻灯片)|(?:pptx?|演示文稿|幻灯片).{0,20}(?:制作|生成|创建|输出|导出|做成)/i.test(request);
  if (/\bpptx\b|可编辑.{0,6}(?:ppt|演示文稿)|(?:ppt|slide|deck|演示文稿|幻灯片).{0,10}(?:文件|产物|交付)/i.test(nodeText)
    || (/\bppt(?:_|\b)|ppt_department/i.test(agentText) && presentationRequested && presentationCreation)) return 'presentation';
  if (/(?:xlsx?|excel|spreadsheet|csv|tsv|电子表格)/i.test(nodeText)) return 'spreadsheet';
  if (/(?:png|jpe?g|webp|image|poster|图片|图像|海报)/i.test(nodeText)) return 'image';
  return '';
}

function singleDeliverableContract(contract = {}) {
  return { ...contract, role: 'primary' };
}

function validationFailure(contract = {}, failureCode = '', summary = '', extra = {}) {
  return {
    passed: false,
    role: contract.role || 'primary',
    failureCode,
    summary,
    contentType: extra.contentType || '',
    files: extra.files || [],
    checks: extra.checks || [],
    title: contract.deliverable_title || '任务交付物',
  };
}

function uniqueFiles(files = []) {
  return [...new Map(files.filter(Boolean).map((file) => [String(file.path || file.relative_path || file.name || ''), file])).values()];
}

function inferRequestedOutputType(request = '', taskType = '', finalNode = null) {
  const originalRequest = String(request || '')
    .replace(/@?\s*(?:我的)?\s*ppt\s*agent\b/gi, ' ')
    .replace(/@?\s*(?:我的)?\s*ppt\s*(?:员工)?\s*(?:agent|智能体)/gi, ' ');
  const deliverableRequest = stripNegatedFileFormats(originalRequest);
  const explicitlyNoFile = explicitlyDeclinesFile(originalRequest);
  const finalNodeType = inferFinalNodeOutputType(finalNode, deliverableRequest);
  if (finalNodeType) return finalNodeType;
  if (/(?:环境治理|治理).{0,12}报告|报告|\breport\b/i.test(deliverableRequest)) return 'report';
  if (explicitlyNoFile) return 'answer';
  const presentationRequested = /(?:pptx?|演示文稿|幻灯片|\bdeck\b|\bpresentation\b)/i.test(deliverableRequest);
  const presentationPlanOnly = /(?:pptx?|演示文稿|幻灯片|\bdeck\b|\bpresentation\b).{0,10}(?:计划|方案|大纲|提纲|建议)|(?:计划|方案|大纲|提纲|建议).{0,10}(?:pptx?|演示文稿|幻灯片|\bdeck\b|\bpresentation\b)/i.test(deliverableRequest);
  const presentationArtifactExplicit = /\bpptx\b|可编辑.{0,4}(?:ppt|演示文稿)|(?:导出|生成|创建).{0,10}(?:ppt|演示文稿).{0,4}(?:文件|产物)/i.test(deliverableRequest);
  const presentationCreatedSeparately = /(?:制作|生成|创建|做一份|做一个|做成).{0,12}(?:ppt|演示文稿)(?:\s*[,，、]|并|以及|同时|再)/i.test(deliverableRequest);
  if (presentationRequested && (!presentationPlanOnly || presentationArtifactExplicit || presentationCreatedSeparately)) return 'presentation';
  if (/(?:表格|电子表格|excel|xlsx?|csv|tsv|spreadsheet)/i.test(deliverableRequest)) return 'spreadsheet';
  if (/(?:图片|图像|海报|插图|image|poster|illustration)/i.test(deliverableRequest)) return 'image';
  if (taskType === 'code_change') return 'code_change';
  if (/(?:文件|文档|document|file|docx?|\bpdf\b|markdown|\bmd\b|\bjson\b|\btxt\b|\bhtml?\b|\bsvg\b|\bmermaid\b|\bdrawio\b|\bmmd\b)/i.test(deliverableRequest)) return 'document';
  return 'answer';
}

function inferDeliverableTitle(request = '', requestedOutputType = 'answer') {
  const cleanRequest = String(request || '').replace(/@[^\s，。；]+/g, '').trim();
  const report = /(?:写|撰写|编写|制作|生成)(?:一份|一个)?\s*[“"']?([^，。；\n]{2,36}?报告)[”"']?(?:给我|给我们|即可|$|[，。；])/i.exec(cleanRequest)?.[1]
    || /[“"']?([^，。；\n]{2,36}?报告)[”"']?(?:给我|给我们|即可|$|[，。；])/i.exec(cleanRequest)?.[1];
  if (requestedOutputType === 'presentation' && report) {
    return `${report.replace(/^(?:写|撰写|编写|制作|生成)(?:一份|一个)?/, '').replace(/报告$/i, '').trim()}PPT`;
  }
  if (report) return normalizeReportTitle(report);
  const quoted = /[“"']([^”"']{2,48})[”"']/.exec(request)?.[1];
  if (quoted) return quoted.trim();
  if (requestedOutputType === 'report') return '任务报告';
  return String(request || '任务交付物').slice(0, 80);
}

function expectedFormat(type = '', nodeFormat = '') {
  if (type === 'report') return nodeFormat || 'Markdown report正文（可附 .md 文件）';
  if (type === 'presentation') return nodeFormat || '可编辑 PPTX';
  if (type === 'spreadsheet') return nodeFormat || '可下载电子表格';
  if (type === 'image') return nodeFormat || '可预览与下载的图片';
  return nodeFormat || '可直接交付的最终结果';
}

function requiresFile(request = '', type = '') {
  if (explicitlyDeclinesFile(request)) return false;
  if (FILE_TYPE_EXTENSIONS[type]) return true;
  if (['document', 'report'].includes(type)) return inferRequiredExtensions(request, type).length > 0;
  return /(?:生成|创建|导出|保存|下载).{0,12}(?:文件|文档)|(?:文件|文档).{0,12}(?:生成|创建|导出|保存|下载)|\.(?:md|docx?|pptx?|xlsx?|xls|pdf|txt|html?|svg|mmd|mermaid|drawio)\b|\b(?:docx?|pdf|json|txt|html?|svg|mmd|mermaid|drawio)\b/i.test(request);
}

function inferRequiredExtensions(request = '', type = '') {
  const explicit = explicitRequiredExtensions(request, type);
  if (explicit.length) return explicit;
  const fallback = DEFAULT_FILE_EXTENSION[type] || '';
  return fallback ? [fallback] : [];
}

function explicitRequiredExtensions(request = '', type = '') {
  const text = stripNegatedFileFormats(String(request || ''));
  const explicit = [...text.matchAll(/\.(md|markdown|txt|html?|json|csv|tsv|svg|mmd|mermaid|drawio|xlsx?|docx?|pdf|pptx?|png|jpe?g|webp)\b/gi)]
    .map((match) => `.${String(match[1] || '').toLowerCase()}`);
  const legacyWord = /(?:word.{0,8}(?:97\s*[-–]\s*2003|2003)|(?:97\s*[-–]\s*2003|2003).{0,8}word|\.doc\b)/i.test(text);
  if (/\bdocx?\b/i.test(text) || /\bword\b/i.test(text)) explicit.push(legacyWord ? '.doc' : '.docx');
  if (/\bpdf\b/i.test(text)) explicit.push('.pdf');
  if (/\bmarkdown\b/i.test(text)) explicit.push('.md', '.markdown');
  if (/\bmd\b/i.test(text)) explicit.push('.md');
  if (/\bjson\b/i.test(text)) explicit.push('.json');
  if (/\btxt\b/i.test(text)) explicit.push('.txt');
  if (/\bhtml?\b/i.test(text)) explicit.push(/\bhtm\b/i.test(text) && !/\bhtml\b/i.test(text) ? '.htm' : '.html');
  if (/\bsvg\b/i.test(text)) explicit.push('.svg');
  if (/\bmermaid\b/i.test(text)) explicit.push('.mermaid');
  if (/\bmmd\b/i.test(text)) explicit.push('.mmd');
  if (/\bdrawio\b/i.test(text)) explicit.push('.drawio');
  const legacyPowerPoint = /(?:powerpoint|ppt).{0,8}(?:97\s*[-–]\s*2003|2003)|(?:97\s*[-–]\s*2003|2003).{0,8}(?:powerpoint|ppt)|\.ppt\b/i.test(text);
  if (/\bpptx?\b|powerpoint/i.test(text)) explicit.push(legacyPowerPoint ? '.ppt' : '.pptx');
  const legacyExcel = /(?:excel.{0,8}(?:97\s*[-–]\s*2003|2003)|(?:97\s*[-–]\s*2003|2003).{0,8}excel)/i.test(text);
  if (/\bxlsx\b/i.test(text) || (/\bexcel\b/i.test(text) && !legacyExcel)) explicit.push('.xlsx');
  if (legacyExcel) explicit.push('.xls');
  if (/\bxls\b/i.test(text)) explicit.push('.xls');
  if (/\bcsv\b/i.test(text)) explicit.push('.csv');
  if (/\btsv\b/i.test(text)) explicit.push('.tsv');
  if (/\bpng\b/i.test(text)) explicit.push('.png');
  if (/\bjpe?g\b/i.test(text)) explicit.push(/\bjpeg\b/i.test(text) ? '.jpeg' : '.jpg');
  if (/\bwebp\b/i.test(text)) explicit.push('.webp');
  const uniqueExplicit = [...new Set(explicit)];
  if (!FILE_TYPE_EXTENSIONS[type]) return uniqueExplicit;
  if (type === 'presentation' && uniqueExplicit.includes('.ppt')) return ['.ppt'];
  return uniqueExplicit.filter((extension) => FILE_TYPE_EXTENSIONS[type].has(extension));
}

function formalDeliverableContracts(contract = {}, plannedDeliverables = []) {
  if (Array.isArray(contract.deliverables) && contract.deliverables.length) {
    return contract.deliverables.filter((item) => ['primary', 'supporting'].includes(String(item?.role || 'primary')));
  }
  if (Array.isArray(plannedDeliverables) && plannedDeliverables.length) {
    return plannedDeliverables
      .filter((item) => ['primary', 'supporting'].includes(String(item?.role || 'primary')))
      .map((item) => ({
        ...item,
        requested_output_type: item.requested_output_type || item.type || '',
        deliverable_title: item.deliverable_title || item.title || '',
        requires_file: item.requires_file === true || String(item.delivery_mode || item.deliveryMode || '') === 'file',
        required_extensions: item.required_extensions || item.requiredExtensions || [],
        extension_rule: item.extension_rule || item.extensionRule || 'one_of',
      }));
  }
  return [{ ...contract, id: contract.id || 'primary', role: contract.role || 'primary' }];
}

function inferExtensionRule(request = '', extensions = []) {
  if (!Array.isArray(extensions) || extensions.length <= 1) return 'one_of';
  if (extensions.every((item) => ['.md', '.markdown'].includes(item))) return 'one_of';
  return /(?:\bor\b|或|任选|任一|其中一种)/i.test(String(request || '')) ? 'one_of' : 'all_of';
}

function normalizeExtension(value = '') {
  const clean = String(value || '').trim().toLowerCase();
  return clean && !clean.startsWith('.') ? `.${clean}` : clean;
}

function explicitlyDeclinesFile(request = '') {
  const text = String(request || '');
  return /(?:先别|不要|不用|无需|不需要|不必|禁止|别)(?!只|仅).{0,8}(?:创建|生成|制作|导出|保存|提供)?.{0,4}(?:文件|文档|附件)|(?:文件|文档|附件).{0,4}(?:先别|不要|不用|无需|不需要|不必|别)(?!只|仅)/i.test(text);
}

function stripNegatedFileFormats(request = '') {
  return String(request || '').replace(
    /(?:先别|不要|不用|无需|不需要|不必|禁止|别)(?!只|仅)\s*(?:(?:生成|创建|制作|导出|提供|使用)(?:成|为)?\s*)?(?:(?:任何|额外|一份|一个)\s*)?(?:pptx?|演示文稿|幻灯片|pdf|docx?|xlsx?|xls|excel|csv|tsv|png|jpe?g|webp|json|html?|svg|mmd|mermaid|drawio|txt|markdown|md)(?:文件|文档|附件)?/gi,
    ' ',
  );
}

function acceptanceCriteria(type = '', title = '') {
  const base = type === 'answer' ? [
    '回答应直接满足用户问题，不把过程日志或技术诊断冒充为答案。',
  ] : [
    '最终输出必须声明 content_type=deliverable。',
    '过程日志、技术诊断和中间产物不得进入最终交付区。',
    `交付标题、摘要和正文必须与“${title || '用户目标'}”一致。`,
  ];
  if (type === 'report') base.push('正文必须具备报告标题、摘要或概述，以及至少两个与主题相关的章节。', '不能只描述执行了哪些 Agent、节点或链路。');
  return base;
}

function finalTaskNode(task = {}) {
  const nodes = Array.isArray(task.nodes) ? task.nodes : [];
  const explicitId = String(task.metadata?.finalTaskNodeId || '');
  const explicit = nodes.find((node) => node.id === explicitId);
  if (explicit) return explicit;
  const dependedOn = new Set(nodes.flatMap((node) => node.dependencies || []));
  return nodes.find((node) => node.status === 'completed' && !dependedOn.has(node.id))
    || nodes.filter((node) => node.status === 'completed').at(-1)
    || null;
}

function collectFinalFileCandidates({
  task = {}, finalNode = {}, body = '', workspaceRoot = '', contract = null, allowAllSafeFiles = false,
} = {}) {
  const root = path.resolve(String(workspaceRoot || task.metadata?.workspaceRoot || '').trim() || '.');
  const realRoot = safeRealPath(root) || root;
  const resolvedContract = contract || task.metadata?.deliverableContract || {};
  const labeledBodyFiles = extractLabeledFileReferences(body);
  const raw = [
    ...(Array.isArray(task.metadata?.generatedTaskFiles) ? task.metadata.generatedTaskFiles : [])
      .map((item) => ({ value: fileCandidatePath(item), trusted: true, deliverableId: item.deliverable_id || item.deliverableId || '' })),
    ...(resolvedContract.final_file_candidates || []).map((value) => ({ value, trusted: false, deliverableId: '' })),
    ...(finalNode.evidenceRefs || []).filter((item) => ['file', 'artifact'].includes(item?.type)).map((item) => ({ value: item.value || item.path || item.label, trusted: item.type === 'artifact', deliverableId: item.deliverableId || item.deliverable_id || '' })),
    ...(Array.isArray(task.metadata?.deliverableResult?.files) ? task.metadata.deliverableResult.files : [])
      .map((item) => ({ value: fileCandidatePath(item), trusted: true, deliverableId: item.deliverable_id || item.deliverableId || '' })),
    ...labeledBodyFiles.map((value) => ({ value, trusted: true, deliverableId: '' })),
  ];
  const seen = new Set();
  const files = [];
  for (const candidate of raw) {
    const clean = String(candidate.value || '').trim().replace(/^['"`<]+|['"`>,.;:]+$/g, '');
    if (!clean || /^https?:\/\//i.test(clean)) continue;
    const resolved = path.resolve(root, clean);
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    if (!fs.existsSync(resolved)) continue;
    const realResolved = safeRealPath(resolved);
    if (!realResolved || pathOutsideRoot(realRoot, realResolved)) continue;
    if (seen.has(realResolved)) continue;
    if (!fs.statSync(realResolved).isFile()) continue;
    if (!allowAllSafeFiles && !candidate.trusted && !isLikelyFinalFile(resolved, resolvedContract)) continue;
    seen.add(realResolved);
    const stat = fs.statSync(realResolved);
    files.push({
      name: path.basename(resolved),
      filename: path.basename(resolved),
      path: resolved,
      relative_path: relative.replace(/\\/g, '/'),
      size: stat.size,
      kind: path.extname(resolved).slice(1).toLowerCase(),
      deliverableId: String(candidate.deliverableId || ''),
    });
  }
  return files;
}

function extractLabeledFileReferences(body = '') {
  const values = [];
  for (const line of String(body || '').split(/\r?\n/)) {
    if (!/(?:交付文件|最终文件|产物文件|输出文件|文件路径|deliverable\s*file|output\s*file)\s*[:：]/i.test(line)) continue;
    const tail = line.replace(/^.*?(?:交付文件|最终文件|产物文件|输出文件|文件路径|deliverable\s*file|output\s*file)\s*[:：]\s*/i, '').trim();
    const quoted = [...tail.matchAll(/[`“"']([^`”"']+\.(?:md|markdown|txt|html?|json|csv|tsv|svg|mmd|mermaid|drawio|xlsx?|docx?|pdf|pptx?|png|jpe?g|webp))[`”"']/gi)].map((match) => match[1]);
    const plain = tail.match(/(?:[A-Za-z]:)?[^<>:"|?*\n]+?\.(?:md|markdown|txt|html?|json|csv|tsv|svg|mmd|mermaid|drawio|xlsx?|docx?|pdf|pptx?|png|jpe?g|webp)\b/i)?.[0];
    values.push(...quoted, plain);
  }
  return [...new Set(values.map((item) => String(item || '').trim()).filter(Boolean))];
}

function deliverableLikeFilename(file = '', contract = {}) {
  const name = path.basename(file, path.extname(file)).replace(/[\s_\-]+/g, '').toLowerCase();
  const title = normalizeReportTopic(contract.deliverable_title || '');
  return Boolean(title && name.includes(title.slice(0, Math.min(title.length, 8))));
}

function isLikelyFinalFile(file = '', contract = {}) {
  const ext = path.extname(file).toLowerCase();
  const requiredExtensions = new Set((contract.required_extensions || []).map((item) => String(item || '').toLowerCase()));
  if (requiredExtensions.has(ext)) return true;
  if (['report', 'document'].includes(contract.requested_output_type)) return deliverableLikeFilename(file, contract);
  return true;
}

function safeRealPath(value = '') {
  try {
    return fs.realpathSync(value);
  } catch {
    return '';
  }
}

function pathOutsideRoot(root = '', candidate = '') {
  const relative = path.relative(root, candidate);
  return relative.startsWith('..') || path.isAbsolute(relative);
}

function validDeliverableFile(file = {}) {
  const filePath = String(file.path || '');
  const ext = path.extname(filePath || file.name || '').toLowerCase();
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > 128 * 1024 * 1024) return false;
  if (OFFICE_FILE_EXTENSIONS.has(ext)) return inspectOfficeFile(filePath, ext).valid;
  if (ext === '.pdf') return fileContainsNearStart(filePath, Buffer.from('%PDF-', 'ascii'), 1024)
    && fileContainsNearEnd(filePath, Buffer.from('%%EOF', 'ascii'), 4096);
  if (ext === '.png') return fileStartsWith(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    && fileEndsWith(filePath, Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]));
  if (['.jpg', '.jpeg'].includes(ext)) return fileStartsWith(filePath, Buffer.from([0xff, 0xd8, 0xff]))
    && fileEndsWith(filePath, Buffer.from([0xff, 0xd9]));
  if (ext === '.webp') return validWebp(filePath);
  if (ext === '.json') return validJsonArtifact(filePath);
  if (['.csv', '.tsv', '.md', '.markdown', '.txt', '.html', '.htm', '.svg', '.mmd', '.mermaid', '.drawio'].includes(ext)) return validTextArtifact(filePath);
  return true;
}

function pptSlideCount(filePath = '') {
  try {
    const entries = readZipEntries(filePath);
    return [...entries.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name)).length;
  } catch {
    return 0;
  }
}

function zipEntryHasContent(entries = new Map(), name = '') {
  try {
    const read = entries.get(name);
    return typeof read === 'function' && read().length > 0;
  } catch {
    return false;
  }
}

function fileStartsWith(filePath = '', signature = Buffer.alloc(0)) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(signature.length);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return bytesRead === signature.length && buffer.equals(signature);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function fileEndsWith(filePath = '', signature = Buffer.alloc(0)) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < signature.length) return false;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(signature.length);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, stat.size - signature.length);
      return bytesRead === signature.length && buffer.equals(signature);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function fileContainsNearStart(filePath = '', needle = Buffer.alloc(0), maxBytes = 1024) {
  return fileRegionContains(filePath, needle, { start: 0, length: maxBytes });
}

function fileContainsNearEnd(filePath = '', needle = Buffer.alloc(0), maxBytes = 4096) {
  try {
    const stat = fs.statSync(filePath);
    return fileRegionContains(filePath, needle, { start: Math.max(0, stat.size - maxBytes), length: maxBytes });
  } catch {
    return false;
  }
}

function fileRegionContains(filePath = '', needle = Buffer.alloc(0), { start = 0, length = 1024 } = {}) {
  try {
    const stat = fs.statSync(filePath);
    const size = Math.max(0, Math.min(Number(length || 0), stat.size - start));
    if (!needle.length || size < needle.length) return false;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(size);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.subarray(0, bytesRead).includes(needle);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function validTextArtifact(filePath = '') {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const buffer = Buffer.alloc(Math.min(stat.size, 64 * 1024));
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (!bytesRead) return false;
      return !buffer.subarray(0, bytesRead).includes(0x00);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function validJsonArtifact(filePath = '') {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 16 * 1024 * 1024) return false;
    JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

function validWebp(filePath = '') {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(12);
      if (fs.readSync(fd, buffer, 0, buffer.length, 0) !== buffer.length) return false;
      const stat = fs.fstatSync(fd);
      return buffer.subarray(0, 4).toString('ascii') === 'RIFF'
        && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
        && buffer.readUInt32LE(4) + 8 <= stat.size;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function readTextFile(file = '') {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function validateCandidateBody(content = '', contract = {}) {
  const text = String(content || '').trim();
  if (!text) return { passed: false, code: 'deliverable_empty', summary: '交付正文为空。' };
  if (contract.requested_output_type !== 'report') {
    const processTermCount = (text.match(PROCESS_TERMS) || []).length;
    const processOnly = !PROCESS_TOPIC.test(contract.deliverable_title || '')
      && (PROCESS_LANGUAGE.test(text) || processTermCount >= 4);
    return processOnly
      ? { passed: false, code: 'process_log_as_deliverable', summary: '内容主要是执行链路说明，不是用户要求的交付结果。' }
      : { passed: true, code: '', summary: '交付正文存在。' };
  }
  const normalized = normalizeReportTopic(text);
  const subject = normalizeReportTopic(contract.deliverable_title || '');
  const subjectMatched = Boolean(subject && (normalized.includes(subject) || subject.length > 8 && normalized.includes(subject.slice(0, 8))));
  const headingCount = (text.match(/^#{1,4}\s+.+$/gm) || []).length;
  const sectionHits = new Set((text.match(/(?:摘要|概述|背景|现状|问题|目标|原则|措施|方案|实施|保障|风险|结论|建议)/g) || [])).size;
  const reportShape = headingCount >= 2 || sectionHits >= 3;
  const processTermCount = (text.match(PROCESS_TERMS) || []).length;
  const environmentTerms = new Set(text.match(ENVIRONMENT_TERMS) || []);
  const contentWithoutHeadings = text.replace(/^#{1,6}\s+.+$/gm, '').replace(/\s+/g, '');
  const processOnly = !PROCESS_TOPIC.test(contract.deliverable_title || '')
    && PROCESS_LANGUAGE.test(text)
    && (processTermCount >= 4 || contentWithoutHeadings.length < 120);
  if (!subjectMatched) return { passed: false, code: 'deliverable_topic_mismatch', summary: `正文没有围绕“${contract.deliverable_title}”展开。` };
  if (!reportShape) return { passed: false, code: 'report_structure_missing', summary: '正文缺少报告应有的摘要/概述和主题章节结构。' };
  if (processOnly) return { passed: false, code: 'process_log_as_deliverable', summary: `内容主要描述执行链路，不是“${contract.deliverable_title || '用户要求的报告'}”正文。` };
  if (contentWithoutHeadings.length < 120) return { passed: false, code: 'report_content_too_short', summary: '报告正文过短，尚不足以构成正式交付。' };
  if (/环境.{0,8}治理/i.test(contract.deliverable_title || '') && environmentTerms.size < 4) return { passed: false, code: 'report_substance_missing', summary: '正文缺少环境治理所需的现状、指标、措施或实施保障等实质内容。' };
  return { passed: true, code: '', summary: '报告主题和章节结构通过验收。' };
}

function normalizeReportTitle(value = '') {
  const clean = String(value || '')
    .replace(/^(?:请|帮我|给我|为我)?\s*(?:写|撰写|编写|制作|生成)(?:一份|一个)?\s*/i, '')
    .replace(/^关于\s*/i, '')
    .replace(/\s*的\s*(?=(?:预测|趋势|发展|影响|分析|研究|评估|报告))/g, '')
    .trim();
  return clean || '任务报告';
}

function normalizeReportTopic(value = '') {
  return normalizeReportTitle(value)
    .replace(/报告$/i, '')
    .replace(/(?:^|\s)(?:the|a|an|about|report)(?=\s|$)/gi, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase();
}

function deliverableSummary(body = '', title = '') {
  const lines = String(body || '').replace(/<!--[^]*?-->/g, '').split(/\r?\n/).map((line) => line.trim());
  const summaryHeading = lines.findIndex((line) => /^#{1,6}\s*(?:摘要|概述|执行摘要)\s*$/i.test(line));
  const summaryParagraph = summaryHeading >= 0
    ? lines.slice(summaryHeading + 1).find((line) => line && !/^#{1,6}\s+/.test(line))
    : '';
  const plain = summaryParagraph || lines
    .filter((line) => line && !/^#{1,6}\s+/.test(line) && line !== title && !/^(?:摘要|概述|背景|现状|问题|目标|措施|方案|实施|保障|结论|建议)$/.test(line))
    .at(0) || title || '交付物已通过验收。';
  return plain.slice(0, 220);
}

function fileCandidatePath(item = '') {
  if (typeof item === 'string') return item;
  return item.source_path || item.sourcePath || item.path || item.relative_path || item.relativePath || '';
}

function failedResult(contract = {}, failureCode = '', summary = '', extra = {}) {
  return {
    passed: false,
    resultState: 'needs_revision',
    validationState: 'failed',
    failureCode,
    summary,
    contentType: extra.contentType || '',
    title: contract.deliverable_title || '任务交付物',
    body: '',
    files: extra.files || [],
    deliverables: extra.deliverables || [],
    contract: { ...contract, final_file_candidates: (extra.files || []).map((file) => file.relative_path || file.path) },
    checks: extra.checks || [],
  };
}
