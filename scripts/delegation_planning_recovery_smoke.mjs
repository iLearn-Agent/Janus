import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  delegationExecutionLeaseRenewalDefinitelyLost,
  delegationExecutionLeaseRetryDelayMs,
  externalDelegationPlanningAttemptTimeoutMs,
  externalDelegationPlanningFailureIsTransient,
  externalDelegationPlanningRecoveryExhausted,
} from '../src/main/modules/collaboration/application/createDelegationRuntimeApi.js';
import { delegationExecutionFailureDetails } from '../src/main/modules/collaboration/application/secretaryDelegationRules.js';

assert.equal(externalDelegationPlanningRecoveryExhausted({ executionEpoch: 1, maxPlanningEpochs: 3 }), false);
assert.equal(externalDelegationPlanningRecoveryExhausted({ executionEpoch: 3, maxPlanningEpochs: 3 }), false);
assert.equal(externalDelegationPlanningRecoveryExhausted({ executionEpoch: 4, maxPlanningEpochs: 3 }), true);
assert.equal(externalDelegationPlanningRecoveryExhausted({ executionEpoch: 11, maxPlanningEpochs: 3 }), true);
assert.equal(externalDelegationPlanningRecoveryExhausted({ executionEpoch: 11, taskRunId: 'task-created', maxPlanningEpochs: 3 }), false);

const planningStartedAt = 1_000_000;
const firstAttemptMs = externalDelegationPlanningAttemptTimeoutMs({ attempt: 1, startedAt: planningStartedAt, now: planningStartedAt });
const secondStartedAt = planningStartedAt + firstAttemptMs + 5_000;
const secondAttemptMs = externalDelegationPlanningAttemptTimeoutMs({
  attempt: 2, startedAt: planningStartedAt, now: secondStartedAt,
});
const thirdStartedAt = secondStartedAt + secondAttemptMs + 15_000;
const thirdAttemptMs = externalDelegationPlanningAttemptTimeoutMs({
  attempt: 3, startedAt: planningStartedAt, now: thirdStartedAt,
});
assert.ok(firstAttemptMs >= 50_000 && firstAttemptMs <= 55_000);
assert.ok(secondAttemptMs >= 50_000 && secondAttemptMs <= 55_000);
assert.ok(thirdAttemptMs >= 50_000 && thirdAttemptMs <= 55_000);
assert.ok(firstAttemptMs + 5_000 + secondAttemptMs + 15_000 + thirdAttemptMs <= 180_000,
  'three planning attempts and both backoffs must remain inside the 180 second budget');
assert.equal(externalDelegationPlanningFailureIsTransient(new Error('Codex model request timed out after 90s.')), true);
assert.equal(externalDelegationPlanningFailureIsTransient(new Error('unexpected status 502 Bad Gateway')), true);
assert.equal(externalDelegationPlanningFailureIsTransient(new Error('Codex CLI was not found.')), false);

assert.equal(delegationExecutionLeaseRenewalDefinitelyLost({ status: 409, code: 'delegation_execution_lease_lost' }), true);
assert.equal(delegationExecutionLeaseRenewalDefinitelyLost({ status: 502, code: 'bad_gateway' }), false);
assert.equal(delegationExecutionLeaseRetryDelayMs({ leaseExpiresAt: new Date(planningStartedAt + 90_000).toISOString() }, planningStartedAt), 10_000);
assert.equal(delegationExecutionLeaseRetryDelayMs({ leaseExpiresAt: new Date(planningStartedAt - 1).toISOString() }, planningStartedAt), 0);

const exhaustedError = new Error('Planning recovery attempts exhausted.');
exhaustedError.code = 'ubuddy_planning_recovery_exhausted';
const failure = delegationExecutionFailureDetails(exhaustedError);
assert.equal(failure.code, 'ubuddy_planning_recovery_exhausted');
assert.equal(failure.retryable, false);
assert.equal(failure.stage, 'planning');
assert.match(failure.publicMessage, /停止自动重试/);

const source = readFileSync(new URL('../src/main/modules/collaboration/application/createDelegationRuntimeApi.js', import.meta.url), 'utf8');
const claimedExecution = source.indexOf('const executionEpoch = Math.max(0, Number(executionClaim.lease?.executionEpoch || 0));');
const leaseArmed = source.indexOf('armDelegationExecutionLease(delegationId', claimedExecution);
const plannerStarted = source.indexOf('const unified = await this.startExternalUBuddyTask', claimedExecution);
assert.ok(claimedExecution >= 0 && leaseArmed > claimedExecution && plannerStarted > leaseArmed,
  'the execution lease must be renewed before external task planning begins');
assert.match(source.slice(plannerStarted, plannerStarted + 700), /signal: executionAbortController\.signal/);
assert.match(source.slice(claimedExecution, plannerStarted), /payload\[internalAutoStart\][\s\S]*externalDelegationPlanningRecoveryExhausted/,
  'the recovery ceiling must stop automatic retries without preventing an explicit manual retry');
assert.match(source, /for \(let attempt = 1; attempt <= planningMaxAttempts; attempt \+= 1\)/,
  'external delegation planning must use bounded in-context attempts');
assert.match(source, /failure\.code === 'model_unavailable'[\s\S]*externalDelegationPlanningFailureIsTransient\(error\)/,
  'only transient model availability failures may automatically retry external planning');
assert.match(source, /delegationExecutionLeaseRetryTimers/,
  'transient execution lease renewal failures must retain a bounded retry timer');

console.log('delegation planning recovery smoke passed');
