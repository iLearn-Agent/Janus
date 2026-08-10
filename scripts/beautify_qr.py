#!/usr/bin/env python3
"""Recompose a QR-code screenshot as a clean, square community poster.

Example:
    python3 scripts/beautify_qr.py input.jpg output.png

Pillow is the only third-party dependency:
    python3 -m pip install Pillow
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageDraw, ImageFont, ImageOps


DEFAULT_FONT_CANDIDATES = (
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "DejaVuSans-Bold.ttf",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Turn a QR screenshot into a square iLearn-Agent poster."
    )
    parser.add_argument("input", type=Path, help="source screenshot")
    parser.add_argument("output", type=Path, help="output PNG path")
    parser.add_argument("--size", type=int, default=1200, help="square size in pixels")
    parser.add_argument("--line-one", default="iLearn-Agent", help="first title line")
    parser.add_argument("--line-two", default="Community", help="second title line")
    parser.add_argument("--font", type=Path, help="path to a bold TrueType/OpenType font")
    parser.add_argument(
        "--threshold",
        type=int,
        default=150,
        help="pixels darker than this value are used for QR detection",
    )
    parser.add_argument(
        "--crop",
        type=int,
        nargs=4,
        metavar=("LEFT", "TOP", "RIGHT", "BOTTOM"),
        help="manual QR bounds, including the black modules but not the quiet zone",
    )
    parser.add_argument(
        "--overwrite", action="store_true", help="allow replacing an existing output file"
    )
    return parser.parse_args()


def find_font(explicit_font: Path | None, candidates: Iterable[str]) -> str:
    if explicit_font:
        if not explicit_font.is_file():
            raise FileNotFoundError(f"Font not found: {explicit_font}")
        return str(explicit_font)

    for candidate in candidates:
        try:
            ImageFont.truetype(candidate, 24)
            return candidate
        except OSError:
            continue

    raise FileNotFoundError("No suitable bold font found. Pass one with --font.")


def find_qr_bounds(image: Image.Image, threshold: int) -> tuple[int, int, int, int]:
    """Find the dark square in the lower part of this screenshot-style image."""
    width, height = image.size
    search_top = int(height * 0.30)
    gray = image.convert("L").crop((0, search_top, width, height))
    dark_mask = gray.point(lambda value: 255 if value < threshold else 0)
    local_bounds = dark_mask.getbbox()

    if local_bounds is None:
        raise ValueError("Could not find dark QR pixels; use --crop to set the bounds.")

    left, top, right, bottom = local_bounds
    bounds = (left, top + search_top, right, bottom + search_top)
    qr_width = right - left
    qr_height = bottom - top

    if min(qr_width, qr_height) < min(width, height) * 0.25:
        raise ValueError("Detected region is too small to be the QR code; use --crop.")
    if not 0.88 <= qr_width / qr_height <= 1.12:
        raise ValueError("Detected region is not square enough to be a QR code; use --crop.")

    return bounds


def fit_font(font_path: str, text: str, preferred_size: int, max_width: int) -> ImageFont.FreeTypeFont:
    size = preferred_size
    while size >= 18:
        font = ImageFont.truetype(font_path, size)
        left, _, right, _ = font.getbbox(text)
        if right - left <= max_width:
            return font
        size -= 2
    raise ValueError(f"Title is too long to fit: {text!r}")


def centered_text(
    draw: ImageDraw.ImageDraw,
    canvas_width: int,
    y: int,
    text: str,
    font: ImageFont.FreeTypeFont,
    fill: str,
) -> None:
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    x = (canvas_width - (right - left)) // 2 - left
    draw.text((x, y - top), text, font=font, fill=fill)


def compose(
    source: Image.Image,
    qr_bounds: tuple[int, int, int, int],
    size: int,
    line_one: str,
    line_two: str,
    font_path: str,
) -> Image.Image:
    if size < 600:
        raise ValueError("--size must be at least 600 pixels.")

    qr = source.crop(qr_bounds).convert("RGB")
    max_qr_size = int(size * 0.63)
    if max(qr.size) > max_qr_size:
        scale = min(max_qr_size / qr.width, max_qr_size / qr.height)
        resized = (max(1, round(qr.width * scale)), max(1, round(qr.height * scale)))
        qr = qr.resize(resized, Image.Resampling.NEAREST)

    background = "#F6F8F7"
    ink = "#171A19"
    accent = "#23845B"
    canvas = Image.new("RGB", (size, size), background)
    draw = ImageDraw.Draw(canvas)

    title_font = fit_font(font_path, line_one, round(size * 0.062), round(size * 0.88))
    subtitle_font = fit_font(font_path, line_two, round(size * 0.043), round(size * 0.88))
    centered_text(draw, size, round(size * 0.040), line_one, title_font, ink)
    centered_text(draw, size, round(size * 0.122), line_two, subtitle_font, accent)

    divider_width = round(size * 0.060)
    divider_height = max(4, round(size * 0.005))
    divider_y = round(size * 0.205)
    divider_x = (size - divider_width) // 2
    draw.rounded_rectangle(
        (divider_x, divider_y, divider_x + divider_width, divider_y + divider_height),
        radius=divider_height // 2,
        fill=accent,
    )

    # Four source modules are about 4% of the canvas in this layout.
    quiet_zone = round(size * 0.040)
    panel_width = qr.width + quiet_zone * 2
    panel_height = qr.height + quiet_zone * 2
    panel_left = (size - panel_width) // 2
    panel_top = round(size * 0.250)
    panel_bottom = panel_top + panel_height
    if panel_bottom > size - round(size * 0.035):
        raise ValueError("QR code does not fit the requested canvas size.")

    draw.rectangle(
        (panel_left, panel_top, panel_left + panel_width, panel_bottom),
        fill="#FFFFFF",
        outline="#E4E8E6",
        width=max(1, round(size * 0.001)),
    )
    canvas.paste(qr, (panel_left + quiet_zone, panel_top + quiet_zone))
    return canvas


def main() -> None:
    args = parse_args()
    if not args.input.is_file():
        raise FileNotFoundError(f"Input image not found: {args.input}")
    if args.output.exists() and not args.overwrite:
        raise FileExistsError(f"Output already exists: {args.output} (use --overwrite)")
    if not 1 <= args.threshold <= 254:
        raise ValueError("--threshold must be between 1 and 254.")

    source = ImageOps.exif_transpose(Image.open(args.input)).convert("RGB")
    qr_bounds = tuple(args.crop) if args.crop else find_qr_bounds(source, args.threshold)
    font_path = find_font(args.font, DEFAULT_FONT_CANDIDATES)
    result = compose(
        source,
        qr_bounds,
        args.size,
        args.line_one,
        args.line_two,
        font_path,
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    result.save(args.output, format="PNG", optimize=True, dpi=(300, 300))
    print(f"Saved {result.width}x{result.height} image to {args.output}")
    print(f"QR bounds: {qr_bounds}")


if __name__ == "__main__":
    main()
