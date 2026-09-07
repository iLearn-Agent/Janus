import { all, get, run } from '../../../db.js';
import { runCodexExec } from '../../../codex.js';
import { diagnoseAgentEvidence } from '../../../diagnosis.js';
import { compileEffectiveSkill } from '../../identity/index.js';
import { clipText, newId, nowIso, safeJsonParse, sha256Text } from '../../../utils.js';

const MIN_MANUAL_EVIDENCE = 8;
const MIN_MANUAL_CONTEXTS = 2;
const MIN_AUTO_EVIDENCE = 20;
const MIN_AUTO_CONTEXTS = 3;
const AUTO_GATE_SCORE = 0.9;
const AUTO_SCORE_IMPROVEMENT = 0.05;
const ALLOWED_MEMORY_SECTIONS = new Set([
  'Stable Learnings', 'Reusable Preferences', 'Failure Modes', 'Workflow Notes', 'Topic Files', 'Do Not Store',
]);
const ALLOWED_MEMORY_OPERATIONS = new Set(['add', 'replace', 'remove']);
const PERSONAL_PRIVACY_PATTERN = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\+?\d[\d\s().-]{7,}\d|(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|secret|私钥|密码|密钥)\s*[:=]|(?:[A-Za-z]:\\|\/(?:home|Users|tmp|var|private|mnt)\/)|https?:\/\/|\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b)/gi;

export class PersonalEvolutionCoordinator {
  constructor({ store, root = '', org = null, cloudSync = null, enabled = false, executeModel = runCodexExec } = {}) {
    if (!store) throw new Error('Personal evolution coordinator requires a Store.');
    this.store = store;
    this.root = root;
    this.org = org;
    this.cloudSync = cloudSync;
    this.enabled = Boolean(enabled);
    this.executeModel = executeModel;
  }

  status() {
    return {
      scope: 'personal', enabled: this.enabled, algorithmVersion: 'personal_overlay_v2',
      mutationEnabled: this.enabled, providerBoundary: 'configured_provider',
      minimumEvidence: MIN_MANUAL_EVIDENCE, automaticMinimumEvidence: MIN_AUTO_EVIDENCE,
    };
  }

  eligibleSubjects({ userId = '' } = {}) {
    if (!userId) return [];
    return this.store.listUserAgentInstances({ userId })
      .filter((instance) => instance.status === 'active' && instance.personalEvolutionConsent)
      .map((instance) => ({
        scope: 'personal', userId: instance.userId, agentInstanceId: instance.id,
        agentFamilyId: instance.agentFamilyId, autoActivate: instance.personalSkillAutoActivate,
        allowedMemoryDocumentIds: this.allowedMemoryDocuments(instance.id).map((document) => document.id),
      }));
  }

  stageRun(subject = {}) {
    if (!this.enabled) return { status: 'disabled', ...this.status() };
    const instance = this.assertEligibleInstance(subject);
    const allowedMemoryDocumentIds = this.allowedMemoryDocuments(instance.id).map((document) => document.id);
    const runId = this.store.createScopedEvolutionRun({
      scope: 'personal', userId: instance.userId, agentInstanceId: instance.id,
      agentFamilyId: instance.agentFamilyId, algorithmVersion: 'personal_overlay_v2',
      consentSnapshot: this.consentSnapshot(instance, allowedMemoryDocumentIds),
    });
    return { status: 'staged', runId, mutationEnabled: true };
  }

  async run({ userId = '', agentInstanceId = '', trigger = 'manual', dryRun = false, force: _force = false } = {}) {
    if (!this.enabled) return { status: 'disabled', ...this.status() };
    const instance = this.assertEligibleInstance({ userId, agentInstanceId });
    const state = this.store.getPersonalEvolutionInstanceState(instance.id);
    if (state.runningRunId) return { status: 'deferred', reason: 'personal_evolution_already_running', runId: state.runningRunId };
    if (state.nextEligibleAt && Date.parse(state.nextEligibleAt) > Date.now()) {
      return { status: 'deferred', reason: 'personal_evolution_not_due', nextEligibleAt: state.nextEligibleAt };
    }
    const context = this.store.resolveUserAgent({ userId: instance.userId, agentInstanceId: instance.id, agentFamilyId: instance.agentFamilyId });
    const allowedMemory = this.allowedMemoryDocuments(instance.id);
    const runId = this.store.createScopedEvolutionRun({
      scope: 'personal', userId: instance.userId, agentInstanceId: instance.id,
      agentFamilyId: instance.agentFamilyId, algorithmVersion: 'personal_overlay_v2',
      evidenceCursorFrom: JSON.stringify(state.evidenceCursor || {}),
      consentSnapshot: this.consentSnapshot(instance, allowedMemory.map((document) => document.id)),
    });
    const syncScope = this.syncScope(instance);
    const proposal = this.store.createPersonalEvolutionProposal({
      runId, userId: instance.userId, agentInstanceId: instance.id, agentFamilyId: instance.agentFamilyId,
      syncScope, originDeviceId: this.cloudSync?.status?.().deviceId || '',
      baseAgentVersionId: context.baseVersion?.id || '', basePersonalSkillVersionId: context.personalSkillVersion?.id || '',
      baseEffectiveSkillHash: context.effectiveSkillHash, baseMemoryManifestHash: context.memoryManifestHash,
      evidenceCursorFrom: state.evidenceCursor || {},
    });
    this.store.updatePersonalEvolutionInstanceState(instance.id, {
      runningRunId: runId, lastRunAt: nowIso(), nextEligibleAt: nextDayIso(), lastError: '',
    });
    try {
      const collected = this.collectEvidence({ instance, cursor: state.evidenceCursor || {}, allowedMemory });
      this.store.addPersonalEvolutionEvidence(proposal.id, collected.items);
      this.store.updatePersonalEvolutionProposal(proposal.id, {
        evidenceCursorTo: collected.cursor, evidenceCount: collected.evidenceCount,
        distinctContextCount: collected.distinctContextCount,
      });
      run(this.store.db, 'UPDATE evolution_runs SET evidence_message_count = ?, evidence_cursor_to = ?, updated_at = ? WHERE id = ?', [
        collected.evidenceCount, JSON.stringify(collected.cursor), nowIso(), runId,
      ]);
      const minimumEvidence = trigger === 'auto' ? MIN_AUTO_EVIDENCE : MIN_MANUAL_EVIDENCE;
      const minimumContexts = trigger === 'auto' ? MIN_AUTO_CONTEXTS : MIN_MANUAL_CONTEXTS;
      if (collected.evidenceCount < minimumEvidence || collected.distinctContextCount < minimumContexts) {
        const reason = `Need ${minimumEvidence} evidence items across ${minimumContexts} contexts.`;
        this.store.updatePersonalEvolutionProposal(proposal.id, { status: 'insufficient_evidence', summary: reason });
        this.finishRun(runId, 'skipped', reason);
        return this.store.getPersonalEvolutionProposal(proposal.id);
      }
      this.expireReadyProposals(instance.id, proposal.id, 'new_evidence_run');
      const diagnosticEvidence = collected.items.filter((item) => item.included && item.content).map((item) => ({ role: item.role || 'system', content: item.content, created_at: item.occurredAt }));
      const diagnostic = diagnoseAgentEvidence({ agentId: instance.agentFamilyId, departmentId: context.family?.departmentId || '', evidence: diagnosticEvidence });
      const generatedOutput = dryRun
        ? deterministicProposal({ instance, diagnostic, allowedMemory })
        : await this.generateProposal({ instance, context, diagnostic, evidence: diagnosticEvidence, allowedMemory, runId });
      const validated = validatePersonalProposal(generatedOutput, { allowedMemory });
      const generated = sanitizePersonalProposalForStorage(generatedOutput);
      const gate = scorePersonalProposalGate({ generated: generatedOutput, diagnostic, errors: validated.errors, privacyReport: validated.privacyReport });
      const overlayText = String(generated.overlay_text || '').trim();
      const candidate = gate.status === 'passed' && overlayText
        ? this.store.createPersonalSkillVersion({ agentInstanceId: instance.id, overlayText, sourceEvolutionRunId: runId })
        : null;
      const operations = normalizeMemoryOperations(generated.memory_operations, allowedMemory);
      if (operations.length) this.store.addPersonalEvolutionMemoryOperations(proposal.id, operations);
      const evaluations = gate.status === 'passed'
        ? await this.evaluateProposal({ instance, context, generated, overlayText, allowedMemory, runId, dryRun })
        : [];
      if (evaluations.length) this.store.addPersonalEvolutionEvaluations(proposal.id, evaluations);
      const evaluationSummary = summarizeEvaluations(evaluations);
      const autoEligible = gate.score >= AUTO_GATE_SCORE
        && collected.evidenceCount >= MIN_AUTO_EVIDENCE
        && collected.distinctContextCount >= MIN_AUTO_CONTEXTS
        && validated.privacyReport.flagCount === 0
        && evaluationSummary.regressionCount === 0
        && evaluationSummary.averageImprovement >= AUTO_SCORE_IMPROVEMENT;
      const markdown = renderProposalMarkdown({ generated, diagnostic, gate, evaluationSummary, evidenceCount: collected.evidenceCount, distinctContextCount: collected.distinctContextCount });
      const status = gate.status === 'passed' ? 'ready' : 'failed';
      this.store.updatePersonalEvolutionProposal(proposal.id, {
        status, candidatePersonalSkillVersionId: candidate?.id || '', proposalMarkdown: markdown,
        proposalHash: sha256Text(markdown), summary: generated.summary || diagnostic.recommendation || '',
        proposedOverlayText: overlayText, proposedOverlayHash: sha256Text(overlayText), diagnostics: diagnostic,
        gate, privacyReport: validated.privacyReport, evaluationSummary, autoActivationEligible: autoEligible,
      });
      if (status === 'ready') {
        this.store.updatePersonalEvolutionInstanceState(instance.id, {
          evidenceCursor: collected.cursor, lastReadyAt: nowIso(), nextEligibleAt: nextDayIso(),
        });
        this.finishRun(runId, 'proposed', 'Personal evolution Proposal is ready for review.');
        if (instance.personalSkillAutoActivate && autoEligible) {
          try {
            if (syncScope === 'cloud') await this.cloudSync?.syncNow?.({ reason: 'personal_evolution_auto_prepare' });
            await this.decide({ userId: instance.userId, proposalId: proposal.id, skillDecision: 'accept', memoryDecisions: [], actorDeviceId: this.cloudSync?.status?.().deviceId || '', automatic: true });
          } catch (error) {
            this.store.updatePersonalEvolutionInstanceState(instance.id, { lastError: `Auto activation deferred: ${String(error.message || error)}` });
          }
        }
      } else {
        this.finishRun(runId, 'failed', gate.reasons.join('; '));
      }
      return this.store.getPersonalEvolutionProposal(proposal.id);
    } catch (error) {
      this.store.updatePersonalEvolutionProposal(proposal.id, { status: 'failed', summary: String(error.message || error) });
      this.store.updatePersonalEvolutionInstanceState(instance.id, { lastError: String(error.message || error) });
      this.finishRun(runId, 'failed', String(error.message || error));
      throw error;
    } finally {
      this.store.updatePersonalEvolutionInstanceState(instance.id, { runningRunId: '' });
    }
  }

  refreshProposalFreshness(proposalId) {
    const proposal = this.store.getPersonalEvolutionProposal(proposalId);
    if (!proposal || proposal.status !== 'ready') return proposal;
    const instance = this.store.getUserAgentInstance(proposal.agentInstanceId);
    if (!instance || !instance.personalEvolutionConsent) return this.expireProposal(proposal, 'consent_changed');
    const context = this.store.resolveUserAgent({ userId: proposal.userId, agentInstanceId: proposal.agentInstanceId, agentFamilyId: proposal.agentFamilyId });
    if (context.baseVersion?.id !== proposal.baseAgentVersionId
      || (context.personalSkillVersion?.id || '') !== proposal.basePersonalSkillVersionId
      || context.effectiveSkillHash !== proposal.baseEffectiveSkillHash
      || context.memoryManifestHash !== proposal.baseMemoryManifestHash) {
      return this.expireProposal(proposal, 'baseline_changed');
    }
    const currentCursor = this.latestEvidenceCursor(instance.id, this.allowedMemoryDocuments(instance.id));
    if (cursorAdvanced(currentCursor, proposal.evidenceCursorTo)) return this.expireProposal(proposal, 'new_evidence');
    return proposal;
  }

  async decide({ userId = '', proposalId = '', skillDecision = '', memoryDecisions = [], actorDeviceId = '', automatic = false } = {}) {
    let proposal = this.refreshProposalFreshness(proposalId);
    if (!proposal || proposal.userId !== userId) throw new Error('Personal evolution Proposal is unavailable.');
    if (!['ready', 'partially_applied'].includes(proposal.status)) throw new Error(`Personal evolution Proposal cannot be applied from status ${proposal.status}.`);
    const instance = this.assertEligibleInstance({ userId, agentInstanceId: proposal.agentInstanceId, agentFamilyId: proposal.agentFamilyId });
    if (automatic && (!instance.personalSkillAutoActivate || !proposal.autoActivationEligible)) throw new Error('Proposal is not eligible for automatic activation.');
    if (proposal.syncScope === 'cloud') {
      if (!this.cloudSync?.decidePersonalEvolution) throw new Error('Cloud decision service is unavailable.');
      await this.cloudSync.syncNow({ reason: 'personal_evolution_decision_prepare' });
      const decisions = [];
      if (skillDecision) decisions.push({ targetKind: 'skill', targetId: proposal.candidatePersonalSkillVersionId || '', decision: skillDecision });
      for (const item of memoryDecisions) decisions.push({ targetKind: 'memory_operation', targetId: item.operationId, decision: item.decision });
      const cloudResult = await this.cloudSync.decidePersonalEvolution({ proposalId, decisions });
      if (cloudResult?.status !== 'accepted') throw new Error(cloudResult?.message || 'Cloud rejected the Proposal decision.');
    }
    if (skillDecision) this.applySkillDecision({ proposal, instance, decision: skillDecision, actorDeviceId, automatic });
    if (memoryDecisions.length) this.applyMemoryDecisions({ proposal, instance, decisions: memoryDecisions, actorDeviceId });
    proposal = this.store.getPersonalEvolutionProposal(proposal.id);
    const skillTerminal = ['activated', 'rejected', 'none'].includes(proposal.skillActionStatus);
    const memoryOperations = proposal.memoryOperations || [];
    const memoryTerminal = memoryOperations.every((item) => ['applied', 'rejected'].includes(item.status));
    let status = proposal.status;
    let decision = proposal.decision;
    if (skillTerminal && memoryTerminal) {
      const accepted = proposal.skillActionStatus === 'activated' || memoryOperations.some((item) => item.status === 'applied');
      const rejected = proposal.skillActionStatus === 'rejected' || memoryOperations.some((item) => item.status === 'rejected');
      status = accepted && rejected ? 'partially_applied' : accepted ? 'applied' : 'rejected';
      decision = accepted && rejected ? 'partial' : accepted ? (automatic ? 'auto_accepted' : 'accepted') : 'rejected';
    } else if (proposal.skillActionStatus === 'activated' || memoryOperations.some((item) => item.status === 'applied')) {
      status = 'partially_applied';
    }
    return this.store.updatePersonalEvolutionProposal(proposal.id, {
      status, decision, decidedAt: decision === 'pending' ? '' : nowIso(),
      memoryActionStatus: memoryTerminal ? (memoryOperations.some((item) => item.status === 'applied') ? 'applied' : memoryOperations.length ? 'rejected' : 'none') : 'pending',
    });
  }

  rollbackSkill({ userId = '', agentInstanceId = '', targetSkillVersionId = '', actorDeviceId = '' } = {}) {
    const instance = this.store.getUserAgentInstance(agentInstanceId);
    if (!instance || instance.userId !== userId) throw new Error('User Agent instance is unavailable.');
    let resolution;
    if (targetSkillVersionId) {
      const target = get(this.store.db, 'SELECT id FROM user_agent_skill_versions WHERE id = ? AND user_agent_instance_id = ?', [targetSkillVersionId, instance.id]);
      if (!target) throw new Error('Rollback Skill version does not belong to this Agent instance.');
      resolution = this.store.activatePersonalSkillVersion({ agentInstanceId: instance.id, skillVersionId: target.id });
    } else {
      resolution = this.store.deactivatePersonalSkill({ agentInstanceId: instance.id });
    }
    this.store.recordPersonalEvolutionAction({
      proposalId: '', targetKind: 'skill_rollback', targetId: targetSkillVersionId || 'base', decision: 'rollback',
      actorUserId: userId, actorDeviceId, syncStatus: 'local', confirmedAt: nowIso(),
    });
    return resolution;
  }

  rollbackMemory({ userId = '', memoryDocumentId = '', targetVersionId = '' } = {}) {
    const document = this.store.getMemoryDocument(memoryDocumentId);
    if (!document || document.userId !== userId) throw new Error('Memory document is unavailable.');
    const target = get(this.store.db, 'SELECT * FROM memory_document_versions WHERE id = ? AND memory_document_id = ?', [targetVersionId, document.id]);
    if (!target) throw new Error('Rollback Memory version does not belong to this document.');
    return this.store.appendMemoryDocumentVersion({
      memoryDocumentId: document.id, content: target.content, sourceKind: 'personal_evolution_rollback',
      sourceId: target.id, reviewStatus: 'approved', createdBy: userId,
    });
  }

  collectEvidence({ instance, cursor = {}, allowedMemory = [] } = {}) {
    const items = [];
    const addRows = (kind, rows, mapper) => {
      for (const row of rows) {
        const mapped = mapper(row);
        const sanitized = sanitizeEvidence(mapped.content || '');
        items.push({
          id: newId('peev'), sourceKind: kind, sourceId: mapped.sourceId,
          sourceHash: sha256Text(mapped.content || ''), occurredAt: mapped.occurredAt,
          contextKey: mapped.contextKey || `${kind}:${mapped.sourceId}`, privacyLevel: 'private',
          included: !sanitized.blocked, rejectionReason: sanitized.blocked ? sanitized.reason : '',
          content: sanitized.text, role: mapped.role || 'system',
        });
      }
    };
    const messageCursor = normalizeCursor(cursor.messages);
    addRows('message', all(this.store.db, `SELECT m.*, s.id AS session_context_id FROM messages m
      JOIN sessions s ON s.id = m.session_id
      WHERE s.user_id = ? AND s.status != 'deleted' AND m.role IN ('user','assistant') AND m.visible = 1
        AND (m.agent_instance_id = ? OR (m.agent_instance_id = '' AND s.agent_instance_id = ?))
        AND (m.created_at > ? OR (m.created_at = ? AND m.id > ?))
      ORDER BY m.created_at, m.id LIMIT 80`, [instance.userId, instance.id, instance.id, messageCursor.createdAt, messageCursor.createdAt, messageCursor.id]), (row) => ({
      sourceId: row.id, content: row.content, occurredAt: row.created_at,
      contextKey: row.context_space_id ? `context:${row.context_space_id}` : `session:${row.session_context_id}`, role: row.role,
    }));
    for (const document of allowedMemory) {
      const sanitized = sanitizeEvidence(document.content || '');
      items.push({
        id: newId('peev'), sourceKind: 'memory_context', sourceId: document.currentVersionId || document.id,
        sourceHash: document.contentHash, occurredAt: document.updatedAt, contextKey: `memory:${document.id}`,
        privacyLevel: 'private', included: !sanitized.blocked, rejectionReason: sanitized.blocked ? sanitized.reason : '',
        content: sanitized.text, role: 'memory',
      });
    }
    const counted = items.filter((item) => item.included && item.sourceKind !== 'memory_context');
    return {
      items, evidenceCount: counted.length,
      distinctContextCount: new Set(counted.map((item) => item.contextKey).filter(Boolean)).size,
      cursor: cursorFromEvidence(items, cursor),
    };
  }

  latestEvidenceCursor(agentInstanceId, allowedMemory = []) {
    const instance = this.store.getUserAgentInstance(agentInstanceId);
    if (!instance) return {};
    return this.collectEvidence({ instance, cursor: {}, allowedMemory }).cursor;
  }

  async generateProposal({ instance, context, diagnostic, evidence, allowedMemory, runId }) {
    const prompt = buildPersonalEvolutionPrompt({ instance, context, diagnostic, evidence, allowedMemory });
    const raw = await this.executeModel({
      prompt, agentId: instance.agentFamilyId, role: 'personal-evolution-proposer', root: this.root,
      sandbox: 'read-only', executionContext: {
        store: this.store, userId: instance.userId, agentId: instance.agentFamilyId,
        agentInstanceId: instance.id, agentVersionId: context.baseVersion?.id || '',
        personalSkillVersionId: context.personalSkillVersion?.id || '', executionKind: 'personal_evolution_proposal',
        skillHash: context.effectiveSkillHash, memoryManifestHash: context.memoryManifestHash,
        metadata: { evolutionRunId: runId, scope: 'personal' },
      },
    });
    return parseProposalJson(raw);
  }

  async evaluateProposal({ instance, context, generated, overlayText, allowedMemory, runId, dryRun }) {
    const cases = normalizeEvalCases(generated.eval_cases).slice(0, 5);
    const candidateSkill = compileEffectiveSkill(context.baseVersion?.baseSkillContent || '', overlayText);
    const memoryText = allowedMemory.map((document) => sanitizeEvidence(document.content).text).join('\n\n');
    const evaluations = [];
    for (const [caseIndex, item] of cases.entries()) {
      let baselineOutput = '';
      let candidateOutput = '';
      if (dryRun) {
        baselineOutput = 'Baseline response without the proposed personal rule.';
        candidateOutput = `${item.expectedText || item.inputText} ${overlayText}`;
      } else {
        baselineOutput = await this.executeModel({
          prompt: buildReplayPrompt(item, context.effectiveSkill, memoryText), agentId: instance.agentFamilyId,
          role: 'personal-evolution-baseline', root: this.root, sandbox: 'read-only',
          executionContext: { store: this.store, userId: instance.userId, agentId: instance.agentFamilyId, agentInstanceId: instance.id, executionKind: 'personal_evolution_baseline', metadata: { evolutionRunId: runId, caseIndex } },
        });
        candidateOutput = await this.executeModel({
          prompt: buildReplayPrompt(item, candidateSkill, memoryText), agentId: instance.agentFamilyId,
          role: 'personal-evolution-candidate', root: this.root, sandbox: 'read-only',
          executionContext: { store: this.store, userId: instance.userId, agentId: instance.agentFamilyId, agentInstanceId: instance.id, executionKind: 'personal_evolution_candidate', metadata: { evolutionRunId: runId, caseIndex } },
        });
      }
      const baselineScore = scoreOutput(baselineOutput, item.expectedText || item.inputText);
      const candidateScore = scoreOutput(candidateOutput, item.expectedText || item.inputText);
      evaluations.push({
        caseIndex, inputText: item.inputText, expectedText: item.expectedText,
        baselineOutput: clipText(baselineOutput, 4000), candidateOutput: clipText(candidateOutput, 4000),
        baselineScore, candidateScore, regression: candidateScore + 0.05 < baselineScore,
        judge: { evaluator: 'personal_keyword_contract_v1', improvement: Number((candidateScore - baselineScore).toFixed(3)) },
        status: 'completed',
      });
    }
    return evaluations;
  }

  allowedMemoryDocuments(agentInstanceId) {
    return this.store.listMemoryDocuments({ agentInstanceId }).filter((document) => document.allowPersonalEvolution);
  }

  applySkillDecision({ proposal, instance, decision, actorDeviceId, automatic }) {
    if (!['accept', 'reject'].includes(decision)) throw new Error('Skill decision must be accept or reject.');
    if (proposal.skillActionStatus === 'activated' || proposal.skillActionStatus === 'rejected') return;
    if (decision === 'accept') {
      if (!proposal.candidatePersonalSkillVersionId) throw new Error('Proposal has no candidate Skill Overlay.');
      this.store.activatePersonalSkillVersion({ agentInstanceId: instance.id, skillVersionId: proposal.candidatePersonalSkillVersionId });
    }
    this.store.recordPersonalEvolutionAction({
      proposalId: proposal.id, targetKind: 'skill', targetId: proposal.candidatePersonalSkillVersionId || '', decision,
      actorUserId: instance.userId, actorDeviceId, syncStatus: proposal.syncScope === 'cloud' ? 'confirmed' : 'local', confirmedAt: nowIso(),
    });
    this.store.updatePersonalEvolutionProposal(proposal.id, {
      skillActionStatus: decision === 'accept' ? 'activated' : 'rejected',
      decision: automatic && decision === 'accept' ? 'auto_accepted' : proposal.decision,
    });
  }

  applyMemoryDecisions({ proposal, instance, decisions, actorDeviceId }) {
    const byId = new Map((proposal.memoryOperations || []).map((item) => [item.id, item]));
    const acceptedByDocument = new Map();
    for (const item of decisions) {
      const operation = byId.get(item.operationId);
      if (!operation) throw new Error('Memory operation does not belong to this Proposal.');
      if (!['accept', 'reject'].includes(item.decision)) throw new Error('Memory decision must be accept or reject.');
      if (operation.status !== 'pending') continue;
      if (item.decision === 'accept') {
        const list = acceptedByDocument.get(operation.memoryDocumentId) || [];
        list.push(operation);
        acceptedByDocument.set(operation.memoryDocumentId, list);
      }
    }
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [documentId, operations] of acceptedByDocument) {
        const document = this.store.getMemoryDocument(documentId);
        if (!document || document.userId !== instance.userId || document.userAgentInstanceId !== instance.id) throw new Error('Memory operation target is unavailable.');
        for (const operation of operations) {
          if (document.currentVersionId !== operation.baselineVersionId || document.contentHash !== operation.baselineContentHash) throw new Error('Memory baseline changed; regenerate the Proposal.');
        }
        const content = applyMemoryOperations(document.content, operations);
        this.store.appendMemoryDocumentVersion({
          memoryDocumentId: document.id, content, sourceKind: 'personal_evolution', sourceId: proposal.runId,
          reviewStatus: 'approved', createdBy: instance.userId, withinTransaction: true,
        });
      }
      for (const item of decisions) {
        const operation = byId.get(item.operationId);
        if (!operation || operation.status !== 'pending') continue;
        run(this.store.db, 'UPDATE personal_evolution_memory_operations SET status = ?, updated_at = ? WHERE id = ?', [item.decision === 'accept' ? 'applied' : 'rejected', nowIso(), operation.id]);
        this.store.recordPersonalEvolutionAction({
          proposalId: proposal.id, targetKind: 'memory_operation', targetId: operation.id, decision: item.decision,
          actorUserId: instance.userId, actorDeviceId, syncStatus: proposal.syncScope === 'cloud' ? 'confirmed' : 'local', confirmedAt: nowIso(),
        });
      }
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      if (/Memory baseline changed/.test(String(error.message || error))) this.expireProposal(proposal, 'memory_baseline_changed');
      throw error;
    }
  }

  assertEligibleInstance({ userId = '', agentInstanceId = '', agentFamilyId = '' } = {}) {
    const instance = this.store.getUserAgentInstance(agentInstanceId);
    if (!instance || (userId && instance.userId !== userId) || (agentFamilyId && instance.agentFamilyId !== agentFamilyId)) {
      throw new Error('Personal evolution subject does not match a user Agent instance.');
    }
    if (instance.status !== 'active') throw new Error('Personal evolution requires an active Agent instance.');
    if (!instance.personalEvolutionConsent) throw new Error('Personal evolution consent is required.');
    return instance;
  }

  consentSnapshot(instance, allowedMemoryDocumentIds) {
    return {
      syncEnabled: instance.syncEnabled, personalEvolutionConsent: instance.personalEvolutionConsent,
      clusterContributionConsent: instance.clusterContributionConsent,
      personalSkillAutoActivate: instance.personalSkillAutoActivate, allowedMemoryDocumentIds,
      providerBoundary: 'configured_provider',
    };
  }

  syncScope(instance) {
    if (!instance.syncEnabled) return 'local_only';
    const user = get(this.store.db, 'SELECT remote_id FROM auth_users WHERE id = ?', [instance.userId]);
    return user?.remote_id ? 'cloud' : 'local_only';
  }

  expireReadyProposals(agentInstanceId, exceptId, reason) {
    run(this.store.db, `UPDATE personal_evolution_proposals SET status = 'expired', expires_reason = ?, expires_at = ?, updated_at = ?
      WHERE user_agent_instance_id = ? AND status = 'ready' AND id != ?`, [reason, nowIso(), nowIso(), agentInstanceId, exceptId]);
  }

  expireProposal(proposal, reason) {
    return this.store.updatePersonalEvolutionProposal(proposal.id, { status: 'expired', expiresReason: reason, expiresAt: nowIso() });
  }

  finishRun(runId, status, summary) {
    run(this.store.db, `UPDATE evolution_runs SET status = ?, summary = ?, updated_at = ?, completed_at = ? WHERE id = ?`, [
      status, clipText(summary, 1000), nowIso(), nowIso(), runId,
    ]);
  }
}

export function sanitizeEvidence(value = '') {
  const source = String(value || '');
  const blocked = /(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|secret|私钥|密码|密钥)\s*[:=]/i.test(source);
  let text = redactSensitiveText(source)
    .replace(/\s+/g, ' ')
    .trim();
  text = clipText(text, 1400);
  return { text, blocked, reason: blocked ? 'credential_like_content' : '' };
}

function redactSensitiveText(value = '') {
  return String(value || '')
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|secret|私钥|密码|密钥)\s*[:=]\s*)[^\r\n,;]+/gi, '$1[redacted-secret]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[redacted-phone]')
    .replace(/\b(?:user|uagent|session|task|msg|memdoc|memdocver)_[0-9a-z-]{8,}\b/gi, '[redacted-id]')
    .replace(/(?:[A-Za-z]:\\|\/(?:home|Users|tmp|var|private|mnt)\/)[^\s"'`]+/g, '[redacted-path]')
    .replace(/https?:\/\/[^\s)]+/gi, '[redacted-url]')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g, '[redacted-secret]');
}

function sanitizePersonalProposalForStorage(generated = {}) {
  const clean = (value, maxChars) => clipText(redactSensitiveText(value), maxChars);
  return {
    ...generated,
    summary: clean(generated.summary || '', 2000),
    overlay_text: clean(generated.overlay_text || '', 12000),
    memory_operations: (Array.isArray(generated.memory_operations) ? generated.memory_operations : []).map((item) => ({
      ...item,
      proposed_text: clean(item?.proposed_text || '', 1000),
      rationale: clean(item?.rationale || '', 1000),
    })),
    eval_cases: (Array.isArray(generated.eval_cases) ? generated.eval_cases : []).map((item) => ({
      ...item,
      input: clean(item?.input || item?.inputText || '', 2000),
      expected: clean(item?.expected || item?.expectedText || '', 1500),
    })),
    risks: (Array.isArray(generated.risks) ? generated.risks : []).map((item) => clean(item, 1000)),
  };
}

export function validatePersonalProposal(generated = {}, { allowedMemory = [] } = {}) {
  const errors = [];
  const overlay = String(generated.overlay_text || '').trim();
  if (!overlay) errors.push('Personal Overlay is empty.');
  if (overlay.length > 12000) errors.push('Personal Overlay exceeds 12000 characters.');
  if (/^#\s+/m.test(overlay)) errors.push('Personal Overlay may not replace the full Skill.');
  if (/(AGENTS\.md|config\.toml|\$CODEX_HOME|developer_instructions|another agent|其他 Agent)/i.test(overlay)) errors.push('Personal Overlay exceeds its mutation boundary.');
  const allowedIds = new Set(allowedMemory.map((document) => document.id));
  for (const operation of generated.memory_operations || []) {
    if (!allowedIds.has(operation.memory_document_id)) errors.push('Memory operation targets an unauthorized document.');
    if (!ALLOWED_MEMORY_SECTIONS.has(operation.section_name)) errors.push('Memory operation targets an unsupported section.');
    if (!ALLOWED_MEMORY_OPERATIONS.has(operation.operation_type)) errors.push('Memory operation type is invalid.');
  }
  const synchronizedText = JSON.stringify({
    summary: generated.summary || '', overlay_text: overlay,
    memory_operations: (generated.memory_operations || []).map((item) => ({ proposed_text: item.proposed_text || '', rationale: item.rationale || '' })),
    eval_cases: (generated.eval_cases || []).map((item) => ({ input: item.input || item.inputText || '', expected: item.expected || item.expectedText || '' })),
    risks: generated.risks || [],
  });
  const privacyMatches = synchronizedText.match(PERSONAL_PRIVACY_PATTERN) || [];
  if (privacyMatches.length) errors.push('Proposal contains material that must be redacted before synchronization.');
  return { errors, privacyReport: { flagCount: privacyMatches.length, flags: privacyMatches.map(() => 'redaction_required') } };
}

function scorePersonalProposalGate({ generated, diagnostic, errors, privacyReport }) {
  let score = 1;
  const reasons = [...errors];
  score -= Math.min(0.7, errors.length * 0.18);
  const overlay = String(generated.overlay_text || '').toLowerCase();
  const alignmentTerms = String(diagnostic.recommendation || diagnostic.primary_layer || '').toLowerCase().match(/[a-z]{4,}|[\u4e00-\u9fff]{2,}/g) || [];
  const aligned = alignmentTerms.some((term) => overlay.includes(term)) || overlay.includes(String(diagnostic.primary_layer || '').replace(/_/g, ' '));
  if (!aligned) { score -= 0.08; reasons.push('Overlay has weak diagnosis alignment.'); }
  if (!(generated.eval_cases || []).length) { score -= 0.12; reasons.push('Proposal has no Eval Cases.'); }
  if (!(generated.risks || []).length) { score -= 0.08; reasons.push('Proposal has no risk analysis.'); }
  if (privacyReport.flagCount) score -= 0.4;
  score = Math.max(0, Number(score.toFixed(3)));
  return { status: errors.length === 0 && score >= 0.72 ? 'passed' : 'failed', score, minScore: 0.72, reasons, diagnosticAlignment: aligned };
}

function buildPersonalEvolutionPrompt({ instance, context, diagnostic, evidence, allowedMemory }) {
  const evidenceText = evidence.slice(-60).map((item, index) => `${index + 1}. ${item.role}: ${item.content}`).join('\n');
  const memoryText = allowedMemory.map((document) => `Document ${document.id}:\n${sanitizeEvidence(document.content).text}`).join('\n\n');
  return `You generate a private personal Skill Overlay Proposal for one Janus user Agent instance.

Return only JSON:
{"summary":"","overlay_text":"","memory_operations":[{"memory_document_id":"","section_name":"Stable Learnings|Reusable Preferences|Failure Modes|Workflow Notes|Topic Files|Do Not Store","operation_type":"add|replace|remove","target_item_hash":"","proposed_text":"","rationale":""}],"eval_cases":[{"input":"","expected":""}],"risks":[""]}

Rules:
- Improve only this instance's personal Overlay. Never replace the base Skill or modify another Agent.
- Do not quote raw chats or include names, identities, email, phone, credentials, paths, URLs, files, or project-specific facts.
- Memory operations may target only the listed document IDs and must remain reusable.
- Produce 1-5 eval cases and explicit risks.

Agent family: ${instance.agentFamilyId}
Current effective Skill:
${clipText(context.effectiveSkill || '', 10000)}

Allowed Memory context:
${clipText(memoryText || '(none)', 6000)}

Diagnosis:
${JSON.stringify(diagnostic)}

Sanitized evidence:
${clipText(evidenceText, 24000)}`;
}

function buildReplayPrompt(item, skill, memory) {
  return `Answer the evaluation input using the supplied private effective Skill and allowed Memory. Return only the answer.

Effective Skill:
${clipText(skill || '', 12000)}

Allowed Memory:
${clipText(memory || '', 6000)}

Input:
${item.inputText}

Expected behavior (do not copy mechanically):
${item.expectedText}`;
}

function parseProposalJson(raw) {
  let text = String(raw || '').trim();
  if (text.startsWith('```')) text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const parsed = safeJsonParse(text, null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Personal evolution proposer returned invalid JSON.');
  return parsed;
}

function deterministicProposal({ instance, diagnostic, allowedMemory }) {
  const phrase = String(diagnostic.recommendation || 'Use a narrow evidence-backed procedure.').replace(/\s+/g, ' ').trim();
  return {
    summary: `Dry-run personal improvement for ${instance.agentFamilyId}.`,
    overlay_text: `## Personal Procedure\n- ${phrase}`,
    memory_operations: allowedMemory[0] ? [{
      memory_document_id: allowedMemory[0].id, section_name: 'Workflow Notes', operation_type: 'add',
      target_item_hash: '', proposed_text: 'Prefer an evidence-first check before final delivery.', rationale: 'Repeated sanitized evidence indicates a reusable workflow preference.',
    }] : [],
    eval_cases: [{ input: 'Handle a similar task with the recurring failure risk.', expected: phrase }],
    risks: ['Avoid overfitting to one task and never store private source material.'],
  };
}

function normalizeMemoryOperations(items = [], allowedMemory = []) {
  const byId = new Map(allowedMemory.map((document) => [document.id, document]));
  return items.slice(0, 20).map((item) => {
    const document = byId.get(item.memory_document_id);
    return {
      memoryDocumentId: item.memory_document_id, sectionName: item.section_name,
      operationType: item.operation_type, targetItemHash: item.target_item_hash || '',
      proposedText: clipText(item.proposed_text || '', 1000), rationale: clipText(item.rationale || '', 1000),
      baselineVersionId: document?.currentVersionId || '', baselineContentHash: document?.contentHash || '',
    };
  });
}

function normalizeEvalCases(items = []) {
  return items.filter((item) => item && (item.input || item.inputText)).map((item) => ({
    inputText: clipText(item.input || item.inputText || '', 2000), expectedText: clipText(item.expected || item.expectedText || '', 1500),
  }));
}

function scoreOutput(output, expected) {
  const tokens = [...new Set((String(expected || '').toLowerCase().match(/[a-z0-9]{4,}|[\u4e00-\u9fff]{2,}/g) || []).slice(0, 30))];
  if (!tokens.length) return output ? 0.75 : 0;
  const text = String(output || '').toLowerCase();
  return Number((tokens.filter((token) => text.includes(token)).length / tokens.length).toFixed(3));
}

function summarizeEvaluations(evaluations = []) {
  const count = evaluations.length;
  const baselineAverage = count ? evaluations.reduce((sum, item) => sum + item.baselineScore, 0) / count : 0;
  const candidateAverage = count ? evaluations.reduce((sum, item) => sum + item.candidateScore, 0) / count : 0;
  return {
    caseCount: count, regressionCount: evaluations.filter((item) => item.regression).length,
    baselineAverage: Number(baselineAverage.toFixed(3)), candidateAverage: Number(candidateAverage.toFixed(3)),
    averageImprovement: Number((candidateAverage - baselineAverage).toFixed(3)),
  };
}

function renderProposalMarkdown({ generated, diagnostic, gate, evaluationSummary, evidenceCount, distinctContextCount }) {
  const operations = generated.memory_operations || [];
  const cases = normalizeEvalCases(generated.eval_cases);
  return `# Personal Evolution Proposal\n\n## Summary\n${generated.summary || ''}\n\n## Evidence\n- ${evidenceCount} qualifying items across ${distinctContextCount} contexts\n- Diagnosis: ${diagnostic.primary_layer || 'skill_procedure'}\n\n## Proposed Skill Overlay\n${generated.overlay_text || 'no-op'}\n\n## Proposed Memory Operations\n${operations.length ? operations.map((item) => `- ${item.operation_type} ${item.section_name}: ${item.proposed_text || item.target_item_hash || 'item'}`).join('\n') : '- no-op'}\n\n## Eval Cases\n${cases.map((item) => `- Input: ${item.inputText} Expected: ${item.expectedText}`).join('\n') || '- none'}\n\n## Evaluation\n- Gate: ${gate.status} (${gate.score})\n- Baseline: ${evaluationSummary.baselineAverage || 0}\n- Candidate: ${evaluationSummary.candidateAverage || 0}\n- Regressions: ${evaluationSummary.regressionCount || 0}\n\n## Risks\n${(generated.risks || []).map((item) => `- ${item}`).join('\n') || '- none'}\n`;
}

export function applyMemoryOperations(content, operations) {
  let result = String(content || '');
  for (const operation of operations) {
    result = applyMemoryOperation(result, operation);
  }
  return result.endsWith('\n') ? result : `${result}\n`;
}

function applyMemoryOperation(content, operation) {
  const heading = `## ${operation.sectionName}`;
  let source = String(content || '');
  if (!source.includes(heading)) source = `${source.trimEnd()}\n\n${heading}\n`;
  const start = source.indexOf(heading) + heading.length;
  const rest = source.slice(start);
  const nextHeading = /\n##\s+/.exec(rest);
  const end = nextHeading ? start + nextHeading.index : source.length;
  const before = source.slice(0, start);
  const section = source.slice(start, end);
  const after = source.slice(end);
  const lines = section.split(/\r?\n/);
  if (operation.operationType === 'add') {
    const text = String(operation.proposedText || '').trim().replace(/^[-*]\s+/, '');
    if (!text) throw new Error('Memory add operation is empty.');
    const filtered = lines.filter((line) => !/^\s*-\s+(?:None yet\.|暂无|无)\s*$/i.test(line));
    filtered.push(`- ${text}`);
    return `${before}${normalizeSectionLines(filtered)}${after}`;
  }
  const index = lines.findIndex((line) => /^\s*[-*]\s+/.test(line) && sha256Text(line.replace(/^\s*[-*]\s+/, '').trim()) === operation.targetItemHash);
  if (index < 0) throw new Error('Memory operation target item changed or no longer exists.');
  if (operation.operationType === 'remove') lines.splice(index, 1);
  if (operation.operationType === 'replace') {
    const text = String(operation.proposedText || '').trim().replace(/^[-*]\s+/, '');
    if (!text) throw new Error('Memory replace operation is empty.');
    lines[index] = `- ${text}`;
  }
  return `${before}${normalizeSectionLines(lines)}${after}`;
}

function normalizeSectionLines(lines) {
  const body = lines.join('\n').replace(/^\s*\n/, '\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  return `${body ? `\n${body.replace(/^\n+/, '')}` : ''}\n`;
}

function normalizeCursor(value) { return { createdAt: String(value?.createdAt || ''), id: String(value?.id || '') }; }

function cursorFromEvidence(items, previous = {}) {
  const result = { ...previous };
  const mapping = { message: 'messages', model_execution: 'executions', task_retrospective: 'retrospectives', performance_review: 'performanceReviews' };
  for (const [sourceKind, cursorKey] of Object.entries(mapping)) {
    const latest = items.filter((item) => item.sourceKind === sourceKind).sort(compareEvidence).at(-1);
    if (latest) result[cursorKey] = { createdAt: latest.occurredAt || '', id: latest.sourceId || '' };
  }
  return result;
}

function compareEvidence(left, right) { return String(left.occurredAt || '').localeCompare(String(right.occurredAt || '')) || String(left.sourceId || '').localeCompare(String(right.sourceId || '')); }
function cursorAdvanced(current = {}, baseline = {}) { return ['messages', 'executions', 'retrospectives', 'performanceReviews'].some((key) => compareCursor(current[key], baseline[key]) > 0); }
function compareCursor(left, right) { const a = normalizeCursor(left); const b = normalizeCursor(right); return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id); }
function nextDayIso() { return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); }
