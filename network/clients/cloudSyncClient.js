import { createHttpClient } from '../core/httpClient.js';
import { normalizeBaseUrl, joinUrl } from '../core/url.js';
import { databaseContractQuery } from '../../src/shared/databaseEvolutionContract.js';

export class CloudSyncClient {
  constructor({
    fetchImpl = globalThis.fetch,
    timeoutMs = Number(process.env.JANUS_CLOUD_REQUEST_TIMEOUT_MS || 15_000),
  } = {}) {
    this.http = createHttpClient({ fetchImpl });
    this.employeeHttp = createHttpClient({ fetchImpl, timeoutMs });
    this.employeeRequestTimeoutMs = Math.max(0, Number(timeoutMs || 0));
    this.fetchImpl = fetchImpl;
  }

  registerDevice(state, payload = {}, { accessToken = '' } = {}) {
    return this.fetchJson(state, '/api/device-grants/register', { method: 'POST', body: JSON.stringify(payload), tokenOverride: accessToken });
  }

  issueDeviceGrant(state, deviceId, payload = {}, { accessToken = '' } = {}) {
    return this.fetchJson(state, `/api/device-grants/${encodeURIComponent(deviceId)}/token`, {
      method: 'POST', body: JSON.stringify(payload), tokenOverride: accessToken,
    });
  }

  deviceGrants(state, { accessToken = '' } = {}) {
    return this.fetchJson(state, '/api/device-grants', { tokenOverride: accessToken });
  }

  approveDevice(state, deviceId) {
    return this.fetchDeviceJson(state, `/api/device-grants/${encodeURIComponent(deviceId)}/approve`, { method: 'POST', body: '{}' });
  }

  revokeDevice(state, deviceId) {
    return this.fetchDeviceJson(state, `/api/device-grants/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
  }

  syncV6Capabilities(state, clientContract = {}) {
    const params = new URLSearchParams(databaseContractQuery(clientContract));
    return this.fetchDeviceJson(state, `/v1/sync/v6/capabilities?${params.toString()}`);
  }
  submitV6Batch(state, payload, clientContract = {}) {
    return this.fetchDeviceJson(state, '/v1/sync/v6/batches', {
      method: 'POST', body: JSON.stringify({ ...payload, clientContract }),
    });
  }
  syncV6Changes(state, { cursor = '', limit = 500, clientContract = {}, accountId = '' } = {}) {
    const params = new URLSearchParams({ cursor: String(cursor || ''), limit: String(limit), accountId: String(accountId || ''), ...databaseContractQuery(clientContract) });
    return this.fetchDeviceJson(state, `/v1/sync/v6/changes?${params.toString()}`);
  }
  syncV6Metrics(state) { return this.fetchDeviceJson(state, '/v1/sync/v6/metrics'); }
  rewrapTaskKey(state, payload = {}) {
    return this.fetchDeviceJson(state, '/v1/sync/v6/task-keys/rewrap', { method: 'POST', body: JSON.stringify(payload) });
  }
  initiateV6File(state, payload = {}) {
    return this.fetchDeviceJson(state, '/v1/sync/v6/files/initiate', { method: 'POST', body: JSON.stringify(payload) });
  }
  completeV6File(state, payload = {}) {
    return this.fetchDeviceJson(state, '/v1/sync/v6/files/complete', { method: 'POST', body: JSON.stringify(payload) });
  }
  downloadV6File(state, sha256) {
    return this.fetchDeviceJson(state, `/v1/sync/v6/files/${encodeURIComponent(sha256)}/download`);
  }

  async uploadPresigned(upload = {}, body) {
    const response = await this.fetchImpl(upload.url, { method: upload.method || 'PUT', headers: upload.headers || {}, body });
    if (!response.ok) throw new Error(`Object upload failed with ${response.status}.`);
    return { status: 'uploaded', httpStatus: response.status };
  }

  submitBatch(state, payload) {
    return this.fetchJson(state, '/v1/sync/batches', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  identitySnapshot(state, { userId = '', cursor = '' } = {}) {
    const params = new URLSearchParams({ userId });
    if (cursor) params.set('cursor', cursor);
    return this.fetchJson(state, `/v1/sync/v3/identity?${params.toString()}`);
  }

  personalEvolutionSnapshot(state, { userId = '', cursor = '' } = {}) {
    const params = new URLSearchParams({ userId });
    if (cursor) params.set('cursor', cursor);
    return this.fetchJson(state, `/v1/sync/v4/personal-evolution?${params.toString()}`);
  }

  decidePersonalEvolution(state, payload = {}) {
    return this.fetchJson(state, '/v1/sync/v4/personal-evolution/decisions', {
      method: 'POST', body: JSON.stringify(payload),
    });
  }

  bootstrapEvolutionGrant(state, payload = {}, { accessToken = '' } = {}) {
    return this.fetchJson(state, '/api/evolution/grants', {
      method: 'POST', body: JSON.stringify(payload), tokenOverride: accessToken,
    });
  }

  bootstrapLegacyEvolutionGrant(state, payload = {}) {
    return this.fetchJson(state, '/v1/evolution/grants', {
      method: 'POST', body: JSON.stringify(payload),
    });
  }

  evolutionGrants(state, { accessToken = '' } = {}) {
    return this.fetchJson(state, '/api/evolution/grants', { tokenOverride: accessToken });
  }

  revokeEvolutionGrant(state, deviceId = '', { accessToken = '' } = {}) {
    return this.fetchJson(state, `/api/evolution/grants/${encodeURIComponent(deviceId)}`, {
      method: 'DELETE', tokenOverride: accessToken,
    });
  }

  evolutionCapabilities(state) {
    return this.fetchEvolutionJson(state, '/v1/evolution/capabilities');
  }

  evolutionPreference(state) {
    return this.fetchEvolutionJson(state, '/v1/evolution/preferences');
  }

  setEvolutionPreference(state, payload = {}) {
    return this.fetchEvolutionJson(state, '/v1/evolution/preferences', {
      method: 'PATCH', body: JSON.stringify(payload),
    });
  }

  evolutionUpdates(state) {
    return this.fetchEvolutionJson(state, '/v1/evolution/updates');
  }

  uploadEvolutionEvidence(state, items = []) {
    return this.fetchEvolutionJson(state, '/v1/evolution/evidence/batch', {
      method: 'POST', body: JSON.stringify({ items }),
    });
  }

  evolutionEvidenceCounts(state, { agentInstanceId = '' } = {}) {
    const params = new URLSearchParams({ agentInstanceId });
    return this.fetchEvolutionJson(state, `/v1/evolution/evidence/counts?${params.toString()}`);
  }

  evolutionEvidenceUsage(state, { agentInstanceId = '', scope = '', status = '', cursor = '', limit = 50 } = {}) {
    const params = new URLSearchParams({ agentInstanceId, limit: String(limit) });
    if (scope) params.set('scope', scope);
    if (status) params.set('status', status);
    if (cursor) params.set('cursor', cursor);
    return this.fetchEvolutionJson(state, `/v1/evolution/evidence/usage?${params.toString()}`);
  }

  personalEvolutionSchedule(state, { agentInstanceId = '' } = {}) {
    const query = agentInstanceId ? `?agentInstanceId=${encodeURIComponent(agentInstanceId)}` : '';
    return this.fetchEvolutionJson(state, `/v1/evolution/personal/schedule${query}`);
  }

  requestPersonalEvolutionRun(state, payload = {}) {
    return this.fetchEvolutionJson(state, '/v1/evolution/personal/runs', {
      method: 'POST', body: JSON.stringify(payload),
    });
  }

  personalEvolutionRuns(state, { agentInstanceId = '', limit = 30 } = {}) {
    const params = new URLSearchParams({ agentInstanceId, limit: String(limit) });
    return this.fetchEvolutionJson(state, `/v1/evolution/personal/runs?${params.toString()}`);
  }

  personalEvolutionRun(state, runId = '') {
    return this.fetchEvolutionJson(state, `/v1/evolution/personal/runs/${encodeURIComponent(runId)}`);
  }

  decidePersonalEvolutionRun(state, runId = '', payload = {}) {
    return this.fetchEvolutionJson(state, `/v1/evolution/personal/runs/${encodeURIComponent(runId)}/decisions`, {
      method: 'POST', body: JSON.stringify(payload),
    });
  }

  personalEvolutionVersions(state, { agentInstanceId = '' } = {}) {
    const params = new URLSearchParams({ agentInstanceId });
    return this.fetchEvolutionJson(state, `/v1/evolution/personal/versions?${params.toString()}`);
  }

  rollbackPersonalEvolutionVersion(state, payload = {}) {
    return this.fetchEvolutionJson(state, '/v1/evolution/personal/rollback', {
      method: 'POST', body: JSON.stringify(payload),
    });
  }

  activatePersonalEvolutionVersion(state, versionId = '', payload = {}) {
    return this.fetchEvolutionJson(state, `/v1/evolution/personal/versions/${encodeURIComponent(versionId)}/activate`, {
      method: 'POST', body: JSON.stringify(payload),
    });
  }

  clusterEvolutionStatus(state) {
    return this.fetchEvolutionJson(state, '/v1/evolution/cluster/status');
  }

  marketEvolutionStatus(state) {
    return this.fetchEvolutionJson(state, '/v1/evolution/market/status');
  }

  uploadPerformanceEvents(state, items = []) {
    return this.fetchEvolutionJson(state, '/v1/evolution/performance/events', { method: 'POST', body: JSON.stringify({ items }) });
  }

  performanceLevel(state, agentInstanceId = '') {
    return this.fetchEvolutionJson(state, `/v1/evolution/performance/${encodeURIComponent(agentInstanceId)}`);
  }

  performanceHistory(state, agentInstanceId = '', { limit = 30 } = {}) {
    return this.fetchEvolutionJson(state, `/v1/evolution/performance/${encodeURIComponent(agentInstanceId)}/history?limit=${encodeURIComponent(limit)}`);
  }

  uploadLeadershipEvents(state, items = []) {
    return this.fetchEvolutionJson(state, '/v1/evolution/leadership/events', { method: 'POST', body: JSON.stringify({ items }) });
  }

  evaluateLeadershipTask(state, payload = {}) {
    return this.fetchEvolutionJson(state, '/v1/evolution/leadership/evaluations', { method: 'POST', body: JSON.stringify(payload) });
  }

  leadershipLevel(state, agentInstanceId = '') {
    return this.fetchEvolutionJson(state, `/v1/evolution/leadership/${encodeURIComponent(agentInstanceId)}`);
  }

  calculateLeadershipLevel(state, agentInstanceId = '') {
    return this.fetchEvolutionJson(state, `/v1/evolution/leadership/${encodeURIComponent(agentInstanceId)}`, { method: 'POST', body: '{}' });
  }

  leadershipHistory(state, agentInstanceId = '', { limit = 30 } = {}) {
    return this.fetchEvolutionJson(state, `/v1/evolution/leadership/${encodeURIComponent(agentInstanceId)}/history?limit=${encodeURIComponent(limit)}`);
  }

  leadershipActions(state, { agentInstanceId = '', status = '', limit = 50 } = {}) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (agentInstanceId) params.set('agentInstanceId', agentInstanceId);
    if (status) params.set('status', status);
    return this.fetchEvolutionJson(state, `/v1/evolution/leadership/actions?${params.toString()}`);
  }

  requestLeadershipTrial(state, payload = {}) {
    return this.fetchEvolutionJson(state, '/v1/evolution/leadership/trials', { method: 'POST', body: JSON.stringify(payload) });
  }

  decideLeadershipAction(state, actionId = '', payload = {}) {
    return this.fetchEvolutionJson(state, `/v1/evolution/leadership/actions/${encodeURIComponent(actionId)}/decisions`, { method: 'POST', body: JSON.stringify(payload) });
  }

  restoreLeadership(state, agentInstanceId = '', payload = {}) {
    return this.fetchEvolutionJson(state, `/v1/evolution/leadership/${encodeURIComponent(agentInstanceId)}/restore`, { method: 'POST', body: JSON.stringify(payload) });
  }

  leadershipAppeals(state, { agentInstanceId = '', status = '', limit = 50 } = {}) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (agentInstanceId) params.set('agentInstanceId', agentInstanceId);
    if (status) params.set('status', status);
    return this.fetchEvolutionJson(state, `/v1/evolution/leadership/appeals?${params.toString()}`);
  }

  submitLeadershipAppeal(state, payload = {}) {
    return this.fetchEvolutionJson(state, '/v1/evolution/leadership/appeals', { method: 'POST', body: JSON.stringify(payload) });
  }

  decideLeadershipAppeal(state, appealId = '', payload = {}) {
    return this.fetchEvolutionJson(state, `/v1/evolution/leadership/appeals/${encodeURIComponent(appealId)}/decisions`, { method: 'POST', body: JSON.stringify(payload) });
  }

  clusterCohorts(state) {
    return this.fetchEvolutionJson(state, '/v1/evolution/cluster/cohorts');
  }

  clusterRuns(state, { limit = 30 } = {}) {
    return this.fetchEvolutionJson(state, `/v1/evolution/cluster/runs?limit=${encodeURIComponent(limit)}`);
  }

  marketCandidates(state, { familyId = '' } = {}) {
    const params = new URLSearchParams();
    if (familyId) params.set('familyId', familyId);
    return this.fetchEvolutionJson(state, `/v1/evolution/market/candidates?${params.toString()}`);
  }

  marketVersions(state, { familyId = '', agentInstanceId = '' } = {}) {
    const params = new URLSearchParams();
    if (familyId) params.set('familyId', familyId);
    if (agentInstanceId) params.set('agentInstanceId', agentInstanceId);
    return this.fetchEvolutionJson(state, `/v1/evolution/market/versions?${params.toString()}`);
  }

  marketCanaryStatus(state,{agentInstanceId=''}={}) {
    return this.fetchEvolutionJson(state,`/v1/evolution/market/canary?agentInstanceId=${encodeURIComponent(agentInstanceId)}`);
  }

  setMarketCanaryOptIn(state,payload={}) {
    return this.fetchEvolutionJson(state,'/v1/evolution/market/canary/opt-in',{method:'POST',body:JSON.stringify(payload)});
  }

  adoptMarketSections(state, payload = {}) {
    return this.fetchEvolutionJson(state, '/v1/evolution/market/adoptions', { method: 'POST', body: JSON.stringify(payload) });
  }

  rollbackMarketSections(state, payload = {}) {
    return this.fetchEvolutionJson(state, '/v1/evolution/market/adoptions/rollback', { method: 'POST', body: JSON.stringify(payload) });
  }

  ignoreMarketSections(state, payload = {}) {
    return this.fetchEvolutionJson(state, '/v1/evolution/market/adoptions/ignore', { method: 'POST', body: JSON.stringify(payload) });
  }

  effectiveMarketSkill(state, agentInstanceId = '') {
    return this.fetchEvolutionJson(state, `/v1/evolution/market/effective-skill/${encodeURIComponent(agentInstanceId)}`);
  }

  employeeOverview(state) {
    return this.fetchEmployeeJson(state, '/v1/employees');
  }

  employeeCapabilities(state) {
    return this.fetchEmployeeJson(state, '/v1/employees/capabilities');
  }

  employeeBootstrap(state, payload = {}) {
    return this.fetchEmployeeJson(state, '/v1/employees/bootstrap', {
      method: 'POST', body: JSON.stringify(payload),
    });
  }

  employeeCommand(state, payload = {}) {
    return this.fetchEmployeeJson(state, '/v1/employees/commands', {
      method: 'POST', body: JSON.stringify(payload),
    }).catch((error) => {
      if (error?.status === 409 && error.body?.status === 'rejected') return error.body;
      throw error;
    });
  }

  employeeEvents(state, { cursor = '', limit = 100 } = {}) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    return this.fetchEmployeeJson(state, `/v1/employees/events?${params.toString()}`);
  }

  fetchEmployeeJson(state, route, options = {}) {
    return this.fetchJson(state, route, {
      ...options,
      tokenOverride: state?.evolution_grant || state?.evolutionGrant || '',
      httpClient: this.employeeHttp,
    });
  }

  fetchEvolutionJson(state, route, options = {}) {
    return this.fetchJson(state, route, { ...options, tokenOverride: state?.evolution_grant || state?.evolutionGrant || '' });
  }

  fetchDeviceJson(state, route, options = {}) {
    return this.fetchJson(state, route, { ...options, tokenOverride: state?.device_grant || state?.deviceGrant || '' });
  }


  uploadCompliance(state, { status = '', limit = 100 } = {}) {
    const params = new URLSearchParams({ limit: String(limit || 100) });
    if (status) params.set('status', status);
    return this.fetchJson(state, `/v1/admin/upload-compliance?${params.toString()}`);
  }

  suspendCloudUser(state, { userId = '', reason = 'manual_suspension' } = {}) {
    return this.fetchJson(state, `/v1/admin/users/${encodeURIComponent(userId)}/suspend`, {
      method: 'POST', body: JSON.stringify({ reason }),
    });
  }

  reactivateCloudUser(state, { userId = '', reason = 'manual_reactivation' } = {}) {
    return this.fetchJson(state, `/v1/admin/users/${encodeURIComponent(userId)}/reactivate`, {
      method: 'POST', body: JSON.stringify({ reason }),
    });
  }

  traceFile(state, { sha256 = '', userId = '', deviceId = '' } = {}) {
    const params = new URLSearchParams();
    if (userId) params.set('userId', userId);
    if (deviceId) params.set('deviceId', deviceId);
    return this.fetchJson(state, `/v1/trace/files/${encodeURIComponent(sha256)}?${params.toString()}`);
  }

  traceConversation(state, { conversationId = '', userId = '', deviceId = '' } = {}) {
    const params = new URLSearchParams();
    if (userId) params.set('userId', userId);
    if (deviceId) params.set('deviceId', deviceId);
    return this.fetchJson(state, `/v1/conversations/${encodeURIComponent(conversationId)}?${params.toString()}`);
  }

  uploadFile(state, { sha256, body, localPath = '', sizeBytes = 0 } = {}) {
    return this.fetchJson(state, `/v1/files/${encodeURIComponent(sha256)}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'x-janus-file-path': encodeURIComponent(localPath),
        'x-janus-file-size': String(sizeBytes),
      },
      body,
    });
  }

  latestRelease(state, { channel = 'dev', platform = process.platform, arch = process.arch } = {}) {
    const params = new URLSearchParams({ channel, platform, arch });
    return this.fetchJson(state, `/v1/releases/latest?${params.toString()}`, {
      method: 'GET',
      requireToken: false,
    });
  }

  fetchJson(state, route, {
    method = 'GET',
    headers = {},
    body = undefined,
    requireToken = true,
    tokenOverride = '',
    httpClient = this.http,
  } = {}) {
    const url = joinUrl(normalizeServerUrl(state?.server_url), route);
    const requestHeaders = {
      accept: 'application/json',
      ...headers,
    };
    const requestToken = tokenOverride || state?.token || '';
    if (requireToken && requestToken) requestHeaders.authorization = `Bearer ${requestToken}`;
    if (body && typeof body === 'string') requestHeaders['content-type'] = requestHeaders['content-type'] || 'application/json';
    return httpClient.request(url, {
      method,
      route,
      headers: requestHeaders,
      body,
      errorMessage: ({ detail }) => detail || '云端请求失败，请稍后重试。',
    });
  }
}

export function normalizeServerUrl(value) {
  return normalizeBaseUrl(value);
}
