# Cloud sync database compatibility requirements

- Use `.agents/skills/safe-database-evolution/SKILL.md` before changing PostgreSQL sync tables, Sync payloads, identity canonicalization, Workspace routing, capabilities, cursors, or conflict handling.
- Keep PostgreSQL storage, the public sync contract, and desktop SQLite schema decoupled. A server table change must not silently change payload semantics.
- Use expand-migrate-contract releases. Preserve the previous contract until supported desktop clients advertise the required protocol and capabilities.
- New identity or Workspace semantics require a versioned capability. Reject or defer incompatible clients before accepting uploads or returning changes; never advance a cursor for changes the client cannot apply.
- Identity merges must be explicit, idempotent operations with a deterministic conflict policy that preserves all conversations and messages.
- Add HTTP/service tests for compatible, missing-contract, obsolete-protocol, missing-capability, duplicate delivery, conflict, and cursor-not-advanced cases.
