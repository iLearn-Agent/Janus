import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { apiError, errorResponse, mapPgError } from './errors.mjs';
import { cloudDatabaseReadiness, inTransaction } from './db.mjs';
import {
  evolutionEncryptionReady,
  evolutionEnvelopePublicKeyringFromEnv,
  evolutionKeyringFromEnv,
  logDeprecatedEvolutionEnvironment,
} from '../../src/shared/evolution/index.js';
import { createExpressNetworkMiddleware, route } from '../../network/server/express.js';
import { profileAvatarUrlValidation } from '../../src/shared/profileAvatar.js';

const BUILD_PACKAGE = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const BUILD_VERSION = String(BUILD_PACKAGE.version || '').trim();
import {
  delegationTransitionAllowed,
  isDelegationStatus,
  legacyDelegationTransitionAllowed,
  nextDelegationStatus,
  normalizeDelegationStatus,
  privateDelegationMetadata,
  privateWorkspaceMessageMetadata,
  publicDelegationMetadata,
  publicDelegationSubmissionText,
} from './modules/collaboration/index.mjs';
import {
  hashEmailCode,
  hashPassword,
  hashRefreshToken,
  newId,
  randomCode,
  randomToken,
  signAccessToken,
  verifyAccessToken,
  verifyPassword,
} from './security.mjs';
import {
  MAX_COLLABORATION_FILE_BYTES,
  authMiddleware,
  authenticateRequest,
  sessionResponse,
  ensurePersonalAccountWorkspaceMembership,
  consumeEmailCode,
  friendsOverview,
  createOrganization,
  joinOrganization,
  organizationAction,
  userSearchPayload,
  acceptFriendRequestInTransaction,
  closeFriendRequest,
  pendingFriendRequest,
  friendshipBetween,
  isBlockedEitherWay,
  findUserByEmail,
  findUserByIdentifier,
  getUserById,
  uniqueUsername,
  sessionPayload,
  normalizeSessionPatch,
  normalizeSessionId,
  normalizeSessionStatus,
  normalizeOptionalDate,
  userPayload,
  publicUser,
  friendRequestPayload,
  friendshipPayload,
  requireMessagingFriend,
  parseCursor,
  jsonObject,
  normalizeMessageKind,
  hydratedSocialMessage,
  socialMessagePayload,
  delegationSelectSql,
  hydratedDelegation,
  delegationPayloadsForViewer,
  delegationPayload,
  delegationWorkspacePayload,
  delegationWorkspaceMessagePayload,
  emptyTaskRouting,
  insertPrivateTaskIngress,
  routeGroupMessageToPrivateThreads,
  requireDelegationParticipant,
  requireActiveTaskMembership,
  publicTaskActionMetadata,
  publicSocialMessageMetadata,
  collaborationFilename,
  collaborationContentDisposition,
  collaborationFileAttachment,
  collaborationGroupWorkspaceRelativePath,
  collaborationGroupWorkspacePayload,
  collaborationGroupWorkspaceFilePayload,
  ensureCollaborationGroupWorkspace,
  activeCollaborationMembership,
  collaborationGroupPayload,
  collaborationMemberPayload,
  collaborationMessagePayload,
  collaborationOverview,
  collaborationGroupDetail,
  one,
  many,
  orderedUserPair,
  normalizeEmail,
  normalizePurpose,
  normalizeCode,
  validatePassword,
  normalizeDisplayName,
  normalizeUsername,
  normalizeRole,
  toIso,
} from './modules/platform/index.mjs';
import { registerEvolutionRoutes } from './modules/evolution/index.mjs';
import { createPostgresAuthoritativeEvidence } from './modules/evolution/authoritativeEvidence.mjs';
import { registerEmployeeRoutes } from './modules/employees/index.mjs';
import { registerWorkMemoryRoutes } from './modules/work-memory/index.mjs';
import { registerSyncRoutes } from './modules/sync/index.mjs';
import { releaseArtifactFile } from '../../src/shared/releaseLayout.js';
import { normalizeMentionEntities } from '../../src/shared/contracts/mentions.js';
import {
  normalizeUBuddyCapabilityProfile,
  validateUBuddyCapabilityProfile,
} from '../../src/shared/contracts/uBuddyCapabilityProfile.js';

export { permissionsForRole } from './modules/platform/index.mjs';

const FAST_FILE_LIMIT_BYTES = 60 * 1024 * 1024;
const LARGE_FILE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
const LARGE_FILE_CHUNK_BYTES = 16 * 1024 * 1024;
const LARGE_FILE_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

function providerKeyApplicationPayload(row = {}) {
  return {
    id: String(row.id || ''),
    userId: String(row.user_id || ''),
    accountEmail: String(row.account_email || ''),
    organization: String(row.organization || ''),
    usage: String(row.usage || ''),
    status: String(row.status || 'pending'),
    decisionNote: String(row.decision_note || ''),
    reviewedByUserId: String(row.reviewed_by_user_id || ''),
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : '',
    grantExpiresAt: row.grant_expires_at ? new Date(row.grant_expires_at).toISOString() : '',
    claimedAt: row.claimed_at ? new Date(row.claimed_at).toISOString() : '',
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : '',
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : '',
  };
}

function providerKeyDistribution(config = {}) {
  const baseUrl = String(config.providerKeyDistributionBaseUrl || '').trim().replace(/\/+$/, '');
  const apiKey = String(config.providerKeyDistributionKey || '').trim();
  const model = String(config.providerKeyDistributionModel || '').trim();
  return { ready: Boolean(baseUrl && apiKey), baseUrl, apiKey, model };
}

function requireProviderKeyReviewer(user = null) {
  if (user?.role === 'admin') return user;
  throw apiError('forbidden', '只有云端管理员可以审核 Provider Key 申请。', 403);
}

function providerKeyGrantExpiry(value = '') {
  const text = String(value || '').trim();
  if (!text) return null;
  const timestamp = new Date(text);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.getTime() <= Date.now()) {
    throw apiError('grant_expiry_invalid', '授权有效期必须是未来时间。', 400);
  }
  return timestamp;
}

async function issuePostgresEmailCode({ pool, config, mailer, email, purpose }) {
  const resendMs = Math.max(10_000, Number(config.emailCodeResendSeconds || 60) * 1000);
  const issued = await inTransaction(pool, async (client) => {
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`email-code\u001f${email}\u001f${purpose}`]);
    } catch (error) {
      if (!/hashtextextended|pg_advisory_xact_lock/i.test(String(error?.message || ''))) throw error;
    }
    const latest = await one(
      client,
      `SELECT id, expires_at, created_at FROM email_verifications
       WHERE email = $1 AND purpose = $2 AND consumed = false
       ORDER BY created_at DESC LIMIT 1`,
      [email, purpose],
    );
    const createdAtMs = new Date(latest?.created_at || 0).getTime();
    const expiresAtMs = new Date(latest?.expires_at || 0).getTime();
    const elapsedMs = Date.now() - createdAtMs;
    if (latest && Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < resendMs && expiresAtMs > Date.now()) {
      return {
        reused: true,
        expiresAt: new Date(expiresAtMs).toISOString(),
        retryAfterSeconds: Math.max(1, Math.ceil((resendMs - elapsedMs) / 1000)),
      };
    }
    const code = randomCode();
    const id = newId('email_code');
    const expiresAt = new Date(Date.now() + Number(config.emailCodeTtlMinutes || 10) * 60 * 1000);
    const codeHash = hashEmailCode({ email, purpose, code, secret: config.emailCodeSecret });
    await client.query(
      'UPDATE email_verifications SET consumed = true WHERE email = $1 AND purpose = $2 AND consumed = false',
      [email, purpose],
    );
    await client.query(
      `INSERT INTO email_verifications (id, email, purpose, code_hash, consumed, expires_at, created_at)
       VALUES ($1, $2, $3, $4, false, $5, now())`,
      [id, email, purpose, codeHash, expiresAt],
    );
    return {
      id,
      code,
      reused: false,
      expiresAt: expiresAt.toISOString(),
      retryAfterSeconds: Math.ceil(resendMs / 1000),
    };
  });
  if (!issued.code) {
    return {
      ok: true, provider: 'cloud', delivery: 'email', email, purpose,
      expiresAt: issued.expiresAt, retryAfterSeconds: issued.retryAfterSeconds, reused: true,
    };
  }
  try {
    await mailer.sendEmailCode({ email, purpose, code: issued.code, expiresAt: issued.expiresAt });
  } catch (error) {
    await pool.query('UPDATE email_verifications SET consumed = true WHERE id = $1', [issued.id]).catch(() => null);
    const deliveryError = emailDeliveryFailure(error);
    deliveryError.cause = error;
    throw deliveryError;
  }
  return {
    ok: true, provider: 'cloud', delivery: 'email', email, purpose,
    expiresAt: issued.expiresAt, retryAfterSeconds: issued.retryAfterSeconds, reused: false,
  };
}

function emailDeliveryFailure(error) {
  const responseCode = Number(error?.responseCode || error?.statusCode || 0);
  const detail = String(error?.response || error?.message || '').toLowerCase();
  const explicitlyRejected = Array.isArray(error?.rejected) && error.rejected.length > 0
    && (!Array.isArray(error?.accepted) || error.accepted.length === 0);
  const recipientRejected = explicitlyRejected
    || [550, 551, 553].includes(responseCode)
    || /(?:user unknown|unknown user|no such user|mailbox (?:not found|unavailable)|recipient address rejected|invalid recipient)/i.test(detail);
  return recipientRejected
    ? apiError('email_address_unreachable', '该邮箱不存在或无法接收邮件，请检查邮箱地址后重试。', 422)
    : apiError('email_delivery_failed', '验证码邮件发送失败，请稍后重试。', 503);
}

export function createApp({ pool, config, mailer, objectStore = null }) {
  logDeprecatedEvolutionEnvironment({ processName: 'janus-postgres-cloud' });
  const app = express();
  app.disable('x-powered-by');
  const env = config?.env || process.env;
  const largeFileStorageRoot = path.resolve(String(env.JANUS_FILE_STORAGE_ROOT
    || path.join(env.JANUS_CLOUD_HOME || process.cwd(), 'data', 'file-storage')));
  const largeFileStorage = ensureLargeFileStorage(largeFileStorageRoot, {
    explicitlyConfigured: Boolean(String(env.JANUS_FILE_STORAGE_ROOT || env.JANUS_CLOUD_HOME || '').trim()),
  });
  const network = createExpressNetworkMiddleware({
    apiError,
    errorResponse,
    mapError: mapPgError,
    jsonLimit: String(env.JANUS_HTTP_JSON_LIMIT || '2mb'),
    env,
  });
  app.use(network.requestDiagnostics);
  app.use(network.jsonBody);

  const auth = authMiddleware(pool, config);
  const emailCodeRequests = new Map();

  app.get('/healthz', route(async (_req, res) => {
    res.json({ ok: true, status: 'ok', version: BUILD_VERSION });
  }));

  app.get('/readyz', route(async (_req, res) => {
    const database = await cloudDatabaseReadiness(pool);
    const storageConfigured = Boolean(
      String(env.JANUS_S3_ENDPOINT || '').trim()
      && String(env.JANUS_S3_BUCKET || '').trim()
      && String(env.JANUS_S3_ACCESS_KEY_ID || '').trim()
      && String(env.JANUS_S3_SECRET_ACCESS_KEY || '').trim()
    );
    const ready = database.ready && largeFileStorage.available !== false && storageConfigured;
    res.status(ready ? 200 : 503).json({
      ok: ready,
      status: ready ? 'ready' : 'not_ready',
      version: BUILD_VERSION,
      database,
      fileStorage: largeFileStorage,
      objectStorage: { configured: storageConfigured },
    });
  }));

  app.get('/v1/releases/latest', route(async (req, res) => {
    const releaseHome = String(env.JANUS_RELEASE_STORAGE_ROOT || '').trim();
    if (!releaseHome) throw apiError('release_service_unconfigured', 'Release service is not configured.', 404);
    const release = latestPublishedRelease({
      home: releaseHome,
      channel: req.query.channel || 'dev',
      platform: req.query.platform || '',
      arch: req.query.arch || '',
      kind: req.query.kind || '',
    });
    if (!release) throw apiError('release_not_found', 'No matching release is published.', 404);
    res.json(release);
  }));

  app.get('/v1/releases/artifacts/*artifact', route(async (req, res) => {
    const home = String(env.JANUS_RELEASE_STORAGE_ROOT || '').trim();
    if (!home) throw apiError('release_service_unconfigured', 'Release service is not configured.', 404);
    const relativeArtifact = Array.isArray(req.params.artifact)
      ? req.params.artifact.join('/')
      : String(req.params.artifact || '');
    const artifact = releaseArtifactFile(path.join(home, 'releases'), relativeArtifact);
    if (!artifact || !fs.existsSync(artifact) || !fs.statSync(artifact).isFile()) {
      throw apiError('release_artifact_not_found', 'Release artifact was not found.', 404);
    }
    res.sendFile(artifact);
  }));

  const deviceGrants = registerSyncRoutes({ app, pool, auth, route, apiError, env, objectStore });
  registerEvolutionRoutes({ app, pool, auth, route, apiError, deviceGrants, env });
  registerEmployeeRoutes({ app, pool, apiError });
  registerWorkMemoryRoutes({ app, pool, auth, route, apiError, env });

  app.post('/api/auth/email-code', route(async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const purpose = normalizePurpose(req.body?.purpose);
    const existing = await findUserByEmail(pool, email);
    if (purpose === 'register' && existing) throw apiError('email_already_registered', '该邮箱已被注册。', 409);
    if (purpose === 'password_reset' && !existing) throw apiError('email_not_found', '账号不存在。', 404);
    if (['password_change', 'organization_invitation_reset'].includes(purpose)) {
      const currentUser = await authenticateRequest(pool, config, req);
      if (email !== String(currentUser.email || '').toLowerCase()) {
        throw apiError('forbidden', '验证码只能发送到当前账号邮箱。', 403);
      }
    }

    const requestKey = `${email}\u001f${purpose}`;
    const pendingRequest = emailCodeRequests.get(requestKey);
    if (pendingRequest) {
      const result = await pendingRequest;
      res.json({ ...result, reused: true });
      return;
    }
    const requestPromise = issuePostgresEmailCode({ pool, config, mailer, email, purpose });
    emailCodeRequests.set(requestKey, requestPromise);
    try {
      res.json(await requestPromise);
    } finally {
      if (emailCodeRequests.get(requestKey) === requestPromise) emailCodeRequests.delete(requestKey);
    }
  }));

  app.post('/api/auth/register', route(async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = validatePassword(req.body?.password);
    const code = normalizeCode(req.body?.code);
    const displayName = normalizeDisplayName(req.body?.displayName, email.split('@')[0]);
    const user = await inTransaction(pool, async (client) => {
      if (await findUserByEmail(client, email)) throw apiError('email_already_registered', '该邮箱已被注册。', 409);
      await consumeEmailCode(client, config, { email, purpose: 'register', code });
      const id = newId('user');
      const username = await uniqueUsername(client, displayName || id);
      await client.query(
        `INSERT INTO users (id, email, display_name, username, avatar_url, email_verified, role, password_hash, created_at, updated_at)
         VALUES ($1, $2, $3, $4, '', true, 'member', $5, now(), now())`,
        [id, email, displayName, username, hashPassword(password)],
      );
      const createdUser = await getUserById(client, id);
      await ensurePersonalAccountWorkspaceMembership(client, id, createdUser);
      return createdUser;
    });
    res.json(await sessionResponse(pool, config, user));
  }));

  app.post('/api/auth/login', route(async (req, res) => {
    const identifier = String(req.body?.identifier || req.body?.email || '').trim().toLowerCase();
    if (!identifier) throw apiError('unauthorized', '请输入邮箱、用户名或用户 ID。', 401);
    const userRow = await findUserByIdentifier(pool, identifier);
    if (!userRow || !verifyPassword(req.body?.password || '', userRow.password_hash || '')) {
      throw apiError('unauthorized', '账号或密码不正确。', 401);
    }
    if (!userRow.email_verified) throw apiError('forbidden', '邮箱尚未验证，请先完成邮箱验证。', 403);
    res.json(await sessionResponse(pool, config, userPayload(userRow)));
  }));

  app.get('/api/auth/me', auth, route(async (req, res) => {
    res.json({ user: req.auth.user });
  }));

  app.post('/api/provider-key-applications', auth, route(async (req, res) => {
    const user = req.auth.user;
    if (!user?.email || !user.emailVerified) {
      throw apiError('email_not_verified', '请先完成当前账号的邮箱验证。', 403);
    }
    const recipient = String(config.providerKeyApplicationEmail || '').trim();
    if (!recipient || typeof mailer?.sendProviderKeyApplication !== 'function') {
      throw apiError('provider_key_application_unavailable', 'Provider Key 申请邮箱尚未配置，请联系 Janus 管理员。', 503);
    }
    const organization = String(req.body?.organization || '').trim().replace(/\s+/g, ' ');
    const usage = String(req.body?.usage || '').trim().replace(/\r\n/g, '\n');
    if (organization.length < 2 || organization.length > 120) {
      throw apiError('organization_invalid', '机构名称长度应为 2 到 120 个字符。', 400);
    }
    if (usage.length > 2000) throw apiError('usage_too_long', '申请用途不能超过 2000 个字符。', 400);

    const created = await inTransaction(pool, async (client) => {
      const existing = await one(client, `SELECT * FROM provider_key_applications
        WHERE user_id=$1 AND status IN ('pending','approved','claimed') ORDER BY created_at DESC LIMIT 1`, [user.id]);
      if (existing) return { row: existing, reused: true };
      try {
        const row = await one(client, `INSERT INTO provider_key_applications(
          id,user_id,account_email,organization,usage,status,created_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,'pending',now(),now()) RETURNING *`, [
          newId('provider_key_application'), user.id, user.email, organization, usage,
        ]);
        return { row, reused: false };
      } catch (error) {
        if (error?.code !== '23505') throw error;
        const concurrent = await one(client, `SELECT * FROM provider_key_applications
          WHERE user_id=$1 AND status IN ('pending','approved','claimed') ORDER BY created_at DESC LIMIT 1`, [user.id]);
        if (!concurrent) throw error;
        return { row: concurrent, reused: true };
      }
    });
    let notificationDelivered = Boolean(created.row.admin_notified_at);
    if (!notificationDelivered) {
      try {
        await mailer.sendProviderKeyApplication({
          recipient,
          applicationId: created.row.id,
          user,
          organization: created.row.organization,
          usage: created.row.usage,
          submittedAt: new Date(created.row.created_at).toISOString(),
        });
        await pool.query('UPDATE provider_key_applications SET admin_notified_at=now(),updated_at=now() WHERE id=$1', [created.row.id]);
        notificationDelivered = true;
      } catch (error) {
        console.warn(`[janus-cloud] Provider Key application notification failed id=${created.row.id}: ${error?.message || error}`);
      }
    }
    const application = await one(pool, 'SELECT * FROM provider_key_applications WHERE id=$1', [created.row.id]);
    res.status(created.reused ? 200 : 201).json({
      ok: true,
      application: providerKeyApplicationPayload(application),
      reused: created.reused,
      notificationDelivered,
    });
  }));

  app.get('/api/provider-key-applications', auth, route(async (req, res) => {
    const own = await many(pool, `SELECT * FROM provider_key_applications
      WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [req.auth.user.id]);
    const review = req.auth.user.role === 'admin'
      ? await many(pool, `SELECT * FROM provider_key_applications
        ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END,created_at DESC LIMIT 200`)
      : [];
    res.json({
      own: own.map(providerKeyApplicationPayload),
      review: review.map(providerKeyApplicationPayload),
      distributionReady: providerKeyDistribution(config).ready,
    });
  }));

  app.post('/api/provider-key-applications/:applicationId/decision', auth, route(async (req, res) => {
    const reviewer = requireProviderKeyReviewer(req.auth.user);
    const applicationId = String(req.params.applicationId || '').trim();
    const action = String(req.body?.action || '').trim().toLowerCase();
    const note = String(req.body?.note || '').trim().slice(0, 2000);
    if (!['approve', 'reject', 'reissue', 'revoke'].includes(action)) {
      throw apiError('provider_key_decision_invalid', '审核操作不正确。', 400);
    }
    if (['approve', 'reissue'].includes(action) && !providerKeyDistribution(config).ready) {
      throw apiError('provider_key_distribution_unavailable', '共享 Provider URL 或 Key 尚未在服务器配置。', 503);
    }
    const expiresAt = ['approve', 'reissue'].includes(action) ? providerKeyGrantExpiry(req.body?.expiresAt) : null;
    const decided = await inTransaction(pool, async (client) => {
      const current = await one(client, 'SELECT * FROM provider_key_applications WHERE id=$1', [applicationId]);
      if (!current) throw apiError('provider_key_application_not_found', '申请不存在。', 404);
      const allowed = (action === 'approve' && current.status === 'pending')
        || (action === 'reject' && current.status === 'pending')
        || (action === 'reissue' && ['approved', 'claimed'].includes(current.status))
        || (action === 'revoke' && ['approved', 'claimed'].includes(current.status));
      if (!allowed) throw apiError('provider_key_application_state_conflict', `当前申请状态 ${current.status} 不允许执行该操作。`, 409);
      const status = ['approve', 'reissue'].includes(action) ? 'approved' : action === 'reject' ? 'rejected' : 'revoked';
      return one(client, `UPDATE provider_key_applications SET
        status=$2,decision_note=$3,reviewed_by_user_id=$4,reviewed_at=now(),
        grant_expires_at=$5,claimed_at=CASE WHEN $2='approved' THEN NULL ELSE claimed_at END,
        decision_notified_at=NULL,updated_at=now()
        WHERE id=$1 RETURNING *`, [applicationId, status, note, reviewer.id, expiresAt]);
    });
    const applicant = await one(pool, 'SELECT * FROM users WHERE id=$1', [decided.user_id]);
    let notificationDelivered = false;
    try {
      await mailer.sendProviderKeyDecision({
        user: userPayload(applicant),
        applicationId: decided.id,
        organization: decided.organization,
        status: decided.status,
        note: decided.decision_note,
      });
      await pool.query('UPDATE provider_key_applications SET decision_notified_at=now(),updated_at=now() WHERE id=$1', [decided.id]);
      notificationDelivered = true;
    } catch (error) {
      console.warn(`[janus-cloud] Provider Key decision notification failed id=${decided.id}: ${error?.message || error}`);
    }
    const application = await one(pool, 'SELECT * FROM provider_key_applications WHERE id=$1', [decided.id]);
    res.json({ ok: true, application: providerKeyApplicationPayload(application), notificationDelivered });
  }));

  app.post('/api/provider-key-applications/:applicationId/claim', auth, route(async (req, res) => {
    const applicationId = String(req.params.applicationId || '').trim();
    const application = await one(pool, 'SELECT * FROM provider_key_applications WHERE id=$1 AND user_id=$2', [applicationId, req.auth.user.id]);
    if (!application) throw apiError('provider_key_application_not_found', '申请不存在。', 404);
    if (application.status !== 'approved') {
      throw apiError('provider_key_application_not_approved', '申请尚未获批或已经领取。', 409);
    }
    if (application.grant_expires_at && new Date(application.grant_expires_at).getTime() <= Date.now()) {
      throw apiError('provider_key_grant_expired', 'Provider Key 授权已经过期，请联系管理员重新审核。', 410);
    }
    const distribution = providerKeyDistribution(config);
    if (!distribution.ready) throw apiError('provider_key_distribution_unavailable', '共享 Provider 配置尚未就绪。', 503);
    res.json({
      application: providerKeyApplicationPayload(application),
      credential: {
        baseUrl: distribution.baseUrl,
        apiKey: distribution.apiKey,
        model: distribution.model,
        authEnvKey: 'OPENAI_API_KEY',
      },
    });
  }));

  app.post('/api/provider-key-applications/:applicationId/claim-confirm', auth, route(async (req, res) => {
    const applicationId = String(req.params.applicationId || '').trim();
    const application = await one(pool, `UPDATE provider_key_applications SET
      status='claimed',claimed_at=COALESCE(claimed_at,now()),updated_at=now()
      WHERE id=$1 AND user_id=$2 AND status='approved' RETURNING *`, [applicationId, req.auth.user.id]);
    if (!application) {
      const current = await one(pool, 'SELECT * FROM provider_key_applications WHERE id=$1 AND user_id=$2', [applicationId, req.auth.user.id]);
      if (current?.status === 'claimed') {
        res.json({ ok: true, application: providerKeyApplicationPayload(current), reused: true });
        return;
      }
      throw apiError('provider_key_claim_state_conflict', '申请状态已变化，无法确认领取。', 409);
    }
    res.json({ ok: true, application: providerKeyApplicationPayload(application), reused: false });
  }));

  app.post('/api/auth/refresh', route(async (req, res) => {
    const refreshToken = String(req.body?.refreshToken || '').trim();
    if (!refreshToken) throw apiError('unauthorized', '请重新登录。', 401);
    const tokenHash = hashRefreshToken(refreshToken, config.jwtSecret);
    const user = await inTransaction(pool, async (client) => {
      const tokenRow = await one(client, 'SELECT * FROM refresh_tokens WHERE token_hash = $1 AND revoked = false', [tokenHash]);
      if (!tokenRow || new Date(tokenRow.expires_at).getTime() <= Date.now()) {
        throw apiError('unauthorized', '登录状态已过期，请重新登录。', 401);
      }
      await client.query('UPDATE refresh_tokens SET revoked = true WHERE id = $1', [tokenRow.id]);
      const currentUser = await getUserById(client, tokenRow.user_id);
      if (!currentUser) throw apiError('unauthorized', '请重新登录。', 401);
      return currentUser;
    });
    res.json(await sessionResponse(pool, config, user));
  }));

  app.post('/api/auth/logout', route(async (req, res) => {
    const refreshToken = String(req.body?.refreshToken || '').trim();
    if (refreshToken) {
      await pool.query('UPDATE refresh_tokens SET revoked = true WHERE token_hash = $1', [
        hashRefreshToken(refreshToken, config.jwtSecret),
      ]);
    }
    res.json({ ok: true });
  }));

  app.post('/api/auth/verify-email', auth, route(async (req, res) => {
    const email = normalizeEmail(req.body?.email || req.auth.user.email);
    const purpose = normalizePurpose(req.body?.purpose || 'email_verify');
    const code = normalizeCode(req.body?.code);
    if (purpose !== 'email_verify') throw apiError('email_code_invalid', '邮箱验证码不正确。', 400);
    if (email !== String(req.auth.user.email || '').toLowerCase()) {
      throw apiError('forbidden', '只能验证当前账号邮箱。', 403);
    }
    const user = await inTransaction(pool, async (client) => {
      await consumeEmailCode(client, config, { email, purpose, code });
      await client.query('UPDATE users SET email_verified = true, updated_at = now() WHERE id = $1', [req.auth.user.id]);
      return getUserById(client, req.auth.user.id);
    });
    res.json({ user });
  }));

  app.post('/api/auth/password-reset', route(async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const code = normalizeCode(req.body?.code);
    const newPassword = validatePassword(req.body?.newPassword);
    const result = await inTransaction(pool, async (client) => {
      const row = await findUserByEmail(client, email);
      if (!row) throw apiError('email_not_found', '账号不存在。', 404);
      await consumeEmailCode(client, config, { email, purpose: 'password_reset', code });
      await client.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [hashPassword(newPassword), row.id]);
      return { ok: true, userId: row.id };
    });
    res.json(result);
  }));

  app.patch('/api/auth/profile', auth, route(async (req, res) => {
    const current = req.auth.user;
    const displayName = req.body?.displayName === undefined
      ? current.displayName
      : normalizeDisplayName(req.body.displayName, current.displayName);
    const email = req.body?.email === undefined ? current.email : normalizeEmail(req.body.email);
    if (email !== String(current.email || '').toLowerCase()) {
      throw apiError('email_change_not_supported', '注册邮箱不支持直接修改。', 400);
    }
    const username = req.body?.username === undefined
      ? current.username
      : normalizeUsername(req.body.username, current.username);
    const avatarProvided = req.body?.avatarUrl !== undefined || req.body?.avatar_url !== undefined;
    const avatarValidation = profileAvatarUrlValidation(avatarProvided
      ? req.body?.avatarUrl ?? req.body?.avatar_url ?? ''
      : current.avatarUrl, { allowLegacyLocal: !avatarProvided });
    if (!avatarValidation.valid) throw apiError('profile_avatar_invalid', avatarValidation.reason, 400);
    const avatarUrl = avatarValidation.value;
    const user = await inTransaction(pool, async (client) => {
      const emailConflict = await one(client, 'SELECT id FROM users WHERE email = $1 AND id <> $2', [email, current.id]);
      if (emailConflict) throw apiError('email_already_registered', '该邮箱已被其他账号使用。', 409);
      if (username) {
        const usernameConflict = await one(client, 'SELECT id FROM users WHERE username = $1 AND id <> $2', [username, current.id]);
        if (usernameConflict) throw apiError('username_already_taken', '该用户名已被其他账号使用。', 409);
      }
      const emailVerified = email === String(current.email || '').toLowerCase() ? current.emailVerified : false;
      await client.query(
        `UPDATE users
         SET display_name = $1, email = $2, username = $3, avatar_url = $4, email_verified = $5, updated_at = now()
         WHERE id = $6`,
        [displayName, email, username || null, avatarUrl, emailVerified, current.id],
      );
      return getUserById(client, current.id);
    });
    res.json({ user });
  }));

  app.patch('/api/auth/password', auth, route(async (req, res) => {
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');
    const code = normalizeCode(req.body.code);
    validatePassword(newPassword);
    const row = await one(pool, 'SELECT * FROM users WHERE id = $1', [req.auth.user.id]);
    if (!row || !verifyPassword(currentPassword, row.password_hash)) throw apiError('unauthorized', '当前密码不正确。', 401);
    await inTransaction(pool, async (client) => {
      await consumeEmailCode(client, config, { email: row.email, purpose: 'password_change', code });
      await client.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [hashPassword(newPassword), row.id]);
      await client.query('UPDATE refresh_tokens SET revoked = true WHERE user_id = $1', [row.id]);
    });
    res.json({ ok: true });
  }));

  app.get('/api/friends/search', auth, route(async (req, res) => {
    const q = String(req.query?.q || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(50, Number(req.query?.limit || 20)));
    if (!q) return res.json({ items: [] });
    const rows = await many(
      pool,
      `SELECT *
       FROM users
       WHERE id <> $1
         AND (lower(email) LIKE $2 OR lower(display_name) LIKE $2 OR lower(coalesce(username, '')) LIKE $2 OR lower(id) LIKE $2)
       ORDER BY display_name ASC
       LIMIT $3`,
      [req.auth.user.id, `%${q}%`, limit * 2],
    );
    const items = [];
    for (const row of rows) {
      if (await isBlockedEitherWay(pool, req.auth.user.id, row.id)) continue;
      items.push(await userSearchPayload(pool, row, req.auth.user.id));
      if (items.length >= limit) break;
    }
    res.json({ items });
  }));

  app.get('/api/friends', auth, route(async (req, res) => {
    res.json(await friendsOverview(pool, req.auth.user.id));
  }));

  app.post('/api/friends/requests', auth, route(async (req, res) => {
    const currentUserId = req.auth.user.id;
    const targetId = String(req.body?.userId || '').trim();
    const message = String(req.body?.message || '').trim().slice(0, 200);
    if (!targetId || targetId === currentUserId) throw apiError('user_not_found', '不能添加自己为好友。', 400);
    const result = await inTransaction(pool, async (client) => {
      const target = await getUserById(client, targetId);
      if (!target) throw apiError('user_not_found', '用户不存在。', 404);
      if (await isBlockedEitherWay(client, currentUserId, targetId)) throw apiError('blocked_user', '无法向该用户发送好友申请。', 403);
      if (await friendshipBetween(client, currentUserId, targetId)) throw apiError('friendship_already_exists', '你们已经是好友。', 409);
      const reverse = await one(
        client,
        "SELECT * FROM friend_requests WHERE requester_id = $1 AND recipient_id = $2 AND status = 'pending'",
        [targetId, currentUserId],
      );
      if (reverse) {
        await acceptFriendRequestInTransaction(client, currentUserId, reverse);
        return { requestId: reverse.id };
      }
      const existing = await one(
        client,
        "SELECT * FROM friend_requests WHERE requester_id = $1 AND recipient_id = $2 AND status = 'pending'",
        [currentUserId, targetId],
      );
      if (existing) throw apiError('friend_request_already_pending', '好友申请已发送。', 409);
      const requestId = newId('friend_req');
      await client.query(
        `INSERT INTO friend_requests (id, requester_id, recipient_id, status, message, created_at, updated_at)
         VALUES ($1, $2, $3, 'pending', $4, now(), now())`,
        [requestId, currentUserId, targetId, message],
      );
      return { requestId };
    });
    res.json({ ok: true, requestId: result.requestId, overview: await friendsOverview(pool, currentUserId) });
  }));

  app.post('/api/friends/requests/:requestId/accept', auth, route(async (req, res) => {
    await inTransaction(pool, async (client) => {
      const row = await pendingFriendRequest(client, req.params.requestId);
      if (row.recipient_id !== req.auth.user.id) throw apiError('forbidden', '无权处理该好友申请。', 403);
      await acceptFriendRequestInTransaction(client, req.auth.user.id, row);
    });
    res.json({ ok: true, overview: await friendsOverview(pool, req.auth.user.id) });
  }));

  app.post('/api/friends/requests/:requestId/reject', auth, route(async (req, res) => {
    await closeFriendRequest(pool, req.auth.user.id, req.params.requestId, 'rejected', true);
    res.json({ ok: true, overview: await friendsOverview(pool, req.auth.user.id) });
  }));

  app.post('/api/friends/requests/:requestId/cancel', auth, route(async (req, res) => {
    await closeFriendRequest(pool, req.auth.user.id, req.params.requestId, 'cancelled', false);
    res.json({ ok: true, overview: await friendsOverview(pool, req.auth.user.id) });
  }));

  app.patch('/api/friends/:userId', auth, route(async (req, res) => {
    const currentUserId = req.auth.user.id;
    const targetId = String(req.params.userId || '').trim();
    const [userA, userB] = orderedUserPair(currentUserId, targetId);
    const friendship = await one(pool, "SELECT * FROM friendships WHERE user_a_id = $1 AND user_b_id = $2 AND status = 'accepted'", [userA, userB]);
    if (!friendship) throw apiError('friendship_not_found', '好友关系不存在。', 404);
    const remark = String(req.body?.remark || '').trim().slice(0, 40);
    await pool.query(
      `UPDATE friendships SET
         user_a_remark = CASE WHEN user_a_id = $1 THEN $3 ELSE user_a_remark END,
         user_b_remark = CASE WHEN user_b_id = $1 THEN $3 ELSE user_b_remark END,
         updated_at = now()
       WHERE user_a_id = $2 AND user_b_id = $4`,
      [currentUserId, userA, remark, userB],
    );
    res.json({ ok: true, remark, overview: await friendsOverview(pool, currentUserId) });
  }));

  app.patch('/api/contacts/:userId/remark', auth, route(async (req, res) => {
    const currentUserId = req.auth.user.id;
    const targetId = String(req.params.userId || '').trim();
    if (!targetId || targetId === currentUserId) throw apiError('contact_invalid', '请选择有效联系人。', 400);
    const friendship = await one(pool, `SELECT 1 FROM friendships
      WHERE ((user_a_id=$1 AND user_b_id=$2) OR (user_a_id=$2 AND user_b_id=$1)) AND status='accepted'`, [currentUserId, targetId]);
    const sharedOrganization = await one(pool, `SELECT 1 FROM contact_organization_members own
      JOIN contact_organization_members target ON target.organization_id=own.organization_id
      WHERE own.user_id=$1 AND target.user_id=$2 LIMIT 1`, [currentUserId, targetId]);
    if (!friendship && !sharedOrganization) throw apiError('contact_not_found', '联系人不存在或已不在你的通讯录中。', 404);
    const remark = String(req.body?.remark || '').trim().slice(0, 40);
    await inTransaction(pool, async (client) => {
      await client.query(`INSERT INTO social_contact_remarks(owner_user_id,target_user_id,remark,created_at,updated_at)
        VALUES($1,$2,$3,now(),now()) ON CONFLICT(owner_user_id,target_user_id) DO UPDATE SET remark=excluded.remark,updated_at=now()`,
      [currentUserId, targetId, remark]);
      const [userA, userB] = orderedUserPair(currentUserId, targetId);
      await client.query(`UPDATE friendships SET
        user_a_remark=CASE WHEN user_a_id=$1 THEN $3 ELSE user_a_remark END,
        user_b_remark=CASE WHEN user_b_id=$1 THEN $3 ELSE user_b_remark END,updated_at=now()
        WHERE user_a_id=$2 AND user_b_id=$4 AND status='accepted'`, [currentUserId, userA, remark, userB]);
    });
    res.json({ ok: true, remark, overview: await friendsOverview(pool, currentUserId) });
  }));

  app.delete('/api/friends/:userId', auth, route(async (req, res) => {
    const [userA, userB] = orderedUserPair(req.auth.user.id, req.params.userId);
    await pool.query("UPDATE friendships SET status = 'removed', updated_at = now() WHERE user_a_id = $1 AND user_b_id = $2", [userA, userB]);
    res.json({ ok: true, overview: await friendsOverview(pool, req.auth.user.id) });
  }));

  app.post('/api/friends/block', auth, route(async (req, res) => {
    const currentUserId = req.auth.user.id;
    const targetId = String(req.body?.userId || '').trim();
    if (!targetId || targetId === currentUserId) throw apiError('user_not_found', '请选择有效用户。', 400);
    await inTransaction(pool, async (client) => {
      if (!(await getUserById(client, targetId))) throw apiError('user_not_found', '用户不存在。', 404);
      await client.query(
        `INSERT INTO user_blocks (id, blocker_id, blocked_id, created_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
        [newId('block'), currentUserId, targetId],
      );
      await client.query(
        `UPDATE friend_requests
         SET status = 'cancelled', updated_at = now()
         WHERE status = 'pending'
           AND ((requester_id = $1 AND recipient_id = $2) OR (requester_id = $2 AND recipient_id = $1))`,
        [currentUserId, targetId],
      );
      const [userA, userB] = orderedUserPair(currentUserId, targetId);
      await client.query("UPDATE friendships SET status = 'removed', updated_at = now() WHERE user_a_id = $1 AND user_b_id = $2", [userA, userB]);
    });
    res.json({ ok: true, overview: await friendsOverview(pool, currentUserId) });
  }));

  app.post('/api/organizations', auth, route(async (req, res) => {
    const result = await createOrganization(pool, req.auth.user.id, req.body || {});
    res.status(201).json(result);
  }));

  app.post('/api/organizations/join', auth, route(async (req, res) => {
    res.json(await joinOrganization(pool, req.auth.user.id, req.body || {}));
  }));

  app.post('/api/organizations/:organizationId/actions', auth, route(async (req, res) => {
    res.json(await organizationAction(pool, req.auth.user.id, {
      ...(req.body || {}), organizationId: req.params.organizationId,
    }, { config }));
  }));

  app.get('/api/social/capabilities', auth, route(async (_req, res) => {
    res.json({ capabilities: ['chat-groups-v1', 'chat-groups-v2', 'chat-group-message-withdraw-v1', 'chat-group-files-v1', 'resumable-file-transfer-v1', 'account-social-direct-v1', 'conversation-inbox-archive-v1', 'delegation-realtime-sse-v1', 'delegation-execution-lease-v1', 'delegation-create-idempotency-v1', 'direct-delegation-files-v1', 'contact-remarks-v1', 'membership-display-names-v1', 'ubuddy-capability-profile-v1', 'agent-work-detail-projection-v1'], chatGroups: {
      enabled: true, version: 2, audienceScope: 'account_social', messageWithdraw: true,
    } });
  }));

  app.put('/api/social/ubuddy-profile', auth, route(async (req, res) => {
    requireUBuddyCapabilityProfileCapability(req);
    const ownerUserId = req.auth.user.id;
    const commandId = String(req.body?.commandId || '').trim().slice(0, 200);
    if (!commandId) throw apiError('ubuddy_profile_command_required', '缺少简介发布命令标识。', 400);
    const profile = normalizePublishedUBuddyCapabilityProfile(req.body?.profile, ownerUserId);
    const expectedStateRevision = nonNegativeRevision(req.body?.expectedStateRevision);
    const contentHash = stableRequestHash(profile);
    const payloadHash = stableRequestHash({ operation: 'publish', ownerUserId, expectedStateRevision, profile });
    const result = await inTransaction(pool, async (client) => {
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [ownerUserId]);
      const priorCommand = await one(client, `SELECT * FROM social_ubuddy_capability_profile_commands
        WHERE command_id=$1`, [commandId]);
      if (priorCommand) {
        if (priorCommand.owner_user_id !== ownerUserId || priorCommand.operation_kind !== 'publish'
          || priorCommand.payload_hash !== payloadHash) {
          throw apiError('ubuddy_profile_idempotency_conflict', '简介发布命令已被不同请求占用。', 409);
        }
        return jsonObject(priorCommand.response_json);
      }
      const active = await one(client, `SELECT * FROM social_ubuddy_capability_profiles
        WHERE owner_user_id=$1 AND publication_state='active' FOR UPDATE`, [ownerUserId]);
      const state = await one(client, `SELECT COALESCE(MAX(state_revision),0) AS state_revision
        FROM social_ubuddy_capability_profiles WHERE owner_user_id=$1`, [ownerUserId]);
      const currentStateRevision = Number(state?.state_revision || 0);
      if (expectedStateRevision > 0 && currentStateRevision !== expectedStateRevision) {
        throw apiError('ubuddy_profile_state_conflict', '云端简介状态已在其他设备更新。', 409, { currentStateRevision });
      }
      const identity = await one(client, `SELECT * FROM social_ubuddy_capability_profiles
        WHERE owner_user_id=$1 AND ubuddy_agent_instance_id=$2 AND profile_revision=$3 FOR UPDATE`, [
        ownerUserId, profile.uBuddyAgentInstanceId, profile.profileRevision,
      ]);
      if (identity && identity.content_hash !== contentHash) {
        throw apiError('ubuddy_profile_revision_conflict', '同一简介版本已对应不同内容。', 409);
      }
      if (identity?.publication_state === 'archived') {
        throw apiError('ubuddy_profile_revision_archived', '该简介版本已经归档，请发布更高版本。', 409);
      }
      let row = identity;
      if (!row) {
        const nextStateRevision = currentStateRevision + 1;
        if (active) {
          await client.query(`UPDATE social_ubuddy_capability_profiles SET publication_state='archived',
            state_revision=$2,last_command_id=$3,archived_at=now(),updated_at=now()
            WHERE owner_user_id=$1 AND publication_state='active'`, [ownerUserId, nextStateRevision, commandId]);
        }
        row = await one(client, `INSERT INTO social_ubuddy_capability_profiles(
          owner_user_id,ubuddy_agent_instance_id,profile_revision,profile_version,visibility,publication_state,
          source_effective_skill_hash,content_hash,profile_json,state_revision,last_command_id,published_at,created_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,'active',$6,$7,$8::jsonb,$9,$10,now(),now(),now()) RETURNING *`, [
          ownerUserId, profile.uBuddyAgentInstanceId, profile.profileRevision, profile.version, profile.visibility,
          profile.sourceEffectiveSkillHash, contentHash, JSON.stringify(profile), nextStateRevision, commandId,
        ]);
      }
      const response = { ok: true, stateRevision: Number(row.state_revision || 0), item: uBuddyCloudProfilePayload(row, 'owner') };
      await client.query(`INSERT INTO social_ubuddy_capability_profile_commands(
        command_id,owner_user_id,operation_kind,payload_hash,response_json,created_at
      ) VALUES($1,$2,'publish',$3,$4::jsonb,now())`, [commandId, ownerUserId, payloadHash, JSON.stringify(response)]);
      return response;
    });
    res.json(result);
  }));

  app.post('/api/social/ubuddy-profile/unpublish', auth, route(async (req, res) => {
    requireUBuddyCapabilityProfileCapability(req);
    const ownerUserId = req.auth.user.id;
    const commandId = String(req.body?.commandId || '').trim().slice(0, 200);
    if (!commandId) throw apiError('ubuddy_profile_command_required', '缺少简介撤回命令标识。', 400);
    const expectedStateRevision = nonNegativeRevision(req.body?.expectedStateRevision);
    const payloadHash = stableRequestHash({ operation: 'unpublish', ownerUserId, expectedStateRevision });
    const result = await inTransaction(pool, async (client) => {
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [ownerUserId]);
      const priorCommand = await one(client, `SELECT * FROM social_ubuddy_capability_profile_commands WHERE command_id=$1`, [commandId]);
      if (priorCommand) {
        if (priorCommand.owner_user_id !== ownerUserId || priorCommand.operation_kind !== 'unpublish'
          || priorCommand.payload_hash !== payloadHash) {
          throw apiError('ubuddy_profile_idempotency_conflict', '简介撤回命令已被不同请求占用。', 409);
        }
        return jsonObject(priorCommand.response_json);
      }
      const active = await one(client, `SELECT * FROM social_ubuddy_capability_profiles
        WHERE owner_user_id=$1 AND publication_state='active' FOR UPDATE`, [ownerUserId]);
      const state = await one(client, `SELECT COALESCE(MAX(state_revision),0) AS state_revision
        FROM social_ubuddy_capability_profiles WHERE owner_user_id=$1`, [ownerUserId]);
      const currentStateRevision = Number(state?.state_revision || 0);
      if (expectedStateRevision > 0 && currentStateRevision !== expectedStateRevision) {
        throw apiError('ubuddy_profile_state_conflict', '云端简介状态已在其他设备更新。', 409, { currentStateRevision });
      }
      const nextStateRevision = active ? currentStateRevision + 1 : currentStateRevision;
      if (active) {
        await client.query(`UPDATE social_ubuddy_capability_profiles SET publication_state='archived',
          state_revision=$2,last_command_id=$3,archived_at=now(),updated_at=now()
          WHERE owner_user_id=$1 AND publication_state='active'`, [ownerUserId, nextStateRevision, commandId]);
      }
      const response = { ok: true, stateRevision: nextStateRevision, item: null, unpublished: Boolean(active) };
      await client.query(`INSERT INTO social_ubuddy_capability_profile_commands(
        command_id,owner_user_id,operation_kind,payload_hash,response_json,created_at
      ) VALUES($1,$2,'unpublish',$3,$4::jsonb,now())`, [commandId, ownerUserId, payloadHash, JSON.stringify(response)]);
      return response;
    });
    res.json(result);
  }));

  app.get('/api/social/ubuddy-profile', auth, route(async (req, res) => {
    requireUBuddyCapabilityProfileCapability(req);
    const row = await one(pool, `SELECT * FROM social_ubuddy_capability_profiles
      WHERE owner_user_id=$1 AND publication_state='active'`, [req.auth.user.id]);
    res.json({ item: row ? safeUBuddyCloudProfilePayload(row, 'owner') : null });
  }));

  app.post('/api/social/ubuddy-profiles/query', auth, route(async (req, res) => {
    requireUBuddyCapabilityProfileCapability(req);
    const viewerUserId = req.auth.user.id;
    const userIds = uniqueProfileUserIds(req.body?.userIds);
    const profiles = [];
    const unavailableUserIds = [];
    for (const ownerUserId of userIds) {
      const row = await one(pool, `SELECT * FROM social_ubuddy_capability_profiles
        WHERE owner_user_id=$1 AND publication_state='active'`, [ownerUserId]);
      const accessScope = row ? await uBuddyProfileAccessScope(pool, viewerUserId, ownerUserId, row.visibility) : '';
      const exposed = row && accessScope ? safeUBuddyCloudProfilePayload(row, accessScope) : null;
      if (!exposed) unavailableUserIds.push(ownerUserId);
      else profiles.push(exposed);
    }
    res.json({ profiles, unavailableUserIds });
  }));

  app.get('/api/social/events/stream', auth, async (req, res, next) => {
    if (!delegationRealtimeRequested(req)) {
      next(apiError('delegation_realtime_capability_required', '当前客户端未声明实时委托能力。', 426));
      return;
    }
    const userId = req.auth.user.id;
    let cursor = Math.max(0, Number(req.headers['last-event-id'] || req.query.cursor || 0) || 0);
    let closed = false;
    let draining = false;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const writeEvent = (row) => {
      const payload = {
        id: row.id,
        sequence: Number(row.sequence_id || 0),
        type: row.event_type,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        aggregateVersion: Number(row.aggregate_version || 0),
        accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
        payload: jsonObject(row.payload_json),
        createdAt: toIso(row.created_at),
      };
      res.write(`id: ${payload.sequence}\nevent: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
      cursor = Math.max(cursor, payload.sequence);
    };
    const drain = async () => {
      if (closed || draining) return;
      draining = true;
      try {
        const rows = await many(pool, `SELECT * FROM social_realtime_events
          WHERE recipient_user_id=$1 AND sequence_id>$2 ORDER BY sequence_id ASC LIMIT 500`, [userId, cursor]);
        for (const row of rows) writeEvent(row);
      } catch (error) {
        if (!closed) next(error);
      } finally {
        draining = false;
      }
    };
    res.write(': connected\n\n');
    await drain();
    const drainTimer = setInterval(() => { void drain(); }, 1_000);
    const heartbeatTimer = setInterval(() => {
      if (!closed) res.write(`: heartbeat ${Date.now()}\n\n`);
    }, 15_000);
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(drainTimer);
      clearInterval(heartbeatTimer);
    };
    req.on('close', close);
    res.on('close', close);
  });

  app.get('/api/social/conversation-preferences', auth, route(async (req, res) => {
    requireConversationArchiveCapability(req);
    const rows = await many(pool, `SELECT * FROM social_conversation_preferences
      WHERE user_id=$1 ORDER BY updated_at DESC,conversation_kind,conversation_id`, [req.auth.user.id]);
    const preferences = [];
    for (const row of rows) preferences.push(await socialConversationPreferencePayload(pool, row));
    res.json({ capability: 'conversation-inbox-archive-v1', preferences });
  }));

  app.post('/api/social/conversation-preferences', auth, route(async (req, res) => {
    requireConversationArchiveCapability(req);
    const userId = req.auth.user.id;
    const conversationKind = normalizeConversationPreferenceKind(req.body?.conversationKind);
    const conversationId = String(req.body?.conversationId || '').trim().slice(0, 240);
    const commandId = String(req.body?.commandId || '').trim().slice(0, 240);
    const archived = req.body?.archived === true;
    const expectedRevision = Number(req.body?.expectedRevision || 0);
    if (!conversationId || !commandId) throw apiError('conversation_preference_identity_required', '缺少会话或命令标识。', 400);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw apiError('conversation_preference_revision_invalid', '会话归档版本号无效。', 400);
    }
    const target = await requireConversationPreferenceMembership(pool, { userId, conversationKind, conversationId });
    const requestedWorkspaceId = String(req.body?.workspaceId || '').trim();
    if (requestedWorkspaceId && requestedWorkspaceId !== target.account_workspace_id) {
      throw apiError('conversation_preference_workspace_mismatch', '会话不属于指定工作空间。', 409);
    }
    const payloadHash = stableRequestHash({ userId, workspaceId: target.account_workspace_id, conversationKind, conversationId, archived, expectedRevision });
    const preference = await inTransaction(pool, async (client) => {
      const prior = await one(client, 'SELECT * FROM social_conversation_preference_commands WHERE command_id=$1', [commandId]);
      if (prior) {
        if (prior.user_id !== userId || prior.request_payload_hash !== payloadHash) {
          throw apiError('conversation_preference_idempotency_conflict', '会话归档命令已被不同请求占用。', 409);
        }
        return prior.response_json?.preference || prior.response_json;
      }
      const current = await one(client, `SELECT * FROM social_conversation_preferences
        WHERE account_workspace_id=$1 AND user_id=$2 AND conversation_kind=$3 AND conversation_id=$4 FOR UPDATE`, [
        target.account_workspace_id, userId, conversationKind, conversationId,
      ]);
      const currentRevision = Number(current?.state_revision || 0);
      if (expectedRevision !== currentRevision) {
        throw apiError('conversation_preference_conflict', '会话归档状态已在其他设备更新。', 409, { currentRevision });
      }
      const nextRevision = currentRevision + 1;
      const updated = await one(client, `INSERT INTO social_conversation_preferences(
        account_workspace_id,user_id,conversation_kind,conversation_id,archived,state_revision,last_command_id,source_device_id
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(account_workspace_id,user_id,conversation_kind,conversation_id) DO UPDATE SET
        archived=excluded.archived,state_revision=excluded.state_revision,last_command_id=excluded.last_command_id,
        source_device_id=excluded.source_device_id,updated_at=now() RETURNING *`, [
        target.account_workspace_id, userId, conversationKind, conversationId, archived, nextRevision, commandId,
        String(req.body?.sourceDeviceId || '').trim().slice(0, 240),
      ]);
      const response = conversationPreferencePayloadFromRow(updated);
      await client.query(`INSERT INTO social_conversation_preference_commands(
        command_id,account_workspace_id,user_id,conversation_kind,conversation_id,request_payload_hash,response_json
      ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, [commandId, target.account_workspace_id, userId, conversationKind,
        conversationId, payloadHash, JSON.stringify({ preference: response })]);
      return response;
    });
    res.json({ ok: true, capability: 'conversation-inbox-archive-v1', preference });
  }));

  app.post('/api/file-uploads', auth, route(async (req, res) => {
    const fileId = String(req.body?.fileId || '').trim().slice(0, 200);
    const scopeKind = normalizeLargeFileScopeKind(req.body?.scopeKind);
    const scopeId = String(req.body?.scopeId || '').trim().slice(0, 240);
    const sizeBytes = Number(req.body?.size || req.body?.sizeBytes || 0);
    const sha256 = normalizeLargeFileSha256(req.body?.sha256);
    if (!fileId || !scopeId) throw apiError('large_file_scope_required', '缺少大文件的会话范围或文件 ID。', 400);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= FAST_FILE_LIMIT_BYTES || sizeBytes > LARGE_FILE_LIMIT_BYTES) {
      throw apiError('large_file_size_invalid', '分片上传仅用于 60 MB 至 2 GB 的文件。', 413);
    }
    if (!sha256) throw apiError('large_file_hash_required', '大文件必须提供有效的 SHA-256。', 400);
    const filename = collaborationFilename(req.body?.filename);
    const contentType = String(req.body?.contentType || 'application/octet-stream').trim().slice(0, 200) || 'application/octet-stream';
    const scope = await authorizeLargeFileScope(pool, req, { scopeKind, scopeId });
    const existingObject = await one(pool, 'SELECT * FROM large_file_objects WHERE id=$1', [fileId]);
    if (existingObject) {
      assertLargeFileIdentity(existingObject, { ownerUserId: req.auth.user.id, scopeKind, scopeId, sizeBytes, sha256 });
      return res.json({ ok: true, completed: true, attachment: largeFileAttachment(existingObject) });
    }
    const existingUpload = await one(pool, `SELECT * FROM large_file_upload_sessions
      WHERE file_id=$1 AND owner_user_id=$2 AND status IN ('uploading','assembling')
      ORDER BY updated_at DESC LIMIT 1`, [fileId, req.auth.user.id]);
    if (existingUpload) {
      assertLargeFileIdentity(existingUpload, { ownerUserId: req.auth.user.id, scopeKind, scopeId, sizeBytes, sha256 });
      const chunks = await many(pool, 'SELECT chunk_index FROM large_file_upload_chunks WHERE upload_id=$1 ORDER BY chunk_index', [existingUpload.id]);
      return res.json(largeFileUploadPayload(existingUpload, chunks));
    }
    const uploadId = newId('file_upload');
    const chunkCount = Math.ceil(sizeBytes / LARGE_FILE_CHUNK_BYTES);
    const storageKey = largeFileObjectStorageKey(sha256);
    const expiresAt = new Date(Date.now() + LARGE_FILE_UPLOAD_TTL_MS);
    await pool.query(`INSERT INTO large_file_upload_sessions (
      id,file_id,account_workspace_id,owner_user_id,scope_kind,scope_id,recipient_user_id,group_id,delegation_id,
      filename,content_type,size_bytes,sha256,chunk_size_bytes,chunk_count,storage_key,status,expires_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'uploading',$17)`, [
      uploadId, fileId, scope.accountWorkspaceId, req.auth.user.id, scopeKind, scopeId,
      scope.recipientUserId || null, scope.groupId || null, scope.delegationId || null,
      filename, contentType, sizeBytes, sha256, LARGE_FILE_CHUNK_BYTES, chunkCount, storageKey, expiresAt,
    ]);
    const upload = await one(pool, 'SELECT * FROM large_file_upload_sessions WHERE id=$1', [uploadId]);
    res.status(201).json(largeFileUploadPayload(upload, []));
  }));

  app.get('/api/file-uploads/:uploadId', auth, route(async (req, res) => {
    const upload = await requireOwnedLargeFileUpload(pool, req.params.uploadId, req.auth.user.id);
    const chunks = await many(pool, 'SELECT chunk_index FROM large_file_upload_chunks WHERE upload_id=$1 ORDER BY chunk_index', [upload.id]);
    res.json(largeFileUploadPayload(upload, chunks));
  }));

  app.put('/api/file-uploads/:uploadId/chunks/:chunkIndex', auth,
    express.raw({ type: 'application/octet-stream', limit: `${LARGE_FILE_CHUNK_BYTES + 1024}b` }), route(async (req, res) => {
      const upload = await requireOwnedLargeFileUpload(pool, req.params.uploadId, req.auth.user.id);
      if (upload.status !== 'uploading') throw apiError('large_file_upload_not_writable', '当前上传会话不能继续接收分片。', 409);
      if (new Date(upload.expires_at).getTime() <= Date.now()) throw apiError('large_file_upload_expired', '大文件上传会话已过期，请重新开始。', 410);
      const chunkIndex = Number(req.params.chunkIndex);
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= Number(upload.chunk_count)) {
        throw apiError('large_file_chunk_index_invalid', '大文件分片序号无效。', 400);
      }
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
      const expectedBytes = Math.min(Number(upload.chunk_size_bytes), Number(upload.size_bytes) - chunkIndex * Number(upload.chunk_size_bytes));
      if (!data.length || data.length !== expectedBytes) throw apiError('large_file_chunk_size_invalid', '大文件分片长度与上传计划不一致。', 400);
      const sha256 = crypto.createHash('sha256').update(data).digest('hex');
      const claimedSha256 = normalizeLargeFileSha256(req.headers['x-janus-chunk-sha256']);
      if (req.headers['x-janus-chunk-sha256'] && claimedSha256 !== sha256) throw apiError('large_file_chunk_hash_mismatch', '大文件分片校验失败。', 400);
      const existing = await one(pool, 'SELECT * FROM large_file_upload_chunks WHERE upload_id=$1 AND chunk_index=$2', [upload.id, chunkIndex]);
      if (existing && (Number(existing.size_bytes) !== data.length || existing.sha256 !== sha256)) {
        throw apiError('large_file_chunk_conflict', '该分片序号已被不同内容占用。', 409);
      }
      const chunkPath = largeFileChunkPath(largeFileStorageRoot, upload.id, chunkIndex);
      fs.mkdirSync(path.dirname(chunkPath), { recursive: true });
      const temporary = `${chunkPath}.${process.pid}.${Date.now()}.tmp`;
      try {
        fs.writeFileSync(temporary, data, { flag: 'wx' });
        fs.renameSync(temporary, chunkPath);
      } finally {
        if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
      }
      await pool.query(`INSERT INTO large_file_upload_chunks(upload_id,chunk_index,size_bytes,sha256,updated_at)
        VALUES($1,$2,$3,$4,now()) ON CONFLICT(upload_id,chunk_index) DO UPDATE SET updated_at=now()`,
      [upload.id, chunkIndex, data.length, sha256]);
      await pool.query('UPDATE large_file_upload_sessions SET updated_at=now() WHERE id=$1', [upload.id]);
      res.status(existing ? 200 : 201).json({ ok: true, uploadId: upload.id, chunkIndex, size: data.length, sha256 });
    }));

  app.post('/api/file-uploads/:uploadId/complete', auth, route(async (req, res) => {
    const upload = await requireOwnedLargeFileUpload(pool, req.params.uploadId, req.auth.user.id);
    const existingObject = await one(pool, 'SELECT * FROM large_file_objects WHERE id=$1', [upload.file_id]);
    if (existingObject) {
      assertLargeFileIdentity(existingObject, {
        ownerUserId: upload.owner_user_id, scopeKind: upload.scope_kind, scopeId: upload.scope_id,
        sizeBytes: Number(upload.size_bytes), sha256: upload.sha256,
      });
      await pool.query("UPDATE large_file_upload_sessions SET status='completed',updated_at=now() WHERE id=$1", [upload.id]);
      return res.json({ ok: true, completed: true, attachment: largeFileAttachment(existingObject) });
    }
    if (!['uploading', 'assembling'].includes(upload.status)) throw apiError('large_file_upload_not_completable', '当前上传会话不能完成。', 409);
    const chunks = await many(pool, 'SELECT * FROM large_file_upload_chunks WHERE upload_id=$1 ORDER BY chunk_index', [upload.id]);
    if (chunks.length !== Number(upload.chunk_count) || chunks.some((chunk, index) => Number(chunk.chunk_index) !== index)) {
      throw apiError('large_file_chunks_incomplete', '大文件分片尚未上传完整。', 409, { uploadedChunks: chunks.map((item) => Number(item.chunk_index)) });
    }
    await pool.query("UPDATE large_file_upload_sessions SET status='assembling',updated_at=now() WHERE id=$1 AND status IN ('uploading','assembling')", [upload.id]);
    let assembled;
    try {
      assembled = await assembleLargeFileObject(largeFileStorageRoot, upload, chunks);
      await inTransaction(pool, async (client) => {
        const conflict = await one(client, 'SELECT * FROM large_file_objects WHERE id=$1 FOR UPDATE', [upload.file_id]);
        if (conflict) {
          assertLargeFileIdentity(conflict, {
            ownerUserId: upload.owner_user_id, scopeKind: upload.scope_kind, scopeId: upload.scope_id,
            sizeBytes: Number(upload.size_bytes), sha256: upload.sha256,
          });
        } else {
          await client.query(`INSERT INTO large_file_objects(
            id,account_workspace_id,owner_user_id,scope_kind,scope_id,recipient_user_id,group_id,delegation_id,
            filename,content_type,size_bytes,sha256,storage_key,status
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'ready')`, [
            upload.file_id, upload.account_workspace_id, upload.owner_user_id, upload.scope_kind, upload.scope_id,
            upload.recipient_user_id, upload.group_id, upload.delegation_id, upload.filename, upload.content_type,
            upload.size_bytes, upload.sha256, upload.storage_key,
          ]);
        }
        await client.query("UPDATE large_file_upload_sessions SET status='completed',updated_at=now() WHERE id=$1", [upload.id]);
      });
    } catch (error) {
      await pool.query("UPDATE large_file_upload_sessions SET status='failed',updated_at=now() WHERE id=$1", [upload.id]).catch(() => {});
      throw error;
    }
    fs.rmSync(largeFileUploadDirectory(largeFileStorageRoot, upload.id), { recursive: true, force: true });
    const stored = await one(pool, 'SELECT * FROM large_file_objects WHERE id=$1', [upload.file_id]);
    res.status(201).json({ ok: true, completed: true, assembled, attachment: largeFileAttachment(stored) });
  }));

  app.get('/api/chat-groups', auth, route(async (req, res) => {
    const workspace = await requireAccountWorkspaceAccess(pool, req.auth.user.id, requestAccountWorkspaceId(req));
    res.json(await naturalChatGroupsOverview(pool, req.auth.user.id, workspace.id, { accountGlobal: naturalChatV2Requested(req) }));
  }));

  app.post('/api/chat-groups', auth, route(async (req, res) => {
    const ownerId = req.auth.user.id;
    const workspace = await requireAccountWorkspaceAccess(pool, ownerId, requestAccountWorkspaceId(req));
    const accountGlobal = naturalChatV2Requested(req);
    const memberIds = [...new Set((Array.isArray(req.body?.memberIds) ? req.body.memberIds : [])
      .map((value) => String(value || '').trim()).filter(Boolean))].filter((id) => id !== ownerId);
    if (!memberIds.length) throw apiError('chat_group_members_required', '至少选择 1 位联系人创建群聊。', 400);
    for (const memberId of memberIds) {
      if (accountGlobal) await requireContactChatPeer(pool, workspace, ownerId, memberId);
      else await requireWorkspaceMessagingPeer(pool, workspace, ownerId, memberId);
    }
    const groupId = String(req.body?.groupId || req.body?.clientGroupId || '').trim().slice(0, 200) || newId('chat_group');
    const clientRequestId = String(req.body?.clientRequestId || '').trim().slice(0, 200) || groupId;
    const title = String(req.body?.title || '').trim().slice(0, 80) || '新群聊';
    const historyVisibility = req.body?.historyVisibility === 'full' ? 'full' : 'from_join';
    const metadata = jsonObject(req.body?.metadata);
    const payloadHash = stableRequestHash({ groupId, clientRequestId, title, memberIds: [...memberIds].sort(), historyVisibility, metadata, workspaceId: workspace.id });
    const existingRequest = await one(pool, `SELECT * FROM chat_groups WHERE account_workspace_id=$1 AND owner_user_id=$2 AND client_request_id=$3`,
      [workspace.id, ownerId, clientRequestId]);
    if (existingRequest) {
      if (existingRequest.request_payload_hash !== payloadHash) throw apiError('chat_group_idempotency_conflict', '群聊幂等键已被不同请求占用。', 409);
      return res.json({ ok: true, idempotent: true, ...(await naturalChatGroupDetail(pool, existingRequest.id, ownerId, workspace.id, { accountGlobal })) });
    }
    const existingId = await one(pool, 'SELECT request_payload_hash FROM chat_groups WHERE id=$1', [groupId]);
    if (existingId) throw apiError('chat_group_id_conflict', '群聊 ID 已被占用。', 409);
    await inTransaction(pool, async (client) => {
      await client.query(`INSERT INTO chat_groups(id,account_workspace_id,organization_id,owner_user_id,title,scope_type,chat_mode,
        binding_type,binding_id,history_visibility,status,audience_scope,client_request_id,request_payload_hash,metadata_json)
        VALUES($1,$2,$3,$4,$5,$6,'conversation','manual','',$7,'active',$8,$9,$10,$11::jsonb)`, [groupId, workspace.id,
        workspace.organization_id || '', ownerId, title, await naturalChatScopeType(client, workspace, memberIds),
        historyVisibility, accountGlobal ? 'account_social' : 'workspace_legacy', clientRequestId, payloadHash, JSON.stringify(metadata)]);
      for (const memberId of [ownerId, ...memberIds]) {
        await client.query(`INSERT INTO chat_group_members(group_id,user_id,role,status,invited_by_user_id)
          VALUES($1,$2,$3,'active',$4)`, [groupId, memberId, memberId === ownerId ? 'owner' : 'member', ownerId]);
      }
      const systemContent = `群聊“${title}”已创建。`;
      await client.query(`INSERT INTO chat_group_messages(id,account_workspace_id,group_id,sender_user_id,kind,content,metadata_json,request_payload_hash)
        VALUES($1,$2,$3,$4,'system',$5,$6::jsonb,$7)`, [newId('chat_group_msg'), workspace.id, groupId, ownerId, systemContent,
        JSON.stringify({ type: 'chat_group_created', memberIds: [ownerId, ...memberIds] }), stableRequestHash({ systemContent, groupId })]);
    });
    res.status(201).json({ ok: true, ...(await naturalChatGroupDetail(pool, groupId, ownerId, workspace.id, { accountGlobal })) });
  }));

  app.get('/api/chat-groups/:groupId', auth, route(async (req, res) => {
    const workspace = await requireAccountWorkspaceAccess(pool, req.auth.user.id, requestAccountWorkspaceId(req));
    res.json(await naturalChatGroupDetail(pool, String(req.params.groupId || ''), req.auth.user.id, workspace.id,
      { markRead: true, accountGlobal: naturalChatV2Requested(req) }));
  }));

  app.put('/api/chat-groups/:groupId/message-files/:fileId', auth, express.raw({ type: 'application/octet-stream', limit: '60mb' }), route(async (req, res) => {
    const workspace = await requireAccountWorkspaceAccess(pool, req.auth.user.id, requestAccountWorkspaceId(req));
    const accountGlobal = naturalChatV2Requested(req);
    const groupId = String(req.params.groupId || '').trim();
    const fileId = String(req.params.fileId || '').trim().slice(0, 200);
    const { group, membership } = await requireNaturalChatGroupMember(pool, groupId, req.auth.user.id, workspace.id, { accountGlobal });
    if (group.status !== 'active' || membership.status !== 'active') throw apiError('chat_group_readonly', '群聊已结束，不能发送附件。', 409);
    if (!fileId) throw apiError('chat_group_file_id_required', '缺少群聊附件 ID。', 400);
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    if (!data.length) throw apiError('chat_group_file_empty', '不能发送空附件。', 400);
    if (data.length > MAX_COLLABORATION_FILE_BYTES) throw apiError('chat_group_file_too_large', '群聊附件不能超过 60 MB。', 413);
    const filename = collaborationFilename(req.headers['x-janus-filename']);
    const contentType = String(req.headers['x-janus-content-type'] || 'application/octet-stream').trim().slice(0, 200) || 'application/octet-stream';
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    const claimedSha256 = String(req.headers['x-janus-file-sha256'] || '').trim().toLowerCase();
    if (claimedSha256 && claimedSha256 !== sha256) throw apiError('chat_group_file_hash_mismatch', '群聊附件校验失败。', 400);
    const existing = await one(pool, 'SELECT * FROM chat_group_message_files WHERE id=$1', [fileId]);
    if (existing && (existing.account_workspace_id !== group.account_workspace_id || existing.owner_user_id !== req.auth.user.id || existing.group_id !== groupId || existing.sha256 !== sha256)) {
      throw apiError('chat_group_file_conflict', '群聊附件 ID 已被其他文件占用。', 409);
    }
    await pool.query(
      `INSERT INTO chat_group_message_files (
         id, account_workspace_id, owner_user_id, group_id, filename, content_type, size_bytes, sha256, data, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, decode($9, 'base64'), now())
       ON CONFLICT (id) DO UPDATE SET
         filename=excluded.filename, content_type=excluded.content_type,
         size_bytes=excluded.size_bytes, data=excluded.data, updated_at=now()`,
      [fileId, group.account_workspace_id, req.auth.user.id, groupId, filename, contentType, data.length, sha256, data.toString('base64')],
    );
    const stored = await one(pool, 'SELECT * FROM chat_group_message_files WHERE id=$1', [fileId]);
    res.status(existing ? 200 : 201).json({ ok: true, attachment: { ...socialFileAttachment(stored), remote_file_kind: 'chat_group' } });
  }));

  app.get('/api/chat-groups/:groupId/message-files/:fileId', auth, route(async (req, res) => {
    const workspace = await requireAccountWorkspaceAccess(pool, req.auth.user.id, requestAccountWorkspaceId(req));
    const accountGlobal = naturalChatV2Requested(req);
    const groupId = String(req.params.groupId || '').trim();
    const { membership } = await requireNaturalChatGroupMember(pool, groupId, req.auth.user.id, workspace.id, { accountGlobal });
    if (!['active', 'left', 'removed'].includes(membership.status)) throw apiError('chat_group_not_found', '群聊不存在或你已不在群内。', 404);
    const requestedFileId = String(req.params.fileId || '').trim();
    const file = await one(pool, 'SELECT * FROM chat_group_message_files WHERE id=$1 AND group_id=$2', [requestedFileId, groupId])
      || await largeFileObjectByScope(pool, requestedFileId, 'chat_group', groupId);
    if (!file) throw apiError('chat_group_file_not_found', '群聊附件不存在。', 404);
    sendStoredFile(req, res, file, largeFileStorageRoot);
  }));

  app.post('/api/chat-groups/:groupId/messages', auth, route(async (req, res) => {
    const workspace = await requireAccountWorkspaceAccess(pool, req.auth.user.id, requestAccountWorkspaceId(req));
    const accountGlobal = naturalChatV2Requested(req);
    const groupId = String(req.params.groupId || '').trim();
    const { group, membership } = await requireNaturalChatGroupMember(pool, groupId, req.auth.user.id, workspace.id, { accountGlobal });
    if (group.status !== 'active' || membership.status !== 'active') throw apiError('chat_group_readonly', '群聊已结束，不能继续发送消息。', 409);
    const content = String(req.body?.content || '').trim().slice(0, 8000);
    if (!content) throw apiError('message_required', '请输入消息内容。', 400);
    const messageId = String(req.body?.clientMessageId || '').trim().slice(0, 200) || newId('chat_group_msg');
    const metadata = publicSocialMessageMetadata(req.body?.metadata);
    await validateNaturalChatGroupAttachments(pool, metadata.attachments, groupId);
    const sourceEventId = String(req.body?.sourceEventId || '').trim().slice(0, 240);
    const senderAgentId = String(req.body?.senderAgentId || '').trim() === 'secretary_agent' ? 'secretary_agent' : '';
    const kind = senderAgentId ? 'agent' : 'friend';
    const payloadHash = stableRequestHash({ groupId, content, metadata, sourceEventId, senderAgentId, kind, senderUserId: req.auth.user.id });
    const existing = await one(pool, 'SELECT * FROM chat_group_messages WHERE id=$1', [messageId]);
    if (existing) {
      if (existing.group_id !== groupId || existing.request_payload_hash !== payloadHash) throw apiError('chat_group_message_conflict', '消息幂等 ID 已被不同内容占用。', 409);
      return res.json({ ok: true, idempotent: true, ...(await naturalChatGroupDetail(pool, groupId, req.auth.user.id, workspace.id, { markRead: true, accountGlobal })) });
    }
    await inTransaction(pool, async (client) => {
      await client.query(`INSERT INTO chat_group_messages(id,account_workspace_id,group_id,sender_user_id,sender_agent_id,kind,content,metadata_json,source_event_id,request_payload_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`, [messageId, group.account_workspace_id, groupId, req.auth.user.id, senderAgentId, kind, content,
        JSON.stringify(metadata), sourceEventId, payloadHash]);
      await client.query('UPDATE chat_groups SET updated_at=now() WHERE id=$1', [groupId]);
      if (!senderAgentId) {
        const mentionedUBuddyOwnerIds = [...new Set(normalizeMentionEntities(metadata.mentions, { content, requirePicker: true })
          .filter((mention) => mention.principalType === 'ubuddy')
          .map((mention) => String(mention.ownerUserId || '').trim())
          .filter((userId) => userId && userId !== req.auth.user.id))];
        if (mentionedUBuddyOwnerIds.length) {
          const mentionedOwners = new Set(mentionedUBuddyOwnerIds);
          const activeMembers = (await many(client, `SELECT user_id FROM chat_group_members
            WHERE group_id=$1 AND status='active'`, [groupId]))
            .filter((member) => mentionedOwners.has(String(member.user_id || '')));
          await appendSocialRealtimeEvents(client, {
            accountWorkspaceId: group.account_workspace_id,
            recipientUserIds: activeMembers.map((member) => member.user_id),
            eventType: 'chat_group.ubuddy_mentioned',
            aggregateType: 'chat_group_message',
            aggregateId: messageId,
            aggregateVersion: 1,
            payload: { groupId, messageId, senderUserId: req.auth.user.id },
          });
        }
      }
    });
    res.status(201).json({ ok: true, ...(await naturalChatGroupDetail(pool, groupId, req.auth.user.id, workspace.id, { markRead: true, accountGlobal })) });
  }));

  app.patch('/api/chat-groups/:groupId', auth, route(async (req, res) => {
    const workspace = await requireAccountWorkspaceAccess(pool, req.auth.user.id, requestAccountWorkspaceId(req));
    const accountGlobal = naturalChatV2Requested(req);
    const groupId = String(req.params.groupId || '').trim();
    const { group, membership } = await requireNaturalChatGroupMember(pool, groupId, req.auth.user.id, workspace.id, { accountGlobal });
    const action = String(req.body?.action || '').trim().toLowerCase();
    const targetId = String(req.body?.userId || '').trim();
    const targetMessageId = String(req.body?.messageId || '').trim().slice(0, 200);
    const clientRequestId = String(req.body?.clientRequestId || '').trim().slice(0, 200) || newId('chat_group_action');
    const idempotencyKey = `chat-group:update:${groupId}:${clientRequestId}`;
    const payloadHash = stableRequestHash({ groupId, action, targetId, targetMessageId,
      title: req.body?.title || '', displayName: req.body?.displayName || '', role: req.body?.role || '', actor: req.auth.user.id });
    const prior = await one(pool, 'SELECT * FROM chat_group_operations WHERE idempotency_key=$1', [idempotencyKey]);
    if (prior) {
      if (prior.request_payload_hash !== payloadHash) throw apiError('chat_group_idempotency_conflict', '群聊操作幂等键已被不同请求占用。', 409);
      return res.json({ ok: true, idempotent: true, ...(await naturalChatGroupDetail(pool, groupId, req.auth.user.id, workspace.id, { accountGlobal })) });
    }
    if (group.status !== 'active' && action !== 'dissolve') throw apiError('chat_group_readonly', '群聊已解散，不能继续修改。', 409);
    const manager = ['owner', 'admin'].includes(membership.role);
    await inTransaction(pool, async (client) => {
      if (action === 'rename') {
        if (!manager) throw apiError('chat_group_manager_required', '只有群主或管理员可以修改群名。', 403);
        const title = String(req.body?.title || '').trim().slice(0, 80);
        if (!title) throw apiError('chat_group_title_required', '请输入群名。', 400);
        await client.query('UPDATE chat_groups SET title=$1,updated_at=now() WHERE id=$2', [title, groupId]);
      } else if (action === 'set_display_name') {
        const displayName = String(req.body?.displayName || req.body?.display_name || '').trim().slice(0, 80);
        await client.query(`UPDATE chat_group_members SET display_name_override=$1
          WHERE group_id=$2 AND user_id=$3 AND status='active'`, [displayName, groupId, req.auth.user.id]);
      } else if (action === 'add_member') {
        if (!manager) throw apiError('chat_group_manager_required', '只有群主或管理员可以添加成员。', 403);
        if (accountGlobal) await requireContactChatPeer(client, workspace, req.auth.user.id, targetId);
        else await requireWorkspaceMessagingPeer(client, workspace, req.auth.user.id, targetId);
        await client.query(`INSERT INTO chat_group_members(group_id,user_id,role,status,invited_by_user_id,joined_at,left_at)
          VALUES($1,$2,'member','active',$3,now(),NULL) ON CONFLICT(group_id,user_id) DO UPDATE SET role='member',status='active',
          invited_by_user_id=excluded.invited_by_user_id,joined_at=now(),left_at=NULL`, [groupId, targetId, req.auth.user.id]);
      } else if (action === 'remove_member') {
        if (!manager || targetId === group.owner_user_id) throw apiError('chat_group_remove_forbidden', '无法移除该成员。', 403);
        await client.query("UPDATE chat_group_members SET status='removed',left_at=now() WHERE group_id=$1 AND user_id=$2 AND status='active'", [groupId, targetId]);
      } else if (action === 'set_role') {
        const role = String(req.body?.role || '').trim();
        if (membership.role !== 'owner' || targetId === group.owner_user_id || !['admin', 'member'].includes(role)) throw apiError('chat_group_owner_required', '只有群主可以调整管理员。', 403);
        await client.query("UPDATE chat_group_members SET role=$1 WHERE group_id=$2 AND user_id=$3 AND status='active'", [role, groupId, targetId]);
      } else if (action === 'transfer_owner') {
        if (membership.role !== 'owner' || !targetId || targetId === req.auth.user.id) throw apiError('chat_group_owner_required', '请选择新群主。', 403);
        const target = await one(client, "SELECT 1 FROM chat_group_members WHERE group_id=$1 AND user_id=$2 AND status='active'", [groupId, targetId]);
        if (!target) throw apiError('chat_group_member_not_found', '新群主必须是当前成员。', 404);
        await client.query("UPDATE chat_group_members SET role='member' WHERE group_id=$1 AND user_id=$2", [groupId, req.auth.user.id]);
        await client.query("UPDATE chat_group_members SET role='owner' WHERE group_id=$1 AND user_id=$2", [groupId, targetId]);
        await client.query('UPDATE chat_groups SET owner_user_id=$1,updated_at=now() WHERE id=$2', [targetId, groupId]);
      } else if (action === 'leave') {
        if (membership.role === 'owner') throw apiError('chat_group_owner_transfer_required', '群主退出前需先转让群主或解散群聊。', 409);
        await client.query("UPDATE chat_group_members SET status='left',left_at=now() WHERE group_id=$1 AND user_id=$2", [groupId, req.auth.user.id]);
      } else if (action === 'dissolve') {
        if (membership.role !== 'owner') throw apiError('chat_group_owner_required', '只有群主可以解散群聊。', 403);
        await client.query("UPDATE chat_groups SET status='dissolved',dissolved_at=now(),updated_at=now() WHERE id=$1", [groupId]);
      } else if (action === 'withdraw_message') {
        const message = targetMessageId
          ? await one(client, 'SELECT * FROM chat_group_messages WHERE id=$1 AND group_id=$2', [targetMessageId, groupId])
          : null;
        const metadata = publicSocialMessageMetadata(message?.metadata_json);
        if (!message || message.sender_user_id !== req.auth.user.id || message.kind !== 'friend' || String(message.sender_agent_id || '').trim()) {
          throw apiError('chat_group_message_withdraw_forbidden', '只能撤回自己发送的自然人群聊消息。', 403);
        }
        if (metadata.withdrawn === true) throw apiError('chat_group_message_already_withdrawn', '这条群聊消息已经撤回。', 409);
        const ageMs = Date.now() - new Date(message.created_at || 0).getTime();
        if (!Number.isFinite(ageMs) || ageMs < -30_000 || ageMs > 2 * 60 * 1000) {
          throw apiError('chat_group_message_withdraw_expired', '消息发送超过2分钟，无法撤回。', 409);
        }
        await client.query('UPDATE chat_group_messages SET metadata_json=$1::jsonb,updated_at=now() WHERE id=$2 AND group_id=$3', [
          JSON.stringify({ ...metadata, withdrawn: true, withdrawnAt: new Date().toISOString() }), targetMessageId, groupId,
        ]);
        await client.query('UPDATE chat_groups SET updated_at=now() WHERE id=$1', [groupId]);
      } else {
        throw apiError('chat_group_action_invalid', '不支持的群聊操作。', 400);
      }
      await client.query(`INSERT INTO chat_group_operations(idempotency_key,group_id,actor_user_id,operation_kind,request_payload_hash,response_json)
        VALUES($1,$2,$3,'update_group',$4,'{}'::jsonb)`, [idempotencyKey, groupId, req.auth.user.id, payloadHash]);
    });
    res.json({ ok: true, ...(await naturalChatGroupDetail(pool, groupId, req.auth.user.id, workspace.id, { accountGlobal })) });
  }));

  app.get('/api/social/messages', auth, route(async (req, res) => {
    const userId = req.auth.user.id;
    const accountGlobal = accountSocialDirectRequested(req);
    const workspace = accountGlobal ? null : await requireAccountWorkspaceAccess(pool, userId, req.query.workspaceId || req.headers['x-janus-workspace-id']);
    const peerId = String(req.query.peerId || '').trim();
    const cursor = parseCursor(req.query.cursor);
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    const params = [userId];
    const where = ['(sm.sender_user_id = $1 OR sm.recipient_user_id = $1)'];
    if (!accountGlobal) {
      params.push(workspace.id);
      where.push(`sm.account_workspace_id = $${params.length}`);
    }
    if (peerId) {
      params.push(peerId);
      where.push(`((sm.sender_user_id = $1 AND sm.recipient_user_id = $${params.length}) OR (sm.sender_user_id = $${params.length} AND sm.recipient_user_id = $1))`);
    }
    if (cursor) {
      params.push(cursor);
      where.push(`sm.updated_at > $${params.length}`);
    }
    params.push(limit);
    const rows = await many(
      pool,
      `SELECT sm.*,
              sender.email AS sender_email, sender.display_name AS sender_display_name,
              sender.username AS sender_username, sender.avatar_url AS sender_avatar_url,
              sender.role AS sender_role, sender.email_verified AS sender_email_verified,
              recipient.email AS recipient_email, recipient.display_name AS recipient_display_name,
              recipient.username AS recipient_username, recipient.avatar_url AS recipient_avatar_url,
              recipient.role AS recipient_role, recipient.email_verified AS recipient_email_verified
       FROM social_messages sm
       JOIN users sender ON sender.id = sm.sender_user_id
       JOIN users recipient ON recipient.id = sm.recipient_user_id
       WHERE ${where.join(' AND ')}
       ORDER BY sm.updated_at ASC
       LIMIT $${params.length}`,
      params,
    );
    res.json({ items: rows.map(socialMessagePayload), cursor: rows.at(-1)?.updated_at?.toISOString?.() || cursor || new Date().toISOString() });
  }));

  app.put('/api/social/files/:fileId', auth, express.raw({ type: 'application/octet-stream', limit: '60mb' }), route(async (req, res) => {
    const ownerUserId = req.auth.user.id;
    const recipientUserId = String(req.headers['x-janus-recipient-id'] || '').trim();
    const fileId = String(req.params.fileId || '').trim().slice(0, 200);
    const workspace = await requireAccountWorkspaceAccess(pool, ownerUserId, requestAccountWorkspaceId(req));
    await requireContactChatPeer(pool, workspace, ownerUserId, recipientUserId);
    if (!fileId) throw apiError('social_file_id_required', '缺少私聊附件 ID。', 400);
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    if (!data.length) throw apiError('social_file_empty', '不能发送空附件。', 400);
    if (data.length > MAX_COLLABORATION_FILE_BYTES) throw apiError('social_file_too_large', '私聊附件不能超过 60 MB。', 413);
    const filename = collaborationFilename(req.headers['x-janus-filename']);
    const contentType = String(req.headers['x-janus-content-type'] || 'application/octet-stream').trim().slice(0, 200) || 'application/octet-stream';
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    const claimedSha256 = String(req.headers['x-janus-file-sha256'] || '').trim().toLowerCase();
    if (claimedSha256 && claimedSha256 !== sha256) throw apiError('social_file_hash_mismatch', '私聊附件校验失败。', 400);
    const existing = await one(pool, 'SELECT * FROM social_message_files WHERE id = $1', [fileId]);
    if (existing && (existing.account_workspace_id !== workspace.id || existing.owner_user_id !== ownerUserId || existing.recipient_user_id !== recipientUserId || existing.sha256 !== sha256)) {
      throw apiError('social_file_conflict', '私聊附件 ID 已被其他文件占用。', 409);
    }
    await pool.query(
      `INSERT INTO social_message_files (
         id, account_workspace_id, owner_user_id, recipient_user_id, filename, content_type, size_bytes, sha256, data, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, decode($9, 'base64'), now())
       ON CONFLICT (id) DO UPDATE SET
         filename = excluded.filename, content_type = excluded.content_type,
         size_bytes = excluded.size_bytes, data = excluded.data, updated_at = now()`,
      [fileId, workspace.id, ownerUserId, recipientUserId, filename, contentType, data.length, sha256, data.toString('base64')],
    );
    const stored = await one(pool, 'SELECT * FROM social_message_files WHERE id = $1', [fileId]);
    res.status(existing ? 200 : 201).json({ ok: true, attachment: socialFileAttachment(stored) });
  }));

  app.get('/api/social/files/:fileId', auth, route(async (req, res) => {
    const fileId = String(req.params.fileId || '').trim();
    const file = await one(pool, 'SELECT * FROM social_message_files WHERE id = $1', [fileId])
      || await one(pool, "SELECT * FROM large_file_objects WHERE id=$1 AND scope_kind='social' AND status='ready'", [fileId]);
    if (!file) throw apiError('social_file_not_found', '私聊附件不存在。', 404);
    if (!accountSocialDirectRequested(req)) {
      const workspace = await requireAccountWorkspaceAccess(pool, req.auth.user.id, requestAccountWorkspaceId(req));
      if (file.account_workspace_id !== workspace.id) throw apiError('social_file_not_found', '私聊附件不存在。', 404);
    }
    if (![file.owner_user_id, file.recipient_user_id].includes(req.auth.user.id)) {
      throw apiError('social_file_forbidden', '无权下载该私聊附件。', 403);
    }
    sendStoredFile(req, res, file, largeFileStorageRoot);
  }));

  app.post('/api/social/messages', auth, route(async (req, res) => {
    const senderId = req.auth.user.id;
    const recipientId = String(req.body.recipientId || req.body.userId || '').trim();
    const workspace = await requireAccountWorkspaceAccess(pool, senderId, req.body.workspaceId || req.headers['x-janus-workspace-id']);
    await requireContactChatPeer(pool, workspace, senderId, recipientId);
    const content = String(req.body.content || '').trim();
    if (!content) throw apiError('message_required', '请输入消息内容。', 400);
    const metadata = publicSocialMessageMetadata(req.body.metadata);
    const selfMessage = senderId === recipientId;
    if (selfMessage && (String(req.body.senderAgentId || '').trim() || String(req.body.recipientAgentId || '').trim() || !['', 'direct_message'].includes(String(metadata.type || '')))) {
      throw apiError('self_message_kind_invalid', '自己与自己的会话只支持普通消息。', 400);
    }
    if (metadata.type === 'social_task_group_message') {
      const taskGroupId = String(metadata.taskGroupId || metadata.groupId || '').trim();
      if (!taskGroupId) throw apiError('task_group_id_required', '缺少任务群聊 ID。', 400);
      const dissolved = await one(
        pool,
        `SELECT 1 FROM social_messages
         WHERE account_workspace_id=$1 AND metadata_json->>'type' = 'social_task_group'
           AND metadata_json->>'action' = 'dissolved'
           AND COALESCE(metadata_json->>'taskGroupId', metadata_json->>'groupId') = $2
           AND ((sender_user_id = $3 AND recipient_user_id = $4) OR (sender_user_id = $4 AND recipient_user_id = $3))
         LIMIT 1`,
        [workspace.id, taskGroupId, senderId, recipientId],
      );
      if (dissolved) throw apiError('task_group_closed', '任务群已解散，只能查看历史记录。', 409);
      metadata.taskGroupId = taskGroupId;
      metadata.groupId = taskGroupId;
    }
    if (metadata.type === 'social_task_group') {
      const taskGroupId = String(metadata.taskGroupId || metadata.groupId || '').trim();
      const action = String(metadata.action || '').trim().toLowerCase();
      if (!taskGroupId) throw apiError('task_group_id_required', '缺少任务群聊 ID。', 400);
      metadata.taskGroupId = taskGroupId;
      metadata.groupId = taskGroupId;
      if (action === 'created') {
        metadata.initiatorUserId = senderId;
      } else if (action === 'dissolved' || action === 'renamed') {
        const created = await one(
          pool,
          `SELECT sender_user_id FROM social_messages
           WHERE account_workspace_id=$1 AND metadata_json->>'type' = 'social_task_group'
             AND metadata_json->>'action' = 'created'
             AND COALESCE(metadata_json->>'taskGroupId', metadata_json->>'groupId') = $2
             AND ((sender_user_id = $3 AND recipient_user_id = $4) OR (sender_user_id = $4 AND recipient_user_id = $3))
           ORDER BY created_at ASC LIMIT 1`,
          [workspace.id, taskGroupId, senderId, recipientId],
        );
        if (!created || created.sender_user_id !== senderId) {
          throw apiError(action === 'renamed' ? 'task_group_rename_forbidden' : 'task_group_dissolve_forbidden', action === 'renamed' ? '只有群聊发起人可以修改群聊名称。' : '只有群聊发起人可以解散任务群聊。', 403);
        }
        metadata.initiatorUserId = created.sender_user_id;
        if (action === 'renamed') metadata.groupTitle = String(metadata.groupTitle || metadata.title || '').trim().slice(0, 80);
      }
    }
    await validateDirectMessageAttachments(pool, metadata.attachments, senderId, recipientId, workspace.id);
    const id = String(req.body.clientMessageId || '').trim().slice(0, 200) || newId('social_msg');
    const existingMessage = await one(pool, 'SELECT * FROM social_messages WHERE id=$1', [id]);
    if (existingMessage) {
      if (existingMessage.sender_user_id !== senderId || existingMessage.recipient_user_id !== recipientId
        || existingMessage.content !== content.slice(0, 8000) || existingMessage.title !== String(req.body.title || '').slice(0, 160)) {
        throw apiError('social_message_idempotency_conflict', '消息幂等键已被不同请求占用。', 409);
      }
      return res.json({ ok: true, idempotent: true, message: await hydratedSocialMessage(pool, id) });
    }
    const row = await one(
      pool,
      `INSERT INTO social_messages (
        id, account_workspace_id, sender_user_id, recipient_user_id, sender_agent_id, recipient_agent_id,
        kind, title, content, metadata_json
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       RETURNING *`,
      [
        id, workspace.id, senderId, recipientId,
        String(req.body.senderAgentId || '').slice(0, 80),
        String(req.body.recipientAgentId || '').slice(0, 80),
        normalizeMessageKind(req.body.kind),
        String(req.body.title || '').slice(0, 160),
        content.slice(0, 8000),
        JSON.stringify(metadata),
      ],
    );
    if (selfMessage) await pool.query("UPDATE social_messages SET status='read',read_at=now(),updated_at=now() WHERE id=$1", [row.id]);
    res.status(201).json({ ok: true, message: await hydratedSocialMessage(pool, row.id) });
  }));

  app.patch('/api/social/messages/:messageId', auth, route(async (req, res) => {
    const messageId = String(req.params.messageId || '');
    const current = await one(pool, 'SELECT * FROM social_messages WHERE id = $1 AND sender_user_id = $2', [messageId, req.auth.user.id]);
    if (!current) throw apiError('message_not_found', '\u6d88\u606f\u4e0d\u5b58\u5728\u6216\u65e0\u6743\u4fee\u6539\u3002', 404);
    if (!accountSocialDirectRequested(req)) {
      const workspace = await requireAccountWorkspaceAccess(pool, req.auth.user.id, requestAccountWorkspaceId(req));
      if (current.account_workspace_id !== workspace.id) throw apiError('message_not_found', '消息不存在或无权修改。', 404);
    }
    const currentMetadata = publicSocialMessageMetadata(current.metadata_json);
    const withdraw = String(req.body.action || '').toLowerCase() === 'withdraw';
    const directPersonMessage = currentMetadata.type === 'direct_message'
      && current.kind === 'friend'
      && !String(current.sender_agent_id || '').trim()
      && !String(current.recipient_agent_id || '').trim()
      && current.sender_user_id !== current.recipient_user_id;
    const delegationComment = currentMetadata.type === 'agent_delegation_comment';
    if (!delegationComment && !(withdraw && directPersonMessage)) {
      throw apiError('message_update_forbidden', withdraw ? '只能撤回自己发送的自然人私聊消息。' : '\u53ea\u80fd\u4fee\u6539\u59d4\u6258\u7684\u8865\u5145\u6d88\u606f\u3002', 403);
    }
    if (withdraw && directPersonMessage) {
      const ageMs = Date.now() - new Date(current.created_at || 0).getTime();
      if (!Number.isFinite(ageMs) || ageMs < -30_000 || ageMs > 2 * 60 * 1000) {
        throw apiError('message_withdraw_expired', '消息发送超过2分钟，无法撤回。', 409);
      }
    }
    const content = withdraw ? current.content : String(req.body.content ?? current.content ?? '').trim();
    if (!withdraw && !content) throw apiError('message_required', '\u4fee\u6539\u540e\u7684\u5185\u5bb9\u4e0d\u80fd\u4e3a\u7a7a\u3002', 400);
    const now = new Date().toISOString();
    const metadata = {
      ...currentMetadata,
      ...publicSocialMessageMetadata(req.body.metadata),
      ...(withdraw ? { withdrawn: true, withdrawnAt: now } : { withdrawn: false, edited: true, editedAt: now }),
    };
    await validateDirectMessageAttachments(pool, metadata.attachments, current.sender_user_id, current.recipient_user_id, current.account_workspace_id);
    await pool.query(
      'UPDATE social_messages SET content = $1, metadata_json = $2::jsonb, updated_at = now() WHERE id = $3 AND sender_user_id = $4',
      [content.slice(0, 8000), JSON.stringify(metadata), messageId, req.auth.user.id],
    );
    res.json({ ok: true, message: await hydratedSocialMessage(pool, messageId) });
  }));

  app.post('/api/social/messages/:messageId/read', auth, route(async (req, res) => {
    const current = await one(pool, 'SELECT account_workspace_id FROM social_messages WHERE id=$1 AND recipient_user_id=$2', [String(req.params.messageId || ''), req.auth.user.id]);
    if (!current) throw apiError('message_not_found', '消息不存在。', 404);
    if (!accountSocialDirectRequested(req)) {
      const workspace = await requireAccountWorkspaceAccess(pool, req.auth.user.id, requestAccountWorkspaceId(req));
      if (current.account_workspace_id !== workspace.id) throw apiError('message_not_found', '消息不存在。', 404);
    }
    const row = await one(
      pool,
      `UPDATE social_messages SET status = 'read', read_at = now(), updated_at = now()
       WHERE id = $1 AND recipient_user_id = $2 RETURNING *`,
      [String(req.params.messageId || ''), req.auth.user.id],
    );
    if (!row) throw apiError('message_not_found', '消息不存在。', 404);
    res.json({ ok: true, message: await hydratedSocialMessage(pool, row.id) });
  }));

  app.get('/api/delegations', auth, route(async (req, res) => {
    const userId = req.auth.user.id;
    const workspace = await requireAccountWorkspaceAccess(pool, userId, requestAccountWorkspaceId(req));
    const direction = ['incoming', 'outgoing'].includes(String(req.query.direction || '')) ? String(req.query.direction) : 'all';
    const cursor = parseCursor(req.query.cursor);
    const cursorId = String(req.query.cursorId || '').trim().slice(0, 240);
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    const params = [userId, workspace.id];
    const where = ['ad.account_workspace_id=$2', direction === 'incoming' ? 'ad.recipient_user_id = $1' : direction === 'outgoing' ? 'ad.requester_user_id = $1' : '(ad.requester_user_id = $1 OR ad.recipient_user_id = $1)'];
    if (cursor) {
      params.push(cursor);
      const cursorParam = params.length;
      if (cursorId) {
        params.push(cursorId);
        where.push(`(ad.updated_at > $${cursorParam} OR (ad.updated_at = $${cursorParam} AND ad.id > $${params.length}))`);
      } else {
        where.push(`ad.updated_at > $${cursorParam}`);
      }
    }
    params.push(limit);
    const rows = await many(
      pool,
      `${delegationSelectSql()} WHERE ${where.join(' AND ')} ORDER BY ad.updated_at ASC, ad.id ASC LIMIT $${params.length}`,
      params,
    );
    res.json({
      items: await delegationPayloadsForViewer(pool, rows, userId),
      cursor: rows.at(-1)?.updated_at?.toISOString?.() || cursor || new Date().toISOString(),
      cursorId: rows.at(-1)?.id || cursorId || '',
    });
  }));

  app.post('/api/delegations/:delegationId/execution-claim', auth, route(async (req, res) => {
    requireDelegationExecutionLeaseCapability(req);
    const delegationId = String(req.params.delegationId || '').trim();
    const deviceId = String(req.body?.deviceId || '').trim().slice(0, 240);
    if (!deviceId) throw apiError('delegation_execution_device_required', '缺少执行设备标识。', 400);
    const leaseSeconds = Math.max(30, Math.min(300, Number(req.body?.leaseSeconds || 90) || 90));
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    const claimResult = await inTransaction(pool, async (client) => {
      const delegation = await one(client, 'SELECT * FROM agent_delegations WHERE id=$1 FOR UPDATE', [delegationId]);
      if (!delegation || delegation.recipient_user_id !== req.auth.user.id) {
        throw apiError('delegation_not_found', '委托任务不存在。', 404);
      }
      if (['submitted', 'result_accepted', 'closed', 'withdrawn', 'declined', 'rejected', 'completed'].includes(String(delegation.status || ''))) {
        throw apiError('delegation_execution_terminal', '当前委托状态不允许获取执行权。', 409);
      }
      const current = await one(client, 'SELECT * FROM agent_delegation_execution_leases WHERE delegation_id=$1 FOR UPDATE', [delegationId]);
      const currentActive = current && !current.released_at && new Date(current.lease_expires_at).getTime() > Date.now();
      if (currentActive && current.device_id !== deviceId) {
        throw apiError('delegation_execution_claimed', '该任务正在另一台设备上执行。', 409, {
          deviceId: current.device_id,
          executionEpoch: Number(current.execution_epoch || 1),
          leaseExpiresAt: toIso(current.lease_expires_at),
        });
      }
      const takeover = !current || current.device_id !== deviceId || !currentActive;
      const executionEpoch = takeover ? Number(current?.execution_epoch || 0) + 1 : Number(current.execution_epoch || 1);
      const maxPlanningEpochs = Math.max(1, Number(process.env.JANUS_EXTERNAL_DELEGATION_MAX_PLANNING_EPOCHS || 3));
      const planningRecoveryExhausted = takeover
        && executionEpoch > maxPlanningEpochs
        && !String(delegation.task_run_id || '').trim()
        && ['preparing', 'awaiting_approval', 'accepted', 'running'].includes(String(delegation.status || ''));
      if (planningRecoveryExhausted) {
        const occurredAt = new Date().toISOString();
        const currentMetadata = jsonObject(delegation.metadata_json);
        const currentProgress = jsonObject(currentMetadata.executionProgress);
        const publicMessage = '任务规划连续多次未能完成，云端已停止自动重试，避免任务反复从准备阶段重新开始。请检查接收方模型服务后手动重试。';
        const metadata = {
          ...currentMetadata,
          executionState: 'failed',
          deliveryState: 'blocked',
          failureCode: 'ubuddy_planning_recovery_exhausted',
          failureStage: 'unified_planning_recovery',
          retryable: false,
          publicFailure: {
            code: 'ubuddy_planning_recovery_exhausted',
            stage: 'unified_planning_recovery',
            message: publicMessage,
            retryable: false,
            occurredAt,
          },
          executionProgress: {
            ...currentProgress,
            version: 2,
            sequence: Number(currentProgress.sequence || 0) + 1,
            phase: 'failed',
            taskStatus: 'failed',
            failureStage: 'unified_planning_recovery',
            message: publicMessage,
            failed: Math.max(1, Number(currentProgress.failed || 0)),
            terminal: true,
            updatedAt: occurredAt,
          },
        };
        await client.query(`UPDATE agent_delegations SET status='failed',last_error=$1,metadata_json=$2::jsonb,updated_at=now()
          WHERE id=$3`, [publicMessage, JSON.stringify(metadata), delegationId]);
        if (current) await client.query(`UPDATE agent_delegation_execution_leases SET
          released_at=now(),release_reason='planning_recovery_exhausted',updated_at=now() WHERE delegation_id=$1`, [delegationId]);
        await appendDelegationRealtimeEvents(client, {
          delegationId,
          accountWorkspaceId: delegation.account_workspace_id || 'workspace_personal',
          recipientUserIds: [delegation.requester_user_id, delegation.recipient_user_id],
          eventType: 'delegation.failed',
          aggregateVersion: executionEpoch,
          payload: { status: 'failed', failureCode: 'ubuddy_planning_recovery_exhausted', executionEpoch },
        });
        return { planningRecoveryExhausted: true, executionEpoch, maxPlanningEpochs };
      }
      const leaseToken = takeover ? randomToken(32) : current.lease_token;
      const updated = await one(client, `INSERT INTO agent_delegation_execution_leases(
        delegation_id,account_workspace_id,recipient_user_id,device_id,lease_token,execution_epoch,lease_expires_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(delegation_id) DO UPDATE SET
        account_workspace_id=excluded.account_workspace_id,recipient_user_id=excluded.recipient_user_id,
        device_id=excluded.device_id,lease_token=excluded.lease_token,execution_epoch=excluded.execution_epoch,
        lease_expires_at=excluded.lease_expires_at,renewed_at=now(),released_at=NULL,release_reason='',updated_at=now()
      RETURNING *`, [delegationId, delegation.account_workspace_id || 'workspace_personal', delegation.recipient_user_id,
        deviceId, leaseToken, executionEpoch, leaseExpiresAt]);
      return { lease: updated };
    });
    if (claimResult?.planningRecoveryExhausted) {
      throw apiError('delegation_planning_recovery_exhausted', '任务规划连续失败，云端已停止自动重试。', 409, {
        executionEpoch: claimResult.executionEpoch,
        maxPlanningEpochs: claimResult.maxPlanningEpochs,
      });
    }
    res.json({ ok: true, lease: delegationExecutionLeasePayload(claimResult?.lease) });
  }));

  app.post('/api/delegations/:delegationId/execution-lease/renew', auth, route(async (req, res) => {
    requireDelegationExecutionLeaseCapability(req);
    const delegationId = String(req.params.delegationId || '').trim();
    const deviceId = String(req.body?.deviceId || '').trim().slice(0, 240);
    const leaseToken = String(req.body?.leaseToken || '').trim().slice(0, 500);
    const leaseSeconds = Math.max(30, Math.min(300, Number(req.body?.leaseSeconds || 90) || 90));
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    const lease = await one(pool, `UPDATE agent_delegation_execution_leases SET
      lease_expires_at=$1,renewed_at=now(),updated_at=now()
      WHERE delegation_id=$2 AND recipient_user_id=$3 AND device_id=$4 AND lease_token=$5
        AND released_at IS NULL AND lease_expires_at>now() RETURNING *`, [
      leaseExpiresAt, delegationId, req.auth.user.id, deviceId, leaseToken,
    ]);
    if (!lease) throw apiError('delegation_execution_lease_lost', '任务执行租约已经失效。', 409);
    res.json({ ok: true, lease: delegationExecutionLeasePayload(lease) });
  }));

  app.post('/api/delegations/:delegationId/execution-lease/release', auth, route(async (req, res) => {
    requireDelegationExecutionLeaseCapability(req);
    const delegationId = String(req.params.delegationId || '').trim();
    const deviceId = String(req.body?.deviceId || '').trim().slice(0, 240);
    const leaseToken = String(req.body?.leaseToken || '').trim().slice(0, 500);
    const lease = await one(pool, `UPDATE agent_delegation_execution_leases SET
      released_at=now(),release_reason=$1,updated_at=now()
      WHERE delegation_id=$2 AND recipient_user_id=$3 AND device_id=$4 AND lease_token=$5 RETURNING *`, [
      String(req.body?.reason || 'released').trim().slice(0, 240), delegationId, req.auth.user.id, deviceId, leaseToken,
    ]);
    res.json({ ok: true, released: Boolean(lease), lease: lease ? delegationExecutionLeasePayload(lease) : null });
  }));

  app.post('/api/delegations', auth, route(async (req, res) => {
    const requesterId = req.auth.user.id;
    const recipientId = String(req.body.recipientId || req.body.userId || '').trim();
    const workspace = await requireAccountWorkspaceAccess(pool, requesterId, requestAccountWorkspaceId(req));
    await requireWorkspaceMessagingPeer(pool, workspace, requesterId, recipientId);
    const instruction = String(req.body.instruction || '').trim();
    if (!instruction) throw apiError('delegation_instruction_required', '请输入委托任务内容。', 400);
    const title = String(req.body.title || instruction.slice(0, 48) || 'Buddy agent 委托').slice(0, 160);
    const delegationMetadata = jsonObject(req.body.metadata);
    const clientRequestId = String(req.body.clientRequestId || delegationMetadata.dispatchCommandId || '').trim().slice(0, 240);
    if (clientRequestId) {
      const existing = await one(pool, `SELECT * FROM agent_delegations
        WHERE account_workspace_id=$1 AND requester_user_id=$2 AND client_request_id=$3`, [workspace.id, requesterId, clientRequestId]);
      if (existing) {
        if (existing.recipient_user_id !== recipientId || existing.title !== title || existing.instruction !== instruction.slice(0, 16000)) {
          throw apiError('delegation_idempotency_conflict', '委托创建幂等键已被不同请求占用。', 409);
        }
        return res.json({ ok: true, idempotent: true, delegation: await hydratedDelegation(pool, existing.id, requesterId), message: null });
      }
    }
    const result = await inTransaction(pool, async (client) => {
      const id = newId('agent_delegate');
      const inserted = await client.query(
        `INSERT INTO agent_delegations (
          id, account_workspace_id, requester_user_id, recipient_user_id, client_request_id, sender_agent_id, recipient_agent_id,
          title, instruction, metadata_json
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
         ${clientRequestId ? 'ON CONFLICT DO NOTHING' : ''}
         RETURNING id`,
        [
          id, workspace.id, requesterId, recipientId, clientRequestId,
          String(req.body.senderAgentId || 'secretary_agent').slice(0, 80),
          String(req.body.recipientAgentId || 'secretary_agent').slice(0, 80),
          title, instruction.slice(0, 16000), JSON.stringify(publicDelegationMetadata(delegationMetadata)),
        ],
      );
      if (!inserted.rowCount) {
        const existing = await one(client, `SELECT * FROM agent_delegations
          WHERE account_workspace_id=$1 AND requester_user_id=$2 AND client_request_id=$3`, [workspace.id, requesterId, clientRequestId]);
        if (!existing) throw apiError('delegation_idempotency_conflict', '委托创建幂等请求发生冲突，请重试。', 409);
        if (existing.recipient_user_id !== recipientId || existing.title !== title || existing.instruction !== instruction.slice(0, 16000)) {
          throw apiError('delegation_idempotency_conflict', '委托创建幂等键已被不同请求占用。', 409);
        }
        return { delegationId: existing.id, messageId: '', idempotent: true };
      }
      const requesterWorkspaceMetadata = privateDelegationMetadata(delegationMetadata);
      if (Object.keys(requesterWorkspaceMetadata).length) {
        await client.query(
          `INSERT INTO agent_delegation_workspaces (delegation_id, user_id, metadata_json, updated_at)
           VALUES ($1, $2, $3::jsonb, now())`,
          [id, requesterId, JSON.stringify(requesterWorkspaceMetadata)],
        );
      }
      const messageId = newId('social_msg');
      await client.query(
        `INSERT INTO social_messages (
          id, account_workspace_id, sender_user_id, recipient_user_id, sender_agent_id, recipient_agent_id,
          kind, title, content, metadata_json
         ) VALUES ($1, $2, $3, $4, 'secretary_agent', 'secretary_agent', 'agent', $5, $6, $7::jsonb)`,
        [messageId, workspace.id, requesterId, recipientId, `Buddy agent 委托：${title}`, instruction.slice(0, 8000), JSON.stringify({ ...publicDelegationMetadata(delegationMetadata), type: 'agent_delegation', action: 'assigned', delegationId: id, status: 'assigned' })],
      );
      await appendDelegationRealtimeEvents(client, {
        delegationId: id,
        accountWorkspaceId: workspace.id,
        recipientUserIds: [requesterId, recipientId],
        eventType: 'delegation.assigned',
        aggregateVersion: 1,
        payload: { status: 'assigned', requesterUserId: requesterId, recipientUserId: recipientId },
      });
      return { delegationId: id, messageId, idempotent: false };
    });
    if (result.idempotent) {
      return res.json({ ok: true, idempotent: true, delegation: await hydratedDelegation(pool, result.delegationId, requesterId), message: null });
    }
    res.status(201).json({
      ok: true,
      delegation: await hydratedDelegation(pool, result.delegationId, requesterId),
      message: await hydratedSocialMessage(pool, result.messageId),
    });
  }));

  app.patch('/api/delegations/:delegationId', auth, route(async (req, res) => {
    const delegationId = String(req.params.delegationId || '');
    const current = await one(pool, 'SELECT * FROM agent_delegations WHERE id = $1', [delegationId]);
    if (!current || ![current.requester_user_id, current.recipient_user_id].includes(req.auth.user.id)) throw apiError('delegation_not_found', '委托任务不存在。', 404);
    const workspace = await requireAccountWorkspaceAccess(pool, req.auth.user.id, requestAccountWorkspaceId(req));
    if (current.account_workspace_id !== workspace.id) throw apiError('delegation_not_found', '委托任务不存在。', 404);
    if (current.group_id) await requireActiveTaskMembership(pool, current.group_id, req.auth.user.id, { accountWorkspaceId: workspace.id });
    const hasExplicitStatus = Object.prototype.hasOwnProperty.call(req.body || {}, 'status');
    const rawStatus = hasExplicitStatus ? String(req.body.status || '').trim().toLowerCase() : current.status;
    if (!isDelegationStatus(rawStatus)) throw apiError('delegation_status_invalid', '不支持的任务状态。', 400);
    const status = rawStatus;
    const statusChanged = status !== current.status;
    if (statusChanged && req.auth.user.id !== current.recipient_user_id) throw apiError('delegation_update_forbidden', '发起人不能通过通用更新接口修改任务状态。', 403);
    if (statusChanged && !legacyDelegationTransitionAllowed(current.status, status)) throw apiError('delegation_transition_invalid', `不能从 ${current.status} 更新为 ${status}。`, 409);
    const incomingMetadata = jsonObject(req.body.metadata);
    const publicMetadata = publicDelegationMetadata(incomingMetadata);
    const privateMetadata = privateDelegationMetadata(incomingMetadata);
    if (req.auth.user.id === current.requester_user_id && (Object.keys(publicMetadata).length || Object.prototype.hasOwnProperty.call(req.body || {}, 'taskRunId') || Object.prototype.hasOwnProperty.call(req.body || {}, 'lastError'))) {
      throw apiError('delegation_update_forbidden', '发起人只能维护自己的私有 uBuddy 工作区。', 403);
    }
    await inTransaction(pool, async (client) => {
      const locked = await one(client, 'SELECT * FROM agent_delegations WHERE id = $1 FOR UPDATE', [delegationId]);
      if (!locked) throw apiError('delegation_not_found', '委托任务不存在。', 404);
      const persistedStatus = hasExplicitStatus ? status : locked.status;
      if (persistedStatus !== locked.status && req.auth.user.id !== locked.recipient_user_id) throw apiError('delegation_update_forbidden', '发起人不能通过通用更新接口修改任务状态。', 403);
      if (persistedStatus !== locked.status && !legacyDelegationTransitionAllowed(locked.status, persistedStatus)) throw apiError('delegation_transition_invalid', `不能从 ${locked.status} 更新为 ${persistedStatus}。`, 409);
      const existingWorkspace = await one(client, 'SELECT * FROM agent_delegation_workspaces WHERE delegation_id = $1 AND user_id = $2', [delegationId, req.auth.user.id]);
      const workspaceSessionId = Object.prototype.hasOwnProperty.call(req.body || {}, 'sessionId')
        ? String(req.body.sessionId || '').slice(0, 200)
        : existingWorkspace?.session_id || '';
      const workspaceMetadata = { ...jsonObject(existingWorkspace?.metadata_json), ...privateMetadata };
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'sessionId') || Object.keys(privateMetadata).length) {
        await client.query(
          `INSERT INTO agent_delegation_workspaces (delegation_id, user_id, session_id, metadata_json, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, now())
           ON CONFLICT (delegation_id, user_id) DO UPDATE SET session_id = excluded.session_id, metadata_json = excluded.metadata_json, updated_at = now()`,
          [delegationId, req.auth.user.id, workspaceSessionId, JSON.stringify(workspaceMetadata)],
        );
      }
      if (req.auth.user.id === locked.recipient_user_id) {
        const metadata = { ...jsonObject(locked.metadata_json), ...publicMetadata };
        const transitionChanged = persistedStatus !== locked.status;
        await client.query(
          `UPDATE agent_delegations SET
             status = $1, task_run_id = $2, last_error = $3,
             metadata_json = $4::jsonb, updated_at = now(),
             started_at = CASE WHEN $1 IN ('accepted','running','working') THEN COALESCE(started_at, now()) ELSE started_at END,
             completed_at = CASE WHEN $1 IN ('completed','failed','rejected','declined') THEN now() ELSE completed_at END
           WHERE id = $5`,
          [persistedStatus, Object.prototype.hasOwnProperty.call(req.body || {}, 'taskRunId') ? String(req.body.taskRunId || '').slice(0, 200) : locked.task_run_id, Object.prototype.hasOwnProperty.call(req.body || {}, 'lastError') ? String(req.body.lastError || '').slice(0, 2000) : locked.last_error, JSON.stringify(metadata), delegationId],
        );
        if (transitionChanged && locked.group_id && ['running', 'draft_ready', 'blocked', 'failed'].includes(persistedStatus)) {
          const progress = jsonObject(metadata.executionProgress);
          const publicFailure = jsonObject(metadata.publicFailure);
          const failureStage = String(publicFailure.stage || metadata.failureStage || '').trim();
          const failureMessage = String(publicFailure.message || '').trim();
          const content = persistedStatus === 'running'
            ? `${locked.title || '任务'}：接收方 uBuddy 已开始处理。`
            : persistedStatus === 'draft_ready'
              ? `${locked.title || '任务'}：处理和校验已完成，等待接收方确认交付。`
              : `${locked.title || '任务'}：${failureMessage || (persistedStatus === 'blocked' ? '任务执行受阻。' : '任务执行失败。')}${failureStage ? `（阶段：${failureStage}）` : ''}`;
          const sourceEventId = `delegation-status:${delegationId}:${persistedStatus}:${Number(progress.sequence || 0)}`;
          await client.query(
            `INSERT INTO collaboration_group_messages
               (id, account_workspace_id, group_id, sender_user_id, sender_agent_id, kind, content, metadata_json, source_event_id)
             VALUES ($1, $2, $3, $4, 'secretary_agent', 'agent', $5, $6::jsonb, $7)
             ON CONFLICT DO NOTHING`,
            [newId('group_msg'), workspace.id, locked.group_id, req.auth.user.id, content.slice(0, 8000), JSON.stringify({
              type: 'delegation_milestone',
              action: persistedStatus,
              delegationId,
              status: persistedStatus,
              executionProgress: progress,
              publicFailure: Object.keys(publicFailure).length ? publicFailure : null,
            }), sourceEventId],
          );
          await client.query('UPDATE collaboration_groups SET updated_at = now() WHERE id = $1', [locked.group_id]);
        }
        const previousProgress = jsonObject(jsonObject(locked.metadata_json).executionProgress);
        const progress = jsonObject(metadata.executionProgress);
        const previousMilestoneKey = String((Array.isArray(previousProgress.milestones) ? previousProgress.milestones : []).at(-1)?.key || '');
        const milestone = (Array.isArray(progress.milestones) ? progress.milestones : []).at(-1) || null;
        const milestoneKey = String(milestone?.key || '');
        if (!transitionChanged && locked.group_id && milestoneKey && milestoneKey !== previousMilestoneKey) {
          const sourceEventId = `delegation-progress:${delegationId}:${milestoneKey}`.slice(0, 240);
          const milestoneContent = `${locked.title || '任务'}：${String(milestone.title || '任务进展').slice(0, 240)}${milestone.detail ? ` · ${String(milestone.detail).slice(0, 600)}` : ''}`;
          await client.query(
            `INSERT INTO collaboration_group_messages
               (id, account_workspace_id, group_id, sender_user_id, sender_agent_id, kind, content, metadata_json, source_event_id)
             VALUES ($1, $2, $3, $4, 'secretary_agent', 'agent', $5, $6::jsonb, $7)
             ON CONFLICT DO NOTHING`,
            [newId('group_msg'), workspace.id, locked.group_id, req.auth.user.id, milestoneContent.slice(0, 8000), JSON.stringify({
              type: 'delegation_progress', delegationId, status: persistedStatus,
              milestone, executionProgress: progress,
            }), sourceEventId],
          );
          await client.query('UPDATE collaboration_groups SET updated_at=now() WHERE id=$1', [locked.group_id]);
        }
        await appendDelegationRealtimeEvents(client, {
          delegationId,
          accountWorkspaceId: workspace.id,
          recipientUserIds: [locked.requester_user_id, locked.recipient_user_id],
          eventType: transitionChanged ? `delegation.${persistedStatus}` : 'delegation.progress',
          aggregateVersion: Number(progress.sequence || 0),
          payload: { status: persistedStatus, progressSequence: Number(progress.sequence || 0), milestoneKey },
        });
      }
    });
    let message = null;
    if (statusChanged && ['completed', 'failed', 'rejected'].includes(status)) {
      const messageId = newId('social_msg');
      const recipientId = current.requester_user_id;
      const content = String(req.body.result || req.body.lastError || `${current.title}：${status}`).slice(0, 8000);
      await pool.query(
        `INSERT INTO social_messages (
          id, account_workspace_id, sender_user_id, recipient_user_id, sender_agent_id, recipient_agent_id,
          kind, title, content, metadata_json
         ) VALUES ($1, $2, $3, $4, 'secretary_agent', 'secretary_agent', 'agent', $5, $6, $7::jsonb)`,
        [messageId, workspace.id, current.recipient_user_id, recipientId, `Buddy agent 任务${status === 'completed' ? '已完成' : '状态更新'}：${current.title}`, content, JSON.stringify({ ...publicMetadata, type: 'agent_delegation', action: status, delegationId, status })],
      );
      message = await hydratedSocialMessage(pool, messageId);
    }
    res.json({ ok: true, delegation: await hydratedDelegation(pool, delegationId, req.auth.user.id), message });
  }));

  app.get('/api/delegations/:delegationId/workspace', auth, route(async (req, res) => {
    const delegationId = String(req.params.delegationId || '');
    const accountWorkspace = await requireAccountWorkspaceAccess(pool, req.auth.user.id, requestAccountWorkspaceId(req));
    await requireDelegationParticipant(pool, delegationId, req.auth.user.id, accountWorkspace.id);
    const workspace = await one(pool, 'SELECT * FROM agent_delegation_workspaces WHERE delegation_id = $1 AND user_id = $2', [delegationId, req.auth.user.id]);
    const messages = await many(
      pool,
      `SELECT * FROM agent_delegation_workspace_messages
       WHERE delegation_id = $1 AND user_id = $2 ORDER BY created_at ASC, id ASC LIMIT 1000`,
      [delegationId, req.auth.user.id],
    );
    res.json({
      workspace: workspace ? delegationWorkspacePayload(workspace) : { delegationId, userId: req.auth.user.id, sessionId: '', metadata: {} },
      items: messages.map(delegationWorkspaceMessagePayload),
    });
  }));

  app.post('/api/delegations/:delegationId/workspace/messages', auth, route(async (req, res) => {
    const delegationId = String(req.params.delegationId || '');
    const accountWorkspace = await requireAccountWorkspaceAccess(pool, req.auth.user.id, requestAccountWorkspaceId(req));
    const delegation = await requireDelegationParticipant(pool, delegationId, req.auth.user.id, accountWorkspace.id);
    if (['closed', 'withdrawn', 'declined', 'rejected'].includes(delegation.status)) throw apiError('delegation_workspace_readonly', '任务已结束，私有工作区现在为只读。', 409);
    const content = String(req.body?.content || '').trim();
    if (!content) throw apiError('message_required', '请输入消息内容。', 400);
    const role = ['user', 'assistant', 'system'].includes(String(req.body?.role || '')) ? String(req.body.role) : 'user';
    const messageId = String(req.body?.clientMessageId || '').trim().slice(0, 200) || newId('workspace_msg');
    const metadata = privateWorkspaceMessageMetadata(jsonObject(req.body?.metadata));
    const sourceEventId = String(req.body?.sourceEventId || metadata.sourceEventId || '').trim().slice(0, 240);
    const sourceGroupMessageId = String(req.body?.sourceGroupMessageId || metadata.sourceGroupMessageId || '').trim().slice(0, 240);
    const row = await inTransaction(pool, async (client) => {
      const conflictingId = await one(client, 'SELECT delegation_id, user_id FROM agent_delegation_workspace_messages WHERE id = $1', [messageId]);
      const persistedMessageId = conflictingId && (conflictingId.delegation_id !== delegationId || conflictingId.user_id !== req.auth.user.id)
        ? `${messageId.slice(0, 140)}_${crypto.createHash('sha256').update(`${delegationId}:${req.auth.user.id}:${messageId}`).digest('hex').slice(0, 24)}`
        : messageId;
      await client.query(
        `INSERT INTO agent_delegation_workspaces (delegation_id, user_id, session_id, metadata_json, updated_at)
         VALUES ($1, $2, $3, '{}'::jsonb, now())
         ON CONFLICT (delegation_id, user_id) DO UPDATE SET
           session_id = CASE WHEN excluded.session_id <> '' THEN excluded.session_id ELSE agent_delegation_workspaces.session_id END,
           updated_at = now()`,
        [delegationId, req.auth.user.id, String(req.body?.sessionId || '').slice(0, 200)],
      );
      await client.query(
        `INSERT INTO agent_delegation_workspace_messages
           (id, delegation_id, user_id, role, content, metadata_json, source_event_id, source_group_message_id)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
         ON CONFLICT DO NOTHING`,
        [persistedMessageId, delegationId, req.auth.user.id, role, content.slice(0, 32000), JSON.stringify(metadata), sourceEventId, sourceGroupMessageId],
      );
      return one(client, `SELECT * FROM agent_delegation_workspace_messages
        WHERE delegation_id = $1 AND user_id = $2 AND (id = $3 OR ($4 <> '' AND source_event_id = $4) OR ($5 <> '' AND source_group_message_id = $5))
        ORDER BY created_at ASC LIMIT 1`, [delegationId, req.auth.user.id, persistedMessageId, sourceEventId, sourceGroupMessageId]);
    });
    res.status(201).json({ ok: true, message: delegationWorkspaceMessagePayload(row) });
  }));

  app.get('/api/collaboration', auth, route(async (req, res) => {
    const workspace = await requireAccountWorkspaceAccess(pool, req.auth.user.id, requestAccountWorkspaceId(req));
    res.json(await collaborationOverview(pool, req.auth.user.id, workspace.id));
  }));

  app.post('/api/collaboration/groups', auth, route(async (req, res) => {
    const ownerId = req.auth.user.id;
    const workspace = await requireAccountWorkspaceAccess(pool, ownerId, requestAccountWorkspaceId(req));
    const clientRequestId = String(req.body?.clientRequestId || '').trim() || newId('dispatch');
    const existing = await one(pool, 'SELECT id FROM collaboration_groups WHERE account_workspace_id=$1 AND owner_user_id=$2 AND client_request_id=$3', [workspace.id, ownerId, clientRequestId]);
    if (existing) return res.json({ ok: true, ...(await collaborationGroupDetail(pool, existing.id, ownerId, { accountWorkspaceId: workspace.id })), idempotent: true });
    const assignments = (Array.isArray(req.body?.assignments) ? req.body.assignments : [])
      .map((item) => ({
        recipientId: String(item.recipientId || item.userId || '').trim(),
        title: String(item.title || req.body?.title || 'uBuddy 委托任务').trim().slice(0, 160),
        instruction: String(item.instruction || '').trim().slice(0, 16000),
        metadata: jsonObject(item.metadata),
      }))
      .filter((item) => item.recipientId && item.recipientId !== ownerId && item.instruction);
    if (new Set(assignments.map((item) => item.recipientId)).size !== assignments.length) {
      throw apiError('collaboration_assignment_duplicate_recipient', '同一参与人只能对应一项远程分工；请将多个工作项合并到同一分工中。', 400);
    }
    if (!assignments.length) throw apiError('collaboration_assignments_required', '请至少选择一位好友并填写任务内容。', 400);
    for (const recipientId of [...new Set(assignments.map((item) => item.recipientId))]) {
      await requireWorkspaceMessagingPeer(pool, workspace, ownerId, recipientId);
    }
    const groupId = newId('collab_group');
    try {
      await inTransaction(pool, async (client) => {
        await client.query(
          `INSERT INTO collaboration_groups (id, account_workspace_id, owner_user_id, title, client_request_id, metadata_json)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [groupId, workspace.id, ownerId, String(req.body?.title || 'uBuddy 任务群').trim().slice(0, 80) || 'uBuddy 任务群', clientRequestId, JSON.stringify(jsonObject(req.body?.metadata))],
        );
        await client.query(
          `INSERT INTO collaboration_group_workspaces (group_id, workspace_epoch, revision, status)
           VALUES ($1, $2, 0, 'active')`,
          [groupId, `workspace_${groupId}`],
        );
        await client.query(`INSERT INTO collaboration_group_members (group_id, user_id, role, last_read_at) VALUES ($1, $2, 'owner', now())`, [groupId, ownerId]);
        for (const recipientId of [...new Set(assignments.map((item) => item.recipientId))]) {
          await client.query(`INSERT INTO collaboration_group_members (group_id, user_id, role) VALUES ($1, $2, 'member')`, [groupId, recipientId]);
        }
        await client.query(
          `INSERT INTO collaboration_group_messages (id, account_workspace_id, group_id, sender_user_id, sender_agent_id, kind, content, metadata_json)
           VALUES ($1, $2, $3, $4, 'secretary_agent', 'system', $5, $6::jsonb)`,
          [newId('group_msg'), workspace.id, groupId, ownerId, 'uBuddy 已创建任务群并发布任务。', JSON.stringify({ type: 'group_created' })],
        );
        for (const assignment of assignments) {
          const delegationId = newId('agent_delegate');
          const metadata = { ...jsonObject(req.body?.metadata), ...assignment.metadata, groupId, source: 'collaboration_group', initiatedThroughOwnUBuddy: true };
          await client.query(
            `INSERT INTO agent_delegations (
               id, account_workspace_id, requester_user_id, recipient_user_id, sender_agent_id, recipient_agent_id,
               title, instruction, status, group_id, metadata_json
             ) VALUES ($1, $2, $3, $4, 'secretary_agent', 'secretary_agent', $5, $6, 'assigned', $7, $8::jsonb)`,
            [delegationId, workspace.id, ownerId, assignment.recipientId, assignment.title, assignment.instruction, groupId, JSON.stringify(publicDelegationMetadata(metadata))],
          );
          const requesterPrivateMetadata = privateDelegationMetadata(metadata);
          await client.query(
            `INSERT INTO agent_delegation_workspaces (delegation_id, user_id, metadata_json)
             VALUES ($1, $2, $3::jsonb), ($1, $4, '{}'::jsonb)
             ON CONFLICT (delegation_id, user_id) DO NOTHING`,
            [delegationId, assignment.recipientId, JSON.stringify(requesterPrivateMetadata), ownerId],
          );
          const assignmentMessageId = newId('group_msg');
          await client.query(
            `INSERT INTO collaboration_group_messages (id, account_workspace_id, group_id, sender_user_id, sender_agent_id, kind, content, metadata_json)
             VALUES ($1, $2, $3, $4, 'secretary_agent', 'agent', $5, $6::jsonb)`,
            [assignmentMessageId, workspace.id, groupId, ownerId, assignment.instruction, JSON.stringify({ type: 'task_assigned', delegationId, recipientUserId: assignment.recipientId })],
          );
          await insertPrivateTaskIngress(client, {
            delegationId,
            userId: assignment.recipientId,
            content: assignment.instruction,
            type: 'task_assigned',
            sourceEventId: `task-assigned:${delegationId}`,
            sourceGroupMessageId: assignmentMessageId,
            fromUserId: ownerId,
          });
          await insertPrivateTaskIngress(client, {
            delegationId,
            userId: ownerId,
            content: assignment.instruction,
            type: 'task_published',
            sourceEventId: `task-published:${delegationId}`,
            sourceGroupMessageId: assignmentMessageId,
            fromUserId: ownerId,
          });
          await appendDelegationRealtimeEvents(client, {
            delegationId,
            accountWorkspaceId: workspace.id,
            recipientUserIds: [ownerId, assignment.recipientId],
            eventType: 'delegation.assigned',
            aggregateVersion: 1,
            payload: { status: 'assigned', groupId, requesterUserId: ownerId, recipientUserId: assignment.recipientId },
          });
        }
      });
    } catch (error) {
      if (error?.code !== '23505') throw error;
      const raced = await one(pool, 'SELECT id FROM collaboration_groups WHERE account_workspace_id=$1 AND owner_user_id=$2 AND client_request_id=$3', [workspace.id, ownerId, clientRequestId]);
      if (!raced) throw error;
      return res.json({ ok: true, ...(await collaborationGroupDetail(pool, raced.id, ownerId, { accountWorkspaceId: workspace.id })), idempotent: true });
    }
    res.status(201).json({ ok: true, ...(await collaborationGroupDetail(pool, groupId, ownerId, { accountWorkspaceId: workspace.id })) });
  }));

  app.get('/api/collaboration/groups/:groupId', auth, route(async (req, res) => {
    const groupId = String(req.params.groupId || '');
    const { workspace } = await requireCollaborationGroupInRequestWorkspace(pool, req, req.auth.user.id, groupId);
    res.json(await collaborationGroupDetail(pool, groupId, req.auth.user.id, { markRead: true, accountWorkspaceId: workspace.id }));
  }));

  app.put('/api/collaboration/groups/:groupId/message-files/:fileId', auth, express.raw({ type: 'application/octet-stream', limit: '60mb' }), route(async (req, res) => {
    const groupId = String(req.params.groupId || '').trim();
    const fileId = String(req.params.fileId || '').trim().slice(0, 200);
    const { workspace } = await requireCollaborationGroupInRequestWorkspace(pool, req, req.auth.user.id, groupId);
    await requireActiveTaskMembership(pool, groupId, req.auth.user.id, { accountWorkspaceId: workspace.id });
    if (!fileId) throw apiError('group_message_file_id_required', '缺少群聊附件 ID。', 400);
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    if (!data.length) throw apiError('group_message_file_empty', '不能发送空附件。', 400);
    if (data.length > MAX_COLLABORATION_FILE_BYTES) throw apiError('group_message_file_too_large', '群聊附件不能超过 60 MB。', 413);
    const filename = collaborationFilename(req.headers['x-janus-filename']);
    const contentType = String(req.headers['x-janus-content-type'] || 'application/octet-stream').trim().slice(0, 200) || 'application/octet-stream';
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    const claimedSha256 = String(req.headers['x-janus-file-sha256'] || '').trim().toLowerCase();
    if (claimedSha256 && claimedSha256 !== sha256) throw apiError('group_message_file_hash_mismatch', '群聊附件校验失败。', 400);
    const existing = await one(pool, 'SELECT * FROM social_message_files WHERE id = $1', [fileId]);
    if (existing && (existing.account_workspace_id !== workspace.id || existing.owner_user_id !== req.auth.user.id || existing.group_id !== groupId || existing.sha256 !== sha256)) {
      throw apiError('group_message_file_conflict', '群聊附件 ID 已被其他文件占用。', 409);
    }
    await pool.query(
      `INSERT INTO social_message_files (
         id, account_workspace_id, owner_user_id, group_id, filename, content_type, size_bytes, sha256, data, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, decode($9, 'base64'), now())
       ON CONFLICT (id) DO UPDATE SET
         filename = excluded.filename, content_type = excluded.content_type,
         size_bytes = excluded.size_bytes, data = excluded.data, updated_at = now()`,
      [fileId, workspace.id, req.auth.user.id, groupId, filename, contentType, data.length, sha256, data.toString('base64')],
    );
    const stored = await one(pool, 'SELECT * FROM social_message_files WHERE id = $1', [fileId]);
    res.status(existing ? 200 : 201).json({ ok: true, attachment: socialFileAttachment(stored) });
  }));

  app.get('/api/collaboration/groups/:groupId/message-files/:fileId', auth, route(async (req, res) => {
    const groupId = String(req.params.groupId || '').trim();
    const { workspace } = await requireCollaborationGroupInRequestWorkspace(pool, req, req.auth.user.id, groupId);
    await requireActiveTaskMembership(pool, groupId, req.auth.user.id, { allowClosed: true, accountWorkspaceId: workspace.id });
    const requestedFileId = String(req.params.fileId || '').trim();
    const file = await one(pool, 'SELECT * FROM social_message_files WHERE id = $1 AND group_id = $2', [requestedFileId, groupId])
      || await largeFileObjectByScope(pool, requestedFileId, 'collaboration_group', groupId);
    if (!file) throw apiError('group_message_file_not_found', '群聊附件不存在。', 404);
    sendStoredFile(req, res, file, largeFileStorageRoot);
  }));

  app.post('/api/collaboration/groups/:groupId/messages', auth, route(async (req, res) => {
    const groupId = String(req.params.groupId || '');
    const { workspace, group } = await requireCollaborationGroupInRequestWorkspace(pool, req, req.auth.user.id, groupId);
    const membership = await one(pool, 'SELECT * FROM collaboration_group_members WHERE group_id = $1 AND user_id = $2', [groupId, req.auth.user.id]);
    if (!membership || !group) throw apiError('collaboration_group_not_found', '任务群不存在或你已不在群内。', 404);
    if (group.status === 'closed') throw apiError('collaboration_group_closed', '任务群已解散，不能继续发送消息。', 409);
    if (membership.status !== 'active') throw apiError('collaboration_group_not_found', '任务群不存在或你已不在群内。', 404);
    const messageMetadata = publicSocialMessageMetadata(req.body?.metadata);
    await validateGroupMessageAttachments(pool, messageMetadata.attachments, groupId);
    const routingConfirmationFor = String(messageMetadata.routingConfirmationFor || '').trim();
    if (routingConfirmationFor) {
      const original = await one(pool, 'SELECT * FROM collaboration_group_messages WHERE id = $1 AND group_id = $2 AND sender_user_id = $3', [routingConfirmationFor, groupId, req.auth.user.id]);
      if (!original) throw apiError('routing_source_not_found', '原群消息不存在或不能由当前用户确认路由。', 404);
      const routing = await inTransaction(pool, async (client) => routeGroupMessageToPrivateThreads(client, {
        groupId,
        groupMessageId: original.id,
        senderUserId: original.sender_user_id,
        content: original.content,
        metadata: { ...jsonObject(original.metadata_json), delegationId: messageMetadata.delegationId || messageMetadata.taskId },
      }));
      return res.json({ ok: true, routing, needsRoutingConfirmation: routing.needsRoutingConfirmation, ...(await collaborationGroupDetail(pool, groupId, req.auth.user.id, { markRead: true, accountWorkspaceId: workspace.id })) });
    }
    const content = String(req.body?.content || '').trim();
    if (!content) throw apiError('message_required', '请输入消息内容。', 400);
    const senderAgentId = String(req.body?.senderAgentId || '') === 'secretary_agent' ? 'secretary_agent' : '';
    const messageId = String(req.body?.clientMessageId || '').trim().slice(0, 200) || newId('group_msg');
    const sourceEventId = String(req.body?.sourceEventId || messageMetadata.sourceEventId || messageMetadata.source_event_id || '').trim().slice(0, 240);
    const routing = await inTransaction(pool, async (client) => {
      const insertedMessage = await client.query(
        `INSERT INTO collaboration_group_messages (id, account_workspace_id, group_id, sender_user_id, sender_agent_id, kind, content, metadata_json, source_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
         ON CONFLICT DO NOTHING RETURNING id`,
        [messageId, workspace.id, groupId, req.auth.user.id, senderAgentId, normalizeMessageKind(req.body?.kind), content.slice(0, 8000), JSON.stringify(messageMetadata), sourceEventId],
      );
      const persistedMessage=await one(client,'SELECT * FROM collaboration_group_messages WHERE id=$1',[messageId]);
      if(persistedMessage)await recordPostgresCollaborationEvidence(client,{env:config?.env || process.env,ownerUserId:req.auth.user.id,
        sourceKind:'collaboration_message',sourceId:persistedMessage.id,sourceVersionId:persistedMessage.source_event_id || '',content:persistedMessage.content,
        delegationId:String(jsonObject(persistedMessage.metadata_json).delegationId || ''),metadata:{groupId,
          senderAgentId:persistedMessage.sender_agent_id || '',kind:persistedMessage.kind}});
      const result = senderAgentId ? emptyTaskRouting() : await routeGroupMessageToPrivateThreads(client, {
        groupId,
        groupMessageId: messageId,
        senderUserId: req.auth.user.id,
        content,
        metadata: messageMetadata,
      });
      if (!senderAgentId && collaborationMentionRequestsTask(content)) {
        let created = await createCollaborationMentionDelegations(client, {
          workspaceId: workspace.id,
          groupId,
          groupTitle: group.title || '',
          groupMessageId: messageId,
          senderUserId: req.auth.user.id,
          content,
          metadata: messageMetadata,
          recipientUserIds: result.unmatchedMentionedUserIds || [],
        });
        if (!created.length && insertedMessage.rowCount === 0) {
          const replayed = [];
          const mentionedRecipients = normalizeMentionEntities(messageMetadata.mentions, { content, requirePicker: true })
            .filter((mention) => mention.principalType === 'user')
            .map((mention) => mention.userId)
            .filter((userId) => userId && userId !== req.auth.user.id);
          for (const recipientUserId of [...new Set(mentionedRecipients)]) {
            const clientRequestId = `group-mention:${messageId}:${recipientUserId}`.slice(0, 240);
            const existingDelegation = await one(client, `SELECT id,recipient_user_id FROM agent_delegations
              WHERE account_workspace_id=$1 AND requester_user_id=$2 AND group_id=$3 AND client_request_id=$4`, [
              workspace.id, req.auth.user.id, groupId, clientRequestId,
            ]);
            if (existingDelegation?.id) replayed.push({
              delegationId: existingDelegation.id,
              recipientUserId: existingDelegation.recipient_user_id,
              idempotent: true,
            });
          }
          created = replayed;
        }
        if (created.length) {
          result.createdDelegations = created;
          result.routed.push(...created.map((item) => ({ delegationId: item.delegationId, targetUserId: item.recipientUserId })));
          const createdRecipients = new Set(created.map((item) => item.recipientUserId));
          result.unmatchedMentionedUserIds = (result.unmatchedMentionedUserIds || [])
            .filter((userId) => !createdRecipients.has(userId));
        }
      }
      await client.query('UPDATE collaboration_groups SET updated_at = now() WHERE id = $1', [groupId]);
      return result;
    });
    res.status(201).json({ ok: true, routing, needsRoutingConfirmation: routing.needsRoutingConfirmation, ...(await collaborationGroupDetail(pool, groupId, req.auth.user.id, { markRead: true, accountWorkspaceId: workspace.id })) });
  }));

  app.patch('/api/collaboration/groups/:groupId', auth, route(async (req, res) => {
    const groupId = String(req.params.groupId || '');
    const { workspace, group } = await requireCollaborationGroupInRequestWorkspace(pool, req, req.auth.user.id, groupId);
    const action = String(req.body?.action || '').toLowerCase();
    const membership = await one(pool, 'SELECT * FROM collaboration_group_members WHERE group_id=$1 AND user_id=$2', [groupId, req.auth.user.id]);
    if (!group || !membership) throw apiError('collaboration_group_not_found', '任务群不存在或你已不在群内。', 404);
    if (action === 'set_display_name' && membership.status !== 'active') throw apiError('collaboration_group_closed', '任务群已结束，不能修改群内显示名。', 409);
    if (action !== 'set_display_name' && group.owner_user_id !== req.auth.user.id) throw apiError('collaboration_owner_required', '只有任务群发起人可以执行此操作。', 403);
    if (group.status === 'closed' && action !== 'close') throw apiError('collaboration_group_closed', '任务群已解散，不能继续修改。', 409);
    if (group.status === 'closed' && action === 'close') return res.json({ ok: true, ...(await collaborationGroupDetail(pool, groupId, req.auth.user.id, { accountWorkspaceId: workspace.id })), idempotent: true });
    if (action === 'set_display_name') {
      await pool.query(`UPDATE collaboration_group_members SET display_name_override=$1
        WHERE group_id=$2 AND user_id=$3 AND status='active'`, [String(req.body?.displayName || req.body?.display_name || '').trim().slice(0, 80), groupId, req.auth.user.id]);
    } else if (action === 'close') {
      await inTransaction(pool, async (client) => {
        await client.query("UPDATE collaboration_groups SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = $1", [groupId]);
        await client.query("UPDATE collaboration_group_workspaces SET status = 'closed', updated_at = now() WHERE group_id = $1", [groupId]);
        await client.query("UPDATE agent_delegations SET status = 'closed', completed_at = now(), updated_at = now() WHERE group_id = $1", [groupId]);
        await client.query("UPDATE collaboration_group_members SET status = 'closed', left_at = COALESCE(left_at, now()) WHERE group_id = $1 AND status = 'active'", [groupId]);
        await client.query(
          `INSERT INTO collaboration_group_messages (id, account_workspace_id, group_id, sender_user_id, kind, content, metadata_json)
           VALUES ($1, $2, $3, $4, 'system', $5, $6::jsonb)`,
          [newId('group_msg'), workspace.id, groupId, req.auth.user.id, '发起人已解散任务群，协作正式结束。', JSON.stringify({ type: 'group_closed' })],
        );
      });
    } else if (action === 'rename') {
      await pool.query('UPDATE collaboration_groups SET title = $1, updated_at = now() WHERE id = $2', [String(req.body?.title || group.title).trim().slice(0, 80), groupId]);
    } else if (action === 'add_member') {
      const targetId = String(req.body?.userId || '').trim();
      await requireWorkspaceMessagingPeer(pool, workspace, req.auth.user.id, targetId);
      const assignment = jsonObject(req.body?.assignment);
      const instruction = String(assignment.instruction || '').trim().slice(0, 16000);
      if (!instruction) throw apiError('collaboration_assignment_required', '添加成员时必须同时分配具体任务。', 400);
      if (await activeCollaborationMembership(pool, groupId, targetId)) throw apiError('collaboration_member_exists', '该用户已经在任务群中。', 409);
      await inTransaction(pool, async (client) => {
        const lockedGroup = await one(client, 'SELECT * FROM collaboration_groups WHERE id = $1', [groupId]);
        if (lockedGroup?.status === 'closed') throw apiError('collaboration_group_closed', '任务群已解散，不能继续修改。', 409);
        await client.query(
          `INSERT INTO collaboration_group_members (group_id, user_id, role, status, joined_at, left_at)
           VALUES ($1, $2, 'member', 'active', now(), NULL)
           ON CONFLICT(group_id, user_id) DO UPDATE SET status = 'active', joined_at = now(), left_at = NULL`,
          [groupId, targetId],
        );
        const delegationId = newId('agent_delegate');
        const assignmentMetadata = { ...jsonObject(assignment.metadata), groupId, source: 'collaboration_group', initiatedThroughOwnUBuddy: true };
        await client.query(
          `INSERT INTO agent_delegations (
             id, account_workspace_id, requester_user_id, recipient_user_id, sender_agent_id, recipient_agent_id,
             title, instruction, status, group_id, metadata_json
           ) VALUES ($1, $2, $3, $4, 'secretary_agent', 'secretary_agent', $5, $6, 'assigned', $7, $8::jsonb)`,
          [delegationId, workspace.id, req.auth.user.id, targetId, String(assignment.title || `${group.title} · 新任务`).trim().slice(0, 160), instruction, groupId, JSON.stringify(publicDelegationMetadata(assignmentMetadata))],
        );
        const recipientPrivateMetadata = privateDelegationMetadata(assignmentMetadata);
        await client.query(
          `INSERT INTO agent_delegation_workspaces (delegation_id, user_id, metadata_json)
           VALUES ($1, $2, $3::jsonb), ($1, $4, '{}'::jsonb)
           ON CONFLICT (delegation_id, user_id) DO NOTHING`,
          [delegationId, targetId, JSON.stringify(recipientPrivateMetadata), req.auth.user.id],
        );
        const assignmentMessageId = newId('group_msg');
        await client.query(
          `INSERT INTO collaboration_group_messages (id, account_workspace_id, group_id, sender_user_id, sender_agent_id, kind, content, metadata_json)
           VALUES ($1, $2, $3, $4, 'secretary_agent', 'agent', $5, $6::jsonb)`,
          [assignmentMessageId, workspace.id, groupId, req.auth.user.id, instruction, JSON.stringify({ type: 'task_assigned', action: 'add_member', userId: targetId, delegationId })],
        );
        await insertPrivateTaskIngress(client, { delegationId, userId: targetId, content: instruction, type: 'task_assigned', sourceEventId: `task-assigned:${delegationId}`, sourceGroupMessageId: assignmentMessageId, fromUserId: req.auth.user.id });
        await insertPrivateTaskIngress(client, { delegationId, userId: req.auth.user.id, content: instruction, type: 'task_published', sourceEventId: `task-published:${delegationId}`, sourceGroupMessageId: assignmentMessageId, fromUserId: req.auth.user.id });
        await appendDelegationRealtimeEvents(client, {
          delegationId,
          accountWorkspaceId: workspace.id,
          recipientUserIds: [req.auth.user.id, targetId],
          eventType: 'delegation.assigned',
          aggregateVersion: 1,
          payload: { status: 'assigned', groupId, requesterUserId: req.auth.user.id, recipientUserId: targetId },
        });
        await client.query('UPDATE collaboration_groups SET updated_at = now() WHERE id = $1', [groupId]);
      });
    } else if (action === 'remove_member') {
      const targetId = String(req.body?.userId || '').trim();
      if (!targetId || targetId === req.auth.user.id) throw apiError('collaboration_remove_invalid', '不能移除任务群发起人。', 400);
      const activeMember = await activeCollaborationMembership(pool, groupId, targetId);
      if (!activeMember) throw apiError('collaboration_member_not_found', '该用户不是当前任务群成员。', 404);
      await inTransaction(pool, async (client) => {
        await client.query("UPDATE collaboration_group_members SET status = 'removed', left_at = now() WHERE group_id = $1 AND user_id = $2 AND status = 'active'", [groupId, targetId]);
        await client.query("UPDATE agent_delegations SET status = 'withdrawn', updated_at = now() WHERE group_id = $1 AND recipient_user_id = $2 AND status <> 'closed'", [groupId, targetId]);
        await client.query(
          `INSERT INTO collaboration_group_messages (id, account_workspace_id, group_id, sender_user_id, kind, content, metadata_json)
           VALUES ($1, $2, $3, $4, 'system', $5, $6::jsonb)`,
          [newId('group_msg'), workspace.id, groupId, req.auth.user.id, '发起人移除了一位群成员，其未完成任务已撤回。', JSON.stringify({ type: 'member_removed', userId: targetId })],
        );
      });
    } else {
      throw apiError('collaboration_action_invalid', '不支持的任务群操作。', 400);
    }
    await pool.query('UPDATE collaboration_groups SET updated_at = now() WHERE id = $1', [groupId]);
    res.json({ ok: true, ...(await collaborationGroupDetail(pool, groupId, req.auth.user.id, { accountWorkspaceId: workspace.id })) });
  }));

  app.post('/api/collaboration/tasks/:delegationId/action', auth, route(async (req, res) => {
    const delegationId = String(req.params.delegationId || '');
    const workspace = await requireAccountWorkspaceAccess(pool, req.auth.user.id, requestAccountWorkspaceId(req));
    const delegation = await requireDelegationParticipant(pool, delegationId, req.auth.user.id, workspace.id);
    const group = delegation.group_id ? await one(pool, 'SELECT * FROM collaboration_groups WHERE id=$1 AND account_workspace_id=$2', [delegation.group_id, workspace.id]) : null;
    if (group?.status === 'closed') throw apiError('collaboration_group_closed', '任务群已结束。', 409);
    if (delegation.group_id) await requireActiveTaskMembership(pool, delegation.group_id, req.auth.user.id, { accountWorkspaceId: workspace.id });
    const action = String(req.body?.action || '').toLowerCase();
    const expectedStatus = String(req.body?.expectedStatus || '').trim();
    const recipientActions = ['working', 'submit', 'decline', 'blocked'];
    const requesterActions = ['accept_result', 'request_revision', 'publish', 'update_requirements'];
    if (action === 'accept_result' && delegation.status === 'result_accepted') {
      if (req.auth.user.id !== delegation.requester_user_id) throw apiError('delegation_update_forbidden', '只有发起人可以验收结果。', 403);
      return res.json({ ok: true, idempotent: true, delegation: await hydratedDelegation(pool, delegationId, req.auth.user.id), ...(delegation.group_id ? await collaborationGroupDetail(pool, delegation.group_id, req.auth.user.id, { accountWorkspaceId: workspace.id }) : {}) });
    }
    if (expectedStatus && expectedStatus !== delegation.status) {
      throw apiError('delegation_status_conflict', '任务状态已经更新，请刷新后重试。', 409, { expectedStatus, actualStatus: delegation.status });
    }
    if (recipientActions.includes(action) && req.auth.user.id !== delegation.recipient_user_id) throw apiError('delegation_update_forbidden', '只有接收人可以执行此操作。', 403);
    if (requesterActions.includes(action) && req.auth.user.id !== delegation.requester_user_id) throw apiError('delegation_update_forbidden', '只有发起人可以验收结果。', 403);
    const rawActionMetadata = jsonObject(req.body?.metadata);
    const sourceWorkspaceMessageId = String(rawActionMetadata.sourceWorkspaceMessageId || '').trim();
    if (sourceWorkspaceMessageId && ['submit', 'publish', 'update_requirements'].includes(action)) {
      const duplicate = await one(pool, `SELECT id FROM agent_delegation_revisions
        WHERE delegation_id = $1 AND action = $2 AND metadata_json->>'sourceWorkspaceMessageId' = $3 LIMIT 1`, [delegationId, action, sourceWorkspaceMessageId]);
      if (duplicate) return res.json({ ok: true, idempotent: true, delegation: await hydratedDelegation(pool, delegationId, req.auth.user.id), ...(delegation.group_id ? await collaborationGroupDetail(pool, delegation.group_id, req.auth.user.id, { accountWorkspaceId: workspace.id }) : {}) });
    }
    const status = nextDelegationStatus(delegation.status, action);
    if (!status) throw apiError('delegation_action_invalid', '不支持的任务操作。', 400);
    if (!delegationTransitionAllowed(delegation.status, action)) throw apiError('delegation_transition_invalid', `当前状态 ${delegation.status} 不能执行 ${action}。`, 409);
    const rawContent = String(req.body?.content || '').trim();
    const content = ['submit', 'publish', 'update_requirements'].includes(action) ? publicDelegationSubmissionText(rawContent) : rawContent;
    if (['submit', 'request_revision', 'publish', 'update_requirements'].includes(action) && !content) throw apiError('delegation_content_required', '请填写需要同步的任务内容。', 400);
    let transactionIdempotent = false;
    try {
      await inTransaction(pool, async (client) => {
        const locked = await one(client, 'SELECT * FROM agent_delegations WHERE id = $1 FOR UPDATE', [delegationId]);
        if (sourceWorkspaceMessageId && ['submit', 'publish', 'update_requirements'].includes(action)) {
          const duplicate = await one(client, `SELECT id FROM agent_delegation_revisions
            WHERE delegation_id = $1 AND action = $2 AND metadata_json->>'sourceWorkspaceMessageId' = $3 LIMIT 1`, [delegationId, action, sourceWorkspaceMessageId]);
          if (duplicate) return;
        }
        if (action === 'accept_result' && locked?.status === 'result_accepted') {
          transactionIdempotent = true;
          return;
        }
        if (!locked || locked.status !== delegation.status) throw apiError('delegation_status_conflict', '任务状态已经更新，请刷新后重试。', 409, { expectedStatus: delegation.status, actualStatus: locked?.status || '' });
        const actionMetadata = ['submit', 'publish', 'update_requirements'].includes(action)
          ? {
              ...rawActionMetadata,
              attachments: await canonicalCollaborationTaskAttachments(client, delegation, rawActionMetadata.attachments, workspace.id),
            }
          : rawActionMetadata;
        const currentMetadata = jsonObject(delegation.metadata_json);
        const incomingActionMetadata = publicTaskActionMetadata(actionMetadata, action);
        const mergedActionMetadata = publicDelegationMetadata({ ...currentMetadata, ...incomingActionMetadata, latestResult: action === 'submit' ? content : currentMetadata.latestResult });
        const metadata = action === 'submit' ? publicTaskActionMetadata(mergedActionMetadata, action) : mergedActionMetadata;
        await client.query(
          `UPDATE agent_delegations SET status = $1,
             instruction = CASE WHEN $4 IN ('publish','update_requirements') THEN $5 ELSE instruction END,
             metadata_json = $2::jsonb, updated_at = now(),
             completed_at = CASE WHEN $1 = 'closed' THEN now() ELSE NULL END WHERE id = $3`,
          [status, JSON.stringify(metadata), delegationId, action, content.slice(0, 16000)],
        );
        const revisionRow = await one(client, 'SELECT COALESCE(MAX(revision_no), 0) AS revision_no FROM agent_delegation_revisions WHERE delegation_id = $1', [delegationId]);
        const revisionNo = Number(revisionRow?.revision_no || 0) + 1;
        const revisionId=newId('task_revision');
        await client.query(
          `INSERT INTO agent_delegation_revisions (id, delegation_id, author_user_id, revision_no, action, content, metadata_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [revisionId,delegationId,req.auth.user.id,revisionNo,action,content.slice(0,16000),JSON.stringify(incomingActionMetadata)],
        );
        await recordPostgresCollaborationEvidence(client,{env:config?.env || process.env,ownerUserId:req.auth.user.id,
          sourceKind:'delegation_event',sourceId:delegationId,sourceVersionId:revisionId,
          content:content || JSON.stringify({action,status,revisionNo}),delegationId,
          metadata:{action,status,revisionNo,groupId:delegation.group_id || ''}});
        let groupMessageId = '';
        if (delegation.group_id) {
          const labels = { submit: '提交了任务结果', accept_result: '接受了任务结果', request_revision: '提出了修改要求', publish: '确认并发布了任务要求', update_requirements: '更新了任务要求', decline: '拒绝了任务', blocked: '将任务标记为受阻', working: '开始处理任务' };
          groupMessageId = newId('group_msg');
          await client.query(
            `INSERT INTO collaboration_group_messages (id, account_workspace_id, group_id, sender_user_id, sender_agent_id, kind, content, metadata_json, source_event_id)
             VALUES ($1, $2, $3, $4, $5, 'agent', $6, $7::jsonb, $8)
             ON CONFLICT DO NOTHING`,
            [groupMessageId, workspace.id, delegation.group_id, req.auth.user.id, ['submit', 'publish', 'update_requirements'].includes(action) ? 'secretary_agent' : '', content || labels[action], JSON.stringify({ type: 'task_action', action, delegationId, status, revisionNo, attachments: metadata.attachments || [] }), `delegation-milestone:${delegationId}:${revisionNo}:${action}`],
          );
          await client.query('UPDATE collaboration_groups SET updated_at = now() WHERE id = $1', [delegation.group_id]);
        } else if (['publish', 'update_requirements'].includes(action)) {
          await client.query(
            `INSERT INTO social_messages (
               id, account_workspace_id, sender_user_id, recipient_user_id, sender_agent_id, recipient_agent_id,
               kind, title, content, metadata_json
             ) VALUES ($1, $2, $3, $4, 'secretary_agent', 'secretary_agent', 'agent', $5, $6, $7::jsonb)`,
            [newId('social_msg'), workspace.id, delegation.requester_user_id, delegation.recipient_user_id, action === 'publish' ? `uBuddy 已发布委托：${delegation.title}` : `uBuddy 已更新委托要求：${delegation.title}`, content.slice(0, 8000), JSON.stringify({ type: 'agent_delegation', action, delegationId, status, revisionNo })],
          );
        }
        const ingressTargetUserId = ['publish', 'update_requirements', 'request_revision', 'accept_result'].includes(action)
          ? delegation.recipient_user_id
          : action === 'submit' ? delegation.requester_user_id : '';
        if (ingressTargetUserId) {
          await insertPrivateTaskIngress(client, {
            delegationId,
            userId: ingressTargetUserId,
            content: content || `任务状态已更新：${action}`,
            type: action === 'submit' ? 'result_submitted' : action === 'request_revision' ? 'revision_requested' : action === 'accept_result' ? 'result_accepted' : 'requirements_update',
            sourceEventId: `task-action:${delegationId}:${revisionNo}:${action}`,
            sourceGroupMessageId: groupMessageId,
            fromUserId: req.auth.user.id,
            metadata: { action, revisionNo, status, attachments: metadata.attachments || [] },
          });
        }
        await appendDelegationRealtimeEvents(client, {
          delegationId,
          accountWorkspaceId: workspace.id,
          recipientUserIds: [delegation.requester_user_id, delegation.recipient_user_id],
          eventType: `delegation.${action}`,
          aggregateVersion: revisionNo,
          payload: { action, status, revisionNo },
        });
      });
    } catch (error) {
      const current = action === 'accept_result'
        ? await one(pool, 'SELECT status FROM agent_delegations WHERE id = $1', [delegationId])
        : null;
      if (current?.status !== 'result_accepted') throw error;
      transactionIdempotent = true;
    }
    res.json({ ok: true, ...(transactionIdempotent ? { idempotent: true } : {}), delegation: await hydratedDelegation(pool, delegationId, req.auth.user.id), ...(delegation.group_id ? await collaborationGroupDetail(pool, delegation.group_id, req.auth.user.id, { accountWorkspaceId: workspace.id }) : {}) });
  }));

  app.get('/api/collaboration/groups/:groupId/workspace', auth, route(async (req, res) => {
    const groupId = String(req.params.groupId || '').trim();
    const { workspace: accountWorkspace, group } = await requireCollaborationGroupInRequestWorkspace(pool, req, req.auth.user.id, groupId);
    const membership = await requireActiveTaskMembership(pool, groupId, req.auth.user.id, { allowClosed: true, accountWorkspaceId: accountWorkspace.id });
    const workspace = await ensureCollaborationGroupWorkspace(pool, groupId, { ownerUserId: group.owner_user_id || '', status: group.status || '' });
    const sinceRevision = Math.max(0, Number(req.query?.sinceRevision || 0));
    const files = await many(
      pool,
      `SELECT * FROM collaboration_group_workspace_files
       WHERE group_id = $1 AND revision > $2 ORDER BY revision ASC, relative_path ASC LIMIT 5000`,
      [groupId, sinceRevision],
    );
    res.json({
      workspace: collaborationGroupWorkspacePayload(workspace, { readOnly: group?.status === 'closed' || membership.status !== 'active' }),
      files: files.map(collaborationGroupWorkspaceFilePayload),
    });
  }));

  app.put('/api/collaboration/groups/:groupId/workspace/files/:fileId', auth, express.raw({ type: 'application/octet-stream', limit: '60mb' }), route(async (req, res) => {
    const groupId = String(req.params.groupId || '').trim();
    const fileId = String(req.params.fileId || '').trim().slice(0, 200);
    const { workspace: accountWorkspace } = await requireCollaborationGroupInRequestWorkspace(pool, req, req.auth.user.id, groupId);
    await requireActiveTaskMembership(pool, groupId, req.auth.user.id, { accountWorkspaceId: accountWorkspace.id });
    if (!fileId) throw apiError('collaboration_workspace_file_id_required', '缺少共享工作区文件 ID。', 400);
    const relativePath = collaborationGroupWorkspaceRelativePath(req.headers['x-janus-relative-path']);
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    if (data.length > MAX_COLLABORATION_FILE_BYTES) throw apiError('collaboration_workspace_file_too_large', '共享工作区文件不能超过 60 MB。', 413);
    const filename = collaborationFilename(req.headers['x-janus-filename'] || relativePath.split('/').at(-1));
    const contentType = String(req.headers['x-janus-content-type'] || 'application/octet-stream').trim().slice(0, 200) || 'application/octet-stream';
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    const claimedSha256 = String(req.headers['x-janus-file-sha256'] || '').trim().toLowerCase();
    if (claimedSha256 && claimedSha256 !== sha256) throw apiError('collaboration_workspace_file_hash_mismatch', '共享工作区文件校验失败。', 400);
    const baseRevision = Math.max(0, Number(req.headers['x-janus-base-revision'] || 0));
    const stored = await inTransaction(pool, async (client) => {
      const workspace = await ensureCollaborationGroupWorkspace(client, groupId);
      const current = await one(client, 'SELECT * FROM collaboration_group_workspace_files WHERE group_id = $1 AND relative_path = $2 FOR UPDATE', [groupId, relativePath]);
      const currentRevision = Math.max(0, Number(current?.revision || 0));
      if (baseRevision !== currentRevision) {
        throw apiError('collaboration_workspace_file_conflict', '共享工作区文件已被其他成员更新。', 409, {
          relativePath,
          expectedRevision: baseRevision,
          current: current ? collaborationGroupWorkspaceFilePayload(current) : null,
        });
      }
      const nextRevision = Math.max(0, Number(workspace.revision || 0)) + 1;
      await client.query(
        `UPDATE collaboration_group_workspaces SET revision = $1, status = 'active', updated_at = now() WHERE group_id = $2`,
        [nextRevision, groupId],
      );
      await client.query(
        `INSERT INTO collaboration_group_workspace_files (
           id, group_id, relative_path, revision, owner_user_id, filename,
           content_type, size_bytes, sha256, data, deleted, updated_at
	         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, decode($10, 'base64'), false, now())
         ON CONFLICT (group_id, relative_path) DO UPDATE SET
           id = excluded.id, revision = excluded.revision, owner_user_id = excluded.owner_user_id,
           filename = excluded.filename, content_type = excluded.content_type,
           size_bytes = excluded.size_bytes, sha256 = excluded.sha256,
           data = excluded.data, deleted = false, updated_at = now()`,
	        [fileId, groupId, relativePath, nextRevision, req.auth.user.id, filename, contentType, data.length, sha256, data.toString('base64')],
      );
      return one(client, 'SELECT * FROM collaboration_group_workspace_files WHERE group_id = $1 AND relative_path = $2', [groupId, relativePath]);
    });
    res.status(baseRevision ? 200 : 201).json({ ok: true, file: collaborationGroupWorkspaceFilePayload(stored) });
  }));

  app.delete('/api/collaboration/groups/:groupId/workspace/files/:fileId', auth, route(async (req, res) => {
    const groupId = String(req.params.groupId || '').trim();
    const fileId = String(req.params.fileId || '').trim();
    const { workspace: accountWorkspace } = await requireCollaborationGroupInRequestWorkspace(pool, req, req.auth.user.id, groupId);
    await requireActiveTaskMembership(pool, groupId, req.auth.user.id, { accountWorkspaceId: accountWorkspace.id });
    const baseRevision = Math.max(0, Number(req.query?.baseRevision || 0));
    const stored = await inTransaction(pool, async (client) => {
      const workspace = await ensureCollaborationGroupWorkspace(client, groupId);
      const current = await one(client, 'SELECT * FROM collaboration_group_workspace_files WHERE group_id = $1 AND id = $2 FOR UPDATE', [groupId, fileId]);
      if (!current) throw apiError('collaboration_workspace_file_not_found', '共享工作区文件不存在。', 404);
      const currentRevision = Math.max(0, Number(current.revision || 0));
      if (baseRevision !== currentRevision) {
        throw apiError('collaboration_workspace_file_conflict', '共享工作区文件已被其他成员更新。', 409, {
          relativePath: current.relative_path,
          expectedRevision: baseRevision,
          current: collaborationGroupWorkspaceFilePayload(current),
        });
      }
      const nextRevision = Math.max(0, Number(workspace.revision || 0)) + 1;
      await client.query('UPDATE collaboration_group_workspaces SET revision = $1, updated_at = now() WHERE group_id = $2', [nextRevision, groupId]);
      await client.query(
        `UPDATE collaboration_group_workspace_files
         SET revision = $1, owner_user_id = $2, data = ''::bytea, size_bytes = 0, sha256 = '', deleted = true, updated_at = now()
         WHERE group_id = $3 AND id = $4`,
        [nextRevision, req.auth.user.id, groupId, fileId],
      );
      return one(client, 'SELECT * FROM collaboration_group_workspace_files WHERE group_id = $1 AND id = $2', [groupId, fileId]);
    });
    res.json({ ok: true, file: collaborationGroupWorkspaceFilePayload(stored) });
  }));

  app.get('/api/collaboration/groups/:groupId/workspace/files/:fileId', auth, route(async (req, res) => {
    const groupId = String(req.params.groupId || '').trim();
    const fileId = String(req.params.fileId || '').trim();
    const { workspace: accountWorkspace } = await requireCollaborationGroupInRequestWorkspace(pool, req, req.auth.user.id, groupId);
    await requireActiveTaskMembership(pool, groupId, req.auth.user.id, { allowClosed: true, accountWorkspaceId: accountWorkspace.id });
    const file = await one(pool, 'SELECT * FROM collaboration_group_workspace_files WHERE group_id = $1 AND id = $2 AND deleted = false', [groupId, fileId]);
    if (!file) throw apiError('collaboration_workspace_file_not_found', '共享工作区文件不存在。', 404);
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data || '');
    res.setHeader('content-type', file.content_type || 'application/octet-stream');
    res.setHeader('content-length', String(data.length));
    res.setHeader('content-disposition', collaborationContentDisposition(file.filename));
    res.setHeader('x-janus-file-sha256', file.sha256 || '');
    res.send(data);
  }));

  app.put('/api/collaboration/tasks/:delegationId/files/:fileId', auth, express.raw({ type: 'application/octet-stream', limit: '60mb' }), route(async (req, res) => {
    const delegationId = String(req.params.delegationId || '').trim();
    const fileId = String(req.params.fileId || '').trim().slice(0, 200);
    const accountWorkspace = await requireAccountWorkspaceAccess(pool, req.auth.user.id, requestAccountWorkspaceId(req));
    const delegation = await requireDelegationParticipant(pool, delegationId, req.auth.user.id, accountWorkspace.id);
    const groupId = String(delegation.group_id || '').trim();
    if (groupId) await requireActiveTaskMembership(pool, groupId, req.auth.user.id, { accountWorkspaceId: accountWorkspace.id });
    else requireDirectDelegationFilesCapability(req);
    if (!fileId) throw apiError('collaboration_file_id_required', '缺少任务附件 ID。', 400);
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    if (!data.length) throw apiError('collaboration_file_empty', '不能提交空文件。', 400);
    if (data.length > MAX_COLLABORATION_FILE_BYTES) throw apiError('collaboration_file_too_large', '任务附件不能超过 60 MB。', 413);
    const filename = collaborationFilename(req.headers['x-janus-filename']);
    const contentType = String(req.headers['x-janus-content-type'] || 'application/octet-stream').trim().slice(0, 200) || 'application/octet-stream';
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    const claimedSha256 = String(req.headers['x-janus-file-sha256'] || '').trim().toLowerCase();
    if (claimedSha256 && claimedSha256 !== sha256) throw apiError('collaboration_file_hash_mismatch', '任务附件校验失败。', 400);
    const existing = await one(pool, 'SELECT * FROM collaboration_files WHERE id = $1', [fileId]);
    if (existing && (existing.delegation_id !== delegationId || existing.owner_user_id !== req.auth.user.id || existing.sha256 !== sha256)) {
      throw apiError('collaboration_file_conflict', '任务附件 ID 已被其他文件占用。', 409);
    }
    await pool.query(
      `INSERT INTO collaboration_files (
         id, delegation_id, group_id, owner_user_id, filename, content_type, size_bytes, sha256, data, updated_at
	       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, decode($9, 'base64'), now())
       ON CONFLICT (id) DO UPDATE SET
         filename = excluded.filename, content_type = excluded.content_type,
         size_bytes = excluded.size_bytes, data = excluded.data, updated_at = now()`,
	      [fileId, delegationId, groupId || null, req.auth.user.id, filename, contentType, data.length, sha256, data.toString('base64')],
    );
    const stored = await one(pool, 'SELECT * FROM collaboration_files WHERE id = $1', [fileId]);
    res.status(existing ? 200 : 201).json({ ok: true, attachment: collaborationFileAttachment(stored) });
  }));

  app.get('/api/collaboration/files/:fileId', auth, route(async (req, res) => {
    const fileId = String(req.params.fileId || '').trim();
    const file = await one(pool, 'SELECT * FROM collaboration_files WHERE id = $1', [fileId])
      || await one(pool, "SELECT * FROM large_file_objects WHERE id=$1 AND scope_kind='collaboration_task' AND status='ready'", [fileId]);
    if (!file) throw apiError('collaboration_file_not_found', '任务附件不存在。', 404);
    if (file.group_id) {
      const { workspace: accountWorkspace } = await requireCollaborationGroupInRequestWorkspace(pool, req, req.auth.user.id, file.group_id);
      const membership = await one(pool, `SELECT status FROM collaboration_group_members
        WHERE group_id = $1 AND user_id = $2 AND status IN ('active', 'closed')`, [file.group_id, req.auth.user.id]);
      if (!membership) throw apiError('collaboration_file_forbidden', '无权下载该任务附件。', 403);
      await requireActiveTaskMembership(pool, file.group_id, req.auth.user.id, { allowClosed: true, accountWorkspaceId: accountWorkspace.id });
    } else {
      const workspace = await requireAccountWorkspaceAccess(pool, req.auth.user.id, requestAccountWorkspaceId(req));
      const delegationId = String(file.delegation_id || (file.scope_kind === 'collaboration_task' ? file.scope_id : '') || '').trim();
      const delegation = delegationId ? await one(pool, 'SELECT * FROM agent_delegations WHERE id=$1 AND account_workspace_id=$2', [delegationId, workspace.id]) : null;
      if (!delegation || ![delegation.requester_user_id, delegation.recipient_user_id].includes(req.auth.user.id)) {
        throw apiError('collaboration_file_forbidden', '无权下载该任务附件。', 403);
      }
    }
    sendStoredFile(req, res, file, largeFileStorageRoot);
  }));

  app.post('/api/presence/heartbeat', auth, route(async (req, res) => {
    const deviceId = String(req.body.deviceId || '').trim();
    if (!deviceId) throw apiError('device_id_required', '缺少设备 ID。', 400);
    await pool.query(
      `INSERT INTO user_presence (user_id, device_id, platform, arch, hostname, status, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, 'online', now())
       ON CONFLICT(user_id, device_id) DO UPDATE SET
         platform = excluded.platform, arch = excluded.arch, hostname = excluded.hostname,
         status = 'online', last_seen_at = now()`,
      [req.auth.user.id, deviceId, String(req.body.platform || ''), String(req.body.arch || ''), String(req.body.hostname || '')],
    );
    res.json({ ok: true, onlineUntil: new Date(Date.now() + 45_000).toISOString() });
  }));

  app.get('/api/sessions', auth, route(async (req, res) => {
    const workspace = await requireAccountWorkspaceAccess(pool, req.auth.user.id, requestAccountWorkspaceId(req));
    const limit = Math.max(1, Math.min(200, Number(req.query?.limit || 80)));
    const includeArchived = String(req.query?.includeArchived || '').toLowerCase() === 'true';
    const statusFilter = includeArchived ? "status <> 'deleted'" : "status <> 'deleted' AND status <> 'archived'";
    const rows = await many(
      pool,
      `SELECT *
       FROM chat_sessions
       WHERE user_id = $1 AND account_workspace_id=$2 AND ${statusFilter}
       ORDER BY
         CASE WHEN pinned_at IS NULL THEN 1 ELSE 0 END,
         pinned_at DESC NULLS LAST,
         updated_at DESC
       LIMIT $3`,
      [req.auth.user.id, workspace.id, limit],
    );
    res.json({ items: rows.map(sessionPayload) });
  }));

  app.put('/api/sessions/:sessionId', auth, route(async (req, res) => {
    const sessionId = normalizeSessionId(req.params.sessionId);
    const workspace = await requireAccountWorkspaceAccess(pool, req.auth.user.id, requestAccountWorkspaceId(req));
    const patch = normalizeSessionPatch(req.body || {}, { allowMissingTitle: false });
    const row = await inTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO chat_sessions (
          id, account_workspace_id, user_id, title, department_id, agent_id, codex_thread_id, status, pinned_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::timestamptz, now()), COALESCE($11::timestamptz, now()))
         ON CONFLICT (id) DO UPDATE SET
          title = excluded.title,
          department_id = excluded.department_id,
          agent_id = excluded.agent_id,
          codex_thread_id = excluded.codex_thread_id,
          status = excluded.status,
          pinned_at = excluded.pinned_at,
          updated_at = excluded.updated_at
         WHERE chat_sessions.user_id = $3 AND chat_sessions.account_workspace_id=$2`,
        [
          sessionId,
          workspace.id,
          req.auth.user.id,
          patch.title,
          patch.departmentId,
          patch.agentId,
          patch.codexThreadId,
          patch.status,
          patch.pinnedAt,
          patch.createdAt,
          patch.updatedAt,
        ],
      );
      return one(client, 'SELECT * FROM chat_sessions WHERE id=$1 AND account_workspace_id=$2 AND user_id=$3', [sessionId, workspace.id, req.auth.user.id]);
    });
    if (!row) throw apiError('forbidden', '无权同步该会话。', 403);
    res.json({ session: sessionPayload(row) });
  }));

  app.patch('/api/sessions/:sessionId', auth, route(async (req, res) => {
    const sessionId = normalizeSessionId(req.params.sessionId);
    const workspace = await requireAccountWorkspaceAccess(pool, req.auth.user.id, requestAccountWorkspaceId(req));
    const existing = await one(pool, 'SELECT * FROM chat_sessions WHERE id=$1 AND account_workspace_id=$2 AND user_id=$3', [sessionId, workspace.id, req.auth.user.id]);
    if (!existing) throw apiError('session_not_found', '会话不存在。', 404);
    const patch = normalizeSessionPatch(req.body || {}, { base: existing, partial: true });
    const row = await inTransaction(pool, async (client) => {
      await client.query(
        `UPDATE chat_sessions
         SET title = $1,
             department_id = $2,
             agent_id = $3,
             codex_thread_id = $4,
             status = $5,
             pinned_at = $6,
             updated_at = now()
         WHERE id = $7 AND user_id = $8 AND account_workspace_id=$9`,
        [
          patch.title,
          patch.departmentId,
          patch.agentId,
          patch.codexThreadId,
          patch.status,
          patch.pinnedAt,
          sessionId,
          req.auth.user.id,
          workspace.id,
        ],
      );
      return one(client, 'SELECT * FROM chat_sessions WHERE id=$1 AND account_workspace_id=$2 AND user_id=$3', [sessionId, workspace.id, req.auth.user.id]);
    });
    res.json({ session: sessionPayload(row) });
  }));

  app.use(network.notFound);
  app.use(network.errorHandler);

  return app;
}

function latestPublishedRelease({ home, channel = 'dev', platform = '', arch = '', kind = '' } = {}) {
  const database = path.join(home, 'cloud.db');
  if (!fs.existsSync(database)) return null;
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const rows = db.prepare(
      `SELECT * FROM release_manifests
       WHERE channel = ?
         AND (? = '' OR platform = ? OR platform = 'any')
         AND (? = '' OR arch = ? OR arch = 'any')
       ORDER BY created_at DESC LIMIT 100`,
    ).all(String(channel || 'dev'), String(platform || ''), String(platform || ''), String(arch || ''), String(arch || ''));
    const row = kind
      ? rows.find((item) => releaseManifest(item).artifacts?.some((artifact) => artifact.kind === kind))
      : rows[0];
    if (!row) return null;
    return {
      status: 'ok',
      channel: row.channel,
      version: row.version,
      platform: row.platform,
      arch: row.arch,
      manifest: releaseManifest(row),
      createdAt: row.created_at,
    };
  } finally {
    db.close();
  }
}

function releaseManifest(row = {}) {
  try {
    return JSON.parse(row.manifest_json || '{}');
  } catch {
    return {};
  }
}

function socialFileAttachment(row = {}) {
  return {
    ...collaborationFileAttachment(row),
    account_workspace_id: row.account_workspace_id || 'workspace_personal',
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    remote_file_kind: row.group_id ? 'collaboration_group' : 'social',
    group_id: row.group_id || '',
  };
}

function largeFileAttachment(row = {}) {
  const remoteFileKind = row.scope_kind === 'chat_group'
    ? 'chat_group'
    : row.scope_kind === 'collaboration_group'
      ? 'collaboration_group'
      : row.scope_kind === 'collaboration_task'
        ? 'collaboration_task'
        : 'social';
  return {
    ...collaborationFileAttachment(row),
    account_workspace_id: row.account_workspace_id || 'workspace_personal',
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    remote_file_kind: remoteFileKind,
    group_id: row.group_id || (['chat_group', 'collaboration_group'].includes(row.scope_kind) ? row.scope_id : ''),
    delegation_id: row.delegation_id || (row.scope_kind === 'collaboration_task' ? row.scope_id : ''),
    resumable: true,
  };
}

function sendStoredFile(req, res, file = {}, storageRoot = '') {
  if (file.storage_key) return sendLargeStoredFile(req, res, file, storageRoot);
  const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data || '');
  res.setHeader('content-type', file.content_type || 'application/octet-stream');
  res.setHeader('content-length', String(data.length));
  res.setHeader('content-disposition', collaborationContentDisposition(file.filename));
  res.setHeader('x-janus-file-sha256', file.sha256 || '');
  res.setHeader('accept-ranges', 'bytes');
  const range = parseFileRange(req.headers?.range, data.length);
  if (range?.invalid) {
    res.status(416).setHeader('content-range', `bytes */${data.length}`);
    return res.end();
  }
  if (range) {
    res.status(206);
    res.setHeader('content-range', `bytes ${range.start}-${range.end}/${data.length}`);
    res.setHeader('content-length', String(range.end - range.start + 1));
    return res.send(data.subarray(range.start, range.end + 1));
  }
  res.send(data);
}

function ensureLargeFileStorage(storageRoot = '', { explicitlyConfigured = false } = {}) {
  const root = path.resolve(String(storageRoot || ''));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK);
  const probe = path.join(root, `.janus-storage-probe-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, 'ok', { flag: 'wx', mode: 0o600 });
    const descriptor = fs.openSync(probe, 'r+');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  } finally {
    fs.rmSync(probe, { force: true });
  }
  return { ok: true, writable: true, explicitlyConfigured };
}

function sendLargeStoredFile(req, res, file = {}, storageRoot = '') {
  const target = safeLargeFileStoragePath(storageRoot, file.storage_key);
  if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw apiError('large_file_object_unavailable', '附件文件暂不可用，请联系管理员检查云端文件存储。', 503);
  }
  const size = fs.statSync(target).size;
  if (size !== Number(file.size_bytes)) throw apiError('large_file_object_size_mismatch', '附件文件校验失败。', 503);
  const range = parseFileRange(req.headers?.range, size);
  res.setHeader('content-type', file.content_type || 'application/octet-stream');
  res.setHeader('content-disposition', collaborationContentDisposition(file.filename));
  res.setHeader('x-janus-file-sha256', file.sha256 || '');
  res.setHeader('accept-ranges', 'bytes');
  if (range?.invalid) {
    res.status(416).setHeader('content-range', `bytes */${size}`);
    return res.end();
  }
  const start = range?.start || 0;
  const end = range?.end ?? size - 1;
  if (range) {
    res.status(206);
    res.setHeader('content-range', `bytes ${start}-${end}/${size}`);
  }
  res.setHeader('content-length', String(end - start + 1));
  const stream = fs.createReadStream(target, { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function parseFileRange(value = '', size = 0) {
  const header = String(value || '').trim();
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size <= 0) return { invalid: true };
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return { invalid: true };
  return { start, end: Math.min(end, size - 1) };
}

function normalizeLargeFileScopeKind(value = '') {
  const clean = String(value || '').trim();
  if (!['social', 'chat_group', 'collaboration_group', 'collaboration_task'].includes(clean)) {
    throw apiError('large_file_scope_invalid', '不支持的大文件会话范围。', 400);
  }
  return clean;
}

function normalizeLargeFileSha256(value = '') {
  const clean = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(clean) ? clean : '';
}

async function authorizeLargeFileScope(db, req, { scopeKind = '', scopeId = '' } = {}) {
  const ownerUserId = req.auth.user.id;
  if (scopeKind === 'social') {
    const workspace = await requireAccountWorkspaceAccess(db, ownerUserId, requestAccountWorkspaceId(req));
    await requireContactChatPeer(db, workspace, ownerUserId, scopeId);
    return { accountWorkspaceId: workspace.id, recipientUserId: scopeId };
  }
  if (scopeKind === 'chat_group') {
    const workspace = await requireAccountWorkspaceAccess(db, ownerUserId, requestAccountWorkspaceId(req));
    const { group, membership } = await requireNaturalChatGroupMember(db, scopeId, ownerUserId, workspace.id, { accountGlobal: true });
    if (group.status !== 'active' || membership.status !== 'active') throw apiError('chat_group_readonly', '群聊已结束，不能发送附件。', 409);
    return { accountWorkspaceId: group.account_workspace_id, groupId: scopeId };
  }
  if (scopeKind === 'collaboration_group') {
    const { workspace } = await requireCollaborationGroupInRequestWorkspace(db, req, ownerUserId, scopeId);
    await requireActiveTaskMembership(db, scopeId, ownerUserId, { accountWorkspaceId: workspace.id });
    return { accountWorkspaceId: workspace.id, groupId: scopeId };
  }
  const workspace = await requireAccountWorkspaceAccess(db, ownerUserId, requestAccountWorkspaceId(req));
  const delegation = await requireDelegationParticipant(db, scopeId, ownerUserId, workspace.id);
  const groupId = String(delegation.group_id || '').trim();
  if (groupId) await requireActiveTaskMembership(db, groupId, ownerUserId, { accountWorkspaceId: workspace.id });
  else requireDirectDelegationFilesCapability(req);
  return { accountWorkspaceId: workspace.id, groupId: groupId || undefined, delegationId: scopeId };
}

async function canonicalCollaborationTaskAttachments(db, delegation = {}, attachments = [], accountWorkspaceId = '') {
  const groupId = String(delegation.group_id || '').trim();
  const canonical = [];
  for (const attachment of Array.isArray(attachments) ? attachments.slice(0, 20) : []) {
    const remoteFileId = String(attachment?.remote_file_id || attachment?.remoteFileId || '').trim();
    const remoteFileKind = String(attachment?.remote_file_kind || attachment?.remoteFileKind || '').trim();
    if (!remoteFileId || (remoteFileKind && remoteFileKind !== 'collaboration_task')) {
      throw apiError('collaboration_file_scope_invalid', '任务附件不属于当前委托。', 400);
    }
    const stored = await one(db, 'SELECT * FROM collaboration_files WHERE id=$1 AND delegation_id=$2', [remoteFileId, delegation.id])
      || await one(db, `SELECT * FROM large_file_objects
        WHERE id=$1 AND account_workspace_id=$2 AND scope_kind='collaboration_task' AND scope_id=$3 AND status='ready'`,
      [remoteFileId, accountWorkspaceId, delegation.id]);
    if (!stored || String(stored.group_id || '').trim() !== groupId) {
      throw apiError('collaboration_file_scope_invalid', '任务附件不属于当前委托。', 400);
    }
    if ((attachment?.sha256 && String(attachment.sha256).toLowerCase() !== String(stored.sha256 || '').toLowerCase())
      || (Number(attachment?.size || 0) > 0 && Number(attachment.size) !== Number(stored.size_bytes || 0))) {
      throw apiError('collaboration_file_metadata_mismatch', '任务附件元数据校验失败。', 400);
    }
    canonical.push(stored.scope_kind ? largeFileAttachment(stored) : collaborationFileAttachment(stored));
  }
  return canonical;
}

function assertLargeFileIdentity(row = {}, { ownerUserId = '', scopeKind = '', scopeId = '', sizeBytes = 0, sha256 = '' } = {}) {
  if (row.owner_user_id !== ownerUserId || row.scope_kind !== scopeKind || row.scope_id !== scopeId
    || Number(row.size_bytes) !== Number(sizeBytes) || row.sha256 !== sha256) {
    throw apiError('large_file_identity_conflict', '大文件 ID 已被其他文件或会话占用。', 409);
  }
}

async function requireOwnedLargeFileUpload(db, uploadId = '', ownerUserId = '') {
  const cleanId = String(uploadId || '').trim();
  const upload = cleanId ? await one(db, 'SELECT * FROM large_file_upload_sessions WHERE id=$1 AND owner_user_id=$2', [cleanId, ownerUserId]) : null;
  if (!upload) throw apiError('large_file_upload_not_found', '大文件上传会话不存在。', 404);
  return upload;
}

function largeFileUploadPayload(upload = {}, chunks = []) {
  return {
    ok: true,
    uploadId: upload.id,
    fileId: upload.file_id,
    status: upload.status,
    size: Number(upload.size_bytes || 0),
    sha256: upload.sha256 || '',
    chunkSize: Number(upload.chunk_size_bytes || LARGE_FILE_CHUNK_BYTES),
    chunkCount: Number(upload.chunk_count || 0),
    uploadedChunks: chunks.map((item) => Number(item.chunk_index)).filter(Number.isInteger),
    expiresAt: toIso(upload.expires_at),
  };
}

function largeFileObjectStorageKey(sha256 = '') {
  return path.posix.join('objects', sha256.slice(0, 2), sha256.slice(2, 4), sha256);
}

function largeFileUploadDirectory(storageRoot = '', uploadId = '') {
  const safeUploadId = String(uploadId || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 220);
  if (!safeUploadId) throw apiError('large_file_upload_path_invalid', '大文件上传目录无效。', 500);
  return path.join(path.resolve(storageRoot), 'uploads', safeUploadId);
}

function largeFileChunkPath(storageRoot = '', uploadId = '', chunkIndex = 0) {
  return path.join(largeFileUploadDirectory(storageRoot, uploadId), `${Number(chunkIndex)}.chunk`);
}

function safeLargeFileStoragePath(storageRoot = '', storageKey = '') {
  const root = path.resolve(storageRoot);
  const target = path.resolve(root, String(storageKey || ''));
  return target.startsWith(`${root}${path.sep}`) ? target : '';
}

async function assembleLargeFileObject(storageRoot = '', upload = {}, chunks = []) {
  const target = safeLargeFileStoragePath(storageRoot, upload.storage_key);
  if (!target) throw apiError('large_file_storage_key_invalid', '大文件存储位置无效。', 500);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${upload.id}.${process.pid}.assembling`;
  const digest = crypto.createHash('sha256');
  let totalBytes = 0;
  const output = await fs.promises.open(temporary, 'w', 0o600);
  try {
    for (const chunk of chunks) {
      const chunkPath = largeFileChunkPath(storageRoot, upload.id, Number(chunk.chunk_index));
      const data = await fs.promises.readFile(chunkPath);
      const chunkSha256 = crypto.createHash('sha256').update(data).digest('hex');
      if (data.length !== Number(chunk.size_bytes) || chunkSha256 !== chunk.sha256) {
        throw apiError('large_file_chunk_storage_mismatch', '云端暂存分片校验失败，请重新上传该文件。', 409);
      }
      await output.writeFile(data);
      digest.update(data);
      totalBytes += data.length;
    }
    await output.sync();
  } finally {
    await output.close();
  }
  const sha256 = digest.digest('hex');
  if (totalBytes !== Number(upload.size_bytes) || sha256 !== upload.sha256) {
    fs.rmSync(temporary, { force: true });
    throw apiError('large_file_hash_mismatch', '大文件完整性校验失败，请重新上传。', 400);
  }
  fs.renameSync(temporary, target);
  return { size: totalBytes, sha256 };
}

async function largeFileObjectByScope(db, fileId = '', scopeKind = '', scopeId = '') {
  return one(db, `SELECT * FROM large_file_objects
    WHERE id=$1 AND scope_kind=$2 AND scope_id=$3 AND status='ready'`, [fileId, scopeKind, scopeId]);
}

async function requireAccountWorkspaceAccess(db, userId = '', workspaceId = '') {
  const requested = String(workspaceId || 'workspace_personal').trim() || 'workspace_personal';
  const workspace = await one(db, `SELECT workspace.* FROM account_workspaces workspace
    JOIN account_workspace_memberships membership ON membership.workspace_id=workspace.id
    WHERE workspace.id=$1 AND workspace.status='active' AND membership.user_id=$2 AND membership.status='active'`, [requested, userId]);
  if (!workspace) throw apiError('account_workspace_forbidden', '工作空间不存在或你已不在该工作空间中。', 403);
  return workspace;
}

function requestAccountWorkspaceId(req = {}) {
  return req.body?.workspaceId || req.query?.workspaceId || req.headers?.['x-janus-workspace-id'] || '';
}

async function requireCollaborationGroupInRequestWorkspace(db, req, userId = '', groupId = '') {
  const workspace = await requireAccountWorkspaceAccess(db, userId, requestAccountWorkspaceId(req));
  const group = await one(db, 'SELECT * FROM collaboration_groups WHERE id=$1 AND account_workspace_id=$2', [groupId, workspace.id]);
  if (!group) throw apiError('collaboration_group_not_found', '任务群不存在或不属于当前工作空间。', 404);
  return { workspace, group };
}

async function requireWorkspaceMessagingPeer(db, workspace, senderId = '', recipientId = '') {
  if (!recipientId) throw apiError('recipient_required', '请选择有效联系人。', 400);
  if (workspace.workspace_kind === 'organization') {
    const peer = await one(db, `SELECT 1 FROM account_workspace_memberships
      WHERE workspace_id=$1 AND user_id=$2 AND status='active'`, [workspace.id, recipientId]);
    if (!peer) throw apiError('account_workspace_peer_forbidden', '只能给当前组织工作空间中的成员发送消息。', 403);
    return true;
  }
  return requireMessagingFriend(db, senderId, recipientId, { allowSelf: true });
}

async function requireContactChatPeer(db, workspace, senderId = '', recipientId = '') {
  if (!recipientId) throw apiError('recipient_required', '请选择有效联系人。', 400);
  if (recipientId === senderId) return true;
  if (workspace.workspace_kind === 'organization') {
    const member = await one(db, `SELECT 1 FROM account_workspace_memberships
      WHERE workspace_id=$1 AND user_id=$2 AND status='active'`, [workspace.id, recipientId]);
    if (member) return true;
  }
  try {
    await requireMessagingFriend(db, senderId, recipientId, { allowSelf: false });
    return true;
  } catch {
    throw apiError('contact_chat_peer_forbidden', '联系人群聊只能添加当前组织成员或已接受的外部联系人。', 403);
  }
}

async function naturalChatScopeType(db, workspace, memberIds = []) {
  if (workspace.workspace_kind !== 'organization') return 'external';
  for (const userId of memberIds) {
    const member = await one(db, `SELECT 1 FROM account_workspace_memberships
      WHERE workspace_id=$1 AND user_id=$2 AND status='active'`, [workspace.id, userId]);
    if (!member) return 'external';
  }
  return 'internal';
}

function naturalChatV2Requested(req = {}) {
  const capability = String(req.body?.socialCapability || req.body?.capability || req.query?.socialCapability
    || req.query?.capability || req.headers?.['x-janus-social-capability'] || '').trim();
  return capability.split(',').map((item) => item.trim()).includes('chat-groups-v2');
}

function accountSocialDirectRequested(req = {}) {
  const capability = String(req.body?.socialCapability || req.body?.capability || req.query?.socialCapability
    || req.query?.capability || req.headers?.['x-janus-social-capability'] || '').trim();
  return capability.split(',').map((item) => item.trim()).includes('account-social-direct-v1');
}

function requireDirectDelegationFilesCapability(req = {}) {
  const capability = String(req.body?.socialCapability || req.body?.capability || req.query?.socialCapability
    || req.query?.capability || req.headers?.['x-janus-social-capability'] || '').trim();
  if (!capability.split(',').map((item) => item.trim()).includes('direct-delegation-files-v1')) {
    throw apiError('direct_delegation_files_capability_required', '当前客户端或通信服务版本不支持一对一任务文件交付。', 426);
  }
}

function delegationRealtimeRequested(req = {}) {
  const capability = String(req.query?.capability || req.headers?.['x-janus-social-capability'] || '').trim();
  return capability.split(',').map((item) => item.trim()).includes('delegation-realtime-sse-v1');
}

function collaborationMentionRequestsTask(content = '') {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  return /(?:请|麻烦|让|需要|负责|帮(?:我|忙)?|务必|尽快|现在)?[^。！？\n]{0,24}(?:完成|制作|撰写|整理|分析|生成|绘制|编写|准备|处理|交付|调研|汇报|总结|检查|测试|修复|开发|设计|翻译|输出|提交)/i.test(text);
}

function collaborationMentionTaskInstruction(content = '', metadata = {}) {
  let instruction = String(content || '').trim();
  for (const mention of normalizeMentionEntities(metadata.mentions, { content, requirePicker: true })) {
    if (mention.principalType !== 'user') continue;
    instruction = instruction.replaceAll(mention.displayText, '');
  }
  return instruction.replace(/^[\s，,：:；;、-]+|[\s]+$/g, '').trim() || String(content || '').trim();
}

async function createCollaborationMentionDelegations(db, {
  workspaceId = 'workspace_personal', groupId = '', groupTitle = '', groupMessageId = '', senderUserId = '',
  content = '', metadata = {}, recipientUserIds = [],
} = {}) {
  const instruction = collaborationMentionTaskInstruction(content, metadata).slice(0, 16000);
  if (!instruction) return [];
  const title = (instruction.replace(/\s+/g, ' ').slice(0, 80) || `${groupTitle || '任务群'} · 新任务`).slice(0, 160);
  const created = [];
  for (const recipientUserId of [...new Set((recipientUserIds || []).map(String).filter(Boolean))]) {
    if (!recipientUserId || recipientUserId === senderUserId) continue;
    const membership = await one(db, `SELECT 1 FROM collaboration_group_members
      WHERE group_id=$1 AND user_id=$2 AND status='active'`, [groupId, recipientUserId]);
    if (!membership) continue;
    const clientRequestId = `group-mention:${groupMessageId}:${recipientUserId}`.slice(0, 240);
    let delegationId = newId('agent_delegate');
    const delegationMetadata = publicDelegationMetadata({
      source: 'collaboration_group_mention',
      groupId,
      sourceGroupMessageId: groupMessageId,
      initiatedThroughGroupMention: true,
    });
    const inserted = await db.query(`INSERT INTO agent_delegations(
      id,account_workspace_id,requester_user_id,recipient_user_id,client_request_id,sender_agent_id,recipient_agent_id,
      title,instruction,status,group_id,metadata_json
    ) VALUES($1,$2,$3,$4,$5,'secretary_agent','secretary_agent',$6,$7,'assigned',$8,$9::jsonb)
    ON CONFLICT DO NOTHING RETURNING id`, [
      delegationId, workspaceId, senderUserId, recipientUserId, clientRequestId, title, instruction, groupId,
      JSON.stringify(delegationMetadata),
    ]);
    const newlyCreated = inserted.rowCount > 0;
    if (!newlyCreated) {
      const existing = await one(db, `SELECT id FROM agent_delegations
        WHERE account_workspace_id=$1 AND requester_user_id=$2 AND client_request_id=$3`, [workspaceId, senderUserId, clientRequestId]);
      if (!existing?.id) continue;
      delegationId = existing.id;
    }
    if (newlyCreated) {
      await db.query(`INSERT INTO agent_delegation_workspaces(delegation_id,user_id,metadata_json)
        VALUES($1,$2,'{}'::jsonb),($1,$3,'{}'::jsonb)
        ON CONFLICT(delegation_id,user_id) DO NOTHING`, [delegationId, senderUserId, recipientUserId]);
      const assignmentMessageId = newId('group_msg');
      await db.query(`INSERT INTO collaboration_group_messages(
        id,account_workspace_id,group_id,sender_user_id,sender_agent_id,kind,content,metadata_json,source_event_id
      ) VALUES($1,$2,$3,$4,'secretary_agent','agent',$5,$6::jsonb,$7)`, [
        assignmentMessageId, workspaceId, groupId, senderUserId,
        `uBuddy 已将群内要求建立为正式任务：${title}`.slice(0, 8000),
        JSON.stringify({ type: 'task_assigned', delegationId, recipientUserId, sourceGroupMessageId: groupMessageId }),
        `group-mention-assigned:${groupMessageId}:${recipientUserId}`.slice(0, 240),
      ]);
      await insertPrivateTaskIngress(db, {
        delegationId,
        userId: recipientUserId,
        content: instruction,
        type: 'task_assigned',
        sourceEventId: `task-assigned:${delegationId}`,
        sourceGroupMessageId: groupMessageId,
        fromUserId: senderUserId,
      });
      await insertPrivateTaskIngress(db, {
        delegationId,
        userId: senderUserId,
        content: instruction,
        type: 'task_published',
        sourceEventId: `task-published:${delegationId}`,
        sourceGroupMessageId: groupMessageId,
        fromUserId: senderUserId,
      });
      await appendDelegationRealtimeEvents(db, {
        delegationId,
        accountWorkspaceId: workspaceId,
        recipientUserIds: [senderUserId, recipientUserId],
        eventType: 'delegation.assigned',
        aggregateVersion: 1,
        payload: { status: 'assigned', groupId, requesterUserId: senderUserId, recipientUserId, sourceGroupMessageId: groupMessageId },
      });
    }
    created.push({ delegationId, recipientUserId, idempotent: !newlyCreated });
  }
  return created;
}

function requireDelegationExecutionLeaseCapability(req = {}) {
  const capability = String(req.body?.socialCapability || req.body?.capability
    || req.headers?.['x-janus-social-capability'] || '').trim();
  if (!capability.split(',').map((item) => item.trim()).includes('delegation-execution-lease-v1')) {
    throw apiError('delegation_execution_lease_capability_required', '当前客户端未声明委托执行租约能力。', 426);
  }
}

async function appendSocialRealtimeEvents(db, {
  accountWorkspaceId = 'workspace_personal', recipientUserIds = [], eventType = 'social.updated',
  aggregateType = 'social', aggregateId = '', aggregateVersion = 0, payload = {},
} = {}) {
  const users = [...new Set((Array.isArray(recipientUserIds) ? recipientUserIds : []).map(String).filter(Boolean))];
  const rows = [];
  for (const recipientUserId of users) {
    const id = newId('social_event');
    const row = await one(db, `INSERT INTO social_realtime_events(
      id,account_workspace_id,recipient_user_id,event_type,aggregate_type,aggregate_id,aggregate_version,payload_json
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *`, [
      id, accountWorkspaceId || 'workspace_personal', recipientUserId, String(eventType || 'delegation.updated').slice(0, 120),
      String(aggregateType || 'social').slice(0, 120), String(aggregateId || '').slice(0, 240),
      Math.max(0, Number(aggregateVersion || 0)), JSON.stringify(payload && typeof payload === 'object' ? payload : {}),
    ]);
    rows.push(row);
  }
  return rows;
}

async function appendDelegationRealtimeEvents(db, {
  delegationId = '', accountWorkspaceId = 'workspace_personal', recipientUserIds = [], eventType = 'delegation.updated',
  aggregateVersion = 0, payload = {},
} = {}) {
  return appendSocialRealtimeEvents(db, {
    accountWorkspaceId,
    recipientUserIds,
    eventType,
    aggregateType: 'agent_delegation',
    aggregateId: delegationId,
    aggregateVersion,
    payload,
  });
}

function delegationExecutionLeasePayload(row = {}) {
  return {
    delegationId: row.delegation_id || '',
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    recipientUserId: row.recipient_user_id || '',
    deviceId: row.device_id || '',
    leaseToken: row.lease_token || '',
    executionEpoch: Number(row.execution_epoch || 1),
    leaseExpiresAt: toIso(row.lease_expires_at),
    claimedAt: toIso(row.claimed_at),
    renewedAt: toIso(row.renewed_at),
    releasedAt: row.released_at ? toIso(row.released_at) : '',
    releaseReason: row.release_reason || '',
    updatedAt: toIso(row.updated_at),
  };
}

function requireConversationArchiveCapability(req = {}) {
  const capability = String(req.body?.socialCapability || req.body?.capability || req.query?.socialCapability
    || req.query?.capability || req.headers?.['x-janus-social-capability'] || '').trim();
  if (!capability.split(',').map((item) => item.trim()).includes('conversation-inbox-archive-v1')) {
    throw apiError('conversation_archive_capability_required', '当前客户端未声明会话归档能力。', 426);
  }
}

function normalizeConversationPreferenceKind(value = '') {
  const kind = String(value || '').trim();
  if (!['chat_group', 'collaboration_group'].includes(kind)) {
    throw apiError('conversation_preference_kind_invalid', '不支持的会话归档类型。', 400);
  }
  return kind;
}

async function requireConversationPreferenceMembership(db, { userId = '', conversationKind = '', conversationId = '' } = {}) {
  const groupTable = conversationKind === 'chat_group' ? 'chat_groups' : 'collaboration_groups';
  const memberTable = conversationKind === 'chat_group' ? 'chat_group_members' : 'collaboration_group_members';
  const group = await one(db, `SELECT * FROM ${groupTable} WHERE id=$1`, [conversationId]);
  const membership = group ? await one(db, `SELECT * FROM ${memberTable} WHERE group_id=$1 AND user_id=$2`, [conversationId, userId]) : null;
  if (!group || !membership) throw apiError('conversation_preference_not_found', '会话不存在或你无权管理。', 404);
  return group;
}

async function socialConversationPreferencePayload(db, row = {}) {
  const groupTable = row.conversation_kind === 'chat_group' ? 'chat_groups' : 'collaboration_groups';
  const group = await one(db, `SELECT status,updated_at FROM ${groupTable} WHERE id=$1`, [row.conversation_id]);
  const ended = row.conversation_kind === 'chat_group' ? group?.status === 'dissolved' : group?.status === 'closed';
  const archived = Boolean(row.archived && (ended || !group?.updated_at || new Date(group.updated_at) <= new Date(row.updated_at)));
  return { ...conversationPreferencePayloadFromRow(row), archived, autoReopened: Boolean(row.archived && !archived) };
}

function conversationPreferencePayloadFromRow(row = {}) {
  return {
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    userId: row.user_id || '',
    conversationKind: row.conversation_kind || '',
    conversationId: row.conversation_id || '',
    archived: Boolean(row.archived),
    stateRevision: Number(row.state_revision || 0),
    lastCommandId: row.last_command_id || '',
    sourceDeviceId: row.source_device_id || '',
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

async function naturalChatGroupsOverview(db, userId = '', accountWorkspaceId = 'workspace_personal', { accountGlobal = false } = {}) {
  const workspacePredicate = accountGlobal ? '' : ' AND chat.account_workspace_id=$2';
  const params = accountGlobal ? [userId] : [userId, accountWorkspaceId];
  const rows = await many(db, `SELECT chat.*,
      membership.user_id AS membership_user_id,membership.role AS membership_role,membership.status AS membership_status,membership.invited_by_user_id AS membership_invited_by_user_id,
      membership.display_name_override AS membership_display_name_override,
      membership.joined_at AS membership_joined_at,membership.left_at AS membership_left_at,membership.last_read_at AS membership_last_read_at
    FROM chat_groups chat JOIN chat_group_members membership ON membership.group_id=chat.id AND membership.user_id=$1
    WHERE membership.status IN ('active','left','removed')${workspacePredicate}
    ORDER BY CASE WHEN chat.status='active' THEN 0 ELSE 1 END,chat.updated_at DESC,chat.id`, params);
  const groups = [];
  for (const row of rows) {
    const memberCount = await one(db, "SELECT COUNT(*) AS count FROM chat_group_members WHERE group_id=$1 AND status='active'", [row.id]);
    const unreadCount = await one(db, `SELECT COUNT(*) AS count FROM chat_group_messages
      WHERE group_id=$1 AND sender_user_id<>$2
        AND ($3::timestamptz IS NULL OR created_at>$3::timestamptz)`, [row.id, userId, row.membership_last_read_at || null]);
    const lastMessage = await one(db, `SELECT
        CASE WHEN message.metadata_json->>'withdrawn'='true' THEN '消息已撤回' ELSE message.content END AS content,
        CASE
          WHEN sender_member.display_name_override<>'' THEN sender_member.display_name_override
          WHEN sender.display_name<>'' THEN sender.display_name
          WHEN sender.username<>'' THEN sender.username
          ELSE message.sender_user_id
        END AS sender_label
      FROM chat_group_messages message
      JOIN users sender ON sender.id=message.sender_user_id
      LEFT JOIN chat_group_members sender_member ON sender_member.group_id=message.group_id AND sender_member.user_id=message.sender_user_id
      WHERE message.group_id=$1 ORDER BY message.created_at DESC,message.id DESC LIMIT 1`, [row.id]);
    groups.push(naturalChatGroupPayload({
      ...row,
      member_count: memberCount?.count || 0,
      unread_count: unreadCount?.count || 0,
      last_message: groupConversationPreview(lastMessage),
    }));
  }
  return { capability: accountGlobal ? 'chat-groups-v2' : 'chat-groups-v1',
    audienceScope: accountGlobal ? 'account_social' : 'workspace_legacy', groups };
}

function groupConversationPreview(message = null) {
  const content = String(message?.content || '').trim();
  if (!content) return '';
  const sender = String(message?.sender_label || '').trim();
  return sender ? `${sender}：${content}` : content;
}

async function naturalChatGroupDetail(db, groupId = '', userId = '', accountWorkspaceId = 'workspace_personal', { markRead = false, accountGlobal = false } = {}) {
  const { group, membership } = await requireNaturalChatGroupMember(db, groupId, userId, accountWorkspaceId, { accountGlobal });
  const members = await many(db, `SELECT member.*,profile.email,
    CASE WHEN member.display_name_override<>'' THEN member.display_name_override ELSE profile.display_name END AS display_name,
    profile.display_name AS account_display_name,profile.username,profile.avatar_url,profile.role AS user_role,profile.email_verified
    FROM chat_group_members member JOIN users profile ON profile.id=member.user_id WHERE member.group_id=$1
    ORDER BY CASE member.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,member.joined_at,member.user_id`, [groupId]);
  const lowerBound = group.history_visibility === 'full' ? null : membership.joined_at;
  const upperBound = ['left', 'removed'].includes(membership.status) ? membership.left_at : null;
  const messages = await many(db, `SELECT message.*,sender.email AS sender_email,
      CASE WHEN sender_member.display_name_override<>'' THEN sender_member.display_name_override ELSE sender.display_name END AS sender_display_name,
      sender.display_name AS sender_account_display_name,
      sender.username AS sender_username,sender.avatar_url AS sender_avatar_url,sender.role AS sender_role,sender.email_verified AS sender_email_verified
    FROM chat_group_messages message JOIN users sender ON sender.id=message.sender_user_id
    LEFT JOIN chat_group_members sender_member ON sender_member.group_id=message.group_id AND sender_member.user_id=message.sender_user_id
    WHERE message.group_id=$1 AND message.account_workspace_id=$2
      AND ($3::timestamptz IS NULL OR message.created_at>=$3::timestamptz)
      AND ($4::timestamptz IS NULL OR message.created_at<=$4::timestamptz)
    ORDER BY message.created_at,message.id`, [groupId, group.account_workspace_id, lowerBound, upperBound]);
  if (markRead && membership.status === 'active') await db.query('UPDATE chat_group_members SET last_read_at=now() WHERE group_id=$1 AND user_id=$2', [groupId, userId]);
  return {
    group: naturalChatGroupPayload(group),
    membership: naturalChatMemberPayload(membership),
    members: members.map(naturalChatMemberPayload),
    messages: messages.map(naturalChatMessagePayload),
  };
}

async function requireNaturalChatGroupMember(db, groupId = '', userId = '', accountWorkspaceId = 'workspace_personal', { accountGlobal = false } = {}) {
  const group = accountGlobal
    ? await one(db, 'SELECT * FROM chat_groups WHERE id=$1', [groupId])
    : await one(db, 'SELECT * FROM chat_groups WHERE id=$1 AND account_workspace_id=$2', [groupId, accountWorkspaceId]);
  const membership = group ? await one(db, 'SELECT * FROM chat_group_members WHERE group_id=$1 AND user_id=$2', [groupId, userId]) : null;
  if (!group || !membership) throw apiError('chat_group_not_found', '群聊不存在或你已不在群内。', 404);
  return { group, membership };
}

function naturalChatGroupPayload(row = {}) {
  return {
    id: row.id,
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    organizationId: row.organization_id || '',
    ownerUserId: row.owner_user_id || '',
    title: row.title || '新群聊',
    scopeType: row.scope_type || 'external',
    chatMode: row.chat_mode || 'conversation',
    bindingType: row.binding_type || 'manual',
    bindingId: row.binding_id || '',
    historyVisibility: row.history_visibility || 'from_join',
    audienceScope: row.audience_scope || 'account_social',
    status: row.status || 'active',
    memberCount: Number(row.member_count || 0),
    unreadCount: Number(row.unread_count || 0),
    lastMessage: row.last_message || '',
    metadata: jsonObject(row.metadata_json),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    dissolvedAt: row.dissolved_at ? toIso(row.dissolved_at) : '',
    ...(row.membership_role ? { membership: {
      groupId: row.id, userId: row.membership_user_id || '', role: row.membership_role, status: row.membership_status || 'active',
      displayNameOverride: row.membership_display_name_override || '',
      invitedByUserId: row.membership_invited_by_user_id || '', joinedAt: toIso(row.membership_joined_at),
      leftAt: row.membership_left_at ? toIso(row.membership_left_at) : '', lastReadAt: row.membership_last_read_at ? toIso(row.membership_last_read_at) : '',
    } } : {}),
  };
}

function naturalChatMemberPayload(row = {}) {
  return {
    groupId: row.group_id || '', userId: row.user_id || '', role: row.role || 'member', status: row.status || 'active',
    invitedByUserId: row.invited_by_user_id || '', joinedAt: toIso(row.joined_at), leftAt: row.left_at ? toIso(row.left_at) : '',
    lastReadAt: row.last_read_at ? toIso(row.last_read_at) : '',
    displayNameOverride: row.display_name_override || '',
    user: row.email !== undefined ? {
      ...publicUser({ id: row.user_id, email: row.email, display_name: row.display_name,
        username: row.username, avatar_url: row.avatar_url, role: row.user_role, email_verified: row.email_verified }),
      accountDisplayName: row.account_display_name || row.display_name || '',
    } : undefined,
  };
}

function naturalChatMessagePayload(row = {}) {
  return {
    id: row.id, accountWorkspaceId: row.account_workspace_id || 'workspace_personal', workspaceId: row.account_workspace_id || 'workspace_personal',
    groupId: row.group_id || '', senderUserId: row.sender_user_id || '', senderAgentId: row.sender_agent_id || '',
    kind: normalizeMessageKind(row.kind), content: row.content || '', sourceEventId: row.source_event_id || '', metadata: jsonObject(row.metadata_json),
    sender: {
      ...publicUser({ id: row.sender_user_id, email: row.sender_email, display_name: row.sender_display_name,
        username: row.sender_username, avatar_url: row.sender_avatar_url, role: row.sender_role, email_verified: row.sender_email_verified }),
      accountDisplayName: row.sender_account_display_name || row.sender_display_name || '',
    },
    createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at),
  };
}

function stableRequestHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableRequestValue(value))).digest('hex');
}

function requireUBuddyCapabilityProfileCapability(req = {}) {
  const capability = String(req.body?.socialCapability || req.body?.capability || req.query?.socialCapability
    || req.query?.capability || req.headers?.['x-janus-social-capability'] || '').trim();
  if (!capability.split(',').map((item) => item.trim()).includes('ubuddy-capability-profile-v1')) {
    throw apiError('ubuddy_profile_capability_required', '当前客户端未声明 uBuddy 简介能力。', 426);
  }
}

function normalizePublishedUBuddyCapabilityProfile(value = {}, ownerUserId = '') {
  const profile = normalizeUBuddyCapabilityProfile({ ...(value || {}), ownerUserId });
  const validation = validateUBuddyCapabilityProfile(profile);
  if (!validation.valid) {
    throw apiError('ubuddy_profile_invalid', 'uBuddy 简介未通过发布校验。', 400, { diagnostics: validation.diagnostics });
  }
  if (profile.publicationState !== 'active') {
    throw apiError('ubuddy_profile_state_invalid', '只能发布 active 状态的 uBuddy 简介。', 400);
  }
  if (!['friends', 'organization'].includes(profile.visibility)) {
    throw apiError('ubuddy_profile_visibility_invalid', '私有 uBuddy 简介不能上传。', 400);
  }
  if (Buffer.byteLength(JSON.stringify(profile), 'utf8') > 32 * 1024) {
    throw apiError('ubuddy_profile_too_large', 'uBuddy 简介不能超过 32 KB。', 413);
  }
  return profile;
}

function nonNegativeRevision(value = 0) {
  const number = Math.floor(Number(value || 0));
  if (!Number.isFinite(number) || number < 0) throw apiError('ubuddy_profile_state_revision_invalid', '简介状态版本号无效。', 400);
  return number;
}

function uniqueProfileUserIds(value = []) {
  const ids = [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))];
  if (ids.length > 100) throw apiError('ubuddy_profile_query_too_large', '一次最多查询 100 个 uBuddy 简介。', 400);
  return ids;
}

async function uBuddyProfileAccessScope(db, viewerUserId = '', ownerUserId = '', visibility = 'friends') {
  if (viewerUserId === ownerUserId) return 'owner';
  if (await isBlockedEitherWay(db, viewerUserId, ownerUserId)) return '';
  if (await friendshipBetween(db, viewerUserId, ownerUserId)) return 'friends';
  if (visibility !== 'organization') return '';
  const sharedOrganization = await one(db, `SELECT 1 FROM contact_organization_members viewer
    JOIN contact_organization_members owner ON owner.organization_id=viewer.organization_id
    WHERE viewer.user_id=$1 AND owner.user_id=$2 LIMIT 1`, [viewerUserId, ownerUserId]);
  return sharedOrganization ? 'organization' : '';
}

function uBuddyCloudProfilePayload(row = {}, accessScope = 'friends') {
  return {
    ownerUserId: row.owner_user_id || '',
    contentHash: row.content_hash || '',
    accessScope,
    stateRevision: Number(row.state_revision || 0),
    publishedAt: toIso(row.published_at),
    updatedAt: toIso(row.updated_at),
    profile: jsonObject(row.profile_json),
  };
}

function safeUBuddyCloudProfilePayload(row = {}, accessScope = 'friends') {
  const payload = uBuddyCloudProfilePayload(row, accessScope);
  return validateUBuddyCapabilityProfile(payload.profile).valid ? payload : null;
}

function stableRequestValue(value) {
  if (Array.isArray(value)) return value.map(stableRequestValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableRequestValue(value[key])]));
}

async function validateDirectMessageAttachments(db, attachments = [], senderUserId = '', recipientUserId = '', accountWorkspaceId = 'workspace_personal') {
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    if (attachment.remote_file_kind !== 'social') throw apiError('social_file_scope_invalid', '私聊消息包含不属于当前会话的附件。', 400);
    const file = await one(db, `SELECT id FROM social_message_files
      WHERE id=$1 AND account_workspace_id=$2 AND group_id IS NULL
        AND ((owner_user_id=$3 AND recipient_user_id=$4) OR (owner_user_id=$4 AND recipient_user_id=$3))`,
    [attachment.remote_file_id, accountWorkspaceId, senderUserId, recipientUserId])
      || await one(db, `SELECT id FROM large_file_objects
        WHERE id=$1 AND account_workspace_id=$2 AND scope_kind='social' AND status='ready'
          AND ((owner_user_id=$3 AND recipient_user_id=$4) OR (owner_user_id=$4 AND recipient_user_id=$3))`,
      [attachment.remote_file_id, accountWorkspaceId, senderUserId, recipientUserId]);
    if (!file) throw apiError('social_file_scope_invalid', '私聊附件不属于当前会话。', 400);
  }
}

async function validateNaturalChatGroupAttachments(db, attachments = [], groupId = '') {
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    if (attachment.remote_file_kind !== 'chat_group' || attachment.group_id !== groupId) {
      throw apiError('chat_group_file_scope_invalid', '群聊消息包含不属于当前群聊的附件。', 400);
    }
    const file = await one(db, 'SELECT id FROM chat_group_message_files WHERE id=$1 AND group_id=$2', [attachment.remote_file_id, groupId])
      || await largeFileObjectByScope(db, attachment.remote_file_id, 'chat_group', groupId);
    if (!file) throw apiError('chat_group_file_scope_invalid', '群聊附件不属于当前群聊。', 400);
  }
}

async function validateGroupMessageAttachments(db, attachments = [], groupId = '') {
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    if (attachment.remote_file_kind !== 'collaboration_group' || attachment.group_id !== groupId) {
      throw apiError('group_message_file_scope_invalid', '群聊消息包含不属于当前群组的附件。', 400);
    }
    const file = await one(db, 'SELECT id FROM social_message_files WHERE id = $1 AND group_id = $2', [attachment.remote_file_id, groupId])
      || await largeFileObjectByScope(db, attachment.remote_file_id, 'collaboration_group', groupId);
    if (!file) throw apiError('group_message_file_scope_invalid', '群聊附件不属于当前群组。', 400);
  }
}

async function recordPostgresCollaborationEvidence(client,{env=process.env,ownerUserId,sourceKind,sourceId,sourceVersionId='',content,
  delegationId='',metadata={}}={}) {
  const keyring=evolutionKeyringFromEnv(env);
  const envelopeKeyring=evolutionEnvelopePublicKeyringFromEnv(env);
  if (!evolutionEncryptionReady(keyring) && !keyring.allowPlaintextTestOnly && !envelopeKeyring.activeKeyId) return null;
  const instance=(await client.query(`SELECT * FROM cloud_user_agent_instances_v3
    WHERE user_id=$1 AND agent_family_id='secretary_agent' AND status='active'`,[ownerUserId])).rows[0];
  if (!instance) return null;
  return createPostgresAuthoritativeEvidence(client,{keyring,envelopeKeyring,requireEnvelope:env.NODE_ENV==='production',ownerUserId,userAgentInstanceId:instance.id,
    agentFamilyId:instance.agent_family_id,sourceKind,sourceId,sourceVersionId,content,delegationId,
    confidence:0.8,metadata});
}
