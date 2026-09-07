from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

# The Windows embeddable distribution uses an isolated ``python312._pth``.
# In that mode Python does not reliably add the executed script directory to
# ``sys.path``, so explicitly expose the packaged PPT service and its sibling
# modules before importing them.
PPT_SERVICE_ROOT = Path(__file__).resolve().parent
if str(PPT_SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(PPT_SERVICE_ROOT))

from ppt_debug_service import (
    _convert_powerpoint_to_pdf_windows,
    parse_slide_specs,
    render_styled_ppt_artifact,
)


def _json_default(value: Any) -> str:
    if isinstance(value, Path):
        return str(value)
    return str(value)


def _argument_path(name: str) -> Path | None:
    try:
        index = sys.argv.index(name)
    except ValueError:
        return None
    if index + 1 >= len(sys.argv):
        raise ValueError(f"{name} requires a file path.")
    return Path(sys.argv[index + 1]).resolve()


def _append_protocol_file(name: str, payload: dict[str, Any]) -> bool:
    path = _argument_path(name)
    if path is None:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(payload, ensure_ascii=False, default=_json_default) + "\n")
        stream.flush()
    return True


def _emit_progress(message: str, **extra: Any) -> None:
    payload = {"type": "progress", "message": message, **extra}
    if not _append_protocol_file("--progress-file", payload):
        print(json.dumps(payload, ensure_ascii=False), file=sys.stderr, flush=True)


def _load_payload() -> dict[str, Any]:
    payload_path = _argument_path("--payload-file")
    raw = payload_path.read_text(encoding="utf-8") if payload_path is not None else sys.stdin.read()
    if not raw.strip():
        raise ValueError("Missing render payload on stdin.")
    return json.loads(raw)


def _safe_paths(paths: list[str] | None) -> list[Path]:
    result: list[Path] = []
    for item in paths or []:
        try:
            path = Path(str(item)).resolve()
        except Exception:
            continue
        if path.is_file():
            result.append(path)
    return result


def _safe_slide_image_map(value: dict[str, str] | None) -> dict[int, Path]:
    result: dict[int, Path] = {}
    for raw_index, raw_path in (value or {}).items():
        try:
            index = int(raw_index)
            path = Path(str(raw_path)).resolve()
        except Exception:
            continue
        if index > 0 and path.is_file():
            result[index] = path
    return result


def _font(size: int, *, bold: bool = False):
    candidates = [
        "C:/Windows/Fonts/msyhbd.ttc" if bold else "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simhei.ttf" if bold else "C:/Windows/Fonts/simsun.ttc",
        "/System/Library/Fonts/PingFang.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            try:
                return ImageFont.truetype(candidate, size)
            except Exception:
                pass
    return ImageFont.load_default()


def _wrap_text(draw: ImageDraw.ImageDraw, text: str, font, max_width: int, max_lines: int) -> list[str]:
    text = " ".join(str(text or "").split())
    if not text:
        return []
    lines: list[str] = []
    current = ""
    for char in text:
        test = current + char
        if draw.textbbox((0, 0), test, font=font)[2] <= max_width or not current:
            current = test
            continue
        lines.append(current)
        current = char
        if len(lines) >= max_lines:
            break
    if current and len(lines) < max_lines:
        lines.append(current)
    if len(lines) == max_lines and len("".join(lines)) < len(text):
        lines[-1] = lines[-1].rstrip(" .。") + "..."
    return lines


def _cover_palette(template_id: str, style_id: str) -> dict[str, tuple[int, int, int]]:
    if template_id == "hitsz":
        return {
            "bg": (246, 251, 253),
            "ink": (18, 54, 74),
            "muted": (75, 99, 114),
            "accent": (11, 94, 122),
            "accent2": (28, 120, 166),
        }
    if template_id == "scut":
        return {
            "bg": (255, 248, 247),
            "ink": (64, 23, 28),
            "muted": (112, 64, 70),
            "accent": (182, 25, 24),
            "accent2": (22, 96, 138),
        }
    if style_id == "major_project":
        return {
            "bg": (247, 250, 252),
            "ink": (17, 24, 39),
            "muted": (82, 97, 107),
            "accent": (29, 78, 216),
            "accent2": (217, 119, 6),
        }
    return {
        "bg": (248, 250, 252),
        "ink": (15, 23, 42),
        "muted": (71, 85, 105),
        "accent": (15, 118, 110),
        "accent2": (37, 99, 235),
    }


def _create_fallback_cover(
    *,
    output_dir: Path,
    title: str,
    subtitle: str,
    style_id: str,
    style_label: str,
    template_id: str,
    template_label: str,
    slide_count: int,
) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    cover = output_dir / "cover.png"
    p = _cover_palette(template_id, style_id)
    img = Image.new("RGB", (1280, 720), p["bg"])
    draw = ImageDraw.Draw(img)
    title_font = _font(54, bold=True)
    subtitle_font = _font(28)
    meta_font = _font(22)
    small_font = _font(18)

    draw.rectangle((0, 0, 118, 720), fill=p["accent"])
    draw.rectangle((118, 0, 1280, 16), fill=p["accent2"])
    draw.rounded_rectangle((185, 145, 1075, 438), radius=24, fill=(255, 255, 255), outline=(218, 226, 236), width=2)
    draw.rectangle((185, 145, 1075, 156), fill=p["accent"])
    draw.ellipse((1058, 518, 1192, 652), fill=tuple(min(255, c + 70) for c in p["accent2"]))
    draw.ellipse((1136, 580, 1215, 659), fill=tuple(min(255, c + 92) for c in p["accent"]))

    y = 205
    for line in _wrap_text(draw, title or "PPT 文件已生成", title_font, 790, 3):
        draw.text((232, y), line, font=title_font, fill=p["ink"])
        y += 68
    sub_lines = _wrap_text(draw, subtitle or f"{style_label} / {template_label}", subtitle_font, 780, 2)
    for line in sub_lines:
        draw.text((234, y + 10), line, font=subtitle_font, fill=p["muted"])
        y += 38

    meta = f"{slide_count} slides · {style_label} · {template_label}"
    draw.text((232, 575), meta, font=meta_font, fill=p["ink"])
    draw.text((232, 620), "Editable PowerPoint generated by Janus renderer", font=small_font, fill=p["muted"])
    img.save(cover, format="PNG")
    return cover


def _convert_with_soffice(deck_path: Path, output_dir: Path) -> Path | None:
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        return None
    with tempfile.TemporaryDirectory(prefix="janus-ppt-preview-") as tmp:
        tmp_path = Path(tmp)
        out_dir = tmp_path / "out"
        profile_dir = tmp_path / "profile"
        out_dir.mkdir()
        profile_dir.mkdir()
        env = os.environ.copy()
        env["HOME"] = str(tmp_path)
        cmd = [
            soffice,
            "--headless",
            "--nologo",
            "--nofirststartwizard",
            "--nolockcheck",
            "--nodefault",
            f"-env:UserInstallation=file://{profile_dir}",
            "--convert-to",
            "pdf",
            "--outdir",
            str(out_dir),
            str(deck_path),
        ]
        try:
            completed = subprocess.run(cmd, capture_output=True, text=True, timeout=90, check=False, env=env)
        except (OSError, subprocess.TimeoutExpired):
            return None
        pdf = out_dir / f"{deck_path.stem}.pdf"
        if completed.returncode == 0 and pdf.is_file():
            target = output_dir / "deck.pdf"
            shutil.copyfile(pdf, target)
            return target
    return None


def _convert_with_powerpoint(deck_path: Path, output_dir: Path) -> tuple[Path | None, Path | None]:
    if os.name != "nt" or os.getenv("JANUS_PPT_PREVIEW_COM", "1").strip().lower() in {"0", "false", "no", "off"}:
        return None, None
    pdf = output_dir / "deck.pdf"
    try:
        pdf_path, _error = _convert_powerpoint_to_pdf_windows(output_dir, deck_path, pdf)
    except Exception:
        return None, None
    if pdf_path is None:
        return None, None
    return pdf_path, _render_pdf_cover(pdf_path, output_dir)


def _render_pdf_cover(pdf_path: Path, output_dir: Path) -> Path | None:
    try:
        import fitz  # type: ignore

        cover = output_dir / "cover.png"
        doc = fitz.open(str(pdf_path))
        try:
            if doc.page_count < 1:
                return None
            page = doc.load_page(0)
            scale = max(1.0, 1280 / max(float(page.rect.width), 1.0))
            pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            pix.save(str(cover))
            return cover if cover.is_file() else None
        finally:
            doc.close()
    except Exception:
        return None


def _render_pdf_slide_images(pdf_path: Path, output_dir: Path) -> list[Path]:
    try:
        import fitz  # type: ignore

        slides_dir = output_dir / "slide_previews"
        slides_dir.mkdir(parents=True, exist_ok=True)
        doc = fitz.open(str(pdf_path))
        images: list[Path] = []
        try:
            for page_index in range(doc.page_count):
                destination = slides_dir / f"slide-{page_index + 1:02d}.png"
                if not destination.is_file() or destination.stat().st_size <= 0:
                    page = doc.load_page(page_index)
                    scale = max(1.0, 1280 / max(float(page.rect.width), 1.0))
                    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
                    pix.save(str(destination))
                if destination.is_file():
                    images.append(destination)
        finally:
            doc.close()
        return images
    except Exception:
        return []


def _export_previews(deck_path: Path, output_dir: Path) -> tuple[Path | None, Path | None, list[Path], list[str]]:
    warnings: list[str] = []
    pdf: Path | None = None
    cover: Path | None = None
    if os.name == "nt":
        # On Windows prefer the installed presentation application so the
        # preview uses the same layout engine the user will open the deck in.
        pdf, cover = _convert_with_powerpoint(deck_path, output_dir)
    if pdf is None:
        pdf = _convert_with_soffice(deck_path, output_dir)
        cover = _render_pdf_cover(pdf, output_dir) if pdf else None
    elif cover is None:
        cover = _render_pdf_cover(pdf, output_dir)
    slide_images = _render_pdf_slide_images(pdf, output_dir) if pdf else []
    if pdf is None:
        warnings.append("Office PDF preview was skipped because no working PowerPoint/WPS/LibreOffice exporter was available.")
    if cover is None:
        warnings.append("Deck cover preview used a renderer fallback image instead of Office-rendered first slide.")
    if pdf is not None and not slide_images:
        warnings.append("Rendered slide image previews were skipped because PyMuPDF could not render the PDF pages.")
    return pdf, cover, slide_images, warnings


def main() -> int:
    payload = _load_payload()
    root = Path(payload["root"]).resolve()
    user_id = str(payload.get("user_id") or "desktop")
    agent_id = str(payload.get("agent_id") or "ppt")
    session_id = str(payload.get("session_id") or f"session-{int(time.time())}")
    user_message = str(payload.get("user_message") or "")
    assistant_answer = str(payload.get("assistant_answer") or "")
    selected_style = str(payload.get("selected_style") or "general")
    selected_template = str(payload.get("selected_template") or "none")
    source_image_paths = _safe_paths(payload.get("source_image_paths") or [])
    pre_generated_image_paths = _safe_slide_image_map(payload.get("pre_generated_image_paths") or {})
    host_imagegen_errors = [str(item) for item in (payload.get("host_imagegen_errors") or []) if str(item).strip()]
    include_notes_artifact = bool(payload.get("include_notes_artifact"))
    enable_imagegen = bool(payload.get("enable_imagegen", False))
    minimum_content_images = max(0, int(payload.get("minimum_content_images", 1) or 0))

    _emit_progress("正在解析页面表和 PPT 风格", phase="parse", phase_current=0, phase_total=1)
    specs = parse_slide_specs(user_message, assistant_answer)
    if not specs:
        raise ValueError("未能从 agent 回答中解析出 PPT 页面表。")
    _emit_progress(
        f"页面计划已解析，共 {len(specs)} 页",
        phase="parse",
        current_slide=0,
        total_slides=len(specs),
        phase_current=1,
        phase_total=1,
    )

    _emit_progress(
        "正在准备附件素材、页面配图和可编辑渲染",
        phase="image",
        current_slide=0,
        total_slides=len(specs),
        phase_current=0,
        phase_total=0,
    )
    deck_path, notes_path, qa_warnings, style, template = render_styled_ppt_artifact(
        root=root,
        user_id=user_id,
        agent_id=agent_id,
        session_id=session_id,
        user_message=user_message,
        assistant_answer=assistant_answer,
        selected_style=selected_style,
        selected_template=selected_template,
        source_image_paths=source_image_paths,
        pre_generated_image_paths=pre_generated_image_paths,
        host_imagegen_errors=host_imagegen_errors,
        enable_imagegen=enable_imagegen,
        minimum_content_images=minimum_content_images,
        on_progress=lambda progress: _emit_progress(
            str(progress.get("message") or "正在制作 PPT"),
            **{key: value for key, value in progress.items() if key != "message"},
        ),
    )
    output_dir = deck_path.parent

    _emit_progress(
        "页面制作和自检已完成，正在生成 PPT 预览",
        phase="preview",
        current_slide=len(specs),
        total_slides=len(specs),
        phase_current=0,
        phase_total=1,
    )
    pdf_path, cover_path, slide_image_paths, preview_warnings = _export_previews(deck_path, output_dir)
    _emit_progress(
        "PPTX 与页面预览已全部生成",
        phase="preview",
        current_slide=len(specs),
        total_slides=len(specs),
        phase_current=1,
        phase_total=1,
    )
    preview_warnings = list(dict.fromkeys([*qa_warnings, *preview_warnings]))
    if cover_path is None:
        cover_path = _create_fallback_cover(
            output_dir=output_dir,
            title=specs[0].title if specs else "PPT 文件已生成",
            subtitle=(specs[0].message or specs[0].visual) if specs else user_message,
            style_id=style.style_id,
            style_label=style.label,
            template_id=template.template_id,
            template_label=template.label,
            slide_count=len(specs),
        )

    if not include_notes_artifact:
        try:
            notes_path.unlink(missing_ok=True)
        except OSError:
            pass

    result = {
        "deck": deck_path,
        "notes": notes_path if include_notes_artifact else None,
        "pdf": pdf_path,
        "cover": cover_path,
        "slide_images": slide_image_paths,
        "preview_render_mode": "office" if pdf_path else "fallback",
        "slide_count": len(specs),
        "style_id": style.style_id,
        "style_label": style.label,
        "template": template.template_id,
        "template_label": template.label,
        "source_visual_count": len(source_image_paths),
        "preview_warnings": preview_warnings,
        "preview": {
            "kind": "ppt",
            "title": specs[0].title if specs else "PPT 文件已生成",
            "subtitle": (specs[0].message or specs[0].visual or user_message) if specs else user_message,
            "notes_excerpt": "\n".join(f"{index + 1}. {spec.title}" for index, spec in enumerate(specs[:5])),
        },
    }
    if not _append_protocol_file("--result-file", result):
        print(json.dumps(result, ensure_ascii=False, default=_json_default), flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        error = {"type": "error", "message": str(exc), "traceback": traceback.format_exc()}
        if not _append_protocol_file("--progress-file", error):
            print(json.dumps(error, ensure_ascii=False), file=sys.stderr, flush=True)
        raise
