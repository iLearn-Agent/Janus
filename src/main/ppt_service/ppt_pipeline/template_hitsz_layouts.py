from __future__ import annotations

from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from janus_lab.ppt_renderer import SlideSpec
from ppt_pipeline.content_parsing import *
from ppt_pipeline.render_primitives import *
from ppt_pipeline.style_catalog import PPTStyleDecision
from ppt_pipeline.template_core import *
from ppt_pipeline.template_feature_layouts import *

def _render_hitsz_focus_strip_layout(
    slide,
    spec: SlideSpec,
    style: PPTStyleDecision,
    content_box: tuple[float, float, float, float],
) -> None:
    if not _is_hitsz_academic_chrome(style):
        _render_template_chrome_claim_layout(slide, spec, style, content_box)
        return
    p = style.palette
    ex = _palette_extras(style)
    ref = _academic_ref_colors(style)
    x, y, w, h = content_box
    points = _hitsz_points(spec, limit=5)
    primary = _hitsz_visible_text(points[0] if points else (spec.title or ""), 46)
    support = _hitsz_support_items(spec, primary, points, limit=4)
    left_w = min(4.65, w * 0.38)
    right_x = x + left_w + 0.42
    right_w = w - left_w - 0.42
    top = y + 0.24
    _add_rect(slide, x, top + 0.08, 0.16, min(3.3, h - 0.4), p["accent"])
    _add_text(slide, _localized_label(spec, "核心判断", "KEY CLAIM"), x + 0.36, top + 0.12, 1.2, 0.28, size=10, color=p["accent"], bold=True, margin=0)
    _add_autofit_text(
        slide,
        primary,
        x + 0.36,
        top + 0.62,
        left_w - 0.48,
        min(2.42, h - 1.05),
        max_size=26,
        min_size=13,
        color=p["ink"],
        bold=True,
        anchor=MSO_ANCHOR.MIDDLE,
        margin=0.02,
    )
    _add_line(slide, right_x, top + 0.12, right_x + right_w, top + 0.12, ref["line"], width=1.1)
    if support:
        _add_text(slide, _localized_label(spec, "支撑要点", "SUPPORT"), right_x, top + 0.28, 1.12, 0.26, size=10, color=p["ink"], bold=True, margin=0)
    visible = support[:4]
    if not visible:
        visible = points[:1]
    row_h = min(0.96, (h - 0.86) / max(len(visible), 1))
    accents = [p["accent2"], p["accent"], ex["good"], ex["warm"]]
    for i, item in enumerate(visible):
        cy = top + 0.76 + i * row_h
        accent = accents[i % len(accents)]
        _add_rect(slide, right_x + 0.08, cy + 0.15, 0.08, max(0.32, row_h - 0.28), accent)
        _add_autofit_text(
            slide,
            _hitsz_visible_text(item, 34),
            right_x + 0.34,
            cy,
            right_w - 0.42,
            row_h - 0.04,
            max_size=14,
            min_size=8,
            color=p["ink"],
            anchor=MSO_ANCHOR.MIDDLE,
            margin=0.01,
        )
        _add_line(slide, right_x, cy + row_h - 0.02, right_x + right_w, cy + row_h - 0.02, ref["line"], width=0.7)


def _render_hitsz_axis_layout(
    slide,
    spec: SlideSpec,
    style: PPTStyleDecision,
    content_box: tuple[float, float, float, float],
) -> None:
    if not _is_hitsz_academic_chrome(style):
        _render_template_chrome_process_layout(slide, spec, style, content_box)
        return
    p = style.palette
    ex = _palette_extras(style)
    ref = _academic_ref_colors(style)
    x, y, w, h = content_box
    points = _hitsz_points(spec, limit=5)
    if len(points) <= 1:
        _render_hitsz_focus_strip_layout(slide, spec, style, content_box)
        return
    n = min(len(points), 5)
    top = y + 0.34
    axis_y = top + 1.24
    _add_line(slide, x + 0.2, axis_y, x + w - 0.2, axis_y, p["accent"], width=1.4)
    gap = 0.2
    item_w = (w - gap * (n - 1)) / n
    accents = [p["accent"], p["accent2"], ex["good"], ex["warm"], ex["danger"]]
    for i, point in enumerate(points[:n]):
        cx = x + i * (item_w + gap)
        accent = accents[i % len(accents)]
        _add_template_icon(slide, _template_icon_kind(point), cx + item_w * 0.5 - 0.27, axis_y - 0.27, 0.54, accent)
        _add_text(slide, _localized_label(spec, "模块", "MODULE"), cx, top + 0.08, item_w, 0.28, size=10, color=accent, bold=True, align=PP_ALIGN.CENTER, margin=0)
        _add_autofit_text(
            slide,
            _hitsz_visible_text(point, 30),
            cx + 0.02,
            axis_y + 0.46,
            item_w - 0.04,
            min(1.42, h - 2.0),
            max_size=13,
            min_size=8,
            color=p["ink"],
            align=PP_ALIGN.CENTER,
            anchor=MSO_ANCHOR.TOP,
            margin=0.01,
        )
    note = (points[:1] or [None])[0]
    if note:
        _add_line(slide, x + 0.3, y + h - 0.72, x + w - 0.3, y + h - 0.72, ref["line"], width=0.8)
        _add_autofit_text(slide, _hitsz_visible_text(note, 62), x + 0.34, y + h - 0.58, w - 0.68, 0.38, max_size=10, min_size=8, color=p["muted"], align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE, margin=0.01)


def _render_hitsz_grid_layout(
    slide,
    spec: SlideSpec,
    style: PPTStyleDecision,
    content_box: tuple[float, float, float, float],
) -> None:
    if not _is_hitsz_academic_chrome(style):
        _render_template_chrome_cards_layout(slide, spec, style, content_box)
        return
    p = style.palette
    ex = _palette_extras(style)
    ref = _academic_ref_colors(style)
    x, y, w, h = content_box
    points = _hitsz_points(spec, limit=5)
    primary = _hitsz_visible_text(points[0] if points else (spec.title or ""), 38)
    support = _hitsz_support_items(spec, primary, points, limit=4)
    if not support:
        _render_hitsz_focus_strip_layout(slide, spec, style, content_box)
        return
    top = y + 0.22
    lead_w = min(4.08, w * 0.33)
    grid_x = x + lead_w + 0.38
    grid_w = w - lead_w - 0.38
    _add_rect(slide, x, top + 0.12, lead_w, min(3.05, h - 0.55), "FFFFFF", line=ref["line"], radius=False)
    _add_rect(slide, x, top + 0.12, 0.12, min(3.05, h - 0.55), p["accent"])
    _add_text(slide, "主线", x + 0.28, top + 0.32, 0.7, 0.24, size=9, color=p["accent2"], bold=True, margin=0)
    _add_autofit_text(slide, primary, x + 0.28, top + 0.78, lead_w - 0.52, min(2.12, h - 1.42), max_size=21, min_size=12, color=p["ink"], bold=True, anchor=MSO_ANCHOR.MIDDLE, margin=0.02)
    item_count = min(len(support), 4)
    cols = 1 if item_count == 1 else 2
    rows = 1 if item_count <= 2 else 2
    gap_x = 0.24
    gap_y = 0.24
    cell_w = (grid_w - gap_x * (cols - 1)) / cols
    cell_h = min(1.5 if rows == 1 else 1.42, (h - 0.42 - gap_y * (rows - 1)) / rows)
    accents = [p["accent"], p["accent2"], ex["good"], ex["warm"]]
    for i, item in enumerate(support[:item_count]):
        col = i % cols
        row = i // cols
        cx = grid_x + col * (cell_w + gap_x)
        cy = top + 0.12 + row * (cell_h + gap_y)
        _add_rect(slide, cx, cy, cell_w, cell_h, "FFFFFF", line=ref["line"], radius=False)
        _add_rect(slide, cx, cy, cell_w, 0.08, accents[i % len(accents)])
        _add_rect(slide, cx + 0.18, cy + 0.22, 0.08, max(0.28, cell_h - 0.42), accents[i % len(accents)])
        _add_autofit_text(slide, _hitsz_visible_text(item, 30), cx + 0.42, cy + 0.14, cell_w - 0.58, cell_h - 0.24, max_size=13, min_size=9, color=p["ink"], anchor=MSO_ANCHOR.MIDDLE, margin=0.01)


def _render_hitsz_metric_band_layout(
    slide,
    spec: SlideSpec,
    style: PPTStyleDecision,
    content_box: tuple[float, float, float, float],
) -> None:
    if not _is_hitsz_academic_chrome(style):
        _render_template_chrome_bigstat_layout(slide, spec, style, content_box)
        return
    p = style.palette
    ex = _palette_extras(style)
    ref = _academic_ref_colors(style)
    x, y, w, h = content_box
    points = _hitsz_points(spec, limit=5)
    values = _numeric_highlights("；".join(points), limit=4)
    top = y + 0.32
    if not values:
        _render_hitsz_focus_strip_layout(slide, spec, style, content_box)
        return
    _add_line(slide, x + 0.2, top + 0.1, x + w - 0.2, top + 0.1, ref["line"], width=1.0)
    n = min(len(values), 4)
    gap = 0.22
    card_w = (w - gap * (n - 1)) / n
    accents = [p["accent"], p["accent2"], ex["good"], ex["warm"]]
    for i, value in enumerate(values[:n]):
        cx = x + i * (card_w + gap)
        point = points[i] if i < len(points) else value
        _add_rect(slide, cx, top + 0.34, card_w, 1.86, "FFFFFF", line=ref["line"], radius=False)
        _add_rect(slide, cx, top + 0.34, card_w, 0.11, accents[i % len(accents)])
        _add_autofit_text(slide, value, cx + 0.14, top + 0.64, card_w - 0.28, 0.54, max_size=27, min_size=15, color=accents[i % len(accents)], bold=True, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE, margin=0.01)
        _add_autofit_text(slide, _hitsz_visible_text(point, 28), cx + 0.18, top + 1.28, card_w - 0.36, 0.68, max_size=12, min_size=9, color=p["ink"], align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE, margin=0.01)
    note = next((point for point in points if not _extract_highlight(point)), "")
    if note:
        _add_autofit_text(slide, _hitsz_visible_text(note, 68), x + 0.35, y + h - 0.78, w - 0.7, 0.5, max_size=12, min_size=9, color=p["muted"], align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE, margin=0.01)


def _render_hitsz_claim_rule_layout(
    slide,
    spec: SlideSpec,
    style: PPTStyleDecision,
    content_box: tuple[float, float, float, float],
) -> None:
    if not _is_hitsz_academic_chrome(style):
        _render_template_chrome_claim_band_layout(slide, spec, style, content_box)
        return
    p = style.palette
    ex = _palette_extras(style)
    ref = _academic_ref_colors(style)
    x, y, w, h = content_box
    points = _hitsz_points(spec, limit=5)
    primary = _hitsz_visible_text(points[0] if points else (spec.title or ""), 54)
    support = _hitsz_support_items(spec, primary, points, limit=4)
    top = y + 0.26
    _add_text(slide, "核心论点", x, top + 0.02, 1.0, 0.26, size=9, color=p["accent2"], bold=True, margin=0)
    _add_line(slide, x + 1.08, top + 0.16, x + w, top + 0.16, ref["line"], width=1.0)
    _add_rect(slide, x, top + 0.6, 0.12, 1.22, p["accent"])
    _add_autofit_text(
        slide,
        primary,
        x + 0.32,
        top + 0.52,
        w - 0.58,
        1.34,
        max_size=28,
        min_size=14,
        color=p["ink"],
        bold=True,
        anchor=MSO_ANCHOR.MIDDLE,
        margin=0.01,
    )
    if support:
        band_y = top + 2.24
        gap = 0.18
        item_count = min(len(support), 4)
        item_w = (w - gap * (item_count - 1)) / item_count
        accents = [p["accent"], p["accent2"], ex["good"], ex["warm"]]
        for i, item in enumerate(support[:item_count]):
            cx = x + i * (item_w + gap)
            _add_line(slide, cx, band_y, cx + item_w, band_y, accents[i % len(accents)], width=1.4)
            _add_rect(slide, cx + 0.08, band_y + 0.2, 0.08, max(0.34, min(0.86, y + h - band_y - 0.2) - 0.22), accents[i % len(accents)])
            _add_autofit_text(
                slide,
                _hitsz_visible_text(item, 28),
                cx + 0.32,
                band_y + 0.1,
                item_w - 0.38,
                min(0.86, y + h - band_y - 0.2),
                max_size=13,
                min_size=9,
                color=p["ink"],
                anchor=MSO_ANCHOR.MIDDLE,
                margin=0.01,
            )


def _render_hitsz_two_column_rule_layout(
    slide,
    spec: SlideSpec,
    style: PPTStyleDecision,
    content_box: tuple[float, float, float, float],
) -> None:
    if not _is_hitsz_academic_chrome(style):
        _render_template_chrome_two_column_plain_layout(slide, spec, style, content_box)
        return
    p = style.palette
    ref = _academic_ref_colors(style)
    x, y, w, h = content_box
    points = _hitsz_points(spec, limit=6)
    if len(points) <= 1:
        _render_hitsz_claim_rule_layout(slide, spec, style, content_box)
        return
    raw = f"{spec.title or ''} {spec.message or ''} {spec.visual or ''}"
    if any(key in raw for key in ["挑战", "问题", "限制", "风险", "消融"]):
        labels = (_localized_label(spec, "关键观察", "KEY OBSERVATION"), _localized_label(spec, "影响与应对", "IMPACT & RESPONSE"))
    elif any(key in raw for key in ["结果", "实验", "评估", "指标"]):
        labels = (_localized_label(spec, "实验现象", "EXPERIMENT SIGNAL"), _localized_label(spec, "结论解释", "INTERPRETATION"))
    else:
        labels = ("主线信息", "支撑证据")
    split = max(1, (len(points) + 1) // 2)
    cols = [points[:split], points[split:] or points[:1]]
    gap = 0.46
    col_w = (w - gap) / 2
    top = y + 0.24
    accents = [p["accent"], p["accent2"]]
    for col, items in enumerate(cols):
        cx = x + col * (col_w + gap)
        _add_line(slide, cx, top + 0.06, cx + col_w, top + 0.06, ref["line"], width=1.0)
        _add_rect(slide, cx, top + 0.24, 0.11, 0.46, accents[col])
        _add_text(slide, labels[col], cx + 0.28, top + 0.2, col_w - 0.42, 0.32, size=12, color=p["ink"], bold=True, margin=0)
        visible = [_hitsz_visible_text(item, 34) for item in items[:4] if _hitsz_visible_text(item, 34)]
        row_h = min(0.98, (h - 0.84) / max(len(visible), 1))
        for i, item in enumerate(visible):
            cy = top + 0.76 + i * row_h
            _add_rect(slide, cx + 0.08, cy + 0.14, 0.08, max(0.3, row_h - 0.26), accents[col])
            _add_autofit_text(
                slide,
                item,
                cx + 0.32,
                cy,
                col_w - 0.38,
                row_h - 0.04,
                max_size=13,
                min_size=9,
                color=p["ink"],
                anchor=MSO_ANCHOR.MIDDLE,
                margin=0.01,
            )
            _add_line(slide, cx, cy + row_h - 0.02, cx + col_w, cy + row_h - 0.02, ref["line"], width=0.7)


def _render_hitsz_takeaway_list_layout(
    slide,
    spec: SlideSpec,
    style: PPTStyleDecision,
    content_box: tuple[float, float, float, float],
) -> None:
    if not _is_hitsz_academic_chrome(style):
        _render_template_chrome_cards_layout(slide, spec, style, content_box)
        return
    p = style.palette
    ex = _palette_extras(style)
    ref = _academic_ref_colors(style)
    x, y, w, h = content_box
    points = _hitsz_points(spec, limit=5)
    primary = _hitsz_visible_text(points[0] if points else (spec.title or ""), 42)
    support = _hitsz_support_items(spec, primary, points, limit=4)
    top = y + 0.28
    lead_w = min(4.3, w * 0.35)
    list_x = x + lead_w + 0.48
    list_w = w - lead_w - 0.48
    _add_line(slide, x, top + 0.06, x + lead_w, top + 0.06, ref["line"], width=1.0)
    _add_text(slide, "主结论", x, top + 0.24, 0.82, 0.26, size=9, color=p["accent2"], bold=True, margin=0)
    _add_autofit_text(
        slide,
        primary,
        x,
        top + 0.72,
        lead_w,
        min(2.2, h - 1.12),
        max_size=24,
        min_size=13,
        color=p["ink"],
        bold=True,
        anchor=MSO_ANCHOR.MIDDLE,
        margin=0.01,
    )
    _add_line(slide, list_x, top + 0.06, list_x + list_w, top + 0.06, ref["line"], width=1.0)
    visible = support[:4]
    if not visible:
        visible = points[:1]
    row_h = min(1.0, (h - 0.62) / max(len(visible), 1))
    accents = [p["accent"], p["accent2"], ex["good"], ex["warm"]]
    for i, item in enumerate(visible):
        cy = top + 0.48 + i * row_h
        accent = accents[i % len(accents)]
        _add_rect(slide, list_x, cy + 0.14, 0.09, max(0.34, row_h - 0.28), accent)
        _add_autofit_text(
            slide,
            _hitsz_visible_text(item, 38),
            list_x + 0.28,
            cy,
            list_w - 0.36,
            row_h - 0.04,
            max_size=14,
            min_size=9,
            color=p["ink"],
            anchor=MSO_ANCHOR.MIDDLE,
            margin=0.01,
        )
        _add_line(slide, list_x, cy + row_h - 0.02, list_x + list_w, cy + row_h - 0.02, ref["line"], width=0.7)


def _render_hitsz_template_chrome_content(
    slide,
    spec: SlideSpec,
    style: PPTStyleDecision,
    content_box: tuple[float, float, float, float],
    *,
    layout_id: str,
    index: int,
    total: int,
) -> None:
    points = _hitsz_points(spec, limit=5)
    raw = f"{spec.title or ''} {spec.message or ''} {spec.visual or ''}"
    numbery = sum(1 for point in points if _extract_highlight(point))
    if layout_id in {"summary_takeaways"} or index == total:
        if index % 2 == 0:
            _render_hitsz_two_column_rule_layout(slide, spec, style, content_box)
        else:
            _render_hitsz_takeaway_list_layout(slide, spec, style, content_box)
    elif layout_id in {"result_big_numbers", "results_bars", "leaderboard_table"} or numbery >= 2:
        _render_hitsz_metric_band_layout(slide, spec, style, content_box)
    elif layout_id in {"method_pipeline", "technical_route", "milestone_roadmap", "method_loop"} or any(key in raw for key in ["流程", "步骤", "链路", "路线", "架构", "框架", "模块", "闭环"]):
        if len(points) >= 3 and index % 3 != 1:
            _render_hitsz_axis_layout(slide, spec, style, content_box)
        elif len(points) >= 3:
            _render_hitsz_two_column_rule_layout(slide, spec, style, content_box)
        else:
            _render_hitsz_claim_rule_layout(slide, spec, style, content_box)
    elif layout_id in {"benchmark_metrics", "evaluation_dashboard", "ablation_matrix", "risk_action_table", "evidence_grid", "workpackage_matrix"}:
        if index % 3 == 0:
            _render_hitsz_grid_layout(slide, spec, style, content_box)
        elif index % 3 == 1:
            _render_hitsz_two_column_rule_layout(slide, spec, style, content_box)
        else:
            _render_hitsz_takeaway_list_layout(slide, spec, style, content_box)
    elif layout_id in {"motivation_compare", "project_target_map", "challenge_map", "domain_object_map"}:
        if index % 3 == 0 and len(points) >= 3:
            _render_hitsz_two_column_rule_layout(slide, spec, style, content_box)
        elif index % 3 == 1:
            _render_hitsz_claim_rule_layout(slide, spec, style, content_box)
        else:
            _render_hitsz_takeaway_list_layout(slide, spec, style, content_box)
    elif len(points) <= 2:
        [_render_hitsz_claim_rule_layout, _render_hitsz_takeaway_list_layout, _render_hitsz_focus_strip_layout][index % 3](slide, spec, style, content_box)
    elif index % 4 == 1:
        _render_hitsz_two_column_rule_layout(slide, spec, style, content_box)
    elif index % 4 == 2:
        _render_hitsz_takeaway_list_layout(slide, spec, style, content_box)
    elif index % 4 == 3:
        _render_hitsz_grid_layout(slide, spec, style, content_box)
    else:
        _render_hitsz_claim_rule_layout(slide, spec, style, content_box)



__all__ = [
    "_render_hitsz_focus_strip_layout",
    "_render_hitsz_axis_layout",
    "_render_hitsz_grid_layout",
    "_render_hitsz_metric_band_layout",
    "_render_hitsz_claim_rule_layout",
    "_render_hitsz_two_column_rule_layout",
    "_render_hitsz_takeaway_list_layout",
    "_render_hitsz_template_chrome_content",
]
