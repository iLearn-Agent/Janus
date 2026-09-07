# Account principal isolation V1 impact record

## Outcome

Personal and organization accounts are independent data/security principals. A human actor may authenticate once and hold memberships in several accounts, but conversations, Agent state, Memory, tasks, files, runtime work and Sync cursors never inherit access merely because the actor is the same.

## Compatibility boundary

- Minimum desktop writer: `0.2.26`.
- Sync protocol: `8`.
- Required capabilities:
  - `account-principal-isolation-v1`
  - `account-scoped-cursor-v1`
  - `conversation-security-domain-v1`
  - `account-owned-agent-v1`
- Rollout is cloud expand, desktop shadow-migrate/cut over, then cloud contract.
- Protocol 7 clients must be rejected before accepting account-principal writes or advancing a cursor.
- This release enables core Sync only for personal Accounts. Organization chats remain isolated locally/socially, while organization core Sync is rejected before batch acceptance or cursor advancement until account-scoped materialized cloud tables replace the legacy user-scoped projections.

## Affected storage

Local identity/control tables:

- `auth_users`, `account_workspaces`, `account_workspace_memberships`, account preferences;
- new `accounts`, `account_memberships`, `account_workspace_bindings`, `auth_principals`;
- `cloud_auth_state`, `cloud_sync_state`, Sync batches, revisions and deferred changes.

Local security roots:

- projects, conversations, sessions, messages, attachments and model executions;
- Agent instances, bindings, branch state, timeline references, Memory and context state;
- task runs/nodes/events/reviews/submissions, work scopes, delegations and collaboration workspaces;
- social direct messages, chat groups, work groups, memberships, outboxes and files;
- file manifests, file references and task file state.

Cloud storage and contracts:

- accounts/memberships and organization projections;
- social conversations, messages, groups, delegations and file objects;
- Sync entities, changes, batches, conflicts, snapshots, device cursors and usage rows.

## Old-to-target mappings

- Legacy personal scope `workspace_personal` plus actor `U` maps to `account_personal_<U>`.
- Organization scope `workspace_org_<O>` maps to `account_org_<O>`.
- Authenticatable local/remote principals receive active personal accounts and `auth_principals`. Cached contact/directory users receive external personal-account projections only so personal-direct Conversation bindings remain explicit; they do not become login principals.
- A legacy personal direct message maps to one personal-direct conversation bound to the two participants' personal accounts.
- A legacy organization direct message maps to a distinct organization-direct conversation anchored to that organization account.
- A normal group is anchored to its creation account. Work/collaboration groups are anchored to their account and work scope.
- A user Agent instance used in multiple accounts is projected to one account-owned instance per account; its Sessions, Memory, context and timeline references follow their source account.

## Unique keys and collision handling

- One personal account per actor; one organization account per organization.
- One membership per `(account_id, actor_id)`.
- One conversation binding per `(conversation_id, account_id)`.
- One writable primary Agent Session per `(account_id, actor_id, account_agent_instance_id)`.
- Sync entity/revision identity is `(account_id, entity_type, entity_id)` and device cursor identity is `(actor_id, account_id, device_id)`.
- File path identity is account and device scoped; a bare local path is not a global identity.
- Projected target values are queried before the first rewrite.
- Payload-identical immutable IDs may be deduplicated. The same ID with different immutable content is quarantined and aborts automatic cutover; it is never overwritten.
- Primary Session winners are selected by referenced state, writable/active status, latest update, creation time and stable ID. Losers remain read-only history and every reference is rebound.
- Equivalent Memory documents may share canonical identity through aliases. Non-equivalent documents and every version remain distinct.

## Preservation invariants

- Message IDs, roles, content, creation timestamps and rewrite/supersession metadata are unchanged.
- Session IDs and Codex thread lineage are retained; no Session is deleted to satisfy uniqueness.
- Memory documents, versions, required keys, aliases and active references are retained.
- Attachment identity, names, hashes, sizes and remote IDs are retained.
- Tasks, nodes, events, revisions, submissions, delivery reviews, model executions, delegations and work files are retained.
- Agent alias lineage and account-specific context state are retained.
- Sync audit/outbox rows and cursors are unchanged until a compatible account-scoped batch commits.

## Migration and recovery

- Pending migration runs on a checkpointed shadow copy before active database mutation.
- A failed projection, inventory comparison, integrity check or foreign-key check leaves the active database, backup set and Sync cursors unchanged.
- Ambiguous ownership is written to quarantine with source table/ID and candidate accounts; it is never guessed.
- Repair-copy migration must prove the same inventory invariants as normal startup.
- Second open is idempotent.
- Fresh replacement databases remain pull-only until account-scoped cloud reconciliation and local/quarantine audit finish.
- Downgrade writers are blocked by `database_meta.min_writer_version`; rollback uses the verified pre-migration backup, not an older writer against the migrated database.
