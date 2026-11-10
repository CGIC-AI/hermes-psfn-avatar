"""FastAPI backend for hermes-psfn-avatar, mounted at ``/api/plugins/hermes-psfn-avatar/``.

Shared by both Hermes Desktop (via ``ctx.rest``) and the Hermes Web Dashboard
(via ``SDK.fetchJSON``). Serves avatar state, 42 baked ARDY motion clips, local
VRM/GLB model storage, and the optional PSFN Lite emotion bridge.
"""

from __future__ import annotations

import base64
import importlib.util
import json
import re
import sys
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool

router = APIRouter()

_SAFE_CLIP_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.json$")
_SAFE_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.(?:vrm|glb)$", re.IGNORECASE)


def _load_root_pkg():
    """Load the plugin package from the parent directory when Hermes imports plugin_api.py standalone."""
    pkg_name = "hermes_psfn_avatar_runtime"
    existing = sys.modules.get(pkg_name)
    if existing is not None:
        return existing
    root = Path(__file__).resolve().parent.parent
    spec = importlib.util.spec_from_file_location(
        pkg_name,
        root / "__init__.py",
        submodule_search_locations=[str(root)],
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load hermes-psfn-avatar package")
    module = importlib.util.module_from_spec(spec)
    sys.modules[pkg_name] = module
    spec.loader.exec_module(module)
    return module


def _json_response(body: Any, status: int = 200) -> Response:
    return Response(
        content=json.dumps(body),
        status_code=status,
        media_type="application/json",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/state")
async def get_avatar_state() -> Response:
    def _read():
        _load_root_pkg()
        from hermes_psfn_avatar_runtime.state import (
            MOOD_NAMES,
            REACTION_CLIPS,
            list_models,
            read_state,
        )

        return {
            "ok": True,
            "state": read_state(),
            "models": list_models(),
            "moods": list(MOOD_NAMES),
            "reactions": list(REACTION_CLIPS.keys()),
        }

    return _json_response(await run_in_threadpool(_read))


@router.post("/perform")
async def post_perform(request: Request) -> Response:
    try:
        body = await request.json()
    except Exception:
        return _json_response({"ok": False, "error": "Invalid JSON body"}, status=400)
    if not isinstance(body, dict):
        return _json_response({"ok": False, "error": "Expected JSON object"}, status=400)

    def _apply():
        _load_root_pkg()
        from hermes_psfn_avatar_runtime.state import apply_performance, write_state

        if "muted" in body and isinstance(body["muted"], bool):
            write_state({"muted": body["muted"]}, broadcast=False)
        updated = apply_performance(
            mood=body.get("mood"),
            reaction=body.get("reaction"),
            activity=body.get("activity"),
            speech_text=body.get("say") if "say" in body else body.get("speech_text"),
            camera=body.get("camera"),
            corner=body.get("corner"),
            scale=body.get("scale"),
            mode=body.get("mode"),
            vad=body.get("vad"),
            clip=body.get("clip"),
        )
        return {"ok": True, "state": updated}

    return _json_response(await run_in_threadpool(_apply))


@router.post("/psfn-sync")
async def post_psfn_sync(request: Request) -> Response:
    raw = await request.body()
    payload: dict[str, Any] | None = None
    if raw:
        try:
            parsed = json.loads(raw.decode("utf-8"))
            if isinstance(parsed, dict) and parsed:
                payload = parsed
        except Exception:
            return _json_response({"ok": False, "error": "Invalid JSON body"}, status=400)

    def _sync():
        _load_root_pkg()
        from hermes_psfn_avatar_runtime.bridge import (
            normalize_psfn_emotion_payload,
            sync_from_psfn_lite,
        )
        from hermes_psfn_avatar_runtime.state import apply_performance, read_state

        if payload is not None:
            projected = normalize_psfn_emotion_payload(payload)
            if projected is None:
                return {"ok": False, "error": "Unrecognized emotion payload"}, 400
            state = apply_performance(
                mood=projected["mood"],
                vad=projected["vad"],
                clip=projected["clip"],
                psfn_lite=projected["psfn_lite"],
            )
            return {"ok": True, "source": "pushed", "state": state}, 200

        synced = sync_from_psfn_lite()
        if synced is None:
            return {
                "ok": False,
                "message": "PSFN Lite Garden is not configured or unreachable in this profile.",
                "state": read_state(),
            }, 200
        return {"ok": True, "source": "psfn_lite", "state": synced}, 200

    res, code = await run_in_threadpool(_sync)
    return _json_response(res, status=code)


@router.get("/clips")
async def get_clips() -> Response:
    def _list():
        _load_root_pkg()
        from hermes_psfn_avatar_runtime.state import load_clips_manifest

        return {"ok": True, "clips": load_clips_manifest()}

    return _json_response(await run_in_threadpool(_list))


@router.get("/clips/{filename}")
async def get_clip_file(filename: str) -> Response:
    if not _SAFE_CLIP_RE.match(filename) or ".." in filename:
        return _json_response({"ok": False, "error": "Invalid clip filename"}, status=400)

    def _read_clip():
        _load_root_pkg()
        from hermes_psfn_avatar_runtime.state import clips_dir

        path = clips_dir() / filename
        if not path.is_file():
            return None
        return path.read_bytes()

    content = await run_in_threadpool(_read_clip)
    if content is None:
        return _json_response({"ok": False, "error": "Clip not found"}, status=404)
    return Response(
        content=content,
        status_code=200,
        media_type="application/json",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@router.get("/models")
async def get_models() -> Response:
    def _list():
        _load_root_pkg()
        from hermes_psfn_avatar_runtime.state import list_models, read_state

        return {
            "ok": True,
            "models": list_models(),
            "active_model": read_state().get("active_model"),
        }

    return _json_response(await run_in_threadpool(_list))


@router.post("/models/select")
async def post_select_model(request: Request) -> Response:
    try:
        body = await request.json()
    except Exception:
        return _json_response({"ok": False, "error": "Invalid JSON body"}, status=400)
    if not isinstance(body, dict):
        return _json_response({"ok": False, "error": "Expected JSON object"}, status=400)

    def _select():
        _load_root_pkg()
        from hermes_psfn_avatar_runtime.state import list_models, write_state

        target_id = str(body.get("id") or body.get("filename") or "builtin:holo").strip()
        for item in list_models():
            if item["id"] == target_id or item.get("filename") == target_id:
                active = {
                    "kind": item["kind"],
                    "name": item["name"],
                    "filename": item["filename"],
                }
                state = write_state({"active_model": active})
                return {"ok": True, "active_model": active, "state": state}, 200
        return {"ok": False, "error": f"Model '{target_id}' not found"}, 404

    res, code = await run_in_threadpool(_select)
    return _json_response(res, status=code)


@router.post("/models/upload")
async def post_upload_model(request: Request) -> Response:
    try:
        body = await request.json()
    except Exception:
        return _json_response({"ok": False, "error": "Invalid JSON body"}, status=400)
    if not isinstance(body, dict):
        return _json_response({"ok": False, "error": "Expected JSON object"}, status=400)

    filename = str(body.get("filename") or "").strip()
    b64 = str(body.get("data_base64") or "").strip()
    if not filename or not b64:
        return _json_response({"ok": False, "error": "filename and data_base64 are required"}, status=400)

    def _save():
        _load_root_pkg()
        from hermes_psfn_avatar_runtime.state import list_models, read_state, save_uploaded_model

        try:
            raw = base64.b64decode(b64, validate=True)
            model_info = save_uploaded_model(filename, raw)
            return {
                "ok": True,
                "model": model_info,
                "models": list_models(),
                "state": read_state(),
            }, 200
        except Exception as exc:
            return {"ok": False, "error": str(exc)}, 400

    res, code = await run_in_threadpool(_save)
    return _json_response(res, status=code)


@router.get("/models/file/{filename}")
async def get_model_file(filename: str) -> Response:
    if not _SAFE_MODEL_RE.match(filename) or ".." in filename:
        return _json_response({"ok": False, "error": "Invalid model filename"}, status=400)

    def _read_model():
        _load_root_pkg()
        from hermes_psfn_avatar_runtime.state import models_dir

        path = models_dir() / filename
        if not path.is_file():
            return None
        return path.read_bytes()

    content = await run_in_threadpool(_read_model)
    if content is None:
        return _json_response({"ok": False, "error": "Model file not found"}, status=404)
    return Response(
        content=content,
        status_code=200,
        media_type="model/gltf-binary",
        headers={"Cache-Control": "no-store"},
    )


@router.delete("/models/file/{filename}")
async def delete_model_file(filename: str) -> Response:
    if not _SAFE_MODEL_RE.match(filename) or ".." in filename:
        return _json_response({"ok": False, "error": "Invalid model filename"}, status=400)

    def _delete():
        _load_root_pkg()
        from hermes_psfn_avatar_runtime.state import (
            default_state,
            list_models,
            models_dir,
            read_state,
            write_state,
        )

        path = models_dir() / filename
        if path.is_file():
            path.unlink()
        cur = read_state()
        if (cur.get("active_model") or {}).get("filename") == filename:
            cur = write_state({"active_model": default_state()["active_model"]})
        return {"ok": True, "models": list_models(), "state": cur}

    return _json_response(await run_in_threadpool(_delete))
