# Main-process database and sync safety

- For changes to `db.js`, `databaseRecovery.js`, `cloudSync.js`, authentication persistence, IPC recovery handlers, or any code that rewrites stored identity/Workspace data, read `../../docs/database-evolution-policy.md` and the closer persistence `AGENTS.md` when applicable.
- Treat server storage, sync payloads, and local SQLite as separate versioned contracts. Do not apply server-originated changes until protocol, migration head, and required capabilities are compatible.
- Stage or reject incompatible sync changes without advancing the cursor. Run identity rewrites and uniqueness repair in one rollback-safe transaction, preserving all user content.
- Fresh-database recovery must pull before push and must expose a local-only data audit before isolation.
