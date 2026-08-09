# Janus repository guidance

## Scope

- Janus is a local-first Electron desktop application with Codex-backed agents, a Node.js main process, a browser renderer, SQLite storage, and optional cloud/social services.
- Keep changes focused on the requested outcome. Preserve unrelated staged, unstaged, and untracked user work.
- Follow a closer nested `AGENTS.md` if one is added under the area you are editing.

## Working conventions

- Read the relevant implementation and existing tests before changing behavior.
- Use `.agents/skills/safe-database-evolution/SKILL.md` for any SQLite/PostgreSQL schema, migration, Sync contract, identity/Workspace mapping, recovery, quarantine, or persisted-user-data change.
- Use the selected project directory as the working directory for project chats; do not create or silently substitute a missing project directory.
- Treat credentials, private project data, unpublished material, and local absolute paths as confidential.
- Do not claim a command, test, artifact, deployment, or external action succeeded unless it was actually verified.
- For diagnosis or review requests, report evidence first and do not implement a fix unless the request includes implementation.
- For implementation requests, continue through proportionate verification while safe in-scope work remains.

## Resource safety

- Keep all repository searches rooted at the selected repository checkout. Never search a parent directory for a repository task.
- Use `rg` without `--follow`/`-L`. Do not use `--no-ignore` for broad searches. Prefer explicit source paths such as `src`, `scripts`, `assets`, `cloud`, and `network` instead of an unbounded filesystem walk.
- Treat `workspace/`, `test-artifacts/`, `node_modules/`, `dist/`, `data/`, `departments/`, and other generated/runtime directories as out of scope unless the task explicitly requires one of them.
- Run CPU-, I/O-, or memory-heavy checks sequentially. Do not launch multiple test suites, package installs, Electron instances, or broad searches in parallel.
- Run commands expected to take more than 30 seconds through `node scripts/run_guarded.mjs -- <command>`. The guard enforces one long command at a time, lowers its scheduling priority, applies a timeout, and stops it if server pressure remains unsafe.
- Before starting a long validation phase, inspect server load and available memory. If the guard refuses to start, do not bypass it; report the resource pressure and wait for it to fall.
- Stop and clean up child processes after a timeout, failed smoke test, or interrupted command. Never leave watchers, dev servers, Electron processes, or test runners running unless the user explicitly requested persistent monitoring.

## Main areas

- `src/main/`: Electron main-process runtime, Codex integration, persistence, scheduling, and artifact services.
- `src/renderer/`: desktop UI and renderer state.
- `src/preload/`: IPC bridge exposed to the renderer.
- `assets/system_agents/` and `assets/departments/`: bundled agent definitions, skills, and memories.
- `scripts/`: validation, smoke tests, packaging, and development entry points.
- `cloud/` and `network/`: optional server and network clients.

## Validation

- Run `node scripts/run_guarded.mjs -- node scripts/check.mjs` for the primary repository checks.
- Run `node scripts/run_guarded.mjs -- node scripts/fake_codex_e2e.mjs` when changing Codex execution, routing, prompts, sessions, goals, projects, or persistence.
- Run the narrowest relevant renderer smoke when changing UI behavior. Electron renderer tests may require an X server or `xvfb-run` on Linux.
- Run `git diff --check` before handoff.
- Do not run release, publish, signing, deployment, or destructive commands unless the user explicitly requests them.
