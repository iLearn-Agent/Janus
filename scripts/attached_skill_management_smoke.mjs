import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';
import { writeCodexAgentHarness } from '../src/main/codexAgentHarness.js';
import { discoverAttachedSkills } from '../src/main/modules/skills/index.js';
import { buildAgentCapabilityCatalog, renderUBuddyCapabilityCatalogPrompt } from '../src/main/modules/orchestration/index.js';

const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-attached-skills-'));
const root = path.join(sandboxRoot, 'runtime');
const source = path.join(sandboxRoot, 'source');
const codexHome = path.join(root, 'codex-home');
fs.mkdirSync(path.join(source, 'research', 'references'), { recursive: true });
fs.mkdirSync(path.join(source, 'delivery', 'scripts'), { recursive: true });
fs.writeFileSync(path.join(source, 'research', 'SKILL.md'), `---
name: evidence-research
description: Research claims and preserve evidence references.
display_name_en: Evidence Research
display_name_zh_cn: 证据研究
description_en: Research claims and preserve evidence references.
description_zh_cn: 研究主张并保留证据引用。
---

# Evidence research
Use references for evidence-led research.
`);
fs.writeFileSync(path.join(source, 'research', 'references', 'method.md'), 'method-v1\n');
fs.writeFileSync(path.join(source, 'delivery', 'SKILL.md'), `---
name: concise-delivery
description: Produce concise delivery notes with validation evidence.
---

# Concise delivery
Validate before reporting completion.
`);
fs.writeFileSync(path.join(source, 'delivery', 'scripts', 'verify.js'), 'console.log("verified");\n');

let runtime;
const catalogChangeEvents = [];
try {
  runtime = await createRuntime({
    root, isDev: true, serverAuthoritativeSkills: true,
    onAttachedSkillCatalogChanged: (event) => catalogChangeEvents.push(event),
  });
  const user = runtime.auth.requireUser();
  const employee = runtime.store.activeEmployeeAgentsForUser({ userId: user.id })[0];
  assert.ok(employee?.id && employee.agentFamilyId, 'default employee is required');
  const agent = runtime.org.agent(employee.agentFamilyId);

  const imported = await runtime.importAttachedSkillPackage({ source });
  assert.equal(imported.ok, true);
  assert.equal(imported.package.skills.filter((skill) => skill.status === 'ready').length, 2);
  const research = imported.package.skills.find((skill) => skill.name === 'evidence-research');
  const delivery = imported.package.skills.find((skill) => skill.name === 'concise-delivery');
  assert.ok(research?.id && delivery?.id);
  assert.equal(research.displayNameEn, 'Evidence Research');
  assert.equal(research.displayNameZhCn, '证据研究');
  assert.equal(research.descriptionZhCn, '研究主张并保留证据引用。');
  assert.equal(catalogChangeEvents.at(-1)?.reason, 'import');
  assert.equal(catalogChangeEvents.at(-1)?.catalog.skills.find((skill) => skill.id === research.id)?.descriptionEn,
    'Research claims and preserve evidence references.');

  const firstPackageId = imported.package.id;
  const firstResearchId = research.id;
  const firstHash = imported.package.contentHash;
  fs.writeFileSync(path.join(source, 'research', 'references', 'method.md'), 'method-v2\n');
  const updated = await runtime.importAttachedSkillPackage({ source });
  assert.equal(updated.package.id, firstPackageId, 'source update must preserve package identity');
  assert.equal(updated.package.skills.find((skill) => skill.name === 'evidence-research')?.id, firstResearchId,
    'source update must preserve Skill identity and assignments');
  assert.notEqual(updated.package.contentHash, firstHash, 'auxiliary file changes must update package hash');

  runtime.assignAttachedSkill({ skillId: research.id, scopeType: 'agent_family', scopeId: employee.agentFamilyId, enabled: true });
  runtime.assignAttachedSkill({ skillId: delivery.id, scopeType: 'department', scopeId: agent.departmentId, enabled: true });
  let effective = runtime.effectiveAttachedSkills({ agentInstanceId: employee.id });
  assert.deepEqual(new Set(effective.skills.map((skill) => skill.name)), new Set(['evidence-research', 'concise-delivery']));
  assert.match(effective.attachedSkillHash, /^[a-f0-9]{64}$/);

  runtime.assignAttachedSkill({ skillId: research.id, scopeType: 'agent_instance', scopeId: employee.id, enabled: false });
  effective = runtime.effectiveAttachedSkills({ agentInstanceId: employee.id });
  assert.deepEqual(effective.skills.map((skill) => skill.name), ['concise-delivery'], 'instance disable must override inheritance');
  runtime.removeAttachedSkillAssignment({ skillId: research.id, scopeType: 'agent_instance', scopeId: employee.id });
  assert.ok(catalogChangeEvents.some((event) => event.reason === 'assign' && event.skillId === research.id));
  assert.ok(catalogChangeEvents.some((event) => event.reason === 'unassign' && event.skillId === research.id));
  effective = runtime.effectiveAttachedSkills({ agentInstanceId: employee.id });
  assert.ok(effective.skills.some((skill) => skill.name === 'evidence-research'));
  const capabilityCatalog = buildAgentCapabilityCatalog({ store: runtime.store, org: runtime.org, userId: user.id });
  const employeeCapability = capabilityCatalog.entries.find((entry) => entry.agentInstanceId === employee.id);
  assert.ok(employeeCapability.capabilities.includes('evidence-research'));
  assert.match(renderUBuddyCapabilityCatalogPrompt(capabilityCatalog), /Research claims and preserve evidence references/);

  const hypotheticalNewEmployee = runtime.store.resolveAttachedSkills({
    ownerUserId: user.id,
    departmentId: agent.departmentId,
    agentFamilyId: employee.agentFamilyId,
    agentInstanceId: 'new_employee_without_copied_assignment',
  });
  assert.deepEqual(new Set(hypotheticalNewEmployee.map((skill) => skill.name)), new Set(['evidence-research', 'concise-delivery']),
    'new employees must inherit department and family assignments without copied rows');

  const userSkillRoot = path.join(codexHome, 'skills', 'user-owned-skill');
  fs.mkdirSync(userSkillRoot, { recursive: true });
  fs.writeFileSync(path.join(userSkillRoot, 'SKILL.md'), '# user owned\n');
  writeCodexAgentHarness(root, codexHome, { attachedSkills: effective.skills, targetAgentId: employee.agentFamilyId });
  assert.ok(fs.existsSync(path.join(userSkillRoot, 'SKILL.md')), 'Harness must preserve unknown user Skill directories');
  const toml = fs.readFileSync(path.join(codexHome, 'agents', `${employee.agentFamilyId}.toml`), 'utf8');
  assert.ok((toml.match(/\[\[skills\.config\]\]/g) || []).length >= 3, 'target Agent must receive core and attached Skills');
  assert.ok(fs.existsSync(path.join(codexHome, 'skills', `attached-${research.id}`, 'references', 'method.md')));

  const invalid = path.join(root, 'invalid');
  fs.mkdirSync(invalid);
  fs.writeFileSync(path.join(invalid, 'SKILL.md'), '# missing frontmatter\n');
  await assert.rejects(discoverAttachedSkills(invalid), (error) => error.code === 'attached_skill_frontmatter_required');
  const symlinkSource = path.join(root, 'symlink-source');
  fs.mkdirSync(symlinkSource);
  fs.symlinkSync(source, path.join(symlinkSource, 'escaped'));
  await assert.rejects(discoverAttachedSkills(symlinkSource), (error) => error.code === 'attached_skill_symlink_forbidden');
  const rootSymlink = path.join(sandboxRoot, 'source-link');
  fs.symlinkSync(source, rootSymlink);
  await assert.rejects(runtime.importAttachedSkillPackage({ source: rootSymlink }), (error) => error.code === 'attached_skill_symlink_forbidden');
  await assert.rejects(runtime.importAttachedSkillPackage({ source: root }), (error) => error.code === 'attached_skill_managed_path_forbidden');

  const integrity = runtime.db.prepare('PRAGMA integrity_check').get()?.integrity_check;
  assert.equal(integrity, 'ok');
  assert.deepEqual(runtime.db.prepare('PRAGMA foreign_key_check').all(), []);
  await runtime.close();
  runtime = await createRuntime({
    root, isDev: true, serverAuthoritativeSkills: true,
    onAttachedSkillCatalogChanged: (event) => catalogChangeEvents.push(event),
  });
  const reopened = runtime.effectiveAttachedSkills({ agentInstanceId: employee.id });
  assert.deepEqual(new Set(reopened.skills.map((skill) => skill.name)), new Set(['evidence-research', 'concise-delivery']));
  assert.equal(runtime.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id='attached_skill_registry_v1'").get()?.count, 1);
  assert.equal(runtime.db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  runtime.disableAttachedSkillPackage({ packageId: firstPackageId });
  assert.equal(catalogChangeEvents.at(-1)?.reason, 'disable_package');
  console.log(JSON.stringify({
    ok: true,
    checks: ['multi_skill_import', 'stable_update_identity', 'auxiliary_content_hash', 'department_inheritance',
      'family_inheritance', 'instance_override', 'new_employee_inheritance', 'codex_multi_skill_config',
      'preserve_user_skills', 'invalid_frontmatter', 'symlink_rejection', 'root_symlink_rejection', 'managed_path_rejection', 'database_integrity',
      'ubuddy_capability_discovery', 'second_open_idempotence', 'assignment_persistence', 'catalog_change_events',
      'localized_metadata'],
  }));
} finally {
  await runtime?.close?.();
  fs.rmSync(sandboxRoot, { recursive: true, force: true });
}
