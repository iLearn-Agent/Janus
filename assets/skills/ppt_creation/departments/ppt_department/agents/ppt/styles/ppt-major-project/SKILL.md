---
name: ppt-major-project
description: Decision-oriented major-project style Skill for the Janus PPT Designer. Apply only when the selected styleId is major_project for project proposals, construction plans, implementation programs, milestone reviews, acceptance reports, or industrial delivery decks.
---

# Skill: Major Project PPT Style

## Inheritance and Scope

- Apply this file only together with the common `ppt` Skill.
- Use it only when the effective `styleId` is `major_project`.
- Change narrative, layout preference, evidence emphasis, and visual tone only. Never change the common renderer contract, output schema, factual integrity requirements, editability requirements, privacy boundary, or Agent identity.

## Narrative and Layout

- Use a decision-oriented arc: background/target -> object modeling -> data/scenarios -> technical route -> modules -> evaluation -> results -> weaknesses/risks -> next actions -> conclusion.
- Prefer `project_target_map`, `domain_object_map`, `technical_route`, `workpackage_matrix`, `evaluation_dashboard`, `risk_action_table`, `milestone_roadmap`, and `summary_takeaways`.
- Connect targets to modules, evidence, deliverables, milestones, risks, or acceptance criteria. Never invent dates, budgets, partners, owners, progress, or acceptance status.
- Keep technical routes, dashboards, schedules, risks, labels, and metrics editable. Use credible engineering/industrial visual language rather than futuristic HUD styling.

## Page-Library Contract

- For `project_target_map`, emit `objective`, 1-4 `nodes`, and an optional four-cell `row`. Emit the row only when every cell contains real output, indicator, acceptance, or owner information; never create an empty acceptance row.
- For `domain_object_map`, emit `layers`, 1-5 `nodes`, and an optional `legend`. Use it only for real object, state, or topology relationships; use `evidence_grid`, `challenge_map`, or a comparison layout for category lists and fit comparisons.
- For `technical_route`, emit 1-4 `stages` shaped as `{title, task}` plus optional `dependency`.
- For `workpackage_matrix`, emit six-column `headers` and no more than five array-shaped `rows`. Never invent owners, dates, or status.
- For `evaluation_dashboard`, emit 1-3 `kpis`, 1-3 real `bars`, no more than three `status_rows`, and optional `scope`. Never invent bar values. Use `{label, status, detail}` when status is known; otherwise use `{dimension, signals, purpose}`.
- For `risk_action_table`, emit no more than five `risks` shaped exactly as `{risk, trigger, impact, action, owner}`. Omit `owner` when unknown and never put mitigation text in the owner field.
- For `milestone_roadmap`, emit 1-6 `milestones` shaped as `{time, title, deliverable}`.
- Use `media_showcase` only when one real source or generated image will exist. Otherwise choose an editable route, matrix, or `basic_content` page.
- For `summary_takeaways`, emit 1-3 `points` or `cards`, plus optional `conclusion` and `next_step`.
- Treat all item counts as maxima rather than targets. Emit only content supported by real material so the renderer can remove and reflow unused slots.
- For every generic table, emit `headers` plus array-shaped `rows` whose cell order exactly matches the headers. Never rely on dictionary key order.
- Keep `content_spec.title` identical to the Markdown table title.

## Evidence and Slide Design

- Connect every important target to a method/module, evidence/result, deliverable, milestone, risk, or acceptance criterion when available.
- Distinguish achieved, in progress, blocked, not started, not evidenced, and proposed states. If evidence is missing, state `待补充依据` or explain the gap in `speaker_note`.
- Give every substantive slide one dominant proof object: target map, object model, scenario map, technical route, module pipeline, evaluation dashboard, result chart, comparison matrix, deliverable tracker, risk table, milestone lane, or decision matrix.
- Avoid generic card grids and slogan pages. Use cards only when they encode real stages, objects, deliverables, risks, indicators, owners, or decisions.
- Keep schedules, labels, owners, metrics, values, status tags, architecture labels, and matrices editable. Place construction instructions only in `visual`.
- For multi-case or before/after evidence, list source figures in display order and provide ordered captions that match them.
- Use generated visuals only for supporting cover or context imagery, never for exact project evidence. Ground them in the real machinery, infrastructure, environment, operational action, viewpoint, and lighting; keep them text-free.
- Vary page geometry across the deck. For a 10-12 slide project deck, normally use at least 6 distinct layouts; reuse one layout at most twice and never on adjacent slides unless the content structure requires it.

## Template and Quality Gate

- Honor the selected template as the brand/chrome base. Without a selected template, use a formal technical-report hierarchy with dark ink, a light background, deep-blue primary accents, restrained teal/cyan for flows, gold/orange for milestones or warnings, and neutral gray for secondary structure.
- Verify before delivery that targets are traceable, every number and status is sourced, the technical route is visual, both results and weaknesses are visible when relevant, decision needs are clear, layouts are varied, and text remains readable.

## Robustness

- Distinguish confirmed facts, proposed plans, pending decisions, risks, and assumptions.
- Use `basic_content` instead of manufacturing project controls, milestones, metrics, or responsibilities that the source material does not provide.
- Preserve explicit user instructions and selected-template branding when they conflict with a stylistic preference in this file, but never fabricate delivery evidence.
