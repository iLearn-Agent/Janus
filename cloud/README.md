# Janus Cloud Auth And Friends

This service implements the HTTP contract in `dev/cloud-auth-friends-api.md` for a deployable cloud provider. It is separate from the Electron local SQLite mock, so the desktop local mode remains available.

The PostgreSQL service is the production authority for Sync V6, Device Grants,
cross-device task Memory key recovery, employee governance, social APIs, and
cloud evolution. The SQLite service started by `npm run cloud:serve` remains a
development/legacy Sync V5 compatibility service and must not be used as the
production Sync V6 authority.

## Local Setup

1. Create a PostgreSQL database.
2. Copy `cloud/.env.example` to your deployment environment and set `DATABASE_URL`, `JWT_SECRET`, and SMTP settings.
3. Run migrations:

```bash
npm run cloud:migrate
```

4. Optionally seed an admin:

```bash
SEED_ADMIN_EMAIL=admin@example.com SEED_ADMIN_PASSWORD='change-me-strongly' npm run cloud:seed
```

5. Start the API:

```bash
npm run cloud:start
```

The server listens on `PORT` and exposes authentication, social, sync, employee,
and cloud-authoritative evolution APIs.

## Evolution Worker

Agent evolution is permanently cloud-authoritative. Start the recurring Worker:

```bash
npm run cloud:evolution-worker
```

Run one scheduling pass for operations or cron integration:

```bash
npm run cloud:evolution-worker -- --once
```

Production must use three distinct database login users: an API login that is a
member of `janus_api`, a Worker login that is a member of
`janus_evolution_worker`, and a migration login that is a member of
`janus_migrator`. Configure them through `DATABASE_URL`,
`EVOLUTION_WORKER_DATABASE_URL`, and `DATABASE_MIGRATOR_URL`. The API role can
read Evidence metadata but PostgreSQL denies it access to ciphertext, wrapped
data keys, and Worker access audits.

The Worker requires PostgreSQL, a configured model provider, an active
32-byte base64 evolution key for generated artifacts, and the private half of
the `JANUS_EVOLUTION_WORKER_*` RSA keyring. Desktop and cloud-native Evidence
is encrypted to the public half before it becomes eligible; validation,
decryption success, denial, failure, and key rotation are recorded in the
Worker-only access audit. Production rejects Evidence uploads that do not use
the Worker public-key envelope. Published market versions remain queryable,
adoptable, and rollback-capable while the model is unavailable. Candidate
generation pauses until readiness returns, and publishing additionally remains
blocked until the candidate passes the default-enrollment real-user Canary
contract.

The model provider may be configured either with the
`JANUS_EVOLUTION_PROVIDER_*` variables or with an explicitly selected,
server-owned Codex home through `JANUS_EVOLUTION_CODEX_HOME`. In Codex-home
mode the Worker reads `config.toml` and a mode-`0600` `auth.json` directly;
the API key is not copied into the process environment, API responses,
database rows, or logs. The systemd unit mounts that directory read-only.
The Cloud API receives only the non-secret
`JANUS_EVOLUTION_MODEL_DELEGATED_TO_WORKER=true` readiness marker; it cannot
read the Codex credential files.

Cluster cohorts require at least seven distinct users. A user's normalized
contribution is capped at 15 percent. The default new/reconsiderable evidence
thresholds are 15 total, including at least five chat, three Memory, and five
completed-task items. The four `JANUS_PHASE8_CLUSTER_MIN_*` variables may raise
or lower these thresholds, but the total must be at least the sum of the three
category thresholds.

Every active synchronized Agent instance participates in cluster governance;
legacy cluster-consent fields are ignored. Performance contribution weights use
cloud-derived `performance_90d_100tasks_v2` snapshots. Desktop uploads contain
task-node references only, and cloud task records determine quality,
reliability, first-pass, peer-normalized efficiency, collaboration, Evidence
completeness, and safety inputs. Market adoption, rejection, and rollback
actions feed both personal and cluster Evidence Ledgers without satisfying the
required chat, Memory, or completed-task category floors.

After Shadow passes, every eligible active synchronized Agent is enrolled in
the real-user Canary by default. Users may opt an Agent out, or explicitly
rejoin it, through the compatibility route
`POST /v1/evolution/market/canary/opt-in`; an explicit opt-out is preserved by
later Worker reconciliation. The Worker enrolls at least seven distinct users,
observes at least seven cloud-validated terminal task cases, and publishes only
after the minimum duration and regression/safety checks pass.
`JANUS_MARKET_CANARY_MIN_DURATION_MS` and
`JANUS_MARKET_CANARY_MAX_DURATION_MS` control the observation window. A
published version is a complete immutable `market_base`; users still choose
full or section-level adoption, and personal overlays remain highest priority
unless the user explicitly resolves a conflict in favor of the market rule.

`JANUS_CLOUD_EVOLUTION_AUTHORITY`, `JANUS_PHASE8_EVOLUTION_ENABLED`,
`JANUS_PERSONAL_EVOLUTION_V2`, `JANUS_LOCAL_EVOLUTION_ENABLED`,
`JANUS_EVOLVE_ENABLED`, and `JANUS_CLUSTER_EVOLUTION_V2` are deprecated and
ignored. Do not use them in deployment configuration.

## Sync V6

Sync V6 uses a per-device Grant rather than a packaged global sync token. A
login Access Token may register a device and bootstrap its token, but ordinary
sync, file, key-recovery, and evolution requests use the Device Grant. The first
device is approved automatically; later devices remain pending until an
approved device accepts them. Token issuance requires an RSA private-key proof
from the registered device and rejects reused nonces.

Files are stored in S3-compatible object storage under a per-user SHA-256 key.
The server issues short-lived presigned URLs, enforces the 60 MB limit, and
verifies both object length and the SHA-256 checksum before enabling downloads.
Configure the `JANUS_S3_*` variables in `.env.example`. Unreferenced verified
objects receive a seven-day grace period before opportunistic cleanup.

The V7 reliability layer persists desktop upload batches for exact retry,
compacts retained change rows into per-user snapshots, and returns a snapshot
before newer changes when a device cursor falls behind the compaction boundary.
`JANUS_HTTP_JSON_LIMIT` controls the bounded JSON request envelope size and
defaults to `2mb`, allowing Sync V6 batches larger than Express's 64 KB default.
`JANUS_SYNC_V6_COMPACTION_CHANGE_THRESHOLD`,
`JANUS_SYNC_V6_BATCH_RATE_LIMIT`, `JANUS_SYNC_V6_RATE_LIMIT_WINDOW_MS`, and
`JANUS_SYNC_V6_STORAGE_QUOTA_BYTES` control compaction, per-device batch rate,
and per-user file storage. Pending uploads reserve quota. Device-grant callers
with `sync:read` can inspect their own isolated counters at
`GET /v1/sync/v6/metrics`.

Cross-device task Memory recovery requires the `JANUS_TASK_MEMORY_CLOUD_*`
RSA keyring. The cloud unwraps only the task DEK, immediately rewraps it to the
approved target device public key, and never returns task plaintext or a
plaintext DEK.

## Deployment Notes

- Use PostgreSQL 14+ or a compatible managed PostgreSQL service.
- Set `JWT_SECRET` and `EMAIL_CODE_SECRET` to long random values. Do not reuse the example values.
- Configure one mail provider through SMTP environment variables. Resend or SendGrid SMTP credentials work through the same settings.
- Put the service behind HTTPS. Access tokens are bearer tokens and refresh tokens are opaque secrets.
- Keep S3 credentials and task Memory cloud private keys only on the cloud host.
- Run `npm run cloud:migrate` during release before starting the new process.
- Run `npm run cloud:rehearse-evolution-security` against a disposable real
  PostgreSQL database before release. A skipped rehearsal is a failed release
  gate; it verifies API ciphertext denial, Worker decryption, RLS, and audit
  isolation.
- Run `npm run cloud:gate:postgres-production` before release. This gate fails
  when a real PostgreSQL URL is missing and serially verifies migrations, Sync,
  employee locking, Worker security, cohort claims, and production-only tails.
- `npm run cloud:gate:evolution-stage2-4` runs the full Stage 2–4 contract,
  outbox/backfill smoke, and the mandatory real-PostgreSQL security rehearsal.

## Security Guarantees

- Passwords are stored as PBKDF2-SHA256 hashes with per-password random salts.
- Email verification codes are stored as HMAC hashes and are never returned by cloud HTTP responses.
- Refresh tokens are opaque random tokens; only HMAC hashes are stored in `refresh_tokens`.
- All friends endpoints require `Authorization: Bearer <accessToken>`.
- Errors use the documented `{ "error": { "code", "message", "details" } }` shape.

## Tests

```bash
npm run cloud:test
```

The test suite exercises the real HTTP routes against the same SQL migrations using an in-memory PostgreSQL-compatible test database.
