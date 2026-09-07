from __future__ import annotations

import re
from typing import Any

from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from janus_lab.ppt_renderer import SlideSpec
from ppt_pipeline.content_parsing import *
from ppt_pipeline.render_primitives import *
from ppt_pipeline.style_catalog import PPTStyleDecision
from ppt_pipeline.template_core import *
from ppt_pipeline.template_feature_layouts import *
from ppt_pipeline.template_hitsz_layouts import *

def _render_template_chrome_two_column_plain_layout(
    slide,
    spec: SlideSpec,
    style: PPTStyleDecision,
    content_box: tuple[float, float, float, float],
) -> None:
    if not _is_scut_academic_chrome(style):
        _render_template_chrome_comparison_layout(slide, spec, style, content_box)
        return
    p = style.palette
    ref = _academic_ref_colors(style)
    x, y, w, h = content_box
    points = _template_rich_bullets(spec, limit=6)
    boost = _academic_sparse_spec_boost(style, spec, points)
    if len(points) < 2:
        _render_template_chrome_statement_sidebar_layout(slide, spec, style, content_box)
        return
    raw = f"{spec.title or ''} {spec.message or ''} {spec.visual or ''}"
    if any(key in raw for key in ["挑战", "问题", "限制", "短板", "局限", "风险"]):
        labels = (_localized_label(spec, "问题侧", "PROBLEM SIDE"), _localized_label(spec, "应对侧", "RESPONSE SIDE"))
    elif any(key in raw for key in ["价值", "收益", "用户", "平台", "业务"]):
        labels = (_localized_label(spec, "价值对象", "VALUE TARGET"), _localized_label(spec, "落地收益", "PRACTICAL GAIN"))
    elif any(key in raw for key in ["结果", "实验", "指标", "评估"]):
        labels = (_localized_label(spec, "观测结果", "OBSERVED RESULT"), _localized_label(spec, "结论解释", "INTERPRETATION"))
    else:
        labels = (_localized_label(spec, "核心观察", "KEY OBSERVATION"), _localized_label(spec, "方法启示", "METHOD INSIGHT"))
    split = max(1, (len(points) + 1) // 2)
    cols = [points[:split], points[split:] or points[:1]]
    gap = 0.44
    col_w = (w - gap) / 2
    top = y + 0.18
    usable_h = h - 0.42
    accents = [p["accent"], p["accent2"]]
    for col, items in enumerate(cols):
        cx = x + col * (col_w + gap)
        _add_line(slide, cx, top + 0.08, cx + col_w, top + 0.08, ref["line"], width=1.0)
        _add_rect(slide, cx, top + 0.25, 0.12, 0.5, accents[col])
        _add_text(slide, labels[col], cx + 0.28, top + 0.22, col_w - 0.5, 0.32, size=12, color=p["ink"], bold=True, margin=0)
        _add_academic_plain_list(
            slide,
            style,
            items[:4],
            cx,
            top + 0.74,
            col_w,
            usable_h - 0.9,
            start=1 if col == 0 else split + 1,
            max_items=4,
            max_size=11 + min(boost, 2),
        )


def _render_template_chrome_metric_focus_layout(
    slide,
    spec: SlideSpec,
    style: PPTStyleDecision,
    content_box: tuple[float, float, float, float],
) -> None:
    if not _is_scut_academic_chrome(style):
        _render_template_chrome_bigstat_layout(slide, spec, style, content_box)
        return
    p = style.palette
    ex = _palette_extras(style)
    ref = _academic_ref_colors(style)
    x, y, w, h = content_box
    points = _template_rich_bullets(spec, limit=5)
    boost = _academic_sparse_spec_boost(style, spec, points)
    highlights = _prominent_numeric_highlights("；".join(points), limit=2)
    focus = highlights[0] if highlights else _shorten_for_cell(points[0] if points else (spec.title or ""), 12)
    focus_note = points[0] if points else (spec.title or "")
    left_w = min(4.05, w * 0.34)
    right_x = x + left_w + 0.52
    right_w = w - left_w - 0.52
    top = y + 0.22
    _add_line(slide, x, top + 0.08, x + left_w, top + 0.08, ref["line"], width=1.0)
    _add_text(slide, "FOCUS", x, top + 0.24, 0.88, 0.24, size=9, color=p["accent"], bold=True, margin=0)
    _add_autofit_text(
        slide,
        focus,
        x,
        top + 0.72,
        left_w,
        1.34,
        max_size=34 + min(boost, 3),
        min_size=18,
        color=p["accent"],
        bold=True,
        align=PP_ALIGN.CENTER,
        anchor=MSO_ANCHOR.MIDDLE,
        margin=0.01,
    )
    _add_autofit_text(
        slide,
        _academic_visible_text(style, focus_note, 42),
        x + 0.1,
        top + 2.24,
        left_w - 0.2,
        1.28,
        max_size=14 + min(boost, 2),
        min_size=10,
        color=p["ink"],
        bold=not highlights,
        align=PP_ALIGN.CENTER,
        anchor=MSO_ANCHOR.MIDDLE,
        margin=0.01,
    )
    _add_line(slide, right_x, top + 0.08, right_x + right_w, top + 0.08, ref["line"], width=1.0)
    _add_text(slide, "证据与解释", right_x, top + 0.24, 1.3, 0.26, size=10, color=p["ink"], bold=True, margin=0)
    evidence = [point for point in points if point != focus_note]
    if not evidence:
        evidence = points[1:5]
    _add_academic_plain_list(
        slide,
        style,
        evidence[:4] or [focus_note],
        right_x,
        top + 0.66,
        right_w,
        h - 1.04,
        start=1,
        max_items=4,
        max_size=12 + min(boost, 2),
    )
    if len(highlights) > 1:
        _add_rect(slide, x + 0.18, y + h - 0.74, left_w - 0.36, 0.44, "FFFFFF", line=ref["line"], radius=False)
        _add_autofit_text(slide, f"{_localized_label(spec, '次级指标', 'Secondary metric')} {highlights[1]}", x + 0.34, y + h - 0.66, left_w - 0.68, 0.28, max_size=10, min_size=8, color=ex["warm"], bold=True, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE, margin=0.01)


def _render_template_chrome_ladder_layout(
    slide,
    spec: SlideSpec,
    style: PPTStyleDecision,
    content_box: tuple[float, float, float, float],
) -> None:
    if not _is_scut_academic_chrome(style):
        _render_template_chrome_process_layout(slide, spec, style, content_box)
        return
    p = style.palette
    ex = _palette_extras(style)
    ref = _academic_ref_colors(style)
    x, y, w, h = content_box
    points = _template_rich_bullets(spec, limit=5)
    boost = _academic_sparse_spec_boost(style, spec, points)
    if len(points) <= 1:
        _render_template_chrome_statement_sidebar_layout(slide, spec, style, content_box)
        return
    top = y + 0.22
    row_count = min(len(points), 5)
    row_h = min(0.78 if boost < 3 else 0.9, (h - 0.48) / row_count)
    accents = [p["accent"], p["accent2"], ex["warm"], ex["good"], ex["danger"]]
    _add_line(slide, x + 0.18, top + 0.08, x + w - 0.18, top + 0.08, ref["line"], width=1.0)
    for i, point in enumerate(points[:row_count]):
        cy = top + 0.34 + i * row_h
        indent = min(0.62, i * 0.15)
        cx = x + indent
        usable_w = w - indent - 0.08
        accent = accents[i % len(accents)]
        _add_template_icon(slide, _template_icon_kind(point), cx, cy + 0.09, 0.44, accent)
        _add_line(slide, cx + 0.58, cy + row_h - 0.02, x + w - 0.12, cy + row_h - 0.02, ref["line"], width=0.75)
        _add_autofit_text(
            slide,
            _academic_visible_text(style, point, 48),
            cx + 0.66,
            cy + 0.04,
            usable_w - 0.74,
            row_h - 0.08,
            max_size=13 + min(boost, 3),
            min_size=9,
            color=p["ink"],
            anchor=MSO_ANCHOR.MIDDLE,
            margin=0.01,
        )


def _render_template_chrome_claim_variant_layout(
    slide,
    spec: SlideSpec,
    style: PPTStyleDecision,
    content_box: tuple[float, float, float, float],
    *,
    index: int = 0,
) -> None:
    if not _is_scut_academic_chrome(style):
        _render_template_chrome_claim_layout(slide, spec, style, content_box)
        return
    points = _template_rich_bullets(spec, limit=6)
    raw = f"{spec.title or ''} {spec.message or ''} {spec.visual or ''}"
    numbery = sum(1 for point in points if _extract_highlight(point))
    if len(points) <= 2:
        _render_template_chrome_sparse_variant_layout(slide, spec, style, content_box, index=index)
    elif numbery >= 1 and any(key in raw for key in ["结果", "实验", "指标", "评估", "性能", "提升", "下降", "CTR", "CVR", "Recall", "NDCG"]):
        _render_template_chrome_metric_focus_layout(slide, spec, style, content_box)
    elif len(points) >= 4 and any(key in raw for key in ["流程", "步骤", "链路", "路线", "框架", "架构", "系统", "模块"]):
        _render_template_chrome_ladder_layout(slide, spec, style, content_box)
    elif len(points) >= 3 and any(key in raw for key in ["对比", "挑战", "问题", "限制", "风险", "价值", "用户", "平台", "业务"]):
        _render_template_chrome_two_column_plain_layout(slide, spec, style, content_box)
    elif index % 4 == 1:
        _render_template_chrome_claim_band_layout(slide, spec, style, content_box)
    elif index % 4 == 2 and len(points) >= 2:
        _render_template_chrome_two_column_plain_layout(slide, spec, style, content_box)
    elif index % 4 == 3:
        _render_template_chrome_metric_focus_layout(slide, spec, style, content_box)
    else:
        _render_template_chrome_ladder_layout(slide, spec, style, content_box)


def _render_template_chrome_process_layout(
    slide,
    spec: SlideSpec,
    style: PPTStyleDecision,
    content_box: tuple[float, float, float, float],
) -> None:
    p = style.palette
    ex = _palette_extras(style)
    points = _template_rich_bullets(spec, limit=5)
    if len(points) <= 2:
        _render_template_chrome_sparse_variant_layout(slide, spec, style, content_box)
        return
    n = min(max(len(points), 1), 4 if _is_scut_academic_chrome(style) else 5)
    x, y, w, h = content_box
    card_gap = 0.18
    card_w = (w - card_gap * (n - 1)) / n
    top = y + 0.34
    block_h = min(2.64 if _is_scut_academic_chrome(style) else 2.36, h - 1.48)
    rail_y = top + 0.54
    accents = [p["accent"], p["accent2"], ex["warm"], ex["good"], ex["danger"]]

    if _is_scut_academic_chrome(style):
        ref = _academic_ref_colors(style)
        rail_y = top + 0.62
        _add_line(slide, x + 0.1, rail_y, x + w - 0.1, rail_y, ref["line"], width=1.4)
        for i, point in enumerate((points or [spec.title or ""])[:n]):
            cx = x + i * (card_w + card_gap)
            accent = accents[i % len(accents)]
            icon_size = 0.46
            _add_template_icon(
                slide,
                _template_icon_kind(point),
                cx + 0.08,
                rail_y - icon_size / 2,
                icon_size,
                accent,
            )
            _add_text(slide, _localized_label(spec, "阶段", "STEP"), cx + 0.64, top + 0.14, min(1.18, card_w - 0.7), 0.26, size=9, color=accent, bold=True, margin=0)
            _add_line(slide, cx + 0.64, top + 0.5, cx + card_w - 0.1, top + 0.5, accent, width=0.9)
            _add_autofit_text(
                slide,
                point,
                cx + 0.08,
                rail_y + 0.36,
                card_w - 0.12,
                block_h - 0.76,
                max_size=12,
                min_size=9,
                color=p["ink"],
                anchor=MSO_ANCHOR.TOP,
                margin=0.01,
            )
            if i < n - 1:
                _add_text(slide, "→", cx + card_w - 0.06, rail_y - 0.16, card_gap + 0.1, 0.28, size=13, color=accent, bold=True, align=PP_ALIGN.CENTER, margin=0)
        note = (points[:1] or [None])[0]
        band_y = top + block_h + 0.38
        if note and band_y + 0.72 <= y + h:
            _add_academic_plain_note(slide, style, note, x, band_y, w, 0.64, label=_localized_label(spec, "讲解", "NOTE"))
        return

    _add_line(slide, x + 0.24, rail_y, x + w - 0.24, rail_y, ex["grid"], width=1.6)
    for i, point in enumerate((points or [spec.title or ""] )[:n]):
        cx = x + i * (card_w + card_gap)
        accent = accents[i % len(accents)]
        _add_academic_ref_panel(slide, style, cx, top, card_w, block_h, fill=_academic_ref_fill(style, i), accent=accent, radius=False)
        _add_rect(slide, cx, top, card_w, 0.1, accent)
        _add_text(slide, f"0{i + 1}", cx + 0.16, top + 0.24, 0.55, 0.28, size=10, color=accent, bold=True, align=PP_ALIGN.LEFT, margin=0)
        icon_size = 0.42
        _add_template_icon(
            slide,
            _template_icon_kind(point),
            cx + card_w * 0.5 - icon_size / 2,
            rail_y - icon_size / 2,
            icon_size,
            accent,
        )
        _add_autofit_text(
            slide,
            point,
            cx + 0.22,
            rail_y + 0.42,
            card_w - 0.44,
            block_h - 1.02,
            max_size=10,
            min_size=7,
            color=p["ink"],
            align=PP_ALIGN.LEFT if _is_scut_academic_chrome(style) else PP_ALIGN.CENTER,
            anchor=MSO_ANCHOR.TOP if _is_scut_academic_chrome(style) else MSO_ANCHOR.MIDDLE,
            margin=0.04,
        )
        if i < n - 1:
            _add_text(slide, "→", cx + card_w - 0.02, rail_y - 0.18, card_gap + 0.04, 0.3, size=14, color=accent, bold=True, align=PP_ALIGN.CENTER, margin=0)
    note = (points[:1] or [None])[0]
    band_y = top + block_h + 0.34
    if note and band_y + 0.74 <= y + h:
        _add_academic_ref_panel(slide, style, x, band_y, w, 0.74, fill="FFFFFF", radius=False)
        _add_rect(slide, x, band_y, 0.1, 0.74, p["accent"])
        _add_autofit_text(
            slide,
            note,
            x + 0.28,
            band_y + 0.08,
            w - 0.48,
            0.56,
            max_size=10,
            min_size=7,
            color=p["muted"],
            anchor=MSO_ANCHOR.MIDDLE,
            margin=0.02,
        )


def _render_template_chrome_matrix_layout(
    slide,
    spec: SlideSpec,
    style: PPTStyleDecision,
    content_box: tuple[float, float, float, float],
) -> None:
    p = style.palette
    ex = _palette_extras(style)
    points = _template_rich_bullets(spec, limit=6)
    if len(points) <= 2:
        _render_template_chrome_claim_variant_layout(slide, spec, style, content_box)
        return
    x, y, w, h = content_box
    rows = min(len(points), 5 if _is_scut_academic_chrome(style) else 6)
    table_x = x
    table_y = y + 0.28
    table_w = w
    header_h = 0.54 if _is_scut_academic_chrome(style) else 0.46
    row_h = min(0.82 if _is_scut_academic_chrome(style) else 0.68, (h - header_h - 0.62) / max(rows, 1))
    label_w = min(3.45, w * 0.31)
    col_ws = [0.5, label_w, w - label_w - 0.94]
    accents = [p["accent"], p["accent2"], ex["warm"], ex["good"], ex["danger"], p["accent"]]
    headers = ["", _localized_label(spec, "模块/对象", "MODULE / OBJECT"), _localized_label(spec, "说明", "DESCRIPTION")]
    cx = table_x
    for j, header in enumerate(headers):
        fill = p["accent"] if j == 0 else ex["soft"]
        _add_rect(slide, cx, table_y, col_ws[j], header_h, fill, line=ex["grid"], radius=False)
        _add_autofit_text(
            slide,
            header,
            cx + 0.08,
            table_y + 0.08,
            col_ws[j] - 0.16,
            header_h - 0.14,
            max_size=11 if _is_scut_academic_chrome(style) else 9,
            min_size=9 if _is_scut_academic_chrome(style) else 7,
            color=p["bg"] if j == 0 else p["ink"],
            bold=True,
            align=PP_ALIGN.CENTER,
            anchor=MSO_ANCHOR.MIDDLE,
            margin=0.01,
        )
        cx += col_ws[j]
    for i, point in enumerate(points[:rows]):
        cy = table_y + header_h + i * row_h
        accent = accents[i % len(accents)]
        chunks = re.split(r"[:：]", point, maxsplit=1)
        label = _shorten_for_cell(chunks[0], 16) if len(chunks) > 1 else _shorten_for_cell(point, 16)
        desc = _academic_visible_text(style, chunks[1].strip() if len(chunks) > 1 else point, 38)
        cells = ["•", label, desc]
        cx = table_x
        for j, cell in enumerate(cells):
            fill = _academic_ref_colors(style)["fill_blue"] if (_is_scut_academic_chrome(style) and i % 2 == 0) else (ex["soft"] if i % 2 == 0 else "FFFFFF")
            _add_rect(slide, cx, cy, col_ws[j], row_h - 0.02, fill, line=ex["grid"], radius=False)
            if j == 0:
                _add_rect(slide, cx, cy, 0.07, row_h - 0.02, accent)
            _add_autofit_text(
                slide,
                cell,
                cx + 0.08,
                cy + 0.07,
                col_ws[j] - 0.16,
                row_h - 0.14,
                max_size=11 if j != 2 else (10 if _is_scut_academic_chrome(style) else 9),
                min_size=8 if _is_scut_academic_chrome(style) else 7,
                color=accent if j == 0 else p["ink"],
                bold=j < 2,
                align=PP_ALIGN.CENTER if j < 2 else PP_ALIGN.LEFT,
                anchor=MSO_ANCHOR.MIDDLE,
                margin=0.01,
            )
            cx += col_ws[j]


def _render_template_chrome_bigstat_layout(
    slide,
    spec: SlideSpec,
    style: PPTStyleDecision,
    content_box: tuple[float, float, float, float],
) -> None:
    p = style.palette
    ex = _palette_extras(style)
    bullets = _template_rich_bullets(spec, limit=4)
    boost = _academic_sparse_spec_boost(style, spec, bullets)
    stats = [(text, _extract_highlight(text)) for text in bullets]
    stats = [(text, value) for text, value in stats if value]
    if len(stats) < 2:
        _render_template_chrome_comparison_layout(slide, spec, style, content_box)
        return
    x, y, w, h = content_box
    n = min(len(stats), 4)
    gap = 0.22
    card_w = (w - gap * (n - 1)) / n
    card_h = min(2.45, h * 0.48)
    top = y + 0.36
    accents = [p["accent"], p["accent2"], ex["warm"], ex["good"]]
    for i, (text, value) in enumerate(stats[:n]):
        cx = x + i * (card_w + gap)
        _add_academic_ref_panel(slide, style, cx, top, card_w, card_h, fill=_academic_ref_fill(style, i), accent=accents[i % len(accents)], radius=True)
        _add_rect(slide, cx, top, card_w, 0.08, accents[i % len(accents)])
        _add_autofit_text(
            slide,
            value or "",
            cx + 0.18,
            top + 0.36,
            card_w - 0.36,
            0.74,
            max_size=27,
            min_size=14,
            color=accents[i % len(accents)],
            bold=True,
            align=PP_ALIGN.CENTER,
            anchor=MSO_ANCHOR.MIDDLE,
            margin=0.02,
        )
        _add_autofit_text(
            slide,
            text,
            cx + 0.18,
            top + 1.26,
            card_w - 0.36,
            card_h - 1.42,
            max_size=10,
            min_size=7,
            color=p["ink"],
            align=PP_ALIGN.CENTER,
            anchor=MSO_ANCHOR.TOP,
            margin=0.03,
        )
    remaining = [point for point in bullets if not _extract_highlight(point)]
    note = remaining[0] if remaining else (points[:1] or [""])[0]
    band_y = top + card_h + 0.46
    if band_y + 1.12 <= y + h:
        _add_academic_ref_panel(slide, style, x, band_y, w, 1.12, fill="FFFFFF", radius=True)
        _add_text(slide, _localized_label(spec, "结果解读", "INTERPRETATION"), x + 0.32, band_y + 0.18, 1.1, 0.24, size=9, color=p["accent"], bold=True, margin=0)
        _add_autofit_text(
            slide,
            note or "关键数字表明本页结论有可量化证据支撑。",
            x + 1.45,
            band_y + 0.14,
            w - 1.75,
            0.84,
            max_size=12 + min(boost, 3),
            min_size=8,
            color=p["muted"],
            anchor=MSO_ANCHOR.MIDDLE,
            margin=0.03,
        )


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


def _render_template_chrome_results_bars_layout(
    slide,
    spec: SlideSpec,
    style: PPTStyleDecision,
    content_box: tuple[float, float, float, float],
) -> None:
    p = style.palette
    ex = _palette_extras(style)
    x, y, w, h = content_box
    points = _template_rich_bullets(spec, limit=4)
    values = _numeric_highlights("；".join(points), limit=5)
    if len(values) < 2:
        _render_template_chrome_bigstat_layout(slide, spec, style, content_box)
        return
    parsed: list[float] = []
    for value in values:
        try:
            parsed.append(float(value.replace("%", "").replace("％", "")))
        except ValueError:
            parsed.append(0.0)
    max_value = max(parsed) if parsed else 1.0
    max_value = max(max_value, 1.0 if max_value > 1 else max_value)
    left_w = min(4.0, w * 0.34)
    chart_x = x + left_w + 0.42
    chart_w = w - left_w - 0.42
    _add_academic_ref_panel(slide, style, x, y + 0.22, left_w, h - 0.52, fill=_academic_ref_fill(style, 0), radius=True)
    _add_rect(slide, x, y + 0.22, 0.1, h - 0.52, p["accent"])
    claim = _academic_visible_text(style, points[0] if points else (spec.title or ""), 34)
    _add_autofit_text(slide, claim, x + 0.36, y + 0.54, left_w - 0.62, 1.08, max_size=15 if _is_scut_academic_chrome(style) else 14, min_size=10 if _is_scut_academic_chrome(style) else 9, color=p["ink"], bold=True, anchor=MSO_ANCHOR.MIDDLE, margin=0.03)
    note = (points[1:2] or points[:1] or [""])[0]
    _add_autofit_text(slide, _academic_visible_text(style, note, 46), x + 0.36, y + 1.95, left_w - 0.62, 1.45, max_size=11 if _is_scut_academic_chrome(style) else 10, min_size=8 if _is_scut_academic_chrome(style) else 7, color=p["muted"], anchor=MSO_ANCHOR.TOP, margin=0.03)

    _add_academic_ref_panel(slide, style, chart_x, y + 0.22, chart_w, h - 0.52, fill="FFFFFF", radius=True)
    accents = [p["accent"], p["accent2"], ex["warm"], ex["good"], ex["danger"]]
    bar_top = y + 0.64
    row_h = min(0.86 if _is_scut_academic_chrome(style) else 0.72, (h - 1.05) / max(len(values), 1))
    labels = []
    for point in points:
        label = re.split(r"[:：]", point, maxsplit=1)[0].strip()
        if label and label not in labels:
            labels.append(_shorten_for_cell(label, 18))
    while len(labels) < len(values):
        labels.append(f"Metric {len(labels) + 1}")
    for i, (value, numeric) in enumerate(zip(values, parsed, strict=False)):
        cy = bar_top + i * row_h
        label = _academic_visible_text(style, labels[i], 16)
        _add_autofit_text(slide, label, chart_x + 0.34, cy + 0.08, 2.25, 0.36, max_size=10, min_size=8 if _is_scut_academic_chrome(style) else 6, color=p["ink"], bold=True, anchor=MSO_ANCHOR.MIDDLE, margin=0.01)
        track_x = chart_x + 2.75
        track_w = chart_w - 4.1
        _add_rect(slide, track_x, cy + 0.18, track_w, 0.16, ex["soft"], line=None, radius=False)
        ratio = min(1.0, numeric / max(max_value, 0.0001))
        _add_rect(slide, track_x, cy + 0.18, max(0.08, track_w * ratio), 0.16, accents[i % len(accents)], line=None, radius=False)
        _add_autofit_text(slide, value, chart_x + chart_w - 1.08, cy + 0.0, 0.84, 0.46, max_size=12, min_size=8, color=accents[i % len(accents)], bold=True, align=PP_ALIGN.RIGHT, anchor=MSO_ANCHOR.MIDDLE, margin=0.01)


def _render_template_chrome_leaderboard_layout(
    slide,
    spec: SlideSpec,
    style: PPTStyleDecision,
    content_box: tuple[float, float, float, float],
) -> None:
    p = style.palette
    ex = _palette_extras(style)
    x, y, w, h = content_box
    raw = "；".join(_template_rich_bullets(spec, limit=5))
    rows: list[tuple[str, str, str]] = []
    for platform in ["Bilibili", "Rednote", "Hupu"]:
        match = re.search(platform + r"[^0-9]*(?:R@20|Recall@20|R@10|Recall)?\s*([0-9]\.\d{3,4})", raw, re.IGNORECASE)
        if not match:
            match = re.search(platform + r".{0,40}?([0-9]\.\d{3,4})", raw, re.IGNORECASE)
        if match:
            rows.append((platform, "R@20", match.group(1)))
    if not rows:
        values = _numeric_highlights(raw, limit=4)
        rows = [(f"Dataset {i + 1}", "Metric", value) for i, value in enumerate(values)]
    if not rows:
        _render_template_chrome_bigstat_layout(slide, spec, style, content_box)
        return
    _add_academic_ref_panel(slide, style, x, y + 0.24, w, h - 0.58, fill="FFFFFF", radius=True)
    headers = ["Dataset", "Metric", "TailorMind", "Interpretation"]
    col_ws = [2.2, 1.65, 2.1, w - 6.3]
    row_h = min(0.86 if _is_scut_academic_chrome(style) else 0.72, (h - 1.28) / (len(rows) + 1))
    cy = y + 0.62
    cx = x + 0.32
    for col, header in enumerate(headers):
        cw = col_ws[col]
        _add_rect(slide, cx, cy, cw, 0.46, p["accent"] if col == 2 else ex["soft"], line=ex["grid"], radius=False)
        _add_autofit_text(slide, header, cx + 0.08, cy + 0.08, cw - 0.16, 0.32, max_size=9, min_size=8 if _is_scut_academic_chrome(style) else 6, color=p["bg"] if col == 2 else p["ink"], bold=True, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE, margin=0.01)
        cx += cw
    for r, (dataset, metric, value) in enumerate(rows[:5]):
        cy = y + 1.12 + r * row_h
        cx = x + 0.32
        cells = [dataset, metric, value, _localized_label(spec, "突出当前方法在个性化找回上的优势", "Highlights the method's advantage in personalized retrieval")]
        for col, cell in enumerate(cells):
            cw = col_ws[col]
            fill = _academic_ref_colors(style)["fill_blue"] if (_is_scut_academic_chrome(style) and r % 2 == 0) else (ex["soft"] if r % 2 == 0 else "FFFFFF")
            _add_rect(slide, cx, cy, cw, row_h - 0.04, fill, line=ex["grid"], radius=False)
            _add_autofit_text(
                slide,
                cell,
                cx + 0.08,
                cy + 0.08,
                cw - 0.16,
                row_h - 0.18,
                max_size=14 if col == 2 else (10 if _is_scut_academic_chrome(style) else 9),
                min_size=8 if _is_scut_academic_chrome(style) else 7,
                color=p["accent"] if col == 2 else p["ink"],
                bold=col == 2,
                align=PP_ALIGN.CENTER if col < 3 else PP_ALIGN.LEFT,
                anchor=MSO_ANCHOR.MIDDLE,
                margin=0.01,
            )
            cx += cw
    note = (points[:1] or [_localized_label(spec, "多类证据共同支撑本页结论。", "Multiple signals support this page claim.")])[0]
    _add_autofit_text(slide, _academic_visible_text(style, note, 54), x + 0.45, y + h - 0.76, w - 0.9, 0.5, max_size=11 if _is_scut_academic_chrome(style) else 10, min_size=8 if _is_scut_academic_chrome(style) else 7, color=p["muted"], align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE, margin=0.01)


def _render_template_chrome_evidence_grid_layout(
    slide,
    spec: SlideSpec,
    style: PPTStyleDecision,
    content_box: tuple[float, float, float, float],
) -> None:
    p = style.palette
    ex = _palette_extras(style)
    x, y, w, h = content_box
    points = _template_rich_bullets(spec, limit=4)
    labels = [
        _localized_label(spec, "证据类型", "EVIDENCE TYPE"),
        _localized_label(spec, "关键观察", "KEY OBSERVATION"),
        _localized_label(spec, "含义", "IMPLICATION"),
    ]
    top = y + 0.28
    table_w = min(w, 11.7)
    table_x = x + (w - table_w) / 2
    header_h = 0.54 if _is_scut_academic_chrome(style) else 0.46
    row_count = min(max(len(points), 1), 4)
    row_h = min(0.9 if _is_scut_academic_chrome(style) else 0.78, (h - 1.18) / row_count)
    col_ws = [1.75, min(4.3, table_w * 0.38), table_w - 1.75 - min(4.3, table_w * 0.38)]
    accents = [p["accent"], p["accent2"], ex["warm"], ex["good"]]
    cx = table_x
    for j, header in enumerate(labels):
        _add_rect(slide, cx, top, col_ws[j], header_h, p["accent"] if j == 0 else ex["soft"], line=ex["grid"], radius=False)
        _add_autofit_text(
            slide,
            header,
            cx + 0.08,
            top + 0.08,
            col_ws[j] - 0.16,
            header_h - 0.14,
            max_size=10 if _is_scut_academic_chrome(style) else 9,
            min_size=8 if _is_scut_academic_chrome(style) else 7,
            color=p["bg"] if j == 0 else p["ink"],
            bold=True,
            align=PP_ALIGN.CENTER,
            anchor=MSO_ANCHOR.MIDDLE,
            margin=0.01,
        )
        cx += col_ws[j]
    default_kinds = ["消融", "效率", "案例", "解释"]
    for i in range(row_count):
        point = points[i] if i < len(points) else default_kinds[i]
        chunks = re.split(r"[:：]", point, maxsplit=1)
        kind = _shorten_for_cell(chunks[0], 8) if len(chunks) > 1 else default_kinds[i]
        observation = _academic_visible_text(style, chunks[1].strip() if len(chunks) > 1 else point, 34)
        meaning = points[:row_count]
        meaning_text = _academic_visible_text(style, meaning[i] if i < len(meaning) else _shorten_for_cell(observation, 32), 32)
        cells = [kind, observation, meaning_text]
        cy = top + header_h + i * row_h
        cx = table_x
        for j, cell in enumerate(cells):
            fill = _academic_ref_colors(style)["fill_blue"] if (_is_scut_academic_chrome(style) and i % 2 == 0) else (ex["soft"] if i % 2 == 0 else "FFFFFF")
            _add_rect(slide, cx, cy, col_ws[j], row_h - 0.02, fill, line=ex["grid"], radius=False)
            if j == 0:
                _add_rect(slide, cx, cy, 0.08, row_h - 0.02, accents[i % len(accents)])
            _add_autofit_text(
                slide,
                cell,
                cx + 0.1,
                cy + 0.07,
                col_ws[j] - 0.2,
                row_h - 0.14,
                max_size=(12 if j == 0 else 11) if _is_scut_academic_chrome(style) else (10 if j == 0 else 9),
                min_size=9 if _is_scut_academic_chrome(style) else 7,
                color=accents[i % len(accents)] if j == 0 else p["ink"],
                bold=j == 0,
                align=PP_ALIGN.CENTER if j == 0 else PP_ALIGN.LEFT,
                anchor=MSO_ANCHOR.MIDDLE,
                margin=0.01,
            )
            cx += col_ws[j]
    note = (points[:1] or [_localized_label(spec, "多类证据共同支撑本页结论。", "Multiple signals support this page claim.")])[0]
    band_y = top + header_h + row_count * row_h + 0.22
    if band_y + 0.64 <= y + h:
        _add_academic_ref_panel(slide, style, table_x, band_y, table_w, 0.62, fill="FFFFFF", radius=False)
        _add_rect(slide, table_x, band_y, 0.1, 0.62, p["accent"])
        _add_autofit_text(slide, _academic_visible_text(style, note, 54), table_x + 0.3, band_y + 0.08, table_w - 0.56, 0.44, max_size=10 if _is_scut_academic_chrome(style) else 9, min_size=8 if _is_scut_academic_chrome(style) else 7, color=p["muted"], anchor=MSO_ANCHOR.MIDDLE, margin=0.02)


def _render_template_chrome_motivation_layout(
    slide,
    spec: SlideSpec,
    style: PPTStyleDecision,
    content_box: tuple[float, float, float, float],
) -> None:
    p = style.palette
    ex = _palette_extras(style)
    x, y, w, h = content_box
    points = _template_rich_bullets(spec, limit=4)
    boost = _academic_sparse_spec_boost(style, spec, points)
    left_w = min(4.75, w * 0.39)
    right_x = x + left_w + 0.36
    right_w = w - left_w - 0.36
    top = y + 0.14
    card_gap = 0.1
    card_h = min(0.74, (h - 1.05 - card_gap * 2) / 3)
    accents = [p["accent"], p["accent2"], ex["warm"]]
    if _is_scut_academic_chrome(style):
        ref = _academic_ref_colors(style)
        _add_text(slide, _localized_label(spec, "背景动因", "MOTIVATION"), x, top + 0.02, 1.08, 0.26, size=9, color=p["accent"], bold=True, margin=0)
        _add_academic_plain_list(
            slide,
            style,
            (points or [spec.title or ""])[:3],
            x,
            top + 0.38,
            left_w,
            min(2.55, h - 1.3),
            start=1,
            max_items=3,
            max_size=12,
        )
        _add_line(slide, right_x, top + 0.08, right_x + right_w, top + 0.08, ref["line"], width=1.0)
        _add_text(slide, _localized_label(spec, "问题关系", "PROBLEM MAP"), right_x, top + 0.2, 1.08, 0.26, size=9, color=ref["title"], bold=True, margin=0)
        cx = right_x + right_w * 0.5
        cy = top + min(3.55, h - 1.28) * 0.54
        node_labels = _template_concept_terms(spec, limit=5)
        if len(node_labels) < 4:
            defaults = ["现有供给", "用户需求", "按需生成", "反馈优化"] if not _prefers_english_spec(spec) else ["Current supply", "User needs", "On-demand output", "Feedback loop"]
            node_labels = [*node_labels, *defaults][:5]
        center_d = 1.4 if boost >= 2 else 1.26
        _add_circle(slide, cx - center_d / 2, cy - center_d / 2, center_d, p["accent"], line=p["accent2"])
        _add_autofit_text(slide, _shorten_for_cell(node_labels[0], 8), cx - 0.54, cy - 0.2, 1.08, 0.4, max_size=11 + min(boost, 2), min_size=10 if boost >= 2 else 9, color=p["bg"], bold=True, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE, margin=0.01)
        positions = [
            (right_x + 0.5, top + 0.56),
            (right_x + right_w - 2.1, top + 0.56),
            (right_x + 0.65, top + 2.5),
            (right_x + right_w - 2.02, top + 2.5),
        ]
        colors = [p["accent"], p["accent2"], ex["warm"], ex["good"]]
        for i, label in enumerate(node_labels[1:5]):
            nx, ny = positions[i]
            node_w = 2.12 if boost >= 2 else 1.96
            node_h = 0.76 if boost >= 2 else 0.68
            _add_line(slide, cx, cy, nx + node_w / 2, ny + node_h / 2, ref["line"], width=0.9)
            _add_rect(slide, nx, ny, node_w, node_h, "FFFFFF", line=colors[i], radius=False)
            _add_autofit_text(slide, _academic_visible_text(style, label, 10), nx + 0.12, ny + 0.11, node_w - 0.24, node_h - 0.22, max_size=11 + min(boost, 2), min_size=10 if boost >= 2 else 9, color=p["ink"], bold=True, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE, margin=0.01)
        note = (points[:1] or [""])[0]
        band_y = y + h - 0.78
        _add_academic_plain_note(slide, style, note, x, band_y, w, 0.62, label=_localized_label(spec, "讲解", "NOTE"))
        return

    for i, point in enumerate((points or [spec.title or ""] )[:3]):
        cy = top + i * (card_h + card_gap)
        _add_academic_ref_panel(slide, style, x, cy, left_w, card_h, fill=_academic_ref_fill(style, i), radius=True)
        _add_rect(slide, x, cy, 0.09, card_h, accents[i % len(accents)])
        _add_autofit_text(
            slide,
            point,
            x + 0.28,
            cy + 0.12,
            left_w - 0.5,
            card_h - 0.22,
            max_size=10,
            min_size=8 if _is_scut_academic_chrome(style) else 7,
            color=p["ink"],
            anchor=MSO_ANCHOR.MIDDLE,
            margin=0.02,
        )
    _add_academic_ref_panel(slide, style, right_x, top, right_w, min(3.55, h - 1.28), fill="FFFFFF", radius=True)
    cx = right_x + right_w * 0.5
    cy = top + min(3.55, h - 1.28) * 0.5
    node_labels = _template_concept_terms(spec, limit=5)
    if len(node_labels) < 4:
        defaults = ["现有供给", "用户需求", "按需生成", "反馈优化"] if not _prefers_english_spec(spec) else ["Current supply", "User needs", "On-demand output", "Feedback loop"]
        node_labels = [*node_labels, *defaults][:5]
    _add_circle(slide, cx - 0.5, cy - 0.5, 1.0, p["accent"], line=p["accent2"])
    _add_autofit_text(slide, _shorten_for_cell(node_labels[0], 8), cx - 0.38, cy - 0.15, 0.76, 0.3, max_size=9, min_size=7, color=p["bg"], bold=True, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE, margin=0.01)
    positions = [
        (right_x + 0.5, top + 0.45),
        (right_x + right_w - 2.15, top + 0.45),
        (right_x + 0.65, top + 2.48),
        (right_x + right_w - 2.05, top + 2.48),
    ]
    colors = [p["accent"], p["accent2"], ex["warm"], ex["good"]]
    for i, label in enumerate(node_labels[1:5]):
        nx, ny = positions[i]
        _add_line(slide, cx, cy, nx + 0.75, ny + 0.25, ex["grid"], width=1.0)
        _add_rect(slide, nx, ny, 1.65, 0.5, "FFFFFF", line=colors[i], radius=False)
        _add_autofit_text(slide, label, nx + 0.1, ny + 0.09, 1.45, 0.28, max_size=9, min_size=7, color=p["ink"], bold=True, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE, margin=0.01)
    note = (points[:1] or [""])[0]
    band_y = y + h - 0.82
    _add_academic_ref_panel(slide, style, x, band_y, w, 0.66, fill="FFFFFF", radius=False)
    _add_rect(slide, x, band_y, 0.1, 0.66, p["accent"])
    _add_autofit_text(slide, _academic_visible_text(style, note, 54), x + 0.28, band_y + 0.08, w - 0.5, 0.48, max_size=11 if _is_scut_academic_chrome(style) else 10, min_size=8 if _is_scut_academic_chrome(style) else 7, color=p["muted"], anchor=MSO_ANCHOR.MIDDLE, margin=0.02)



__all__ = [
    "_render_template_chrome_two_column_plain_layout",
    "_render_template_chrome_metric_focus_layout",
    "_render_template_chrome_ladder_layout",
    "_render_template_chrome_claim_variant_layout",
    "_render_template_chrome_process_layout",
    "_render_template_chrome_matrix_layout",
    "_render_template_chrome_bigstat_layout",
    "_numeric_highlights",
    "_prominent_numeric_highlights",
    "_render_template_chrome_results_bars_layout",
    "_render_template_chrome_leaderboard_layout",
    "_render_template_chrome_evidence_grid_layout",
    "_render_template_chrome_motivation_layout",
]
