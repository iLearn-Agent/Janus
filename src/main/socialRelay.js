import crypto from 'node:crypto';
import os from 'node:os';

import { SocialClient } from '../../network/clients/socialClient.js';
import { packagedCloudSyncDefaults } from './cloudSync.js';
import { all, get, run } from './db.js';
import { newId, nowIso } from './utils.js';
import { validateUBuddyCapabilityProfile } from '../shared/contracts/uBuddyCapabilityProfile.js';

const STATE_ID = 'default';
const DEFAULT_SESSION_MAX_IDLE_MS = Math.max(60_000, Number(process.env.JANUS_AUTH_MAX_IDLE_DAYS || 7) * 24 * 60 * 60 * 1000);
// Keep cloud history catch-up incremental. A newly seeded test profile starts
// with an empty cursor; importing thousands of messages in one poll blocks the
// Electron main process and delays uBuddy task allocation/receipt events.
const SOCIAL_MESSAGE_POLL_PAGE_SIZE = 100;
const MAX_SOCIAL_MESSAGE_POLL_PAGES = 1;
const DELEGATION_POLL_PAGE_SIZE = 200;
const MAX_DELEGATION_POLL_PAGES = 20;
const MAX_COLLABORATION_GROUP_REPAIRS_PER_POLL = 10;
const COLLABORATION_GROUP_REPAIR_BASE_DELAY_MS = 30_000;
const COLLABORATION_GROUP_REPAIR_MAX_DELAY_MS = 5 * 60_000;
const SOCIAL_REALTIME_RETRY_BASE_MS = 1_000;
const SOCIAL_REALTIME_RETRY_MAX_MS = 30_000;
const FRIENDS_PRESENCE_PROJECTION_MAX_AGE_MS = 45_000;

export class SocialRelayService {
  constructor({ db, auth, client = new SocialClient(), secretCodec = null, defaultServerUrl = '', profileProvider = null,
    onSessionCleared = null, onOrganizationAccessRemoved = null,
    realtimeRetryBaseMs = SOCIAL_REALTIME_RETRY_BASE_MS, realtimeRetryMaxMs = SOCIAL_REALTIME_RETRY_MAX_MS } = {}) {
    this.db = db;
    this.auth = auth;
    this.client = client;
    this.secretCodec = secretCodec;
    this.profileProvider = profileProvider;
    this.defaultServerUrl = String(defaultServerUrl || '').trim();
    this.refreshPromise = null;
    this.realtimeController = null;
    this.realtimePromise = null;
    this.capabilityCache = null;
    this.organizationSecondaryVerificationGrants = new Map();
    this.collaborationGroupRepairState = new Map();
    this.collaborationProjectionCache = new Map();
    this.friendsPresenceProjection = null;
    this.onSessionCleared = onSessionCleared;
    this.onOrganizationAccessRemoved = onOrganizationAccessRemoved;
    this.realtimeRetryBaseMs = Math.max(1, Number(realtimeRetryBaseMs || SOCIAL_REALTIME_RETRY_BASE_MS));
    this.realtimeRetryMaxMs = Math.max(this.realtimeRetryBaseMs, Number(realtimeRetryMaxMs || SOCIAL_REALTIME_RETRY_MAX_MS));
    this.ensureState();
  }

  ensureState() {
    const existing = get(this.db, 'SELECT * FROM cloud_auth_state WHERE id = ?', [STATE_ID]);
    const hasExplicitAuthUrl = Object.hasOwn(process.env, 'JANUS_AUTH_URL');
    const serverUrl = String(hasExplicitAuthUrl
      ? process.env.JANUS_AUTH_URL
      : this.defaultServerUrl || packagedCloudSyncDefaults().serverUrl || '').trim();
    if (!existing) {
      run(
        this.db,
        `INSERT INTO cloud_auth_state (id, server_url, device_id, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [STATE_ID, serverUrl, newId('device'), serverUrl ? 1 : 0, nowIso()],
      );
    } else if (serverUrl && existing.server_url !== serverUrl) {
      run(this.db, 'UPDATE cloud_auth_state SET server_url = ?, enabled = 1, updated_at = ? WHERE id = ?', [serverUrl, nowIso(), STATE_ID]);
    }
  }

  state() {
    const row = get(this.db, 'SELECT * FROM cloud_auth_state WHERE id = ?', [STATE_ID]);
    if (!row) return row;
    return {
      ...row,
      access_token: this.decodeSecret(row.access_token),
      refresh_token: this.decodeSecret(row.refresh_token),
    };
  }

  encodeSecret(value = '') {
    const text = String(value || '');
    if (!text || !this.secretCodec?.encode) return text;
    try { return `safe:${this.secretCodec.encode(text)}`; } catch { return text; }
  }

  decodeSecret(value = '') {
    const text = String(value || '');
    if (!text.startsWith('safe:') || !this.secretCodec?.decode) return text;
    try { return this.secretCodec.decode(text.slice(5)); } catch { return ''; }
  }

  status() {
    const state = this.state();
    return {
      enabled: Boolean(state?.enabled && state?.server_url),
      connected: Boolean(state?.remote_user_id && (state?.access_token || state?.refresh_token)),
      serverUrl: state?.server_url || '',
      remoteUserId: state?.remote_user_id || '',
      deviceId: state?.device_id || '',
      lastPresenceAt: state?.last_presence_at || '',
      lastError: state?.last_error || '',
    };
  }

  enabled() {
    const state = this.state();
    return Boolean(state?.enabled && state?.server_url);
  }

  connected() {
    const state = this.state();
    return Boolean(this.enabled() && state?.remote_user_id && (state?.access_token || state?.refresh_token));
  }

  rememberFriendsPresenceProjection(overview = null) {
    const identityKey = this.friendsPresenceIdentityKey();
    if (!identityKey || !overview || typeof overview !== 'object') return overview;
    this.friendsPresenceProjection = { identityKey, overview, storedAt: Date.now() };
    return overview;
  }

  friendsOverviewWithCachedPresence(fallback = null) {
    const identityKey = this.friendsPresenceIdentityKey();
    return identityKey && this.friendsPresenceProjection?.identityKey === identityKey
      && Date.now() - Number(this.friendsPresenceProjection.storedAt || 0) <= FRIENDS_PRESENCE_PROJECTION_MAX_AGE_MS
      ? this.friendsPresenceProjection.overview
      : fallback;
  }

  friendsPresenceIdentityKey() {
    const state = this.state?.() || {};
    const userId = String(this.auth.currentUser?.()?.id || '').trim();
    const remoteUserId = String(state.remote_user_id || '').trim();
    const serverUrl = String(state.server_url || '').trim().replace(/\/+$/, '').toLowerCase();
    return userId ? `${userId}\n${remoteUserId}\n${serverUrl}` : '';
  }

  remoteUserId(userId = '') {
    const cleanId = String(userId || '').trim();
    if (!cleanId) return '';
    const row = get(this.db, `SELECT id,remote_id FROM auth_users
      WHERE id=? OR remote_id=?
      ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1`, [cleanId, cleanId, cleanId]);
    if (row?.remote_id) return row.remote_id;
    const current = this.auth.currentUser?.() || null;
    if (current?.id === cleanId) return current.remoteId || this.state()?.remote_user_id || cleanId;
    return cleanId;
  }

  localUserId(userId = '') {
    const cleanId = String(userId || '').trim();
    if (!cleanId) return '';
    return get(this.db, `SELECT id FROM auth_users
      WHERE id=? OR remote_id=?
      ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1`, [cleanId, cleanId, cleanId])?.id || cleanId;
  }

  async restoreSession({ maxIdleMs = DEFAULT_SESSION_MAX_IDLE_MS } = {}) {
    const state = this.state();
    if (!this.enabled() || !state?.refresh_token || !state?.remote_user_id) {
      return { restored: false, reason: 'no_saved_session' };
    }
    const lastActiveAt = new Date(state.updated_at || 0).getTime();
    if (!Number.isFinite(lastActiveAt) || Date.now() - lastActiveAt > maxIdleMs) {
      try { await this.client.logout(state); } catch {}
      this.clearSession({ deactivateUser: true });
      return { restored: false, expired: true, reason: 'idle_timeout' };
    }
    try {
      const result = await this.withRefresh((fresh) => this.client.me(fresh));
      const user = result?.user || result;
      const localUser = this.auth.importCloudUser(user, { activate: true });
      this.touchSession();
      await this.syncProfileUpdateOutbox().catch(() => null);
      return { restored: true, user: this.auth.currentUser?.() || localUser, lastActiveAt: state.updated_at };
    } catch (error) {
      const invalid = Number(error?.status || 0) === 401
        || ['social_session_expired', 'refresh_token_expired'].includes(String(error?.code || ''));
      if (invalid) {
        this.clearSession({ deactivateUser: true, error: String(error?.message || error) });
        return { restored: false, invalid: true, reason: 'session_invalid' };
      }
      const message = String(error?.message || error).slice(0, 1000);
      run(this.db, 'UPDATE cloud_auth_state SET last_error = ?, updated_at = ? WHERE id = ?', [message, nowIso(), STATE_ID]);
      return {
        restored: false,
        retryable: true,
        reason: 'session_restore_unavailable',
        code: String(error?.code || 'social_session_restore_unavailable'),
      };
    }
  }

  async sendEmailCode(payload = {}) {
    return this.client.sendEmailCode(this.state(), payload);
  }

  async register(payload = {}) {
    const remoteSession = await this.client.register(this.state(), payload);
    this.clearOrganizationSecondaryVerification();
    this.auth.clearOrganizationSecondaryVerification?.();
    const session = this.saveSession(remoteSession);
    await this.syncProfileUpdateOutbox().catch(() => null);
    return { ...session, user: this.auth.currentUser?.() || session.user };
  }

  async login(payload = {}) {
    const remoteSession = await this.client.login(this.state(), payload);
    this.clearOrganizationSecondaryVerification();
    this.auth.clearOrganizationSecondaryVerification?.();
    const session = this.saveSession(remoteSession);
    await this.syncProfileUpdateOutbox().catch(() => null);
    return { ...session, user: this.auth.currentUser?.() || session.user };
  }

  async logout() {
    const state = this.state();
    try {
      if (state?.refresh_token) await this.client.logout(state);
    } catch {
      // Local logout must still succeed when the relay is offline.
    }
    this.clearSession();
    return { ok: true };
  }

  async verifyEmail(payload = {}) {
    const result = await this.withRefresh((state) => this.client.verifyEmail(state, payload));
    return this.auth.importCloudUser(result.user || result, { activate: true });
  }

  resetPassword(payload = {}) {
    return this.client.resetPassword(this.state(), payload);
  }

  async updateProfile(payload = {}) {
    const requestPayload = { ...payload };
    if (Object.hasOwn(requestPayload, 'username') && !String(requestPayload.username || '').trim()) {
      delete requestPayload.username;
    }
    const result = await this.withRefresh((state) => this.client.updateProfile(state, requestPayload));
    const localUser = this.auth.importCloudUser(result.user || result, { activate: true });
    if (Object.hasOwn(requestPayload, 'avatarUrl') || Object.hasOwn(requestPayload, 'avatar_url')) {
      return this.auth.updateProfile({
        displayName: requestPayload.displayName ?? localUser?.displayName ?? localUser?.display_name ?? '',
        email: requestPayload.email ?? localUser?.email ?? '',
        username: requestPayload.username ?? localUser?.username ?? '',
        avatarUrl: requestPayload.avatarUrl ?? requestPayload.avatar_url ?? '',
      });
    }
    return localUser;
  }

  async syncProfileUpdateOutbox({ limit = 20 } = {}) {
    if (!this.connected() || typeof this.auth?.pendingProfileUpdates !== 'function') {
      return { processed: 0, completed: 0, failed: 0, skipped: true };
    }
    let processed = 0;
    let completed = 0;
    let failed = 0;
    for (const row of this.auth.pendingProfileUpdates({ limit })) {
      const currentUser = this.auth.currentUser?.();
      if (!currentUser || currentUser.id !== row.user_id || !currentUser.remoteBound) continue;
      processed += 1;
      this.auth.markProfileUpdateSending(row.user_id);
      try {
        await this.updateProfile(row.payload || {});
        this.auth.markProfileUpdateCompleted(row.user_id);
        completed += 1;
      } catch (error) {
        const retryable = retryableProfileUpdateError(error);
        this.auth.markProfileUpdateFailed(row.user_id, error?.message || error, { retryable });
        failed += 1;
        if (!retryable) continue;
        break;
      }
    }
    return { processed, completed, failed };
  }

  updatePassword(payload = {}) {
    return this.withRefresh((state) => this.client.updatePassword(state, payload));
  }

  requestProviderKeyApplication(payload = {}) {
    return this.withRefresh((state) => this.client.requestProviderKeyApplication(state, payload));
  }

  providerKeyApplications() {
    return this.withRefresh((state) => this.client.providerKeyApplications(state));
  }

  decideProviderKeyApplication(applicationId, payload = {}) {
    return this.withRefresh((state) => this.client.decideProviderKeyApplication(state, applicationId, payload));
  }

  claimProviderKeyApplication(applicationId) {
    return this.withRefresh((state) => this.client.claimProviderKeyApplication(state, applicationId));
  }

  confirmProviderKeyClaim(applicationId) {
    return this.withRefresh((state) => this.client.confirmProviderKeyClaim(state, applicationId));
  }

  saveSession(session = {}) {
    const user = session.user || session;
    const localUser = this.auth.importCloudUser(user, { activate: true });
    run(
      this.db,
      `UPDATE cloud_auth_state
       SET access_token = ?, refresh_token = ?, remote_user_id = ?, last_error = '', updated_at = ?
       WHERE id = ?`,
      [this.encodeSecret(session.accessToken), this.encodeSecret(session.refreshToken), localUser?.remoteId || user.id || '', nowIso(), STATE_ID],
    );
    return { ...session, user: localUser, provider: 'cloud' };
  }

  async withRefresh(callback) {
    try {
      const result = await callback(this.state());
      this.touchSession();
      return result;
    } catch (error) {
      if (Number(error?.status || 0) !== 401) throw error;
      if (!this.state()?.refresh_token) {
        this.clearSession({ deactivateUser: true, error: '登录状态已失效，请重新登录。' });
        throw expiredSocialSessionError();
      }
      try {
        await this.refreshSavedSession();
      } catch (refreshError) {
        if (Number(refreshError?.status || 0) !== 401) throw refreshError;
        this.clearSession({ deactivateUser: true, error: '登录状态已失效，请重新登录。' });
        throw expiredSocialSessionError();
      }
      try {
        const result = await callback(this.state());
        this.touchSession();
        return result;
      } catch (retryError) {
        if (Number(retryError?.status || 0) !== 401) throw retryError;
        try {
          await this.client.me(this.state());
          this.touchSession();
        } catch (identityError) {
          if (Number(identityError?.status || 0) === 401) {
            this.clearSession({ deactivateUser: true, error: '登录状态已失效，请重新登录。' });
            throw expiredSocialSessionError();
          }
          throw identityError;
        }
        throw rejectedSocialOperationError(retryError);
      }
    }
  }

  async refreshSavedSession() {
    if (!this.refreshPromise) {
      this.refreshPromise = this.client.refresh(this.state())
        .then((session) => this.saveSession(session))
        .finally(() => { this.refreshPromise = null; });
    }
    return this.refreshPromise;
  }

  touchSession() {
    run(this.db, "UPDATE cloud_auth_state SET last_error = '', updated_at = ? WHERE id = ?", [nowIso(), STATE_ID]);
  }

  clearSession({ deactivateUser = false, error = '' } = {}) {
    this.stopRealtimeEvents();
    this.clearOrganizationSecondaryVerification();
    this.collaborationProjectionCache.clear();
    this.collaborationGroupRepairState.clear();
    this.friendsPresenceProjection = null;
    this.auth.clearOrganizationSecondaryVerification?.();
    const state = this.state();
    run(
      this.db,
      `UPDATE cloud_auth_state
       SET access_token = '', refresh_token = '', remote_user_id = '', last_social_cursor = '',
           last_social_message_cursor = '', last_social_message_cursors_json = '{}', last_delegation_cursor = '', last_error = ?, updated_at = ?
       WHERE id = ?`,
      [String(error || '').slice(0, 1000), nowIso(), STATE_ID],
    );
    const current = this.auth.currentUser();
    try { this.onSessionCleared?.({ userId: current?.id || '', reason: error || 'local_logout' }); } catch {}
    if (deactivateUser && current && (current.id === state?.remote_user_id || current.authProvider === 'cloud')) this.auth.logout();
  }

  async friendsOverview() {
    const previousOrganizations = this.auth.organizationOverview?.().organizations || [];
    await this.presenceHeartbeat();
    const overview = await this.withRefresh((state) => this.client.friends(state));
    const currentOrganizationIds = new Set((overview?.organizations || []).map((item) => String(item?.id || '')));
    for (const organization of previousOrganizations) {
      const remoteId = String(organization?.remoteId || organization?.remote_id || organization?.id || '');
      if (remoteId && !currentOrganizationIds.has(remoteId)) {
        try { this.onOrganizationAccessRemoved?.({ organizationId: organization.id, action: 'remote_membership_removed' }); } catch {}
      }
    }
    return this.rememberFriendsPresenceProjection({
      ...this.auth.importCloudFriendsOverview(overview),
      organizationExitRequests: overview.organizationExitRequests || [],
      organizationNotices: overview.organizationNotices || [],
    });
  }

  async searchUsers(query = '') {
    const result = await this.withRefresh((state) => this.client.searchUsers(state, query));
    return Array.isArray(result) ? result : result.items || [];
  }

  async friendAction(action, payload = {}) {
    const contactRemarksSupported = action === 'remark'
      ? await this.socialCapabilities()
        .then((result) => Array.isArray(result?.capabilities) && result.capabilities.includes('contact-remarks-v1'))
        .catch(() => false)
      : false;
    const result = await this.withRefresh((state) => {
      if (action === 'send') return this.client.sendFriendRequest(state, payload);
      if (action === 'accept') return this.client.acceptFriendRequest(state, payload.requestId);
      if (action === 'reject') return this.client.rejectFriendRequest(state, payload.requestId);
      if (action === 'cancel') return this.client.cancelFriendRequest(state, payload.requestId);
      if (action === 'remove') return this.client.removeFriend(state, payload.userId);
      if (action === 'remark') {
        if (!contactRemarksSupported) return this.client.updateFriendRemark(state, payload.userId, payload.remark);
        return this.client.updateContactRemark(state, payload.userId, payload.remark).catch((error) => {
          if (Number(error?.status || 0) !== 404) throw error;
          return this.client.updateFriendRemark(state, payload.userId, payload.remark);
        });
      }
      if (action === 'block') return this.client.blockUser(state, payload.userId);
      throw new Error('Unsupported friend action.');
    });
    if (result?.overview) this.auth.importCloudFriendsOverview(result.overview);
    if (['remove', 'block'].includes(action)) {
      this.auth.purgeUBuddyCapabilityProfileCache?.({
        userIds: [payload.userId], remoteUserIds: [this.remoteUserId(payload.userId)], serverOriginHash: this.serverOriginHash(),
      });
    }
    return result;
  }

  async organizationAction(action, payload = {}) {
    const organizationId = String(payload.organizationId || '').trim();
    const sensitive = action === 'action' && sensitiveOrganizationAction(payload.action);
    const requestPayload = { ...payload };
    if (sensitive && organizationId) {
      const grant = this.organizationSecondaryVerificationGrants.get(organizationId) || '';
      if (grant && !requestPayload.verificationCode && !requestPayload.accountPassword) {
        requestPayload.secondaryVerificationGrant = grant;
        requestPayload.secondaryVerificationExpected = true;
      }
    }
    let result;
    try {
      result = await this.withRefresh((state) => {
        if (action === 'create') return this.client.createOrganization(state, requestPayload);
        if (action === 'join') return this.client.joinOrganization(state, requestPayload);
        if (action === 'action') return this.client.organizationAction(state, requestPayload.organizationId, requestPayload);
        throw new Error('Unsupported organization action.');
      });
    } catch (error) {
      if (sensitive && organizationId && ['organization_secondary_verification_expired', 'organization_secondary_verification_invalid']
        .includes(String(error?.code || '').trim())) {
        this.organizationSecondaryVerificationGrants.delete(organizationId);
      }
      throw error;
    }
    if (sensitive && organizationId && result?.secondaryVerificationGrant) {
      this.organizationSecondaryVerificationGrants.set(organizationId, String(result.secondaryVerificationGrant));
    }
    if (result && Object.hasOwn(result, 'secondaryVerificationGrant')) delete result.secondaryVerificationGrant;
    if (sensitive && organizationId) {
      result = { ...result, secondaryVerificationRemembered: this.organizationSecondaryVerificationGrants.has(organizationId) };
    }
    if (result?.overview) {
      const current = await this.withRefresh((state) => this.client.friends(state));
      if (organizationId && !(current?.organizations || []).some((item) => String(item?.id || '') === organizationId)) {
        this.organizationSecondaryVerificationGrants.delete(organizationId);
      }
      if (organizationMutationRemovesAccess(payload)) {
        this.auth.purgeUBuddyCapabilityProfileCache?.({ serverOriginHash: this.serverOriginHash(), allForServer: true });
        try { this.onOrganizationAccessRemoved?.({ organizationId, action: payload.action || '' }); } catch {}
      }
      return { ...result, overview: { ...this.auth.importCloudFriendsOverview(current), organizationExitRequests: current.organizationExitRequests || [], organizationNotices: current.organizationNotices || [] } };
    }
    return result;
  }

  clearOrganizationSecondaryVerification() {
    this.organizationSecondaryVerificationGrants.clear();
  }

  socialCapabilities() {
    if (this.capabilityCache && Date.now() - this.capabilityCache.loadedAt < 60_000) return Promise.resolve(this.capabilityCache.value);
    return this.withRefresh((state) => this.client.capabilities(state)).then((value) => {
      this.capabilityCache = { loadedAt: Date.now(), value };
      return value;
    });
  }

  organizationResearchPolicy(organizationId) {
    return this.withRefresh((state) => this.client.organizationResearchPolicy(state, this.remoteOrganizationId(organizationId)));
  }

  enableOrganizationResearch(organizationId, payload = {}) {
    return this.withRefresh((state) => this.client.enableOrganizationResearch(state, this.remoteOrganizationId(organizationId), payload));
  }

  acquireOrganizationResearchLease(organizationId, payload = {}) {
    return this.withRefresh((state) => this.client.acquireOrganizationResearchLease(state, this.remoteOrganizationId(organizationId), payload));
  }

  organizationResearchChanges(organizationId, payload = {}) {
    return this.withRefresh((state) => this.client.organizationResearchChanges(state, this.remoteOrganizationId(organizationId), payload));
  }

  organizationResearchContext(organizationId, sourceKind, messageId, payload = {}) {
    return this.withRefresh((state) => this.client.organizationResearchContext(
      state, this.remoteOrganizationId(organizationId), sourceKind, messageId, payload,
    ));
  }

  uploadOrganizationResearchAudit(organizationId, payload = {}) {
    return this.withRefresh((state) => this.client.uploadOrganizationResearchAudit(state, this.remoteOrganizationId(organizationId), payload));
  }

  organizationResearchAudits(organizationId, payload = {}) {
    return this.withRefresh((state) => this.client.organizationResearchAudits(state, this.remoteOrganizationId(organizationId), payload));
  }

  uploadUBuddyOrganizationEvolutionTrace(payload = {}) {
    return this.withRefresh((state) => this.client.uploadUBuddyOrganizationEvolutionTrace(state, payload));
  }

  uBuddyOrganizationEvolutionOverview() {
    return this.withRefresh((state) => this.client.uBuddyOrganizationEvolutionOverview(state));
  }

  uBuddyOrganizationEvolutionActivePolicy() {
    return this.withRefresh((state) => this.client.uBuddyOrganizationEvolutionActivePolicy(state));
  }

  uBuddyOrganizationEvolutionActivate(policyVersionId, payload = {}) {
    return this.withRefresh((state) => this.client.uBuddyOrganizationEvolutionActivate(state, policyVersionId, payload));
  }

  uBuddyOrganizationEvolutionDisable(payload = {}) {
    return this.withRefresh((state) => this.client.uBuddyOrganizationEvolutionDisable(state, payload));
  }

  uBuddyOrganizationEvolutionHealth(payload = {}) {
    return this.withRefresh((state) => this.client.uBuddyOrganizationEvolutionHealth(state, payload));
  }

  async delegationRealtimeSupported() {
    const result = await this.socialCapabilities();
    return Array.isArray(result?.capabilities) && result.capabilities.includes('delegation-realtime-sse-v1');
  }

  async delegationExecutionLeaseSupported() {
    const result = await this.socialCapabilities();
    return Array.isArray(result?.capabilities) && result.capabilities.includes('delegation-execution-lease-v1');
  }

  async delegationCreateIdempotencySupported() {
    const result = await this.socialCapabilities();
    return Array.isArray(result?.capabilities) && result.capabilities.includes('delegation-create-idempotency-v1');
  }

  async agentWorkDetailProjectionSupported() {
    const result = await this.socialCapabilities();
    return Array.isArray(result?.capabilities) && result.capabilities.includes('agent-work-detail-projection-v1');
  }

  async uBuddyCapabilityProfilesSupported() {
    const result = await this.socialCapabilities();
    return Array.isArray(result?.capabilities) && result.capabilities.includes('ubuddy-capability-profile-v1');
  }

  async recipientPresenceGatedDispatchSupported() {
    const result = await this.socialCapabilities();
    return Array.isArray(result?.capabilities) && result.capabilities.includes('recipient-presence-gated-dispatch-v1');
  }

  async collaborationPlannedParticipantsSupported() {
    const result = await this.socialCapabilities();
    return Array.isArray(result?.capabilities) && result.capabilities.includes('collaboration-planned-participants-v1');
  }

  async queryRecipientPresence({ userIds = [] } = {}) {
    if (!this.connected()) return { items: [], offline: true };
    const supported = await this.recipientPresenceGatedDispatchSupported();
    if (!supported) {
      const error = new Error('当前通信服务不支持离线等待派发，请先更新服务端后再发布任务。');
      error.code = 'recipient_presence_capability_required';
      error.retryable = false;
      throw error;
    }
    const localIds = [...new Set((Array.isArray(userIds) ? userIds : []).map(String).filter(Boolean))];
    const remoteIds = localIds.map((userId) => this.remoteUserId(userId)).filter(Boolean);
    const result = await this.withRefresh((state) => this.client.queryRecipientPresence(state, { userIds: remoteIds }));
    return {
      ...result,
      items: (result?.items || []).map((item) => ({ ...item, userId: this.localUserId(item.userId || '') })),
    };
  }

  presenceHeartbeat() {
    if (!this.connected()) return Promise.resolve({ skipped: true, reason: 'not_connected' });
    return this.withRefresh((state) => this.client.heartbeat(state, {
      deviceId: state.device_id,
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
    }));
  }

  serverOriginHash() {
    const origin = String(this.state()?.server_url || this.defaultServerUrl || '').trim().replace(/\/+$/, '').toLowerCase();
    return origin ? crypto.createHash('sha256').update(origin).digest('hex') : '';
  }

  async queryUBuddyCapabilityProfiles({ userIds = [], cachedOnly = false } = {}) {
    const localUserIds = uniqueSocialIds(userIds);
    const serverOriginHash = this.serverOriginHash();
    const cached = this.auth.uBuddyCapabilityProfiles?.({ userIds: localUserIds, serverOriginHash }) || [];
    if (cachedOnly || !this.connected()) return { profiles: cached, cached: true, offline: !this.connected() };
    if (!await this.uBuddyCapabilityProfilesSupported()) {
      return { profiles: cached, cached: true, unsupported: true, reason: 'server_capability_missing' };
    }
    const remoteUserIds = uniqueSocialIds(localUserIds.map((id) => this.remoteUserId(id)));
    const result = await this.withRefresh((state) => this.client.queryUBuddyCapabilityProfiles(state, { userIds: remoteUserIds }));
    this.auth.importCloudUBuddyCapabilityProfiles?.({
      profiles: result?.profiles || [],
      unavailableUserIds: result?.unavailableUserIds || [],
      requestedRemoteUserIds: remoteUserIds,
      serverOriginHash,
    });
    return {
      profiles: this.auth.uBuddyCapabilityProfiles?.({ userIds: localUserIds, serverOriginHash }) || [],
      unavailableUserIds: (result?.unavailableUserIds || []).map((id) => this.localUserId(id)),
      cached: false,
    };
  }

  ownUBuddyCapabilityProfile() {
    return this.withRefresh((state) => this.client.ownUBuddyCapabilityProfile(state));
  }

  publishUBuddyCapabilityProfile(payload = {}) {
    return this.withRefresh((state) => this.client.publishUBuddyCapabilityProfile(state, payload));
  }

  unpublishUBuddyCapabilityProfile(payload = {}) {
    return this.withRefresh((state) => this.client.unpublishUBuddyCapabilityProfile(state, payload));
  }

  async syncUBuddyCapabilityProfilePublication({ limit = 100 } = {}) {
    const rows = this.auth.listUBuddyCapabilityProfilePublicationOutbox?.({ limit }) || [];
    if (!rows.length) return { processed: 0 };
    const publishableRows = [];
    let rejected = 0;
    for (const row of rows) {
      const validation = row.operation_kind === 'publish'
        ? validateUBuddyCapabilityProfile(row.payload?.profile || {})
        : { valid: true };
      if (validation.valid) publishableRows.push(row);
      else {
        this.auth.markUBuddyCapabilityProfilePublicationOutbox?.({
          id: row.id,
          status: 'blocked_capability',
          error: 'profile_validation_failed',
          retryAt: '9999-12-31T23:59:59.999Z',
          scrubPayload: true,
        });
        rejected += 1;
      }
    }
    if (!publishableRows.length) return { processed: 0, rejected };
    if (!this.connected()) return { processed: 0, rejected, offline: true };
    const supported = await this.uBuddyCapabilityProfilesSupported().catch(() => false);
    if (!supported) {
      for (const row of publishableRows) this.auth.markUBuddyCapabilityProfilePublicationOutbox?.({
        id: row.id, status: 'blocked_capability', error: 'server_capability_missing',
      });
      return { processed: 0, rejected, blocked: publishableRows.length, reason: 'server_capability_missing' };
    }
    let processed = 0;
    for (const row of publishableRows) {
      try {
        this.auth.markUBuddyCapabilityProfilePublicationOutbox?.({ id: row.id, status: 'sending' });
        const result = row.operation_kind === 'unpublish'
          ? await this.unpublishUBuddyCapabilityProfile(row.payload)
          : await this.publishUBuddyCapabilityProfile(row.payload);
        this.auth.markUBuddyCapabilityProfilePublicationOutbox?.({ id: row.id, status: 'completed' });
        processed += 1;
        if (typeof this.profileProvider?.markUBuddyCapabilityProfilePublication === 'function') {
          await this.profileProvider.markUBuddyCapabilityProfilePublication({
            ownerUserId: this.auth.currentUser?.()?.id || row.owner_user_id || '',
            operationKind: row.operation_kind,
            profileRevision: Number(result?.item?.profile?.profileRevision || row.profile_revision || 0),
            stateRevision: Number(result?.stateRevision || result?.item?.stateRevision || 0),
          });
        }
      } catch (error) {
        const blocked = Number(error?.status || 0) === 426;
        this.auth.markUBuddyCapabilityProfilePublicationOutbox?.({
          id: row.id, status: blocked ? 'blocked_capability' : 'failed', error: error?.message || error,
        });
        if (!isTransientRelayError(error) && !blocked) throw error;
        break;
      }
    }
    return { processed, rejected };
  }

  realtimeCursorKey() {
    const state = this.state();
    return `social:realtime_cursor:${state?.remote_user_id || 'anonymous'}:${state?.device_id || 'local'}`;
  }

  realtimeCursor() {
    return Math.max(0, Number(get(this.db, 'SELECT value FROM app_settings WHERE key=?', [this.realtimeCursorKey()])?.value || 0) || 0);
  }

  saveRealtimeCursor(cursor = 0) {
    const value = String(Math.max(0, Number(cursor || 0) || 0));
    run(this.db, `INSERT INTO app_settings(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [this.realtimeCursorKey(), value]);
    return Number(value);
  }

  messageHistoryCatchUpKey() {
    const state = this.state();
    return `social:message_history_catchup:${state?.remote_user_id || 'anonymous'}:${state?.device_id || 'local'}`;
  }

  messageHistoryCatchUpActive() {
    return get(this.db, 'SELECT value FROM app_settings WHERE key=?', [this.messageHistoryCatchUpKey()])?.value === '1';
  }

  saveMessageHistoryCatchUpActive(active = false) {
    run(this.db, `INSERT INTO app_settings(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [this.messageHistoryCatchUpKey(), active ? '1' : '0']);
  }

  delegationCursorMapKey() {
    const state = this.state();
    return `social:delegation_cursors:${state?.remote_user_id || 'anonymous'}:${state?.device_id || 'local'}`;
  }

  delegationCursorMap() {
    const raw = get(this.db, 'SELECT value FROM app_settings WHERE key=?', [this.delegationCursorMapKey()])?.value || '';
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  saveDelegationCursorMap(cursors = {}) {
    run(this.db, `INSERT INTO app_settings(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [this.delegationCursorMapKey(), JSON.stringify(cursors || {})]);
    return cursors;
  }

  delegationHistoryBaselineMapKey() {
    const state = this.state();
    return `social:delegation_history_baselines:${state?.remote_user_id || 'anonymous'}:${state?.device_id || 'local'}`;
  }

  delegationHistoryBaselineMap() {
    const raw = get(this.db, 'SELECT value FROM app_settings WHERE key=?', [this.delegationHistoryBaselineMapKey()])?.value || '';
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  saveDelegationHistoryBaselineMap(baselines = {}) {
    run(this.db, `INSERT INTO app_settings(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [this.delegationHistoryBaselineMapKey(), JSON.stringify(baselines || {})]);
    return baselines;
  }

  startRealtimeEvents({ onEvent = null, onStatus = null } = {}) {
    if (this.realtimePromise && !this.realtimeController?.signal?.aborted) return this.realtimePromise;
    const controller = new AbortController();
    this.realtimeController = controller;
    const running = (async () => {
      let retryMs = this.realtimeRetryBaseMs;
      while (!controller.signal.aborted && this.connected()) {
        try {
          const supported = await this.delegationRealtimeSupported();
          if (!supported) {
            const capabilityRetryMs = 60_000;
            onStatus?.({ status: 'unsupported', retryMs: capabilityRetryMs });
            await abortableDelay(capabilityRetryMs, controller.signal);
            this.capabilityCache = null;
            continue;
          }
          onStatus?.({ status: 'connecting', cursor: this.realtimeCursor() });
          let eventObserved = false;
          await this.client.streamSocialEvents(this.state(), {
            cursor: this.realtimeCursor(),
            signal: controller.signal,
            onEvent: (event) => {
              eventObserved = true;
              retryMs = this.realtimeRetryBaseMs;
              if (Number(event?.sequence || 0) > 0) this.saveRealtimeCursor(event.sequence);
              onStatus?.({ status: 'connected', cursor: this.realtimeCursor() });
              try { onEvent?.(event); } catch {}
            },
          });
          if (!controller.signal.aborted) {
            onStatus?.({ status: 'reconnecting', reason: 'stream_closed', retryMs });
            await abortableDelay(retryMs, controller.signal);
            if (!eventObserved) retryMs = Math.min(this.realtimeRetryMaxMs, retryMs * 2);
          }
        } catch (error) {
          if (controller.signal.aborted) break;
          if (Number(error?.status || 0) === 401) {
            try {
              await this.refreshSavedSession();
            } catch (refreshError) {
              const refreshStatus = Number(refreshError?.status || 0);
              const refreshCode = String(refreshError?.code || '');
              if (refreshStatus === 401 || ['social_session_expired', 'refresh_token_expired'].includes(refreshCode)) {
                onStatus?.({ status: 'paused_auth', error: String(refreshError?.message || refreshError) });
                break;
              }
            }
          }
          this.capabilityCache = null;
          onStatus?.({ status: 'error', error: String(error?.message || error), retryMs });
          await abortableDelay(retryMs, controller.signal);
          retryMs = Math.min(this.realtimeRetryMaxMs, retryMs * 2);
        }
      }
      return { status: controller.signal.aborted ? 'stopped' : 'closed' };
    })();
    const tracked = running.finally(() => {
      if (this.realtimeController === controller) this.realtimeController = null;
      if (this.realtimePromise === tracked) this.realtimePromise = null;
    });
    this.realtimePromise = tracked;
    return tracked;
  }

  stopRealtimeEvents() {
    if (this.realtimeController && !this.realtimeController.signal.aborted) this.realtimeController.abort();
    this.realtimeController = null;
  }

  sendCallSignal(payload = {}) {
    const state = this.state();
    if (!state?.access_token) throw new Error('未登录，无法发送通话信令。');
    return this.client.sendCallSignal(state, payload);
  }

  getCallIceServers() {
    const state = this.state();
    if (!state?.access_token) throw new Error('未登录，无法获取通话网络配置。');
    return this.client.getCallIceServers(state);
  }

  getVideoRoomConfig(workspaceId = '', options = {}) {
    const state = this.state();
    if (!state?.access_token) throw new Error('未登录，无法获取多人通话配置。');
    return this.client.getVideoRoomConfig(state, workspaceId, options);
  }

  leaveVoiceCall(payload = {}) {
    return this.withRefresh((state) => this.client.leaveVoiceCall(state, {
      ...payload,
      workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
  }

  sendVoiceCallChat(payload = {}) {
    return this.withRefresh((state) => this.client.sendVoiceCallChat(state, {
      ...payload,
      workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
  }

  inviteVoiceCallParticipant(payload = {}) {
    return this.withRefresh((state) => this.client.inviteVoiceCallParticipant(state, {
      ...payload,
      workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
  }

  kickVoiceCallParticipant(payload = {}) {
    return this.withRefresh((state) => this.client.kickVoiceCallParticipant(state, {
      ...payload,
      workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
  }

  async resumableFileTransferSupported() {
    const result = await this.socialCapabilities();
    return Array.isArray(result?.capabilities) && result.capabilities.includes('resumable-file-transfer-v1');
  }

  async directDelegationFilesSupported() {
    const result = await this.socialCapabilities();
    return Array.isArray(result?.capabilities) && result.capabilities.includes('direct-delegation-files-v1');
  }

  createResumableFileUpload(payload = {}) {
    const scopeKind = String(payload.scopeKind || '').trim();
    const scopeId = scopeKind === 'social' ? this.remoteUserId(payload.scopeId || '') : payload.scopeId;
    return this.withRefresh((state) => this.client.createResumableFileUpload(state, {
      ...payload,
      scopeId,
      ...(scopeKind === 'collaboration_task' ? { socialCapability: 'direct-delegation-files-v1' } : {}),
      workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
  }

  resumableFileUpload(uploadId = '') {
    return this.withRefresh((state) => this.client.resumableFileUpload(state, uploadId));
  }

  uploadResumableFileChunk(uploadId = '', chunkIndex = 0, payload = {}) {
    return this.withRefresh((state) => this.client.uploadResumableFileChunk(state, uploadId, chunkIndex, payload));
  }

  completeResumableFileUpload(uploadId = '') {
    return this.withRefresh((state) => this.client.completeResumableFileUpload(state, uploadId));
  }

  async chatGroupsOverview(payload = {}) {
    const result = await this.withRefresh((state) => this.client.chatGroups(state, {
      ...payload, workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
    importCloudChatGroupResult(this.auth, result);
    await this.syncConversationPreferences().catch(() => null);
    return this.auth.chatGroupsOverview();
  }

  async createChatGroup(payload = {}) {
    const outgoing = this.remoteChatGroupPayload(payload);
    const result = await this.withRefresh((state) => this.client.createChatGroup(state, outgoing));
    return importCloudChatGroupResult(this.auth, result);
  }

  async chatGroup(groupId = '', payload = {}) {
    const result = await this.withRefresh((state) => this.client.chatGroup(state, groupId, {
      ...payload, workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
    return importCloudChatGroupResult(this.auth, result);
  }

  async sendChatGroupMessage(groupId = '', payload = {}) {
    const result = await this.withRefresh((state) => this.client.sendChatGroupMessage(state, groupId, {
      ...payload, workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
    return importCloudChatGroupResult(this.auth, result);
  }

  async markChatGroupRead(groupId = '', payload = {}) {
    return this.withRefresh((state) => this.client.markChatGroupRead(state, groupId, {
      ...payload, workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
  }

  async updateChatGroup(groupId = '', payload = {}) {
    const outgoing = this.remoteChatGroupPayload(payload);
    const result = await this.withRefresh((state) => this.client.updateChatGroup(state, groupId, outgoing));
    return importCloudChatGroupResult(this.auth, result);
  }

  remoteChatGroupPayload(payload = {}) {
    return {
      ...payload,
      workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
      ...(Array.isArray(payload.memberIds) ? { memberIds: payload.memberIds.map((id) => this.remoteUserId(id)) } : {}),
      ...(payload.userId ? { userId: this.remoteUserId(payload.userId) } : {}),
    };
  }

  async sendMessage(payload = {}) {
    const recipientId = this.remoteUserId(payload.recipientId || payload.userId || '');
    const outgoing = {
      ...payload,
      recipientId,
      workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
      ...(Object.hasOwn(payload, 'userId') ? { userId: recipientId } : {}),
    };
    const result = await this.withRefresh((state) => this.client.sendMessage(state, outgoing));
    if (result?.message) this.importMessage(result.message);
    return result;
  }

  recordVoiceCall(payload = {}) {
    return this.withRefresh((state) => this.client.recordVoiceCall(state, {
      ...payload,
      workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
      ...(payload.peerId ? { peerId: this.remoteUserId(payload.peerId) } : {}),
      ...(payload.callerId ? { callerId: this.remoteUserId(payload.callerId) } : {}),
    }));
  }

  uploadSocialFile(fileId = '', payload = {}) {
    return this.withRefresh((state) => this.client.uploadSocialFile(state, fileId, {
      ...payload,
      recipientId: this.remoteUserId(payload.recipientId || ''),
      workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
  }

  emojiFavorites() {
    return this.withRefresh((state) => this.client.emojiFavorites(state));
  }

  uploadEmojiFavorite(favoriteId = '', payload = {}) {
    return this.withRefresh((state) => this.client.uploadEmojiFavorite(state, favoriteId, payload));
  }

  downloadEmojiFavorite(favoriteId = '') {
    return this.withRefresh((state) => this.client.downloadEmojiFavorite(state, favoriteId));
  }

  deleteEmojiFavorite(favoriteId = '') {
    return this.withRefresh((state) => this.client.deleteEmojiFavorite(state, favoriteId));
  }

  reorderEmojiFavorites(ids = []) {
    return this.withRefresh((state) => this.client.reorderEmojiFavorites(state, ids));
  }

  downloadSocialFile(fileId = '', payload = {}) {
    return this.withRefresh((state) => this.client.downloadSocialFile(state, fileId, {
      ...payload, workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
  }

  uploadChatGroupMessageFile(groupId = '', fileId = '', payload = {}) {
    return this.withRefresh((state) => this.client.uploadChatGroupMessageFile(state, groupId, fileId, {
      ...payload, workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
  }

  downloadChatGroupMessageFile(groupId = '', fileId = '', payload = {}) {
    return this.withRefresh((state) => this.client.downloadChatGroupMessageFile(state, groupId, fileId, {
      ...payload, workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
  }

  uploadCollaborationGroupMessageFile(groupId = '', fileId = '', payload = {}) {
    return this.withRefresh((state) => this.client.uploadCollaborationGroupMessageFile(state, groupId, fileId, {
      ...payload, workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
  }

  downloadCollaborationGroupMessageFile(groupId = '', fileId = '', payload = {}) {
    return this.withRefresh((state) => this.client.downloadCollaborationGroupMessageFile(state, groupId, fileId, {
      ...payload, workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
  }

  async updateMessage(messageId, payload = {}) {
    const result = await this.withRefresh((state) => this.client.updateMessage(state, messageId, {
      ...payload, workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
    if (result?.message) this.importMessage(result.message);
    return result;
  }

  async toggleMessageReaction(messageId, payload = {}) {
    const result = await this.withRefresh((state) => this.client.toggleMessageReaction(state, messageId, {
      ...payload,
      workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
    if (result?.message) this.importMessage(result.message);
    return result;
  }

  async createDelegation(payload = {}) {
    const result = await this.withRefresh((state) => this.client.createDelegation(state, {
      ...payload,
      recipientId: this.remoteUserId(payload.recipientId || payload.userId || ''),
      socialCapability: payload.presenceGate === 'online_only' ? 'recipient-presence-gated-dispatch-v1' : payload.socialCapability,
      workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
    if (result?.delegation) this.importDelegation(result.delegation);
    if (result?.message) this.importMessage(result.message);
    return result;
  }

  async updateDelegation(delegationId, payload = {}) {
    const result = await this.withRefresh((state) => this.client.updateDelegation(state, delegationId, {
      ...payload, workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
    if (result?.delegation) this.importDelegation(result.delegation);
    if (result?.message) this.importMessage(result.message);
    return result;
  }

  claimDelegationExecution(delegationId, payload = {}) {
    return this.withRefresh((state) => this.client.claimDelegationExecution(state, delegationId, {
      ...payload, deviceId: payload.deviceId || state.device_id || '',
    }));
  }

  renewDelegationExecutionLease(delegationId, payload = {}) {
    return this.withRefresh((state) => this.client.renewDelegationExecutionLease(state, delegationId, {
      ...payload, deviceId: payload.deviceId || state.device_id || '',
    }));
  }

  releaseDelegationExecutionLease(delegationId, payload = {}) {
    return this.withRefresh((state) => this.client.releaseDelegationExecutionLease(state, delegationId, {
      ...payload, deviceId: payload.deviceId || state.device_id || '',
    }));
  }

  delegationWorkspace(delegationId = '', payload = {}) {
    return this.withRefresh((state) => this.client.delegationWorkspace(state, delegationId, {
      ...payload, workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
  }

  sendDelegationWorkspaceMessage(delegationId = '', payload = {}) {
    return this.withRefresh((state) => this.client.sendDelegationWorkspaceMessage(state, delegationId, {
      ...payload, workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
  }

  async collaborationOverview(payload = {}) {
    const { authoritativeTasks = false, ...requestPayload } = payload || {};
    const result = await this.withRefresh((state) => this.client.collaborationOverview(state, {
      ...requestPayload, workspaceId: this.remoteAccountWorkspaceId(requestPayload.workspaceId || requestPayload.accountWorkspaceId || 'workspace_personal'),
    }));
    if (authoritativeTasks) {
      for (const item of Array.isArray(result?.tasks) ? result.tasks : []) this.importDelegation(item, { authoritative: true });
    }
    await this.syncConversationPreferences().catch(() => null);
    return this.projectCollaborationOverview(result, {
      workspaceId: requestPayload.workspaceId || requestPayload.accountWorkspaceId || 'workspace_personal',
      authoritative: true,
    });
  }

  projectCollaborationOverview(result = {}, { workspaceId = '', authoritative = true, error = '' } = {}) {
    const localWorkspaceId = String(workspaceId || 'workspace_personal').trim() || 'workspace_personal';
    const cacheKey = `${this.auth.currentUser()?.id || ''}:${localWorkspaceId}`;
    const incoming = result && typeof result === 'object' ? result : {};
    if ((incoming.group || Array.isArray(incoming.groups)) && this.auth.importCloudCollaborationOverview) {
      this.auth.importCloudCollaborationOverview(incoming);
    }
    const merged = this.mergeCollaborationResult(incoming);
    const stored = this.auth.collaborationOverview?.({ workspaceId: localWorkspaceId }) || { groups: [], tasks: [] };
    const local = !authoritative && this.collaborationProjectionCache.has(cacheKey)
      ? this.collaborationProjectionCache.get(cacheKey)
      : stored;
    const localGroups = new Map((local.groups || [])
      .filter((group) => group?.id).map((group) => [String(group.id), group]));
    const remoteGroups = (incoming.group ? [incoming.group] : merged.groups || []).map((group) => {
      const cached = localGroups.get(String(group?.id || '')) || {};
      const mappedWorkspaceId = cached.workspaceId || cached.accountWorkspaceId || this.localAccountWorkspaceId(
        group?.workspaceId || group?.accountWorkspaceId || group?.account_workspace_id || localWorkspaceId,
      );
      return {
        ...cached,
        ...group,
        accountWorkspaceId: mappedWorkspaceId,
        workspaceId: mappedWorkspaceId,
        metadata: { ...(cached.metadata || {}), ...(group?.metadata || {}), localHistoryOnly: false },
        archived: Boolean(cached.archived),
        archiveRevision: Number(cached.archiveRevision || 0),
        archiveUpdatedAt: cached.archiveUpdatedAt || '',
        archiveAutoReopened: Boolean(cached.archiveAutoReopened),
        localHistoryOnly: false,
      };
    });
    const remoteGroupIds = new Set(remoteGroups.map((group) => String(group?.id || '')).filter(Boolean));
    const cachedGroups = (local.groups || [])
      .filter((group) => !remoteGroupIds.has(String(group?.id || '')))
      .map((group) => authoritative ? {
        ...group,
        localHistoryOnly: true,
        metadata: { ...(group.metadata || {}), localHistoryOnly: true },
      } : group);
    const projectedGroups = [...remoteGroups, ...cachedGroups];
    const projectedTasks = authoritative
      ? merged.tasks || []
      : uniqueItemsById([...(merged.tasks || []), ...(local.tasks || [])]);
    const projection = {
      ...incoming,
      groups: this.auth.decorateConversationGroups(
        uniqueItemsById(projectedGroups),
        'collaboration_group',
      ),
      // A successful cloud overview is authoritative for active tasks. A
      // failed/partial overview keeps the last valid local task projection.
      tasks: projectedTasks,
      collaborationSync: {
        ok: authoritative,
        stale: !authoritative,
        error: String(error || '').slice(0, 1000),
      },
    };
    if (authoritative || remoteGroups.length) {
      this.collaborationProjectionCache.set(cacheKey, {
        groups: projection.groups,
        tasks: projection.tasks,
      });
    }
    return projection;
  }

  async conversationArchiveSupported() {
    const result = await this.socialCapabilities();
    return Array.isArray(result?.capabilities) && result.capabilities.includes('conversation-inbox-archive-v1');
  }

  async syncConversationPreferences() {
    if (!this.connected() || !await this.conversationArchiveSupported()) return this.auth.conversationPreferencesOverview();
    for (const row of this.auth.listConversationPreferenceOutbox({ limit: 100 })) {
      // v1 cloud servers only understand group preferences.  Inbox-only direct
      // and Agent preferences remain safely local until v2 is advertised.
      if (['social_direct', 'agent_session'].includes(row.payload?.conversationKind)) continue;
      try {
        const result = await this.setConversationPreference(row.payload);
        this.auth.markConversationPreferenceOutbox({ id: row.id, status: 'completed' });
      } catch (error) {
        this.auth.markConversationPreferenceOutbox({ id: row.id, status: 'failed', error: error?.message || error });
        throw error;
      }
    }
    const result = await this.withRefresh((state) => this.client.conversationPreferences(state));
    return this.auth.importCloudConversationPreferences(result);
  }

  async setConversationPreference(payload = {}) {
    if (!this.connected() || !await this.conversationArchiveSupported()) {
      const error = new Error('当前通信服务不支持会话归档。');
      error.code = 'conversation_preference_server_update_required';
      throw error;
    }
    const result = await this.withRefresh((state) => this.client.setConversationPreference(state, {
      ...payload,
      workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
      sourceDeviceId: this.state()?.device_id || '',
    }));
    this.auth.importCloudConversationPreferences(result);
    return result;
  }

  async createCollaborationGroup(payload = {}) {
    const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
    const organizationAudienceSnapshot = metadata.organizationAudienceSnapshot
      && typeof metadata.organizationAudienceSnapshot === 'object'
      ? metadata.organizationAudienceSnapshot
      : null;
    const remoteOrganizationId = organizationAudienceSnapshot
      ? this.remoteOrganizationId(organizationAudienceSnapshot.organizationId)
      : '';
    const remoteOrganizationMemberIds = organizationAudienceSnapshot
      ? [...new Set((Array.isArray(organizationAudienceSnapshot.memberUserIds)
        ? organizationAudienceSnapshot.memberUserIds
        : []).map((userId) => this.remoteUserId(userId)).filter(Boolean))].sort()
      : [];
    const outgoingMetadata = organizationAudienceSnapshot ? {
      ...metadata,
      organizationAudienceSnapshot: {
        ...organizationAudienceSnapshot,
        organizationId: remoteOrganizationId,
        memberUserIds: remoteOrganizationMemberIds,
        memberCount: remoteOrganizationMemberIds.length,
        membershipHash: crypto.createHash('sha256')
          .update(`${remoteOrganizationId}\n${remoteOrganizationMemberIds.join('\n')}`, 'utf8')
          .digest('hex'),
      },
    } : metadata;
    const remotePlannedRecipientIds = [...new Set((Array.isArray(payload.plannedRecipientIds)
      ? payload.plannedRecipientIds
      : Array.isArray(metadata.plannedRecipientIds) ? metadata.plannedRecipientIds : [])
      .map((userId) => this.remoteUserId(userId)).filter(Boolean))];
    return this.projectPlannedCollaborationParticipants(this.mergeCollaborationResult(await this.withRefresh((state) => this.client.createCollaborationGroup(state, {
      ...payload,
      plannedRecipientIds: remotePlannedRecipientIds,
      metadata: { ...outgoingMetadata, plannedRecipientIds: remotePlannedRecipientIds },
      assignments: (Array.isArray(payload.assignments) ? payload.assignments : []).map((assignment) => ({
        ...assignment,
        recipientId: this.remoteUserId(assignment.recipientId || assignment.userId || ''),
      })),
      socialCapability: payload.presenceGate === 'online_only' ? 'recipient-presence-gated-dispatch-v1' : payload.socialCapability,
      workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }))));
  }

  async collaborationGroup(groupId = '', payload = {}) {
    try {
      const result = await this.withRefresh((state) => this.client.collaborationGroup(state, groupId, {
        ...payload, workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
      }));
      this.auth.importCloudCollaborationOverview?.(result);
      return this.projectPlannedCollaborationParticipants(this.mergeCollaborationResult(result));
    } catch (error) {
      const status = Number(error?.status || 0);
      if (payload.localHistoryOnly !== true || status === 401 || status === 403) throw error;
      try {
        const local = this.auth.collaborationGroup(groupId, {
          workspaceId: payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal',
        });
        return {
          ...local,
          group: {
            ...(local.group || {}),
            localHistoryOnly: true,
            metadata: { ...(local.group?.metadata || {}), localHistoryOnly: true },
          },
          workspace: { ...(local.workspace || {}), readOnly: true, localHistoryOnly: true },
          localHistoryOnly: true,
        };
      } catch {
        throw error;
      }
    }
  }

  mergeDelegationTasks(tasks = []) {
    return (Array.isArray(tasks) ? tasks : []).map((item) => {
      this.importDelegation(item);
      return this.auth.agentDelegationById(item.id) || item;
    });
  }

  async sendCollaborationMessage(groupId = '', payload = {}) {
    return this.mergeCollaborationResult(await this.withRefresh((state) => this.client.sendCollaborationMessage(state, groupId, {
      ...payload, workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    })));
  }

  async updateCollaborationGroup(groupId = '', payload = {}) {
    return this.mergeCollaborationResult(await this.withRefresh((state) => this.client.updateCollaborationGroup(state, groupId, {
      ...payload,
      socialCapability: payload.presenceGate === 'online_only' ? 'recipient-presence-gated-dispatch-v1' : payload.socialCapability,
      userId: payload.userId ? this.remoteUserId(payload.userId) : payload.userId,
      workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    })));
  }

  collaborationGroupWorkspace(groupId = '', payload = {}) {
    return this.withRefresh((state) => this.client.collaborationGroupWorkspace(state, groupId, {
      ...payload, workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
  }

  uploadCollaborationGroupWorkspaceFile(groupId = '', fileId = '', payload = {}) {
    return this.withRefresh((state) => this.client.uploadCollaborationGroupWorkspaceFile(state, groupId, fileId, {
      ...payload, workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
  }

  deleteCollaborationGroupWorkspaceFile(groupId = '', fileId = '', payload = {}) {
    return this.withRefresh((state) => this.client.deleteCollaborationGroupWorkspaceFile(state, groupId, fileId, {
      ...payload, workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
  }

  downloadCollaborationGroupWorkspaceFile(groupId = '', fileId = '', payload = {}) {
    return this.withRefresh((state) => this.client.downloadCollaborationGroupWorkspaceFile(state, groupId, fileId, {
      ...payload, workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
  }

  async collaborationTaskAction(delegationId = '', payload = {}) {
    const result = await this.withRefresh((state) => this.client.collaborationTaskAction(state, delegationId, {
      ...payload, workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
    const merged = this.mergeCollaborationResult(result);
    if (result?.delegation) this.importDelegation(result.delegation, { authoritative: true });
    const importedDelegation = result?.delegation
      ? this.auth.agentDelegationById(result.delegation.id)
      : null;
    const authoritativeDelegation = result?.delegation
      ? {
          ...(importedDelegation || {}),
          ...result.delegation,
          metadata: {
            ...(importedDelegation?.metadata || {}),
            ...(result.delegation.metadata || {}),
          },
        }
      : null;
    return {
      ...merged,
      tasks: authoritativeDelegation
        ? (merged.tasks || []).map((item) => item.id === authoritativeDelegation.id ? authoritativeDelegation : item)
        : merged.tasks || [],
      delegation: authoritativeDelegation,
    };
  }

  publishWorkMemory(payload = {}) {
    return this.withRefresh((state) => this.client.publishWorkMemory(state, payload));
  }

  appointWorkLeader(payload = {}) {
    return this.withRefresh((state) => this.client.appointWorkLeader(state, payload));
  }

  revokeWorkLeader(payload = {}) {
    return this.withRefresh((state) => this.client.revokeWorkLeader(state, payload));
  }

  readWorkMemory(payload = {}) {
    return this.withRefresh((state) => this.client.readWorkMemory(state, payload));
  }

  uploadCollaborationFile(delegationId = '', fileId = '', payload = {}) {
    return this.withRefresh((state) => this.client.uploadCollaborationFile(state, delegationId, fileId, {
      ...payload, workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
  }

  downloadCollaborationFile(fileId = '', payload = {}) {
    return this.withRefresh((state) => this.client.downloadCollaborationFile(state, fileId, {
      ...payload, workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
  }

  mergeCollaborationResult(result = {}) {
    return { ...(result || {}), tasks: this.mergeDelegationTasks(result?.tasks || []) };
  }

  projectPlannedCollaborationParticipants(result = {}) {
    const remoteParticipants = Array.isArray(result?.plannedParticipants) ? result.plannedParticipants : [];
    const remoteToLocal = new Map();
    const plannedParticipants = remoteParticipants.map((item) => {
      const remoteUserId = String(item?.userId || item?.user?.id || '').trim();
      const imported = item?.user ? this.auth.importCloudUser(item.user) : null;
      const localUserId = imported?.id || this.auth.remoteUserLocalId?.(remoteUserId) || remoteUserId;
      remoteToLocal.set(remoteUserId, localUserId);
      return { ...item, userId: localUserId, user: imported || item.user || { id: localUserId } };
    });
    const metadata = result?.group?.metadata || {};
    const plannedRecipientIds = (Array.isArray(metadata.plannedRecipientIds) ? metadata.plannedRecipientIds : [])
      .map((userId) => remoteToLocal.get(String(userId)) || this.auth.remoteUserLocalId?.(userId) || userId);
    return {
      ...result,
      group: result?.group ? { ...result.group, metadata: { ...metadata, plannedRecipientIds } } : result?.group,
      plannedParticipants,
    };
  }

  async markMessageRead(messageId, payload = {}) {
    const result = await this.withRefresh((state) => this.client.markMessageRead(state, messageId, {
      ...payload, workspaceId: this.remoteAccountWorkspaceId(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal'),
    }));
    run(this.db, "UPDATE social_messages SET status = 'read', read_at = ?, updated_at = ? WHERE id = ? OR remote_id = ?", [nowIso(), nowIso(), messageId, messageId]);
    return result;
  }

  async poll({ workspaceId: resultWorkspaceId = '', onCollaborationProjection = null } = {}) {
    if (!this.connected()) return { skipped: true, reason: 'not_connected' };
    try {
      await this.syncProfileUpdateOutbox();
      await this.presenceHeartbeat();
      const state = this.state();
      const legacyMessageCursor = state.last_social_message_cursor || '';
      const workspaceMessageCursors = parseCursorMap(state.last_social_message_cursors_json);
      const delegationCursorMap = this.delegationCursorMap();
      const delegationHistoryBaselines = this.delegationHistoryBaselineMap();
      const localUserId = this.auth.currentUser()?.id || '';
      const workspaceIds = localUserId ? all(this.db, `SELECT membership.workspace_id FROM account_workspace_memberships membership
        JOIN account_workspaces workspace ON workspace.id=membership.workspace_id
        WHERE membership.user_id=? AND membership.status='active' AND workspace.status='active'`, [localUserId]).map((row) => row.workspace_id) : ['workspace_personal'];
      const workspaceScopes = uniqueRemoteWorkspaceScopes(workspaceIds, (workspaceId) => this.remoteAccountWorkspaceId(workspaceId));
      const messagePagesPromise = Promise.all(workspaceScopes.map(async (scope) => {
        // Legacy installs only had one global cursor. Reuse it for Personal
        // once, but start organization scopes from an empty cursor so their
        // history cannot be skipped by the old global position.
        const cursor = workspaceMessageCursors[scope.remoteWorkspaceId]
          || (!Object.keys(workspaceMessageCursors).length && scope.remoteWorkspaceId === 'workspace_personal' ? legacyMessageCursor : '');
        const page = await collectRelayCursorPages({
          cursor,
          pageSize: SOCIAL_MESSAGE_POLL_PAGE_SIZE,
          maxPages: MAX_SOCIAL_MESSAGE_POLL_PAGES,
          fetchPage: (nextCursor) => this.withRefresh((fresh) => this.client.messages(fresh, {
            cursor: nextCursor, limit: SOCIAL_MESSAGE_POLL_PAGE_SIZE, workspaceId: scope.remoteWorkspaceId,
          })),
        });
        return { ...scope, ...page, previousCursor: cursor };
      }));
      const delegationPagesPromise = Promise.all(workspaceScopes.map(async (scope) => {
          const savedCursor = delegationCursorMap[scope.remoteWorkspaceId] || {};
          const historyCatchUp = delegationHistoryBaselines[scope.remoteWorkspaceId] !== true;
          const page = await collectDelegationCursorPages({
            cursor: savedCursor.cursor || '',
            cursorId: savedCursor.cursorId || '',
            pageSize: DELEGATION_POLL_PAGE_SIZE,
            maxPages: MAX_DELEGATION_POLL_PAGES,
            fetchPage: ({ cursor, cursorId }) => this.withRefresh((fresh) => this.client.delegations(fresh, {
              cursor, cursorId, limit: DELEGATION_POLL_PAGE_SIZE, workspaceId: scope.remoteWorkspaceId,
            })),
          });
          return { ...scope, ...page, historyCatchUp };
        }));
      const friendsPromise = this.withRefresh((fresh) => this.client.friends(fresh));
      const collaborationPagesPromise = Promise.all(workspaceScopes.map(async (scope) => {
          try {
            return {
              ...scope,
              ok: true,
              overview: await this.withRefresh((fresh) => this.client.collaborationOverview(fresh, {
                workspaceId: scope.remoteWorkspaceId,
              })),
              error: '',
            };
          } catch (error) {
            return { ...scope, ok: false, overview: { groups: [], tasks: [] }, error: String(error?.message || error) };
          }
        }));
      const chatGroupPagesPromise = Promise.all(workspaceScopes.map(async (scope) => ({
          ...scope,
          overview: await this.withRefresh((fresh) => this.client.chatGroups(fresh, { workspaceId: scope.remoteWorkspaceId }))
            .catch(() => ({ groups: [], capability: '' })),
        })));
      const remainingSocialPromise = Promise.all([messagePagesPromise, friendsPromise, chatGroupPagesPromise])
        .then((value) => ({ value, error: null }), (error) => ({ value: null, error }));
      const collaborationPages = await collaborationPagesPromise;
      const requestedRemoteWorkspaceId = this.remoteAccountWorkspaceId(resultWorkspaceId || 'workspace_personal');
      const publishCollaborationProjection = (pages = collaborationPages) => {
        const projectedPages = pages.map((page) => ({
          ...page,
          overview: this.projectCollaborationOverview(page.overview, {
            workspaceId: page.localWorkspaceIds[0] || this.localAccountWorkspaceId(page.remoteWorkspaceId),
            authoritative: page.ok,
            error: page.error,
          }),
        }));
        const requestedPage = projectedPages.find((page) => page.remoteWorkspaceId === requestedRemoteWorkspaceId);
        const allWorkspaces = mergeCollaborationOverviews(projectedPages.map((page) => page.overview));
        if (typeof onCollaborationProjection === 'function') {
          try {
            onCollaborationProjection({
              collaboration: requestedPage?.overview || { groups: [], tasks: [] },
              allWorkspaceCollaboration: allWorkspaces,
              collaborationSync: requestedPage?.overview?.collaborationSync
                || { ok: false, stale: true, error: 'workspace_not_polled' },
            });
          } catch {
            // UI projection failures must not abort social synchronization.
          }
        }
        return { projectedPages, requestedPage, allWorkspaces };
      };
      publishCollaborationProjection();
      const delegationPages = await delegationPagesPromise;
      const delegations = {
        items: uniqueItemsById(delegationPages.flatMap((page) => page.items || page.delegations || [])),
        cursor: delegationPages.map((page) => page.cursor || '').filter(Boolean).sort().at(-1) || state.last_delegation_cursor || '',
        workspaceCursors: Object.fromEntries(delegationPages.map((page) => [page.remoteWorkspaceId, {
          cursor: page.cursor || '', cursorId: page.cursorId || '',
        }])),
      };
      for (const item of delegations.items || delegations.delegations || []) this.importDelegation(item);
      await this.repairMissingCollaborationGroups({ collaborationPages, delegations: delegations.items || [] });
      const { requestedPage: requestedCollaborationPage, allWorkspaces: allWorkspaceCollaboration }
        = publishCollaborationProjection();
      const remainingSocial = await remainingSocialPromise;
      if (remainingSocial.error) throw remainingSocial.error;
      const [messagePages, friends, chatGroupPages] = remainingSocial.value;
      const messageWorkspacePages = messagePages;
      const messages = {
        items: uniqueItemsById(messageWorkspacePages.flatMap((page) => page.items || page.messages || [])),
        cursors: Object.fromEntries(messageWorkspacePages.map((page) => [page.remoteWorkspaceId, page.cursor || page.previousCursor || ''])),
        hadHistoryCatchUp: messageWorkspacePages.some((page) => !page.previousCursor && (page.items || page.messages || []).length > 0),
      };
      const delegationHistoryCatchUpPages = delegationPages.filter((page) => page.historyCatchUp);
      const delegationHistoryCatchUpWorkspaceIds = uniqueSocialIds(
        delegationHistoryCatchUpPages.flatMap((page) => page.localWorkspaceIds || []),
      );
      const nextDelegationHistoryBaselines = { ...delegationHistoryBaselines };
      for (const page of delegationPages) {
        if (page.complete) nextDelegationHistoryBaselines[page.remoteWorkspaceId] = true;
      }
      const requestedDelegationPage = delegationPages.find((page) => page.remoteWorkspaceId === requestedRemoteWorkspaceId);
      const collaboration = requestedCollaborationPage?.overview || { groups: [], tasks: [] };
      for (const page of chatGroupPages) importCloudChatGroupResult(this.auth, page.overview);
      const requestedChatPage = chatGroupPages.find((page) => page.remoteWorkspaceId === requestedRemoteWorkspaceId);
      const chatGroups = requestedChatPage
        ? (typeof this.auth?.chatGroupsOverview === 'function'
          ? this.auth.chatGroupsOverview({ workspaceId: requestedChatPage.localWorkspaceIds[0] || resultWorkspaceId || 'workspace_personal' })
          : requestedChatPage.overview)
        : { capability: 'chat-groups-v2', groups: [] };
      const projectedFriends = this.rememberFriendsPresenceProjection(this.auth.importCloudFriendsOverview(friends));
      const incomingMessages = [];
      for (const item of messages.items || messages.messages || []) {
        const messageId = this.importMessage(item);
        if (!messageId) continue;
        try {
          const workspaceId = this.localAccountWorkspaceId(
            item.workspaceId || item.accountWorkspaceId || item.account_workspace_id || 'workspace_personal',
          );
          const imported = this.auth.socialMessageById(messageId, { workspaceId });
          if (imported
            && imported.recipientUserId === localUserId
            && imported.senderUserId !== localUserId
            && imported.status !== 'read') incomingMessages.push(imported);
        } catch {
          // The inbox remains authoritative if a just-imported message cannot be hydrated for a notification.
        }
      }
      const nextMessageCursors = { ...workspaceMessageCursors, ...messages.cursors };
      const nextMessageCursor = Object.values(nextMessageCursors).filter(Boolean).sort().at(-1) || legacyMessageCursor || nowIso();
      const nextDelegationCursor = delegations.cursor || state.last_delegation_cursor || nowIso();
      const fetchedMessageCount = messages.items?.length || messages.messages?.length || 0;
      const historyCatchUp = Boolean(messages.hadHistoryCatchUp || (this.messageHistoryCatchUpActive() && fetchedMessageCount));
      this.saveMessageHistoryCatchUpActive(Boolean(historyCatchUp && fetchedMessageCount >= SOCIAL_MESSAGE_POLL_PAGE_SIZE));
      run(
        this.db,
        `UPDATE cloud_auth_state
         SET last_social_cursor = ?, last_social_message_cursor = ?, last_social_message_cursors_json = ?, last_delegation_cursor = ?,
             last_presence_at = ?, last_error = '', updated_at = ? WHERE id = ?`,
        [nextMessageCursor, nextMessageCursor, JSON.stringify(nextMessageCursors), nextDelegationCursor, nowIso(), nowIso(), STATE_ID],
      );
      this.saveDelegationCursorMap(delegations.workspaceCursors);
      this.saveDelegationHistoryBaselineMap(nextDelegationHistoryBaselines);
      return {
        ok: true,
        messages: messages.items?.length || messages.messages?.length || 0,
        historyCatchUp,
        // Historical imports rebuild the local inbox but must not behave like
        // newly delivered messages or trigger a notification storm.
        incomingMessages: historyCatchUp ? [] : incomingMessages,
        delegations: delegations.items?.length || delegations.delegations?.length || 0,
        delegationHistoryCatchUp: Boolean(requestedDelegationPage?.historyCatchUp),
        allWorkspaceDelegationHistoryCatchUp: delegationHistoryCatchUpPages.length > 0,
        delegationHistoryCatchUpWorkspaceIds,
        friends: projectedFriends,
        collaboration,
        allWorkspaceCollaboration,
        collaborationSync: requestedCollaborationPage?.overview?.collaborationSync || { ok: false, stale: true, error: 'workspace_not_polled' },
        chatGroups,
      };
    } catch (error) {
      run(this.db, 'UPDATE cloud_auth_state SET last_error = ? WHERE id = ?', [String(error.message || error).slice(0, 1000), STATE_ID]);
      throw error;
    }
  }

  async repairMissingCollaborationGroups({ collaborationPages = [], delegations = [] } = {}) {
    const knownGroupIds = new Set(collaborationPages.flatMap((page) => page.overview?.groups || [])
      .map((group) => String(group?.id || '')).filter(Boolean));
    const candidates = uniqueItemsById([
      ...collaborationPages.flatMap((page) => page.overview?.tasks || []),
      ...(Array.isArray(delegations) ? delegations : []),
    ].map((task) => ({
      id: String(task?.groupId || task?.group_id || task?.metadata?.groupId || '').trim(),
      workspaceId: task?.workspaceId || task?.accountWorkspaceId || task?.account_workspace_id || 'workspace_personal',
    }))).filter((item) => item.id && !knownGroupIds.has(item.id));
    const now = Date.now();
    const repairUserId = this.auth.currentUser()?.id || '';
    let attempted = 0;
    for (const candidate of candidates) {
      const repairKey = `${repairUserId}:${candidate.id}`;
      const retry = this.collaborationGroupRepairState.get(repairKey);
      if (retry?.nextAt > now) continue;
      if (attempted >= MAX_COLLABORATION_GROUP_REPAIRS_PER_POLL) break;
      attempted += 1;
      const remoteWorkspaceId = this.remoteAccountWorkspaceId(candidate.workspaceId);
      try {
        const detail = await this.withRefresh((state) => this.client.collaborationGroup(state, candidate.id, {
          workspaceId: remoteWorkspaceId,
        }));
        if (!detail?.group?.id) throw new Error('collaboration_group_repair_missing_group');
        const page = collaborationPages.find((item) => item.remoteWorkspaceId === remoteWorkspaceId)
          || collaborationPages.find((item) => item.localWorkspaceIds.includes(candidate.workspaceId));
        if (page) {
          page.overview = {
            ...(page.overview || {}),
            groups: uniqueItemsById([...(page.overview?.groups || []), detail.group]),
            tasks: uniqueItemsById([...(page.overview?.tasks || []), ...(detail.tasks || [])]),
          };
        }
        this.auth.importCloudCollaborationOverview?.(detail);
        this.collaborationGroupRepairState.delete(repairKey);
        knownGroupIds.add(candidate.id);
      } catch (error) {
        const attempt = Math.max(0, Number(retry?.attempt || 0)) + 1;
        const delay = Math.min(
          COLLABORATION_GROUP_REPAIR_MAX_DELAY_MS,
          COLLABORATION_GROUP_REPAIR_BASE_DELAY_MS * (2 ** Math.min(attempt - 1, 4)),
        );
        this.collaborationGroupRepairState.set(repairKey, {
          attempt,
          nextAt: now + delay,
          error: String(error?.message || error).slice(0, 1000),
        });
      }
    }
  }

  importMessage(item = {}) {
    const id = String(item.id || item.remoteId || '').trim();
    if (!id) return null;
    const sender = item.sender ? this.auth.importCloudUser(item.sender) : null;
    const recipient = item.recipient ? this.auth.importCloudUser(item.recipient) : null;
    const currentUser = this.auth.currentUser?.() || null;
    const savedState = this.state?.() || {};
    const remoteCurrentUserId = String(savedState.remote_user_id || '').trim();
    const rawSenderId = String(item.senderUserId || item.sender_user_id || item.sender?.id || '').trim();
    const rawRecipientId = String(item.recipientUserId || item.recipient_user_id || item.recipient?.id || '').trim();
    const senderUserId = sender?.id || (currentUser && rawSenderId === remoteCurrentUserId
      ? currentUser.id
      : this.localUserId(rawSenderId));
    const recipientUserId = recipient?.id || (currentUser && rawRecipientId === remoteCurrentUserId
      ? currentUser.id
      : this.localUserId(rawRecipientId));
    const accountWorkspaceId = this.localAccountWorkspaceId(item.workspaceId || item.accountWorkspaceId || item.account_workspace_id || 'workspace_personal');
    const conversationId = this.auth.ensureSocialDirectConversation({ senderUserId, recipientUserId, workspaceId: accountWorkspaceId });
    run(
      this.db,
      `INSERT INTO social_messages (
        id, account_workspace_id, conversation_id, sender_user_id, recipient_user_id, sender_agent_id, recipient_agent_id,
        kind, title, content, status, delivery_status, remote_id, metadata_json,
        created_at, updated_at, read_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'delivered', ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         account_workspace_id = excluded.account_workspace_id,
         conversation_id = excluded.conversation_id,
         sender_user_id = excluded.sender_user_id, recipient_user_id = excluded.recipient_user_id,
         sender_agent_id = excluded.sender_agent_id, recipient_agent_id = excluded.recipient_agent_id,
         kind = excluded.kind, title = excluded.title, content = excluded.content,
         status = excluded.status, delivery_status = 'delivered', metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at, read_at = excluded.read_at`,
      [
        id,
        accountWorkspaceId,
        conversationId,
        senderUserId,
        recipientUserId,
        item.senderAgentId || item.sender_agent_id || '',
        item.recipientAgentId || item.recipient_agent_id || '',
        item.kind || 'friend',
        item.title || '',
        item.content || '',
        item.status || 'unread',
        id,
        JSON.stringify(item.metadata || {}),
        item.createdAt || item.created_at || nowIso(),
        item.updatedAt || item.updated_at || nowIso(),
        item.readAt || item.read_at || null,
      ],
    );
    return id;
  }

  remoteAccountWorkspaceId(workspaceId = '') {
    const localId = String(workspaceId || 'workspace_personal').trim() || 'workspace_personal';
    if (localId === 'workspace_personal') return localId;
    const workspace = get(this.db, 'SELECT organization_id FROM account_workspaces WHERE id=?', [localId]);
    const organization = workspace?.organization_id
      ? get(this.db, 'SELECT id,remote_id FROM contact_organizations WHERE id=?', [workspace.organization_id])
      : null;
    const remoteOrganizationId = String(organization?.remote_id || organization?.id || '').trim();
    return remoteOrganizationId ? `workspace_org_${remoteOrganizationId}` : localId;
  }

  remoteOrganizationId(organizationId = '') {
    const localId = String(organizationId || '').trim();
    if (!localId) return '';
    const organization = get(this.db, `SELECT id,remote_id FROM contact_organizations
      WHERE id=? OR remote_id=? ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1`,
    [localId, localId, localId]);
    return String(organization?.remote_id || organization?.id || localId).trim();
  }

  localAccountWorkspaceId(workspaceId = '') {
    const remoteId = String(workspaceId || 'workspace_personal').trim() || 'workspace_personal';
    if (remoteId === 'workspace_personal') return remoteId;
    const organizationId = remoteId.startsWith('workspace_org_') ? remoteId.slice('workspace_org_'.length) : '';
    const organization = organizationId
      ? get(this.db, `SELECT id FROM contact_organizations WHERE remote_id=? OR id=?
        ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1`, [organizationId, organizationId, organizationId])
      : null;
    return organization?.id ? `workspace_org_${organization.id}` : remoteId;
  }

  importDelegation(item = {}, { authoritative = false } = {}) {
    const id = String(item.id || '').trim();
    if (!id) return null;
    if (item.requester) this.auth.importCloudUser(item.requester);
    if (item.recipient) this.auth.importCloudUser(item.recipient);
    const currentUserId = this.auth.currentUser()?.id || '';
    const recipientId = item.recipientUserId || item.recipient_user_id || item.recipient?.id || '';
    const incomingMetadata = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
    const existingRow = get(this.db, `SELECT task_run_id, metadata_json, status, last_error, group_id,
      title, instruction, updated_at, started_at, completed_at
      FROM agent_delegations WHERE id = ?`, [id]);
    const existingMetadata = parseMetadata(existingRow?.metadata_json);
    const incomingUpdatedAt = item.updatedAt || item.updated_at || '';
    const incomingTime = Date.parse(incomingUpdatedAt);
    const existingTime = Date.parse(existingRow?.updated_at || '');
    const staleRemoteRecord = Boolean(!authoritative && existingRow
      && Number.isFinite(incomingTime)
      && Number.isFinite(existingTime)
      && incomingTime < existingTime);
    const storedMetadata = staleRemoteRecord
      ? publicDelegationMetadata(existingMetadata)
      : { ...publicDelegationMetadata(existingMetadata), ...publicDelegationMetadata(incomingMetadata) };
    const incomingTaskRunId = item.taskRunId || item.task_run_id || '';
    const storedTaskRunId = staleRemoteRecord
      ? existingRow?.task_run_id || ''
      : incomingTaskRunId || (currentUserId === recipientId ? existingRow?.task_run_id || '' : '');
    const accountWorkspaceId = this.localAccountWorkspaceId(
      item.workspaceId || item.accountWorkspaceId || item.account_workspace_id || 'workspace_personal',
    );
    run(
      this.db,
      `INSERT INTO agent_delegations (
        id, account_workspace_id, requester_user_id, recipient_user_id, sender_agent_id, recipient_agent_id,
        title, instruction, status, session_id, task_run_id, group_id, metadata_json, last_error,
        created_at, updated_at, started_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         account_workspace_id = excluded.account_workspace_id,
         requester_user_id = excluded.requester_user_id, recipient_user_id = excluded.recipient_user_id,
         title = excluded.title, instruction = excluded.instruction, status = excluded.status,
         task_run_id = excluded.task_run_id, group_id = excluded.group_id,
         metadata_json = excluded.metadata_json, last_error = excluded.last_error,
         updated_at = excluded.updated_at, started_at = excluded.started_at, completed_at = excluded.completed_at`,
      [
        id,
        accountWorkspaceId,
        item.requesterUserId || item.requester_user_id || item.requester?.id || '',
        recipientId,
        item.senderAgentId || item.sender_agent_id || 'secretary_agent',
        item.recipientAgentId || item.recipient_agent_id || 'secretary_agent',
        staleRemoteRecord ? existingRow?.title || item.title || '' : item.title || '',
        staleRemoteRecord ? existingRow?.instruction || item.instruction || '' : item.instruction || '',
        staleRemoteRecord ? existingRow?.status || 'assigned' : item.status || 'assigned',
        '',
        storedTaskRunId,
        staleRemoteRecord ? existingRow?.group_id || '' : item.groupId || item.group_id || incomingMetadata.groupId || '',
        JSON.stringify(storedMetadata),
        staleRemoteRecord ? existingRow?.last_error || '' : item.lastError || item.last_error || '',
        item.createdAt || item.created_at || nowIso(),
        staleRemoteRecord ? existingRow?.updated_at || incomingUpdatedAt || nowIso() : incomingUpdatedAt || nowIso(),
        staleRemoteRecord ? existingRow?.started_at || null : item.startedAt || item.started_at || null,
        staleRemoteRecord ? existingRow?.completed_at || null : item.completedAt || item.completed_at || null,
      ],
    );
    if (!staleRemoteRecord && [item.requesterUserId || item.requester_user_id || item.requester?.id || '', recipientId].includes(currentUserId)) {
      const workspaceMetadata = privateDelegationMetadata(incomingMetadata);
      const sessionId = item.sessionId || item.session_id || '';
      if (sessionId || Object.keys(workspaceMetadata).length) {
        this.auth.upsertDelegationWorkspace({
          delegationId: id,
          workspaceId: accountWorkspaceId,
          sessionId,
          metadata: workspaceMetadata,
        });
      }
    }
    return id;
  }

  pendingIncomingDelegations() {
    const user = this.auth.currentUser();
    if (!user) return [];
    return all(
      this.db,
      `SELECT id FROM agent_delegations
       WHERE recipient_user_id = ? AND status IN ('assigned', 'preparing', 'awaiting_approval', 'accepted', 'running')
       ORDER BY created_at ASC`,
      [user.id],
    ).map((row) => row.id);
  }
}

function uniqueRemoteWorkspaceScopes(workspaceIds = [], resolveRemoteWorkspaceId = (workspaceId) => workspaceId) {
  const scopes = new Map();
  for (const rawWorkspaceId of Array.isArray(workspaceIds) ? workspaceIds : []) {
    const localWorkspaceId = String(rawWorkspaceId || '').trim();
    if (!localWorkspaceId) continue;
    const remoteWorkspaceId = String(resolveRemoteWorkspaceId(localWorkspaceId) || localWorkspaceId).trim();
    if (!remoteWorkspaceId) continue;
    const existing = scopes.get(remoteWorkspaceId);
    if (existing) {
      existing.localWorkspaceIds.push(localWorkspaceId);
      continue;
    }
    scopes.set(remoteWorkspaceId, { remoteWorkspaceId, localWorkspaceIds: [localWorkspaceId] });
  }
  if (!scopes.size) scopes.set('workspace_personal', { remoteWorkspaceId: 'workspace_personal', localWorkspaceIds: ['workspace_personal'] });
  return [...scopes.values()];
}

function parseCursorMap(value = '') {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed)
      .map(([key, cursor]) => [String(key || '').trim(), String(cursor || '').trim()])
      .filter(([key, cursor]) => key && cursor));
  } catch {
    return {};
  }
}

function uniqueSocialIds(value = []) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 100);
}

function sensitiveOrganizationAction(action = '') {
  return [
    'promote_admin', 'revoke_admin', 'remove_member', 'transfer_owner',
    'update_invitation_code', 'resolve_exit', 'owner_exit',
  ].includes(String(action || '').trim().toLowerCase());
}

function organizationMutationRemovesAccess(payload = {}) {
  const action = String(payload.action || '').trim().toLowerCase();
  return ['remove_member', 'request_exit', 'resolve_exit', 'owner_exit', 'dismiss'].includes(action);
}

function retryableProfileUpdateError(error) {
  const status = Number(error?.status || 0);
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  if (status >= 400 && status < 500) return false;
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || error || '').toLowerCase();
  return ['econnreset', 'econnrefused', 'enotfound', 'eai_again', 'etimedout'].includes(code)
    || /fetch failed|network error|socket hang up|connection (?:closed|refused)|timed? out|temporarily unavailable/.test(message);
}

function isTransientRelayError(error = {}) {
  const status = Number(error?.status || 0);
  return !status || status === 408 || status === 429 || status >= 500;
}

function uniqueItemsById(items = []) {
  const unique = new Map();
  const anonymous = [];
  for (const item of Array.isArray(items) ? items : []) {
    const id = String(item?.id || item?.remoteId || '').trim();
    if (!id) {
      anonymous.push(item);
      continue;
    }
    const previous = unique.get(id);
    unique.set(id, previous ? { ...previous, ...item } : item);
  }
  return [...unique.values(), ...anonymous];
}

async function collectRelayCursorPages({
  cursor = '', pageSize = 200, maxPages = 20, fetchPage,
} = {}) {
  const items = [];
  let nextCursor = String(cursor || '');
  const safePageSize = Math.max(1, Number(pageSize || 200));
  const safeMaxPages = Math.max(1, Number(maxPages || 20));
  for (let pageNo = 0; pageNo < safeMaxPages; pageNo += 1) {
    const requestedCursor = nextCursor;
    const page = await fetchPage(requestedCursor);
    const pageItems = Array.isArray(page?.items)
      ? page.items
      : Array.isArray(page?.messages) ? page.messages : [];
    items.push(...pageItems);
    nextCursor = String(page?.cursor || requestedCursor || '');
    if (pageItems.length < safePageSize || nextCursor === requestedCursor) break;
  }
  return { items, cursor: nextCursor };
}

async function collectDelegationCursorPages({
  cursor = '', cursorId = '', pageSize = 200, maxPages = 20, fetchPage,
} = {}) {
  const items = [];
  let nextCursor = String(cursor || '');
  let nextCursorId = String(cursorId || '');
  const safePageSize = Math.max(1, Number(pageSize || 200));
  const safeMaxPages = Math.max(1, Number(maxPages || 20));
  let complete = false;
  for (let pageNo = 0; pageNo < safeMaxPages; pageNo += 1) {
    const requestedCursor = nextCursor;
    const requestedCursorId = nextCursorId;
    const page = await fetchPage({ cursor: requestedCursor, cursorId: requestedCursorId });
    const pageItems = Array.isArray(page?.items)
      ? page.items
      : Array.isArray(page?.delegations) ? page.delegations : [];
    items.push(...pageItems);
    nextCursor = String(page?.cursor || requestedCursor || '');
    nextCursorId = String(page?.cursorId || requestedCursorId || '');
    if (pageItems.length < safePageSize
      || (nextCursor === requestedCursor && nextCursorId === requestedCursorId)) {
      complete = true;
      break;
    }
  }
  return { items, cursor: nextCursor, cursorId: nextCursorId, complete };
}

function mergeCollaborationOverviews(overviews = []) {
  return {
    groups: uniqueItemsById(overviews.flatMap((overview) => overview?.groups || [])),
    tasks: uniqueItemsById(overviews.flatMap((overview) => overview?.tasks || [])),
  };
}

function importCloudChatGroupResult(auth, result) {
  return typeof auth?.importCloudChatGroupResult === 'function'
    ? auth.importCloudChatGroupResult(result)
    : result;
}

function parseMetadata(value = '') {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function abortableDelay(ms = 0, signal = null) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, Math.max(0, Number(ms || 0)));
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', done);
      resolve();
    }
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

function privateDelegationMetadata(metadata = {}) {
  const result = {};
  for (const key of [
    'preliminaryResult', 'intakeSummary', 'threadId', 'answerMessageId', 'sessionId', 'workspaceSessionId',
    'taskWorkspaceRoot', 'generatedTaskFiles', 'ownerConfirmationRequired', 'safePreparationOnly',
    'specializedExecutionError', 'recoveryExecutionError', 'deterministicRecovery',
    'workspaceUpdatedAt', 'workspaceExecutionError', 'workspaceExecutionFailedAt', 'workspaceRevisionRecovered',
    'ubuddyTeamCoordination', 'sourceSecretarySessionId', 'sourceSecretaryMessageId', 'ownerSecretarySessionId', 'ownerSecretaryMessageId',
    'executionEpoch', 'taskOrigin', 'activeTaskRunId', 'attemptTaskRunIds',
    'executionFailureDetail', 'syncState', 'syncError', 'pendingRemoteUpdate', 'pendingWorkspaceSync',
    'pendingSharedWorkspaceSync', 'sharedWorkspaceSyncError',
    'source_conversation_id', 'sourceConversationId', 'source_message_id', 'sourceMessageId',
    'source_group_id', 'sourceGroupId',
  ]) {
    if (Object.prototype.hasOwnProperty.call(metadata, key)) result[key] = metadata[key];
  }
  return result;
}

function publicDelegationMetadata(metadata = {}) {
  const privateKeys = new Set([
    'preliminaryResult', 'intakeSummary', 'threadId', 'answerMessageId', 'sessionId', 'workspaceSessionId',
    'taskWorkspaceRoot', 'generatedTaskFiles', 'ownerConfirmationRequired', 'safePreparationOnly',
    'specializedExecutionError', 'recoveryExecutionError', 'deterministicRecovery',
    'workspaceUpdatedAt', 'workspaceExecutionError', 'workspaceExecutionFailedAt', 'workspaceRevisionRecovered',
    'ubuddyTeamCoordination', 'sourceSecretarySessionId', 'sourceSecretaryMessageId', 'ownerSecretarySessionId', 'ownerSecretaryMessageId',
    'executionEpoch', 'taskOrigin', 'activeTaskRunId', 'attemptTaskRunIds',
    'executionFailureDetail', 'syncState', 'syncError', 'pendingRemoteUpdate', 'pendingWorkspaceSync',
    'pendingSharedWorkspaceSync', 'sharedWorkspaceSyncError',
    'source_conversation_id', 'sourceConversationId', 'source_message_id', 'sourceMessageId',
    'source_group_id', 'sourceGroupId',
  ]);
  return Object.fromEntries(Object.entries(metadata && typeof metadata === 'object' ? metadata : {}).filter(([key]) => !privateKeys.has(key)));
}

function expiredSocialSessionError() {
  const error = new Error('登录状态已失效，请重新登录后再发布任务。');
  error.status = 401;
  error.code = 'social_session_expired';
  return error;
}

function rejectedSocialOperationError(error = {}) {
  const route = String(error?.route || '');
  const isFriendRemark = String(error?.method || '').toUpperCase() === 'PATCH'
    && (/^\/api\/friends\//.test(route) || /^\/api\/contacts\/[^/]+\/remark$/.test(route));
  const message = isFriendRemark
    ? '登录状态有效，但当前云服务尚未支持联系人备注。请更新并重启云服务后重试。'
    : '登录状态有效，但云服务拒绝了该操作。请确认云服务已更新并重启后重试。';
  const result = new Error(message);
  result.status = 401;
  result.code = isFriendRemark ? 'friend_remark_server_update_required' : 'social_operation_rejected';
  result.route = route;
  return result;
}
