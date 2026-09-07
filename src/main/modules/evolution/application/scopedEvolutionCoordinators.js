import { CloudPersonalEvolutionCoordinator } from './cloudPersonalEvolutionCoordinator.js';
import { CLUSTER_EVOLUTION_ALGORITHM_VERSION } from '../../../../shared/evolution/contracts.js';

export function createScopedEvolutionCoordinators({ store, cloudSync = null } = {}) {
  if (!store) throw new Error('Scoped evolution coordinators require a Store.');
  return {
    personal: new CloudPersonalEvolutionCoordinator({ store, cloudSync }),
    cluster: new CloudClusterEvolutionCoordinator({ store, cloudSync }),
  };
}

export class CloudClusterEvolutionCoordinator {
  constructor({ store, cloudSync = null } = {}) {
    this.store = store;
    this.cloudSync = cloudSync;
  }

  status() {
    let capabilities = {};
    try { capabilities = JSON.parse(this.store.settingGet('evolution:cloud_capabilities', '{}') || '{}'); } catch { capabilities = {}; }
    const cluster = capabilities.cluster || {};
    const cloud = this.cloudSync?.status?.() || {};
    return {
      scope: 'cluster',
      authority: 'cloud',
      authorityLocked: true,
      enabled: cloud.evolutionEnabled !== false,
      configured: Boolean(cloud.configured),
      code: cluster.code || (cloud.configured ? 'cloud_capability_pending' : 'cloud_not_configured'),
      algorithmVersion: CLUSTER_EVOLUTION_ALGORITHM_VERSION,
      mutationEnabled: Boolean(cluster.mutationEnabled),
      executionAvailable: Boolean(cluster.executionAvailable),
      readiness: cluster.readiness || { database: false, model: false, encryption: false },
      readOnly: true,
    };
  }

  eligibleSubjects() { return []; }

  stageRun() {
    const error = new Error('Cluster evolution is scheduled by the cloud authority.');
    error.code = 'cloud_authority_required';
    throw error;
  }
}
