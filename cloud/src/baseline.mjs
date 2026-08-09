import { cloudSchemaFingerprint } from './schemaFingerprint.mjs';

export async function markBaselineEquivalent(pool, metadata) {
  const migrations = await pool.query('SELECT filename FROM public.schema_migrations ORDER BY filename');
  const applied = new Set(migrations.rows.map((row) => String(row.filename || '')));
  if (applied.has(metadata.baselineId)) return { status: 'already_recorded', baselineId: metadata.baselineId };
  if (!applied.has('081_agent_instance_sequence_compaction.sql')) {
    throw new Error('Historical migration 081 is required before baseline equivalence can be marked.');
  }
  if (applied.has(metadata.firstPostBaselineMigration)) {
    throw new Error('Mark baseline equivalence before applying post-baseline migration 082.');
  }
  const current = await cloudSchemaFingerprint(pool);
  if (current.fingerprint !== metadata.schemaFingerprint || current.objectCount !== metadata.schemaObjectCount) {
    throw new Error(`Schema is not equivalent to ${metadata.baselineId}; expected ${metadata.schemaFingerprint}/${metadata.schemaObjectCount}, received ${current.fingerprint}/${current.objectCount}.`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO public.schema_migrations(filename) VALUES($1) ON CONFLICT(filename) DO NOTHING', [metadata.baselineId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { status: 'recorded', baselineId: metadata.baselineId, fingerprint: current.fingerprint };
}
