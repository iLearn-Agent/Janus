# PPT Style Registry

`style_registry.json` is the backend source of truth for PPT expected styles and style-agent routing.

- The only routable and recruitable PPT employee is `ppt`.
- The frontend sends `styleId` values `general`, `academic_report`, or `major_project`; each value loads one style Skill under `agents/ppt/styles/`, while styles remain overlays rather than Agent identities.
- The common `agents/ppt/SKILL.md` owns invariant renderer, editability, factual-integrity, privacy, dependency, and delivery rules. A style Skill may specialize only narrative, layout preference, evidence emphasis, and visual tone.
- Runtime Skill composition validates each style file's frontmatter, includes the active style in the effective Skill hash, and falls back to the `general` style Skill if the requested file is missing or invalid.
- `agent_style_map` remains only for compatibility with historical sessions and artifacts that stored old Agent IDs.
- Shared production capabilities and source-cited research live as internal phases inside the single `ppt` Agent.
- PPT template options are stored under `departments/ppt_department/templates/` and described by `template_registry.json`.
- Prompt aliases are matched against user instructions.
- Explicit unknown style wording creates a new `custom_*` style after generation starts.
- The registry stores reusable style metadata only; it must not store private slide content.
