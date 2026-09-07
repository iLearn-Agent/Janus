import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-feishu-agent-runtime-'));
const runtimeRoot = path.join(tempRoot, 'runtime');
const fakeCodex = path.join(tempRoot, 'fake-codex.mjs');
const previousCodexBin = process.env.JANUS_CODEX_BIN;

await writeFile(fakeCodex, `#!/usr/bin/env node
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fake-codex-feishu-agent'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) { console.log('Usage: codex app-server [OPTIONS]'); process.exit(0); }
if (args[0] !== 'app-server') process.exit(2);
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (!message.method) continue;
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'feishu-agent-runtime-smoke' } });
  else if (message.method === 'thread/start' || message.method === 'thread/resume') {
    send({ id: message.id, result: { thread: { id: 'feishu-agent-thread' } } });
  } else if (message.method === 'thread/memoryMode/set' || message.method?.startsWith('thread/goal/')) {
    if (message.method === 'thread/goal/get') send({ id: message.id, result: { goal: null } });
    else send({ id: message.id, result: {} });
  } else if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'feishu-agent-turn' } } });
    send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'FEISHU_AGENT_RUNTIME_OK' } } });
    send({ method: 'turn/completed', params: { usage: { input_tokens: 10, output_tokens: 5 }, turn: { id: 'feishu-agent-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'FEISHU_AGENT_RUNTIME_OK' }] } } });
  } else send({ id: message.id, error: { code: -32601, message: 'unsupported' } });
}
`, { mode: 0o755 });
fs.chmodSync(fakeCodex, 0o755);
process.env.JANUS_CODEX_BIN = fakeCodex;

let runtime;
try {
  runtime = await createRuntime({ root: runtimeRoot, isDev: true, serverAuthoritativeSkills: true });
  const user = runtime.currentUser();
  const first = runtime.store.findUserAgentInstance({ userId: user.id, agentFamilyId: 'general_agent' })
    || runtime.store.recruitUserAgent({
      userId: user.id, agentFamilyId: 'general_agent', commandId: 'feishu-agent-runtime:first',
    }).instance;
  const second = runtime.store.recruitUserAgent({
    userId: user.id, agentFamilyId: 'general_agent', commandId: 'feishu-agent-runtime:second',
  }).instance;
  runtime.store.updateUserAgentProfile({ userId: user.id, agentInstanceId: first.id, displayName: '飞书一号' });
  runtime.store.updateUserAgentProfile({ userId: user.id, agentInstanceId: second.id, displayName: '飞书二号' });
  runtime.saveCodexConfig({ apiKey: 'sk-feishu-agent-runtime', model: 'gpt-5.6-sol', reasoningEffort: 'medium' });

  const scope = { expectedUserId: user.id, accountWorkspaceId: 'workspace_personal' };
  runtime.db.prepare(`INSERT INTO auth_users (id,email,display_name,username,email_verified)
    VALUES ('feishu_contact_bob','feishu-bob@example.com','Bob','bob',1)`).run();
  runtime.db.prepare(`INSERT INTO friendships (id,user_a_id,user_b_id,status,user_a_remark)
    VALUES ('feishu_contact_friendship',?,'feishu_contact_bob','accepted','产品 Bob')`).run(user.id);
  runtime.db.prepare(`INSERT INTO auth_users (id,email,display_name,username,email_verified)
    VALUES ('feishu_contact_org','feishu-org@example.com','组织成员','org_member',1)`).run();
  runtime.db.prepare(`INSERT INTO contact_organizations
    (id,organization_number,name,owner_user_id,source)
    VALUES ('feishu_contact_org_unit','ORG-FEISHU','测试组织',?,'local')`).run(user.id);
  runtime.db.prepare(`INSERT INTO contact_organization_members (organization_id,user_id,role)
    VALUES ('feishu_contact_org_unit',?,'owner'),('feishu_contact_org_unit','feishu_contact_org','member')`).run(user.id);
  assert.deepEqual(runtime.externalChannelContacts(scope), [{
    userId: 'feishu_contact_bob', username: 'bob', displayName: '产品 Bob',
  }, {
    userId: 'feishu_contact_org', username: 'org_member', displayName: '组织成员',
  }]);
  const resolvedMention = runtime.resolveExternalChannelJanusMention({
    ...scope, username: 'BOB', displayText: '@BOB', mentionId: 'feishu-runtime-mention',
  });
  assert.equal(resolvedMention.ok, true);
  assert.deepEqual(resolvedMention.contact, {
    userId: 'feishu_contact_bob', username: 'bob', displayName: '产品 Bob',
  });
  assert.deepEqual({
    principalType: resolvedMention.mention.principalType,
    userId: resolvedMention.mention.userId,
    displayText: resolvedMention.mention.displayText,
    mentionId: resolvedMention.mention.mentionId,
    source: resolvedMention.mention.source,
  }, {
    principalType: 'user', userId: 'feishu_contact_bob', displayText: '@BOB',
    mentionId: 'feishu-runtime-mention', source: 'picker',
  });
  assert.deepEqual(runtime.resolveExternalChannelJanusMention({ ...scope, username: 'not_a_contact' }), {
    ok: false, reason: 'not_found',
  });
  const resolvedOrganizationMention = runtime.resolveExternalChannelJanusMention({
    ...scope, username: 'org_member', displayText: '@org_member', mentionId: 'feishu-runtime-org-mention',
  });
  assert.equal(resolvedOrganizationMention.ok, true);
  assert.equal(resolvedOrganizationMention.contact.userId, 'feishu_contact_org');
  const agents = runtime.externalChannelAgents(scope);
  assert.ok(agents.some((item) => item.agentInstanceId === first.id && item.displayName === '飞书一号'));
  assert.ok(agents.some((item) => item.agentInstanceId === second.id && item.displayName === '飞书二号'));

  const primary = runtime.store.createSession({
    title: '飞书一号主会话', departmentId: 'general', agentId: 'general_agent',
    agentInstanceId: first.id, userId: user.id, accountWorkspaceId: 'workspace_personal',
  });
  const result = await runtime.externalChannelAgentChat({
    ...scope,
    provider: 'feishu',
    agentInstanceId: first.id,
    externalMessageId: 'om_feishu_agent_runtime',
    externalUserId: 'ou_owner',
    externalChatId: 'chat_owner',
    message: '只发给飞书一号',
  });
  assert.equal(result.answer, 'FEISHU_AGENT_RUNTIME_OK');
  assert.equal(result.session.id, primary.id, 'external Agent chat must reuse the desktop primary session');
  assert.equal(result.session.agentInstanceId, first.id, 'external Agent chat must preserve the exact recruited instance');
  assert.equal(runtime.store.getPrimaryAgentSession({
    userId: user.id, agentInstanceId: second.id, workspaceId: 'workspace_personal',
  }), null, 'routing to one same-family instance must not create a session for another instance');
  const messages = runtime.listMessages(primary.id);
  assert.ok(messages.some((item) => item.role === 'user' && item.content === '只发给飞书一号'));
  assert.ok(messages.some((item) => item.role === 'assistant' && item.content === 'FEISHU_AGENT_RUNTIME_OK'));
  assert.ok(messages.filter((item) => ['user', 'assistant'].includes(item.role)).every((item) => item.agentInstanceId === first.id));

  assert.throws(() => runtime.externalChannelAgents({
    expectedUserId: 'other_user', accountWorkspaceId: 'workspace_personal',
  }), (error) => error.code === 'external_channel_user_changed');
  console.log('Feishu remote Agent runtime smoke passed.');
} finally {
  runtime?.close();
  if (previousCodexBin === undefined) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousCodexBin;
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
