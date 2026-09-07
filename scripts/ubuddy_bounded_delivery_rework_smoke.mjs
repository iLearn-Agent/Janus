import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../src/main/db.js';
import { Store } from '../src/main/store.js';
import { classifyTaskNodeError, effectiveTaskExecutionPermissionMode, taskExecutionPermissionMode, TaskScheduler } from '../src/main/scheduler.js';
import { deterministicDelegationWorkspaceIntent } from '../src/main/modules/collaboration/domain/delegationWorkspaceRules.js';
import { renderUBuddyCoordinationPanels } from '../src/renderer/app/views/ubuddyCoordinationView.js';
import {
  reviewUBuddyTaskDelivery,
  snapshotTaskDeliveryArtifacts,
} from '../src/main/modules/orchestration/application/uBuddyDeliveryReviewService.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-bounded-delivery-rework-'));

try {
  assert.equal(deterministicDelegationWorkspaceIntent('修改方向：把结论摘要压缩成三点。'), 'execute');
  assert.equal(deterministicDelegationWorkspaceIntent('请生成一份 Markdown 需求说明文件。'), 'execute');
  assert.equal(deterministicDelegationWorkspaceIntent('正式更新：流程图必须可编辑。'), 'execute');
  assert.equal(deterministicDelegationWorkspaceIntent('先在我的私有任务会话里把要求整理成三点，暂时不要同步。'), 'execute');
  assert.equal(deterministicDelegationWorkspaceIntent('请告诉我当前任务进度。'), 'message');
  assert.equal(deterministicDelegationWorkspaceIntent('不要修改初稿，直接提交到任务群。'), 'submit');
  let db = openDatabase(root, { appVersion: '0.2.25' });
  let store = new Store(db, { root });
  db.prepare(`INSERT INTO auth_users(id,email,display_name,email_verified)
    VALUES('delivery-review-user','delivery-review@example.com','Delivery Review User',1)`).run();
  const session = store.createSession({
    id: 'delivery-review-session', userId: 'delivery-review-user', title: 'Delivery review history',
  });
  store.addMessage({
    id: 'delivery-review-message', sessionId: session.id, role: 'user', content: 'Preserve delivery review source message.',
  });
  const task = store.createTaskRun({
    id: 'delivery-review-task', ownerUserId: 'delivery-review-user', title: 'Delivery review task',
    prompt: 'Produce a reviewable report.', metadata: { source: 'ubuddy_dispatch' },
  });
  const preserved = {
    task: { ...db.prepare('SELECT id,title,prompt,status,owner_user_id FROM task_runs WHERE id=?').get(task.id) },
    message: { ...db.prepare('SELECT id,session_id,role,content FROM messages WHERE id=?').get('delivery-review-message') },
    counts: coreCounts(db),
  };
  db.close();

  const raw = new DatabaseSync(path.join(root, 'data', 'janus.db'));
  raw.exec(`PRAGMA foreign_keys=OFF;
    DROP TABLE IF EXISTS task_delivery_review_jobs;
    DROP TABLE IF EXISTS task_delivery_review_events;
    DROP TABLE IF EXISTS task_delivery_submissions;
    DROP TABLE IF EXISTS task_delivery_reviews;
    DELETE FROM schema_migrations WHERE id='bounded_delivery_rework_v1';
    PRAGMA foreign_keys=ON;`);
  raw.close();

  db = openDatabase(root, { appVersion: '0.2.25' });
  store = new Store(db, { root });
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id='bounded_delivery_rework_v1'").get());
  for (const table of ['task_delivery_reviews', 'task_delivery_submissions', 'task_delivery_review_events', 'task_delivery_review_jobs']) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), `${table} was not restored`);
  }
  assert.deepEqual({ ...db.prepare('SELECT id,title,prompt,status,owner_user_id FROM task_runs WHERE id=?').get(task.id) }, preserved.task);
  assert.deepEqual({ ...db.prepare('SELECT id,session_id,role,content FROM messages WHERE id=?').get('delivery-review-message') }, preserved.message);
  assert.deepEqual(coreCounts(db), preserved.counts, 'additive delivery review migration must preserve core entity counts');

  const review = store.ensureTaskDeliveryReview({ taskRunId: task.id });
  assert.equal(review.state, 'submitted');
  assert.equal(review.maxQualityRevisions, 2);
  const submissionInput = {
    taskRunId: task.id,
    submissionKey: 'delivery-review-submission-1',
    bodySnapshot: 'Reviewable report v1',
    evidence: { checks: ['report_exists'] },
    artifactManifest: [{ id: 'artifact-1', name: 'report.md' }],
  };
  const submission = store.recordTaskDeliverySubmission(submissionInput);
  assert.equal(store.recordTaskDeliverySubmission({
    ...submissionInput,
    evidence: { checks: ['report_exists'] },
  }).id, submission.id);
  assert.throws(() => store.recordTaskDeliverySubmission({
    ...submissionInput, bodySnapshot: 'Different report under the same key',
  }), (error) => error?.code === 'delivery_submission_payload_conflict');
  const ownerRevision = store.recordOwnerDeliveryRevisionRequest({
    taskRunId: task.id,
    submissionId: submission.id,
    eventId: 'delivery-review-owner-revision-1',
    summary: 'Please tighten the executive summary.',
    actorId: 'delivery-review-user',
    occurredAt: '2026-08-13T08:00:00.000Z',
  });
  assert.equal(ownerRevision.duplicate, false);
  assert.equal(ownerRevision.event.eventType, 'owner_revision_requested');
  assert.equal(ownerRevision.event.submissionId, submission.id);
  assert.equal(store.recordOwnerDeliveryRevisionRequest({
    taskRunId: task.id,
    submissionId: submission.id,
    eventId: 'delivery-review-owner-revision-1',
    summary: 'Please tighten the executive summary.',
    actorId: 'delivery-review-user',
    occurredAt: '2026-08-13T08:00:00.000Z',
  }).duplicate, true);
  assert.equal(store.getTaskDeliveryReview(task.id).state, 'submitted',
    'owner revision history must not mutate the bounded quality-review state machine');
  assert.deepEqual({ ...db.prepare('SELECT id,session_id,role,content FROM messages WHERE id=?').get('delivery-review-message') }, preserved.message);

  const verification = store.transitionTaskDeliveryReview({
    taskRunId: task.id, submissionId: submission.id, eventId: 'delivery-review-event-1',
    eventType: 'verification_started', payload: { reviewer: 'ubuddy' },
  });
  assert.equal(verification.review.state, 'verifying');
  assert.equal(store.transitionTaskDeliveryReview({
    taskRunId: task.id, submissionId: submission.id, eventId: 'delivery-review-event-1',
    eventType: 'verification_started', payload: { reviewer: 'ubuddy' },
  }).duplicate, true);
  assert.throws(() => store.transitionTaskDeliveryReview({
    taskRunId: task.id, submissionId: submission.id, eventId: 'delivery-review-event-1',
    eventType: 'validation_passed', payload: { reviewer: 'ubuddy' },
  }), (error) => error?.code === 'delivery_review_event_payload_conflict');

  const failed = store.transitionTaskDeliveryReview({
    taskRunId: task.id, submissionId: submission.id, eventId: 'delivery-review-event-2',
    eventType: 'validation_failed', payload: {
      correctable: true,
      failedChecks: [{ code: 'missing_summary', summary: 'Executive summary is missing.' }],
      requiredChanges: ['Add an executive summary.'],
      preservedRequirements: ['Keep the verified data table unchanged.'],
    },
  });
  assert.equal(failed.action, 'revision_requested');
  assert.equal(failed.review.qualityRevisionCount, 1);

  const job = store.enqueueTaskDeliveryReviewJob({
    taskRunId: task.id, submissionId: submission.id, payload: { reviewMode: 'bounded' }, maxAttempts: 3,
  });
  assert.equal(store.enqueueTaskDeliveryReviewJob({
    taskRunId: task.id, submissionId: submission.id, payload: { reviewMode: 'bounded' }, maxAttempts: 3,
  }).id, job.id);
  assert.throws(() => store.enqueueTaskDeliveryReviewJob({
    taskRunId: task.id, submissionId: submission.id, payload: { reviewMode: 'different' }, maxAttempts: 3,
  }), (error) => error?.code === 'delivery_review_job_payload_conflict');

  const reviewSnapshot = store.getTaskDeliveryReview(task.id);
  const submissionSnapshot = store.listTaskDeliverySubmissions(task.id);
  const eventSnapshot = store.listTaskDeliveryReviewEvents(task.id);
  const jobSnapshot = store.listTaskDeliveryReviewJobs({ taskRunId: task.id });
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();

  db = openDatabase(root, { appVersion: '0.2.25' });
  store = new Store(db, { root });
  assert.equal(db.migrationBackup?.pendingMigrationIds?.includes('bounded_delivery_rework_v1') || false, false,
    'a second open must not rerun the additive delivery-review migration');
  assert.deepEqual(store.getTaskDeliveryReview(task.id), reviewSnapshot);
  assert.deepEqual(store.listTaskDeliverySubmissions(task.id), submissionSnapshot);
  assert.deepEqual(store.listTaskDeliveryReviewEvents(task.id), eventSnapshot);
  assert.deepEqual(store.listTaskDeliveryReviewJobs({ taskRunId: task.id }), jobSnapshot);
  assert.deepEqual(coreCounts(db), preserved.counts, 'delivery review history must not alter core inventories after restart');
  store.completeTaskDeliveryReviewJob({ jobId: job.id, status: 'cancelled', error: 'Migration smoke setup completed.' });

  const modelAccepted = await reviewUBuddyTaskDelivery({
    task: { id: task.id, title: 'Quarterly review', prompt: 'Provide the requested result.', metadata: {} },
    review: store.getTaskDeliveryReview(task.id),
    submission: { id: submission.id, submissionNo: 1, bodySnapshot: 'Useful content without an internal marker.' },
    evidence: {
      originalRequest: 'Provide the requested result.',
      body: 'Useful content without an internal marker or fixed report headings.',
      files: [{ id: 'artifact-objective-1', name: 'totally-unrelated-name.md', structurallyValid: true }],
    },
    execute: async () => JSON.stringify({
      version: 'UBUDDY_DELIVERY_REVIEW_DECISION_V1', verdict: 'accepted', confidence: 0.93,
      failureCodes: [], failedChecks: [], requiredChanges: [], preservedRequirements: [],
      summary: 'The delivery satisfies the original request.', evidence: ['artifact-objective-1'],
    }),
  });
  assert.equal(modelAccepted.verdict, 'accepted',
    'missing internal markers, fixed headings, and filename similarity must not programmatically reject a model-accepted delivery');
  const uncertainExhaustion = await reviewUBuddyTaskDelivery({
    task: { id: task.id, title: 'Final confirmation', prompt: 'Confirm the final delivery.', metadata: {} },
    review: { qualityRevisionCount: 2, maxQualityRevisions: 2 },
    submission: { id: submission.id, submissionNo: 3, bodySnapshot: 'Latest version.' },
    evidence: { originalRequest: 'Confirm the final delivery.', body: 'Latest version.', files: [] },
    exhaustionConfirmation: true,
    execute: async () => JSON.stringify({
      version: 'UBUDDY_DELIVERY_REVIEW_DECISION_V1', verdict: 'revision_requested', confidence: 0.8,
      failureCodes: ['possible_gap'],
      failedChecks: [{ code: 'possible_gap', summary: 'A possible gap remains.', requirement: 'Confirm the result.', evidence: 'body' }],
      requiredChanges: ['Investigate the possible gap.'], preservedRequirements: [], summary: 'Confidence is insufficient.', evidence: ['body'],
    }),
  });
  assert.equal(uncertainExhaustion.verdict, 'uncertain',
    'an uncertain exhaustion confirmation must stop the automatic quality loop instead of exhausting it');
  const permissionBlocked = await reviewUBuddyTaskDelivery({
    task: { id: task.id, title: 'Permission boundary', prompt: 'Use an approved private source.', metadata: {} },
    review: { qualityRevisionCount: 0, maxQualityRevisions: 2 },
    submission: { id: submission.id, submissionNo: 1, bodySnapshot: 'Permission is unavailable.' },
    evidence: { originalRequest: 'Use an approved private source.', body: 'Permission is unavailable.', files: [] },
    execute: async () => JSON.stringify({
      version: 'UBUDDY_DELIVERY_REVIEW_DECISION_V1', verdict: 'revision_requested', confidence: 0.95,
      failureCodes: ['permission_required'],
      failedChecks: [{ code: 'permission_required', summary: 'The source cannot be accessed.', requirement: 'Use the approved source.', evidence: 'body' }],
      requiredChanges: ['Obtain access to the source.'], preservedRequirements: [], summary: 'Permission is required.', evidence: ['body'],
    }),
  });
  assert.equal(permissionBlocked.verdict, 'action_required',
    'permission and approval blockers must never enter the automatic quality-rework loop');

  const schedulerOrg = {
    agent(id) { return { id, name: id, departmentId: 'general', routable: true }; },
    list() { return { agents: [] }; },
    readSkill() { return ''; },
    readMemory() { return ''; },
  };
  const scheduler = new TaskScheduler({ root, store, org: schedulerOrg });
  scheduler.scheduleDeliveryReviewDrain = () => {};
  scheduler.continueTaskRun = async (taskRunId) => store.getTaskRun(taskRunId);
  store.upsertAgentFamily({
    id: 'general_agent', name: 'General Agent', departmentId: 'general', role: 'agent', routable: true,
  });
  store.upsertAgentVersion({
    agent: {
      id: 'general_agent', name: 'General Agent', departmentId: 'general', role: 'agent',
      baseSkill: '# General Agent\nHandle general spreadsheet work.',
    },
    memoryTemplate: '# Memory\n',
  });
  const supportingFallbackAgent = store.recruitUserAgent({
    userId: 'delivery-review-user',
    agentFamilyId: 'general_agent',
    commandId: 'bounded-delivery-rework:supporting-fallback-agent',
    recruitmentSource: 'test',
  }).instance;
  const activeLegacyTask = store.createTaskRun({
    id: 'delivery-review-active-legacy-task', ownerUserId: 'delivery-review-user', title: 'Active legacy task',
    prompt: 'Resume under bounded review.', metadata: {
      source: 'ubuddy_dispatch', featureFlagSnapshot: { boundedDeliveryReworkV1: false, boundedDeliveryRework: false },
    },
  });
  const activatedLegacyTask = scheduler.activateBoundedDeliveryReviewForActiveTask(activeLegacyTask);
  assert.equal(activatedLegacyTask.metadata.featureFlagSnapshot.boundedDeliveryReworkV1, false,
    'delivery policy activation must not rewrite the historical feature-flag snapshot');
  assert.equal(activatedLegacyTask.metadata.deliveryReviewPolicyVersion, 'delivery_review_policy_v2');
  assert.equal(activatedLegacyTask.metadata.deliveryAuthority, 'scheduler');
  assert.equal(activatedLegacyTask.metadata.deliveryMode, 'available_before_quality_review');
  scheduler.activateBoundedDeliveryReviewForActiveTask(store.getTaskRun(activeLegacyTask.id));
  assert.equal(store.getTaskRun(activeLegacyTask.id).events
    .filter((event) => event.eventType === 'ubuddy_delivery_review_policy_activated').length, 1,
  'active-task policy activation must be idempotent');

  const supportingFallbackTask = store.createTaskRun({
    id: 'supporting-file-fallback-task', ownerUserId: 'delivery-review-user', title: 'Supporting file fallback',
    prompt: 'Generate a supporting spreadsheet.', initialStatus: 'running', deferAgentInstanceBinding: true,
    metadata: { deliverableContract: { deliverables: [] } },
  });
  const supportingFileNode = store.createTaskNode({
    taskRunId: supportingFallbackTask.id, title: 'Generate supporting data', objective: 'Generate the supporting spreadsheet.',
    agentId: 'general_agent', departmentId: 'general', status: 'running', blocking: true,
    outputFormat: 'spreadsheet', fallback: 'Rebuild the complete supporting spreadsheet.', deferAgentInstanceBinding: true,
  });
  store.updateTaskRunMetadata(supportingFallbackTask.id, {
    finalTaskNodeId: 'different-final-node',
    deliverableContract: { deliverables: [{
      id: 'supporting-sheet', role: 'supporting', deliverable_title: '数据附件', requested_output_type: 'spreadsheet',
      requires_file: true, owner_node_id: supportingFileNode.id, required_extensions: ['.xlsx'],
    }] },
  });
  const supportingFallback = scheduler.replaceNodeWithFallback(
    store.getTaskRun(supportingFallbackTask.id), store.getTaskNode(supportingFileNode.id),
    {
      reason: 'renderer unavailable',
      errorCode: 'execution_failed',
      fallbackCandidate: {
        agentId: 'general_agent', agentInstanceId: supportingFallbackAgent.id,
        departmentId: 'general', effectiveSkill: 'spreadsheet xlsx',
      },
    },
  ).replacement;
  const reboundSupportingContract = store.getTaskRun(supportingFallbackTask.id).metadata.deliverableContract;
  assert.equal(reboundSupportingContract.deliverables[0].owner_node_id, supportingFallback.id,
    'a non-final file deliverable must follow its replacement node');
  assert.match(supportingFallback.outputFormat, /\.xlsx/,
    'a fallback node must inherit the exact published file format');

  assert.equal(effectiveTaskExecutionPermissionMode({ metadata: { source: 'ubuddy_dispatch' } }, 'request-approval'), 'task-workspace');
  assert.equal(effectiveTaskExecutionPermissionMode({
    metadata: { source: 'ubuddy_dispatch', executionOptions: { permissionMode: 'full-access', permissionPolicyVersion: 'ubuddy_task_permission_v2' } },
  }, 'task-workspace'), 'full-access');
  assert.equal(effectiveTaskExecutionPermissionMode({
    metadata: { taskOrigin: 'external_delegation', executionOptions: { permissionMode: 'auto-approve', permissionPolicyVersion: 'ubuddy_task_permission_v2' } },
  }, 'task-workspace'), 'auto-approve');
  assert.equal(taskExecutionPermissionMode({ metadata: { source: 'ubuddy_dispatch', executionOptions: {
    permissionPolicyVersion: 'ubuddy_task_permission_v2', permissionMode: 'full-access', permissionDeviceId: 'device-a',
  } } }, 'task-workspace', 'device-a'), 'full-access');
  assert.throws(() => taskExecutionPermissionMode({ metadata: { source: 'ubuddy_dispatch', executionOptions: {
    permissionPolicyVersion: 'ubuddy_task_permission_v2', permissionMode: 'full-access', permissionDeviceId: 'device-a',
  } } }, 'task-workspace', 'device-b'), (error) => error.code === 'permission_reauthorization_required');
  assert.equal(taskExecutionPermissionMode({ metadata: { source: 'ubuddy_dispatch', executionOptions: {
    permissionMode: 'full-access', requestedPermissionMode: 'full-access',
  } } }, 'task-workspace', 'device-a'), 'task-workspace', 'legacy tasks must keep the conservative workspace policy');
  assert.equal(effectiveTaskExecutionPermissionMode({ metadata: { source: 'ordinary_task' } }, 'request-approval'), 'request-approval');
  const permissionDiagnostic = classifyTaskNodeError(Object.assign(
    new Error('The isolated workspace appears read-only and approval is unavailable.'), { code: 'diagnostic_output' },
  ));
  assert.equal(permissionDiagnostic.code, 'permission_required');
  assert.equal(permissionDiagnostic.userActionRequired, false,
    'an unattended permission mismatch must wake uBuddy recovery before asking the owner');
  const windowsSandboxDiagnostic = classifyTaskNodeError(new Error(
    'writing is blocked by read-only sandbox; rejected by user approval settings',
  ));
  assert.equal(windowsSandboxDiagnostic.code, 'sandbox_workspace_write_unavailable');
  assert.equal(windowsSandboxDiagnostic.blocked, true);
  assert.equal(windowsSandboxDiagnostic.userActionRequired, true);
  assert.equal(classifyTaskNodeError(new Error('API key credential is missing (401).')).code, 'credential_required');
  assert.deepEqual(
    classifyTaskNodeError(new Error('Request aborted after timeout while waiting for model service.')),
    { code: 'execution_timeout', retryable: true, userActionRequired: false, userMessage: '执行超时，系统将自动重试。' },
    'timeout-driven aborts must remain retryable model failures instead of user cancellations',
  );

  const recoverySession = store.createSession({
    id: 'delivery-review-recovery-session', userId: 'delivery-review-user', title: 'uBuddy recovery',
    departmentId: 'secretary_department', agentId: 'secretary_agent',
  });
  const recoveryTask = store.createTaskRun({
    id: 'delivery-review-recovery-task', ownerUserId: 'delivery-review-user', title: 'Recover generic failure',
    prompt: 'Recover before asking the owner.', metadata: { source: 'ubuddy_dispatch', workspaceRoot: root },
  });
  const recoveryNode = store.createTaskNode({
    taskRunId: recoveryTask.id, title: 'Recoverable node', objective: 'Produce a deliverable.',
    agentId: '', status: 'running', blocking: true, deferAgentInstanceBinding: true, attemptCount: 1,
  });
  store.startUBuddyCoordination({ taskRunId: recoveryTask.id, sourceSessionId: recoverySession.id });
  store.markUBuddySleeping({
    taskRunId: recoveryTask.id, leaderAgentId: 'general_agent', leaderAgentInstanceId: 'general_instance_recovery',
  });
  let requestedRecoveryWake = null;
  scheduler.requestUBuddyFailureWake = (_taskRunId, payload) => { requestedRecoveryWake = payload; return null; };
  scheduler.handleNodeExecutionFailure(store.getTaskRun(recoveryTask.id), recoveryNode, {
    errorSummary: 'The tool returned a non-retryable diagnostic.',
    failure: classifyTaskNodeError(Object.assign(new Error('The tool returned a non-retryable diagnostic.'), { code: 'diagnostic_output' })),
  });
  assert.equal(requestedRecoveryWake.reasonCode, 'recovery_required');
  assert.equal(store.getTaskRun(recoveryTask.id).nodes.find((node) => node.id === recoveryNode.id).status, 'failed');

  const sideEffectTask = store.createTaskRun({
    id: 'delivery-review-side-effect-task', ownerUserId: 'delivery-review-user', title: 'Review unsafe recovery',
    prompt: 'Review before asking the owner.', metadata: { source: 'ubuddy_dispatch', workspaceRoot: root },
  });
  const sideEffectNode = store.createTaskNode({
    taskRunId: sideEffectTask.id, title: '发送邮件', objective: '发送一封正式通知邮件。',
    agentId: '', status: 'running', blocking: true, deferAgentInstanceBinding: true, attemptCount: 1,
  });
  store.startUBuddyCoordination({ taskRunId: sideEffectTask.id, sourceSessionId: recoverySession.id });
  store.markUBuddySleeping({
    taskRunId: sideEffectTask.id, leaderAgentId: 'general_agent', leaderAgentInstanceId: 'general_instance_side_effect',
  });
  requestedRecoveryWake = null;
  scheduler.handleNodeExecutionFailure(store.getTaskRun(sideEffectTask.id), sideEffectNode, {
    errorSummary: 'Temporary network failure after the send operation started.',
    failure: classifyTaskNodeError(new Error('ECONNRESET temporary network failure')),
  });
  assert.equal(requestedRecoveryWake.reasonCode, 'recovery_required',
    'unsafe side-effect failures must still wake uBuddy for review');
  assert.equal(store.getTaskRun(sideEffectTask.id).nodes.find((node) => node.id === sideEffectNode.id).status, 'failed');
  assert.match(store.getTaskRun(sideEffectTask.id).metadata.failureReport.suggestedNextStep, /确认是否允许/,
    'uBuddy review must not silently retry a node that may repeat an external side effect');

  const sandboxBlockedTask = store.createTaskRun({
    id: 'delivery-review-sandbox-blocked-task', ownerUserId: 'delivery-review-user', title: 'Sandbox blocked task',
    prompt: 'Create a document.', metadata: { source: 'ubuddy_dispatch', workspaceRoot: root,
      featureFlagSnapshot: { boundedDeliveryReworkV1: true } },
  });
  const sandboxBlockedNode = store.createTaskNode({
    taskRunId: sandboxBlockedTask.id, title: 'Create document', objective: 'Create the requested file.',
    agentId: '', status: 'running', blocking: true, deferAgentInstanceBinding: true, attemptCount: 1,
  });
  scheduler.requestUBuddyFailureWake = () => null;
  const sandboxFailure = classifyTaskNodeError(new Error('bwrap: setting up uid map: Permission denied'));
  assert.equal(sandboxFailure.code, 'sandbox_workspace_write_unavailable');
  assert.equal(sandboxFailure.blocked, true);
  scheduler.handleNodeExecutionFailure(store.getTaskRun(sandboxBlockedTask.id), sandboxBlockedNode, {
    errorSummary: 'bwrap: setting up uid map: Permission denied', failure: sandboxFailure,
  });
  const sandboxBlocked = store.getTaskRun(sandboxBlockedTask.id);
  assert.equal(sandboxBlocked.nodes.find((node) => node.id === sandboxBlockedNode.id).status, 'blocked');
  assert.equal(sandboxBlocked.status, 'waiting');
  assert.equal(sandboxBlocked.metadata.failureReport.errorCode, 'sandbox_workspace_write_unavailable');
  assert.equal(store.listTaskDeliverySubmissions(sandboxBlockedTask.id).length, 0,
    'execution-environment blockers must not be submitted as delivery quality candidates');
  const missingWorkspaceTask = store.createTaskRun({
    id: 'delivery-review-missing-workspace-task', ownerUserId: 'delivery-review-user', title: 'Missing Workspace review',
    prompt: 'Use the selected Workspace.', metadata: {
      source: 'ubuddy_dispatch', workspaceRoot: path.join(root, 'workspace-does-not-exist'),
      featureFlagSnapshot: { boundedDeliveryReworkV1: true },
    },
  });
  const missingWorkspaceNode = store.createTaskNode({
    taskRunId: missingWorkspaceTask.id, title: 'Workspace result', objective: 'Return the result.',
    agentId: '', status: 'pending', blocking: true, deferAgentInstanceBinding: true,
  });
  store.updateTaskRunMetadata(missingWorkspaceTask.id, { finalTaskNodeId: missingWorkspaceNode.id });
  store.updateTaskNode(missingWorkspaceNode.id, { status: 'completed', resultText: 'Result awaiting Workspace review.', completedAt: new Date().toISOString() });
  scheduler.reconcileTaskStatus(missingWorkspaceTask.id);
  const missingWorkspaceReviewed = store.getTaskRun(missingWorkspaceTask.id);
  assert.equal(missingWorkspaceReviewed.status, 'completed');
  assert.equal(missingWorkspaceReviewed.deliveryReview.state, 'verifying');
  assert.equal(missingWorkspaceReviewed.metadata.finalDelivery.state, 'delivered');
  assert.equal(missingWorkspaceReviewed.deliveryReview.qualityRevisionCount, 0);
  assert.equal(store.listTaskDeliveryReviewJobs({ taskRunId: missingWorkspaceTask.id }).length, 1,
    'a missing Workspace without file evidence must not block an inline delivery');
  const missingRequiredFileTask = store.createTaskRun({
    id: 'delivery-review-missing-required-file-task', ownerUserId: 'delivery-review-user',
    title: 'Missing required PPTX', prompt: 'Create and deliver a PPTX file.', metadata: {
      source: 'ubuddy_dispatch', workspaceRoot: root,
      featureFlagSnapshot: { boundedDeliveryReworkV1: false, boundedDeliveryRework: false },
      deliveryReviewPolicyVersion: 'delivery_review_policy_v2', deliveryAuthority: 'scheduler',
      deliveryMode: 'available_before_quality_review',
      deliverableContract: { version: 'deliverable_contract_v2', requires_file: true,
        required_extensions: ['.pptx'], deliverables: [] },
    },
  });
  const missingRequiredFileNode = store.createTaskNode({
    taskRunId: missingRequiredFileTask.id, title: 'PPTX result', objective: 'Create the requested PPTX.',
    agentId: '', status: 'pending', blocking: true, deferAgentInstanceBinding: true,
  });
  store.updateTaskRunMetadata(missingRequiredFileTask.id, { finalTaskNodeId: missingRequiredFileNode.id });
  store.updateTaskNode(missingRequiredFileNode.id, {
    status: 'completed', resultText: 'I described the slides but did not create the PPTX.', completedAt: new Date().toISOString(),
  });
  scheduler.reconcileTaskStatus(missingRequiredFileTask.id);
  const missingRequiredFileReviewed = store.getTaskRun(missingRequiredFileTask.id);
  assert.equal(missingRequiredFileReviewed.status, 'ready');
  assert.equal(missingRequiredFileReviewed.deliveryReview.state, 'reworking');
  assert.equal(missingRequiredFileReviewed.deliveryReview.qualityRevisionCount, 1);
  assert.equal(missingRequiredFileReviewed.metadata.deliveryValidationCode, '');
  assert.equal(missingRequiredFileReviewed.metadata.resultState, 'needs_revision');
  assert.equal(missingRequiredFileReviewed.metadata.finalDelivery?.state || 'not_delivered', 'not_delivered');
  assert.equal(missingRequiredFileReviewed.nodes.some((node) => node.parallelGroup === 'delivery_rework'), true);
  assert.equal(missingRequiredFileReviewed.events.some((event) => event.eventType === 'delivery_unqualified'), true);
  const legacyValidationWarningTask = store.createTaskRun({
    id: 'delivery-review-legacy-validation-warning-task', ownerUserId: 'delivery-review-user',
    title: 'Legacy validation warning keeps result visible',
    prompt: 'Return a result before legacy validation warning.', metadata: { source: 'ubuddy_dispatch' },
  });
  const legacyValidationWarningNode = store.createTaskNode({
    taskRunId: legacyValidationWarningTask.id,
    title: 'Legacy validation result',
    objective: 'Return the result.',
    agentId: '',
    status: 'completed',
    blocking: true,
    deferAgentInstanceBinding: true,
  });
  store.updateTaskNode(legacyValidationWarningNode.id, {
    status: 'completed',
    resultText: 'Visible result before validation warning.',
    completedAt: new Date().toISOString(),
  });
  store.updateTaskRunMetadata(legacyValidationWarningTask.id, { finalTaskNodeId: legacyValidationWarningNode.id });
  store.updateTaskRunStatus(legacyValidationWarningTask.id, 'verifying', 'Legacy validation gate.');
  const legacyValidationWarned = scheduler.completeTaskDeliveryValidation(legacyValidationWarningTask.id, {
    passed: false,
    failureCode: 'legacy_validation_warning',
    summary: 'Legacy validation reported a warning.',
  });
  assert.equal(legacyValidationWarned.status, 'completed');
  assert.equal(legacyValidationWarned.metadata.finalDelivery.state, 'delivered');
  assert.equal(legacyValidationWarned.metadata.resultState, 'delivered');
  assert.equal(legacyValidationWarned.metadata.deliveryValidationState, 'warning');
  assert.match(legacyValidationWarned.metadata.deliverableResult.body, /Visible result/);
  const schedulerTask = store.createTaskRun({
    id: 'delivery-review-scheduler-task', ownerUserId: 'delivery-review-user', title: 'Scheduler review flow',
    prompt: 'Return a complete scheduler-reviewed result.', metadata: {
      source: 'ubuddy_dispatch', workspaceRoot: root,
      featureFlagSnapshot: { boundedDeliveryReworkV1: true },
    },
  });
  const schedulerNode = store.createTaskNode({
    taskRunId: schedulerTask.id, title: 'Final result', objective: 'Produce the final result.',
    agentId: '', status: 'pending', blocking: true, deferAgentInstanceBinding: true,
  });
  store.updateTaskRunMetadata(schedulerTask.id, { finalTaskNodeId: schedulerNode.id });
  store.updateTaskNode(schedulerNode.id, { status: 'completed', resultText: 'Version one result.', completedAt: new Date().toISOString() });
  scheduler.reconcileTaskStatus(schedulerTask.id);
  let schedulerReviewedTask = store.getTaskRun(schedulerTask.id);
  assert.equal(schedulerReviewedTask.status, 'completed');
  assert.equal(schedulerReviewedTask.deliveryReview.state, 'verifying');
  assert.equal(schedulerReviewedTask.deliverySubmissions.length, 1);
  assert.equal(schedulerReviewedTask.metadata.finalDelivery.state, 'delivered');
  assert.equal(schedulerReviewedTask.metadata.resultState, 'delivered');
  assert.equal(schedulerReviewedTask.metadata.deliveryBasicCheck.passed, true);
  const schedulerReviewJob = store.listTaskDeliveryReviewJobs({ taskRunId: schedulerTask.id })[0];
  assert.equal(schedulerReviewJob.maxAttempts, 2, 'quality review allows one initial attempt and one retry');
  await scheduler.applyTaskDeliveryReviewDecision({
    task: schedulerReviewedTask,
    submission: schedulerReviewedTask.deliverySubmissions[0],
    review: schedulerReviewedTask.deliveryReview,
    job: schedulerReviewJob,
    decision: {
      verdict: 'revision_requested', confidence: 0.95, failureCodes: ['missing_item'],
      failedChecks: [{ code: 'missing_item', summary: 'One requested item is missing.', requirement: 'Return a complete result.', evidence: 'body' }],
      requiredChanges: ['Add the missing requested item.'], preservedRequirements: ['Keep the valid first section.'],
      summary: 'uBuddy requested one bounded quality revision.', evidence: ['body'],
    },
  });
  schedulerReviewedTask = store.getTaskRun(schedulerTask.id);
  assert.equal(schedulerReviewedTask.status, 'completed');
  assert.equal(schedulerReviewedTask.deliveryReview.state, 'revision_requested');
  assert.equal(schedulerReviewedTask.deliveryReview.qualityRevisionCount, 1);
  assert.equal(schedulerReviewedTask.metadata.resultState, 'delivered');
  assert.equal(schedulerReviewedTask.metadata.deliveryValidationState, 'warning');
  assert.equal(schedulerReviewedTask.nodes.some((node) => node.parallelGroup === 'delivery_rework'), false,
    'uBuddy quality feedback must remain advisory and must not create automatic rework');
  const reviewMarkup = renderUBuddyCoordinationPanels({
    state: { employeeOverview: { roster: [] }, uBuddyFeatureFlags: {} },
    taskRunId: schedulerReviewedTask.id,
    coordination: {
      coordinationState: 'awakened', participants: [], leader: {}, waitingRequirements: [],
    },
    task: schedulerReviewedTask,
    nodes: schedulerReviewedTask.nodes,
  });
  assert.match(reviewMarkup, /交付与质量检查/);
  assert.match(reviewMarkup, /质量提示/);
  assert.match(reviewMarkup, /完全开放|AI 自动审查|兼容隔离/);
  assert.match(reviewMarkup, /查看全部交付版本（1）/);
  assert.match(reviewMarkup, /等待用户决定/);
  assert.match(reviewMarkup, /接受当前交付/);
  assert.equal(schedulerReviewedTask.metadata.finalDelivery.state, 'delivered');
  assert.equal(schedulerReviewedTask.metadata.finalDelivery.closedAt, '', 'uBuddy acceptance must not close before user confirmation');
  scheduler.acceptTaskDeliverySubmission({
    taskRunId: schedulerReviewedTask.id,
    submissionId: schedulerReviewedTask.deliverySubmissions[0].id,
    actorId: 'delivery-review-user',
    clientCommandId: 'scheduler-user-confirm-current-version',
  });
  schedulerReviewedTask = store.getTaskRun(schedulerTask.id);
  assert.equal(schedulerReviewedTask.metadata.deliveryReviewOutcome, 'owner_override');
  assert.equal(schedulerReviewedTask.metadata.finalDelivery.state, 'closed');

  const ownerAcceptedTask = store.createTaskRun({
    id: 'delivery-review-owner-accepted-task', ownerUserId: 'delivery-review-user', title: 'Owner accepts saved version',
    prompt: 'Prepare a saved version.', metadata: { source: 'ubuddy_dispatch' },
  });
  const ownerAcceptedNode = store.createTaskNode({
    taskRunId: ownerAcceptedTask.id, title: 'Ongoing revision', objective: 'Revise the result.',
    status: 'running', blocking: true, deferAgentInstanceBinding: true,
  });
  const ownerSubmissionOne = store.recordTaskDeliverySubmission({
    taskRunId: ownerAcceptedTask.id, taskNodeId: ownerAcceptedNode.id,
    submissionKey: 'owner-accepted-submission-1', bodySnapshot: 'Owner selected version one.',
  });
  store.transitionTaskDeliveryReview({
    taskRunId: ownerAcceptedTask.id, submissionId: ownerSubmissionOne.id,
    eventId: 'owner-accepted-submitted-1', eventType: 'submitted', payload: {},
  });
  store.transitionTaskDeliveryReview({
    taskRunId: ownerAcceptedTask.id, submissionId: ownerSubmissionOne.id,
    eventId: 'owner-accepted-verifying-1', eventType: 'verification_started', payload: {},
  });
  const ownerReviewJob = store.enqueueTaskDeliveryReviewJob({
    taskRunId: ownerAcceptedTask.id, submissionId: ownerSubmissionOne.id, payload: {}, maxAttempts: 3,
  });
  store.updateTaskRunStatus(ownerAcceptedTask.id, 'verifying', 'Reviewing owner-selectable version.');
  store.updateTaskRunMetadata(ownerAcceptedTask.id, {
    deliverableResult: { title: 'Owner selected report', summary: 'Awaiting owner acceptance.' },
  });
  const staleTaskSnapshot = store.getTaskRun(ownerAcceptedTask.id);
  const staleReviewSnapshot = staleTaskSnapshot.deliveryReview;
  scheduler.acceptTaskDeliverySubmission({
    taskRunId: ownerAcceptedTask.id,
    submissionId: ownerSubmissionOne.id,
    actorId: 'delivery-review-user',
    clientCommandId: 'owner-command-1',
  });
  let ownerAccepted = store.getTaskRun(ownerAcceptedTask.id);
  assert.equal(ownerAccepted.status, 'completed');
  assert.equal(ownerAccepted.deliveryReview.state, 'accepted');
  assert.equal(ownerAccepted.metadata.deliveryReviewOutcome, 'owner_override');
  assert.equal(ownerAccepted.metadata.finalDelivery.state, 'closed');
  assert.ok(ownerAccepted.metadata.finalDelivery.userConfirmedAt);
  assert.ok(ownerAccepted.metadata.finalDelivery.closedAt);
  assert.equal(ownerAccepted.metadata.deliverableResult.selectedSubmissionId, ownerSubmissionOne.id);
  assert.equal(ownerAccepted.metadata.deliverableResult.title, 'Owner selected report',
    'acceptance must preserve the title shown on the original delivery card');
  assert.equal(ownerAccepted.nodes.find((node) => node.id === ownerAcceptedNode.id).status, 'cancelled');
  assert.equal(store.listTaskDeliveryReviewJobs({ taskRunId: ownerAcceptedTask.id })[0].status, 'cancelled');
  scheduler.acceptTaskDeliverySubmission({
    taskRunId: ownerAcceptedTask.id,
    submissionId: ownerSubmissionOne.id,
    actorId: 'delivery-review-user',
    clientCommandId: 'owner-command-1',
  });
  assert.equal(store.listTaskDeliveryReviewEvents(ownerAcceptedTask.id)
    .filter((event) => event.eventType === 'owner_accepted').length, 1, 'owner acceptance must be idempotent');
  await scheduler.applyTaskDeliveryReviewDecision({
    task: staleTaskSnapshot,
    submission: ownerSubmissionOne,
    review: staleReviewSnapshot,
    job: ownerReviewJob,
    decision: {
      verdict: 'revision_requested', confidence: 0.99, failureCodes: ['late_review'],
      failedChecks: [{ code: 'late_review', summary: 'Late review result.', requirement: 'Do not override owner.', evidence: 'body' }],
      requiredChanges: ['This stale result must be ignored.'], preservedRequirements: [], summary: 'Late review.', evidence: ['body'],
    },
  });
  ownerAccepted = store.getTaskRun(ownerAcceptedTask.id);
  assert.equal(ownerAccepted.status, 'completed');
  assert.equal(ownerAccepted.nodes.filter((node) => node.parallelGroup === 'delivery_rework').length, 0,
    'a late review result must not create rework after owner acceptance');

  const bestEffortTask = store.createTaskRun({
    id: 'delivery-review-best-effort-task', ownerUserId: 'delivery-review-user', title: 'Best effort exhaustion delivery',
    prompt: 'Return the latest version after bounded revisions.', metadata: { source: 'ubuddy_dispatch' },
  });
  let bestEffortReview = store.ensureTaskDeliveryReview({ taskRunId: bestEffortTask.id });
  let bestEffortSubmission = null;
  for (let submissionNo = 1; submissionNo <= 3; submissionNo += 1) {
    bestEffortSubmission = store.recordTaskDeliverySubmission({
      taskRunId: bestEffortTask.id,
      submissionKey: `best-effort-submission-${submissionNo}`,
      bodySnapshot: `Best effort version ${submissionNo}`,
    });
    store.transitionTaskDeliveryReview({
      taskRunId: bestEffortTask.id, submissionId: bestEffortSubmission.id,
      eventId: `best-effort-submitted-${submissionNo}`, eventType: 'submitted', payload: {},
    });
    bestEffortReview = store.transitionTaskDeliveryReview({
      taskRunId: bestEffortTask.id, submissionId: bestEffortSubmission.id,
      eventId: `best-effort-verifying-${submissionNo}`, eventType: 'verification_started', payload: {},
    }).review;
    if (submissionNo <= 2) {
      bestEffortReview = store.transitionTaskDeliveryReview({
        taskRunId: bestEffortTask.id, submissionId: bestEffortSubmission.id,
        eventId: `best-effort-rejected-${submissionNo}`, eventType: 'validation_failed', payload: {
          correctable: true, failureCodes: ['quality_gap'],
          failedChecks: [{ code: 'quality_gap', summary: 'A quality gap remains.', requirement: 'Improve the result.', evidence: 'body' }],
          requiredChanges: ['Improve the result.'], summary: 'Revision required.',
        },
      }).review;
      store.transitionTaskDeliveryReview({
        taskRunId: bestEffortTask.id, submissionId: bestEffortSubmission.id,
        eventId: `best-effort-rework-${submissionNo}`, eventType: 'rework_started', payload: {},
      });
    }
  }
  store.updateTaskRunStatus(bestEffortTask.id, 'verifying', 'Final bounded review.');
  const bestEffortJob = store.enqueueTaskDeliveryReviewJob({
    taskRunId: bestEffortTask.id, submissionId: bestEffortSubmission.id, payload: {}, maxAttempts: 3,
  });
  await scheduler.applyTaskDeliveryReviewDecision({
    task: store.getTaskRun(bestEffortTask.id),
    submission: bestEffortSubmission,
    review: bestEffortReview,
    job: bestEffortJob,
    decision: {
      verdict: 'revision_requested', confidence: 0.96, failureCodes: ['quality_gap'],
      failedChecks: [{ code: 'quality_gap', summary: 'A quality gap remains.', requirement: 'Improve the result.', evidence: 'body' }],
      requiredChanges: ['Improve the result.'], preservedRequirements: [],
      summary: 'The latest version still has a quality gap.', evidence: ['body'],
    },
  });
  const bestEffortDelivered = store.getTaskRun(bestEffortTask.id);
  assert.equal(bestEffortDelivered.status, 'completed');
  assert.equal(bestEffortDelivered.deliveryReview.state, 'revision_exhausted');
  assert.equal(bestEffortDelivered.metadata.deliveryReviewOutcome, 'ubuddy_quality_advisory');
  assert.equal(bestEffortDelivered.metadata.finalDelivery.state, 'delivered');
  assert.equal(bestEffortDelivered.metadata.finalDelivery.userConfirmedAt, '');
  assert.equal(bestEffortDelivered.metadata.deliverableResult.qualityWarning, true);
  assert.equal(bestEffortDelivered.metadata.deliverableResult.body, 'Best effort version 3');
  assert.equal(bestEffortDelivered.metadata.failureReport, null);
  assert.equal(bestEffortDelivered.nodes.some((node) => node.parallelGroup === 'delivery_rework'), false);

  const flowTask = store.createTaskRun({
    id: 'delivery-review-flow-task', ownerUserId: 'delivery-review-user', title: 'Bounded review flow',
    prompt: 'Prepare a complete launch note.', metadata: { source: 'ubuddy_dispatch' },
  });
  let flowReview = store.ensureTaskDeliveryReview({ taskRunId: flowTask.id });
  for (let submissionNo = 1; submissionNo <= 3; submissionNo += 1) {
    const flowSubmission = store.recordTaskDeliverySubmission({
      taskRunId: flowTask.id, submissionKey: `flow-submission-${submissionNo}`,
      bodySnapshot: `Launch note version ${submissionNo}`,
    });
    store.transitionTaskDeliveryReview({
      taskRunId: flowTask.id, submissionId: flowSubmission.id,
      eventId: `flow-submitted-${submissionNo}`, eventType: 'submitted', payload: { occurredAt: `2026-08-04T00:0${submissionNo}:00.000Z` },
    });
    flowReview = store.transitionTaskDeliveryReview({
      taskRunId: flowTask.id, submissionId: flowSubmission.id,
      eventId: `flow-verifying-${submissionNo}`, eventType: 'verification_started', payload: { occurredAt: `2026-08-04T00:0${submissionNo}:00.000Z` },
    }).review;
    if (submissionNo <= 2) {
      const revision = store.transitionTaskDeliveryReview({
        taskRunId: flowTask.id, submissionId: flowSubmission.id,
        eventId: `flow-revision-${submissionNo}`, eventType: 'validation_failed', payload: {
          correctable: true, confidence: 0.91, summary: `Version ${submissionNo} needs one fix.`,
          failureCodes: ['content_missing'],
          failedChecks: [{ code: 'content_missing', summary: 'A required item is missing.', requirement: 'Include all launch items.', evidence: `version-${submissionNo}` }],
          requiredChanges: [`Add missing launch item ${submissionNo}.`],
          preservedRequirements: ['Keep the verified release date.'],
        },
      });
      assert.equal(revision.action, 'revision_requested');
      assert.equal(revision.review.qualityRevisionCount, submissionNo);
      assert.equal(revision.review.executionAttemptCount, 0);
      assert.equal(revision.review.latestFeedback.summary, `Version ${submissionNo} needs one fix.`);
      flowReview = store.transitionTaskDeliveryReview({
        taskRunId: flowTask.id, submissionId: flowSubmission.id,
        eventId: `flow-rework-${submissionNo}`, eventType: 'rework_started', payload: {},
      }).review;
    } else {
      flowReview = store.transitionTaskDeliveryReview({
        taskRunId: flowTask.id, submissionId: flowSubmission.id,
        eventId: 'flow-accepted-3', eventType: 'validation_passed', payload: { summary: 'Third version accepted.' },
      }).review;
    }
  }
  assert.equal(flowReview.state, 'accepted');
  assert.equal(flowReview.qualityRevisionCount, 2);
  assert.equal(store.listTaskDeliverySubmissions(flowTask.id).length, 3);

  const exhaustedTask = store.createTaskRun({
    id: 'delivery-review-exhausted-task', ownerUserId: 'delivery-review-user', title: 'Exhausted review flow',
    prompt: 'Prepare a complete handoff.', metadata: { source: 'ubuddy_dispatch' },
  });
  for (let submissionNo = 1; submissionNo <= 3; submissionNo += 1) {
    const exhaustedSubmission = store.recordTaskDeliverySubmission({
      taskRunId: exhaustedTask.id, submissionKey: `exhausted-submission-${submissionNo}`, bodySnapshot: `Handoff ${submissionNo}`,
    });
    store.transitionTaskDeliveryReview({
      taskRunId: exhaustedTask.id, submissionId: exhaustedSubmission.id,
      eventId: `exhausted-submitted-${submissionNo}`, eventType: 'submitted', payload: {},
    });
    store.transitionTaskDeliveryReview({
      taskRunId: exhaustedTask.id, submissionId: exhaustedSubmission.id,
      eventId: `exhausted-verifying-${submissionNo}`, eventType: 'verification_started', payload: {},
    });
    const decision = store.transitionTaskDeliveryReview({
      taskRunId: exhaustedTask.id, submissionId: exhaustedSubmission.id,
      eventId: `exhausted-revision-${submissionNo}`, eventType: 'validation_failed', payload: {
        correctable: true, failureCodes: ['still_incomplete'], requiredChanges: ['Complete the missing handoff item.'],
      },
    });
    if (submissionNo <= 2) {
      assert.equal(decision.action, 'revision_requested');
      store.transitionTaskDeliveryReview({
        taskRunId: exhaustedTask.id, submissionId: exhaustedSubmission.id,
        eventId: `exhausted-rework-${submissionNo}`, eventType: 'rework_started', payload: {},
      });
    } else {
      assert.equal(decision.action, 'revision_exhausted');
      assert.equal(decision.review.state, 'revision_exhausted');
      assert.equal(decision.review.qualityRevisionCount, 2);
    }
  }

  const executionTask = store.createTaskRun({
    id: 'delivery-review-execution-task', ownerUserId: 'delivery-review-user', title: 'Review execution retry',
    prompt: 'Review execution failures separately.', metadata: { source: 'ubuddy_dispatch' },
  });
  const executionSubmission = store.recordTaskDeliverySubmission({
    taskRunId: executionTask.id, submissionKey: 'execution-submission-1', bodySnapshot: 'Review me.',
  });
  store.recordTaskDeliveryReviewExecutionFailure({
    taskRunId: executionTask.id, submissionId: executionSubmission.id, eventId: 'execution-failure-1', error: 'network timeout',
  });
  store.recordTaskDeliveryReviewExecutionFailure({
    taskRunId: executionTask.id, submissionId: executionSubmission.id, eventId: 'execution-failure-1', error: 'network timeout',
  });
  const executionReview = store.getTaskDeliveryReview(executionTask.id);
  assert.equal(executionReview.executionAttemptCount, 1, 'duplicate model execution failures must not increment twice');
  assert.equal(executionReview.qualityRevisionCount, 0, 'model execution failures must not consume quality revisions');

  const workspaceFile = path.join(root, 'review-snapshot-source.md');
  fs.writeFileSync(workspaceFile, 'immutable version one');
  const firstSnapshot = snapshotTaskDeliveryArtifacts({
    root, taskRunId: flowTask.id, submissionNo: 1,
    files: [{ path: workspaceFile, name: 'review.md', relative_path: 'review.md', structurallyValid: true }],
  });
  fs.writeFileSync(workspaceFile, 'workspace version two');
  const secondSnapshot = snapshotTaskDeliveryArtifacts({
    root, taskRunId: flowTask.id, submissionNo: 2,
    files: [{ path: workspaceFile, name: 'review.md', relative_path: 'review.md', structurallyValid: true }],
  });
  assert.equal(fs.readFileSync(firstSnapshot[0].snapshotPath, 'utf8'), 'immutable version one');
  assert.equal(fs.readFileSync(secondSnapshot[0].snapshotPath, 'utf8'), 'workspace version two');

  const restartJob = store.enqueueTaskDeliveryReviewJob({
    taskRunId: executionTask.id, submissionId: executionSubmission.id, payload: { submissionNo: 1 }, maxAttempts: 3,
  });
  const firstClaim = store.claimPendingTaskDeliveryReviewJobs({ workerId: 'worker-before-restart', limit: 20, now: Date.now() });
  assert.equal(firstClaim.some((job) => job.id === restartJob.id), true);
  db.prepare("UPDATE task_delivery_review_jobs SET lease_expires_at='2026-08-04T00:00:00.000Z' WHERE id=?").run(restartJob.id);
  db.close();

  db = openDatabase(root, { appVersion: '0.2.25' });
  store = new Store(db, { root });
  const reclaimed = store.claimPendingTaskDeliveryReviewJobs({ workerId: 'worker-after-restart', limit: 20, now: Date.now() });
  const reclaimedRestartJob = reclaimed.find((job) => job.id === restartJob.id);
  assert.ok(reclaimedRestartJob, 'an expired claimed review job must be reclaimed after restart');
  assert.equal(reclaimedRestartJob.attemptCount, 2);
  db.close();

  console.log('uBuddy bounded delivery rework smoke passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function coreCounts(db) {
  return Object.fromEntries([
    'sessions', 'messages', 'memory_documents', 'memory_document_versions', 'message_attachments',
    'task_runs', 'task_nodes', 'task_events', 'model_executions',
  ].map((table) => [table, Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)]));
}
