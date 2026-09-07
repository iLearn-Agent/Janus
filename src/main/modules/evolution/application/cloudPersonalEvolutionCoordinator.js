export class CloudPersonalEvolutionCoordinator {
  constructor({ store, cloudSync } = {}) {
    if (!store) throw new Error('Cloud personal evolution coordinator requires a Store.');
    this.store = store;
    this.cloudSync = cloudSync;
  }

  status() {
    const cloud = this.cloudSync?.status?.() || {};
    let capabilities = {};
    try { capabilities = JSON.parse(this.store.settingGet('evolution:cloud_capabilities', '{}') || '{}'); } catch { capabilities = {}; }
    const personal = capabilities.personal || {};
    return {
      scope: 'personal',
      authority: 'cloud',
      authorityLocked: true,
      enabled: cloud.evolutionEnabled !== false,
      mutationEnabled: Boolean(personal.mutationEnabled),
      localExecutionEnabled: false,
      executionAvailable: Boolean(personal.executionAvailable),
      readiness: personal.readiness || { database: false, model: false, encryption: false },
      evaluationIntervalMs: personal.evaluationIntervalMs || 86400000,
      retryIntervalMs: personal.retryIntervalMs || 300000,
      configured: Boolean(cloud.configured),
      grantReady: Boolean(cloud.evolutionGrantReady),
      deviceId: cloud.deviceId || '',
      providerBoundary: 'platform_managed',
      algorithmVersion: 'personal_cloud_authority_v1',
      minimumEvidence: 5,
      maximumEvidence: 60,
      code: personal.code || (cloud.configured ? (cloud.evolutionGrantReady ? 'cloud_capability_pending' : 'cloud_grant_pending') : 'cloud_not_configured'),
      evidenceUpload: cloud.evolutionEvidenceUpload || {
        currentAccount: {}, otherAccountsPending: 0, permanentlyBlocked: 0, nextRetryAt: '', deferredReasons: {},
      },
    };
  }

  eligibleSubjects({ userId = '' } = {}) {
    if (!userId) return [];
    let evidenceCounts = {};
    try { evidenceCounts = JSON.parse(this.store.settingGet('evolution:cloud_evidence_counts', '{}') || '{}'); } catch { evidenceCounts = {}; }
    let schedules = {};
    try {
      const cached = JSON.parse(this.store.settingGet('evolution:cloud_personal_schedules', '{}') || '{}');
      schedules = Object.fromEntries((cached.items || []).map((item) => [item.agentInstanceId, item]));
    } catch { schedules = {}; }
    return this.store.listUserAgentInstances({ userId })
      .filter((instance) => instance.status === 'active' && instance.personalEvolutionConsent && instance.syncEnabled)
      .map((instance) => ({
        scope: 'personal', authority: 'cloud', userId: instance.userId, agentInstanceId: instance.id,
        agentFamilyId: instance.agentFamilyId,
        evidenceCounts: evidenceCounts[instance.id]?.counts || {},
        availableEvidence: Number(evidenceCounts[instance.id]?.available || 0),
        schedule: schedules[instance.id] || null,
      }));
  }

  async schedule({ userId = '', agentInstanceId = '' } = {}) {
    if (agentInstanceId) this.assertOwned(userId, agentInstanceId);
    if (!this.cloudSync?.personalEvolutionSchedule) return { authority: 'cloud', items: [], status: 'unavailable' };
    return this.cloudSync.personalEvolutionSchedule({ agentInstanceId });
  }

  async run({ userId = '', agentInstanceId = '', trigger = 'manual', force = false } = {}) {
    this.assertOwnedEligible(userId, agentInstanceId);
    if (!this.cloudSync?.status?.().configured) return { status: 'unavailable', authority: 'cloud', code: 'cloud_not_configured' };
    if (!this.cloudSync?.requestPersonalEvolutionRun) return { status: 'unavailable', authority: 'cloud', code: 'cloud_evolution_client_unavailable' };
    const result = await this.cloudSync.requestPersonalEvolutionRun({ agentInstanceId, trigger, force });
    if (result?.status !== 'unavailable') this.store.updatePersonalEvolutionInstanceState(agentInstanceId, {
      lastRunAt: new Date().toISOString(), lastError: result?.error || '',
    });
    return result;
  }

  refreshProposalFreshness(proposalId = '') {
    const proposal = this.store.getPersonalEvolutionProposal(proposalId);
    return proposal ? { ...proposal, authority: 'cloud', sourceAuthority: 'legacy_local', readOnly: true } : null;
  }

  async runs({ userId = '', agentInstanceId = '', limit = 30 } = {}) {
    if (agentInstanceId) this.assertOwned(userId, agentInstanceId);
    if (!this.cloudSync?.personalEvolutionRuns) return { authority: 'cloud', items: [], status: 'unavailable' };
    return this.cloudSync.personalEvolutionRuns({ agentInstanceId, limit });
  }

  async getRun({ userId = '', runId = '' } = {}) {
    if (!this.cloudSync?.personalEvolutionRun) return null;
    const run = await this.cloudSync.personalEvolutionRun(runId);
    if (!run || (run.userId && this.cloudSync.status().userId !== run.userId)) throw new Error('Cloud evolution run is unavailable.');
    return run;
  }

  async decide({ userId = '', proposalId = '', skillDecision = '', memoryDecisions = [] } = {}) {
    const run = await this.getRun({ userId, runId: proposalId });
    if (!run) throw new Error('Cloud evolution Proposal is unavailable.');
    this.assertOwned(userId, run.agentInstanceId);
    if (!this.cloudSync?.decidePersonalEvolutionRun) throw new Error('Cloud evolution decision service is unavailable.');
    return this.cloudSync.decidePersonalEvolutionRun({
      runId: proposalId,
      skillDecision,
      memoryDecisions,
    });
  }

  async rollbackSkill({ userId = '', agentInstanceId = '', targetSkillVersionId = '', commandId = '', expectedActiveVersionId } = {}) {
    this.assertOwned(userId, agentInstanceId);
    if (!this.cloudSync?.rollbackPersonalVersion) throw new Error('Cloud evolution rollback service is unavailable.');
    return this.cloudSync.rollbackPersonalVersion({
      agentInstanceId,
      targetVersionId: targetSkillVersionId,
      commandId,
      expectedActiveVersionId,
    });
  }

  async rollbackMemory({ userId = '', agentInstanceId = '', memoryDocumentId = '', targetVersionId = '' } = {}) {
    this.assertOwned(userId, agentInstanceId);
    if (!this.cloudSync?.rollbackPersonalMemory) throw new Error('Cloud Memory rollback service is unavailable.');
    return this.cloudSync.rollbackPersonalMemory({ agentInstanceId, memoryDocumentId, targetVersionId });
  }

  assertOwned(userId, agentInstanceId) {
    const instance = this.store.getUserAgentInstance(agentInstanceId);
    if (!instance || instance.userId !== userId) throw new Error('User Agent instance is unavailable.');
    return instance;
  }

  assertOwnedEligible(userId, agentInstanceId) {
    const instance = this.assertOwned(userId, agentInstanceId);
    if (instance.status !== 'active' || !instance.syncEnabled || !instance.personalEvolutionConsent) {
      throw new Error('Agent is not eligible for cloud personal evolution.');
    }
    return instance;
  }
}
