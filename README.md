# hermes-psfn-avatar — 3D VRM VTuber & Companion Avatar for Hermes Agent

`hermes-psfn-avatar` brings a live 3D VRM 0.x / 1.0 VTuber avatar directly into **Hermes Desktop** and the **Hermes Web Dashboard** as a transparent corner overlay, dockable stage pane, and full 3D motion studio—powered by **Three.js** and **`@pixiv/three-vrm`**.

Built as a standalone plugin for any Hermes Agent user, with a zero-config emotional continuity bridge to **PSFN Lite** (`psfn_lite`) when installed in the same Hermes profile.

## Features

- **Floating VTuber Corner Overlay & Dockable Stage Pane**:
  - Sits in any corner of Hermes Desktop (`bottom-right`, `bottom-left`, `top-right`, `top-left`) with a transparent WebGL canvas (`alpha: true`), framed on the character's upper-body bust (`bust`), waist-up (`waist`), or full body (`full`).
  - Click-through background with interactive anatomical touch zones (`headpat`, `petting`, `cheek boop`, `hug`), drag-to-reposition on the avatar silhouette, `Shift+drag` or `Right-drag` smooth 360° 3D camera orbit, scroll-wheel zoom, and a persistent hover Mini-HUD with one-click toggle to dock into a right-hand layout pane.
  - Also populates the `overlay` shell slot and `/vrm-avatar` Studio tab in the **Hermes Web Dashboard**.
- **On-Demand VRM Download Catalog (4 Models) & Custom `.vrm` / `.glb` Upload**:
  - Defaults to **Nous-Girl** (`Nous-Girl.vrm`, CGIC assembly; see [`CGIC-AI/nous-girl-vrm/LICENSE.md`](https://github.com/CGIC-AI/nous-girl-vrm/blob/70bfc01c3bbc105267612f94486e0e7ee1b5a7d6/LICENSE.md)) and includes a commit-pinned, SHA-256-verified on-demand download catalog: **DeepSeek-chan** ([CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)) plus **Claude** (`claude.vrm`) and **Claude Suit** (`claude_suit.vrm`) from [`SkyeShark/eidoverse-video`](https://github.com/SkyeShark/eidoverse-video/tree/main/eidoverse/assets/vrms).
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
  - **Nous-Girl (Default Model)**: Fetched on demand from `https://raw.githubusercontent.com/CGIC-AI/nous-girl-vrm/70bfc01c3bbc105267612f94486e0e7ee1b5a7d6/nous-girl.vrm` and verified against SHA-256 `34c72ebaf068f3d692c29e5b1878b42e0039f63a2b0679aab18bb365b4abc275` (`11,491,924` bytes) before caching in `plugin-data` / IndexedDB. Created by CGIC (base body/face derived from VRoid `AvatarSample_A` under its conditions of use; procedural hair, headphones, and outfit built in Blender; see [`CGIC-AI/nous-girl-vrm/LICENSE.md`](https://github.com/CGIC-AI/nous-girl-vrm/blob/70bfc01c3bbc105267612f94486e0e7ee1b5a7d6/LICENSE.md)).
  - **DeepSeek-chan (Optional Preset, CC BY-NC-SA 4.0)**: Fetched on demand when selected from `https://raw.githubusercontent.com/tegnike/deepseek-chan-vrm/3aceb037df7a8b8126efea89d3a75664d1af868d/DeepSeek-chan.vrm` and verified against SHA-256 `9fa455e48ee2271dc7c2b62f2f2edcd47709406ca89067b6f544979589958f42` before caching. Credits ([CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)): original character **溟月 (Mingyue)** by **上善无形** ([Bilibili](https://www.bilibili.com/opus/1231977657712771073)), maid outfit design by **ZipZipPipe** ([Bilibili](https://t.bilibili.com/1231980045693616162)), 3D VRM model by **ニケ (`tegnike`)** ([Hugging Face / GitHub](https://huggingface.co/datasets/ikechan8370/vrm-models/blob/main/DeepSeek-chan.vrm)).
  - **Eidoverse 3rd-Party VRM Catalog (Optional Presets)**: Fetched on demand when selected from commit-pinned `https://raw.githubusercontent.com/SkyeShark/eidoverse-video/404a00e7db3068af51bd914d61e608e6b8dc9b82/eidoverse/assets/vrms/<file>.vrm` (`claude.vrm` SHA-256 `883eb1d6c63c7409e1cbebb335509af346e92d046c4c9916ebc7695da4c64073` and `claude_suit.vrm` SHA-256 `7be6286215c0d7e4251633ec741d9f5bde943dc635f05a312ca7d1b45bceaa5d`) and verified against each file's SHA-256 digest before caching in IndexedDB.
  - **Motion Clips Fallback**: In standalone Desktop mode when the gateway FastAPI plugin route (`/api/plugins/hermes-psfn-avatar/clips/*`) is not mounted, fetches the 42 baked motion-capture JSON clips from `https://raw.githubusercontent.com/axAilotl/hermes-psfn-avatar/7b9a7f7f677b2fd25ed889b56e5ec83055202463/clips/`.
- **Loopback PSFN Lite Continuity Bridge**: When `psfn_lite_bridge` is enabled and `$HERMES_HOME/psfn-lite.json` defines a loopback (`127.0.0.1` / `localhost` / `::1`) `garden.url`, queries `GET <garden.url>/api/lite/overview` using the profile's secret scope (`agent.secret_scope.get_secret`) to read the companion's VAD and GoEmotions state; non-loopback URLs are refused.
- **No Shell Execution or Background Daemons**: Spawns no subprocesses, shell commands, or external daemons, and collects no telemetry.
