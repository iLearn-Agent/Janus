import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';
import { setSkillPackageInstalled } from '../src/shared/skillPackages.js';

async function verifyCloudCatalogCannotOverrideLocalSkillState({ serverAuthoritativeSkills, expectedRoutable }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `janus-ppt-cloud-catalog-${expectedRoutable ? 'installed' : 'missing'}-`));
  let runtime;
  try {
    runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills });
    const user = runtime.currentUser();
    const recruitablePpt = runtime.store.listRecruitableAgentFamilies({ userId: user.id })
      .find((item) => item.id === 'ppt');
    assert.equal(recruitablePpt?.canRecruit, expectedRoutable,
      'PPT recruitment must stay blocked until the device-local Skill is installed');
    assert.equal(recruitablePpt?.recruitmentCode, expectedRoutable ? 'recruit' : 'agent_skill_install_required');
    if (!expectedRoutable) {
      assert.throws(() => runtime.store.stagePendingEmployeeCommand({
        userId: user.id,
        remoteUserId: `remote_${user.id}`,
        action: 'recruit',
        agentFamilyId: 'ppt',
        commandId: 'ppt-cloud-catalog:blocked-recruitment',
      }), (error) => error?.code === 'agent_skill_install_required',
      'a stale UI or direct lifecycle command must not recruit PPT before Skill installation');

      const quotaBeforeInstall = runtime.store.getEmployeeQuota({ userId: user.id });
      assert.equal(quotaBeforeInstall.used, 1, 'the default Generalist must be the only used employee slot before PPT recruitment');
      const installedPackageRoot = path.join(root, 'skills', 'ppt_creation');
      fs.cpSync(path.join(process.cwd(), 'assets', 'skills', 'ppt_creation'), installedPackageRoot, { recursive: true });
      setSkillPackageInstalled(root, 'ppt_creation', true, { source: 'test', version: 'test' });
      runtime.refreshAgentIdentityCatalog();
      const pptAfterInstall = runtime.store.listRecruitableAgentFamilies({ userId: user.id })
        .find((item) => item.id === 'ppt');
      assert.equal(pptAfterInstall?.canRecruit, true,
        'installing the PPT Skill with only one used slot must restore the PPT hire action');
      assert.equal(pptAfterInstall?.recruitmentCode, 'recruit');
      assert.equal(runtime.store.getEmployeeQuota({ userId: user.id }).used, 1,
        'installing a Skill must not consume an employee slot before recruitment');

      fs.rmSync(installedPackageRoot, { recursive: true, force: true });
      setSkillPackageInstalled(root, 'ppt_creation', false, { source: 'test', version: 'test' });
      runtime.refreshAgentIdentityCatalog();
    }
    const recruitment = runtime.store.recruitUserAgent({
      userId: user.id,
      agentFamilyId: 'ppt',
      commandId: `ppt-cloud-catalog:${expectedRoutable ? 'installed' : 'missing'}`,
    });
    const remoteUserId = `remote_${user.id}`;
    runtime.db.prepare('UPDATE auth_users SET remote_id=?,remote_bound_at=? WHERE id=?')
      .run(remoteUserId, new Date().toISOString(), user.id);

    runtime.cloudSync.applyIdentitySnapshot({
      status: 'ok',
      data: {
        agentFamilies: [{
          id: 'ppt',
          departmentId: 'ppt_department',
          name: 'PPT Designer',
          role: 'agent',
          status: 'active',
          routable: !expectedRoutable,
          instanceKind: 'employee',
          recruitable: true,
          currentVersionId: runtime.store.getAgentFamily('ppt').currentVersionId,
        }],
        userAgentInstances: [{
          id: recruitment.instance.id,
          agentFamilyId: 'ppt',
          status: 'active',
          instanceKind: 'employee',
          employmentState: 'active',
          quotaExempt: false,
          stateRevision: recruitment.instance.stateRevision + 1,
          policyVersion: recruitment.instance.policyVersion,
          syncEnabled: true,
        }],
      },
    }, { remoteUserId });

    const family = runtime.store.getAgentFamily('ppt');
    const activePpt = runtime.store.activeEmployeeAgentsForUser({ userId: user.id })
      .find((item) => item.agentFamilyId === 'ppt');
    assert.equal(family.routable, expectedRoutable,
      'cloud Agent-family routing flags must be reconciled against the device-local PPT Skill state');
    assert.equal(Boolean(activePpt), expectedRoutable,
      'the recruited PPT employee must be executable exactly when its local Skill is installed');
    if (expectedRoutable) {
      assert.doesNotThrow(() => runtime.store.requireRoutableUserAgent({
        userId: user.id,
        agentInstanceId: recruitment.instance.id,
        agentFamilyId: 'ppt',
      }), 'an installed and recruited PPT employee must pass the execution preflight');
    } else {
      assert.throws(() => runtime.store.requireRoutableUserAgent({
        userId: user.id,
        agentInstanceId: recruitment.instance.id,
        agentFamilyId: 'ppt',
      }), (error) => error?.code === 'employee_not_active',
      'a recruited PPT employee without the local Skill must remain blocked');
    }
  } finally {
    runtime?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

await verifyCloudCatalogCannotOverrideLocalSkillState({ serverAuthoritativeSkills: true, expectedRoutable: true });
await verifyCloudCatalogCannotOverrideLocalSkillState({ serverAuthoritativeSkills: false, expectedRoutable: false });

process.stdout.write(`${JSON.stringify({ status: 'passed', scenarios: ['installed', 'missing'] })}\n`);
