/**
 * Transparent Three.js WebGL VTuber & Companion Stage Renderer.
 *
 * Drives either the built-in articulated Persephone Holo-Rig or any user-supplied
 * VRM 0.x / 1.0 / GLB model with the 42 baked ARDY motion clips, 27 GoEmotions
 * mood envelopes, lip-sync, and Bust / Waist / Full camera framing presets.
 */

import {
  AnimationMixer,
  Box3,
  DirectionalLight,
  HemisphereLight,
  MathUtils,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from 'three';
import { VRM } from '@pixiv/three-vrm';
import { createCompanionMotion, type CompanionMotionHandle } from './companion-motion.ts';
import {
  CompanionPlayer,
  type AudioClockAdapter,
  type ClipManifestEntry,
  type ExpressionAdapter,
} from './companion-player.ts';
import { VRM_PRESET_FOR_BASE, type EmotionalBase } from './emotion-mapping.ts';
import { createHoloAvatar, type HoloAvatarHandle } from './holo-avatar.ts';
import { disposeAvatarScenes, loadAvatarFromArrayBuffer, LocalAvatarError } from './load-avatar.ts';
import { VrmClipPlayer, type BakedMotionClip, type ClipFetcher } from './vrm-clip-player.ts';

export type CameraPreset = 'bust' | 'waist' | 'full';

export interface StagePlaybackState {
  readonly active: boolean;
  readonly animated: boolean;
  readonly activity: 'idle' | 'thinking' | 'listening' | 'talking' | 'tool';
  readonly mood: string;
  readonly emotionalBase: EmotionalBase;
  readonly reaction: string | null;
  readonly clipFile: string | null;
  readonly cameraPreset: CameraPreset;
  readonly speechText: string;
  readonly speechId: number;
  readonly muted: boolean;
}

export interface StageRendererOptions {
  readonly canvas: HTMLCanvasElement;
  readonly fetchClip: ClipFetcher;
  readonly fetchClipsManifest: () => Promise<ClipManifestEntry[]>;
  readonly onStatus?: (info: { format: string; state: string; error?: string }) => void;
}

export interface StageRendererHandle {
  updateState(next: StagePlaybackState): void;
  loadHoloModel(): Promise<void>;
  loadVrmBuffer(buffer: ArrayBuffer, label?: string): Promise<void>;
  playClipByFile(clipFile: string, loop?: boolean): Promise<void>;
  nudgeOrbit(deltaYaw: number, deltaPitch: number): void;
  nudgeZoom(factor: number): void;
  resetCamera(): void;
  dispose(): void;
}

const PRESET_EXPRESSIONS = ['happy', 'relaxed', 'surprised', 'sad', 'angry'] as const;

export function createStageRenderer(options: StageRendererOptions): StageRendererHandle {
  const { canvas, fetchClip, fetchClipsManifest, onStatus } = options;

  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'low-power',
    });
  } catch {
    throw new LocalAvatarError('3D WebGL rendering is unavailable on this device.');
  }
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  const hemiLight = new HemisphereLight(0xffffff, 0x334155, 1.45);
  scene.add(hemiLight);

  const keyLight = new DirectionalLight(0xfff8f0, 1.85);
  keyLight.position.set(1.4, 2.4, 2.2);
  scene.add(keyLight);

  const rimLight = new DirectionalLight(0x5eead4, 0.85);
  rimLight.position.set(-1.5, 1.8, -1.6);
  scene.add(rimLight);

  const camera = new PerspectiveCamera(26, 1, 0.05, 50);

  // Audio / syllable cadence clock shared with CompanionPlayer
  const audioClock: AudioClockAdapter = {
    speechTime: null,
    speechLevel: 0,
  };
  let speechRemainingSec = 0;
  let speechPhaseSec = 0;
  let lastSpeechId = -1;

  // Model & animation handles
  let disposed = false;
  let loadGeneration = 0;
  let currentFormat = 'Holo-Rig';
  let holoAvatar: HoloAvatarHandle | null = null;
  let currentVrm: VRM | null = null;
  let currentSceneRoots: Object3D[] = [];
  let gltfMixer: AnimationMixer | null = null;
  let companionMotion: CompanionMotionHandle | null = null;
  let clipPlayer: VrmClipPlayer | null = null;
  let companionPlayer: CompanionPlayer | null = null;
  let clipLibrary: ClipManifestEntry[] = [];

  // Bounds & camera orbit
  let modelMinY = 0;
  let modelHeight = 1.65;
  let modelCenterX = 0;
  let modelCenterZ = 0;
  let orbitYaw = 0;
  let orbitPitch = 0.03;
  let orbitZoom = 1.0;

  let state: StagePlaybackState = {
    active: true,
    animated: true,
    activity: 'idle',
    mood: 'neutral',
    emotionalBase: 'neutral',
    reaction: null,
    clipFile: null,
    cameraPreset: 'bust',
    speechText: '',
    speechId: 0,
    muted: false,
  };

  let lastAppliedMood = 'neutral';
  let lastAppliedClipFile: string | null = null;
  let lastAppliedReaction: string | null = null;

  let rafId: number | null = null;
  let lastFrameMs: number | null = null;
  let elapsedSec = 0;
  let width = 0;
  let height = 0;

  function getBoneNode(name: string): Object3D | null {
    if (holoAvatar) return holoAvatar.getBoneNode(name);
    const h = currentVrm?.humanoid;
    if (!h) return null;
    return h.getNormalizedBoneNode(name as Parameters<typeof h.getNormalizedBoneNode>[0]);
  }

  const customMoodWeights = new Map<string, number>();
  const MOOD_TO_VRM_PRESET: Readonly<Record<string, 'happy' | 'relaxed' | 'surprised' | 'sad' | 'angry'>> = {
    admiration: 'happy',
    amusement: 'happy',
    anger: 'angry',
    annoyance: 'angry',
    approval: 'relaxed',
    caring: 'relaxed',
    confusion: 'surprised',
    curiosity: 'surprised',
    desire: 'happy',
    disappointment: 'sad',
    disapproval: 'angry',
    disgust: 'angry',
    embarrassment: 'relaxed',
    excitement: 'happy',
    fear: 'sad',
    gratitude: 'happy',
    grief: 'sad',
    joy: 'happy',
    love: 'happy',
    nervousness: 'sad',
    optimism: 'happy',
    pride: 'happy',
    realization: 'surprised',
    relief: 'relaxed',
    remorse: 'sad',
    sadness: 'sad',
    surprise: 'surprised',
  };

  function getExpressionAdapter(): ExpressionAdapter | null {
    if (holoAvatar) return holoAvatar.expressionManager;
    const em = currentVrm?.expressionManager;
    if (!em) return null;
    return {
      getValue: (name: string) => {
        const direct = em.getValue(name);
        if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
        return customMoodWeights.get(name.toLowerCase()) ?? 0;
      },
      setValue: (name: string, val: number) => {
        em.setValue(name, val);
        const mapped = MOOD_TO_VRM_PRESET[name.toLowerCase()];
        if (mapped) {
          customMoodWeights.set(name.toLowerCase(), val);
          em.setValue(mapped, Math.max(em.getValue(mapped) ?? 0, val * 0.85));
        }
      },
      resetValues: () => {
        customMoodWeights.clear();
        em.resetValues();
      },
    };
  }
  function computeModelBounds(root: Object3D): void {
    root.updateMatrixWorld(true);
    const box = new Box3().setFromObject(root);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    if (Number.isFinite(size.y) && size.y > 0.1) {
      modelMinY = box.min.y;
      modelHeight = Math.max(0.5, size.y);
      modelCenterX = center.x;
      modelCenterZ = center.z;
    } else {
      modelMinY = 0;
      modelHeight = 1.65;
      modelCenterX = 0;
      modelCenterZ = 0;
    }
  }

  function applyCameraFraming(): void {
    if (disposed) return;
    const preset = state.cameraPreset;
    // VTuber Bust frames head + chest + shoulders (top 38% of height);
    // Waist frames upper 60%; Full frames 100%.
    let targetRatioY = 0.79;
    let spanRatio = 0.42;
    if (preset === 'waist') {
      targetRatioY = 0.65;
      spanRatio = 0.64;
    } else if (preset === 'full') {
      targetRatioY = 0.52;
      spanRatio = 1.06;
    }

    const headNode = getBoneNode('head');
    const chestNode = getBoneNode('upperChest') ?? getBoneNode('chest');
    const hipsNode = getBoneNode('hips');
    let targetX = modelCenterX;
    let targetY = modelMinY + modelHeight * targetRatioY;
    let targetZ = modelCenterZ;
    if (headNode && chestNode) {
      const headPos = headNode.getWorldPosition(new Vector3());
      const chestPos = chestNode.getWorldPosition(new Vector3());
      if (Number.isFinite(headPos.y) && Number.isFinite(chestPos.y)) {
        targetX = chestPos.x * 0.5 + headPos.x * 0.5;
        targetZ = chestPos.z * 0.5 + headPos.z * 0.5;
        if (preset === 'bust') {
          targetY = chestPos.y * 0.42 + headPos.y * 0.58;
        } else if (preset === 'waist' && hipsNode) {
          const hipsPos = hipsNode.getWorldPosition(new Vector3());
          targetY = hipsPos.y * 0.45 + headPos.y * 0.55;
        }
      }
    }

    const visibleHeight = modelHeight * spanRatio;
    const halfFovRad = MathUtils.degToRad(camera.fov / 2);
    const baseDist = (visibleHeight / (2 * Math.tan(halfFovRad))) * 1.05;
    const dist = Math.max(0.35, baseDist * orbitZoom);

    const cosP = Math.cos(orbitPitch);
    const sinP = Math.sin(orbitPitch);
    const sinY = Math.sin(orbitYaw);
    const cosY = Math.cos(orbitYaw);

    camera.position.set(
      targetX + dist * cosP * sinY,
      targetY + dist * sinP,
      targetZ + dist * cosP * cosY,
    );
    camera.lookAt(targetX, targetY, targetZ);
    camera.updateProjectionMatrix();
  }

  function clearCurrentModel(): void {
    companionPlayer?.dispose();
    companionPlayer = null;
    clipPlayer = null;
    companionMotion = null;
    if (gltfMixer) {
      gltfMixer.stopAllAction();
      gltfMixer = null;
    }
    if (holoAvatar) {
      scene.remove(holoAvatar.scene);
      holoAvatar.dispose();
      holoAvatar = null;
    }
    if (currentSceneRoots.length > 0) {
      disposeAvatarScenes(currentSceneRoots);
      currentSceneRoots = [];
    }
    currentVrm = null;
  }

  async function ensureClipLibrary(): Promise<ClipManifestEntry[]> {
    if (clipLibrary.length > 0) return clipLibrary;
    try {
      const list = await fetchClipsManifest();
      clipLibrary = list.map((c) => ({
        ...c,
        url: c.url.split('/').pop() ?? c.url,
      }));
    } catch {
      clipLibrary = [];
    }
    return clipLibrary;
  }

  async function wireClipRuntime(generation: number): Promise<void> {
    const hips = getBoneNode('hips');
    const hipsRest = hips ? hips.position.clone() : null;
    const body = new VrmClipPlayer(getBoneNode, hipsRest, fetchClip);
    const player = new CompanionPlayer(body, getExpressionAdapter(), audioClock, {
      onState: (st, detail) => {
        onStatus?.({ format: currentFormat, state: detail ? `${st} · ${detail}` : st });
      },
    });
    clipPlayer = body;
    companionPlayer = player;

    const lib = await ensureClipLibrary();
    if (disposed || generation !== loadGeneration || !lib.length) return;
    await player.init(lib, true);
    if (disposed || generation !== loadGeneration) return;
    await player.select('Idle');
    applyMoodAndClipTriggers(true);
    drawFrame(0);
  }

  async function loadHoloModel(): Promise<void> {
    const generation = ++loadGeneration;
    clearCurrentModel();
    const holo = createHoloAvatar();
    holoAvatar = holo;
    currentFormat = 'Holo-Rig 3D';
    scene.add(holo.scene);
    computeModelBounds(holo.scene);
    applyCameraFraming();
    onStatus?.({ format: currentFormat, state: 'Idle' });
    await wireClipRuntime(generation);
  }

  async function loadVrmBuffer(buffer: ArrayBuffer, label = 'VRM Model'): Promise<void> {
    const generation = ++loadGeneration;
    const { gltf, vrm } = await loadAvatarFromArrayBuffer(buffer);
    if (disposed || generation !== loadGeneration) {
      disposeAvatarScenes(gltf.scenes);
      return;
    }
    let motion: CompanionMotionHandle | null = null;
    try {
      motion = await createCompanionMotion(gltf);
    } catch {
      motion = null;
    }
    if (disposed || generation !== loadGeneration) {
      disposeAvatarScenes(gltf.scenes);
      return;
    }

    clearCurrentModel();
    currentVrm = vrm;
    companionMotion = motion;
    currentSceneRoots = [...gltf.scenes];
    currentFormat = vrm ? `VRM ${vrm.meta.metaVersion === '0' ? '0.x' : '1.0'} · ${label}` : `GLB · ${label}`;
    scene.add(gltf.scene);

    if (gltf.animations.length > 0 && !vrm) {
      gltfMixer = new AnimationMixer(gltf.scene);
      gltfMixer.clipAction(gltf.animations[0]!).play();
    }

    computeModelBounds(gltf.scene);
    applyCameraFraming();
    onStatus?.({ format: currentFormat, state: 'Loaded' });
    await wireClipRuntime(generation);
  }

  async function playClipByFile(clipFile: string, loop = false): Promise<void> {
    if (!companionPlayer || !clipLibrary.length) return;
    const clean = clipFile.split('/').pop() ?? clipFile;
    const match = clipLibrary.find((c) => (c.url.split('/').pop() ?? c.url) === clean);
    const targetUrl = match ? match.url : clean;
    try {
      await companionPlayer.preview(targetUrl, loop);
    } catch {
      // Fall back to automatic idle/talking state if clip is missing
    }
  }

  function applyMoodAndClipTriggers(force = false): void {
    const expr = getExpressionAdapter();
    if (expr) {
      // Apply VRM preset base expression (happy, relaxed, surprised, sad, angry)
      const preset = VRM_PRESET_FOR_BASE[state.emotionalBase];
      for (const name of PRESET_EXPRESSIONS) {
        expr.setValue(name, name === preset ? 0.65 : 0);
      }
      // Also set custom 27-mood expression weight on models/holo-rigs that support it
      if (lastAppliedMood && lastAppliedMood !== state.mood) {
        expr.setValue(lastAppliedMood, 0);
      }
      if (state.mood && state.mood !== 'neutral') {
        expr.setValue(state.mood, 0.78);
      }
      lastAppliedMood = state.mood;
    }

    if (
      state.clipFile &&
      (force || state.clipFile !== lastAppliedClipFile || state.reaction !== lastAppliedReaction)
    ) {
      lastAppliedClipFile = state.clipFile;
      lastAppliedReaction = state.reaction;
      if (state.clipFile !== 'Neutral_Idle_01.json') {
        void playClipByFile(state.clipFile, false);
      }
    }
  }

  function updateSpeechClock(dt: number): void {
    if (state.speechId !== lastSpeechId && state.speechText.trim().length > 0) {
      lastSpeechId = state.speechId;
      // Estimate natural speaking duration from character count (~16 chars/sec, clamped 1.4s..7.0s)
      const chars = state.speechText.trim().length;
      speechRemainingSec = Math.max(1.4, Math.min(7.0, chars / 16));
      speechPhaseSec = 0;
    }
    if (state.activity === 'talking' && speechRemainingSec <= 0) {
      speechRemainingSec = 0.6;
    }
    if (speechRemainingSec > 0 && !state.muted) {
      speechRemainingSec = Math.max(0, speechRemainingSec - dt);
      speechPhaseSec += dt;
      audioClock.speechTime = speechPhaseSec;
      // Two-harmonic syllable cadence envelope (5.4 Hz + 8.7 Hz) -> realistic vowel opening
      const syllable =
        0.52 +
        0.32 * Math.sin(speechPhaseSec * Math.PI * 2 * 5.4) +
        0.22 * Math.sin(speechPhaseSec * Math.PI * 2 * 8.7);
      audioClock.speechLevel = Math.max(0.08, Math.min(0.95, syllable));
    } else {
      audioClock.speechTime = null;
      audioClock.speechLevel = 0;
    }
  }

  function drawFrame(dt: number): void {
    if (disposed || !state.active || width <= 0 || height <= 0) return;

    updateSpeechClock(dt);

    const expr = getExpressionAdapter();
    if (expr) {
      // Natural periodic blink every 4.4s
      const blink = state.animated
        ? Math.max(0, 1 - Math.abs(((elapsedSec % 4.4) - 4.1) / 0.11))
        : 0;
      expr.setValue('blink', state.emotionalBase === 'asleep' ? 1 : blink);
      // Secondary VRM 1.0 vowel visemes during speech
      const speaking = audioClock.speechTime !== null;
      expr.setValue('ih', speaking ? Math.max(0, Math.sin(speechPhaseSec * 14.0) * 0.35) : 0);
      expr.setValue('ou', speaking ? Math.max(0, Math.cos(speechPhaseSec * 11.0) * 0.3) : 0);
    }
    if (companionPlayer) {
      companionPlayer.update(dt, {
        thinking: state.activity === 'thinking' || state.activity === 'tool',
        listening: state.activity === 'listening',
        enabled: state.animated,
      });
    }

    if (!clipPlayer?.playing) {
      // Procedural humanoid stance + breathing + talking gestures when baked clips are still loading or offline
      const dir = currentVrm?.meta?.metaVersion === '0' ? -1 : 1;
      const speaking = audioClock.speechTime !== null;
      const waving = state.reaction === 'wave' || state.reaction === 'celebrate';
      const lUpper = getBoneNode('leftUpperArm');
      const rUpper = getBoneNode('rightUpperArm');
      const lLower = getBoneNode('leftLowerArm');
      const rLower = getBoneNode('rightLowerArm');
      const chest = getBoneNode('chest');
      const head = getBoneNode('head');
      if (lUpper) {
        lUpper.rotation.z = dir * (-1.18 + Math.sin(elapsedSec * 1.6) * 0.03);
        lUpper.rotation.x = speaking ? Math.sin(elapsedSec * 5.2) * 0.14 : 0.06;
      }
      if (rUpper) {
        rUpper.rotation.z = waving
          ? dir * (-2.1 + Math.sin(elapsedSec * 9.0) * 0.25)
          : dir * (1.18 - Math.sin(elapsedSec * 1.6) * 0.03);
        rUpper.rotation.x = speaking ? Math.cos(elapsedSec * 4.8) * 0.14 : 0.06;
      }
      if (lLower) lLower.rotation.z = speaking ? 0.25 + Math.sin(elapsedSec * 6.0) * 0.12 : 0.12;
      if (rLower) rLower.rotation.z = waving ? -0.45 + Math.sin(elapsedSec * 10.0) * 0.3 : speaking ? -0.25 : -0.12;
      if (chest) {
        chest.rotation.x = Math.sin(elapsedSec * 1.7) * 0.025;
        chest.rotation.y = Math.sin(elapsedSec * 0.8) * 0.04;
      }
      if (head) {
        head.rotation.y = Math.sin(elapsedSec * 1.1) * 0.07;
        head.rotation.x =
          state.activity === 'thinking'
            ? -0.12 + Math.sin(elapsedSec * 2.0) * 0.04
            : speaking
              ? Math.sin(elapsedSec * 6.5) * 0.05
              : Math.sin(elapsedSec * 1.4) * 0.025;
      }
    }
    companionMotion?.update(dt);
    gltfMixer?.update(dt);
    holoAvatar?.update(dt, elapsedSec);
    currentVrm?.update(dt);

    renderer.render(scene, camera);
  }

  function tick(nowMs: number): void {
    rafId = null;
    if (disposed || !state.active || !state.animated || width <= 0 || height <= 0) return;
    const dt = lastFrameMs === null ? 0 : Math.min((nowMs - lastFrameMs) / 1000, 0.05);
    lastFrameMs = nowMs;
    elapsedSec += dt;
    drawFrame(dt);
    if (!disposed) {
      rafId = requestAnimationFrame(tick);
    }
  }

  function stopLoop(): void {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    lastFrameMs = null;
  }

  function refreshLoop(): void {
    stopLoop();
    drawFrame(0);
    if (!disposed && state.active && state.animated && width > 0 && height > 0) {
      rafId = requestAnimationFrame(tick);
    }
  }

  function resize(): void {
    if (disposed) return;
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    if (width > 0 && height > 0) {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      applyCameraFraming();
    }
    refreshLoop();
  }

  const resizeObserver =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
  resizeObserver?.observe(canvas);
  resize();

  return {
    updateState(next: StagePlaybackState): void {
      if (disposed) return;
      const presetChanged = state.cameraPreset !== next.cameraPreset;
      const loopChanged = state.active !== next.active || state.animated !== next.animated;
      state = next;
      if (presetChanged) applyCameraFraming();
      applyMoodAndClipTriggers(false);
      if (loopChanged) refreshLoop();
      else if (!state.animated) drawFrame(0);
    },
    loadHoloModel,
    loadVrmBuffer,
    playClipByFile,
    nudgeOrbit(deltaYaw: number, deltaPitch: number): void {
      orbitYaw = MathUtils.clamp(orbitYaw + deltaYaw, -Math.PI * 0.65, Math.PI * 0.65);
      orbitPitch = MathUtils.clamp(orbitPitch + deltaPitch, -0.45, 0.55);
      applyCameraFraming();
      if (!state.animated) drawFrame(0);
    },
    nudgeZoom(factor: number): void {
      orbitZoom = MathUtils.clamp(orbitZoom * factor, 0.55, 2.2);
      applyCameraFraming();
      if (!state.animated) drawFrame(0);
    },
    resetCamera(): void {
      orbitYaw = 0;
      orbitPitch = 0.03;
      orbitZoom = 1.0;
      applyCameraFraming();
      if (!state.animated) drawFrame(0);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      stopLoop();
      resizeObserver?.disconnect();
      clearCurrentModel();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
