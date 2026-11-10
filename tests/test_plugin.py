"""Unit and integration tests for hermes-psfn-avatar Python plugin and FastAPI backend."""

from __future__ import annotations

import base64
import json
import os
import shutil
import struct
import sys
import tempfile
from pathlib import Path

HERMES_ROOT = Path("/home/vega/.hermes/hermes-agent")
if HERMES_ROOT.is_dir() and str(HERMES_ROOT) not in sys.path:
    os.environ.setdefault("HERMES_HOME", "/home/vega/.hermes")
    sys.path.insert(0, str(HERMES_ROOT))
    try:
        import hermes_bootstrap  # noqa: F401
    except Exception:
        pass

_TEST_HERMES_HOME = tempfile.mkdtemp(prefix="hermes-psfn-avatar-test-")
os.environ["HERMES_HOME"] = _TEST_HERMES_HOME
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT.parent) not in sys.path:
    sys.path.insert(0, str(ROOT.parent))

import importlib.util

spec = importlib.util.spec_from_file_location(
    "hermes_psfn_avatar_testpkg",
    ROOT / "__init__.py",
    submodule_search_locations=[str(ROOT)],
)
assert spec is not None and spec.loader is not None
plugin_pkg = importlib.util.module_from_spec(spec)
sys.modules["hermes_psfn_avatar_testpkg"] = plugin_pkg
spec.loader.exec_module(plugin_pkg)


class StubContext:
    def __init__(self) -> None:
        self.tools: list[str] = []
        self.hooks: dict[str, object] = {}
        self.skills: list[str] = []
        self.config: dict[str, object] = {"auto_emote": True, "psfn_lite_bridge": True}

    def register_tool(self, name: str, *args: object, **kwargs: object) -> None:
        del args, kwargs
        self.tools.append(name)

    def register_hook(self, hook_name: str, callback: object, **kwargs: object) -> None:
        del kwargs
        self.hooks[hook_name] = callback

    def register_skill(self, name: str, path: Path, **kwargs: object) -> None:
        del kwargs
        assert Path(path).is_file()
        self.skills.append(name)

    def get_config(self, key: str, default: object = None) -> object:
        return self.config.get(key, default)


def _make_minimal_glb_bytes() -> bytes:
    json_dict = {"asset": {"version": "2.0"}, "extensions": {"VRMC_vrm": {"specVersion": "1.0"}}}
    raw_json = json.dumps(json_dict).encode("utf-8")
    pad = (4 - (len(raw_json) % 4)) % 4
    raw_json += b" " * pad
    total_len = 12 + 8 + len(raw_json)
    header = struct.pack("<III", 0x46546C67, 2, total_len)
    chunk_header = struct.pack("<II", len(raw_json), 0x4E4F534A)
    return header + chunk_header + raw_json


def test_register_and_hooks() -> None:
    ctx = StubContext()
    plugin_pkg.register(ctx)
    assert ctx.tools == ["vrm_avatar"]
    assert set(ctx.hooks.keys()) == {
        "pre_llm_call",
        "pre_tool_call",
        "post_tool_call",
        "post_llm_call",
        "on_session_end",
    }
    assert ctx.skills == ["vrm-avatar"]

    # Exercise hook lifecycle
    ctx.hooks["pre_llm_call"]()
    st = json.loads(plugin_pkg.handle_vrm_avatar_tool({"action": "status"}))["state"]
    assert st["activity"] == "thinking"

    ctx.hooks["pre_tool_call"](tool_name="web_search")
    st = json.loads(plugin_pkg.handle_vrm_avatar_tool({"action": "status"}))["state"]
    assert st["activity"] == "tool"
    assert st["tool_activity"]["name"] == "web_search"
    assert st["tool_activity"]["phase"] == "started"

    ctx.hooks["post_tool_call"](tool_name="web_search", is_error=False)
    st = json.loads(plugin_pkg.handle_vrm_avatar_tool({"action": "status"}))["state"]
    assert st["tool_activity"]["phase"] == "completed"
    assert st["activity"] == "thinking"

    # Mid-turn LLM call that emits tool calls stays in thinking (never talking)
    ctx.hooks["post_llm_call"](response_text="Let me check that...", tool_calls=[{"name": "read_file"}])
    st = json.loads(plugin_pkg.handle_vrm_avatar_tool({"action": "status"}))["state"]
    assert st["activity"] == "thinking"

    # Directive parsing in post_llm_call
    ctx.hooks["post_llm_call"](
        response_text='Here we go!\n::avatar{mood="excitement" reaction="celebrate" say="Shipped!"}\n'
    )
    st = json.loads(plugin_pkg.handle_vrm_avatar_tool({"action": "status"}))["state"]
    assert st["mood"] == "excitement"
    assert st["reaction"] == "celebrate"
    assert st["clip"] == "Celebrate_Reaction_01.json"
    assert st["speech_text"] == "Shipped!"
    assert st["activity"] == "idle"

    ctx.hooks["on_session_end"]()
    st = json.loads(plugin_pkg.handle_vrm_avatar_tool({"action": "status"}))["state"]
    assert st["activity"] == "idle"


def test_psfn_lite_emotion_projection() -> None:
    projected = plugin_pkg.normalize_psfn_emotion_payload(
        {
            "companionId": "persephone-01",
            "emotion": {
                "valence": 0.72,
                "arousal": 0.58,
                "dominance": 0.31,
                "discrete": [
                    {"label": "curiosity", "score": 0.81},
                    {"label": "joy", "score": 0.44},
                ],
                "updatedAt": "2026-11-09T12:00:00Z",
            },
            "openConcerns": [{"id": "c1"}],
        }
    )
    assert projected is not None
    assert projected["mood"] == "curiosity"
    assert projected["emotional_base"] == "curious"
    assert projected["clip"] == "Curiosity_Mood_02.json"
    assert projected["psfn_lite"]["connected"] is True
    assert projected["psfn_lite"]["companion_id"] == "persephone-01"
    assert projected["psfn_lite"]["concerns_count"] == 1


def test_dashboard_api_routes() -> None:
    api_spec = importlib.util.spec_from_file_location(
        "hermes_psfn_avatar_api",
        ROOT / "dashboard" / "plugin_api.py",
    )
    assert api_spec is not None and api_spec.loader is not None
    api_mod = importlib.util.module_from_spec(api_spec)
    api_spec.loader.exec_module(api_mod)

    app = FastAPI()
    app.include_router(api_mod.router, prefix="/api/plugins/hermes-psfn-avatar")
    client = TestClient(app)

    res = client.get("/api/plugins/hermes-psfn-avatar/state")
    assert res.status_code == 200
    assert res.json()["ok"] is True

    res = client.post(
        "/api/plugins/hermes-psfn-avatar/perform",
        json={"mood": "joy", "reaction": "wave", "camera": "waist", "scale": 1.25},
    )
    assert res.status_code == 200
    state = res.json()["state"]
    assert state["mood"] == "joy"
    assert state["reaction"] == "wave"
    assert state["camera"] == "waist"
    assert state["scale"] == 1.25

    # Clips manifest & clip file
    clips_res = client.get("/api/plugins/hermes-psfn-avatar/clips")
    assert clips_res.status_code == 200
    assert len(clips_res.json()["clips"]) == 42

    idle_res = client.get("/api/plugins/hermes-psfn-avatar/clips/Neutral_Idle_01.json")
    assert idle_res.status_code == 200
    assert idle_res.json()["frames"] > 10

    # Upload a minimal valid VRM binary, fetch it back, then delete it
    glb_bytes = _make_minimal_glb_bytes()
    up_res = client.post(
        "/api/plugins/hermes-psfn-avatar/models/upload",
        json={
            "filename": "test_companion.vrm",
            "data_base64": base64.b64encode(glb_bytes).decode("ascii"),
        },
    )
    assert up_res.status_code == 200
    assert up_res.json()["model"]["filename"] == "test_companion.vrm"

    dl_res = client.get("/api/plugins/hermes-psfn-avatar/models/file/test_companion.vrm")
    assert dl_res.status_code == 200
    assert dl_res.content == glb_bytes

    # Verify changing camera view via /perform preserves the selected model
    perf_res = client.post(
        "/api/plugins/hermes-psfn-avatar/perform",
        json={
            "camera": "full",
            "active_model": {
                "kind": "vrm",
                "name": "test companion",
                "filename": "test_companion.vrm",
            },
        },
    )
    assert perf_res.status_code == 200
    assert perf_res.json()["state"]["active_model"]["filename"] == "test_companion.vrm"

    del_res = client.delete("/api/plugins/hermes-psfn-avatar/models/file/test_companion.vrm")
    assert del_res.status_code == 200
    assert del_res.json()["state"]["active_model"]["filename"] == "Nous-Girl.vrm"


if __name__ == "__main__":
    try:
        test_register_and_hooks()
        test_psfn_lite_emotion_projection()
        test_dashboard_api_routes()
        print("All Python plugin + FastAPI route tests passed.")
    finally:
        shutil.rmtree(_TEST_HERMES_HOME, ignore_errors=True)
