import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';
import { parseAttachedSkillControlIntent } from '../src/main/attachedSkillIntent.js';
import { createPickerMentionEntity } from '../src/shared/contracts/mentions.js';

const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-attached-skill-host-'));
const root = path.join(sandboxRoot, 'runtime');
const source = path.join(sandboxRoot, 'skill source');
let runtime;
const catalogChangeEvents = [];

function autoApprove(runtimeRef, counter = null) {
  return (event) => {
    if (event.kind !== 'approval-request') return;
    if (counter) counter.count += 1;
    queueMicrotask(() => runtimeRef.resolveChatApproval({
      runId: event.runId, approvalId: event.approvalId, approved: true,
    }));
  };
}

try {
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), `---
name: controlled-install
description: Install through the Janus controlled registry.
display_name_en: Controlled Install
display_name_zh_cn: 受控安装
description_en: Install through the Janus controlled registry.
description_zh_cn: 通过 Janus 受控目录安装。
---

# Controlled install
Use the Janus registry.
`);

  assert.deepEqual(parseAttachedSkillControlIntent('安装 Skill owner/repository'), {
    action: 'install', source: 'owner/repository', sourceRevision: '', sourceType: 'github', originalSource: 'owner/repository',
  });
  assert.equal(parseAttachedSkillControlIntent('安装技能owner/repository')?.source, 'owner/repository');
  assert.equal(parseAttachedSkillControlIntent('写一个 Skill 安装方案'), null);
  assert.equal(parseAttachedSkillControlIntent('安装 Skill relative/path/extra'), null);
  assert.equal(parseAttachedSkillControlIntent(`安装 Skill ${source}`)?.source, source);

  runtime = await createRuntime({
    root, isDev: true, serverAuthoritativeSkills: true,
    onAttachedSkillCatalogChanged: (event) => catalogChangeEvents.push(event),
    getUiLanguage: () => 'zh-CN',
  });
  const user = runtime.currentUser();
  const generalInstance = runtime.store.findUserAgentInstance({ userId: user.id, agentFamilyId: 'general_agent' })
    || runtime.store.recruitUserAgent({
      userId: user.id, agentFamilyId: 'general_agent', commandId: 'attached-skill-host:recruit-general',
    }).instance;
  const approvals = { count: 0 };
  const agentResult = await runtime.sendChat({
    departmentId: 'general', agentId: 'general_agent', agentInstanceId: generalInstance.id,
    chatMode: 'agent', routePreference: 'explicit', message: `安装 Skill ${source}`,
    sandboxPermission: 'request-approval', onEvent: autoApprove(runtime, approvals),
  });
  assert.equal(approvals.count, 1);
  assert.equal(agentResult.uBuddyMode, 'attached_skill_control');
  assert.equal(agentResult.attachedSkillControl.status, 'installed');
  assert.equal(agentResult.attachedSkillControl.catalogVerified, true);
  assert.match(agentResult.answer, /已安装，但尚未分配/);
  assert.equal(agentResult.session.agentInstanceId, generalInstance.id);
  assert.equal(agentResult.attachedSkillCatalog.assignments.length, 0);
  assert.equal(agentResult.attachedSkillCatalog.skills[0]?.descriptionZhCn, '通过 Janus 受控目录安装。');
  assert.equal(catalogChangeEvents.at(-1)?.reason, 'chat_install');

  const unavailableSkillMention = createPickerMentionEntity({
    principalType: 'skill', skillId: agentResult.attachedSkillCatalog.skills[0].id,
    displayText: '@controlled-install', mentionId: 'mention-unassigned-skill',
  });
  await assert.rejects(runtime.sendChat({
    chatMode: 'agent', departmentId: 'general', agentId: 'general_agent', agentInstanceId: generalInstance.id,
    routePreference: 'explicit', message: '@controlled-install 请按 Skill 执行', mentions: [unavailableSkillMention],
    sandboxPermission: 'request-approval',
  }), (error) => error.code === 'attached_skill_mention_unavailable');

  const normalResult = await runtime.sendChat({
    chatMode: 'normal', message: `导入技能 ${source}`, sandboxPermission: 'request-approval',
    onEvent: autoApprove(runtime),
  });
  assert.equal(normalResult.attachedSkillControl.status, 'installed');
  assert.equal(normalResult.session.departmentId, 'general');
  assert.equal(normalResult.session.agentId, '');

  const privateResult = await runtime.sendChat({
    chatMode: 'private_assistant', departmentId: 'private_assistant', agentId: 'private_assistant',
    message: `安装 Skill ${source}`, sandboxPermission: 'request-approval', onEvent: autoApprove(runtime),
  });
  assert.equal(privateResult.attachedSkillControl.status, 'installed');
  assert.equal(privateResult.session.departmentId, 'private_assistant');

  const secretarySession = runtime.ensureSecretarySession();
  const secretaryResult = await runtime.secretaryChat({
    sessionId: secretarySession.id, message: `安装 Skill ${source}`, sandboxPermission: 'request-approval',
    onEvent: autoApprove(runtime),
  });
  assert.equal(secretaryResult.attachedSkillControl.status, 'installed');
  assert.equal(secretaryResult.uBuddyMode, 'attached_skill_control');

  const cancelled = await runtime.secretaryChat({
    sessionId: secretarySession.id, message: `安装 Skill ${source}`, sandboxPermission: 'request-approval',
    onEvent(event) {
      if (event.kind !== 'approval-request') return;
      queueMicrotask(() => runtime.resolveChatApproval({ runId: event.runId, approvalId: event.approvalId, approved: false }));
    },
  });
  assert.equal(cancelled.attachedSkillControl.status, 'cancelled');

  const planResult = await runtime.sendChat({
    sessionId: agentResult.session.id, departmentId: 'general', agentId: 'general_agent',
    agentInstanceId: generalInstance.id, chatMode: 'agent', routePreference: 'explicit', interactionMode: 'plan',
    message: `安装 Skill ${source}`, sandboxPermission: 'request-approval',
  });
  assert.equal(planResult.attachedSkillControl.status, 'read_only');
  assert.equal(planResult.attachedSkillControl.errorCode, 'plan_mode_read_only');
  assert.equal(runtime.attachedSkillCatalog().assignments.length, 0);
  assert.equal(runtime.activeRuns.size, 0);

  console.log(JSON.stringify({
    ok: true,
    checks: ['bounded_intent', 'agent_install', 'normal_install', 'private_install', 'ubuddy_install', 'approval',
      'cancellation', 'plan_read_only', 'installed_not_assigned', 'catalog_change_event', 'localized_metadata'],
  }));
} finally {
  await runtime?.close?.();
  fs.rmSync(sandboxRoot, { recursive: true, force: true });
}
