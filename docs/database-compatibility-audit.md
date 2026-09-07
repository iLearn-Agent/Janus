# Database compatibility audit for the Codex process-display rollout

## Scope and compatibility boundary

- The P0–P4 process-display and strict file-snapshot work adds no SQLite or PostgreSQL table, column, index, or migration. It stores optional comparison data in existing message/execution JSON metadata.
- This audit also covers the database and Sync changes already present in the same working tree: SQLite migration preflight/recovery, account Workspace isolation, canonical Agent identity merge, Sync V6 contract negotiation, and fresh-database pull-only recovery.
- Required desktop boundary: app `0.2.18`, Sync protocol `6`, migration `account_workspace_context_isolation_v2`, and the capabilities declared in `databaseEvolutionContract.js`.
- Cloud Sync now fails closed when `JANUS_SYNC_REQUIRE_CLIENT_CONTRACT` is missing; production keeps it at `1`. Contract-less or incompatible clients are rejected before batch acceptance or device-cursor advancement, and `0` is reserved for an explicit, time-bounded compatibility window.

## Affected records and value mappings

- Empty local `sessions.account_workspace_id` values map to `workspace_personal`.
- Server-originated Agent aliases map `alias_instance_id` to `canonical_instance_id`.
- Fresh replacement databases remain pull-only until the remote change stream reaches its final page and no deferred/quarantined identity change remains.
- P0–P4 file comparison metadata does not rewrite user, Agent, Workspace, conversation, message, Memory, attachment, task, execution, or file identities.

## Collision handling

- Primary session key: `(user_id, account_workspace_id, agent_instance_id)` for writable, non-deleted primary sessions. The index is removed before Workspace normalization or Agent canonicalization, a deterministic primary is selected, losing sessions remain as read-only history, context-state references are rebound, and the index is recreated before commit.
- Workspace Agent binding key: `(workspace_id, agent_instance_id)`. Alias/canonical rows are merged; represented visibility, active status, and all granted capabilities are preserved.
- Running work key: partial unique `agent_work_queue(agent_instance_id) WHERE status='running'`. All queue rows are preserved; the deterministic oldest running item remains running and additional colliding running items are returned to `queued`.
- Cloud primary conversation identity accepts both camelCase and snake_case payloads. Deleted cloud entities are excluded when selecting a canonical writable primary, so a stale materialized row cannot demote a valid replacement conversation.
- Message, Memory-version, context-space, and conversation collisions continue to use the existing preserve-and-report, renumber, alias, or history strategies covered by the historical matrix.

## Preservation and recovery invariants

- Session and message IDs, roles, content, and creation times remain present.
- Message attachments retain identity and content metadata.
- Memory documents/versions, task runs/nodes, model executions, and file references do not decrease during shadow migration or repair-copy validation.
- A failed shadow preflight leaves the active database, backup set, and Sync cursor unchanged.
- Repair runs operate on a copy and replace the active database only after integrity, foreign-key, health, inventory, and content-fingerprint checks pass.
- Fresh-database quarantine remains available for local-only data; bidirectional Sync is not enabled while more cloud pages or unresolved identity changes remain.

## Rollout and rollback

- Cloud rollout is expand-migrate-contract: deploy compatibility-aware server code first, require the client contract in production, then allow desktop `0.2.18` uploads.
- Older clients may read optional P0–P4 JSON metadata but must not participate in the new database contract once the production gate is enabled.
- The added repair logic is idempotent. A second open keeps one writable primary, retains history/queue/binding rows, and produces no further inventory loss.
