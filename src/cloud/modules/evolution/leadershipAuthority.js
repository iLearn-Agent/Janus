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
} from '../../../shared/evolution/leadership.js';

export function createSqliteLeadershipAuthority({ db, modelExecutor = null } = {}) {
  if (!db) throw new Error('Leadership authority requires a database.');
  return {
    capabilities: () => ({ authority: 'cloud', authorityLocked: true, enabled: true, algorithmVersion: LEADERSHIP_ALGORITHM_VERSION,
      levels: ['L0', 'L1', 'L2', 'L3'], policyVersion: 'leadership_v2' }),

    ensureProfiles() {
      let inserted = 0;
      for (const instance of db.prepare("SELECT * FROM cloud_user_agent_instances_v3 WHERE instance_kind='employee'").all()) {
        inserted += db.prepare(`INSERT OR IGNORE INTO cloud_agent_leadership_levels
          (user_agent_instance_id,owner_user_id,agent_family_id,score,level,provisional,status,payload_json)
          VALUES (?,?,?,0,'L0',1,'active','{}')`).run(instance.id, instance.user_id, instance.agent_family_id).changes;
      }
      return { inserted };
    },

    recordEvents(items = []) {
      let inserted = 0;
      for (const item of items) {
        if (!item.ownerUserId || !item.agentInstanceId || !item.eventKind || !item.occurredAt) continue;
        const id = item.id || stableId('levent', item.ownerUserId, item.agentInstanceId, item.taskId || '', item.assignmentId || '', item.eventKind, item.occurredAt);
        inserted += db.prepare(`INSERT OR IGNORE INTO cloud_agent_leadership_events
          (id,owner_user_id,user_agent_instance_id,agent_family_id,task_id,work_scope_id,assignment_id,event_kind,occurred_at,payload_json)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, item.ownerUserId, item.agentInstanceId, item.agentFamilyId || '', item.taskId || '',
          item.workScopeId || '', item.assignmentId || '', item.eventKind, item.occurredAt, JSON.stringify(item)).changes;
      }
      return { status: 'recorded', inserted };
    },

    backfillTaskHistory() {
      let inserted = 0;
      for (const row of db.prepare(`SELECT r.* FROM cloud_task_runs r WHERE NOT EXISTS (
        SELECT 1 FROM cloud_agent_leadership_evaluations e WHERE e.task_id=r.id AND e.algorithm_version=?
      ) ORDER BY r.updated_at`).all(LEADERSHIP_ALGORITHM_VERSION)) {
        const run = parse(row.payload_json);
        const agentInstanceId = run.leadAgentInstanceId || run.lead_agent_instance_id || '';
        if (!agentInstanceId || !['completed', 'failed', 'cancelled'].includes(String(run.status || ''))) continue;
        const instance = db.prepare('SELECT * FROM cloud_user_agent_instances_v3 WHERE id=?').get(agentInstanceId);
        if (!instance) continue;
        const nodes = db.prepare('SELECT * FROM cloud_task_nodes WHERE task_run_id=?').all(row.id).map((node) => ({ id: node.id, ...parse(node.payload_json) }));
        if (!nodes.length) continue;
        const evaluation = legacyTaskEvaluation({ row, run, nodes });
        const id = stableId('leval', instance.id, evaluation.taskId, '', LEADERSHIP_ALGORITHM_VERSION);
        inserted += db.prepare(`INSERT OR IGNORE INTO cloud_agent_leadership_evaluations
          (id,owner_user_id,user_agent_instance_id,task_id,assignment_id,algorithm_version,score,evaluation_json,completed_at)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(id, instance.user_id, instance.id, evaluation.taskId, '', LEADERSHIP_ALGORITHM_VERSION,
          evaluation.score, JSON.stringify(evaluation), evaluation.completedAt).changes;
      }
      return { status: 'backfilled', inserted };
    },

    async evaluateTask(input = {}) {
      const instance = ownedInstance(db, input.ownerUserId, input.agentInstanceId);
      const authoritativeInput = input.trustedGovernanceReview === true ? input : sqliteAuthoritativeTaskInput(db, instance, input);
      const baselineContext = sqliteBaselineContext(db, authoritativeInput);
      const governanceReview = input.trustedGovernanceReview === true
        ? input.governanceReview || {}
        : await leadershipGovernanceReview(modelExecutor, { ...authoritativeInput, baselineContext }).catch(() => ({}));
      const baseline = input.trustedGovernanceReview === true ? input.baseline || {}
        : baselineContext.sampleCount >= 5 ? historicalBaseline(baselineContext, authoritativeInput) : { available: false, passed: false, uplift: 0 };
      const evaluation = calculateLeadershipEvaluation({ ...authoritativeInput,
        deterministic: { ...(authoritativeInput.deterministic || {}), baselineUplift: baseline.uplift || 0 }, baseline,
        governanceReview,
        evidenceRefs: authoritativeInput.evidenceRefs?.length ? authoritativeInput.evidenceRefs : [`task:${authoritativeInput.taskId}`] });
      evaluation.baseline = baseline;
      if (!evaluation.taskId) throw codedError('leadership_task_required', 'Leadership evaluation requires a task id.', 400);
      const id = stableId('leval', instance.id, evaluation.taskId, evaluation.assignmentId, LEADERSHIP_ALGORITHM_VERSION);
      db.prepare(`INSERT INTO cloud_agent_leadership_evaluations
        (id,owner_user_id,user_agent_instance_id,task_id,assignment_id,algorithm_version,score,evaluation_json,completed_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(user_agent_instance_id,task_id,assignment_id,algorithm_version) DO UPDATE SET
        score=excluded.score,evaluation_json=excluded.evaluation_json,completed_at=excluded.completed_at`)
        .run(id, instance.user_id, instance.id, evaluation.taskId, evaluation.assignmentId, LEADERSHIP_ALGORITHM_VERSION,
          evaluation.score, JSON.stringify(evaluation), evaluation.completedAt);
      if (evaluation.assignmentMode === 'trial' && evaluation.assignmentId) {
        db.prepare("UPDATE cloud_leadership_promotion_actions SET status='consumed',updated_at=? WHERE id=? AND owner_user_id=? AND user_agent_instance_id=? AND action='trial_approved' AND status='approved'")
          .run(new Date().toISOString(), evaluation.assignmentId, instance.user_id, instance.id);
      }
      return { id, ...evaluation };
    },

    calculate({ agentInstanceId = '', now = new Date(), migrationBackfill = false } = {}) {
      const instance = db.prepare('SELECT * FROM cloud_user_agent_instances_v3 WHERE id=?').get(agentInstanceId);
      if (!instance) throw codedError('agent_instance_not_found', 'Agent instance was not found.', 404);
      let current = db.prepare('SELECT * FROM cloud_agent_leadership_levels WHERE user_agent_instance_id=?').get(instance.id);
      if (!current) {
        db.prepare(`INSERT INTO cloud_agent_leadership_levels
          (user_agent_instance_id,owner_user_id,agent_family_id,score,level,provisional,status,payload_json)
          VALUES (?,?,?,0,'L0',1,'active','{}')`).run(instance.id, instance.user_id, instance.agent_family_id);
        current = db.prepare('SELECT * FROM cloud_agent_leadership_levels WHERE user_agent_instance_id=?').get(instance.id);
      }
      const evaluations = db.prepare(`SELECT evaluation_json FROM cloud_agent_leadership_evaluations
        WHERE user_agent_instance_id=? AND completed_at>=? ORDER BY completed_at DESC LIMIT 100`)
        .all(instance.id, new Date(now.getTime() - 90 * 86400000).toISOString()).map((row) => parse(row.evaluation_json));
      const snapshot = calculateLeadershipSnapshot(evaluations, { now, currentLevel: current.level, status: current.status });
      const previousPayload = parse(current.payload_json);
      const safetyOverrideInputHash = previousPayload.safetyOverrideInputHash || '';
      const effectiveSevereSafetyViolation = snapshot.severeSafetyViolation && safetyOverrideInputHash !== snapshot.severeSafetyInputHash;
      const policySnapshot = { ...snapshot, severeSafetyViolation: effectiveSevereSafetyViolation,
        status: effectiveSevereSafetyViolation ? 'frozen' : current.status === 'inactive' ? 'inactive' : 'active' };
      const migrationBackfillLocked = current.level === 'L0' && previousPayload.migrationBackfillInputHash === snapshot.inputHash;
      const performance = db.prepare('SELECT * FROM cloud_agent_performance_levels WHERE user_agent_instance_id=?').get(instance.id) || {};
      const evidenceReadiness = applyPromotionCooldown(leadershipPromotionReadiness({ ...policySnapshot.promotion, currentLevel: current.level, score: policySnapshot.score,
        taskCount: policySnapshot.leadershipTaskCount, teamLeadTrialCount: policySnapshot.teamLeadTrialCount,
        crossTeamTrialCount: policySnapshot.crossTeamTrialCount, crossDepartmentTaskCount: policySnapshot.crossDepartmentTaskCount,
        baselineComparisonCount: policySnapshot.baselineComparisonCount,
        baselineUplift: policySnapshot.baselineUplift, professionalLevel: performance.level || '', professionalProvisional: performance.provisional !== 0,
        governanceApproved: Boolean(policySnapshot.governanceApproved), severeSafetyViolation: effectiveSevereSafetyViolation }), current.level_changed_at, now);
      const promotionSettlement = settlePromotionWindow(evidenceReadiness, previousPayload.promotionSettlement, policySnapshot, now);
      const readiness = { ...evidenceReadiness, evidenceReady: evidenceReadiness.ready,
        ready: evidenceReadiness.ready && promotionSettlement.confirmed, promotionSettlement,
        reasons: evidenceReadiness.ready && !promotionSettlement.confirmed
          ? [...new Set([...(evidenceReadiness.reasons || []), 'monthly_windows_insufficient'])] : evidenceReadiness.reasons };
      const effectiveMigrationBackfill = Boolean(migrationBackfill || migrationBackfillLocked);
      const applied = applyAutomaticPolicy(db, { instance, current, snapshot: policySnapshot, readiness, migrationBackfill: effectiveMigrationBackfill, now });
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
      db.prepare(`INSERT OR IGNORE INTO cloud_agent_leadership_history
        (id,user_agent_instance_id,algorithm_version,input_hash,score,level,provisional,status,payload_json)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(historyId, instance.id, LEADERSHIP_ALGORITHM_VERSION, snapshot.inputHash || 'empty', snapshot.score,
          finalLevel, snapshot.provisional ? 1 : 0, finalStatus, JSON.stringify(payload));
      db.prepare(`UPDATE cloud_agent_leadership_levels SET score=?,level=?,provisional=?,status=?,leadership_task_count=?,state_revision=?,
        consecutive_low_windows=?,last_low_input_hash=?,last_low_evaluated_at=?,last_low_task_count=?,level_changed_at=CASE WHEN level<>? THEN ? ELSE level_changed_at END,
        payload_json=?,updated_at=? WHERE user_agent_instance_id=?`).run(snapshot.score, finalLevel, snapshot.provisional ? 1 : 0,
        finalStatus, snapshot.leadershipTaskCount, nextStateRevision, applied.consecutiveLowWindows, applied.lastLowInputHash,
        applied.lastLowEvaluatedAt, applied.lastLowTaskCount, finalLevel,
        applied.levelChanged ? now.toISOString() : current.level_changed_at || '', JSON.stringify(payload), now.toISOString(), instance.id);
      if (readiness.ready && ((readiness.approvalRequired && !effectiveMigrationBackfill) || (migrationBackfill && readiness.targetLevel === 'L1'))) {
        ensurePromotionProposal(db, instance, current.level, readiness.targetLevel, payload);
      }
      return { authority: 'cloud', agentInstanceId: instance.id, agentFamilyId: instance.agent_family_id, ...payload };
    },

    calculateAll({ migrationBackfill = false } = {}) {
      this.ensureProfiles();
      return db.prepare("SELECT id FROM cloud_user_agent_instances_v3 WHERE status='active' AND sync_enabled=1 AND instance_kind='employee'").all()
        .map((row) => this.calculate({ agentInstanceId: row.id, migrationBackfill }));
    },

    status({ agentInstanceId = '' } = {}) {
      const row = db.prepare('SELECT * FROM cloud_agent_leadership_levels WHERE user_agent_instance_id=?').get(agentInstanceId);
      return row ? { authority: 'cloud', ...parse(row.payload_json), agentInstanceId: row.user_agent_instance_id, agentFamilyId: row.agent_family_id,
        ownerUserId: row.owner_user_id, score: Number(row.score), level: row.level, provisional: Boolean(row.provisional), status: row.status,
        leadershipTaskCount: row.leadership_task_count, stateRevision: Number(row.state_revision || 0) } : null;
    },

    history({ agentInstanceId = '', limit = 30 } = {}) {
      return db.prepare('SELECT * FROM cloud_agent_leadership_history WHERE user_agent_instance_id=? ORDER BY created_at DESC LIMIT ?')
        .all(agentInstanceId, Math.min(100, Math.max(1, Number(limit || 30)))).map((row) => ({ id: row.id, ...parse(row.payload_json), createdAt: row.created_at }));
    },

    actions({ ownerUserId = '', actorRole = '', agentInstanceId = '', status = '', limit = 50 } = {}) {
      const clauses = [];
      const values = [];
      if (String(actorRole || '').toLowerCase() !== 'admin') { clauses.push('owner_user_id=?'); values.push(ownerUserId); }
      if (agentInstanceId) { clauses.push('user_agent_instance_id=?'); values.push(agentInstanceId); }
      if (status) { clauses.push('status=?'); values.push(status); }
      values.push(Math.min(100, Math.max(1, Number(limit || 50))));
      return db.prepare(`SELECT * FROM cloud_leadership_promotion_actions${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`)
        .all(...values).map(actionPayload);
    },

    requestTrial({ ownerUserId = '', agentInstanceId = '', role = 'task_lead', participantCount = 1, nodeCount = 1, departmentCount = 1, commandId = '', expectedStateRevision } = {}) {
      const instance = ownedInstance(db, ownerUserId, agentInstanceId);
      const leadership = this.status({ agentInstanceId }) || this.calculate({ agentInstanceId });
      assertExpectedRevision(leadership, expectedStateRevision);
      const performance = db.prepare('SELECT * FROM cloud_agent_performance_levels WHERE user_agent_instance_id=?').get(agentInstanceId) || {};
      const eligibility = leadershipAssignmentEligibility({ level: leadership.level, status: leadership.status, role, assignmentMode: 'trial',
        participantCount, nodeCount, departmentCount, activeTaskGroups: activeLeadershipGroups(db, agentInstanceId), ownerApproved: true, governanceApproved: true,
        professionalLevel: performance.level || '', professionalProvisional: performance.provisional !== 0 });
      if (!eligibility.eligible) throw codedError('leadership_trial_ineligible', 'Leadership trial is not eligible.', 409, { reasons: eligibility.reasons });
      const governanceRequired = leadership.level === 'L2';
      return insertAction(db, { ownerUserId, agentInstanceId, action: governanceRequired ? 'trial_requested' : 'trial_approved', fromLevel: leadership.level,
        toLevel: nextLeadershipLevel(leadership.level), status: governanceRequired ? 'pending' : 'approved', commandId, actorId: ownerUserId,
        reason: governanceRequired ? `Requested governed ${role} trial.` : `Owner approved supervised ${role} trial.`,
        evidence: { role, participantCount, nodeCount, departmentCount, eligibility, agentFamilyId: instance.agent_family_id,
          stateRevision: leadership.stateRevision,
          requiredReviewer: leadership.level === 'L2' ? 'cloud_governance' : 'department_hr' } });
    },

    decideAction({ actorUserId = '', actorRole = '', actionId = '', decision = '', commandId = '', reason = '', expectedStateRevision } = {}) {
      assertGovernanceActor(actorRole);
      const action = db.prepare('SELECT * FROM cloud_leadership_promotion_actions WHERE id=?').get(actionId);
      if (!action) throw codedError('leadership_action_not_found', 'Leadership action was not found.', 404);
      if (action.status !== 'pending') return actionPayload(action);
      const leadership = this.status({ agentInstanceId: action.user_agent_instance_id });
      assertExpectedRevision(leadership, expectedStateRevision);
      const normalized = String(decision || '').toLowerCase();
      if (!['approve', 'reject'].includes(normalized)) throw codedError('invalid_leadership_decision', 'Decision must be approve or reject.', 400);
      const now = new Date().toISOString();
      if (normalized === 'approve' && action.action === 'promote') {
        db.prepare(`UPDATE cloud_agent_leadership_levels SET level=?,state_revision=state_revision+1,level_changed_at=?,consecutive_low_windows=0,last_low_input_hash='',last_low_evaluated_at='',last_low_task_count=0,updated_at=?
          WHERE owner_user_id=? AND user_agent_instance_id=?`).run(action.to_level, now, now, action.owner_user_id, action.user_agent_instance_id);
      }
      if (normalized === 'approve' && action.action === 'restore') {
        const current = this.status({ agentInstanceId: action.user_agent_instance_id });
        const restoredPayload = { ...current, status: 'active', reviewState: 'stable', safetyOverrideInputHash: current?.severeSafetyInputHash || '' };
        db.prepare("UPDATE cloud_agent_leadership_levels SET status='active',state_revision=state_revision+CASE WHEN status<>'active' THEN 1 ELSE 0 END,consecutive_low_windows=0,last_low_input_hash='',last_low_evaluated_at='',last_low_task_count=0,payload_json=?,updated_at=? WHERE owner_user_id=? AND user_agent_instance_id=?")
          .run(JSON.stringify(restoredPayload), now, action.owner_user_id, action.user_agent_instance_id);
      }
      const nextAction = normalized === 'approve' && action.action === 'trial_requested' ? 'trial_approved' : action.action;
      db.prepare("UPDATE cloud_leadership_promotion_actions SET action=?,status=?,command_id=CASE WHEN command_id='' THEN ? ELSE command_id END,actor_id=?,reason=?,updated_at=? WHERE id=?")
        .run(nextAction, normalized === 'approve' ? 'approved' : 'rejected', commandId || '', actorUserId, reason || normalized, now, action.id);
      return actionPayload(db.prepare('SELECT * FROM cloud_leadership_promotion_actions WHERE id=?').get(action.id));
    },

    restore({ ownerUserId = '', agentInstanceId = '', commandId = '', reason = '', expectedStateRevision } = {}) {
      ownedInstance(db, ownerUserId, agentInstanceId);
      const current = this.status({ agentInstanceId });
      assertExpectedRevision(current, expectedStateRevision);
      if (current?.status !== 'frozen') throw codedError('leadership_not_frozen', 'Leadership restoration is only available for frozen profiles.', 409);
      return insertAction(db, { ownerUserId, agentInstanceId, action: 'restore', fromLevel: current?.level || 'L0', toLevel: current?.level || 'L0',
        status: 'pending', commandId, actorId: ownerUserId, reason: reason || 'Owner requested governance review for leadership restoration.', evidence: current || {} });
    },

    submitAppeal({ ownerUserId = '', agentInstanceId = '', leadershipActionId = '', appealKind = 'assessment', reason = '', commandId = '' } = {}) {
      ownedInstance(db, ownerUserId, agentInstanceId);
      if (!String(reason || '').trim()) throw codedError('leadership_appeal_reason_required', 'Leadership appeal requires a reason.', 400);
      if (commandId) {
        const existing = db.prepare('SELECT * FROM cloud_leadership_appeals WHERE owner_user_id=? AND command_id=?').get(ownerUserId, commandId);
        if (existing) return appealPayload(existing);
      }
      const id = stableId('lappeal', ownerUserId, agentInstanceId, commandId || crypto.randomUUID());
      const current = this.status({ agentInstanceId });
      db.prepare(`INSERT INTO cloud_leadership_appeals
        (id,owner_user_id,user_agent_instance_id,leadership_action_id,appeal_kind,status,command_id,submitted_reason,evidence_snapshot_json)
        VALUES (?,?,?,?,?,'pending',?,?,?)`).run(id, ownerUserId, agentInstanceId, leadershipActionId, normalizeAppealKind(appealKind),
          commandId, String(reason).trim(), JSON.stringify(current || {}));
      return appealPayload(db.prepare('SELECT * FROM cloud_leadership_appeals WHERE id=?').get(id));
    },

    appeals({ ownerUserId = '', actorRole = '', agentInstanceId = '', status = '', limit = 50 } = {}) {
      const admin = String(actorRole || '').toLowerCase() === 'admin';
      const clauses = [];
      const values = [];
      if (!admin) { clauses.push('owner_user_id=?'); values.push(ownerUserId); }
      if (agentInstanceId) { clauses.push('user_agent_instance_id=?'); values.push(agentInstanceId); }
      if (status) { clauses.push('status=?'); values.push(status); }
      values.push(Math.min(100, Math.max(1, Number(limit || 50))));
      return db.prepare(`SELECT * FROM cloud_leadership_appeals${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`)
        .all(...values).map(appealPayload);
    },

    decideAppeal({ actorUserId = '', actorRole = '', appealId = '', decision = '', reason = '' } = {}) {
      assertGovernanceActor(actorRole);
      const normalized = String(decision || '').toLowerCase();
      if (!['approve', 'reject'].includes(normalized)) throw codedError('invalid_leadership_decision', 'Decision must be approve or reject.', 400);
      const now = new Date().toISOString();
      const result = db.prepare("UPDATE cloud_leadership_appeals SET status=?,reviewer_user_id=?,reviewer_reason=?,updated_at=? WHERE id=? AND status='pending'")
        .run(normalized === 'approve' ? 'approved' : 'rejected', actorUserId, reason || normalized, now, appealId);
      if (!result.changes) throw codedError('leadership_appeal_not_found', 'Pending Leadership appeal was not found.', 404);
      return appealPayload(db.prepare('SELECT * FROM cloud_leadership_appeals WHERE id=?').get(appealId));
    },

    assignmentEligibility(input = {}) {
      const leadership = this.status({ agentInstanceId: input.agentInstanceId }) || { level: 'L0', status: 'active' };
      const performance = db.prepare('SELECT * FROM cloud_agent_performance_levels WHERE user_agent_instance_id=?').get(input.agentInstanceId) || {};
      return leadershipAssignmentEligibility({ ...input, level: leadership.level, status: leadership.status,
        professionalLevel: performance.level || '', professionalProvisional: performance.provisional !== 0,
        activeTaskGroups: input.activeTaskGroups ?? activeLeadershipGroups(db, input.agentInstanceId) });
    },
  };
}

function applyAutomaticPolicy(db, { instance, current, snapshot, readiness, migrationBackfill, now }) {
  let level = normalizeLeadershipLevel(current.level);
  let status = snapshot.status;
  let consecutiveLowWindows = Number(current.consecutive_low_windows || 0);
  let lastLowInputHash = current.last_low_input_hash || '';
  let lastLowEvaluatedAt = current.last_low_evaluated_at || '';
  let lastLowTaskCount = Number(current.last_low_task_count || 0);
  let levelChanged = false;
  if (snapshot.severeSafetyViolation && current.status !== 'frozen') {
    insertAction(db, { ownerUserId: instance.user_id, agentInstanceId: instance.id, action: 'freeze', fromLevel: level, toLevel: level,
      status: 'approved', actorId: 'cloud_governance', reason: 'Severe leadership safety violation.', evidence: snapshot });
    status = 'frozen';
    db.prepare("UPDATE cloud_leadership_assignments SET status='revoked',valid_until=CASE WHEN valid_until='' OR valid_until>? THEN ? ELSE valid_until END,updated_at=? WHERE user_id=? AND agent_instance_id=? AND status='active'")
      .run(now.toISOString(), now.toISOString(), now.toISOString(), instance.user_id, instance.id);
  }
  if (!migrationBackfill && readiness.ready && readiness.automatic && status === 'active') {
    const next = readiness.targetLevel;
    insertAction(db, { ownerUserId: instance.user_id, agentInstanceId: instance.id, action: 'promote', fromLevel: level, toLevel: next,
      status: 'approved', actorId: 'cloud_governance', reason: 'Automatic L0 to L1 promotion.', evidence: snapshot });
    level = next;
    levelChanged = true;
    db.prepare("UPDATE cloud_leadership_promotion_actions SET status='superseded',updated_at=? WHERE owner_user_id=? AND user_agent_instance_id=? AND action='promote' AND to_level=? AND status='pending'")
      .run(now.toISOString(), instance.user_id, instance.id, next);
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
      levelChanged = true;
      consecutiveLowWindows = 0;
      lastLowInputHash = '';
      lastLowEvaluatedAt = '';
      lastLowTaskCount = 0;
      insertAction(db, { ownerUserId: instance.user_id, agentInstanceId: instance.id, action: 'demote', fromLevel: previous, toLevel: level,
        status: 'approved', actorId: 'cloud_governance', reason: 'Two mature leadership windows were below the level threshold.', evidence: snapshot });
      const drainUntil = new Date(now.getTime() + 24 * 3600000).toISOString();
      db.prepare("UPDATE cloud_leadership_assignments SET status='draining',valid_until=CASE WHEN valid_until='' OR valid_until>? THEN ? ELSE valid_until END,updated_at=? WHERE user_id=? AND agent_instance_id=? AND status='active'")
        .run(drainUntil, drainUntil, now.toISOString(), instance.user_id, instance.id);
    }
  } else if (snapshot.score >= threshold) {
    consecutiveLowWindows = 0;
    lastLowInputHash = '';
    lastLowEvaluatedAt = '';
    lastLowTaskCount = 0;
  }
  return { level, status, consecutiveLowWindows, lastLowInputHash, lastLowEvaluatedAt, lastLowTaskCount, levelChanged, now };
}

function ensurePromotionProposal(db, instance, fromLevel, toLevel, evidence) {
  const existing = db.prepare("SELECT id FROM cloud_leadership_promotion_actions WHERE owner_user_id=? AND user_agent_instance_id=? AND action='promote' AND to_level=? AND status='pending'")
    .get(instance.user_id, instance.id, toLevel);
  if (existing) return existing;
  return insertAction(db, { ownerUserId: instance.user_id, agentInstanceId: instance.id, action: 'promote', fromLevel, toLevel,
    status: 'pending', actorId: 'cloud_governance', reason: `${toLevel} promotion evidence is ready for governance review.`,
    evidence: { ...evidence, requiredReviewer: toLevel === 'L3' ? 'cloud_admin' : 'department_hr' } });
}

function insertAction(db, { ownerUserId, agentInstanceId, action, fromLevel = 'L0', toLevel = 'L0', status = 'pending', commandId = '', actorId = '', reason = '', evidence = {} }) {
  if (commandId) {
    const existing = db.prepare('SELECT * FROM cloud_leadership_promotion_actions WHERE owner_user_id=? AND command_id=?').get(ownerUserId, commandId);
    if (existing) return actionPayload(existing);
  }
  const id = stableId('laction', ownerUserId, agentInstanceId, action, commandId || crypto.randomUUID());
  db.prepare(`INSERT INTO cloud_leadership_promotion_actions
    (id,owner_user_id,user_agent_instance_id,action,from_level,to_level,status,command_id,actor_id,reason,evidence_snapshot_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, ownerUserId, agentInstanceId, action, fromLevel, toLevel, status, commandId, actorId, reason, JSON.stringify(evidence));
  return actionPayload(db.prepare('SELECT * FROM cloud_leadership_promotion_actions WHERE id=?').get(id));
}

function ownedInstance(db, ownerUserId, agentInstanceId) {
  const row = db.prepare('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=? AND id=?').get(ownerUserId, agentInstanceId);
  if (!row) throw codedError('agent_instance_not_found', 'Agent instance does not belong to the user.', 404);
  return row;
}

function activeLeadershipGroups(db, agentInstanceId) {
  return Number(db.prepare("SELECT COUNT(DISTINCT a.work_scope_id) AS count FROM cloud_leadership_assignments a JOIN cloud_work_scopes s ON s.id=a.work_scope_id WHERE a.agent_instance_id=? AND a.status='active' AND s.status='active' AND (a.valid_until IS NULL OR a.valid_until='' OR a.valid_until>?)")
    .get(agentInstanceId, new Date().toISOString())?.count || 0);
}

function actionPayload(row = {}) { return { id: row.id, ownerUserId: row.owner_user_id, agentInstanceId: row.user_agent_instance_id, action: row.action, fromLevel: row.from_level,
  toLevel: row.to_level, status: row.status, commandId: row.command_id || '', actorId: row.actor_id || '', reason: row.reason || '',
  evidence: parse(row.evidence_snapshot_json), createdAt: row.created_at, updatedAt: row.updated_at }; }
function appealPayload(row = {}) { return { id: row.id, ownerUserId: row.owner_user_id, agentInstanceId: row.user_agent_instance_id, leadershipActionId: row.leadership_action_id || '',
  appealKind: row.appeal_kind, status: row.status, commandId: row.command_id || '', submittedReason: row.submitted_reason || '',
  reviewerUserId: row.reviewer_user_id || '', reviewerReason: row.reviewer_reason || '', evidence: parse(row.evidence_snapshot_json),
  createdAt: row.created_at, updatedAt: row.updated_at }; }
function parse(value) { try { return JSON.parse(value || '{}'); } catch { return {}; } }
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

function sqliteBaselineContext(db, input = {}) {
  const cutoff = new Date(Date.now() - 180 * 86400000).toISOString();
  const comparable = db.prepare('SELECT evaluation_json FROM cloud_agent_leadership_evaluations WHERE completed_at>=? ORDER BY completed_at DESC LIMIT 500')
    .all(cutoff).map((row) => parse(row.evaluation_json)).filter((item) => item.taskTypeKey === String(input.taskTypeKey || 'general')
      && (!input.agentInstanceId || item.agentInstanceId !== input.agentInstanceId)
      && Math.abs(Number(item.participantCount || 1) - Number(input.participantCount || 1)) <= 1
      && Number(item.departmentCount || 1) === Number(input.departmentCount || 1)
      && Number(item.operational?.actualDurationMs || 0) > 0);
  return { sampleCount: comparable.length, medianDurationMs: median(comparable.map((item) => Number(item.operational?.actualDurationMs || 0))),
    referenceId: comparable.length ? stableId('lbaseline', ...comparable.map((item) => item.taskId).sort()) : '' };
}

function sqliteAuthoritativeTaskInput(db, instance, input = {}) {
  const row = db.prepare('SELECT * FROM cloud_task_runs WHERE id=?').get(input.taskId || '');
  if (!row) throw codedError('leadership_task_not_synchronized', 'Leadership task must be synchronized before evaluation.', 409);
  const run = parse(row.payload_json);
  const ownerUserId = row.owner_user_id || run.ownerUserId || run.owner_user_id || '';
  if (ownerUserId && ownerUserId !== instance.user_id) throw codedError('leadership_task_owner_mismatch', 'Leadership task does not belong to the Agent owner.', 403);
  const leadAgentInstanceId = run.leadAgentInstanceId || run.lead_agent_instance_id || '';
  if (leadAgentInstanceId !== instance.id) throw codedError('leadership_task_leader_mismatch', 'Agent was not the synchronized task leader.', 409);
  const metadata = run.metadata || run.metadata_json || {};
  if (!metadata.leadershipAssessmentEligible && !metadata.leadershipAssignmentId) throw codedError('leadership_task_not_eligible', 'Task did not contain an authorized leadership appointment.', 409);
  const nodes = db.prepare('SELECT * FROM cloud_task_nodes WHERE task_run_id=? ORDER BY updated_at').all(row.id).map((node) => ({ id: node.id, ...parse(node.payload_json) }));
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
  return `You are the Janus cloud Leadership evaluator. Return JSON only. Score only from the supplied task facts and evidence references.
Do not reward the leader for doing all node work. Judge whether delegation, context, review, conflict handling, and coordination improved other Agents.
Schema: {"deliveryQuality":0-100,"decompositionMatching":0-100,"reviewReworkControl":0-100,"dependencyCoordination":0-100,"teamEfficiencyUplift":0-100,"decision":"approved|pending|rejected","baseline":{"available":true,"kind":"historical|shadow_replay","sampleCount":1,"uplift":0,"passed":false,"referenceId":"..."},"evidenceRefs":["..."]}.
Task facts:\n${JSON.stringify({ taskId: input.taskId, role: input.role, assignmentMode: input.assignmentMode,
    taskTypeKey: input.taskTypeKey, participantCount: input.participantCount, departmentCount: input.departmentCount,
    deterministic: input.deterministic, baseline: input.baseline, evidenceRefs: input.evidenceRefs })}`;
}

function parseModelJson(answer = '') {
  const text = String(answer || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || text;
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
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
