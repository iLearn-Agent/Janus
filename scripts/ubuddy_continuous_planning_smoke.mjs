import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../src/main/db.js';
import { Store } from '../src/main/store.js';
import { planUBuddyContinuously } from '../src/main/modules/orchestration/application/uBuddyContinuousPlanner.js';
import {
  createUBuddyPlanningCheckpoint,
  validateUBuddyPlanningDecision,
} from '../src/shared/contracts/uBuddyPlanningSession.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-continuous-planning-'));
let db;
try {
  db = openDatabase(root, { skipMigrationBackup: true, skipMigrationPreflight: true });
  const store = new Store(db, { root });
  const session = store.createUBuddyPlanningSession({
    ownerUserId: 'owner', accountWorkspaceId: 'workspace_personal', sourceSessionId: 'secretary',
    modelConfig: { model: 'test-model' },
  });
  assert.equal(session.revision, 1);
  assert.equal(session.status, 'planning');

  const user = { userId: 'employee', displayName: '员工' };
  const agent = { agentId: 'general_agent', agentInstanceId: 'agent_instance', name: 'Generalist', departmentId: 'general' };
  const calls = [];
  const execute = async ({ threadId, prompt }) => {
    calls.push({ threadId, prompt });
    if (calls.length === 1) {
      return { threadId: 'continuous-thread', answer: JSON.stringify(clarificationDecision(user)) };
    }
    return { threadId: 'continuous-thread', answer: JSON.stringify(readyDecision(agent)) };
  };
  const clarification = await planUBuddyContinuously({
    planningSessionId: session.id, revision: session.revision, prompt: '请完成一份报告',
    authorizedUsers: [user], candidateAgents: [agent], taskMode: true, execute,
  });
  assert.equal(clarification.decision, 'awaiting_clarification');
  assert.equal(clarification.plannerThreadId, 'continuous-thread');
  assert.equal(calls[0].threadId, '');

  const revision2 = store.updateUBuddyPlanningSession({
    id: session.id, baseRevision: 1, status: 'awaiting_clarification',
    plan: { decision: clarification }, codexThreadId: clarification.plannerThreadId,
  });
  const ready = await planUBuddyContinuously({
    planningSessionId: revision2.id, revision: revision2.revision, prompt: '输出 Markdown 报告',
    priorDecision: clarification,
    clarificationResponse: { answers: [{ questionId: 'format', value: 'Markdown' }] },
    authorizedUsers: [user], candidateAgents: [agent], taskMode: true,
    plannerThreadId: revision2.codexThreadId, execute,
  });
  assert.equal(ready.decision, 'ready_for_dispatch');
  assert.equal(calls[1].threadId, 'continuous-thread');
  const revised = await planUBuddyContinuously({
    planningSessionId: revision2.id, revision: revision2.revision, prompt: '第二位改为复核报告',
    priorDecision: ready, directive: 'revise', authorizedUsers: [user], candidateAgents: [agent], taskMode: true,
    plannerThreadId: revision2.codexThreadId, execute,
  });
  assert.equal(revised.planningSessionId, revision2.id);
  assert.equal(revised.plannerThreadId, 'continuous-thread');
  assert.match(calls[2].prompt, /Planning directive: "revise"/);

  const revision3 = store.updateUBuddyPlanningSession({
    id: revision2.id, baseRevision: revision2.revision, status: 'ready_to_dispatch', plan: { decision: ready },
  });
  assert.throws(() => store.updateUBuddyPlanningSession({
    id: revision3.id, baseRevision: revision2.revision, status: 'dispatching',
  }), (error) => error.code === 'ubuddy_planning_revision_conflict');

  const firstEvent = store.recordUBuddyPlanningSessionEvent({
    planningSessionId: revision3.id, idempotencyKey: 'clarification:digest', eventType: 'clarification_resolved',
    baseRevision: revision2.revision, resultRevision: revision3.revision, payload: { answer: 'Markdown' },
  });
  const repeatedEvent = store.recordUBuddyPlanningSessionEvent({
    planningSessionId: revision3.id, idempotencyKey: 'clarification:digest', eventType: 'clarification_resolved',
    baseRevision: 0, resultRevision: 0, payload: { answer: 'ignored duplicate' },
  });
  assert.equal(repeatedEvent.id, firstEvent.id);

  const checkpoint = createUBuddyPlanningCheckpoint({
    planningSessionId: revision3.id, revision: revision3.revision, status: revision3.status,
    decision: ready, ownerUserId: 'owner', accountWorkspaceId: 'workspace_personal',
    sourceSessionId: 'secretary', sourceMessageId: 'message',
  });
  assert.equal(checkpoint.decision.plannerThreadId, undefined, 'synced checkpoints must not expose physical Codex thread ids');
  assert.equal(validateUBuddyPlanningDecision(checkpoint.decision, {
    allowedUserIds: [user.userId], allowedAgentInstanceIds: [agent.agentInstanceId],
  }).valid, true);
  const incompleteReady = readyDecision(agent);
  incompleteReady.assignments = [];
  assert.deepEqual(validateUBuddyPlanningDecision(incompleteReady, {
    allowedUserIds: [user.userId], allowedAgentInstanceIds: [agent.agentInstanceId],
  }).diagnostics.map((item) => item.code).sort(), [
    'planning_assignments_missing', 'planning_selected_agent_unassigned',
  ]);
  const mixedExternal = readyDecision(agent);
  mixedExternal.target = {
    kind: 'task_group', candidateUserIds: [user.userId], requiredUserIds: [user.userId],
    selectedUserIds: [user.userId], selectedAgentInstanceIds: [agent.agentInstanceId],
  };
  mixedExternal.assignments.push({
    assignmentId: 'remote', assigneeKind: 'user', userId: user.userId, agentInstanceId: '',
    title: '远端工作', objective: '完成远端工作', deliverables: ['结果'], dependencies: [],
  });
  assert.ok(validateUBuddyPlanningDecision(mixedExternal, {
    allowedUserIds: [user.userId], allowedAgentInstanceIds: [agent.agentInstanceId],
  }).diagnostics.some((item) => item.code === 'planning_external_agent_assignment_unsupported'));
  assert.equal(db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id='ubuddy_continuous_planning_v1'").get().count, 1);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  const rendererController = await readFile(new URL('../src/renderer/app/features/chat/chatRunController.js', import.meta.url), 'utf8');
  const sendController = await readFile(new URL('../src/renderer/app/features/chat/messageSendController.js', import.meta.url), 'utf8');
  const runtimeSource = await readFile(new URL('../src/main/runtime.js', import.meta.url), 'utf8');
  const collaborationRuntimeSource = await readFile(new URL('../src/main/modules/collaboration/application/createCollaborationGroupRuntimeApi.js', import.meta.url), 'utf8');
  assert.match(rendererController, /planningSessionId: String\(planningCheckpoint\?\.planningSessionId/);
  assert.match(rendererController, /baseRevision: Math\.max\(0, Number\(planningCheckpoint\?\.revision/);
  assert.match(sendController, /planningBaseRevision/);
  assert.match(runtimeSource, /threadEpoch: checkpoint \? Math\.max\(1, Number\(checkpoint\.threadEpoch \|\| 1\)\) \+ 1 : 1/,
    'checkpoint reconstruction must identify a new local physical Codex thread epoch');
  for (const legacyPlanner of ['decideUBuddyTaskIntake(', 'auditUBuddyTaskReadinessImpl(', 'decideUBuddyCollaborationMode(', 'planUBuddyCollaborationAssignments(']) {
    assert.equal(runtimeSource.includes(legacyPlanner), false, `runtime must not invoke legacy planner ${legacyPlanner}`);
    assert.equal(collaborationRuntimeSource.includes(legacyPlanner), false, `collaboration runtime must not invoke legacy planner ${legacyPlanner}`);
  }
  assert.match(collaborationRuntimeSource, /freezeNaturalGroupContinuousDispatch/);

  process.stdout.write('uBuddy continuous planning smoke passed.\n');
} finally {
  try { db?.close(); } catch {}
  await rm(root, { recursive: true, force: true });
}

function baseIntake({ state, clarifications = [], readiness }) {
  return {
    version: 'ubuddy_task_intake_v1', state, taskKind: 'general', workReportSpec: null,
    objective: '完成一份报告', deliverables: ['Markdown 报告'], acceptanceCriteria: [], constraints: [], deadline: '',
    candidateUsers: [], requiredUsers: [], attachments: [], privacyScope: 'owner_private', riskLevel: 'low',
    missingFields: state === 'ready' ? [] : ['format'], clarifications,
    executionPlan: { summary: '生成报告', steps: ['研究并撰写'], requiredInputs: [] },
    knownFacts: [], safeAssumptions: [], criticalUnknowns: state === 'ready' ? [] : [{ id: 'format', name: '格式', reason: '需要格式', questionId: 'format' }],
    readiness: { status: readiness, reason: '' },
  };
}

function clarificationDecision() {
  const questions = [{ id: 'format', header: '格式', question: '使用什么格式？', reason: '需要明确格式', answerType: 'single_choice', options: [{ value: 'Markdown', label: 'Markdown' }, { value: 'Word', label: 'Word' }], allowOther: true, required: true }];
  return {
    version: 'UBUDDY_PLANNING_DECISION_V1', decision: 'awaiting_clarification', confidence: 0.9, answer: '',
    intake: baseIntake({ state: 'needs_clarification', clarifications: questions, readiness: 'needs_clarification' }),
    target: { kind: 'local_agent', candidateUserIds: [], requiredUserIds: [], selectedUserIds: [], selectedAgentInstanceIds: [] },
    collaboration: { mode: 'manager_delegation', initiatorParticipation: 'coordinator_only', participantSelectionIntent: 'all', assignmentIntent: 'auto' },
    assignments: [], clarifications: questions,
    readiness: { status: 'needs_clarification', reason: '缺少格式', knownFacts: [], safeAssumptions: [], criticalUnknowns: ['format'] },
    riskLevel: 'low', rationale: '需要澄清格式',
  };
}

function readyDecision(agent) {
  return {
    version: 'UBUDDY_PLANNING_DECISION_V1', decision: 'ready_for_dispatch', confidence: 0.95, answer: '',
    intake: baseIntake({ state: 'ready', readiness: 'ready' }),
    target: { kind: 'local_agent', candidateUserIds: [], requiredUserIds: [], selectedUserIds: [], selectedAgentInstanceIds: [agent.agentInstanceId] },
    collaboration: { mode: 'manager_delegation', initiatorParticipation: 'coordinator_only', participantSelectionIntent: 'all', assignmentIntent: 'auto' },
    assignments: [{ assignmentId: 'write', assigneeKind: 'agent', userId: '', agentInstanceId: agent.agentInstanceId, title: '撰写报告', objective: '撰写 Markdown 报告', deliverables: ['Markdown 报告'], dependencies: [] }],
    clarifications: [], readiness: { status: 'ready', reason: '', knownFacts: [], safeAssumptions: [], criticalUnknowns: [] },
    riskLevel: 'low', rationale: 'Generalist 可以完成任务',
  };
}
