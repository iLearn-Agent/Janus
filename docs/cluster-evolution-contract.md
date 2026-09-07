# Cluster evolution contract

This document freezes the cloud-authoritative product and persistence contract for cluster evolution.

## Identity and thresholds

- A family cohort is identified by `family:<agent_family_id>`.
- A similar cohort is identified by its department and sorted capability tags.
- `cohort_id` is the stable SHA-256-derived ID of that key and never contains an algorithm version.
- The minimum cohort size is 7 users. A user's final normalized contribution may not exceed 15%.
- Seven users are required because fewer users cannot produce a normalized 100% contribution total while every user remains at or below 15%.
- Every active, synchronized Agent instance participates under policy `cluster_active_synced_mandatory_v1`; legacy cluster consent fields do not affect eligibility.
- A published section must eventually be supported by evidence from at least 3 distinct users.
- The cluster algorithm version is `cluster_market_v2` and is stored on runs and evidence re-evaluation records, not cohort identity.

## Evidence ledger

- Evidence usage states are `available`, `reserved`, `consumed`, `evaluated_rejected`, and `released`.
- Personal and cluster consumers have independent ledger rows. One evidence item may be consumed once by each scope.
- Market adoption, rejection, and rollback actions are structured Evidence for both personal and cluster scopes; they remain in the `other` cluster category and cannot replace chat, Memory, or completed-task minimums.
- A consumed cluster claim is permanent across cohort membership or algorithm changes.
- `evaluated_rejected` may be reserved again only when its algorithm/policy/related-evidence basis changes.
- Cohort thresholds count only valid new `available` or `released` evidence. Reconsidered rejected evidence cannot satisfy the new-evidence floor.
- Infrastructure, model, or key failures release reservations. Gate, governance, privacy, and regression rejection are terminal for the current basis.
- Evidence from an inactive Agent remains auditable but is excluded from new cohorts. An already frozen run snapshot remains immutable.

## Market and Canary lifecycle

- A complete market version is an immutable `market_base` Agent version. Historical section-only versions are `legacy_sections`.
- Candidate states are `draft`, `gated`, `governance_approved`, `shadow_passed`, `canary_running`, `canary_passed`, `released`, the stage-specific rejection states, `rolled_back`, and `archived`.
- Cross-user replay is a Shadow evaluation, not a Canary.
- Real Canary may affect only user instances that explicitly opt in under policy `market_canary_real_user_opt_in_v1`.
- A Shadow-passed candidate remains unpublished until at least 7 opted-in users are enrolled and at least 7 real task cases are observed.
- Opt-in assignments temporarily add only that candidate's family sections to the assigned Agent's effective Skill; personal overlay conflicts continue to default to the personal rule.
- Canary rejects confirmed privacy or role violations, a score regression greater than 10 points, or a failure-rate increase greater than 10 percentage points.
- A passed Canary publishes an immutable `market_base`, marks the frozen run Evidence consumed, and retains the Canary observation record. Insufficient observations release Evidence after the Canary deadline; evaluated safety or quality regressions are recorded as `evaluated_rejected`.
- Released market content and section bodies are immutable. Health monitoring may only change lifecycle status to suspended or rolled back.

## Performance authority

- Cohort weights use cloud-derived `performance_90d_100tasks_v2` snapshots only.
- Desktop clients submit synchronized task-node references, not trusted quality, first-pass, peer-median, evidence-completeness, or security scores.
- Completed-task count includes only completed or accepted tasks. Failed and blocked attempts affect reliability; cancelled tasks remain auditable but do not count as completed or terminal performance attempts.
- Efficiency uses at least five other-Agent tasks of the same task type, then at least five same-family tasks, then the task estimate, and finally a neutral baseline.
- Fewer than ten completed tasks is provisional and caps the contribution weight at 1.0.

## Evidence collection and validation

- A conversation segment is exactly one visible user message plus the first visible assistant reply that follows it. Later assistant messages do not create additional segments for that user turn.
- Evidence identity remains stable across devices. `lineage_key` suppresses duplicate lineage, and a conversation segment supersedes its constituent message records for cluster selection.
- Historical backfill is cursor-based, bounded, idempotent, and resumable for chat, conversation segments, task lifecycle/results, Memory versions, model executions/metrics, collaboration messages, and delegation revisions.
- Evidence that cannot be attributed to a synchronized Agent instance enters quarantine and cannot participate in evolution.
- History produced before an Agent's `deactivated_at` may upload for audit, but it creates no personal or cluster usage.
- New envelopes remain `pending_validation` until the Worker verifies decryption, content hash, source authority, confidence, task relevance, acceptance quality, and privacy. Missing keys create no usage.

## Worker-only Evidence access

- Production uses separate `janus_api`, `janus_evolution_worker`, and `janus_migrator` PostgreSQL roles.
- The API role may read Evidence metadata and insert Worker-encrypted envelopes, but PostgreSQL denies ciphertext, wrapped-key, and Evidence access-audit reads.
- Only the Worker role decrypts stored Evidence. Allowed, denied, failed, and key-rotation attempts are audited with Worker identity, run, Evidence, purpose, result, key, and timestamp.
- Evidence data keys use RSA-OAEP-SHA256 wrapping and may be rewrapped to a new Worker key without decrypting or rewriting the ciphertext.
- Production upload rejects non-envelope Evidence. SQLite keeps the same validation and audit state contract for tests and local compatibility.

## Section support and privacy Gate

- Proposal prompts use run-local HMAC contributor and Evidence handles; they never expose real user, instance, or Evidence IDs.
- Proposer-supplied support IDs are ignored. A section passes only when deterministic semantic support and an independent reviewer agree on Evidence from at least 3 distinct contributors with confidence of at least 0.8.
- Internal section support mappings remain private. Candidate and market payloads expose only anonymous support counts and review status.
- Deterministic privacy checks cover names/usernames, contacts, credentials, IDs, local paths, URLs, configured unpublished project facts, and phrases attributable to a single user.
- An independent privacy reviewer runs at the Gate, and the final family candidate is scanned again immediately before Shadow.

## Verification checklist

- Shared constants, SQLite checks, and PostgreSQL checks expose the same states.
- Legacy cohort IDs migrate to the canonical ID without reopening consumed evidence.
- Concurrent runs cannot reserve the same cluster evidence.
- Gate, governance, privacy, regression, and mixed rejection retain distinct audit reasons.
- Shadow success alone creates no released market version and no consumed cluster Evidence.
- Opt-in Canary publication creates `market_base` versions in both SQLite and PostgreSQL, consumes only the frozen run Evidence, and never applies candidate sections to non-opted-in Agents.
