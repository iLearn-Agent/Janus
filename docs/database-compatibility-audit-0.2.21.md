# Database compatibility audit for Janus 0.2.21

## Compatibility boundary and rollout

- Desktop application version: `0.2.21`.
- Local Sync protocol: `6`; minimum compatible application remains `0.2.18` because the new uBuddy tables are local-only and do not change Sync entity semantics.
- Local migration head: `ubuddy_coordination_contract_v2`.
- Required Sync capabilities remain `account-workspace-v2`, `canonical-agent-identity-v1`, `conversation-identity-phase6`, and `staged-sync-v6`.
- Social file capabilities are negotiated separately as `chat-group-files-v1` and `resumable-file-transfer-v1`.
- Cloud rollout is expand-migrate-contract: apply PostgreSQL migrations `065_chat_group_message_files.sql` and `066_resumable_large_files.sql`, deploy the capability-aware cloud service, and only then advertise the new file capabilities. Existing file tables and endpoints remain available to older clients.

## Affected records and value mappings

- Local additive tables: `agent_work_reservations`, `ubuddy_agent_wait_requests`, and `ubuddy_planning_jobs`.
- Local rewritten columns:
  - `sessions.interaction_mode`: legacy value `plan` maps to the empty/default interaction mode. No session identity column changes.
  - `messages.metadata_json`: when `dispatchDraftId` exists and `dispatchCommandId` does not, the value is copied to `dispatchCommandId` before the legacy key is removed.
- Local additive columns add reservation leases, heartbeats, and exact/family binding with safe empty or `family` defaults.
- Cloud additive tables: `chat_group_message_files`, `large_file_objects`, `large_file_upload_sessions`, and `large_file_upload_chunks`.
- No user, Agent, account Workspace, conversation, message, Memory, attachment, task, execution, or file identity is rewritten or merged by this release.

## Unique keys, collisions, and reference binding

- Only one active `agent_work_reservations` row may exist per Agent instance. Reservation and waiting-row creation uses an immediate all-or-none transaction; contention leaves no partial reservation.
- `(task_run_id, agent_instance_id)` and `(task_run_id, allocation_key)` remain unique. Existing rows are preserved; a waiting slot is matched only to an eligible idle instance.
- `ubuddy_planning_jobs.task_run_id` and `idempotency_key` are unique, so duplicate enqueue/recovery returns the existing job instead of creating duplicate work.
- File IDs are immutable identities. A repeated file ID is accepted only when owner, scope, size, and SHA-256 match; conflicting content is rejected rather than overwriting user data.
- Chunk identity is `(upload_id, chunk_index)`. A duplicate chunk is idempotent only when its size and hash match; otherwise the upload fails with a conflict.
- Cloud file rows reference existing users, account Workspaces, and chat groups. Downloads re-authorize the requesting member or recipient before returning bytes.

## Preservation invariants

- Session and message IDs, roles, content, timestamps, and Workspace/Agent ownership remain unchanged apart from the two declared non-identity value mappings.
- Memory documents and versions, attachment metadata, task runs/nodes, model executions, context states, and file references must not decrease during migration, repair, or second open.
- Existing social and collaboration file rows remain in their original PostgreSQL tables; new large-file metadata and object files are additive.
- Incomplete or hash-invalid uploads never create a ready large-file object. Completed downloads are placed in a user- and file-isolated local cache only after size and SHA-256 verification.
- `PRAGMA integrity_check` must return `ok`, `PRAGMA foreign_key_check` must be empty, and a second migration/open must produce an identical core inventory.

## Startup, recovery, idempotence, and rollback

- Pending local migrations run against a checkpointed shadow copy before the active database is replaced. A failed preflight leaves the active database, backups, and Sync cursor unchanged.
- Repair-copy and quarantine flows use the same inventory, integrity, foreign-key, and second-open gates. Fresh replacement databases remain pull-only until cloud reconciliation completes.
- Local migrations are idempotent. Legacy Plan normalization only touches rows still carrying `plan`; dispatch metadata is copied only when the destination key is absent.
- Rollback stops creating or advertising the new uBuddy/file capabilities but preserves additive rows and object files for a later forward-compatible deployment. It does not delete local-only user data.
