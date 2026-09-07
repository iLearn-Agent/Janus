# User Agent identity migration and recovery

Janus creates a consistent SQLite backup before applying a pending identity or Personal Evolution migration to an existing database.

## Backup behavior

- Backups are stored under `<JANUS_HOME>/data/migration-backups/`.
- The database is checkpointed and copied with SQLite `VACUUM INTO`.
- `PRAGMA integrity_check` must return `ok` before migration starts.
- The latest three successful backups are retained.
- Schema creation and migration remain inside one `BEGIN IMMEDIATE` transaction.

## Rehearsal

```bash
node scripts/user_agent_migration_rehearsal.mjs
```

Use `--keep` to preserve the temporary fixture for inspection.

## Restore

Close Janus before restoring:

```bash
node scripts/restore_database_backup.mjs \
  --root /path/to/janus-home \
  --backup /path/to/migration-backups/<backup>.db
```

The restore tool verifies the selected backup, preserves the current database as an emergency copy, restores the backup, and verifies the restored database again.
