from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

STYLE_REGISTRY = Path("departments/ppt_department/styles/style_registry.json")
INTERACTION_LOG = Path("departments/ppt_department/styles/interaction_log.jsonl")

DEFAULT_STYLE_REGISTRY: dict[str, Any] = {
    "version": 1,
    "agent_style_map": {
        "ppt": "general",
        "ppt_academic_report": "academic_report",
        "ppt_major_project": "major_project",
    },
    "styles": [
        {
            "id": "general",
            "label": "通用PPT",
            "skill_name": "ppt-general",
            "skill_path": "agents/ppt/styles/ppt-general/SKILL.md",
            "aliases": ["通用", "默认", "无风格", "general", "default presentation"],
            "palette": {
                "bg": "F8FAFC",
                "ink": "111827",
                "muted": "4B5563",
                "accent": "2563EB",
                "accent2": "0F766E",
                "panel": "FFFFFF",
            },
            "prompt": "General editorial presentation style: let the subject determine the visual world and medium; use bold but controlled composition, tactile materials, and topic-specific imagery instead of default corporate-blue technology art.",
            "usage_count": 0,
        },
        {
            "id": "academic_report",
            "label": "学术汇报风",
            "skill_name": "ppt-academic-report",
            "skill_path": "agents/ppt/styles/ppt-academic-report/SKILL.md",
            "aliases": ["学术", "学术汇报", "组会", "科研汇报", "论文汇报", "答辩", "paper talk", "academic report"],
            "palette": {
                "bg": "F8FAFC",
                "ink": "0F172A",
                "muted": "475569",
                "accent": "0F766E",
                "accent2": "2563EB",
                "panel": "FFFFFF",
            },
            "prompt": "Academic report style: publication-grade scientific editorial imagery, restrained evidence-first hierarchy, precise forms, subtle paper or natural-material texture, and credible macro/cutaway/orthographic viewpoints without glossy corporate 3D or neon sci-fi styling.",
            "usage_count": 0,
        },
        {
            "id": "major_project",
            "label": "重大项目风",
            "skill_name": "ppt-major-project",
            "skill_path": "agents/ppt/styles/ppt-major-project/SKILL.md",
            "aliases": ["重大项目", "横向项目", "项目汇报", "项目进展", "里程碑", "验收", "industry project", "major project"],
            "palette": {
                "bg": "F7FAFC",
                "ink": "111827",
                "muted": "52616B",
                "accent": "1D4ED8",
                "accent2": "D97706",
                "panel": "FFFFFF",
            },
            "prompt": "Major horizontal-project style: cinematic engineering and industrial editorial imagery with credible scale, real materials, operational context, controlled dramatic lighting, deep spatial layering, and serious navy/amber accents rather than futuristic HUD graphics.",
            "usage_count": 0,
        },
    ],
}

DEFAULT_PPT_TEMPLATE_REGISTRY: dict[str, Any] = {
    "version": 3,
    "templates": [
        {"id": "none", "label": "无", "description": "使用无学校标识的通用多功能页面库。", "path": "templates/通用多功能PPT模板.pptx", "engine": "slide_library", "schema_version": "janus-multifunction-v1", "schema": "templates/MULTIFUNCTION_TEMPLATE_SCHEMA.md"},
        {"id": "hitsz", "label": "哈工深模板", "description": "覆盖学术汇报与重大项目全部功能页的哈尔滨工业大学深圳校区模板。", "path": "templates/哈工深多功能PPT模板.pptx", "engine": "slide_library", "schema_version": "janus-multifunction-v1", "schema": "templates/MULTIFUNCTION_TEMPLATE_SCHEMA.md"},
        {"id": "scut", "label": "华工模板", "description": "覆盖学术汇报与重大项目全部功能页的华南理工大学模板。", "path": "templates/华工多功能PPT模板.pptx", "engine": "slide_library", "schema_version": "janus-multifunction-v1", "schema": "templates/MULTIFUNCTION_TEMPLATE_SCHEMA.md"},
    ],
}


@dataclass(frozen=True)
class PPTStyleDecision:
    style_id: str
    label: str
    prompt: str
    palette: dict[str, str]
    matched_by: str
    created: bool = False


@dataclass(frozen=True)
class PPTTemplateDecision:
    template_id: str
    label: str
    path: Path | None
    prompt: str


TEMPLATE_RENDER_PROFILES: dict[str, dict[str, Any]] = {
    "none": {
        "engine": "slide_library",
        "schema_version": "janus-multifunction-v1",
        "layouts": {"cover": 0, "content": 1},
        "source_slides": {"cover": 0, "content": 1, "directory": 1},
        "palette": {
            "bg": "F8FAFC",
            "ink": "111827",
            "muted": "4B5563",
            "accent": "2563EB",
            "accent2": "0F766E",
            "panel": "FFFFFF",
        },
        "footer": "通用演示",
    },
    "hitsz": {
        "engine": "slide_library",
        "schema_version": "janus-multifunction-v1",
        "layouts": {"cover": 0, "content": 1, "directory": 1, "ending": 2},
        "source_slides": {"cover": 0, "content": 1, "directory": 1, "ending": 22},
        "palette": {
            "bg": "FFFFFF",
            "ink": "12364A",
            "muted": "4B6372",
            "accent": "0B5E7A",
            "accent2": "B58A28",
            "panel": "F7FAFC",
        },
        "footer": "哈尔滨工业大学（深圳）",
    },
    "scut": {
        "engine": "slide_library",
        "schema_version": "janus-multifunction-v1",
        "layouts": {"cover": 0, "content": 1},
        "source_slides": {"cover": 0, "content": 1, "directory": 1},
        "palette": {
            "bg": "FFFFFF",
            "ink": "3A1F1B",
            "muted": "6B4B43",
            "accent": "B61918",
            "accent2": "D6A21E",
            "panel": "FFF8F2",
        },
        "footer": "华南理工大学",
    },
}

def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _registry_path(root: Path) -> Path:
    return root / STYLE_REGISTRY


def _template_registry_path(root: Path) -> Path:
    return root / "departments" / "ppt_department" / "templates" / "template_registry.json"


def _load_style_registry(root: Path) -> dict[str, Any]:
    path = _registry_path(root)
    if not path.exists():
        return json.loads(json.dumps(DEFAULT_STYLE_REGISTRY))
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        data = json.loads(json.dumps(DEFAULT_STYLE_REGISTRY))
    data.setdefault("version", 1)
    data.setdefault("agent_style_map", DEFAULT_STYLE_REGISTRY["agent_style_map"])
    data.setdefault("styles", [])
    return data


def _save_style_registry(root: Path, registry: dict[str, Any]) -> None:
    path = _registry_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(registry, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _normalize_text(value: str) -> str:
    return re.sub(r"\s+", "", value.strip().lower())


def _style_by_id(registry: dict[str, Any], style_id: str) -> dict[str, Any] | None:
    for style in registry.get("styles", []):
        if style.get("id") == style_id:
            return style
    return None


def _builtin_style_by_key(style_key: str) -> dict[str, Any] | None:
    key = _normalize_text(style_key)
    for style in DEFAULT_STYLE_REGISTRY.get("styles", []):
        aliases = [style.get("id", ""), style.get("label", ""), *(style.get("aliases") or [])]
        if any(_normalize_text(str(alias)) == key for alias in aliases):
            return json.loads(json.dumps(style))
    return None


def _style_from_record(style: dict[str, Any], matched_by: str, *, created: bool = False) -> PPTStyleDecision:
    palette = dict(style.get("palette") or {})
    fallback = DEFAULT_STYLE_REGISTRY["styles"][0]["palette"]
    for key, value in fallback.items():
        palette.setdefault(key, value)
    return PPTStyleDecision(
        style_id=str(style["id"]),
        label=str(style.get("label") or style["id"]),
        prompt=str(style.get("prompt") or ""),
        palette={k: str(v).lstrip("#").upper() for k, v in palette.items()},
        matched_by=matched_by,
        created=created,
    )


def _unseen_default_style() -> dict[str, Any]:
    return {
        "id": "unseen_default",
        "label": "未指定风格",
        "aliases": [],
        "palette": DEFAULT_STYLE_REGISTRY["styles"][0]["palette"],
        "prompt": (
            "No previously seen PPT style is registered. Use a neutral, editable, high-quality "
            "PowerPoint design without treating it as a learned or selected style."
        ),
        "usage_count": 0,
    }


def _extract_requested_style_phrase(message: str) -> str | None:
    patterns = [
        r"([A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff\-\s]{1,24})(?:风格|风)",
        r"(?:风格|style)\s*(?:是|为|:|：)\s*([A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff\-\s]{1,24})",
        r"(?:类似|像|参考)\s*([A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff\-\s]{1,24})",
    ]
    for pattern in patterns:
        match = re.search(pattern, message, flags=re.IGNORECASE)
        if match:
            phrase = match.group(1).strip(" ：:，,。.；;、")
            phrase = re.sub(r"^(做一份|帮我做|制作|生成|一份|PPT|ppt)", "", phrase).strip()
            phrase = re.sub(r"^\d{1,2}\s*(页|张|p|P|slides?|Slides?)", "", phrase).strip()
            phrase = re.sub(r"^(的|个|张|页)", "", phrase).strip()
            phrase = phrase.replace("PPT", "").replace("ppt", "").strip()
            if phrase.endswith(("是", "为", "关于", "主题")) or "主题是" in phrase or "主题为" in phrase:
                continue
            if len(_normalize_text(phrase)) >= 2:
                return phrase[:24]
    return None


def _slugify(value: str, fallback: str = "deck") -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    value = re.sub(r"-+", "-", value).strip("-")
    return value or fallback


def _safe_deck_filename_stem(value: str, fallback: str = "presentation") -> str:
    value = str(value or "").strip().strip("《》〈〉「」『』【】[]()（）\"'“”‘’")
    value = re.sub(r"\.pptx?\s*$", "", value, flags=re.IGNORECASE)
    value = re.sub(r"[<>:\"/\\|?*\x00-\x1f]", "-", value)
    value = re.sub(r"\s+", " ", value).strip(" .-_，,。")
    value = re.sub(r"[-_]{2,}", "-", value)
    if value.upper() in {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}:
        value = f"{value}-presentation"
    return (value[:80].rstrip(" .-_，,。") or fallback)


def _extract_requested_deck_name(message: str) -> str | None:
    patterns = [
        r"(?:文件名|文件名称|PPT\s*(?:名称|名字)|演示文稿(?:名称|名字))\s*(?:为|是|叫|设为|设置为|[:：])\s*[《〈「『【\"'“‘]?([^\n，,。；;]{1,100})",
        r"(?:命名为|取名为|保存为|另存为)\s*[《〈「『【\"'“‘]?([^\n，,。；;]{1,100})",
        r"(?:file\s*name|presentation\s*name|deck\s*name)\s*(?:is|as|[:=])\s*[\"']?([^\n,;]{1,100})",
    ]
    for pattern in patterns:
        match = re.search(pattern, message, flags=re.IGNORECASE)
        if not match:
            continue
        candidate = re.split(r"(?:并且|并|然后|同时|再帮我|and\s+then)", match.group(1), maxsplit=1, flags=re.IGNORECASE)[0]
        candidate = _safe_deck_filename_stem(candidate, "")
        if candidate:
            return candidate
    return None


def _deck_artifact_stem(user_message: str, specs: list["SlideSpec"]) -> str:
    requested = _extract_requested_deck_name(user_message)
    if requested:
        return requested
    title = specs[0].title if specs else ""
    if not title or re.fullmatch(r"(?:ppt|ppt draft|presentation|演示文稿|幻灯片|标题|封面)", title.strip(), flags=re.IGNORECASE):
        first_line = next((line.strip() for line in user_message.splitlines() if line.strip()), "")
        title = first_line
    return _safe_deck_filename_stem(title, "presentation")


def _style_slug(value: str) -> str:
    ascii_slug = _slugify(value, "")
    if ascii_slug:
        return f"custom_{ascii_slug[:40].strip('-')}"
    digest = uuid.uuid5(uuid.NAMESPACE_URL, _normalize_text(value)).hex[:10]
    return f"custom_{digest}"


def resolve_ppt_style(
    *,
    message: str,
    root: Path,
    selected_style: str | None = None,
    selected_agent_id: str | None = None,
    save_new_style: bool = True,
) -> PPTStyleDecision:
    registry = _load_style_registry(root)
    agent_style_map = registry.get("agent_style_map", {})
    normalized_message = _normalize_text(message)

    if selected_style:
        style = _style_by_id(registry, selected_style)
        if style:
            if save_new_style:
                _record_style_use(root, registry, style, "selected_style")
            return _style_from_record(style, "selected_style")
        builtin_style = _builtin_style_by_key(selected_style)
        if builtin_style:
            return _style_from_record(builtin_style, "selected_builtin_style")

    if selected_agent_id and selected_agent_id != "ppt":
        mapped_style_id = agent_style_map.get(selected_agent_id) or DEFAULT_STYLE_REGISTRY.get("agent_style_map", {}).get(selected_agent_id)
        if mapped_style_id:
            style = _style_by_id(registry, mapped_style_id)
            if style is None:
                style = _builtin_style_by_key(mapped_style_id)
            if style:
                if save_new_style:
                    existing_style = _style_by_id(registry, str(style.get("id")))
                    if existing_style:
                        _record_style_use(root, registry, existing_style, "selected_agent_id")
                return _style_from_record(style, "selected_agent_id")

    for style in registry.get("styles", []):
        aliases = [style.get("label", ""), style.get("id", ""), *(style.get("aliases") or [])]
        for alias in aliases:
            alias_norm = _normalize_text(str(alias))
            if alias_norm and alias_norm in normalized_message:
                if save_new_style:
                    _record_style_use(root, registry, style, "message_alias")
                return _style_from_record(style, "message_alias")

    for style in DEFAULT_STYLE_REGISTRY.get("styles", []):
        aliases = [style.get("label", ""), style.get("id", ""), *(style.get("aliases") or [])]
        for alias in aliases:
            alias_norm = _normalize_text(str(alias))
            if alias_norm and alias_norm in normalized_message:
                return _style_from_record(json.loads(json.dumps(style)), "message_builtin_alias")

    phrase = _extract_requested_style_phrase(message)
    if phrase:
        custom_id = _style_slug(phrase)
        existing = _style_by_id(registry, custom_id)
        if existing:
            if save_new_style:
                _record_style_use(root, registry, existing, "custom_alias")
            return _style_from_record(existing, "custom_alias")
        custom = {
            "id": custom_id,
            "label": phrase if phrase.endswith("风") else f"{phrase}风",
            "aliases": [phrase],
            "palette": DEFAULT_STYLE_REGISTRY["styles"][0]["palette"],
            "prompt": (
                f"Custom user-discovered style named {phrase}. Preserve the user's requested visual tone, "
                "then stabilize it into editable slides with clear hierarchy, consistent palette, and image prompts."
            ),
            "usage_count": 1,
            "created_at": _utc_now(),
            "last_used_at": _utc_now(),
        }
        registry.setdefault("styles", []).append(custom)
        if save_new_style:
            _save_style_registry(root, registry)
            _append_interaction(root, custom["id"], "created_new_style")
        return _style_from_record(custom, "created_from_message", created=True)

    if selected_agent_id:
        mapped_style_id = agent_style_map.get(selected_agent_id)
        if mapped_style_id:
            style = _style_by_id(registry, mapped_style_id)
            if style:
                if save_new_style:
                    _record_style_use(root, registry, style, "selected_agent_id")
                return _style_from_record(style, "selected_agent_id")

    default_style = _style_by_id(registry, "academic_report")
    if default_style:
        if save_new_style:
            _record_style_use(root, registry, default_style, "default")
        return _style_from_record(default_style, "default")
    return _style_from_record(_unseen_default_style(), "no_seen_style")


def _record_style_use(root: Path, registry: dict[str, Any], style: dict[str, Any], reason: str) -> None:
    style["usage_count"] = int(style.get("usage_count") or 0) + 1
    style["last_used_at"] = _utc_now()
    _save_style_registry(root, registry)
    _append_interaction(root, str(style.get("id")), reason)


def _append_interaction(root: Path, style_id: str, reason: str) -> None:
    path = root / INTERACTION_LOG
    path.parent.mkdir(parents=True, exist_ok=True)
    event = {"at": _utc_now(), "style_id": style_id, "reason": reason}
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(event, ensure_ascii=False) + "\n")


def _load_template_registry(root: Path) -> dict[str, Any]:
    path = _template_registry_path(root)
    if not path.exists():
        return json.loads(json.dumps(DEFAULT_PPT_TEMPLATE_REGISTRY))
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        data = json.loads(json.dumps(DEFAULT_PPT_TEMPLATE_REGISTRY))
    data.setdefault("version", 1)
    data.setdefault("templates", DEFAULT_PPT_TEMPLATE_REGISTRY["templates"])
    multifunction = {
        "none": {
            "label": "无",
            "description": "使用无学校标识的通用多功能页面库。",
            "path": "templates/通用多功能PPT模板.pptx",
        },
        "hitsz": {
            "label": "哈工深模板",
            "description": "覆盖学术汇报与重大项目全部功能页的哈尔滨工业大学深圳校区模板。",
            "path": "templates/哈工深多功能PPT模板.pptx",
        },
        "scut": {
            "label": "华工模板",
            "description": "覆盖学术汇报与重大项目全部功能页的华南理工大学模板。",
            "path": "templates/华工多功能PPT模板.pptx",
        },
    }
    for record in data.get("templates") or []:
        template_id = str(record.get("id") or "")
        replacement = multifunction.get(template_id)
        if replacement is None:
            continue
        candidate = root / "departments" / "ppt_department" / replacement["path"]
        if candidate.is_file():
            record.update(replacement)
            record["engine"] = "slide_library"
            record["schema_version"] = "janus-multifunction-v1"
            record["schema"] = "templates/MULTIFUNCTION_TEMPLATE_SCHEMA.md"
    data["version"] = max(3, int(data.get("version") or 1))
    return data


def resolve_ppt_template(root: Path, selected_template: str | None = None) -> PPTTemplateDecision:
    template_id = (selected_template or "none").strip() or "none"
    registry = _load_template_registry(root)
    templates = registry.get("templates") or []
    record = next((item for item in templates if item.get("id") == template_id), None)
    if record is None:
        record = next((item for item in templates if item.get("id") == "none"), None) or DEFAULT_PPT_TEMPLATE_REGISTRY["templates"][0]
    rel_path = record.get("path")
    path = (root / "departments" / "ppt_department" / str(rel_path)).resolve() if rel_path else None
    if path is not None and not path.exists():
        path = None
    label = str(record.get("label") or record.get("id") or "无")
    if path is None:
        return PPTTemplateDecision(
            template_id=str(record.get("id") or "none"),
            label=label,
            path=None,
            prompt="No school PPT template selected; use the selected style renderer defaults.",
        )
    return PPTTemplateDecision(
        template_id=str(record.get("id") or template_id),
        label=label,
        path=path,
        prompt=f"Use {label} as an editable multi-function slide library. Select each source page by layout_id and preserve its semantic template structure.",
    )


def ppt_template_prompt_context(root: Path, selected_template: str | None = None) -> str:
    template = resolve_ppt_template(root, selected_template)
    return (
        "\n\n[Private PPT rendering context. Do not quote, translate, summarize, or expose this block in the user-facing answer.]\n"
        f"- Selected template: {template.label} (template_id={template.template_id}).\n"
        f"- Rendering instruction: {template.prompt}\n"
        "- Do not use shell commands, filesystem tools, python-pptx, LibreOffice, or custom scripts to create the PPT file yourself.\n"
        "- Your job is to produce the slide plan as the required Markdown table with page-level layout_id; the web backend will render the real editable .pptx automatically after your answer.\n"
        "- The selected template is a multi-function slide library; the neutral option uses the same editable pages without school branding. Choose a content layout_id for each slide so the backend copies the matching page and fills its semantic slots.\n"
        "- First output a compact user-facing page-title list with one line per slide. Show only page number and title/topic. Put the detailed Markdown page table inside a fenced janus-slide-plan block so the Desktop UI can hide renderer-only details.\n"
        "- After the hidden slide-plan block, output a fenced janus-deck-spec JSON object with schema_version janus-multifunction-v1 and one slides item per table row. Each item contains layout_id and semantic content_spec. Never use template page numbers or PowerPoint shape names.\n"
        "- Finish with a normal final answer promptly after the table so the backend can attach the generated deck.\n"
        "- The final response may briefly say that a .pptx has been generated, but must not print this private template block.\n"
    )



__all__ = [
    "PPTStyleDecision",
    "PPTTemplateDecision",
    "TEMPLATE_RENDER_PROFILES",
    "_deck_artifact_stem",
    "_safe_deck_filename_stem",
    "ppt_template_prompt_context",
    "resolve_ppt_style",
    "resolve_ppt_template",
]
