# hermes-psfn-avatar — 3D VRM VTuber & Companion Avatar for Hermes Agent

`hermes-psfn-avatar` brings a live 3D VRM 0.x / 1.0 VTuber avatar directly into **Hermes Desktop** and the **Hermes Web Dashboard** as a transparent corner overlay, dockable stage pane, and full 3D motion studio—powered by **Three.js** and **`@pixiv/three-vrm`**.

Built as a standalone plugin for any Hermes Agent user, with a zero-config emotional continuity bridge to **PSFN Lite** (`psfn_lite`) when installed in the same Hermes profile.

## Features

- **Floating VTuber Corner Overlay & Dockable Stage Pane**:
  - Sits in any corner of Hermes Desktop (`bottom-right`, `bottom-left`, `top-right`, `top-left`) with a transparent WebGL canvas (`alpha: true`), framed on the character's upper-body bust (`bust`), waist-up (`waist`), or full body (`full`).
  - Click-through background with interactive anatomical touch zones (`headpat`, `petting`, `cheek boop`, `hug`), drag-to-reposition on the avatar silhouette, `Shift+drag` or `Right-drag` smooth 360° 3D camera orbit, scroll-wheel zoom, and a persistent hover Mini-HUD with one-click toggle to dock into a right-hand layout pane.
  - Also populates the `overlay` shell slot and `/vrm-avatar` Studio tab in the **Hermes Web Dashboard**.
- **Curated VRM Presets (`Nous-Girl` Default + `DeepSeek-chan`) & Custom `.vrm` / `.glb` Upload**:
  - Defaults to **Nous-Girl** (`Nous-Girl.vrm`, Hermes / PSFN original assembly licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)) and includes one-click switching to **DeepSeek-chan** (`DeepSeek-chan.vrm`, licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)).
  - Upload any standard `.vrm` (VRM 0.x or VRM 1.0) or `.glb` file in the **VRM Avatar Studio** (`/vrm-avatar` or **Settings → Plugins → VRM Avatar**); models are validated locally and persisted in `<HERMES_HOME>/plugin-data/hermes-psfn-avatar/models/` and browser IndexedDB.
- **42 Baked ARDY Humanoid Motion-Capture Clips & 28 GoEmotions Moods**:
  - Ships 42 baked Core-27 skeletal motion clips in `clips/`: Idle, 4 auto-rotating Talking gesture variants, a 55-second Thinking choreography sequence (hand-to-chin pondering, calm breathing stances, gentle nods, and weighing-an-idea gestures), 2 Listening clips, 7 one-shot Reactions (`wave`, `nod`, `celebrate`, `thanks`, `reach`, `surprise`, `laugh`, `shrug`), and **27 discrete GoEmotions mood body performances** with 0.4s attack / 0.5s release facial blend envelopes.
  - Supports `psfn.companion-motion/1` VRM extras for custom ear/tail spring-bone pivots while keeping standard VRMs 100% compatible.
- **Live TTS Lip-Sync + Automatic Turn Reactivity + Agent-Driven Stage Directions**:
  - Automatically shifts between **Thinking** (during reasoning, streaming, and tool calls), **Talking** (driven by live TTS audio with 5-vowel `aa`/`ih`/`ou`/`ee`/`oh` lip-sync), and **Idle** (breathing, periodic blinking, spring-bone physics, and subtle eye/head gaze).
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

## Disclosure (Catalog Rule 13) & Model Attribution

- **Local Storage**: Stores avatar state (`avatar_state.json`) and user-uploaded `.vrm` / `.glb` files in Hermes's profile-scoped plugin data directory (`<HERMES_HOME>/plugin-data/hermes-psfn-avatar/`), and caches VRM models in browser IndexedDB (`hermes-psfn-avatar-vrm-cache`). No binary `.vrm` files are packaged inside this repository.
- **Pinned Static Asset Fetches (`raw.githubusercontent.com`)**:
  - **Nous-Girl (Default Model, CC BY-NC-SA 4.0)**: Fetched on demand from `https://raw.githubusercontent.com/axAilotl/nous-girl-vrm/82d3e874855040748a150080c3c142b6cd8cfc01/Nous-Girl.vrm` and verified against SHA-256 `a99c587d26f02012079f8f8aa6a6cdda5c99da626eee01e91bb65fbf4def3747` before caching in `plugin-data` / IndexedDB. Created by Vega / PSFN (VRoid `AvatarSample_A` base with procedural Blender hair, headphones, and outfit), licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).
  - **DeepSeek-chan (Optional Preset, CC BY-NC-SA 4.0)**: Fetched on demand when selected from `https://raw.githubusercontent.com/tegnike/deepseek-chan-vrm/3aceb037df7a8b8126efea89d3a75664d1af868d/DeepSeek-chan.vrm` and verified against SHA-256 `9fa455e48ee2271dc7c2b62f2f2edcd47709406ca89067b6f544979589958f42` before caching. Credits ([CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)): original character **溟月 (Mingyue)** by **上善无形** ([Bilibili](https://www.bilibili.com/opus/1231977657712771073)), maid outfit design by **ZipZipPipe** ([Bilibili](https://t.bilibili.com/1231980045693616162)), 3D VRM model by **ニケ (`tegnike`)** ([Hugging Face / GitHub](https://huggingface.co/datasets/ikechan8370/vrm-models/blob/main/DeepSeek-chan.vrm)).
  - **Motion Clips Fallback**: In standalone Desktop mode when the gateway FastAPI plugin route (`/api/plugins/hermes-psfn-avatar/clips/*`) is not mounted, fetches the 42 baked motion-capture JSON clips from `https://raw.githubusercontent.com/axAilotl/hermes-psfn-avatar/7b9a7f7f677b2fd25ed889b56e5ec83055202463/clips/`.
- **Loopback PSFN Lite Continuity Bridge**: When `psfn_lite_bridge` is enabled and `$HERMES_HOME/psfn-lite.json` defines a loopback (`127.0.0.1` / `localhost` / `::1`) `garden.url`, queries `GET <garden.url>/api/lite/overview` using the profile's secret scope (`agent.secret_scope.get_secret`) to read the companion's VAD and GoEmotions state; non-loopback URLs are refused.
- **No Shell Execution or Background Daemons**: Spawns no subprocesses, shell commands, or external daemons, and collects no telemetry.
