import { all, get, run } from '../../../db.js';
import {
  AGENT_INSTANCE_KINDS,
  EMPLOYEE_CLOUD_POLICY_VERSION,
  EMPLOYEE_POLICY_VERSION,
  EMPLOYEE_QUOTA_LIMIT,
  EMPLOYMENT_STATES,
  canRecruitAgent,
  canRouteEmployee,
  employeePolicyError,
  employeeQuotaSnapshot,
} from '../../identity/index.js';
import { newId, nowIso, safeJsonParse } from '../../../utils.js';
import { canonicalPptAgentId, isLegacyPptAgentId } from '../../../../shared/pptAgents.js';
import { canonicalGeneralAgentId, isLegacyGeneralAgentId } from '../../../../shared/generalAgents.js';
import {
  defaultAgentInstanceDisplayName,
  isDefaultAgentInstanceDisplayName,
} from '../../../../shared/agentInstanceNaming.js';

export function installEmployeeRecruitmentStoreMethods(prototype) {
  Object.assign(prototype, {
    listEmployeeRoster({ userId = '', includeInactive = true } = {}) {
      if (!userId) return [];
      const rows = all(this.db, `SELECT id FROM user_agent_instances
        WHERE user_id = ? AND instance_kind = 'employee'
          AND NOT EXISTS (SELECT 1 FROM user_agent_instance_aliases alias WHERE alias.alias_instance_id=user_agent_instances.id)
          ${includeInactive ? '' : "AND (employment_state = 'active' OR (authority_state = 'pending' AND pending_target_state = 'active' AND employment_state != 'conflict'))"}
        ORDER BY employment_state = 'active' DESC, recruited_at ASC, created_at ASC`, [userId]);
      return [...new Map(rows.map((row) => {
        const instance = this.getUserAgentInstance(row.id);
        const family = this.getAgentFamily(instance.agentFamilyId);
        return { ...instance, family, routeEligible: canRouteEmployee({ instance, family }) };
      }).map((instance) => [instance.id, instance])).values()];
    },

    activeEmployeeAgentsForUser({ userId = '' } = {}) {
      return this.listEmployeeRoster({ userId, includeInactive: false })
        .filter((item) => item.routeEligible);
    },

    requireRoutableUserAgent({ userId = '', agentInstanceId = '', agentFamilyId = '', allowSystem = false } = {}) {
      const context = this.resolveUserAgent({ userId, agentInstanceId, agentFamilyId });
      if (!context?.instance) throw employeePolicyError('agent_instance_not_found');
      const { instance, family } = context;
      if (instance.instanceKind === AGENT_INSTANCE_KINDS.system) {
        if (allowSystem && instance.status === 'active' && instance.employmentState === EMPLOYMENT_STATES.active) return context;
        throw employeePolicyError('employee_not_active', 'System Agent is unavailable for this execution path.');
      }
      if (!canRouteEmployee({ instance, family })) throw employeePolicyError('employee_not_active');
      return context;
    },

    getEmployeeQuota({ userId = '', limit = EMPLOYEE_QUOTA_LIMIT } = {}) {
      const instances = this.listUserAgentInstances({ userId }).filter((instance) => (
        this.getAgentFamily(instance.agentFamilyId)?.instanceKind === AGENT_INSTANCE_KINDS.employee
      ));
      return employeeQuotaSnapshot(instances, limit);
    },

    listRecruitableAgentFamilies({ userId = '' } = {}) {
      const baseQuota = this.getEmployeeQuota({ userId });
      const reserved = Number(get(this.db, `SELECT COUNT(*) AS count FROM user_agent_instances
        WHERE user_id=? AND instance_kind='employee' AND quota_exempt=0
          AND employment_state!='active' AND employment_state!='conflict'
          AND authority_state='pending' AND pending_target_state='active'`, [userId])?.count || 0);
      const quota = {
        ...baseQuota,
        reserved,
        used: Number(baseQuota.used || 0) + reserved,
        remaining: Math.max(0, Number(baseQuota.limit || EMPLOYEE_QUOTA_LIMIT) - Number(baseQuota.used || 0) - reserved),
      };
      return all(this.db, `SELECT id FROM agent_families
        WHERE instance_kind = 'employee' AND recruitable = 1
          AND status NOT IN ('retired','archived','disabled')
          AND id NOT GLOB 'general_agent_[0-9]*'
        ORDER BY default_for_new_user DESC, department_id, name, id`).map((row) => {
        const family = this.getAgentFamily(row.id);
        const instances = this.listUserAgentInstancesByFamily({ userId, agentFamilyId: row.id });
        const eligibility = canRecruitAgent({ family, instance: null, quota, requireInstalledSkill: true });
        return {
          ...family,
          instance: instances[0] || null,
          instances,
          instanceCount: instances.length,
          activeInstanceCount: instances.filter((instance) => instance.employmentState === EMPLOYMENT_STATES.active
            || (instance.authorityState === 'pending'
              && instance.pendingTargetState === EMPLOYMENT_STATES.active
              && instance.employmentState !== EMPLOYMENT_STATES.conflict)).length,
          employmentState: 'recruitable',
          canRecruit: eligibility.allowed,
          recruitmentCode: eligibility.code,
        };
      });
    },

    listRecruitmentEvents({ userId = '', agentInstanceId = '', limit = 100 } = {}) {
      const where = ['1 = 1'];
      const params = [];
      if (userId) { where.push('user_id = ?'); params.push(userId); }
      if (agentInstanceId) { where.push('user_agent_instance_id = ?'); params.push(agentInstanceId); }
      params.push(Math.max(1, Math.min(500, Number(limit || 100))));
      return all(this.db, `SELECT * FROM user_agent_recruitment_events
        WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`, params).map(normalizeRecruitmentEvent);
    },

    reconcileProvisionalEmployeeInstances({ userId = '' } = {}) {
      if (!userId) return { inspected: 0, merged: 0 };
      const commands = all(this.db, `SELECT command_id,agent_family_id,local_agent_instance_id
        FROM employee_command_outbox
        WHERE user_id=? AND action='recruit' AND local_agent_instance_id!=''
          AND status IN ('confirmed','rejected','conflict')
        ORDER BY updated_at,command_id`, [userId]);
      let merged = 0;
      for (const command of commands) {
        const alias = this.getUserAgentInstance(command.local_agent_instance_id);
        if (!alias || alias.userId !== userId) continue;
        const eventInstanceId = get(this.db, `SELECT user_agent_instance_id FROM user_agent_recruitment_events
          WHERE user_id=? AND command_id=? AND user_agent_instance_id!=''
          ORDER BY created_at DESC,id DESC LIMIT 1`, [userId, command.command_id])?.user_agent_instance_id || '';
        let canonical = eventInstanceId ? this.getUserAgentInstance(eventInstanceId) : null;
        if (!canonical) {
          const candidates = all(this.db, `SELECT id FROM user_agent_instances
            WHERE user_id=? AND agent_family_id=? AND last_employee_command_id=?
            ORDER BY authority_state='cloud_confirmed' DESC,employment_state='active' DESC,updated_at DESC,id DESC
            LIMIT 2`, [userId, command.agent_family_id, command.command_id]);
          canonical = candidates.length > 1 ? this.getUserAgentInstance(candidates[0].id) : null;
        }
        if (!canonical || canonical.id === alias.id || canonical.userId !== userId
          || canonical.agentFamilyId !== alias.agentFamilyId) continue;
        this.bindCanonicalAgentInstance({
          userId,
          aliasInstanceId: alias.id,
          canonicalInstanceId: canonical.id,
          reason: 'employee_recruitment_race_repair',
        });
        merged += 1;
      }
      return { inspected: commands.length, merged };
    },

    recordRecruitmentEvent(input = {}) {
      const id = input.id || newId('recruitment_event');
      const commandId = requiredCommandId(input.commandId);
      run(this.db, `INSERT INTO user_agent_recruitment_events (
        id, user_id, user_agent_instance_id, agent_family_id, event_type,
        previous_state, next_state, quota_before, quota_after, command_id,
        source_device_id, reason, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id, input.userId, input.agentInstanceId || '', input.agentFamilyId, input.eventType,
        input.previousState || '', input.nextState || '', Number(input.quotaBefore || 0),
        Number(input.quotaAfter || 0), commandId, input.sourceDeviceId || '', input.reason || '',
        JSON.stringify(input.metadata || {}), input.createdAt || nowIso(),
      ]);
      return normalizeRecruitmentEvent(get(this.db, 'SELECT * FROM user_agent_recruitment_events WHERE id = ?', [id]));
    },

    ensureSystemAgentInstances({ userId = '' } = {}) {
      if (!get(this.db, 'SELECT id FROM auth_users WHERE id = ?', [userId])) return [];
      const families = all(this.db, "SELECT id, current_version_id FROM agent_families WHERE instance_kind = 'system' ORDER BY id");
      return families.map((family) => {
        let instance = this.ensureUserAgentInstance({
          userId,
          agentFamilyId: family.id,
          baseAgentVersionId: family.current_version_id || '',
          instanceKind: AGENT_INSTANCE_KINDS.system,
          employmentState: EMPLOYMENT_STATES.active,
          quotaExempt: true,
          recruitmentSource: 'default',
          creationMode: 'system_default',
        });
        if (!instance) return null;
        if (instance.instanceKind !== AGENT_INSTANCE_KINDS.system
          || instance.employmentState !== EMPLOYMENT_STATES.active
          || !instance.quotaExempt
          || instance.status !== 'active') {
          const now = nowIso();
          run(this.db, `UPDATE user_agent_instances SET
            status = 'active', instance_kind = 'system', employment_state = 'active', quota_exempt = 1,
            recruited_at = CASE WHEN recruited_at = '' THEN ? ELSE recruited_at END,
            deactivated_at = '', last_state_changed_at = ?, state_revision = state_revision + 1,
            recruitment_source = 'default', policy_version = ?, updated_at = ? WHERE id = ?`, [
            now, now, EMPLOYEE_POLICY_VERSION, now, instance.id,
          ]);
          instance = this.getUserAgentInstance(instance.id);
        }
        return instance;
      }).filter(Boolean);
    },

    provisionNewUserAgentDefaults({ userId = '', sourceDeviceId = '' } = {}) {
      const user = get(this.db, 'SELECT id,remote_id,remote_bound_at FROM auth_users WHERE id = ?', [userId]);
      if (!user) return null;
      const systemInstances = this.ensureSystemAgentInstances({ userId });
      const remoteBound = Boolean(String(user.remote_id || '').trim() && String(user.remote_bound_at || '').trim());
      const defaults = remoteBound ? [] : all(this.db, `SELECT id FROM agent_families
        WHERE instance_kind = 'employee' AND default_for_new_user = 1 AND recruitable = 1 ORDER BY id`);
      const employeeResults = [];
      for (const family of defaults) {
        const existing = this.findUserAgentInstance({ userId, agentFamilyId: family.id });
        if (existing) continue;
        employeeResults.push(this.recruitUserAgent({
          userId,
          agentFamilyId: family.id,
          commandId: `default:${EMPLOYEE_POLICY_VERSION}:${family.id}`,
          sourceDeviceId,
          recruitmentSource: 'default',
        }));
      }
      return { systemInstances, employeeResults, quota: this.getEmployeeQuota({ userId }), employeeAuthority: remoteBound ? 'cloud' : 'local' };
    },

    stageLocalOnlyEmployeeAdoptions({
      userId = '', remoteUserId = '', sourceDeviceId = '', overview = {}, capability = {},
    } = {}) {
      if (!userId || !remoteUserId
        || capability.instanceAliasProjection !== 'overview_v1'
        || capability.localInstanceAdoption !== 'recruit_preserve_state_v1') {
        return { inspected: 0, staged: 0, skipped: 0, reason: 'employee_adoption_contract_unavailable', items: [] };
      }
      const remoteInstances = [
        ...(Array.isArray(overview.systemRoster) ? overview.systemRoster : []),
        ...(Array.isArray(overview.roster) ? overview.roster : []),
      ];
      const remoteIds = new Set(remoteInstances.map((item) => String(item?.id || '').trim()).filter(Boolean));
      let remaining = Math.max(0, Number(overview?.quota?.remaining || 0));
      const candidates = this.listEmployeeRoster({ userId, includeInactive: true })
        .filter((instance) => instance.instanceKind === AGENT_INSTANCE_KINDS.employee
          && [EMPLOYMENT_STATES.active, EMPLOYMENT_STATES.inactive].includes(instance.employmentState)
          && ['local_confirmed', 'migration_grandfathered'].includes(instance.authorityState)
          && !remoteIds.has(instance.id)
          && this.resolveUserAgent({ agentInstanceId: instance.id })?.instance?.id === instance.id)
        .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')) || left.id.localeCompare(right.id));
      const items = [];
      let staged = 0;
      for (const instance of candidates) {
        if (instance.employmentState === EMPLOYMENT_STATES.active && remaining < 1) {
          items.push({ agentInstanceId: instance.id, status: 'skipped', code: 'employee_quota_exceeded' });
          continue;
        }
        const commandId = `employee-local-adoption:${remoteUserId}:${instance.id}:v1`;
        try {
          const result = this.stagePendingEmployeeCommand({
            userId,
            remoteUserId,
            action: 'recruit',
            agentFamilyId: instance.agentFamilyId,
            agentInstanceId: instance.id,
            commandId,
            sourceDeviceId,
            reason: 'local_instance_cloud_adoption',
            targetEmploymentState: instance.employmentState,
            adoptLocalInstance: true,
          });
          staged += result.idempotent ? 0 : 1;
          if (instance.employmentState === EMPLOYMENT_STATES.active) remaining -= 1;
          items.push({ agentInstanceId: instance.id, commandId, status: result.command?.status || result.status, idempotent: Boolean(result.idempotent) });
        } catch (error) {
          items.push({ agentInstanceId: instance.id, status: 'skipped', code: String(error?.code || 'employee_adoption_failed') });
        }
      }
      return { inspected: candidates.length, staged, skipped: items.filter((item) => item.status === 'skipped').length, items };
    },

    reconcileEmployeeInstanceClassifications() {
      const rows = all(this.db, `SELECT i.*, f.instance_kind AS family_instance_kind
        FROM user_agent_instances i
        LEFT JOIN agent_families f ON f.id = i.agent_family_id`);
      let changed = 0;
      for (const row of rows) {
        const familyKind = row.family_instance_kind || AGENT_INSTANCE_KINDS.unavailable;
        const modern = [EMPLOYEE_POLICY_VERSION, EMPLOYEE_CLOUD_POLICY_VERSION].includes(row.policy_version)
          && Object.values(AGENT_INSTANCE_KINDS).includes(row.instance_kind)
          && Object.values(EMPLOYMENT_STATES).includes(row.employment_state);
        const forceSystemRepair = familyKind === AGENT_INSTANCE_KINDS.system
          && (row.instance_kind !== AGENT_INSTANCE_KINDS.system || row.employment_state !== EMPLOYMENT_STATES.active || Number(row.quota_exempt) !== 1);
        const forceGovernanceRepair = familyKind === AGENT_INSTANCE_KINDS.governance
          && (row.instance_kind !== AGENT_INSTANCE_KINDS.governance || Number(row.quota_exempt) !== 1);
        const forceEmployeeRepair = familyKind === AGENT_INSTANCE_KINDS.employee
          && row.instance_kind === AGENT_INSTANCE_KINDS.unavailable;
        if (modern && !forceSystemRepair && !forceGovernanceRepair && !forceEmployeeRepair && row.recruited_at && row.last_state_changed_at) continue;
        const instanceKind = forceSystemRepair || forceGovernanceRepair || forceEmployeeRepair
          ? familyKind
          : modern ? row.instance_kind : familyKind;
        const employmentState = forceSystemRepair
          ? EMPLOYMENT_STATES.active
          : modern ? row.employment_state : row.status === 'inactive' ? EMPLOYMENT_STATES.inactive : EMPLOYMENT_STATES.active;
        const quotaExempt = instanceKind === AGENT_INSTANCE_KINDS.employee ? 0 : 1;
        const status = employmentState === EMPLOYMENT_STATES.active ? 'active' : 'inactive';
        run(this.db, `UPDATE user_agent_instances SET
          status = ?, instance_kind = ?, employment_state = ?, quota_exempt = ?,
          recruited_at = CASE WHEN recruited_at = '' THEN ? ELSE recruited_at END,
          last_state_changed_at = CASE WHEN last_state_changed_at = '' THEN ? ELSE last_state_changed_at END,
          recruitment_source = CASE WHEN recruitment_source IN ('', 'legacy') THEN 'migration' ELSE recruitment_source END,
          policy_version = ? WHERE id = ?`, [
          status, instanceKind, employmentState, quotaExempt,
          row.created_at || nowIso(), row.updated_at || row.created_at || nowIso(),
          EMPLOYEE_POLICY_VERSION, row.id,
        ]);
        changed += 1;
      }
      return { instanceCount: rows.length, changed };
    },

    recruitUserAgent({
      userId = '',
      agentFamilyId = '',
      agentInstanceId = '',
      commandId = '',
      sourceDeviceId = '',
      recruitmentSource = 'user',
      expectedStateRevision,
    } = {}) {
      const cleanCommandId = requiredCommandId(commandId);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const priorEvent = get(this.db, 'SELECT * FROM user_agent_recruitment_events WHERE user_id = ? AND command_id = ?', [userId, cleanCommandId]);
        if (priorEvent) {
          this.db.exec('COMMIT');
          return recruitmentResult(this, normalizeRecruitmentEvent(priorEvent), true);
        }
        const user = get(this.db, 'SELECT id FROM auth_users WHERE id = ?', [userId]);
        if (!user) throw new Error('Recruitment user does not exist.');
        const family = this.getAgentFamily(agentFamilyId);
        if (!family) throw new Error('Recruitment Agent family does not exist.');
        const quotaBefore = this.getEmployeeQuota({ userId });
        let instance = agentInstanceId ? this.getUserAgentInstance(agentInstanceId) : null;
        if (instance && (instance.userId !== userId || instance.agentFamilyId !== agentFamilyId)) {
          throw employeePolicyError('agent_instance_owner_mismatch');
        }
        if (instance && expectedStateRevision !== undefined && Number(expectedStateRevision) !== instance.stateRevision) {
          const event = rejectedRecruitmentEvent(this, {
            userId, instance, agentFamilyId, commandId: cleanCommandId, sourceDeviceId,
            quota: quotaBefore, code: 'employee_state_conflict', expectedStateRevision,
          });
          this.db.exec('COMMIT');
          return recruitmentResult(this, event, false);
        }
        const eligibility = canRecruitAgent({ family, instance, quota: quotaBefore });
        if (!eligibility.allowed) {
          if (eligibility.code === 'agent_already_active') {
            const event = this.recordRecruitmentEvent({
              userId, agentInstanceId: instance.id, agentFamilyId, eventType: 'reconciled',
              previousState: EMPLOYMENT_STATES.active, nextState: EMPLOYMENT_STATES.active,
              quotaBefore: quotaBefore.used, quotaAfter: quotaBefore.used, commandId: cleanCommandId,
              sourceDeviceId, reason: eligibility.code,
              metadata: { action: 'already_active', status: 'active', code: eligibility.code },
            });
            this.db.exec('COMMIT');
            return recruitmentResult(this, event, false);
          }
          const event = rejectedRecruitmentEvent(this, {
            userId, instance, agentFamilyId, commandId: cleanCommandId, sourceDeviceId,
            quota: quotaBefore, code: eligibility.code,
          });
          this.db.exec('COMMIT');
          return recruitmentResult(this, event, false);
        }

        const now = nowIso();
        const previousState = instance?.employmentState || 'not_recruited';
        const action = instance ? 'reactivated' : 'recruited';
        const evolutionEnabled = Boolean(Number(get(
          this.db,
          "SELECT evolution_enabled FROM cloud_sync_state WHERE id = 'default'",
        )?.evolution_enabled ?? 1));
        if (instance) {
          const updated = run(this.db, `UPDATE user_agent_instances SET
            status = 'active', instance_kind = 'employee', employment_state = 'active', quota_exempt = 0,
            deactivated_at = '', last_state_changed_at = ?, state_revision = state_revision + 1,
            recruitment_source = ?, policy_version = ?,
            personal_evolution_consent=CASE WHEN sync_enabled=1 AND ?=1 THEN 1 ELSE 0 END,
            cluster_contribution_consent=CASE WHEN sync_enabled=1 AND ?=1 THEN 1 ELSE 0 END,
            personal_skill_auto_activate=0,updated_at = ? WHERE id = ? AND state_revision = ?`, [
            now, recruitmentSource, EMPLOYEE_POLICY_VERSION, evolutionEnabled ? 1 : 0,
            evolutionEnabled ? 1 : 0, now, instance.id, instance.stateRevision,
          ]);
          if (Number(updated?.changes || 0) !== 1) throw employeePolicyError('employee_state_conflict');
        } else {
          const id = newId('uagent');
          const familyInstanceSeq = this.nextAgentFamilyInstanceSequence({ userId, agentFamilyId });
          const displayName = defaultAgentInstanceDisplayName(family.name || agentFamilyId, familyInstanceSeq, agentFamilyId);
          run(this.db, `INSERT INTO user_agent_instances (
            id, user_id, agent_family_id, base_agent_version_id, status,
            instance_kind, employment_state, quota_exempt, recruited_at, deactivated_at,
            last_state_changed_at, state_revision, recruitment_source, policy_version,
            sync_enabled, personal_evolution_consent, cluster_contribution_consent,personal_skill_auto_activate,
            family_instance_seq,display_name
          ) VALUES (?, ?, ?, ?, 'active', 'employee', 'active', 0, ?, '', ?, 1, ?, ?, 1, ?, ?, 0,?,?)`, [
            id, userId, agentFamilyId, family.currentVersionId || '', now, now,
            recruitmentSource, EMPLOYEE_POLICY_VERSION, evolutionEnabled ? 1 : 0, evolutionEnabled ? 1 : 0,
            familyInstanceSeq, displayName,
          ]);
          this.ensureDefaultMemoryDocument({ agentInstanceId: id, withinTransaction: true });
          instance = this.getUserAgentInstance(id);
        }
        instance = this.getUserAgentInstance(instance.id);
        const quotaAfter = this.getEmployeeQuota({ userId });
        const event = this.recordRecruitmentEvent({
          userId, agentInstanceId: instance.id, agentFamilyId, eventType: action,
          previousState, nextState: EMPLOYMENT_STATES.active,
          quotaBefore: quotaBefore.used, quotaAfter: quotaAfter.used, commandId: cleanCommandId,
          sourceDeviceId, reason: recruitmentSource, metadata: { action, status: 'active' },
        });
        this.db.exec('COMMIT');
        return recruitmentResult(this, event, false);
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    },

    deactivateUserAgent({ userId = '', agentInstanceId = '', commandId = '', sourceDeviceId = '', reason = 'user', expectedStateRevision } = {}) {
      const cleanCommandId = requiredCommandId(commandId);
      const expectedRevision = requiredStateRevision(expectedStateRevision);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const priorEvent = get(this.db, 'SELECT * FROM user_agent_recruitment_events WHERE user_id = ? AND command_id = ?', [userId, cleanCommandId]);
        if (priorEvent) {
          this.db.exec('COMMIT');
          return recruitmentResult(this, normalizeRecruitmentEvent(priorEvent), true);
        }
        let instance = this.getUserAgentInstance(agentInstanceId);
        if (!instance) throw employeePolicyError('agent_instance_not_found');
        if (instance.userId !== userId) throw employeePolicyError('agent_instance_owner_mismatch');
        if (instance.instanceKind !== AGENT_INSTANCE_KINDS.employee || instance.quotaExempt) throw employeePolicyError('agent_not_recruitable', 'Only quota-counted employees can be deactivated.');
        const quotaBefore = this.getEmployeeQuota({ userId });
        if (expectedRevision !== instance.stateRevision) {
          const event = rejectedRecruitmentEvent(this, {
            userId, instance, agentFamilyId: instance.agentFamilyId, commandId: cleanCommandId,
            sourceDeviceId, quota: quotaBefore, code: 'employee_state_conflict', expectedStateRevision,
          });
          this.db.exec('COMMIT');
          return recruitmentResult(this, event, false);
        }
        if (instance.employmentState === EMPLOYMENT_STATES.inactive) {
          const quota = this.getEmployeeQuota({ userId });
          const event = this.recordRecruitmentEvent({
            userId, agentInstanceId: instance.id, agentFamilyId: instance.agentFamilyId, eventType: 'reconciled',
            previousState: EMPLOYMENT_STATES.inactive, nextState: EMPLOYMENT_STATES.inactive,
            quotaBefore: quota.used, quotaAfter: quota.used, commandId: cleanCommandId,
            sourceDeviceId, reason: 'agent_already_inactive',
            metadata: { action: 'already_inactive', status: 'inactive', code: 'agent_already_inactive' },
          });
          this.db.exec('COMMIT');
          return recruitmentResult(this, event, false);
        }
        const now = nowIso();
        const updated = run(this.db, `UPDATE user_agent_instances SET
          status = 'inactive', employment_state = 'inactive', deactivated_at = ?,
          last_state_changed_at = ?, state_revision = state_revision + 1,
          policy_version = ?,cluster_contribution_consent=0, updated_at = ? WHERE id = ? AND state_revision = ?`, [
          now, now, EMPLOYEE_POLICY_VERSION, now, instance.id, instance.stateRevision,
        ]);
        if (Number(updated?.changes || 0) !== 1) throw employeePolicyError('employee_state_conflict');
        instance = this.getUserAgentInstance(instance.id);
        const quotaAfter = this.getEmployeeQuota({ userId });
        const event = this.recordRecruitmentEvent({
          userId, agentInstanceId: instance.id, agentFamilyId: instance.agentFamilyId,
          eventType: 'deactivated', previousState: EMPLOYMENT_STATES.active, nextState: EMPLOYMENT_STATES.inactive,
          quotaBefore: quotaBefore.used, quotaAfter: quotaAfter.used, commandId: cleanCommandId,
          sourceDeviceId, reason, metadata: { action: 'deactivated', status: 'inactive' },
        });
        this.db.exec('COMMIT');
        return recruitmentResult(this, event, false);
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    },

    reactivateUserAgent({ userId = '', agentInstanceId = '', commandId = '', sourceDeviceId = '', expectedStateRevision } = {}) {
      const cleanCommandId = requiredCommandId(commandId);
      const expectedRevision = requiredStateRevision(expectedStateRevision);
      let instance = this.resolveUserAgent({ agentInstanceId })?.instance || null;
      if (!instance) throw employeePolicyError('agent_instance_not_found');
      if (instance.userId !== userId) throw employeePolicyError('agent_instance_owner_mismatch');
      const familyId = canonicalGeneralAgentId(canonicalPptAgentId(instance.agentFamilyId));
      if (familyId !== instance.agentFamilyId) {
        const canonical = this.findUserAgentInstance({ userId, agentFamilyId: familyId });
        if (canonical) instance = canonical;
        else {
          run(this.db, 'UPDATE user_agent_instances SET agent_family_id=?,updated_at=? WHERE id=?', [familyId, nowIso(), instance.id]);
          instance = this.getUserAgentInstance(instance.id);
        }
      }
      return this.recruitUserAgent({
        userId,
        agentFamilyId: familyId,
        agentInstanceId: instance.id,
        commandId: cleanCommandId,
        sourceDeviceId,
        recruitmentSource: 'user_reactivation',
        expectedStateRevision: expectedRevision,
      });
    },

    listEmployeeCommandOutbox({ userId = '', statuses = [], limit = 100 } = {}) {
      const where = ['1 = 1'];
      const params = [];
      if (userId) { where.push('user_id = ?'); params.push(userId); }
      const normalizedStatuses = [...new Set((Array.isArray(statuses) ? statuses : [statuses]).map(String).filter(Boolean))];
      if (normalizedStatuses.length) {
        where.push(`status IN (${normalizedStatuses.map(() => '?').join(',')})`);
        params.push(...normalizedStatuses);
      }
      params.push(Math.max(1, Math.min(500, Number(limit || 100))));
      return all(this.db, `SELECT * FROM employee_command_outbox WHERE ${where.join(' AND ')}
        ORDER BY created_at ASC, command_id ASC LIMIT ?`, params).map(normalizeEmployeeOutboxCommand);
    },

    getEmployeeCommandOutbox({ userId = '', commandId = '' } = {}) {
      if (!commandId) return null;
      const params = [commandId];
      const userFilter = userId ? ' AND user_id = ?' : '';
      if (userId) params.push(userId);
      return normalizeEmployeeOutboxCommand(get(
        this.db,
        `SELECT * FROM employee_command_outbox WHERE command_id = ?${userFilter}`,
        params,
      ));
    },

    recoverStaleEmployeeCommandOutbox({ staleBefore = '' } = {}) {
      if (!staleBefore) return 0;
      const result = run(this.db, `UPDATE employee_command_outbox
        SET status='failed',last_error=CASE WHEN last_error='' THEN 'interrupted while sending' ELSE last_error END,updated_at=?
        WHERE status='sending' AND updated_at<?`, [nowIso(), staleBefore]);
      return Number(result?.changes || 0);
    },

    blockEmployeeCommandsForCloudAuth({ userId = '', error = 'cloud_auth_required: Cloud authentication is required.' } = {}) {
      if (!userId) return 0;
      const result = run(this.db, `UPDATE employee_command_outbox
        SET status='blocked_auth',last_error=?,updated_at=?
        WHERE user_id=? AND status IN ('pending','sending','failed')`, [
        String(error || '').slice(0, 2000), nowIso(), userId,
      ]);
      return Number(result?.changes || 0);
    },

    updateEmployeeCommandExpectedRevision({ userId = '', commandId = '', expectedStateRevision } = {}) {
      const expectedRevision = requiredStateRevision(expectedStateRevision);
      const existing = this.getEmployeeCommandOutbox({ userId, commandId });
      if (!existing) return null;
      const payload = { ...(existing.payload || {}), expectedStateRevision: expectedRevision };
      run(this.db, `UPDATE employee_command_outbox SET expected_state_revision=?,payload_json=?,updated_at=?
        WHERE command_id=? AND user_id=?`, [expectedRevision, JSON.stringify(payload), nowIso(), commandId, userId]);
      return this.getEmployeeCommandOutbox({ userId, commandId });
    },

    stagePendingEmployeeCommand({
      userId = '', remoteUserId = '', action = '', agentFamilyId = '', agentInstanceId = '',
      commandId = '', expectedStateRevision, sourceDeviceId = '', reason = 'offline',
      targetEmploymentState = '', adoptLocalInstance = false,
    } = {}) {
      const cleanCommandId = requiredCommandId(commandId);
      const cleanAction = String(action || '').trim();
      if (!['recruit', 'deactivate', 'reactivate'].includes(cleanAction)) throw employeePolicyError('employee_command_invalid');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const existingCommand = get(this.db, 'SELECT * FROM employee_command_outbox WHERE command_id = ? AND user_id = ?', [cleanCommandId, userId]);
        if (existingCommand) {
          this.db.exec('COMMIT');
          const command = normalizeEmployeeOutboxCommand(existingCommand);
          return { status: command.status === 'confirmed' ? 'confirmed' : 'pending_cloud_confirmation', command, instance: command.localAgentInstanceId ? this.getUserAgentInstance(command.localAgentInstanceId) : null, idempotent: true };
        }
        if (!get(this.db, 'SELECT id FROM auth_users WHERE id = ?', [userId])) throw employeePolicyError('agent_instance_owner_mismatch', 'Recruitment user does not exist.');
        let instance = agentInstanceId ? (this.resolveUserAgent({ agentInstanceId })?.instance || null) : null;
        const familyId = canonicalGeneralAgentId(canonicalPptAgentId(agentFamilyId || instance?.agentFamilyId || ''));
        if (instance && isLegacyPptAgentId(instance.agentFamilyId)) {
          const canonical = this.findUserAgentInstance({ userId, agentFamilyId: familyId });
          if (canonical && canonical.id !== instance.id) {
            instance = this.bindCanonicalAgentInstance({
              userId,
              aliasInstanceId: instance.id,
              canonicalInstanceId: canonical.id,
              reason: 'ppt_lifecycle_canonicalization',
              withinTransaction: true,
            });
          } else if (!canonical) {
            run(this.db, 'UPDATE user_agent_instances SET agent_family_id=?,updated_at=? WHERE id=?', [familyId, nowIso(), instance.id]);
            instance = this.getUserAgentInstance(instance.id);
          }
        } else if (instance && isLegacyGeneralAgentId(instance.agentFamilyId)) {
          const canonicalFamily = this.getAgentFamily(familyId);
          run(this.db, `UPDATE user_agent_instances SET agent_family_id=?,base_agent_version_id=CASE WHEN ?<>'' THEN ? ELSE base_agent_version_id END,
            updated_at=? WHERE id=?`, [
            familyId, canonicalFamily?.currentVersionId || '', canonicalFamily?.currentVersionId || '', nowIso(), instance.id,
          ]);
          instance = this.getUserAgentInstance(instance.id);
        }
        const family = this.getAgentFamily(familyId);
        if (!family || family.instanceKind !== AGENT_INSTANCE_KINDS.employee || !family.recruitable) throw employeePolicyError('agent_not_recruitable');
        if (instance && instance.userId !== userId) throw employeePolicyError('agent_instance_owner_mismatch');
        if (!instance && cleanAction !== 'recruit') instance = this.findUserAgentInstance({ userId, agentFamilyId: familyId });
        const predecessor = instance?.lastEmployeeCommandId
          ? normalizeEmployeeOutboxCommand(get(this.db, 'SELECT * FROM employee_command_outbox WHERE command_id = ? AND user_id = ?', [instance.lastEmployeeCommandId, userId]))
          : null;
        const targetState = cleanAction === 'deactivate'
          || (cleanAction === 'recruit' && adoptLocalInstance && targetEmploymentState === EMPLOYMENT_STATES.inactive)
          ? EMPLOYMENT_STATES.inactive
          : EMPLOYMENT_STATES.active;
        if (targetState === EMPLOYMENT_STATES.active) {
          const activationEligibility = canRecruitAgent({
            family,
            instance,
            quota: this.getEmployeeQuota({ userId }),
            requireInstalledSkill: true,
          });
          if (!activationEligibility.allowed && activationEligibility.code === 'agent_skill_install_required') {
            throw employeePolicyError(activationEligibility.code);
          }
        }
        const predecessorPending = predecessor
          && !['confirmed', 'rejected', 'conflict', 'failed_terminal'].includes(predecessor.status);
        const reversesPendingLifecycle = cleanAction !== 'recruit'
          && instance?.authorityState === 'pending'
          && Boolean(instance?.pendingTargetState)
          && instance.pendingTargetState !== targetState
          && predecessorPending;
        const repeatsPendingTarget = instance?.authorityState === 'pending'
          && instance?.pendingTargetState === targetState
          && predecessor
          && !['confirmed', 'rejected', 'conflict'].includes(predecessor.status);
        if (repeatsPendingTarget) {
          this.db.exec('COMMIT');
          return {
            status: 'pending_cloud_confirmation',
            action: predecessor.action,
            commandId: predecessor.commandId,
            instance: this.getUserAgentInstance(instance.id),
            command: predecessor,
            quota: employeeQuotaWithReservations(this.db, userId),
            idempotent: true,
            reusedPendingCommandId: predecessor.commandId,
          };
        }
        if (instance?.authorityState === 'pending' && instance.lastEmployeeCommandId && !reversesPendingLifecycle) {
          throw employeePolicyError('employee_command_pending');
        }
        const previousState = reversesPendingLifecycle
          ? instance.pendingTargetState
          : instance?.employmentState || 'not_recruited';
        const expectedRevision = cleanAction === 'recruit' && expectedStateRevision === undefined
          ? Number(instance?.stateRevision || 0)
          : requiredStateRevision(expectedStateRevision);
        if (targetState === EMPLOYMENT_STATES.active) {
          const active = pendingQuotaCount(this.db, userId, instance?.id || '');
          if (active >= EMPLOYEE_QUOTA_LIMIT && previousState !== EMPLOYMENT_STATES.active) throw employeePolicyError('employee_quota_exceeded');
        }
        const now = nowIso();
        const proposedId = instance?.id || newId('uagent');
        if (!instance) {
          const familyInstanceSeq = this.nextAgentFamilyInstanceSequence({ userId, agentFamilyId: familyId });
          const displayName = defaultAgentInstanceDisplayName(family.name || familyId, familyInstanceSeq, familyId);
          run(this.db, `INSERT INTO user_agent_instances (
            id,user_id,agent_family_id,base_agent_version_id,status,instance_kind,employment_state,quota_exempt,
            recruited_at,last_state_changed_at,state_revision,recruitment_source,policy_version,
            pending_target_state,authority_state,last_employee_command_id,
            sync_enabled,personal_evolution_consent,cluster_contribution_consent,personal_skill_auto_activate,
            family_instance_seq,display_name,created_at,updated_at
          ) VALUES (?,?,?,?,'inactive','employee','pending_cloud_confirmation',0,?,?,1,'cloud_pending','employee_cloud_authority_v1',
            'active','pending',?,1,0,0,0,?,?,?,?)`, [
            proposedId, userId, familyId, family.currentVersionId || '', now, now, cleanCommandId,
            familyInstanceSeq, displayName, now, now,
          ]);
          this.ensureDefaultMemoryDocument({ agentInstanceId: proposedId, withinTransaction: true });
        } else {
          const localEmploymentState = cleanAction === 'deactivate'
            ? EMPLOYMENT_STATES.inactive
            : EMPLOYMENT_STATES.pendingCloudConfirmation;
          run(this.db, `UPDATE user_agent_instances SET status='inactive',employment_state=?,
            pending_target_state=?,authority_state='pending',last_employee_command_id=?,policy_version='employee_cloud_authority_v1',
            last_state_changed_at=?,updated_at=? WHERE id=?`, [localEmploymentState, targetState, cleanCommandId, now, now, instance.id]);
        }
        const stagedInstance = this.getUserAgentInstance(proposedId);
        const payload = {
          action: cleanAction,
          commandId: cleanCommandId,
          agentFamilyId: familyId,
          agentInstanceId: cleanAction === 'recruit' ? '' : proposedId,
          proposedInstanceId: proposedId,
          displayName: stagedInstance?.displayName || '',
          familyInstanceSeq: Number(stagedInstance?.familyInstanceSeq || 1),
          expectedStateRevision: expectedRevision || undefined,
          reason,
          ...(cleanAction === 'recruit' && adoptLocalInstance ? {
            adoptLocalInstance: true,
            employmentState: targetState,
          } : {}),
          ...(reversesPendingLifecycle ? {
            dependsOnCommandId: predecessor.commandId,
            expectedStateRevisionMode: 'cloud_after_dependency',
          } : {}),
        };
        run(this.db, `INSERT INTO employee_command_outbox (
          command_id,user_id,remote_user_id,action,agent_family_id,local_agent_instance_id,proposed_instance_id,
          expected_state_revision,previous_employment_state,payload_json,status,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)`, [
          cleanCommandId, userId, remoteUserId, cleanAction, familyId, proposedId, proposedId,
          Number(expectedRevision || 0), previousState, JSON.stringify({ ...payload, sourceDeviceId }), now, now,
        ]);
        this.db.exec('COMMIT');
        return {
          status: 'pending_cloud_confirmation',
          action: cleanAction,
          commandId: cleanCommandId,
          instance: this.getUserAgentInstance(proposedId),
          command: normalizeEmployeeOutboxCommand(get(this.db, 'SELECT * FROM employee_command_outbox WHERE command_id = ?', [cleanCommandId])),
          quota: employeeQuotaWithReservations(this.db, userId),
          deferredByCommandId: reversesPendingLifecycle ? predecessor.commandId : '',
          idempotent: false,
        };
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    },

    markEmployeeCommandAttempt({ commandId = '', status = 'failed', error = '' } = {}) {
      run(this.db, `UPDATE employee_command_outbox SET status=?,attempt_count=attempt_count+1,last_error=?,updated_at=?
        WHERE command_id=?`, [status, String(error || '').slice(0, 2000), nowIso(), commandId]);
      return normalizeEmployeeOutboxCommand(get(this.db, 'SELECT * FROM employee_command_outbox WHERE command_id = ?', [commandId]));
    },

    applyCloudEmployeeInstance({ userId = '', instance: remote = {}, commandId = '' } = {}) {
      const canonicalId = String(remote.id || '').trim();
      const familyId = canonicalGeneralAgentId(canonicalPptAgentId(remote.agentFamilyId || remote.agent_family_id || ''));
      if (!canonicalId || !familyId) return null;
      if (!this.getAgentFamily(familyId)) throw employeePolicyError('agent_not_recruitable', 'Cloud Agent family is not available in the local catalog.');
      const remoteStatus = remote.status || ((remote.employmentState || remote.employment_state) === 'active' ? 'active' : 'inactive');
      const remoteSyncEnabled = remote.syncEnabled === false || remote.sync_enabled === 0 ? 0 : 1;
      const evolutionEnabled = Boolean(Number(get(
        this.db,
        "SELECT evolution_enabled FROM cloud_sync_state WHERE id = 'default'",
      )?.evolution_enabled ?? 1));
      const evolutionAllowed = evolutionEnabled && remoteSyncEnabled && remoteStatus === 'active' ? 1 : 0;
      const family = this.getAgentFamily(familyId);
      const remoteBaseAgentVersionId = isLegacyGeneralAgentId(remote.agentFamilyId || remote.agent_family_id || '')
        ? family?.currentVersionId || remote.baseAgentVersionId || remote.base_agent_version_id || ''
        : remote.baseAgentVersionId || remote.base_agent_version_id || '';
      const remoteRawDisplayName = String(remote.displayName || remote.display_name || '').trim();
      let localById = this.getUserAgentInstance(canonicalId);
      let local = localById;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (localById && isLegacyPptAgentId(localById.agentFamilyId)) {
          const canonicalFamilyInstance = this.findUserAgentInstance({ userId, agentFamilyId: familyId });
          if (canonicalFamilyInstance && canonicalFamilyInstance.id !== localById.id) {
            local = this.bindCanonicalAgentInstance({
              userId, aliasInstanceId: canonicalFamilyInstance.id, canonicalInstanceId: localById.id,
              reason: 'ppt_cloud_canonical', withinTransaction: true,
            });
          }
          run(this.db, 'UPDATE user_agent_instances SET agent_family_id=?,updated_at=? WHERE id=?', [familyId, nowIso(), localById.id]);
          local = this.getUserAgentInstance(localById.id);
        } else if (localById && isLegacyGeneralAgentId(localById.agentFamilyId)) {
          const requestedSequence = Math.max(0, Math.floor(Number(
            remote.familyInstanceSeq ?? remote.family_instance_seq ?? localById.familyInstanceSeq ?? 0,
          ) || 0));
          const repairedSequence = resolveRemoteEmployeeSequence(this, {
            userId, familyId, instanceId: localById.id, requestedSequence,
          });
          const repairedDisplayName = remoteRawDisplayName && !isDefaultAgentInstanceDisplayName(
            remoteRawDisplayName, family?.name || familyId, familyId, requestedSequence || 1,
          )
            ? remoteRawDisplayName
            : defaultAgentInstanceDisplayName(family?.name || familyId, repairedSequence, familyId);
          run(this.db, `UPDATE user_agent_instances SET agent_family_id=?,base_agent_version_id=?,family_instance_seq=?,display_name=?,updated_at=? WHERE id=?`, [
            familyId, remoteBaseAgentVersionId, repairedSequence, repairedDisplayName, nowIso(), localById.id,
          ]);
          local = this.getUserAgentInstance(localById.id);
        }
        if (commandId) {
          const pendingLocalId = get(this.db, `SELECT local_agent_instance_id FROM employee_command_outbox
            WHERE command_id=? AND user_id=?`, [commandId, userId])?.local_agent_instance_id || '';
          const pendingLocal = pendingLocalId ? this.getUserAgentInstance(pendingLocalId) : null;
          if (pendingLocal && pendingLocal.id !== canonicalId) {
            this.bindCanonicalAgentInstance({
              userId, aliasInstanceId: pendingLocal.id, canonicalInstanceId: canonicalId,
              reason: 'employee_cloud_canonical', withinTransaction: true,
            });
            local = this.getUserAgentInstance(canonicalId);
          }
        }
        if (!local) {
          const createdAt = remote.createdAt || remote.created_at || nowIso();
          const requestedFamilyInstanceSeq = Math.max(0, Math.floor(Number(
            remote.familyInstanceSeq ?? remote.family_instance_seq ?? 0,
          ) || 0));
          const familyInstanceSeq = resolveRemoteEmployeeSequence(this, {
            userId,
            familyId,
            instanceId: canonicalId,
            requestedSequence: requestedFamilyInstanceSeq,
          });
          const displayName = remoteRawDisplayName && !isDefaultAgentInstanceDisplayName(
            remoteRawDisplayName, family?.name || familyId, familyId, requestedFamilyInstanceSeq || 1,
          )
            ? remoteRawDisplayName
            : defaultAgentInstanceDisplayName(family?.name || familyId, familyInstanceSeq, familyId);
          run(this.db, `INSERT INTO user_agent_instances (
            id,user_id,agent_family_id,base_agent_version_id,active_personal_skill_version_id,status,
            instance_kind,employment_state,quota_exempt,recruited_at,deactivated_at,last_state_changed_at,state_revision,
            recruitment_source,policy_version,pending_target_state,authority_state,last_employee_command_id,
            sync_enabled,personal_evolution_consent,cluster_contribution_consent,personal_skill_auto_activate,
            family_instance_seq,display_name,note,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
            canonicalId, userId, familyId, remoteBaseAgentVersionId,
            remote.activePersonalSkillVersionId || remote.active_personal_skill_version_id || '',
            remoteStatus,
            remote.instanceKind || remote.instance_kind || 'employee', remote.employmentState || remote.employment_state || 'inactive',
            remote.quotaExempt || remote.quota_exempt ? 1 : 0, remote.recruitedAt || remote.recruited_at || '',
            remote.deactivatedAt || remote.deactivated_at || '', remote.lastStateChangedAt || remote.last_state_changed_at || '',
            Number(remote.stateRevision ?? remote.state_revision ?? 1), remote.recruitmentSource || remote.recruitment_source || 'cloud',
            remote.policyVersion || remote.policy_version || 'employee_cloud_authority_v1', '', 'cloud_confirmed', commandId,
            remoteSyncEnabled, evolutionAllowed, evolutionAllowed, 0,
            familyInstanceSeq, displayName, remote.note || '',
            createdAt, remote.updatedAt || remote.updated_at || nowIso(),
          ]);
          this.ensureDefaultMemoryDocument({ agentInstanceId: canonicalId, withinTransaction: true });
        }
        local = this.getUserAgentInstance(canonicalId) || local;
        const remoteEmploymentState = remote.employmentState || remote.employment_state || 'inactive';
        const remoteRevision = Number(remote.stateRevision ?? remote.state_revision ?? 1);
        const localPending = ['pending', 'conflict'].includes(local?.authorityState || '');
        const remoteSettlesPendingTarget = Boolean(local?.pendingTargetState)
          && remoteEmploymentState === local.pendingTargetState;
        const newerCloudAuthority = remoteRevision > Number(local?.stateRevision || 0);
        const pendingCommand = local?.lastEmployeeCommandId
          ? normalizeEmployeeOutboxCommand(get(this.db, `SELECT * FROM employee_command_outbox
            WHERE command_id=? AND user_id=?`, [local.lastEmployeeCommandId, userId]))
          : null;
        const olderLocalCommandResult = Boolean(commandId && local?.lastEmployeeCommandId)
          && commandId !== local.lastEmployeeCommandId;
        const confirmsPendingDependency = Boolean(pendingCommand?.dependsOnCommandId)
          && (!commandId || pendingCommand.dependsOnCommandId === commandId);
        const preservePendingLifecycle = localPending
          && (!commandId || commandId !== local?.lastEmployeeCommandId)
          && !remoteSettlesPendingTarget
          && (olderLocalCommandResult || confirmsPendingDependency || !newerCloudAuthority);
        const supersededPendingCommandId = localPending && !preservePendingLifecycle && !commandId
          ? String(local?.lastEmployeeCommandId || '')
          : '';
        const targetId = local?.id || canonicalId;
        const remoteUpdatedAt = remote.updatedAt || remote.updated_at || '';
        const remoteProfileWins = !local?.updatedAt || !remoteUpdatedAt || remoteUpdatedAt >= local.updatedAt;
        const requestedRemoteSequence = Math.max(0, Math.floor(Number(
          remote.familyInstanceSeq ?? remote.family_instance_seq ?? local?.familyInstanceSeq ?? 0,
        ) || 0));
        const resolvedRemoteSequence = resolveRemoteEmployeeSequence(this, {
          userId,
          familyId,
          instanceId: targetId,
          requestedSequence: requestedRemoteSequence,
        });
        const remoteDisplayName = remoteRawDisplayName && !isDefaultAgentInstanceDisplayName(
          remoteRawDisplayName, family?.name || familyId, familyId, requestedRemoteSequence || 1,
        )
          ? remoteRawDisplayName
          : defaultAgentInstanceDisplayName(family?.name || familyId, resolvedRemoteSequence, familyId);
        run(this.db, `UPDATE user_agent_instances SET
          base_agent_version_id=?,active_personal_skill_version_id=?,
          status=CASE WHEN ? THEN status ELSE ? END,
          instance_kind=CASE WHEN ? THEN instance_kind ELSE ? END,
          employment_state=CASE WHEN ? THEN employment_state ELSE ? END,
          quota_exempt=CASE WHEN ? THEN quota_exempt ELSE ? END,
          recruited_at=CASE WHEN ? THEN recruited_at ELSE ? END,
          deactivated_at=CASE WHEN ? THEN deactivated_at ELSE ? END,
          last_state_changed_at=CASE WHEN ? THEN last_state_changed_at ELSE ? END,
          state_revision=CASE WHEN ? THEN state_revision ELSE ? END,
          recruitment_source=CASE WHEN ? THEN recruitment_source ELSE ? END,
          policy_version=CASE WHEN ? THEN policy_version ELSE ? END,
          pending_target_state=CASE WHEN ? THEN pending_target_state ELSE '' END,
          authority_state=CASE WHEN ? THEN authority_state ELSE 'cloud_confirmed' END,
          last_employee_command_id=CASE WHEN ? THEN last_employee_command_id ELSE ? END,sync_enabled=?,
          personal_evolution_consent=?,cluster_contribution_consent=?,personal_skill_auto_activate=?,
          family_instance_seq=CASE WHEN ? THEN ? ELSE family_instance_seq END,
          display_name=CASE WHEN ? THEN ? ELSE display_name END,
          note=CASE WHEN ? THEN ? ELSE note END,
          updated_at=CASE WHEN ? THEN ? ELSE updated_at END WHERE id=? AND user_id=?`, [
          remoteBaseAgentVersionId, remote.activePersonalSkillVersionId || remote.active_personal_skill_version_id || '',
          preservePendingLifecycle ? 1 : 0, remoteStatus,
          preservePendingLifecycle ? 1 : 0, remote.instanceKind || remote.instance_kind || 'employee',
          preservePendingLifecycle ? 1 : 0, remoteEmploymentState,
          preservePendingLifecycle ? 1 : 0, remote.quotaExempt || remote.quota_exempt ? 1 : 0,
          preservePendingLifecycle ? 1 : 0, remote.recruitedAt || remote.recruited_at || '',
          preservePendingLifecycle ? 1 : 0, remote.deactivatedAt || remote.deactivated_at || '',
          preservePendingLifecycle ? 1 : 0, remote.lastStateChangedAt || remote.last_state_changed_at || '',
          preservePendingLifecycle ? 1 : 0, remoteRevision,
          preservePendingLifecycle ? 1 : 0, remote.recruitmentSource || remote.recruitment_source || 'cloud',
          preservePendingLifecycle ? 1 : 0, remote.policyVersion || remote.policy_version || 'employee_cloud_authority_v1',
          preservePendingLifecycle ? 1 : 0, preservePendingLifecycle ? 1 : 0,
          preservePendingLifecycle ? 1 : 0, commandId,
          remoteSyncEnabled, evolutionAllowed, evolutionAllowed, 0,
          remoteProfileWins ? 1 : 0, resolvedRemoteSequence,
          remoteProfileWins ? 1 : 0, remoteDisplayName || local?.displayName || '',
          remoteProfileWins ? 1 : 0, remote.note ?? local?.note ?? '',
          remoteProfileWins ? 1 : 0, remote.updatedAt || remote.updated_at || nowIso(), targetId, userId,
        ]);
        if (supersededPendingCommandId) {
          const targetReached = remoteSettlesPendingTarget;
          run(this.db, `UPDATE employee_command_outbox SET status=?,last_error=?,completed_at=?,updated_at=?
            WHERE command_id=? AND user_id=? AND status IN ('pending','sending','failed','blocked_auth','blocked_incompatible_cloud','conflict')`, [
            targetReached ? 'confirmed' : 'conflict',
            targetReached ? '' : 'superseded_by_newer_cloud_snapshot',
            nowIso(), nowIso(), supersededPendingCommandId, userId,
          ]);
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      return this.getUserAgentInstance(local?.id || canonicalId);
    },

    applyCloudEmployeeCommandResult({ userId = '', result = {}, commandId = '' } = {}) {
      const cleanCommandId = String(commandId || result.commandId || result.command_id || '').trim();
      const outbox = cleanCommandId ? get(this.db, 'SELECT * FROM employee_command_outbox WHERE command_id = ? AND user_id = ?', [cleanCommandId, userId]) : null;
      const rejected = result.status === 'rejected';
      if (!rejected && result.instance) this.applyCloudEmployeeInstance({ userId, instance: result.instance, commandId: cleanCommandId });
      if (rejected && outbox?.local_agent_instance_id) {
        const conflict = String(result.code || result.event?.reason || '') === 'employee_state_conflict';
        const previous = outbox.previous_employment_state || 'inactive';
        const restored = previous === 'active' ? 'active' : 'inactive';
        run(this.db, `UPDATE user_agent_instances SET status=?,employment_state=?,pending_target_state='',authority_state=?,
          last_employee_command_id=?,sync_enabled=CASE WHEN ?='not_recruited' THEN 0 ELSE sync_enabled END,updated_at=?
          WHERE id=? AND user_id=? AND last_employee_command_id=?`, [
          conflict ? 'inactive' : restored, conflict ? 'conflict' : restored,
          conflict ? 'conflict' : 'rejected', cleanCommandId, previous, nowIso(), outbox.local_agent_instance_id, userId, cleanCommandId,
        ]);
      }
      if (cleanCommandId) {
        run(this.db, `UPDATE employee_command_outbox SET status=?,attempt_count=attempt_count+1,last_error=?,completed_at=?,updated_at=?
          WHERE command_id=? AND user_id=?`, [
          rejected ? (String(result.code || result.event?.reason || '') === 'employee_state_conflict' ? 'conflict' : 'rejected') : 'confirmed',
          rejected ? String(result.code || result.event?.reason || 'rejected') : '', nowIso(), nowIso(), cleanCommandId, userId,
        ]);
      }
      const event = result.event || null;
      if (event?.id && event.agentFamilyId) {
        run(this.db, `INSERT OR IGNORE INTO user_agent_recruitment_events (
          id,user_id,user_agent_instance_id,agent_family_id,event_type,previous_state,next_state,quota_before,quota_after,
          command_id,source_device_id,reason,metadata_json,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
          event.id, userId, result.instance?.id || event.agentInstanceId || '', event.agentFamilyId,
          event.eventType || (rejected ? 'rejected' : result.action || 'reconciled'), event.previousState || '', event.nextState || '',
          Number(event.quotaBefore || 0), Number(event.quotaAfter || 0), cleanCommandId,
          event.sourceDeviceId || '', event.reason || result.code || '', JSON.stringify(event.metadata || {}), event.createdAt || nowIso(),
        ]);
      }
      return {
        ...result,
        commandId: cleanCommandId,
        instance: result.instance?.id ? this.getUserAgentInstance(result.instance.id) : outbox?.local_agent_instance_id ? this.getUserAgentInstance(outbox.local_agent_instance_id) : null,
        outbox: cleanCommandId ? normalizeEmployeeOutboxCommand(get(this.db, 'SELECT * FROM employee_command_outbox WHERE command_id = ?', [cleanCommandId])) : null,
      };
    },
  });
}

function normalizeEmployeeOutboxCommand(row) {
  if (!row) return null;
  const payload = safeJsonParse(row.payload_json, {});
  return {
    commandId: row.command_id,
    userId: row.user_id,
    remoteUserId: row.remote_user_id || '',
    action: row.action,
    agentFamilyId: row.agent_family_id || '',
    localAgentInstanceId: row.local_agent_instance_id || '',
    proposedInstanceId: row.proposed_instance_id || '',
    expectedStateRevision: Number(row.expected_state_revision || 0),
    previousEmploymentState: row.previous_employment_state || '',
    payload,
    dependsOnCommandId: payload.dependsOnCommandId || '',
    expectedStateRevisionMode: payload.expectedStateRevisionMode || '',
    status: row.status,
    attemptCount: Number(row.attempt_count || 0),
    lastError: row.last_error || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || '',
  };
}

function pendingQuotaCount(db, userId, excludedInstanceId = '') {
  return Number(get(db, `SELECT COUNT(*) AS count FROM user_agent_instances
    WHERE user_id=? AND id!=? AND instance_kind='employee' AND quota_exempt=0
      AND (employment_state='active' OR (authority_state='pending' AND pending_target_state='active' AND employment_state!='conflict'))`,
  [userId, excludedInstanceId])?.count || 0);
}

function employeeQuotaWithReservations(db, userId) {
  const active = Number(get(db, `SELECT COUNT(*) AS count FROM user_agent_instances
    WHERE user_id=? AND instance_kind='employee' AND quota_exempt=0 AND employment_state='active'`, [userId])?.count || 0);
  const reserved = Number(get(db, `SELECT COUNT(*) AS count FROM user_agent_instances
    WHERE user_id=? AND instance_kind='employee' AND quota_exempt=0
      AND employment_state!='active' AND employment_state!='conflict'
      AND authority_state='pending' AND pending_target_state='active'`, [userId])?.count || 0);
  return { active, reserved, used: active + reserved, limit: EMPLOYEE_QUOTA_LIMIT, remaining: Math.max(0, EMPLOYEE_QUOTA_LIMIT - active - reserved) };
}

function normalizeRecruitmentEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    agentInstanceId: row.user_agent_instance_id || '',
    agentFamilyId: row.agent_family_id,
    eventType: row.event_type,
    previousState: row.previous_state || '',
    nextState: row.next_state || '',
    quotaBefore: Number(row.quota_before || 0),
    quotaAfter: Number(row.quota_after || 0),
    commandId: row.command_id,
    sourceDeviceId: row.source_device_id || '',
    reason: row.reason || '',
    metadata: safeJsonParse(row.metadata_json, {}),
    createdAt: row.created_at,
  };
}

function recruitmentResult(store, event, idempotent) {
  const instance = event?.agentInstanceId ? store.getUserAgentInstance(event.agentInstanceId) : null;
  const code = event?.metadata?.code || event?.reason || '';
  const rejected = event?.eventType === 'rejected';
  const eventStatus = event?.metadata?.status || event?.nextState || '';
  return {
    status: rejected ? 'rejected' : eventStatus || instance?.employmentState || 'unknown',
    action: event?.metadata?.action || event?.eventType || '',
    code,
    instance,
    event,
    quota: store.getEmployeeQuota({ userId: event?.userId || '' }),
    idempotent: Boolean(idempotent),
  };
}

function requiredCommandId(value) {
  const commandId = String(value || '').trim();
  if (!commandId) throw employeePolicyError('recruitment_command_required');
  return commandId;
}

function requiredStateRevision(value) {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 1) {
    throw employeePolicyError('employee_state_conflict', 'expectedStateRevision is required.');
  }
  return revision;
}

function resolveRemoteEmployeeSequence(store, {
  userId = '', familyId = '', instanceId = '', requestedSequence = 0,
} = {}) {
  const requested = Math.max(0, Math.floor(Number(requestedSequence) || 0));
  if (requested > 0) {
    const conflict = get(store.db, `SELECT 1 FROM user_agent_instances
      WHERE user_id=? AND agent_family_id=? AND family_instance_seq=? AND id<>? LIMIT 1`, [
      userId, familyId, requested, instanceId,
    ]);
    if (!conflict) return requested;
  }
  const existing = store.getUserAgentInstance(instanceId);
  if (existing?.userId === userId && Number(existing.familyInstanceSeq || 0) > 0) {
    return Number(existing.familyInstanceSeq);
  }
  return store.nextAgentFamilyInstanceSequence({ userId, agentFamilyId: familyId });
}

function rejectedRecruitmentEvent(store, {
  userId,
  instance = null,
  agentFamilyId,
  commandId,
  sourceDeviceId = '',
  quota = {},
  code,
  expectedStateRevision,
} = {}) {
  return store.recordRecruitmentEvent({
    userId,
    agentInstanceId: instance?.id || '',
    agentFamilyId,
    eventType: 'rejected',
    previousState: instance?.employmentState || 'not_recruited',
    nextState: instance?.employmentState || 'not_recruited',
    quotaBefore: Number(quota.used || 0),
    quotaAfter: Number(quota.used || 0),
    commandId,
    sourceDeviceId,
    reason: code,
    metadata: {
      code,
      status: 'rejected',
      ...(expectedStateRevision === undefined ? {} : {
        expectedStateRevision: Number(expectedStateRevision),
        actualStateRevision: Number(instance?.stateRevision || 0),
      }),
    },
  });
}
