from __future__ import annotations

from copy import deepcopy
import math
import re
from pathlib import Path
from typing import Any

from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.enum.text import MSO_AUTO_SIZE, PP_ALIGN, MSO_ANCHOR
from pptx.dml.color import RGBColor
from pptx.oxml.ns import qn
from pptx.oxml.xmlchemy import OxmlElement
from pptx.util import Inches, Pt
from ppt_pipeline.content_payloads import (
    _compact_node_label,
    _compact_supporting_text,
    _display,
    _item_parts,
    _message_points,
    _payload_numbers,
    _payload_points,
    _structured_list,
)

KNOWN_LAYOUT_IDS = {
    "basic_content",
    "motivation_compare",
    "challenge_map",
    "method_pipeline",
    "method_loop",
    "benchmark_metrics",
    "result_big_numbers",
    "results_bars",
    "leaderboard_table",
    "ablation_matrix",
    "evidence_grid",
    "case_gallery",
    "summary_takeaways",
    "project_target_map",
    "domain_object_map",
    "technical_route",
    "workpackage_matrix",
    "evaluation_dashboard",
    "risk_action_table",
    "milestone_roadmap",
    "media_showcase",
}

def _scan_slide_library(prs: Presentation) -> dict[str, int]:
    result: dict[str, int] = {}
    for index, slide in enumerate(prs.slides):
        for shape in slide.shapes:
            text = _shape_text(shape).strip()
            if shape.name.startswith("tpl-title-") and text in KNOWN_LAYOUT_IDS:
                result[text] = index
                break
    return result


def _remove_shape(shape) -> None:
    element = shape.element
    parent = element.getparent()
    if parent is not None:
        parent.remove(element)


def _set_shape_text_color(shape: Any, color: RGBColor) -> None:
    if shape is None or not getattr(shape, "has_text_frame", False):
        return
    for paragraph in shape.text_frame.paragraphs:
        for run in paragraph.runs:
            try:
                run.font.color.rgb = color
            except Exception:
                pass


def _append_deck_rhythm_warnings(roles: list[str], warnings: list[str]) -> None:
    families = [_layout_family(role) for role in roles]
    densities = [_layout_density(role, {}, 0) for role in roles]
    for index in range(1, len(roles)):
        if densities[index - 1] == densities[index] == "dense":
            warnings.append(
                f"第 {index + 1}、{index + 2} 页仍连续使用高密度页面；当前内容缺少安全的语义等价替补版式。"
            )
    for index in range(2, len(roles)):
        if families[index - 2] == families[index - 1] == families[index]:
            warnings.append(
                f"第 {index}–{index + 2} 页连续属于 {families[index]} 类型，建议下一轮内容规划中插入不同密度页面。"
            )


def _clone_slide(prs: Presentation, source_slide):
    destination = prs.slides.add_slide(source_slide.slide_layout)
    for shape in list(destination.shapes):
        element = shape.element
        element.getparent().remove(element)

    relationship_map: dict[str, str] = {}
    for rel in source_slide.part.rels.values():
        if rel.reltype.endswith("/slideLayout") or rel.reltype.endswith("/notesSlide"):
            continue
        try:
            if rel.is_external:
                new_id = destination.part.relate_to(rel.target_ref, rel.reltype, is_external=True)
            else:
                new_id = destination.part.relate_to(rel._target, rel.reltype)
            relationship_map[rel.rId] = new_id
        except Exception:
            continue

    for shape in source_slide.shapes:
        element = deepcopy(shape.element)
        _remap_relationship_ids(element, relationship_map)
        destination.shapes._spTree.insert_element_before(element, "p:extLst")

    source_bg = source_slide._element.cSld.bg
    if source_bg is not None:
        destination_bg = destination._element.cSld.bg
        if destination_bg is not None:
            destination._element.cSld.remove(destination_bg)
        destination._element.cSld.insert(0, deepcopy(source_bg))
    return destination


def _remap_relationship_ids(element, relationship_map: dict[str, str]) -> None:
    if not relationship_map:
        return
    for node in element.iter():
        for attr, value in list(node.attrib.items()):
            if value in relationship_map:
                node.set(attr, relationship_map[value])


def _remove_original_slides(prs: Presentation, count: int) -> None:
    slide_ids = list(prs.slides._sldIdLst)[:count]
    for slide_id in slide_ids:
        prs.part.drop_rel(slide_id.rId)
        prs.slides._sldIdLst.remove(slide_id)


def _walk_shapes(shapes):
    for shape in shapes:
        yield shape
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from _walk_shapes(shape.shapes)


def _shape_text(shape) -> str:
    return str(getattr(shape, "text", "") or "")


def _coerce_image_paths(value: Path | list[Path] | tuple[Path, ...] | None) -> list[Path]:
    if isinstance(value, Path):
        return [value] if value.is_file() else []
    if isinstance(value, (list, tuple)):
        return [path for path in value if isinstance(path, Path) and path.is_file()]
    return []


def _shapes_named(slide, name: str) -> list[Any]:
    return [shape for shape in _walk_shapes(slide.shapes) if shape.name == name]


def _shape_named(slide, name: str):
    matches = _shapes_named(slide, name)
    return matches[0] if matches else None


def _sample_text_style(shape) -> dict[str, Any]:
    result: dict[str, Any] = {}
    try:
        paragraph = shape.text_frame.paragraphs[0]
        result["alignment"] = paragraph.alignment
        result["level"] = paragraph.level
        run = paragraph.runs[0] if paragraph.runs else None
        if run is not None:
            font = run.font
            result.update({
                "name": font.name,
                "size": font.size,
                "bold": font.bold,
                "italic": font.italic,
            })
            try:
                result["rgb"] = font.color.rgb
            except Exception:
                result["rgb"] = None
            try:
                result["theme_color"] = font.color.theme_color
                result["brightness"] = font.color.brightness
            except Exception:
                result["theme_color"] = None
    except Exception:
        pass
    return result


_FORMAL_LATIN_PREFIXES = (
    "bench-kpi",
    "bench-table-",
    "big-kpi",
    "bar",
    "leaderboard-grid-",
    "ablation-grid-",
    "pipeline-grid-",
    "target-grid-",
    "wp-grid-",
    "eval-kpi",
    "eval-bar",
    "eval-status-grid-",
    "risk-grid-",
)


def _latin_font_for_shape(shape: Any) -> str:
    name = str(getattr(shape, "name", "") or "")
    return "Arial" if name.startswith(_FORMAL_LATIN_PREFIXES) else "Comic Sans MS"


def _set_run_typefaces(run: Any, *, latin: str, east_asian: str = "Microsoft YaHei") -> None:
    """Set Latin and East Asian faces explicitly for stable cross-viewer output."""
    try:
        run.font.name = latin
        properties = run._r.get_or_add_rPr()
        for tag, typeface in (("a:latin", latin), ("a:ea", east_asian), ("a:cs", latin)):
            element = properties.find(qn(tag))
            if element is None:
                element = OxmlElement(tag)
                properties.append(element)
            element.set("typeface", typeface)
    except Exception:
        pass


def _text_visual_units(text: str) -> float:
    total = 0.0
    for char in str(text or ""):
        if char.isspace():
            total += 0.3
        elif ord(char) > 0x2E7F:
            total += 1.0
        elif char.isupper():
            total += 0.64
        elif char in "mwMW@%&":
            total += 0.78
        elif char in "ilI1|.,:;'`":
            total += 0.32
        else:
            total += 0.56
    return total


def _shape_fit_font_size(shape: Any, max_size: float, min_size: float = 10.0) -> float:
    if shape is None or not getattr(shape, "has_text_frame", False):
        return max_size
    frame = shape.text_frame
    usable_width = max(
        0.35,
        float(shape.width - frame.margin_left - frame.margin_right) / 914400,
    )
    usable_height = max(
        0.18,
        float(shape.height - frame.margin_top - frame.margin_bottom) / 914400,
    )
    paragraphs = list(frame.paragraphs)
    for half_points in range(int(max_size * 2), int(min_size * 2) - 1, -1):
        size = half_points / 2.0
        units_per_line = max(1.0, usable_width * 72.0 / size)
        total_lines = 0
        paragraph_gap = 0.0
        line_multiplier = 1.18
        for paragraph in paragraphs:
            text = paragraph.text or " "
            segments = text.splitlines() or [" "]
            for segment in segments:
                units = max(0.5, _text_visual_units(segment) * 1.08)
                total_lines += max(1, math.ceil(units / units_per_line))
            try:
                if paragraph.space_after is not None:
                    paragraph_gap += float(paragraph.space_after.pt) / 72.0
            except Exception:
                pass
            try:
                if isinstance(paragraph.line_spacing, float):
                    line_multiplier = max(line_multiplier, paragraph.line_spacing)
            except Exception:
                pass
        required_height = total_lines * (size / 72.0) * line_multiplier + paragraph_gap
        if required_height <= usable_height:
            return size
    return min_size


def _apply_shape_font_size(shape: Any, size: float) -> None:
    if shape is None or not getattr(shape, "has_text_frame", False):
        return
    for paragraph in shape.text_frame.paragraphs:
        for run in paragraph.runs:
            run.font.size = Pt(size)


def _refit_shape_text(shape: Any, max_size: float | None = None, min_size: float = 10.0) -> None:
    if shape is None or not getattr(shape, "has_text_frame", False):
        return
    sizes = [
        float(run.font.size.pt)
        for paragraph in shape.text_frame.paragraphs
        for run in paragraph.runs
        if run.font.size is not None
    ]
    target = float(max_size) if max_size is not None else (max(sizes) if sizes else 12.0)
    _apply_shape_font_size(shape, _shape_fit_font_size(shape, target, min_size=min_size))


def _set_shape_text(shape, text: str, *, max_size: float | None = None, bold: bool | None = None) -> None:
    if shape is None or not getattr(shape, "has_text_frame", False):
        return
    style = _sample_text_style(shape)
    frame = shape.text_frame
    frame.clear()
    frame.word_wrap = True
    # PowerPoint/WPS and LibreOffice apply normAutofit differently. Compute an
    # explicit safe font size here so the preview and downloaded deck use the
    # same typography instead of relying on viewer-specific auto shrinking.
    frame.auto_size = MSO_AUTO_SIZE.NONE
    frame.vertical_anchor = getattr(frame, "vertical_anchor", None) or MSO_ANCHOR.MIDDLE
    lines = [line.strip() for line in str(text or "").splitlines() if line.strip()] or [""]
    target_size = float(max_size) if max_size is not None else None
    if target_size is not None and target_size <= 15:
        target_size += 1
    for line_index, line in enumerate(lines):
        paragraph = frame.paragraphs[0] if line_index == 0 else frame.add_paragraph()
        paragraph.alignment = style.get("alignment")
        paragraph.level = style.get("level") or 0
        run = paragraph.add_run()
        run.text = line
        font = run.font
        latin_font = style.get("name") or _latin_font_for_shape(shape)
        if latin_font == "Arial" and not str(getattr(shape, "name", "") or "").startswith(_FORMAL_LATIN_PREFIXES):
            latin_font = "Comic Sans MS"
        _set_run_typefaces(run, latin=latin_font)
        size = style.get("size")
        if target_size is not None:
            # Semantic binders pass the desired readable size for the content
            # role. Preserve the template's font family/color, but do not let a
            # small placeholder font silently cap all generated slide text.
            font.size = Pt(max(10, target_size))
        elif size is not None:
            font.size = size
        if bold is not None:
            font.bold = bold
        elif style.get("bold") is not None:
            font.bold = style["bold"]
        if style.get("italic") is not None:
            font.italic = style["italic"]
        try:
            if style.get("rgb") is not None:
                font.color.rgb = style["rgb"]
            elif style.get("theme_color") is not None:
                font.color.theme_color = style["theme_color"]
                font.color.brightness = style.get("brightness") or 0
        except Exception:
            pass
    shape_name = str(getattr(shape, "name", "") or "")
    if shape_name.startswith("tpl-title-"):
        minimum = 18.0
    elif shape_name.startswith(_FORMAL_LATIN_PREFIXES):
        minimum = 10.0
    elif any(token in shape_name for token in ("caption", "note", "guide", "legend", "rule")):
        minimum = 11.0
    else:
        minimum = 12.0
    _refit_shape_text(shape, max_size=target_size, min_size=minimum)


def _set_named(slide, name: str, value: str, *, max_size: float | None = None, bold: bool | None = None, occurrence: int = 0) -> None:
    shapes = _shapes_named(slide, name)
    if occurrence < len(shapes):
        _set_shape_text(shapes[occurrence], value, max_size=max_size, bold=bold)


def _set_named_many(slide, name: str, values: list[str], *, max_size: float | None = None) -> None:
    for index, shape in enumerate(_shapes_named(slide, name)):
        _set_shape_text(shape, values[index] if index < len(values) else "", max_size=max_size)


def _remove_named(slide, name: str) -> None:
    for shape in list(_shapes_named(slide, name)):
        _remove_shape(shape)


def _remove_prefix(slide, prefix: str) -> None:
    for shape in list(_walk_shapes(slide.shapes)):
        if str(getattr(shape, "name", "") or "").startswith(prefix):
            _remove_shape(shape)


def _remove_crosses(slide, slot_name: str) -> None:
    _remove_named(slide, f"{slot_name}-cross-a")
    _remove_named(slide, f"{slot_name}-cross-b")


def _bind_cover(slide, spec: Any, template_id: str) -> None:
    title = str(getattr(spec, "title", "") or "PRESENTATION")
    points = _message_points(getattr(spec, "message", ""), 2)
    subtitle = points[0] if points else ""
    title_shape = next((
        shape for shape in _walk_shapes(slide.shapes)
        if shape.is_placeholder
        and "SUBTITLE" not in _placeholder_type(shape)
        and "TITLE" in _placeholder_type(shape)
    ), None)
    subtitle_shape = next((shape for shape in _walk_shapes(slide.shapes) if shape.is_placeholder and "SUBTITLE" in _placeholder_type(shape)), None)
    if title_shape is not None:
        _set_shape_text(title_shape, title, max_size=34, bold=True)
        if subtitle_shape is not None:
            _set_shape_text(subtitle_shape, subtitle, max_size=17)
            if template_id == "hitsz":
                _set_shape_text_color(subtitle_shape, RGBColor(15, 58, 86))
        return
    # 华工封面是完整品牌图片，因此在保留背景的同时叠加可编辑标题。
    title_box = slide.shapes.add_textbox(Inches(1.18), Inches(2.15), Inches(10.95), Inches(1.35))
    title_box.name = "janus-cover-title"
    title_box.text_frame.vertical_anchor = MSO_ANCHOR.MIDDLE
    _set_shape_text(title_box, title, max_size=30, bold=True)
    title_box.text_frame.paragraphs[0].alignment = PP_ALIGN.CENTER
    if subtitle:
        subtitle_box = slide.shapes.add_textbox(Inches(2.0), Inches(3.7), Inches(9.3), Inches(0.72))
        subtitle_box.name = "janus-cover-subtitle"
        _set_shape_text(subtitle_box, subtitle, max_size=15)
        subtitle_box.text_frame.paragraphs[0].alignment = PP_ALIGN.CENTER


def _placeholder_type(shape) -> str:
    try:
        return str(shape.placeholder_format.type).upper()
    except Exception:
        return ""



__all__ = [
    "_set_shape_text_color",
    "_remove_shape",
    "_scan_slide_library",
    "_append_deck_rhythm_warnings",
    "_clone_slide",
    "_remap_relationship_ids",
    "_remove_original_slides",
    "_walk_shapes",
    "_shape_text",
    "_coerce_image_paths",
    "_shapes_named",
    "_shape_named",
    "_sample_text_style",
    "_latin_font_for_shape",
    "_set_run_typefaces",
    "_text_visual_units",
    "_shape_fit_font_size",
    "_apply_shape_font_size",
    "_refit_shape_text",
    "_set_shape_text",
    "_set_named",
    "_set_named_many",
    "_remove_named",
    "_remove_prefix",
    "_remove_crosses",
    "_bind_cover",
    "_placeholder_type",
]
