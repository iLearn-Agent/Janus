# File-change strict snapshot impact record

## Storage and compatibility

- Local tables: existing `messages.metadata_json` and `model_executions.metadata_json` only. No table, column, index, migration, or schema-count change.
- Cloud tables/entities: existing message and model-execution JSON metadata. Device-local snapshot `path` fields are removed by the existing recursive Cloud Sync sanitizer; hashes, completeness state, provenance, metrics, and bounded semantic changes remain forward-compatible optional JSON.
- Rewritten identity or Workspace columns: none.
- Unique keys, foreign keys, collisions, canonical winners, loser preservation, and reference rebinds: not applicable.
- Required app/schema/Sync boundary: app `0.2.18`; current schema and Sync protocol remain valid because older clients ignore the optional fields.

## Preservation invariants

- Session and message IDs, roles, content, creation times, visibility, and conversation ownership are unchanged.
- Memory, attachments, tasks, task nodes, model executions, context state, file references, and Sync cursors are not rewritten or deleted.
- Strict comparison data is appended to process events. Full pre/post files remain local under the runtime data directory; Cloud Sync never receives their absolute paths.
- If a baseline, post-change file, parser, or capacity limit is unavailable, the event is marked incomplete. No guessed before-state is persisted.

## Recovery and rollback

- Normal startup and second open read optional comparison metadata without migration.
- Completed and interrupted runs retain bounded semantic results and immutable local snapshots for restart replay.
- Removing the feature is rollback-safe: older builds ignore the optional JSON and leave messages intact.
- Database repair, quarantine, and fresh-database recovery require no special transformation. Cloud-restored messages keep hashes and semantic results but may lack device-local preview files.
