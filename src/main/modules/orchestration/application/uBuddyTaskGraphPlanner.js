import { runCodexExec } from '../../../codex.js';
import {
  buildAgentCapabilityCatalog,
  capabilityCatalogPlannerCandidates,
} from '../domain/agentCapabilityCatalog.js';

const MAX_NODES = 8;
const DELIVERABLE_TYPES = new Set(['answer', 'report', 'document', 'presentation', 'spreadsheet', 'image', 'code_change']);
const DELIVERABLE_ROLES = new Set(['primary', 'supporting', 'intermediate']);
const DELIVERABLE_ROLE_ALIASES = new Map([
  ['final', 'primary'], ['main', 'primary'], ['final_output', 'primary'], ['final-deliverable', 'primary'],
  ['support', 'supporting'], ['secondary', 'supporting'], ['supplementary', 'supporting'],
  ['internal', 'intermediate'], ['handoff', 'intermediate'], ['draft', 'intermediate'],
]);
const DELIVERABLE_TYPE_ALIASES = new Map([
  ['ppt', 'presentation'], ['pptx', 'presentation'], ['slides', 'presentation'], ['slide_deck', 'presentation'], ['deck', 'presentation'],
  ['doc', 'document'], ['docx', 'document'], ['markdown', 'document'], ['md', 'document'], ['text', 'document'],
  ['xls', 'spreadsheet'], ['xlsx', 'spreadsheet'], ['excel', 'spreadsheet'], ['csv', 'spreadsheet'], ['table', 'spreadsheet'],
  ['png', 'image'], ['jpg', 'image'], ['jpeg', 'image'], ['webp', 'image'], ['illustration', 'image'], ['graphic', 'image'],
  ['code', 'code_change'], ['patch', 'code_change'], ['codechange', 'code_change'],
]);
export const DEFAULT_UBUDDY_PLANNER_TIMEOUT_MS = 180_000;

export async function proposeUBuddyTaskGraph({ prompt = '', candidates = [], root = '', cwd = '', model = '', reasoningEffort = '', signal = null, executionContext = null, timeoutMs = Number(process.env.JANUS_UBUDDY_WORKSPACE_PLANNER_TIMEOUT_MS || DEFAULT_UBUDDY_PLANNER_TIMEOUT_MS) } = {}) {
  const normalizedCandidates = normalizeCandidates(candidates);
  if (!normalizedCandidates.length) throw new Error('employee_not_active: no active employee candidate is available.');
  const plannerPrompt = [
    '【UBUDDY_TASK_GRAPH_PROPOSAL_V2】',
    'Return JSON only. Plan a private task graph for the owner. uBuddy coordinates but must never be an execution node.',
    'Write every user-visible field in the same language as the owner request, including clarification text, node titles, objectives, output formats, fallbacks, and deliverable titles.',
    `Use the fewest useful nodes: normally 1-4 and never more than ${MAX_NODES}. Every node needs localId, title, objective, agentId, agentInstanceId, dependencies, outputFormat, and isFinal.`,
    'Choose agentInstanceId from the supplied active employee candidates. Multiple candidates may share one agentId; their queue, performance, Memory, and personal evolution state are independent.',
    'Exactly one node must have isFinal=true. Dependencies must reference localId values and form a DAG.',
    'Mark auxiliary work blocking=false when the final delivery can proceed without it. Give important nodes a concrete fallback plan.',
    'Also classify requested outputs. Exactly one deliverable must have role=primary and its ownerLocalId must be the isFinal node. Use supporting for additional user-facing formal outputs and intermediate for internal handoff material.',
    'Allowed deliverable types: answer, report, document, presentation, spreadsheet, image, code_change. For presentation creation use deliveryMode=file and requiredExtensions=[".pptx"]. Put exact requested slide count in constraints.exactSlideCount.',
    'If the final deliverable is genuinely ambiguous, return {"version":2,"status":"needs_clarification","confidence":0.0,"clarification":{"reason":"ambiguous_final_deliverable","question":"...","options":["...","..."]}} and no task nodes.',
    'Prefer effective Skill fit, then performance P level, then lower queueDepth. P1 provisional is only a scheduling hint.',
    `Owner request:\n${String(prompt || '').trim()}`,
    `Active employee candidates:\n${JSON.stringify(normalizedCandidates)}`,
    'Schema: {"version":2,"status":"ready","confidence":0.9,"nodes":[{"localId":"...","title":"...","objective":"...","agentId":"...","agentInstanceId":"...","dependencies":[],"outputFormat":"...","isFinal":false,"blocking":true,"fallback":"...","maxAttempts":3,"retryStrategy":"automatic","priority":50,"estimatedMinutes":20}],"deliverables":[{"id":"...","role":"primary|supporting|intermediate","type":"presentation","title":"...","ownerLocalId":"...","deliveryMode":"file","requiredExtensions":[".pptx"],"constraints":{"exactSlideCount":5}}]}.',
  ].join('\n\n');
  const answer = await runCodexExec({
    prompt: plannerPrompt,
    agentId: 'secretary_agent',
    root,
    cwd: cwd || root,
    role: 'ubuddy-task-graph-planner',
    model,
    reasoningEffort,
    sandbox: 'read-only',
    signal,
    timeoutMs,
    executionContext,
  });
  const proposal = validateUBuddyTaskGraphProposal(parseJsonAnswer(answer), normalizedCandidates);
  return { ...proposal, mode: 'model', rawAnswer: answer };
}

export function validateUBuddyTaskGraphProposal(proposal = {}, candidates = []) {
  const proposalStatus = String(proposal?.status || '').trim().toLowerCase();
  const proposalConfidence = Math.max(0, Math.min(1, Number(proposal?.confidence ?? 0.9) || 0));
  if (proposalStatus === 'needs_clarification' || proposalConfidence < 0.7) {
    return {
      version: 2,
      status: 'needs_clarification',
      confidence: proposalConfidence,
      clarification: normalizeClarification(proposal?.clarification),
      nodes: [],
      finalNodeId: '',
      deliverablePlan: null,
    };
  }
  const normalizedCandidates = normalizeCandidates(candidates);
  const activeAgentIds = new Set(normalizedCandidates.map((item) => item.agentId));
  const candidatesByInstanceId = new Map(normalizedCandidates.map((item) => [item.agentInstanceId, item]));
  const sourceNodes = Array.isArray(proposal?.nodes) ? proposal.nodes : [];
  if (!sourceNodes.length || sourceNodes.length > MAX_NODES) throw new Error(`uBuddy task graph must contain 1-${MAX_NODES} nodes.`);
  const ids = new Set();
  const nodes = sourceNodes.map((node, index) => {
    const localId = String(node?.localId || node?.id || `node_${index + 1}`).trim().slice(0, 80);
    const agentId = String(node?.agentId || '').trim();
    const requestedAgentInstanceId = String(node?.agentInstanceId || '').trim();
    const objective = String(node?.objective || '').trim();
    const outputFormat = String(node?.outputFormat || '').trim();
    if (!localId || ids.has(localId)) throw new Error('uBuddy task graph node ids must be unique.');
    if (!agentId || agentId === 'secretary_agent' || !activeAgentIds.has(agentId)) throw new Error(`Invalid or inactive task graph agent: ${agentId || 'missing'}.`);
    const requestedCandidate = requestedAgentInstanceId ? candidatesByInstanceId.get(requestedAgentInstanceId) : null;
    if (requestedAgentInstanceId && (!requestedCandidate || requestedCandidate.agentId !== agentId)) {
      throw new Error(`Invalid or inactive task graph Agent instance: ${requestedAgentInstanceId}.`);
    }
    const selectedCandidate = requestedCandidate || selectBestUBuddyCandidate(
      normalizedCandidates.filter((candidate) => candidate.agentId === agentId),
      { departmentId: String(node?.departmentId || '').trim(), prompt: `${objective}\n${String(node?.title || '')}` },
    );
    if (!selectedCandidate?.agentInstanceId) throw new Error(`No active Agent instance is available for task graph agent: ${agentId}.`);
    if (!objective || !outputFormat) throw new Error(`Task graph node ${localId} requires objective and outputFormat.`);
    ids.add(localId);
    return {
      localId,
      title: String(node?.title || objective).trim().slice(0, 160),
      objective: objective.slice(0, 8000),
      departmentId: String(node?.departmentId || '').trim(),
      agentId,
      agentInstanceId: selectedCandidate.agentInstanceId,
      dependencies: [...new Set((Array.isArray(node?.dependencies) ? node.dependencies : []).map((item) => String(item || '').trim()).filter(Boolean))],
      outputFormat: outputFormat.slice(0, 1000),
      estimatedMinutes: Math.max(0, Math.min(1440, Number(node?.estimatedMinutes || 20))),
      priority: Math.max(1, Math.min(100, Number(node?.priority || 50))),
      parallelGroup: String(node?.parallelGroup || 'model').trim().slice(0, 80),
      blocking: node?.blocking !== false,
      notify: [],
      fallback: String(node?.fallback || '').trim().slice(0, 2000),
      maxAttempts: Math.max(1, Math.min(5, Number(node?.maxAttempts || 3))),
      retryStrategy: node?.retryStrategy === 'never' ? 'never' : 'automatic',
      isFinal: node?.isFinal === true,
    };
  });
  for (const node of nodes) {
    if (node.dependencies.includes(node.localId) || node.dependencies.some((id) => !ids.has(id))) throw new Error(`Invalid dependency for task graph node ${node.localId}.`);
  }
  if (nodes.filter((node) => node.isFinal).length !== 1) throw new Error('uBuddy task graph requires exactly one final node.');
  assertAcyclic(nodes);
  const finalNode = nodes.find((node) => node.isFinal);
  const dependedOn = new Set(nodes.flatMap((node) => node.dependencies));
  const terminalIds = nodes.filter((node) => node.blocking && !dependedOn.has(node.localId) && !node.isFinal).map((node) => node.localId);
  finalNode.dependencies = [...new Set([...finalNode.dependencies, ...terminalIds])].filter((id) => id !== finalNode.localId);
  assertAcyclic(nodes);
  const deliverables = normalizeDeliverables(proposal?.deliverables, nodes, finalNode);
  return {
    version: deliverables.length ? 2 : 1,
    status: 'ready',
    confidence: proposalConfidence,
    nodes: topologicalOrder(nodes),
    finalNodeId: finalNode.localId,
    deliverablePlan: deliverables.length ? { version: 'deliverable_plan_v2', confidence: proposalConfidence, deliverables } : null,
  };
}

export function buildUBuddyPlannerCandidates({ store, org, userId = '', performanceForAgent = null, leadershipForAgent = null } = {}) {
  return capabilityCatalogPlannerCandidates(buildAgentCapabilityCatalog({
    store, org, userId, performanceForAgent, leadershipForAgent,
  }));
}

export function selectBestUBuddyCandidate(candidates = [], { departmentId = '', prompt = '' } = {}) {
  const words = new Set(String(prompt || '').toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((item) => item.length >= 2));
  return normalizeCandidates(candidates).map((candidate, index) => {
    const skill = String(candidate.effectiveSkill || '').toLowerCase();
    const skillHits = [...words].filter((word) => skill.includes(word)).length;
    const level = Math.max(1, Math.min(10, Number(String(candidate.performanceLevel || 'P1').replace(/^P/i, '')) || 1));
    const score = (candidate.departmentId === departmentId ? 30 : 0) + skillHits * 3 + level * (candidate.provisional ? 0.5 : 1) - candidate.queueDepth * 4 - (candidate.status === 'busy' ? 3 : 0) - index * 0.001;
    return { candidate, score };
  }).sort((left, right) => right.score - left.score)[0]?.candidate || null;
}

function normalizeCandidates(candidates = []) {
  return (Array.isArray(candidates) ? candidates : []).filter((item) => item && item.agentId && item.agentInstanceId).map((item) => ({
    ...item,
    agentId: String(item.agentId),
    agentInstanceId: String(item.agentInstanceId),
    queueDepth: Math.max(0, Number(item.queueDepth || 0)),
    performanceLevel: /^P(?:10|[1-9])$/.test(String(item.performanceLevel || '')) ? String(item.performanceLevel) : 'P1',
    provisional: item.provisional !== false,
    leadershipLevel: /^L[0-3]$/.test(String(item.leadershipLevel || '')) ? String(item.leadershipLevel) : 'L0',
    leadershipScore: Math.max(0, Math.min(100, Number(item.leadershipScore || 0))),
    leadershipProvisional: item.leadershipProvisional !== false,
    leadershipStatus: ['active', 'frozen', 'inactive'].includes(String(item.leadershipStatus || '')) ? String(item.leadershipStatus) : 'active',
    leadershipTrialApproved: Boolean(item.leadershipTrialApproved),
    leadershipTrialActionId: String(item.leadershipTrialActionId || ''),
    leadershipTrialRole: String(item.leadershipTrialRole || ''),
    leadershipActiveTaskGroups: Math.max(0, Number(item.leadershipActiveTaskGroups || 0)),
  }));
}

function normalizeClarification(value = {}) {
  const options = [...new Set((Array.isArray(value?.options) ? value.options : [])
    .map((item) => typeof item === 'string' ? item : item?.label)
    .map((item) => String(item || '').trim().slice(0, 120)).filter(Boolean))].slice(0, 3);
  return {
    reason: String(value?.reason || 'ambiguous_final_deliverable').trim().slice(0, 120),
    question: String(value?.question || '请确认这项任务最终需要交付哪一种产物。').trim().slice(0, 500),
    options: options.length >= 2 ? options : ['以最后阶段产物为最终交付', '将提到的产物都作为正式交付'],
  };
}

function normalizeDeliverables(value = [], nodes = [], finalNode = null) {
  const ids = new Set(nodes.map((node) => node.localId));
  const source = Array.isArray(value) ? value.slice(0, 12) : [];
  const items = source.map((item, index) => {
    const field = `deliverables[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${field} must be an object.`);
    }
    const roleInput = String(item.role || '').trim().toLowerCase();
    const role = DELIVERABLE_ROLES.has(roleInput) ? roleInput : DELIVERABLE_ROLE_ALIASES.get(roleInput) || '';
    if (!role) {
      throw new Error(`${field}.role is invalid: ${roleInput || 'missing'}. Expected primary, supporting, or intermediate.`);
    }
    const typeInput = String(item.type || item.outputType || item.output_type || '').trim().toLowerCase();
    const type = DELIVERABLE_TYPES.has(typeInput) ? typeInput : DELIVERABLE_TYPE_ALIASES.get(typeInput) || '';
    if (!type) {
      throw new Error(`${field}.type is invalid: ${typeInput || 'missing'}. Expected answer, report, document, presentation, spreadsheet, image, or code_change.`);
    }
    let ownerLocalId = String(item.ownerLocalId || item.owner_local_id || item.ownerNodeId || item.owner_node_id || item.ownerId || '').trim();
    if (!ownerLocalId && source.length === 1 && role === 'primary' && finalNode?.localId) ownerLocalId = finalNode.localId;
    if (!ownerLocalId) {
      throw new Error(`${field}.ownerLocalId is required and must reference a task node localId.`);
    }
    if (!ids.has(ownerLocalId)) {
      throw new Error(`${field}.ownerLocalId references unknown node ${ownerLocalId}. Valid localIds: ${[...ids].join(', ')}.`);
    }
    const exactSlideCount = Math.max(0, Math.min(500, Number(
      item.constraints?.exactSlideCount
      ?? item.constraints?.exact_slide_count
      ?? item.constraints?.slideCount
      ?? item.exactSlideCount
      ?? 0,
    ) || 0));
    const extensionInput = item.requiredExtensions ?? item.required_extensions ?? [];
    const requiredExtensions = [...new Set((Array.isArray(extensionInput) ? extensionInput : [extensionInput]).map((extension) => {
      const clean = String(extension || '').trim().toLowerCase();
      return clean && !clean.startsWith('.') ? `.${clean}` : clean;
    }).filter((extension) => /^\.(?:md|markdown|txt|html?|json|csv|tsv|xlsx?|docx|pdf|pptx|png|jpe?g|webp)$/.test(extension)))];
    return {
      id: String(item.id || `deliverable_${index + 1}`).trim().slice(0, 80),
      role,
      type,
      title: String(item.title || nodes.find((node) => node.localId === ownerLocalId)?.title || '任务交付物').trim().slice(0, 160),
      ownerLocalId,
      deliveryMode: ['inline', 'file'].includes(String(item.deliveryMode || item.delivery_mode || '').toLowerCase())
        ? String(item.deliveryMode || item.delivery_mode).toLowerCase()
        : ['presentation', 'spreadsheet', 'image'].includes(type) ? 'file' : 'inline',
      requiredExtensions: type === 'presentation' ? ['.pptx'] : requiredExtensions,
      constraints: exactSlideCount > 0 ? { exactSlideCount } : {},
    };
  });
  const primaryIndexes = items.map((item, index) => item.role === 'primary' ? index : -1).filter((index) => index >= 0);
  const primary = primaryIndexes.map((index) => items[index]);
  if (!items.length) return [];
  if (primary.length !== 1) {
    throw new Error(`deliverables must contain exactly one primary item; found ${primary.length}${primaryIndexes.length ? ` at indexes ${primaryIndexes.join(', ')}` : ''}.`);
  }
  if (primary[0].ownerLocalId !== finalNode?.localId) {
    throw new Error(`deliverables[${primaryIndexes[0]}].ownerLocalId must reference final node ${finalNode?.localId || 'missing'}, received ${primary[0].ownerLocalId}.`);
  }
  return items;
}

function parseJsonAnswer(answer = '') {
  const text = String(answer || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || text;
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('uBuddy planner did not return JSON.');
  return JSON.parse(fenced.slice(start, end + 1));
}

function assertAcyclic(nodes = []) {
  const byId = new Map(nodes.map((node) => [node.localId, node]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new Error('uBuddy task graph contains a dependency cycle.');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies || []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) visit(node.localId);
}

function topologicalOrder(nodes = []) {
  const byId = new Map(nodes.map((node) => [node.localId, node]));
  const result = [];
  const visited = new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    for (const dependency of byId.get(id)?.dependencies || []) visit(dependency);
    visited.add(id);
    result.push(byId.get(id));
  };
  for (const node of nodes) visit(node.localId);
  return result.filter(Boolean);
}
