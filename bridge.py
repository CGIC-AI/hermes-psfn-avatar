"""Optional bridge to PSFN Lite's continuous emotion & inner-life state.

When PSFN Lite (``psfn_lite``) is configured in the active Hermes profile
(``$HERMES_HOME/psfn-lite.json`` with a loopback ``garden`` endpoint), this bridge
reads the companion's authoritative VAD + 28 GoEmotions state after each turn and
projects it onto the 3D VRM avatar. When PSFN Lite is not installed or not configured,
every call returns ``None`` cleanly without errors.
"""

from __future__ import annotations

import ipaddress
import json
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from .state import (
    DISCRETE_TO_BASE,
    MOOD_CLIPS,
    MOOD_NAMES,
    apply_performance,
    vad_to_emotional_base,
)


def _is_loopback_http(url: str) -> bool:
    """Only contact a loopback PSFN Lite Garden endpoint (127.0.0.0/8, ::1, localhost)."""
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    if parsed.scheme != "http" or not parsed.hostname or parsed.username or parsed.password:
        return False
    host = parsed.hostname.lower()
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _read_psfn_lite_garden_config() -> tuple[str, str, float] | None:
    """Read ``$HERMES_HOME/psfn-lite.json`` and resolve the Garden bearer through Hermes's secret_scope."""
    try:
        from hermes_constants import get_hermes_home
        from agent.secret_scope import get_secret

        cfg_path: Path = get_hermes_home() / "psfn-lite.json"
        if not cfg_path.is_file():
            return None
        raw = json.loads(cfg_path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return None
        garden = raw.get("garden")
        if not isinstance(garden, dict):
            return None
        url = str(garden.get("url") or "").rstrip("/")
        cred_env = str(garden.get("credential_env") or "").strip()
        timeout = float(garden.get("timeout_seconds") or 5.0)
        if not url or not cred_env or not _is_loopback_http(url):
            return None
        token = (get_secret(cred_env) or "").strip()
        if not token:
            return None
        return url, token, max(0.5, min(timeout, 10.0))
    except Exception:
        return None


def normalize_psfn_emotion_payload(payload: dict[str, Any]) -> dict[str, Any] | None:
    """Project a PSFN Lite ``/api/lite/inner-life`` or ``/api/lite/overview`` payload onto avatar state."""
    if not isinstance(payload, dict):
        return None
    emotion = payload.get("emotion") if isinstance(payload.get("emotion"), dict) else payload
    if not isinstance(emotion, dict):
        return None

    # Extract VAD vector (supports {vad: {valence, arousal, dominance}}, {vector: ...}, or flat)
    vec = (
        emotion.get("vad")
        if isinstance(emotion.get("vad"), dict)
        else emotion.get("vector")
        if isinstance(emotion.get("vector"), dict)
        else emotion.get("mood")
        if isinstance(emotion.get("mood"), dict)
        else emotion
    )
    valence = float(vec.get("valence", 0.0) or 0.0)
    arousal = float(vec.get("arousal", 0.0) or 0.0)
    dominance = float(vec.get("dominance", 0.0) or 0.0)

    # Extract discrete 28-class GoEmotions scores (list of {label, score} or dict of label->score)
    raw_discrete = emotion.get("discrete") or emotion.get("emotions") or emotion.get("scores") or []
    discrete_list: list[dict[str, Any]] = []
    if isinstance(raw_discrete, list):
        for item in raw_discrete:
            if isinstance(item, dict) and isinstance(item.get("label"), str):
                label = item["label"].strip().lower()
                score = float(item.get("score", 0.0) or 0.0)
                discrete_list.append({"label": label, "score": round(score, 4)})
    elif isinstance(raw_discrete, dict):
        for k, v in raw_discrete.items():
            if isinstance(v, (int, float)):
                discrete_list.append({"label": str(k).strip().lower(), "score": round(float(v), 4)})

    discrete_list.sort(key=lambda x: x["score"], reverse=True)

    raw_mood_field = emotion.get("dominant") or (emotion.get("mood") if isinstance(emotion.get("mood"), str) else "")
    dominant_mood = str(raw_mood_field or "").strip().lower()
    if dominant_mood not in MOOD_NAMES:
        dominant_mood = ""
    if not dominant_mood and discrete_list:
        top = discrete_list[0]
        if top["label"] in MOOD_NAMES and top["label"] != "neutral" and top["score"] >= 0.12:
            dominant_mood = top["label"]
        elif len(discrete_list) > 1 and discrete_list[1]["label"] in MOOD_NAMES and discrete_list[1]["score"] >= 0.15:
            dominant_mood = discrete_list[1]["label"]
        elif top["label"] in MOOD_NAMES and top["score"] >= 0.35:
            dominant_mood = top["label"]

    vad = {
        "valence": round(max(-1.0, min(1.0, valence)), 4),
        "arousal": round(max(-1.0, min(1.0, arousal)), 4),
        "dominance": round(max(-1.0, min(1.0, dominance)), 4),
    }
    base = DISCRETE_TO_BASE.get(dominant_mood) if dominant_mood else vad_to_emotional_base(valence, arousal, dominance)
    base_to_mood = {
        "happy": "joy",
        "content": "relief",
        "excited": "excitement",
        "curious": "curiosity",
        "sad": "sadness",
        "anxious": "nervousness",
        "grumpy": "annoyance",
        "tired": "relief",
    }
    mood = dominant_mood or base_to_mood.get(base or "neutral", "neutral")
    clip = MOOD_CLIPS.get(mood)
    concerns = payload.get("openConcerns") or payload.get("focus") or []
    concerns_count = len(concerns) if isinstance(concerns, list) else 0

    return {
        "mood": mood,
        "emotional_base": base or "neutral",
        "vad": vad,
        "clip": clip,
        "psfn_lite": {
            "connected": True,
            "companion_id": payload.get("companionId"),
            "last_synced_at": emotion.get("updatedAt") or emotion.get("timestamp"),
            "discrete": discrete_list[:6],
            "concerns_count": concerns_count,
        },
    }


def sync_from_psfn_lite() -> dict[str, Any] | None:
    """Query PSFN Lite's loopback Garden if configured and apply its emotion state to the avatar."""
    cfg = _read_psfn_lite_garden_config()
    if cfg is None:
        return None
    url, token, timeout = cfg
    req = urllib.request.Request(
        f"{url}/api/lite/overview",
        method="GET",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status != 200:
                return None
            data = json.loads(resp.read().decode("utf-8"))
    except (OSError, urllib.error.URLError, ValueError):
        return None

    projected = normalize_psfn_emotion_payload(data)
    if projected is None:
        return None
    return apply_performance(
        mood=projected["mood"],
        vad=projected["vad"],
        clip=projected["clip"],
        psfn_lite=projected["psfn_lite"],
    )
