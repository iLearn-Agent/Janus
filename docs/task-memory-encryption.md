# Task Memory encryption

Task-scoped Memory versions are encrypted locally with AES-256-GCM. Each task has a random 32-byte data-encryption key (DEK); the plaintext DEK is never stored in SQLite or included in Cloud Sync payloads.

## Local envelope

- The task DEK is wrapped with a device-local AES-256-GCM key.
- The device key is stored at `<JANUS_HOME>/data/task-memory-device-key.json` with mode `0600` where the platform supports POSIX permissions.
- The same file is upgraded in place with an RSA-OAEP recovery keypair. Existing AES KEK IDs and wrapped task keys are preserved.
- This is a local file boundary, not an OS keychain or hardware-backed KMS.
- Migration backups copy the device key beside the database backup as `*.task-memory-key.json`; the restore script restores both files together.
- Existing plaintext Memory versions remain readable as legacy data. New task Memory versions are encrypted lazily without deleting old content.

## Cloud envelope

Cloud access uses an RSA-OAEP-SHA256 envelope around the same task DEK. The desktop receives only a public key. Cloud services retain the matching private key and decrypt only when the task security context is active and its explicit cloud authorization is enabled.

Configure the desktop/cloud public key capability with:

```text
JANUS_TASK_MEMORY_CLOUD_ACTIVE_KEY_ID=<key-id>
JANUS_TASK_MEMORY_CLOUD_PUBLIC_KEYS_JSON={"<key-id>":"<PEM public key>"}
```

Configure the private key only on cloud services:

```text
JANUS_TASK_MEMORY_CLOUD_PRIVATE_KEYS_JSON={"<key-id>":"<PEM private key>"}
```

Keep old private keys during key rotation until every active envelope has been rewrapped. Never put the private-key JSON in a desktop configuration or sync payload.

## Authorization and revocation

- Enabling task cloud evolution creates or activates the cloud envelope only when a cloud public key is available.
- Until then, the envelope state remains `pending` and encrypted task evidence is not usable by cloud evolution.
- Cloud evolution and explicit cloud collaboration are independent authorizations. Revoking evolution disables future evolution reads; the envelope remains active only when an explicit collaboration publication still requires it. Otherwise the context becomes `revoked`.
- Evolution services must require `cloud_evolution_allowed` plus an `active` envelope. Work-Memory services must validate their publication, membership, visibility, and leadership rules independently.
- Cloud Sync sends task ciphertext and the cloud envelope, but removes the device-local wrapped key, nonce, tag, and device wrapping-key ID.
- `cloud_sync_recovery_allowed` is independent from evolution and collaboration consent. Recovery returns a DEK wrapped to the approved requesting device public key; the desktop verifies AES-GCM and `content_hash` before storing a new local KEK envelope.
- Revoking a device immediately invalidates its Device Grant and all active per-device task key envelopes.
