import path from 'node:path';

import { all, get, run } from '../../../db.js';
import { nowIso, safeJsonParse, sha256Text } from '../../../utils.js';

const SCOPE_TYPES = new Set(['department', 'agent_family', 'agent_instance']);

export function installAttachedSkillStoreMethods(prototype) {
  Object.assign(prototype, {
    registerAttachedSkillPackage({ package: pkg = {}, skills = [] } = {}) {
      if (!pkg.id || !pkg.ownerUserId || !pkg.installRoot || !pkg.contentHash) throw new Error('Invalid attached Skill package.');
      const ownsTransaction = !this.db.isTransaction;
      if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
      try {
        const now = nowIso();
        run(this.db, `INSERT INTO attached_skill_packages(
          id,owner_user_id,source_type,source_uri,source_revision,install_root,status,content_hash,metadata_json,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
          source_revision=excluded.source_revision,install_root=excluded.install_root,status=excluded.status,
          content_hash=excluded.content_hash,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`, [
          pkg.id, pkg.ownerUserId, pkg.sourceType || 'local', pkg.sourceUri || '', pkg.sourceRevision || '',
          pkg.installRoot, pkg.status || 'installed', pkg.contentHash, JSON.stringify(pkg.metadata || {}), now, now,
        ]);
        const activeIds = [];
        for (const skill of skills) {
          activeIds.push(skill.id);
          run(this.db, `INSERT INTO attached_skills(
            id,package_id,skill_key,name,description,relative_path,content_hash,status,metadata_json,created_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,description=excluded.description,relative_path=excluded.relative_path,
            content_hash=excluded.content_hash,status=excluded.status,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`, [
            skill.id, pkg.id, skill.skillKey, skill.name, skill.description || '', skill.relativePath,
            skill.contentHash, skill.status || 'ready', JSON.stringify(skill.metadata || {}), now, now,
          ]);
        }
        if (activeIds.length) {
          run(this.db, `UPDATE attached_skills SET status='disabled',updated_at=? WHERE package_id=? AND id NOT IN (${activeIds.map(() => '?').join(',')})`, [now, pkg.id, ...activeIds]);
        }
        if (ownsTransaction) this.db.exec('COMMIT');
        return this.attachedSkillPackage(pkg.id);
      } catch (error) {
        if (ownsTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
    },

    attachedSkillPackage(packageId = '') {
      const row = get(this.db, 'SELECT * FROM attached_skill_packages WHERE id=?', [packageId]);
      return normalizePackage(row, this);
    },

    attachedSkillPackageByContentHash({ ownerUserId = '', contentHash = '' } = {}) {
      if (!ownerUserId || !contentHash) return null;
      const row = get(this.db, `SELECT * FROM attached_skill_packages
        WHERE owner_user_id=? AND content_hash=? AND status='installed'
        ORDER BY updated_at DESC LIMIT 1`, [ownerUserId, contentHash]);
      return normalizePackage(row, this);
    },

    mergeAttachedSkillPackageInto({ ownerUserId = '', sourcePackageId = '', targetPackageId = '' } = {}) {
      if (!ownerUserId || !sourcePackageId || !targetPackageId || sourcePackageId === targetPackageId) return { ok: false };
      const sourceSkills = this.listAttachedSkills({ ownerUserId, packageId: sourcePackageId, includeDisabled: true });
      const targetSkills = this.listAttachedSkills({ ownerUserId, packageId: targetPackageId, includeDisabled: true });
      const targetByIdentity = new Map(targetSkills.map((skill) => [`${skill.skillKey}:${skill.contentHash}`, skill]));
      const now = nowIso();
      for (const sourceSkill of sourceSkills) {
        const targetSkill = targetByIdentity.get(`${sourceSkill.skillKey}:${sourceSkill.contentHash}`);
        if (!targetSkill) continue;
        const assignments = all(this.db, 'SELECT * FROM attached_skill_assignments WHERE owner_user_id=? AND skill_id=?', [ownerUserId, sourceSkill.id]);
        for (const assignment of assignments) {
          const id = `skillassign_${sha256Text(`${ownerUserId}\n${targetSkill.id}\n${assignment.scope_type}\n${assignment.scope_id}`).slice(0, 40)}`;
          run(this.db, `INSERT INTO attached_skill_assignments(id,owner_user_id,skill_id,scope_type,scope_id,enabled,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_user_id,skill_id,scope_type,scope_id) DO UPDATE SET
            enabled=MAX(attached_skill_assignments.enabled,excluded.enabled),updated_at=excluded.updated_at`, [
            id, ownerUserId, targetSkill.id, assignment.scope_type, assignment.scope_id, assignment.enabled, now, now,
          ]);
        }
      }
      run(this.db, "UPDATE attached_skill_packages SET status='disabled',updated_at=? WHERE id=? AND owner_user_id=?", [now, sourcePackageId, ownerUserId]);
      return { ok: true, package: this.attachedSkillPackage(targetPackageId) };
    },

    listAttachedSkillPackages({ ownerUserId = '', includeDisabled = false } = {}) {
      const where = ['owner_user_id=?'];
      if (!includeDisabled) where.push("status='installed'");
      return all(this.db, `SELECT * FROM attached_skill_packages WHERE ${where.join(' AND ')} ORDER BY updated_at DESC,id`, [ownerUserId])
        .map((row) => normalizePackage(row, this));
    },

    listAttachedSkills({ ownerUserId = '', packageId = '', includeDisabled = false } = {}) {
      const where = ['package.owner_user_id=?'];
      const params = [ownerUserId];
      if (packageId) { where.push('skill.package_id=?'); params.push(packageId); }
      if (!includeDisabled) where.push("skill.status='ready'", "package.status='installed'");
      return all(this.db, `SELECT skill.*,package.install_root,package.source_type,package.source_uri,package.source_revision
        FROM attached_skills skill JOIN attached_skill_packages package ON package.id=skill.package_id
        WHERE ${where.join(' AND ')} ORDER BY lower(skill.name),package.updated_at DESC,skill.id`).map(normalizeSkill);
    },

    setAttachedSkillAssignment({ ownerUserId = '', skillId = '', scopeType = '', scopeId = '', enabled = true } = {}) {
      if (!ownerUserId || !skillId || !scopeId || !SCOPE_TYPES.has(scopeType)) throw new Error('Invalid attached Skill assignment.');
      const skill = get(this.db, `SELECT skill.id FROM attached_skills skill JOIN attached_skill_packages package ON package.id=skill.package_id
        WHERE skill.id=? AND package.owner_user_id=?`, [skillId, ownerUserId]);
      if (!skill) throw new Error('Attached Skill not found.');
      const now = nowIso();
      const id = `skillassign_${sha256Text(`${ownerUserId}\n${skillId}\n${scopeType}\n${scopeId}`).slice(0, 40)}`;
      run(this.db, `INSERT INTO attached_skill_assignments(id,owner_user_id,skill_id,scope_type,scope_id,enabled,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_user_id,skill_id,scope_type,scope_id) DO UPDATE SET
        enabled=excluded.enabled,updated_at=excluded.updated_at`, [id, ownerUserId, skillId, scopeType, scopeId, enabled ? 1 : 0, now, now]);
      return normalizeAssignment(get(this.db, 'SELECT * FROM attached_skill_assignments WHERE id=?', [id]));
    },

    setAttachedSkillAssignmentsBatch({ ownerUserId = '', assignments = [] } = {}) {
      const items = Array.isArray(assignments) ? assignments : [];
      if (!ownerUserId || !items.length) throw new Error('At least one Skill assignment is required.');
      const ownsTransaction = !this.db.isTransaction;
      if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = [];
        for (const item of items) {
          result.push(this.setAttachedSkillAssignment({ ownerUserId, ...item }));
        }
        if (ownsTransaction) this.db.exec('COMMIT');
        return result;
      } catch (error) {
        if (ownsTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
    },

    removeAttachedSkillAssignment({ ownerUserId = '', skillId = '', scopeType = '', scopeId = '' } = {}) {
      run(this.db, `DELETE FROM attached_skill_assignments WHERE owner_user_id=? AND skill_id=? AND scope_type=? AND scope_id=?`, [ownerUserId, skillId, scopeType, scopeId]);
      return { ok: true };
    },

    listAttachedSkillAssignments({ ownerUserId = '', scopeType = '', scopeId = '' } = {}) {
      const where = ['assignment.owner_user_id=?'];
      const params = [ownerUserId];
      if (scopeType) { where.push('assignment.scope_type=?'); params.push(scopeType); }
      if (scopeId) { where.push('assignment.scope_id=?'); params.push(scopeId); }
      return all(this.db, `SELECT assignment.*,skill.name,skill.description,skill.relative_path,package.install_root
        FROM attached_skill_assignments assignment JOIN attached_skills skill ON skill.id=assignment.skill_id
        JOIN attached_skill_packages package ON package.id=skill.package_id WHERE ${where.join(' AND ')}
        ORDER BY assignment.scope_type,assignment.scope_id,lower(skill.name)`, params).map((row) => ({
          ...normalizeAssignment(row), name: row.name, description: row.description || '',
          skillPath: path.join(row.install_root, row.relative_path),
        }));
    },

    resolveAttachedSkills({ ownerUserId = '', departmentId = '', agentFamilyId = '', agentInstanceId = '' } = {}) {
      if (!ownerUserId) return [];
      const rows = this.listAttachedSkills({ ownerUserId });
      const assignments = this.listAttachedSkillAssignments({ ownerUserId });
      const relevant = assignments.filter((item) => (
        (item.scopeType === 'department' && item.scopeId === departmentId)
        || (item.scopeType === 'agent_family' && item.scopeId === agentFamilyId)
        || (item.scopeType === 'agent_instance' && item.scopeId === agentInstanceId)
      ));
      const instanceOverrides = new Map(relevant.filter((item) => item.scopeType === 'agent_instance').map((item) => [item.skillId, item.enabled]));
      return rows.filter((skill) => {
        if (instanceOverrides.has(skill.id)) return instanceOverrides.get(skill.id);
        return relevant.some((item) => item.skillId === skill.id && item.enabled);
      }).map((skill) => ({
        ...skill,
        assignmentHash: sha256Text(relevant.filter((item) => item.skillId === skill.id).map((item) => `${item.scopeType}:${item.scopeId}:${item.enabled}`).sort().join('|')),
      }));
    },

    disableAttachedSkillPackage({ ownerUserId = '', packageId = '' } = {}) {
      run(this.db, "UPDATE attached_skill_packages SET status='disabled',updated_at=? WHERE id=? AND owner_user_id=?", [nowIso(), packageId, ownerUserId]);
      return { ok: true };
    },
  });
}

function normalizePackage(row, store) {
  if (!row) return null;
  return {
    id: row.id, ownerUserId: row.owner_user_id, sourceType: row.source_type, sourceUri: row.source_uri,
    sourceRevision: row.source_revision, installRoot: row.install_root, status: row.status,
    contentHash: row.content_hash, metadata: safeJsonParse(row.metadata_json, {}), createdAt: row.created_at,
    updatedAt: row.updated_at, skills: store ? store.listAttachedSkills({ ownerUserId: row.owner_user_id, packageId: row.id, includeDisabled: true }) : [],
  };
}

function normalizeSkill(row) {
  if (!row) return null;
  const metadata = safeJsonParse(row.metadata_json, {});
  return {
    id: row.id, packageId: row.package_id, skillKey: row.skill_key, name: row.name,
    description: row.description || '', relativePath: row.relative_path, contentHash: row.content_hash,
    displayNameEn: metadata.displayNameEn || '', displayNameZhCn: metadata.displayNameZhCn || '',
    descriptionEn: metadata.descriptionEn || '', descriptionZhCn: metadata.descriptionZhCn || '',
    status: row.status, metadata, installRoot: row.install_root || '',
    skillPath: row.install_root ? path.join(row.install_root, row.relative_path) : '',
    sourceType: row.source_type || '', sourceUri: row.source_uri || '', sourceRevision: row.source_revision || '',
  };
}

function normalizeAssignment(row) {
  if (!row) return null;
  return {
    id: row.id, ownerUserId: row.owner_user_id, skillId: row.skill_id, scopeType: row.scope_type,
    scopeId: row.scope_id, enabled: Boolean(row.enabled), createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
