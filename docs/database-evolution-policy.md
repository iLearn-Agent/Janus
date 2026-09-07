# Janus database evolution policy

This policy is mandatory for changes to desktop SQLite, cloud PostgreSQL sync storage, migrations, identity/Workspace mapping, recovery, or persisted user data.

## Required design review

Before editing, identify:

1. affected local tables, server tables, and sync entity types;
2. rewritten identity/Workspace columns;
3. affected unique and foreign keys;
4. collisions produced by target values, not only current values;
5. canonical winner selection and loser preservation;
6. every reference that must be rebound;
7. message, Memory, attachment, task, and execution preservation invariants;
8. required sync protocol, application version, migration head, and capabilities;
9. normal-startup, repair-copy, quarantine-restore, idempotence, and rollback tests.

## Migration invariants

- Keep server storage, sync payloads, and local SQLite as separate versioned contracts.
- Use expand-migrate-contract server releases. Do not change payload semantics for clients that have not advertised the required capability.
- Do not rewrite columns participating in unique identities until target collisions are handled. Remove or defer the constraint, transform data, preserve/rebind losers, validate, and recreate the constraint in one transaction.
- Never delete or silently ignore user sessions, messages, Memory, attachments, tasks, or executions to make a migration pass.
- Do not use `INSERT OR IGNORE` when a conflict could represent user data.
- Run pending migrations on a consistent shadow copy before modifying the active database.
- Preserve message IDs, roles, content, and creation times; preserve attachment identity/content metadata; do not decrease declared inventory counts.
- Require `PRAGMA integrity_check`, an empty `PRAGMA foreign_key_check`, database-health invariants, and second-run idempotence.
- A failed shadow migration must not replace the active database or advance cloud sync cursors.

## Sync invariants

- Desktop requests must send the database client contract: app version, protocol version, local schema count, migration head/applied IDs, and capabilities.
- The cloud must reject incompatible uploads and pulls before accepting a batch or advancing a device cursor.
- Every returned change/snapshot must declare its minimum protocol and required capabilities.
- The desktop must defer an unsupported change without recording its revision or advancing the cursor.
- Agent identity merges are explicit alias operations. Apply them transactionally with duplicate-primary-session repair and equivalent-context merging.
- A fresh database performs one pull-only reconciliation before file or change uploads resume.

## Migration declarations

Every migration introduced in 0.2.18 or later requires an explicit declaration in `databaseMigrationRegistry.js` containing:

- affected tables;
- rewritten columns;
- affected unique keys;
- collision strategy;
- preservation rules;
- minimum sync protocol;
- required capabilities;
- `idempotent: true`;
- `rollbackSafe: true`.

`scripts/database_migration_guard.mjs` must reject missing or unsafe declarations and unsafe identity-rewrite ordering.

## Required validation

Run sequentially:

```text
node scripts/database_migration_guard.mjs
node scripts/database_sync_contract_smoke.mjs
node scripts/database_historical_upgrade_matrix.mjs
node scripts/database_maintenance_framework_smoke.mjs
node scripts/database_recovery_surface_smoke.mjs
node scripts/database_fresh_fallback_smoke.mjs
node scripts/database_fresh_pull_only_sync_smoke.mjs
node scripts/database_runtime_identity_merge_smoke.mjs
node scripts/database_shadow_preflight_smoke.mjs
node scripts/run_guarded.mjs -- node scripts/check.mjs
node scripts/run_guarded.mjs -- node scripts/fake_codex_e2e.mjs
git diff --check
```

Use the guarded runner for commands expected to exceed 30 seconds. Do not report the migration safe unless all relevant historical, sync, recovery, and final repository checks pass.
