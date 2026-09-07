# Application logging

Janus Desktop writes production diagnostics as JSON Lines with a `.log`
extension. Logging is local-only and does not upload telemetry.

## Storage

- Stable packaged app: `~/.janus/logs/`
- Test packaged app: `~/.janus-test/logs/`
- Explicit runtime home: `$JANUS_HOME/logs/`
- Explicit logging override: `$JANUS_LOG_DIR/`

The active file is `janus.log`. It rotates at 10 MiB or at a UTC date
boundary. Rotated files and local crash dumps are retained for 14 days, with a
200 MiB cap for the managed logging directory.

## Privacy

Production records contain lifecycle events, levels, durations, errors, and
correlation identifiers. Prompts, conversations, model answers, file contents,
process stdin/stdout/stderr, credentials, and authentication fields are removed
or redacted before writing.

The Settings > Diagnostics and Logs page can open the managed directory, clear
old files, or export the retained JSON Lines into a single
`Janus-Diagnostics-<timestamp>.log` file. Export is user-initiated and excludes
databases, configuration files, environment variables, and binary crash dumps.

## Configuration and checks

Set `JANUS_LOG_LEVEL` to `debug`, `info`, `warn`, or `error`. Packaged builds
default to `info`; development builds default to `debug`.

Run the focused smoke with:

```bash
npm run test:logging
```

The repository check, fake Codex E2E, and renderer settings smoke also verify
the logging integration and privacy boundary.
