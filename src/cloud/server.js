import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { isBearerAuthorized, readBody, readJson, sendFileResponse, sendJson } from '../../network/server/nodeHttp.js';
import {
  normalizeReleaseArtifactPath,
  normalizeReleaseVersion,
  releaseArtifactFile,
  releaseArtifactUrl,
} from '../shared/releaseLayout.js';
import { isLegacyChatDepartmentId } from '../shared/departments.js';
import {
  normalizeUBuddyCapabilityProfile,
  validateUBuddyCapabilityProfile,
} from '../shared/contracts/uBuddyCapabilityProfile.js';
import {
  agentFamilyNameUsesCanonicalTemplate,
  canonicalAgentFamilyName,
  compactAgentInstanceProfiles,
} from '../shared/agentInstanceNaming.js';
import { logDeprecatedEvolutionEnvironment } from '../shared/evolution/index.js';
import {
  appendDiagnosticEvent,
  diagnosticContext,
  diagnosticsEnabled,
  testDiagnosticFile,
} from '../shared/diagnostics.js';
import {
  delegationTransitionAllowed as cloudDelegationTransitionAllowed,
  isDelegationStatus as isCloudDelegationStatus,
  legacyDelegationTransitionAllowed as legacyCloudDelegationTransitionAllowed,
  nextDelegationStatus as nextCloudDelegationStatus,
  normalizeDelegationStatus as normalizeCloudDelegationStatus,
  privateDelegationMetadata as privateCloudDelegationMetadata,
  privateWorkspaceMessageMetadata as privateCloudWorkspaceMessageMetadata,
  publicDelegationMetadata as publicCloudDelegationMetadata,
  publicDelegationSubmissionText as publicCloudDelegationSubmissionText,
} from './modules/collaboration/index.js';
import { CLOUD_SCHEMA } from './modules/persistence/index.js';
import { createEvolutionAuthority, createPlatformEvolutionModelExecutor, createSqliteLeadershipAuthority, createStage8Authority } from './modules/evolution/index.js';
import { createCloudWorkMemoryService } from './modules/collaboration/application/cloudWorkMemory.js';
import {
  ensureLegacyPrivateThreadRoutingColumns,
  ensureLegacyCollaborationMessageSourceColumn,
  applySyncMigrations,
  cleanupLegacyDepartmentCloudData,
  payloadDepartmentId,
  payloadContainsLegacyDepartment,
  legacyPayloadSql,
  applySyncMigration,
  backfillLegacyFileRefs,
  backfillLegacyBatch,
  upsertLegacyFileRef,
  buildLegacyFileIndex,
  appendLegacyIndex,
  legacyFileForAttachment,
  uniqueLegacyFiles,
  legacyArtifactFileAttachments,
  sanitizeLegacyMessageContent,
  parseLegacyArtifact,
  sanitizeLegacyCloudValue,
  recordBatch,
  identitySnapshot,
  personalEvolutionSnapshot,
  decidePersonalEvolution,
  upsertProjectV2,
  upsertConversationV2,
  purgeConversationFiles,
  purgeCloudConversationData,
  cloudConversationExists,
  upsertMessageV2,
  upsertTranscriptV2,
  upsertModelExecutionV2,
  upsertFileRefV2,
  upsertRows,
  traceFile,
  traceConversation,
  conversationContext,
  storedFileForUser,
  payloadFromRow,
  fileRefPayload,
  normalizeUploadedLocalPath,
  stableServerId,
} from './modules/persistence/index.js';
import {
  registerCloudUser,
  sendCloudEmailCode,
  resetCloudUserPassword,
  loginCloudUser,
  refreshCloudSession,
  logoutCloudSession,
  requireCloudAuth,
  suspendCloudUser,
  reactivateCloudUser,
  createCloudSession,
  updateCloudUserProfile,
  updateCloudUserPassword,
  cloudUserPayload,
  normalizeCloudEmail,
  normalizeCloudEmailPurpose,
  normalizeCloudEmailCode,
  validateCloudPassword,
  normalizeCloudDisplayName,
  normalizeCloudUsername,
  uniqueCloudUsername,
  hashCloudPassword,
  verifyCloudPassword,
  hashCloudToken,
  hashCloudEmailCode,
  verifyCloudEmailCode,
  consumeCloudEmailCode,
  createCloudMailerFromEnv,
  cloudEmailSubject,
  createCloudEmployeeAuthority,
} from './modules/identity/index.js';
import { cloudApiError } from './modules/http/index.js';
import {
  searchCloudUsers,
  cloudFriendsOverview,
  createCloudFriendRequest,
  updateCloudFriendRequest,
  acceptCloudFriendRequestRow,
  removeCloudFriend,
  updateCloudFriendRemark,
  blockCloudUser,
  listCloudSocialMessages,
  createCloudSocialMessage,
  updateCloudSocialMessage,
  markCloudSocialMessageRead,
  listCloudDelegations,
  createCloudDelegation,
  updateCloudDelegation,
  cloudDelegationWorkspace,
  createCloudDelegationWorkspaceMessage,
  cloudCollaborationOverview,
  cloudCollaborationGroupDetail,
  createCloudCollaborationGroup,
  createCloudCollaborationMessage,
  updateCloudCollaborationGroup,
  applyCloudCollaborationTaskAction,
  cloudCollaborationGroupWorkspace,
  storeCloudCollaborationGroupWorkspaceFile,
  deleteCloudCollaborationGroupWorkspaceFile,
  cloudCollaborationGroupWorkspaceFileForUser,
  storeCloudCollaborationFile,
  cloudCollaborationFileForUser,
  cloudCollaborationFilename,
  cloudCollaborationContentDisposition,
  cloudCollaborationFileAttachment,
  insertCloudCollaborationSystemMessage,
  cloudCollaborationGroupPayload,
  cloudCollaborationMemberPayload,
  cloudCollaborationMessagePayload,
  updateCloudPresence,
  cloudPublicUser,
  cloudFriendRequestPayload,
  cloudFriendshipPayload,
  cloudFriendshipBetween,
  cloudUsersBlocked,
  requireCloudMessagingFriend,
  cloudSocialMessageSelectSql,
  hydratedCloudSocialMessage,
  cloudSocialMessagePayload,
  cloudDelegationSelectSql,
  hydratedCloudDelegation,
  cloudDelegationWorkspaceRow,
  cloudDelegationPayload,
  cloudOrderedUserPair,
  normalizeCloudCursor,
  cloudJsonObject,
  normalizeCloudMessageKind,
  cloudDelegationWorkspacePayload,
  cloudDelegationWorkspaceMessagePayload,
  emptyCloudTaskRouting,
  insertCloudPrivateTaskIngress,
  routeCloudGroupMessageToPrivateThreads,
  requireCloudDelegationParticipant,
  requireCloudActiveTaskMembership,
  publicCloudTaskActionMetadata,
  createCloudOrganization,
  joinCloudOrganization,
  cloudOrganizationAction,
} from './modules/social/index.js';

export function cloudHomeFromEnv() {
  return process.env.JANUS_CLOUD_HOME || path.join(process.cwd(), 'cloud-workspace');
}

export async function initCloudHome({
  home = cloudHomeFromEnv(),
  token = process.env.JANUS_CLOUD_TOKEN || crypto.randomBytes(24).toString('hex'),
  syncToken = process.env.JANUS_CLOUD_SYNC_TOKEN || crypto.randomBytes(24).toString('hex'),
} = {}) {
  await fsp.mkdir(path.join(home, 'files', 'sha256'), { recursive: true });
  await fsp.mkdir(path.join(home, 'releases'), { recursive: true });
  await fsp.mkdir(path.join(home, 'logs'), { recursive: true });
  const envPath = path.join(home, '.env');
  if (!fs.existsSync(envPath)) {
    await fsp.writeFile(
      envPath,
      [
        `JANUS_CLOUD_HOME=${home.replaceAll('\\', '/')}`,
        'JANUS_CLOUD_HOST=127.0.0.1',
        'JANUS_CLOUD_PORT=8787',
        `JANUS_CLOUD_TOKEN=${token}`,
        `JANUS_CLOUD_SYNC_TOKEN=${syncToken}`,
        'JANUS_RELEASE_CHANNEL=dev',
        '',
      ].join('\n'),
      'utf8',
    );
  }
  const db = openCloudDatabase(home);
  db.close();
  return { home, envPath, tokenWritten: !fs.existsSync(envPath) };
}

export function openCloudDatabase(home = cloudHomeFromEnv()) {
  fs.mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(path.join(home, 'cloud.db'));
  ensureLegacyPrivateThreadRoutingColumns(db);
  ensureLegacyCollaborationMessageSourceColumn(db);
  ensureLegacyEvolutionContractColumns(db);
  ensureLegacyAccountWorkspaceColumns(db);
  ensureLegacyDelegationIdentityColumns(db);
  db.exec(CLOUD_SCHEMA);
  ensureCloudEmployeeMultiInstance(db);
  ensureCloudEmployeeProfileUniqueness(db);
  ensureLegacyContactOrganizationColumns(db);
  removeLegacyCloudOrganizationFriendships(db);
  ensureCloudEvolutionHealthColumns(db);
  ensureCloudFriendshipRemarkColumns(db);
  ensureCloudLeadershipAssignmentColumns(db);
  ensureCloudLeadershipLevelColumns(db);
  ensureCloudAccountControlColumns(db);
  const existing = db.prepare('SELECT id FROM server_records LIMIT 1').get();
  if (!existing) {
    db.prepare('INSERT INTO server_records (id, schema_version) VALUES (?, 3)').run(`server_${crypto.randomUUID()}`);
  }
  applySyncMigrations(db);
  db.prepare('UPDATE server_records SET schema_version = 3').run();
  return db;
}

function ensureLegacyAccountWorkspaceColumns(db) {
  for (const tableName of [
    'cloud_task_runs',
    'social_messages',
    'agent_delegations',
    'collaboration_groups',
    'collaboration_group_messages',
  ]) {
    ensureLegacyTableColumns(db, tableName, [
      ['account_workspace_id', "TEXT NOT NULL DEFAULT 'workspace_personal'"],
    ]);
  }
  ensureLegacyTableColumns(db, 'cloud_task_events', [
    ['updated_at', "TEXT NOT NULL DEFAULT ''"],
  ]);
}

function ensureLegacyDelegationIdentityColumns(db) {
  ensureLegacyTableColumns(db, 'agent_delegations', [
    ['client_request_id', "TEXT NOT NULL DEFAULT ''"],
  ]);
}

function removeLegacyCloudOrganizationFriendships(db) {
  db.prepare("DELETE FROM friendships WHERE id LIKE 'friendship_org_%'").run();
}

function ensureLegacyEvolutionContractColumns(db) {
  ensureLegacyTableColumns(db, 'cloud_evolution_evidence', [
    ['personal_threshold_eligible', 'INTEGER NOT NULL DEFAULT 1'],
    ['eligibility_policy_version', "TEXT NOT NULL DEFAULT 'personal_threshold_v1'"],
    ['lineage_key', "TEXT NOT NULL DEFAULT ''"],
    ['validation_status', "TEXT NOT NULL DEFAULT 'validated'"],
    ['validation_policy_version', "TEXT NOT NULL DEFAULT 'legacy_backfill_v1'"],
    ['validation_json', "TEXT NOT NULL DEFAULT '{}'"],
    ['validated_at', "TEXT NOT NULL DEFAULT ''"],
    ['historical_inactive', 'INTEGER NOT NULL DEFAULT 0'],
    ['wrapped_data_key', "TEXT NOT NULL DEFAULT ''"],
    ['key_wrap_algorithm', "TEXT NOT NULL DEFAULT ''"],
    ['key_version', 'INTEGER NOT NULL DEFAULT 0'],
    ['envelope_format', "TEXT NOT NULL DEFAULT 'legacy_symmetric'"],
  ]);
  ensureLegacyTableColumns(db, 'cloud_agent_performance_events', [
    ['source_kind', "TEXT NOT NULL DEFAULT 'legacy_client'"],
    ['source_id', "TEXT NOT NULL DEFAULT ''"],
    ['source_version_id', "TEXT NOT NULL DEFAULT ''"],
    ['source_hash', "TEXT NOT NULL DEFAULT ''"],
    ['authority', "TEXT NOT NULL DEFAULT 'legacy_client'"],
    ['validation_status', "TEXT NOT NULL DEFAULT 'legacy'"],
  ]);
  ensureLegacyTableColumns(db, 'cloud_market_adoption_actions', [
    ['command_id', "TEXT NOT NULL DEFAULT ''"],
    ['payload_json', "TEXT NOT NULL DEFAULT '{}'"],
  ]);
}

function ensureLegacyContactOrganizationColumns(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'contact_organizations'").get();
  if (!table) return;
  const columns = new Set(db.prepare('PRAGMA table_info(contact_organizations)').all().map((row) => row.name));
  if (columns.has('secret_salt') && !columns.has('verification_code_salt')) {
    db.exec('ALTER TABLE contact_organizations RENAME COLUMN secret_salt TO verification_code_salt');
  }
  if (columns.has('secret_hash') && !columns.has('verification_code_hash')) {
    db.exec('ALTER TABLE contact_organizations RENAME COLUMN secret_hash TO verification_code_hash');
  }
}

function ensureCloudEmployeeMultiInstance(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='cloud_user_agent_instances_v3'").get();
  if (!/UNIQUE\s*\(\s*user_id\s*,\s*agent_family_id\s*\)/i.test(String(table?.sql || ''))) return;
  db.exec(`PRAGMA foreign_keys=OFF;
    PRAGMA legacy_alter_table=ON;
    BEGIN IMMEDIATE;
    ALTER TABLE cloud_user_agent_instances_v3 RENAME TO cloud_user_agent_instances_singleton_v3;
    CREATE TABLE cloud_user_agent_instances_v3 (
      user_id TEXT NOT NULL,id TEXT NOT NULL,agent_family_id TEXT NOT NULL,
      base_agent_version_id TEXT NOT NULL DEFAULT '',active_personal_skill_version_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',instance_kind TEXT NOT NULL DEFAULT 'employee',
      employment_state TEXT NOT NULL DEFAULT 'active',quota_exempt INTEGER NOT NULL DEFAULT 0,
      recruited_at TEXT NOT NULL DEFAULT '',deactivated_at TEXT NOT NULL DEFAULT '',last_state_changed_at TEXT NOT NULL DEFAULT '',
      state_revision INTEGER NOT NULL DEFAULT 1,recruitment_source TEXT NOT NULL DEFAULT 'migration',
      policy_version TEXT NOT NULL DEFAULT 'employee_cloud_authority_v1',sync_enabled INTEGER NOT NULL DEFAULT 1,
      personal_evolution_consent INTEGER NOT NULL DEFAULT 1,cluster_contribution_consent INTEGER NOT NULL DEFAULT 0,
      personal_skill_auto_activate INTEGER NOT NULL DEFAULT 0,source_device_id TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(user_id,id),CHECK(status IN ('active','inactive')),
      CHECK(instance_kind IN ('employee','system','governance','unavailable')),
      CHECK(employment_state IN ('active','inactive')),CHECK(status=employment_state),CHECK(state_revision>=1)
    );
    INSERT INTO cloud_user_agent_instances_v3 SELECT * FROM cloud_user_agent_instances_singleton_v3;
    DROP TABLE cloud_user_agent_instances_singleton_v3;
    CREATE INDEX idx_cloud_user_agent_instances_family ON cloud_user_agent_instances_v3(user_id,agent_family_id,created_at,id);
    COMMIT;
    PRAGMA legacy_alter_table=OFF;
    PRAGMA foreign_keys=ON;`);
}

function ensureCloudEmployeeProfileUniqueness(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cloud_user_agent_instances_v3'").get();
  if (!table) return;
  const columns = new Set(db.prepare('PRAGMA table_info(cloud_user_agent_instances_v3)').all().map((row) => row.name));
  if (!columns.has('family_instance_seq')) db.exec('ALTER TABLE cloud_user_agent_instances_v3 ADD COLUMN family_instance_seq INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('display_name')) db.exec("ALTER TABLE cloud_user_agent_instances_v3 ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
  if (!columns.has('note')) db.exec("ALTER TABLE cloud_user_agent_instances_v3 ADD COLUMN note TEXT NOT NULL DEFAULT ''");
  for (const family of db.prepare('SELECT id,name,payload_json FROM cloud_agent_families_v3 ORDER BY id').all()) {
    const familyId = family.id;
    const name = canonicalAgentFamilyName(familyId, family.name);
    if (!agentFamilyNameUsesCanonicalTemplate(familyId, family.name)) continue;
    let payload = {};
    try { payload = JSON.parse(family.payload_json || '{}'); } catch { payload = {}; }
    db.prepare(`UPDATE cloud_agent_families_v3 SET name=?,payload_json=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND (name<>? OR payload_json<>?)`).run(
      name, JSON.stringify({ ...payload, name }), familyId, name, JSON.stringify({ ...payload, name }),
    );
  }
  const rows = db.prepare(`SELECT i.id,i.user_id,i.agent_family_id,i.family_instance_seq,i.display_name,i.note,i.payload_json,
      i.recruited_at,i.created_at,COALESCE(f.name,i.agent_family_id,'Agent') AS family_name,
      EXISTS(SELECT 1 FROM cloud_user_agent_instance_aliases_v3 alias
        WHERE alias.user_id=i.user_id AND alias.alias_instance_id=i.id) AS is_alias
    FROM cloud_user_agent_instances_v3 i LEFT JOIN cloud_agent_families_v3 f ON f.id=i.agent_family_id
    ORDER BY i.user_id,i.agent_family_id,i.recruited_at,i.created_at,i.id`).all();
  const normalized = rows.map((row) => {
    let payload = {};
    try { payload = JSON.parse(row.payload_json || '{}'); } catch { payload = {}; }
    return {
      id: row.id, userId: row.user_id, agentFamilyId: row.agent_family_id,
      familyInstanceSeq: Number(row.family_instance_seq || payload.familyInstanceSeq || 0),
      displayName: row.display_name || payload.displayName || '',
      note: row.note || payload.note || '', familyName: row.family_name,
      recruitedAt: row.recruited_at, createdAt: row.created_at, isAlias: Boolean(row.is_alias), payload,
    };
  });
  const repaired = compactAgentInstanceProfiles(normalized);
  const update = db.prepare(`UPDATE cloud_user_agent_instances_v3 SET family_instance_seq=?,display_name=?,note=?,payload_json=?,
    state_revision=state_revision+?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=? AND id=?`);
  const changedUsers = new Set();
  const profileChanges = repaired.filter((profile) => profile.profileChanged);
  for (let index = 0; index < profileChanges.length; index += 1) {
    const profile = profileChanges[index];
    db.prepare(`UPDATE cloud_user_agent_instances_v3 SET family_instance_seq=?
      WHERE user_id=? AND id=?`).run(profile.familyInstanceSeq > 0 ? -(index + 1) : 0, profile.userId, profile.id);
  }
  for (const profile of repaired) {
    const payload = { ...(profile.payload || {}), familyInstanceSeq: profile.familyInstanceSeq, displayName: profile.displayName, note: profile.note || '' };
    const payloadChanged = JSON.stringify(payload) !== JSON.stringify(profile.payload || {});
    if (!profile.profileChanged && !payloadChanged) continue;
    update.run(profile.familyInstanceSeq, profile.displayName, profile.note || '', JSON.stringify(payload), profile.profileChanged ? 1 : 0, profile.userId, profile.id);
    if (profile.profileChanged) changedUsers.add(profile.userId);
  }
  for (const userId of changedUsers) {
    db.prepare(`UPDATE cloud_employee_roster_states SET roster_revision=roster_revision+1,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=?`).run(userId);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_user_agent_instances_unique_family_seq
    ON cloud_user_agent_instances_v3(user_id,agent_family_id,family_instance_seq) WHERE family_instance_seq>0`);
}

function ensureLegacyTableColumns(db, tableName, definitions = []) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
  if (!table) return;
  const columns = new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));
  for (const [name, definition] of definitions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${name} ${definition}`);
  }
}

function ensureCloudEvolutionHealthColumns(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(cloud_personal_version_health)').all().map((row) => row.name));
  if (!columns.has('last_performance_input_hash')) {
    db.exec("ALTER TABLE cloud_personal_version_health ADD COLUMN last_performance_input_hash TEXT NOT NULL DEFAULT ''");
  }
}

function ensureCloudFriendshipRemarkColumns(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(friendships)').all().map((row) => row.name));
  if (!columns.has('user_a_remark')) db.exec("ALTER TABLE friendships ADD COLUMN user_a_remark TEXT NOT NULL DEFAULT ''");
  if (!columns.has('user_b_remark')) db.exec("ALTER TABLE friendships ADD COLUMN user_b_remark TEXT NOT NULL DEFAULT ''");
}

function ensureCloudLeadershipAssignmentColumns(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cloud_leadership_assignments'").get();
  if (!table) return;
  const columns = new Set(db.prepare('PRAGMA table_info(cloud_leadership_assignments)').all().map((row) => row.name));
  if (!columns.has('assignment_mode')) db.exec("ALTER TABLE cloud_leadership_assignments ADD COLUMN assignment_mode TEXT NOT NULL DEFAULT 'normal'");
  if (!columns.has('limit_snapshot_json')) db.exec("ALTER TABLE cloud_leadership_assignments ADD COLUMN limit_snapshot_json TEXT NOT NULL DEFAULT '{}'");
}


function ensureCloudAccountControlColumns(db) {
  ensureLegacyTableColumns(db, 'users', [
    ['account_status', "TEXT NOT NULL DEFAULT 'active'"],
    ['suspended_at', "TEXT NOT NULL DEFAULT ''"],
    ['suspension_reason', "TEXT NOT NULL DEFAULT ''"],
  ]);
  db.exec(`CREATE TABLE IF NOT EXISTS cloud_upload_compliance (
    user_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL DEFAULT '',
    last_access_at TEXT NOT NULL DEFAULT '',
    last_sync_at TEXT NOT NULL DEFAULT '',
    last_effective_sync_at TEXT NOT NULL DEFAULT '',
    empty_batch_streak INTEGER NOT NULL DEFAULT 0,
    suspicious_access_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ok',
    reason TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cloud_upload_compliance_status ON cloud_upload_compliance(status, updated_at);`);
}

function ensureCloudLeadershipLevelColumns(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cloud_agent_leadership_levels'").get();
  if (!table) return;
  const columns = new Set(db.prepare('PRAGMA table_info(cloud_agent_leadership_levels)').all().map((row) => row.name));
  if (!columns.has('state_revision')) db.exec('ALTER TABLE cloud_agent_leadership_levels ADD COLUMN state_revision INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('last_low_evaluated_at')) db.exec("ALTER TABLE cloud_agent_leadership_levels ADD COLUMN last_low_evaluated_at TEXT NOT NULL DEFAULT ''");
  if (!columns.has('last_low_task_count')) db.exec('ALTER TABLE cloud_agent_leadership_levels ADD COLUMN last_low_task_count INTEGER NOT NULL DEFAULT 0');
}

export function createCloudServer({
  home = cloudHomeFromEnv(),
  token = process.env.JANUS_CLOUD_TOKEN || '',
  syncToken = process.env.JANUS_CLOUD_SYNC_TOKEN || '',
  emailCodeSecret = process.env.JANUS_EMAIL_CODE_SECRET || process.env.EMAIL_CODE_SECRET || token,
  mailer = createCloudMailerFromEnv(),
  evolutionModelExecutor = null,
  env = process.env,
} = {}) {
  logDeprecatedEvolutionEnvironment({ processName: 'janus-sqlite-cloud' });
  const db = openCloudDatabase(home);
  const evolutionAuthority = createEvolutionAuthority({ db, env, modelExecutor: evolutionModelExecutor });
  const employeeAuthority = createCloudEmployeeAuthority({ db });
  const stage8Authority = createStage8Authority({ db, modelExecutor: evolutionModelExecutor || createPlatformEvolutionModelExecutor({ env }) });
  const leadershipAuthority = createSqliteLeadershipAuthority({ db, modelExecutor: evolutionModelExecutor || createPlatformEvolutionModelExecutor({ env }) });
  const workMemoryService = createCloudWorkMemoryService({ db, env });
  const cloudDiagnosticFile = testDiagnosticFile('sqlite-cloud-http.jsonl', env);
  const testDiagnostics = diagnosticsEnabled(env);
  const server = http.createServer(async (request, response) => {
    const startedAt = Date.now();
    const requestId = `req_${crypto.randomUUID()}`;
    const context = diagnosticContext(env);
    const runId = testDiagnostics ? cleanCloudDiagnosticId(request.headers['x-janus-test-run-id']) || context.runId : '';
    const caseId = testDiagnostics ? cleanCloudDiagnosticId(request.headers['x-janus-test-case-id']) || context.caseId : '';
    response.setHeader('x-request-id', requestId);
    response.once('finish', () => {
      if (!cloudDiagnosticFile) return;
      const url = new URL(request.url || '/', 'http://localhost');
      const diagnosticPath = normalizeCloudDiagnosticPath(url.pathname);
      appendDiagnosticEvent(cloudDiagnosticFile, {
        source: 'http', runId, caseId,
        level: response.statusCode >= 500 ? 'error' : 'info',
        event: 'request_complete', message: `${request.method} ${diagnosticPath} ${response.statusCode}`,
        durationMs: Date.now() - startedAt,
        data: { requestId, method: request.method, path: diagnosticPath, statusCode: response.statusCode },
      }, { env });
    });
    try {
      await handleRequest({ request, response, db, home, token, syncToken, emailCodeSecret, mailer, evolutionAuthority, employeeAuthority, stage8Authority, leadershipAuthority, workMemoryService });
    } catch (error) {
      const status = Number(error?.status || 500);
      const message = error?.message || String(error);
      const errorPath = normalizeCloudDiagnosticPath(new URL(request.url || '/', 'http://localhost').pathname);
      if (cloudDiagnosticFile) appendDiagnosticEvent(cloudDiagnosticFile, {
        source: 'http', runId, caseId, level: 'error', event: 'request_error', message: error?.code || 'request_failed',
        data: { requestId, method: request.method, path: errorPath, statusCode: status }, error,
      }, { env });
      audit(db, request.method, request.url, status, message);
      sendJson(response, status, {
        error: status >= 500 ? message : {
          code: error?.code || 'request_failed',
          message,
          details: error?.details && typeof error.details === 'object' ? error.details : {},
        },
      });
    }
  });
  return {
    server,
    db,
    listen({ host = process.env.JANUS_CLOUD_HOST || '127.0.0.1', port = Number(process.env.JANUS_CLOUD_PORT || 8787) } = {}) {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const address = server.address();
          resolve({ host, port: typeof address === 'object' && address ? address.port : port, home });
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          db.close();
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

function cleanCloudDiagnosticId(value) {
  return String(value || '').trim().replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 160);
}

function normalizeCloudDiagnosticPath(value) {
  return String(value || '').split('/').map((segment) => {
    if (/^[A-Fa-f0-9]{32,}$/.test(segment)) return ':hash';
    if (segment.length >= 16 && /^[A-Za-z0-9_-]+$/.test(segment)) return ':id';
    return segment;
  }).join('/').slice(0, 2_000);
}

async function handleRequest({ request, response, db, home, token, syncToken, emailCodeSecret, mailer, evolutionAuthority, employeeAuthority, stage8Authority, leadershipAuthority, workMemoryService }) {
  const url = new URL(request.url || '/', 'http://localhost');
  if (request.method === 'GET' && url.pathname === '/healthz') {
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, { ok: true, status: 'ok' });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/releases/latest') {
    const result = latestRelease(db, url.searchParams, home);
    audit(db, request.method, url.pathname, result.status === 'empty' ? 404 : 200);
    sendJson(response, result.status === 'empty' ? 404 : 200, result);
    return;
  }
  if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname.startsWith('/v1/releases/artifacts/')) {
    const name = decodeURIComponent(url.pathname.slice('/v1/releases/artifacts/'.length));
    await sendArtifact(response, home, name, { head: request.method === 'HEAD' });
    audit(db, request.method, url.pathname, 200);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/email-code') {
    const payload = await readJson(request);
    const purpose = normalizeCloudEmailPurpose(payload.purpose);
    const currentUser = ['password_change', 'organization_invitation_reset'].includes(purpose) ? requireCloudAuth(db, request) : null;
    const result = await sendCloudEmailCode({ db, payload: { ...payload, purpose }, currentUser, emailCodeSecret, mailer });
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/register') {
    const result = registerCloudUser(db, await readJson(request), { emailCodeSecret });
    audit(db, request.method, url.pathname, 201);
    sendJson(response, 201, result);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/login') {
    const result = loginCloudUser(db, await readJson(request));
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/refresh') {
    const result = refreshCloudSession(db, await readJson(request));
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    logoutCloudSession(db, await readJson(request));
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/password-reset') {
    const result = resetCloudUserPassword(db, await readJson(request), { emailCodeSecret });
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/auth/me') {
    const user = requireCloudAuth(db, request);
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, { user: cloudUserPayload(user) });
    return;
  }
  if (request.method === 'PATCH' && url.pathname === '/api/auth/profile') {
    const user = requireCloudAuth(db, request);
    const result = updateCloudUserProfile(db, user, await readJson(request));
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, { user: result });
    return;
  }
  if (request.method === 'PATCH' && url.pathname === '/api/auth/password') {
    const user = requireCloudAuth(db, request);
    updateCloudUserPassword(db, user, await readJson(request), { emailCodeSecret });
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/social/capabilities') {
    requireCloudAuth(db, request);
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, { capabilities: ['delegation-create-idempotency-v1', 'direct-delegation-files-v1', 'ubuddy-capability-profile-v1', 'agent-work-detail-projection-v1'] });
    return;
  }
  if (request.method === 'PUT' && url.pathname === '/api/social/ubuddy-profile') {
    const user = requireCloudAuth(db, request);
    const payload = await readJson(request);
    requireCloudUBuddyProfileCapability(request, url, payload);
    const result = publishCloudUBuddyCapabilityProfile(db, user.id, payload);
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/social/ubuddy-profile/unpublish') {
    const user = requireCloudAuth(db, request);
    const payload = await readJson(request);
    requireCloudUBuddyProfileCapability(request, url, payload);
    const result = unpublishCloudUBuddyCapabilityProfile(db, user.id, payload);
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/social/ubuddy-profile') {
    const user = requireCloudAuth(db, request);
    requireCloudUBuddyProfileCapability(request, url);
    const row = db.prepare(`SELECT * FROM social_ubuddy_capability_profiles
      WHERE owner_user_id=? AND publication_state='active'`).get(user.id);
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, { item: row ? safeCloudUBuddyProfilePayload(row, 'owner') : null });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/social/ubuddy-profiles/query') {
    const user = requireCloudAuth(db, request);
    const payload = await readJson(request);
    requireCloudUBuddyProfileCapability(request, url, payload);
    const result = queryCloudUBuddyCapabilityProfiles(db, user.id, payload);
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/friends/search') {
    const user = requireCloudAuth(db, request);
    const result = searchCloudUsers(db, user.id, url.searchParams.get('q') || '', url.searchParams.get('limit'));
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, { items: result });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/friends') {
    const user = requireCloudAuth(db, request);
    const result = cloudFriendsOverview(db, user.id);
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/friends/requests') {
    const user = requireCloudAuth(db, request);
    const result = createCloudFriendRequest(db, user.id, await readJson(request));
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  const friendRequestAction = url.pathname.match(/^\/api\/friends\/requests\/([^/]+)\/(accept|reject|cancel)$/);
  if (request.method === 'POST' && friendRequestAction) {
    const user = requireCloudAuth(db, request);
    const result = updateCloudFriendRequest(db, user.id, decodeURIComponent(friendRequestAction[1]), friendRequestAction[2]);
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  const friendDelete = url.pathname.match(/^\/api\/friends\/([^/]+)$/);
  if (request.method === 'PATCH' && friendDelete) {
    const user = requireCloudAuth(db, request);
    const result = updateCloudFriendRemark(db, user.id, decodeURIComponent(friendDelete[1]), await readJson(request));
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  if (request.method === 'DELETE' && friendDelete) {
    const user = requireCloudAuth(db, request);
    const result = removeCloudFriend(db, user.id, decodeURIComponent(friendDelete[1]));
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/friends/block') {
    const user = requireCloudAuth(db, request);
    const result = blockCloudUser(db, user.id, await readJson(request));
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/organizations') {
    const user = requireCloudAuth(db, request);
    const result = createCloudOrganization(db, user.id, await readJson(request));
    audit(db, request.method, url.pathname, 201);
    sendJson(response, 201, result);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/organizations/join') {
    const user = requireCloudAuth(db, request);
    const result = joinCloudOrganization(db, user.id, await readJson(request));
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  const organizationActionMatch = url.pathname.match(/^\/api\/organizations\/([^/]+)\/actions$/);
  if (request.method === 'POST' && organizationActionMatch) {
    const user = requireCloudAuth(db, request);
    const result = cloudOrganizationAction(db, user.id, {
      ...(await readJson(request)), organizationId: decodeURIComponent(organizationActionMatch[1]),
    }, { emailCodeSecret });
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/social/messages') {
    const user = requireCloudAuth(db, request);
    const result = listCloudSocialMessages(db, user.id, url.searchParams);
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/social/messages') {
    const user = requireCloudAuth(db, request);
    const result = createCloudSocialMessage(db, user.id, await readJson(request));
    audit(db, request.method, url.pathname, 201);
    sendJson(response, 201, result);
    return;
  }
  const messageUpdate = url.pathname.match(/^\/api\/social\/messages\/([^/]+)$/);
  if (request.method === 'PATCH' && messageUpdate) {
    const user = requireCloudAuth(db, request);
    const result = updateCloudSocialMessage(db, user.id, decodeURIComponent(messageUpdate[1]), await readJson(request));
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  const messageRead = url.pathname.match(/^\/api\/social\/messages\/([^/]+)\/read$/);
  if (request.method === 'POST' && messageRead) {
    const user = requireCloudAuth(db, request);
    const result = markCloudSocialMessageRead(db, user.id, decodeURIComponent(messageRead[1]), await readJson(request));
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/delegations') {
    const user = requireCloudAuth(db, request);
    const result = listCloudDelegations(db, user.id, url.searchParams);
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/delegations') {
    const user = requireCloudAuth(db, request);
    const result = createCloudDelegation(db, user.id, await readJson(request));
    audit(db, request.method, url.pathname, 201);
    sendJson(response, 201, result);
    return;
  }
  const delegationUpdate = url.pathname.match(/^\/api\/delegations\/([^/]+)$/);
  if (request.method === 'PATCH' && delegationUpdate) {
    const user = requireCloudAuth(db, request);
    const result = updateCloudDelegation(db, user.id, decodeURIComponent(delegationUpdate[1]), await readJson(request));
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  const delegationWorkspace = url.pathname.match(/^\/api\/delegations\/([^/]+)\/workspace$/);
  if (request.method === 'GET' && delegationWorkspace) {
    const user = requireCloudAuth(db, request);
    const result = cloudDelegationWorkspace(db, decodeURIComponent(delegationWorkspace[1]), user.id, url.searchParams.get('workspaceId'));
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  const delegationWorkspaceMessages = url.pathname.match(/^\/api\/delegations\/([^/]+)\/workspace\/messages$/);
  if (request.method === 'POST' && delegationWorkspaceMessages) {
    const user = requireCloudAuth(db, request);
    const result = createCloudDelegationWorkspaceMessage(db, decodeURIComponent(delegationWorkspaceMessages[1]), user.id, await readJson(request));
    audit(db, request.method, url.pathname, 201);
    sendJson(response, 201, result);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/collaboration') {
    const user = requireCloudAuth(db, request);
    const result = cloudCollaborationOverview(db, user.id, url.searchParams.get('workspaceId'));
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/collaboration/groups') {
    const user = requireCloudAuth(db, request);
    const result = createCloudCollaborationGroup(db, user.id, await readJson(request));
    const status = result.idempotent ? 200 : 201;
    audit(db, request.method, url.pathname, status);
    sendJson(response, status, result);
    return;
  }
  const collaborationGroupRoute = url.pathname.match(/^\/api\/collaboration\/groups\/([^/]+)$/);
  if (request.method === 'GET' && collaborationGroupRoute) {
    const user = requireCloudAuth(db, request);
    const result = cloudCollaborationGroupDetail(db, decodeURIComponent(collaborationGroupRoute[1]), user.id, { markRead: true, workspaceId: url.searchParams.get('workspaceId') });
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  if (request.method === 'PATCH' && collaborationGroupRoute) {
    const user = requireCloudAuth(db, request);
    const result = updateCloudCollaborationGroup(db, decodeURIComponent(collaborationGroupRoute[1]), user.id, await readJson(request));
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  const collaborationMessageRoute = url.pathname.match(/^\/api\/collaboration\/groups\/([^/]+)\/messages$/);
  if (request.method === 'POST' && collaborationMessageRoute) {
    const user = requireCloudAuth(db, request);
    const payload = await readJson(request);
    const result = createCloudCollaborationMessage(db, decodeURIComponent(collaborationMessageRoute[1]), user.id, payload);
    const status = cloudJsonObject(payload.metadata).routingConfirmationFor ? 200 : 201;
    audit(db, request.method, url.pathname, status);
    sendJson(response, status, result);
    return;
  }
  const collaborationTaskActionRoute = url.pathname.match(/^\/api\/collaboration\/tasks\/([^/]+)\/action$/);
  if (request.method === 'POST' && collaborationTaskActionRoute) {
    const user = requireCloudAuth(db, request);
    const result = applyCloudCollaborationTaskAction(db, decodeURIComponent(collaborationTaskActionRoute[1]), user.id, await readJson(request));
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  const collaborationGroupWorkspaceRoute = url.pathname.match(/^\/api\/collaboration\/groups\/([^/]+)\/workspace$/);
  if (request.method === 'GET' && collaborationGroupWorkspaceRoute) {
    const user = requireCloudAuth(db, request);
    const result = cloudCollaborationGroupWorkspace(db, decodeURIComponent(collaborationGroupWorkspaceRoute[1]), user.id, {
      sinceRevision: Number(url.searchParams.get('sinceRevision') || 0),
      workspaceId: url.searchParams.get('workspaceId'),
    });
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  const collaborationGroupWorkspaceFileRoute = url.pathname.match(/^\/api\/collaboration\/groups\/([^/]+)\/workspace\/files\/([^/]+)$/);
  if (request.method === 'PUT' && collaborationGroupWorkspaceFileRoute) {
    const user = requireCloudAuth(db, request);
    const result = storeCloudCollaborationGroupWorkspaceFile(db, {
      groupId: decodeURIComponent(collaborationGroupWorkspaceFileRoute[1]),
      fileId: decodeURIComponent(collaborationGroupWorkspaceFileRoute[2]),
      userId: user.id,
      workspaceId: request.headers['x-janus-workspace-id'],
      headers: request.headers,
      data: await readBody(request),
    });
    audit(db, request.method, url.pathname, result.created ? 201 : 200);
    sendJson(response, result.created ? 201 : 200, { ok: true, file: result.file });
    return;
  }
  if (request.method === 'DELETE' && collaborationGroupWorkspaceFileRoute) {
    const user = requireCloudAuth(db, request);
    const result = deleteCloudCollaborationGroupWorkspaceFile(db, {
      groupId: decodeURIComponent(collaborationGroupWorkspaceFileRoute[1]),
      fileId: decodeURIComponent(collaborationGroupWorkspaceFileRoute[2]),
      userId: user.id,
      workspaceId: url.searchParams.get('workspaceId'),
      baseRevision: Number(url.searchParams.get('baseRevision') || 0),
    });
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  if (request.method === 'GET' && collaborationGroupWorkspaceFileRoute) {
    const user = requireCloudAuth(db, request);
    const file = cloudCollaborationGroupWorkspaceFileForUser(
      db,
      decodeURIComponent(collaborationGroupWorkspaceFileRoute[1]),
      decodeURIComponent(collaborationGroupWorkspaceFileRoute[2]),
      user.id,
      url.searchParams.get('workspaceId'),
    );
    response.writeHead(200, {
      'content-type': file.content_type || 'application/octet-stream',
      'content-length': file.data.length,
      'content-disposition': cloudCollaborationContentDisposition(file.filename),
      'x-janus-file-sha256': file.sha256 || '',
    });
    response.end(file.data);
    audit(db, request.method, url.pathname, 200);
    return;
  }
  const collaborationFileUploadRoute = url.pathname.match(/^\/api\/collaboration\/tasks\/([^/]+)\/files\/([^/]+)$/);
  if (request.method === 'PUT' && collaborationFileUploadRoute) {
    const user = requireCloudAuth(db, request);
    const result = storeCloudCollaborationFile(db, {
      delegationId: decodeURIComponent(collaborationFileUploadRoute[1]),
      fileId: decodeURIComponent(collaborationFileUploadRoute[2]),
      userId: user.id,
      workspaceId: request.headers['x-janus-workspace-id'],
      headers: request.headers,
      data: await readBody(request),
    });
    audit(db, request.method, url.pathname, result.created ? 201 : 200);
    sendJson(response, result.created ? 201 : 200, { ok: true, attachment: result.attachment });
    return;
  }
  const collaborationFileDownloadRoute = url.pathname.match(/^\/api\/collaboration\/files\/([^/]+)$/);
  if (request.method === 'GET' && collaborationFileDownloadRoute) {
    const user = requireCloudAuth(db, request);
    const file = cloudCollaborationFileForUser(db, decodeURIComponent(collaborationFileDownloadRoute[1]), user.id, url.searchParams.get('workspaceId'));
    response.writeHead(200, {
      'content-type': file.content_type || 'application/octet-stream',
      'content-length': file.data.length,
      'content-disposition': cloudCollaborationContentDisposition(file.filename),
      'x-janus-file-sha256': file.sha256 || '',
    });
    response.end(file.data);
    audit(db, request.method, url.pathname, 200);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/work-memory/publications') {
    const user = requireCloudAuth(db, request);
    const result = workMemoryService.publish({ userId: user.id, payload: await readJson(request) });
    audit(db, request.method, url.pathname, 201);
    sendJson(response, 201, result);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/work-memory/appointments') {
    const user = requireCloudAuth(db, request);
    const result = workMemoryService.appoint({ userId: user.id, payload: await readJson(request) });
    audit(db, request.method, url.pathname, 201);
    sendJson(response, 201, result);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/work-memory/appointments/revoke') {
    const user = requireCloudAuth(db, request);
    const result = workMemoryService.revoke({ userId: user.id, payload: await readJson(request) });
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/work-memory/read') {
    const user = requireCloudAuth(db, request);
    const result = workMemoryService.read({ userId: user.id, payload: await readJson(request) });
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/presence/heartbeat') {
    const user = requireCloudAuth(db, request);
    const result = updateCloudPresence(db, user.id, await readJson(request));
    audit(db, request.method, url.pathname, 200);
    sendJson(response, 200, result);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/evolution/grants') {
    const user = requireCloudAuth(db, request);
    const result = evolutionAuthority.issueGrant({ ...(await readJson(request)), userId: user.id });
    sendJson(response, 201, result);
    audit(db, request.method, url.pathname, 201);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/evolution/grants') {
    const user = requireCloudAuth(db, request);
    sendJson(response, 200, { items: evolutionAuthority.listGrants({ userId: user.id }) });
    audit(db, request.method, url.pathname, 200);
    return;
  }
  const evolutionGrantRoute = url.pathname.match(/^\/api\/evolution\/grants\/([^/]+)$/);
  if (request.method === 'DELETE' && evolutionGrantRoute) {
    const user = requireCloudAuth(db, request);
    const result = evolutionAuthority.revokeGrant({ userId: user.id, deviceId: decodeURIComponent(evolutionGrantRoute[1]) });
    sendJson(response, 200, result);
    audit(db, request.method, url.pathname, 200);
    return;
  }
  const adminAuthorized = isBearerAuthorized(request, token);
  const syncAuthorized = adminAuthorized || (Boolean(syncToken) && isBearerAuthorized(request, syncToken));
  if (request.method === 'GET' && url.pathname === '/v1/admin/upload-compliance') {
    if (!adminAuthorized) {
      audit(db, request.method, url.pathname, 401, 'unauthorized');
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }
    sendJson(response, 200, { items: listUploadCompliance(db, url.searchParams) });
    audit(db, request.method, url.pathname, 200);
    return;
  }
  const adminUserSuspensionRoute = url.pathname.match(/^\/v1\/admin\/users\/([^/]+)\/(suspend|reactivate)$/);
  if (request.method === 'POST' && adminUserSuspensionRoute) {
    if (!adminAuthorized) {
      audit(db, request.method, url.pathname, 401, 'unauthorized');
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }
    const payload = await readJson(request).catch(() => ({}));
    const userId = decodeURIComponent(adminUserSuspensionRoute[1]);
    const result = adminUserSuspensionRoute[2] === 'reactivate'
      ? reactivateCloudUser(db, { userId, reason: payload.reason || 'manual_reactivation' })
      : suspendCloudUser(db, { userId, reason: payload.reason || 'manual_suspension' });
    sendJson(response, 200, result);
    audit(db, request.method, url.pathname, 200);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/evolution/grants') {
    const legacyGrantBootstrap = ['1', 'true', 'yes', 'on'].includes(String(process.env.JANUS_EVOLUTION_ALLOW_LEGACY_GRANT_BOOTSTRAP || '').toLowerCase());
    if (!adminAuthorized && !(legacyGrantBootstrap && syncAuthorized)) {
      audit(db, request.method, url.pathname, 401, 'unauthorized');
      sendJson(response, 401, { error: { code: 'unauthorized', message: 'Evolution grant bootstrap requires sync authorization.' } });
      return;
    }
    const payload = await readJson(request);
    ensureLegacyCloudUser(db, payload.userId || payload.user_id || '');
    const result = evolutionAuthority.issueGrant(payload);
    sendJson(response, 201, result);
    audit(db, request.method, url.pathname, 201);
    return;
  }
  if (url.pathname === '/v1/employees' || url.pathname === '/v1/employees/capabilities'
      || url.pathname === '/v1/employees/bootstrap' || url.pathname === '/v1/employees/commands'
      || url.pathname === '/v1/employees/events') {
    const grant = evolutionAuthority.requireGrant(bearerToken(request), request.method === 'GET'
      ? ['employees:read', 'evolution:read'] : ['employees:write', 'evolution:write']);
    if (request.method === 'GET' && url.pathname === '/v1/employees/capabilities') {
      sendJson(response, 200, employeeAuthority.capabilities());
      audit(db, request.method, url.pathname, 200);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/employees') {
      sendJson(response, 200, employeeAuthority.overview({ userId: grant.userId }));
      audit(db, request.method, url.pathname, 200);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/employees/commands') {
      const result = employeeAuthority.command({ userId: grant.userId, deviceId: grant.deviceId, payload: await readJson(request) });
      sendJson(response, result.status === 'rejected' ? 409 : 200, result);
      audit(db, request.method, url.pathname, result.status === 'rejected' ? 409 : 200);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/employees/bootstrap') {
      const result = employeeAuthority.bootstrap({ userId: grant.userId, deviceId: grant.deviceId, payload: await readJson(request) });
      sendJson(response, result.idempotent ? 200 : 201, result);
      audit(db, request.method, url.pathname, result.idempotent ? 200 : 201);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/employees/events') {
      sendJson(response, 200, { authority: 'cloud', items: employeeAuthority.events({ userId: grant.userId, cursor: url.searchParams.get('cursor') || '', limit: url.searchParams.get('limit') || 100 }) });
      audit(db, request.method, url.pathname, 200);
      return;
    }
  }
  if (url.pathname.startsWith('/v1/evolution/')) {
    if (request.method === 'POST' && url.pathname === '/v1/evolution/worker/tick') {
      if (!adminAuthorized) {
        sendJson(response, 401, { error: { code: 'unauthorized', message: 'Worker control requires cloud administration authorization.' } });
        return;
      }
      const result = await evolutionAuthority.tickWorker(await readJson(request));
      const performance = stage8Authority.calculateAllPerformance();
      const leadershipBackfill = leadershipAuthority.backfillTaskHistory();
      const leadership = leadershipAuthority.calculateAll({ migrationBackfill: leadershipBackfill.inserted > 0 });
      const health = [];
      for (const snapshot of performance) {
        const instance = db.prepare('SELECT user_id,active_personal_skill_version_id FROM cloud_user_agent_instances_v3 WHERE id=?').get(snapshot.agentInstanceId);
        if (!instance?.active_personal_skill_version_id) continue;
        health.push(evolutionAuthority.evaluateVersionHealth({
          userId: instance.user_id,
          agentInstanceId: snapshot.agentInstanceId,
          score: snapshot.score,
          failureRate: snapshot.failureRate,
          completedTaskCount: snapshot.completedTaskCount,
          inputHash: snapshot.inputHash,
        }));
      }
      const marketHealth = stage8Authority.evaluateMarketHealth();
      const canary = stage8Authority.reconcileMarketCanaries();
      let stage8 = { status: 'unavailable', code: stage8Authority.capabilities().cluster.code,
        performanceCount: performance.length, leadershipCount: leadership.length, leadershipBackfill, health, marketHealth, canary };
      if (stage8Authority.capabilities().cluster.executionAvailable) {
        const cohorts = stage8Authority.refreshCohorts({ refreshPerformance: false });
        const scheduled = [];
        for (const cohort of stage8Authority.cohorts()) scheduled.push(stage8Authority.requestClusterRun({ cohortId: cohort.id, triggerKind: 'scheduled' }));
        const cluster = await stage8Authority.tickClusterWorker({ limit: 5 });
        stage8 = { status: 'ok', performanceCount: performance.length, leadershipCount: leadership.length, leadershipBackfill, health, marketHealth, canary,
          cohortCount: cohorts.filter((item) => item.eligible).length, scheduled, cluster };
      }
      sendJson(response, 200, { ...result, stage8 });
      audit(db, request.method, url.pathname, 200);
      return;
    }
    const grant = evolutionAuthority.requireGrant(bearerToken(request), request.method === 'GET' ? 'evolution:read' : 'evolution:write');
    if (request.method === 'GET' && url.pathname === '/v1/evolution/capabilities') {
      sendJson(response, 200, { ...evolutionAuthority.capabilities(), ...stage8Authority.capabilities(), leadership: leadershipAuthority.capabilities() });
      audit(db, request.method, url.pathname, 200);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/evolution/preferences') {
      sendJson(response, 200, evolutionAuthority.preference(grant));
      audit(db, request.method, url.pathname, 200);
      return;
    }
    if (request.method === 'PATCH' && url.pathname === '/v1/evolution/preferences') {
      const result = evolutionAuthority.setPreference(grant, await readJson(request));
      sendJson(response, result.status === 'conflict' ? 409 : 200, result);
      audit(db, request.method, url.pathname, result.status === 'conflict' ? 409 : 200);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/evolution/evidence/batch') {
      const payload = await readJson(request);
      const result = evolutionAuthority.ingestEvidence(grant, payload.items || []);
      sendJson(response, 200, result);
      audit(db, request.method, url.pathname, 200);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/evolution/evidence/counts') {
      const result = evolutionAuthority.evidenceCounts(grant, { agentInstanceId: url.searchParams.get('agentInstanceId') || '' });
      sendJson(response, 200, result);
      audit(db, request.method, url.pathname, 200);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/evolution/evidence/usage') {
      const result = evolutionAuthority.listEvidenceUsage(grant, {
        agentInstanceId:url.searchParams.get('agentInstanceId')||'',scope:url.searchParams.get('scope')||'',
        status:url.searchParams.get('status')||'',cursor:url.searchParams.get('cursor')||'',limit:url.searchParams.get('limit')||50,
      });
      sendJson(response,200,result);audit(db,request.method,url.pathname,200);return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/evolution/personal/schedule') {
      const agentInstanceId = url.searchParams.get('agentInstanceId') || '';
      const result = agentInstanceId
        ? evolutionAuthority.personalSchedule(grant, { agentInstanceId })
        : { authority: 'cloud', items: evolutionAuthority.listPersonalSchedules(grant) };
      sendJson(response, 200, result);
      audit(db, request.method, url.pathname, 200);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/evolution/personal/runs') {
      const result = evolutionAuthority.requestPersonalRun(grant, await readJson(request));
      sendJson(response, result.status === 'unavailable' ? 503 : 202, result);
      audit(db, request.method, url.pathname, result.status === 'unavailable' ? 503 : 202);
      if (result.status === 'queued') queueMicrotask(() => evolutionAuthority.tickWorker({ limit: 1 }).catch(() => {}));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/evolution/personal/runs') {
      const result = evolutionAuthority.listRuns(grant, {
        agentInstanceId: url.searchParams.get('agentInstanceId') || '', limit: url.searchParams.get('limit') || 30,
      });
      sendJson(response, 200, { authority: 'cloud', items: result });
      audit(db, request.method, url.pathname, 200);
      return;
    }
    const runRoute = url.pathname.match(/^\/v1\/evolution\/personal\/runs\/([^/]+)$/);
    if (request.method === 'GET' && runRoute) {
      sendJson(response, 200, evolutionAuthority.getRun(grant, decodeURIComponent(runRoute[1])));
      audit(db, request.method, url.pathname, 200);
      return;
    }
    const runDecisionRoute = url.pathname.match(/^\/v1\/evolution\/personal\/runs\/([^/]+)\/decisions$/);
    if (request.method === 'POST' && runDecisionRoute) {
      const result = evolutionAuthority.decidePersonalRun(grant, {
        ...(await readJson(request)), runId: decodeURIComponent(runDecisionRoute[1]),
      });
      sendJson(response, result.status === 'conflict' ? 409 : 200, result);
      audit(db, request.method, url.pathname, result.status === 'conflict' ? 409 : 200);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/evolution/personal/versions') {
      const items = evolutionAuthority.listVersions(grant, { agentInstanceId: url.searchParams.get('agentInstanceId') || '' });
      sendJson(response, 200, { authority: 'cloud', items });
      audit(db, request.method, url.pathname, 200);
      return;
    }
    const personalVersionActivateRoute = url.pathname.match(/^\/v1\/evolution\/personal\/versions\/([^/]+)\/activate$/);
    if (request.method === 'POST' && personalVersionActivateRoute) {
      const result = evolutionAuthority.activatePersonalVersion(grant, {
        ...(await readJson(request)), targetVersionId: decodeURIComponent(personalVersionActivateRoute[1]),
      });
      sendJson(response, result.status === 'conflict' ? 409 : 200, result);
      audit(db, request.method, url.pathname, result.status === 'conflict' ? 409 : 200);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/evolution/personal/rollback') {
      const result = evolutionAuthority.rollbackPersonalVersion(grant, await readJson(request));
      sendJson(response, result.status === 'conflict' ? 409 : 200, result);
      audit(db, request.method, url.pathname, result.status === 'conflict' ? 409 : 200);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/evolution/updates') {
      sendJson(response, 200, evolutionAuthority.updates(grant, { stage8: stage8Authority }));
      audit(db, request.method, url.pathname, 200);
      return;
    }
    const performanceRoute = url.pathname.match(/^\/v1\/evolution\/performance\/([^/]+)$/);
    if (request.method === 'POST' && url.pathname === '/v1/evolution/performance/events') {
      const payload = await readJson(request);
      const items = (Array.isArray(payload.items) ? payload.items : []).map((item) => {
        const instance = db.prepare('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=? AND id=?').get(grant.userId, item.agentInstanceId || '');
        if (!instance) throw cloudApiError('agent_instance_not_found', 'Performance event Agent instance does not belong to the granted user.', 404);
        return { ...item, ownerUserId: grant.userId, agentInstanceId: instance.id, agentFamilyId: instance.agent_family_id };
      });
      const result = stage8Authority.recordPerformanceEvents(items);
      const levels = [...new Set(items.map((item) => item.agentInstanceId))].map((agentInstanceId) => stage8Authority.calculatePerformance({ agentInstanceId }));
      sendJson(response, 200, { ...result, levels });
      audit(db, request.method, url.pathname, 200);
      return;
    }
    if (request.method === 'GET' && performanceRoute) {
      const instanceId = decodeURIComponent(performanceRoute[1]);
      requireGrantedInstance(db, grant, instanceId);
      sendJson(response, 200, { authority: 'cloud', item: stage8Authority.performance({ agentInstanceId: instanceId }) });
      audit(db, request.method, url.pathname, 200);
      return;
    }
    const performanceHistoryRoute = url.pathname.match(/^\/v1\/evolution\/performance\/([^/]+)\/history$/);
    if (request.method === 'GET' && performanceHistoryRoute) {
      const instanceId = decodeURIComponent(performanceHistoryRoute[1]);
      requireGrantedInstance(db, grant, instanceId);
      sendJson(response, 200, { authority: 'cloud', items: stage8Authority.performanceHistory({ agentInstanceId: instanceId, limit: url.searchParams.get('limit') || 30 }) });
      audit(db, request.method, url.pathname, 200);
      return;
    }
    if (request.method === 'POST' && performanceRoute) {
      const instanceId = decodeURIComponent(performanceRoute[1]);
      requireGrantedInstance(db, grant, instanceId);
      sendJson(response, 200, { authority: 'cloud', item: stage8Authority.calculatePerformance({ agentInstanceId: instanceId }) });
      audit(db, request.method, url.pathname, 200);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/evolution/leadership/events') {
      const payload = await readJson(request);
      const items = (Array.isArray(payload.items) ? payload.items : []).map((item) => {
        const instance = requireGrantedInstance(db, grant, item.agentInstanceId || '');
        return { ...item, ownerUserId: grant.userId, agentInstanceId: instance.id, agentFamilyId: instance.agent_family_id };
      });
      sendJson(response, 200, leadershipAuthority.recordEvents(items));
      audit(db, request.method, url.pathname, 200);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/evolution/leadership/evaluations') {
      const payload = await readJson(request);
      const instance = requireGrantedInstance(db, grant, payload.agentInstanceId || '');
      const evaluation = await leadershipAuthority.evaluateTask({ ...payload, governanceReview: undefined, trustedGovernanceReview: false,
        ownerUserId: grant.userId, agentInstanceId: instance.id });
      const level = leadershipAuthority.calculate({ agentInstanceId: instance.id });
      sendJson(response, 200, { authority: 'cloud', evaluation, level });
      audit(db, request.method, url.pathname, 200);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/evolution/leadership/actions') {
      const instanceId = url.searchParams.get('agentInstanceId') || '';
      if (instanceId) requireGrantedInstance(db, grant, instanceId);
      const actorRole = db.prepare('SELECT role FROM users WHERE id=?').get(grant.userId)?.role || 'member';
      sendJson(response, 200, { authority: 'cloud', items: leadershipAuthority.actions({ ownerUserId: grant.userId, actorRole,
        agentInstanceId, status: url.searchParams.get('status') || '', limit: url.searchParams.get('limit') || 50 }) });
      audit(db, request.method, url.pathname, 200);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/evolution/leadership/trials') {
      const payload = await readJson(request);
      const instance = requireGrantedInstance(db, grant, payload.agentInstanceId || '');
      sendJson(response, 200, leadershipAuthority.requestTrial({ ...payload, ownerUserId: grant.userId, agentInstanceId: instance.id }));
      audit(db, request.method, url.pathname, 200);
      return;
    }
    const leadershipDecisionRoute = url.pathname.match(/^\/v1\/evolution\/leadership\/actions\/([^/]+)\/decisions$/);
    if (request.method === 'POST' && leadershipDecisionRoute) {
      const actorRole = db.prepare('SELECT role FROM users WHERE id=?').get(grant.userId)?.role || 'member';
      sendJson(response, 200, leadershipAuthority.decideAction({ ...(await readJson(request)), actorUserId: grant.userId, actorRole,
        actionId: decodeURIComponent(leadershipDecisionRoute[1]) }));
      audit(db, request.method, url.pathname, 200);
      return;
    }
    const leadershipRestoreRoute = url.pathname.match(/^\/v1\/evolution\/leadership\/([^/]+)\/restore$/);
    if (request.method === 'POST' && leadershipRestoreRoute) {
      const instanceId = decodeURIComponent(leadershipRestoreRoute[1]);
      requireGrantedInstance(db, grant, instanceId);
      sendJson(response, 200, leadershipAuthority.restore({ ...(await readJson(request)), ownerUserId: grant.userId, agentInstanceId: instanceId }));
      audit(db, request.method, url.pathname, 200);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/evolution/leadership/appeals') {
      const actorRole = db.prepare('SELECT role FROM users WHERE id=?').get(grant.userId)?.role || 'member';
      const instanceId = url.searchParams.get('agentInstanceId') || '';
      if (instanceId) requireGrantedInstance(db, grant, instanceId);
      sendJson(response, 200, { authority: 'cloud', items: leadershipAuthority.appeals({ ownerUserId: grant.userId, actorRole,
        agentInstanceId: instanceId, status: url.searchParams.get('status') || '', limit: url.searchParams.get('limit') || 50 }) });
      audit(db, request.method, url.pathname, 200);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/evolution/leadership/appeals') {
      const payload = await readJson(request);
      const instance = requireGrantedInstance(db, grant, payload.agentInstanceId || '');
      sendJson(response, 200, leadershipAuthority.submitAppeal({ ...payload, ownerUserId: grant.userId, agentInstanceId: instance.id }));
      audit(db, request.method, url.pathname, 200);
      return;
    }
    const leadershipAppealDecisionRoute = url.pathname.match(/^\/v1\/evolution\/leadership\/appeals\/([^/]+)\/decisions$/);
    if (request.method === 'POST' && leadershipAppealDecisionRoute) {
      const actorRole = db.prepare('SELECT role FROM users WHERE id=?').get(grant.userId)?.role || 'member';
      sendJson(response, 200, leadershipAuthority.decideAppeal({ ...(await readJson(request)), actorUserId: grant.userId, actorRole,
        appealId: decodeURIComponent(leadershipAppealDecisionRoute[1]) }));
      audit(db, request.method, url.pathname, 200);
      return;
    }
    const leadershipHistoryRoute = url.pathname.match(/^\/v1\/evolution\/leadership\/([^/]+)\/history$/);
    if (request.method === 'GET' && leadershipHistoryRoute) {
      const instanceId = decodeURIComponent(leadershipHistoryRoute[1]);
      requireGrantedInstance(db, grant, instanceId);
      sendJson(response, 200, { authority: 'cloud', items: leadershipAuthority.history({ agentInstanceId: instanceId, limit: url.searchParams.get('limit') || 30 }) });
      audit(db, request.method, url.pathname, 200);
      return;
    }
    const leadershipRoute = url.pathname.match(/^\/v1\/evolution\/leadership\/([^/]+)$/);
    if (request.method === 'GET' && leadershipRoute) {
      const instanceId = decodeURIComponent(leadershipRoute[1]);
      requireGrantedInstance(db, grant, instanceId);
      sendJson(response, 200, { authority: 'cloud', item: leadershipAuthority.status({ agentInstanceId: instanceId }) || leadershipAuthority.calculate({ agentInstanceId: instanceId }) });
      audit(db, request.method, url.pathname, 200);
      return;
    }
    if (request.method === 'POST' && leadershipRoute) {
      const instanceId = decodeURIComponent(leadershipRoute[1]);
      requireGrantedInstance(db, grant, instanceId);
      sendJson(response, 200, { authority: 'cloud', item: leadershipAuthority.calculate({ agentInstanceId: instanceId }) });
      audit(db, request.method, url.pathname, 200);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/evolution/cluster/status') {
      sendJson(response, 200, stage8Authority.capabilities().cluster);
      audit(db, request.method, url.pathname, 200);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/evolution/cluster/cohorts') {
      sendJson(response, 200, { authority: 'cloud', items: stage8Authority.cohorts({ includeIneligible: url.searchParams.get('includeIneligible') === '1' }).map(publicCohort) });
      audit(db, request.method, url.pathname, 200);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/evolution/cluster/runs') {
      const rows = db.prepare("SELECT * FROM cloud_evolution_runs WHERE evolution_scope='cluster' ORDER BY created_at DESC LIMIT ?").all(Math.min(100, Number(url.searchParams.get('limit') || 30)));
      sendJson(response, 200, { authority: 'cloud', items: rows.map(publicClusterRun) });
      audit(db, request.method, url.pathname, 200);
      return;
    }
    if (request.method === 'POST' && url.pathname.startsWith('/v1/evolution/cluster/')) throw cloudApiError('cluster_run_admin_only', 'Cluster mutation is performed only by the cloud scheduler.', 403);
    if (request.method === 'GET' && url.pathname === '/v1/evolution/market/status') {
      sendJson(response, 200, stage8Authority.capabilities().market);
      audit(db, request.method, url.pathname, 200);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/evolution/market/candidates') {
      sendJson(response, 200, { authority: 'cloud', items: stage8Authority.candidates({ familyId: url.searchParams.get('familyId') || '' }) });
      audit(db, request.method, url.pathname, 200);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/evolution/market/versions') {
      const agentInstanceId = url.searchParams.get('agentInstanceId') || '';
      if (agentInstanceId) requireGrantedInstance(db, grant, agentInstanceId);
      sendJson(response, 200, { authority: 'cloud', items: stage8Authority.marketVersions({ familyId: url.searchParams.get('familyId') || '',
        userId: grant.userId, agentInstanceId }) });
      audit(db, request.method, url.pathname, 200);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/evolution/market/canary') {
      const agentInstanceId=url.searchParams.get('agentInstanceId')||'';
      requireGrantedInstance(db,grant,agentInstanceId);
      sendJson(response,200,stage8Authority.canaryStatus({userId:grant.userId,agentInstanceId}));
      audit(db,request.method,url.pathname,200);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/evolution/market/canary/opt-in') {
      const payload=await readJson(request);const agentInstanceId=String(payload.agentInstanceId||'');
      requireGrantedInstance(db,grant,agentInstanceId);
      sendJson(response,200,stage8Authority.setCanaryOptIn({userId:grant.userId,agentInstanceId,
        enabled:payload.enabled!==false,commandId:payload.commandId||''}));
      audit(db,request.method,url.pathname,200);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/evolution/market/adoptions') {
      const payload = await readJson(request);
      const result = stage8Authority.adopt({ ...payload, userId: grant.userId, action: 'adopt' });
      sendJson(response, 200, result);
      audit(db, request.method, url.pathname, 200);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/evolution/market/adoptions/rollback') {
      const payload = await readJson(request);
      const result = stage8Authority.adopt({ ...payload, userId: grant.userId, action: 'rollback' });
      sendJson(response, 200, result);
      audit(db, request.method, url.pathname, 200);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/evolution/market/adoptions/ignore') {
      const payload = await readJson(request);
      const result = stage8Authority.adopt({ ...payload, userId: grant.userId, action: 'ignore' });
      sendJson(response, 200, result);
      audit(db, request.method, url.pathname, 200);
      return;
    }
    const effectiveSkillRoute = url.pathname.match(/^\/v1\/evolution\/market\/effective-skill\/([^/]+)$/);
    if (request.method === 'GET' && effectiveSkillRoute) {
      const instanceId = decodeURIComponent(effectiveSkillRoute[1]);
      requireGrantedInstance(db, grant, instanceId);
      sendJson(response, 200, { authority: 'cloud', item: stage8Authority.effectiveSkill({ userId: grant.userId, agentInstanceId: instanceId }) });
      audit(db, request.method, url.pathname, 200);
      return;
    }
    sendJson(response, 404, { error: { code: 'evolution_route_not_found', message: 'Evolution route was not found.' } });
    audit(db, request.method, url.pathname, 404);
    return;
  }
  const syncIngestRoute = (
    (request.method === 'GET' && url.pathname === '/v1/sync/status')
    || (request.method === 'POST' && url.pathname === '/v1/sync/batches')
    || (request.method === 'GET' && url.pathname === '/v1/sync/v3/identity')
    || (request.method === 'GET' && url.pathname === '/v1/sync/v4/personal-evolution')
    || (request.method === 'POST' && url.pathname === '/v1/sync/v4/personal-evolution/decisions')
    || (request.method === 'PUT' && url.pathname.startsWith('/v1/files/'))
  );
  if (syncIngestRoute && !syncAuthorized) {
    audit(db, request.method, url.pathname, 401, 'unauthorized');
    sendJson(response, 401, { error: 'unauthorized' });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/sync/status') {
    sendJson(response, 200, syncStatus(db));
    audit(db, request.method, url.pathname, 200);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/sync/batches') {
    const payload = await readJson(request);
    requireLegacySyncUserActive(db, payload?.device?.userId || payload?.device?.user_id || payload?.userId || payload?.user_id || '');
    const result = recordBatch(db, payload);
    const uploadCompliance = recordLegacySyncUploadCompliance(db, payload);
    sendJson(response, 200, { ...result, uploadCompliance });
    audit(db, request.method, url.pathname, 200);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/sync/v3/identity') {
    requireLegacySyncUserActive(db, url.searchParams.get('userId') || '', { createIfMissing: false });
    const result = identitySnapshot(db, {
      userId: url.searchParams.get('userId') || '',
      cursor: url.searchParams.get('cursor') || '',
    });
    sendJson(response, 200, result);
    audit(db, request.method, url.pathname, 200);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/sync/v4/personal-evolution') {
    requireLegacySyncUserActive(db, url.searchParams.get('userId') || '', { createIfMissing: false });
    const result = personalEvolutionSnapshot(db, {
      userId: url.searchParams.get('userId') || '', cursor: url.searchParams.get('cursor') || '',
    });
    sendJson(response, 200, result);
    audit(db, request.method, url.pathname, 200);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/sync/v4/personal-evolution/decisions') {
    const payload = await readJson(request);
    requireLegacySyncUserActive(db, payload.userId || payload.user_id || '', { createIfMissing: false });
    const result = decidePersonalEvolution(db, payload);
    sendJson(response, 200, result);
    audit(db, request.method, url.pathname, 200);
    return;
  }
  if (request.method === 'PUT' && url.pathname.startsWith('/v1/files/')) {
    const sha256 = decodeURIComponent(url.pathname.slice('/v1/files/'.length));
    const result = await storeFile({ db, home, request, sha256 });
    sendJson(response, 200, result);
    audit(db, request.method, url.pathname, 200);
    return;
  }
  if (!adminAuthorized) {
    audit(db, request.method, url.pathname, 401, 'unauthorized');
    sendJson(response, 401, { error: 'unauthorized' });
    return;
  }
  if (request.method === 'GET' && url.pathname.startsWith('/v1/trace/files/')) {
    const sha256 = decodeURIComponent(url.pathname.slice('/v1/trace/files/'.length));
    const result = traceFile(db, sha256, url.searchParams);
    sendJson(response, result.status === 'not_found' ? 404 : result.status === 'invalid' ? 400 : 200, result);
    audit(db, request.method, url.pathname, result.status === 'not_found' ? 404 : result.status === 'invalid' ? 400 : 200);
    return;
  }
  if (request.method === 'GET' && url.pathname.startsWith('/v1/conversations/')) {
    const conversationId = decodeURIComponent(url.pathname.slice('/v1/conversations/'.length));
    const result = traceConversation(db, conversationId, url.searchParams);
    sendJson(response, result.status === 'not_found' ? 404 : result.status === 'invalid' ? 400 : 200, result);
    audit(db, request.method, url.pathname, result.status === 'not_found' ? 404 : result.status === 'invalid' ? 400 : 200);
    return;
  }
  if (request.method === 'GET' && url.pathname.startsWith('/v1/files/')) {
    const sha256 = decodeURIComponent(url.pathname.slice('/v1/files/'.length));
    const result = storedFileForUser(db, sha256, url.searchParams);
    if (result.status !== 'ok') {
      sendJson(response, result.status === 'not_found' ? 404 : 400, result);
      audit(db, request.method, url.pathname, result.status === 'not_found' ? 404 : 400);
      return;
    }
    await sendFileResponse(response, result.storagePath, { filename: result.filename });
    audit(db, request.method, url.pathname, 200);
    return;
  }
  audit(db, request.method, url.pathname, 404, 'not_found');
  sendJson(response, 404, { error: 'not_found' });
}

function publishCloudUBuddyCapabilityProfile(db, ownerUserId = '', payload = {}) {
  const commandId = String(payload.commandId || '').trim().slice(0, 200);
  if (!commandId) throw cloudApiError('ubuddy_profile_command_required', '缺少简介发布命令标识。', 400);
  const profile = normalizeCloudPublishedUBuddyProfile(payload.profile, ownerUserId);
  const expectedStateRevision = cloudUBuddyNonNegativeRevision(payload.expectedStateRevision);
  const contentHash = cloudStableRequestHash(profile);
  const payloadHash = cloudStableRequestHash({ operation: 'publish', ownerUserId, expectedStateRevision, profile });
  return withImmediateCloudTransaction(db, () => {
    const prior = db.prepare('SELECT * FROM social_ubuddy_capability_profile_commands WHERE command_id=?').get(commandId);
    if (prior) {
      if (prior.owner_user_id !== ownerUserId || prior.operation_kind !== 'publish' || prior.payload_hash !== payloadHash) {
        throw cloudApiError('ubuddy_profile_idempotency_conflict', '简介发布命令已被不同请求占用。', 409);
      }
      return cloudJsonObject(prior.response_json);
    }
    const active = db.prepare(`SELECT * FROM social_ubuddy_capability_profiles
      WHERE owner_user_id=? AND publication_state='active'`).get(ownerUserId);
    const currentStateRevision = Number(db.prepare(`SELECT COALESCE(MAX(state_revision),0) AS state_revision
      FROM social_ubuddy_capability_profiles WHERE owner_user_id=?`).get(ownerUserId)?.state_revision || 0);
    if (expectedStateRevision > 0 && expectedStateRevision !== currentStateRevision) {
      throw cloudApiError('ubuddy_profile_state_conflict', '云端简介状态已在其他设备更新。', 409);
    }
    const identity = db.prepare(`SELECT * FROM social_ubuddy_capability_profiles
      WHERE owner_user_id=? AND ubuddy_agent_instance_id=? AND profile_revision=?`).get(
      ownerUserId, profile.uBuddyAgentInstanceId, profile.profileRevision,
    );
    if (identity && identity.content_hash !== contentHash) {
      throw cloudApiError('ubuddy_profile_revision_conflict', '同一简介版本已对应不同内容。', 409);
    }
    if (identity?.publication_state === 'archived') {
      throw cloudApiError('ubuddy_profile_revision_archived', '该简介版本已经归档，请发布更高版本。', 409);
    }
    let row = identity;
    if (!row) {
      const now = new Date().toISOString();
      const nextStateRevision = currentStateRevision + 1;
      if (active) db.prepare(`UPDATE social_ubuddy_capability_profiles SET publication_state='archived',
        state_revision=?,last_command_id=?,archived_at=?,updated_at=?
        WHERE owner_user_id=? AND publication_state='active'`).run(nextStateRevision, commandId, now, now, ownerUserId);
      db.prepare(`INSERT INTO social_ubuddy_capability_profiles(
        owner_user_id,ubuddy_agent_instance_id,profile_revision,profile_version,visibility,publication_state,
        source_effective_skill_hash,content_hash,profile_json,state_revision,last_command_id,published_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,'active',?,?,?,?,?,?,?,?)`).run(
        ownerUserId, profile.uBuddyAgentInstanceId, profile.profileRevision, profile.version, profile.visibility,
        profile.sourceEffectiveSkillHash, contentHash, JSON.stringify(profile), nextStateRevision, commandId, now, now, now,
      );
      row = db.prepare(`SELECT * FROM social_ubuddy_capability_profiles
        WHERE owner_user_id=? AND ubuddy_agent_instance_id=? AND profile_revision=?`).get(
        ownerUserId, profile.uBuddyAgentInstanceId, profile.profileRevision,
      );
    }
    const response = { ok: true, stateRevision: Number(row.state_revision || 0), item: cloudUBuddyProfilePayload(row, 'owner') };
    db.prepare(`INSERT INTO social_ubuddy_capability_profile_commands(
      command_id,owner_user_id,operation_kind,payload_hash,response_json,created_at
    ) VALUES(?,?,'publish',?,?,?)`).run(commandId, ownerUserId, payloadHash, JSON.stringify(response), new Date().toISOString());
    return response;
  });
}

function unpublishCloudUBuddyCapabilityProfile(db, ownerUserId = '', payload = {}) {
  const commandId = String(payload.commandId || '').trim().slice(0, 200);
  if (!commandId) throw cloudApiError('ubuddy_profile_command_required', '缺少简介撤回命令标识。', 400);
  const expectedStateRevision = cloudUBuddyNonNegativeRevision(payload.expectedStateRevision);
  const payloadHash = cloudStableRequestHash({ operation: 'unpublish', ownerUserId, expectedStateRevision });
  return withImmediateCloudTransaction(db, () => {
    const prior = db.prepare('SELECT * FROM social_ubuddy_capability_profile_commands WHERE command_id=?').get(commandId);
    if (prior) {
      if (prior.owner_user_id !== ownerUserId || prior.operation_kind !== 'unpublish' || prior.payload_hash !== payloadHash) {
        throw cloudApiError('ubuddy_profile_idempotency_conflict', '简介撤回命令已被不同请求占用。', 409);
      }
      return cloudJsonObject(prior.response_json);
    }
    const active = db.prepare(`SELECT * FROM social_ubuddy_capability_profiles
      WHERE owner_user_id=? AND publication_state='active'`).get(ownerUserId);
    const currentStateRevision = Number(db.prepare(`SELECT COALESCE(MAX(state_revision),0) AS state_revision
      FROM social_ubuddy_capability_profiles WHERE owner_user_id=?`).get(ownerUserId)?.state_revision || 0);
    if (expectedStateRevision > 0 && expectedStateRevision !== currentStateRevision) {
      throw cloudApiError('ubuddy_profile_state_conflict', '云端简介状态已在其他设备更新。', 409);
    }
    const nextStateRevision = active ? currentStateRevision + 1 : currentStateRevision;
    if (active) {
      const now = new Date().toISOString();
      db.prepare(`UPDATE social_ubuddy_capability_profiles SET publication_state='archived',state_revision=?,
        last_command_id=?,archived_at=?,updated_at=? WHERE owner_user_id=? AND publication_state='active'`)
        .run(nextStateRevision, commandId, now, now, ownerUserId);
    }
    const response = { ok: true, stateRevision: nextStateRevision, item: null, unpublished: Boolean(active) };
    db.prepare(`INSERT INTO social_ubuddy_capability_profile_commands(
      command_id,owner_user_id,operation_kind,payload_hash,response_json,created_at
    ) VALUES(?,?,'unpublish',?,?,?)`).run(commandId, ownerUserId, payloadHash, JSON.stringify(response), new Date().toISOString());
    return response;
  });
}

function queryCloudUBuddyCapabilityProfiles(db, viewerUserId = '', payload = {}) {
  const userIds = [...new Set((Array.isArray(payload.userIds) ? payload.userIds : [])
    .map((item) => String(item || '').trim()).filter(Boolean))];
  if (userIds.length > 100) throw cloudApiError('ubuddy_profile_query_too_large', '一次最多查询 100 个 uBuddy 简介。', 400);
  const profiles = [];
  const unavailableUserIds = [];
  for (const ownerUserId of userIds) {
    const row = db.prepare(`SELECT * FROM social_ubuddy_capability_profiles
      WHERE owner_user_id=? AND publication_state='active'`).get(ownerUserId);
    const accessScope = row ? cloudUBuddyProfileAccessScope(db, viewerUserId, ownerUserId, row.visibility) : '';
    const exposed = row && accessScope ? safeCloudUBuddyProfilePayload(row, accessScope) : null;
    if (!exposed) unavailableUserIds.push(ownerUserId);
    else profiles.push(exposed);
  }
  return { profiles, unavailableUserIds };
}

function requireCloudUBuddyProfileCapability(request, url, payload = {}) {
  const capability = String(payload?.socialCapability || payload?.capability || url?.searchParams?.get('socialCapability')
    || url?.searchParams?.get('capability') || request?.headers?.['x-janus-social-capability'] || '').trim();
  if (!capability.split(',').map((item) => item.trim()).includes('ubuddy-capability-profile-v1')) {
    throw cloudApiError('ubuddy_profile_capability_required', '当前客户端未声明 uBuddy 简介能力。', 426);
  }
}

function normalizeCloudPublishedUBuddyProfile(value = {}, ownerUserId = '') {
  const profile = normalizeUBuddyCapabilityProfile({ ...(value || {}), ownerUserId });
  const validation = validateUBuddyCapabilityProfile(profile);
  if (!validation.valid) throw cloudApiError('ubuddy_profile_invalid', 'uBuddy 简介未通过发布校验。', 400);
  if (profile.publicationState !== 'active') throw cloudApiError('ubuddy_profile_state_invalid', '只能发布 active 状态的 uBuddy 简介。', 400);
  if (!['friends', 'organization'].includes(profile.visibility)) throw cloudApiError('ubuddy_profile_visibility_invalid', '私有 uBuddy 简介不能上传。', 400);
  if (Buffer.byteLength(JSON.stringify(profile), 'utf8') > 32 * 1024) throw cloudApiError('ubuddy_profile_too_large', 'uBuddy 简介不能超过 32 KB。', 413);
  return profile;
}

function cloudUBuddyNonNegativeRevision(value = 0) {
  const number = Math.floor(Number(value || 0));
  if (!Number.isFinite(number) || number < 0) throw cloudApiError('ubuddy_profile_state_revision_invalid', '简介状态版本号无效。', 400);
  return number;
}

function cloudUBuddyProfileAccessScope(db, viewerUserId = '', ownerUserId = '', visibility = 'friends') {
  if (viewerUserId === ownerUserId) return 'owner';
  if (cloudUsersBlocked(db, viewerUserId, ownerUserId)) return '';
  if (cloudFriendshipBetween(db, viewerUserId, ownerUserId)) return 'friends';
  if (visibility !== 'organization') return '';
  const shared = db.prepare(`SELECT 1 FROM contact_organization_members viewer
    JOIN contact_organization_members owner ON owner.organization_id=viewer.organization_id
    WHERE viewer.user_id=? AND owner.user_id=? LIMIT 1`).get(viewerUserId, ownerUserId);
  return shared ? 'organization' : '';
}

function cloudUBuddyProfilePayload(row = {}, accessScope = 'friends') {
  return {
    ownerUserId: row.owner_user_id || '', contentHash: row.content_hash || '', accessScope,
    stateRevision: Number(row.state_revision || 0), publishedAt: row.published_at || '', updatedAt: row.updated_at || '',
    profile: cloudJsonObject(row.profile_json),
  };
}

function safeCloudUBuddyProfilePayload(row = {}, accessScope = 'friends') {
  const payload = cloudUBuddyProfilePayload(row, accessScope);
  return validateUBuddyCapabilityProfile(payload.profile).valid ? payload : null;
}

function cloudStableRequestHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(cloudStableRequestValue(value))).digest('hex');
}

function cloudStableRequestValue(value) {
  if (Array.isArray(value)) return value.map(cloudStableRequestValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, cloudStableRequestValue(value[key])]));
}

function withImmediateCloudTransaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}


function requireLegacySyncUserActive(db, userId = '', { createIfMissing = true } = {}) {
  const id = String(userId || '').trim();
  if (!id) throw cloudApiError('sync_user_required', '\u540c\u6b65\u8bf7\u6c42\u7f3a\u5c11\u7528\u6237 ID\u3002', 400);
  if (createIfMissing) ensureLegacyCloudUser(db, id);
  const user = db.prepare('SELECT id,account_status,suspension_reason,suspended_at FROM users WHERE id=?').get(id);
  if (user && String(user.account_status || 'active') !== 'active') {
    throw cloudApiError('account_suspended', user.suspension_reason || '\u8d26\u53f7\u5df2\u88ab\u505c\u7528\uff0c\u8bf7\u8054\u7cfb\u7ba1\u7406\u5458\u3002', 403, {
      suspendedAt: user.suspended_at || '',
      reason: user.suspension_reason || '',
    });
  }
  return user || null;
}

function recordLegacySyncUploadCompliance(db, payload = {}) {
  const device = payload.device || {};
  const userId = String(device.userId || device.user_id || payload.userId || payload.user_id || '').trim();
  if (!userId) return { status: 'skipped', reason: 'missing_user' };
  const user = db.prepare('SELECT id,role,account_status FROM users WHERE id=?').get(userId);
  if (!user || String(user.role || '') === 'admin') return { status: 'skipped', reason: 'non_account_or_admin' };
  const now = new Date().toISOString();
  const deviceId = String(device.deviceId || device.device_id || '').trim();
  const effectiveItems = legacySyncEffectiveItemCount(payload);
  const row = db.prepare('SELECT * FROM cloud_upload_compliance WHERE user_id=?').get(userId);
  const emptyStreak = effectiveItems > 0 ? 0 : Number(row?.empty_batch_streak || 0) + 1;
  const status = effectiveItems > 0 ? 'ok' : emptyStreak >= uploadComplianceEmptyBatchStrikes() ? 'suspicious' : 'watching';
  const reason = effectiveItems > 0 ? '' : 'empty_sync_batch';
  db.prepare(`INSERT INTO cloud_upload_compliance (
      user_id,device_id,last_sync_at,last_effective_sync_at,empty_batch_streak,status,reason,updated_at
    ) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      device_id=excluded.device_id,
      last_sync_at=excluded.last_sync_at,
      last_effective_sync_at=CASE WHEN ? > 0 THEN excluded.last_effective_sync_at ELSE cloud_upload_compliance.last_effective_sync_at END,
      empty_batch_streak=excluded.empty_batch_streak,
      suspicious_access_count=CASE WHEN ? > 0 THEN 0 ELSE suspicious_access_count END,
      status=excluded.status,
      reason=excluded.reason,
      updated_at=excluded.updated_at`).run(
        userId, deviceId, now, effectiveItems > 0 ? now : '', emptyStreak, status, reason, now,
        effectiveItems, effectiveItems,
      );
  if (emptyStreak >= uploadComplianceEmptyBatchStrikes() && String(user.account_status || 'active') === 'active') {
    return suspendCloudUser(db, { userId, reason: `empty_sync_batch_streak:${emptyStreak}`, now });
  }
  return { status, effectiveItems, emptyBatchStreak: emptyStreak };
}

function legacySyncEffectiveItemCount(payload = {}) {
  const data = payload.data || {};
  const batchItems = Number(payload.batch?.itemCount || payload.batch?.item_count || 0);
  const arrays = [
    data.projects, data.conversations, data.sessions, data.messages, data.codexTranscripts,
    data.modelExecutions, data.fileRefs, data.agentFamilies, data.agentVersions,
    data.userAgentInstances, data.userAgentSkillVersions, data.userAgentInstanceAliases,
    data.memoryDocuments, data.memoryDocumentVersions, data.memoryDocumentAliases,
    data.agentContextSpaces, data.agentContextStates, data.chatContextStates,
    data.memorySyncMappings, data.taskSecurityContexts, data.personalEvolutionProposals,
    data.personalEvolutionMemoryOperations, payload.files,
  ];
  const arrayItems = arrays.reduce((total, item) => total + (Array.isArray(item) ? item.length : 0), 0);
  return Math.max(0, batchItems, arrayItems);
}

function listUploadCompliance(db, searchParams = new URLSearchParams()) {
  const status = String(searchParams.get('status') || '').trim();
  const where = [];
  const params = [];
  if (status) { where.push('c.status=?'); params.push(status); }
  params.push(Math.min(200, Math.max(1, Number(searchParams.get('limit') || 100))));
  return db.prepare(`SELECT c.*,u.email,u.username,u.display_name,u.role,u.account_status,u.suspended_at,u.suspension_reason
    FROM cloud_upload_compliance c LEFT JOIN users u ON u.id=c.user_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.updated_at DESC LIMIT ?`).all(...params);
}

function uploadComplianceEmptyBatchStrikes() {
  return Math.max(1, Number(process.env.JANUS_UPLOAD_COMPLIANCE_EMPTY_BATCH_STRIKES || process.env.JANUS_UPLOAD_COMPLIANCE_SUSPEND_STRIKES || 4));
}

function ensureLegacyCloudUser(db, userId = '') {
  const id = String(userId || '').trim();
  if (!id || db.prepare('SELECT id FROM users WHERE id=?').get(id)) return;
  const digest = crypto.createHash('sha256').update(id).digest('hex').slice(0, 20);
  db.prepare(`INSERT INTO users(id,email,display_name,username,password_hash,email_verified)
    VALUES(?,?,?,?,?,1)`).run(id, `${digest}@local.janus.invalid`, id, `legacy_${digest}`, 'legacy_sync_identity');
}

async function storeFile({ db, home, request, sha256 }) {
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error('invalid sha256');
  const body = await readBody(request);
  const actual = crypto.createHash('sha256').update(body).digest('hex');
  if (actual !== sha256.toLowerCase()) throw new Error('sha256 mismatch');
  const objectDir = path.join(home, 'files', 'sha256', sha256.slice(0, 2));
  await fsp.mkdir(objectDir, { recursive: true });
  const storagePath = path.join(objectDir, sha256);
  if (!fs.existsSync(storagePath)) await fsp.writeFile(storagePath, body);
  db.prepare(
    `INSERT INTO file_objects (sha256, size_bytes, storage_path)
     VALUES (?, ?, ?)
     ON CONFLICT(sha256) DO UPDATE SET size_bytes = excluded.size_bytes, storage_path = excluded.storage_path`,
  ).run(sha256, body.length, storagePath);
  return { status: 'stored', sha256, sizeBytes: body.length };
}

function syncStatus(db) {
  const batches = db.prepare('SELECT COUNT(*) AS count FROM sync_batches').get()?.count || 0;
  const files = db.prepare('SELECT COUNT(*) AS count FROM file_objects').get()?.count || 0;
  const projects = db.prepare('SELECT COUNT(*) AS count FROM cloud_projects_v2').get()?.count || 0;
  const conversations = db.prepare('SELECT COUNT(*) AS count FROM cloud_conversations_v2').get()?.count || 0;
  const messages = db.prepare('SELECT COUNT(*) AS count FROM cloud_messages_v2').get()?.count || 0;
  const transcripts = db.prepare('SELECT COUNT(*) AS count FROM cloud_transcripts_v2').get()?.count || 0;
  const fileRefs = db.prepare('SELECT COUNT(*) AS count FROM cloud_file_refs_v2').get()?.count || 0;
  const modelExecutions = db.prepare('SELECT COUNT(*) AS count FROM cloud_model_executions_v2').get()?.count || 0;
  const latest = db.prepare('SELECT * FROM sync_batches ORDER BY created_at DESC LIMIT 1').get();
  return {
    status: 'ok',
    batchCount: Number(batches),
    projectCount: Number(projects),
    conversationCount: Number(conversations),
    messageCount: Number(messages),
    transcriptCount: Number(transcripts),
    modelExecutionCount: Number(modelExecutions),
    fileCount: Number(files),
    fileRefCount: Number(fileRefs),
    latestBatch: latest || null,
  };
}

function latestRelease(db, params, home = '') {
  const channel = params.get('channel') || 'dev';
  const platform = params.get('platform') || '';
  const arch = params.get('arch') || '';
  const kind = params.get('kind') || '';
  const rows = db.prepare(
    `SELECT * FROM release_manifests
     WHERE channel = ?
       AND (? = '' OR platform = ? OR platform = 'any')
       AND (? = '' OR arch = ? OR arch = 'any')
     ORDER BY created_at DESC LIMIT 100`,
  ).all(channel, platform, platform, arch, arch);
  const row = kind
    ? rows.find((item) => (safeJsonObject(item.manifest_json).artifacts || []).some((artifact) => artifact.kind === kind))
    : rows[0];
  if (!row) return discoverReleaseFromFiles(home, { channel, platform, arch });
  return {
    status: 'ok',
    channel: row.channel,
    version: row.version,
    platform: row.platform,
    arch: row.arch,
    manifest: JSON.parse(row.manifest_json || '{}'),
    createdAt: row.created_at,
  };
}

function discoverReleaseFromFiles(home, { channel = 'dev', platform = '', arch = '' } = {}) {
  if (channel !== 'dev') return { status: 'empty', channel, platform, arch };
  if (!['darwin', 'win32', 'linux'].includes(platform)) return { status: 'empty', channel, platform, arch };
  const releasesRoot = path.join(home, 'releases');
  const platformDirectory = platform === 'darwin' ? 'macos' : platform === 'linux' ? 'linux' : 'windows';
  const releasesDir = path.join(releasesRoot, platformDirectory);
  const artifactPathPrefix = `${platformDirectory}/`;
  const feedName = feedNameForPlatform(platform);
  const feedPath = path.join(releasesDir, feedName);
  if (!fs.existsSync(feedPath)) return { status: 'empty', channel, platform, arch };
  const feedText = fs.readFileSync(feedPath, 'utf8');
  const stat = fs.statSync(feedPath);
  const version = matchYamlValue(feedText, 'version') || '';
  const artifactNames = new Set([feedName]);
  const pathValue = matchYamlValue(feedText, 'path');
  if (pathValue) artifactNames.add(pathValue);
  for (const urlValue of matchYamlValues(feedText, 'url')) artifactNames.add(urlValue);
  const blockMapName = [...artifactNames].find((name) => /\.(exe|dmg|zip|AppImage)$/i.test(name));
  if (blockMapName && fs.existsSync(releaseArtifactFile(releasesDir, `${blockMapName}.blockmap`))) {
    artifactNames.add(`${blockMapName}.blockmap`);
  }
  let versionDir = '';
  try {
    versionDir = path.join(releasesDir, normalizeReleaseVersion(version));
  } catch {
    versionDir = '';
  }
  if (versionDir && fs.existsSync(versionDir)) {
    for (const name of fs.readdirSync(versionDir)) {
      if (/^janus-agents-.*\.json$/i.test(name)) artifactNames.add(`${version}/${name}`);
    }
  }
  const agentArtifactNames = [];
  const agentVersionRoots = version
    ? [path.join(releasesRoot, 'agents', version), path.join(releasesRoot, version)]
    : [];
  const agentVersionDir = agentVersionRoots.find((directory) => directory !== versionDir && fs.existsSync(directory)) || '';
  if (agentVersionDir) {
    const relativeAgentRoot = path.relative(releasesRoot, agentVersionDir).replaceAll(path.sep, '/');
    for (const name of fs.readdirSync(agentVersionDir)) {
      if (/^janus-agents-.*\.json$/i.test(name)) agentArtifactNames.push(`${relativeAgentRoot}/${name}`);
    }
  }
  const artifacts = [
    ...[...artifactNames].map((name) => artifactFromReleaseFile(releasesDir, name, { platform, arch, artifactPathPrefix })),
    ...agentArtifactNames.map((name) => artifactFromReleaseFile(releasesRoot, name, { platform, arch })),
  ]
    .filter(Boolean);
  const manifest = {
    id: `dev-${version || 'file'}-${Math.trunc(stat.mtimeMs)}`,
    channel,
    version,
    commit: '',
    createdAt: stat.mtime.toISOString(),
    platform: platform || platformForFeed(feedName),
    arch: arch || 'x64',
    artifacts,
    source: 'release_files',
  };
  return {
    status: 'ok',
    channel,
    version,
    platform: manifest.platform,
    arch: manifest.arch,
    manifest,
    createdAt: manifest.createdAt,
  };
}

function feedNameForPlatform(platform = '') {
  if (platform === 'linux') return 'latest-linux.yml';
  if (platform === 'darwin') return 'latest-mac.yml';
  return 'latest.yml';
}

function platformForFeed(feedName = '') {
  if (feedName === 'latest-linux.yml') return 'linux';
  if (feedName === 'latest-mac.yml') return 'darwin';
  return 'win32';
}

function matchYamlValue(text, key) {
  const match = String(text || '').match(new RegExp(`^\\s*${key}:\\s*['"]?([^'"\\r\\n]+)['"]?\\s*$`, 'm'));
  return match ? match[1].trim() : '';
}

function matchYamlValues(text, key) {
  return [...String(text || '').matchAll(new RegExp(`^\\s*-?\\s*${key}:\\s*['"]?([^'"\\r\\n]+)['"]?\\s*$`, 'gm'))]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

function safeJsonObject(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function artifactFromReleaseFile(releasesDir, name, { platform = '', arch = '', artifactPathPrefix = '' } = {}) {
  const safePath = normalizeReleaseArtifactPath(name);
  if (!safePath) return null;
  const safeName = path.posix.basename(safePath);
  const file = releaseArtifactFile(releasesDir, safePath);
  if (!fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  return {
    name: safeName,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    sizeBytes: stat.size,
    platform: /^janus-agents-.*\.json$/i.test(safeName) ? 'any' : platform || platformForFeed(feedNameForArtifact(safeName)),
    arch: /^janus-agents-.*\.json$/i.test(safeName) ? 'any' : arch || 'x64',
    url: releaseArtifactUrl(`${artifactPathPrefix}${safePath}`),
  };
}

function feedNameForArtifact(name = '') {
  if (/\.AppImage$/i.test(name) || name === 'latest-linux.yml') return 'latest-linux.yml';
  if (/\.(dmg|zip)$/i.test(name) || name === 'latest-mac.yml') return 'latest-mac.yml';
  return 'latest.yml';
}

async function sendArtifact(response, home, name, { head = false } = {}) {
  const safePath = normalizeReleaseArtifactPath(name);
  const safeName = safePath ? path.posix.basename(safePath) : '';
  const releasesRoot = path.join(home, 'releases');
  let file = safePath ? releaseArtifactFile(releasesRoot, safePath) : '';
  if (
    file
    && (!fs.existsSync(file) || !fs.statSync(file).isFile())
    && /^\d+\.\d+\.\d+\/janus-agents-.*\.json$/i.test(safePath)
  ) {
    file = releaseArtifactFile(releasesRoot, `agents/${safePath}`);
  }
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    sendJson(response, 404, { error: 'artifact_not_found' });
    return;
  }
  sendFileResponse(response, file, { filename: safeName, head });
}

function audit(db, method = '', route = '', status = 0, errorText = '') {
  try {
    db.prepare(
      `INSERT INTO request_audit (id, method, route, status, error_text)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(`audit_${crypto.randomUUID()}`, method || '', route || '', status, String(errorText || '').slice(0, 1000));
  } catch {
    // Audit failures must never break API responses.
  }
}

function bearerToken(request) {
  const value = String(request.headers.authorization || '');
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : '';
}

function requireGrantedInstance(db, grant, instanceId) {
  const row = db.prepare('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=? AND id=?').get(grant.userId, instanceId);
  if (!row) throw cloudApiError('agent_instance_not_found', 'Agent instance does not belong to the granted user.', 404);
  return row;
}

function publicCohort(row = {}) {
  return {
    id: row.id,
    cohortKey: row.cohortKey || '',
    identityVersion: row.identityVersion || '',
    type: row.type,
    agentFamilyId: row.familyId || row.agentFamilyId || '',
    departmentId: row.departmentId || '',
    capabilityTags: row.capabilityTags || [],
    userCount: Number(row.userCount || 0),
    evidenceCount: Number(row.evidenceCount || 0),
    newEvidenceCount: Number(row.newEvidenceCount || 0),
    reconsiderableEvidenceCount: Number(row.reconsiderableEvidenceCount || 0),
    evidenceBreakdown: row.evidenceBreakdown || {},
    evidenceThresholds: row.evidenceThresholds || {},
    eligibilityReasons: row.eligibilityReasons || [],
    fallbackReason: row.fallbackReason || '',
    eligible: Boolean(row.eligible),
    status: row.status || 'active',
  };
}

function publicClusterRun(row = {}) {
  return {
    id: row.id,
    scope: row.evolution_scope,
    cohortId: row.cohort_id || '',
    agentFamilyId: row.agent_family_id || '',
    status: row.status,
    evidenceCount: Number(row.evidence_count || 0),
    summary: row.summary || '',
    errorCode: row.error_code || '',
    createdAt: row.created_at,
    completedAt: row.completed_at || '',
  };
}
