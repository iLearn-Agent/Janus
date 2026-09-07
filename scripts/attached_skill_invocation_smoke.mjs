import assert from 'node:assert/strict';
import fs from 'node:fs';

import { state } from '../src/renderer/app/state.js';
import { renderChat } from '../src/renderer/app/views/chatView.js';
import { createPickerMentionEntity, mentionPrincipalId, normalizeMentionEntities } from '../src/shared/contracts/mentions.js';

const skillMention = createPickerMentionEntity({
  principalType: 'skill',
  skillId: 'skill_evidence',
  displayText: '@Evidence Research',
  mentionId: 'mention-skill-evidence',
});
assert.equal(skillMention.principalType, 'skill');
assert.equal(skillMention.skillId, 'skill_evidence');
assert.equal(mentionPrincipalId(skillMention), 'skill_evidence');
assert.equal(normalizeMentionEntities([skillMention], { content: '@Evidence Research analyze this' }).length, 1);
assert.equal(normalizeMentionEntities([skillMention], { content: 'analyze this' }).length, 0);
assert.equal(normalizeMentionEntities([skillMention], { content: '@Evidence Research', allowedUserIds: [] }).length, 1);

Object.assign(state, {
  currentUser: { id: 'skill-user', name: 'Skill User' },
  currentTab: 'chat', homeMode: 'department', currentSessionId: 'skill-session',
  currentAgentId: 'general_agent', currentAgentInstanceId: 'general-instance', currentDepartmentId: 'general',
  currentChatKey: 'session:skill-session',
  sessions: [{ id: 'skill-session', departmentId: 'general', agentId: 'general_agent', agentInstanceId: 'general-instance', title: 'General' }],
  messages: [], projects: [], activeProjectId: '', workspaceRoot: '', workspaceDetached: false,
  employeeOverview: { roster: [{ id: 'general-instance', agentFamilyId: 'general_agent', status: 'active', name: 'General' }] },
  friendOverview: { friends: [], organizations: [] }, activeAccountWorkspace: { id: 'workspace_personal', kind: 'personal' },
  attachedSkillCatalog: {
    packages: [{ id: 'package-evidence' }],
    skills: [{
      id: 'skill_evidence', packageId: 'package-evidence', skillKey: 'evidence-research', name: 'evidence-research',
      displayNameEn: 'Evidence Research', displayNameZhCn: '证据研究',
      descriptionEn: 'Research with evidence.', descriptionZhCn: '使用证据开展研究。',
    }],
    assignments: [{ id: 'assignment-evidence', skillId: 'skill_evidence', scopeType: 'agent_instance', scopeId: 'general-instance', enabled: true }],
    targets: {},
  },
  codexPlugins: { capability: { supported: true }, installed: [], available: [], marketplaces: [], legacyMcpConflicts: [] },
  pluginCatalog: [], composerMentions: [], secretaryMentions: [], composerFileReferences: [], composerMemoryReferences: [],
  socialMentionMenuOpen: true, composerMentionQuery: '', composerMentionActiveIndex: 0,
  chatDraft: '@', languageMode: 'en', busy: false, chatRuns: [], activeChatRun: null,
});

state.composerMentionPickerMode = 'mention';
let markup = renderChat({ renderMessageList: () => '' });
assert.match(markup, /data-project-mention-group="skills"/);
assert.match(markup, /Evidence Research/);
assert.match(markup, /data-ubuddy-mention-skill="skill_evidence"/);
assert.match(markup, /data-ubuddy-mention-token="@Evidence Research"/);

state.composerMentionPickerMode = 'skill';
state.chatDraft = '/skills';
markup = renderChat({ renderMessageList: () => '' });
assert.match(markup, />\/ 选择 Skill</);
assert.match(markup, /data-ubuddy-mention-slash-token="\$evidence-research"/);
assert.doesNotMatch(markup, /data-project-mention-group="plugins"/);

const rendererSource = fs.readFileSync(new URL('../src/renderer/app/core/rendererApp.js', import.meta.url), 'utf8');
const runtimeSource = fs.readFileSync(new URL('../src/main/runtime.js', import.meta.url), 'utf8');
const messageSendSource = fs.readFileSync(new URL('../src/renderer/app/features/chat/messageSendController.js', import.meta.url), 'utf8');
assert.match(rendererSource, /composerSkillCommandQuery/);
assert.match(rendererSource, /\/skills\?/);
assert.match(rendererSource, /insertSkillMention/);
assert.match(runtimeSource, /withAttachedSkillMentionContext/);
assert.match(runtimeSource, /attached_skill_mention_unavailable/);
assert.match(runtimeSource, /Load and follow each selected Skill from Codex Skill discovery/);
assert.match(messageSendSource, /\['plugin', 'skill'\]/);

console.log('attached skill invocation smoke passed');
