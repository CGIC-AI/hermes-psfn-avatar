"""Profile-scoped avatar state, 28-mood GoEmotions taxonomy, clip catalog, and VRM model storage."""

from __future__ import annotations

import hashlib
import json
import re
import tempfile
import time
from pathlib import Path
from typing import Any

PLUGIN_ID = "hermes-psfn-avatar"

#: The 27 custom mood expressions with baked ARDY body clips in clips/clips.json, plus neutral.
MOOD_NAMES: tuple[str, ...] = (
    "neutral",
    "admiration",
    "amusement",
    "anger",
    "annoyance",
    "approval",
    "caring",
    "confusion",
    "curiosity",
    "desire",
    "disappointment",
    "disapproval",
    "disgust",
    "embarrassment",
    "excitement",
    "fear",
    "gratitude",
    "grief",
    "joy",
    "love",
    "nervousness",
    "optimism",
    "pride",
    "realization",
    "relief",
    "remorse",
    "sadness",
    "surprise",
)

#: Reaction names mapped to baked one-shot ARDY clips in clips/clips.json.
REACTION_CLIPS: dict[str, str] = {
    "wave": "Wave_Reaction_01.json",
    "nod": "Nod_Reaction_01.json",
    "celebrate": "Celebrate_Reaction_01.json",
    "thanks": "Thanks_Reaction_01.json",
    "reach": "Reach_Reaction_01.json",
    "surprise": "Surprise_Reaction_01.json",
    "laugh": "Laugh_Reaction_02.json",
    "shrug": "Shrug_Reaction_02.json",
    "headpat": "Celebrate_Reaction_01.json",
    "petting": "Nod_Reaction_01.json",
    "hug": "Reach_Reaction_01.json",
    "kiss": "Thanks_Reaction_01.json",
}

#: Mood name -> baked mood body clip filename in clips/.
MOOD_CLIPS: dict[str, str] = {
    "admiration": "Admiration_Mood_01.json",
    "amusement": "Amusement_Mood_01.json",
    "anger": "Anger_Mood_01.json",
    "annoyance": "Annoyance_Mood_01.json",
    "approval": "Approval_Mood_02.json",
    "caring": "Caring_Mood_01.json",
    "confusion": "Confusion_Mood_01.json",
    "curiosity": "Curiosity_Mood_02.json",
    "desire": "Desire_Mood_01.json",
    "disappointment": "Disappointment_Mood_01.json",
    "disapproval": "Disapproval_Mood_02.json",
    "disgust": "Disgust_Mood_01.json",
    "embarrassment": "Embarrassment_Mood_01.json",
    "excitement": "Excitement_Mood_01.json",
    "fear": "Fear_Mood_01.json",
    "gratitude": "Gratitude_Mood_01.json",
    "grief": "Grief_Mood_01.json",
    "joy": "Joy_Mood_01.json",
    "love": "Love_Mood_01.json",
    "nervousness": "Nervousness_Mood_01.json",
    "optimism": "Optimism_Mood_01.json",
    "pride": "Pride_Mood_01.json",
    "realization": "Realization_Mood_01.json",
    "relief": "Relief_Mood_01.json",
    "remorse": "Remorse_Mood_01.json",
    "sadness": "Sadness_Mood_03.json",
    "surprise": "Surprise_Mood_01.json",
}

#: Discrete GoEmotions label -> PSFN 16 emotional base family.
DISCRETE_TO_BASE: dict[str, str] = {
    "neutral": "neutral",
    "admiration": "happy",
    "amusement": "laughing",
    "anger": "grumpy",
    "annoyance": "grumpy",
    "approval": "content",
    "caring": "love",
    "confusion": "curious",
    "curiosity": "curious",
    "desire": "love",
    "disappointment": "sad",
    "disapproval": "grumpy",
    "disgust": "grumpy",
    "embarrassment": "embarrassed",
    "excitement": "excited",
    "fear": "anxious",
    "gratitude": "happy",
    "grief": "sad",
    "joy": "happy",
    "love": "love",
    "nervousness": "anxious",
    "optimism": "happy",
    "pride": "smug",
    "realization": "surprised",
    "relief": "content",
    "remorse": "sad",
    "sadness": "sad",
    "surprise": "surprised",
}

#: Default VAD coordinates per discrete mood when no explicit VAD vector is supplied.
MOOD_DEFAULT_VAD: dict[str, dict[str, float]] = {
    "neutral": {"valence": 0.0, "arousal": 0.1, "dominance": 0.0},
    "admiration": {"valence": 0.65, "arousal": 0.35, "dominance": 0.2},
    "amusement": {"valence": 0.75, "arousal": 0.65, "dominance": 0.3},
    "anger": {"valence": -0.7, "arousal": 0.75, "dominance": 0.5},
    "annoyance": {"valence": -0.45, "arousal": 0.45, "dominance": 0.25},
    "approval": {"valence": 0.5, "arousal": 0.25, "dominance": 0.25},
    "caring": {"valence": 0.65, "arousal": 0.25, "dominance": 0.15},
    "confusion": {"valence": -0.15, "arousal": 0.4, "dominance": -0.25},
    "curiosity": {"valence": 0.4, "arousal": 0.55, "dominance": 0.15},
    "desire": {"valence": 0.6, "arousal": 0.6, "dominance": 0.2},
    "disappointment": {"valence": -0.55, "arousal": -0.15, "dominance": -0.35},
    "disapproval": {"valence": -0.5, "arousal": 0.35, "dominance": 0.3},
    "disgust": {"valence": -0.65, "arousal": 0.5, "dominance": 0.2},
    "embarrassment": {"valence": -0.3, "arousal": 0.45, "dominance": -0.45},
    "excitement": {"valence": 0.85, "arousal": 0.8, "dominance": 0.4},
    "fear": {"valence": -0.7, "arousal": 0.75, "dominance": -0.6},
    "gratitude": {"valence": 0.7, "arousal": 0.3, "dominance": 0.1},
    "grief": {"valence": -0.8, "arousal": -0.3, "dominance": -0.5},
    "joy": {"valence": 0.85, "arousal": 0.6, "dominance": 0.35},
    "love": {"valence": 0.9, "arousal": 0.45, "dominance": 0.2},
    "nervousness": {"valence": -0.45, "arousal": 0.65, "dominance": -0.45},
    "optimism": {"valence": 0.65, "arousal": 0.45, "dominance": 0.35},
    "pride": {"valence": 0.7, "arousal": 0.5, "dominance": 0.6},
    "realization": {"valence": 0.25, "arousal": 0.6, "dominance": 0.15},
    "relief": {"valence": 0.55, "arousal": -0.2, "dominance": 0.2},
    "remorse": {"valence": -0.6, "arousal": 0.15, "dominance": -0.45},
    "sadness": {"valence": -0.65, "arousal": -0.25, "dominance": -0.4},
    "surprise": {"valence": 0.2, "arousal": 0.8, "dominance": -0.1},
}

CAMERA_PRESETS = ("bust", "waist", "full")
CORNER_PRESETS = ("bottom-right", "bottom-left", "top-right", "top-left")
DISPLAY_MODES = ("floating", "pane", "hidden")

_SAFE_FILENAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.(?:vrm|glb)$", re.IGNORECASE)
_DIRECTIVE_RE = re.compile(r"(?m)^\s*::avatar\{([^}\n]*)\}\s*$")
_ATTR_RE = re.compile(r'([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*"([^"]*)"')
_MAX_MODEL_BYTES = 64 * 1024 * 1024  # 64 MiB cap for uploaded local VRM/GLB files
_GLB_MAGIC = b"glTF"


def _data_root() -> Path:
    """Resolve profile-scoped plugin data directory via Hermes's public storage helper."""
    try:
        from plugins.plugin_storage import plugin_data_dir

        return plugin_data_dir(PLUGIN_ID)
    except Exception:
        fallback = Path(tempfile.gettempdir()) / "hermes-psfn-avatar-data"
        fallback.mkdir(parents=True, exist_ok=True)
        return fallback


def clips_dir() -> Path:
    return Path(__file__).resolve().parent / "clips"


def load_clips_manifest() -> list[dict[str, Any]]:
    manifest_path = clips_dir() / "clips.json"
    if not manifest_path.is_file():
        return []
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def models_dir() -> Path:
    d = _data_root() / "models"
    d.mkdir(parents=True, exist_ok=True)
    return d


def shared_models_dir() -> Path:
    hermes_home = Path.home() / ".hermes"
    return hermes_home / "plugin-data" / PLUGIN_ID / "models"


def find_model_file(filename: str) -> Path | None:
    if not _SAFE_FILENAME_RE.match(filename) or ".." in filename:
        return None
    for candidate in (models_dir() / filename, shared_models_dir() / filename):
        if candidate.is_file():
            return candidate
    return None


def state_file() -> Path:
    return _data_root() / "avatar_state.json"


def default_state() -> dict[str, Any]:
    return {
        "seq": 1,
        "updated_at": time.time(),
        "activity": "idle",
        "mood": "neutral",
        "emotional_base": "neutral",
        "vad": dict(MOOD_DEFAULT_VAD["neutral"]),
        "reaction": None,
        "clip": "Neutral_Idle_01.json",
        "speech_text": "",
        "speech_Id": 0,
        "tool_activity": None,
        "camera": "bust",
        "corner": "bottom-right",
        "scale": 1.0,
        "mode": "floating",
        "muted": False,
        "active_model": {
            "kind": "vrm",
            "name": "Nous-Girl (VRM 0.x)",
            "filename": "Nous-Girl.vrm",
        },
        "psfn_lite": {
            "connected": False,
            "companion_id": None,
            "last_synced_at": None,
            "discrete": [],
            "concerns_count": 0,
        },
    }


def read_state() -> dict[str, Any]:
    base = default_state()
    path = state_file()
    if not path.is_file():
        return base
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            base.update(loaded)
    except Exception:
        pass
    return base


def write_state(patch: dict[str, Any], *, broadcast: bool = True) -> dict[str, Any]:
    current = read_state()
    current.update(patch)
    current["seq"] = int(current.get("seq") or 0) + 1
    current["updated_at"] = time.time()
    path = state_file()
    tmp = path.with_suffix(".json.tmp")
    try:
        tmp.write_text(json.dumps(current, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(path)
    except Exception:
        pass
    if broadcast:
        broadcast_avatar_event("state", current)
    return current


def broadcast_avatar_event(event_name: str, payload: dict[str, Any]) -> None:
    """Push a real-time event to connected Hermes Desktop clients via the public plugin_events API."""
    try:
        from hermes_cli.plugin_events import broadcast_plugin_event

        broadcast_plugin_event(PLUGIN_ID, event_name, payload)
    except Exception:
        pass


def vad_to_emotional_base(valence: float, arousal: float, dominance: float = 0.0) -> str:
    """Port of psfn-framework's vadQuadrantBase(vector) -> 16-state EmotionalBase."""
    if abs(valence) < 0.15 and abs(arousal) < 0.15:
        return "neutral"
    if valence >= 0.15:
        if arousal >= 0.6:
            return "excited"
        if arousal < 0.35:
            return "content"
        return "happy"
    if valence <= -0.15:
        if arousal < 0.0:
            return "tired"
        if arousal >= 0.35:
            return "grumpy" if dominance >= 0.0 else "anxious"
        return "sad"
    return "curious" if arousal >= 0.35 else "neutral"


def apply_performance(
    *,
    mood: str | None = None,
    reaction: str | None = None,
    activity: str | None = None,
    speech_text: str | None = None,
    camera: str | None = None,
    corner: str | None = None,
    scale: float | None = None,
    mode: str | None = None,
    vad: dict[str, float] | None = None,
    clip: str | None = None,
    psfn_lite: dict[str, Any] | None = None,
    active_model: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Validate and apply an avatar performance update, returning the updated state."""
    current = read_state()
    patch: dict[str, Any] = {}

    if mood is not None:
        clean_mood = mood.strip().lower()
        if clean_mood in MOOD_NAMES:
            patch["mood"] = clean_mood
            patch["emotional_base"] = DISCRETE_TO_BASE.get(clean_mood, "neutral")
            if vad is None:
                patch["vad"] = dict(MOOD_DEFAULT_VAD.get(clean_mood, MOOD_DEFAULT_VAD["neutral"]))
            if clip is None and reaction is None and clean_mood in MOOD_CLIPS:
                patch["clip"] = MOOD_CLIPS[clean_mood]

    if vad is not None and isinstance(vad, dict):
        v = max(-1.0, min(1.0, float(vad.get("valence", 0.0))))
        a = max(-1.0, min(1.0, float(vad.get("arousal", 0.0))))
        d = max(-1.0, min(1.0, float(vad.get("dominance", 0.0))))
        patch["vad"] = {"valence": round(v, 4), "arousal": round(a, 4), "dominance": round(d, 4)}
        if "mood" not in patch:
            patch["emotional_base"] = vad_to_emotional_base(v, a, d)

    if reaction is not None:
        clean_react = reaction.strip().lower()
        if clean_react in REACTION_CLIPS:
            patch["reaction"] = clean_react
            patch["clip"] = REACTION_CLIPS[clean_react]
        elif clean_react in ("none", "clear", ""):
            patch["reaction"] = None

    if clip is not None:
        clean_clip = Path(clip.strip()).name
        if (clips_dir() / clean_clip).is_file():
            patch["clip"] = clean_clip

    if activity is not None and activity in ("idle", "thinking", "listening", "talking", "tool"):
        patch["activity"] = activity

    if speech_text is not None:
        patch["speech_text"] = str(speech_text).strip()[:600]
        patch["speech_Id"] = int(current.get("speech_Id") or 0) + 1

    if camera is not None and camera in CAMERA_PRESETS:
        patch["camera"] = camera

    if corner is not None and corner in CORNER_PRESETS:
        patch["corner"] = corner

    if scale is not None:
        patch["scale"] = round(max(0.5, min(2.0, float(scale))), 2)

    if mode is not None and mode in DISPLAY_MODES:
        patch["mode"] = mode

    if psfn_lite is not None:
        patch["psfn_lite"] = psfn_lite

    if isinstance(active_model, dict):
        fname = str(active_model.get("filename") or "").strip()
        if fname and _SAFE_FILENAME_RE.match(fname):
            kind = str(active_model.get("kind") or ("glb" if fname.lower().endswith(".glb") else "vrm"))
            name = str(active_model.get("name") or Path(fname).stem)
            patch["active_model"] = {"kind": kind, "name": name, "filename": fname}

    return write_state(patch)


def parse_avatar_directives(text: str) -> list[dict[str, str]]:
    """Extract ``::avatar{mood="joy" reaction="wave"}`` directives from assistant text."""
    results: list[dict[str, str]] = []
    for match in _DIRECTIVE_RE.finditer(text or ""):
        attrs = {k.lower(): v for k, v in _ATTR_RE.findall(match.group(1))}
        if attrs:
            results.append(attrs)
    return results


_KEYWORD_MOODS: tuple[tuple[tuple[str, ...], str, str | None], ...] = (
    (("congratulations", "awesome", "woohoo", "celebrate", "nailed it", "hooray"), "excitement", "celebrate"),
    (("thank you", "thanks so much", "appreciate it", "grateful"), "gratitude", "thanks"),
    (("haha", "lol", "lmao", "hilarious", "funny"), "amusement", "laugh"),
    (("sorry", "apologize", "my mistake", "regret"), "remorse", None),
    (("interesting", "curious", "wonder why", "let's investigate", "fascinating"), "curiosity", None),
    (("glad to", "happy to", "delighted", "great news", "wonderful"), "joy", "nod"),
    (("phew", "relieved", "fixed now", "all clear", "resolved"), "relief", "nod"),
    (("hmm", "puzzling", "not sure why", "confusing", "strange"), "confusion", "shrug"),
    (("proud", "accomplished", "clean build"), "pride", "nod"),
    (("careful", "watch out", "warning", "caution"), "nervousness", None),
    (("hello", "hi there", "hey there", "greetings", "welcome"), "joy", "wave"),
)


def infer_turn_emote(reply_text: str) -> dict[str, str | None]:
    """Lightweight deterministic fallback when the model didn't explicitly emit ::avatar or call vrm_avatar."""
    directives = parse_avatar_directives(reply_text)
    if directives:
        last = directives[-1]
        return {
            "mood": last.get("mood") or last.get("emotion"),
            "reaction": last.get("reaction") or last.get("action"),
            "camera": last.get("camera"),
            "say": last.get("say"),
        }
    lower = (reply_text or "").lower()
    for keywords, mood, reaction in _KEYWORD_MOODS:
        if any(kw in lower for kw in keywords):
            return {"mood": mood, "reaction": reaction, "camera": None, "say": None}
    return {"mood": "approval" if len(lower) > 80 else "neutral", "reaction": "nod" if len(lower) > 80 else None, "camera": None, "say": None}


def list_models() -> list[dict[str, Any]]:
    """List available VRM/GLB avatar models (bundled Nous-Girl default, DeepSeek-chan, and uploaded files)."""
    items: list[dict[str, Any]] = [
        {
            "id": "file:Nous-Girl.vrm",
            "kind": "vrm",
            "name": "Nous-Girl (VRM 0.x)",
            "filename": "Nous-Girl.vrm",
            "size_bytes": 11491944,
        },
        {
            "id": "file:DeepSeek-chan.vrm",
            "kind": "vrm",
            "name": "DeepSeek-chan (CC BY-NC-SA 4.0)",
            "filename": "DeepSeek-chan.vrm",
            "size_bytes": 33616628,
        },
    ]
    seen = {"Nous-Girl.vrm", "DeepSeek-chan.vrm"}
    mdir = models_dir()
    for path in sorted(mdir.iterdir()):
        if path.is_file() and _SAFE_FILENAME_RE.match(path.name) and path.name not in seen:
            seen.add(path.name)
            ext = path.suffix.lower().lstrip(".")
            items.append(
                {
                    "id": f"file:{path.name}",
                    "kind": "vrm" if ext == "vrm" else "glb",
                    "name": path.stem.replace("_", " ").replace("-", " "),
                    "filename": path.name,
                    "size_bytes": path.stat().st_size,
                }
            )
    return items


def save_uploaded_model(filename: str, data: bytes) -> dict[str, Any]:
    """Validate and store a .vrm or .glb binary in plugin_data_dir('hermes-psfn-avatar')/models/."""
    clean_name = Path(filename or "").name.strip()
    clean_name = re.sub(r"[^A-Za-z0-9._-]", "_", clean_name)
    if not _SAFE_FILENAME_RE.match(clean_name):
        raise ValueError("Model filename must end with .vrm or .glb and contain only safe characters.")
    if len(data) < 20:
        raise ValueError("Model file is too small to be a valid VRM/GLB binary.")
    if len(data) > _MAX_MODEL_BYTES:
        raise ValueError(f"Model file exceeds maximum size ({_MAX_MODEL_BYTES // (1024 * 1024)} MiB).")
    if data[:4] != _GLB_MAGIC:
        raise ValueError("Invalid VRM/GLB header: expected binary glTF ('glTF' magic bytes).")

    target = models_dir() / clean_name
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(target)

    ext = target.suffix.lower().lstrip(".")
    model_info = {
        "kind": "vrm" if ext == "vrm" else "glb",
        "name": target.stem.replace("_", " ").replace("-", " "),
        "filename": target.name,
        "sha256": hashlib.sha256(data).hexdigest()[:16],
        "size_bytes": len(data),
    }
    write_state({"active_model": model_info})
    return model_info
