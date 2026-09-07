import crypto from 'node:crypto';

import {
  UBUDDY_ORG_TRACE_VERSION,
  uBuddyOrganizationPolicyHash,
  validateUBuddyOrganizationPlaybook,
} from '../../../../shared/contracts/uBuddyOrganizationEvolution.js';

export class UBuddyOrganizationEvolutionService {
  constructor({
    socialRelay = null,
    featureFlags = null,
    currentUser = () => null,
    maxConcurrentUploads = 2,
    maxQueuedUploads = 128,
    uploadRetryCooldownMs = 30_000,
    recentUploadLimit = 2_048,
  } = {}) {
    this.socialRelay = socialRelay;
    this.featureFlags = featureFlags;
    this.currentUser = currentUser;
    this.activePolicies = new Map();
    this.overviews = new Map();
    this.pendingUploads = new Set();
    this.uploadQueue = [];
    this.activeUploadCount = 0;
    this.maxConcurrentUploads = Math.max(1, Math.min(8, Number(maxConcurrentUploads || 2)));
    this.maxQueuedUploads = Math.max(8, Math.min(1_024, Number(maxQueuedUploads || 128)));
    this.uploadRetryCooldownMs = Math.max(1_000, Number(uploadRetryCooldownMs || 30_000));
    this.recentUploadLimit = Math.max(128, Number(recentUploadLimit || 2_048));
    this.recentUploads = new Map();
  }

  flags(userId = '', workspaceId = '') {
    return this.featureFlags?.snapshot?.({ userId, workspaceId }) || {};
  }

  cachedOverview(userId = '') {
    return this.overviews.get(String(userId || '')) || {
      authority: 'cloud', status: 'unavailable', traceCount: 0, activePolicyVersionId: '', policies: [], healthEvents: [],
    };
  }

  activePolicySnapshot(userId = '') {
    return this.activePolicies.get(String(userId || '')) || null;
  }

  async refresh(userId = '') {
    const ownerUserId = String(userId || this.currentUser()?.id || '').trim();
    if (!ownerUserId || !this.socialRelay?.connected?.()) return this.cachedOverview(ownerUserId);
    const overview = await this.socialRelay.uBuddyOrganizationEvolutionOverview();
    this.installActivePolicy(ownerUserId, overview?.activePolicy || null);
    this.overviews.set(ownerUserId, overview || this.cachedOverview(ownerUserId));
    return this.cachedOverview(ownerUserId);
  }

  async refreshActivePolicy(userId = '') {
    const ownerUserId = String(userId || this.currentUser()?.id || '').trim();
    if (!ownerUserId || !this.socialRelay?.connected?.()) return this.activePolicySnapshot(ownerUserId);
    const response = await this.socialRelay.uBuddyOrganizationEvolutionActivePolicy();
    return this.installActivePolicy(ownerUserId, response?.activePolicy || null);
  }

  installActivePolicy(ownerUserId, activePolicy = null) {
    if (activePolicy?.playbook) {
      try {
        const playbook = validateUBuddyOrganizationPlaybook(activePolicy.playbook);
        const expectedHash = uBuddyOrganizationPolicyHash(playbook);
        if (!activePolicy.policyHash || activePolicy.policyHash !== expectedHash) {
          throw new Error('uBuddy organization policy hash mismatch.');
        }
        this.activePolicies.set(ownerUserId, { ...activePolicy, playbook });
      } catch (error) {
        this.activePolicies.delete(ownerUserId);
        throw error;
      }
    } else {
      this.activePolicies.delete(ownerUserId);
    }
    return this.activePolicySnapshot(ownerUserId);
  }

  async activate({ userId = '', policyVersionId = '', commandId = '', expectedActivePolicyVersionId = '' } = {}) {
    const ownerUserId = String(userId || this.currentUser()?.id || '').trim();
    await this.socialRelay.uBuddyOrganizationEvolutionActivate(policyVersionId, {
      commandId: commandId || `ubuddy_org_activate_${crypto.randomUUID()}`,
      expectedActivePolicyVersionId,
    });
    return this.refresh(ownerUserId);
  }

  async disable({ userId = '', commandId = '', expectedActivePolicyVersionId = '', reason = 'user_disabled' } = {}) {
    const ownerUserId = String(userId || this.currentUser()?.id || '').trim();
    await this.socialRelay.uBuddyOrganizationEvolutionDisable({
      commandId: commandId || `ubuddy_org_disable_${crypto.randomUUID()}`,
      expectedActivePolicyVersionId,
      reason,
    });
    this.activePolicies.delete(ownerUserId);
    return this.refresh(ownerUserId);
  }

  recordDispatch({ userId = '', workspaceId = '', traceId = '', task = null, decision = null, candidates = [], taskType = '' } = {}) {
    const flags = this.flags(userId, workspaceId);
    if (!flags.organizationEvolutionCollectV1 || !traceId || !task?.id || decision?.decision !== 'task_plan') return false;
    return this.queueTrace({
      traceId,
      eventKind: 'dispatch',
      taskType,
      taskSignature: taskSignature({ taskType, nodes: decision.nodes }),
      idempotencyKey: `${traceId}:dispatch`,
      payload: {
        version: UBUDDY_ORG_TRACE_VERSION,
        taskRunRef: sha256(task.id),
        taskType: String(taskType || ''),
        nodes: (decision.nodes || []).slice(0, 8).map((node) => ({
          localId: String(node.localId || ''), agentId: String(node.agentId || ''),
          agentInstanceId: String(node.agentInstanceId || ''), isFinal: Boolean(node.isFinal),
        })),
        candidates: (Array.isArray(candidates) ? candidates : []).slice(0, 100).map((candidate) => ({
          agentId: String(candidate.agentId || ''), agentInstanceId: String(candidate.agentInstanceId || ''),
          departmentId: String(candidate.departmentId || ''), performanceLevel: String(candidate.performanceLevel || ''),
          queueDepth: Math.max(0, Number(candidate.queueDepth || 0)),
        })),
        policyVersionId: String(task.metadata?.uBuddyOrganizationEvolution?.policyVersionId || ''),
      },
    });
  }

  recordTerminal(task = null) {
    const traceId = String(task?.metadata?.uBuddyOrganizationTraceId || '');
    const userId = String(task?.ownerUserId || task?.metadata?.userId || '');
    const workspaceId = String(task?.workspaceId || task?.accountWorkspaceId || '');
    if (!traceId) return false;
    const policyVersionId = String(task.metadata?.uBuddyOrganizationEvolution?.policyVersionId || '');
    const collectEnabled = this.flags(userId, workspaceId).organizationEvolutionCollectV1;
    if (!collectEnabled && !policyVersionId) return false;
    const success = String(task.status || '') === 'completed';
    if (collectEnabled) {
      this.queueTrace({
        traceId,
        eventKind: 'terminal',
        taskType: String(task.metadata?.taskType || ''),
        taskSignature: String(task.metadata?.uBuddyOrganizationTaskSignature || ''),
        idempotencyKey: `${traceId}:terminal:${String(task.status || '')}`,
        payload: {
          version: UBUDDY_ORG_TRACE_VERSION,
          status: String(task.status || ''),
          resultState: String(task.metadata?.resultState || ''),
          reworkCount: Math.max(0, Number(task.metadata?.deliveryReworkCount || task.metadata?.reworkCount || 0)),
          nodes: (task.nodes || []).slice(0, 32).map((node) => ({
            agentId: String(node.agentId || ''), agentInstanceId: String(node.agentInstanceId || ''),
            status: String(node.status || ''), attempts: Math.max(0, Number(node.attempt || node.attempts || 0)),
          })),
        },
      });
    }
    if (policyVersionId) this.recordHealth({
      policyVersionId, traceId, eventKind: success ? 'success' : 'failure',
      idempotencyKey: `${traceId}:health:${String(task.status || '')}`,
      payload: { taskStatus: String(task.status || ''), resultState: String(task.metadata?.resultState || '') },
      userId,
    });
    return true;
  }

  recordPolicyApplication({ userId = '', traceId = '', applicationRecord = null } = {}) {
    if (!applicationRecord?.applied || !applicationRecord.policyVersionId) return false;
    return this.recordHealth({
      userId, traceId, policyVersionId: applicationRecord.policyVersionId,
      eventKind: 'applied', idempotencyKey: `${traceId}:health:applied`,
      payload: { ruleIds: applicationRecord.ruleIds || [] },
    });
  }

  recordPolicyRejection({ userId = '', traceId = '', policyVersionId = '', reason = '' } = {}) {
    if (!policyVersionId) return false;
    return this.recordHealth({
      userId, traceId, policyVersionId, eventKind: 'contract_rejected',
      idempotencyKey: `${traceId || crypto.randomUUID()}:health:contract_rejected`, payload: { reason: String(reason || '') },
    });
  }

  recordHealth(payload = {}) {
    if (!this.socialRelay?.connected?.()) return false;
    const idempotencyKey = String(payload.idempotencyKey || '').trim();
    if (!idempotencyKey) return false;
    return this.enqueueUpload({
      key: `health:${idempotencyKey}`,
      priority: ['contract_rejected', 'failure'].includes(payload.eventKind) ? 3 : 2,
      run: () => this.socialRelay.uBuddyOrganizationEvolutionHealth(payload).then((result) => {
        if (result?.autoDisabled) this.activePolicies.delete(String(payload.userId || this.currentUser()?.id || ''));
        return result;
      }),
    });
  }

  queueTrace(payload) {
    if (!this.socialRelay?.connected?.()) return false;
    const idempotencyKey = String(payload.idempotencyKey || '').trim();
    if (!idempotencyKey) return false;
    return this.enqueueUpload({
      key: `trace:${idempotencyKey}`,
      priority: payload.eventKind === 'dispatch' ? 1 : 2,
      run: () => this.socialRelay.uploadUBuddyOrganizationEvolutionTrace({
        ...payload,
        capability: 'ubuddy-organization-evolution-v1',
        clientCreatedAt: new Date().toISOString(),
      }),
    });
  }

  enqueueUpload({ key = '', priority = 0, run = null } = {}) {
    if (!key || typeof run !== 'function') return false;
    const now = Date.now();
    const recent = this.recentUploads.get(key);
    if (recent?.status === 'succeeded'
      || (recent && now - recent.at < this.uploadRetryCooldownMs)) return false;
    if (this.uploadQueue.length >= this.maxQueuedUploads) {
      let replacementIndex = -1;
      for (let index = 0; index < this.uploadQueue.length; index += 1) {
        if (this.uploadQueue[index].priority < priority) {
          replacementIndex = index;
          break;
        }
      }
      if (replacementIndex < 0) return false;
      const [dropped] = this.uploadQueue.splice(replacementIndex, 1);
      this.recentUploads.delete(dropped.key);
    }
    this.rememberUpload(key, { status: 'queued', at: now });
    const job = { key, priority, run };
    const insertionIndex = this.uploadQueue.findIndex((item) => item.priority < priority);
    if (insertionIndex < 0) this.uploadQueue.push(job);
    else this.uploadQueue.splice(insertionIndex, 0, job);
    queueMicrotask(() => this.drainUploads());
    return true;
  }

  drainUploads() {
    while (this.activeUploadCount < this.maxConcurrentUploads && this.uploadQueue.length) {
      const job = this.uploadQueue.shift();
      this.activeUploadCount += 1;
      this.rememberUpload(job.key, { status: 'running', at: Date.now() });
      let pending;
      pending = Promise.resolve()
        .then(job.run)
        .then((result) => {
          this.rememberUpload(job.key, { status: 'succeeded', at: Date.now() });
          return result;
        })
        .catch(() => {
          this.rememberUpload(job.key, { status: 'failed', at: Date.now() });
          return null;
        })
        .finally(() => {
          this.pendingUploads.delete(pending);
          this.activeUploadCount = Math.max(0, this.activeUploadCount - 1);
          this.drainUploads();
        });
      this.pendingUploads.add(pending);
    }
  }

  rememberUpload(key, value) {
    this.recentUploads.delete(key);
    this.recentUploads.set(key, value);
    while (this.recentUploads.size > this.recentUploadLimit) {
      this.recentUploads.delete(this.recentUploads.keys().next().value);
    }
  }
}

function taskSignature({ taskType = '', nodes = [] } = {}) {
  return sha256(JSON.stringify({ taskType: String(taskType || ''), roles: (nodes || []).map((node) => ({ agentId: node.agentId, final: Boolean(node.isFinal) })) }));
}

function sha256(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
