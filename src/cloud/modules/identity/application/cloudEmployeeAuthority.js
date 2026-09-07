import crypto from 'node:crypto';

import {
  CLOUD_EMPLOYEE_POLICY_VERSION,
  CLOUD_EMPLOYEE_QUOTA_LIMIT,
  cloudEmployeeCapability,
} from '../../../../shared/cloudContracts.js';
import { canonicalPptAgentId, isLegacyPptAgentId } from '../../../../shared/pptAgents.js';
import { cloudApiError } from '../../http/index.js';
import {
  canonicalAgentFamilyName,
  defaultAgentInstanceDisplayName,
  isDefaultAgentInstanceDisplayName,
} from '../../../../shared/agentInstanceNaming.js';

const EMPLOYEE_LIMIT = CLOUD_EMPLOYEE_QUOTA_LIMIT;
const POLICY_VERSION = CLOUD_EMPLOYEE_POLICY_VERSION;

export function createCloudEmployeeAuthority({ db } = {}) {
  if (!db) throw new Error('Cloud employee authority requires a database.');
  return {
    capabilities() {
      return cloudEmployeeCapability(true);
    },

    overview({ userId = '' } = {}) {
      requireUser(db, userId);
      return overviewPayload(db, userId);
    },

    bootstrap({ userId = '', deviceId = '', payload = {} } = {}) {
      requireUser(db, userId);
      const bootstrapId = required(payload.bootstrapId || payload.bootstrap_id, 'employee_bootstrap_id_required');
      const requested = Array.isArray(payload.instances) ? payload.instances : [];
      db.exec('BEGIN IMMEDIATE');
      try {
        ensureRosterState(db, userId);
        const state = readRosterState(db, userId);
        if (state.bootstrap_status === 'completed') {
          if (state.bootstrap_id !== bootstrapId) throw cloudApiError('employee_bootstrap_already_completed', 'Employee roster bootstrap has already completed.', 409);
          for (const instance of db.prepare('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=? ORDER BY created_at,id').all(userId)) {
            ensureCanonicalMemory0(db, userId, instance, deviceId);
          }
          db.exec('COMMIT');
          return { ...overviewPayload(db, userId), status: 'completed', bootstrapId, idempotent: true };
        }
        const bootstrapItems = requested.filter((item) => canonicalPptAgentId(item?.agentFamilyId || item?.agent_family_id || ''));
        if (!bootstrapItems.length) {
          const family = db.prepare("SELECT id FROM cloud_agent_families_v3 WHERE instance_kind='employee' AND recruitable=1 AND default_for_new_user=1 ORDER BY id LIMIT 1").get();
          if (family) bootstrapItems.push({ agentFamilyId: family.id, employmentState: 'active' });
        }
        const aliases = [];
        for (const item of bootstrapItems) {
          const familyId = canonicalPptAgentId(item?.agentFamilyId || item?.agent_family_id || '');
          const family = db.prepare('SELECT * FROM cloud_agent_families_v3 WHERE id = ?').get(familyId);
          if (!family || family.instance_kind !== 'employee') continue;
          const requestedId = String(item.proposedInstanceId || item.proposed_instance_id || item.id || '').trim();
          let instance = requestedId ? db.prepare('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=? AND id=?').get(userId, requestedId) : null;
          if (instance && canonicalPptAgentId(instance.agent_family_id) !== familyId) instance = null;
          let canonicalId = requestedId || `uagent_${crypto.randomUUID()}`;
          const collision = db.prepare('SELECT agent_family_id FROM cloud_user_agent_instances_v3 WHERE user_id=? AND id=?').get(userId, canonicalId);
          if (!instance && collision && collision.agent_family_id !== familyId) canonicalId = `uagent_${crypto.randomUUID()}`;
          if (requestedId && requestedId !== canonicalId) {
            db.prepare(`INSERT INTO cloud_user_agent_instance_aliases_v3(user_id,alias_instance_id,canonical_instance_id,reason)
              VALUES(?,?,?,'employee_bootstrap_canonical') ON CONFLICT(user_id,alias_instance_id)
              DO UPDATE SET canonical_instance_id=excluded.canonical_instance_id,reason=excluded.reason`).run(userId, requestedId, canonicalId);
            aliases.push({ aliasInstanceId: requestedId, canonicalInstanceId: canonicalId });
          }
          const employmentState = String(item.employmentState || item.employment_state || 'active') === 'inactive' ? 'inactive' : 'active';
          const now = new Date().toISOString();
          if (!instance) {
            const requestedSequence = Math.max(0, Math.floor(Number(item.familyInstanceSeq || item.family_instance_seq || 0) || 0));
            const familyInstanceSeq = bootstrapFamilySequence(db, userId, familyId, requestedSequence);
            const requestedDisplayName = String(item.displayName || item.display_name || '').trim();
            const displayName = !requestedDisplayName || isDefaultAgentInstanceDisplayName(requestedDisplayName, family.name || familyId, familyId)
              ? defaultAgentInstanceDisplayName(family.name || familyId, familyInstanceSeq, familyId)
              : requestedDisplayName;
            const note = String(item.note || '').slice(0, 500);
            db.prepare(`INSERT INTO cloud_user_agent_instances_v3 (
              user_id,id,agent_family_id,base_agent_version_id,status,instance_kind,employment_state,quota_exempt,
              recruited_at,deactivated_at,last_state_changed_at,state_revision,recruitment_source,policy_version,source_device_id,
              sync_enabled,personal_evolution_consent,cluster_contribution_consent,personal_skill_auto_activate,
              family_instance_seq,display_name,note,payload_json,created_at,updated_at
            ) VALUES(?,?,?,?,?,'employee',?,0,?,?,?,?, 'migration',?,?,1,?, ?,0,?,?,?,?,?,?)`).run(
              userId, canonicalId, familyId, family.current_version_id || '', employmentState, employmentState,
              item.recruitedAt || item.recruited_at || now, employmentState === 'inactive' ? (item.deactivatedAt || item.deactivated_at || now) : '',
              item.lastStateChangedAt || item.last_state_changed_at || now, Math.max(1, Number(item.stateRevision || item.state_revision || 1)),
              POLICY_VERSION, deviceId || '', employmentState === 'active' ? 1 : 0, employmentState === 'active' ? 1 : 0,
              familyInstanceSeq, displayName, note, JSON.stringify({ displayName, familyInstanceSeq, note }),
              item.createdAt || item.created_at || now, item.updatedAt || item.updated_at || now,
            );
            instance = db.prepare('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=? AND id=?').get(userId, canonicalId);
          } else if (instance.policy_version !== POLICY_VERSION) {
            db.prepare(`UPDATE cloud_user_agent_instances_v3 SET status=?,employment_state=?,instance_kind='employee',quota_exempt=0,
              policy_version=?,recruitment_source='migration',source_device_id=?,sync_enabled=1,cluster_contribution_consent=?,
              state_revision=MAX(state_revision,?),updated_at=? WHERE user_id=? AND id=?`).run(
              employmentState, employmentState, POLICY_VERSION, deviceId || '', employmentState === 'active' ? 1 : 0,
              Math.max(1, Number(item.stateRevision || item.state_revision || 1)), now, userId, instance.id);
            instance = db.prepare('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=? AND id=?').get(userId, instance.id);
          }
          ensureCanonicalMemory0(db, userId, instance, deviceId);
          const commandId = `${bootstrapId}:${canonicalId}`;
          if (!db.prepare('SELECT id FROM cloud_user_agent_recruitment_events WHERE user_id=? AND command_id=?').get(userId, commandId)) {
            const active = activeEmployeeCount(db, userId);
            recordEvent(db, { userId, deviceId, commandId, instance, familyId, eventType: 'migrated', previousState: 'not_recruited', nextState: instance.employment_state, quotaBefore: active, quotaAfter: active });
          }
        }
        if (Number(db.prepare("SELECT COUNT(*) AS count FROM cloud_user_agent_instances_v3 WHERE user_id=? AND instance_kind='employee'").get(userId)?.count || 0) === 0) {
          throw cloudApiError('employee_catalog_not_ready', 'Cloud employee catalog is not ready for roster bootstrap.', 503);
        }
        ensureSystemInstance(db, userId, 'secretary_agent', deviceId);
        db.prepare(`UPDATE cloud_employee_roster_states SET bootstrap_status='completed',bootstrap_id=?,roster_revision=roster_revision+1,
          bootstrapped_at=?,updated_at=? WHERE user_id=?`).run(bootstrapId, new Date().toISOString(), new Date().toISOString(), userId);
        const completed = overviewPayload(db, userId);
        const result = {
          ...completed,
          status: 'completed',
          bootstrapId,
          idempotent: false,
          aliases: mergeInstanceAliases(completed.aliases, aliases),
        };
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    command({ userId = '', deviceId = '', payload = {} } = {}) {
      requireUser(db, userId);
      ensureRosterState(db, userId);
      if (readRosterState(db, userId).bootstrap_status !== 'completed') {
        throw cloudApiError('employee_bootstrap_required', 'Employee roster bootstrap must complete before lifecycle commands.', 409);
      }
      const commandId = required(payload.commandId || payload.command_id, 'recruitment_command_required');
      const action = String(payload.action || '').trim();
      if (!['recruit', 'deactivate', 'reactivate'].includes(action)) throw cloudApiError('employee_command_invalid', 'Employee command action is invalid.', 400);
      db.exec('BEGIN IMMEDIATE');
      try {
        const existingEvent = db.prepare('SELECT * FROM cloud_user_agent_recruitment_events WHERE user_id = ? AND command_id = ?').get(userId, commandId);
        if (existingEvent) {
          db.exec('COMMIT');
          return commandResult(db, existingEvent, true);
        }
        const result = action === 'recruit'
          ? recruit(db, { userId, deviceId, commandId, payload })
          : changeState(db, { userId, deviceId, commandId, payload, action });
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    events({ userId = '', cursor = '', limit = 100 } = {}) {
      requireUser(db, userId);
      const params = [userId];
      const filter = cursor ? ' AND created_at > ?' : '';
      if (cursor) params.push(cursor);
      params.push(Math.max(1, Math.min(500, Number(limit || 100))));
      return db.prepare(`SELECT * FROM cloud_user_agent_recruitment_events WHERE user_id = ?${filter}
        ORDER BY created_at ASC, id ASC LIMIT ?`).all(...params).map(eventPayload);
    },
  };
}

function recruit(db, { userId, deviceId, commandId, payload }) {
  const familyId = canonicalPptAgentId(required(payload.agentFamilyId || payload.agent_family_id, 'agent_family_required'));
  const family = db.prepare('SELECT * FROM cloud_agent_families_v3 WHERE id = ?').get(familyId);
  if (!family || family.instance_kind !== 'employee' || !Number(family.recruitable)) {
    return reject(db, { userId, deviceId, commandId, familyId, code: 'agent_not_recruitable' });
  }
  const adoptedState = payload.adoptLocalInstance === true && String(payload.employmentState || payload.employment_state || '') === 'inactive'
    ? 'inactive'
    : 'active';
  const active = activeEmployeeCount(db, userId);
  if (adoptedState === 'active' && active >= EMPLOYEE_LIMIT) return reject(db, { userId, deviceId, commandId, familyId, code: 'employee_quota_exceeded' });
  const now = new Date().toISOString();
  const deactivatedAt = adoptedState === 'inactive' ? now : '';
  let id = String(payload.proposedInstanceId || payload.proposed_instance_id || `uagent_${crypto.randomUUID()}`);
  if (db.prepare('SELECT id FROM cloud_user_agent_instances_v3 WHERE user_id = ? AND id = ?').get(userId, id)) {
    id = `uagent_${crypto.randomUUID()}`;
  }
  const familyInstanceSeq = nextFamilySequence(db, userId, familyId);
  const requestedDisplayName = String(payload.displayName || payload.display_name || '').trim();
  const displayName = !requestedDisplayName || isDefaultAgentInstanceDisplayName(requestedDisplayName, family.name || familyId, familyId)
    ? defaultAgentInstanceDisplayName(family.name || familyId, familyInstanceSeq, familyId)
    : requestedDisplayName;
  const note = String(payload.note || '').slice(0, 500);
  db.prepare(`INSERT INTO cloud_user_agent_instances_v3 (
      user_id,id,agent_family_id,base_agent_version_id,status,instance_kind,employment_state,quota_exempt,
      recruited_at,deactivated_at,last_state_changed_at,state_revision,recruitment_source,policy_version,source_device_id,
      sync_enabled,personal_evolution_consent,cluster_contribution_consent,personal_skill_auto_activate,
      family_instance_seq,display_name,note,payload_json,created_at,updated_at
    ) VALUES (?,?,?,?,?,'employee',?,0,?,?,?,1,?,?,?,1,?,?,0,?,?,?,?,?,?)`).run(
    userId, id, familyId, family.current_version_id || '', adoptedState, adoptedState,
    now, deactivatedAt, now, payload.adoptLocalInstance === true ? 'local_instance_adoption' : 'user', POLICY_VERSION, deviceId || '',
    adoptedState === 'active' ? 1 : 0, adoptedState === 'active' ? 1 : 0,
    familyInstanceSeq, displayName, note,
    JSON.stringify({ displayName, familyInstanceSeq, note, adoptedLocalInstance: payload.adoptLocalInstance === true }), now, now,
  );
  const instance = db.prepare('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id = ? AND id = ?').get(userId, id);
  ensureCanonicalMemory0(db, userId, instance, deviceId);
  const event = recordEvent(db, { userId, deviceId, commandId, instance, familyId, eventType: 'recruited', previousState: 'not_recruited', nextState: adoptedState, quotaBefore: active, quotaAfter: activeEmployeeCount(db, userId) });
  bumpRosterRevision(db, userId);
  return commandResult(db, event, false);
}

function changeState(db, { userId, deviceId, commandId, payload, action }) {
  const requestedInstanceId = required(payload.agentInstanceId || payload.agent_instance_id, 'agent_instance_not_found');
  const instanceId = db.prepare(`SELECT canonical_instance_id FROM cloud_user_agent_instance_aliases_v3
    WHERE user_id = ? AND alias_instance_id = ?`).get(userId, requestedInstanceId)?.canonical_instance_id || requestedInstanceId;
  let instance = db.prepare('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id = ? AND id = ?').get(userId, instanceId);
  if (!instance) throw cloudApiError('agent_instance_not_found', 'Employee Agent instance was not found.', 404);
  if (instance.instance_kind !== 'employee' || Number(instance.quota_exempt)) throw cloudApiError('agent_not_recruitable', 'Only employee instances can change employment state.', 409);
  const expected = Number(payload.expectedStateRevision ?? payload.expected_state_revision);
  if (!Number.isInteger(expected) || expected < 1 || expected !== Number(instance.state_revision)) {
    return reject(db, { userId, deviceId, commandId, familyId: instance.agent_family_id, instance, code: 'employee_state_conflict', expectedStateRevision: payload.expectedStateRevision ?? payload.expected_state_revision });
  }
  if (action === 'reactivate') {
    const quotaBefore = activeEmployeeCount(db, userId);
    if (instance.employment_state === 'active') {
      const event = recordEvent(db, { userId, deviceId, commandId, instance, familyId: instance.agent_family_id, eventType: 'reconciled', previousState: 'active', nextState: 'active', code: 'agent_already_active', quotaBefore, quotaAfter: quotaBefore });
      return commandResult(db, event, false);
    }
    if (quotaBefore >= EMPLOYEE_LIMIT) return reject(db, { userId, deviceId, commandId, familyId: instance.agent_family_id, instance, code: 'employee_quota_exceeded' });
    const now = new Date().toISOString();
    db.prepare(`UPDATE cloud_user_agent_instances_v3 SET status='active',employment_state='active',deactivated_at='',
      last_state_changed_at=?,state_revision=state_revision+1,recruitment_source='user_reactivation',policy_version=?,
      source_device_id=?,cluster_contribution_consent=1,updated_at=? WHERE user_id=? AND id=? AND state_revision=?`).run(
      now, POLICY_VERSION, deviceId || '', now, userId, instance.id, instance.state_revision,
    );
    instance = db.prepare('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=? AND id=?').get(userId, instance.id);
    ensureCanonicalMemory0(db, userId, instance, deviceId);
    const event = recordEvent(db, { userId, deviceId, commandId, instance, familyId: instance.agent_family_id, eventType: 'reactivated', previousState: 'inactive', nextState: 'active', quotaBefore, quotaAfter: activeEmployeeCount(db, userId) });
    bumpRosterRevision(db, userId);
    return commandResult(db, event, false);
  }
  if (instance.employment_state === 'inactive') {
    const active = activeEmployeeCount(db, userId);
    const event = recordEvent(db, { userId, deviceId, commandId, instance, familyId: instance.agent_family_id, eventType: 'reconciled', previousState: 'inactive', nextState: 'inactive', code: 'agent_already_inactive', quotaBefore: active, quotaAfter: active });
    return commandResult(db, event, false);
  }
  const quotaBefore = activeEmployeeCount(db, userId);
  const now = new Date().toISOString();
  db.prepare(`UPDATE cloud_user_agent_instances_v3 SET status='inactive',employment_state='inactive',deactivated_at=?,
    last_state_changed_at=?,state_revision=state_revision+1,policy_version=?,source_device_id=?,cluster_contribution_consent=0,updated_at=?
    WHERE user_id=? AND id=? AND state_revision=?`).run(now, now, POLICY_VERSION, deviceId || '', now, userId, instance.id, instance.state_revision);
  instance = db.prepare('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id = ? AND id = ?').get(userId, instance.id);
  const event = recordEvent(db, { userId, deviceId, commandId, instance, familyId: instance.agent_family_id, eventType: 'deactivated', previousState: 'active', nextState: 'inactive', quotaBefore, quotaAfter: activeEmployeeCount(db, userId) });
  bumpRosterRevision(db, userId);
  return commandResult(db, event, false);
}

function reject(db, { userId, deviceId, commandId, familyId, instance = null, code, expectedStateRevision }) {
  const active = activeEmployeeCount(db, userId);
  const event = recordEvent(db, {
    userId, deviceId, commandId, instance, familyId, eventType: 'rejected',
    previousState: instance?.employment_state || 'not_recruited', nextState: instance?.employment_state || 'not_recruited', code,
    metadata: expectedStateRevision === undefined ? {} : { expectedStateRevision: Number(expectedStateRevision), actualStateRevision: Number(instance?.state_revision || 0) },
    quotaBefore: active, quotaAfter: active,
  });
  return commandResult(db, event, false);
}

function recordEvent(db, { userId, deviceId, commandId, instance = null, familyId, eventType, previousState, nextState, code = '', metadata = {}, quotaBefore, quotaAfter }) {
  const id = `recruitment_event_${crypto.randomUUID()}`;
  const active = activeEmployeeCount(db, userId);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO cloud_user_agent_recruitment_events (
    id,user_id,user_agent_instance_id,agent_family_id,event_type,previous_state,next_state,quota_before,quota_after,
    command_id,source_device_id,reason,metadata_json,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, userId, instance?.id || '', familyId, eventType, previousState || '', nextState || '',
    Number(quotaBefore ?? active), Number(quotaAfter ?? active),
    commandId, deviceId || '', code, JSON.stringify({ code, status: eventType === 'rejected' ? 'rejected' : nextState, ...metadata }), now,
  );
  return db.prepare('SELECT * FROM cloud_user_agent_recruitment_events WHERE id = ?').get(id);
}

function commandResult(db, eventRow, idempotent) {
  const event = eventPayload(eventRow);
  const instance = event.agentInstanceId ? db.prepare('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id = ? AND id = ?').get(event.userId, event.agentInstanceId) : null;
  const active = activeEmployeeCount(db, event.userId);
  const rosterState = readRosterState(db, event.userId);
  return {
    status: event.eventType === 'rejected' ? 'rejected' : 'confirmed',
    action: event.eventType,
    code: event.reason || '',
    commandId: event.commandId,
    instance: instance ? instancePayload(instance) : null,
    event,
    quota: { active, reserved: 0, used: active, limit: EMPLOYEE_LIMIT, remaining: Math.max(0, EMPLOYEE_LIMIT - active), grandfatheredOverLimit: active > EMPLOYEE_LIMIT },
    rosterRevision: Number(rosterState?.roster_revision || 0),
    idempotent: Boolean(idempotent),
  };
}

function ensureRosterState(db, userId) {
  db.prepare(`INSERT OR IGNORE INTO cloud_employee_roster_states(user_id,bootstrap_status,policy_version)
    VALUES(?,'pending',?)`).run(userId, POLICY_VERSION);
}

function readRosterState(db, userId) {
  return db.prepare('SELECT * FROM cloud_employee_roster_states WHERE user_id=?').get(userId);
}

function bumpRosterRevision(db, userId) {
  ensureRosterState(db, userId);
  db.prepare('UPDATE cloud_employee_roster_states SET roster_revision=roster_revision+1,updated_at=? WHERE user_id=?')
    .run(new Date().toISOString(), userId);
}

function ensureSystemInstance(db, userId, familyId, deviceId = '') {
  const family = db.prepare("SELECT * FROM cloud_agent_families_v3 WHERE id=? AND instance_kind='system'").get(familyId);
  if (!family) return null;
  const existing = db.prepare('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=? AND agent_family_id=?').get(userId, familyId);
  if (existing) {
    ensureCanonicalMemory0(db, userId, existing, deviceId);
    return existing;
  }
  const now = new Date().toISOString();
  const id = `uagent_${crypto.randomUUID()}`;
  const familyInstanceSeq = nextFamilySequence(db, userId, familyId);
  const displayName = defaultAgentInstanceDisplayName(family.name || familyId, familyInstanceSeq, familyId);
  db.prepare(`INSERT INTO cloud_user_agent_instances_v3 (
    user_id,id,agent_family_id,base_agent_version_id,status,instance_kind,employment_state,quota_exempt,
    recruited_at,last_state_changed_at,state_revision,recruitment_source,policy_version,source_device_id,
    sync_enabled,personal_evolution_consent,cluster_contribution_consent,personal_skill_auto_activate,
    family_instance_seq,display_name,note,payload_json,created_at,updated_at
  ) VALUES(?,?,?,?,'active','system','active',1,?,?,1,'system_default',?,?,1,1,1,0,?,?,?, ?,?,?)`).run(
    userId, id, familyId, family.current_version_id || '', now, now, POLICY_VERSION, deviceId || '',
    familyInstanceSeq, displayName, '', JSON.stringify({ familyInstanceSeq, displayName, note: '' }), now, now,
  );
  const created = db.prepare('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=? AND id=?').get(userId, id);
  ensureCanonicalMemory0(db, userId, created, deviceId);
  return created;
}

function ensureCanonicalMemory0(db, userId, instance, deviceId = '') {
  if (!instance?.id) return null;
  let document = db.prepare(`SELECT * FROM cloud_memory_documents_v3
    WHERE user_id=? AND user_agent_instance_id=? AND scope='general' AND slot_no=0
      AND task_run_id='' AND project_id='' AND relationship_id=''
    ORDER BY created_at,id LIMIT 1`).get(userId, instance.id);
  if (!document) {
    const documentId = stableId('memory', userId, instance.id, 'general', '0');
    const versionId = stableId('memory_version', userId, instance.id, 'general', '0', '1');
    const cloudKey = stableId('memory_cloud', userId, instance.id, 'general', '0');
    const baseVersion = instance.base_agent_version_id
      ? db.prepare('SELECT payload_json FROM cloud_agent_versions_v3 WHERE id=?').get(instance.base_agent_version_id)
      : null;
    const versionPayload = parseObject(baseVersion?.payload_json);
    const content = String(versionPayload.memoryTemplateContent || versionPayload.memory_template_content
      || '# memory0.md\n\n## Stable Learnings\n\n## Reusable Preferences\n\n## Failure Modes\n\n## Workflow Notes\n\n<!-- scope:general -->\n');
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');
    const now = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO cloud_memory_documents_v3(
      user_id,id,user_agent_instance_id,agent_family_id,cloud_key,scope,slot_no,display_name,current_version_id,
      lifecycle_state,sync_enabled,allow_personal_evolution,allow_cluster_evolution,payload_json,created_at,updated_at
    ) VALUES(?,?,?,?,?,'general',0,'memory0.md',?,'active',1,?,?,?, ?,?)`).run(
      userId, documentId, instance.id, instance.agent_family_id || '', cloudKey, versionId,
      Number(instance.personal_evolution_consent || 0), instance.sync_enabled && instance.status === 'active' ? 1 : 0,
      JSON.stringify({ id: documentId, cloudKey, scope: 'general', slotNo: 0, displayName: 'memory0.md' }), now, now,
    );
    db.prepare(`INSERT OR IGNORE INTO cloud_memory_document_versions_v3(
      user_id,id,memory_document_id,version_no,content_hash,base_version_id,parent_version_id,branch_id,conflict_state,payload_json,created_at
    ) VALUES(?,?,?,1,?,'','','main','none',?,?)`).run(
      userId, versionId, documentId, contentHash,
      JSON.stringify({ id: versionId, memoryDocumentId: documentId, versionNo: 1, content, contentHash,
        sourceKind: 'agent_template', sourceId: instance.base_agent_version_id || '', privacyLevel: 'private',
        reviewStatus: 'seeded', createdBy: userId, branchId: 'main', conflictState: 'none', createdAt: now }), now,
    );
    document = db.prepare('SELECT * FROM cloud_memory_documents_v3 WHERE user_id=? AND id=?').get(userId, documentId);
  }
  let currentVersion = document.current_version_id
    ? db.prepare('SELECT id FROM cloud_memory_document_versions_v3 WHERE user_id=? AND id=?').get(userId, document.current_version_id)
    : db.prepare(`SELECT id FROM cloud_memory_document_versions_v3 WHERE user_id=? AND memory_document_id=?
      ORDER BY version_no DESC,created_at DESC,id DESC LIMIT 1`).get(userId, document.id);
  if (!currentVersion) {
    const baseVersion = instance.base_agent_version_id
      ? db.prepare('SELECT payload_json FROM cloud_agent_versions_v3 WHERE id=?').get(instance.base_agent_version_id)
      : null;
    const versionPayload = parseObject(baseVersion?.payload_json);
    const content = String(versionPayload.memoryTemplateContent || versionPayload.memory_template_content
      || '# memory0.md\n\n## Stable Learnings\n\n## Reusable Preferences\n\n## Failure Modes\n\n## Workflow Notes\n\n<!-- scope:general -->\n');
    const versionId = stableId('memory_version', userId, instance.id, document.id, '1');
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');
    const now = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO cloud_memory_document_versions_v3(
      user_id,id,memory_document_id,version_no,content_hash,base_version_id,parent_version_id,branch_id,conflict_state,payload_json,created_at
    ) VALUES(?,?,?,1,?,'','','main','none',?,?)`).run(
      userId, versionId, document.id, contentHash,
      JSON.stringify({ id: versionId, memoryDocumentId: document.id, versionNo: 1, content, contentHash,
        sourceKind: 'agent_template', sourceId: instance.base_agent_version_id || '', privacyLevel: 'private',
        reviewStatus: 'seeded', createdBy: userId, branchId: 'main', conflictState: 'none', createdAt: now }), now,
    );
    currentVersion = { id: versionId };
  }
  if (!document.current_version_id && currentVersion?.id) {
    db.prepare('UPDATE cloud_memory_documents_v3 SET current_version_id=?,updated_at=? WHERE user_id=? AND id=?')
      .run(currentVersion.id, new Date().toISOString(), userId, document.id);
    document = db.prepare('SELECT * FROM cloud_memory_documents_v3 WHERE user_id=? AND id=?').get(userId, document.id);
  }
  const existingContext = db.prepare(`SELECT id FROM cloud_agent_context_spaces
    WHERE user_id=? AND user_agent_instance_id=? AND context_kind='general_memory' AND memory_document_id=? LIMIT 1`)
    .get(userId, instance.id, document.id);
  const contextId = existingContext?.id || stableId('context', userId, instance.id, 'general', document.id);
  db.prepare(`INSERT INTO cloud_agent_context_spaces(
    user_id,id,user_agent_instance_id,context_kind,memory_document_id,lifecycle_state,created_at,updated_at
  ) VALUES(?,?,?,'general_memory',?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET
    lifecycle_state=excluded.lifecycle_state,updated_at=excluded.updated_at`).run(
    userId, contextId, instance.id, document.id, document.lifecycle_state === 'archived' ? 'archived' : 'active',
    document.created_at || new Date().toISOString(), new Date().toISOString(),
  );
  const cloudKey = document.cloud_key || document.id;
  db.prepare(`INSERT INTO cloud_memory_sync_mappings(
    owner_user_id,user_agent_instance_id,cloud_key,memory_document_id,status,created_at,updated_at
  ) VALUES(?,?,?,?,'active',?,?) ON CONFLICT(owner_user_id,user_agent_instance_id,cloud_key) DO UPDATE SET
    memory_document_id=excluded.memory_document_id,status='active',updated_at=excluded.updated_at`).run(
    userId, instance.id, cloudKey, document.id, document.created_at || new Date().toISOString(), new Date().toISOString(),
  );
  const active = db.prepare(`SELECT d.id,c.id AS context_id FROM cloud_memory_documents_v3 d
    LEFT JOIN cloud_agent_context_spaces c ON c.user_id=d.user_id AND c.memory_document_id=d.id AND c.context_kind='general_memory'
    WHERE d.user_id=? AND d.user_agent_instance_id=? AND d.scope='general' AND d.lifecycle_state='active'
    ORDER BY d.updated_at DESC,d.slot_no DESC,d.id DESC LIMIT 1`).get(userId, instance.id);
  db.prepare(`INSERT INTO cloud_agent_context_states(
    owner_user_id,user_agent_instance_id,active_context_space_id,active_memory_document_id,state_revision,
    last_command_id,source_device_id,created_at,updated_at
  ) VALUES(?,?,?,?,1,'employee_memory0',?,?,?) ON CONFLICT(owner_user_id,user_agent_instance_id) DO UPDATE SET
    active_context_space_id=CASE WHEN cloud_agent_context_states.active_context_space_id='' THEN excluded.active_context_space_id ELSE cloud_agent_context_states.active_context_space_id END,
    active_memory_document_id=CASE WHEN cloud_agent_context_states.active_memory_document_id='' THEN excluded.active_memory_document_id ELSE cloud_agent_context_states.active_memory_document_id END,
    updated_at=excluded.updated_at`).run(
    userId, instance.id, active?.context_id || contextId, active?.id || document.id, deviceId || '',
    document.created_at || new Date().toISOString(), new Date().toISOString(),
  );
  return document;
}

function stableId(prefix, ...parts) {
  return `${prefix}_${crypto.createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0, 40)}`;
}

function overviewPayload(db, userId) {
  ensureRosterState(db, userId);
  const instances = db.prepare('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=? ORDER BY created_at,id').all(userId);
  const roster = instances.filter((row) => row.instance_kind === 'employee' && !isLegacyPptAgentId(row.agent_family_id)).map(instancePayload);
  const systemRoster = instances.filter((row) => row.instance_kind === 'system').map(instancePayload);
  const active = roster.filter((item) => item.employmentState === 'active' && !item.quotaExempt).length;
  const state = readRosterState(db, userId);
  const families = db.prepare("SELECT * FROM cloud_agent_families_v3 WHERE instance_kind='employee' AND recruitable=1 ORDER BY default_for_new_user DESC,department_id,name,id").all()
    .filter((family) => !isLegacyPptAgentId(family.id));
  const aliases = db.prepare(`SELECT alias_instance_id,canonical_instance_id,reason,created_at
    FROM cloud_user_agent_instance_aliases_v3 WHERE user_id=? ORDER BY created_at,alias_instance_id`).all(userId).map((row) => ({
    aliasInstanceId: row.alias_instance_id,
    canonicalInstanceId: row.canonical_instance_id,
    reason: row.reason || '',
    createdAt: row.created_at || '',
  }));
  return {
    authority: 'cloud', authorityLocked: true, policyVersion: POLICY_VERSION, rosterRevision: Number(state.roster_revision || 0),
    bootstrap: { required: state.bootstrap_status !== 'completed', status: state.bootstrap_status, bootstrapId: state.bootstrap_id || '' },
    quota: { active, reserved: 0, used: active, limit: EMPLOYEE_LIMIT, remaining: Math.max(0, EMPLOYEE_LIMIT - active), grandfatheredOverLimit: active > EMPLOYEE_LIMIT },
    roster, systemRoster, aliases,
    recruitableFamilies: families.map((family) => ({
      ...familyPayload(family),
      instance: roster.find((item) => item.agentFamilyId === family.id) || null,
      instances: roster.filter((item) => item.agentFamilyId === family.id),
      instanceCount: roster.filter((item) => item.agentFamilyId === family.id).length,
      activeInstanceCount: roster.filter((item) => item.agentFamilyId === family.id && item.employmentState === 'active').length,
    })),
  };
}

function mergeInstanceAliases(...groups) {
  const merged = new Map();
  for (const item of groups.flat()) {
    const aliasInstanceId = String(item?.aliasInstanceId || '').trim();
    const canonicalInstanceId = String(item?.canonicalInstanceId || '').trim();
    if (!aliasInstanceId || !canonicalInstanceId || aliasInstanceId === canonicalInstanceId) continue;
    merged.set(aliasInstanceId, { ...item, aliasInstanceId, canonicalInstanceId });
  }
  return [...merged.values()];
}

function activeEmployeeCount(db, userId) {
  return Number(db.prepare("SELECT COUNT(*) AS count FROM cloud_user_agent_instances_v3 WHERE user_id=? AND instance_kind='employee' AND employment_state='active' AND quota_exempt=0").get(userId)?.count || 0);
}

function nextFamilySequence(db, userId, familyId) {
  return Number(db.prepare(`SELECT COALESCE(MAX(family_instance_seq),0) AS maximum
    FROM cloud_user_agent_instances_v3 WHERE user_id=? AND agent_family_id=?`).get(userId, familyId)?.maximum || 0) + 1;
}

function bootstrapFamilySequence(db, userId, familyId, requestedSequence = 0) {
  if (requestedSequence > 0) {
    const conflict = db.prepare(`SELECT 1 FROM cloud_user_agent_instances_v3
      WHERE user_id=? AND agent_family_id=? AND family_instance_seq=? LIMIT 1`).get(userId, familyId, requestedSequence);
    if (!conflict) return requestedSequence;
  }
  return nextFamilySequence(db, userId, familyId);
}

function instancePayload(row) {
  const payload = parseObject(row.payload_json);
  return {
    ...payload,
    familyInstanceSeq: Number(row.family_instance_seq || 0),
    displayName: row.display_name || '',
    note: row.note || '',
    id: row.id,
    userId: row.user_id,
    agentFamilyId: canonicalPptAgentId(row.agent_family_id),
    baseAgentVersionId: row.base_agent_version_id || '',
    activePersonalSkillVersionId: row.active_personal_skill_version_id || '',
    status: row.status,
    instanceKind: row.instance_kind,
    employmentState: row.employment_state,
    quotaExempt: Boolean(row.quota_exempt),
    stateRevision: Number(row.state_revision || 0),
    recruitedAt: row.recruited_at || '',
    deactivatedAt: row.deactivated_at || '',
    lastStateChangedAt: row.last_state_changed_at || '',
    recruitmentSource: row.recruitment_source || '',
    policyVersion: row.policy_version || '',
    syncEnabled: Boolean(row.sync_enabled),
    personalEvolutionConsent: Boolean(row.personal_evolution_consent),
    clusterContributionConsent: Boolean(row.cluster_contribution_consent),
    personalSkillAutoActivate: Boolean(row.personal_skill_auto_activate),
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}

function familyPayload(row) {
  return { ...parseObject(row.payload_json), id: row.id, name: canonicalAgentFamilyName(row.id, row.name), departmentId: row.department_id, role: row.role, status: row.status, routable: Boolean(row.routable), instanceKind: row.instance_kind, recruitable: Boolean(row.recruitable), defaultForNewUser: Boolean(row.default_for_new_user) };
}

function eventPayload(row) {
  return { id: row.id, userId: row.user_id, agentInstanceId: row.user_agent_instance_id || '', agentFamilyId: row.agent_family_id, eventType: row.event_type, previousState: row.previous_state, nextState: row.next_state, quotaBefore: Number(row.quota_before || 0), quotaAfter: Number(row.quota_after || 0), commandId: row.command_id, sourceDeviceId: row.source_device_id || '', reason: row.reason || '', metadata: parseObject(row.metadata_json), createdAt: row.created_at };
}

function requireUser(db, userId) { if (!userId || !db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) throw cloudApiError('unauthorized', 'Cloud employee user was not found.', 401); }
function required(value, code) { const text = String(value || '').trim(); if (!text) throw cloudApiError(code, code, 400); return text; }
function parseObject(value) { if (value && typeof value === 'object') return value; try { return JSON.parse(String(value || '{}')); } catch { return {}; } }
