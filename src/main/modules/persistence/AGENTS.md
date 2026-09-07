# Database evolution requirements

- Read `../../../../docs/database-evolution-policy.md` before changing SQLite schema, migrations, database health checks, backups, recovery, sessions, messages, Memory, attachments, tasks, or identity persistence.
- Before editing, identify every affected table, rewritten identity column, unique/foreign key, target-value collision, reference rebind, preservation invariant, sync protocol dependency, and recovery path.
- Never update columns participating in a unique identity before either proving the target values are collision-free or temporarily removing the constraint and applying a deterministic preserve-and-rebind strategy in the same transaction.
- Preserve user records. Do not resolve collisions by deleting sessions, messages, Memory, attachments, tasks, or executions. Do not use `INSERT OR IGNORE` where it could silently discard user data.
- Every new migration must have an explicit machine-readable risk declaration in `databaseMigrationRegistry.js`, including affected tables, rewritten columns, unique keys, collision strategy, preservation rules, sync requirements, idempotence, and rollback safety.
- Add historical upgrade fixtures covering normal startup, recovery-copy repair, second-open idempotence, integrity/foreign-key checks, and failure rollback. Include a target-value collision fixture whenever identity or Workspace columns change.
- Run the database migration guard, historical upgrade matrix, maintenance/recovery smokes, primary repository check, Fake Codex E2E when persistence or sync behavior changes, and `git diff --check`.
- Do not claim a migration is safe unless the final database preserves the required data inventory and passes the declared compatibility gates.
