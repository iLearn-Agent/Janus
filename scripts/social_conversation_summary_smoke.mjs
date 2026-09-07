import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-social-summary-'));
const previousAuthUrl = process.env.JANUS_AUTH_URL;
process.env.JANUS_AUTH_URL = '';
let runtime;

try {
  runtime = await createRuntime({ root, isDev: true });
  const bob = runtime.authRegister({ email: 'summary-bob@example.com', password: 'summary-password', displayName: 'Summary Bob' });
  const alice = runtime.authRegister({ email: 'summary-alice@example.com', password: 'summary-password', displayName: 'Summary Alice' });

  runtime.friendSendRequest({ userId: bob.id, message: 'summary smoke' });
  runtime.authLogin({ identifier: bob.email, password: 'summary-password' });
  runtime.friendAcceptRequest({ requestId: runtime.friendsOverview().requests.incoming[0].id });
  runtime.socialSendMessage({ recipientId: alice.id, content: 'summary-from-bob' });

  runtime.authLogin({ identifier: alice.email, password: 'summary-password' });
  runtime.socialSendMessage({ recipientId: bob.id, content: 'summary-from-alice' });

  const result = runtime.socialConversationSummaries({ messagesPerThread: 100, limit: 100 });
  const thread = result.threads.find((item) => item.friend.id === bob.id);
  assert.ok(thread, 'the peer summary must be returned');
  assert.equal(thread.friend.displayName, 'Summary Bob');
  assert.deepEqual(thread.messages.map((message) => message.content), ['summary-from-bob', 'summary-from-alice']);
  assert.equal(thread.messages.at(-1).senderUserId, alice.id);

  for (let index = 0; index < 5; index += 1) {
    const sent = runtime.socialSendMessage({
      recipientId: bob.id,
      content: `latest-window-${index}`,
      clientMessageId: `latest-window-${index}`,
    });
    runtime.db.prepare('UPDATE social_messages SET created_at=?, updated_at=? WHERE id=?').run(
      `2099-08-07T00:00:0${index}.000Z`,
      `2099-08-07T00:00:0${index}.000Z`,
      sent.message.id,
    );
  }
  const latestWindow = runtime.socialConversation({ peerId: bob.id, limit: 3 });
  assert.deepEqual(latestWindow.map((message) => message.content), [
    'latest-window-2',
    'latest-window-3',
    'latest-window-4',
  ], 'bounded contact history must keep the latest messages instead of the oldest messages');

  console.log('social conversation summary smoke passed');
} finally {
  runtime?.close?.();
  if (previousAuthUrl === undefined) delete process.env.JANUS_AUTH_URL;
  else process.env.JANUS_AUTH_URL = previousAuthUrl;
  await rm(root, { recursive: true, force: true });
}
