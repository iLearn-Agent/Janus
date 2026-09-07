# Unified test diagnostics

Janus tests run through `scripts/test_runner.mjs`. The runner executes tests
sequentially, keeps running after independent failures, and writes redacted
diagnostics below `test-artifacts/runs/<run-id>/`.

## Commands

```bash
# Existing required repository suite
npm run check

# Repository suite plus safe Cloud Node tests
npm run test:all

# Targeted diagnosis
npm run test:diagnostic -- --case renderer-auth
npm run test:diagnostic -- --group cloud
npm run test:rerun-failed

# uBuddy complete-chain diagnosis with a retained compact report
npm run test:ubuddy-full-chain

# Retention and capacity cleanup
npm run test:logs:prune
```

Use `node scripts/test_runner.mjs --list` to list stable case IDs. Long server
runs should continue to be launched through `scripts/run_guarded.mjs`.

## Run contents

Every run contains `run.json`, `summary.json`, `summary.md`, `junit.xml`, and a
structured `events.jsonl`. Failed cases additionally retain timestamped stdout,
stderr, combined output, a reproduction command, and collected artifacts.

Electron failures capture a screenshot and a redacted DOM/state snapshot.
Desktop diagnostics add main-process lifecycle, Renderer console, IPC timing,
and renderer recovery events. Codex diagnostics record process lifecycle and
protocol event metadata without prompts or model answers. Cloud diagnostics
record request IDs, status, latency, and errors without request bodies or
authentication headers.

The `ubuddy-full-chain` case always retains a compact successful diagnostic
set: `result.json`, `ubuddy-report.json`, `ubuddy-report.md`, and
`ubuddy-events.jsonl`. The report covers scenario timing, delegation and task
state transitions, execution takeover/recovery, workspace intent, requirement
updates, result submission, attachment upload/download verification,
membership cutoff, group closure, and restart persistence. Raw prompts,
private messages, Memory content, usernames, absolute paths, temporary
databases, and generated workspaces are not copied into these reports.

When `JANUS_TEST_DIAGNOSTICS=1`, uBuddy runtime components append metadata-only
events to the same `ubuddy-events.jsonl`. Outside test or explicitly enabled
diagnostic mode this instrumentation is a no-op.

Set `JANUS_TEST_COLLECT_JOURNAL=1` on a server to attach the failed run's
redacted `janus-cloud` and `janus-evolution-worker` journal window.

## Privacy and retention

Diagnostic text is redacted before it is written. Passwords, access and refresh
tokens, API keys, verification codes, cookies, authorization headers, private
keys, credential-bearing URLs, and email local parts are removed or masked.
Home and temporary paths are normalized.

Successful runs retain summaries for 14 days. Failed runs retain full
diagnostics for 30 days. Automatic capacity cleanup applies only to
`test-artifacts/runs`, with a default 10 GB cap; it never removes installers or
other manually built test packages.
