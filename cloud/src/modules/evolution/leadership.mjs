import crypto from 'node:crypto';

import {
  LEADERSHIP_ALGORITHM_VERSION,
  LEADERSHIP_RETENTION_THRESHOLDS,
  calculateLeadershipEvaluation,
  calculateLeadershipSnapshot,
  leadershipAssignmentEligibility,
  leadershipPromotionReadiness,
  nextLeadershipLevel,
  normalizeLeadershipLevel,
} from '../../../../src/shared/evolution/leadership.js';
import { createEvolutionModelExecutor } from './modelProvider.mjs';

export function createPostgresLeadershipAuthority({ pool, env = process.env, modelExecutor = null } = {}) {
  if (!pool) throw new Error('Leadership authority requires a PostgreSQL pool.');
  const executeModel = modelExecutor || createEvolutionModelExecutor({ env });
  return {
    capabilities: () => ({ authority: 'cloud', authorityLocked: true, enabled: true, algorithmVersion: LEADERSHIP_ALGORITHM_VERSION,
      levels: ['L0', 'L1', 'L2', 'L3'], policyVersion: 'leadership_v2' }),

    async ensureProfiles() {
      const result = await pool.query(`INSERT INTO cloud_agent_leadership_levels
        (user_agent_instance_id,owner_user_id,agent_family_id,score,level,provisional,status,payload_json)
        SELECT id,user_id,agent_family_id,0,'L0',true,'active','{}'::jsonb FROM cloud_user_agent_instances_v3
        WHERE instance_kind='employee' ON CONFLICT(user_agent_instance_id) DO NOTHING`);
      return { inserted: result.rowCount };
    },

    async recordEvents(items = []) {
      let inserted = 0;
      for (const item of items) {
        if (!item.ownerUserId || !item.agentInstanceId || !item.eventKind || !item.occurredAt) continue;
        const id = item.id || stableId('levent', item.ownerUserId, item.agentInstanceId, item.taskId || '', item.assignmentId || '', item.eventKind, item.occurredAt);
        const result = await pool.query(`INSERT INTO cloud_agent_leadership_events
          (id,owner_user_id,user_agent_instance_id,agent_family_id,task_id,work_scope_id,assignment_id,event_kind,occurred_at,payload_json)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT DO NOTHING`, [id, item.ownerUserId, item.agentInstanceId,
          item.agentFamilyId || '', item.taskId || '', item.workScopeId || '', item.assignmentId || '', item.eventKind, item.occurredAt, JSON.stringify(item)]);
        inserted += result.rowCount;
      }
      return { status: 'recorded', inserted };
    },

    async backfillTaskHistory() {
      const rows = (await pool.query(`SELECT r.* FROM cloud_task_runs r WHERE NOT EXISTS (
        SELECT 1 FROM cloud_agent_leadership_evaluations e WHERE e.task_id=r.id AND e.algorithm_version=$1
      ) ORDER BY r.updated_at`, [LEADERSHIP_ALGORITHM_VERSION])).rows;
      let inserted = 0;
      for (const row of rows) {
        const run = row.payload_json || {};
        const agentInstanceId = run.leadAgentInstanceId || run.lead_agent_instance_id || '';
        if (!agentInstanceId || !['completed', 'failed', 'cancelled'].includes(String(run.status || ''))) continue;
        const instance = (await pool.query('SELECT * FROM cloud_user_agent_instances_v3 WHERE id=$1', [agentInstanceId])).rows[0];
        if (!instance) continue;
        const nodes = (await pool.query('SELECT * FROM cloud_task_nodes WHERE task_run_id=$1', [row.id])).rows.map((node) => ({ id: node.id, ...(node.payload_json || {}) }));
        if (!nodes.length) continue;
        const evaluation = legacyTaskEvaluation({ row, run, nodes });
        const id = stableId('leval', instance.id, evaluation.taskId, '', LEADERSHIP_ALGORITHM_VERSION);
        const result = await pool.query(`INSERT INTO cloud_agent_leadership_evaluations
          (id,owner_user_id,user_agent_instance_id,task_id,assignment_id,algorithm_version,score,evaluation_json,completed_at)
          VALUES ($1,$2,$3,$4,'',$5,$6,$7::jsonb,$8) ON CONFLICT DO NOTHING`, [id, instance.user_id, instance.id, evaluation.taskId,
          LEADERSHIP_ALGORITHM_VERSION, evaluation.score, JSON.stringify(evaluation), evaluation.completedAt]);
        inserted += result.rowCount;
      }
      return { status: 'backfilled', inserted };
    },

    async evaluateTask(input = {}) {
      const instance = await ownedInstance(pool, input.ownerUserId, input.agentInstanceId);
      const authoritativeInput = input.trustedGovernanceReview === true ? input : await postgresAuthoritativeTaskInput(pool, instance, input);
      const baselineContext = await postgresBaselineContext(pool, authoritativeInput);
      const governanceReview = input.trustedGovernanceReview === true
        ? input.governanceReview || {}
        : await leadershipGovernanceReview(executeModel, { ...authoritativeInput, baselineContext }).catch(() => ({}));
      const baseline = input.trustedGovernanceReview === true ? input.baseline || {}
        : baselineContext.sampleCount >= 5 ? historicalBaseline(baselineContext, authoritativeInput) : { available: false, passed: false, uplift: 0 };
      const evaluation = calculateLeadershipEvaluation({ ...authoritativeInput,
        deterministic: { ...(authoritativeInput.deterministic || {}), baselineUplift: baseline.uplift || 0 }, baseline,
        governanceReview,
        evidenceRefs: authoritativeInput.evidenceRefs?.length ? authoritativeInput.evidenceRefs : [`task:${authoritativeInput.taskId}`] });
      evaluation.baseline = baseline;
      if (!evaluation.taskId) throw codedError('leadership_task_required', 'Leadership evaluation requires a task id.', 400);
      const id = stableId('leval', instance.id, evaluation.taskId, evaluation.assignmentId, LEADERSHIP_ALGORITHM_VERSION);
      await pool.query(`INSERT INTO cloud_agent_leadership_evaluations
        (id,owner_user_id,user_agent_instance_id,task_id,assignment_id,algorithm_version,score,evaluation_json,completed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT(user_agent_instance_id,task_id,assignment_id,algorithm_version) DO UPDATE SET
        score=excluded.score,evaluation_json=excluded.evaluation_json,completed_at=excluded.completed_at`, [id, instance.user_id, instance.id,
        evaluation.taskId, evaluation.assignmentId, LEADERSHIP_ALGORITHM_VERSION, evaluation.score, JSON.stringify(evaluation), evaluation.completedAt]);
      if (evaluation.assignmentMode === 'trial' && evaluation.assignmentId) {
        await pool.query("UPDATE cloud_leadership_promotion_actions SET status='consumed',updated_at=now() WHERE id=$1 AND owner_user_id=$2 AND user_agent_instance_id=$3 AND action='trial_approved' AND status='approved'",
          [evaluation.assignmentId, instance.user_id, instance.id]);
      }
      return { id, ...evaluation };
    },

    async calculate({ agentInstanceId = '', now = new Date(), migrationBackfill = false } = {}) {
      const instance = (await pool.query('SELECT * FROM cloud_user_agent_instances_v3 WHERE id=$1', [agentInstanceId])).rows[0];
      if (!instance) throw codedError('agent_instance_not_found', 'Agent instance was not found.', 404);
      await pool.query(`INSERT INTO cloud_agent_leadership_levels
        (user_agent_instance_id,owner_user_id,agent_family_id,score,level,provisional,status,payload_json)
        VALUES ($1,$2,$3,0,'L0',true,'active','{}'::jsonb) ON CONFLICT(user_agent_instance_id) DO NOTHING`, [instance.id, instance.user_id, instance.agent_family_id]);
      const current = (await pool.query('SELECT * FROM cloud_agent_leadership_levels WHERE user_agent_instance_id=$1', [instance.id])).rows[0];
      const evaluations = (await pool.query(`SELECT evaluation_json FROM cloud_agent_leadership_evaluations
        WHERE user_agent_instance_id=$1 AND completed_at>=$2 ORDER BY completed_at DESC LIMIT 100`, [instance.id, new Date(now.getTime() - 90 * 86400000)])).rows.map((row) => row.evaluation_json);
      const snapshot = calculateLeadershipSnapshot(evaluations, { now, currentLevel: current.level, status: current.status });
      const previousPayload = current.payload_json || {};
      const safetyOverrideInputHash = previousPayload.safetyOverrideInputHash || '';
      const effectiveSevereSafetyViolation = snapshot.severeSafetyViolation && safetyOverrideInputHash !== snapshot.severeSafetyInputHash;
      const policySnapshot = { ...snapshot, severeSafetyViolation: effectiveSevereSafetyViolation,
        status: effectiveSevereSafetyViolation ? 'frozen' : current.status === 'inactive' ? 'inactive' : 'active' };
      const migrationBackfillLocked = current.level === 'L0' && previousPayload.migrationBackfillInputHash === snapshot.inputHash;
      const performance = (await pool.query('SELECT * FROM cloud_agent_performance_levels WHERE user_agent_instance_id=$1', [instance.id])).rows[0] || {};
      const evidenceReadiness = applyPromotionCooldown(leadershipPromotionReadiness({ currentLevel: current.level, score: policySnapshot.score,
        taskCount: policySnapshot.leadershipTaskCount, teamLeadTrialCount: policySnapshot.teamLeadTrialCount,
        crossTeamTrialCount: policySnapshot.crossTeamTrialCount, crossDepartmentTaskCount: policySnapshot.crossDepartmentTaskCount,
        baselineComparisonCount: policySnapshot.baselineComparisonCount,
        baselineUplift: policySnapshot.baselineUplift, professionalLevel: performance.level || '', professionalProvisional: performance.provisional !== false,
        governanceApproved: Boolean(policySnapshot.governanceApproved), severeSafetyViolation: effectiveSevereSafetyViolation }), current.level_changed_at, now);
      const promotionSettlement = settlePromotionWindow(evidenceReadiness, previousPayload.promotionSettlement, policySnapshot, now);
      const readiness = { ...evidenceReadiness, evidenceReady: evidenceReadiness.ready,
        ready: evidenceReadiness.ready && promotionSettlement.confirmed, promotionSettlement,
        reasons: evidenceReadiness.ready && !promotionSettlement.confirmed
          ? [...new Set([...(evidenceReadiness.reasons || []), 'monthly_windows_insufficient'])] : evidenceReadiness.reasons };
      const effectiveMigrationBackfill = Boolean(migrationBackfill || migrationBackfillLocked);
      const applied = await applyAutomaticPolicy(pool, { instance, current, snapshot: policySnapshot, readiness, migrationBackfill: effectiveMigrationBackfill, now });
      const finalLevel = applied.level || current.level;
      const finalStatus = applied.status || snapshot.status;
      const nextStateRevision = Number(current.state_revision || 0) + (current.level !== finalLevel || current.status !== finalStatus ? 1 : 0);
      const payload = { ...policySnapshot, level: finalLevel, status: finalStatus, stateRevision: nextStateRevision, promotion: readiness,
        reviewState: finalStatus === 'frozen' ? 'frozen' : readiness.ready && readiness.approvalRequired ? 'promotion_pending'
          : applied.consecutiveLowWindows > 0 ? 'demotion_watch' : 'stable',
        promotionSettlement,
        migrationBackfill: effectiveMigrationBackfill,
        migrationBackfillInputHash: migrationBackfill ? snapshot.inputHash : previousPayload.migrationBackfillInputHash || '',
        safetyOverrideInputHash };
      const historyId = stableId('lhistory', instance.id, LEADERSHIP_ALGORITHM_VERSION, snapshot.inputHash || 'empty');
      await pool.query(`INSERT INTO cloud_agent_leadership_history
        (id,user_agent_instance_id,algorithm_version,input_hash,score,level,provisional,status,payload_json)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT DO NOTHING`, [historyId, instance.id, LEADERSHIP_ALGORITHM_VERSION,
        snapshot.inputHash || 'empty', snapshot.score, finalLevel, snapshot.provisional, finalStatus, JSON.stringify(payload)]);
      await pool.query(`UPDATE cloud_agent_leadership_levels SET score=$1,level=$2,provisional=$3,status=$4,leadership_task_count=$5,state_revision=$6,
        consecutive_low_windows=$7,last_low_input_hash=$8,last_low_evaluated_at=$9,last_low_task_count=$10,
        level_changed_at=CASE WHEN level<>$2 THEN $11 ELSE level_changed_at END,payload_json=$12::jsonb,updated_at=$11 WHERE user_agent_instance_id=$13`,
      [snapshot.score, finalLevel, snapshot.provisional, finalStatus, snapshot.leadershipTaskCount, nextStateRevision,
        applied.consecutiveLowWindows, applied.lastLowInputHash, applied.lastLowEvaluatedAt || null, applied.lastLowTaskCount, now, JSON.stringify(payload), instance.id]);
      if (readiness.ready && ((readiness.approvalRequired && !effectiveMigrationBackfill) || (migrationBackfill && readiness.targetLevel === 'L1'))) {
        await ensurePromotionProposal(pool, instance, current.level, readiness.targetLevel, payload);
      }
      return { authority: 'cloud', agentInstanceId: instance.id, agentFamilyId: instance.agent_family_id, ...payload };
    },

    async calculateAll({ migrationBackfill = false } = {}) {
      await this.ensureProfiles();
      const rows = (await pool.query("SELECT id FROM cloud_user_agent_instances_v3 WHERE status='active' AND sync_enabled=true AND instance_kind='employee'")).rows;
      const results = [];
      for (const row of rows) results.push(await this.calculate({ agentInstanceId: row.id, migrationBackfill }));
      return results;
    },

    async status({ agentInstanceId = '' } = {}) {
      const row = (await pool.query('SELECT * FROM cloud_agent_leadership_levels WHERE user_agent_instance_id=$1', [agentInstanceId])).rows[0];
      return row ? { authority: 'cloud', ...row.payload_json, agentInstanceId: row.user_agent_instance_id, agentFamilyId: row.agent_family_id, ownerUserId: row.owner_user_id,
        score: Number(row.score), level: row.level, provisional: row.provisional, status: row.status, leadershipTaskCount: row.leadership_task_count,
        stateRevision: Number(row.state_revision || 0) } : null;
    },

    async history({ agentInstanceId = '', limit = 30 } = {}) {
      const rows = (await pool.query('SELECT * FROM cloud_agent_leadership_history WHERE user_agent_instance_id=$1 ORDER BY created_at DESC LIMIT $2',
        [agentInstanceId, Math.min(100, Math.max(1, Number(limit || 30)))])).rows;
      return rows.map((row) => ({ id: row.id, ...row.payload_json, createdAt: row.created_at }));
    },

    async actions({ ownerUserId = '', actorRole = '', agentInstanceId = '', status = '', limit = 50 } = {}) {
      const values = [];
      const filters = [];
      if (String(actorRole || '').toLowerCase() !== 'admin') { values.push(ownerUserId); filters.push(`owner_user_id=$${values.length}`); }
      if (agentInstanceId) { values.push(agentInstanceId); filters.push(`user_agent_instance_id=$${values.length}`); }
      if (status) { values.push(status); filters.push(`status=$${values.length}`); }
      values.push(Math.min(100, Math.max(1, Number(limit || 50))));
      const rows = (await pool.query(`SELECT * FROM cloud_leadership_promotion_actions${filters.length ? ` WHERE ${filters.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT $${values.length}`, values)).rows;
      return rows.map(actionPayload);
    },

    async requestTrial({ ownerUserId = '', agentInstanceId = '', role = 'task_lead', participantCount = 1, nodeCount = 1, departmentCount = 1, commandId = '', expectedStateRevision } = {}) {
      const instance = await ownedInstance(pool, ownerUserId, agentInstanceId);
      const leadership = await this.status({ agentInstanceId }) || await this.calculate({ agentInstanceId });
      assertExpectedRevision(leadership, expectedStateRevision);
      const performance = (await pool.query('SELECT * FROM cloud_agent_performance_levels WHERE user_agent_instance_id=$1', [agentInstanceId])).rows[0] || {};
      const activeTaskGroups = Number((await pool.query(`SELECT COUNT(DISTINCT a.work_scope_id)::int AS count FROM cloud_leadership_assignments a
        JOIN cloud_work_scopes s ON s.id=a.work_scope_id WHERE a.agent_instance_id=$1 AND a.status='active' AND s.status='active'
        AND (a.valid_until IS NULL OR a.valid_until>now())`, [agentInstanceId])).rows[0]?.count || 0);
      const eligibility = leadershipAssignmentEligibility({ level: leadership.level, status: leadership.status, role, assignmentMode: 'trial',
        participantCount, nodeCount, departmentCount, activeTaskGroups, ownerApproved: true, governanceApproved: true,
        professionalLevel: performance.level || '', professionalProvisional: performance.provisional !== false });
      if (!eligibility.eligible) throw codedError('leadership_trial_ineligible', 'Leadership trial is not eligible.', 409, { reasons: eligibility.reasons });
      const governanceRequired = leadership.level === 'L2';
      return insertAction(pool, { ownerUserId, agentInstanceId, action: governanceRequired ? 'trial_requested' : 'trial_approved',
        fromLevel: leadership.level, toLevel: nextLeadershipLevel(leadership.level), status: governanceRequired ? 'pending' : 'approved',
        commandId, actorId: ownerUserId, reason: governanceRequired ? `Requested governed ${role} trial.` : `Owner approved supervised ${role} trial.`,
        evidence: { role, participantCount, nodeCount, departmentCount, eligibility, agentFamilyId: instance.agent_family_id,
          stateRevision: leadership.stateRevision,
          requiredReviewer: leadership.level === 'L2' ? 'cloud_governance' : 'department_hr' } });
    },

    async decideAction({ actorUserId = '', actorRole = '', actionId = '', decision = '', commandId = '', reason = '', expectedStateRevision } = {}) {
      assertGovernanceActor(actorRole);
      const action = (await pool.query('SELECT * FROM cloud_leadership_promotion_actions WHERE id=$1', [actionId])).rows[0];
      if (!action) throw codedError('leadership_action_not_found', 'Leadership action was not found.', 404);
      if (action.status !== 'pending') return actionPayload(action);
      const leadership = await this.status({ agentInstanceId: action.user_agent_instance_id });
      assertExpectedRevision(leadership, expectedStateRevision);
      const normalized = String(decision || '').toLowerCase();
      if (!['approve', 'reject'].includes(normalized)) throw codedError('invalid_leadership_decision', 'Decision must be approve or reject.', 400);
      if (normalized === 'approve' && action.action === 'promote') await pool.query(`UPDATE cloud_agent_leadership_levels SET level=$1,state_revision=state_revision+1,level_changed_at=now(),consecutive_low_windows=0,
        last_low_input_hash='',last_low_evaluated_at=NULL,last_low_task_count=0,updated_at=now() WHERE owner_user_id=$2 AND user_agent_instance_id=$3`, [action.to_level, action.owner_user_id, action.user_agent_instance_id]);
      if (normalized === 'approve' && action.action === 'restore') {
        const current = await this.status({ agentInstanceId: action.user_agent_instance_id });
        const restoredPayload = { ...current, status: 'active', reviewState: 'stable', safetyOverrideInputHash: current?.severeSafetyInputHash || '' };
        await pool.query("UPDATE cloud_agent_leadership_levels SET status='active',state_revision=state_revision+CASE WHEN status<>'active' THEN 1 ELSE 0 END,consecutive_low_windows=0,last_low_input_hash='',last_low_evaluated_at=NULL,last_low_task_count=0,payload_json=$3::jsonb,updated_at=now() WHERE owner_user_id=$1 AND user_agent_instance_id=$2",
          [action.owner_user_id, action.user_agent_instance_id, JSON.stringify(restoredPayload)]);
      }
      const nextAction = normalized === 'approve' && action.action === 'trial_requested' ? 'trial_approved' : action.action;
      const row = (await pool.query(`UPDATE cloud_leadership_promotion_actions SET action=$1,status=$2,command_id=CASE WHEN command_id='' THEN $3 ELSE command_id END,
        actor_id=$4,reason=$5,updated_at=now() WHERE id=$6 RETURNING *`, [nextAction, normalized === 'approve' ? 'approved' : 'rejected', commandId || '', actorUserId,
        reason || normalized, action.id])).rows[0];
      return actionPayload(row);
    },

    async restore({ ownerUserId = '', agentInstanceId = '', commandId = '', reason = '', expectedStateRevision } = {}) {
      await ownedInstance(pool, ownerUserId, agentInstanceId);
      const current = await this.status({ agentInstanceId });
      assertExpectedRevision(current, expectedStateRevision);
      if (current?.status !== 'frozen') throw codedError('leadership_not_frozen', 'Leadership restoration is only available for frozen profiles.', 409);
      return insertAction(pool, { ownerUserId, agentInstanceId, action: 'restore', fromLevel: current?.level || 'L0', toLevel: current?.level || 'L0',
        status: 'pending', commandId, actorId: ownerUserId, reason: reason || 'Owner requested governance review for leadership restoration.', evidence: current || {} });
    },

    async submitAppeal({ ownerUserId = '', agentInstanceId = '', leadershipActionId = '', appealKind = 'assessment', reason = '', commandId = '' } = {}) {
      await ownedInstance(pool, ownerUserId, agentInstanceId);
      if (!String(reason || '').trim()) throw codedError('leadership_appeal_reason_required', 'Leadership appeal requires a reason.', 400);
      if (commandId) {
        const existing = (await pool.query('SELECT * FROM cloud_leadership_appeals WHERE owner_user_id=$1 AND command_id=$2', [ownerUserId, commandId])).rows[0];
        if (existing) return appealPayload(existing);
      }
      const id = stableId('lappeal', ownerUserId, agentInstanceId, commandId || crypto.randomUUID());
      const current = await this.status({ agentInstanceId });
      const row = (await pool.query(`INSERT INTO cloud_leadership_appeals
        (id,owner_user_id,user_agent_instance_id,leadership_action_id,appeal_kind,status,command_id,submitted_reason,evidence_snapshot_json)
        VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8::jsonb) RETURNING *`, [id, ownerUserId, agentInstanceId,
        leadershipActionId, normalizeAppealKind(appealKind), commandId, String(reason).trim(), JSON.stringify(current || {})])).rows[0];
      return appealPayload(row);
    },

    async appeals({ ownerUserId = '', actorRole = '', agentInstanceId = '', status = '', limit = 50 } = {}) {
      const admin = String(actorRole || '').toLowerCase() === 'admin';
      const values = [];
      const filters = [];
      if (!admin) { values.push(ownerUserId); filters.push(`owner_user_id=$${values.length}`); }
      if (agentInstanceId) { values.push(agentInstanceId); filters.push(`user_agent_instance_id=$${values.length}`); }
      if (status) { values.push(status); filters.push(`status=$${values.length}`); }
      values.push(Math.min(100, Math.max(1, Number(limit || 50))));
      const rows = (await pool.query(`SELECT * FROM cloud_leadership_appeals${filters.length ? ` WHERE ${filters.join(' AND ')}` : ''}
        ORDER BY created_at DESC LIMIT $${values.length}`, values)).rows;
      return rows.map(appealPayload);
    },

    async decideAppeal({ actorUserId = '', actorRole = '', appealId = '', decision = '', reason = '' } = {}) {
      assertGovernanceActor(actorRole);
      const normalized = String(decision || '').toLowerCase();
      if (!['approve', 'reject'].includes(normalized)) throw codedError('invalid_leadership_decision', 'Decision must be approve or reject.', 400);
      const row = (await pool.query(`UPDATE cloud_leadership_appeals SET status=$1,reviewer_user_id=$2,reviewer_reason=$3,updated_at=now()
        WHERE id=$4 AND status='pending' RETURNING *`, [normalized === 'approve' ? 'approved' : 'rejected', actorUserId, reason || normalized, appealId])).rows[0];
      if (!row) throw codedError('leadership_appeal_not_found', 'Pending Leadership appeal was not found.', 404);
      return appealPayload(row);
    },

    async assignmentEligibility(input = {}) {
      const leadership = await this.status({ agentInstanceId: input.agentInstanceId }) || { level: 'L0', status: 'active' };
      const performance = (await pool.query('SELECT * FROM cloud_agent_performance_levels WHERE user_agent_instance_id=$1', [input.agentInstanceId])).rows[0] || {};
      const activeTaskGroups = Number((await pool.query(`SELECT COUNT(DISTINCT a.work_scope_id)::int AS count FROM cloud_leadership_assignments a
        JOIN cloud_work_scopes s ON s.id=a.work_scope_id WHERE a.agent_instance_id=$1 AND a.status='active' AND s.status='active'
        AND (a.valid_until IS NULL OR a.valid_until>now())`, [input.agentInstanceId])).rows[0]?.count || 0);
      return leadershipAssignmentEligibility({ ...input, level: leadership.level, status: leadership.status,
        professionalLevel: performance.level || '', professionalProvisional: performance.provisional !== false,
        activeTaskGroups: input.activeTaskGroups ?? activeTaskGroups });
    },
  };
}

async function applyAutomaticPolicy(pool, { instance, current, snapshot, readiness, migrationBackfill, now = new Date() }) {
  let level = normalizeLeadershipLevel(current.level);
  let status = snapshot.status;
  let consecutiveLowWindows = Number(current.consecutive_low_windows || 0);
  let lastLowInputHash = current.last_low_input_hash || '';
  let lastLowEvaluatedAt = current.last_low_evaluated_at || '';
  let lastLowTaskCount = Number(current.last_low_task_count || 0);
  if (snapshot.severeSafetyViolation && current.status !== 'frozen') {
    await insertAction(pool, { ownerUserId: instance.user_id, agentInstanceId: instance.id, action: 'freeze', fromLevel: level, toLevel: level,
      status: 'approved', actorId: 'cloud_governance', reason: 'Severe leadership safety violation.', evidence: snapshot });
    status = 'frozen';
    await pool.query(`UPDATE cloud_leadership_assignments SET status='revoked',valid_until=CASE WHEN valid_until IS NULL OR valid_until>now() THEN now() ELSE valid_until END
      WHERE user_id=$1 AND agent_instance_id=$2 AND status='active'`, [instance.user_id, instance.id]);
  }
  if (!migrationBackfill && readiness.ready && readiness.automatic && status === 'active') {
    const next = readiness.targetLevel;
    await insertAction(pool, { ownerUserId: instance.user_id, agentInstanceId: instance.id, action: 'promote', fromLevel: level, toLevel: next,
      status: 'approved', actorId: 'cloud_governance', reason: 'Automatic L0 to L1 promotion.', evidence: snapshot });
    level = next;
    await pool.query("UPDATE cloud_leadership_promotion_actions SET status='superseded',updated_at=now() WHERE owner_user_id=$1 AND user_agent_instance_id=$2 AND action='promote' AND to_level=$3 AND status='pending'", [instance.user_id, instance.id, next]);
  }
  const threshold = LEADERSHIP_RETENTION_THRESHOLDS[level] || 0;
  const distinctMatureWindow = snapshot.inputHash !== lastLowInputHash && (!lastLowEvaluatedAt
    || (now.getTime() - Date.parse(lastLowEvaluatedAt) >= 30 * 86400000 && snapshot.leadershipTaskCount - lastLowTaskCount >= 2));
  if (level !== 'L0' && !snapshot.provisional && snapshot.score < threshold && distinctMatureWindow) {
    consecutiveLowWindows += 1;
    lastLowInputHash = snapshot.inputHash;
    lastLowEvaluatedAt = now.toISOString();
    lastLowTaskCount = snapshot.leadershipTaskCount;
    if (consecutiveLowWindows >= 2) {
      const previous = level;
      level = `L${Math.max(0, Number(level.slice(1)) - 1)}`;
      consecutiveLowWindows = 0;
      lastLowInputHash = '';
      lastLowEvaluatedAt = '';
      lastLowTaskCount = 0;
      await insertAction(pool, { ownerUserId: instance.user_id, agentInstanceId: instance.id, action: 'demote', fromLevel: previous, toLevel: level,
        status: 'approved', actorId: 'cloud_governance', reason: 'Two mature leadership windows were below the level threshold.', evidence: snapshot });
      await pool.query(`UPDATE cloud_leadership_assignments SET status='draining',valid_until=CASE WHEN valid_until IS NULL OR valid_until>now()+interval '24 hours' THEN now()+interval '24 hours' ELSE valid_until END
        WHERE user_id=$1 AND agent_instance_id=$2 AND status='active'`, [instance.user_id, instance.id]);
    }
  } else if (snapshot.score >= threshold) { consecutiveLowWindows = 0; lastLowInputHash = ''; lastLowEvaluatedAt = ''; lastLowTaskCount = 0; }
  return { level, status, consecutiveLowWindows, lastLowInputHash, lastLowEvaluatedAt, lastLowTaskCount };
}

async function ensurePromotionProposal(pool, instance, fromLevel, toLevel, evidence) {
  const existing = (await pool.query(`SELECT id FROM cloud_leadership_promotion_actions WHERE owner_user_id=$1 AND user_agent_instance_id=$2
    AND action='promote' AND to_level=$3 AND status='pending'`, [instance.user_id, instance.id, toLevel])).rows[0];
  return existing || insertAction(pool, { ownerUserId: instance.user_id, agentInstanceId: instance.id, action: 'promote', fromLevel, toLevel,
    status: 'pending', actorId: 'cloud_governance', reason: `${toLevel} promotion evidence is ready for governance review.`,
    evidence: { ...evidence, requiredReviewer: toLevel === 'L3' ? 'cloud_admin' : 'department_hr' } });
}

async function insertAction(pool, { ownerUserId, agentInstanceId, action, fromLevel = 'L0', toLevel = 'L0', status = 'pending', commandId = '', actorId = '', reason = '', evidence = {} }) {
  if (commandId) {
    const existing = (await pool.query('SELECT * FROM cloud_leadership_promotion_actions WHERE owner_user_id=$1 AND command_id=$2', [ownerUserId, commandId])).rows[0];
    if (existing) return actionPayload(existing);
  }
  const id = stableId('laction', ownerUserId, agentInstanceId, action, commandId || crypto.randomUUID());
  const row = (await pool.query(`INSERT INTO cloud_leadership_promotion_actions
    (id,owner_user_id,user_agent_instance_id,action,from_level,to_level,status,command_id,actor_id,reason,evidence_snapshot_json)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING *`, [id, ownerUserId, agentInstanceId, action, fromLevel, toLevel,
    status, commandId, actorId, reason, JSON.stringify(evidence)])).rows[0];
  return actionPayload(row);
}

async function ownedInstance(pool, ownerUserId, agentInstanceId) {
  const row = (await pool.query('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND id=$2', [ownerUserId, agentInstanceId])).rows[0];
  if (!row) throw codedError('agent_instance_not_found', 'Agent instance does not belong to the user.', 404);
  return row;
}
function actionPayload(row = {}) { return { id: row.id, ownerUserId: row.owner_user_id, agentInstanceId: row.user_agent_instance_id, action: row.action, fromLevel: row.from_level,
  toLevel: row.to_level, status: row.status, commandId: row.command_id || '', actorId: row.actor_id || '', reason: row.reason || '',
  evidence: row.evidence_snapshot_json || {}, createdAt: row.created_at, updatedAt: row.updated_at }; }
function appealPayload(row = {}) { return { id: row.id, ownerUserId: row.owner_user_id, agentInstanceId: row.user_agent_instance_id, leadershipActionId: row.leadership_action_id || '',
  appealKind: row.appeal_kind, status: row.status, commandId: row.command_id || '', submittedReason: row.submitted_reason || '',
  reviewerUserId: row.reviewer_user_id || '', reviewerReason: row.reviewer_reason || '', evidence: row.evidence_snapshot_json || {},
  createdAt: row.created_at, updatedAt: row.updated_at }; }
function stableId(prefix, ...parts) { return `${prefix}_${crypto.createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0, 24)}`; }
function median(values = []) { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function codedError(code, message, status = 400, details = {}) { const error = new Error(message); error.code = code; error.status = status; error.details = details; return error; }
function assertExpectedRevision(current, expected) {
  if (expected == null || expected === '') return;
  if (Number(expected) !== Number(current?.stateRevision || 0)) throw codedError('leadership_revision_conflict', 'Leadership state revision changed.', 409,
    { expectedStateRevision: Number(expected), currentStateRevision: Number(current?.stateRevision || 0) });
}
function assertGovernanceActor(role = '') {
  if (String(role || '').toLowerCase() !== 'admin') throw codedError('leadership_governance_required', 'Cloud governance approval is required.', 403);
}
function normalizeAppealKind(value = 'assessment') {
  const kind = String(value || 'assessment').toLowerCase();
  return ['assessment', 'promotion', 'demotion', 'freeze', 'restore'].includes(kind) ? kind : 'assessment';
}
function settlePromotionWindow(readiness = {}, previous = {}, snapshot = {}, now = new Date()) {
  if (!readiness.ready || !readiness.targetLevel) return { targetLevel: readiness.targetLevel || '', consecutiveWindows: 0,
    confirmed: false, lastInputHash: '', lastEvaluatedAt: '', lastTaskCount: 0 };
  const sameTarget = previous?.targetLevel === readiness.targetLevel;
  let consecutiveWindows = sameTarget ? Math.max(0, Number(previous.consecutiveWindows || 0)) : 0;
  let lastInputHash = sameTarget ? String(previous.lastInputHash || '') : '';
  let lastEvaluatedAt = sameTarget ? String(previous.lastEvaluatedAt || '') : '';
  let lastTaskCount = sameTarget ? Math.max(0, Number(previous.lastTaskCount || 0)) : 0;
  let lastTaskIds = sameTarget && Array.isArray(previous.lastTaskIds) ? previous.lastTaskIds.map(String) : [];
  const firstWindow = consecutiveWindows === 0;
  const previousTaskIds = new Set(lastTaskIds);
  const newTaskCount = (Array.isArray(snapshot.taskIds) ? snapshot.taskIds : []).filter((taskId) => !previousTaskIds.has(String(taskId))).length;
  const distinctMonthlyWindow = !firstWindow && snapshot.inputHash !== lastInputHash && Number.isFinite(Date.parse(lastEvaluatedAt))
    && now.getTime() - Date.parse(lastEvaluatedAt) >= 30 * 86400000 && newTaskCount >= 2;
  if (firstWindow || distinctMonthlyWindow) {
    consecutiveWindows += 1;
    lastInputHash = snapshot.inputHash;
    lastEvaluatedAt = now.toISOString();
    lastTaskCount = snapshot.leadershipTaskCount;
    lastTaskIds = Array.isArray(snapshot.taskIds) ? snapshot.taskIds.map(String) : [];
  }
  return { targetLevel: readiness.targetLevel, consecutiveWindows, confirmed: consecutiveWindows >= 2,
    lastInputHash, lastEvaluatedAt, lastTaskCount, lastTaskIds };
}
function applyPromotionCooldown(readiness, levelChangedAt, now = new Date()) {
  const changedAt = Date.parse(levelChangedAt || '');
  if (!readiness.targetLevel || !Number.isFinite(changedAt)) return readiness;
  const cooldownUntil = new Date(changedAt + 30 * 86400000).toISOString();
  if (Date.parse(cooldownUntil) <= now.getTime()) return { ...readiness, cooldownUntil };
  return { ...readiness, ready: false, cooldownUntil, reasons: [...new Set([...(readiness.reasons || []), 'promotion_cooldown'])] };
}

function legacyTaskEvaluation({ row, run, nodes }) {
  const metadata = run.metadata || run.metadata_json || {};
  const failed = nodes.filter((node) => node.status === 'failed').length;
  const blocked = nodes.filter((node) => node.status === 'blocked').length;
  const rework = nodes.filter((node) => node.status === 'rework').length;
  return calculateLeadershipEvaluation({ taskId: row.id, completedAt: run.updatedAt || run.updated_at || row.updated_at,
    role: 'task_lead', assignmentMode: 'normal', participantCount: new Set(nodes.map((node) => node.agentInstanceId || node.agent_instance_id || node.agentId).filter(Boolean)).size,
    departmentCount: Math.max(1, Array.isArray(metadata.collaboratingDepartmentIds) ? metadata.collaboratingDepartmentIds.length + 1 : 1),
    evidenceRefs: nodes.map((node) => `task_node:${node.id}`), deterministic: {
      deliveryQuality: Number(metadata.acceptanceScore ?? (run.status === 'completed' ? 75 : 20)), decompositionMatching: Math.min(85, 60 + nodes.length * 3),
      reworkCount: rework, escapedErrorCount: failed, dependencyCoordination: Math.max(0, 100 - failed * 20 - blocked * 15),
      baselineUplift: 0, securityViolationCount: Number(metadata.securityViolationCount || 0),
    }, baseline: { available: false, passed: false, uplift: 0 }, evaluatorVersion: 'legacy_backfill_v1' });
}

async function postgresBaselineContext(pool, input = {}) {
  const rows = (await pool.query('SELECT evaluation_json FROM cloud_agent_leadership_evaluations WHERE completed_at>=now()-interval \'180 days\' ORDER BY completed_at DESC LIMIT 500')).rows;
  const comparable = rows.map((row) => row.evaluation_json || {}).filter((item) => item.taskTypeKey === String(input.taskTypeKey || 'general')
    && (!input.agentInstanceId || item.agentInstanceId !== input.agentInstanceId)
    && Math.abs(Number(item.participantCount || 1) - Number(input.participantCount || 1)) <= 1
    && Number(item.departmentCount || 1) === Number(input.departmentCount || 1)
    && Number(item.operational?.actualDurationMs || 0) > 0);
  return { sampleCount: comparable.length, medianDurationMs: median(comparable.map((item) => Number(item.operational?.actualDurationMs || 0))),
    referenceId: comparable.length ? stableId('lbaseline', ...comparable.map((item) => item.taskId).sort()) : '' };
}
async function postgresAuthoritativeTaskInput(pool, instance, input = {}) {
  const row = (await pool.query('SELECT * FROM cloud_task_runs WHERE id=$1', [input.taskId || ''])).rows[0];
  if (!row) throw codedError('leadership_task_not_synchronized', 'Leadership task must be synchronized before evaluation.', 409);
  const run = row.payload_json || {};
  const ownerUserId = row.owner_user_id || run.ownerUserId || run.owner_user_id || '';
  if (ownerUserId && ownerUserId !== instance.user_id) throw codedError('leadership_task_owner_mismatch', 'Leadership task does not belong to the Agent owner.', 403);
  const leadAgentInstanceId = run.leadAgentInstanceId || run.lead_agent_instance_id || '';
  if (leadAgentInstanceId !== instance.id) throw codedError('leadership_task_leader_mismatch', 'Agent was not the synchronized task leader.', 409);
  const metadata = run.metadata || run.metadata_json || {};
  if (!metadata.leadershipAssessmentEligible && !metadata.leadershipAssignmentId) throw codedError('leadership_task_not_eligible', 'Task did not contain an authorized leadership appointment.', 409);
  const nodes = (await pool.query('SELECT * FROM cloud_task_nodes WHERE task_run_id=$1 ORDER BY updated_at', [row.id])).rows.map((node) => ({ id: node.id, ...(node.payload_json || {}) }));
  if (!nodes.length) throw codedError('leadership_task_nodes_missing', 'Leadership task nodes are not synchronized.', 409);
  return authoritativeTaskFacts({ row, run, metadata, nodes, instance });
}
function historicalBaseline(context, input = {}) {
  const baselineDuration = Number(context.medianDurationMs || 0);
  const actualDuration = Number(input.deterministic?.actualDurationMs || 0);
  const quality = Number(input.deterministic?.deliveryQuality || 0);
  const uplift = baselineDuration > 0 && actualDuration > 0 && quality >= 60 ? ((baselineDuration - actualDuration) / baselineDuration) * 100 : 0;
  return { available: true, kind: 'historical', sampleCount: context.sampleCount, uplift: Math.round(uplift * 100) / 100,
    passed: quality >= 60 && uplift >= 0, referenceId: context.referenceId };
}
function authoritativeTaskFacts({ row, run, metadata, nodes, instance }) {
  const failed = nodes.filter((node) => node.status === 'failed').length;
  const blocked = nodes.filter((node) => node.status === 'blocked').length;
  const rework = nodes.filter((node) => node.status === 'rework').length;
  const participants = new Set(nodes.map((node) => node.agentInstanceId || node.agent_instance_id || node.agentId).filter(Boolean));
  const leaderNodes = nodes.filter((node) => (node.agentInstanceId || node.agent_instance_id) === instance.id || (!(node.agentInstanceId || node.agent_instance_id) && node.agentId === instance.agent_family_id)).length;
  const completedNodes = nodes.filter((node) => ['completed', 'accepted'].includes(String(node.status || ''))).length;
  const validTakeoverNodeCount = validLeadershipTakeovers(metadata).length;
  const actualDurationMs = durationBetween(run.startedAt || run.started_at || run.createdAt || row.created_at,
    run.completedAt || run.completed_at || run.updatedAt || run.updated_at || row.updated_at);
  const estimatedDurationMs = nodes.reduce((sum, node) => sum + Math.max(0, Number(node.estimatedMinutes || node.estimated_minutes || 0)) * 60000, 0);
  return { ownerUserId: instance.user_id, agentInstanceId: instance.id, taskId: row.id,
    assignmentId: metadata.leadershipAssignmentId || '', assignmentMode: metadata.leadershipAssignmentMode || 'normal',
    role: metadata.leadershipRole || 'task_lead', taskTypeKey: metadata.taskTypeKey || run.departmentId || run.department_id || instance.agent_family_id,
    departmentCount: Math.max(1, Array.isArray(metadata.collaboratingDepartmentIds) ? metadata.collaboratingDepartmentIds.length + 1 : 1),
    participantCount: Math.max(0, participants.size - 1), completedAt: run.completedAt || run.completed_at || run.updatedAt || run.updated_at || row.updated_at,
    evidenceRefs: nodes.map((node) => `task_node:${node.id}`), deterministic: {
      deliveryQuality: Number(metadata.acceptanceScore ?? (run.status === 'completed' ? (metadata.accepted ? 90 : 75) : 20)),
      decompositionMatching: Number(metadata.leadershipDecompositionScore ?? deterministicDecompositionScore(nodes, metadata, instance)),
      leaderNodeShare: nodes.length ? leaderNodes / nodes.length : 1, totalNodeCount: nodes.length, completedNodeCount: completedNodes,
      validTakeoverNodeCount, reworkCount: rework,
      escapedErrorCount: Number(metadata.escapedErrorCount || failed), caughtErrorCount: Number(metadata.caughtErrorCount || 0),
      dependencyCoordination: Number(metadata.leadershipCoordinationScore ?? Math.max(0, 100 - failed * 20 - blocked * 15)),
      avoidableBlockedMinutes: Number(metadata.avoidableBlockedMinutes || blocked * 15), baselineUplift: Number(metadata.leadershipBaselineUplift || 0),
      securityViolationCount: Number(metadata.securityViolationCount || 0), unauthorizedAccessCount: Number(metadata.unauthorizedAccessCount || 0),
      severeSafetyViolation: Boolean(metadata.severeSafetyViolation),
      actualDurationMs, estimatedDurationMs,
    }, evaluatorVersion: 'cloud_authoritative_task_v1' };
}

async function leadershipGovernanceReview(modelExecutor, input) {
  if (typeof modelExecutor !== 'function' || modelExecutor.available === false) return {};
  const answer = await modelExecutor({ modelRole: 'leadership_evaluator', prompt: leadershipReviewPrompt(input) });
  const review = parseModelJson(answer);
  const allowed = new Set((Array.isArray(input.evidenceRefs) ? input.evidenceRefs : []).map(String));
  review.evidenceRefs = (Array.isArray(review.evidenceRefs) ? review.evidenceRefs : []).map(String).filter((item) => allowed.has(item));
  return review.evidenceRefs.length ? review : {};
}
function leadershipReviewPrompt(input = {}) {
  return `You are the Janus cloud Leadership evaluator. Return JSON only. Score only from supplied task facts and evidence references.
Do not reward the leader for doing all node work. Judge whether delegation, context, review, conflict handling, and coordination improved other Agents.
Schema: {"deliveryQuality":0-100,"decompositionMatching":0-100,"reviewReworkControl":0-100,"dependencyCoordination":0-100,"teamEfficiencyUplift":0-100,"decision":"approved|pending|rejected","baseline":{"available":true,"kind":"historical|shadow_replay","sampleCount":1,"uplift":0,"passed":false,"referenceId":"..."},"evidenceRefs":["..."]}.
Task facts:\n${JSON.stringify({ taskId: input.taskId, role: input.role, assignmentMode: input.assignmentMode,
    taskTypeKey: input.taskTypeKey, participantCount: input.participantCount, departmentCount: input.departmentCount,
    deterministic: input.deterministic, baseline: input.baseline, evidenceRefs: input.evidenceRefs })}`;
}
function parseModelJson(answer = '') {
  const text = String(answer || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || text;
  const start = fenced.indexOf('{'); const end = fenced.lastIndexOf('}');
  return start >= 0 && end > start ? JSON.parse(fenced.slice(start, end + 1)) : {};
}
function deterministicDecompositionScore(nodes = [], metadata = {}, instance = {}) {
  const relevant = nodes.filter((node) => String(node.status || '') !== 'cancelled' || !/merged into/i.test(String(node.errorText || node.error_text || '')));
  const completionCoverage = relevant.length ? relevant.filter((node) => ['completed', 'accepted'].includes(String(node.status || ''))).length / relevant.length : 0;
  const edgeCount = relevant.reduce((sum, node) => sum + (Array.isArray(node.dependencies) ? node.dependencies.length : 0), 0);
  const dependencyCorrections = Math.max(0, Number(metadata.dependencyCorrectionCount || metadata.dependency_correction_count || 0));
  const dependencyPrecision = Math.max(0, 1 - dependencyCorrections / Math.max(1, edgeCount));
  const skillFit = Math.max(0, Math.min(1, Number(metadata.assignmentSkillFit || metadata.assignment_skill_fit || 70) / 100));
  const loadBalance = estimatedLoadBalance(relevant, instance);
  return Math.round((completionCoverage * 30 + skillFit * 25 + dependencyPrecision * 25 + loadBalance * 20) * 100) / 100;
}
function estimatedLoadBalance(nodes = [], instance = {}) {
  const loads = new Map();
  for (const node of nodes) {
    const agent = node.agentInstanceId || node.agent_instance_id || node.agentId || '';
    if (!agent || agent === instance.id || agent === instance.agent_family_id) continue;
    loads.set(agent, (loads.get(agent) || 0) + Math.max(1, Number(node.estimatedMinutes || node.estimated_minutes || 1)));
  }
  const values = [...loads.values()];
  if (values.length < 2) return 1;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const difference = values.reduce((sum, left) => sum + values.reduce((inner, right) => inner + Math.abs(left - right), 0), 0);
  return Math.max(0, 1 - difference / (2 * values.length * values.length * Math.max(1, mean)));
}
function validLeadershipTakeovers(metadata = {}) {
  const allowed = new Set(['blocked', 'failed', 'security', 'owner_request']);
  return (Array.isArray(metadata.leadershipTakeovers) ? metadata.leadershipTakeovers : [])
    .filter((item) => allowed.has(String(item?.reason || '').toLowerCase()) && String(item?.nodeId || '').trim());
}
function durationBetween(start, end) { const left = Date.parse(start || ''); const right = Date.parse(end || '');
  return Number.isFinite(left) && Number.isFinite(right) && right >= left ? right - left : 0; }
