import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createEvolutionAuthority } from '../src/cloud/modules/evolution/index.js';
import { openCloudDatabase } from '../src/cloud/server.js';
import { createRuntime } from '../src/main/runtime.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-evolution-harness-'));
const runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });
const cloudDb = openCloudDatabase(path.join(root, 'cloud-authority'));

try {
  const status = runtime.personalEvolutionStatus();
  assert.equal(status.authority, 'cloud');
  assert.equal(status.authorityLocked, true);
  assert.equal(status.enabled, true);
  assert.equal(status.code, 'cloud_not_configured');

  let localInstance = runtime.store.resolveUserAgent({ userId: 'local_admin', agentFamilyId: 'general_agent' })?.instance;
  if (!localInstance) {
    localInstance = runtime.store.recruitUserAgent({
      userId: 'local_admin', agentFamilyId: 'general_agent', commandId: 'evolution-harness-local-instance',
    }).instance;
  }
  runtime.store.updateUserAgentConsents({
    agentInstanceId: localInstance.id, syncEnabled: true, personalEvolutionConsent: true,
  });
  const unavailable = await runtime.runPersonalEvolution({ agentInstanceId: localInstance.id, trigger: 'manual' });
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.code, 'cloud_not_configured');

  const legacyVersion = runtime.store.createPersonalSkillVersion({
    agentInstanceId: localInstance.id,
    overlayText: 'Legacy local history must remain read-only after the cloud authority cutover.',
  });
  runtime.store.activatePersonalSkillVersion({ agentInstanceId: localInstance.id, skillVersionId: legacyVersion.id });
  await assert.rejects(
    () => runtime.rollbackPersonalSkill({ agentInstanceId: localInstance.id, targetSkillVersionId: '' }),
    (error) => error.code === 'cloud_authority_required',
  );
  await assert.rejects(
    () => runtime.rollbackPersonalMemory({ memoryDocumentId: 'legacy-memory', targetVersionId: '' }),
    /无权回滚该 Memory|Cloud/,
  );
  const maintenance = await runtime.runMaintenanceSafely({ system: true, respectActiveRuns: false });
  assert.equal(maintenance.authority, 'cloud');
  assert.deepEqual(maintenance.agentResults, []);
  assert.deepEqual(maintenance.hrResults, []);

  const now = new Date().toISOString();
  cloudDb.prepare("INSERT INTO cloud_agent_families_v3(id,department_id,name,payload_json,updated_at) VALUES('family','general','Agent','{}',?)").run(now);
  cloudDb.prepare("INSERT INTO cloud_agent_versions_v3(id,agent_family_id,payload_json,created_at) VALUES('base','family',?,?)").run(
    JSON.stringify({ baseSkillContent: 'Follow instructions carefully and verify results.' }), now,
  );
  cloudDb.prepare(`INSERT INTO cloud_user_agent_instances_v3 (
    user_id,id,agent_family_id,base_agent_version_id,status,sync_enabled,personal_evolution_consent,
    cluster_contribution_consent,personal_skill_auto_activate,payload_json,created_at,updated_at
  ) VALUES ('user','instance','family','base','active',1,1,0,0,'{}',?,?)`).run(now, now);
  const keyring = { activeKeyId: 'harness', keys: { harness: crypto.randomBytes(32).toString('base64') } };
  const authority = createEvolutionAuthority({ db: cloudDb, keyring, modelExecutor: approvedModel });
  const token = authority.issueGrant({ userId: 'user', deviceId: 'device' }).token;
  const grant = authority.requireGrant(token, 'evolution:write');
  for (const index of [1, 3]) {
    cloudDb.prepare('INSERT INTO cloud_task_runs(id,payload_json,updated_at) VALUES(?,?,?)').run(
      `task_${index}`, JSON.stringify({ ownerUserId: 'user' }), now,
    );
    cloudDb.prepare('INSERT INTO cloud_task_nodes(id,task_run_id,payload_json,updated_at) VALUES(?,?,?,?)').run(
      `evidence_${index}`, `task_${index}`, JSON.stringify({ agentInstanceId: 'instance' }), now,
    );
  }
  const evidence = authority.ingestEvidence(grant, Array.from({ length: 5 }, (_, index) => ({
    userAgentInstanceId: 'instance',
    sourceKind: index % 2 ? 'task_result' : 'message',
    sourceId: `evidence_${index}`,
    content: `Repeated failed task ${index}: verify the result before delivery.`,
    allowedEvolutionScopes: ['personal'],
    occurredAt: new Date(Date.now() + index).toISOString(),
  })));
  assert.equal(evidence.accepted.length, 5);
  const queued = authority.requestPersonalRun(grant, { agentInstanceId: 'instance', triggerKind: 'manual' });
  assert.equal(queued.status, 'queued');
  const tick = await authority.tickWorker({ limit: 1 });
  assert.equal(tick.completed[0].status, 'available');
  assert.equal(tick.completed[0].autoActivated, false);
  let run = authority.getRun(grant, queued.run.id);
  assert.equal(run.status, 'available');
  assert.equal(run.candidateVersion.status, 'candidate');
  assert.equal(run.proposal.status, 'ready');
  assert.equal(run.actions.some((item) => item.targetKind === 'skill'), false);
  const activated = authority.activatePersonalVersion(grant, {
    agentInstanceId: 'instance',
    targetVersionId: run.candidateVersion.id,
    commandId: 'evolution_harness_manual_activate',
    expectedActiveVersionId: '',
  });
  assert.equal(activated.status, 'activated');
  run = authority.getRun(grant, queued.run.id);
  assert.equal(run.status, 'applied');
  assert.equal(run.candidateVersion.status, 'active');
  assert.equal(run.proposal.status, 'applied');
  assert.equal(run.actions.find((item) => item.targetKind === 'skill')?.automatic, false);
  assert.equal(authority.evidenceCounts(grant, { agentInstanceId: 'instance' }).counts.consumed, 5);
  assert.ok(Date.parse(authority.personalSchedule(grant, { agentInstanceId: 'instance' }).nextEligibleAt) > Date.now());

  console.log('Evolution harness smoke passed.');
} finally {
  runtime.close();
  cloudDb.close();
  fs.rmSync(root, { recursive: true, force: true });
}

async function approvedModel({ kind }) {
  if (kind === 'personal_proposal') return JSON.stringify({
    summary: 'Improve runtime reliability.',
    overlay_text: 'Add runtime guardrails, explicit failure handling, and verification before delivery.',
    memory_operations: [],
    eval_cases: [{ input: 'Complete a repeated task.', expected: 'Verify the result before delivery.' }],
    risks: ['Avoid overfitting to a single task.'],
  });
  if (kind === 'personal_review') return JSON.stringify({ decision: 'full', rationale: 'Narrow and evidence-backed.', risks: [] });
  if (kind === 'personal_replay_judge') return JSON.stringify({ winner: 'tie', before_score: 1, after_score: 1, rationale: 'No regression.' });
  return 'Verify the result before delivery.';
}
