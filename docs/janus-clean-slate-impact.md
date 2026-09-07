# Janus clean-slate database impact record

## Compatibility boundary

Janus 0.3.0 is a new product generation. It does not discover, open, migrate, import, repair, quarantine, upload, or delete data from the retired product. Desktop storage starts at `~/.janus/data/janus.db`; the test channel starts at `~/.janus-test/data/janus.db`. Cloud deployments use a new `janus` PostgreSQL database, Janus-only roles, a Janus object-storage namespace, Sync protocol 9, database contract 2, and the `janus-clean-slate-v1` capability.

## Affected storage

- Local: every table declared by `SQLITE_SCHEMA`, with a fresh empty database and a `database_meta` identity of `product_namespace=janus`, `data_generation=1`.
- Cloud: every table built by the Janus PostgreSQL migration set, with the singleton `janus_database_identity` row.
- Sync: all existing entity types remain structurally supported, but no prior rows or cursors are imported into the Janus deployment.

## Mapping, keys, and collisions

There is no row-level old-to-target mapping. No identity, user, Workspace, session, message, Memory, attachment, task, execution, file, or cursor value is rewritten because retired data is outside the Janus storage boundary. Unique and foreign keys are created only against the empty Janus baseline, so migration-time target collisions do not exist. Users register new Janus accounts and receive new account, device, Workspace, Agent, session, and sync identities.

## Preservation and recovery

Janus does not promise preservation of retired product data. It also does not delete that data: the old directory and old cloud deployment remain operationally separate until an administrator or user explicitly removes them. A Janus startup or migration failure affects only the new Janus database. Fresh-database recovery remains pull-only before upload, but it reconciles only with the Janus cloud generation.

## Rollout and rollback

The desktop, cloud API, worker, PostgreSQL database, object storage, update feed, environment variables, and deployment units must switch together. Old clients are rejected before batch acceptance or cursor advancement because they cannot advertise database contract 2, Sync protocol 9, and `janus-clean-slate-v1`. Rollback means returning users to the separate retired product; Janus data is never written into its database.
