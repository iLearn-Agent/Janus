import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPostgresEvidenceUsageLedger } from '../src/modules/evolution/evidenceUsageLedger.mjs';

test('PostgreSQL Evidence Ledger reuses an existing transaction client without reconnecting it', async () => {
  const statements = [];
  const client = {
    release() {},
    connect() { throw new Error('transaction client must not be reconnected'); },
    async query(statement) {
      statements.push(String(statement));
      return { rows: [], rowCount: 0 };
    },
  };
  const selected = await createPostgresEvidenceUsageLedger(client).selectPersonalCandidates({
    ownerUserId: 'user', agentInstanceId: 'instance', minimum: 5, limit: 60,
    algorithmVersion: 'personal_cloud_authority_v1',
  });
  assert.deepEqual(selected, { rows: [], thresholdEligibleCount: 0 });
  assert.equal(statements.length, 1);
  assert.equal(statements.some((statement) => /^BEGIN|^COMMIT|^ROLLBACK/.test(statement)), false);
});
