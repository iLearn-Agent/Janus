from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from html import escape as xml_escape
from pathlib import Path
import re
import textwrap
import zipfile
from typing import Any


@dataclass(slots=True)
class SlideSpec:
    title: str
    message: str = ""
    visual: str = ""
    speaker_note: str = ""
    time: str = ""
    content_spec: dict[str, Any] | None = None


def should_render_ppt_artifact(user_message: str, assistant_answer: str) -> bool:
    text = f"{user_message}\n{assistant_answer}".lower()
    text_only_markers = (
        "final product format: markdown",
        "final product format: json",
        "final product format: yaml",
        "final product format: csv",
        "text only",
        "plain text",
        "markdown table",
    )
    if any(marker in text for marker in text_only_markers):
        return False
    return any(marker in text for marker in ("ppt", "slide", "slides", "deck", "presentation", "group meeting", "pitch", "defense"))


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
    return (value[:80].rstrip(" .-_，,。") or fallback)


def _parse_markdown_table(answer: str) -> list[SlideSpec]:
    lines = [line.rstrip() for line in answer.splitlines() if line.strip()]
    table_lines = [line for line in lines if line.lstrip().startswith("|") and line.rstrip().endswith("|")]
    if len(table_lines) < 2:
        return []
    header = [cell.strip().lower() for cell in table_lines[0].strip("|").split("|")]
    rows: list[SlideSpec] = []
    for line in table_lines[2:]:
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if len(cells) != len(header):
            continue
        data = dict(zip(header, cells, strict=False))
        rows.append(
            SlideSpec(
                title=data.get("title") or data.get("slide") or f"Slide {len(rows) + 1}",
                message=data.get("message", ""),
                visual=data.get("visual", ""),
                speaker_note=data.get("speakernote") or data.get("speaker_note") or "",
                time=data.get("time", ""),
            )
        )
    return rows


def _parse_fallback(answer: str, user_message: str) -> list[SlideSpec]:
    lines = [line.strip() for line in answer.splitlines() if line.strip()]
    headings = [line[1:].strip() for line in lines if line.startswith("#")]
    if headings:
        specs = [SlideSpec(title=headings[0], message=user_message)]
        for idx, heading in enumerate(headings[1:], start=2):
            specs.append(SlideSpec(title=heading, message=f"Section {idx}"))
        return specs
    chunks = textwrap.wrap(re.sub(r"\s+", " ", answer).strip(), width=120) or [user_message]
    return [SlideSpec(title="Summary", message=chunk) for chunk in chunks[:5]]


def parse_slide_specs(user_message: str, assistant_answer: str) -> list[SlideSpec]:
    specs = _parse_markdown_table(assistant_answer)
    if specs:
        return specs
    return _parse_fallback(assistant_answer, user_message)


def _xml_paragraph(text: str, *, size: int = 2400, bold: bool = False) -> str:
    text = xml_escape(text)
    return (
        "<a:p>"
        "<a:pPr/>"
        f'<a:r><a:rPr lang="en-US" sz="{size}" b="{1 if bold else 0}"/><a:t>{text}</a:t></a:r>'
        "<a:endParaRPr lang=\"en-US\"/>"
        "</a:p>"
    )


def _xml_text_body(title: str, body: str, visual: str, speaker_note: str, time: str) -> str:
    body_parts = []
    if body:
        body_parts.append(_xml_paragraph(body, size=2200))
    if visual:
        body_parts.append(_xml_paragraph(f"Visual: {visual}", size=1800))
    if speaker_note:
        body_parts.append(_xml_paragraph(f"Note: {speaker_note}", size=1800))
    if time:
        body_parts.append(_xml_paragraph(f"Time: {time}", size=1800))
    if not body_parts:
        body_parts.append(_xml_paragraph(" ", size=2000))
    paragraphs = "".join(body_parts)
    return f"""
<p:sp>
  <p:nvSpPr>
    <p:cNvPr id="2" name="Title 1"/>
    <p:cNvSpPr txBox="1"/>
    <p:nvPr/>
  </p:nvSpPr>
  <p:spPr/>
  <p:txBody>
    <a:bodyPr wrap="square"/>
    <a:lstStyle/>
    {_xml_paragraph(title, size=3200, bold=True)}
  </p:txBody>
</p:sp>
<p:sp>
  <p:nvSpPr>
    <p:cNvPr id="3" name="Content 1"/>
    <p:cNvSpPr txBox="1"/>
    <p:nvPr/>
  </p:nvSpPr>
  <p:spPr/>
  <p:txBody>
    <a:bodyPr wrap="square"/>
    <a:lstStyle/>
    {paragraphs}
  </p:txBody>
</p:sp>
""".strip()


def _slide_xml(spec: SlideSpec) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr/>
      {_xml_text_body(spec.title, spec.message, spec.visual, spec.speaker_note, spec.time)}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr>
    <a:masterClrMapping/>
  </p:clrMapOvr>
</p:sld>
"""


def _write_file(zf: zipfile.ZipFile, path: str, text: str) -> None:
    zf.writestr(path, text.encode("utf-8"))


def _deck_name(specs: list[SlideSpec], user_message: str) -> str:
    base = specs[0].title if specs else user_message
    return _safe_deck_filename_stem(base)


def render_ppt_artifact(
    *,
    root: Path,
    user_id: str,
    agent_id: str,
    session_id: str,
    user_message: str,
    assistant_answer: str,
) -> tuple[Path, Path]:
    specs = parse_slide_specs(user_message, assistant_answer)
    name = _deck_name(specs, user_message)
    output_dir = root / "outputs" / "ppt_department" / f"{session_id}-{name}"
    output_dir.mkdir(parents=True, exist_ok=True)
    deck_path = output_dir / f"{name}.pptx"
    notes_path = output_dir / "speaker_notes.md"

    if len(specs) == 1 and not specs[0].message:
        specs[0].message = user_message

    created = datetime.now(timezone.utc).isoformat()
    with zipfile.ZipFile(deck_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        _write_file(zf, "[Content_Types].xml", f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  {"".join(f'<Override PartName="/ppt/slides/slide{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' for i in range(1, len(specs) + 1))}
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>
""")
        _write_file(zf, "_rels/.rels", """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>
""")
        _write_file(zf, "docProps/core.xml", f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:dcmitype="http://purl.org/dc/dcmitype/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>{xml_escape(specs[0].title if specs else name)}</dc:title>
  <dc:creator>OPL</dc:creator>
  <cp:lastModifiedBy>OPL</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">{created}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">{created}</dcterms:modified>
</cp:coreProperties>
""")
        _write_file(zf, "docProps/app.xml", f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
  xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>OPL</Application>
  <Slides>{len(specs)}</Slides>
  <PresentationFormat>On-screen Show (16:9)</PresentationFormat>
  <Notes>0</Notes>
  <HiddenSlides>0</HiddenSlides>
  <MMClips>0</MMClips>
  <ScaleCrop>false</ScaleCrop>
  <HeadingPairs>
    <vt:vector size="2" baseType="variant">
      <vt:variant><vt:lpstr>Slides</vt:lpstr></vt:variant>
      <vt:variant><vt:i4>{len(specs)}</vt:i4></vt:variant>
    </vt:vector>
  </HeadingPairs>
  <TitlesOfParts>
    <vt:vector size="{len(specs)}" baseType="lpstr">
      {''.join(f'<vt:lpstr>{xml_escape(spec.title)}</vt:lpstr>' for spec in specs)}
    </vt:vector>
  </TitlesOfParts>
  <Company>OPL</Company>
  <LinksUpToDate>false</LinksUpToDate>
  <SharedDoc>false</SharedDoc>
  <HyperlinksChanged>false</HyperlinksChanged>
  <AppVersion>1.0</AppVersion>
</Properties>
""")
        _write_file(zf, "ppt/presentation.xml", f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst>
    <p:sldMasterId id="2147483648" r:id="rId1"/>
  </p:sldMasterIdLst>
  <p:sldIdLst>
    {''.join(f'<p:sldId id="{256 + i}" r:id="rId{2 + i}"/>' for i in range(len(specs)))}
  </p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>
""")
        _write_file(zf, "ppt/_rels/presentation.xml.rels", f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  {''.join(f'<Relationship Id="rId{2 + i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{i + 1}.xml"/>' for i in range(len(specs)))}
</Relationships>
""")
        _write_file(zf, "ppt/slideMasters/slideMaster1.xml", """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr/>
    </p:spTree>
  </p:cSld>
  <p:sldLayoutIdLst>
    <p:sldLayoutId id="1" r:id="rId1"/>
  </p:sldLayoutIdLst>
  <p:txStyles/>
  <p:clrMapOvr>
    <a:masterClrMapping/>
  </p:clrMapOvr>
</p:sldMaster>
""")
        _write_file(zf, "ppt/slideMasters/_rels/slideMaster1.xml.rels", """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>
""")
        _write_file(zf, "ppt/slideLayouts/slideLayout1.xml", """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  type="title">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr/>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr>
    <a:masterClrMapping/>
  </p:clrMapOvr>
</p:sldLayout>
""")
        _write_file(zf, "ppt/slideLayouts/_rels/slideLayout1.xml.rels", """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>
""")
        _write_file(zf, "ppt/theme/theme1.xml", """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="OPL Theme">
  <a:themeElements>
    <a:clrScheme name="OPL">
      <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="1F2937"/></a:dk2>
      <a:lt2><a:srgbClr val="F8FAFC"/></a:lt2>
      <a:accent1><a:srgbClr val="2563EB"/></a:accent1>
      <a:accent2><a:srgbClr val="0EA5E9"/></a:accent2>
      <a:accent3><a:srgbClr val="10B981"/></a:accent3>
      <a:accent4><a:srgbClr val="F59E0B"/></a:accent4>
      <a:accent5><a:srgbClr val="EF4444"/></a:accent5>
      <a:accent6><a:srgbClr val="8B5CF6"/></a:accent6>
      <a:hlink><a:srgbClr val="2563EB"/></a:hlink>
      <a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="OPL">
      <a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont>
      <a:minorFont><a:latin typeface="Aptos"/></a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="OPL">
      <a:fillStyleLst/>
      <a:lnStyleLst/>
      <a:effectStyleLst/>
      <a:bgFillStyleLst/>
    </a:fmtScheme>
  </a:themeElements>
</a:theme>
""")
        for idx, spec in enumerate(specs, start=1):
            _write_file(zf, f"ppt/slides/slide{idx}.xml", _slide_xml(spec))
            _write_file(zf, f"ppt/slides/_rels/slide{idx}.xml.rels", """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>
""")

    notes_lines = [
        f"# Speaker Notes for {name}",
        f"- user: {user_id}",
        f"- agent: {agent_id}",
        f"- session: {session_id}",
        "",
    ]
    for idx, spec in enumerate(specs, start=1):
        notes_lines.append(f"## Slide {idx}: {spec.title}")
        if spec.speaker_note:
            notes_lines.append(spec.speaker_note)
        elif spec.message:
            notes_lines.append(spec.message)
        else:
            notes_lines.append("(no note)")
        notes_lines.append("")
    notes_path.write_text("\n".join(notes_lines).rstrip() + "\n", encoding="utf-8")
    return deck_path, notes_path
