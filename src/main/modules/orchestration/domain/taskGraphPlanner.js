import { classifyPptIntent } from '../../../pptIntent.js';

export function routeDepartment(prompt) {
  if (classifyPptIntent(prompt).creation) return 'ppt_department';
  return 'general';
}

export function leadAgentForDepartment(departmentId, agents, prompt = '') {
  if (departmentId === 'collaboration') {
    return chooseCollaborationLeadAgent(agents, prompt);
  }
  const preferred = {
    ppt_department: 'ppt',
    general: 'general_agent',
  }[departmentId];
  return agents.find((agent) => agent.id === preferred)?.id || agents.find((agent) => agent.departmentId === departmentId)?.id || '';
}

function chooseCollaborationLeadAgent(agents, prompt = '') {
  const text = String(prompt || '');
  if (/(ppt|slide|deck|汇报|答辩|演示|presentation)/i.test(text)) {
    return findAgent(agents, 'ppt')
      || findAgent(agents, 'general_agent');
  }
  return findAgent(agents, 'general_agent')
    || findAgent(agents, 'ppt')
    || agents.find((agent) => agent.routable !== false)?.id
    || '';
}

function findAgent(agents, id) {
  return agents.find((agent) => agent.id === id && agent.routable !== false)?.id || '';
}


export function planTaskGraph({ prompt, departmentId, leadAgentId, agents }) {
  const text = String(prompt || '');
  const graph = [];
  const add = (node) => graph.push({
    localId: node.localId,
    title: node.title,
    objective: node.objective,
    departmentId: node.departmentId || departmentId,
    agentId: node.agentId,
    dependencies: node.dependencies || [],
    outputFormat: node.outputFormat || 'markdown',
    estimatedMinutes: node.estimatedMinutes || defaultEstimatedMinutes(node),
    priority: node.priority || 50,
    parallelGroup: node.parallelGroup || 'main',
    blocking: Boolean(node.blocking),
    notify: node.notify || [],
    fallback: node.fallback || '',
    maxAttempts: node.maxAttempts || 3,
    retryStrategy: node.retryStrategy || 'automatic',
  });

  if (departmentId === 'collaboration') {
    return planCollaborationTaskGraph({ prompt, leadAgentId, agents, add, graph });
  }

  const needsResearch = /(查找|调研|文献|source|citation|数据|案例|research|web|联网)/i.test(text);
  const needsPpt = departmentId === 'ppt_department';
  const pptAgent = findAgent(agents, 'ppt') || leadAgentId;
  if (needsResearch && needsPpt && pptAgent) {
    add({
      localId: 'research',
      title: 'Evidence pack',
      objective: 'Find source-cited facts, data, cases, and visual references that can support the deck.',
      agentId: pptAgent,
      outputFormat: 'source-cited evidence pack with uncertainty flags',
      priority: 10,
      estimatedMinutes: 25,
      parallelGroup: 'research',
      fallback: 'Proceed with explicit source gaps and mark claims as assumptions.',
    });
  }

  if (needsPpt) {
    add({
      localId: 'strategy',
      title: 'Deck strategy and slide plan',
      objective: 'Create a slide-by-slide plan with claim titles, message, visual direction, speaker notes, and timing.',
      agentId: pptAgent,
      dependencies: graph.some((node) => node.localId === 'research') ? ['research'] : [],
      outputFormat: 'markdown slide table',
      priority: 30,
      estimatedMinutes: 35,
      parallelGroup: 'strategy',
      blocking: true,
    });
    const finalDependencies = ['strategy'];
    if (hasCrossDepartmentNodes(graph, departmentId)) {
      add({
        localId: 'consistency',
        title: 'Cross-department consistency check',
        objective: 'Compare all upstream department outputs, identify contradictions or ownership gaps, and produce the final consistency decision for the primary department.',
        agentId: leadAgentId,
        dependencies: ['strategy'],
        outputFormat: 'consistency audit with conflicts, resolutions, uncertainty flags, and final handoff decision',
        priority: 80,
        estimatedMinutes: 20,
        parallelGroup: 'final',
        blocking: true,
        fallback: 'If outputs conflict, keep the primary department accountable and mark unresolved claims as assumptions.',
      });
      finalDependencies[0] = 'consistency';
    }
    add({
      localId: 'final',
      title: 'Final deck synthesis',
      objective: 'Integrate upstream outputs, check editability/artifact contract, and deliver final user-facing result.',
      agentId: leadAgentId,
      dependencies: finalDependencies,
      outputFormat: 'final answer with artifact path or exact next action',
      priority: 90,
      estimatedMinutes: 45,
      parallelGroup: 'final',
      blocking: true,
    });
    return graph;
  }

  add({
    localId: 'main',
    title: 'Primary task execution',
    objective: 'Complete the user request with structured, reusable output.',
    agentId: leadAgentId,
    dependencies: graph.some((node) => node.localId === 'research') ? ['research'] : [],
    outputFormat: 'markdown report or concrete artifact instructions',
    priority: 40,
    estimatedMinutes: 45,
    parallelGroup: 'main',
    blocking: true,
  });
  const retrospectiveDependencies = ['main'];
  if (hasCrossDepartmentNodes(graph, departmentId)) {
    add({
      localId: 'consistency',
      title: 'Cross-department consistency check',
      objective: 'Compare collaborating department outputs against the primary deliverable, resolve contradictions, and confirm which department owns the final answer.',
      agentId: leadAgentId,
      dependencies: ['main'],
      outputFormat: 'consistency audit with conflicts, resolutions, uncertainty flags, and final handoff decision',
      priority: 85,
      estimatedMinutes: 20,
      parallelGroup: 'final',
      blocking: true,
      fallback: 'If collaborating outputs conflict, preserve the primary department deliverable and list unresolved assumptions.',
    });
    retrospectiveDependencies[0] = 'consistency';
  }
  add({
    localId: 'retro',
    title: 'Task retrospective',
    objective: 'Summarize key decisions, failure points, reusable learnings, and memory/self-evolution candidates.',
    departmentId,
    agentId: leadAgentId,
    dependencies: retrospectiveDependencies,
    outputFormat: 'retrospective bullets',
    priority: 95,
    estimatedMinutes: 15,
    parallelGroup: 'retro',
  });
  return graph;
}

function planCollaborationTaskGraph({ prompt, leadAgentId, agents, add, graph }) {
  const text = String(prompt || '');
  const generalAgent = findAgent(agents, 'general_agent');
  const pptAgent = findAgent(agents, 'ppt');
  const finalAgent = leadAgentId || (/ppt|slide|deck|汇报|答辩|演示|presentation/i.test(text) ? pptAgent : generalAgent) || pptAgent || agents.find((agent) => agent.routable !== false)?.id || '';
  const finalDepartment = agents.find((agent) => agent.id === finalAgent)?.departmentId || 'general';
  const needsPpt = /(ppt|slide|deck|汇报|答辩|演示|presentation)/i.test(text);
  const needsResearch = /(查找|调研|文献|source|citation|数据|案例|research|web|联网)/i.test(text);

  if (needsPpt && needsResearch && pptAgent) {
    add({
      localId: 'research',
      title: 'PPT evidence and context scan',
      objective: 'Build a source-cited evidence pack for the requested presentation and identify unknowns, constraints, and risks.',
      departmentId: 'ppt_department',
      agentId: pptAgent,
      outputFormat: 'source-cited evidence pack with assumptions and missing inputs',
      priority: 10,
      estimatedMinutes: 30,
      parallelGroup: 'discovery',
      blocking: true,
      notify: [pptAgent, finalAgent].filter(Boolean),
      fallback: 'If evidence is incomplete, list assumptions and mark claims needing later verification.',
    });
  }

  const sharedDeps = graph.some((node) => node.localId === 'research') ? ['research'] : [];
  const terminalNodes = [];
  if (needsPpt && pptAgent) {
    add({
      localId: 'ppt',
      title: 'PPT/storytelling workstream',
      objective: 'Convert the task and selected evidence into a slide narrative, page table, visual plan, and artifact-readiness checklist.',
      departmentId: 'ppt_department',
      agentId: pptAgent,
      dependencies: sharedDeps,
      outputFormat: 'slide plan/page table with visual and speaker-note guidance',
      priority: 55,
      estimatedMinutes: 45,
      parallelGroup: 'deliverable',
      blocking: true,
      notify: [finalAgent].filter(Boolean),
      fallback: 'If upstream material is missing, produce a conservative slide skeleton and missing evidence list.',
    });
    terminalNodes.push('ppt');
  }

  if (!terminalNodes.length && generalAgent) {
    add({
      localId: 'general',
      title: 'General execution workstream',
      objective: 'Execute the task directly, coordinate any needed specialist handoff, and produce the best verified answer.',
      departmentId: 'general',
      agentId: generalAgent,
      outputFormat: 'direct answer with handoff or next-action notes',
      priority: 40,
      estimatedMinutes: 30,
      parallelGroup: 'deliverable',
      blocking: true,
    });
    terminalNodes.push('general');
  }

  const finalDeps = terminalNodes.length ? terminalNodes : graph.map((node) => node.localId).filter((id) => id !== 'final');
  add({
    localId: 'final',
    title: 'Cross-department synthesis',
    objective: [
      'Integrate all department outputs into a single user-facing answer.',
      'Resolve contradictions, call out waiting communication requests, list completed departments, and state the next executable step.',
      'Do not claim another department finished work that is still waiting or blocked.',
    ].join('\n'),
    departmentId: finalDepartment,
    agentId: finalAgent,
    dependencies: finalDeps,
    outputFormat: 'final collaboration summary with completed outputs, open communications, blockers, and next actions',
    priority: 95,
    estimatedMinutes: 30,
    parallelGroup: 'final',
    blocking: true,
    fallback: 'If upstream departments conflict or block, summarize partial progress and list exact unresolved inputs.',
  });
  return graph;
}

function defaultEstimatedMinutes(node) {
  if (node.parallelGroup === 'research') return 30;
  if (node.parallelGroup === 'strategy') return 35;
  if (node.parallelGroup === 'final') return 30;
  if (node.parallelGroup === 'retro') return 15;
  if (node.blocking) return 45;
  return 20;
}

function hasCrossDepartmentNodes(graph, primaryDepartmentId) {
  return graph.some((node) => (node.departmentId || primaryDepartmentId) !== primaryDepartmentId);
}

export function populateDownstreamNotifications(graph) {
  const byLocalId = new Map(graph.map((node) => [node.localId, node]));
  for (const node of graph) {
    for (const dependency of node.dependencies || []) {
      const upstream = byLocalId.get(dependency);
      if (!upstream || !node.agentId) continue;
      upstream.notify = [...new Set([...(upstream.notify || []), node.agentId])];
    }
  }
}
