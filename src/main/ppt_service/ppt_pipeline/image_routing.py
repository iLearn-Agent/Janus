from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any

from janus_lab.ppt_renderer import SlideSpec

def _generated_image_brief(spec: SlideSpec) -> str:
    visual = re.sub(r"\blayout_id\s*[:：=]\s*[a-zA-Z0-9_-]+", " ", spec.visual or "", flags=re.IGNORECASE)
    visual = re.sub(
        r"(?:生成插图|生成图片|生成概念插图|概念插图|image prompt|generate image)\s*[:：=\-]*",
        " ",
        visual,
        flags=re.IGNORECASE,
    )
    visual = re.sub(r"\s+", " ", visual).strip(" ；;，,。")
    return visual or spec.message or spec.title or "presentation supporting visual"


def _topic_image_world(spec: SlideSpec) -> str:
    text = f"{spec.title or ''} {spec.message or ''} {spec.visual or ''}".lower()
    topic_profiles = [
        (
            r"(医学|医疗|临床|生物|细胞|蛋白|基因|药物|脑科学|生命科学|medical|clinical|bio|cell|protein|gene|drug)",
            "Life-science world: biomolecular, cellular, tissue, laboratory, or clinical subject matter; translucent organic materials and microscopy-inspired depth; scientifically credible rather than a generic AI brain.",
        ),
        (
            r"(制造|工业|工厂|设备|机械|能源|电网|光网络|芯片|机器人|供应链|manufactur|industrial|factory|machine|energy|grid|robot|semiconductor)",
            "Engineering world: real machinery, infrastructure, physical components, brushed metal, glass, cables, energy flow, and human-scale operations; grounded and buildable rather than abstract sci-fi circuitry.",
        ),
        (
            r"(农业|生态|环境|气候|碳|森林|海洋|可持续|agri|ecology|environment|climate|carbon|forest|ocean|sustainab)",
            "Environmental world: recognizable landscapes, organisms, water, soil, atmosphere, and material cycles with natural light and tactile textures; avoid generic green-leaf icons.",
        ),
        (
            r"(文化|历史|文学|艺术|博物馆|建筑|城市|遗产|culture|history|literature|museum|architecture|urban|heritage)",
            "Cultural-editorial world: archival materials, typography-free documents, artifacts, architecture, people, and place-specific textures; thoughtful documentary tone rather than corporate technology imagery.",
        ),
        (
            r"(电商|零售|消费|品牌|短视频|音乐|推荐|内容平台|社交|commerce|retail|consumer|brand|video|music|recommend|social media)",
            "Contemporary consumer-media world: products, creators, audiences, devices, storefront or feed contexts, expressive color and human behavior; avoid anonymous stock-office scenes.",
        ),
        (
            r"(教育|学习|课堂|教师|学生|课程|education|learning|classroom|teacher|student|course)",
            "Learning world: real learners, teaching materials, spatial interaction, curiosity, and progression; warm documentary/editorial cues instead of generic graduation symbols.",
        ),
        (
            r"(金融|商业|市场|组织|管理|战略|投资|finance|business|market|organization|management|strategy|investment)",
            "Business-editorial world: concrete flows of people, capital, products, decisions, and environments expressed through architectural or material metaphors; no handshakes, stock-photo meetings, or floating charts.",
        ),
        (
            r"(人工智能|智能体|大模型|算法|数据|软件|网络|多模态|ai\b|agent|model|algorithm|data|software|network|multimodal)",
            "Computational world: depict the specific inputs, transformations, agents, interfaces, and outcomes named by the slide through a concrete spatial or material metaphor; avoid glowing brains, humanoid robots, blue binary rain, and generic neural-network webs.",
        ),
    ]
    for pattern, direction in topic_profiles:
        if re.search(pattern, text, re.IGNORECASE):
            return direction
    return (
        "Topic-specific world: use the concrete nouns, actors, environment, materials, and mechanism named by the slide. "
        "Prefer one literal subject or one precise visual metaphor; do not fall back to a generic technology background."
    )


def _style_image_direction(style: Any) -> str:
    style_id = str(getattr(style, "style_id", "") or "general").lower()
    profiles = {
        "academic_report": (
            "Publication-grade scientific editorial illustration: precise, restrained, evidence-oriented, crisp silhouettes, "
            "subtle paper grain or natural material texture, orthographic/cutaway/macro viewpoint when useful; no glossy corporate 3D and no neon sci-fi look."
        ),
        "major_project": (
            "Cinematic engineering and industrial editorial art: credible scale, real materials, operational detail, controlled dramatic light, "
            "deep spatial layering, and sponsor-facing seriousness; no futuristic HUD overlays or speculative sci-fi machinery."
        ),
        "general": (
            "Contemporary editorial art direction selected to fit the topic: a refined photographic-concept, tactile collage, crafted 3D still life, "
            "or painterly editorial illustration. Make the chosen medium visually decisive; avoid default corporate-blue technology art."
        ),
        "unseen_default": (
            "Distinctive contemporary editorial illustration grounded in the topic, with tactile materials, confident composition, and a non-generic visual metaphor."
        ),
    }
    base = profiles.get(style_id)
    if base:
        return f"{base} Selected deck style context: {style.prompt}"
    return (
        f"Make the user-selected style visibly dominant: {style.prompt or getattr(style, 'label', style_id)}. "
        "Translate it into a coherent image medium, lighting model, material language, and composition rather than merely changing accent colors."
    )


def _slide_image_role(spec: SlideSpec) -> str:
    text = f"{spec.title or ''} {spec.message or ''} {spec.visual or ''}".lower()
    layout_id = _spec_layout_id(spec)
    if layout_id == "cover" or re.search(r"(封面|标题页|cover|opening)", text):
        return "Opening hero: one memorable focal subject, strong atmosphere, and generous clean negative space for editable title overlays."
    if layout_id in {"motivation_compare", "challenge_map", "risk_action_table"} or re.search(r"(痛点|挑战|风险|矛盾|problem|challenge|risk|gap)", text):
        return "Problem framing: show a specific tension, contrast, bottleneck, or before/after condition through a narrative scene or material metaphor."
    if layout_id in {"case_gallery", "evidence_grid", "media_showcase"} or re.search(r"(案例|场景|应用|demo|case|scenario|application)", text):
        return "Case/evidence visual: a believable subject in context with documentary specificity, not an abstract infographic or icon grid."
    if layout_id in {"summary_takeaways", "milestone_roadmap"} or re.search(r"(未来|展望|下一步|愿景|future|outlook|next step|vision)", text):
        return "Forward-looking close: convey transition, momentum, scale, or an emerging horizon without using roads-to-sunrise clichés."
    return "Explanatory visual thesis: communicate one central idea with one dominant focal subject and only a few meaningful secondary cues."


def _slide_image_composition(spec: SlideSpec, style: Any) -> str:
    variants = [
        "Asymmetric editorial composition; focal subject in one third, layered depth, and a broad quiet region for slide text.",
        "Wide cinematic composition; foreground detail, clear midground action, restrained background context, and natural visual flow.",
        "Graphic close-up or cutaway composition; one dominant form, purposeful cropping, tactile detail, and strong silhouette.",
        "Environmental composition; subject embedded in a recognizable setting, diagonal or curved visual movement, and uncluttered negative space.",
    ]
    key = f"{getattr(style, 'style_id', '')}|{spec.title or ''}|{spec.visual or ''}".encode("utf-8")
    return variants[hashlib.sha256(key).digest()[0] % len(variants)]


def _slide_image_palette(style: Any) -> str:
    style_id = str(getattr(style, "style_id", "") or "").lower()
    if style_id.startswith("custom_") or bool(getattr(style, "created", False)):
        return (
            "Use the palette naturally implied by the user-selected custom style and subject matter; "
            "do not inherit the default corporate blue palette unless the style explicitly calls for it."
        )
    palette = getattr(style, "palette", {}) or {}
    colors = [str(palette.get(key) or "").lstrip("#") for key in ("ink", "accent", "accent2", "bg")]
    colors = [f"#{color}" for color in colors if re.fullmatch(r"[0-9A-Fa-f]{6}", color)]
    if not colors:
        return "Use a topic-appropriate palette with controlled contrast and natural material colors."
    return f"Use deck colors {', '.join(colors)} as restrained accents; preserve believable subject and material colors instead of tinting the whole image."


def _slide_image_prompt(spec: SlideSpec, style: Any) -> str:
    title = spec.title or "Presentation visual"
    brief = _generated_image_brief(spec)
    return (
        "Use case: presentation-support-art\n"
        "Asset type: a standalone landscape supporting image, not a slide screenshot, infographic, dashboard, diagram, or poster.\n"
        f"Slide title/context: {title}\n"
        f"Subject and scene brief: {brief}\n"
        f"Narrative role: {_slide_image_role(spec)}\n"
        f"Topic world: {_topic_image_world(spec)}\n"
        f"Visual style and medium: {_style_image_direction(style)}\n"
        f"Color direction: {_slide_image_palette(style)}\n"
        f"Composition: {_slide_image_composition(spec, style)} Landscape 3:2 framing with safe crop room for a 16:9 slide image slot.\n"
        "Content policy: make the subject, environment, materials, lighting, and camera/viewpoint specific to this slide. Favor one strong visual thesis over multiple equal panels or generic decorative elements.\n"
        "Text policy: render no words, letters, numbers, labels, captions, logos, UI, charts, tables, equations, or citations inside the image; PowerPoint will add all exact information as editable overlays.\n"
        "Avoid: watermarks, template chrome, generic blue technology backgrounds, glowing brains, random network webs, stock-photo handshakes, icon grids, and repeated 3D spheres/cubes unless explicitly required by the topic.\n"
    )


def _needs_generated_image(spec: SlideSpec, index: int, total: int) -> bool:
    text = f"{spec.title or ''} {spec.message or ''} {spec.visual or ''}".lower()
    explicit_markers = [
        "gpt-image",
        "image prompt",
        "生成图片",
        "生成插图",
        "配图",
        "插图",
        "图片",
        "背景图",
        "背景",
        "封面视觉",
        "概念图",
        "场景图",
        "视觉元素",
        "电商",
        "短视频",
        "音乐",
        "信息流",
    ]
    diagram_only_markers = ["流程图", "架构图", "关系图", "矩阵", "表格", "时间线", "路线图", "分层", "两栏"]
    if any(marker in text for marker in explicit_markers):
        return True
    if any(marker in text for marker in diagram_only_markers):
        return False
    return index in {1, max(2, total // 2 + 1)}


IMAGE_CAPABLE_LAYOUT_IDS = {"basic_content", "evidence_grid", "case_gallery", "media_showcase"}
IMAGE_ADAPTABLE_LAYOUT_IDS = IMAGE_CAPABLE_LAYOUT_IDS | {"motivation_compare", "challenge_map"}


def _spec_layout_id(spec: SlideSpec) -> str:
    match = re.search(r"\blayout_id\s*[:：=]\s*([a-zA-Z0-9_-]+)", spec.visual or "", re.IGNORECASE)
    return match.group(1).strip().lower() if match else ""


def _explicit_generated_image_requested(spec: SlideSpec) -> bool:
    text = f"{spec.title or ''} {spec.visual or ''}".lower()
    return any(marker in text for marker in (
        "gpt-image",
        "image prompt",
        "生成图片",
        "生成插图",
        "概念插图",
        "generate image",
        "generated image",
    ))


def _selected_image_slide_indices(specs: list[SlideSpec], max_images: int, *, include_cover: bool = True) -> list[int]:
    if max_images <= 0:
        return []
    total = len(specs)
    explicit = [
        index
        for index, spec in enumerate(specs, start=1)
        if _explicit_generated_image_requested(spec)
    ]
    compatible = [
        index
        for index, spec in enumerate(specs, start=1)
        if _spec_layout_id(spec) in IMAGE_ADAPTABLE_LAYOUT_IDS
        and index != total
        and (include_cover or index != 1)
        and _auto_generated_image_eligible(spec, index, total)
    ]
    preferred = [idx for idx in explicit if idx != total and (include_cover or idx != 1)]
    if not include_cover:
        preferred = [idx for idx in preferred if idx != 1]
    if compatible:
        # A single generated infographic needs a reasonably large image slot.
        # Prefer media/case/basic pages over the six-cell evidence mosaic; the
        # latter remains available for explicit requests or source-figure sets.
        roomy = [
            idx for idx in compatible
            if _spec_layout_id(specs[idx - 1]) in {"media_showcase", "case_gallery", "basic_content"}
        ]
        if roomy:
            roomy_spread = [roomy[0], roomy[len(roomy) // 2], roomy[-1]]
            for idx in roomy_spread:
                if idx not in preferred:
                    preferred.append(idx)
                    if len(preferred) >= max_images:
                        break
        # Fill remaining image slots by maximizing distance from already
        # selected pages. This avoids adjacent generated-image pages and gives
        # the deck a more even visual rhythm.
        remaining = [idx for idx in compatible if idx not in preferred]
        while remaining and len(preferred) < max_images:
            if preferred:
                next_index = max(
                    remaining,
                    key=lambda idx: (min(abs(idx - chosen) for chosen in preferred), idx),
                )
            else:
                next_index = remaining[len(remaining) // 2]
            preferred.append(next_index)
            remaining.remove(next_index)
    fallback_candidates = [
        index
        for index, spec in enumerate(specs, start=1)
        if index != total
        and (include_cover or index != 1)
        and _spec_layout_id(spec) in IMAGE_ADAPTABLE_LAYOUT_IDS
        and index not in preferred
    ]
    while fallback_candidates and len(preferred) < max_images:
        if preferred:
            next_index = max(
                fallback_candidates,
                key=lambda idx: (min(abs(idx - chosen) for chosen in preferred), -idx),
            )
        else:
            next_index = fallback_candidates[len(fallback_candidates) // 2]
        preferred.append(next_index)
        fallback_candidates.remove(next_index)
    if not preferred and total > 1:
        # A deck-level minimum-image requirement must not disappear merely
        # because the agent selected only diagram/table/process layouts. The
        # slide-library policy can safely adapt one substantive page to a
        # basic single-image layout when an image is attached to it.
        substantive = [index for index in range(2, total) if index != total]
        if not substantive:
            substantive = [2]
        preferred.append(substantive[len(substantive) // 2])
    if not preferred and include_cover and total:
        preferred.append(1)
    if total in explicit and total not in preferred:
        preferred.append(total)
    return preferred[:max_images]


def _auto_generated_image_eligible(spec: SlideSpec, index: int, total: int) -> bool:
    """Keep automatic bitmap generation on narrative/scene pages only."""
    if _explicit_generated_image_requested(spec):
        return True
    layout_id = _spec_layout_id(spec)
    text = f"{spec.title or ''} {spec.message or ''} {spec.visual or ''}".lower()
    if index == 1:
        return True
    if layout_id in {"case_gallery", "media_showcase"}:
        return True
    scene_markers = (
        "背景", "现状", "场景", "应用", "用户", "产业", "行业", "案例", "痛点", "挑战", "价值", "机会", "边界", "趋势",
        "context", "scenario", "application", "customer", "consumer", "environment", "landscape", "challenge", "opportunity", "trend",
    )
    return layout_id in IMAGE_ADAPTABLE_LAYOUT_IDS and any(marker in text for marker in scene_markers)


def _source_visual_request_text(spec: SlideSpec) -> str:
    return " ".join([spec.title or "", spec.message or "", spec.visual or "", spec.speaker_note or ""])


def _explicit_source_visual_requested(spec: SlideSpec) -> bool:
    text = _source_visual_request_text(spec).lower()
    explicit_markers = (
        "使用附件原图",
        "附件原图",
        "源文档",
        "论文图",
        "论文原图",
        "原文图",
        "原图",
        "截图",
        "source figure",
        "source image",
        "paper figure",
        "attachment figure",
    )
    if any(marker in text for marker in explicit_markers):
        return True
    return bool(re.search(r"\b(?:fig(?:ure)?\.?|图)\s*\d+[a-z]?\b", text, re.IGNORECASE))


def _requested_source_page(spec: SlideSpec) -> int | None:
    text = _source_visual_request_text(spec)
    patterns = [
        r"(?:第|page\s*)\s*(\d{1,3})\s*(?:页|p\b)?",
        r"\bp(?:age)?[.\-_\s]*(\d{1,3})\b",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            try:
                return int(match.group(1))
            except ValueError:
                return None
    return None


def _requested_source_figures(spec: SlideSpec) -> list[int]:
    figures: list[int] = []
    for match in re.finditer(r"\bfig(?:ure)?\.?\s*(\d{1,2})\b|图\s*(\d{1,2})\b", _source_visual_request_text(spec), re.IGNORECASE):
        raw = match.group(1) or match.group(2)
        try:
            value = int(raw)
        except (TypeError, ValueError):
            continue
        if value not in figures:
            figures.append(value)
    return figures


def _source_path_figure_numbers(path: Path) -> list[int]:
    text = path.name.lower()
    combo = re.search(r"figures[-_](\d{1,2})[-_](\d{1,2})", text)
    if combo:
        start = int(combo.group(1))
        end = int(combo.group(2))
        if start <= end:
            return list(range(start, end + 1))
    match = re.search(r"figure[-_](\d{1,2})", text)
    if match:
        return [int(match.group(1))]
    return []


def _source_path_page_number(path: Path) -> int | None:
    text = path.name.lower()
    match = re.search(r"(?:page|p)[-_\s]*(\d{1,3})(?:\D|$)", text)
    if match:
        try:
            return int(match.group(1))
        except ValueError:
            return None
    return None


def _source_visual_slide_indices(specs: list[SlideSpec], max_images: int) -> list[int]:
    if max_images <= 0:
        return []
    total = len(specs)
    preferred = [
        index
        for index, spec in enumerate(specs, start=1)
        if index != 1 and _explicit_source_visual_requested(spec)
    ]
    if not preferred:
        # Attachments are stronger evidence than a generic generated image.
        # When the slide plan forgot to name a source figure, still reserve a
        # suitable body page so at least one extracted visual can be used.
        preferred = _selected_image_slide_indices(specs, 1, include_cover=False)
    return preferred[:max_images]


def _slide_image_list(value: Path | list[Path] | tuple[Path, ...] | None) -> list[Path]:
    if isinstance(value, Path):
        return [value] if value.is_file() else []
    if isinstance(value, (list, tuple)):
        return [path for path in value if isinstance(path, Path) and path.is_file()]
    return []


def _merge_slide_image_maps(
    *maps: dict[int, Path | list[Path]] | None,
) -> dict[int, list[Path]]:
    merged: dict[int, list[Path]] = {}
    for mapping in maps:
        for index, value in (mapping or {}).items():
            bucket = merged.setdefault(index, [])
            for path in _slide_image_list(value):
                if path not in bucket:
                    bucket.append(path)
    return merged


def _first_slide_image(value: Path | list[Path] | None) -> Path | None:
    paths = _slide_image_list(value)
    return paths[0] if paths else None


def _map_source_visuals_to_slides(specs: list[SlideSpec], source_image_paths: list[Path] | None) -> dict[int, list[Path]]:
    source_paths = [path for path in (source_image_paths or []) if path and path.exists()]
    if not source_paths:
        return {}
    indices = _source_visual_slide_indices(specs, len(source_paths))
    if not indices:
        return {}

    assigned: dict[int, list[Path]] = {}
    used: set[Path] = set()
    for index in indices:
        spec = specs[index - 1]
        requested_figures = _requested_source_figures(spec)
        requested_page = _requested_source_page(spec)
        layout_id = _spec_layout_id(spec)
        capacity = 6 if layout_id == "evidence_grid" else 5 if layout_id == "case_gallery" else 1
        if requested_figures:
            capacity = max(capacity, min(6, len(requested_figures)))
        chosen: list[Path] = []
        if requested_figures:
            requested_set = set(requested_figures)
            for path in source_paths:
                if path in used:
                    continue
                figure_set = set(_source_path_figure_numbers(path))
                if figure_set and figure_set.intersection(requested_set):
                    chosen.append(path)
                    if len(chosen) >= capacity:
                        break
        if not chosen and requested_page is not None:
            for path in source_paths:
                if path in used:
                    continue
                if _source_path_page_number(path) == requested_page:
                    chosen.append(path)
                    if len(chosen) >= capacity:
                        break
        if not chosen:
            for path in source_paths:
                if path in used:
                    continue
                chosen.append(path)
                if len(chosen) >= capacity:
                    break
        if chosen:
            assigned[index] = chosen
            used.update(chosen)
    return assigned
