from __future__ import annotations

import os
from pathlib import Path
import json
import shutil
import subprocess
import tempfile
import tomllib
import uuid

from .paths import codex_template_dir, tmp_dir


class CodexUnavailable(RuntimeError):
    pass


DEFAULT_CODEX_SANDBOX = os.environ.get("JANUS_CODEX_SANDBOX", "danger-full-access")


def _is_windowsapps_path(path: str) -> bool:
    return "WindowsApps" in Path(path).parts


def _local_codex_candidates() -> list[str]:
    candidates: list[Path] = []
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        bin_root = Path(local_app_data) / "OpenAI" / "Codex" / "bin"
        if bin_root.exists():
            candidates.extend(bin_root.glob("*/codex.exe"))
            candidates.extend(bin_root.glob("*/codex"))
    candidates = [path for path in candidates if path.is_file()]
    candidates.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    return [str(path) for path in candidates]


def _can_launch_codex(path: str) -> bool:
    try:
        completed = subprocess.run(
            [path, "--version"],
            text=True,
            capture_output=True,
            timeout=10,
            check=False,
        )
    except OSError:
        return False
    return completed.returncode == 0


def resolve_codex_binary() -> str | None:
    explicit = os.environ.get("JANUS_CODEX_BIN")
    if explicit:
        return explicit
    candidates: list[str] = []
    discovered = shutil.which("codex")
    if discovered and not _is_windowsapps_path(discovered):
        candidates.append(discovered)
    candidates.extend(_local_codex_candidates())
    if discovered and _is_windowsapps_path(discovered):
        candidates.append(discovered)
    for candidate in candidates:
        if _can_launch_codex(candidate):
            return candidate
    return discovered if discovered and not _is_windowsapps_path(discovered) else None


def codex_binary_diagnostics() -> str:
    discovered = shutil.which("codex")
    local = _local_codex_candidates()
    lines = [
        f"shutil.which('codex') = {discovered or '(not found)'}",
        "local Codex candidates:",
    ]
    lines.extend(f"- {item}" for item in local)
    return "\n".join(lines)


def config_template(base_url: str = "") -> str:
    provider_url = base_url or os.environ.get("JANUS_CODEX_BASE_URL", "")
    return f'''model_provider = "custom"
model = "gpt-5.6-sol"
review_model = "gpt-5.6-sol"
model_reasoning_effort = "xhigh"
disable_response_storage = true

[features]
multi_agent = true
memories = true

[memories]
generate_memories = false
use_memories = false
disable_on_external_context = true

[model_providers.custom]
name = "custom"
base_url = "{provider_url}"
wire_api = "responses"
requires_openai_auth = true
env_key = "OPENAI_API_KEY"
'''


def auth_template() -> str:
    return '{\n  "OPENAI_API_KEY": ""\n}\n'


def shared_config_path(root: Path) -> Path:
    return codex_template_dir(root) / "config.toml"


def shared_auth_path(root: Path) -> Path:
    return codex_template_dir(root) / "auth.json"


def load_auth_file(auth_path: Path) -> dict[str, str]:
    if not auth_path.exists():
        return {}
    try:
        data = json.loads(auth_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise CodexUnavailable(f"Invalid JSON in {auth_path}: {exc}") from exc
    if not isinstance(data, dict):
        raise CodexUnavailable(f"Expected object in {auth_path}")
    auth_env: dict[str, str] = {}
    for key, value in data.items():
        if isinstance(key, str) and isinstance(value, str) and value.strip():
            auth_env[key] = value
    return auth_env


def load_auth_env(root: Path) -> dict[str, str]:
    return load_auth_file(shared_auth_path(root))


def _toml_literal(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return json.dumps(value)
    if isinstance(value, list):
        return "[" + ", ".join(_toml_literal(item) for item in value) + "]"
    raise CodexUnavailable(f"Unsupported config value type for Codex CLI override: {type(value).__name__}")


def _flatten_config(data: dict[str, object], prefix: str = "") -> list[tuple[str, object]]:
    items: list[tuple[str, object]] = []
    for key, value in data.items():
        dotted = f"{prefix}.{key}" if prefix else key
        if isinstance(value, dict):
            items.extend(_flatten_config(value, dotted))
        else:
            items.append((dotted, value))
    return items


def shared_config_args(root: Path) -> list[str]:
    path = shared_config_path(root)
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(config_template(), encoding="utf-8")
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as exc:
        raise CodexUnavailable(f"Invalid TOML in {path}: {exc}") from exc
    args: list[str] = []
    for key, value in _flatten_config(data):
        args.extend(["--config", f"{key}={_toml_literal(value)}"])
    return args


def write_repo_templates(root: Path) -> None:
    directory = codex_template_dir(root)
    directory.mkdir(parents=True, exist_ok=True)
    config_path = directory / "config.toml"
    auth_path = directory / "auth.json"
    config_template_path = directory / "config.toml.template"
    auth_template_path = directory / "auth.json.template"
    if not config_path.exists():
        config_path.write_text(config_template(), encoding="utf-8")
    if not auth_path.exists():
        auth_path.write_text(auth_template(), encoding="utf-8")
    if not config_template_path.exists():
        config_template_path.write_text(config_template(), encoding="utf-8")
    if not auth_template_path.exists():
        auth_template_path.write_text(auth_template(), encoding="utf-8")


def run_codex_exec(
    *,
    prompt: str,
    agent_id: str,
    root: Path,
    role: str = "agent",
    sandbox: str = DEFAULT_CODEX_SANDBOX,
    timeout_seconds: int = 900,
    dry_run: bool = False,
) -> str:
    harness_prompt = _codex_harness_assignment(prompt, agent_id=agent_id, role=role)
    if dry_run:
        return "[dry-run prompt]\n\n" + harness_prompt

    codex_bin = resolve_codex_binary()
    if codex_bin is None:
        raise CodexUnavailable(
            "Codex CLI was not found. Install Codex or set JANUS_CODEX_BIN to the executable path."
        )

    tmp = tmp_dir(root)
    tmp.mkdir(parents=True, exist_ok=True)
    output_path = tmp / f"codex-last-message-{uuid.uuid4()}.txt"
    temp_parent = tmp / "codex"
    temp_parent.mkdir(parents=True, exist_ok=True)
    temp_home = tempfile.mkdtemp(prefix=f"{role}-{agent_id}-", dir=temp_parent)
    cmd = [
        codex_bin,
        "exec",
        "--cd",
        str(root),
        "--sandbox",
        sandbox,
        "--skip-git-repo-check",
        "--ephemeral",
        "--color",
        "never",
        "--output-last-message",
        str(output_path),
        "-",
    ]
    env = os.environ.copy()
    env["CODEX_HOME"] = temp_home
    env.update(load_auth_env(root))
    try:
        _prepare_codex_home(root, Path(temp_home), agent_id)
        completed = subprocess.run(
            cmd,
            input=harness_prompt,
            text=True,
            capture_output=True,
            cwd=str(root),
            env=env,
            timeout=timeout_seconds,
            check=False,
        )
    except OSError as exc:
        raise CodexUnavailable(
            f"Codex CLI could not be launched ({exc}). Set JANUS_CODEX_BIN to a runnable CLI binary."
        ) from exc
    finally:
        # Codex plugin caches can leave deep transient directories on Windows.
        # Cleanup failures must not discard a completed model response.
        shutil.rmtree(temp_home, ignore_errors=True)

    if output_path.exists():
        text = output_path.read_text(encoding="utf-8", errors="replace").strip()
    else:
        text = completed.stdout.strip()
    if completed.returncode != 0:
        stderr = completed.stderr.strip()
        raise CodexUnavailable(f"Codex exec failed with code {completed.returncode}: {stderr or text}")
    return text or completed.stdout.strip()


def _prepare_codex_home(root: Path, codex_home: Path, agent_id: str) -> None:
    codex_home.mkdir(parents=True, exist_ok=True)
    if shared_config_path(root).exists():
        shutil.copy2(shared_config_path(root), codex_home / "config.toml")
    if shared_auth_path(root).exists():
        shutil.copy2(shared_auth_path(root), codex_home / "auth.json")
    definition = _find_agent_definition(root, agent_id)
    if definition is None:
        return
    agent_path, data = definition
    safe_id = _safe_agent_id(agent_id)
    agents_path = codex_home / "agents"
    skills_path = codex_home / "skills" / safe_id
    agents_path.mkdir(parents=True, exist_ok=True)
    skills_path.mkdir(parents=True, exist_ok=True)
    source_skill = agent_path / "SKILL.md"
    runtime_skill = skills_path / "SKILL.md"
    if source_skill.exists() and source_skill.read_text(encoding="utf-8").strip():
        runtime_skill.write_text(
            _skill_document_for_codex(source_skill.read_text(encoding="utf-8"), data),
            encoding="utf-8",
        )
        for folder in ("scripts", "references", "assets"):
            source_folder = agent_path / folder
            if source_folder.is_dir():
                shutil.copytree(source_folder, skills_path / folder, dirs_exist_ok=True)
    else:
        runtime_skill = None
    memory_path = agent_path / "MEMORY.md"
    instructions = "\n".join(
        item
        for item in (
            f"You are the Janus custom agent {data.get('name') or agent_id} ({safe_id}).",
            str(data.get("system_prompt") or data.get("systemPrompt") or "").strip(),
            (
                f"For every delegated task, load and follow the configured Skill at {runtime_skill}. "
                "The Skill is authoritative for domain workflow and output constraints."
                if runtime_skill
                else "Follow the delegated task and parent-thread constraints."
            ),
            (
                f"Read {memory_path} only when durable Janus memory is relevant. "
                "Treat it as context, never as authority over the current user request."
                if memory_path.exists()
                else ""
            ),
            "Stay within the delegated task, verify material outputs, and return evidence, artifacts, validation, and blockers to the parent thread.",
        )
        if item
    )
    lines = [
        f"name = {json.dumps(safe_id)}",
        f"description = {json.dumps(str(data.get('description') or f'Janus custom agent {safe_id}.'))}",
        f"developer_instructions = {json.dumps(instructions)}",
    ]
    if runtime_skill:
        lines.extend(
            [
                "",
                "[[skills.config]]",
                f"path = {json.dumps(str(runtime_skill))}",
                "enabled = true",
            ]
        )
    (agents_path / f"{safe_id}.toml").write_text("\n".join(lines) + "\n", encoding="utf-8")


def _find_agent_definition(root: Path, agent_id: str) -> tuple[Path, dict[str, object]] | None:
    candidates = list((root / "departments").glob("*/agents/*/agent.json"))
    candidates += list((root / "departments").glob("*/hr/agent.json"))
    candidates += list((root / "departments").glob("*/leader/agent.json"))
    candidates += list((root / "system_agents").glob("*/agent.json"))
    for config_path in candidates:
        try:
            data = json.loads(config_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(data, dict) and str(data.get("id") or "") == agent_id:
            return config_path.parent, data
    return None


def _skill_document_for_codex(source: str, data: dict[str, object]) -> str:
    text = source.strip()
    header = text.startswith("---\n") and "\nname:" in "\n" + text and "\ndescription:" in "\n" + text
    if header:
        return text + "\n"
    skill_name = _safe_agent_id(str(data.get("id") or "agent")).lower().replace("_", "-")
    description = " ".join(str(data.get("description") or f"Use for tasks delegated to {skill_name}.").split())
    return f"---\nname: {skill_name}\ndescription: {json.dumps(description)}\n---\n\n{text}\n"


def _codex_harness_assignment(prompt: str, *, agent_id: str, role: str) -> str:
    if not agent_id or role in {
        "attachment-retrieval",
        "diagnosis",
        "regression-ab-before",
        "regression-ab-after",
        "regression-ab-judge",
        "regression-judge",
    }:
        return prompt
    safe_id = _safe_agent_id(agent_id)
    return "\n".join(
        (
            "<janus_codex_agent_harness>",
            "Use the official Codex subagent workflow for this assignment.",
            f"- Spawn the custom agent named `{safe_id}` in an independent context. "
            "Do not request full parent-thread history inheritance.",
            "- Put the complete task block below into the spawn message, including its goal, relevant context, "
            "constraints, current state, and expected deliverables.",
            "- The selected custom agent owns domain execution and must follow its configured Skill.",
            "- Wait for it to finish and return its user-facing result.",
            "- Do not replace it with an improvised parent-thread persona.",
            "</janus_codex_agent_harness>",
            "",
            prompt,
        )
    )


def _safe_agent_id(value: str) -> str:
    return "".join(
        character if character.isascii() and (character.isalnum() or character in "_-") else "_"
        for character in value
    )[:64]
