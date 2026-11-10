# hermes-psfn-avatar — 3D VRM VTuber & Companion Avatar for Hermes Agent

`hermes-psfn-avatar` brings a live 3D VRM 0.x / 1.0 & Holo-Rig VTuber avatar directly into **Hermes Desktop** and the **Hermes Web Dashboard** as a transparent corner overlay, dockable stage pane, and full 3D motion studio—powered by **Three.js** and **`@pixiv/three-vrm`**.

Built as a standalone plugin for any Hermes Agent user, with a zero-config emotional continuity bridge to **PSFN Lite** (`psfn_lite`) when installed in the same Hermes profile.

## Features

- **Floating VTuber Corner Overlay & Dockable Stage Pane**:
  - Sits in any corner of Hermes Desktop (`bottom-right`, `bottom-left`, `top-right`, `top-left`) with a transparent WebGL canvas (`alpha: true`), framed on the character's upper-body bust (`bust`), waist-up (`waist`), or full body (`full`).
  - Click-through background with interactive anatomical touch zones (`headpat`, `petting`, `cheek boop`, `hug`), drag-to-reposition on the avatar silhouette, `Shift+drag` or `Right-drag` smooth 360° 3D camera orbit, scroll-wheel zoom, and a persistent hover Mini-HUD with one-click toggle to dock into a right-hand layout pane.
  - Also populates the `overlay` shell slot and `/vrm-avatar` Studio tab in the **Hermes Web Dashboard**.
- **Works Out of the Box (Built-in 3D Persephone Holo-Rig + Custom `.vrm` / `.glb` Upload)**:
  - Immediately renders an articulated 3D humanoid Holo-Rig with VRM-normalized bones, expressive visor eyes, lip-synced mouth, blush cheeks, halo, and emotion-driven ears & tail before any external `.vrm` file is loaded.
  - Upload any standard `.vrm` (VRM 0.x or VRM 1.0) or `.glb` file in the **VRM Avatar Studio** (`/vrm-avatar` or **Settings → Plugins → VRM Avatar**); models are validated locally and persisted in `<HERMES_HOME>/plugin-data/hermes-psfn-avatar/models/`.
- **42 Baked ARDY Humanoid Motion-Capture Clips & 28 GoEmotions Moods**:
  - Ships 42 baked Core-27 skeletal motion clips in `clips/`: 1 Idle, 4 auto-rotating Talking gesture variants, 1 Thinking, 2 Listening, 7 one-shot Reactions (`wave`, `nod`, `celebrate`, `thanks`, `reach`, `surprise`, `laugh`, `shrug`), and **27 discrete GoEmotions mood body performances** with 0.4s attack / 0.5s release facial blend envelopes.
  - Supports `psfn.companion-motion/1` VRM extras for custom ear/tail spring-bone pivots while keeping standard VRMs 100% compatible.
- **Automatic Turn Reactivity + Agent-Driven Stage Directions**:
  - Automatically shifts between **Thinking**, **Tool Activity**, **Talking** (with syllable-paced `aa` lip-sync), and **Idle** (breathing, periodic blinking, spring-bone physics) via Hermes lifecycle hooks and Desktop gateway events.
  - **Tool (`vrm_avatar`)** and **Transcript Directive (`::avatar{mood="joy" reaction="wave" say="..."}`)** let the model deliberately emote and perform gestures mid-conversation.
- **Optional PSFN Lite (`psfn_lite`) Emotional Continuity Bridge**:
  - When `psfn_lite` is configured in the active Hermes profile (`$HERMES_HOME/psfn-lite.json` with a loopback `garden` endpoint), `hermes-psfn-avatar` automatically syncs the companion's continuous **Valence-Arousal-Dominance (VAD)** vector and **28-class GoEmotions** state after each turn.

## Installation

```bash
hermes plugins install https://github.com/axAilotl/hermes-psfn-avatar
hermes plugins enable hermes-psfn-avatar
```

In **Hermes Desktop**, open **Capabilities → Plugins** and toggle **PSFN 3D VRM Avatar** on (or run **⌘K → VRM Avatar: Open 3D Avatar Studio**).

## Usage

### Inline Transcript Directives
The agent can emit a standalone `::avatar{...}` paragraph in any reply:

```markdown
::avatar{mood="excitement" reaction="celebrate" say="All tests are green!"}
```

### Agent Tool (`vrm_avatar`)
- `vrm_avatar(action="emote", mood="curiosity", reaction="nod", camera="bust")`
- `vrm_avatar(action="status")`
- `vrm_avatar(action="clips")`
- `vrm_avatar(action="sync_psfn")`

## Disclosure (Catalog Rule 13)

- **Local Storage**: Stores avatar state (`avatar_state.json`) and user-uploaded `.vrm` / `.glb` files in Hermes's profile-scoped plugin data directory (`<HERMES_HOME>/plugin-data/hermes-psfn-avatar/`), and caches the default VRM model in browser IndexedDB (`hermes-psfn-avatar-vrm-cache`).
- **Pinned Static Asset Fetches (`raw.githubusercontent.com`)**:
  - Fetches the default **DeepSeek-chan VRM 1.0** model from `https://raw.githubusercontent.com/tegnike/deepseek-chan-vrm/3aceb037df7a8b8126efea89d3a75664d1af868d/DeepSeek-chan.vrm` (verified against SHA-256 `9fa455e48ee2271dc7c2b62f2f2edcd47709406ca89067b6f544979589958f42` before caching in `plugin-data` / IndexedDB; falls back to the procedural 3D Holo-Rig offline). Credits (CC BY-NC-SA 4.0): original character "溟月" by 上善无形, maid outfit design by ZipZipPipe, 3D VRM model by ニケ (`tegnike`).
  - In standalone Desktop mode when the gateway FastAPI plugin route (`/api/plugins/hermes-psfn-avatar/clips/*`) is not mounted, fetches the 42 baked motion-capture JSON clips from `https://raw.githubusercontent.com/axAilotl/hermes-psfn-avatar/7b9a7f7f677b2fd25ed889b56e5ec83055202463/clips/`.
- **Loopback PSFN Lite Continuity Bridge**: When `psfn_lite_bridge` is enabled and `$HERMES_HOME/psfn-lite.json` defines a loopback (`127.0.0.1` / `localhost` / `::1`) `garden.url`, queries `GET <garden.url>/api/lite/overview` using the profile's secret scope (`agent.secret_scope.get_secret`) to read the companion's VAD and GoEmotions state; non-loopback URLs are refused.
- **No Shell Execution or Background Daemons**: Spawns no subprocesses, shell commands, or external daemons, and collects no telemetry.
