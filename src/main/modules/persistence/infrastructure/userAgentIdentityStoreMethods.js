import { all, get, run } from '../../../db.js';
import { newId, nowIso, sha256Text } from '../../../utils.js';
import {
  AGENT_INSTANCE_KINDS,
  EMPLOYEE_POLICY_VERSION,
  classifyAgentFamily,
  compileEffectiveSkill,
  PERSONAL_OVERLAY_COMPILER_VERSION,
} from '../../identity/index.js';
import { recordMemoryVersionEvidenceOutbox } from './evolutionEvidenceOutboxStoreMethods.js';
import { LEGACY_PPT_AGENT_IDS, canonicalPptAgentId, pptStyleForAgentId } from '../../../../shared/pptAgents.js';
import {
  canonicalAgentFamilyName,
  canonicalAgentInstanceDisplayName,
  defaultAgentInstanceDisplayName,
  normalizeAgentInstanceDisplayName,
  normalizeAgentInstanceNote,
} from '../../../../shared/agentInstanceNaming.js';
import { repairPrimaryAgentSessionUniqueness, resequenceMemoryDocumentVersions } from './sqliteMigrations.js';

export { compileEffectiveSkill } from '../../identity/index.js';

const EMPTY_MEMORY_TEMPLATE = (agentFamilyId) => `# Agent Memory: ${agentFamilyId}\n\n## Stable Learnings\n- None yet.\n\n## Reusable Preferences\n- None yet.\n\n## Failure Modes\n- None yet.\n`;
const OVERLAY_COMPILER_VERSION = PERSONAL_OVERLAY_COMPILER_VERSION;

export function installUserAgentIdentityStoreMethods(prototype) {
  Object.assign(prototype, {
    reconcileAgentIdentityCatalog({ organization = {}, memoryTemplateForAgent = null } = {}) {
      const agents = [
        ...(organization.agents || []),
        ...(organization.hrs || []),
        ...(organization.leaders || []),
      ];
      const currentVersions = new Map();
      for (const agent of agents) {
        const family = this.upsertAgentFamily(agent);
        const template = typeof memoryTemplateForAgent === 'function'
          ? String(memoryTemplateForAgent(agent) || '')
          : '';
        const version = this.upsertAgentVersion({ agent, memoryTemplate: template, sourceBundleId: 'bundled_assets' });
        currentVersions.set(family.id, version);
        if (agent.role === 'hr' || agent.role === 'department_leader') continue;
        const runtimeMemory = agent.runtimeMemory === undefined ? '' : this.identityRuntimeMemory(agent);
        const effectiveTemplate = template || EMPTY_MEMORY_TEMPLATE(family.id);
        if (runtimeMemory && sha256Text(runtimeMemory) !== sha256Text(effectiveTemplate)) {
          this.recordLegacyMemoryCandidate({
            agentFamilyId: family.id,
            content: runtimeMemory,
            sourcePath: agent.memoryPath || '',
            templateHash: sha256Text(effectiveTemplate),
          });
        }
      }
      consolidateLegacyPptIdentities(this.db, currentVersions.get('ppt')?.id || '');
      this.reconcileEmployeeInstanceClassifications();
      const users = localPrincipalUsers(this.db);
      for (const user of users) this.reconcileProvisionalEmployeeInstances?.({ userId: user.id });
      for (const user of users) this.provisionNewUserAgentDefaults({ userId: user.id });
      const legacyBackfillComplete = this.settingGet('identity:legacy_agent_backfill_complete', '') === '1';
      const backfill = this.backfillAgentInstanceReferences({
        creationPolicy: legacyBackfillComplete ? 'existing_only' : 'legacy_backfill',
      });
      if (!legacyBackfillComplete) this.settingSet('identity:legacy_agent_backfill_complete', '1');
      return {
        familyCount: agents.length,
        userCount: users.length,
        instanceCount: Number(get(this.db, 'SELECT COUNT(*) AS count FROM user_agent_instances')?.count || 0),
        backfill,
      };
    },

    identityRuntimeMemory(agent = {}) {
      try {
        if (!agent.memoryPath) return '';
        return String(agent.runtimeMemory || '');
      } catch {
        return '';
      }
    },

    upsertAgentFamily(agent = {}) {
      const id = String(agent.id || '').trim();
      if (!id) throw new Error('Agent family id is required.');
      const now = nowIso();
      const employment = classifyAgentFamily(agent);
      run(
        this.db,
        `INSERT INTO agent_families (
          id, department_id, name, role, status, routable, instance_kind,
          recruitable, default_for_new_user, quota_cost, classification_version,
          metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          department_id = excluded.department_id,
          name = excluded.name,
          role = excluded.role,
          status = excluded.status,
          routable = excluded.routable,
          instance_kind = excluded.instance_kind,
          recruitable = excluded.recruitable,
          default_for_new_user = excluded.default_for_new_user,
          quota_cost = excluded.quota_cost,
          classification_version = excluded.classification_version,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at`,
        [
          id,
          agent.departmentId || '',
          canonicalAgentFamilyName(id, agent.name || id),
          agent.role || 'agent',
          agent.lifecycleStatus || (agent.enabled === false ? 'disabled' : 'active'),
          agent.routable ? 1 : 0,
          employment.instanceKind,
          employment.recruitable ? 1 : 0,
          employment.defaultForNewUser ? 1 : 0,
          employment.quotaCost,
          employment.classificationVersion,
          JSON.stringify({
            rank: agent.rank || '',
            lifecycleRole: agent.lifecycleRole || '',
            skillPackageId: agent.skillPackageId || '',
            summary: agent.description || '',
            description: agent.description || '',
            capabilityTags: Array.isArray(agent.skills) ? agent.skills.map(String).filter(Boolean) : [],
          }),
          now,
          now,
        ],
      );
      return this.getAgentFamily(id);
    },

    getAgentFamily(id) {
      return normalizeAgentFamily(get(this.db, 'SELECT * FROM agent_families WHERE id = ?', [id]));
    },

    upsertAgentVersion({ agent = {}, memoryTemplate = '', sourceBundleId = '' } = {}) {
      const agentFamilyId = String(agent.id || '').trim();
      if (!agentFamilyId) throw new Error('Agent family id is required for versioning.');
      const existingFamily = this.getAgentFamily(agentFamilyId);
      const existingVersion = existingFamily?.currentVersionId ? this.getAgentVersion(existingFamily.currentVersionId) : null;
      const baseSkill = agent.baseSkill === undefined
        ? String(existingVersion?.baseSkillContent || '')
        : String(agent.baseSkill || '');
      const config = {
        id: agent.id,
        name: agent.name || agent.id,
        description: agent.description || '',
        systemPrompt: agent.systemPrompt || '',
        selfEvolutionPrompt: agent.selfEvolutionPrompt || '',
        departmentId: agent.departmentId || '',
        role: agent.role || 'agent',
        lifecycleStatus: agent.lifecycleStatus || '',
        routingState: agent.routingState || '',
        rank: agent.rank || '',
        permissions: agent.permissions || {},
      };
      const descriptor = JSON.stringify({ config, baseSkill, memoryTemplate });
      const contentHash = sha256Text(descriptor);
      const id = `agentver_${contentHash.slice(0, 24)}`;
      run(
        this.db,
        `INSERT INTO agent_versions (
          id, agent_family_id, version_label, agent_config_json, base_skill_content,
          base_skill_hash, memory_template_content, memory_template_hash,
          source_bundle_id, content_hash, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
        ON CONFLICT(id) DO NOTHING`,
        [
          id,
          agentFamilyId,
          contentHash.slice(0, 12),
          JSON.stringify(config),
          baseSkill,
          sha256Text(baseSkill),
          memoryTemplate || EMPTY_MEMORY_TEMPLATE(agentFamilyId),
          sha256Text(memoryTemplate || EMPTY_MEMORY_TEMPLATE(agentFamilyId)),
          sourceBundleId || '',
          contentHash,
        ],
      );
      run(this.db, 'UPDATE agent_families SET current_version_id = ?, updated_at = ? WHERE id = ?', [id, nowIso(), agentFamilyId]);
      return this.getAgentVersion(id);
    },

    getAgentVersion(id) {
      return normalizeAgentVersion(get(this.db, 'SELECT * FROM agent_versions WHERE id = ?', [id]));
    },

    ensureUserAgentInstance({
      userId,
      agentFamilyId,
      baseAgentVersionId = '',
      instanceKind = '',
      employmentState = 'active',
      quotaExempt,
      recruitmentSource = 'legacy_internal',
      creationMode = 'existing_only',
      withinTransaction = false,
    } = {}) {
      const cleanUserId = String(userId || '').trim();
      const cleanFamilyId = String(agentFamilyId || '').trim();
      if (!cleanUserId || !cleanFamilyId) return null;
      const existing = get(
        this.db,
        'SELECT * FROM user_agent_instances WHERE user_id = ? AND agent_family_id = ?',
        [cleanUserId, cleanFamilyId],
      );
      if (existing) {
        if (baseAgentVersionId && !existing.base_agent_version_id) {
          run(this.db, 'UPDATE user_agent_instances SET base_agent_version_id = ?, updated_at = ? WHERE id = ?', [baseAgentVersionId, nowIso(), existing.id]);
        }
        this.ensureDefaultMemoryDocument({ agentInstanceId: existing.id, withinTransaction });
        return this.getUserAgentInstance(existing.id);
      }
      if (creationMode === 'existing_only') return null;
      const family = this.getAgentFamily(cleanFamilyId);
      if (!family) return null;
      if (!creationModeAllowed(creationMode, family)) {
        throw new Error(`Agent instance creation mode ${creationMode} is invalid for ${cleanFamilyId}.`);
      }
      const versionId = baseAgentVersionId || family.currentVersionId || '';
      const id = newId('uagent');
      const familyInstanceSeq = this.nextAgentFamilyInstanceSequence({ userId: cleanUserId, agentFamilyId: cleanFamilyId });
      const displayName = defaultAgentInstanceDisplayName(family.name || cleanFamilyId, familyInstanceSeq, cleanFamilyId);
      const resolvedKind = instanceKind || family.instanceKind || 'unavailable';
      const resolvedState = employmentState || 'active';
      const resolvedQuotaExempt = quotaExempt === undefined ? resolvedKind !== 'employee' : Boolean(quotaExempt);
      const evolutionEnabled = Boolean(Number(get(
        this.db,
        "SELECT evolution_enabled FROM cloud_sync_state WHERE id = 'default'",
      )?.evolution_enabled ?? 1));
      const now = nowIso();
      if (!withinTransaction) this.db.exec('BEGIN IMMEDIATE');
      try {
        run(
          this.db,
          `INSERT INTO user_agent_instances (
            id, user_id, agent_family_id, base_agent_version_id, status,
            instance_kind, employment_state, quota_exempt, recruited_at,
            last_state_changed_at, state_revision, recruitment_source, policy_version,
            authority_state, sync_enabled, personal_evolution_consent, cluster_contribution_consent,personal_skill_auto_activate,
            family_instance_seq,display_name
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1, ?, ?, 0,?,?)`,
          [
            id, cleanUserId, cleanFamilyId, versionId,
            resolvedState === 'active' ? 'active' : 'inactive', resolvedKind, resolvedState,
            resolvedQuotaExempt ? 1 : 0, now, now, recruitmentSource, EMPLOYEE_POLICY_VERSION,
            creationMode === 'legacy_backfill' ? 'migration_grandfathered' : 'local_confirmed',
            resolvedState === 'active' && evolutionEnabled ? 1 : 0,
            resolvedState === 'active' && evolutionEnabled ? 1 : 0,
            familyInstanceSeq, displayName,
          ],
        );
        this.ensureDefaultMemoryDocument({ agentInstanceId: id, withinTransaction: true });
        if (!withinTransaction) this.db.exec('COMMIT');
      } catch (error) {
        if (!withinTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
      return this.getUserAgentInstance(id);
    },

    getUserAgentInstance(id) {
      const canonicalId = this.resolveCanonicalAgentInstanceId(id);
      return normalizeUserAgentInstance(get(this.db, 'SELECT * FROM user_agent_instances WHERE id = ?', [canonicalId]));
    },

    findUserAgentInstance({ userId, agentFamilyId } = {}) {
      return normalizeUserAgentInstance(get(
        this.db,
        `SELECT * FROM user_agent_instances WHERE user_id = ? AND agent_family_id = ?
          AND NOT EXISTS (SELECT 1 FROM user_agent_instance_aliases alias WHERE alias.alias_instance_id=user_agent_instances.id)
          ORDER BY employment_state='active' DESC,created_at ASC,id ASC LIMIT 1`,
        [userId || '', agentFamilyId || ''],
      ));
    },

    listUserAgentInstancesByFamily({ userId = '', agentFamilyId = '' } = {}) {
      if (!userId || !agentFamilyId) return [];
      return all(this.db, `SELECT * FROM user_agent_instances WHERE user_id=? AND agent_family_id=?
        AND NOT EXISTS (SELECT 1 FROM user_agent_instance_aliases alias WHERE alias.alias_instance_id=user_agent_instances.id)
        ORDER BY family_instance_seq ASC,created_at ASC,id ASC`, [userId, agentFamilyId]).map(normalizeUserAgentInstance);
    },

    nextAgentFamilyInstanceSequence({ userId = '', agentFamilyId = '' } = {}) {
      return Number(get(this.db, `SELECT COALESCE(MAX(family_instance_seq),0)+1 AS sequence
        FROM user_agent_instances WHERE user_id=? AND agent_family_id=?
          AND NOT EXISTS (SELECT 1 FROM user_agent_instance_aliases alias WHERE alias.alias_instance_id=user_agent_instances.id)`, [userId, agentFamilyId])?.sequence || 1);
    },

    updateUserAgentProfile({ userId = '', agentInstanceId = '', displayName = '', note = '' } = {}) {
      const instance = this.getUserAgentInstance(agentInstanceId);
      if (!instance) throw new Error('Employee Agent instance was not found.');
      if (instance.userId !== userId) throw new Error('Employee Agent instance does not belong to the user.');
      const family = this.getAgentFamily(instance.agentFamilyId);
      const requestedName = normalizeAgentInstanceDisplayName(displayName);
      const normalizedName = requestedName
        ? canonicalAgentInstanceDisplayName({
          agentFamilyId: instance.agentFamilyId,
          familyName: family?.name || instance.agentFamilyId,
          displayName: requestedName,
          sequence: instance.familyInstanceSeq || 1,
        })
        : defaultAgentInstanceDisplayName(family?.name || instance.agentFamilyId, instance.familyInstanceSeq || 1, instance.agentFamilyId);
      run(this.db, 'UPDATE user_agent_instances SET display_name=?,note=?,updated_at=? WHERE id=? AND user_id=?', [
        normalizedName, normalizeAgentInstanceNote(note), nowIso(), instance.id, userId,
      ]);
      return this.getUserAgentInstance(instance.id);
    },

    listUserAgentInstances({ userId = '' } = {}) {
      const rows = userId
        ? all(this.db, `SELECT * FROM user_agent_instances WHERE user_id = ?
          AND NOT EXISTS (SELECT 1 FROM user_agent_instance_aliases alias WHERE alias.alias_instance_id=user_agent_instances.id)
          ORDER BY created_at ASC`, [userId])
        : all(this.db, `SELECT * FROM user_agent_instances
          WHERE NOT EXISTS (SELECT 1 FROM user_agent_instance_aliases alias WHERE alias.alias_instance_id=user_agent_instances.id)
          ORDER BY user_id,created_at ASC`);
      return rows.map(normalizeUserAgentInstance);
    },

    resolveCanonicalAgentInstanceId(agentInstanceId = '') {
      let currentId = String(agentInstanceId || '').trim();
      if (!currentId) return '';
      const visited = new Set();
      while (currentId) {
        if (visited.has(currentId)) throw new Error('Agent instance alias cycle detected.');
        visited.add(currentId);
        const alias = get(this.db, 'SELECT canonical_instance_id FROM user_agent_instance_aliases WHERE alias_instance_id = ?', [currentId]);
        const nextId = String(alias?.canonical_instance_id || '').trim();
        if (!nextId || nextId === currentId) return currentId;
        currentId = nextId;
      }
      return '';
    },

    assertAgentInstanceAliasBinding({ userId = '', aliasInstanceId = '', canonicalInstanceId = '' } = {}) {
      const aliasId = String(aliasInstanceId || '').trim();
      const canonicalId = String(canonicalInstanceId || '').trim();
      if (!userId || !aliasId || !canonicalId) throw new Error('Canonical Agent instance mapping is incomplete.');
      if (aliasId === canonicalId) return canonicalId;
      const visited = new Set([aliasId]);
      let currentId = canonicalId;
      while (currentId) {
        if (visited.has(currentId)) throw new Error('Agent instance alias cycle detected.');
        visited.add(currentId);
        const row = get(this.db, `SELECT canonical_instance_id,user_id FROM user_agent_instance_aliases
          WHERE alias_instance_id=?`, [currentId]);
        if (row?.user_id && row.user_id !== userId) throw new Error('Agent instance alias crosses user boundaries.');
        const nextId = String(row?.canonical_instance_id || '').trim();
        if (!nextId || nextId === currentId) break;
        currentId = nextId;
      }
      const target = this.getUserAgentInstance(currentId || canonicalId);
      if (target && target.userId !== userId) throw new Error('Canonical Agent instance does not belong to the user.');
      return currentId || canonicalId;
    },

    resolveUserAgent({
      userId = '',
      agentInstanceId = '',
      agentFamilyId = '',
      taskRunId = '',
      projectId = '',
      relationshipId = '',
      memoryPurpose = 'runtime',
    } = {}) {
      const canonicalAgentInstanceId = this.resolveCanonicalAgentInstanceId(agentInstanceId);
      let instance = canonicalAgentInstanceId ? this.getUserAgentInstance(canonicalAgentInstanceId) : null;
      if (instance && userId && instance.userId !== userId) throw new Error('User Agent instance does not belong to the requested user.');
      if (instance && agentFamilyId && instance.agentFamilyId !== agentFamilyId) throw new Error('User Agent instance does not match the requested Agent family.');
      if (!instance && userId && agentFamilyId) instance = this.findUserAgentInstance({ userId, agentFamilyId });
      if (!instance) return null;
      const family = this.getAgentFamily(instance.agentFamilyId);
      const skillResolution = this.resolveEffectiveSkill({ agentInstanceId: instance.id });
      const baseVersion = skillResolution?.baseVersion || this.getAgentVersion(instance.baseAgentVersionId || family?.currentVersionId || '');
      const personalSkillVersion = skillResolution?.personalSkillVersion || null;
      const memoryResolution = this.resolveMemoryContext?.({
        agentInstanceId: instance.id,
        taskRunId,
        projectId,
        relationshipId,
        purpose: memoryPurpose,
      }) || { documents: this.listMemoryDocuments({ agentInstanceId: instance.id }), content: '', manifestHash: '' };
      const memoryDocuments = memoryResolution.documents;
      const effectiveSkill = skillResolution?.effectiveSkill || baseVersion?.baseSkillContent || '';
      return {
        instance,
        family,
        baseVersion,
        personalSkillVersion,
        effectiveSkill,
        effectiveSkillHash: skillResolution?.effectiveSkillHash || sha256Text(effectiveSkill),
        memoryDocuments,
        memoryContent: memoryResolution.content || memoryDocuments.map((item) => item.content).filter(Boolean).join('\n\n'),
        memoryManifestHash: memoryResolution.manifestHash || sha256Text(JSON.stringify(memoryDocuments.map((item) => ({ id: item.id, currentVersionId: item.currentVersionId, contentHash: item.contentHash })))),
      };
    },

    resolveEffectiveSkill({ agentInstanceId } = {}) {
      const instance = this.getUserAgentInstance(agentInstanceId);
      if (!instance) return null;
      const family = this.getAgentFamily(instance.agentFamilyId);
      const baseVersion = this.getAgentVersion(instance.baseAgentVersionId || family?.currentVersionId || '');
      const personalSkillVersion = instance.activePersonalSkillVersionId
        ? normalizePersonalSkillVersion(get(this.db, 'SELECT * FROM user_agent_skill_versions WHERE id = ? AND user_agent_instance_id = ?', [instance.activePersonalSkillVersionId, instance.id]))
        : null;
      const marketProjectionRow = get(this.db, 'SELECT payload_json FROM cloud_stage8_projections WHERE projection_key = ?', [`effective_skill:${instance.id}`]);
      const marketProjection = safeJson(marketProjectionRow?.payload_json);
      const projectedSkill = marketProjection?.agentInstanceId === instance.id ? String(marketProjection.effectiveSkill || '') : '';
      const effectiveSkill = projectedSkill || compileEffectiveSkill(baseVersion?.baseSkillContent || '', personalSkillVersion?.overlayText || '');
      return {
        instance,
        baseVersion,
        personalSkillVersion,
        effectiveSkill,
        effectiveSkillHash: sha256Text(effectiveSkill),
        compilerVersion: projectedSkill ? 'market_sections_overlay_v1' : OVERLAY_COMPILER_VERSION,
      };
    },

    createPersonalSkillVersion({ agentInstanceId, overlayText = '', sourceEvolutionRunId = '' } = {}) {
      const instance = this.getUserAgentInstance(agentInstanceId);
      if (!instance) throw new Error('User Agent instance not found.');
      const family = this.getAgentFamily(instance.agentFamilyId);
      const baseVersion = this.getAgentVersion(instance.baseAgentVersionId || family?.currentVersionId || '');
      if (!baseVersion) throw new Error('Base Agent version not found.');
      const effectiveSkill = compileEffectiveSkill(baseVersion.baseSkillContent, overlayText);
      const id = newId('uaskill');
      const now = nowIso();
      run(this.db, `INSERT INTO user_agent_skill_versions (
        id, user_agent_instance_id, base_agent_version_id, parent_version_id,
        overlay_text, effective_skill_content, effective_skill_hash, compiler_version,
        status, source_evolution_run_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?)`, [
        id, instance.id, baseVersion.id, instance.activePersonalSkillVersionId || '',
        String(overlayText || ''), effectiveSkill, sha256Text(effectiveSkill), OVERLAY_COMPILER_VERSION,
        sourceEvolutionRunId || '', now, now,
      ]);
      return normalizePersonalSkillVersion(get(this.db, 'SELECT * FROM user_agent_skill_versions WHERE id = ?', [id]));
    },

    activatePersonalSkillVersion({ agentInstanceId, skillVersionId } = {}) {
      const instance = this.getUserAgentInstance(agentInstanceId);
      const target = get(this.db, 'SELECT * FROM user_agent_skill_versions WHERE id = ? AND user_agent_instance_id = ?', [skillVersionId || '', agentInstanceId || '']);
      if (!instance || !target) throw new Error('Personal Skill version does not belong to this Agent instance.');
      const now = nowIso();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        run(this.db, `UPDATE user_agent_skill_versions
          SET status = 'archived', archived_at = ?, updated_at = ?
          WHERE user_agent_instance_id = ? AND status = 'active' AND id <> ?`, [now, now, instance.id, target.id]);
        run(this.db, `UPDATE user_agent_skill_versions
          SET status = 'active', activated_at = ?, archived_at = '', updated_at = ? WHERE id = ?`, [now, now, target.id]);
        run(this.db, 'UPDATE user_agent_instances SET active_personal_skill_version_id = ?, updated_at = ? WHERE id = ?', [target.id, now, instance.id]);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      const resolution = this.resolveEffectiveSkill({ agentInstanceId: instance.id });
      this.notifyEffectiveSkillChanged?.({
        userId: instance.userId, agentInstanceId: instance.id, trigger: 'personal_skill_activated',
      });
      return resolution;
    },

    deactivatePersonalSkill({ agentInstanceId } = {}) {
      const instance = this.getUserAgentInstance(agentInstanceId);
      if (!instance) throw new Error('User Agent instance not found.');
      const now = nowIso();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        run(this.db, `UPDATE user_agent_skill_versions SET status = 'archived', archived_at = CASE WHEN archived_at = '' THEN ? ELSE archived_at END, updated_at = ?
          WHERE user_agent_instance_id = ? AND status = 'active'`, [now, now, instance.id]);
        run(this.db, "UPDATE user_agent_instances SET active_personal_skill_version_id = '', updated_at = ? WHERE id = ?", [now, instance.id]);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      const resolution = this.resolveEffectiveSkill({ agentInstanceId: instance.id });
      this.notifyEffectiveSkillChanged?.({
        userId: instance.userId, agentInstanceId: instance.id, trigger: 'personal_skill_deactivated',
      });
      return resolution;
    },

    ensureDefaultMemoryDocument({ agentInstanceId, workspaceId = '', withinTransaction = false } = {}) {
      const instance = this.getUserAgentInstance(agentInstanceId);
      if (!instance) return null;
      const resolvedWorkspaceId = this.resolveAccountWorkspaceId?.({ userId: instance.userId, workspaceId }) || 'workspace_personal';
      const existing = get(
        this.db,
        "SELECT * FROM memory_documents WHERE account_workspace_id=? AND user_agent_instance_id = ? AND scope = 'general' AND slot_no = 0",
        [resolvedWorkspaceId, agentInstanceId],
      );
      if (existing) {
        const pointedContext = existing.context_space_id
          ? get(this.db, `SELECT id FROM agent_context_spaces WHERE id=? AND account_workspace_id=? AND user_id=?
            AND user_agent_instance_id=? AND context_kind='general_memory' AND memory_document_id=?`, [
            existing.context_space_id, resolvedWorkspaceId, instance.userId, instance.id, existing.id,
          ])
          : null;
        if (!pointedContext) {
          const exactContext = this.ensureAgentContextSpace?.({
            userId: instance.userId,
            agentInstanceId: instance.id,
            workspaceId: resolvedWorkspaceId,
            contextKind: 'general_memory',
            memoryDocumentId: existing.id,
            lifecycleState: existing.lifecycle_state === 'archived' ? 'archived' : existing.lifecycle_state === 'active' ? 'active' : 'inactive',
          });
          if (exactContext?.id) {
            run(this.db, 'UPDATE memory_documents SET context_space_id=?,updated_at=MAX(updated_at,?) WHERE id=?', [
              exactContext.id, nowIso(), existing.id,
            ]);
          }
        }
        return this.getMemoryDocument(existing.id);
      }
      const family = this.getAgentFamily(instance.agentFamilyId);
      const version = this.getAgentVersion(instance.baseAgentVersionId || family?.currentVersionId || '');
      const content = version?.memoryTemplateContent || EMPTY_MEMORY_TEMPLATE(instance.agentFamilyId);
      return this.createMemoryDocument({
        agentInstanceId: instance.id,
        scope: 'general',
        slotNo: 0,
        displayName: 'memory0.md',
        content,
        sourceKind: 'agent_template',
        sourceId: version?.id || '',
        workspaceId: resolvedWorkspaceId,
        withinTransaction,
      });
    },

    getMemoryDocument(id) {
      const alias = get(this.db, 'SELECT canonical_document_id FROM memory_document_aliases WHERE alias_document_id = ?', [id || '']);
      const documentId = alias?.canonical_document_id || id;
      const row = get(
        this.db,
        `SELECT md.*, mdv.content AS current_content,
          mdv.encryption_algorithm AS current_encryption_algorithm,mdv.encryption_key_id AS current_encryption_key_id,
          mdv.encryption_key_version AS current_encryption_key_version,mdv.content_ciphertext AS current_content_ciphertext,
          mdv.content_nonce AS current_content_nonce,mdv.content_tag AS current_content_tag,mdv.content_aad AS current_content_aad
         FROM memory_documents md
         LEFT JOIN memory_document_versions mdv ON mdv.id = md.current_version_id
         WHERE md.id = ?`,
        [documentId],
      );
      return normalizeMemoryDocument(row, this);
    },

    listMemoryDocuments({ agentInstanceId = '', userId = '', workspaceId = '', allWorkspaces = false } = {}) {
      const where = ['1 = 1'];
      const params = [];
      if (agentInstanceId) { where.push('md.user_agent_instance_id = ?'); params.push(agentInstanceId); }
      const resolvedUserId = userId || (agentInstanceId ? get(this.db, 'SELECT user_id FROM user_agent_instances WHERE id=?', [agentInstanceId])?.user_id || '' : '');
      if (resolvedUserId) { where.push('md.user_id = ?'); params.push(resolvedUserId); }
      if (resolvedUserId && !allWorkspaces) {
        where.push('md.account_workspace_id = ?');
        params.push(this.resolveAccountWorkspaceId?.({ userId: resolvedUserId, workspaceId }) || 'workspace_personal');
      }
      return all(
        this.db,
        `SELECT md.*, mdv.content AS current_content,
          mdv.encryption_algorithm AS current_encryption_algorithm,mdv.encryption_key_id AS current_encryption_key_id,
          mdv.encryption_key_version AS current_encryption_key_version,mdv.content_ciphertext AS current_content_ciphertext,
          mdv.content_nonce AS current_content_nonce,mdv.content_tag AS current_content_tag,mdv.content_aad AS current_content_aad
         FROM memory_documents md
         LEFT JOIN memory_document_versions mdv ON mdv.id = md.current_version_id
         WHERE ${where.join(' AND ')}
         ORDER BY md.scope, md.slot_no, md.created_at`,
        params,
      ).map((row) => normalizeMemoryDocument(row, this));
    },

    listMemoryDocumentVersions({ memoryDocumentId = '' } = {}) {
      const alias = get(this.db, 'SELECT canonical_document_id FROM memory_document_aliases WHERE alias_document_id = ?', [memoryDocumentId || '']);
      const documentId = alias?.canonical_document_id || memoryDocumentId;
      if (!documentId) return [];
      return all(this.db, `SELECT * FROM memory_document_versions
        WHERE memory_document_id = ? ORDER BY version_no DESC, created_at DESC`, [documentId]).map((row) => {
        let resolvedContent = '';
        let decryptionState = row.encryption_algorithm ? 'unavailable' : 'plaintext_legacy';
        try {
          resolvedContent = this.decryptMemoryVersionContent?.(row) ?? row.content ?? '';
          if (row.encryption_algorithm) decryptionState = 'decrypted';
        } catch {}
        return ({
        id: row.id,
        memoryDocumentId: row.memory_document_id,
        versionNo: Number(row.version_no || 0),
        content: resolvedContent,
        decryptionState,
        contentHash: row.content_hash || '',
        sourceKind: row.source_kind || '',
        sourceId: row.source_id || '',
        privacyLevel: row.privacy_level || 'private',
        reviewStatus: row.review_status || 'unreviewed',
        createdBy: row.created_by || '',
        originDocumentId: row.origin_document_id || '',
        originVersionNo: Number(row.origin_version_no || 0),
        baseVersionId: row.base_version_id || '',
        parentVersionId: row.parent_version_id || '',
        branchId: row.branch_id || 'main',
        conflictState: row.conflict_state || 'none',
        visibility: normalizeMemoryVisibility(row.visibility),
        publishedAt: row.published_at || '',
        publishedByAgentInstanceId: row.published_by_agent_instance_id || '',
        sourceCursor: row.source_cursor || '',
        encryptionAlgorithm: row.encryption_algorithm || '',
        encryptionKeyId: row.encryption_key_id || '',
        encryptionKeyVersion: Number(row.encryption_key_version || 0),
        createdAt: row.created_at || '',
      });
      });
    },

    appendMemoryDocumentVersion({
      memoryDocumentId,
      content = '',
      sourceKind = 'user_edit',
      sourceId = '',
      reviewStatus = 'unreviewed',
      createdBy = '',
      visibility = 'agent_private',
      publishedAt = '',
      publishedByAgentInstanceId = '',
      sourceCursor = '',
      baseVersionId = '',
      parentVersionId = '',
      branchId = 'main',
      conflictState = 'none',
      activate = true,
      withinTransaction = false,
    } = {}) {
      const alias = get(this.db, 'SELECT canonical_document_id FROM memory_document_aliases WHERE alias_document_id = ?', [memoryDocumentId || '']);
      const documentId = alias?.canonical_document_id || memoryDocumentId;
      const document = get(this.db, 'SELECT * FROM memory_documents WHERE id = ?', [documentId || '']);
      if (!document) throw new Error('Memory document not found.');
      const text = String(content || '');
      const hash = sha256Text(text);
      const versionId = newId('memdocver');
      const now = nowIso();
      const normalizedVisibility = normalizeMemoryVisibility(visibility);
      const resolvedBaseVersionId = baseVersionId || document.current_version_id || '';
      const resolvedParentVersionId = parentVersionId || resolvedBaseVersionId;
      const isConflict = Boolean(resolvedBaseVersionId && document.current_version_id && resolvedBaseVersionId !== document.current_version_id);
      const resolvedConflictState = isConflict ? 'unresolved' : (conflictState || 'none');
      const resolvedBranchId = isConflict && (!branchId || branchId === 'main') ? newId('memory_branch') : (branchId || 'main');
      if (publishedAt && !publishedByAgentInstanceId) throw new Error('Published Memory version requires publishing Agent instance.');
      if (!withinTransaction) this.db.exec('BEGIN IMMEDIATE');
      try {
        const nextVersion = Number(get(this.db, 'SELECT COALESCE(MAX(version_no), 0) + 1 AS value FROM memory_document_versions WHERE memory_document_id = ?', [document.id])?.value || 1);
        const protectedContent = this.protectMemoryVersionContent?.({ document, versionNo: nextVersion, content: text })
          || { content: text, algorithm: '', keyId: '', keyVersion: 0, ciphertext: '', nonce: '', tag: '', aad: '' };
        run(this.db, `INSERT INTO memory_document_versions (
          id, memory_document_id, version_no, content, content_hash, source_kind,
          source_id, privacy_level, review_status, created_by, origin_document_id,
          origin_version_no,base_version_id,parent_version_id,branch_id,conflict_state,
          visibility, published_at, published_by_agent_instance_id,
          source_cursor,encryption_algorithm,encryption_key_id,encryption_key_version,content_ciphertext,
          content_nonce,content_tag,content_aad,created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'private', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
          versionId, document.id, nextVersion, protectedContent.content, hash, sourceKind || '', sourceId || '',
          reviewStatus || 'unreviewed', createdBy || document.user_id, document.id, nextVersion,
          resolvedBaseVersionId, resolvedParentVersionId, resolvedBranchId, resolvedConflictState,
          normalizedVisibility, publishedAt || '', publishedByAgentInstanceId || '', sourceCursor || '',
          protectedContent.algorithm, protectedContent.keyId, protectedContent.keyVersion,
          protectedContent.ciphertext, protectedContent.nonce, protectedContent.tag, protectedContent.aad, now,
        ]);
        if (activate && !isConflict) run(this.db, 'UPDATE memory_documents SET current_version_id = ?, content_hash = ?, visibility = ?, updated_at = ? WHERE id = ?', [
          versionId, hash, normalizedVisibility, now, document.id,
        ]);
        recordMemoryVersionEvidenceOutbox(this, { documentId: document.id, versionId });
        if (!withinTransaction) this.db.exec('COMMIT');
      } catch (error) {
        if (!withinTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
      return this.getMemoryDocument(document.id);
    },

    listMemoryConflicts({ memoryDocumentId = '' } = {}) {
      const document = this.getMemoryDocument(memoryDocumentId);
      if (!document) return [];
      return all(this.db, `SELECT * FROM memory_document_versions WHERE memory_document_id=? AND conflict_state='unresolved'
        ORDER BY created_at DESC,id DESC`, [document.id]).map((row) => ({
        id: row.id, memoryDocumentId: row.memory_document_id, versionNo: Number(row.version_no || 0),
        content: this.decryptMemoryVersionContent?.(row) ?? row.content ?? '', contentHash: row.content_hash || '',
        baseVersionId: row.base_version_id || '', parentVersionId: row.parent_version_id || '', branchId: row.branch_id || '',
        conflictState: row.conflict_state || 'none', createdAt: row.created_at,
      }));
    },

    resolveMemoryConflict({ memoryDocumentId = '', versionId = '', createdBy = '' } = {}) {
      const document = this.getMemoryDocument(memoryDocumentId);
      const version = get(this.db, 'SELECT * FROM memory_document_versions WHERE id=? AND memory_document_id=?', [versionId, document?.id || '']);
      if (!document || !version) throw new Error('Memory conflict version not found.');
      const selectedContent = this.decryptMemoryVersionContent?.(version) ?? version.content ?? '';
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const merged = this.appendMemoryDocumentVersion({
          memoryDocumentId: document.id,
          content: selectedContent,
          sourceKind: 'conflict_resolution',
          sourceId: version.id,
          reviewStatus: 'user_resolved',
          createdBy: createdBy || document.userId,
          baseVersionId: document.currentVersionId,
          parentVersionId: document.currentVersionId,
          branchId: 'main',
          conflictState: 'resolved',
          activate: true,
          withinTransaction: true,
        });
        run(this.db, "UPDATE memory_document_versions SET conflict_state=CASE WHEN id=? THEN 'selected' WHEN conflict_state='unresolved' THEN 'retained' ELSE conflict_state END WHERE memory_document_id=?", [version.id, document.id]);
        this.db.exec('COMMIT');
        return {
          document: this.getMemoryDocument(document.id),
          selectedVersionId: version.id,
          mergedVersionId: merged.currentVersionId,
          createdBy,
        };
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    },

    updateUserAgentConsents({ agentInstanceId, syncEnabled, personalEvolutionConsent, clusterContributionConsent, personalSkillAutoActivate } = {}) {
      const instance = this.getUserAgentInstance(agentInstanceId);
      if (!instance) throw new Error('User Agent instance not found.');
      const fields = [];
      const params = [];
      if (syncEnabled !== undefined) { fields.push('sync_enabled = ?'); params.push(syncEnabled ? 1 : 0); }
      const evolutionEnabled = Boolean(Number(get(
        this.db,
        "SELECT evolution_enabled FROM cloud_sync_state WHERE id = 'default'",
      )?.evolution_enabled ?? 1));
      const nextSyncEnabled = syncEnabled === undefined ? instance.syncEnabled : Boolean(syncEnabled);
      const evolutionAllowed = evolutionEnabled && nextSyncEnabled && instance.status === 'active';
      fields.push('personal_evolution_consent = ?');
      params.push(evolutionAllowed ? 1 : 0);
      fields.push('cluster_contribution_consent = ?');
      params.push(evolutionAllowed ? 1 : 0);
      fields.push('personal_skill_auto_activate = ?');
      params.push(0);
      fields.push('updated_at = ?');
      params.push(nowIso(), instance.id);
      run(this.db, `UPDATE user_agent_instances SET ${fields.join(', ')} WHERE id = ?`, params);
      const updated = this.getUserAgentInstance(instance.id);
      run(this.db, `UPDATE memory_documents SET allow_personal_evolution=?,allow_cluster_evolution=?,sync_enabled=?,updated_at=?
        WHERE user_agent_instance_id=?`, [
        updated.personalEvolutionConsent ? 1 : 0,
        updated.syncEnabled && updated.status === 'active' ? 1 : 0,
        updated.syncEnabled ? 1 : 0,
        nowIso(), updated.id,
      ]);
      return this.getUserAgentInstance(instance.id);
    },

    updateMemoryEvolutionPermissions({ memoryDocumentId, allowPersonalEvolution, allowClusterEvolution } = {}) {
      const alias = get(this.db, 'SELECT canonical_document_id FROM memory_document_aliases WHERE alias_document_id = ?', [memoryDocumentId || '']);
      const documentId = alias?.canonical_document_id || memoryDocumentId;
      const document = this.getMemoryDocument(documentId);
      if (!document) throw new Error('Memory document not found.');
      const fields = [];
      const params = [];
      const instance = this.getUserAgentInstance(document.userAgentInstanceId);
      const evolutionEnabled = Boolean(Number(get(
        this.db,
        "SELECT evolution_enabled FROM cloud_sync_state WHERE id = 'default'",
      )?.evolution_enabled ?? 1));
      const evolutionAllowed = evolutionEnabled && instance?.syncEnabled && instance?.status === 'active';
      fields.push('allow_personal_evolution = ?');
      params.push(evolutionAllowed ? 1 : 0);
      fields.push('allow_cluster_evolution = ?');
      params.push(evolutionAllowed ? 1 : 0);
      fields.push('updated_at = ?');
      params.push(nowIso(), documentId);
      run(this.db, `UPDATE memory_documents SET ${fields.join(', ')} WHERE id = ?`, params);
      return this.getMemoryDocument(documentId);
    },

    recordLegacyMemoryCandidate({ agentFamilyId, content, sourcePath = '', templateHash = '' } = {}) {
      const cleanContent = String(content || '');
      if (!agentFamilyId || !cleanContent.trim()) return null;
      const contentHash = sha256Text(cleanContent);
      const existing = get(this.db, 'SELECT id FROM legacy_memory_candidates WHERE agent_family_id = ? AND content_hash = ?', [agentFamilyId, contentHash]);
      if (existing) return existing.id;
      const id = newId('legacymem');
      run(
        this.db,
        `INSERT INTO legacy_memory_candidates (
          id, agent_family_id, content, content_hash, template_hash, source_path, review_status
        ) VALUES (?, ?, ?, ?, ?, ?, 'needs_review')`,
        [id, agentFamilyId, cleanContent, contentHash, templateHash, sourcePath],
      );
      return id;
    },

    backfillAgentInstanceReferences({ creationPolicy = 'existing_only' } = {}) {
      const allowLegacyCreation = creationPolicy === 'legacy_backfill';
      const pairs = all(
        this.db,
        `SELECT DISTINCT user_id, agent_id FROM sessions
         WHERE user_id != '' AND agent_id != ''`,
      );
      if (allowLegacyCreation) {
        for (const pair of pairs) this.ensureUserAgentInstance({
          userId: pair.user_id,
          agentFamilyId: pair.agent_id,
          creationMode: 'legacy_backfill',
          recruitmentSource: 'migration',
        });
      }
      run(
        this.db,
        `UPDATE sessions
         SET agent_instance_id = COALESCE((
           SELECT uai.id FROM user_agent_instances uai
           WHERE uai.user_id = sessions.user_id AND uai.agent_family_id = sessions.agent_id
         ), '')
         WHERE agent_id != '' AND agent_instance_id = ''`,
      );
      run(
        this.db,
        `UPDATE messages
         SET agent_instance_id = COALESCE((SELECT s.agent_instance_id FROM sessions s WHERE s.id = messages.session_id), '')
         WHERE agent_instance_id = '' AND session_id != ''`,
      );
      run(this.db, `UPDATE messages SET agent_instance_id = COALESCE((
        SELECT tn.agent_instance_id FROM task_nodes tn WHERE tn.id = messages.task_node_id
      ), '') WHERE agent_instance_id = '' AND task_node_id != ''`);
      run(
        this.db,
        `UPDATE model_executions
         SET agent_instance_id = COALESCE((
           SELECT uai.id FROM user_agent_instances uai
           WHERE uai.user_id = model_executions.user_id AND uai.agent_family_id = model_executions.agent_id
         ), '')
         WHERE agent_instance_id = '' AND user_id != '' AND agent_id != ''`,
      );
      const taskPairs = all(this.db, `SELECT DISTINCT owner_user_id AS user_id, lead_agent_id AS agent_id FROM task_runs
        WHERE owner_user_id != '' AND lead_agent_id != ''`);
      if (allowLegacyCreation) {
        for (const pair of taskPairs) this.ensureUserAgentInstance({
          userId: pair.user_id,
          agentFamilyId: pair.agent_id,
          creationMode: 'legacy_backfill',
          recruitmentSource: 'migration',
        });
      }
      run(this.db, `UPDATE task_runs SET lead_agent_instance_id = COALESCE((
        SELECT id FROM user_agent_instances uai WHERE uai.user_id = task_runs.owner_user_id AND uai.agent_family_id = task_runs.lead_agent_id
      ), '') WHERE lead_agent_instance_id = '' AND owner_user_id != '' AND lead_agent_id != ''`);
      run(this.db, `UPDATE task_nodes SET agent_instance_id = COALESCE((
        SELECT uai.id FROM task_runs tr JOIN user_agent_instances uai
          ON uai.user_id = tr.owner_user_id AND uai.agent_family_id = task_nodes.agent_id
        WHERE tr.id = task_nodes.task_run_id
      ), '') WHERE agent_instance_id = '' AND agent_id != ''`);
      for (const table of ['memory_entries', 'typed_memories']) {
        run(this.db, `UPDATE ${table} SET agent_instance_id = COALESCE((
          SELECT id FROM user_agent_instances uai WHERE uai.user_id = ${table}.user_id AND uai.agent_family_id = ${table}.agent_id
        ), '') WHERE agent_instance_id = '' AND user_id != '' AND agent_id != ''`);
        run(this.db, `UPDATE ${table} SET memory_document_id = COALESCE((
          SELECT md.id FROM memory_documents md WHERE md.user_agent_instance_id = ${table}.agent_instance_id
            AND md.scope = 'general' AND md.slot_no = 0
        ), '') WHERE memory_document_id = '' AND agent_instance_id != ''`);
      }
      run(this.db, `UPDATE agent_performance_reviews SET user_agent_instance_id = COALESCE((
        SELECT id FROM user_agent_instances uai WHERE uai.user_id = agent_performance_reviews.user_id
          AND uai.agent_family_id = agent_performance_reviews.agent_family_id
      ), '') WHERE user_agent_instance_id = '' AND user_id != '' AND agent_family_id != ''`);
      for (const table of ['evolution_runs', 'evolution_archives']) {
        run(this.db, `UPDATE ${table} SET user_agent_instance_id = COALESCE((
          SELECT id FROM user_agent_instances uai WHERE uai.user_id = ${table}.user_id
            AND uai.agent_family_id = ${table}.agent_family_id
        ), '') WHERE user_agent_instance_id = '' AND user_id != '' AND agent_family_id != ''`);
      }
      const unresolvedSessions = Number(get(this.db, `SELECT COUNT(*) AS count FROM sessions
        WHERE user_id != '' AND agent_id != '' AND agent_instance_id = ''`)?.count || 0);
      const unresolvedTasks = Number(get(this.db, `SELECT COUNT(*) AS count FROM task_runs
        WHERE owner_user_id != '' AND lead_agent_id != '' AND lead_agent_instance_id = ''`)?.count || 0);
      const quarantineRows = [
        ...all(this.db, `SELECT id,user_id,agent_id FROM sessions WHERE user_id!='' AND agent_id!='' AND agent_instance_id=''`)
          .map((row) => ({ table: 'sessions', id: row.id, userId: row.user_id, familyId: row.agent_id })),
        ...all(this.db, `SELECT id,owner_user_id AS user_id,lead_agent_id AS agent_id FROM task_runs
          WHERE owner_user_id!='' AND lead_agent_id!='' AND lead_agent_instance_id=''`)
          .map((row) => ({ table: 'task_runs', id: row.id, userId: row.user_id, familyId: row.agent_id })),
        ...all(this.db, `SELECT n.id,r.owner_user_id AS user_id,n.agent_id FROM task_nodes n JOIN task_runs r ON r.id=n.task_run_id
          WHERE n.agent_id!='' AND n.agent_instance_id=''`)
          .map((row) => ({ table: 'task_nodes', id: row.id, userId: row.user_id, familyId: row.agent_id })),
        ...all(this.db, `SELECT id,user_id,agent_id FROM model_executions WHERE user_id!='' AND agent_id!='' AND agent_instance_id=''`)
          .map((row) => ({ table: 'model_executions', id: row.id, userId: row.user_id, familyId: row.agent_id })),
      ];
      for (const table of ['memory_entries', 'typed_memories']) {
        quarantineRows.push(...all(this.db, `SELECT id,user_id,agent_id FROM ${table}
          WHERE user_id!='' AND agent_id!='' AND agent_instance_id=''`)
          .map((row) => ({ table, id: row.id, userId: row.user_id, familyId: row.agent_id })));
      }
      for (const row of quarantineRows) {
        run(this.db, `INSERT OR IGNORE INTO agent_identity_migration_quarantine (
          id,source_table,source_id,user_id,agent_family_id,reason,payload_json
        ) VALUES (?,?,?,?,?,'unresolved_user_agent_identity',?)`, [
          `identity_quarantine_${sha256Text(`${row.table}:${row.id}:unresolved_user_agent_identity`).slice(0, 32)}`,
          row.table, row.id, row.userId || '', row.familyId || '', JSON.stringify(row),
        ]);
      }
      return {
        status: 'completed', creationPolicy, unresolvedSessions, unresolvedTasks,
        quarantineCount: Number(get(this.db, 'SELECT COUNT(*) AS count FROM agent_identity_migration_quarantine')?.count || 0),
      };
    },

    bindCanonicalAgentInstance({ userId, aliasInstanceId, canonicalInstanceId, reason = 'cloud_canonical_merge', withinTransaction = false } = {}) {
      const aliasId = String(aliasInstanceId || '').trim();
      const canonicalId = String(canonicalInstanceId || '').trim();
      if (!userId || !aliasId || !canonicalId) throw new Error('Canonical Agent instance mapping is incomplete.');
      if (aliasId === canonicalId) return this.getUserAgentInstance(canonicalId);
      this.assertAgentInstanceAliasBinding({ userId, aliasInstanceId: aliasId, canonicalInstanceId: canonicalId });
      const aliasInstance = normalizeUserAgentInstance(get(this.db, 'SELECT * FROM user_agent_instances WHERE id=?', [aliasId]));
      const canonicalInstance = normalizeUserAgentInstance(get(this.db, 'SELECT * FROM user_agent_instances WHERE id=?', [canonicalId]));
      if (!aliasInstance && canonicalInstance) {
        run(this.db, `INSERT INTO user_agent_instance_aliases (alias_instance_id, canonical_instance_id, user_id, reason)
          VALUES (?, ?, ?, ?) ON CONFLICT(alias_instance_id) DO UPDATE SET canonical_instance_id = excluded.canonical_instance_id, user_id = excluded.user_id, reason = excluded.reason`,
        [aliasId, canonicalId, userId, reason]);
        return canonicalInstance;
      }
      if (!aliasInstance || aliasInstance.userId !== userId) throw new Error('Alias Agent instance does not belong to the user.');
      if (canonicalInstance && (canonicalInstance.userId !== userId
        || canonicalPptAgentId(canonicalInstance.agentFamilyId) !== canonicalPptAgentId(aliasInstance.agentFamilyId))) {
        throw new Error('Canonical Agent instance identity mismatch.');
      }
      if (!withinTransaction) this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec('DROP INDEX IF EXISTS idx_sessions_one_primary_agent');
        if (!canonicalInstance) {
          run(this.db, 'UPDATE user_agent_instances SET id = ?, updated_at = ? WHERE id = ?', [canonicalId, nowIso(), aliasId]);
        }
        run(this.db, `INSERT INTO user_agent_instance_aliases (alias_instance_id, canonical_instance_id, user_id, reason)
          VALUES (?, ?, ?, ?) ON CONFLICT(alias_instance_id) DO UPDATE SET canonical_instance_id = excluded.canonical_instance_id, user_id = excluded.user_id, reason = excluded.reason`,
        [aliasId, canonicalId, userId, reason]);
        rewriteAgentInstanceReferences(this.db, aliasId, canonicalId);
        mergeInstanceMemoryDocuments(this.db, userId, aliasId, canonicalId);
        run(this.db, `UPDATE memory_document_versions SET published_by_agent_instance_id=?
          WHERE published_by_agent_instance_id=?`, [canonicalId, aliasId]);
        if (canonicalInstance) {
          run(this.db, 'UPDATE user_agent_skill_versions SET user_agent_instance_id = ?, updated_at = ? WHERE user_agent_instance_id = ?', [canonicalId, nowIso(), aliasId]);
          run(this.db, 'DELETE FROM user_agent_instances WHERE id = ?', [aliasId]);
        }
        run(this.db, `INSERT INTO user_agent_instance_aliases (alias_instance_id, canonical_instance_id, user_id, reason)
          VALUES (?, ?, ?, ?) ON CONFLICT(alias_instance_id) DO UPDATE SET canonical_instance_id = excluded.canonical_instance_id, user_id = excluded.user_id, reason = excluded.reason`,
        [aliasId, canonicalId, userId, reason]);
        reconcileActiveSkillVersion(this.db, canonicalId);
        repairPrimaryAgentSessionUniqueness(this.db);
        mergeAgentConversationSessionsForInstance(this.db, userId, canonicalId);
        repairAgentConversationBranchesForInstance(this.db, userId, canonicalId);
        this.db.exec(`CREATE UNIQUE INDEX idx_sessions_one_primary_agent ON sessions(user_id,account_workspace_id,agent_instance_id)
          WHERE agent_instance_id!='' AND conversation_role='primary' AND write_state='writable' AND status!='deleted'`);
        if (!withinTransaction) this.db.exec('COMMIT');
      } catch (error) {
        if (!withinTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
      return this.getUserAgentInstance(canonicalId);
    },

    bindCanonicalMemoryDocument({ userId, aliasDocumentId, canonicalDocumentId, reason = 'cloud_canonical_merge', withinTransaction = false } = {}) {
      const aliasId = String(aliasDocumentId || '').trim();
      const canonicalId = String(canonicalDocumentId || '').trim();
      if (!userId || !aliasId || !canonicalId) throw new Error('Canonical Memory document mapping is incomplete.');
      if (aliasId === canonicalId) return this.getMemoryDocument(canonicalId);
      const source = get(this.db, 'SELECT * FROM memory_documents WHERE id = ?', [aliasId]);
      const target = get(this.db, 'SELECT * FROM memory_documents WHERE id = ?', [canonicalId]);
      if (!withinTransaction) this.db.exec('BEGIN IMMEDIATE');
      try {
        if (source && source.user_id !== userId) throw new Error('Alias Memory document does not belong to the user.');
        if (target && target.user_id !== userId) throw new Error('Canonical Memory document does not belong to the user.');
        if (source && target) mergeMemoryDocumentRows(this.db, userId, source, target);
        else if (source) {
          run(this.db, 'UPDATE memory_documents SET id = ?, updated_at = ? WHERE id = ?', [canonicalId, nowIso(), aliasId]);
          run(this.db, 'UPDATE memory_document_versions SET memory_document_id = ? WHERE memory_document_id = ?', [canonicalId, aliasId]);
          run(this.db, 'UPDATE memory_entries SET memory_document_id = ? WHERE memory_document_id = ?', [canonicalId, aliasId]);
          run(this.db, 'UPDATE typed_memories SET memory_document_id = ? WHERE memory_document_id = ?', [canonicalId, aliasId]);
          rewriteLocalMemoryDocumentReferences(this.db, aliasId, canonicalId);
        }
        run(this.db, `INSERT INTO memory_document_aliases (alias_document_id, canonical_document_id, user_id, reason)
          VALUES (?, ?, ?, ?) ON CONFLICT(alias_document_id) DO UPDATE SET canonical_document_id = excluded.canonical_document_id, user_id = excluded.user_id, reason = excluded.reason`,
        [aliasId, canonicalId, userId, reason]);
        if (!withinTransaction) this.db.exec('COMMIT');
      } catch (error) {
        if (!withinTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
      return this.getMemoryDocument(canonicalId);
    },

    createScopedEvolutionRun({
      scope = 'legacy',
      userId = '',
      agentInstanceId = '',
      agentFamilyId = '',
      departmentId = '',
      hrId = '',
      cohortKey = '',
      algorithmVersion = 'identity_scaffold_v1',
      evidenceCursorFrom = '',
      evidenceCursorTo = '',
      consentSnapshot = {},
    } = {}) {
      const normalizedScope = ['legacy', 'personal', 'cluster'].includes(scope) ? scope : 'legacy';
      if (normalizedScope === 'personal' && (!userId || !agentInstanceId || !agentFamilyId)) {
        throw new Error('Personal evolution requires userId, agentInstanceId, and agentFamilyId.');
      }
      if (normalizedScope === 'personal') {
        const instance = this.getUserAgentInstance(agentInstanceId);
        if (!instance || instance.userId !== userId || instance.agentFamilyId !== agentFamilyId) {
          throw new Error('Personal evolution identity does not match the user Agent instance.');
        }
      }
      if (normalizedScope === 'cluster' && (!agentFamilyId || !cohortKey || userId || agentInstanceId)) {
        throw new Error('Cluster evolution requires agentFamilyId and cohortKey without a user instance.');
      }
      const id = newId('evo');
      run(
        this.db,
        `INSERT INTO evolution_runs (
          id, agent_id, agent_family_id, department_id, hr_id, evolution_scope,
          user_id, user_agent_instance_id, cohort_key, algorithm_version,
          evidence_cursor_from, evidence_cursor_to, consent_snapshot_json, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')`,
        [
          id, agentFamilyId, agentFamilyId, departmentId, hrId, normalizedScope,
          userId, agentInstanceId, cohortKey, algorithmVersion, evidenceCursorFrom, evidenceCursorTo, JSON.stringify(consentSnapshot || {}),
        ],
      );
      return id;
    },
  });
}

function normalizeAgentFamily(row) {
  if (!row) return null;
  return {
    id: row.id,
    departmentId: row.department_id,
    name: canonicalAgentFamilyName(row.id, row.name),
    role: row.role,
    status: row.status,
    routable: Boolean(row.routable),
    instanceKind: row.instance_kind || 'unavailable',
    recruitable: Boolean(row.recruitable),
    defaultForNewUser: Boolean(row.default_for_new_user),
    quotaCost: Number(row.quota_cost || 0),
    classificationVersion: row.classification_version || EMPLOYEE_POLICY_VERSION,
    currentVersionId: row.current_version_id || '',
    metadata: safeJson(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeAgentVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    agentFamilyId: row.agent_family_id,
    versionLabel: row.version_label,
    agentConfig: safeJson(row.agent_config_json),
    baseSkillContent: row.base_skill_content || '',
    baseSkillHash: row.base_skill_hash || '',
    memoryTemplateContent: row.memory_template_content || '',
    memoryTemplateHash: row.memory_template_hash || '',
    sourceBundleId: row.source_bundle_id || '',
    contentHash: row.content_hash || '',
    status: row.status,
    createdAt: row.created_at,
  };
}

function normalizeUserAgentInstance(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    agentFamilyId: row.agent_family_id,
    baseAgentVersionId: row.base_agent_version_id || '',
    activePersonalSkillVersionId: row.active_personal_skill_version_id || '',
    status: row.status,
    instanceKind: row.instance_kind || 'employee',
    employmentState: row.employment_state || (row.status === 'inactive' ? 'inactive' : 'active'),
    quotaExempt: Boolean(row.quota_exempt),
    recruitedAt: row.recruited_at || '',
    deactivatedAt: row.deactivated_at || '',
    lastStateChangedAt: row.last_state_changed_at || '',
    stateRevision: Number(row.state_revision || 0),
    recruitmentSource: row.recruitment_source || '',
    policyVersion: row.policy_version || EMPLOYEE_POLICY_VERSION,
    pendingTargetState: row.pending_target_state || '',
    authorityState: row.authority_state || 'local_confirmed',
    lastEmployeeCommandId: row.last_employee_command_id || '',
    syncEnabled: Boolean(row.sync_enabled),
    personalEvolutionConsent: Boolean(row.personal_evolution_consent),
    clusterContributionConsent: Boolean(row.cluster_contribution_consent),
    personalSkillAutoActivate: Boolean(row.personal_skill_auto_activate),
    familyInstanceSeq: Number(row.family_instance_seq || 0),
    displayName: row.display_name || '',
    note: row.note || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizePersonalSkillVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    userAgentInstanceId: row.user_agent_instance_id,
    agentFamilyId: row.agent_family_id || '',
    cloudKey: row.cloud_key || row.id,
    baseAgentVersionId: row.base_agent_version_id,
    parentVersionId: row.parent_version_id || '',
    overlayText: row.overlay_text || '',
    effectiveSkillContent: row.effective_skill_content || '',
    effectiveSkillHash: row.effective_skill_hash || '',
    compilerVersion: row.compiler_version || OVERLAY_COMPILER_VERSION,
    authority: row.authority || 'legacy_local',
    status: row.status,
    sourceEvolutionRunId: row.source_evolution_run_id || '',
    activatedAt: row.activated_at || '',
    archivedAt: row.archived_at || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

function normalizeMemoryDocument(row, store) {
  if (!row) return null;
  let content = row.current_content || '';
  let decryptionState = row.current_encryption_algorithm ? 'unavailable' : 'plaintext_legacy';
  if (row.current_encryption_algorithm) {
    try {
      content = store?.decryptMemoryVersionContent?.({
        memory_document_id: row.id,
        encryption_algorithm: row.current_encryption_algorithm,
        encryption_key_id: row.current_encryption_key_id,
        encryption_key_version: row.current_encryption_key_version,
        content_ciphertext: row.current_content_ciphertext,
        content_nonce: row.current_content_nonce,
        content_tag: row.current_content_tag,
        content_aad: row.current_content_aad,
      }) || '';
      decryptionState = 'decrypted';
    } catch {}
  }
  return {
    id: row.id,
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    userId: row.user_id,
    userAgentInstanceId: row.user_agent_instance_id,
    agentFamilyId: row.agent_family_id || '',
    cloudKey: row.cloud_key || row.id,
    scope: row.scope,
    slotNo: Number(row.slot_no || 0),
    displayName: row.display_name,
    taskRunId: row.task_run_id || '',
    projectId: row.project_id || '',
    relationshipId: row.relationship_id || '',
    relationshipUserId: row.relationship_user_id || '',
    delegationId: row.delegation_id || '',
    groupId: row.group_id || '',
    contextSpaceId: row.context_space_id || '',
    workScopeId: row.work_scope_id || '',
    lifecycleState: row.lifecycle_state,
    visibility: row.visibility,
    syncEnabled: Boolean(row.sync_enabled),
    allowPersonalEvolution: Boolean(row.allow_personal_evolution),
    allowClusterEvolution: Boolean(row.allow_cluster_evolution),
    currentVersionId: row.current_version_id || '',
    contentHash: row.content_hash || '',
    content,
    decryptionState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeMemoryVisibility(value) {
  const visibility = String(value || 'agent_private').trim().toLowerCase();
  if (visibility === 'private') return 'agent_private';
  if (!['agent_private', 'work_collaborators', 'work_leadership', 'work_participants', 'work_summary', 'owner_private'].includes(visibility)) {
    throw new Error(`Unsupported Memory visibility: ${visibility}`);
  }
  return visibility;
}

function safeJson(value) {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function localPrincipalUsers(db) {
  const activeUserId = get(db, "SELECT value FROM app_settings WHERE key = 'auth:active_user_id'")?.value || '';
  return all(db, `SELECT DISTINCT u.id FROM auth_users u
    WHERE u.auth_provider = 'local_mock'
      OR u.id = ?
      OR EXISTS (SELECT 1 FROM user_agent_instances i WHERE i.user_id = u.id)
      OR EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id)
      OR EXISTS (SELECT 1 FROM projects p WHERE p.user_id = u.id)
    ORDER BY u.created_at ASC`, [activeUserId]);
}

function consolidateLegacyPptIdentities(db, pptVersionId = '') {
  if (!get(db, "SELECT id FROM agent_families WHERE id = 'ppt'")) return;
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
  try {
  const placeholders = LEGACY_PPT_AGENT_IDS.map(() => '?').join(',');
  const now = nowIso();
  const legacySessions = all(db, `SELECT id,user_id,agent_id FROM sessions WHERE agent_id IN (${placeholders})`, LEGACY_PPT_AGENT_IDS);
  for (const session of legacySessions) persistLegacyPptSessionStyle(db, session);

  const users = all(db, `SELECT DISTINCT user_id FROM user_agent_instances
    WHERE agent_family_id IN (${placeholders}) ORDER BY user_id`, LEGACY_PPT_AGENT_IDS);
  for (const { user_id: userId } of users) {
    const sources = all(db, `SELECT * FROM user_agent_instances WHERE user_id=?
      AND agent_family_id IN (${placeholders})
      ORDER BY CASE WHEN employment_state='active' THEN 0 WHEN employment_state='pending_cloud_confirmation' THEN 1 ELSE 2 END,
        updated_at DESC,created_at DESC,id DESC`, [userId, ...LEGACY_PPT_AGENT_IDS]);
    if (!sources.length) continue;
    let canonical = get(db, "SELECT * FROM user_agent_instances WHERE user_id=? AND agent_family_id='ppt'", [userId]);
    const sourceActive = sources.some((item) => item.employment_state === 'active' && item.status === 'active');
    const sourcePending = sources.find((item) => item.employment_state === 'pending_cloud_confirmation' && item.pending_target_state === 'active');
    const personalEvolutionConsent = Number(canonical?.personal_evolution_consent || 0) || sources.some((item) => Number(item.personal_evolution_consent || 0));
    const clusterContributionConsent = Number(canonical?.cluster_contribution_consent || 0) || sources.some((item) => Number(item.cluster_contribution_consent || 0));
    if (!canonical) {
      canonical = sources.shift();
      run(db, `UPDATE user_agent_skill_versions SET status='archived',activated_at='',
        archived_at=CASE WHEN archived_at='' THEN ? ELSE archived_at END,updated_at=? WHERE user_agent_instance_id=?`, [now, now, canonical.id]);
      run(db, `UPDATE user_agent_instances SET agent_family_id='ppt',base_agent_version_id=?,
        active_personal_skill_version_id='',updated_at=? WHERE id=?`, [pptVersionId, now, canonical.id]);
      canonical = get(db, 'SELECT * FROM user_agent_instances WHERE id=?', [canonical.id]);
    }

    for (const source of sources) {
      if (!source || source.id === canonical.id) continue;
      run(db, `UPDATE sessions SET conversation_role='history',write_state='read_only',superseded_by_session_id='',
        codex_thread_id='',updated_at=? WHERE agent_instance_id=?`, [now, source.id]);
      run(db, `UPDATE user_agent_skill_versions SET status='archived',activated_at='',
        archived_at=CASE WHEN archived_at='' THEN ? ELSE archived_at END,updated_at=? WHERE user_agent_instance_id=?`, [now, now, source.id]);
      run(db, `INSERT INTO user_agent_instance_aliases(alias_instance_id,canonical_instance_id,user_id,reason)
        VALUES(?,?,?,'ppt_agent_consolidation') ON CONFLICT(alias_instance_id) DO UPDATE SET
        canonical_instance_id=excluded.canonical_instance_id,user_id=excluded.user_id,reason=excluded.reason`, [source.id, canonical.id, userId]);
      rewriteAgentInstanceReferences(db, source.id, canonical.id, 'ppt');
      mergeInstanceMemoryDocuments(db, userId, source.id, canonical.id);
      run(db, 'UPDATE memory_document_versions SET published_by_agent_instance_id=? WHERE published_by_agent_instance_id=?', [canonical.id, source.id]);
      run(db, 'DELETE FROM user_agent_instances WHERE id=?', [source.id]);
    }

    if (sourceActive && canonical.employment_state !== 'active') {
      run(db, `UPDATE user_agent_instances SET status='active',employment_state='active',quota_exempt=0,
        pending_target_state='',authority_state='local_confirmed',deactivated_at='',state_revision=state_revision+1,
        personal_evolution_consent=?,cluster_contribution_consent=?,updated_at=? WHERE id=?`, [
        personalEvolutionConsent ? 1 : 0, clusterContributionConsent ? 1 : 0, now, canonical.id,
      ]);
    } else if (!sourceActive && sourcePending && canonical.employment_state !== 'active') {
      run(db, `UPDATE user_agent_instances SET status='active',employment_state='pending_cloud_confirmation',quota_exempt=0,
        pending_target_state='active',authority_state='pending',deactivated_at='',state_revision=state_revision+1,
        personal_evolution_consent=?,cluster_contribution_consent=?,updated_at=? WHERE id=?`, [
        personalEvolutionConsent ? 1 : 0, clusterContributionConsent ? 1 : 0, now, canonical.id,
      ]);
    }

    run(db, `UPDATE sessions SET agent_id='ppt',agent_instance_id=?,conversation_role='history',write_state='read_only',
      superseded_by_session_id='',codex_thread_id='',updated_at=?
      WHERE user_id=? AND agent_id IN (${placeholders}) AND agent_instance_id=''`, [canonical.id, now, userId, ...LEGACY_PPT_AGENT_IDS]);
    rewritePptFamilyReferences(db, canonical.id);
    reconcilePptPrimarySessions(db, userId, canonical.id);
    run(db, "UPDATE memory_documents SET agent_family_id='ppt',updated_at=? WHERE user_agent_instance_id=?", [now, canonical.id]);
    run(db, "UPDATE user_agent_instances SET base_agent_version_id=CASE WHEN base_agent_version_id='' THEN ? ELSE base_agent_version_id END,updated_at=? WHERE id=?", [pptVersionId, now, canonical.id]);
    reconcileActiveSkillVersion(db, canonical.id);
  }

  rewritePptFamilyReferences(db, '');
  run(db, `UPDATE agent_families SET status='retired',routable=0,instance_kind='unavailable',
    recruitable=0,default_for_new_user=0,quota_cost=0,updated_at=? WHERE id IN (${placeholders})`, [now, ...LEGACY_PPT_AGENT_IDS]);
    if (ownsTransaction) db.exec('COMMIT');
  } catch (error) {
    if (ownsTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function persistLegacyPptSessionStyle(db, session = {}) {
  const message = get(db, `SELECT id,metadata_json FROM messages WHERE session_id=?
    ORDER BY CASE WHEN role='user' THEN 0 ELSE 1 END,created_at DESC,id DESC LIMIT 1`, [session.id]);
  if (!message) return;
  const metadata = safeJson(message.metadata_json);
  if (!metadata.pptStyleId) metadata.pptStyleId = pptStyleForAgentId(session.agent_id);
  run(db, 'UPDATE messages SET metadata_json=? WHERE id=?', [JSON.stringify(metadata), message.id]);
}

function rewritePptFamilyReferences(db, canonicalInstanceId = '') {
  const placeholders = LEGACY_PPT_AGENT_IDS.map(() => '?').join(',');
  const now = nowIso();
  const canonical = canonicalInstanceId
    ? get(db, 'SELECT id,user_id FROM user_agent_instances WHERE id=? AND agent_family_id=?', [canonicalInstanceId, 'ppt'])
    : null;
  const definitions = [
    ['sessions', 'agent_id', 'agent_instance_id'],
    ['messages', 'agent_id', 'agent_instance_id'],
    ['model_executions', 'agent_id', 'agent_instance_id'],
    ['task_runs', 'lead_agent_id', 'lead_agent_instance_id'],
    ['task_nodes', 'agent_id', 'agent_instance_id'],
    ['memory_entries', 'agent_id', 'agent_instance_id'],
    ['typed_memories', 'agent_id', 'agent_instance_id'],
  ];
  for (const [table, familyColumn, instanceColumn] of definitions) {
    if (!tableHasColumns(db, table, familyColumn, instanceColumn)) continue;
    if (canonicalInstanceId && !canonical) continue;
    if (canonicalInstanceId && table === 'sessions' && tableHasColumns(db, table, 'user_id')) {
      run(db, `UPDATE ${table} SET ${familyColumn}='ppt'${tableHasColumns(db, table, 'updated_at') ? ',updated_at=?' : ''}
        WHERE ${instanceColumn}=? AND user_id=?`, [
        ...(tableHasColumns(db, table, 'updated_at') ? [now] : []),
        canonicalInstanceId,
        canonical.user_id,
      ]);
      continue;
    }
    // Identity-guarded tables must never observe a canonical family paired with
    // another user's still-legacy instance. Rewrite one canonical instance at a
    // time; the final pass is intentionally limited to unbound legacy rows.
    const where = canonicalInstanceId
      ? `${instanceColumn}=?`
      : `${familyColumn} IN (${placeholders}) AND (${instanceColumn}='' OR ${instanceColumn} IS NULL)`;
    run(db, `UPDATE ${table} SET ${familyColumn}='ppt'${tableHasColumns(db, table, 'updated_at') ? ',updated_at=?' : ''}
      WHERE ${where}`, [
      ...(tableHasColumns(db, table, 'updated_at') ? [now] : []),
      ...(canonicalInstanceId ? [canonicalInstanceId] : LEGACY_PPT_AGENT_IDS),
    ]);
  }
}

function reconcilePptPrimarySessions(db, userId, canonicalInstanceId) {
  const workspaces = all(db, `SELECT DISTINCT account_workspace_id FROM sessions
    WHERE user_id=? AND agent_instance_id=? AND status!='deleted'`, [userId, canonicalInstanceId]);
  for (const workspace of workspaces) {
    const workspaceId = workspace.account_workspace_id || 'workspace_personal';
    const sessions = all(db, `SELECT id FROM sessions WHERE user_id=? AND account_workspace_id=? AND agent_instance_id=? AND status!='deleted'
      ORDER BY updated_at DESC,created_at DESC,id DESC`, [userId, workspaceId, canonicalInstanceId]);
    if (!sessions.length) continue;
    const winner = sessions[0].id;
    const now = nowIso();
    run(db, `UPDATE sessions SET conversation_role='history',write_state='read_only',superseded_by_session_id=?,
      codex_thread_id='',updated_at=? WHERE user_id=? AND account_workspace_id=? AND agent_instance_id=? AND id<>?`,
    [winner, now, userId, workspaceId, canonicalInstanceId, winner]);
    run(db, `UPDATE sessions SET agent_id='ppt',conversation_role='primary',write_state='writable',
      superseded_by_session_id='',codex_thread_id='',updated_at=? WHERE id=?`, [now, winner]);
    if (tableHasColumns(db, 'agent_context_state', 'account_workspace_id', 'primary_session_id', 'user_agent_instance_id')) {
      run(db, `UPDATE agent_context_state SET primary_session_id=?,updated_at=?
        WHERE account_workspace_id=? AND user_agent_instance_id=?`, [winner, now, workspaceId, canonicalInstanceId]);
    }
    if (tableHasColumns(db, 'agent_device_context_state', 'account_workspace_id', 'primary_session_id', 'user_agent_instance_id')) {
      run(db, `UPDATE agent_device_context_state SET primary_session_id=?,updated_at=?
        WHERE account_workspace_id=? AND user_agent_instance_id=?`, [winner, now, workspaceId, canonicalInstanceId]);
    }
  }
}

function tableHasColumns(db, table, ...columns) {
  const available = new Set(all(db, `PRAGMA table_info(${table})`).map((row) => row.name));
  return columns.every((column) => available.has(column));
}

function creationModeAllowed(mode, family = {}) {
  if (mode === 'system_default') return family.instanceKind === AGENT_INSTANCE_KINDS.system;
  if (mode === 'employee_default') {
    return family.instanceKind === AGENT_INSTANCE_KINDS.employee && family.defaultForNewUser && family.recruitable;
  }
  if (mode === 'explicit_recruitment') {
    return family.instanceKind === AGENT_INSTANCE_KINDS.employee && family.recruitable;
  }
  return mode === 'legacy_backfill';
}

function rewriteAgentInstanceReferences(db, aliasId, canonicalId, canonicalFamilyId = '') {
  mergeWorkParticipantReferences(db, aliasId, canonicalId);
  mergeWorkspaceAgentBindingReferences(db, aliasId, canonicalId);
  mergeAgentWorkQueueReferences(db, aliasId, canonicalId);
  mergeAgentConversationWindowReferences(db, aliasId, canonicalId);
  for (const aliasContextState of all(db, 'SELECT * FROM agent_context_state WHERE user_agent_instance_id=?', [aliasId])) {
    const canonicalContextState = get(db, `SELECT 1 FROM agent_context_state
      WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [
      aliasContextState.user_id, aliasContextState.account_workspace_id || 'workspace_personal', canonicalId,
    ]);
    if (!canonicalContextState) {
      run(db, `UPDATE agent_context_state SET user_agent_instance_id=?,updated_at=?
        WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [
        canonicalId, nowIso(), aliasContextState.user_id, aliasContextState.account_workspace_id || 'workspace_personal', aliasId,
      ]);
    } else {
      run(db, `DELETE FROM agent_context_state WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [
        aliasContextState.user_id, aliasContextState.account_workspace_id || 'workspace_personal', aliasId,
      ]);
    }
  }
  for (const row of all(db, 'SELECT * FROM agent_device_context_state WHERE user_agent_instance_id=?', [aliasId])) {
    const workspaceId = row.account_workspace_id || 'workspace_personal';
    const target = get(db, `SELECT 1 FROM agent_device_context_state
      WHERE device_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [row.device_id, workspaceId, canonicalId]);
    if (target) run(db, `DELETE FROM agent_device_context_state
      WHERE device_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [row.device_id, workspaceId, aliasId]);
    else run(db, `UPDATE agent_device_context_state SET user_agent_instance_id=?,updated_at=?
      WHERE device_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [canonicalId, nowIso(), row.device_id, workspaceId, aliasId]);
  }
  mergeAgentContextSpaceReferences(db, aliasId, canonicalId, canonicalFamilyId);
  for (const [table, column] of [
    ['sessions', 'agent_instance_id'],
    ['messages', 'agent_instance_id'],
    ['conversations', 'agent_instance_id'],
    ['model_executions', 'agent_instance_id'],
    ['task_runs', 'lead_agent_instance_id'],
    ['task_nodes', 'agent_instance_id'],
    ['memory_entries', 'agent_instance_id'],
    ['typed_memories', 'agent_instance_id'],
    ['evolution_runs', 'user_agent_instance_id'],
    ['evolution_archives', 'user_agent_instance_id'],
    ['agent_performance_reviews', 'user_agent_instance_id'],
    ['skill_versions', 'user_agent_instance_id'],
    ['user_agent_recruitment_events', 'user_agent_instance_id'],
    ['agent_delivery_receipts', 'target_agent_instance_id'],
    ['cloud_stage8_projections', 'user_agent_instance_id'],
    ['leadership_assignments', 'agent_instance_id'],
    ['ubuddy_coordination_states', 'leader_agent_instance_id'],
    ['ubuddy_wake_outbox', 'leader_agent_instance_id'],
    ['work_memory_access_audits', 'requester_agent_instance_id'],
    ['work_memory_access_audits', 'target_agent_instance_id'],
  ]) {
    if (canonicalFamilyId && table === 'sessions') {
      run(db, `UPDATE sessions SET agent_instance_id=?,agent_id=? WHERE agent_instance_id=?`, [canonicalId, canonicalFamilyId, aliasId]);
    } else if (canonicalFamilyId && table === 'messages') {
      run(db, `UPDATE messages SET agent_instance_id=?,agent_id=? WHERE agent_instance_id=?`, [canonicalId, canonicalFamilyId, aliasId]);
    } else {
      run(db, `UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`, [canonicalId, aliasId]);
    }
  }
  run(db, 'UPDATE user_agent_skill_versions SET user_agent_instance_id = ?, updated_at = ? WHERE user_agent_instance_id = ?', [canonicalId, nowIso(), aliasId]);
  run(db, `UPDATE employee_command_outbox SET local_agent_instance_id = ?, proposed_instance_id = ?, updated_at = ?
    WHERE local_agent_instance_id = ? OR proposed_instance_id = ?`, [canonicalId, canonicalId, nowIso(), aliasId, aliasId]);
}

function mergeAgentConversationWindowReferences(db, aliasId, canonicalId) {
  const hasTable = (tableName) => Boolean(get(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [tableName]));
  if (hasTable('agent_conversation_branch_state')) {
    for (const source of all(db, 'SELECT * FROM agent_conversation_branch_state WHERE agent_instance_id=?', [aliasId])) {
      const target = get(db, `SELECT * FROM agent_conversation_branch_state
        WHERE user_id=? AND account_workspace_id=? AND agent_instance_id=?`, [
        source.user_id, source.account_workspace_id || 'workspace_personal', canonicalId,
      ]);
      if (!target) {
        run(db, `UPDATE agent_conversation_branch_state SET agent_instance_id=?,updated_at=?
          WHERE user_id=? AND account_workspace_id=? AND agent_instance_id=?`, [
          canonicalId, nowIso(), source.user_id, source.account_workspace_id || 'workspace_personal', aliasId,
        ]);
        continue;
      }
      run(db, `UPDATE agent_conversation_branch_state SET
        rebuild_required=MAX(rebuild_required,?),
        thread_generation=MAX(thread_generation,?),
        last_injected_timeline_sequence=MAX(last_injected_timeline_sequence,?),updated_at=MAX(updated_at,?)
        WHERE user_id=? AND account_workspace_id=? AND agent_instance_id=?`, [
        Number(source.rebuild_required || 0), Number(source.thread_generation || 1),
        Number(source.last_injected_timeline_sequence || 0), source.updated_at || nowIso(),
        source.user_id, source.account_workspace_id || 'workspace_personal', canonicalId,
      ]);
      run(db, `DELETE FROM agent_conversation_branch_state
        WHERE user_id=? AND account_workspace_id=? AND agent_instance_id=?`, [
        source.user_id, source.account_workspace_id || 'workspace_personal', aliasId,
      ]);
    }
  }
  if (hasTable('agent_conversation_thread_lineage')) {
    run(db, 'UPDATE agent_conversation_thread_lineage SET agent_instance_id=? WHERE agent_instance_id=?', [canonicalId, aliasId]);
  }
  if (hasTable('agent_conversation_timeline_refs')) {
    for (const source of all(db, 'SELECT * FROM agent_conversation_timeline_refs WHERE agent_instance_id=?', [aliasId])) {
      const existing = get(db, `SELECT sequence_no FROM agent_conversation_timeline_refs
        WHERE agent_instance_id=? AND source_kind=? AND source_id=?`, [canonicalId, source.source_kind, source.source_id]);
      if (existing) {
        run(db, 'DELETE FROM agent_conversation_timeline_refs WHERE sequence_no=?', [source.sequence_no]);
        continue;
      }
      const refId = `${source.source_kind}:${source.source_id}:${canonicalId}`;
      run(db, `UPDATE agent_conversation_timeline_refs SET ref_id=?,agent_instance_id=? WHERE sequence_no=?`, [
        refId, canonicalId, source.sequence_no,
      ]);
    }
  }
}

function repairAgentConversationBranchesForInstance(db, userId, agentInstanceId) {
  if (!get(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_conversation_branch_state'")) return;
  const primaries = all(db, `SELECT * FROM sessions WHERE user_id=? AND agent_instance_id=?
    AND conversation_role='primary' AND write_state='writable' AND status!='deleted'
    ORDER BY account_workspace_id,updated_at DESC,created_at DESC,id DESC`, [userId, agentInstanceId]);
  const activeWorkspaces = new Set();
  for (const session of primaries) {
    const workspaceId = session.account_workspace_id || 'workspace_personal';
    if (activeWorkspaces.has(workspaceId)) continue;
    activeWorkspaces.add(workspaceId);
    const conversationId = String(session.conversation_id || session.id);
    run(db, `INSERT OR IGNORE INTO conversations(
      id,account_workspace_id,conversation_kind,owner_user_id,title,agent_id,agent_instance_id,project_id,workspace_root,status,created_at,updated_at
    ) VALUES(?,?,'direct',?,?,?,?,?,?,'active',?,?)`, [
      conversationId, workspaceId, userId, session.title || 'Untitled', session.agent_id || '', agentInstanceId,
      session.project_id || '', session.workspace_root || '', session.created_at || nowIso(), session.updated_at || nowIso(),
    ]);
    run(db, `UPDATE sessions SET conversation_id=? WHERE id=? AND conversation_id!=?`, [conversationId, session.id, conversationId]);
    run(db, `INSERT INTO agent_conversation_branch_state(
      user_id,account_workspace_id,agent_instance_id,conversation_id,primary_session_id,thread_generation,rebuild_required,updated_at
    ) VALUES(?,?,?,?,?,1,1,?) ON CONFLICT(user_id,account_workspace_id,agent_instance_id) DO UPDATE SET
      conversation_id=excluded.conversation_id,primary_session_id=excluded.primary_session_id,
      rebuild_required=MAX(agent_conversation_branch_state.rebuild_required,1),updated_at=excluded.updated_at`, [
      userId, workspaceId, agentInstanceId, conversationId, session.id, nowIso(),
    ]);
  }
  for (const branch of all(db, `SELECT account_workspace_id FROM agent_conversation_branch_state
    WHERE user_id=? AND agent_instance_id=?`, [userId, agentInstanceId])) {
    if (activeWorkspaces.has(branch.account_workspace_id || 'workspace_personal')) continue;
    run(db, `DELETE FROM agent_conversation_branch_state
      WHERE user_id=? AND account_workspace_id=? AND agent_instance_id=?`, [
      userId, branch.account_workspace_id || 'workspace_personal', agentInstanceId,
    ]);
  }
}

function mergeAgentConversationSessionsForInstance(db, userId, agentInstanceId) {
  if (!get(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversations'")) return;
  const rows = all(db, `SELECT session.*,COALESCE(conversation.conversation_kind,'direct') AS conversation_kind
    FROM sessions session LEFT JOIN conversations conversation ON conversation.id=COALESCE(NULLIF(session.conversation_id,''),session.id)
    WHERE session.user_id=? AND session.agent_instance_id=? AND session.status!='deleted'
      AND session.department_id NOT IN ('agent_delegation','collaboration')
      AND COALESCE(conversation.conversation_kind,'direct')='direct'
    ORDER BY session.account_workspace_id,
      CASE WHEN session.conversation_role='primary' AND session.write_state='writable' THEN 0 ELSE 1 END,
      session.updated_at DESC,session.created_at DESC,session.id DESC`, [userId, agentInstanceId]);
  const byWorkspace = new Map();
  for (const row of rows) {
    const workspaceId = row.account_workspace_id || 'workspace_personal';
    byWorkspace.set(workspaceId, [...(byWorkspace.get(workspaceId) || []), row]);
  }
  for (const [workspaceId, sessions] of byWorkspace) {
    const winner = sessions[0];
    const canonicalConversationId = String(winner.conversation_id || winner.id);
    run(db, `INSERT OR IGNORE INTO conversations(
      id,account_workspace_id,conversation_kind,owner_user_id,title,agent_id,agent_instance_id,project_id,workspace_root,status,created_at,updated_at
    ) VALUES(?,?,'direct',?,?,?,?,?,?,'active',?,?)`, [
      canonicalConversationId, workspaceId, userId, winner.title || 'Untitled', winner.agent_id || '', agentInstanceId,
      winner.project_id || '', winner.workspace_root || '', winner.created_at || nowIso(), winner.updated_at || nowIso(),
    ]);
    for (const [index, session] of sessions.entries()) {
      const oldConversationId = String(session.conversation_id || session.id);
      if (session.codex_thread_id) {
        run(db, `INSERT INTO agent_conversation_thread_lineage(
          id,user_id,account_workspace_id,agent_instance_id,conversation_id,source_session_id,codex_thread_id,lineage_role,reason
        ) VALUES(?,?,?,?,?,?,?,?,'runtime_agent_identity_merge')
        ON CONFLICT(conversation_id,codex_thread_id) DO UPDATE SET source_session_id=excluded.source_session_id,
          lineage_role=excluded.lineage_role,reason=excluded.reason`, [
          `thread_lineage:${session.id}:${session.codex_thread_id}`, userId, workspaceId, agentInstanceId,
          canonicalConversationId, session.id, session.codex_thread_id, index === 0 ? 'winner' : 'merged',
        ]);
      }
      run(db, `UPDATE messages SET conversation_id=? WHERE session_id=? AND conversation_id=''`, [
        canonicalConversationId, session.id,
      ]);
      run(db, `UPDATE message_attachments SET conversation_id=? WHERE conversation_id='' AND message_id IN (
        SELECT id FROM messages WHERE session_id=?
      )`, [canonicalConversationId, session.id]);
      if (oldConversationId !== canonicalConversationId) {
        run(db, `UPDATE messages SET conversation_id=? WHERE conversation_id=? OR session_id=?`, [
          canonicalConversationId, oldConversationId, session.id,
        ]);
        run(db, `UPDATE message_attachments SET conversation_id=? WHERE conversation_id=? OR message_id IN (
          SELECT id FROM messages WHERE session_id=?
        )`, [canonicalConversationId, oldConversationId, session.id]);
        run(db, `UPDATE model_executions SET conversation_id=? WHERE conversation_id IN (?,?)`, [
          canonicalConversationId, oldConversationId, session.id,
        ]);
        run(db, `UPDATE cloud_file_refs SET session_id=? WHERE session_id IN (?,?)`, [canonicalConversationId, oldConversationId, session.id]);
        run(db, `UPDATE cloud_file_manifest SET session_id=? WHERE session_id IN (?,?)`, [canonicalConversationId, oldConversationId, session.id]);
        run(db, `UPDATE agent_conversation_timeline_refs SET source_conversation_id=?
          WHERE source_conversation_id IN (?,?)`, [canonicalConversationId, oldConversationId, session.id]);
        run(db, `UPDATE conversation_aliases SET conversation_id=? WHERE conversation_id=?`, [canonicalConversationId, oldConversationId]);
        run(db, `INSERT INTO conversation_aliases(alias_id,conversation_id,alias_kind,reason)
          VALUES(?,?,'agent_single_window','runtime_agent_identity_merge') ON CONFLICT(alias_id) DO UPDATE SET
          conversation_id=excluded.conversation_id,alias_kind=excluded.alias_kind,reason=excluded.reason`, [
          oldConversationId, canonicalConversationId,
        ]);
        run(db, `UPDATE conversations SET status='deleted',updated_at=MAX(updated_at,?) WHERE id=?`, [nowIso(), oldConversationId]);
      }
      if (session.id !== canonicalConversationId) {
        run(db, `INSERT INTO conversation_aliases(alias_id,conversation_id,alias_kind,reason)
          VALUES(?,?,'agent_single_window','runtime_agent_identity_merge') ON CONFLICT(alias_id) DO UPDATE SET
          conversation_id=excluded.conversation_id,alias_kind=excluded.alias_kind,reason=excluded.reason`, [
          session.id, canonicalConversationId,
        ]);
      }
      run(db, `UPDATE sessions SET conversation_id=?,conversation_role=?,write_state=?,superseded_by_session_id=?,
        codex_thread_id='',updated_at=MAX(updated_at,?) WHERE id=?`, [
        canonicalConversationId, index === 0 ? 'primary' : 'history', index === 0 ? 'writable' : 'read_only',
        index === 0 ? '' : winner.id, nowIso(), session.id,
      ]);
    }
    for (const table of ['agent_context_state', 'agent_device_context_state']) {
      if (!get(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [table])) continue;
      run(db, `UPDATE ${table} SET primary_session_id=?
        WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [
        winner.id, userId, workspaceId, agentInstanceId,
      ]);
    }
  }
}

function mergeWorkspaceAgentBindingReferences(db, aliasId, canonicalId) {
  const rows = all(db, 'SELECT * FROM workspace_agent_bindings WHERE agent_instance_id=? ORDER BY workspace_id', [aliasId]);
  for (const source of rows) {
    const target = get(db, `SELECT * FROM workspace_agent_bindings
      WHERE workspace_id=? AND agent_instance_id=?`, [source.workspace_id, canonicalId]);
    if (!target) {
      run(db, `UPDATE workspace_agent_bindings SET agent_instance_id=?,updated_at=?
        WHERE workspace_id=? AND agent_instance_id=?`, [canonicalId, nowIso(), source.workspace_id, aliasId]);
      continue;
    }
    run(db, `UPDATE workspace_agent_bindings SET
      visibility=CASE WHEN visibility='represented' OR ?='represented' THEN 'represented' ELSE 'private' END,
      can_receive_mentions=MAX(can_receive_mentions,?),can_receive_delegations=MAX(can_receive_delegations,?),
      can_read_workspace_files=MAX(can_read_workspace_files,?),can_write_workspace_memory=MAX(can_write_workspace_memory,?),
      status=CASE WHEN status='active' OR ?='active' THEN 'active' ELSE 'disabled' END,
      created_at=MIN(created_at,?),updated_at=MAX(updated_at,?)
      WHERE workspace_id=? AND agent_instance_id=?`, [
      source.visibility, Number(source.can_receive_mentions || 0), Number(source.can_receive_delegations || 0),
      Number(source.can_read_workspace_files || 0), Number(source.can_write_workspace_memory || 0), source.status,
      source.created_at || nowIso(), source.updated_at || nowIso(), source.workspace_id, canonicalId,
    ]);
    run(db, 'DELETE FROM workspace_agent_bindings WHERE workspace_id=? AND agent_instance_id=?', [source.workspace_id, aliasId]);
  }
}

function mergeAgentWorkQueueReferences(db, aliasId, canonicalId) {
  const running = all(db, `SELECT id,agent_instance_id,started_at,enqueued_at,sequence_no FROM agent_work_queue
    WHERE agent_instance_id IN (?,?) AND status='running'
    ORDER BY CASE WHEN started_at='' THEN 1 ELSE 0 END,started_at,enqueued_at,sequence_no,id`, [aliasId, canonicalId]);
  const winner = running[0]?.id || '';
  for (const row of running) {
    if (row.id === winner) continue;
    run(db, `UPDATE agent_work_queue SET status='queued',started_at='',completed_at='',
      error_text=CASE WHEN error_text='' THEN 'identity_merge_requeued' ELSE error_text END,updated_at=? WHERE id=?`, [nowIso(), row.id]);
  }
  run(db, 'UPDATE agent_work_queue SET agent_instance_id=?,updated_at=? WHERE agent_instance_id=?', [canonicalId, nowIso(), aliasId]);
}

function mergeAgentContextSpaceReferences(db, aliasId, canonicalId, canonicalFamilyId = '') {
  const canonical = get(db, 'SELECT user_id,agent_family_id FROM user_agent_instances WHERE id=?', [canonicalId]);
  if (!canonical) throw new Error('Canonical Agent instance is missing during Context merge.');
  const familyId = canonicalFamilyId || canonical.agent_family_id || '';
  run(db, 'UPDATE sessions SET agent_instance_id=?,agent_id=? WHERE agent_instance_id=? AND user_id=?', [
    canonicalId, familyId, aliasId, canonical.user_id,
  ]);
  const aliasContexts = all(db, 'SELECT * FROM agent_context_spaces WHERE user_agent_instance_id=? ORDER BY created_at,id', [aliasId]);
  for (const source of aliasContexts) {
    const incompatibleMessages = Number(get(db, `SELECT COUNT(*) count FROM messages WHERE context_space_id=?
      AND agent_instance_id!='' AND agent_instance_id NOT IN (?,?)`, [source.id, aliasId, canonicalId])?.count || 0);
    if (incompatibleMessages) throw new Error('message_context_agent_mismatch');
    const target = get(db, `SELECT * FROM agent_context_spaces WHERE id!=? AND user_id=? AND account_workspace_id=?
      AND user_agent_instance_id=? AND context_kind=? AND memory_document_id=? AND project_id=? AND task_run_id=?
      AND delegation_id=? AND group_id=? AND relationship_user_id=? AND legacy_session_id=? LIMIT 1`, [
      source.id, source.user_id, source.account_workspace_id || 'workspace_personal', canonicalId, source.context_kind,
      source.memory_document_id, source.project_id, source.task_run_id, source.delegation_id, source.group_id,
      source.relationship_user_id, source.legacy_session_id,
    ]);
    if (!target) {
      run(db, 'UPDATE agent_context_spaces SET user_agent_instance_id=?,updated_at=? WHERE id=?', [canonicalId, nowIso(), source.id]);
      run(db, `UPDATE messages SET
        agent_instance_id=CASE WHEN agent_instance_id='' THEN '' ELSE ? END,
        agent_id=CASE WHEN agent_instance_id='' THEN agent_id ELSE ? END WHERE context_space_id=?`, [
        canonicalId, familyId, source.id,
      ]);
      continue;
    }
    run(db, `UPDATE messages SET context_space_id='' WHERE context_space_id=? AND memory_id=''
      AND json_valid(metadata_json)
      AND json_type(metadata_json,'$.databaseRecovery.orphanedMemoryId') IS NOT NULL`, [source.id]);
    run(db, `UPDATE messages SET context_space_id=?,
      agent_instance_id=CASE WHEN agent_instance_id='' THEN '' ELSE ? END,
      agent_id=CASE WHEN agent_instance_id='' THEN agent_id ELSE ? END WHERE context_space_id=?`, [
      target.id, canonicalId, familyId, source.id,
    ]);
    run(db, 'UPDATE memory_documents SET context_space_id=? WHERE context_space_id=?', [target.id, source.id]);
    run(db, 'UPDATE agent_context_state SET active_context_space_id=? WHERE active_context_space_id=?', [target.id, source.id]);
    run(db, 'UPDATE agent_device_context_state SET active_context_space_id=? WHERE active_context_space_id=?', [target.id, source.id]);
    rebindChatContextStates(db, source.id, target.id);
    run(db, 'DELETE FROM agent_context_spaces WHERE id=?', [source.id]);
  }
}

function rebindChatContextStates(db, sourceContextId, targetContextId) {
  for (const source of all(db, 'SELECT * FROM chat_context_states WHERE context_space_id=? ORDER BY updated_at,id', [sourceContextId])) {
    const target = get(db, `SELECT * FROM chat_context_states
      WHERE owner_user_id=? AND session_id=? AND context_space_id=?`, [source.owner_user_id, source.session_id, targetContextId]);
    if (!target) {
      run(db, 'UPDATE chat_context_states SET context_space_id=?,updated_at=? WHERE id=?', [targetContextId, nowIso(), source.id]);
      continue;
    }
    const winner = String(source.updated_at || '').localeCompare(String(target.updated_at || '')) > 0 ? source : target;
    run(db, `UPDATE chat_context_states SET context_epoch=?,reset_after_message_id=?,reset_after_created_at=?,last_execution_id=?,
      last_input_tokens=?,context_window_tokens=?,provider_compaction_detected=?,state_revision=?,base_state_revision=?,
      last_command_id=?,source_device_id=?,sync_status=?,updated_at=? WHERE id=?`, [
      winner.context_epoch, winner.reset_after_message_id, winner.reset_after_created_at, winner.last_execution_id,
      winner.last_input_tokens, winner.context_window_tokens, winner.provider_compaction_detected,
      Math.max(Number(source.state_revision || 1), Number(target.state_revision || 1)), winner.base_state_revision,
      winner.last_command_id, winner.source_device_id, winner.sync_status, winner.updated_at || nowIso(), target.id,
    ]);
    run(db, 'DELETE FROM chat_context_states WHERE id=?', [source.id]);
  }
}

function mergeWorkParticipantReferences(db, aliasId, canonicalId) {
  const aliasRows = all(db, 'SELECT * FROM work_participants WHERE agent_instance_id=?', [aliasId]);
  for (const source of aliasRows) {
    const target = get(db, `SELECT * FROM work_participants WHERE work_scope_id=? AND agent_instance_id=?`, [source.work_scope_id, canonicalId]);
    if (!target) {
      run(db, 'UPDATE work_participants SET agent_instance_id=?,updated_at=? WHERE id=?', [canonicalId, nowIso(), source.id]);
      continue;
    }
    const edges = [...new Set([
      ...safeJsonArray(source.collaboration_edges_json),
      ...safeJsonArray(target.collaboration_edges_json),
    ].map((value) => value === aliasId ? canonicalId : value).filter((value) => value && value !== canonicalId))].sort();
    const leadershipRoles = new Set(['task_lead', 'team_lead', 'cross_team_lead']);
    const role = leadershipRoles.has(target.role) ? target.role : leadershipRoles.has(source.role) ? source.role : target.role || source.role;
    const active = source.status === 'active' || target.status === 'active';
    run(db, `UPDATE work_participants SET role=?,collaboration_edges_json=?,
      valid_from=MIN(valid_from,?),valid_until=?,status=?,updated_at=? WHERE id=?`, [
      role, JSON.stringify(edges), source.valid_from, active ? '' : [source.valid_until, target.valid_until].filter(Boolean).sort().at(-1) || '',
      active ? 'active' : 'removed', nowIso(), target.id,
    ]);
    run(db, 'DELETE FROM work_participants WHERE id=?', [source.id]);
  }
  for (const participant of all(db, 'SELECT id,collaboration_edges_json FROM work_participants')) {
    const edges = safeJsonArray(participant.collaboration_edges_json);
    if (!edges.includes(aliasId)) continue;
    run(db, 'UPDATE work_participants SET collaboration_edges_json=?,updated_at=? WHERE id=?', [
      JSON.stringify([...new Set(edges.map((value) => value === aliasId ? canonicalId : value))].sort()), nowIso(), participant.id,
    ]);
  }
}

function safeJsonArray(value) {
  const parsed = safeJson(value);
  return Array.isArray(parsed) ? parsed : [];
}

function mergeInstanceMemoryDocuments(db, userId, aliasId, canonicalId) {
  const aliasDocuments = all(db, 'SELECT * FROM memory_documents WHERE user_agent_instance_id = ? ORDER BY created_at, id', [aliasId]);
  for (const source of aliasDocuments) {
    const target = get(db, `SELECT * FROM memory_documents
      WHERE user_agent_instance_id = ? AND scope = ? AND slot_no = ?
        AND task_run_id = ? AND project_id = ? AND relationship_id = ?`,
    [canonicalId, source.scope, source.slot_no, source.task_run_id, source.project_id, source.relationship_id]);
    if (!target) {
      run(db, 'UPDATE memory_documents SET user_agent_instance_id = ?, updated_at = ? WHERE id = ?', [canonicalId, nowIso(), source.id]);
      continue;
    }
    mergeMemoryDocumentRows(db, userId, source, target);
  }
}

function mergeMemoryDocumentRows(db, userId, source, target) {
  const sourceVersions = all(db, 'SELECT * FROM memory_document_versions WHERE memory_document_id = ? ORDER BY created_at, id', [source.id]);
  let offset = 1000000 + Number(get(db, 'SELECT COALESCE(MAX(version_no), 0) AS value FROM memory_document_versions WHERE memory_document_id = ?', [target.id])?.value || 0);
  for (const version of sourceVersions) {
    offset += 1;
    run(db, `UPDATE memory_document_versions
      SET memory_document_id = ?, version_no = ?,
          origin_document_id = CASE WHEN origin_document_id = '' THEN ? ELSE origin_document_id END,
          origin_version_no = CASE WHEN origin_version_no = 0 THEN ? ELSE origin_version_no END
      WHERE id = ?`, [target.id, offset, source.id, version.version_no, version.id]);
  }
  resequenceMemoryDocumentVersions(db, target.id);
  const sourceWins = String(source.updated_at || '').localeCompare(String(target.updated_at || '')) > 0
    || (source.updated_at === target.updated_at && String(source.current_version_id || '').localeCompare(String(target.current_version_id || '')) > 0);
  const currentVersionId = sourceWins ? source.current_version_id : target.current_version_id;
  const currentVersion = get(db, 'SELECT content_hash FROM memory_document_versions WHERE id = ?', [currentVersionId]);
  run(db, `UPDATE memory_documents SET current_version_id = ?, content_hash = ?, updated_at = ? WHERE id = ?`, [
    currentVersionId,
    currentVersion?.content_hash || '',
    [source.updated_at, target.updated_at].filter(Boolean).sort().at(-1) || nowIso(),
    target.id,
  ]);
  run(db, 'UPDATE memory_entries SET memory_document_id = ? WHERE memory_document_id = ?', [target.id, source.id]);
  run(db, 'UPDATE typed_memories SET memory_document_id = ? WHERE memory_document_id = ?', [target.id, source.id]);
  rewriteLocalMemoryDocumentReferences(db, source.id, target.id);
  run(db, `INSERT INTO memory_document_aliases (alias_document_id, canonical_document_id, user_id, reason)
    VALUES (?, ?, ?, 'cloud_canonical_merge')
    ON CONFLICT(alias_document_id) DO UPDATE SET canonical_document_id = excluded.canonical_document_id, user_id = excluded.user_id`,
  [source.id, target.id, userId]);
  run(db, 'DELETE FROM memory_documents WHERE id = ?', [source.id]);
}

function rewriteLocalMemoryDocumentReferences(db, sourceId, targetId) {
  const sourceContext = get(db, `SELECT * FROM agent_context_spaces
    WHERE context_kind='general_memory' AND memory_document_id=? ORDER BY updated_at DESC LIMIT 1`, [sourceId]);
  const targetContext = get(db, `SELECT * FROM agent_context_spaces
    WHERE context_kind='general_memory' AND memory_document_id=? ORDER BY updated_at DESC LIMIT 1`, [targetId]);
  if (sourceContext && targetContext && sourceContext.id !== targetContext.id) {
    run(db, `UPDATE messages SET context_space_id='' WHERE context_space_id=? AND memory_id=''
      AND json_valid(metadata_json)
      AND json_type(metadata_json,'$.databaseRecovery.orphanedMemoryId') IS NOT NULL`, [sourceContext.id]);
    run(db, 'UPDATE messages SET context_space_id=? WHERE context_space_id=?', [targetContext.id,sourceContext.id]);
    run(db, 'UPDATE agent_device_context_state SET active_context_space_id=? WHERE active_context_space_id=?', [targetContext.id,sourceContext.id]);
    run(db, 'UPDATE agent_context_state SET active_context_space_id=?,updated_at=? WHERE active_context_space_id=?', [targetContext.id,nowIso(),sourceContext.id]);
    run(db, 'DELETE FROM agent_context_spaces WHERE id=?', [sourceContext.id]);
  } else {
    run(db, 'UPDATE agent_context_spaces SET memory_document_id=? WHERE memory_document_id=?', [targetId,sourceId]);
  }
  run(db, 'UPDATE agent_device_context_state SET active_memory_document_id=? WHERE active_memory_document_id=?', [targetId,sourceId]);
  run(db, 'UPDATE agent_context_state SET active_memory_document_id=?,updated_at=? WHERE active_memory_document_id=?', [targetId,nowIso(),sourceId]);
  run(db, 'UPDATE memory_access_audits SET memory_document_id=? WHERE memory_document_id=?', [targetId,sourceId]);
  const sourceMappings = all(db, 'SELECT * FROM memory_sync_mappings WHERE memory_document_id=?', [sourceId]);
  for (const mapping of sourceMappings) {
    const targetMapping = get(db, 'SELECT * FROM memory_sync_mappings WHERE device_id=? AND memory_document_id=?', [mapping.device_id,targetId]);
    if (targetMapping) run(db, 'DELETE FROM memory_sync_mappings WHERE device_id=? AND private_key=?', [mapping.device_id,mapping.private_key]);
    else run(db, 'UPDATE memory_sync_mappings SET memory_document_id=? WHERE device_id=? AND private_key=?', [targetId,mapping.device_id,mapping.private_key]);
  }
}

function reconcileActiveSkillVersion(db, agentInstanceId) {
  const versions = all(db, `SELECT * FROM user_agent_skill_versions
    WHERE user_agent_instance_id = ? ORDER BY activated_at DESC, updated_at DESC, id DESC`, [agentInstanceId]);
  const winner = versions.find((item) => item.activated_at);
  const now = nowIso();
  for (const version of versions) {
    if (!version.activated_at) continue;
    const status = winner?.id === version.id ? 'active' : 'archived';
    run(db, `UPDATE user_agent_skill_versions
      SET status = ?, archived_at = CASE WHEN ? = 'archived' AND archived_at = '' THEN ? WHEN ? = 'active' THEN '' ELSE archived_at END,
          updated_at = ? WHERE id = ?`, [status, status, now, status, now, version.id]);
  }
  run(db, 'UPDATE user_agent_instances SET active_personal_skill_version_id = ?, updated_at = ? WHERE id = ?', [winner?.id || '', now, agentInstanceId]);
}
