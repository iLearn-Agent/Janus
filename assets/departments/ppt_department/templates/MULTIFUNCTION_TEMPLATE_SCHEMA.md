# Janus Multi-function PPT Template Schema

Schema version: `janus-multifunction-v1`

## Rendering contract

- A school template is an editable slide library, not only a theme or background.
- Slide 1 is the cover source.
- Functional source slides are discovered by a `tpl-title-*` shape whose text is a registered `layout_id`.
- The renderer clones only the pages required by the deck plan, fills semantic shapes, then removes the unused library pages.
- School templates may change colors, masters, fonts, logos, and geometry, but templates sharing this schema must keep the semantic shape names required by the renderer.

## Functional pages

`basic_content`, `motivation_compare`, `challenge_map`, `method_pipeline`, `method_loop`, `benchmark_metrics`, `result_big_numbers`, `results_bars`, `leaderboard_table`, `ablation_matrix`, `evidence_grid`, `case_gallery`, `summary_takeaways`, `project_target_map`, `domain_object_map`, `technical_route`, `workpackage_matrix`, `evaluation_dashboard`, `risk_action_table`, `milestone_roadmap`, and `media_showcase`.

## Agent contract

The PPT style skill chooses a semantic `layout_id` and emits `content_spec`. It must not depend on template page numbers or PowerPoint shape names. Common semantic keys include:

`points`, `current`, `target`, `gap`, `input`, `output`, `steps`, `kpis`, `bars`, `headers`, `rows`, `table`, `captions`, `cards`, `nodes`, `layers`, `stages`, `risks`, `milestones`, `objective`, `protocol`, `scope`, `conclusion`, and `next_step`.

KPI/bar items may set `primary`, `highlight`, `best`, or `is_primary` to request the single main emphasis. Without an explicit flag, the renderer uses semantic labels such as `ours`, `primary`, `核心`, or `本方案` and keeps all other metrics visually secondary.

## Layout-specific content contract

The following shapes are semantic contracts. Item counts are upper bounds; the renderer removes and reflows unused cards instead of leaving empty placeholders.

- `basic_content`: `points` (1-5), optional `caption`, `proof_object`, `visual_label`.
- `motivation_compare`: `current` and `target` as `{label, points:[...]}`, plus `gap`; optional `row` with four cells.
- `challenge_map`: `nodes` (1-4) as `{label, detail}` or `risks` (1-4) as `{risk, impact, mitigation}`; optional `objective/core`, `note`.
- `method_pipeline`: `input`, `steps` (1-5; string or `{label, detail}`), and `output`; optional five-cell `row`.
- `method_loop`: `steps` or `stages` (3-4; `{label, detail}`), `objective`, optional `guardrail`.
- `benchmark_metrics`: `kpis` (1-4) as `{value, label, note}` or `{group, metrics:[...]}`, `protocol`, optional `headers/rows/table`.
- `result_big_numbers`: `kpis` (1-3) and `interpretation`.
- `results_bars`: `bars` (1-4) as `{label, value}`, optional `points` notes.
- `leaderboard_table`: `headers` (5) and `rows` (up to 6), optional `points` notes.
- `ablation_matrix`: `headers` (6), `rows` (up to 5), `conclusion`, optional `guide`.
- `evidence_grid`: use only with actual evidence images or 1-6 text `cards` as `{title, points}`; optional `captions`.
- `case_gallery`: use only with actual case images/screenshots or 1-5 text `cards` as `{title, points}`; optional `captions`, `main_label`.
- `media_showcase`: requires a real attachment/generated image. Without an image the renderer automatically chooses `method_pipeline`, `evidence_grid`, or `basic_content` from the supplied semantic data.
- A slide may receive multiple source images. `evidence_grid` supports 2-6 images and `case_gallery` supports 2-5 images; one image automatically uses the larger `basic_content` composition. Captions bind in image order.
- `summary_takeaways`: `points` or `cards` (1-3), optional `conclusion`, `next_step`.
- `project_target_map`: `objective`, `nodes` (1-4), optional four-cell `row`.
- `domain_object_map`: `layers`, `nodes` (1-5), optional `legend`.
- `technical_route`: `stages` (1-4) as `{title, task}`, optional `dependency`.
- `workpackage_matrix`: `headers` (6), `rows` (up to 5), optional `note`.
- `evaluation_dashboard`: `kpis` (1-3), `bars` (1-3), `status_rows` (up to 3), optional `scope`.
- `risk_action_table`: `risks` or `rows` (up to 5), optional `rule`.
- `milestone_roadmap`: `milestones` (1-6) as `{time, title, deliverable}`, optional `note`.

Do not choose an image-dependent layout merely to obtain visual variety. Use an editable diagram/table layout when no image asset will exist.

## Deck rhythm

- Layout selection is deck-aware: it scores semantic-compatible alternatives using recent layout family, density, and repetition count.
- Safe substitutions include `basic_content` → `summary_takeaways`, `summary_takeaways` → text-card `evidence_grid`, `method_pipeline` ↔ `technical_route`, `evidence_grid` ↔ `case_gallery`, and KPI-only `benchmark_metrics` ↔ `result_big_numbers`.
- A substitution must preserve the supplied semantic content. Dense tables, risk matrices, and other specialized structures are not replaced merely for variety.
- The school cover is locked and excluded from rhythm substitutions and body safe-area repairs.
- When two dense pages are semantically unavoidable, the renderer keeps both and emits a traceable warning rather than discarding information.

## Validation

Before rendering, the backend verifies the 16:9 slide size, required functional pages, title markers, and layout-specific semantic shapes. A failed validation uses the legacy renderer as a compatibility fallback.

After binding, the backend also checks title fidelity, semantic-slot coverage, leftover placeholder text, required image availability, language consistency, body safe-area bounds, empty semantic cards, duplicated long text, excessive strong emphasis, missing result conclusions, adjacent dense pages, and repeated layout families. Safe-area overflow is repaired before save. QA must preserve full semantic titles and retain the best-scoring render attempt.
