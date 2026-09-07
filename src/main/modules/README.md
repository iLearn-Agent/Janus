# Main-process modules

Each directory owns one product capability and exposes supported integration
points through its `index.js`.

- `identity`: authentication/session application API and credential rules.
- `collaboration`: friend, social, delegation, and collaboration application APIs.
- `projects`: workspace validation and project prompt context.
- `orchestration`: task leadership, shared task context, and graph rules.
- `evolution`: proposal, HR review, governance, and rollout rules.
- `artifacts`: file/PPT artifact application APIs and progress rules.
- `codex`: Codex application API and runtime option contracts.
- `cloud`: cloud sync application API.
- `persistence`: SQLite schema and ordered compatibility migrations.
- `settings`: settings persistence adapter.

New modules should separate `domain`, `application`, and `infrastructure` only
where those layers are meaningful. Do not add empty layers or move unrelated
helpers into a generic utility module.

The flat files in `src/main` remain compatibility facades while existing
callers migrate. New feature code should import a module public entry instead
of another module's internal file.
