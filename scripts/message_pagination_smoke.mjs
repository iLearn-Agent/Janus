import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AuthService } from '../src/main/auth.js';
import { openDatabase } from '../src/main/db.js';
import { Store } from '../src/main/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-message-pagination-'));
let db;
try {
  db = openDatabase(root, { skipMigrationBackup: true });
  const auth = new AuthService(db);
  const user = auth.currentUser();
  const store = new Store(db, { root });
  store.ensureAccountWorkspaces({ user });
  const session = store.createSession({ userId: user.id, title: 'Pagination smoke' });

  const expectedIds = [];
  for (let index = 0; index < 205; index += 1) {
    const message = store.addMessage({
      sessionId: session.id,
      role: index % 2 ? 'assistant' : 'user',
      content: `pagination-message-${String(index).padStart(3, '0')}`,
      metadata: index === 17 ? {
        attachments: [{ id: 'pagination-file', name: 'pagination.txt', path: '/tmp/pagination.txt', sizeBytes: 17 }],
      } : {},
    });
    expectedIds.push(message.id);
    db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(
      new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      message.id,
    );
  }

  const first = store.listMessagePage(session.id, { limit: 80 });
  assert.equal(first.items.length, 80);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.items.map((item) => item.id), expectedIds.slice(-80));
  assert.equal(first.nextCursor.id, expectedIds[125]);

  const collected = [...first.items];
  let cursor = first.nextCursor;
  let hasMore = first.hasMore;
  while (hasMore) {
    const page = store.listMessagePage(session.id, { before: cursor, limit: 80 });
    collected.unshift(...page.items);
    cursor = page.nextCursor;
    hasMore = page.hasMore;
  }

  assert.equal(collected.length, 205);
  assert.equal(new Set(collected.map((item) => item.id)).size, 205);
  assert.deepEqual(collected.map((item) => item.id), expectedIds);
  const attachmentMessage = collected.find((item) => item.id === expectedIds[17]);
  assert.equal(attachmentMessage.metadata.attachments[0].name, 'pagination.txt');

  const empty = store.listMessagePage(session.id, {
    before: { createdAt: '1900-01-01T00:00:00.000Z', id: 'before-all' },
    limit: 80,
  });
  assert.deepEqual(empty, { items: [], hasMore: false, nextCursor: null });

  console.log('message pagination smoke passed');
} finally {
  db?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
