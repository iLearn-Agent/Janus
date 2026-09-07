from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any

from .paths import departments_root


@dataclass(frozen=True)
class HrDefinition:
    id: str
    name: str
    description: str
    system_prompt: str
    debate_prompt: str


@dataclass(frozen=True)
class DepartmentDefinition:
    id: str
    name: str
    description: str
    hr: HrDefinition


@dataclass(frozen=True)
class AgentDefinition:
    id: str
    name: str
    description: str
    department_id: str
    department_name: str
    hr_id: str
    hr_name: str
    skills: list[str]
    system_prompt: str
    self_evolution_prompt: str
    evolution_interval_hours: int = 24
    min_messages_for_evolution: int = 5


@dataclass(frozen=True)
class Organization:
    departments: dict[str, DepartmentDefinition]
    agents: dict[str, AgentDefinition]


def _require_str(data: dict[str, Any], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Config missing string field: {key}")
    return value.strip()


def _load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError(f"Expected JSON object in {path}")
    return data


def _skills(data: dict[str, Any]) -> list[str]:
    skills = data.get("skills", [])
    if not isinstance(skills, list) or not all(isinstance(item, str) for item in skills):
        raise ValueError("Agent config field 'skills' must be a list of strings")
    return skills


def _load_department(path: Path) -> DepartmentDefinition:
    data = _load_json(path / "department.json")
    hr_data = _load_json(path / "hr" / "agent.json")
    hr = HrDefinition(
        id=_require_str(hr_data, "id"),
        name=_require_str(hr_data, "name"),
        description=_require_str(hr_data, "description"),
        system_prompt=_require_str(hr_data, "system_prompt"),
        debate_prompt=_require_str(hr_data, "debate_prompt"),
    )
    return DepartmentDefinition(
        id=_require_str(data, "id"),
        name=_require_str(data, "name"),
        description=_require_str(data, "description"),
        hr=hr,
    )


def _load_agent(path: Path, department: DepartmentDefinition) -> AgentDefinition:
    data = _load_json(path)
    evolution = data.get("evolution", {})
    if not isinstance(evolution, dict):
        evolution = {}
    return AgentDefinition(
        id=_require_str(data, "id"),
        name=_require_str(data, "name"),
        description=_require_str(data, "description"),
        department_id=department.id,
        department_name=department.name,
        hr_id=department.hr.id,
        hr_name=department.hr.name,
        skills=_skills(data),
        system_prompt=_require_str(data, "system_prompt"),
        self_evolution_prompt=_require_str(data, "self_evolution_prompt"),
        evolution_interval_hours=int(evolution.get("interval_hours", 24)),
        min_messages_for_evolution=int(evolution.get("min_messages", 5)),
    )


def load_organization(root: Path | None = None) -> Organization:
    base = departments_root(root)
    departments: dict[str, DepartmentDefinition] = {}
    agents: dict[str, AgentDefinition] = {}
    for directory in sorted(path for path in base.iterdir() if path.is_dir()):
        if not (directory / "department.json").exists():
            continue
        department = _load_department(directory)
        if department.id in departments:
            raise ValueError(f"Duplicate department id: {department.id}")
        departments[department.id] = department
        for agent_path in sorted((directory / "agents").glob("*/agent.json")):
            raw_agent = _load_json(agent_path)
            if raw_agent.get("enabled") is False:
                continue
            agent = _load_agent(agent_path, department)
            if agent.id in agents:
                raise ValueError(f"Duplicate agent id: {agent.id}")
            agents[agent.id] = agent
    if not departments:
        raise FileNotFoundError(f"No departments found in {base}")
    if not agents:
        raise FileNotFoundError(f"No department agents found in {base}")
    return Organization(departments=departments, agents=agents)


def load_agent_definitions(root: Path | None = None) -> dict[str, AgentDefinition]:
    return load_organization(root).agents


def load_department_definitions(root: Path | None = None) -> dict[str, DepartmentDefinition]:
    return load_organization(root).departments


def render_agent_skill(agent: AgentDefinition) -> str:
    skills = "\n".join(f"- {item}" for item in agent.skills)
    return f"""# Skill: {agent.name}

## Role

{agent.description}

## Department

{agent.department_name} (`{agent.department_id}`)

## Core Procedures

{skills}

## Skill Selection

Use progressive disclosure. Treat this file as a catalog of reusable procedures:
first identify the relevant section for the user's current task, then apply only
the matching procedures plus approved memory. If no section fits, work from the
core role and ask for missing task details.

## Operating Contract

{agent.system_prompt}

## Self-Evolution Contract

After a task is complete, review only the current task trace plus approved memory.
Propose improvements as a reviewable patch. Do not silently preserve private user
facts, raw unpublished results, credentials, or manuscript text. Prefer reusable
rubrics, templates, checklists, eval cases, and failure-mode corrections.

{agent.self_evolution_prompt}

## Memory Hygiene

- Keep durable memory compact and reusable.
- Prefer stable preferences, task rubrics, and recurring failure modes.
- Drop one-off project details unless the user explicitly asks to preserve them.
- If memory grows noisy, propose a compressed replacement instead of appending.
"""


def render_hr_skill(department: DepartmentDefinition, agents: list[AgentDefinition]) -> str:
    agent_lines = "\n".join(f"- `{agent.id}`: {agent.name} - {agent.description}" for agent in agents)
    return f"""# Skill: {department.hr.name}

## Role

{department.hr.description}

## Department

{department.name} (`{department.id}`)

## Managed Agents

{agent_lines}

## Operating Contract

{department.hr.system_prompt}

## Debate And Organization Review

{department.hr.debate_prompt}

## Governance Rules

- Review agent skills, approved memory, recent self-evolution proposals, and redacted usage patterns.
- Convene a written debate among managed agents before recommending structural changes.
- Recommend new agents only when a repeated task style, research branch, or workflow has stable demand.
- Prefer narrower specialist agents when a broad agent develops conflicting styles or methods.
- Do not expose user-private chats, unpublished data, credentials, or manuscript-specific content.
- Output proposals as reviewable organization changes; do not directly rewrite department structure during debate.
"""
