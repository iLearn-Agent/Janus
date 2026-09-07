from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Callable

try:
    from PIL import Image
except Exception:
    Image = None

from janus_lab.codex_runner import load_auth_env
from janus_lab.paths import tmp_dir
from janus_lab.ppt_renderer import SlideSpec
from ppt_pipeline.image_routing import _selected_image_slide_indices, _slide_image_prompt
from ppt_pipeline.style_catalog import PPTStyleDecision, PPTTemplateDecision, TEMPLATE_RENDER_PROFILES, resolve_ppt_template

IMAGEGEN_SCRIPT = Path.home() / ".codex" / "skills" / ".system" / "imagegen" / "scripts" / "image_gen.py"
PPTProgressCallback = Callable[[dict[str, Any]], None]


def _report_ppt_progress(on_progress: PPTProgressCallback | None, payload: dict[str, Any]) -> None:
    if on_progress is None:
        return
    try:
        on_progress(payload)
    except Exception:
        pass


def _ppt_imagegen_env(root: Path) -> dict[str, str]:
    env = os.environ.copy()
    env.update(load_auth_env(root))
    if not env.get("OPENAI_BASE_URL"):
        env["OPENAI_BASE_URL"] = env.get("OPENAI_IMAGE_BASE_URL") or _ppt_openai_api_base(root)
    return env


def _ppt_openai_api_base(root: Path) -> str:
    auth_env = load_auth_env(root)
    env_base = os.getenv(
        "OPENAI_IMAGE_BASE_URL",
        os.getenv(
            "JANUS_IMAGE_API_BASE",
            os.getenv(
                "JANUS_OPENAI_BASE_URL",
                os.getenv("OPENAI_BASE_URL", auth_env.get("OPENAI_IMAGE_BASE_URL", auth_env.get("OPENAI_BASE_URL", ""))),
            ),
        ),
    ).strip()
    if env_base:
        return env_base.rstrip("/")
    config_path = root / "config" / "codex" / "config.toml"
    try:
        config = tomllib.loads(config_path.read_text(encoding="utf-8"))
        provider_name = str(config.get("model_provider") or "custom")
        providers = config.get("model_providers") if isinstance(config.get("model_providers"), dict) else {}
        provider = providers.get(provider_name) if isinstance(providers, dict) else None
        base_url = provider.get("base_url") if isinstance(provider, dict) else ""
        if isinstance(base_url, str) and base_url.strip():
            return base_url.strip().rstrip("/")
    except Exception:
        pass
    return "https://api.openai.com/v1"


def _ppt_image_bytes_from_response(response: dict[str, Any]) -> bytes:
    data = response.get("data")
    first = data[0] if isinstance(data, list) and data and isinstance(data[0], dict) else {}
    if isinstance(first.get("b64_json"), str) and first["b64_json"]:
        try:
            return base64.b64decode(first["b64_json"], validate=True)
        except binascii.Error as exc:
            raise RuntimeError("image API returned invalid base64 data") from exc
    if isinstance(first.get("url"), str) and first["url"]:
        with urllib.request.urlopen(first["url"], timeout=30) as response_url:
            return response_url.read()
    raise RuntimeError("image API did not return image data")


def _ppt_generate_image_direct(
    *,
    root: Path,
    prompt: str,
    out_path: Path,
    quality: str,
    size: str,
    env: dict[str, str],
) -> None:
    api_key = (env.get("OPENAI_IMAGE_API_KEY") or env.get("OPENAI_API_KEY") or "").strip()
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    payload: dict[str, Any] = {
        "model": os.getenv("JANUS_WEB_IMAGE_MODEL", "gpt-image-2"),
        "prompt": prompt,
        "size": size,
        "n": 1,
    }
    if quality and quality != "auto":
        payload["quality"] = quality
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{_ppt_openai_api_base(root)}/images/generations",
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    timeout = max(5, int(os.environ.get("JANUS_PPT_IMAGEGEN_TIMEOUT_SECONDS", "30")))
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read().decode("utf-8", errors="replace")
    parsed = json.loads(body)
    raw = _ppt_image_bytes_from_response(parsed)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(raw)


def _valid_generated_image(path: Path) -> bool:
    if not path.is_file() or path.stat().st_size <= 0:
        return False
    if Image is None:
        return True
    try:
        with Image.open(path) as image:
            image.verify()
        return True
    except Exception:
        return False


def _ppt_imagegen_cache_path(
    *,
    root: Path,
    prompt: str,
    model: str,
    quality: str,
    size: str,
) -> Path:
    cache_root = Path(
        os.environ.get(
            "JANUS_PPT_IMAGEGEN_CACHE_DIR",
            str(root / "data" / "preview_cache" / "ppt_imagegen"),
        )
    ).resolve()
    digest = hashlib.sha256(
        json.dumps(
            {
                "version": 1,
                "provider": _ppt_openai_api_base(root),
                "model": model,
                "quality": quality,
                "size": size,
                "prompt": prompt,
            },
            ensure_ascii=False,
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()
    return cache_root / digest[:2] / f"{digest}.png"


def _copy_generated_image(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.stem}-{uuid.uuid4().hex}{target.suffix}")
    try:
        shutil.copyfile(source, temporary)
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def _store_generated_image_cache(source: Path, cache_path: Path) -> None:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = cache_path.with_name(f".{cache_path.stem}-{uuid.uuid4().hex}{cache_path.suffix}")
    try:
        shutil.copyfile(source, temporary)
        if not _valid_generated_image(temporary):
            raise RuntimeError("generated image was empty or unreadable")
        temporary.replace(cache_path)
    finally:
        temporary.unlink(missing_ok=True)


def _generate_slide_image_job(
    *,
    root: Path,
    prompt: str,
    out_path: Path,
    cache_path: Path,
    quality: str,
    size: str,
    attempts: int,
    imagegen_env: dict[str, str],
    cache_enabled: bool = True,
    on_retry: Callable[[int, str], None] | None = None,
) -> tuple[bool, str, bool]:
    last_error = ""
    temporary = out_path.with_name(f".{out_path.stem}-generate-{uuid.uuid4().hex}{out_path.suffix}")
    try:
        for attempt in range(1, attempts + 1):
            if attempt > 1 and on_retry is not None:
                on_retry(attempt, last_error)
            try:
                _ppt_generate_image_direct(
                    root=root,
                    prompt=prompt,
                    out_path=temporary,
                    quality=quality,
                    size=size,
                    env=imagegen_env,
                )
                if _valid_generated_image(temporary):
                    if cache_enabled:
                        _store_generated_image_cache(temporary, cache_path)
                        _copy_generated_image(cache_path, out_path)
                    else:
                        temporary.replace(out_path)
                    return True, "", False
                last_error = "image API returned an empty or unreadable image"
            except Exception as exc:
                last_error = _compact_exception(exc)
            temporary.unlink(missing_ok=True)
            if attempt < attempts:
                time.sleep(min(8, 2 * attempt))

        script = _imagegen_script_path()
        if not script.exists():
            return False, f"gpt-image-2 failed ({last_error}); imagegen CLI not found: {script}", False
        if on_retry is not None:
            on_retry(attempts + 1, last_error)
        cmd = [
            sys.executable,
            str(script),
            "generate",
            "--prompt",
            prompt,
            "--size",
            size,
            "--quality",
            quality,
            "--out",
            str(temporary),
            "--force",
        ]
        fallback_timeout = max(10, int(os.environ.get("JANUS_PPT_IMAGEGEN_FALLBACK_TIMEOUT_SECONDS", "45")))
        try:
            completed = subprocess.run(
                cmd,
                cwd=str(root),
                env=imagegen_env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=False,
                timeout=fallback_timeout,
            )
        except subprocess.TimeoutExpired:
            return False, f"direct={last_error}; fallback image generator timed out after {fallback_timeout}s", True
        if completed.returncode == 0 and _valid_generated_image(temporary):
            if cache_enabled:
                _store_generated_image_cache(temporary, cache_path)
                _copy_generated_image(cache_path, out_path)
            else:
                temporary.replace(out_path)
            return True, "", True
        details = (completed.stderr or completed.stdout or "imagegen failed").strip()
        combined = f"direct={last_error}; cli_code={completed.returncode}; cli={details}"
        return False, combined, True
    finally:
        temporary.unlink(missing_ok=True)


def _compact_exception(exc: BaseException) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        detail = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(detail)
            message = parsed.get("error", {}).get("message") or parsed.get("message")
            if message:
                return f"HTTP {exc.code}: {message}"
        except Exception:
            pass
        return f"HTTP {exc.code}: {detail[:500]}"
    return f"{exc.__class__.__name__}: {str(exc)[:500]}"


def _enabled_imagegen(root: Path, enable_imagegen: bool | None) -> bool:
    if enable_imagegen is not None:
        return enable_imagegen
    if os.environ.get("JANUS_PPT_ENABLE_IMAGEGEN", "").strip() in {"0", "false", "False", "no"}:
        return False
    imagegen_env = _ppt_imagegen_env(root)
    return bool(imagegen_env.get("OPENAI_IMAGE_API_KEY") or imagegen_env.get("OPENAI_API_KEY"))


def _enabled_research(enable_research: bool | None) -> bool:
    if enable_research is not None:
        return enable_research
    if os.environ.get("JANUS_PPT_ENABLE_RESEARCH", "").strip() in {"0", "false", "False", "no"}:
        return False
    return True


def _imagegen_script_path() -> Path:
    codex_home = os.environ.get("CODEX_HOME")
    if codex_home:
        return Path(codex_home) / "skills" / ".system" / "imagegen" / "scripts" / "image_gen.py"
    return IMAGEGEN_SCRIPT




def _generate_slide_images(
    *,
    root: Path,
    session_id: str,
    specs: list[SlideSpec],
    style: PPTStyleDecision,
    enable_imagegen: bool | None,
    selected_template: str | None = None,
    reserved_image_indices: set[int] | None = None,
    minimum_images: int = 1,
    on_progress: PPTProgressCallback | None = None,
) -> tuple[dict[int, Path], list[str]]:
    if not _enabled_imagegen(root, enable_imagegen):
        return {}, []
    imagegen_env = _ppt_imagegen_env(root)
    if not (imagegen_env.get("OPENAI_IMAGE_API_KEY") or imagegen_env.get("OPENAI_API_KEY")):
        return {}, ["No image API key is configured; skipped gpt-image-2 image generation."]

    required_images = max(0, min(int(minimum_images or 0), len(specs)))
    max_images = max(required_images, int(os.environ.get("JANUS_PPT_IMAGEGEN_MAX", "2")))
    max_images = max(0, min(max_images, len(specs)))
    if max_images == 0:
        return {}, []
    selected_template_decision = resolve_ppt_template(root, selected_template)
    selected_profile = TEMPLATE_RENDER_PROFILES.get(selected_template_decision.template_id, {})
    include_cover = not bool(selected_template_decision.path and selected_profile.get("engine") == "slide_library")
    selected_indices = _selected_image_slide_indices(specs, max_images, include_cover=include_cover)
    if reserved_image_indices:
        selected_indices = [index for index in selected_indices if index not in reserved_image_indices]
    selected_indices = selected_indices[:max_images]
    if not selected_indices:
        return {}, []

    out_dir = root / "outputs" / "ppt_department" / session_id / "imagegen"
    out_dir.mkdir(parents=True, exist_ok=True)
    images: dict[int, Path] = {}
    errors: list[str] = []
    attempts = max(1, int(os.environ.get("JANUS_PPT_IMAGEGEN_ATTEMPTS", "1")))
    size = os.environ.get("JANUS_PPT_IMAGEGEN_SIZE", "1536x1024")
    quality = os.environ.get("JANUS_PPT_IMAGEGEN_QUALITY", "medium")
    model = os.environ.get("JANUS_WEB_IMAGE_MODEL", "gpt-image-2")
    cache_enabled = os.environ.get("JANUS_PPT_IMAGEGEN_CACHE", "1").strip().lower() not in {"0", "false", "no"}
    concurrency = max(1, int(os.environ.get("JANUS_PPT_IMAGEGEN_CONCURRENCY", "2")))
    concurrency = min(4, concurrency, len(selected_indices))
    jobs: list[dict[str, Any]] = []
    completed_count = 0
    cache_hits = 0
    progress_lock = threading.Lock()

    for index in selected_indices:
        spec = specs[index - 1]
        out_path = out_dir / f"slide-{index:02d}.png"
        prompt = _slide_image_prompt(spec, style)
        cache_path = _ppt_imagegen_cache_path(
            root=root,
            prompt=prompt,
            model=model,
            quality=quality,
            size=size,
        )
        if cache_enabled and _valid_generated_image(cache_path):
            _copy_generated_image(cache_path, out_path)
            images[index] = out_path
            completed_count += 1
            cache_hits += 1
            _report_ppt_progress(on_progress, {
                "phase": "image",
                "status": "cached",
                "cache_hit": True,
                "cache_hits": cache_hits,
                "concurrency": concurrency,
                "current_slide": index,
                "total_slides": len(specs),
                "phase_current": completed_count,
                "phase_total": len(selected_indices),
                "slide_title": spec.title or f"Slide {index}",
                "attempt": 1,
                "message": f"已复用第 {index}/{len(specs)} 页的缓存配图：{spec.title or f'Slide {index}'}",
            })
            continue
        if cache_path.exists():
            cache_path.unlink(missing_ok=True)
        jobs.append({
            "index": index,
            "spec": spec,
            "prompt": prompt,
            "out_path": out_path,
            "cache_path": cache_path,
        })

    if not jobs:
        return images, errors

    for job in jobs:
        index = int(job["index"])
        spec = job["spec"]
        _report_ppt_progress(on_progress, {
            "phase": "image",
            "status": "running",
            "cache_hit": False,
            "cache_hits": cache_hits,
            "concurrency": concurrency,
            "current_slide": index,
            "total_slides": len(specs),
            "phase_current": completed_count,
            "phase_total": len(selected_indices),
            "slide_title": spec.title or f"Slide {index}",
            "attempt": 1,
            "message": (
                f"正在并行生成第 {index}/{len(specs)} 页配图：{spec.title or f'Slide {index}'}"
                if concurrency > 1
                else f"正在生成第 {index}/{len(specs)} 页配图：{spec.title or f'Slide {index}'}"
            ),
        })

    def retry_progress(job: dict[str, Any], attempt_number: int, _last_error: str) -> None:
        with progress_lock:
            done = completed_count
            hits = cache_hits
        index = int(job["index"])
        spec = job["spec"]
        fallback = attempt_number > attempts
        _report_ppt_progress(on_progress, {
            "phase": "image",
            "status": "fallback" if fallback else "retrying",
            "cache_hit": False,
            "cache_hits": hits,
            "concurrency": concurrency,
            "current_slide": index,
            "total_slides": len(specs),
            "phase_current": done,
            "phase_total": len(selected_indices),
            "slide_title": spec.title or f"Slide {index}",
            "attempt": attempt_number,
            "message": (
                f"第 {index}/{len(specs)} 页配图正在切换备用生成器"
                if fallback
                else f"第 {index}/{len(specs)} 页配图正在进行第 {attempt_number} 次尝试"
            ),
        })

    with ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="ppt-imagegen") as executor:
        future_jobs = {
            executor.submit(
                _generate_slide_image_job,
                root=root,
                prompt=str(job["prompt"]),
                out_path=job["out_path"],
                cache_path=job["cache_path"],
                quality=quality,
                size=size,
                attempts=attempts,
                imagegen_env=imagegen_env,
                cache_enabled=cache_enabled,
                on_retry=lambda attempt_number, last_error, current_job=job: retry_progress(
                    current_job,
                    attempt_number,
                    last_error,
                ),
            ): job
            for job in jobs
        }
        for future in as_completed(future_jobs):
            job = future_jobs[future]
            index = int(job["index"])
            spec = job["spec"]
            try:
                succeeded, detail, used_fallback = future.result()
            except Exception as exc:
                succeeded, detail, used_fallback = False, _compact_exception(exc), False
            with progress_lock:
                completed_count += 1
                done = completed_count
                hits = cache_hits
            if succeeded and _valid_generated_image(job["out_path"]):
                images[index] = job["out_path"]
            else:
                errors.append(f"Slide {index}: imagegen failed: {detail}"[:2200])
            _report_ppt_progress(on_progress, {
                "phase": "image",
                "status": "completed" if succeeded else "failed",
                "cache_hit": False,
                "cache_hits": hits,
                "concurrency": concurrency,
                "current_slide": index,
                "total_slides": len(specs),
                "phase_current": done,
                "phase_total": len(selected_indices),
                "slide_title": spec.title or f"Slide {index}",
                "attempt": attempts + 1 if used_fallback else 1,
                "message": (
                    f"第 {index}/{len(specs)} 页配图生成完成：{spec.title or f'Slide {index}'}"
                    if succeeded
                    else f"第 {index}/{len(specs)} 页配图生成失败，将继续制作可编辑页面"
                ),
            })
    return images, errors



__all__ = [
    "_ppt_imagegen_env",
    "_ppt_openai_api_base",
    "_ppt_image_bytes_from_response",
    "_ppt_generate_image_direct",
    "_valid_generated_image",
    "_ppt_imagegen_cache_path",
    "_copy_generated_image",
    "_store_generated_image_cache",
    "_generate_slide_image_job",
    "_compact_exception",
    "_enabled_imagegen",
    "_enabled_research",
    "_imagegen_script_path",
    "_generate_slide_images",
]
