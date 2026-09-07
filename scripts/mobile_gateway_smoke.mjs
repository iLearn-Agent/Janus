import assert from 'node:assert/strict';
import { createMobileGateway } from '../src/main/mobileGateway.js';

const settings = new Map();
const runtime = {
  store: {
    settingGet: (key, fallback = '') => settings.has(key) ? settings.get(key) : fallback,
    settingSet: (key, value) => settings.set(key, String(value)),
  },
  currentUser: () => ({ id: 'user_mobile_smoke', displayName: 'Mobile Smoke' }),
  listSessions: () => [{ id: 'session_mobile_smoke', title: '测试会话', updatedAt: '2026-09-02T00:00:00Z' }],
  listMessagePage: () => ({ items: [{ id: 'message_mobile_smoke', role: 'assistant', content: 'ready' }], nextCursor: '' }),
  ensureSecretarySession: () => ({ id: 'session_mobile_new', title: 'uBuddy', updatedAt: '2026-09-02T00:00:00Z' }),
  sendChat: async ({ onEvent }) => {
    onEvent({ kind: 'start', runId: 'run_mobile_smoke', sessionId: 'session_mobile_smoke' });
    onEvent({ kind: 'done', runId: 'run_mobile_smoke', sessionId: 'session_mobile_smoke', answer: 'done' });
    return { session: { id: 'session_mobile_smoke' }, answer: 'done' };
  },
  cancelChat: async () => ({ ok: true }),
  resolveChatApproval: () => ({ ok: true }),
};

const gateway = createMobileGateway({ runtime, port: 0, logger: { info() {}, warn() {} } });
try {
  const status = await gateway.start();
  const origin = `http://127.0.0.1:${status.port}`;
  const pairing = gateway.status();
  const pairResponse = await fetch(`${origin}/mobile/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pairing.pairingCode, deviceName: 'smoke phone' }),
  });
  assert.equal(pairResponse.status, 201);
  const { token } = await pairResponse.json();
  assert.match(token, /^mgt_/);
  const headers = { authorization: `Bearer ${token}` };
  const created = await fetch(`${origin}/mobile/sessions/new`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' }).then((response) => response.json());
  assert.equal(created.session.id, 'session_mobile_new');
  const sessions = await fetch(`${origin}/mobile/sessions`, { headers }).then((response) => response.json());
  assert.equal(sessions.sessions[0].id, 'session_mobile_smoke');
  const messages = await fetch(`${origin}/mobile/sessions/session_mobile_smoke/messages`, { headers }).then((response) => response.json());
  assert.equal(messages.messages[0].content, 'ready');
  const sent = await fetch(`${origin}/mobile/chat/send`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'session_mobile_smoke', instruction: 'hello' }),
  }).then((response) => response.json());
  await new Promise((resolve) => setTimeout(resolve, 20));
  const run = await fetch(`${origin}/mobile/runs/${encodeURIComponent(sent.run.id)}`, { headers }).then((response) => response.json());
  assert.equal(run.run.status, 'completed');
  assert.equal(run.run.answer, 'done');
  const events = await fetch(`${origin}/mobile/events?token=${encodeURIComponent(token)}`, { headers: { accept: 'text/event-stream' } });
  assert.equal(events.status, 200);
  events.body?.cancel?.();
  console.log('mobile gateway smoke ok');
} finally {
  await gateway.stop();
}
