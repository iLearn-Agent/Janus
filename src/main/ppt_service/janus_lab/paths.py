from __future__ import annotations

import os
from pathlib import Path


def workspace_root() -> Path:
    return Path(os.environ.get("JANUS_WORKSPACE", os.getcwd())).resolve()


def state_root(root: Path | None = None) -> Path:
    root = root or workspace_root()
    return Path(os.environ.get("JANUS_STATE_DIR", str(root / ".janus"))).resolve()


def db_path(root: Path | None = None) -> Path:
    root = root or workspace_root()
    return Path(os.environ.get("JANUS_DB_PATH", str(root / "data" / "janus.db"))).resolve()


def legacy_db_path(root: Path | None = None) -> Path:
    return state_root(root) / "janus.db"


def agents_dir(root: Path | None = None) -> Path:
    root = root or workspace_root()
    return root / "agents"


def departments_root(root: Path | None = None) -> Path:
    root = root or workspace_root()
    return root / "departments"


def department_dir(department_id: str, root: Path | None = None) -> Path:
    return departments_root(root) / department_id


def department_agents_dir(department_id: str, root: Path | None = None) -> Path:
    return department_dir(department_id, root) / "agents"


def department_hr_dir(department_id: str, root: Path | None = None) -> Path:
    return department_dir(department_id, root) / "hr"


def agent_dir(department_id: str, agent_id: str, root: Path | None = None) -> Path:
    return department_agents_dir(department_id, root) / agent_id


def hr_dir(department_id: str, root: Path | None = None) -> Path:
    return department_hr_dir(department_id, root)


def codex_template_dir(root: Path | None = None) -> Path:
    root = root or workspace_root()
    return root / "config" / "codex"


def memory_file(department_id: str, agent_id: str, root: Path | None = None) -> Path:
    return agent_dir(department_id, agent_id, root) / "MEMORY.md"


def skill_file(department_id: str, agent_id: str, root: Path | None = None) -> Path:
    return agent_dir(department_id, agent_id, root) / "SKILL.md"


def agent_config_file(department_id: str, agent_id: str, root: Path | None = None) -> Path:
    return agent_dir(department_id, agent_id, root) / "agent.json"


def hr_memory_file(department_id: str, root: Path | None = None) -> Path:
    return hr_dir(department_id, root) / "MEMORY.md"


def hr_skill_file(department_id: str, root: Path | None = None) -> Path:
    return hr_dir(department_id, root) / "SKILL.md"


def hr_config_file(department_id: str, root: Path | None = None) -> Path:
    return hr_dir(department_id, root) / "agent.json"


def evolution_dir(department_id: str, agent_id: str, root: Path | None = None) -> Path:
    return agent_dir(department_id, agent_id, root) / "evolution"


def hr_debate_dir(department_id: str, root: Path | None = None) -> Path:
    return hr_dir(department_id, root) / "debates"


def codex_temp_home(identity: str, root: Path | None = None, role: str = "agent") -> Path:
    safe_identity = identity.replace("/", "_").replace("\\", "_")
    return tmp_dir(root) / "codex" / role / safe_identity


def tmp_dir(root: Path | None = None) -> Path:
    return state_root(root) / "tmp"
