import crypto from 'node:crypto';

import {
  CLOUD_EMPLOYEE_POLICY_VERSION,
  CLOUD_EMPLOYEE_QUOTA_LIMIT,
  cloudEmployeeCapability,
} from '../../../../src/shared/cloudContracts.js';
import { canonicalPptAgentId, isLegacyPptAgentId } from '../../../../src/shared/pptAgents.js';
import { canonicalGeneralAgentId, isLegacyGeneralAgentId } from '../../../../src/shared/generalAgents.js';
import { routeWithDeviceGrant } from '../sync/index.mjs';
import {
  canonicalAgentFamilyName,
  defaultAgentInstanceDisplayName,
  isDefaultAgentInstanceDisplayName,
} from '../../../../src/shared/agentInstanceNaming.js';

const EMPLOYEE_LIMIT = CLOUD_EMPLOYEE_QUOTA_LIMIT;
const POLICY_VERSION = CLOUD_EMPLOYEE_POLICY_VERSION;
const canonicalEmployeeAgentFamilyId = (value = '') => canonicalGeneralAgentId(canonicalPptAgentId(value));
const EMPLOYEE_READ_SCOPES = ['employees:read', 'evolution:read'];
const EMPLOYEE_WRITE_SCOPES = ['employees:write', 'evolution:write'];

export function registerEmployeeRoutes({ app, pool, apiError }) {
  const authority = createPostgresEmployeeAuthority({ pool, apiError });
  const employeeRoute = (scopes, handler) => routeWithDeviceGrant(pool, apiError, scopes, handler, { property: 'employeeGrant' });
  app.get('/v1/employees/capabilities', employeeRoute(EMPLOYEE_READ_SCOPES, async (_req, res) => {
    res.json(authority.capabilities());
  }));
  app.get('/v1/employees', employeeRoute(EMPLOYEE_READ_SCOPES, async (req, res) => {
    res.json(await authority.overview({ userId: req.employeeGrant.userId }));
  }));
  app.post('/v1/employees/bootstrap', employeeRoute(EMPLOYEE_WRITE_SCOPES, async (req, res) => {
    const result = await authority.bootstrap({
      userId: req.employeeGrant.userId,
      deviceId: req.employeeGrant.deviceId,
      payload: req.body || {},
    });
    res.status(result.idempotent ? 200 : 201).json(result);
  }));
  app.post('/v1/employees/commands', employeeRoute(EMPLOYEE_WRITE_SCOPES, async (req, res) => {
    const result = await authority.command({
      userId: req.employeeGrant.userId,
      deviceId: req.employeeGrant.deviceId,
      payload: req.body || {},
    });
    res.status(result.status === 'rejected' ? 409 : 200).json(result);
  }));
  app.get('/v1/employees/events', employeeRoute(EMPLOYEE_READ_SCOPES, async (req, res) => {
    res.json({
      authority: 'cloud',
      items: await authority.events({
        userId: req.employeeGrant.userId,
        cursor: req.query.cursor || '',
        limit: req.query.limit || 100,
      }),
    });
  }));
}

export function createPostgresEmployeeAuthority({ pool, apiError }) {
  if (!pool) throw new Error('PostgreSQL employee authority requires a pool.');
  return {
    capabilities() {
      return cloudEmployeeCapability(true);
    },

    async overview({ userId = '' } = {}) {
      await requireUser(pool, userId, apiError);
      await ensureRosterState(pool, userId);
      return overviewWithDb(pool, userId);
    },

    async bootstrap({ userId = '', deviceId = '', payload = {} } = {}) {
      const bootstrapId = required(payload.bootstrapId || payload.bootstrap_id, 'employee_bootstrap_id_required', apiError);
      const requested = Array.isArray(payload.instances) ? payload.instances : [];
      return withTransaction(pool, async (client) => {
        const state = await lockRosterState(client, userId, apiError);
        const evolutionEnabled = await userEvolutionEnabled(client, userId);
        if (state.bootstrap_status === 'completed') {
          if (state.bootstrap_id !== bootstrapId) {
            throw apiError('employee_bootstrap_already_completed', 'Employee roster bootstrap has already completed.', 409);
          }
          const existingInstances = (await client.query(
            'SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=$1 ORDER BY created_at,id', [userId],
          )).rows;
          for (const existingInstance of existingInstances) await ensureCanonicalMemory0(client, userId, existingInstance, deviceId);
          return { ...(await overviewWithDb(client, userId)), status: 'completed', bootstrapId, idempotent: true };
        }
        const aliases = [];
        const bootstrapItems = requested.filter((item) => canonicalEmployeeAgentFamilyId(item?.agentFamilyId || item?.agent_family_id || ''));
        if (!bootstrapItems.length) {
          const defaultFamily = (await client.query(`SELECT id FROM cloud_agent_families_v3
            WHERE instance_kind='employee' AND recruitable=true AND default_for_new_user=true
            ORDER BY id LIMIT 1`)).rows[0];
          if (defaultFamily) bootstrapItems.push({ agentFamilyId: defaultFamily.id, employmentState: 'active' });
        }
        for (const item of bootstrapItems) {
          const familyId = canonicalEmployeeAgentFamilyId(item?.agentFamilyId || item?.agent_family_id || '');
          const family = (await client.query('SELECT * FROM cloud_agent_families_v3 WHERE id=$1', [familyId])).rows[0];
          if (!family || family.instance_kind !== 'employee') continue;
          const requestedId = String(item.proposedInstanceId || item.proposed_instance_id || item.id || '').trim();
          let instance = requestedId ? (await client.query(`SELECT * FROM cloud_user_agent_instances_v3
            WHERE user_id=$1 AND id=$2 FOR UPDATE`, [userId, requestedId])).rows[0] : null;
          if (instance && canonicalEmployeeAgentFamilyId(instance.agent_family_id) !== familyId) instance = null;
          let canonicalId = requestedId || `uagent_${crypto.randomUUID()}`;
          const collision = (await client.query(`SELECT agent_family_id FROM cloud_user_agent_instances_v3
            WHERE user_id=$1 AND id=$2`, [userId, canonicalId])).rows[0];
          if (!instance && collision && collision.agent_family_id !== familyId) canonicalId = `uagent_${crypto.randomUUID()}`;
          if (requestedId && requestedId !== canonicalId) {
            await client.query(`INSERT INTO cloud_user_agent_instance_aliases_v3(user_id,alias_instance_id,canonical_instance_id,reason)
              VALUES($1,$2,$3,'employee_bootstrap_canonical') ON CONFLICT(user_id,alias_instance_id)
              DO UPDATE SET canonical_instance_id=excluded.canonical_instance_id,reason=excluded.reason`, [userId, requestedId, canonicalId]);
            aliases.push({ aliasInstanceId: requestedId, canonicalInstanceId: canonicalId });
          }
          const employmentState = String(item.employmentState || item.employment_state || 'active') === 'inactive' ? 'inactive' : 'active';
          const now = new Date();
          if (!instance) {
            const requestedSequence = Math.max(0, Math.floor(Number(item.familyInstanceSeq || item.family_instance_seq || 0) || 0));
            const familyInstanceSeq = await bootstrapFamilySequence(client, userId, familyId, requestedSequence);
            const requestedDisplayName = String(item.displayName || item.display_name || '').trim();
            const displayName = !requestedDisplayName || isDefaultAgentInstanceDisplayName(requestedDisplayName, family.name || familyId, familyId)
              ? defaultAgentInstanceDisplayName(family.name || familyId, familyInstanceSeq, familyId)
              : requestedDisplayName;
            const note = String(item.note || '').slice(0, 500);
            const profilePayload = { displayName, familyInstanceSeq, note };
            await client.query(`INSERT INTO cloud_user_agent_instances_v3 (
              user_id,id,agent_family_id,base_agent_version_id,status,instance_kind,employment_state,quota_exempt,
              recruited_at,deactivated_at,last_state_changed_at,state_revision,recruitment_source,policy_version,source_device_id,
              sync_enabled,personal_evolution_consent,cluster_contribution_consent,personal_skill_auto_activate,
              family_instance_seq,display_name,note,payload_json,created_at,updated_at
            ) VALUES($1,$2,$3,$4,$5,'employee',$5,false,$6,$7,$8,$9,'migration',$10,$11,true,$13,$13,false,
              $14,$15,$16,$17::jsonb,$12,$12)`, [
              userId, canonicalId, familyId, family.current_version_id || '', employmentState,
              item.recruitedAt || item.recruited_at || now, employmentState === 'inactive' ? (item.deactivatedAt || item.deactivated_at || now) : null,
              item.lastStateChangedAt || item.last_state_changed_at || now, Math.max(1, Number(item.stateRevision || item.state_revision || 1)),
              POLICY_VERSION, deviceId || '', item.createdAt || item.created_at || now, evolutionEnabled && employmentState === 'active',
              familyInstanceSeq, displayName, note, JSON.stringify(profilePayload),
            ]);
            instance = (await client.query('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND id=$2', [userId, canonicalId])).rows[0];
          } else if (instance.policy_version !== POLICY_VERSION) {
            instance = (await client.query(`UPDATE cloud_user_agent_instances_v3 SET status=$1,employment_state=$1,
              instance_kind='employee',quota_exempt=false,policy_version=$2,recruitment_source='migration',source_device_id=$3,
              sync_enabled=true,personal_evolution_consent=($7 AND $1='active'),cluster_contribution_consent=($7 AND $1='active'),personal_skill_auto_activate=false,
              state_revision=GREATEST(state_revision,$4),last_state_changed_at=COALESCE(last_state_changed_at,now()),updated_at=now()
              WHERE user_id=$5 AND id=$6 RETURNING *`, [employmentState, POLICY_VERSION, deviceId || '', Math.max(1, Number(item.stateRevision || item.state_revision || 1)), userId, instance.id, evolutionEnabled])).rows[0];
          }
          await ensureCanonicalMemory0(client, userId, instance, deviceId);
          const commandId = `${bootstrapId}:${canonicalId}`;
          const existingEvent = (await client.query(`SELECT id FROM cloud_user_agent_recruitment_events
            WHERE user_id=$1 AND command_id=$2`, [userId, commandId])).rows[0];
          if (!existingEvent) await recordEvent(client, {
            userId, deviceId, commandId, instance, familyId, eventType: 'migrated', previousState: 'not_recruited',
            nextState: instance.employment_state, quotaBefore: await activeEmployeeCount(client, userId), quotaAfter: await activeEmployeeCount(client, userId),
          });
        }
        if (Number((await client.query(`SELECT COUNT(*)::int AS count FROM cloud_user_agent_instances_v3
          WHERE user_id=$1 AND instance_kind='employee'`, [userId])).rows[0]?.count || 0) === 0) {
          throw apiError('employee_catalog_not_ready', 'Cloud employee catalog is not ready for roster bootstrap.', 503);
        }
        await ensureSystemInstance(client, userId, 'secretary_agent', deviceId);
        await client.query(`UPDATE cloud_employee_roster_states SET bootstrap_status='completed',bootstrap_id=$1,
          roster_revision=roster_revision+1,bootstrapped_at=now(),updated_at=now() WHERE user_id=$2`, [bootstrapId, userId]);
        const completed = await overviewWithDb(client, userId);
        return {
          ...completed,
          status: 'completed',
          bootstrapId,
          idempotent: false,
          aliases: mergeInstanceAliases(completed.aliases, aliases),
        };
      });
    },

    async command({ userId = '', deviceId = '', payload = {} } = {}) {
      const commandId = required(payload.commandId || payload.command_id, 'recruitment_command_required', apiError);
      const action = String(payload.action || '').trim();
      if (!['recruit', 'deactivate', 'reactivate'].includes(action)) {
        throw apiError('employee_command_invalid', 'Employee command action is invalid.', 400);
      }
      return withTransaction(pool, async (client) => {
        const rosterState = await lockRosterState(client, userId, apiError);
        if (rosterState.bootstrap_status !== 'completed') {
          throw apiError('employee_bootstrap_required', 'Employee roster bootstrap must complete before lifecycle commands.', 409);
        }
        const existing = (await client.query(
          'SELECT * FROM cloud_user_agent_recruitment_events WHERE user_id=$1 AND command_id=$2',
          [userId, commandId],
        )).rows[0];
        if (existing) return commandResult(client, existing, true);
        return action === 'recruit'
          ? recruit(client, { userId, deviceId, commandId, payload, apiError })
          : changeState(client, { userId, deviceId, commandId, payload, action, apiError });
      });
    },

    async events({ userId = '', cursor = '', limit = 100 } = {}) {
      await requireUser(pool, userId, apiError);
      const values = [userId];
      let filter = '';
      if (cursor) {
        values.push(cursor);
        filter = ` AND created_at > $${values.length}`;
      }
      values.push(Math.max(1, Math.min(500, Number(limit || 100))));
      const rows = (await pool.query(`SELECT * FROM cloud_user_agent_recruitment_events
        WHERE user_id=$1${filter} ORDER BY created_at,id LIMIT $${values.length}`, values)).rows;
      return rows.map(eventPayload);
    },
  };
}

async function recruit(client, { userId, deviceId, commandId, payload, apiError }) {
  const evolutionEnabled = await userEvolutionEnabled(client, userId);
  const familyId = canonicalEmployeeAgentFamilyId(required(payload.agentFamilyId || payload.agent_family_id, 'agent_family_required', apiError));
  const family = (await client.query('SELECT * FROM cloud_agent_families_v3 WHERE id=$1', [familyId])).rows[0];
  if (!family || family.instance_kind !== 'employee' || !family.recruitable) {
    return reject(client, { userId, deviceId, commandId, familyId, code: 'agent_not_recruitable' });
  }
  const adoptedState = payload.adoptLocalInstance === true && String(payload.employmentState || payload.employment_state || '') === 'inactive'
    ? 'inactive'
    : 'active';
  const quotaBefore = await activeEmployeeCount(client, userId);
  if (adoptedState === 'active' && quotaBefore >= EMPLOYEE_LIMIT) {
    return reject(client, { userId, deviceId, commandId, familyId, code: 'employee_quota_exceeded' });
  }
  const now = new Date();
  const deactivatedAt = adoptedState === 'inactive' ? now : null;
  let id = String(payload.proposedInstanceId || payload.proposed_instance_id || '').trim() || `uagent_${crypto.randomUUID()}`;
  const collision = (await client.query('SELECT id FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND id=$2', [userId, id])).rows[0];
  if (collision) id = `uagent_${crypto.randomUUID()}`;
  const familyInstanceSeq = await nextFamilySequence(client, userId, familyId);
  const requestedDisplayName = String(payload.displayName || payload.display_name || '').trim();
  const displayName = !requestedDisplayName || isDefaultAgentInstanceDisplayName(requestedDisplayName, family.name || familyId, familyId)
    ? defaultAgentInstanceDisplayName(family.name || familyId, familyInstanceSeq, familyId)
    : requestedDisplayName;
  const note = String(payload.note || '').slice(0, 500);
  await client.query(`INSERT INTO cloud_user_agent_instances_v3 (
      user_id,id,agent_family_id,base_agent_version_id,status,instance_kind,employment_state,quota_exempt,
      recruited_at,deactivated_at,last_state_changed_at,state_revision,recruitment_source,policy_version,source_device_id,
      sync_enabled,personal_evolution_consent,cluster_contribution_consent,personal_skill_auto_activate,
      family_instance_seq,display_name,note,payload_json,created_at,updated_at
    ) VALUES ($1,$2,$3,$4,$5,'employee',$5,false,$6,$7,$6,1,$8,$9,$10,true,$11,$11,false,
      $12,$13,$14,$15::jsonb,$6,$6)`,
  [userId, id, familyId, family.current_version_id || '', adoptedState, now, deactivatedAt,
    payload.adoptLocalInstance === true ? 'local_instance_adoption' : 'user', POLICY_VERSION, deviceId || '',
    evolutionEnabled && adoptedState === 'active', familyInstanceSeq, displayName, note,
    JSON.stringify({ displayName, familyInstanceSeq, note, adoptedLocalInstance: payload.adoptLocalInstance === true })]);
  const instance = (await client.query('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND id=$2', [userId, id])).rows[0];
  await ensureCanonicalMemory0(client, userId, instance, deviceId);
  const quotaAfter = await activeEmployeeCount(client, userId);
  const event = await recordEvent(client, {
    userId, deviceId, commandId, instance, familyId,
    eventType: 'recruited', previousState: 'not_recruited', nextState: 'active', quotaBefore, quotaAfter,
  });
  await bumpRosterRevision(client, userId);
  return commandResult(client, event, false);
}

async function changeState(client, { userId, deviceId, commandId, payload, action, apiError }) {
  const evolutionEnabled = await userEvolutionEnabled(client, userId);
  const requestedInstanceId = required(payload.agentInstanceId || payload.agent_instance_id, 'agent_instance_not_found', apiError);
  const instanceId = await resolveOwnedEmployeeInstanceId(client, userId, requestedInstanceId, apiError);
  let instance = (await client.query(
    'SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND id=$2 FOR UPDATE', [userId, instanceId],
  )).rows[0];
  if (!instance) throw apiError('agent_instance_not_found', 'Employee Agent instance was not found.', 404);
  if (instance.instance_kind !== 'employee' || instance.quota_exempt) {
    throw apiError('agent_not_recruitable', 'Only employee instances can change employment state.', 409);
  }
  const expected = Number(payload.expectedStateRevision ?? payload.expected_state_revision);
  if (!Number.isInteger(expected) || expected < 1 || expected !== Number(instance.state_revision)) {
    return reject(client, {
      userId, deviceId, commandId, familyId: instance.agent_family_id, instance,
      code: 'employee_state_conflict', expectedStateRevision: payload.expectedStateRevision ?? payload.expected_state_revision,
    });
  }
  if (action === 'reactivate') {
    const quotaBefore = await activeEmployeeCount(client, userId);
    if (instance.employment_state === 'active') {
      const event = await recordEvent(client, { userId, deviceId, commandId, instance, familyId: instance.agent_family_id,
        eventType: 'reconciled', previousState: 'active', nextState: 'active', code: 'agent_already_active', quotaBefore, quotaAfter: quotaBefore });
      return commandResult(client, event, false);
    }
    if (quotaBefore >= EMPLOYEE_LIMIT) return reject(client, { userId, deviceId, commandId, familyId: instance.agent_family_id, instance, code: 'employee_quota_exceeded' });
    const now = new Date();
    const updated = await client.query(`UPDATE cloud_user_agent_instances_v3 SET status='active',employment_state='active',deactivated_at=NULL,
      last_state_changed_at=$1,state_revision=state_revision+1,recruitment_source='user_reactivation',policy_version=$2,
      source_device_id=$3,personal_evolution_consent=$7,cluster_contribution_consent=$7,updated_at=$1
      WHERE user_id=$4 AND id=$5 AND state_revision=$6 RETURNING *`, [
      now, POLICY_VERSION, deviceId || '', userId, instance.id, instance.state_revision, evolutionEnabled,
    ]);
    instance = updated.rows[0];
    if (!instance) return reject(client, { userId, deviceId, commandId, familyId: instanceId, code: 'employee_state_conflict' });
    await ensureCanonicalMemory0(client, userId, instance, deviceId);
    const event = await recordEvent(client, { userId, deviceId, commandId, instance, familyId: instance.agent_family_id,
      eventType: 'reactivated', previousState: 'inactive', nextState: 'active', quotaBefore, quotaAfter: await activeEmployeeCount(client, userId) });
    await bumpRosterRevision(client, userId);
    return commandResult(client, event, false);
  }
  const quotaBefore = await activeEmployeeCount(client, userId);
  if (instance.employment_state === 'inactive') {
    const event = await recordEvent(client, {
      userId, deviceId, commandId, instance, familyId: instance.agent_family_id,
      eventType: 'reconciled', previousState: 'inactive', nextState: 'inactive',
      code: 'agent_already_inactive', quotaBefore, quotaAfter: quotaBefore,
    });
    return commandResult(client, event, false);
  }
  const now = new Date();
  const updated = await client.query(`UPDATE cloud_user_agent_instances_v3 SET
    status='inactive',employment_state='inactive',deactivated_at=$1,last_state_changed_at=$1,
    state_revision=state_revision+1,policy_version=$2,source_device_id=$3,cluster_contribution_consent=false,updated_at=$1
    WHERE user_id=$4 AND id=$5 AND state_revision=$6 RETURNING *`,
  [now, POLICY_VERSION, deviceId || '', userId, instance.id, instance.state_revision]);
  instance = updated.rows[0];
  if (!instance) return reject(client, { userId, deviceId, commandId, familyId: instanceId, code: 'employee_state_conflict' });
  const quotaAfter = await activeEmployeeCount(client, userId);
  const event = await recordEvent(client, {
    userId, deviceId, commandId, instance, familyId: instance.agent_family_id,
    eventType: 'deactivated', previousState: 'active', nextState: 'inactive', quotaBefore, quotaAfter,
  });
  await bumpRosterRevision(client, userId);
  return commandResult(client, event, false);
}

export async function resolveOwnedEmployeeInstanceId(client, userId, value, apiError) {
  let instanceId = String(value || '').trim();
  const visited = new Set();
  while (instanceId) {
    if (visited.has(instanceId)) break;
    visited.add(instanceId);
    const alias = (await client.query(`SELECT canonical_instance_id FROM cloud_user_agent_instance_aliases_v3
      WHERE user_id=$1 AND alias_instance_id=$2`, [userId, instanceId])).rows[0];
    if (alias?.canonical_instance_id) {
      instanceId = String(alias.canonical_instance_id).trim();
      continue;
    }
    const instance = (await client.query(`SELECT id FROM cloud_user_agent_instances_v3
      WHERE user_id=$1 AND id=$2`, [userId, instanceId])).rows[0];
    if (instance) return instance.id;
    break;
  }
  throw apiError('agent_instance_not_found', 'Employee Agent instance was not found.', 404);
}

async function reject(client, { userId, deviceId, commandId, familyId, instance = null, code, expectedStateRevision }) {
  const active = await activeEmployeeCount(client, userId);
  const event = await recordEvent(client, {
    userId, deviceId, commandId, instance, familyId, eventType: 'rejected',
    previousState: instance?.employment_state || 'not_recruited',
    nextState: instance?.employment_state || 'not_recruited', code, quotaBefore: active, quotaAfter: active,
    metadata: expectedStateRevision === undefined ? {} : {
      expectedStateRevision: Number(expectedStateRevision), actualStateRevision: Number(instance?.state_revision || 0),
    },
  });
  return commandResult(client, event, false);
}

async function recordEvent(client, {
  userId, deviceId, commandId, instance = null, familyId, eventType, previousState, nextState,
  code = '', quotaBefore = 0, quotaAfter = 0, metadata = {},
}) {
  const id = `recruitment_event_${crypto.randomUUID()}`;
  const createdAt = new Date();
  const payload = { code, status: eventType === 'rejected' ? 'rejected' : nextState, ...metadata };
  const row = await client.query(`INSERT INTO cloud_user_agent_recruitment_events (
    id,user_id,user_agent_instance_id,agent_family_id,event_type,previous_state,next_state,quota_before,quota_after,
    command_id,source_device_id,reason,metadata_json,created_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14) RETURNING *`, [
    id, userId, instance?.id || '', familyId || instance?.agent_family_id || '', eventType,
    previousState || '', nextState || '', quotaBefore, quotaAfter, commandId, deviceId || '', code,
    JSON.stringify(payload), createdAt,
  ]);
  return row.rows[0];
}

async function commandResult(client, eventRow, idempotent) {
  const event = eventPayload(eventRow);
  const instance = event.agentInstanceId
    ? (await client.query('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND id=$2', [event.userId, event.agentInstanceId])).rows[0]
    : null;
  const active = await activeEmployeeCount(client, event.userId);
  const rosterState = await readRosterState(client, event.userId);
  return {
    status: event.eventType === 'rejected' ? 'rejected' : 'confirmed',
    action: event.eventType,
    code: event.reason || '',
    commandId: event.commandId,
    instance: instance ? instancePayload(instance) : null,
    event,
    quota: quotaPayload(active),
    rosterRevision: Number(rosterState?.roster_revision || 0),
    idempotent: Boolean(idempotent),
  };
}

async function ensureRosterState(db, userId) {
  await db.query(`INSERT INTO cloud_employee_roster_states(user_id,bootstrap_status,policy_version)
    VALUES($1,'pending',$2) ON CONFLICT(user_id) DO NOTHING`, [userId, POLICY_VERSION]);
}

async function readRosterState(db, userId) {
  return (await db.query('SELECT * FROM cloud_employee_roster_states WHERE user_id=$1', [userId])).rows[0] || null;
}

async function lockRosterState(client, userId, apiError) {
  const user = (await client.query('SELECT id FROM users WHERE id=$1', [userId])).rows[0];
  if (!user) throw apiError('unauthorized', 'Cloud employee user was not found.', 401);
  await ensureRosterState(client, userId);
  return (await client.query('SELECT * FROM cloud_employee_roster_states WHERE user_id=$1 FOR UPDATE', [userId])).rows[0];
}

async function bumpRosterRevision(client, userId) {
  await client.query(`UPDATE cloud_employee_roster_states SET roster_revision=roster_revision+1,updated_at=now()
    WHERE user_id=$1`, [userId]);
}

async function ensureSystemInstance(client, userId, familyId, deviceId = '') {
  const evolutionEnabled = await userEvolutionEnabled(client, userId);
  const family = (await client.query('SELECT * FROM cloud_agent_families_v3 WHERE id=$1 AND instance_kind=$2', [familyId, 'system'])).rows[0];
  if (!family) return null;
  const existing = (await client.query('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND agent_family_id=$2', [userId, familyId])).rows[0];
  if (existing) {
    await ensureCanonicalMemory0(client, userId, existing, deviceId);
    return existing;
  }
  const now = new Date();
  const id = `uagent_${crypto.randomUUID()}`;
  const familyInstanceSeq = await nextFamilySequence(client, userId, familyId);
  const displayName = defaultAgentInstanceDisplayName(family.name || familyId, familyInstanceSeq, familyId);
  const created = (await client.query(`INSERT INTO cloud_user_agent_instances_v3 (
    user_id,id,agent_family_id,base_agent_version_id,status,instance_kind,employment_state,quota_exempt,
    recruited_at,last_state_changed_at,state_revision,recruitment_source,policy_version,source_device_id,
    sync_enabled,personal_evolution_consent,cluster_contribution_consent,personal_skill_auto_activate,
    family_instance_seq,display_name,note,payload_json,created_at,updated_at
  ) VALUES($1,$2,$3,$4,'active','system','active',true,$5,$5,1,'system_default',$6,$7,true,$8,$8,false,
    $9,$10,'',$11::jsonb,$5,$5)
  RETURNING *`, [userId, id, familyId, family.current_version_id || '', now, POLICY_VERSION, deviceId || '', evolutionEnabled,
    familyInstanceSeq, displayName, JSON.stringify({ familyInstanceSeq, displayName, note: '' })])).rows[0];
  await ensureCanonicalMemory0(client, userId, created, deviceId);
  return created;
}

async function userEvolutionEnabled(queryable, userId = '') {
  return true;
}

async function ensureCanonicalMemory0(client, userId, instance, deviceId = '') {
  if (!instance?.id) return null;
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`canonical-memory0\u001f${userId}\u001f${instance.id}`]);
  } catch (error) {
    if (!/hashtextextended|pg_advisory_xact_lock/i.test(String(error?.message || ''))) throw error;
  }
  let document = (await client.query(`SELECT * FROM cloud_memory_documents_v3
    WHERE user_id=$1 AND user_agent_instance_id=$2 AND scope='general' AND slot_no=0
      AND task_run_id='' AND project_id='' AND relationship_id=''
    ORDER BY created_at,id LIMIT 1`, [userId, instance.id])).rows[0];
  if (!document) {
    const documentId = stableId('memory', userId, instance.id, 'general', '0');
    const versionId = stableId('memory_version', userId, instance.id, 'general', '0', '1');
    const cloudKey = stableId('memory_cloud', userId, instance.id, 'general', '0');
    const baseVersion = instance.base_agent_version_id
      ? (await client.query('SELECT payload_json FROM cloud_agent_versions_v3 WHERE id=$1', [instance.base_agent_version_id])).rows[0]
      : null;
    const versionPayload = jsonObject(baseVersion?.payload_json);
    const content = String(versionPayload.memoryTemplateContent || versionPayload.memory_template_content
      || `# memory0.md\n\n## Stable Learnings\n\n## Reusable Preferences\n\n## Failure Modes\n\n## Workflow Notes\n\n<!-- scope:general -->\n`);
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');
    const now = new Date();
    await client.query(`INSERT INTO cloud_memory_documents_v3(
      user_id,id,user_agent_instance_id,agent_family_id,cloud_key,scope,slot_no,display_name,
      visibility,current_version_id,lifecycle_state,sync_enabled,allow_personal_evolution,allow_cluster_evolution,
      payload_json,created_at,updated_at
    ) VALUES($1,$2,$3,$4,$5,'general',0,'memory0.md','agent_private',$6,'active',true,$7,$8,$9::jsonb,$10,$10)
    ON CONFLICT(user_id,id) DO NOTHING`, [
      userId, documentId, instance.id, instance.agent_family_id || '', cloudKey, versionId,
      Boolean(instance.personal_evolution_consent), Boolean(instance.sync_enabled && instance.status === 'active'),
      JSON.stringify({ id: documentId, cloudKey, scope: 'general', slotNo: 0, displayName: 'memory0.md' }), now,
    ]);
    await client.query(`INSERT INTO cloud_memory_document_versions_v3(
      user_id,id,memory_document_id,version_no,content_hash,base_version_id,parent_version_id,branch_id,conflict_state,payload_json,created_at
    ) VALUES($1,$2,$3,1,$4,'','','main','none',$5::jsonb,$6) ON CONFLICT(user_id,id) DO NOTHING`, [
      userId, versionId, documentId, contentHash,
      JSON.stringify({ id: versionId, memoryDocumentId: documentId, versionNo: 1, content, contentHash,
        sourceKind: 'agent_template', sourceId: instance.base_agent_version_id || '', privacyLevel: 'private',
        reviewStatus: 'seeded', createdBy: userId, branchId: 'main', conflictState: 'none', createdAt: now.toISOString() }), now,
    ]);
    document = (await client.query('SELECT * FROM cloud_memory_documents_v3 WHERE user_id=$1 AND id=$2', [userId, documentId])).rows[0];
  }
  let currentVersion = document.current_version_id
    ? (await client.query('SELECT id FROM cloud_memory_document_versions_v3 WHERE user_id=$1 AND id=$2', [userId, document.current_version_id])).rows[0]
    : (await client.query(`SELECT id FROM cloud_memory_document_versions_v3 WHERE user_id=$1 AND memory_document_id=$2
      ORDER BY version_no DESC,created_at DESC,id DESC LIMIT 1`, [userId, document.id])).rows[0];
  if (!currentVersion) {
    const baseVersion = instance.base_agent_version_id
      ? (await client.query('SELECT payload_json FROM cloud_agent_versions_v3 WHERE id=$1', [instance.base_agent_version_id])).rows[0]
      : null;
    const versionPayload = jsonObject(baseVersion?.payload_json);
    const content = String(versionPayload.memoryTemplateContent || versionPayload.memory_template_content
      || `# memory0.md\n\n## Stable Learnings\n\n## Reusable Preferences\n\n## Failure Modes\n\n## Workflow Notes\n\n<!-- scope:general -->\n`);
    const versionId = stableId('memory_version', userId, instance.id, document.id, '1');
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');
    const now = new Date();
    await client.query(`INSERT INTO cloud_memory_document_versions_v3(
      user_id,id,memory_document_id,version_no,content_hash,base_version_id,parent_version_id,branch_id,conflict_state,payload_json,created_at
    ) VALUES($1,$2,$3,1,$4,'','','main','none',$5::jsonb,$6) ON CONFLICT(user_id,id) DO NOTHING`, [
      userId, versionId, document.id, contentHash,
      JSON.stringify({ id: versionId, memoryDocumentId: document.id, versionNo: 1, content, contentHash,
        sourceKind: 'agent_template', sourceId: instance.base_agent_version_id || '', privacyLevel: 'private',
        reviewStatus: 'seeded', createdBy: userId, branchId: 'main', conflictState: 'none', createdAt: now.toISOString() }), now,
    ]);
    currentVersion = { id: versionId };
  }
  if (!document.current_version_id && currentVersion?.id) {
    await client.query('UPDATE cloud_memory_documents_v3 SET current_version_id=$1,updated_at=now() WHERE user_id=$2 AND id=$3', [
      currentVersion.id, userId, document.id,
    ]);
    document = (await client.query('SELECT * FROM cloud_memory_documents_v3 WHERE user_id=$1 AND id=$2', [userId, document.id])).rows[0];
  }
  let contextId = (await client.query(`SELECT id FROM cloud_agent_context_spaces
    WHERE user_id=$1 AND user_agent_instance_id=$2 AND context_kind='general_memory' AND memory_document_id=$3
    LIMIT 1`, [userId, instance.id, document.id])).rows[0]?.id
    || stableId('context', userId, instance.id, 'general', document.id);
  await client.query(`INSERT INTO cloud_agent_context_spaces(
    user_id,id,user_agent_instance_id,context_kind,memory_document_id,lifecycle_state,created_at,updated_at
  ) VALUES($1,$2,$3,'general_memory',$4,$5,now(),now()) ON CONFLICT(user_id,id) DO NOTHING`, [
    userId, contextId, instance.id, document.id, document.lifecycle_state === 'archived' ? 'archived' : 'active',
  ]);
  contextId = (await client.query(`SELECT id FROM cloud_agent_context_spaces
    WHERE user_id=$1 AND user_agent_instance_id=$2 AND context_kind='general_memory' AND memory_document_id=$3
    LIMIT 1`, [userId, instance.id, document.id])).rows[0]?.id || contextId;
  const cloudKey = document.cloud_key || document.id;
  await client.query(`INSERT INTO cloud_memory_sync_mappings(
    owner_user_id,user_agent_instance_id,cloud_key,memory_document_id,status,created_at,updated_at
  ) VALUES($1,$2,$3,$4,'active',now(),now()) ON CONFLICT(owner_user_id,user_agent_instance_id,cloud_key) DO NOTHING`,
  [userId, instance.id, cloudKey, document.id]);
  const active = (await client.query(`SELECT d.id,c.id AS context_id FROM cloud_memory_documents_v3 d
    LEFT JOIN cloud_agent_context_spaces c ON c.user_id=d.user_id AND c.memory_document_id=d.id AND c.context_kind='general_memory'
    WHERE d.user_id=$1 AND d.user_agent_instance_id=$2 AND d.scope='general' AND d.lifecycle_state='active'
    ORDER BY d.updated_at DESC,d.slot_no DESC,d.id DESC LIMIT 1`, [userId, instance.id])).rows[0];
  await client.query(`INSERT INTO cloud_agent_context_states(
    owner_user_id,user_agent_instance_id,active_context_space_id,active_memory_document_id,state_revision,
    last_command_id,source_device_id,created_at,updated_at
  ) VALUES($1,$2,$3,$4,1,'employee_memory0',$5,now(),now())
  ON CONFLICT(owner_user_id,user_agent_instance_id) DO UPDATE SET
    active_context_space_id=CASE WHEN cloud_agent_context_states.active_context_space_id='' THEN excluded.active_context_space_id ELSE cloud_agent_context_states.active_context_space_id END,
    active_memory_document_id=CASE WHEN cloud_agent_context_states.active_memory_document_id='' THEN excluded.active_memory_document_id ELSE cloud_agent_context_states.active_memory_document_id END,
    updated_at=CASE WHEN cloud_agent_context_states.active_context_space_id='' OR cloud_agent_context_states.active_memory_document_id=''
      THEN now() ELSE cloud_agent_context_states.updated_at END`, [
    userId, instance.id, active?.context_id || contextId, active?.id || document.id, deviceId || '',
  ]);
  await publishCanonicalMemoryState(client, userId, instance.id, deviceId || 'cloud_employee_authority');
  return document;
}

async function publishCanonicalMemoryState(client, userId, instanceId, deviceId) {
  const document = (await client.query(`SELECT * FROM cloud_memory_documents_v3
    WHERE user_id=$1 AND user_agent_instance_id=$2 AND scope='general' AND slot_no=0
    ORDER BY created_at,id LIMIT 1`, [userId, instanceId])).rows[0];
  if (!document) return;
  const version = document.current_version_id
    ? (await client.query(`SELECT * FROM cloud_memory_document_versions_v3 WHERE user_id=$1 AND id=$2`,
      [userId, document.current_version_id])).rows[0]
    : null;
  const context = (await client.query(`SELECT * FROM cloud_agent_context_spaces
    WHERE user_id=$1 AND user_agent_instance_id=$2 AND context_kind='general_memory' AND memory_document_id=$3 LIMIT 1`,
  [userId, instanceId, document.id])).rows[0];
  const mapping = (await client.query(`SELECT * FROM cloud_memory_sync_mappings
    WHERE owner_user_id=$1 AND user_agent_instance_id=$2 AND memory_document_id=$3 AND status='active' LIMIT 1`,
  [userId, instanceId, document.id])).rows[0];
  const state = (await client.query(`SELECT * FROM cloud_agent_context_states
    WHERE owner_user_id=$1 AND user_agent_instance_id=$2`, [userId, instanceId])).rows[0];
  const entities = [
    ['memory_document', document.id, { ...jsonObject(document.payload_json), ...document }],
    version ? ['memory_document_version', version.id, { ...jsonObject(version.payload_json), ...version }] : null,
    context ? ['agent_context_space', context.id, { ...context }] : null,
    mapping ? ['memory_sync_mapping', mapping.cloud_key, { id: mapping.cloud_key, ...mapping }] : null,
    state ? ['agent_context_state', instanceId, { id: instanceId, ...state,
      base_state_revision: state.state_revision, baseStateRevision: state.state_revision }] : null,
  ].filter(Boolean);
  const batchId = stableId('employee_sync_batch', userId, instanceId);
  await client.query(`INSERT INTO cloud_sync_batches_v6(
    id,user_id,device_id,item_count,payload_hash,status,created_at
  ) VALUES($1,$2,$3,$4,$5,'accepted',now()) ON CONFLICT(id) DO UPDATE SET item_count=excluded.item_count`, [
    batchId, userId, deviceId, entities.length, stableId('payload', userId, instanceId),
  ]);
  let cursor = 0;
  for (const [entityType, entityId, payload] of entities) {
    const payloadJson = JSON.stringify(payload);
    const contentHash = crypto.createHash('sha256').update(payloadJson).digest('hex');
    const existing = (await client.query(`SELECT revision,content_hash FROM cloud_sync_entities_v6
      WHERE user_id=$1 AND entity_type=$2 AND entity_id=$3`, [userId, entityType, entityId])).rows[0];
    if (existing?.content_hash === contentHash) continue;
    const revision = Number(existing?.revision || 0) + 1;
    await client.query(`INSERT INTO cloud_sync_entities_v6(
      user_id,entity_type,entity_id,revision,deleted,content_hash,payload_json,origin_device_id,occurred_at,updated_at
    ) VALUES($1,$2,$3,$4,false,$5,$6::jsonb,$7,now(),now()) ON CONFLICT(user_id,entity_type,entity_id) DO UPDATE SET
      revision=excluded.revision,content_hash=excluded.content_hash,payload_json=excluded.payload_json,
      origin_device_id=excluded.origin_device_id,occurred_at=now(),updated_at=now()`, [
      userId, entityType, entityId, revision, contentHash, payloadJson, deviceId,
    ]);
    const changeId = stableId('employee_change', userId, entityType, entityId, String(revision), contentHash);
    const change = await client.query(`INSERT INTO cloud_sync_changes_v6(
      change_id,user_id,device_id,batch_id,entity_type,entity_id,operation,base_revision,revision,content_hash,payload_json,occurred_at
    ) VALUES($1,$2,$3,$4,$5,$6,'upsert',$7,$8,$9,$10::jsonb,now()) ON CONFLICT(change_id) DO UPDATE SET
      change_id=excluded.change_id RETURNING sequence_id`, [
      changeId, userId, deviceId, batchId, entityType, entityId, Number(existing?.revision || 0), revision, contentHash, payloadJson,
    ]);
    cursor = Math.max(cursor, Number(change.rows[0]?.sequence_id || 0));
  }
  if (cursor) await client.query('UPDATE cloud_sync_batches_v6 SET accepted_cursor=$1 WHERE id=$2', [String(cursor), batchId]);
}

function stableId(prefix, ...parts) {
  return `${prefix}_${crypto.createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0, 40)}`;
}

async function overviewWithDb(db, userId) {
  const instances = (await db.query('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=$1 ORDER BY created_at,id', [userId])).rows;
  const roster = instances.filter((row) => row.instance_kind === 'employee'
    && !isLegacyPptAgentId(row.agent_family_id) && !isLegacyGeneralAgentId(row.agent_family_id)).map(instancePayload);
  const systemRoster = instances.filter((row) => row.instance_kind === 'system').map(instancePayload);
  const active = roster.filter((item) => item.employmentState === 'active' && !item.quotaExempt).length;
  const families = (await db.query(`SELECT * FROM cloud_agent_families_v3
    WHERE instance_kind='employee' AND recruitable=true AND status NOT IN ('retired','archived','disabled')
    ORDER BY default_for_new_user DESC,department_id,name,id`)).rows.filter((family) => (
    !isLegacyPptAgentId(family.id) && !isLegacyGeneralAgentId(family.id)
  ));
  const rosterState = await readRosterState(db, userId);
  const aliases = (await db.query(`SELECT alias_instance_id,canonical_instance_id,reason,created_at
    FROM cloud_user_agent_instance_aliases_v3 WHERE user_id=$1 ORDER BY created_at,alias_instance_id`, [userId])).rows.map((row) => ({
    aliasInstanceId: row.alias_instance_id,
    canonicalInstanceId: row.canonical_instance_id,
    reason: row.reason || '',
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : '',
  }));
  return {
    authority: 'cloud', authorityLocked: true, policyVersion: POLICY_VERSION,
    rosterRevision: Number(rosterState?.roster_revision || 0),
    bootstrap: { required: rosterState?.bootstrap_status !== 'completed', status: rosterState?.bootstrap_status || 'pending', bootstrapId: rosterState?.bootstrap_id || '' },
    quota: quotaPayload(active), roster, systemRoster, aliases,
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

async function activeEmployeeCount(db, userId) {
  const row = (await db.query(`SELECT COUNT(*)::int AS count FROM cloud_user_agent_instances_v3
    WHERE user_id=$1 AND instance_kind='employee' AND employment_state='active' AND quota_exempt=false`, [userId])).rows[0];
  return Number(row?.count || 0);
}

async function nextFamilySequence(db, userId, familyId) {
  const row = (await db.query(`SELECT COALESCE(MAX(family_instance_seq),0)::int AS maximum
    FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND agent_family_id=$2`, [userId, familyId])).rows[0];
  return Number(row?.maximum || 0) + 1;
}

async function bootstrapFamilySequence(db, userId, familyId, requestedSequence = 0) {
  if (requestedSequence > 0) {
    const conflict = (await db.query(`SELECT 1 FROM cloud_user_agent_instances_v3
      WHERE user_id=$1 AND agent_family_id=$2 AND family_instance_seq=$3 LIMIT 1`, [userId, familyId, requestedSequence])).rows[0];
    if (!conflict) return requestedSequence;
  }
  return nextFamilySequence(db, userId, familyId);
}

async function requireUser(db, userId, apiError) {
  const row = (await db.query('SELECT id FROM users WHERE id=$1', [userId])).rows[0];
  if (!row) throw apiError('unauthorized', 'Cloud employee user was not found.', 401);
}

async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function required(value, code, apiError) {
  const text = String(value || '').trim();
  if (!text) throw apiError(code, code, 400);
  return text;
}

function quotaPayload(active) {
  return {
    active, reserved: 0, used: active, limit: EMPLOYEE_LIMIT,
    remaining: Math.max(0, EMPLOYEE_LIMIT - active), grandfatheredOverLimit: active > EMPLOYEE_LIMIT,
    policyState: active > EMPLOYEE_LIMIT ? 'grandfathered_over_limit' : 'within_limit',
  };
}

function instancePayload(row) {
  const legacy = jsonObject(row.payload_json);
  return {
    ...legacy,
    familyInstanceSeq: Number(row.family_instance_seq || 0), displayName: row.display_name || '', note: row.note || '',
    id: row.id, userId: row.user_id, agentFamilyId: canonicalEmployeeAgentFamilyId(row.agent_family_id),
    baseAgentVersionId: row.base_agent_version_id || '', activePersonalSkillVersionId: row.active_personal_skill_version_id || '',
    status: row.status, instanceKind: row.instance_kind, employmentState: row.employment_state,
    quotaExempt: Boolean(row.quota_exempt), stateRevision: Number(row.state_revision || 0),
    recruitedAt: iso(row.recruited_at), deactivatedAt: iso(row.deactivated_at), lastStateChangedAt: iso(row.last_state_changed_at),
    recruitmentSource: row.recruitment_source || '', policyVersion: row.policy_version || '',
    syncEnabled: Boolean(row.sync_enabled), personalEvolutionConsent: Boolean(row.personal_evolution_consent),
    clusterContributionConsent: Boolean(row.cluster_contribution_consent), personalSkillAutoActivate: Boolean(row.personal_skill_auto_activate),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function familyPayload(row) {
  const name = canonicalAgentFamilyName(row.id, row.name);
  return {
    ...jsonObject(row.payload_json), id: row.id, name, departmentId: row.department_id, role: row.role,
    status: row.status, routable: Boolean(row.routable), instanceKind: row.instance_kind,
    recruitable: Boolean(row.recruitable), defaultForNewUser: Boolean(row.default_for_new_user),
    quotaCost: Number(row.quota_cost || 0), currentVersionId: row.current_version_id || '',
  };
}

function eventPayload(row) {
  return {
    id: row.id, userId: row.user_id, agentInstanceId: row.user_agent_instance_id || '', agentFamilyId: row.agent_family_id,
    eventType: row.event_type, previousState: row.previous_state || '', nextState: row.next_state || '',
    quotaBefore: Number(row.quota_before || 0), quotaAfter: Number(row.quota_after || 0), commandId: row.command_id,
    sourceDeviceId: row.source_device_id || '', reason: row.reason || '', metadata: jsonObject(row.metadata_json), createdAt: iso(row.created_at),
  };
}

function jsonObject(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')); } catch { return {}; }
}

function iso(value) {
  if (!value) return '';
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
