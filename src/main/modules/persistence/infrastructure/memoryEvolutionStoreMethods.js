import { all, get, run } from '../../../db.js';
import { classifyPrivacy, memoryMergeDecision, privateMemoryMarker } from '../../../memory.js';
import { newId, nowIso, safeJsonParse } from '../../../utils.js';
import { normalizeProject, normalizeSession, normalizeInteractionMode, normalizeWorkspacePath, requestCodexThreadReset, normalizeGoalStatus, compareSessionsForDisplay, normalizeMemoryEntryContent, normalizeSearchText, textMatchesQuery, compactPreviewText, messageMetadataSearchText, flattenSearchValues, searchMatchExcerpt, normalizeMessage, normalizeModelExecution, normalizeTaskRun, normalizeTaskNode, normalizeTaskEvent, normalizeTaskGraphRevision, normalizeCommunication, normalizeTaskRetrospective, normalizeMemoryEntry, normalizeMemoryAudit, normalizeEvolutionRun, normalizeArchive, normalizeSkillVersion, normalizeTypedMemory, normalizeHrReview, normalizeAgentEvolutionReview, normalizeGovernanceEvent, normalizePerformanceReview, normalizeSpecialistExperiment, normalizeWorkflowCredit } from '../domain/recordNormalizers.js';

export function installMemoryEvolutionStoreMethods(prototype) {
  Object.assign(prototype, {
  upsertMemoryEntry({
    scope,
    ownerId,
    userId = '',
    departmentId = '',
    agentId = '',
    agentInstanceId = '',
    memoryDocumentId = '',
    taskRunId = '',
    memoryType,
    content,
    lifecycleState = 'active',
    confidence = 0.5,
    privacyLevel = 'public_reusable',
    sourceKind = '',
    sourceId = '',
    reviewStatus = 'unreviewed',
    expiresAt = null,
    updateReason = '',
    reviewerId = '',
  }) {
    const resolvedMemoryDocumentId = memoryDocumentId || (agentInstanceId
      ? this.ensureDefaultMemoryDocument?.({ agentInstanceId })?.id || ''
      : '');
    const detectedPrivacy = classifyPrivacy(content, memoryType);
    const effectivePrivacy = detectedPrivacy === 'public_reusable' ? privacyLevel : detectedPrivacy;
    const shouldRedact = effectivePrivacy !== 'public_reusable';
    const storedContent = shouldRedact ? privateMemoryMarker(content, effectivePrivacy) : content;
    const effectiveLifecycle = shouldRedact ? 'blocked' : lifecycleState;
    const existing = get(
      this.db,
      `SELECT * FROM memory_entries
       WHERE scope = ? AND owner_id = ? AND memory_type = ? AND source_id = ?
       ORDER BY updated_at DESC LIMIT 1`,
      [scope, ownerId, memoryType, sourceId],
    );
    if (existing) {
      run(
        this.db,
        `UPDATE memory_entries
         SET user_id = ?, department_id = ?, agent_id = ?, agent_instance_id = ?, memory_document_id = ?, task_run_id = ?,
             content = ?, lifecycle_state = ?, confidence = ?, privacy_level = ?,
             review_status = ?, expires_at = ?, updated_at = ?
         WHERE id = ?`,
        [userId, departmentId, agentId, agentInstanceId, resolvedMemoryDocumentId, taskRunId,
          storedContent, effectiveLifecycle, confidence, effectivePrivacy, reviewStatus, expiresAt, nowIso(), existing.id],
      );
      run(
        this.db,
        `INSERT INTO memory_versions (
          id, memory_entry_id, old_content, new_content, update_reason,
          source_kind, source_id, reviewer_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId('memver'),
          existing.id,
          existing.privacy_level === 'public_reusable' ? existing.content : privateMemoryMarker(existing.content, existing.privacy_level),
          storedContent,
          updateReason,
          sourceKind,
          sourceId,
          reviewerId,
        ],
      );
      return this.getMemoryEntry(existing.id);
    }
    const id = newId('memory');
    run(
      this.db,
      `INSERT INTO memory_entries (
        id, scope, owner_id, user_id, department_id, agent_id, agent_instance_id,
        memory_document_id, task_run_id, memory_type,
        content, lifecycle_state, confidence, privacy_level, source_kind,
        source_id, review_status, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        scope,
        ownerId,
        userId,
        departmentId,
        agentId,
        agentInstanceId,
        resolvedMemoryDocumentId,
        taskRunId,
        memoryType,
        storedContent,
        effectiveLifecycle,
        confidence,
        effectivePrivacy,
        sourceKind,
        sourceId,
        reviewStatus,
        expiresAt,
      ],
    );
    return this.getMemoryEntry(id);
  },

  getMemoryEntry(id) {
    return normalizeMemoryEntry(get(this.db, 'SELECT * FROM memory_entries WHERE id = ?', [id]));
  },

  listMemoryEntries({ scope = '', ownerId = '', limit = 80 } = {}) {
    return all(
      this.db,
      `SELECT * FROM memory_entries
       WHERE (? = '' OR scope = ?)
         AND (? = '' OR owner_id = ?)
       ORDER BY updated_at DESC LIMIT ?`,
      [scope, scope, ownerId, ownerId, limit],
    ).map(normalizeMemoryEntry);
  },

  transitionMemoryEntry(id, {
    lifecycleState = '',
    confidence = null,
    privacyLevel = '',
    reviewStatus = '',
    expiresAt = undefined,
    updateReason = '',
    sourceKind = 'memory_lifecycle_policy',
    sourceId = '',
    reviewerId = 'memory_lifecycle_policy',
  } = {}) {
    const before = get(this.db, 'SELECT * FROM memory_entries WHERE id = ?', [id]);
    if (!before) return null;
    const nextLifecycleState = lifecycleState || before.lifecycle_state;
    const nextConfidence = confidence === null || confidence === undefined ? Number(before.confidence || 0) : Number(confidence);
    const nextPrivacyLevel = privacyLevel || before.privacy_level;
    const nextReviewStatus = reviewStatus || before.review_status;
    const nextExpiresAt = expiresAt === undefined ? before.expires_at : expiresAt;
    const safeContent = nextPrivacyLevel === 'public_reusable'
      ? before.content
      : privateMemoryMarker(before.content, nextPrivacyLevel);
    run(
      this.db,
      `UPDATE memory_entries
       SET content = ?, lifecycle_state = ?, confidence = ?, privacy_level = ?,
           review_status = ?, expires_at = ?, updated_at = ?
       WHERE id = ?`,
      [safeContent, nextLifecycleState, nextConfidence, nextPrivacyLevel, nextReviewStatus, nextExpiresAt, nowIso(), id],
    );
    run(
      this.db,
      `INSERT INTO memory_versions (
        id, memory_entry_id, old_content, new_content, update_reason,
        source_kind, source_id, reviewer_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId('memver'),
        id,
        safeContent,
        safeContent,
        updateReason || `Lifecycle ${before.lifecycle_state} -> ${nextLifecycleState}`,
        sourceKind,
        sourceId,
        reviewerId,
      ],
    );
    return this.getMemoryEntry(id);
  },

  applyMemoryLifecyclePolicy({
    scope = '',
    ownerId = '',
    now = new Date(),
    dryRun = false,
    staleDays = 90,
    candidateDays = 30,
    shortTermDays = 7,
    lowConfidenceThreshold = 0.35,
  } = {}) {
    const rows = this.listMemoryEntries({ scope, ownerId, limit: 5000 })
      .filter((row) => !['archived', 'deleted', 'blocked'].includes(row.lifecycleState));
    const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
    const actions = [];
    const seen = new Map();
    const sorted = [...rows].sort((left, right) => {
      const confidenceDelta = Number(right.confidence || 0) - Number(left.confidence || 0);
      if (confidenceDelta) return confidenceDelta;
      const rightUpdated = Date.parse(right.updatedAt || '') || 0;
      const leftUpdated = Date.parse(left.updatedAt || '') || 0;
      return rightUpdated - leftUpdated;
    });

    const enqueue = (row, action, nextState, reason, extra = {}) => {
      if (actions.some((item) => item.memoryEntryId === row.id)) return;
      actions.push({
        action,
        memoryEntryId: row.id,
        scope: row.scope,
        ownerId: row.ownerId,
        memoryType: row.memoryType,
        fromState: row.lifecycleState,
        toState: nextState,
        reason,
        ...extra,
      });
    };

    for (const row of sorted) {
      const key = `${row.scope}:${row.ownerId}:${row.memoryType}:${normalizeMemoryEntryContent(row.content)}`;
      if (!seen.has(key)) {
        seen.set(key, row);
      } else {
        enqueue(row, 'archive_duplicate', 'archived', `Duplicate of memory ${seen.get(key).id}.`, {
          canonicalMemoryEntryId: seen.get(key).id,
        });
      }
    }

    const conflictBaselines = new Map();
    for (const row of sorted) {
      if (actions.some((item) => item.memoryEntryId === row.id)) continue;
      if (row.privacyLevel !== 'public_reusable') continue;
      const groupKey = `${row.scope}:${row.ownerId}:${row.memoryType}`;
      const baselines = conflictBaselines.get(groupKey) || [];
      const conflict = baselines.find((candidate) => memoryMergeDecision(candidate.content, row.content).method === 'blocked_conflict');
      if (conflict) {
        enqueue(row, 'flag_conflict', 'candidate', `Conflicts with memory ${conflict.id}; requires HR or project-level review before reuse.`, {
          conflictWithMemoryEntryId: conflict.id,
        });
        continue;
      }
      baselines.push(row);
      conflictBaselines.set(groupKey, baselines);
    }

    for (const row of rows) {
      const updatedMs = Date.parse(row.updatedAt || row.createdAt || '');
      const ageDays = Number.isFinite(updatedMs) ? (nowMs - updatedMs) / (24 * 60 * 60 * 1000) : 0;
      const expiresMs = row.expiresAt ? Date.parse(row.expiresAt) : NaN;
      if (row.memoryType === 'do_not_store') {
        enqueue(row, 'forbid_reuse', 'blocked', 'Only a redacted policy fingerprint is retained; the original do-not-store content cannot be reused.', {
          privacyLevel: 'privacy_policy',
        });
        continue;
      }
      if (Number.isFinite(expiresMs) && expiresMs <= nowMs) {
        enqueue(row, 'archive_expired', 'archived', `Memory expired at ${row.expiresAt}.`);
        continue;
      }
      if (row.privacyLevel !== 'public_reusable') {
        enqueue(row, 'block_private', 'blocked', `Privacy level ${row.privacyLevel} is not reusable.`);
        continue;
      }
      if (row.lifecycleState === 'candidate' && ageDays >= candidateDays && row.confidence < lowConfidenceThreshold) {
        enqueue(row, 'archive_stale_candidate', 'archived', `Candidate stayed low-confidence for ${Math.floor(ageDays)} days.`);
        continue;
      }
      if (row.scope === 'short_term' && ageDays >= shortTermDays) {
        enqueue(row, 'archive_stale_short_term', 'archived', `Short-term memory exceeded ${shortTermDays} days.`);
        continue;
      }
      if (ageDays >= staleDays && row.confidence < lowConfidenceThreshold) {
        enqueue(row, 'archive_low_confidence_stale', 'archived', `Low-confidence memory stayed stale for ${Math.floor(ageDays)} days.`);
      }
    }

    if (!dryRun) {
      for (const action of actions) {
        this.transitionMemoryEntry(action.memoryEntryId, {
          lifecycleState: action.toState,
          privacyLevel: action.privacyLevel || '',
          reviewStatus: action.action,
          updateReason: action.reason,
          sourceKind: 'memory_lifecycle_policy',
          sourceId: action.canonicalMemoryEntryId || action.conflictWithMemoryEntryId || '',
          reviewerId: 'memory_lifecycle_policy',
        });
      }
    }
    const audit = this.recordMemoryAudit({ scope, ownerId, actions });
    return {
      audit,
      actions,
      applied: dryRun ? 0 : actions.length,
      dryRun,
    };
  },

  recordMemoryAudit({ scope = '', ownerId = '', actions = [] } = {}) {
    const rows = this.listMemoryEntries({ scope, ownerId, limit: 1000 });
    const normalized = new Map();
    let duplicateCount = 0;
    let staleCount = 0;
    let lowConfidenceCount = 0;
    let privacyRiskCount = 0;
    let migrationCandidateCount = 0;
    const now = Date.now();
    for (const row of rows) {
      const key = `${row.scope}:${row.ownerId}:${row.memoryType}:${row.content.toLowerCase().replace(/\s+/g, ' ').trim()}`;
      if (normalized.has(key)) duplicateCount += 1;
      normalized.set(key, row.id);
      if (row.updatedAt && now - Date.parse(row.updatedAt) > 90 * 24 * 60 * 60 * 1000) staleCount += 1;
      if (row.confidence < 0.35) lowConfidenceCount += 1;
      if (row.privacyLevel !== 'public_reusable') privacyRiskCount += 1;
      if (row.reviewStatus === 'needs_hr_review' || row.lifecycleState === 'candidate') migrationCandidateCount += 1;
    }
    const id = newId('audit');
    run(
      this.db,
      `INSERT INTO memory_audits (
        id, scope, owner_id, duplicate_count, stale_count, low_confidence_count,
        privacy_risk_count, migration_candidate_count, actions_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        scope,
        ownerId,
        duplicateCount,
        staleCount,
        lowConfidenceCount,
        privacyRiskCount,
        migrationCandidateCount,
        JSON.stringify(actions),
      ],
    );
    return this.getMemoryAudit(id);
  },

  getMemoryAudit(id) {
    return normalizeMemoryAudit(get(this.db, 'SELECT * FROM memory_audits WHERE id = ?', [id]));
  },

  recordGovernanceEvent({
    departmentId = '',
    agentId = '',
    eventType,
    status = '',
    evidenceCount = 0,
    confidence = 0,
    rationale = '',
    migrationPlan = '',
    payload = {},
    sourceReviewId = '',
  }) {
    const id = newId('gov');
    run(
      this.db,
      `INSERT INTO agent_governance_events (
        id, department_id, agent_id, event_type, status, evidence_count,
        confidence, rationale, migration_plan, payload_json, source_review_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        departmentId,
        agentId,
        eventType,
        status,
        evidenceCount,
        confidence,
        rationale,
        migrationPlan,
        JSON.stringify(payload),
        sourceReviewId,
      ],
    );
    return id;
  },

  recordPerformanceReview({
    departmentId = '',
    agentId,
    userId = '',
    agentFamilyId = '',
    userAgentInstanceId = '',
    reviewType = 'periodic',
    rating = 'observe',
    taskCount = 0,
    successCount = 0,
    failureCount = 0,
    communicationCount = 0,
    memoryHealth = {},
    recommendation = '',
    score = 0,
    scenarioMetrics = {},
    skillVersionId = '',
    skillHash = '',
    sourceReviewId = '',
  }) {
    const id = newId('review');
    run(
      this.db,
      `INSERT INTO agent_performance_reviews (
        id, department_id, agent_id, user_id, agent_family_id, user_agent_instance_id,
        review_type, rating, task_count,
        success_count, failure_count, communication_count, memory_health_json,
        recommendation, score, scenario_metrics_json, skill_version_id, skill_hash,
        source_review_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        departmentId,
        agentId,
        userId,
        agentFamilyId || agentId,
        userAgentInstanceId,
        reviewType,
        rating,
        taskCount,
        successCount,
        failureCount,
        communicationCount,
        JSON.stringify(memoryHealth),
        recommendation,
        Number(score || 0),
        JSON.stringify(scenarioMetrics || {}),
        skillVersionId,
        skillHash,
        sourceReviewId,
      ],
    );
    return id;
  },

  evolutionOverview() {
    const latestRuns = all(
      this.db,
      `SELECT * FROM evolution_runs ORDER BY created_at DESC LIMIT 20`,
    );
    const archives = all(
      this.db,
      `SELECT ea.*,
              l.label AS latest_label,
              l.label_source AS latest_label_source,
              l.confidence AS latest_label_confidence,
              l.rationale AS latest_label_rationale,
              l.synthetic AS latest_label_synthetic,
              l.created_at AS latest_label_created_at
       FROM evolution_archives ea
       LEFT JOIN evolution_archive_labels l
         ON l.id = (
           SELECT id FROM evolution_archive_labels
           WHERE run_id = ea.run_id
           ORDER BY created_at DESC, rowid DESC LIMIT 1
         )
       ORDER BY ea.created_at DESC LIMIT 20`,
    );
    const memories = all(
      this.db,
      `SELECT * FROM typed_memories WHERE status = 'active' ORDER BY updated_at DESC LIMIT 40`,
    );
    const hrReviews = all(
      this.db,
      `SELECT * FROM hr_reviews ORDER BY created_at DESC LIMIT 20`,
    );
    const agentEvolutionReviews = all(
      this.db,
      `SELECT * FROM agent_evolution_reviews ORDER BY created_at DESC LIMIT 20`,
    );
    const governanceEvents = all(
      this.db,
      `SELECT * FROM agent_governance_events ORDER BY created_at DESC LIMIT 30`,
    );
    const performanceReviews = all(
      this.db,
      `SELECT * FROM agent_performance_reviews ORDER BY created_at DESC LIMIT 30`,
    );
    const specialistExperiments = all(
      this.db,
      `SELECT * FROM specialist_experiments ORDER BY created_at DESC LIMIT 30`,
    );
    const workflowCredits = all(
      this.db,
      `SELECT * FROM workflow_credit_assignments ORDER BY created_at DESC LIMIT 30`,
    );
    const memoryEntries = all(
      this.db,
      `SELECT * FROM memory_entries ORDER BY updated_at DESC LIMIT 40`,
    );
    const memoryAudits = all(
      this.db,
      `SELECT * FROM memory_audits ORDER BY created_at DESC LIMIT 20`,
    );
    const skillVersions = all(
      this.db,
      `SELECT * FROM skill_versions ORDER BY created_at DESC LIMIT 30`,
    );
    const evals = all(
      this.db,
      `SELECT status, COUNT(*) AS count FROM evolution_regression_evals GROUP BY status`,
    );
    const governanceVotes = all(this.db, `SELECT * FROM hr_governance_votes ORDER BY created_at DESC LIMIT 50`);
    const applyJournals = all(this.db, `SELECT * FROM evolution_apply_journal ORDER BY created_at DESC LIMIT 30`);
    const holdoutEvals = all(this.db, `SELECT * FROM evolution_holdout_evals WHERE active = 1 ORDER BY created_at DESC LIMIT 30`);
    return {
      latestRuns: latestRuns.map(normalizeEvolutionRun),
      archives: archives.map(normalizeArchive),
      memories: memories.map(normalizeTypedMemory),
      memoryEntries: memoryEntries.map(normalizeMemoryEntry),
      memoryAudits: memoryAudits.map(normalizeMemoryAudit),
      hrReviews: hrReviews.map(normalizeHrReview),
      agentEvolutionReviews: agentEvolutionReviews.map(normalizeAgentEvolutionReview),
      governanceEvents: governanceEvents.map(normalizeGovernanceEvent),
      performanceReviews: performanceReviews.map(normalizePerformanceReview),
      specialistExperiments: specialistExperiments.map(normalizeSpecialistExperiment),
      workflowCredits: workflowCredits.map(normalizeWorkflowCredit),
      skillVersions: skillVersions.map(normalizeSkillVersion),
      evals: evals.map((row) => ({ status: row.status, count: Number(row.count || 0) })),
      governanceVotes: governanceVotes.map((row) => ({
        id: row.id, reviewId: row.review_id, departmentId: row.department_id,
        actionIndex: Number(row.action_index || 0), actionType: row.action_type,
        voterAgentId: row.voter_agent_id, vote: row.vote, rationale: row.rationale,
        sourceKind: row.source_kind, createdAt: row.created_at,
      })),
      applyJournals: applyJournals.map((row) => ({
        id: row.id, runId: row.run_id, agentId: row.agent_id, status: row.status,
        regression: safeJsonParse(row.regression_json, {}), error: row.error_text, createdAt: row.created_at, completedAt: row.completed_at,
      })),
      holdoutEvals: holdoutEvals.map((row) => ({
        id: row.id, agentId: row.agent_id, departmentId: row.department_id,
        caseText: row.case_text, sourceKind: row.source_kind, createdAt: row.created_at,
      })),
    };
  }
  });
}
