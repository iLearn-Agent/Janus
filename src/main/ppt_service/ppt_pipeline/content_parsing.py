from __future__ import annotations

import json
import re
from dataclasses import replace
from html import unescape as html_unescape
from typing import Any

from janus_lab.ppt_renderer import SlideSpec, parse_slide_specs as _base_parse_slide_specs
from ppt_pipeline.image_routing import _spec_layout_id
from ppt_pipeline.presentation_assets import _shorten_for_cell
from ppt_pipeline.render_primitives import _clean_visible_text, _visual_len
from slide_library_renderer import KNOWN_LAYOUT_IDS as SLIDE_LIBRARY_LAYOUT_IDS


def _extract_highlight(text: str) -> str | None:
    """Extract the strongest standalone metric from visible slide text."""
    if not text:
        return None
    skip_context = re.compile(
        r"(?:table|fig(?:ure)?|图|表|page|slide|section|sec\.?|第|r@|n@|recall@|ndcg@)\s*$",
        re.IGNORECASE,
    )
    candidates: list[tuple[int, str]] = []
    for match in re.finditer(r"\d+(?:[.,]\d+)?\s*(?:%|％|亿|万|倍|分钟|秒|岁|年|美元|mmHg|kg|克)?", text):
        token = match.group().strip()
        if not any(ch.isdigit() for ch in token):
            continue
        before = text[max(0, match.start() - 16):match.start()]
        after = text[match.end():match.end() + 10]
        prev_char = text[match.start() - 1] if match.start() > 0 else ""
        next_char = text[match.end()] if match.end() < len(text) else ""
        if re.match(r"[A-Za-z]", prev_char) or re.match(r"[A-Za-z]", next_char):
            continue
        if skip_context.search(before):
            continue
        if before.endswith("@") or re.search(r"^\s*[.)、:：-]", after):
            continue
        value = token.replace(",", ".")
        score = 0
        if "." in value:
            score += 20
        if "%" in token or "％" in token:
            score += 15
        if re.search(
            r"(coherence|novelty|aesthetic|hallucination|recall|ndcg|r@|n@|ctr|cvr)",
            before + after,
            re.IGNORECASE,
        ):
            score += 8
        if re.fullmatch(r"\d{1,2}", token):
            score -= 8
        candidates.append((score, token))
    if candidates:
        candidates.sort(key=lambda item: item[0], reverse=True)
        return candidates[0][1]
    return None


def _numeric_highlights(text: str, *, limit: int = 8) -> list[str]:
    values: list[str] = []
    for chunk in re.split(r"[；;。]\s*|\n+", text or ""):
        value = _extract_highlight(chunk)
        if value and value not in values:
            values.append(value)
        if len(values) >= limit:
            break
    if len(values) < limit:
        for match in re.finditer(r"\d+\.\d{2,4}", text or ""):
            value = match.group().strip()
            if value not in values:
                values.append(value)
            if len(values) >= limit:
                break
    return values[:limit]


def _prominent_numeric_highlights(text: str, *, limit: int = 8) -> list[str]:
    values: list[str] = []
    for value in _numeric_highlights(text, limit=max(limit * 3, limit)):
        if re.fullmatch(r"\d{1,2}", value):
            continue
        if value not in values:
            values.append(value)
        if len(values) >= limit:
            break
    return values


def _fallback_outline_from_message(message: str, count: int) -> list[tuple[str, list[str], str]]:
    """Extract a usable slide outline from explicit user page-by-page prompts."""
    text = re.sub(r"\r\n?", "\n", message or "")
    pattern = re.compile(r"(?m)^\s*第\s*([一二三四五六七八九十百\d]+)\s*[页张]\s*[:：]\s*(.+?)\s*$")
    matches = list(pattern.finditer(text))
    outline: list[tuple[str, list[str], str]] = []
    if matches:
        for idx, match in enumerate(matches[:count]):
            title = match.group(2).strip(" -：:|")
            start = match.end()
            end = matches[idx + 1].start() if idx + 1 < len(matches) else len(text)
            block = text[start:end].strip()
            lines: list[str] = []
            visual = ""
            for raw in block.splitlines():
                line = raw.strip(" -•\t")
                if not line:
                    continue
                if re.match(r"^(标题|副标题|内容包括)\s*[:：]", line):
                    line = re.sub(r"^(标题|副标题|内容包括)\s*[:：]\s*", "", line).strip()
                if re.match(r"^(视觉建议|可配合|可将)\s*[:：]?", line):
                    visual = re.sub(r"^(视觉建议|可配合|可将)\s*[:：]?\s*", "", line).strip() or visual
                    continue
                if re.match(r"^(介绍|讲述|说明|总结|重点说明|举例说明)", line) or "：" in line or "。" in line:
                    cleaned = re.sub(r"^\d+[.)、]\s*", "", line)
                    cleaned = re.sub(r"^(用户侧|平台侧|商家或内容侧)\s*[:：]\s*", "", cleaned)
                    if not _is_layout_instruction_text(cleaned):
                        lines.append(cleaned[:60])
                if len(lines) >= 4:
                    break
            if not lines:
                lines = _meaningful_bullets(block, limit=4)
            outline.append((title or f"第 {idx + 1} 页", lines[:4], visual))
    return outline


def _parse_slide_ordinal(value: str) -> int | None:
    text = str(value or "").strip()
    if text.isdigit():
        return int(text)
    digits = {"零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
    if text == "十":
        return 10
    if text.startswith("十") and len(text) == 2 and text[1] in digits:
        return 10 + digits[text[1]]
    if text.endswith("十") and len(text) == 2 and text[0] in digits:
        return digits[text[0]] * 10
    if "十" in text and len(text) == 3 and text[0] in digits and text[2] in digits:
        return digits[text[0]] * 10 + digits[text[2]]
    if text in digits:
        return digits[text]
    return None


def _outline_titles_by_number(message: str) -> dict[int, str]:
    text = re.sub(r"\r\n?", "\n", message or "")
    pattern = re.compile(r"(?m)^\s*第\s*([一二三四五六七八九十百\d]+)\s*[页张]\s*[:：]\s*(.+?)\s*$")
    titles: dict[int, str] = {}
    for match in pattern.finditer(text):
        number = _parse_slide_ordinal(match.group(1))
        title = match.group(2).strip(" -：:|")
        if number is not None and title:
            titles[number] = title
    return titles



def _parse_bullets(text: str, *, limit: int = 4) -> list[str]:
    """Split a message field into clean bullet points.

    Prefers explicit ' • ' separators produced by the leader prompt; falls back
    to sentence punctuation. Drops fragments and trims to `limit` points.
    """
    value = re.sub(r"[ \t\r\f\v]+", " ", text or "").strip()
    if not value:
        return []
    if "•" in value:
        parts = [p.strip(" -·•，,;；") for p in value.split("•")]
    else:
        parts = re.split(r"[；;。]\s*|\n+", value)
        parts = [p.strip(" -·•，,;；") for p in parts]
    points = [p for p in parts if len(p) >= 2]
    if not points:
        points = [value]
    return points[:limit]


def _is_reference_fragment_text(text: str) -> bool:
    value = re.sub(r"\s+", " ", str(text or "").strip(" -·•，,;；。:：()（）[]【】")).strip()
    if not value:
        return True
    patterns = [
        r"p\.?\s*\d+(?:\s*[-–]\s*\d+)?(?:\s+[A-Za-z][A-Za-z0-9 .,/&-]{0,50})?",
        r"(?:sec|section)\.?\s*\d+(?:\.\d+)*(?:\s*[-–]\s*\d+(?:\.\d+)*)?",
        r"(?:eq|equation)\.?\s*\d+(?:\s*[-–]\s*\d+)?",
        r"(?:fig|figure|table)\.?\s*\d+[A-Za-z]?",
        r"(?:图|表|公式|第)\s*\d+(?:\s*[-–]\s*\d+)?(?:\s*[页张])?",
        r"anonymous\s+(?:acl|neurips|iclr|cvpr|iccv|emnlp|aaai)\s+submission",
    ]
    return any(re.fullmatch(pattern, value, re.IGNORECASE) for pattern in patterns)


def _is_intermediate_artifact_text(text: str) -> bool:
    """True for renderer/planning/proof scraps that should not be visible."""
    value = re.sub(r"\s+", " ", str(text or "").strip(" -·•，,;；。")).strip()
    if not value:
        return True
    normalized = value.lower()
    if re.match(r"^(?:来源|source|ref|reference)\s*[:：]", value, re.IGNORECASE):
        return True
    if re.fullmatch(r"(?:n/?a|none|null|todo|tbd|placeholder|占位|待补充|无)", normalized):
        return True
    if re.fullmatch(r"[a-z][a-z0-9]*(?:_[a-z0-9]+)+", normalized):
        return True
    if normalized.strip(".:：") in {"eq", "fig", "figure", "table", "sec", "section", "layout_id", "layout"}:
        return True
    parts = [part.strip() for part in re.split(r"[；;,，、\n]+", value) if part.strip()]
    if parts and all(_is_reference_fragment_text(part) for part in parts):
        return True
    if _is_reference_fragment_text(value):
        return True
    if re.match(r"^(?:p\.?\s*\d+|sec\.?\s*\d+|figure\s*\d+|fig\.?\s*\d+|table\s*\d+|eq\.?\s*\d+)\b", value, re.IGNORECASE):
        return True
    return False


def _strip_visible_source_anchor(text: str) -> str:
    value = str(text or "")
    value = re.sub(r"(?:^|[；;。]\s*)(?:来源|source|ref|reference)\s*[:：].*$", "", value, flags=re.IGNORECASE)
    return value.strip(" -·•，,;；。")


def _is_layout_instruction_text(text: str) -> bool:
    value = re.sub(r"\s+", "", str(text or "").strip()).lower()
    if not value:
        return True
    if _is_intermediate_artifact_text(text):
        return True
    if re.fullmatch(r"(?:\d+|[一二三四五六七八九十])[.)、]?", value):
        return True
    prefix_markers = (
        "封面",
        "画面",
        "左侧",
        "右侧",
        "左上",
        "左下",
        "右上",
        "右下",
        "中间",
        "中部",
        "上半部分",
        "下半部分",
        "上方",
        "下方",
        "底部",
        "顶部",
        "旁边",
        "放",
        "用fig",
        "用figure",
        "用图",
        "用table",
        "用表",
        "插入",
        "绘制",
        "重绘",
        "标注",
        "展示",
        "补充",
        "高亮",
        "使用附件原图",
        "生成插图",
        "可编辑",
        "左",
        "右",
    )
    if value.startswith(prefix_markers):
        return True
    markers = (
        "visualdirection",
        "layout",
        "placeholder",
        "视觉建议",
        "推荐图表",
        "呈现方式",
        "版式",
        "布局",
        "排版",
        "占位",
        "放公式",
        "公式简化版",
        "中间放",
        "封面放",
        "关键词",
        "流程图重绘",
        "表格展示",
        "突出",
        "强调",
        "两栏",
        "左栏",
        "右栏",
        "图文",
        "配图",
        "作为主体",
        "主体图",
        "右侧标注",
        "底部展示",
        "左侧画",
        "右侧放",
        "上半部分",
        "下半部分",
    )
    if any(marker in value for marker in markers):
        return True
    if "卡片" in value and re.search(r"(?:两个|三个|三张|四个|挑战|总结|价值|要点).*卡片", value):
        return True
    return False


def _meaningful_bullets(text: str, *, limit: int = 4) -> list[str]:
    points = _parse_bullets(text or "", limit=limit + 4)
    cleaned = [_strip_visible_source_anchor(point) for point in points]
    return [
        point
        for point in cleaned
        if point and not _is_layout_instruction_text(point) and not _is_intermediate_artifact_text(point)
    ][:limit]


_LOW_SUBSTANCE_TERMS = {
    "背景",
    "目标",
    "方案",
    "方法",
    "流程",
    "结果",
    "结论",
    "总结",
    "挑战",
    "问题",
    "价值",
    "风险",
    "计划",
    "需求",
    "供给",
    "验证",
    "评估",
    "指标",
    "路径",
    "模块",
    "主线",
    "核心内容",
    "关键内容",
    "本页要点",
    "总体目标",
    "背景约束",
    "实施路径",
    "阶段成果",
    "风险控制",
    "下一步动作",
    "方法模块",
    "验证证据",
    "结果含义",
    "主线信息",
    "支撑证据",
    "核心观察",
    "关键观察",
    "方法启示",
    "实验现象",
    "结论解释",
}


def _is_low_substance_bullet(text: str) -> bool:
    value = _clean_visible_text(text)
    if not value:
        return True
    compact = re.sub(r"\s+", "", value).strip(" -·•，,;；。:：")
    if not compact:
        return True
    if compact in _LOW_SUBSTANCE_TERMS:
        return True
    if re.fullmatch(r"(?:[一二三四五六七八九十\d]+[.)、]?|模块[一二三四五六七八九十\d]+|阶段[一二三四五六七八九十\d]+)", compact):
        return True
    if _visual_len(compact) <= 5.5:
        return True
    has_specific_signal = bool(
        re.search(r"\d|%|％|→|->|vs|VS|对比|提升|降低|增加|减少|导致|依赖|通过|基于|覆盖|约束|成本|需求|供给|验证|评估|指标|数据|用户|模型|系统|平台|论文|实验|样本|场景|交付|里程碑|证据|支撑|影响|机制|差异|映射|驱动|暴露|解释|收益", value)
    )
    if _visual_len(compact) <= 10 and not has_specific_signal:
        return True
    return False


def _dedupe_visible_points(points: list[str]) -> list[str]:
    seen: set[str] = set()
    unique: list[str] = []
    for point in points:
        value = _clean_visible_text(point)
        if not value:
            continue
        key = re.sub(r"\s+", "", value).lower()
        if key in seen:
            continue
        seen.add(key)
        unique.append(value)
    return unique


def _evidence_visible_points(spec: SlideSpec, *, limit: int = 3) -> list[str]:
    """Turn proof_object / visual evidence names into concrete visible fallback text."""
    raw = str(spec.visual or "")
    if not raw:
        return []
    raw = re.sub(r"(?:^|\n)\s*(?:layout_id|layout|版式模板)\s*[:：=]\s*[a-zA-Z0-9_-]+\s*", "\n", raw, flags=re.IGNORECASE)
    chunks = [part.strip() for part in re.split(r"\n+|[；;。]\s*", raw) if part.strip()]
    title = _clean_visible_text(spec.title or "")
    title_short = _shorten_for_cell(title, 18) if title and not _is_layout_instruction_text(title) else ""
    evidence_terms: list[str] = []

    for chunk in chunks:
        value = _clean_visible_text(_strip_visible_source_anchor(chunk))
        value = re.sub(
            r"^(?:proof_object|proof object|proof|主证据对象|证据对象|主证据|证据|visual|视觉)\s*[:：=]\s*",
            "",
            value,
            flags=re.IGNORECASE,
        )
        value = re.sub(
            r"^(?:使用附件原图|使用附件图片|附件原图|使用原图|生成插图|生成概念插图|概念插图|可编辑|重绘)\s*[:：=\-]*\s*",
            "",
            value,
        )
        value = value.strip(" -·•，,;；。:：")
        if not value:
            continue
        if re.search(r"(左侧|右侧|左上|右上|中间|底部|顶部|版式|布局|占位|排版|放置|放入|高亮|两栏|三栏)", value):
            continue
        if _is_intermediate_artifact_text(value) or _is_reference_fragment_text(value):
            continue
        has_evidence_signal = bool(
            re.search(r"(图|表|矩阵|流程|架构|指标|数据|截图|原图|插图|diagram|chart|figure|table|benchmark|dashboard)", value, re.IGNORECASE)
        )
        if _is_low_substance_bullet(value) and not has_evidence_signal:
            continue
        phrase = _shorten_for_cell(value, 28)
        if phrase and phrase not in evidence_terms:
            evidence_terms.append(phrase)
        if len(evidence_terms) >= limit:
            break

    return evidence_terms[:limit]


def _slide_display_points(spec: SlideSpec, *, limit: int = 4, include_title: bool = True) -> list[str]:
    """Visible slide text candidates, with renderer-only instructions removed."""
    message_points = _meaningful_bullets(spec.message or "", limit=limit + 3)
    merged = _dedupe_visible_points(message_points)
    specific = [point for point in merged if not _is_low_substance_bullet(point)]
    points = specific[:limit]
    if len(points) < min(limit, 3):
        for point in merged:
            if point not in points:
                points.append(point)
            if len(points) >= limit:
                break
    if not points and include_title and spec.title and not _is_layout_instruction_text(spec.title):
        points = [spec.title]
    return points[:limit]


def _clean_slide_cell(value: str) -> str:
    text = html_unescape(str(value or ""))
    text = re.sub(r"<\s*br\s*/?\s*>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</\s*p\s*>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = text.replace("\\n", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip(" \t\r\n`*_")


def _normalize_slide_table_key(value: str) -> str:
    text = _clean_slide_cell(value).lower()
    text = re.sub(r"[`*_#]", "", text)
    text = re.sub(r"\s+", "", text)
    text = re.sub(r"[:：/\\|,，.。()（）\[\]【】<>《》\"'“”‘’_-]+", "", text)
    return text


def _slide_table_field(header: str) -> str | None:
    key = _normalize_slide_table_key(header)
    if not key:
        return None
    if key in {"layout", "layoutid", "layout_id", "版式", "页面版式", "布局模板", "版式模板"}:
        return "layout"
    if key in {"title", "slidetitle", "pagetitle", "页面标题", "幻灯片标题"} or "标题" in key:
        return "title"
    if key in {"slide", "page", "页码", "序号", "编号"}:
        return "page"
    if (
        "视觉" in key
        or "可视化" in key
        or "图表" in key
        or "呈现方式" in key
        or "布局建议" in key
        or "可视化指令" in key
        or "视觉指令" in key
        or "证据对象" in key
        or "主证据" in key
        or "proofobject" in key
        or key in {"visual", "chart", "diagram", "image", "proof", "proof_object"}
    ):
        return "visual"
    if (
        key in {"message", "claim", "coremessage", "mainmessage", "页面核心观点", "核心观点", "核心信息", "观点"}
        or "核心内容" in key
        or "核心论点" in key
        or "主要论点" in key
        or "主论点" in key
        or "核心主张" in key
        or "核心结论" in key
        or "论点" in key
        or "主张" in key
        or "页面内容" in key
    ):
        return "core"
    if (
        "内容要点" in key
        or "关键内容" in key
        or "主要内容" in key
        or (key.endswith("内容") and "核心" not in key)
        or key in {"bullets", "points", "要点", "35个内容要点", "3到5个内容要点"}
    ):
        return "points"
    if "演讲" in key or "备注" in key or key in {"speakernote", "speakernotes", "speaker_note", "note", "notes"}:
        return "speaker_note"
    if key in {"time", "duration", "时长", "时间"}:
        return "time"
    return None


def _is_markdown_separator_row(cells: list[str]) -> bool:
    return bool(cells) and all(re.fullmatch(r"\s*:?-{2,}:?\s*", cell or "") for cell in cells)


def _split_markdown_row(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def _markdown_table_blocks(answer: str) -> list[list[str]]:
    blocks: list[list[str]] = []
    current: list[str] = []
    for line in str(answer or "").splitlines():
        stripped = line.rstrip()
        if stripped.lstrip().startswith("|") and stripped.rstrip().endswith("|"):
            current.append(stripped)
            continue
        if current:
            blocks.append(current)
            current = []
    if current:
        blocks.append(current)
    return blocks


def _parse_slide_table_block(table_lines: list[str]) -> list[SlideSpec]:
    if len(table_lines) < 2:
        return []

    header_cells = _split_markdown_row(table_lines[0])
    fields = [_slide_table_field(cell) for cell in header_cells]
    if "title" not in fields and "core" not in fields and "points" not in fields:
        return []

    rows: list[SlideSpec] = []
    for line in table_lines[1:]:
        cells = _split_markdown_row(line)
        if _is_markdown_separator_row(cells):
            continue
        if len(cells) != len(fields):
            continue
        values: dict[str, list[str]] = {}
        for field, cell in zip(fields, cells, strict=False):
            if not field or field == "page":
                continue
            cleaned = _clean_slide_cell(cell)
            if cleaned:
                values.setdefault(field, []).append(cleaned)

        title = " ".join(values.get("title", [])).strip() or f"Slide {len(rows) + 1}"
        core = "\n".join(values.get("core", [])).strip()
        points = "\n".join(values.get("points", [])).strip()
        message = "\n".join(part for part in [core, points] if part).strip()
        visual = "\n".join(values.get("visual", [])).strip()
        layout = " ".join(values.get("layout", [])).strip()
        if layout:
            visual = f"layout_id: {layout}\n{visual}".strip()
        speaker_note = "\n".join(values.get("speaker_note", [])).strip()
        time = "\n".join(values.get("time", [])).strip()
        rows.append(SlideSpec(title=title, message=message, visual=visual, speaker_note=speaker_note, time=time))
    return rows


def _parse_multilingual_markdown_table(answer: str) -> list[SlideSpec]:
    best: list[SlideSpec] = []
    for table_lines in _markdown_table_blocks(answer):
        rows = _parse_slide_table_block(table_lines)
        if len(rows) > len(best):
            best = rows
    return best


def _generic_slide_title_number(title: str | None) -> int | None:
    value = re.sub(r"\s+", " ", str(title or "").strip())
    if not value:
        return None
    patterns = [
        r"slide\s*(\d{1,2})",
        r"page\s*(\d{1,2})",
        r"第\s*([一二三四五六七八九十\d]{1,4})\s*[页张]",
        r"幻灯片\s*(\d{1,2})",
    ]
    for pattern in patterns:
        match = re.fullmatch(pattern, value, re.IGNORECASE)
        if match:
            return _parse_slide_ordinal(match.group(1))
    return None


def _is_generic_slide_title(title: str | None, index: int) -> bool:
    value = re.sub(r"\s+", " ", str(title or "").strip())
    if not value:
        return True
    number = _generic_slide_title_number(value)
    return number is not None and (number == index or re.search(r"^(?:slide|page|第|幻灯片)", value, re.IGNORECASE))


def _infer_title_from_spec(spec: SlideSpec, index: int) -> str | None:
    points = _slide_display_points(spec, limit=2, include_title=False)
    if points:
        first = points[0].strip()
        if "：" in first:
            candidate = first.split("：", 1)[0].strip()
        elif ":" in first:
            candidate = first.split(":", 1)[0].strip()
        else:
            candidate = first
        candidate = re.sub(r"^(介绍|说明|讲述|总结|重点说明|举例说明)", "", candidate).strip()
        if 2 <= len(candidate) <= 28 and not _is_layout_instruction_text(candidate):
            return candidate
    if spec.visual and not _is_layout_instruction_text(spec.visual):
        candidate = re.split(r"[：:；;。,.，]", spec.visual.strip(), maxsplit=1)[0].strip()
        if 2 <= len(candidate) <= 28:
            return candidate
    return None


def _repair_slide_titles(user_message: str, specs: list[SlideSpec]) -> list[SlideSpec]:
    if not specs:
        return specs
    outline = _fallback_outline_from_message(user_message, len(specs))
    outline_by_number = _outline_titles_by_number(user_message)
    repaired: list[SlideSpec] = []
    for index, spec in enumerate(specs, start=1):
        title = (spec.title or "").strip()
        if _is_generic_slide_title(title, index):
            generic_number = _generic_slide_title_number(title)
            outline_title = ""
            if generic_number is not None:
                outline_title = outline_by_number.get(generic_number, "")
            if not outline_title:
                outline_title = outline[index - 1][0] if index - 1 < len(outline) else ""
            inferred = outline_title or _infer_title_from_spec(spec, index)
            if inferred:
                title = inferred
        repaired.append(
            SlideSpec(
                title=title or spec.title,
                message=spec.message,
                visual=spec.visual,
                speaker_note=spec.speaker_note,
                time=spec.time,
                content_spec=spec.content_spec,
            )
        )
    return repaired


def _looks_like_empty_generic_deck(specs: list[SlideSpec]) -> bool:
    if not specs:
        return False
    generic = 0
    empty = 0
    for index, spec in enumerate(specs, start=1):
        if _is_generic_slide_title(spec.title, index):
            generic += 1
        if not (spec.message or spec.visual or spec.speaker_note or "").strip():
            empty += 1
    return generic >= max(2, len(specs) // 2) and empty >= max(2, len(specs) // 2)


def _requested_slide_count(user_message: str) -> int | None:
    text = re.sub(r"\s+", "", user_message or "")
    patterns = [
        r"(?:页数控制在|控制在|做成|制作|生成)?(\d{1,2})页(?:左右|以内|以内左右)?",
        r"(\d{1,2})张(?:左右|以内)?",
        r"around(\d{1,2})slides?",
        r"(\d{1,2})slides?",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if not match:
            continue
        try:
            value = int(match.group(1))
        except ValueError:
            continue
        if 2 <= value <= 40:
            return value
    outline_numbers = [_parse_slide_ordinal(n) for n in re.findall(r"第\s*([一二三四五六七八九十\d]{1,4})\s*页", user_message or "")]
    outline_numbers = [n for n in outline_numbers if n is not None]
    if outline_numbers:
        return max(outline_numbers)
    return None


def _merge_specs(left: SlideSpec, right: SlideSpec) -> SlideSpec:
    left_points = _slide_display_points(left, limit=3, include_title=False)
    right_points = _slide_display_points(right, limit=3, include_title=False)
    merged_points: list[str] = []
    for point in [*left_points, *right_points]:
        if point and point not in merged_points:
            merged_points.append(_shorten_for_cell(point, 42))
        if len(merged_points) >= 4:
            break
    title = left.title or right.title
    title_text = f"{left.title or ''} {right.title or ''}"
    if left.title and right.title and left.title != right.title:
        if "研究问题" in title_text and any(key in title_text for key in ["方法", "框架", "总览"]):
            title = "研究问题与方法总览"
        elif "模块二" in title_text and "模块三" in title_text:
            title = "画像优化与生成对齐"
        elif any(key in title_text for key in ["结果", "实验"]) and "消融" in title_text:
            title = "实验结果与消融分析"
        elif "TailorBench" in title_text and any(key in title_text for key in ["结果", "实验"]):
            title = "评测基准与关键结果"
        else:
            title = left.title
    visual = left.visual or right.visual
    if left.visual and right.visual and left.visual != right.visual:
        visual = f"{left.visual}；{right.visual}"
    note = " ".join(part for part in [left.speaker_note, right.speaker_note] if part).strip()
    return SlideSpec(
        title=title,
        message=" • " + " • ".join(merged_points) if merged_points else (left.message or right.message),
        visual=visual,
        speaker_note=note,
        time=left.time or right.time,
        content_spec=left.content_spec or right.content_spec,
    )


def _fit_specs_to_requested_count(user_message: str, specs: list[SlideSpec]) -> list[SlideSpec]:
    target = _requested_slide_count(user_message)
    if not target or len(specs) <= target + 1:
        return specs
    fitted = list(specs)
    while len(fitted) > target:
        best_index: int | None = None
        best_score = 10_000
        for i in range(1, len(fitted) - 2):
            pair_text = f"{fitted[i].title or ''} {fitted[i + 1].title or ''}"
            score = len(_slide_display_points(fitted[i], limit=4)) + len(_slide_display_points(fitted[i + 1], limit=4))
            if re.search(r"(模块|结果|实验|评测|方法|框架|背景|问题)", pair_text):
                score -= 2
            if score < best_score:
                best_score = score
                best_index = i
        if best_index is None:
            break
        fitted[best_index] = _merge_specs(fitted[best_index], fitted[best_index + 1])
        del fitted[best_index + 1]
    return fitted


def _extract_machine_deck_spec(answer: str) -> list[dict[str, Any]]:
    candidates = re.findall(r"```(?:json|janus-deck-spec)?\s*\n([\s\S]*?)```", str(answer or ""), flags=re.IGNORECASE)
    for raw in reversed(candidates):
        try:
            data = json.loads(raw.strip())
        except Exception:
            continue
        slides = data.get("slides") if isinstance(data, dict) else None
        if isinstance(slides, list) and all(isinstance(item, dict) for item in slides):
            return slides
    return []


def _apply_machine_deck_spec(specs: list[SlideSpec], answer: str) -> list[SlideSpec]:
    machine_slides = _extract_machine_deck_spec(answer)
    if not machine_slides:
        return specs
    merged: list[SlideSpec] = []
    for index, spec in enumerate(specs):
        machine = machine_slides[index] if index < len(machine_slides) else {}
        content = machine.get("content_spec") or machine.get("content") or machine.get("data")
        content_spec = content if isinstance(content, dict) else spec.content_spec
        layout_id = str(machine.get("layout_id") or "").strip()
        visual = spec.visual
        if layout_id in SLIDE_LIBRARY_LAYOUT_IDS and not re.search(r"\blayout_id\s*[:：=]", visual or "", re.IGNORECASE):
            visual = f"layout_id: {layout_id}\n{visual or ''}".strip()
        merged.append(replace(spec, visual=visual, content_spec=content_spec))
    return merged


def _semantic_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, dict):
        return " ".join(_semantic_text(item) for item in value.values()).strip()
    if isinstance(value, list):
        return " ".join(_semantic_text(item) for item in value).strip()
    return re.sub(r"\s+", " ", str(value)).strip()


def _dedupe_semantic_items(items: list[Any], *, limit: int) -> list[Any]:
    result: list[Any] = []
    seen: set[str] = set()
    for item in items:
        key = re.sub(r"[^\w\u3400-\u9fff]+", "", _semantic_text(item).lower())
        if not key or key in seen:
            continue
        seen.add(key)
        result.append(item)
        if len(result) >= limit:
            break
    return result


def _sequence_parts(value: Any) -> list[Any]:
    if isinstance(value, list):
        expanded: list[Any] = []
        for item in value:
            if isinstance(item, str):
                parts = [part.strip() for part in re.split(r"\s*(?:→|➜|⇒|—|–|->|、|；|;)\s*", item) if part.strip()]
                expanded.extend(parts if len(parts) > 1 else [item])
            else:
                expanded.append(item)
        return expanded
    if isinstance(value, str):
        return [part.strip() for part in re.split(r"\s*(?:→|➜|⇒|—|–|->|、|；|;)\s*", value) if part.strip()]
    return []


def _title_sequence_parts(title: str) -> list[str]:
    candidate = str(title or "")
    if "：" in candidate or ":" in candidate:
        candidate = re.split(r"[：:]", candidate, maxsplit=1)[-1]
    parts = [part.strip(" ，,。") for part in re.split(r"\s*(?:→|➜|⇒|—|–|->|、|；|;)\s*", candidate) if part.strip(" ，,。")]
    return parts if len(parts) >= 3 else []


def _domain_sequence_defaults(deck_text: str, *, loop: bool = False) -> list[str]:
    if re.search(r"(?:多模态.*推荐|推荐.*多模态|multimodal recommendation)", deck_text, re.IGNORECASE):
        if loop:
            return ["多模态内容表征", "用户偏好建模", "候选排序决策", "反馈更新"]
        return ["视觉/文本表征", "跨模态融合", "用户偏好建模", "候选排序与评估"]
    if loop:
        return ["信息采集", "分析决策", "执行验证", "反馈更新"]
    return ["输入与目标定义", "核心机制处理", "结果验证与反馈"]


def _payload_rows(payload: dict[str, Any]) -> list[Any]:
    rows = payload.get("rows")
    if isinstance(rows, list):
        return rows
    table = payload.get("table") if isinstance(payload.get("table"), dict) else {}
    return table.get("rows") if isinstance(table.get("rows"), list) else []


def _meaningful_payload_rows(payload: dict[str, Any]) -> list[Any]:
    result: list[Any] = []
    for row in _payload_rows(payload):
        if isinstance(row, dict):
            values = [_semantic_text(value) for value in row.values() if _semantic_text(value)]
        elif isinstance(row, (list, tuple)):
            values = [_semantic_text(value) for value in row if _semantic_text(value)]
        else:
            values = [_semantic_text(row)] if _semantic_text(row) else []
        if len(values) >= 2:
            result.append(row)
    return result


def _replace_spec_layout(spec: SlideSpec, layout_id: str) -> SlideSpec:
    marker = f"layout_id: {layout_id}"
    visual = re.sub(
        r"\blayout_id\s*[:：=]\s*[a-zA-Z0-9_-]+",
        marker,
        spec.visual or "",
        count=1,
        flags=re.IGNORECASE,
    )
    if not re.search(r"\blayout_id\s*[:：=]", visual, re.IGNORECASE):
        visual = f"{marker}\n{visual}".strip()
    return replace(spec, visual=visual)


def _fallback_from_incomplete_table(spec: SlideSpec, payload: dict[str, Any]) -> tuple[SlideSpec, dict[str, Any]]:
    points = _slide_display_points(spec, limit=6, include_title=False)
    cards: list[dict[str, Any]] = []
    for row in _meaningful_payload_rows(payload):
        values = list(row.values()) if isinstance(row, dict) else list(row)
        clean = [_semantic_text(value) for value in values if _semantic_text(value)]
        if clean:
            cards.append({"title": clean[0], "points": clean[1:3]})
    if len(cards) >= 2:
        repaired_payload = {
            "title": payload.get("title") or spec.title,
            "cards": cards[:6],
            "points": points,
            "conclusion": payload.get("conclusion") or payload.get("interpretation") or "",
        }
        return _replace_spec_layout(spec, "evidence_grid"), repaired_payload
    repaired_payload = {
        "title": payload.get("title") or spec.title,
        "points": points or [spec.message or spec.title],
        "conclusion": payload.get("conclusion") or payload.get("interpretation") or "",
    }
    return _replace_spec_layout(spec, "basic_content"), repaired_payload


def _repair_semantic_content_specs(user_message: str, specs: list[SlideSpec]) -> list[SlideSpec]:
    deck_text = " ".join([user_message or "", *[f"{spec.title or ''} {spec.message or ''}" for spec in specs]])
    repaired: list[SlideSpec] = []
    for spec in specs:
        layout_id = _spec_layout_id(spec)
        payload = dict(spec.content_spec or {})
        payload.setdefault("title", spec.title or "")
        points = _slide_display_points(spec, limit=10, include_title=False)

        if layout_id == "motivation_compare":
            current = payload.get("current")
            target = payload.get("target")
            gap = payload.get("gap")
            transition = re.search(r"从(.{2,28}?)(?:到|走向|迈向|升级为)(.{2,28})", spec.title or "")
            if transition:
                current = current or {"label": "现状", "points": [transition.group(1).strip()]}
                target = target or {"label": "目标", "points": [transition.group(2).strip()]}
            if not _semantic_text(current):
                current = {"label": "现状", "points": [points[0] if points else f"围绕“{spec.title}”的现有做法仍较分散"]}
            if not _semantic_text(target) or _semantic_text(target).lower() == _semantic_text(current).lower():
                current_value = (
                    current.get("points") or current.get("value") or current.get("detail") or current
                    if isinstance(current, dict)
                    else current
                )
                current_key = re.sub(r"\W+", "", _semantic_text(current_value).lower())
                target_point = next((
                    point for point in points
                    if (point_key := re.sub(r"\W+", "", point.lower()))
                    and point_key not in current_key
                    and current_key not in point_key
                ), "")
                target = {"label": "目标", "points": [target_point or f"形成围绕“{spec.title}”的清晰方法与验证闭环"]}
            if not _semantic_text(gap):
                gap = points[2] if len(points) > 2 else "需要补齐从现状到目标的关键机制与验证证据"
            payload.update({"current": current, "target": target, "gap": gap})

        elif layout_id in {"method_pipeline", "technical_route"}:
            raw_steps = payload.get("steps") if isinstance(payload.get("steps"), list) else payload.get("stages")
            steps = _sequence_parts(raw_steps)
            if len(_dedupe_semantic_items(steps, limit=5)) < 3:
                steps.extend(_title_sequence_parts(spec.title or ""))
            if len(_dedupe_semantic_items(steps, limit=5)) < 3:
                steps.extend(_domain_sequence_defaults(deck_text))
            payload["steps"] = _dedupe_semantic_items(steps, limit=5)[:5]
            if layout_id == "technical_route":
                payload["stages"] = payload["steps"]

        elif layout_id == "method_loop":
            raw_steps = payload.get("steps") if isinstance(payload.get("steps"), list) else payload.get("stages")
            steps = _sequence_parts(raw_steps)
            if len(_dedupe_semantic_items(steps, limit=4)) < 3:
                steps.extend(_title_sequence_parts(spec.title or ""))
            if len(_dedupe_semantic_items(steps, limit=4)) < 3:
                steps.extend(_domain_sequence_defaults(deck_text, loop=True))
            payload["steps"] = _dedupe_semantic_items(steps, limit=4)[:4]
            payload["stages"] = payload["steps"]

        elif layout_id == "leaderboard_table":
            if len(_meaningful_payload_rows(payload)) < 3:
                spec, payload = _fallback_from_incomplete_table(spec, payload)

        elif layout_id == "benchmark_metrics":
            kpis = _dedupe_semantic_items(payload.get("kpis") if isinstance(payload.get("kpis"), list) else [], limit=6)
            if len(kpis) >= 3:
                payload["kpis"] = kpis
            elif len(_meaningful_payload_rows(payload)) < 3:
                spec, payload = _fallback_from_incomplete_table(spec, payload)

        elif layout_id == "ablation_matrix":
            if len(_meaningful_payload_rows(payload)) < 3:
                spec, payload = _fallback_from_incomplete_table(spec, payload)

        elif layout_id == "summary_takeaways":
            candidates: list[Any] = []
            for key in ("findings", "cards", "points"):
                if isinstance(payload.get(key), list):
                    candidates.extend(payload[key])
            for key, label in (("conclusion", "核心结论"), ("limitations", "关键限制"), ("limitation", "关键限制"), ("next_step", "下一步")):
                value = payload.get(key)
                if _semantic_text(value):
                    candidates.append({"title": label, "points": [_semantic_text(value)]})
            candidates.extend(points)
            cards = _dedupe_semantic_items(candidates, limit=3)
            defaults = [
                {"title": "核心结论", "points": [points[0] if points else f"{spec.title}需要围绕关键问题形成清晰结论"]},
                {"title": "关键限制", "points": [points[1] if len(points) > 1 else "结论应明确适用边界与证据限制"]},
                {"title": "下一步", "points": [points[2] if len(points) > 2 else "用可验证的行动继续推进"]},
            ]
            for default in defaults:
                if len(cards) >= 3:
                    break
                default_point = _semantic_text(default.get("points"))
                existing_text = " ".join(_semantic_text(item) for item in cards)
                if default_point and default_point in existing_text:
                    continue
                cards.append(default)
            cards = _dedupe_semantic_items(cards, limit=3)
            payload["cards"] = cards
            payload["points"] = cards

        repaired.append(replace(spec, content_spec=payload))
    return repaired


def parse_slide_specs(user_message: str, assistant_answer: str) -> list[SlideSpec]:
    specs = _parse_multilingual_markdown_table(assistant_answer)
    if not specs:
        specs = _base_parse_slide_specs(user_message, assistant_answer)
    if _looks_like_empty_generic_deck(specs):
        return []
    repaired = _fit_specs_to_requested_count(user_message, _repair_slide_titles(user_message, specs))
    merged = _apply_machine_deck_spec(repaired, assistant_answer)
    return _repair_semantic_content_specs(user_message, merged)



__all__ = [
    "_extract_highlight",
    "_numeric_highlights",
    "_prominent_numeric_highlights",
    "_fallback_outline_from_message",
    "_outline_titles_by_number",
    "_parse_slide_ordinal",
    "_parse_bullets",
    "_is_reference_fragment_text",
    "_is_intermediate_artifact_text",
    "_strip_visible_source_anchor",
    "_is_layout_instruction_text",
    "_meaningful_bullets",
    "_is_low_substance_bullet",
    "_dedupe_visible_points",
    "_evidence_visible_points",
    "_slide_display_points",
    "_clean_slide_cell",
    "_normalize_slide_table_key",
    "_slide_table_field",
    "_is_markdown_separator_row",
    "_split_markdown_row",
    "_markdown_table_blocks",
    "_parse_slide_table_block",
    "_parse_multilingual_markdown_table",
    "_generic_slide_title_number",
    "_is_generic_slide_title",
    "_infer_title_from_spec",
    "_repair_slide_titles",
    "_looks_like_empty_generic_deck",
    "_requested_slide_count",
    "_merge_specs",
    "_fit_specs_to_requested_count",
    "_extract_machine_deck_spec",
    "_apply_machine_deck_spec",
    "_semantic_text",
    "_dedupe_semantic_items",
    "_sequence_parts",
    "_title_sequence_parts",
    "_domain_sequence_defaults",
    "_payload_rows",
    "_meaningful_payload_rows",
    "_replace_spec_layout",
    "_fallback_from_incomplete_table",
    "_repair_semantic_content_specs",
    "parse_slide_specs",
]
