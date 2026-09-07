import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { composePptStyleSkill, pptSkillStatus, resolvePptStyleSkill } from '../src/main/skills.js';
import { managedPythonSitePackages, pythonEnvironment } from '../src/main/python.js';
import { setSkillPackageInstalled, skillPackageInstallRoot } from '../src/shared/skillPackages.js';
import { sha256Text } from '../src/main/utils.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-ppt-style-skill-smoke-'));

try {
  const packageRoot = skillPackageInstallRoot(root, 'ppt_creation');
  fs.cpSync(path.join(process.cwd(), 'assets', 'skills', 'ppt_creation'), packageRoot, { recursive: true });
  setSkillPackageInstalled(root, 'ppt_creation', true, { source: 'smoke', version: 'style-split-v1' });

  const status = pptSkillStatus(root);
  assert.equal(status.installed, true);
  assert.deepEqual(status.skillFiles.map((item) => item.id), [
    'ppt',
    'ppt-style-general',
    'ppt-style-academic-report',
    'ppt-style-major-project',
  ]);
  assert.ok(status.skillFiles.every((item) => item.available && item.installed));
  const managedPythonSite = managedPythonSitePackages(root);
  const externalPythonEnv = pythonEnvironment({}, { root, packaged: false });
  assert.equal(externalPythonEnv.PYTHONNOUSERSITE, undefined);
  assert.equal(externalPythonEnv.PYTHONPATH.split(path.delimiter)[0], managedPythonSite);
  const packagedPythonEnv = pythonEnvironment({}, { root, packaged: true });
  assert.equal(packagedPythonEnv.PYTHONNOUSERSITE, '1');
  assert.notEqual(packagedPythonEnv.PYTHONPATH?.split(path.delimiter)[0], managedPythonSite);
  assert.doesNotMatch(fs.readFileSync(new URL('../src/main/python.js', import.meta.url), 'utf8'), /pip',\s*'install',\s*'--user'/);

  const sourceDepartmentRoot = path.join(process.cwd(), 'assets', 'departments', 'ppt_department');
  const bundledDepartmentRoot = path.join(process.cwd(), 'assets', 'skills', 'ppt_creation', 'departments', 'ppt_department');
  const styleRegistry = JSON.parse(fs.readFileSync(path.join(sourceDepartmentRoot, 'styles', 'style_registry.json'), 'utf8'));
  const expectedRegistry = {
    general: ['ppt-general', 'agents/ppt/styles/ppt-general/SKILL.md'],
    academic_report: ['ppt-academic-report', 'agents/ppt/styles/ppt-academic-report/SKILL.md'],
    major_project: ['ppt-major-project', 'agents/ppt/styles/ppt-major-project/SKILL.md'],
  };
  for (const style of styleRegistry.styles || []) {
    const expected = expectedRegistry[style.id];
    if (!expected) continue;
    assert.equal(style.skill_name, expected[0]);
    assert.equal(style.skill_path, expected[1]);
    assert.equal(fs.existsSync(path.join(sourceDepartmentRoot, style.skill_path)), true);
    assert.equal(fs.existsSync(path.join(bundledDepartmentRoot, style.skill_path)), true);
    assert.equal(
      fs.readFileSync(path.join(sourceDepartmentRoot, style.skill_path), 'utf8'),
      fs.readFileSync(path.join(bundledDepartmentRoot, style.skill_path), 'utf8'),
      `${style.id} differs between the source department and bundled install package.`,
    );
  }
  assert.deepEqual(
    (styleRegistry.styles || []).map((style) => style.id).filter((id) => expectedRegistry[id]).sort(),
    Object.keys(expectedRegistry).sort(),
  );

  const baseSkill = fs.readFileSync(path.join(
    packageRoot, 'departments', 'ppt_department', 'agents', 'ppt', 'SKILL.md',
  ), 'utf8');
  assert.equal(
    baseSkill,
    fs.readFileSync(path.join(sourceDepartmentRoot, 'agents', 'ppt', 'SKILL.md'), 'utf8'),
    'The common PPT Skill differs between the source department and installed package.',
  );
  assert.doesNotMatch(baseSkill, /^## Style Profiles$/m);

  const effective = {};
  for (const styleId of ['general', 'academic_report', 'major_project']) {
    const resolved = resolvePptStyleSkill(root, styleId);
    assert.equal(resolved.styleId, styleId);
    assert.equal(resolved.source, 'installed');
    assert.equal(resolved.fallback, false);
    effective[styleId] = composePptStyleSkill(root, baseSkill, styleId);
    assert.match(effective[styleId], new RegExp(`Active PPT Style Skill: ${styleId}`));
    assert.ok(effective[styleId].length <= 20_000, `${styleId} effective Skill exceeds the dedicated PPT prompt budget.`);
  }

  assert.match(effective.general, /audience-led narrative/);
  assert.doesNotMatch(effective.general, /benchmark_metrics/);
  assert.match(effective.academic_report, /benchmark_metrics/);
  assert.match(effective.academic_report, /array-shaped `rows`/);
  assert.doesNotMatch(effective.academic_report, /project_target_map/);
  assert.match(effective.major_project, /project_target_map/);
  assert.match(effective.major_project, /Never invent bar values/);
  assert.doesNotMatch(effective.major_project, /method_loop/);
  assert.equal(new Set(Object.values(effective).map((value) => sha256Text(value))).size, 3);
  assert.match(composePptStyleSkill(root, baseSkill, 'unknown-style'), /Active PPT Style Skill: general/);

  const legacyBase = [
    '# Legacy PPT Skill',
    '',
    '## Style Profiles',
    '',
    '### `general`',
    '- legacy general profile',
    '',
    '### `major_project`',
    '- legacy project profile',
    '',
    '## Internal Research Role',
    '',
    '- preserve shared research behavior',
  ].join('\n');
  const migrated = composePptStyleSkill(root, legacyBase, 'academic_report');
  assert.doesNotMatch(migrated, /legacy general profile|legacy project profile/);
  assert.match(migrated, /preserve shared research behavior/);
  assert.match(migrated, /Active PPT Style Skill: academic_report/);

  const installedAcademic = path.join(
    packageRoot, 'departments', 'ppt_department', 'agents', 'ppt', 'styles', 'ppt-academic-report', 'SKILL.md',
  );
  fs.writeFileSync(installedAcademic, 'invalid installed style Skill\n', 'utf8');
  const recovered = resolvePptStyleSkill(root, 'academic_report');
  assert.equal(recovered.styleId, 'academic_report');
  assert.equal(recovered.source, 'bundled');
  assert.match(recovered.content, /^---\s*\nname: ppt-academic-report/m);

  console.log('ppt style Skill smoke passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
