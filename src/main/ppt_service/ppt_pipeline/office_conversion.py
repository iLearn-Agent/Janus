from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

TEMPLATE_CHROME_RENDER_TIMEOUT_SECONDS = 60
POWERPOINT_COM_RENDER_TIMEOUT_SECONDS = int(os.environ.get("JANUS_PPT_COM_TIMEOUT_SECONDS", "90"))

def _truthy_env(value: str | None, *, default: bool = True) -> bool:
    if value is None or value == "":
        return default
    return value.strip().lower() not in {"0", "false", "no", "off"}


def _convert_powerpoint_to_pdf_powershell_windows(
    root: Path,
    source_path: Path,
    target_path: Path,
    *,
    timeout_seconds: int,
) -> tuple[Path | None, str | None]:
    powershell = shutil.which("powershell.exe") or shutil.which("powershell")
    if not powershell:
        return None, "PowerShell is unavailable."
    script = r'''
param(
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][string]$Target
)
$ErrorActionPreference = "Stop"
$errors = New-Object System.Collections.Generic.List[string]
$progIds = @("PowerPoint.Application", "KWPP.Application", "KWPP.Application.12")
foreach ($progId in $progIds) {
  $presentation = $null
  $app = $null
  try {
    $app = New-Object -ComObject $progId
    $presentation = $app.Presentations.Open($Source, $true, $false, $false)
    try {
      $presentation.SaveAs($Target, 32)
    } catch {
      if ($presentation.PSObject.Methods.Name -contains "ExportAsFixedFormat") {
        $presentation.ExportAsFixedFormat($Target, 2)
      } else {
        throw
      }
    }
    if (Test-Path -LiteralPath $Target) {
      exit 0
    }
    throw "$progId did not create the PDF target."
  } catch {
    $errors.Add("$progId`: $($_.Exception.Message)")
    Remove-Item -LiteralPath $Target -Force -ErrorAction SilentlyContinue
  } finally {
    if ($null -ne $presentation) {
      try { $presentation.Close() } catch {}
      try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation) } catch {}
    }
    if ($null -ne $app) {
      try { $app.Quit() } catch {}
      try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch {}
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
  }
}
throw ($errors -join "; ")
'''
    with tempfile.TemporaryDirectory(prefix="opl-ppt-powershell-") as temp:
        script_path = Path(temp) / "export-ppt-preview.ps1"
        script_path.write_text(script, encoding="utf-8-sig")
        try:
            result = subprocess.run(
                [
                    powershell,
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Sta",
                    "-File",
                    str(script_path),
                    "-Source",
                    str(source_path),
                    "-Target",
                    str(target_path),
                ],
                cwd=str(root),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout_seconds,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return None, f"PowerShell PowerPoint export timed out after {timeout_seconds}s."
    if target_path.is_file() and target_path.stat().st_size > 0:
        return target_path, None
    details = (result.stderr or result.stdout or "PowerShell PowerPoint export failed").strip()
    return None, details[-500:]


def _convert_powerpoint_to_pdf_windows(
    root: Path,
    source_path: Path,
    target_path: Path,
    *,
    timeout_seconds: int | None = None,
) -> tuple[Path | None, str | None]:
    """Use PowerPoint COM in a child process so a slow Office export cannot hang rendering."""
    if os.name != "nt":
        return None, "PowerPoint COM export is only available on Windows."
    if not _truthy_env(os.environ.get("JANUS_PPT_COM_EXPORT"), default=True):
        return None, "PowerPoint COM export is disabled by JANUS_PPT_COM_EXPORT."
    target_path.parent.mkdir(parents=True, exist_ok=True)
    if target_path.exists():
        try:
            target_path.unlink()
        except Exception:
            pass
    source_for_com = source_path
    temp_dir: tempfile.TemporaryDirectory[str] | None = None
    try:
        str(source_path).encode("ascii")
    except UnicodeEncodeError:
        temp_dir = tempfile.TemporaryDirectory(prefix="opl-ppt-com-path-")
        source_for_com = Path(temp_dir.name) / f"source{source_path.suffix or '.pptx'}"
        shutil.copyfile(source_path, source_for_com)
    script = r'''
from __future__ import annotations

import json
import sys
from pathlib import Path

source = Path(sys.argv[1]).resolve()
target = Path(sys.argv[2]).resolve()

presentation = None
app = None
try:
    import pythoncom  # type: ignore
    import win32com.client  # type: ignore

    pythoncom.CoInitialize()
    app = win32com.client.DispatchEx("PowerPoint.Application")
    presentation = app.Presentations.Open(str(source), WithWindow=False)
    presentation.SaveAs(str(target), 32)
    ok = target.is_file() and target.stat().st_size > 0
    print(json.dumps({"ok": ok, "target": str(target)}, ensure_ascii=False))
except Exception as exc:
    print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
    raise
finally:
    try:
        if presentation is not None:
            presentation.Close()
    except Exception:
        pass
    try:
        if app is not None:
            app.Quit()
    except Exception:
        pass
    try:
        pythoncom.CoUninitialize()  # type: ignore[name-defined]
    except Exception:
        pass
'''
    timeout = timeout_seconds or POWERPOINT_COM_RENDER_TIMEOUT_SECONDS
    pywin32_error = ""
    try:
        try:
            result = subprocess.run(
                [sys.executable, "-c", script, str(source_for_com), str(target_path)],
                cwd=str(root),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                check=False,
            )
            pywin32_error = (result.stderr or result.stdout or "PowerPoint COM export failed").strip()[-500:]
        except subprocess.TimeoutExpired:
            pywin32_error = f"PowerPoint COM export timed out after {timeout}s."
        if target_path.is_file() and target_path.stat().st_size > 0:
            return target_path, None
        target_path.unlink(missing_ok=True)
        powershell_pdf, powershell_error = _convert_powerpoint_to_pdf_powershell_windows(
            root,
            source_for_com,
            target_path,
            timeout_seconds=timeout,
        )
        if powershell_pdf is not None:
            return powershell_pdf, None
        combined = f"pywin32: {pywin32_error}; PowerShell: {powershell_error or 'failed'}"
        return None, combined[-1000:]
    finally:
        if temp_dir is not None:
            temp_dir.cleanup()



__all__ = [
    "_convert_powerpoint_to_pdf_powershell_windows",
    "_convert_powerpoint_to_pdf_windows",
    "_truthy_env",
]
