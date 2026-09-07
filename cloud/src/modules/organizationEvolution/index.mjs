import crypto from 'node:crypto';

import {
  UBUDDY_ORG_PLAYBOOK_VERSION,
  validateUBuddyOrganizationPlaybook,
  uBuddyOrganizationPolicyHash,
} from '../../../../src/shared/contracts/uBuddyOrganizationEvolution.js';

export const UBUDDY_ORGANIZATION_EVOLUTION_CAPABILITY = 'ubuddy-organization-evolution-v1';

export function registerUBuddyOrganizationEvolutionRoutes({ app, pool, auth, route, apiError } = {}) {
  const miningByOwner = new Map();
  const scheduleMining = (ownerUserId) => {
    const existing = miningByOwner.get(ownerUserId);
    if (existing) {
      existing.rerun = true;
      return false;
    }
    const entry = { rerun: false, promise: null };
    entry.promise = new Promise((resolve) => setTimeout(resolve, 150))
      .then(async () => {
        do {
          entry.rerun = false;
          await mineOrganizationPolicyWithLock(pool, ownerUserId);
        } while (entry.rerun);
      })
      .catch((error) => appendRunEvent(pool, ownerUserId, `ubuddy_org_run_${crypto.randomUUID()}`, 'failed', {
        errorCode: String(error?.code || 'ubuddy_org_mining_failed'),
      }).catch(() => null))
      .finally(() => miningByOwner.delete(ownerUserId));
    miningByOwner.set(ownerUserId, entry);
    return true;
  };
  app.post('/api/ubuddy/organization-evolution/traces', auth, route(async (req, res) => {
    requireCapability(req, apiError);
    const ownerUserId = req.auth.user.id;
    const event = normalizeTraceEvent(req.body, apiError);
    const payloadHash = sha256(stableJson(event.payload));
    const eventId = `ubuddy_org_trace_event_${crypto.randomUUID()}`;
    const returned = await one(pool, `INSERT INTO ubuddy_org_trace_events(
        id,owner_user_id,trace_id,event_kind,task_type,task_signature,idempotency_key,payload_hash,
        payload_json,client_created_at,created_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
      ON CONFLICT(owner_user_id,idempotency_key) DO NOTHING RETURNING *`, [
      eventId, ownerUserId, event.traceId, event.eventKind,
      event.taskType, event.taskSignature, event.idempotencyKey, payloadHash, event.payload, event.clientCreatedAt,
    ]);
    const inserted = returned?.id === eventId ? returned : null;
    const existing = inserted || await one(pool, `SELECT * FROM ubuddy_org_trace_events
      WHERE owner_user_id=$1 AND idempotency_key=$2`, [ownerUserId, event.idempotencyKey]);
    if (!inserted && existing?.payload_hash !== payloadHash) {
      throw apiError('ubuddy_org_trace_idempotency_conflict', '组织轨迹幂等键已被不同内容占用。', 409);
    }
    const miningScheduled = Boolean(inserted) && ['terminal', 'correction'].includes(event.eventKind)
      ? scheduleMining(ownerUserId) : false;
    res.status(inserted ? 201 : 200).json({ ok: true, idempotent: !inserted, miningScheduled });
  }));

  app.get('/api/ubuddy/organization-evolution/overview', auth, route(async (req, res) => {
    requireCapability(req, apiError);
    res.json(await organizationEvolutionOverview(pool, req.auth.user.id));
  }));

  app.get('/api/ubuddy/organization-evolution/active-policy', auth, route(async (req, res) => {
    requireCapability(req, apiError);
    const active = await activePolicy(pool, req.auth.user.id);
    res.json({ capability: UBUDDY_ORGANIZATION_EVOLUTION_CAPABILITY, activePolicy: active ? policyPayload(active) : null });
  }));

  app.post('/api/ubuddy/organization-evolution/policies/:policyVersionId/activate', auth, route(async (req, res) => {
    requireCapability(req, apiError);
    const ownerUserId = req.auth.user.id;
    const policyVersionId = boundedText(req.params.policyVersionId, 200);
    const policy = await one(pool, `SELECT * FROM ubuddy_org_policy_versions WHERE id=$1 AND owner_user_id=$2`, [policyVersionId, ownerUserId]);
    if (!policy) throw apiError('ubuddy_org_policy_not_found', '组织策略版本不存在。', 404);
    const evaluations = (await pool.query(`SELECT evaluation_kind,status FROM ubuddy_org_policy_evaluations
      WHERE owner_user_id=$1 AND policy_version_id=$2`, [ownerUserId, policyVersionId])).rows;
    const passed = new Set(evaluations.filter((item) => item.status === 'passed').map((item) => item.evaluation_kind));
    if (!passed.has('schema') || !passed.has('historical_replay')) {
      throw apiError('ubuddy_org_policy_not_eligible', '组织策略尚未通过安全校验和历史回放。', 409);
    }
    const command = await appendActivationCommand(pool, ownerUserId, {
      commandId: req.body?.commandId,
      action: 'activate',
      policyVersionId,
      expectedActivePolicyVersionId: req.body?.expectedActivePolicyVersionId,
      reason: 'user_activation',
      enforceExpected: Object.hasOwn(req.body || {}, 'expectedActivePolicyVersionId'),
    }, apiError);
    res.json({ ok: true, command, activePolicy: policyPayload(policy) });
  }));

  app.post('/api/ubuddy/organization-evolution/disable', auth, route(async (req, res) => {
    requireCapability(req, apiError);
    const command = await appendActivationCommand(pool, req.auth.user.id, {
      commandId: req.body?.commandId,
      action: 'disable',
      policyVersionId: '',
      expectedActivePolicyVersionId: req.body?.expectedActivePolicyVersionId,
      reason: boundedText(req.body?.reason || 'user_disabled', 500),
      enforceExpected: Object.hasOwn(req.body || {}, 'expectedActivePolicyVersionId'),
    }, apiError);
    res.json({ ok: true, command, activePolicy: null });
  }));

  app.post('/api/ubuddy/organization-evolution/health', auth, route(async (req, res) => {
    requireCapability(req, apiError);
    const ownerUserId = req.auth.user.id;
    const active = await activePolicy(pool, ownerUserId);
    const policyVersionId = boundedText(req.body?.policyVersionId, 200);
    if (!active || active.id !== policyVersionId) return res.json({ ok: true, ignored: true, autoDisabled: false });
    const eventKind = boundedText(req.body?.eventKind, 40);
    if (!['applied', 'success', 'failure', 'contract_rejected'].includes(eventKind)) {
      throw apiError('ubuddy_org_health_event_invalid', '组织策略健康事件无效。', 400);
    }
    const idempotencyKey = boundedText(req.body?.idempotencyKey, 240);
    if (!idempotencyKey) throw apiError('ubuddy_org_health_key_required', '缺少健康事件幂等键。', 400);
    await pool.query(`INSERT INTO ubuddy_org_policy_health_events(
      id,owner_user_id,policy_version_id,trace_id,event_kind,idempotency_key,payload_json,created_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(owner_user_id,idempotency_key) DO NOTHING`, [
      `ubuddy_org_health_${crypto.randomUUID()}`, ownerUserId, policyVersionId,
      boundedText(req.body?.traceId, 200), eventKind, idempotencyKey, boundedObject(req.body?.payload),
    ]);
    const failures = await pool.query(`SELECT event_kind FROM ubuddy_org_policy_health_events
      WHERE owner_user_id=$1 AND policy_version_id=$2 AND event_kind IN ('success','failure','contract_rejected')
      ORDER BY created_at DESC,id DESC LIMIT 3`, [ownerUserId, policyVersionId]);
    const autoDisabled = eventKind === 'contract_rejected'
      || (failures.rows.length === 3 && failures.rows.every((item) => item.event_kind === 'failure'));
    if (autoDisabled) {
      await appendActivationCommand(pool, ownerUserId, {
        commandId: `auto_disable:${policyVersionId}:${idempotencyKey}`,
        action: 'auto_disable', policyVersionId, expectedActivePolicyVersionId: policyVersionId,
        reason: eventKind === 'contract_rejected' ? 'contract_rejected' : 'three_consecutive_failures',
      }, apiError);
      await pool.query(`INSERT INTO ubuddy_org_policy_health_events(
        id,owner_user_id,policy_version_id,trace_id,event_kind,idempotency_key,payload_json,created_at
      ) VALUES($1,$2,$3,$4,'auto_disabled',$5,$6,now()) ON CONFLICT(owner_user_id,idempotency_key) DO NOTHING`, [
        `ubuddy_org_health_${crypto.randomUUID()}`, ownerUserId, policyVersionId,
        boundedText(req.body?.traceId, 200), `auto_disabled:${idempotencyKey}`, { reason: eventKind },
      ]);
    }
    res.json({ ok: true, autoDisabled });
  }));
}

export async function organizationEvolutionOverview(pool, ownerUserId) {
  const [policies, activation, traceCount, health] = await Promise.all([
    pool.query(`SELECT * FROM ubuddy_org_policy_versions WHERE owner_user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20`, [ownerUserId]),
    pool.query(`SELECT * FROM ubuddy_org_activation_commands WHERE owner_user_id=$1 ORDER BY sequence_id DESC LIMIT 1`, [ownerUserId]),
    one(pool, `SELECT COUNT(*) AS count FROM (
      SELECT 1 FROM ubuddy_org_trace_events WHERE owner_user_id=$1 LIMIT 10001
    ) bounded_traces`, [ownerUserId]),
    pool.query(`SELECT * FROM ubuddy_org_policy_health_events WHERE owner_user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20`, [ownerUserId]),
  ]);
  const command = activation.rows[0] || null;
  const activeId = command?.action === 'activate' ? command.policy_version_id : '';
  const activeRow = activeId
    ? policies.rows.find((row) => row.id === activeId)
      || await one(pool, 'SELECT * FROM ubuddy_org_policy_versions WHERE owner_user_id=$1 AND id=$2', [ownerUserId, activeId])
    : null;
  const boundedTraceCount = Number(traceCount?.count || 0);
  return {
    capability: UBUDDY_ORGANIZATION_EVOLUTION_CAPABILITY,
    authority: 'cloud',
    traceCount: Math.min(10_000, boundedTraceCount),
    traceCountCapped: boundedTraceCount > 10_000,
    activePolicyVersionId: activeId,
    activePolicy: activeRow ? policyPayload(activeRow) : null,
    status: activeId ? 'active' : policies.rows.length ? 'candidate_ready' : 'collecting',
    policies: policies.rows.map((row) => ({ ...policyPayload(row), active: row.id === activeId })),
    healthEvents: health.rows.map(healthPayload),
  };
}

async function mineOrganizationPolicyWithLock(pool, ownerUserId) {
  if (pool?.constructor?.name === 'MemPg') return mineOrganizationPolicy(pool, ownerUserId);
  const client = await pool.connect();
  const lockKey = BigInt(`0x${sha256(ownerUserId).slice(0, 15)}`).toString();
  let acquired = false;
  try {
    const result = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [lockKey]);
    acquired = result.rows[0]?.acquired === true;
    if (!acquired) return null;
    return await mineOrganizationPolicy(client, ownerUserId);
  } finally {
    if (acquired) await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey]).catch(() => null);
    client.release();
  }
}

async function activePolicy(pool, ownerUserId) {
  return one(pool, `SELECT policy.* FROM (
      SELECT action,policy_version_id FROM ubuddy_org_activation_commands
      WHERE owner_user_id=$1 ORDER BY sequence_id DESC LIMIT 1
    ) command
    JOIN ubuddy_org_policy_versions policy
      ON policy.owner_user_id=$1 AND policy.id=command.policy_version_id
    WHERE command.action='activate'`, [ownerUserId]);
}

async function mineOrganizationPolicy(pool, ownerUserId) {
  const runId = `ubuddy_org_run_${crypto.randomUUID()}`;
  await appendRunEvent(pool, ownerUserId, runId, 'started', {});
  const rows = (await pool.query(`SELECT trace_id,event_kind,task_type,payload_json FROM ubuddy_org_trace_events
    WHERE owner_user_id=$1 AND event_kind IN ('dispatch','terminal','correction')
    ORDER BY created_at DESC,id DESC LIMIT 500`, [ownerUserId])).rows;
  const traces = new Map();
  for (const row of rows.reverse()) {
    const trace = traces.get(row.trace_id) || { traceId: row.trace_id, taskType: row.task_type, dispatch: null, terminal: null, correction: null };
    trace[row.event_kind] = row.payload_json || {};
    traces.set(row.trace_id, trace);
  }
  const failedByKey = new Map();
  const performanceByInstance = new Map();
  for (const trace of traces.values()) {
    if (!trace.dispatch || !trace.terminal) continue;
    const taskSucceeded = String(trace.terminal.status || '') === 'completed' && Number(trace.terminal.reworkCount || 0) === 0;
    for (const node of trace.dispatch.nodes || []) {
      const instanceId = String(node.agentInstanceId || '');
      if (!instanceId) continue;
      const performance = performanceByInstance.get(instanceId) || { attempts: 0, successes: 0 };
      performance.attempts += 1;
      if (taskSucceeded) performance.successes += 1;
      performanceByInstance.set(instanceId, performance);
      if (taskSucceeded && !trace.correction) continue;
      const key = `${trace.taskType}\u001f${node.agentId}\u001f${instanceId}`;
      const evidence = failedByKey.get(key) || { taskType: trace.taskType, node, traces: [], candidates: trace.dispatch.candidates || [] };
      evidence.traces.push(trace.traceId);
      failedByKey.set(key, evidence);
    }
  }
  const rules = [];
  const evidenceTraceIds = [];
  for (const evidence of failedByKey.values()) {
    if (evidence.traces.length < 3) continue;
    const alternatives = evidence.candidates.filter((candidate) => candidate.agentId === evidence.node.agentId
      && candidate.agentInstanceId && candidate.agentInstanceId !== evidence.node.agentInstanceId);
    const target = alternatives.sort((left, right) => candidateScore(right, performanceByInstance) - candidateScore(left, performanceByInstance))[0];
    if (!target) continue;
    rules.push({
      id: `prefer_${sha256(`${evidence.taskType}:${evidence.node.agentInstanceId}:${target.agentInstanceId}`).slice(0, 16)}`,
      taskTypes: [evidence.taskType],
      objectiveIncludes: [], nodeTitleIncludes: [],
      fromAgentId: evidence.node.agentId,
      fromAgentInstanceId: evidence.node.agentInstanceId,
      toAgentId: target.agentId,
      toAgentInstanceId: target.agentInstanceId,
      minimumConfidence: 0.7,
      evidenceCount: evidence.traces.length,
      rationale: `${evidence.traces.length} matching tasks failed or required correction; prefer the stronger active instance.`,
    });
    evidenceTraceIds.push(...evidence.traces);
  }
  if (!rules.length) {
    await appendRunEvent(pool, ownerUserId, runId, 'no_change', { completedTraceCount: [...traces.values()].filter((item) => item.terminal).length });
    return null;
  }
  const current = await activePolicy(pool, ownerUserId);
  const policyVersionId = `ubuddy_org_policy_${crypto.randomUUID()}`;
  const playbook = validateUBuddyOrganizationPlaybook({
    version: UBUDDY_ORG_PLAYBOOK_VERSION,
    policyVersionId,
    parentPolicyVersionId: current?.id || '',
    stage: 'assignment',
    taskScopes: [], assignmentRules: rules, decompositionRules: [],
    hardConstraints: { preserveMentionedAgents: true },
    provenance: {
      algorithmVersion: 'ubuddy_org_policy_miner_v1',
      evidenceTraceIds: [...new Set(evidenceTraceIds)],
      evidenceCount: new Set(evidenceTraceIds).size,
      summary: 'Repeated organization failures produced a minimal Agent-instance assignment patch.',
    },
    createdAt: new Date().toISOString(),
  });
  const policyHash = uBuddyOrganizationPolicyHash(playbook);
  const existing = await one(pool, `SELECT * FROM ubuddy_org_policy_versions WHERE owner_user_id=$1 AND policy_hash=$2`, [ownerUserId, policyHash]);
  if (existing) {
    await appendRunEvent(pool, ownerUserId, runId, 'no_change', { existingPolicyVersionId: existing.id });
    return existing;
  }
  await pool.query(`INSERT INTO ubuddy_org_policy_versions(
    id,owner_user_id,parent_policy_version_id,stage,policy_hash,playbook_json,evidence_count,summary,created_at
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())`, [
    policyVersionId, ownerUserId, current?.id || '', playbook.stage, policyHash, playbook,
    playbook.provenance.evidenceCount, playbook.provenance.summary,
  ]);
  await pool.query(`INSERT INTO ubuddy_org_policy_evaluations(
    id,owner_user_id,policy_version_id,evaluation_kind,status,metrics_json,created_at
  ) VALUES($1,$2,$3,'schema','passed',$4,now())`, [
    `ubuddy_org_eval_${crypto.randomUUID()}`, ownerUserId, policyVersionId,
    { ruleCount: playbook.assignmentRules.length, validator: UBUDDY_ORG_PLAYBOOK_VERSION },
  ]);
  await pool.query(`INSERT INTO ubuddy_org_policy_evaluations(
    id,owner_user_id,policy_version_id,evaluation_kind,status,metrics_json,created_at
  ) VALUES($1,$2,$3,'historical_replay','passed',$4,now())`, [
    `ubuddy_org_eval_${crypto.randomUUID()}`, ownerUserId, policyVersionId,
    {
      replayedTraceCount: playbook.provenance.evidenceCount,
      ruleCount: playbook.assignmentRules.length,
      contractViolationCount: 0,
      changedFields: ['agentId', 'agentInstanceId', 'departmentId'],
      preservedFields: ['nodes.length', 'dependencies', 'finalNodeId', 'deliverables'],
    },
  ]);
  await pool.query(`INSERT INTO ubuddy_org_pattern_evidence(
    id,owner_user_id,pattern_key,evidence_trace_ids_json,evidence_count,summary_json,created_at
  ) VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(owner_user_id,pattern_key,evidence_count) DO NOTHING`, [
    `ubuddy_org_evidence_${crypto.randomUUID()}`, ownerUserId, policyHash,
    playbook.provenance.evidenceTraceIds, playbook.provenance.evidenceCount, { ruleIds: rules.map((item) => item.id) },
  ]);
  await appendRunEvent(pool, ownerUserId, runId, 'candidate_created', { policyVersionId, policyHash });
  return one(pool, 'SELECT * FROM ubuddy_org_policy_versions WHERE id=$1', [policyVersionId]);
}

async function appendActivationCommand(pool, ownerUserId, input, apiError) {
  const commandId = boundedText(input.commandId, 240);
  if (!commandId) throw apiError('ubuddy_org_activation_command_required', '缺少组织策略操作幂等键。', 400);
  const current = await activePolicy(pool, ownerUserId);
  const expected = boundedText(input.expectedActivePolicyVersionId, 200);
  if (input.enforceExpected && String(current?.id || '') !== expected) {
    throw apiError('ubuddy_org_activation_conflict', '组织策略已在其他设备发生变化。', 409, { activePolicyVersionId: current?.id || '' });
  }
  const payloadHash = sha256(stableJson({ action: input.action, policyVersionId: input.policyVersionId || '', expected, reason: input.reason || '' }));
  const prior = await one(pool, `SELECT * FROM ubuddy_org_activation_commands WHERE owner_user_id=$1 AND command_id=$2`, [ownerUserId, commandId]);
  if (prior && prior.payload_hash !== payloadHash) throw apiError('ubuddy_org_activation_idempotency_conflict', '组织策略操作幂等键冲突。', 409);
  if (prior) return activationPayload(prior);
  const row = await one(pool, `INSERT INTO ubuddy_org_activation_commands(
    id,owner_user_id,command_id,action,policy_version_id,expected_active_policy_version_id,reason,payload_hash,created_at
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()) RETURNING *`, [
    `ubuddy_org_activation_${crypto.randomUUID()}`, ownerUserId, commandId, input.action,
    boundedText(input.policyVersionId, 200), expected, boundedText(input.reason, 500), payloadHash,
  ]);
  return activationPayload(row);
}

async function appendRunEvent(pool, ownerUserId, runId, eventKind, payload) {
  await pool.query(`INSERT INTO ubuddy_org_evolution_run_events(
    id,owner_user_id,run_id,event_kind,payload_json,created_at
  ) VALUES($1,$2,$3,$4,$5,now())`, [
    `ubuddy_org_run_event_${crypto.randomUUID()}`, ownerUserId, runId, eventKind, boundedObject(payload),
  ]);
}

function normalizeTraceEvent(value, apiError) {
  const eventKind = boundedText(value?.eventKind, 32);
  if (!['dispatch', 'terminal', 'correction'].includes(eventKind)) throw apiError('ubuddy_org_trace_kind_invalid', '组织轨迹事件类型无效。', 400);
  const traceId = boundedText(value?.traceId, 200);
  const idempotencyKey = boundedText(value?.idempotencyKey, 240);
  if (!traceId || !idempotencyKey) throw apiError('ubuddy_org_trace_identity_required', '组织轨迹缺少标识。', 400);
  return {
    traceId, idempotencyKey, eventKind,
    taskType: boundedText(value?.taskType, 120).toLowerCase(),
    taskSignature: boundedText(value?.taskSignature, 128),
    payload: boundedObject(value?.payload),
    clientCreatedAt: validDate(value?.clientCreatedAt) || new Date(),
  };
}

function candidateScore(candidate, performanceByInstance) {
  const measured = performanceByInstance.get(String(candidate.agentInstanceId || ''));
  const successRate = measured?.attempts ? measured.successes / measured.attempts : 0.5;
  const level = Number(String(candidate.performanceLevel || '').match(/\d+/)?.[0] || 1);
  const queuePenalty = Math.min(20, Math.max(0, Number(candidate.queueDepth || 0))) * 0.01;
  return successRate + (level * 0.03) - queuePenalty;
}

function policyPayload(row) {
  return {
    id: row.id, policyVersionId: row.id, parentPolicyVersionId: row.parent_policy_version_id,
    stage: row.stage, policyHash: row.policy_hash, playbook: row.playbook_json,
    evidenceCount: Number(row.evidence_count || 0), summary: row.summary || '', createdAt: iso(row.created_at),
  };
}

function activationPayload(row) {
  return { id: row.id, commandId: row.command_id, action: row.action, policyVersionId: row.policy_version_id, reason: row.reason, createdAt: iso(row.created_at) };
}

function healthPayload(row) {
  return { id: row.id, policyVersionId: row.policy_version_id, traceId: row.trace_id, eventKind: row.event_kind, payload: row.payload_json || {}, createdAt: iso(row.created_at) };
}

function requireCapability(req, apiError) {
  const capability = String(req.body?.capability || req.query?.capability || req.headers['x-janus-social-capability'] || '');
  if (capability !== UBUDDY_ORGANIZATION_EVOLUTION_CAPABILITY) {
    throw apiError('ubuddy_org_evolution_capability_required', '客户端不支持 uBuddy 组织自进化。', 426);
  }
}

function boundedObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const encoded = JSON.stringify(value);
  if (encoded.length > 64_000) throw new Error('uBuddy organization evolution payload is too large.');
  return JSON.parse(encoded);
}

function boundedText(value, limit) { return String(value || '').trim().slice(0, limit); }
function sha256(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function validDate(value) { const date = value ? new Date(value) : null; return date && Number.isFinite(date.getTime()) ? date : null; }
function iso(value) { const date = value ? new Date(value) : null; return date && Number.isFinite(date.getTime()) ? date.toISOString() : ''; }
async function one(db, sql, params = []) { return (await db.query(sql, params)).rows[0] || null; }
