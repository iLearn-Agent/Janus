from __future__ import annotations

import re
from typing import Any

def _display(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, dict):
        return "\n".join(f"{key}：{_display(item)}" for key, item in value.items())
    if isinstance(value, list):
        return "\n".join(_display(item) for item in value)
    return str(value).strip()

def _message_points(value: str, limit: int = 8) -> list[str]:
    raw = str(value or "").replace("<br>", "\n").replace("<br/>", "\n")
    parts = re.split(r"\s*[•·]\s*|\n+|(?<=[。；;])\s*", raw)
    result: list[str] = []
    for part in parts:
        clean = re.sub(r"^[\-–—\d.、)）\s]+", "", part).strip(" ，,。；;：:")
        if clean and clean not in result:
            result.append(clean)
        if len(result) >= limit:
            break
    return result


def _payload_points(payload: dict[str, Any], limit: int = 12) -> list[str]:
    structured = payload.get("points")
    if isinstance(structured, list):
        values = [_display(item) for item in structured if _display(item)]
        if values:
            return values[:limit]
    return _message_points(str(payload.get("message") or ""), limit)


def _payload_numbers(payload: dict[str, Any], limit: int = 6) -> list[str]:
    values = payload.get("numbers")
    if isinstance(values, list):
        result = [_display(item) for item in values if _display(item)]
        if result:
            return result[:limit]
    raw = f"{payload.get('message', '')} {payload.get('visual', '')}"
    found = re.findall(r"(?:[+\-]?[0-9]+(?:\.[0-9]+)?\s*(?:%|ms|s|x|倍|万|亿|项|个|组|类|页)?)", raw, re.IGNORECASE)
    return list(dict.fromkeys(value.strip() for value in found if value.strip()))[:limit]


def _structured_list(payload: dict[str, Any], key: str) -> list[Any]:
    value = payload.get(key)
    return value if isinstance(value, list) else []


def _item_parts(item: Any) -> tuple[str, str]:
    if isinstance(item, dict):
        title = _display(
            item.get("label")
            or item.get("title")
            or item.get("group")
            or item.get("risk")
            or item.get("name")
        )
        detail_value = (
            item.get("detail")
            or item.get("description")
            or item.get("note")
            or item.get("points")
            or item.get("metrics")
            or item.get("impact")
            or item.get("content")
        )
        detail = _display(detail_value)
        mitigation = _display(item.get("mitigation") or item.get("action"))
        if mitigation:
            detail = "\n".join(part for part in [detail, mitigation] if part)
        return title, detail
    text = _display(item)
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return (lines[0], "\n".join(lines[1:])) if lines else ("", "")


def _compact_node_label(value: str) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    text = re.sub(r"^(?:label|标签)\s*[：:]\s*", "", text, flags=re.IGNORECASE)
    limit = 18 if re.search(r"[\u3400-\u9fff]", text) else 30
    if len(text) <= limit:
        return text
    words = text.split()
    if len(words) > 1:
        result: list[str] = []
        for word in words:
            candidate = " ".join([*result, word])
            if result and len(candidate) > limit:
                break
            result.append(word)
        if result:
            return " ".join(result)
    return text[: max(1, limit - 1)].rstrip() + "…"


def _compact_supporting_text(value: str, limit: int = 48) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if len(text) <= limit:
        return text
    words = text.split()
    result: list[str] = []
    for word in words:
        candidate = " ".join([*result, word])
        if result and len(candidate) > max(8, limit - 1):
            break
        result.append(word)
    compact = " ".join(result).rstrip(" ,.;:，。；：")
    return (compact or text[: max(1, limit - 1)].rstrip()) + "…"


__all__ = [
    "_compact_node_label",
    "_compact_supporting_text",
    "_display",
    "_item_parts",
    "_message_points",
    "_payload_numbers",
    "_payload_points",
    "_structured_list",
]
