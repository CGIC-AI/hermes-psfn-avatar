"""hermes-psfn-avatar: 3D VRM VTuber & companion avatar plugin for Hermes Agent."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from .bridge import normalize_psfn_emotion_payload, sync_from_psfn_lite
from .state import (
    CAMERA_PRESETS,
    CORNER_PRESETS,
    DISPLAY_MODES,
    MOOD_NAMES,
    PLUGIN_ID,
    REACTION_CLIPS,
    apply_performance,
    infer_turn_emote,
    list_models,
    load_clips_manifest,
    parse_avatar_directives,
    read_state,
    write_state,
)

TOOL_NAME = "vrm_avatar"

TOOL_SCHEMA: dict[str, Any] = {
    "name": TOOL_NAME,
    "description": (
        "Control the 3D VRM VTuber / companion avatar overlaid in Hermes Desktop and Web Dashboard. "
        "Trigger any of the 27 GoEmotions mood body performances, one-shot reactions (wave, nod, "
        "celebrate, thanks, reach, surprise, laugh, shrug), lip-synced speech lines, camera presets "
        "(bust, waist, full), or sync continuous VAD emotion state from PSFN Lite."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["emote", "status", "clips", "sync_psfn"],
                "description": "Operation to perform (default: 'emote').",
            },
            "mood": {
                "type": "string",
                "enum": list(MOOD_NAMES),
                "description": "Facial + full-body ARDY mood performance to blend into.",
            },
            "reaction": {
                "type": "string",
                "enum": [*REACTION_CLIPS.keys(), "none"],
                "description": "One-shot physical gesture reaction clip to play.",
            },
            "say": {
                "type": "string",
                "description": "Optional short spoken line to lip-sync and show in the avatar bubble.",
            },
            "camera": {
                "type": "string",
                "enum": list(CAMERA_PRESETS),
                "description": "Camera framing preset: 'bust' (VTuber half-torso), 'waist', or 'full'.",
            },
            "corner": {
                "type": "string",
                "enum": list(CORNER_PRESETS),
                "description": "Floating overlay corner anchor.",
            },
            "mode": {
                "type": "string",
                "enum": list(DISPLAY_MODES),
                "description": "Display mode: 'floating' (transparent corner overlay), 'pane' (docked), or 'hidden'.",
            },
            "scale": {
                "type": "number",
                "description": "Overlay scale multiplier between 0.5 and 2.0.",
            },
            "valence": {
                "type": "number",
                "description": "Optional VAD valence override (-1.0 to 1.0).",
            },
            "arousal": {
                "type": "number",
                "description": "Optional VAD arousal override (-1.0 to 1.0).",
            },
            "dominance": {
                "type": "number",
                "description": "Optional VAD dominance override (-1.0 to 1.0).",
            },
        },
        "required": [],
    },
}


def handle_vrm_avatar_tool(args: dict[str, Any] | None = None, **kwargs: Any) -> str:
    """Execute the ``vrm_avatar`` tool and return a JSON payload."""
    del kwargs
    params = dict(args or {})
    action = str(params.get("action") or "emote").strip().lower()

    if action == "status":
        state = read_state()
        return json.dumps(
            {
                "ok": True,
                "state": state,
                "models": list_models(),
                "available_moods": list(MOOD_NAMES),
                "available_reactions": list(REACTION_CLIPS.keys()),
            }
        )

    if action == "clips":
        clips = load_clips_manifest()
        return json.dumps(
            {
                "ok": True,
                "count": len(clips),
                "clips": [
                    {
                        "name": c.get("name"),
                        "file": Path(str(c.get("url") or "")).name,
                        "state": c.get("state"),
                        "expression": c.get("expression"),
                        "loop": c.get("loop", True),
                    }
                    for c in clips
                ],
            }
        )

    if action == "sync_psfn":
        synced = sync_from_psfn_lite()
        if synced is None:
            return json.dumps(
                {
                    "ok": False,
                    "message": "PSFN Lite Garden is not configured or unreachable in this profile; standalone avatar state remains active.",
                    "state": read_state(),
                }
            )
        return json.dumps({"ok": True, "synced_from": "psfn_lite", "state": synced})

    vad: dict[str, float] | None = None
    if any(k in params for k in ("valence", "arousal", "dominance")):
        cur_vad = read_state().get("vad") or {}
        vad = {
            "valence": float(params.get("valence", cur_vad.get("valence", 0.0))),
            "arousal": float(params.get("arousal", cur_vad.get("arousal", 0.1))),
            "dominance": float(params.get("dominance", cur_vad.get("dominance", 0.0))),
        }

    say_text = params.get("say")
    updated = apply_performance(
        mood=params.get("mood"),
        reaction=params.get("reaction"),
        activity="talking" if say_text else None,
        speech_text=say_text,
        camera=params.get("camera"),
        corner=params.get("corner"),
        scale=params.get("scale"),
        mode=params.get("mode"),
        vad=vad,
    )
    return json.dumps(
        {
            "ok": True,
            "applied": {
                "mood": updated.get("mood"),
                "emotional_base": updated.get("emotional_base"),
                "reaction": updated.get("reaction"),
                "clip": updated.get("clip"),
                "camera": updated.get("camera"),
                "mode": updated.get("mode"),
                "say": updated.get("speech_text"),
            },
        }
    )


def register(ctx: Any) -> None:
    """Register tools, lifecycle hooks, and the bundled skill with Hermes."""
    ctx.register_tool(
        name=TOOL_NAME,
        toolset="avatar",
        schema=TOOL_SCHEMA,
        handler=handle_vrm_avatar_tool,
        description="Animate and configure the 3D VRM VTuber / companion avatar overlay.",
        emoji="🎭",
    )

    skill_file = Path(__file__).resolve().parent / "skills" / "vrm-avatar" / "SKILL.md"
    if skill_file.is_file():
        try:
            ctx.register_skill(
                "vrm-avatar",
                skill_file,
                description="Drive the 3D VRM avatar overlay with moods, reactions, lip-sync, and ::avatar{} directives.",
            )
        except Exception:
            pass

    def on_pre_llm_call(**kwargs: Any) -> None:
        del kwargs
        write_state({"activity": "thinking", "reaction": None})

    def on_pre_tool_call(**kwargs: Any) -> None:
        tool_name = str(kwargs.get("tool_name") or kwargs.get("name") or "")
        if tool_name == TOOL_NAME:
            return
        write_state(
            {
                "activity": "tool",
                "tool_activity": {
                    "name": tool_name,
                    "phase": "started",
                    "updated_at": time.time(),
                },
            }
        )

    def on_post_tool_call(**kwargs: Any) -> None:
        tool_name = str(kwargs.get("tool_name") or kwargs.get("name") or "")
        if tool_name == TOOL_NAME:
            return
        is_err = bool(kwargs.get("is_error") or kwargs.get("error"))
        write_state(
            {
                "activity": "thinking",
                "tool_activity": {
                    "name": tool_name,
                    "phase": "failed" if is_err else "completed",
                    "updated_at": time.time(),
                },
            }
        )

    def on_post_llm_call(**kwargs: Any) -> None:
        reply = str(kwargs.get("response_text") or kwargs.get("content") or kwargs.get("text") or "")
        psfn_synced = None
        if bool(ctx.get_config("psfn_lite_bridge", True)):
            psfn_synced = sync_from_psfn_lite()

        directives = parse_avatar_directives(reply)
        if directives:
            last = directives[-1]
            apply_performance(
                mood=last.get("mood") or last.get("emotion"),
                reaction=last.get("reaction") or last.get("action"),
                camera=last.get("camera"),
                activity="talking" if reply.strip() else "idle",
                speech_text=last.get("say") or reply[:320],
            )
            return

        if bool(ctx.get_config("auto_emote", True)) and reply.strip():
            inferred = infer_turn_emote(reply)
            apply_performance(
                mood=None if psfn_synced else inferred.get("mood"),
                reaction=inferred.get("reaction"),
                activity="talking",
                speech_text=reply[:320],
            )

    def on_session_end(**kwargs: Any) -> None:
        del kwargs
        if bool(ctx.get_config("psfn_lite_bridge", True)):
            sync_from_psfn_lite()
        write_state({"activity": "idle", "tool_activity": None})

    ctx.register_hook("pre_llm_call", on_pre_llm_call)
    ctx.register_hook("pre_tool_call", on_pre_tool_call)
    ctx.register_hook("post_tool_call", on_post_tool_call)
    ctx.register_hook("post_llm_call", on_post_llm_call)
    ctx.register_hook("on_session_end", on_session_end)


__all__ = [
    "PLUGIN_ID",
    "TOOL_NAME",
    "TOOL_SCHEMA",
    "handle_vrm_avatar_tool",
    "normalize_psfn_emotion_payload",
    "register",
]
