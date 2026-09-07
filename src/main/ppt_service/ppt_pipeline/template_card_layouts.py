from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from janus_lab.ppt_renderer import SlideSpec
from ppt_pipeline.content_parsing import *
from ppt_pipeline.image_routing import _slide_image_list
from ppt_pipeline.render_primitives import *
from ppt_pipeline.style_catalog import PPTStyleDecision, PPTTemplateDecision
from ppt_pipeline.template_core import *
from ppt_pipeline.template_feature_layouts import *
from ppt_pipeline.template_hitsz_layouts import *
from ppt_pipeline.template_data_layouts import *

def _template_card_variant(spec: SlideSpec, index: int = 0) -> int:
    raw = f"{index}|{spec.title or ''}|{spec.message or ''}|{spec.visual or ''}"
    return sum(ord(ch) for ch in raw) % 4


def _render_template_chrome_triptych_cards_layout(
    slide,
    spec: SlideSpec,
    style: PPTStyleDecision,
    content_box: tuple[float, float, float, float],
) -> None:
    p = style.palette
    ex = _palette_extras(style)
    ref = _academic_ref_colors(style)
    x, y, w, h = content_box
    points = _template_rich_bullets(spec, limit=5)
    if len(points) < 3:
        _render_template_chrome_claim_variant_layout(slide, spec, style, content_box)
        return
    lead = points[0]
    cards = points[1:4]
    top = y + 0.24
    lead_h = min(1.35, max(1.05, h * 0.28))
    _add_line(slide, x, top + 0.06, x + w, top + 0.06, ref["line"], width=1.0)
    _add_rect(slide, x, top + 0.3, 0.12, lead_h - 0.12, p["accent"])
    _add_text(slide, _localized_label(spec, "核心判断", "KEY CLAIM"), x + 0.32, top + 0.26, 1.05, 0.28, size=10, color=p["accent"], bold=True, margin=0)
    _add_autofit_text(
        slide,
        _academic_visible_text(style, lead, 58),
        x + 0.32,
        top + 0.62,
        w - 0.64,
        lead_h - 0.34,
        max_size=19 if _is_scut_academic_chrome(style) else 18,
        min_size=11,
        color=p["ink"],
        bold=True,
        anchor=MSO_ANCHOR.MIDDLE,
        margin=0.01,
    )
    card_top = top + lead_h + 0.44
    gap = 0.22
    card_count = min(len(cards), 3)
    card_w = (w - gap * (card_count - 1)) / card_count
    card_h = min(1.72, max(1.12, y + h - card_top - 0.18))
    accents = [p["accent"], p["accent2"], ex["warm"], ex["good"]]
    labels = ["证据", "机制", "影响"]
    for i, point in enumerate(cards[:card_count]):
        cx = x + i * (card_w + gap)
        accent = accents[i % len(accents)]
        _add_academic_ref_panel(slide, style, cx, card_top, card_w, card_h, fill=_academic_ref_fill(style, i), accent=accent, radius=True)
        _add_rect(slide, cx, card_top, card_w, 0.1, accent)
        _add_text(slide, labels[i], cx + 0.22, card_top + 0.22, 0.76, 0.25, size=9, color=accent, bold=True, margin=0)
        _add_autofit_text(
            slide,
            _academic_visible_text(style, point, 46),
            cx + 0.22,
            card_top + 0.58,
            card_w - 0.44,
            card_h - 0.72,
            max_size=12 if _is_scut_academic_chrome(style) else 11,
            min_size=8,
            color=p["ink"],
            anchor=MSO_ANCHOR.MIDDLE,
            margin=0.02,
        )


def _render_template_chrome_ladder_cards_layout(
    slide,
    spec: SlideSpec,
    style: PPTStyleDecision,
    content_box: tuple[float, float, float, float],
) -> None:
    p = style.palette
    ex = _palette_extras(style)
    ref = _academic_ref_colors(style)
    x, y, w, h = content_box
    points = _template_rich_bullets(spec, limit=5)
    if len(points) < 3:
        _render_template_chrome_claim_variant_layout(slide, spec, style, content_box)
        return
    top = y + 0.24
    left_w = min(4.3, w * 0.36)
    _add_line(slide, x, top + 0.06, x + left_w, top + 0.06, ref["line"], width=1.0)
    _add_text(slide, "主线", x, top + 0.24, 0.7, 0.26, size=9, color=p["accent"], bold=True, margin=0)
    _add_autofit_text(
        slide,
        _academic_visible_text(style, points[0], 48),
        x,
        top + 0.76,
        left_w,
        min(2.28, h - 1.25),
        max_size=22 if _is_scut_academic_chrome(style) else 20,
        min_size=12,
        color=p["ink"],
        bold=True,
        anchor=MSO_ANCHOR.MIDDLE,
        margin=0.01,
    )
    list_x = x + left_w + 0.42
    list_w = w - left_w - 0.42
    visible = points[1:5]
    row_gap = 0.12
    row_h = min(0.86, (h - 0.4 - row_gap * (len(visible) - 1)) / max(len(visible), 1))
    accents = [p["accent"], p["accent2"], ex["good"], ex["warm"]]
    for i, point in enumerate(visible):
        cy = top + 0.08 + i * (row_h + row_gap)
        indent = min(0.48, i * 0.13)
        cx = list_x + indent
        cw = list_w - indent
        accent = accents[i % len(accents)]
        _add_academic_ref_panel(slide, style, cx, cy, cw, row_h, fill=_academic_ref_fill(style, i + 1), accent=accent, radius=False)
        _add_rect(slide, cx, cy, 0.08, row_h, accent)
        _add_template_icon(slide, _template_icon_kind(point), cx + 0.18, cy + row_h * 0.5 - 0.18, 0.36, accent)
        _add_autofit_text(
            slide,
            _academic_visible_text(style, point, 50),
            cx + 0.7,
            cy + 0.08,
            cw - 0.92,
            row_h - 0.16,
            max_size=12 if _is_scut_academic_chrome(style) else 11,
            min_size=8,
            color=p["ink"],
            anchor=MSO_ANCHOR.MIDDLE,
            margin=0.01,
        )


def _render_template_chrome_mosaic_cards_layout(
    slide,
    spec: SlideSpec,
    style: PPTStyleDecision,
    content_box: tuple[float, float, float, float],
) -> None:
    p = style.palette
    ex = _palette_extras(style)
    ref = _academic_ref_colors(style)
    x, y, w, h = content_box
    points = _template_rich_bullets(spec, limit=5)
    if len(points) < 4:
        _render_template_chrome_claim_variant_layout(slide, spec, style, content_box)
        return
    boost = _academic_sparse_spec_boost(style, spec, points)
    top = y + 0.22
    gap = 0.22
    lead_w = min(4.85, w * 0.42)
    grid_x = x + lead_w + gap
    grid_w = w - lead_w - gap
    usable_h = min(h - 0.38, 3.86 if _is_scut_academic_chrome(style) else 3.72)
    _add_academic_ref_panel(slide, style, x, top, lead_w, usable_h, fill=_academic_ref_fill(style, 0), accent=p["accent"], radius=True)
    _add_text(slide, _localized_label(spec, "主判断", "MAIN POINT"), x + 0.3, top + 0.26, 0.86, 0.26, size=9, color=p["accent"], bold=True, margin=0)
    _add_autofit_text(
        slide,
        _academic_visible_text(style, points[0], 48),
        x + 0.32,
        top + 0.72,
        lead_w - 0.64,
        usable_h - 1.06,
        max_size=21 + min(boost, 3) if _is_scut_academic_chrome(style) else 18,
        min_size=12 if _is_scut_academic_chrome(style) else 10,
        color=p["ink"],
        bold=True,
        anchor=MSO_ANCHOR.MIDDLE,
        margin=0.02,
    )

    support = points[1:5]
    cols = 2
    rows = 2
    gap_x = 0.22
    gap_y = 0.2
    cell_w = (grid_w - gap_x) / cols
    cell_h = (usable_h - gap_y) / rows
    accents = [p["accent"], p["accent2"], ex["warm"], ex["good"]]
    _add_line(slide, grid_x, top + 0.03, grid_x + grid_w, top + 0.03, ref["line"], width=1.0)
    for i, point in enumerate(support[:4]):
        col = i % cols
        row = i // cols
        cx = grid_x + col * (cell_w + gap_x)
        cy = top + row * (cell_h + gap_y)
        accent = accents[i % len(accents)]
        _add_academic_ref_panel(slide, style, cx, cy, cell_w, cell_h, fill=_academic_ref_fill(style, i + 1), accent=accent, radius=True)
        _add_template_icon(slide, _template_icon_kind(point), cx + 0.22, cy + 0.22, 0.38, accent)
        _add_autofit_text(
            slide,
            _academic_visible_text(style, point, 40),
            cx + 0.72,
            cy + 0.16,
            cell_w - 0.9,
            cell_h - 0.3,
            max_size=12 + min(boost, 2) if _is_scut_academic_chrome(style) else 10,
            min_size=8,
            color=p["ink"],
            anchor=MSO_ANCHOR.MIDDLE,
            margin=0.01,
        )


def _render_template_chrome_loop_layout(
    slide,
    spec: SlideSpec,
    style: PPTStyleDecision,
    content_box: tuple[float, float, float, float],
) -> None:
    p = style.palette
    ex = _palette_extras(style)
    x, y, w, h = content_box
    points = _template_rich_bullets(spec, limit=5)
    boost = _academic_sparse_spec_boost(style, spec, points)
    if _is_scut_academic_chrome(style) and len(points) <= 2:
        _render_template_chrome_quote_rule_layout(slide, spec, style, content_box)
        return
    if _prefers_english_spec(spec):
        labels = ["Input", "Rank", "Feedback", "Profile", "Check"]
    else:
        labels = [_shorten_for_cell(point, 13) for point in (points or _template_concept_terms(spec, limit=5))[:5]]
    while len(labels) < 5:
        defaults = ["输入证据", "候选排序", "错误反馈", "画像更新", "一致性检查"]
        labels.append(defaults[len(labels)])
    left_w = min(4.1, w * 0.34)
    loop_x = x + left_w + 0.55
    loop_w = w - left_w - 0.55
    _add_academic_ref_panel(slide, style, x, y + 0.18, left_w, h - 0.44, fill=_academic_ref_fill(style, 0), radius=True)
    _add_rect(slide, x, y + 0.18, 0.1, h - 0.44, p["accent"])
    claim = _academic_visible_text(style, points[0] if points else (spec.title or ""), 34)
    _add_autofit_text(slide, claim, x + 0.35, y + 0.48, left_w - 0.62, 1.26 if boost else 1.18, max_size=(16 + min(boost, 3)) if _is_scut_academic_chrome(style) else 15, min_size=11 if (_is_scut_academic_chrome(style) and boost >= 2) else (10 if _is_scut_academic_chrome(style) else 9), color=p["ink"], bold=True, anchor=MSO_ANCHOR.MIDDLE, margin=0.04)
    for i, point in enumerate(points[1:4]):
        iy = y + 2.05 + i * 0.72
        _add_circle(slide, x + 0.38, iy + 0.16, 0.18, [p["accent2"], ex["warm"], ex["good"]][i % 3])
        _add_autofit_text(slide, _academic_visible_text(style, point, 28), x + 0.72, iy, left_w - 0.95, 0.52, max_size=10 if _is_scut_academic_chrome(style) else 9, min_size=8 if _is_scut_academic_chrome(style) else 7, color=p["muted"], anchor=MSO_ANCHOR.MIDDLE, margin=0.02)
    center_x = loop_x + loop_w * 0.5
    center_y = y + h * 0.5
    radius_x = loop_w * 0.34
    radius_y = min(1.65, h * 0.32)
    positions = [
        (center_x - 0.85, center_y - radius_y),
        (center_x + radius_x - 0.75, center_y - 0.28),
        (center_x - 0.85, center_y + radius_y - 0.55),
        (center_x - radius_x - 0.75, center_y - 0.28),
    ]
    colors = [p["accent"], p["accent2"], ex["warm"], ex["good"]]
    for i, (nx, ny) in enumerate(positions):
        node_w = (2.22 if boost >= 2 else 2.08) if _is_scut_academic_chrome(style) else 1.7
        node_h = (0.8 if boost >= 2 else 0.72) if _is_scut_academic_chrome(style) else 0.56
        _add_rect(slide, nx, ny, node_w, node_h, "FFFFFF", line=colors[i], radius=False)
        _add_autofit_text(slide, labels[i], nx + 0.12, ny + 0.1, node_w - 0.24, node_h - 0.18, max_size=(11 + min(boost, 2)) if _is_scut_academic_chrome(style) else 8, min_size=10 if (_is_scut_academic_chrome(style) and boost >= 2) else (9 if _is_scut_academic_chrome(style) else 6), color=p["ink"], bold=True, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE, margin=0.01)
        nnx, nny = positions[(i + 1) % len(positions)]
        _add_line(slide, nx + node_w / 2, ny + node_h / 2, nnx + node_w / 2, nny + node_h / 2, colors[i], width=1.3)
    center_d = 1.42 if _is_scut_academic_chrome(style) else 1.16
    _add_circle(slide, center_x - center_d / 2, center_y - center_d / 2, center_d, p["accent"], line=p["accent2"])
    _add_autofit_text(slide, labels[4], center_x - 0.54, center_y - 0.2, 1.08, 0.4, max_size=10 if _is_scut_academic_chrome(style) else 8, min_size=9 if _is_scut_academic_chrome(style) else 6, color=p["bg"], bold=True, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE, margin=0.01)


def _render_template_chrome_gallery_layout(
    slide,
    spec: SlideSpec,
    style: PPTStyleDecision,
    content_box: tuple[float, float, float, float],
) -> None:
    p = style.palette
    ex = _palette_extras(style)
    x, y, w, h = content_box
    points = _template_rich_bullets(spec, limit=3)
    boost = _academic_sparse_spec_boost(style, spec, points)
    terms = [term for term in _template_concept_terms(spec, limit=4) if term not in points]
    gallery_h = h - 1.05
    gap = 0.18
    cols = 3
    tile_w = (w - gap * (cols - 1)) / cols
    accents = [p["accent"], p["accent2"], ex["warm"]]
    stage_labels = ["输入证据", "约束信号", "生成结果"]
    for i in range(cols):
        cx = x + i * (tile_w + gap)
        _add_academic_ref_panel(slide, style, cx, y + 0.16, tile_w, gallery_h, fill=_academic_ref_fill(style, i), accent=accents[i], radius=True)
        _add_rect(slide, cx, y + 0.16, tile_w, 0.08, accents[i])
        inner_x = cx + 0.2
        inner_y = y + 0.52
        inner_w = tile_w - 0.4
        inner_h = gallery_h - 1.28
        _add_academic_ref_panel(slide, style, inner_x, inner_y, inner_w, inner_h, fill="FFFFFF", radius=True)
        label = points[i] if i < len(points) else (terms[i - len(points)] if i - len(points) < len(terms) else "")
        body = label or stage_labels[i]
        icon_size = 0.5 if _is_scut_academic_chrome(style) else 0.44
        _add_template_icon(slide, _template_icon_kind(body), inner_x + 0.24, inner_y + 0.24, icon_size, accents[i])
        _add_text(
            slide,
            stage_labels[i],
            inner_x + 0.88,
            inner_y + 0.27,
            inner_w - 1.1,
            0.28,
            size=10 if _is_scut_academic_chrome(style) else 8,
            color=accents[i],
            bold=True,
            margin=0,
        )
        _add_line(slide, inner_x + 0.24, inner_y + 0.88, inner_x + inner_w - 0.24, inner_y + 0.88, _academic_ref_colors(style)["line"], width=0.75)
        _add_autofit_text(
            slide,
            _academic_visible_text(style, body, 52),
            inner_x + 0.34,
            inner_y + 1.08,
            inner_w - 0.68,
            inner_h - 1.38,
            max_size=13 + min(boost, 2) if _is_scut_academic_chrome(style) else 10,
            min_size=9 if _is_scut_academic_chrome(style) else 7,
            color=p["ink"],
            bold=True,
            align=PP_ALIGN.CENTER,
            anchor=MSO_ANCHOR.MIDDLE,
            margin=0.03,
        )
        if label:
            _add_autofit_text(slide, _academic_visible_text(style, label, 24), cx + 0.25, y + gallery_h - 0.54, tile_w - 0.5, 0.46, max_size=11 if _is_scut_academic_chrome(style) else 9, min_size=8 if _is_scut_academic_chrome(style) else 6, color=p["ink"], bold=True, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE, margin=0.01)
    note = (points[:1] or [spec.title or ""])[0]
    if note:
        _add_academic_ref_panel(slide, style, x, y + h - 0.72, w, 0.62, fill="FFFFFF", radius=True)
        _add_autofit_text(slide, _academic_visible_text(style, note, 54), x + 0.25, y + h - 0.62, w - 0.5, 0.44, max_size=10 if _is_scut_academic_chrome(style) else 9, min_size=8 if _is_scut_academic_chrome(style) else 6, color=p["muted"], align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE, margin=0.01)


def _render_template_chrome_comparison_layout(
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
    gap = 0.32
    col_w = (w - gap) / 2
    left = points[: max(1, len(points) // 2)]
    right = points[max(1, len(points) // 2) :]
    raw = f"{spec.title or ''} {spec.message or ''} {spec.visual or ''}"
    if any(key in raw for key in ["挑战", "问题", "限制", "缺口", "上限"]):
        labels = (_localized_label(spec, "现有限制", "CURRENT LIMITS"), _localized_label(spec, "关键挑战", "KEY CHALLENGE"))
    elif any(key in raw for key in ["结果", "实验", "指标", "评估", "TailorBench"]):
        labels = (_localized_label(spec, "评估证据", "EVALUATION EVIDENCE"), _localized_label(spec, "结果解读", "RESULT READOUT"))
    else:
        labels = (_localized_label(spec, "核心观察", "KEY OBSERVATION"), _localized_label(spec, "方法启示", "METHOD INSIGHT"))
    top = y + 0.08
    usable_h = h - 0.28
    if _is_scut_academic_chrome(style):
        ref = _academic_ref_colors(style)
        for col, (label, items, accent) in enumerate([(labels[0], left, p["accent"]), (labels[1], right or left[-1:], p["accent2"])]):
            cx = x + col * (col_w + gap)
            _add_line(slide, cx, top + 0.08, cx + col_w, top + 0.08, ref["line"], width=1.0)
            _add_rect(slide, cx, top + 0.18, 0.12, 0.4, accent)
            _add_text(slide, label, cx + 0.28, top + 0.16, col_w - 0.56, 0.28, size=11, color=p["ink"], bold=True, margin=0)
            _add_academic_plain_list(
                slide,
                style,
                items[:4],
                cx,
                top + 0.72,
                col_w,
                usable_h - 1.02,
                start=1,
                max_items=4,
                max_size=10,
            )
        band_h = 0.9
        band_y = top + usable_h - band_h - 0.12
        if band_y > top + 2.7 and not _prefers_english_spec(spec):
            if "catalog-bound" in raw.lower() or "目录式" in raw or "内容池" in raw:
                chain = ["内容池限制", "偏好画像", "按需生成"]
            elif "TailorBench" in raw or "评估" in raw or "结果" in raw:
                chain = ["数据集", "评估维度", "关键结果"]
            elif "消融" in raw:
                chain = ["偏好证据", "生成约束", "整体效果"]
            else:
                terms = _template_concept_terms(spec, limit=5)
                chain = []
                for candidate in terms:
                    if candidate not in chain and len(candidate) >= 2:
                        chain.append(candidate)
                    if len(chain) >= 3:
                        break
            if len(chain) < 3:
                chain = [labels[0], "偏好画像", labels[1]]
            _add_academic_plain_note(slide, style, " → ".join(chain[:3]), x + 0.28, band_y, w - 0.56, 0.62, label=_localized_label(spec, "核心转向", "KEY SHIFT"))
        return

    for col, (label, items, accent) in enumerate([(labels[0], left, p["accent"]), (labels[1], right or left[-1:], p["accent2"])]):
        cx = x + col * (col_w + gap)
        _add_academic_ref_panel(slide, style, cx, top, col_w, usable_h, fill=_academic_ref_fill(style, col), accent=accent, radius=True)
        _add_rect(slide, cx, top, col_w, 0.08, accent)
        _add_text(slide, label, cx + 0.28, top + 0.28, col_w - 0.56, 0.26, size=11, color=p["ink"], bold=True, margin=0)
        item_count = min(len(items), 4)
        item_gap = 0.0
        list_top = top + 0.82
        list_h = usable_h - 1.08
        item_h = min(0.78, (list_h - item_gap * max(item_count - 1, 0)) / max(item_count, 1))
        for i, item in enumerate(items[:4]):
            iy = list_top + i * (item_h + item_gap)
            _add_line(slide, cx + 0.28, iy + item_h, cx + col_w - 0.28, iy + item_h, ex["grid"], width=0.7)
            _add_rect(slide, cx + 0.34, iy + 0.16, 0.1, item_h - 0.32, accent)
            _add_autofit_text(
                slide,
                item,
                cx + 0.62,
                iy + 0.08,
                col_w - 0.98,
                item_h - 0.16,
                max_size=11 if _is_scut_academic_chrome(style) else 10,
                min_size=8 if _is_scut_academic_chrome(style) else 7,
                color=p["ink"],
                anchor=MSO_ANCHOR.MIDDLE,
                margin=0.03,
            )
    band_h = 1.18
    band_y = top + usable_h - band_h - 0.3
    if band_y > top + 2.5 and not _prefers_english_spec(spec):
        _add_academic_ref_panel(slide, style, x + 0.28, band_y, w - 0.56, band_h, fill="FFFFFF", radius=True)
        _add_text(slide, _localized_label(spec, "核心转向", "KEY SHIFT"), x + 0.58, band_y + 0.18, 1.1, 0.24, size=9, color=p["accent"], bold=True, margin=0)
        if "catalog-bound" in raw.lower() or "目录式" in raw or "内容池" in raw:
            chain = ["内容池限制", "偏好画像", "按需生成"] if not _prefers_english_spec(spec) else ["Catalog limits", "Preference profile", "On-demand output"]
        elif "TailorBench" in raw or "评估" in raw or "结果" in raw:
            chain = ["数据集", "评估维度", "关键结果"] if not _prefers_english_spec(spec) else ["Dataset", "Evaluation axis", "Key result"]
        elif "消融" in raw:
            chain = ["偏好证据", "生成约束", "整体效果"] if not _prefers_english_spec(spec) else ["Preference evidence", "Generation constraint", "Overall effect"]
        else:
            terms = _template_concept_terms(spec, limit=5)
            chain = []
            for candidate in terms:
                if candidate not in chain and len(candidate) >= 2:
                    chain.append(candidate)
                if len(chain) >= 3:
                    break
        if len(chain) < 3:
            chain = [labels[0], _localized_label(spec, "偏好画像", "Preference profile"), labels[1]]
        node_w = min(2.35, (w - 3.4) / 3)
        start_x = x + 2.05
        node_y = band_y + 0.42
        colors = [p["accent"], p["accent2"], ex["good"]]
        for i, label in enumerate(chain[:3]):
            nx = start_x + i * (node_w + 0.72)
            _add_rect(slide, nx, node_y, node_w, 0.46, "FFFFFF", line=colors[i % len(colors)], radius=False)
            _add_autofit_text(
                slide,
                label,
                nx + 0.1,
                node_y + 0.08,
                node_w - 0.2,
                0.24,
                max_size=9,
                min_size=8,
                color=p["ink"],
                bold=True,
                align=PP_ALIGN.CENTER,
                anchor=MSO_ANCHOR.MIDDLE,
                margin=0.01,
            )
            if i < 2:
                _add_text(slide, "→", nx + node_w + 0.18, node_y + 0.08, 0.35, 0.26, size=12, color=colors[i], bold=True, align=PP_ALIGN.CENTER, margin=0)


def _render_template_chrome_cards_layout(
    slide,
    spec: SlideSpec,
    style: PPTStyleDecision,
    content_box: tuple[float, float, float, float],
    *,
    index: int = 0,
) -> None:
    p = style.palette
    ex = _palette_extras(style)
    points = _template_rich_bullets(spec, limit=4)
    boost = _academic_sparse_spec_boost(style, spec, points)
    if len(points) <= 2:
        _render_template_chrome_claim_variant_layout(slide, spec, style, content_box)
        return
    variant = _template_card_variant(spec, index)
    if variant == 1:
        _render_template_chrome_triptych_cards_layout(slide, spec, style, content_box)
        return
    if variant == 2:
        _render_template_chrome_ladder_cards_layout(slide, spec, style, content_box)
        return
    if variant == 3:
        _render_template_chrome_mosaic_cards_layout(slide, spec, style, content_box)
        return
    x, y, w, h = content_box
    top = y + 0.28
    lead_w = min(4.1, w * 0.34)
    list_x = x + lead_w + 0.48
    list_w = w - lead_w - 0.48
    row_gap = 0.02
    row_h = min(0.76, (h - 0.95 - row_gap * (len(points[:4]) - 1)) / max(len(points[:4]), 1))
    accents = [p["accent"], p["accent2"], ex["warm"], ex["good"]]
    lead = points[0]

    if _is_scut_academic_chrome(style):
        ref = _academic_ref_colors(style)
        _add_line(slide, x, top + 0.08, x, top + min(h - 1.2, 3.2), p["accent"], width=2.0)
        _add_text(slide, _localized_label(spec, "核心结论", "KEY TAKEAWAY"), x + 0.3, top + 0.08, 1.05, 0.26, size=9, color=p["accent"], bold=True, margin=0)
        _add_autofit_text(
            slide,
            _academic_visible_text(style, lead, 36),
            x + 0.3,
            top + 0.52,
            lead_w - 0.42,
            min(h - 1.75, 2.36 if boost >= 2 else 2.15),
            max_size=20 + min(boost, 4),
            min_size=12 if boost >= 2 else 11,
            color=p["ink"],
            bold=True,
            anchor=MSO_ANCHOR.MIDDLE,
            margin=0.02,
        )
        _add_line(slide, list_x, top + 0.08, list_x + list_w, top + 0.08, ref["line"], width=1.0)
        _add_text(slide, _localized_label(spec, "支撑要点", "SUPPORT"), list_x, top + 0.2, 1.05, 0.26, size=9, color=ref["title"], bold=True, margin=0)
        list_bottom = _add_academic_plain_list(
            slide,
            style,
            points[1:5],
            list_x,
            top + 0.58,
            list_w,
            min(2.95, h - 1.45),
            start=2,
            max_items=4,
            max_size=12 + min(boost, 3),
        )
        return

    _add_academic_ref_panel(slide, style, x, top, lead_w, min(h - 1.15, 3.35), fill=_academic_ref_fill(style, 0), radius=True)
    _add_rect(slide, x, top, 0.11, min(h - 1.15, 3.35), p["accent"])
    _add_text(slide, _localized_label(spec, "核心结论", "KEY TAKEAWAY"), x + 0.34, top + 0.26, lead_w - 0.62, 0.26, size=9, color=p["accent"], bold=True, margin=0)
    _add_autofit_text(
        slide,
        lead,
        x + 0.34,
        top + 0.78,
        lead_w - 0.62,
        min(h - 2.0, 2.05),
        max_size=17,
        min_size=10,
        color=p["ink"],
        bold=True,
        anchor=MSO_ANCHOR.MIDDLE,
        margin=0.03,
    )
    for i, point in enumerate(points[1:5]):
        cy = top + i * (row_h + row_gap)
        _add_academic_ref_panel(slide, style, list_x, cy, list_w, row_h, fill=_academic_ref_fill(style, i + 1), radius=False)
        _add_rect(slide, list_x, cy, 0.1, row_h, accents[(i + 1) % len(accents)])
        _add_template_icon(slide, _template_icon_kind(point), list_x + 0.24, cy + row_h * 0.5 - 0.18, 0.36, accents[(i + 1) % len(accents)])
        _add_autofit_text(
            slide,
            point,
            list_x + 0.82,
            cy + 0.1,
            list_w - 1.04,
            row_h - 0.18,
            max_size=12,
            min_size=8,
            color=p["ink"],
            anchor=MSO_ANCHOR.MIDDLE,
            margin=0.02,
        )


def _render_template_chrome_content(
    slide,
    background_path: Path,
    spec: SlideSpec,
    style: PPTStyleDecision,
    template: PPTTemplateDecision,
    root: Path,
    *,
    role: str,
    index: int,
    total: int,
    image_path: Path | None = None,
    prepared_dir: Path | None = None,
) -> None:
    _add_template_chrome_background(slide, background_path)
    title_box, content_box = _template_chrome_boxes(template, role)
    _add_template_chrome_title(slide, spec, style, title_box)
    visual_text = _clean_layout_markers(" ".join([spec.title or "", spec.visual or "", spec.message or ""]))
    points = _template_rich_bullets(spec, limit=4)
    numbery = sum(1 for point in points if _extract_highlight(point))
    layout_id = _select_template_layout_id(root=root, spec=spec, style=style, index=index, total=total)
    if image_path is not None and prepared_dir is not None:
        _render_template_chrome_image_layout(slide, spec, style, image_path, content_box, prepared_dir, index)
    elif _is_hitsz_academic_chrome(style):
        _render_hitsz_template_chrome_content(
            slide,
            spec,
            style,
            content_box,
            layout_id=layout_id,
            index=index,
            total=total,
        )
    elif layout_id in {"motivation_compare", "project_target_map"}:
        if _is_scut_academic_chrome(style):
            if len(points) <= 2:
                _render_template_chrome_sparse_variant_layout(slide, spec, style, content_box, index=index)
            elif index % 2 == 0:
                _render_template_chrome_two_column_plain_layout(slide, spec, style, content_box)
            else:
                _render_template_chrome_motivation_layout(slide, spec, style, content_box)
        else:
            _render_template_chrome_motivation_layout(slide, spec, style, content_box)
    elif layout_id in {"challenge_map", "domain_object_map"}:
        _render_template_chrome_claim_variant_layout(slide, spec, style, content_box, index=index)
    elif layout_id in {"method_loop"}:
        if _is_scut_academic_chrome(style) and index % 4 != 0:
            if len(points) >= 3:
                _render_template_chrome_ladder_layout(slide, spec, style, content_box)
            else:
                _render_template_chrome_sparse_variant_layout(slide, spec, style, content_box, index=index)
        else:
            _render_template_chrome_loop_layout(slide, spec, style, content_box)
    elif layout_id in {"method_pipeline", "technical_route", "milestone_roadmap"}:
        _render_template_chrome_process_layout(slide, spec, style, content_box)
    elif layout_id in {"benchmark_metrics", "evaluation_dashboard"}:
        if numbery >= 2:
            _render_template_chrome_bigstat_layout(slide, spec, style, content_box)
        else:
            _render_template_chrome_matrix_layout(slide, spec, style, content_box)
    elif layout_id in {"results_bars"}:
        _render_template_chrome_results_bars_layout(slide, spec, style, content_box)
    elif layout_id in {"leaderboard_table"}:
        _render_template_chrome_leaderboard_layout(slide, spec, style, content_box)
    elif layout_id in {"result_big_numbers"}:
        _render_template_chrome_bigstat_layout(slide, spec, style, content_box)
    elif layout_id in {"ablation_matrix", "risk_action_table"}:
        _render_template_chrome_comparison_layout(slide, spec, style, content_box)
    elif layout_id in {"evidence_grid"}:
        _render_template_chrome_evidence_grid_layout(slide, spec, style, content_box)
    elif layout_id in {"case_gallery"}:
        _render_template_chrome_gallery_layout(slide, spec, style, content_box)
    elif layout_id in {"workpackage_matrix"}:
        _render_template_chrome_matrix_layout(slide, spec, style, content_box)
    elif layout_id in {"summary_takeaways"}:
        _render_template_chrome_cards_layout(slide, spec, style, content_box, index=index)
    elif len(points) <= 2:
        _render_template_chrome_sparse_variant_layout(slide, spec, style, content_box, index=index)
    elif any(key in visual_text for key in ["生成插图", "概念图", "场景图", "背景图", "配图", "图片"]):
        _render_template_chrome_claim_variant_layout(slide, spec, style, content_box, index=index)
    elif numbery >= 2 and any(key in visual_text for key in ["结果", "实验", "评估", "指标", "数据", "统计", "TailorBench", "Recall", "NDCG", "CTR", "CVR"]):
        _render_template_chrome_bigstat_layout(slide, spec, style, content_box)
    elif any(key in visual_text for key in ["流程", "workflow", "步骤", "链路", "阶段", "四步", "三步"]):
        _render_template_chrome_process_layout(slide, spec, style, content_box)
    elif any(key in visual_text for key in ["架构", "分层", "模块", "系统", "框架", "数据层", "算法层", "服务层"]):
        _render_template_chrome_matrix_layout(slide, spec, style, content_box)
    elif any(key in visual_text for key in ["指标", "挑战", "对比", "左右", "两栏", "评估", "问题"]):
        _render_template_chrome_comparison_layout(slide, spec, style, content_box)
    elif any(key in visual_text for key in ["价值", "三方", "用户", "平台", "商家", "生产者"]):
        _render_template_chrome_cards_layout(slide, spec, style, content_box, index=index)
    elif index == total:
        _render_template_chrome_cards_layout(slide, spec, style, content_box, index=index)
    elif index % 3 == 1:
        _render_template_chrome_process_layout(slide, spec, style, content_box)
    elif index % 3 == 2:
        _render_template_chrome_cards_layout(slide, spec, style, content_box, index=index)
    else:
        _render_template_chrome_matrix_layout(slide, spec, style, content_box)


def _render_template_chrome_directory(
    slide,
    background_path: Path,
    spec: SlideSpec,
    style: PPTStyleDecision,
    template: PPTTemplateDecision,
) -> None:
    _add_template_chrome_background(slide, background_path)
    boxes = _template_source_placeholder_boxes(template, "directory")
    raw_title = _clean_visible_text(spec.title or "")
    points = _meaningful_bullets(spec.message or "", limit=4)
    title = re.sub(r"^(目录|章节|chapter|section|agenda|outline)\s*[:：\-—]*\s*", "", raw_title, flags=re.IGNORECASE).strip()
    if not title:
        title = "汇报结构" if points else (raw_title or "章节概览")
    p = style.palette
    ref = _academic_ref_colors(style)
    if template.template_id == "hitsz":
        # The HITSZ chapter page uses a left campus photo and a right white text
        # field; keep all generated content inside that white field.
        title_box = (6.72, 1.72, 5.62, 1.58)
        _add_autofit_text(
            slide,
            title,
            *title_box,
            max_size=34,
            min_size=20,
            color=p["ink"],
            bold=True,
            align=PP_ALIGN.CENTER,
            anchor=MSO_ANCHOR.MIDDLE,
            margin=0.02,
        )
        line_y = title_box[1] + title_box[3] + 0.2
        _add_line(slide, title_box[0] + 0.38, line_y, title_box[0] + title_box[2] - 0.38, line_y, p["accent"], width=1.2)
        subtitle = next((_clean_visible_text(item) for item in points if _clean_visible_text(item)), "")
        if subtitle:
            _add_autofit_text(
                slide,
                _hitsz_visible_text(subtitle, 42),
                title_box[0] + 0.42,
                line_y + 0.24,
                title_box[2] - 0.84,
                0.56,
                max_size=12,
                min_size=9,
                color=p["muted"],
                align=PP_ALIGN.CENTER,
                anchor=MSO_ANCHOR.MIDDLE,
                margin=0.01,
            )
        return

    title_box = _box_or_default(boxes, 0, (1.1, 2.25, 11.0, 1.2))
    _add_autofit_text(
        slide,
        title,
        *title_box,
        max_size=32,
        min_size=18,
        color=p["ink"],
        bold=True,
        align=PP_ALIGN.CENTER,
        anchor=MSO_ANCHOR.MIDDLE,
        margin=0.03,
    )
    if points:
        body_box = _box_or_default(boxes, 1, (2.1, 4.0, 9.2, 1.0))
        _add_autofit_text(
            slide,
            "\n".join(_clean_visible_text(point) for point in points[:3]),
            *body_box,
            max_size=14,
            min_size=9,
            color=p["muted"],
            align=PP_ALIGN.CENTER,
            anchor=MSO_ANCHOR.MIDDLE,
            margin=0.03,
        )


def _render_template_chrome_ending(
    slide,
    background_path: Path,
    spec: SlideSpec,
    style: PPTStyleDecision,
    template: PPTTemplateDecision,
) -> None:
    _add_template_chrome_background(slide, background_path)
    boxes = _template_source_placeholder_boxes(template, "ending")
    title = spec.title if re.search(r"(谢谢|thanks|q&a|qa|讨论)", spec.title or "", re.IGNORECASE) else "谢谢观看"
    title_box = _box_or_default(boxes, 0, (7.95, 3.39, 4.47, 1.49))
    body_box = _box_or_default(boxes, 10, _box_or_default(boxes, 1, (7.95, 1.71, 4.47, 1.0)))
    _add_autofit_text(
        slide,
        title,
        *title_box,
        max_size=30,
        min_size=16,
        color=style.palette["ink"],
        bold=True,
        align=PP_ALIGN.CENTER,
        anchor=MSO_ANCHOR.MIDDLE,
        margin=0.03,
    )
    points = _meaningful_bullets(spec.message or "", limit=2)
    if points:
        _add_autofit_text(
            slide,
            "\n".join(points),
            *body_box,
            max_size=14,
            min_size=9,
            color=style.palette["muted"],
            align=PP_ALIGN.CENTER,
            anchor=MSO_ANCHOR.MIDDLE,
            margin=0.04,
        )


def _render_template_chrome_slide(
    slide,
    background_path: Path,
    spec: SlideSpec,
    style: PPTStyleDecision,
    template: PPTTemplateDecision,
    root: Path,
    *,
    role: str,
    index: int,
    total: int,
    image_path: Path | None = None,
    prepared_dir: Path | None = None,
) -> None:
    if role == "cover":
        _render_template_chrome_cover(slide, background_path, spec, style, template)
    elif role == "directory":
        _render_template_chrome_directory(slide, background_path, spec, style, template)
    elif role == "ending":
        _render_template_chrome_ending(slide, background_path, spec, style, template)
    else:
        _render_template_chrome_content(
            slide,
            background_path,
            spec,
            style,
            template,
            root,
            role=role,
            index=index,
            total=total,
            image_path=image_path,
            prepared_dir=prepared_dir,
        )



__all__ = [
    "_template_card_variant",
    "_render_template_chrome_triptych_cards_layout",
    "_render_template_chrome_ladder_cards_layout",
    "_render_template_chrome_mosaic_cards_layout",
    "_render_template_chrome_loop_layout",
    "_render_template_chrome_gallery_layout",
    "_render_template_chrome_comparison_layout",
    "_render_template_chrome_cards_layout",
    "_render_template_chrome_content",
    "_render_template_chrome_directory",
    "_render_template_chrome_ending",
    "_render_template_chrome_slide",
]
