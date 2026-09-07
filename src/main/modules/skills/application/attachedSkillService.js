import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sha256Text } from '../../../utils.js';
import { discoverAttachedSkills, importAttachedSkillPackage } from '../infrastructure/attachedSkillInstaller.js';

const SCOPE_TYPES = new Set(['department', 'agent_family', 'agent_instance']);

export function createAttachedSkillService({ root = '', store = null, auth = null, org = null, onCatalogChanged = null } = {}) {
  if (!root || !store || !auth || !org) throw new Error('Attached Skill service dependencies are required.');

  const currentUser = () => auth.requireUser();
  const inboxRoot = path.join(path.resolve(root), '.skill');
  let inboxWatcher = null;
  const inboxTimers = new Set();
  let inboxScanRunning = false;
  let inboxLastError = '';

  const effectiveForInstance = (user, agentInstanceId) => {
    const instance = ownedInstance(store, user.id, agentInstanceId);
    const family = store.getAgentFamily(instance.agentFamilyId) || org.agent(instance.agentFamilyId) || {};
    const departmentId = family.departmentId || org.agent(instance.agentFamilyId)?.departmentId || '';
    const skills = store.resolveAttachedSkills({
      ownerUserId: user.id,
      departmentId,
      agentFamilyId: instance.agentFamilyId,
      agentInstanceId: instance.id,
    });
    return {
      agentInstanceId: instance.id,
      agentFamilyId: instance.agentFamilyId,
      departmentId,
      skills,
      attachedSkillHash: attachedSkillSetHash(skills),
    };
  };

  const notifyAffectedInstances = (userId, scopeType, scopeId) => {
    const instances = store.listUserAgentInstances({ userId }).filter((instance) => {
      if (scopeType === 'agent_instance') return instance.id === scopeId;
      if (scopeType === 'agent_family') return instance.agentFamilyId === scopeId;
      const agent = org.agent(instance.agentFamilyId);
      const family = store.getAgentFamily(instance.agentFamilyId);
      return (agent?.departmentId || family?.departmentId || '') === scopeId;
    });
    for (const instance of instances) {
      store.notifyEffectiveSkillChanged?.({
        userId,
        agentInstanceId: instance.id,
        agentFamilyId: instance.agentFamilyId,
        reason: 'attached_skill_assignment_changed',
      });
    }
  };

  return {
    catalog() {
      const user = currentUser();
      const organization = org.list();
      const instances = store.listUserAgentInstances({ userId: user.id });
      const families = [...new Map(instances.map((instance) => {
        const agent = org.agent(instance.agentFamilyId);
        const family = store.getAgentFamily(instance.agentFamilyId);
        return [instance.agentFamilyId, {
          id: instance.agentFamilyId,
          name: agent?.name || family?.name || instance.agentFamilyId,
          departmentId: agent?.departmentId || family?.departmentId || '',
        }];
      })).values()];
      const departments = [...new Map([
        ...(organization.departments || []).map((item) => [item.id, { id: item.id, name: item.name || item.id }]),
        ...(organization.agents || []).filter((item) => item.departmentId).map((item) => [
          item.departmentId,
          { id: item.departmentId, name: org.department(item.departmentId)?.name || item.departmentId },
        ]),
      ]).values()];
      return {
        packages: store.listAttachedSkillPackages({ ownerUserId: user.id }),
        skills: store.listAttachedSkills({ ownerUserId: user.id }),
        assignments: store.listAttachedSkillAssignments({ ownerUserId: user.id }),
        inbox: { path: inboxRoot, watching: Boolean(inboxWatcher), lastError: inboxLastError },
        targets: {
          departments,
          agentFamilies: families,
          agentInstances: instances.map((item) => ({
            id: item.id,
            name: item.displayName || families.find((family) => family.id === item.agentFamilyId)?.name || item.agentFamilyId,
            agentFamilyId: item.agentFamilyId,
          })),
        },
      };
    },

    async importPackage({ source = '', sourceRevision = '', allowInboxSource = false } = {}) {
      const user = currentUser();
      const imported = await importAttachedSkillPackage({ root, ownerUserId: user.id, source, sourceRevision, allowInboxSource });
      const sameContent = store.attachedSkillPackageByContentHash?.({ ownerUserId: user.id, contentHash: imported.package.contentHash });
      if (sameContent) {
        await fs.promises.rm(imported.package.installRoot, { recursive: true, force: true }).catch(() => {});
        return { ok: true, package: sameContent, catalog: this.catalog(), alreadyInstalled: true, deduplicated: true };
      }
      const previousPackage = store.attachedSkillPackage(imported.package.id);
      let registered;
      try {
        store.db.exec('BEGIN IMMEDIATE');
        registered = store.registerAttachedSkillPackage(imported);
        if (!registered || registered.contentHash !== imported.package.contentHash
          || registered.skills.filter((skill) => skill.status === 'ready').length !== imported.skills.length) {
          throw serviceError('attached_skill_registration_verification_failed', 'Skill 文件已复制，但注册校验失败。');
        }
        store.db.exec('COMMIT');
      } catch (error) {
        if (store.db.isTransaction) store.db.exec('ROLLBACK');
        await rollbackImport(imported);
        throw error;
      }
      if (previousPackage?.installRoot && previousPackage.installRoot !== registered.installRoot) {
        await fs.promises.rm(previousPackage.installRoot, { recursive: true, force: true }).catch(() => {});
      }
      return { ok: true, package: registered, catalog: this.catalog() };
    },

    async createPackage({ name = '', description = '', body = '', displayNameEn = '', displayNameZhCn = '', descriptionEn = '', descriptionZhCn = '' } = {}) {
      const cleanName = String(name || '').trim();
      const cleanDescription = String(description || '').trim();
      const cleanBody = String(body || '').trim();
      if (!cleanName || !cleanDescription || !cleanBody) throw serviceError('attached_skill_creation_input_required', '创建 Skill 需要名称、用途说明和正文。');
      const stagingRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'janus-skill-'));
      try {
        const frontmatter = [
          '---',
          `name: ${cleanName}`,
          `description: ${cleanDescription}`,
          ...(displayNameEn ? [`display_name_en: ${String(displayNameEn).trim()}`] : []),
          ...(displayNameZhCn ? [`display_name_zh_cn: ${String(displayNameZhCn).trim()}`] : []),
          ...(descriptionEn ? [`description_en: ${String(descriptionEn).trim()}`] : []),
          ...(descriptionZhCn ? [`description_zh_cn: ${String(descriptionZhCn).trim()}`] : []),
          '---', '', cleanBody, '',
        ].join('\n');
        await fs.promises.writeFile(path.join(stagingRoot, 'SKILL.md'), frontmatter, 'utf8');
        return await this.importPackage({ source: stagingRoot });
      } finally {
        await fs.promises.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      }
    },

    inboxPath() {
      return inboxRoot;
    },

    async scanInbox() {
      if (inboxScanRunning) return { ok: false, skipped: true, catalog: this.catalog() };
      inboxScanRunning = true;
      try {
        await fs.promises.mkdir(inboxRoot, { recursive: true });
        const entries = await fs.promises.readdir(inboxRoot, { withFileTypes: true });
        const candidates = [];
        const rootHasSkill = await fs.promises.stat(path.join(inboxRoot, 'SKILL.md')).then((stat) => stat.isFile()).catch(() => false);
        if (rootHasSkill) candidates.push(inboxRoot);
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
          const candidate = path.join(inboxRoot, entry.name);
          const found = await discoverAttachedSkills(candidate).catch((error) => {
            inboxLastError = error?.message || String(error);
            return [];
          });
          if (found.length) candidates.push(candidate);
        }
        const imported = [];
        for (const source of [...new Set(candidates)]) {
          try {
            const result = await this.importPackage({ source, allowInboxSource: true });
            imported.push(result.package?.id || source);
          } catch (error) {
            inboxLastError = error?.message || String(error);
          }
        }
        if (imported.length) {
          inboxLastError = '';
          try {
            const user = currentUser();
            onCatalogChanged?.({ user, catalog: this.catalog(), reason: 'inbox_auto_import', packageId: imported[imported.length - 1] });
          } catch {}
        }
        return { ok: true, imported, catalog: this.catalog() };
      } finally {
        inboxScanRunning = false;
      }
    },

    startInboxWatcher() {
      if (inboxWatcher) return inboxRoot;
      try {
        fs.mkdirSync(inboxRoot, { recursive: true });
        inboxWatcher = fs.watch(inboxRoot, { persistent: false }, () => {
          for (const timer of inboxTimers) clearTimeout(timer);
          inboxTimers.clear();
          // Directory copies often emit only the parent-folder event on Linux,
          // before SKILL.md has finished copying. Retry the scan as the copy
          // settles so nested files do not require an application restart.
          for (const delay of [250, 1_500, 5_000]) {
            const timer = setTimeout(() => {
              inboxTimers.delete(timer);
              void this.scanInbox().catch(() => {});
            }, delay);
            timer.unref?.();
            inboxTimers.add(timer);
          }
        });
        inboxWatcher.on('error', () => { inboxWatcher = null; });
      } catch (error) {
        inboxLastError = error?.message || String(error);
      }
      return inboxRoot;
    },

    stopInboxWatcher() {
      for (const timer of inboxTimers) clearTimeout(timer);
      inboxTimers.clear();
      inboxWatcher?.close?.();
      inboxWatcher = null;
    },

    assign({ skillId = '', scopeType = '', scopeId = '', enabled = true } = {}) {
      const user = currentUser();
      validateScopeTarget({ store, org, userId: user.id, scopeType, scopeId });
      const assignment = store.setAttachedSkillAssignment({
        ownerUserId: user.id, skillId, scopeType, scopeId, enabled,
      });
      notifyAffectedInstances(user.id, scopeType, scopeId);
      return { ok: true, assignment, catalog: this.catalog() };
    },

    assignBatch({ skillIds = [], targets = [], enabled = true } = {}) {
      const user = currentUser();
      const ids = [...new Set((Array.isArray(skillIds) ? skillIds : []).map((id) => String(id || '').trim()).filter(Boolean))];
      const normalizedTargets = [...new Map((Array.isArray(targets) ? targets : []).map((target) => {
        const separator = String(target || '').indexOf(':');
        return [String(target || ''), separator > 0 ? { scopeType: String(target).slice(0, separator), scopeId: String(target).slice(separator + 1) } : null];
      }).filter(([, value]) => value)).values()];
      if (!ids.length || !normalizedTargets.length) throw serviceError('attached_skill_batch_input_required', '请选择至少一个 Skill 和一个分配目标。');
      for (const skillId of ids) {
        const skill = store.listAttachedSkills({ ownerUserId: user.id, includeDisabled: true }).find((item) => item.id === skillId);
        if (!skill) throw serviceError('attached_skill_not_found', 'Skill 不存在或不属于当前用户。');
      }
      for (const target of normalizedTargets) validateScopeTarget({ store, org, userId: user.id, ...target });
      const assignments = ids.flatMap((skillId) => normalizedTargets.map((target) => ({ skillId, ...target, enabled })));
      store.setAttachedSkillAssignmentsBatch({ ownerUserId: user.id, assignments });
      for (const target of normalizedTargets) notifyAffectedInstances(user.id, target.scopeType, target.scopeId);
      return { ok: true, count: assignments.length, catalog: this.catalog() };
    },

    unassign({ skillId = '', scopeType = '', scopeId = '' } = {}) {
      const user = currentUser();
      validateScopeTarget({ store, org, userId: user.id, scopeType, scopeId });
      store.removeAttachedSkillAssignment({ ownerUserId: user.id, skillId, scopeType, scopeId });
      notifyAffectedInstances(user.id, scopeType, scopeId);
      return { ok: true, catalog: this.catalog() };
    },

    effectiveForEmployee({ agentInstanceId = '' } = {}) {
      return effectiveForInstance(currentUser(), agentInstanceId);
    },

    disablePackage({ packageId = '' } = {}) {
      const user = currentUser();
      const pkg = store.attachedSkillPackage(packageId);
      if (!pkg || pkg.ownerUserId !== user.id) throw serviceError('attached_skill_package_not_found', 'Skill 包不存在。');
      store.disableAttachedSkillPackage({ ownerUserId: user.id, packageId });
      for (const instance of store.listUserAgentInstances({ userId: user.id })) {
        store.notifyEffectiveSkillChanged?.({
          userId: user.id,
          agentInstanceId: instance.id,
          agentFamilyId: instance.agentFamilyId,
          reason: 'attached_skill_package_disabled',
        });
      }
      return { ok: true, catalog: this.catalog() };
    },
  };
}

export function attachedSkillSetHash(skills = []) {
  return sha256Text((Array.isArray(skills) ? skills : []).map((skill) => (
    `${skill.id}:${skill.contentHash || ''}:${skill.assignmentHash || ''}`
  )).sort().join('|'));
}

async function rollbackImport(imported = {}) {
  const installRoot = imported.package?.installRoot || '';
  if (!installRoot || imported.alreadyInstalled) return;
  await fs.promises.rm(installRoot, { recursive: true, force: true }).catch(() => {});
}

function validateScopeTarget({ store, org, userId, scopeType, scopeId }) {
  const type = String(scopeType || '').trim();
  const id = String(scopeId || '').trim();
  if (!SCOPE_TYPES.has(type) || !id) throw serviceError('attached_skill_scope_invalid', 'Skill 分配范围无效。');
  if (type === 'department' && !org.department(id) && !(org.list().agents || []).some((agent) => agent.departmentId === id)) {
    throw serviceError('attached_skill_department_not_found', '部门不存在。');
  }
  if (type === 'agent_family' && !org.agent(id) && !store.getAgentFamily(id)) {
    throw serviceError('attached_skill_agent_family_not_found', 'Agent 类型不存在。');
  }
  if (type === 'agent_instance') ownedInstance(store, userId, id);
}

function ownedInstance(store, userId, agentInstanceId) {
  const instance = store.getUserAgentInstance(String(agentInstanceId || '').trim());
  if (!instance || instance.userId !== userId) throw serviceError('attached_skill_agent_instance_not_found', '员工不存在或不属于当前用户。');
  return instance;
}

function serviceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
