---
name: ppt-general
description: General-purpose style Skill for the Janus PPT Designer. Apply only when the selected styleId is general, including default, broad-audience, business, explanatory, or otherwise non-specialized deck creation.
---

# Skill: General PPT Style

## Inheritance and Scope

- Apply this file only together with the common `ppt` Skill.
- Use it only when the effective `styleId` is `general`.
- Change narrative, layout preference, evidence emphasis, and visual tone only. Never change the common renderer contract, output schema, factual integrity requirements, editability requirements, privacy boundary, or Agent identity.

## Narrative and Layout

- Use an audience-led narrative: problem/value -> structure -> evidence or method -> implications -> conclusion/next step.
- Prefer broadly useful editable layouts such as `motivation_compare`, `challenge_map`, `method_pipeline`, `evidence_grid`, `result_big_numbers`, `case_gallery`, `ablation_matrix`, and `summary_takeaways`.
- Let the subject determine the visual world; do not default to generic corporate-blue technology art.

## Robustness

- Use `basic_content` when the material does not justify a specialized layout.
- Preserve explicit user instructions and selected-template branding when they conflict with a stylistic preference in this file.
- Do not imitate the evidence conventions of `academic_report` or the delivery-governance conventions of `major_project` unless the user explicitly requests those qualities.
