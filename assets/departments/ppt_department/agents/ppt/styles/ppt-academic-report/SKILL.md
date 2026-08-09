---
name: ppt-academic-report
description: Evidence-first academic-report style Skill for the Janus PPT Designer. Apply only when the selected styleId is academic_report for paper talks, research updates, course reports, defenses, scientific explanation, or benchmark-oriented decks.
---

# Skill: Academic Report PPT Style

## Inheritance and Scope

- Apply this file only together with the common `ppt` Skill.
- Use it only when the effective `styleId` is `academic_report`.
- Change narrative, layout preference, evidence emphasis, and visual tone only. Never change the common renderer contract, output schema, factual integrity requirements, editability requirements, privacy boundary, or Agent identity.

## Narrative and Layout

- Use an evidence-first arc: motivation -> gap/challenge -> objective -> method/system -> experiment/evidence/demo -> result -> limitation -> next work.
- For multi-project updates use overview -> module motivation -> objective -> method -> cases/demos -> limitation -> next module -> synthesis.
- Prefer `method_loop`, `benchmark_metrics`, `results_bars`, `leaderboard_table`, `ablation_matrix`, source-figure pages, and editable scientific diagrams.
- Treat every exact benchmark, dataset, venue, citation, result, and limitation as unverified until supported by the provided material or a cited source. Keep limitations explicit.
- Use restrained publication-grade scientific hierarchy and avoid marketing-style hero pages or decorative scientific imagery.

## Page-Library Contract

- For `challenge_map`, emit 1-4 `nodes` shaped as `{label, detail}` or 1-4 `risks` shaped as `{risk, impact, mitigation}`.
- For `method_pipeline`, emit 1-5 `steps` plus `input` and `output`.
- For `method_loop`, emit 3-4 `steps` or `stages`, each shaped as `{label, detail}`, plus `objective`.
- For `benchmark_metrics`, emit 1-4 `kpis` shaped as `{value, label, note}` or `{group, metrics:[...]}`, plus `protocol`; use `headers` and array-shaped `rows` for a real comparison table.
- Use `evidence_grid` and `case_gallery` only when real source/generated images will exist, or emit 1-6/1-5 substantive text `cards` shaped as `{title, points}`. Never emit generic labels such as "Evidence 1" or "Case 1".
- Use `media_showcase` only when one real source or generated image will exist. Otherwise choose `method_pipeline`, an evidence layout with substantive cards, or `basic_content`.
- For `summary_takeaways`, emit 1-3 `points` or `cards`, plus optional `conclusion` and `next_step`.
- Treat all item counts as maxima rather than targets. Emit only content supported by real material so the renderer can remove and reflow unused slots.
- For every table, emit `headers` plus array-shaped `rows` whose cell order exactly matches the headers. Never rely on dictionary key order or create empty columns.
- Keep `content_spec.title` identical to the Markdown table title.

## Evidence and Slide Design

- Treat every exact figure/table number, benchmark, dataset, metric, paper status, author claim, venue, and limitation as unverified until it appears in the provided material or a cited source.
- If source extraction is partial, use conservative wording, mark assumptions in `speaker_note`, and never invent citations or numbers.
- Preserve source anchors such as section, page, figure, or table references when available. If a referenced figure has not been visually verified, describe it generically or mark it for verification.
- Give every substantive slide one dominant proof object: source figure, method diagram, system pipeline, benchmark table, result chart, ablation matrix, case gallery, or limitation analysis.
- Keep formulas, method names, labels, values, citations, and diagrams editable. Prefer 2-4 compact audience-visible points and place construction instructions only in `visual`.
- For one page comparing several real figures or cases, list the source figures in display order and provide ordered `captions` that match them.
- Use generated visuals only for conceptual support, never for exact scientific evidence. Ground them in the actual scientific subject and keep them text-free.
- Vary page geometry across the deck. For a 10-12 slide academic deck, normally use at least 6 distinct layouts; reuse one layout at most twice and never on adjacent slides unless the content structure requires it.

## Template and Quality Gate

- Honor the selected template as the brand/chrome base. Without a selected template, use a clean academic light canvas with dark ink, restrained blue/teal accents, and stable title/footer treatment.
- Verify before delivery that every slide has a clear academic claim, exact claims are grounded, scientific visuals are editable or correctly sourced, visible text fits, layouts are varied, and limitations and next steps are explicit when relevant.

## Robustness

- Separate claims, methods, evidence, limitations, and next work so that uncertainty remains visible.
- Use `basic_content` instead of forcing a benchmark or scientific diagram when the source material does not support one.
- Preserve explicit user instructions and selected-template branding when they conflict with a stylistic preference in this file, but never relax evidence requirements.
