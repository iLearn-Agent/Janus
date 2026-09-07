import { strict as assert } from 'node:assert';
import { chmodSync, rmSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-task-recovery-'));
const binRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-task-recovery-bin-'));
const fakeCodex = path.join(binRoot, 'fake-codex.mjs');
const shutdownMarker = path.join(binRoot, 'shutdown-resume.marker');
const previousBin = process.env.JANUS_CODEX_BIN;
const previousRetryBase = process.env.JANUS_TASK_RETRY_BASE_MS;
const previousBoundedDeliveryRework = process.env.JANUS_BOUNDED_DELIVERY_REWORK_V1;

await writeFile(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fake-codex'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) { console.log('Usage: codex app-server [OPTIONS]'); process.exit(0); }
if (args[0] === 'doctor') { console.log(JSON.stringify({ overallStatus: 'pass' })); process.exit(0); }
if (args[0] === 'app-server') {
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'task-recovery-smoke' } });
    else if (message.method === 'thread/start' || message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: 'task-recovery-app-thread' } } });
    else if (message.method === 'thread/memoryMode/set') send({ id: message.id, result: {} });
    else if (message.method === 'thread/goal/get') send({ id: message.id, result: { goal: null } });
    else if (message.method === 'turn/start') {
      const response = 'Recovery fixture completed.';
      send({ id: message.id, result: { turn: { id: 'task-recovery-app-turn' } } });
      send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: response } } });
      send({ method: 'turn/completed', params: { turn: { id: 'task-recovery-app-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: response }] } } });
    } else send({ id: message.id, result: {} });
  }
  process.exit(0);
}
let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;
if (stdin.includes('runtime shutdown resume fixture') && !fs.existsSync(${JSON.stringify(shutdownMarker)})) {
  fs.writeFileSync(${JSON.stringify(shutdownMarker)}, 'interrupted', 'utf8');
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (stdin.includes('automatic retry recovery fixture') && stdin.includes('execution attempt: 1/3')) {
  console.error('ECONNRESET temporary network failure');
  process.exit(1);
}
if (stdin.includes('network retry exhaustion fixture')) {
  console.error('ECONNRESET network connection closed');
  process.exit(1);
}
if (stdin.includes('model capacity retry fixture') && stdin.includes('execution attempt: 1/3')) {
  console.error('Selected model is at capacity. Please try a different model.');
  process.exit(1);
}
if (stdin.includes('model capacity no alternate fixture')) {
  console.error('Selected model is at capacity. Please try a different model.');
  process.exit(1);
}
if (stdin.includes('- title: fallback primary failure fixture') && !stdin.includes('Execute the declared fallback plan')) {
  console.error('deterministic primary execution failure');
  process.exit(1);
}
if (stdin.includes('- title: optional non-blocking failure fixture')) {
  console.error('deterministic optional execution failure');
  process.exit(1);
}
if (stdin.includes('- title: 公开发布外部结果')) {
  console.error('ECONNRESET temporary network failure');
  process.exit(1);
}
const response = stdin.includes('Execute the declared fallback plan')
  ? 'Fallback delivery completed.'
  : 'Recovery fixture completed.';
const outputIndex = args.indexOf('--output-last-message');
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : '';
if (outputPath) fs.writeFileSync(outputPath, response, 'utf8');
if (args.includes('--json')) {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'task-recovery-smoke' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: response } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
}
`);
chmodSync(fakeCodex, 0o755);
process.env.JANUS_CODEX_BIN = fakeCodex;
process.env.JANUS_TASK_RETRY_BASE_MS = '1';
process.env.JANUS_BOUNDED_DELIVERY_REWORK_V1 = '0';

let runtime;
try {
  runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });
  const user = runtime.currentUser();
  const general = runtime.store.activeEmployeeAgentsForUser({ userId: user.id })
    .find((item) => item.agentFamilyId === 'general_agent');
  assert.ok(general?.id);
  const alternateGeneral = runtime.store.recruitUserAgent({
    userId: user.id,
    agentFamilyId: 'general_agent',
    commandId: 'task-recovery-smoke:alternate-general',
    recruitmentSource: 'test',
  }).instance;
  assert.ok(alternateGeneral?.id);
  const ppt = runtime.store.activeEmployeeAgentsForUser({ userId: user.id })
    .find((item) => item.agentFamilyId === 'ppt');
  const candidates = [{
    agentId: 'general_agent', agentInstanceId: general.id, departmentId: 'general', leadershipLevel: 'L0',
  }, {
    agentId: 'general_agent', agentInstanceId: alternateGeneral.id, departmentId: 'general', leadershipLevel: 'L0',
  }, ...(ppt ? [{
    agentId: 'ppt', agentInstanceId: ppt.id, departmentId: 'ppt', leadershipLevel: 'L0',
  }] : [])];

  const retryTask = createGraph(runtime, user.id, candidates, 'automatic retry recovery fixture', [
    node('work', 'automatic retry recovery fixture', [], false),
    node('final', 'finalize automatic retry fixture', ['work'], true),
  ]);
  await runtime.scheduler.runReadyNodes(retryTask.id, { maxParallel: 1 });
  let retryState = runtime.store.getTaskRun(retryTask.id);
  assert.equal(retryState.status, 'waiting');
  assert.equal(retryState.nodes.find((item) => item.title === 'automatic retry recovery fixture').status, 'retry_wait');
  await runtime.scheduler.recoverActiveTasks({ now: Date.now() + 1_000 });
  retryState = runtime.store.getTaskRun(retryTask.id);
  assert.equal(retryState.status, 'completed', JSON.stringify(retryState));
  const recoveredNode = retryState.nodes.find((item) => item.title === 'automatic retry recovery fixture');
  assert.equal(recoveredNode.attemptCount, 2);
  assert.ok(recoveredNode.recoveryActions.some((item) => /Automatic retry/.test(item)));

  const capacityTask = createGraph(runtime, user.id, candidates, 'model capacity retry fixture', [
    node('final', 'model capacity retry fixture', [], true),
  ]);
  await runtime.scheduler.runReadyNodes(capacityTask.id, { maxParallel: 1 });
  let capacityState = runtime.store.getTaskRun(capacityTask.id);
  assert.equal(capacityState.status, 'waiting');
  assert.equal(capacityState.nodes[0].status, 'retry_wait');
  assert.equal(capacityState.nodes[0].lastErrorCode, 'service_unavailable');
  await runtime.scheduler.recoverActiveTasks({ now: Date.now() + 1_000 });
  capacityState = runtime.store.getTaskRun(capacityTask.id);
  assert.equal(capacityState.status, 'completed', JSON.stringify(capacityState));
  assert.equal(capacityState.nodes[0].attemptCount, 2);

  const capacityNoAlternateTask = createGraph(runtime, user.id, candidates, 'model capacity no alternate fixture', [
    { ...node('final', 'model capacity no alternate fixture', [], true), fallback: 'Use another available Agent.', maxAttempts: 1 },
  ]);
  await runtime.scheduler.runReadyNodes(capacityNoAlternateTask.id, { maxParallel: 1 });
  const capacityNoAlternateState = runtime.store.getTaskRun(capacityNoAlternateTask.id);
  assert.equal(capacityNoAlternateState.status, 'failed');
  assert.equal(capacityNoAlternateState.nodes.length, 1, 'infrastructure failure must not create an alternate-Agent fallback node');
  assert.equal(capacityNoAlternateState.nodes[0].lastErrorCode, 'service_unavailable');

  const secretarySession = runtime.store.createSession({
    title: 'uBuddy failure wake fixture', departmentId: 'secretary_department', agentId: 'secretary_agent',
    userId: user.id, accountWorkspaceId: 'workspace_personal', reusePrimary: false,
  });
  const networkFailureTask = createGraph(runtime, user.id, candidates, 'network retry exhaustion fixture', [
    { ...node('final', 'network retry exhaustion fixture', [], true), maxAttempts: 2 },
  ], {
    source: 'ubuddy_dispatch',
    sourceSecretarySessionId: secretarySession.id,
    enforceDeliverableContract: false,
    featureFlagSnapshot: {
      boundedDeliveryReworkV1: false,
      boundedDeliveryRework: false,
    },
  });
  await runtime.scheduler.runReadyNodes(networkFailureTask.id, { maxParallel: 1 });
  assert.equal(runtime.store.getTaskRun(networkFailureTask.id).status, 'waiting');
  await runtime.scheduler.recoverActiveTasks({ now: Date.now() + 1_000 });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const networkFailureState = runtime.store.getTaskRun(networkFailureTask.id);
  assert.equal(networkFailureState.status, 'failed');
  assert.equal(networkFailureState.metadata.failureReport.errorCode, 'network_transient');
  assert.equal(networkFailureState.metadata.failureReport.retriesExhausted, true);
  assert.match(networkFailureState.metadata.failureReport.suggestedNextStep, /网络连接|代理|防火墙/);
  const networkCoordination = runtime.store.getUBuddyCoordinationState(networkFailureTask.id);
  const networkWake = runtime.store.getUBuddyWakeForGeneration({
    taskRunId: networkFailureTask.id, generation: networkCoordination.generation,
  });
  assert.equal(networkWake.reasonCode, 'recovery_exhausted');
  assert.equal(networkWake.payload.failureReport.failureNode, 'network retry exhaustion fixture');
  assert.equal(networkWake.payload.failureReport.failureAgentId, 'general_agent');
  assert.equal(networkWake.payload.failureReport.attemptCount, 2);
  assert.equal(networkWake.status, 'delivered');
  const failureDelivery = runtime.store.listMessages(secretarySession.id)
    .find((message) => message.metadata?.uBuddyTaskTerminalTaskRunId === networkFailureTask.id);
  assert.match(failureDelivery?.content || '', /失败报告/);
  assert.match(failureDelivery?.content || '', /网络连接失败/);
  const recoveredNetworkTask = await runtime.scheduler.retryFailedNode(
    networkFailureTask.id,
    networkFailureState.nodes[0].id,
    { dryRun: true },
  );
  assert.equal(recoveredNetworkTask.status, 'completed');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const resumedCoordination = runtime.store.getUBuddyCoordinationState(networkFailureTask.id);
  assert.equal(resumedCoordination.generation, networkCoordination.generation + 1);
  const completionWake = runtime.store.getUBuddyWakeForGeneration({
    taskRunId: networkFailureTask.id, generation: resumedCoordination.generation,
  });
  assert.equal(completionWake.reasonCode, 'completion');
  assert.equal(completionWake.status, 'delivered');
  const terminalDeliveries = runtime.store.listMessages(secretarySession.id)
    .filter((message) => message.metadata?.uBuddyTaskTerminalTaskRunId === networkFailureTask.id);
  assert.equal(terminalDeliveries.length, 2);
  assert.deepEqual(terminalDeliveries.map((message) => message.metadata?.uBuddyCoordinationGeneration), [1, 2]);

  const terminalTask = createGraph(runtime, user.id, candidates, 'terminal retry fixture', [
    node('work', 'terminal retry work', [], false),
    node('final', 'terminal retry final', ['work'], true),
  ]);
  const failedNode = terminalTask.nodes.find((item) => item.title === 'terminal retry work');
  runtime.store.updateTaskNode(failedNode.id, {
    status: 'failed', errorText: 'simulated terminal failure', lastErrorCode: 'execution_failed', completedAt: new Date().toISOString(),
  });
  runtime.scheduler.propagateDependencyFailures(terminalTask.id);
  runtime.scheduler.reconcileTaskStatus(terminalTask.id);
  assert.equal(runtime.store.getTaskRun(terminalTask.id).status, 'failed');
  assert.ok(runtime.store.getTaskRun(terminalTask.id).retrospective);
  const terminalRecovered = await runtime.scheduler.retryFailedNode(terminalTask.id, failedNode.id, { dryRun: true });
  assert.equal(terminalRecovered.status, 'completed', JSON.stringify(terminalRecovered));
  assert.ok(terminalRecovered.nodes.every((item) => item.status === 'completed'));
  assert.match(terminalRecovered.retrospective?.finalSummary || '', /status completed/);

  const fallbackTask = createGraph(runtime, user.id, candidates, 'fallback fixture', [
    { ...node('work', 'fallback primary failure fixture', [], false), agentInstanceId: general.id,
      fallback: 'Return a conservative fallback delivery.', maxAttempts: 1 },
    node('final', 'fallback final synthesis', ['work'], true),
  ]);
  const fallbackPrimary = fallbackTask.nodes.find((item) => item.title === 'fallback primary failure fixture');
  runtime.scheduler.handleNodeExecutionFailure(fallbackTask, fallbackPrimary, {
    errorSummary: 'employee_not_active: original Generalist instance is unavailable',
    failure: { code: 'agent_unavailable', retryable: false, userActionRequired: false },
  });
  await runtime.scheduler.continueTaskRun(fallbackTask.id, { dryRun: true });
  const fallbackState = runtime.store.getTaskRun(fallbackTask.id);
  assert.equal(fallbackState.status, 'completed', JSON.stringify(fallbackState));
  const fallbackReplacement = fallbackState.nodes.find((item) => item.title === 'Fallback: fallback primary failure fixture');
  assert.equal(fallbackReplacement?.status, 'completed');
  assert.equal(fallbackReplacement?.agentId, 'general_agent');
  assert.equal(fallbackReplacement?.agentInstanceId, alternateGeneral.id,
    'Agent unavailability may only select another active instance from the same Agent family');
  assert.ok(fallbackState.revisions.some((item) => item.revisionType === 'add_fallback_node'));

  const validationFailureTask = createGraph(runtime, user.id, candidates, 'output validation fixture', [
    { ...node('final', 'output validation fixture', [], true), agentInstanceId: general.id,
      fallback: 'Ask another Agent to produce the missing Markdown.', maxAttempts: 1 },
  ]);
  runtime.scheduler.handleNodeExecutionFailure(validationFailureTask, validationFailureTask.nodes[0], {
    errorSummary: 'deliverable missing: Markdown artifact was not registered',
    failure: { code: 'output_validation_failed', retryable: true, userActionRequired: false },
  });
  const validationFailureState = runtime.store.getTaskRun(validationFailureTask.id);
  assert.equal(validationFailureState.status, 'failed');
  assert.equal(validationFailureState.nodes.length, 1,
    'Output validation failures must stay on the original node instead of creating a cross-specialty fallback');
  assert.equal(validationFailureState.nodes[0].agentInstanceId, general.id);

  const timeoutTask = createGraph(runtime, user.id, candidates, 'timeout watchdog fixture', [
    { ...node('work', 'timeout watchdog work', [], false), fallback: 'Complete the timed-out work conservatively.' },
    node('final', 'timeout watchdog final', ['work'], true),
  ]);
  const timeoutNode = timeoutTask.nodes.find((item) => item.title === 'timeout watchdog work');
  runtime.store.updateTaskNode(timeoutNode.id, {
    status: 'running', attemptCount: 1, startedAt: new Date(Date.now() - 60_000).toISOString(),
  });
  runtime.scheduler.reconcileTaskStatus(timeoutTask.id);
  await runtime.scheduler.recoverActiveTasks({ now: Date.now() + 1_000, maxRunningMs: 1 });
  const timeoutState = runtime.store.getTaskRun(timeoutTask.id);
  assert.equal(timeoutState.status, 'completed', JSON.stringify(timeoutState));
  assert.ok(timeoutState.events.some((item) => item.eventType === 'node_timeout'));
  assert.equal(timeoutState.nodes.some((item) => item.title === 'Fallback: timeout watchdog work'), false);
  assert.equal(timeoutState.nodes.find((item) => item.title === 'timeout watchdog work')?.attemptCount, 2);

  const optionalTask = createGraph(runtime, user.id, candidates, 'non-blocking fixture', [
    { ...node('optional', 'optional non-blocking failure fixture', [], false), blocking: false },
    node('final', 'non-blocking final delivery', [], true),
  ]);
  await runtime.scheduler.runReadyNodes(optionalTask.id, { maxParallel: 2 });
  const optionalState = runtime.store.getTaskRun(optionalTask.id);
  assert.equal(optionalState.status, 'completed', JSON.stringify(optionalState));
  assert.equal(optionalState.nodes.find((item) => item.title === 'optional non-blocking failure fixture').status, 'cancelled');
  assert.equal(optionalState.nodes.find((item) => item.title === 'non-blocking final delivery').status, 'completed');

  const sideEffectTask = createGraph(runtime, user.id, candidates, 'side-effect retry safety fixture', [
    node('final', '公开发布外部结果', [], true),
  ]);
  await runtime.scheduler.runReadyNodes(sideEffectTask.id, { maxParallel: 1 });
  const sideEffectState = runtime.store.getTaskRun(sideEffectTask.id);
  assert.equal(sideEffectState.status, 'failed');
  assert.equal(sideEffectState.nodes[0].attemptCount, 1);
  assert.equal(sideEffectState.nodes[0].nextRetryAt, '');
  assert.match(sideEffectState.nodes[0].waitReason, /人工确认/);

  const cancelledReworkTask = runtime.store.createTaskRun({
    id: 'cancelled-delivery-rework-recovery',
    ownerUserId: user.id,
    title: 'Cancelled delivery rework recovery',
    prompt: 'Create a complete Markdown delivery.',
    leadAgentId: 'general_agent',
    leadAgentInstanceId: general.id,
    metadata: {
      source: 'ubuddy_dispatch',
      featureFlagSnapshot: { boundedDeliveryReworkV1: true },
      deliveryReviewPolicyVersion: 'delivery_review_policy_v2',
      deliveryAuthority: 'scheduler',
      deliveryMode: 'available_before_quality_review',
    },
  });
  const completedDeliveryNode = runtime.store.createTaskNode({
    taskRunId: cancelledReworkTask.id,
    title: 'Completed delivery source',
    objective: 'Produce the original delivery.',
    agentId: 'general_agent',
    agentInstanceId: general.id,
    status: 'pending',
    blocking: true,
  });
  runtime.store.updateTaskNode(completedDeliveryNode.id, {
    status: 'completed',
    resultText: 'Usable completed delivery body.',
    completedAt: new Date().toISOString(),
  });
  const sourceSubmission = runtime.store.recordTaskDeliverySubmission({
    taskRunId: cancelledReworkTask.id,
    taskNodeId: completedDeliveryNode.id,
    submissionKey: 'cancelled-rework-source-submission',
    bodySnapshot: 'Usable completed delivery body.',
    artifactManifest: [],
    revisionLimit: 2,
  });
  runtime.store.ensureTaskDeliveryReview({ taskRunId: cancelledReworkTask.id });
  runtime.store.transitionTaskDeliveryReview({
    taskRunId: cancelledReworkTask.id, submissionId: sourceSubmission.id,
    eventId: 'cancelled-rework-submitted', eventType: 'submitted', payload: {},
  });
  runtime.store.transitionTaskDeliveryReview({
    taskRunId: cancelledReworkTask.id, submissionId: sourceSubmission.id,
    eventId: 'cancelled-rework-verifying', eventType: 'verification_started', payload: {},
  });
  const rejectedReview = runtime.store.transitionTaskDeliveryReview({
    taskRunId: cancelledReworkTask.id, submissionId: sourceSubmission.id,
    eventId: 'cancelled-rework-rejected', eventType: 'validation_failed', payload: {
      correctable: true,
      failureCodes: ['missing_required_file'],
      failedChecks: [{ code: 'missing_required_file', summary: 'Required file is missing.' }],
      requiredChanges: ['Create the required file.'],
      preservedRequirements: ['Keep the completed body.'],
      summary: 'A bounded revision is required.',
    },
  }).review;
  runtime.store.transitionTaskDeliveryReview({
    taskRunId: cancelledReworkTask.id, submissionId: sourceSubmission.id,
    eventId: 'cancelled-rework-started', eventType: 'rework_started', payload: {},
  });
  const cancelledRevisionNode = runtime.store.createTaskNode({
    taskRunId: cancelledReworkTask.id,
    title: '交付修改 1/2',
    objective: 'Revise the completed delivery.',
    agentId: 'general_agent',
    agentInstanceId: general.id,
    status: 'pending',
    dependencies: [completedDeliveryNode.id],
    parallelGroup: 'delivery_rework',
    blocking: true,
  });
  runtime.store.updateTaskNode(cancelledRevisionNode.id, {
    status: 'cancelled', errorText: 'Interrupted before delivery.', completedAt: new Date().toISOString(),
  });
  const stalledRevisionNode = runtime.store.createTaskNode({
    taskRunId: cancelledReworkTask.id,
    title: '交付修改 1/2',
    objective: 'Continue the delivery revision without waiting forever.',
    agentId: 'general_agent',
    agentInstanceId: general.id,
    status: 'pending',
    dependencies: [cancelledRevisionNode.id],
    parallelGroup: 'delivery_rework',
    blocking: true,
  });
  runtime.store.updateTaskRunMetadata(cancelledReworkTask.id, {
    finalTaskNodeId: stalledRevisionNode.id,
    deliveryReviewState: 'reworking',
  });
  runtime.store.updateTaskRunStatus(cancelledReworkTask.id, 'waiting', 'Waiting on a cancelled revision dependency.');
  runtime.scheduler.prepareTaskRecovery(cancelledReworkTask.id);
  const repairedReworkState = runtime.store.getTaskRun(cancelledReworkTask.id);
  const activeReplacement = repairedReworkState.nodes.find((item) => (
    item.parallelGroup === 'delivery_rework' && ['pending', 'ready'].includes(item.status)
  ));
  assert.ok(activeReplacement, JSON.stringify(repairedReworkState));
  assert.equal(activeReplacement.id, stalledRevisionNode.id,
    'the existing stalled revision should be repaired instead of duplicated');
  assert.deepEqual(activeReplacement.dependencies, [completedDeliveryNode.id]);
  assert.equal(repairedReworkState.deliveryReview.qualityRevisionCount, rejectedReview.qualityRevisionCount,
    'replacing a cancelled revision must not consume another quality revision');
  assert.ok(repairedReworkState.events.some((item) => item.eventType === 'delivery_rework_dependency_recovered'));
  const reworkNodeCount = repairedReworkState.nodes.length;
  runtime.scheduler.createTaskDeliveryReworkNode({
    task: repairedReworkState,
    submission: sourceSubmission,
    review: repairedReworkState.deliveryReview,
    decision: {
      verdict: 'revision_requested',
      failureCodes: ['missing_required_file'],
      failedChecks: [{ code: 'missing_required_file', summary: 'Required file is missing.' }],
      requiredChanges: ['Create the required file.'],
      preservedRequirements: ['Keep the completed body.'],
      summary: 'A bounded revision is required.',
    },
  });
  assert.equal(runtime.store.getTaskRun(cancelledReworkTask.id).nodes.length, reworkNodeCount,
    'replaying the same delivery revision must reuse the active node');

  const cancelledDependencyTask = runtime.store.createTaskRun({
    id: 'generic-cancelled-dependency', ownerUserId: user.id,
    title: 'Generic cancelled dependency', prompt: 'Do not wait forever.',
  });
  const cancelledDependency = runtime.store.createTaskNode({
    taskRunId: cancelledDependencyTask.id, title: 'Cancelled source', objective: 'Cancelled source.', status: 'pending',
  });
  runtime.store.updateTaskNode(cancelledDependency.id, {
    status: 'cancelled', completedAt: new Date().toISOString(),
  });
  const dependentNode = runtime.store.createTaskNode({
    taskRunId: cancelledDependencyTask.id, title: 'Dependent work', objective: 'Dependent work.',
    status: 'pending', dependencies: [cancelledDependency.id],
  });
  runtime.scheduler.prepareTaskRecovery(cancelledDependencyTask.id);
  const cancelledDependencyState = runtime.store.getTaskRun(cancelledDependencyTask.id);
  assert.equal(cancelledDependencyState.nodes.find((item) => item.id === dependentNode.id).status, 'failed');
  assert.equal(cancelledDependencyState.nodes.find((item) => item.id === dependentNode.id).lastErrorCode, 'dependency_cancelled');
  assert.ok(cancelledDependencyState.events.some((item) => item.eventType === 'task_dependency_cancelled'));

  const unavailableSourceTask = runtime.store.createTaskRun({
    id: 'delivery-rework-source-unavailable', ownerUserId: user.id,
    title: 'Delivery rework source unavailable', prompt: 'Require an explicit recovery outcome.',
    metadata: { source: 'ubuddy_dispatch', featureFlagSnapshot: { boundedDeliveryReworkV1: true } },
  });
  const emptySubmission = runtime.store.recordTaskDeliverySubmission({
    taskRunId: unavailableSourceTask.id,
    submissionKey: 'delivery-rework-empty-source',
    bodySnapshot: '', artifactManifest: [], revisionLimit: 2,
  });
  const unavailableReview = runtime.store.getTaskDeliveryReview(unavailableSourceTask.id);
  runtime.scheduler.markTaskDeliveryReworkSourceUnavailable({
    task: runtime.store.getTaskRun(unavailableSourceTask.id),
    submission: emptySubmission,
    review: unavailableReview,
  });
  const unavailableSourceState = runtime.store.getTaskRun(unavailableSourceTask.id);
  assert.equal(unavailableSourceState.status, 'failed');
  assert.equal(unavailableSourceState.deliveryReview.state, 'action_required');
  assert.equal(unavailableSourceState.metadata.deliveryReviewState, 'action_required');
  assert.equal(unavailableSourceState.metadata.failureReport.errorCode, 'delivery_rework_source_unavailable');

  const shutdownResumeTask = createGraph(runtime, user.id, candidates, 'runtime shutdown resume fixture', [
    node('final', 'runtime shutdown resume fixture', [], true),
  ]);
  const shutdownRun = runtime.scheduler.runReadyNodes(shutdownResumeTask.id, { maxParallel: 1 });
  await waitFor(() => runtime.store.listAgentWorkQueue({ statuses: ['running'], limit: 20 })
    .some((work) => work.workKind === 'task_node' && work.workId === shutdownResumeTask.nodes[0].id));
  await Promise.resolve(runtime.close());
  await Promise.allSettled([shutdownRun]);
  runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });
  await waitFor(() => runtime.store.getTaskRun(shutdownResumeTask.id)?.events
    .some((event) => event.eventType === 'durable_work_resumed'), 10_000);
  const shutdownResumeState = runtime.store.getTaskRun(shutdownResumeTask.id);
  assert.equal(shutdownResumeState.nodes[0].attemptCount, 1,
    'application shutdown must resume the same attempt instead of consuming a retry');
  assert.ok(shutdownResumeState.events.some((event) => event.eventType === 'durable_work_interrupted'));
  assert.ok(shutdownResumeState.events.some((event) => event.eventType === 'durable_work_resumed'));

  console.log(JSON.stringify({ ok: true, checks: ['automatic_retry', 'model_capacity_retry', 'model_capacity_no_agent_switch',
    'terminal_in_place_retry', 'same_family_fallback', 'output_validation_no_agent_switch',
    'timeout_watchdog_same_agent', 'non_blocking_skip', 'side_effect_retry_guard',
    'cancelled_delivery_rework_recovery', 'cancelled_dependency_terminal',
    'delivery_rework_source_unavailable', 'runtime_shutdown_resume'] }));
} finally {
  runtime?.close();
  if (previousBin === undefined) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousBin;
  if (previousRetryBase === undefined) delete process.env.JANUS_TASK_RETRY_BASE_MS;
  else process.env.JANUS_TASK_RETRY_BASE_MS = previousRetryBase;
  if (previousBoundedDeliveryRework === undefined) delete process.env.JANUS_BOUNDED_DELIVERY_REWORK_V1;
  else process.env.JANUS_BOUNDED_DELIVERY_REWORK_V1 = previousBoundedDeliveryRework;
  rmSync(root, { recursive: true, force: true });
  rmSync(binRoot, { recursive: true, force: true });
}

function node(localId, title, dependencies, isFinal) {
  return {
    localId, title, objective: title, agentId: 'general_agent', dependencies,
    outputFormat: 'markdown', isFinal, blocking: true, maxAttempts: 3, retryStrategy: 'automatic',
  };
}

function createGraph(runtime, userId, candidates, title, nodes, metadata = {}) {
  return runtime.scheduler.createTaskRun({
    title,
    prompt: title,
    departmentId: 'general',
    userId,
    metadata: { ...metadata, candidateSnapshots: candidates, taskGraphProposal: { nodes }, executionOptions: { permissionMode: 'task-workspace' } },
  });
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out after ${timeoutMs}ms.`);
}
