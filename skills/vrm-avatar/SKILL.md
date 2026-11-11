---
name: vrm-avatar
description: Drive the 3D VRM VTuber / companion avatar overlay in Hermes Desktop and Web Dashboard using the vrm_avatar tool or inline ::avatar{} transcript directives.
---

# Hermes PSFN Avatar (`hermes-psfn-avatar`)

When `hermes-psfn-avatar` is enabled, a 3D VRM / Holo-Rig character floats in the corner of Hermes Desktop and the Web Dashboard (or docks as a side stage pane).

## Automatic Behavior
You do not need to call a tool on every turn:
- The avatar automatically shifts to **Thinking** while you reason, **Tool Activity** while tools run, **Talking** with lip-sync while you stream a reply, and **Idle** (breathing, blinking, spring-bone hair/ears/tail physics) between turns.
- When **PSFN Lite** (`psfn_lite`) is active in the same Hermes profile, the avatar continuously mirrors the companion's authoritative VAD vector and 28-class GoEmotions state.

## Deliberate Emotes & Stage Directions

You have two ways to intentionally perform gestures, change expressions, or adjust the camera:

### 1. Inline Transcript Directive (`::avatar{...}`)
Place a standalone paragraph anywhere in your reply:

```markdown
::avatar{mood="joy" reaction="wave" say="Hey there! Ready to build?"}
```

Supported attributes:
- `mood`: `neutral`, `admiration`, `amusement`, `anger`, `annoyance`, `approval`, `caring`, `confusion`, `curiosity`, `desire`, `disappointment`, `disapproval`, `disgust`, `embarrassment`, `excitement`, `fear`, `gratitude`, `grief`, `joy`, `love`, `nervousness`, `optimism`, `pride`, `realization`, `relief`, `remorse`, `sadness`, `surprise`
- `reaction`: `wave`, `nod`, `celebrate`, `thanks`, `reach`, `surprise`, `laugh`, `shrug`, `headpat`, `hug`
- `camera`: `bust` (VTuber half-torso), `waist`, `full`
- `say`: Short line displayed in the avatar's speech bubble and lip-synced.

### 2. The `vrm_avatar` Tool
Call `vrm_avatar` when the user asks you to change the avatar's layout, inspect loaded `.vrm`/`.glb` models, list the 42 motion clips, or sync with PSFN Lite:
- `vrm_avatar(action="emote", mood="excitement", reaction="celebrate", camera="bust")`
- `vrm_avatar(action="status")`
- `vrm_avatar(action="clips")`
- `vrm_avatar(action="sync_psfn")`
