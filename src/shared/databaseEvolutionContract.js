export const DATABASE_EVOLUTION_CONTRACT_VERSION = 2;
export const DATABASE_SYNC_BASE_PROTOCOL_VERSION = 6;
export const DATABASE_SYNC_PROTOCOL_VERSION = 9;
export const DATABASE_SYNC_MINIMUM_APP_VERSION = '0.3.0';
export const DATABASE_SYNC_MINIMUM_MIGRATION_ID = 'janus_clean_slate_identity_v1';
export const DATABASE_SYNC_CURRENT_MIGRATION_ID = 'organization_message_research_v1';
export const DATABASE_SYNC_BASE_CAPABILITIES = Object.freeze([
  'account-workspace-v2',
  'canonical-agent-identity-v1',
  'conversation-identity-phase6',
  'staged-sync-v6',
]);
export const DATABASE_SYNC_CAPABILITIES = Object.freeze([
  ...DATABASE_SYNC_BASE_CAPABILITIES,
  'agent-single-window-continuity-v1',
  'account-principal-isolation-v1',
  'account-scoped-cursor-v1',
  'conversation-security-domain-v1',
  'account-owned-agent-v1',
  'janus-clean-slate-v1',
  'message-memory-turn-binding-v1',
]);

export function createDatabaseClientContract({ appVersion = '', migrationIds = [], capabilities = DATABASE_SYNC_CAPABILITIES } = {}) {
  const applied = [...new Set((Array.isArray(migrationIds) ? migrationIds : []).map(clean).filter(Boolean))];
  return {
    contractVersion: DATABASE_EVOLUTION_CONTRACT_VERSION,
    appVersion: clean(appVersion),
    syncProtocolVersion: DATABASE_SYNC_PROTOCOL_VERSION,
    localSchemaVersion: applied.length,
    migrationHead: applied.at(-1) || '',
    appliedMigrationIds: applied,
    capabilities: [...new Set((Array.isArray(capabilities) ? capabilities : []).map(clean).filter(Boolean))].sort(),
  };
}

export function normalizeDatabaseClientContract(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const appliedMigrationIds = arrayValue(source.appliedMigrationIds || source.migrations);
  return {
    contractVersion: positiveInteger(source.contractVersion),
    appVersion: clean(source.appVersion),
    syncProtocolVersion: positiveInteger(source.syncProtocolVersion || source.protocolVersion),
    localSchemaVersion: positiveInteger(source.localSchemaVersion || appliedMigrationIds.length),
    migrationHead: clean(source.migrationHead),
    appliedMigrationIds,
    capabilities: arrayValue(source.capabilities).sort(),
  };
}

export function assessDatabaseClientCompatibility(clientValue = {}, {
  requireContract = true,
  minimumProtocolVersion = DATABASE_SYNC_PROTOCOL_VERSION,
  maximumProtocolVersion = DATABASE_SYNC_PROTOCOL_VERSION,
  minimumAppVersion = DATABASE_SYNC_MINIMUM_APP_VERSION,
  minimumMigrationId = DATABASE_SYNC_MINIMUM_MIGRATION_ID,
  requiredCapabilities = DATABASE_SYNC_CAPABILITIES,
} = {}) {
  const client = normalizeDatabaseClientContract(clientValue);
  const reasons = [];
  if (!client.contractVersion) {
    if (requireContract) reasons.push('client_contract_missing');
  } else if (client.contractVersion !== DATABASE_EVOLUTION_CONTRACT_VERSION) {
    reasons.push('contract_version_unsupported');
  }
  if (client.contractVersion) {
    if (client.syncProtocolVersion < minimumProtocolVersion) reasons.push('sync_protocol_too_old');
    if (client.syncProtocolVersion > maximumProtocolVersion) reasons.push('sync_protocol_too_new');
    if (minimumAppVersion && compareVersions(client.appVersion, minimumAppVersion) < 0) reasons.push('app_version_too_old');
    if (minimumMigrationId && !client.appliedMigrationIds.includes(minimumMigrationId)) reasons.push('required_migration_missing');
    const capabilitySet = new Set(client.capabilities);
    for (const capability of requiredCapabilities) {
      if (!capabilitySet.has(capability)) reasons.push(`capability_missing:${capability}`);
    }
  }
  return {
    status: reasons.length ? 'incompatible' : 'compatible',
    compatible: reasons.length === 0,
    reasons,
    client,
    server: {
      contractVersion: DATABASE_EVOLUTION_CONTRACT_VERSION,
      minimumProtocolVersion,
      maximumProtocolVersion,
      minimumAppVersion,
      minimumMigrationId,
      requiredCapabilities: [...requiredCapabilities],
    },
  };
}

export function assertDatabaseClientCompatibility(value = {}, options = {}) {
  const assessment = assessDatabaseClientCompatibility(value, options);
  if (assessment.compatible) return assessment;
  const error = new Error(`Database sync client is incompatible: ${assessment.reasons.join(', ')}`);
  error.code = assessment.reasons.includes('client_contract_missing')
    ? 'sync_client_contract_required'
    : 'sync_client_incompatible';
  error.compatibility = assessment;
  throw error;
}

export function databaseContractQuery(contractValue = {}) {
  const contract = normalizeDatabaseClientContract(contractValue);
  return {
    contractVersion: String(contract.contractVersion || ''),
    appVersion: contract.appVersion,
    syncProtocolVersion: String(contract.syncProtocolVersion || ''),
    localSchemaVersion: String(contract.localSchemaVersion || ''),
    migrationHead: contract.migrationHead,
    migrations: contract.appliedMigrationIds.join(','),
    capabilities: contract.capabilities.join(','),
  };
}

export function databaseContractFromQuery(query = {}) {
  return normalizeDatabaseClientContract({
    contractVersion: query.contractVersion,
    appVersion: query.appVersion,
    syncProtocolVersion: query.syncProtocolVersion,
    localSchemaVersion: query.localSchemaVersion,
    migrationHead: query.migrationHead,
    appliedMigrationIds: splitValue(query.migrations),
    capabilities: splitValue(query.capabilities),
  });
}

function arrayValue(value) {
  if (Array.isArray(value)) return [...new Set(value.map(clean).filter(Boolean))];
  return splitValue(value);
}

function splitValue(value) {
  return [...new Set(clean(value).split(',').map(clean).filter(Boolean))];
}

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function clean(value) {
  return String(value ?? '').trim();
}

function compareVersions(left = '', right = '') {
  const parts = (value) => clean(value).replace(/^v/i, '').split(/[.-]/).slice(0, 3).map((item) => Number.parseInt(item, 10) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0) ? 1 : -1;
  }
  return 0;
}
