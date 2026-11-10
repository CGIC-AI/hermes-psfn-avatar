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
  Euler,
  HemisphereLight,
  MathUtils,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
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
import { sampleTtsAudio } from './tts-audio-tap.ts';
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

  // Audio / live TTS clock shared with CompanionPlayer
  const audioClock: AudioClockAdapter = {
    speechTime: null,
    speechLevel: 0,
  };
  let speechPhaseSec = 0;
  let smoothedSpeechLevel = 0;
  let speechBrightness = 0.35;

  // 3D Gaze Target & Cursor Tracking State
  const lookAtTarget = new Object3D();
  scene.add(lookAtTarget);
  const gazeRestQuats = new Map<string, Quaternion>();
  const scratchEuler = new Euler(0, 0, 0, 'YXZ');
  const scratchQuat = new Quaternion();
  const scratchCamRight = new Vector3();
  const scratchCamUp = new Vector3();

  let pointerClientX = 0;
  let pointerClientY = 0;
  let lastPointerMoveMs = -Infinity;
  let hasPointer = false;
  let glanceWeight = 0;
  let lookX = 0;
  let lookY = 0;
  let eyeLookX = 0;
  let eyeLookY = 0;

  const onWindowPointerMove = (ev: { clientX: number; clientY: number }): void => {
    if (typeof ev.clientX === 'number' && typeof ev.clientY === 'number') {
      const moved = Math.hypot(ev.clientX - pointerClientX, ev.clientY - pointerClientY);
      pointerClientX = ev.clientX;
      pointerClientY = ev.clientY;
      hasPointer = true;
      if (moved >= 2) {
        lastPointerMoveMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      }
    }
  };
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pointermove', onWindowPointerMove, { passive: true });
    window.addEventListener('mousemove', onWindowPointerMove, { passive: true });
  }

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
  let moodHoldSec = 0;
  let moodPulseWeight = 0;
  let activePulsePreset: (typeof PRESET_EXPRESSIONS)[number] | null = null;

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
    const isVrm0 = currentVrm?.meta?.metaVersion === '0';
    return {
      getValue: (name: string) => {
        const lower = name.toLowerCase();
        if (customMoodWeights.has(lower)) {
          return customMoodWeights.get(lower) ?? 0;
        }
        const direct = em.getValue(name);
        if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
        return 0;
      },
      setValue: (name: string, val: number) => {
        const lower = name.toLowerCase();
        const clamped = Math.max(0, Math.min(1, Number.isFinite(val) ? val : 0));
        // On VRM 0.x (VRoid), 'joy'/'happy' is a full-face closed-eye grin blendshape;
        // scale it down so expressions produce a gentle smile instead of a permanent squint.
        const directWeight =
          isVrm0 && (lower === 'happy' || lower === 'joy' || lower === 'relaxed' || lower === 'fun')
            ? clamped * 0.38
            : clamped;
        em.setValue(name, directWeight);

        const mapped = MOOD_TO_VRM_PRESET[lower];
        if (mapped) {
          if (clamped <= 0.001) {
            customMoodWeights.delete(lower);
          } else {
            customMoodWeights.set(lower, clamped);
          }
          let maxForMapped = 0;
          for (const [k, v] of customMoodWeights) {
            if (MOOD_TO_VRM_PRESET[k] === mapped && v > maxForMapped) {
              maxForMapped = v;
            }
          }
          const presetScale = isVrm0 && (mapped === 'happy' || mapped === 'relaxed') ? 0.36 : 0.6;
          em.setValue(mapped, maxForMapped * presetScale);
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

  function captureGazeRestPose(): void {
    gazeRestQuats.clear();
    for (const boneName of ['upperChest', 'neck', 'head', 'leftEye', 'rightEye']) {
      const node = getBoneNode(boneName);
      if (node) {
        gazeRestQuats.set(boneName, node.quaternion.clone());
      }
    }
    if (currentVrm?.lookAt) {
      currentVrm.lookAt.target = lookAtTarget;
      currentVrm.lookAt.autoUpdate = true;
    }
  }

  async function loadHoloModel(): Promise<void> {
    const generation = ++loadGeneration;
    clearCurrentModel();
    const holo = createHoloAvatar();
    holoAvatar = holo;
    currentFormat = 'Holo-Rig 3D';
    scene.add(holo.scene);
    computeModelBounds(holo.scene);
    captureGazeRestPose();
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
    captureGazeRestPose();
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
      if (lastAppliedMood && lastAppliedMood !== state.mood) {
        expr.setValue(lastAppliedMood, 0);
      }
      if (force) {
        // On initial model load, always start with a clean neutral resting face
        for (const name of PRESET_EXPRESSIONS) {
          expr.setValue(name, 0);
        }
        if (state.mood && state.mood !== 'neutral') {
          expr.setValue(state.mood, 0);
        }
        moodHoldSec = 0;
        moodPulseWeight = 0;
        activePulsePreset = null;
      } else if (state.mood !== lastAppliedMood || state.reaction !== lastAppliedReaction) {
        const preset = VRM_PRESET_FOR_BASE[state.emotionalBase];
        if (preset && state.mood !== 'neutral') {
          activePulsePreset = preset;
          moodHoldSec = 2.4;
        } else {
          moodHoldSec = 0;
        }
      }
      lastAppliedMood = state.mood;
    }

    const isThinkingOrTool = state.activity === 'thinking' || state.activity === 'tool';
    if (isThinkingOrTool && companionPlayer?.mode === 'preview' && !state.reaction) {
      companionPlayer.setMode('auto');
    }

    if (force) {
      lastAppliedClipFile = state.clipFile;
      lastAppliedReaction = state.reaction;
      return;
    }

    if (
      state.clipFile &&
      !isThinkingOrTool &&
      (state.clipFile !== lastAppliedClipFile || state.reaction !== lastAppliedReaction)
    ) {
      lastAppliedClipFile = state.clipFile;
      lastAppliedReaction = state.reaction;
      if (state.clipFile !== 'Neutral_Idle_01.json') {
        void playClipByFile(state.clipFile, false);
      }
    }
  }

  function updateSpeechClock(dt: number): void {
    // Drive talking animation & mouth visemes exclusively from live TTS audio playback
    const tts = sampleTtsAudio(dt);
    if (tts.speaking && !state.muted) {
      if (companionPlayer?.mode === 'preview' && !state.reaction) {
        companionPlayer.setMode('auto');
      }
      speechPhaseSec += dt;
      audioClock.speechTime = speechPhaseSec;
      const alpha = Math.min(1, Math.max(0.2, dt * 28));
      smoothedSpeechLevel += (tts.level - smoothedSpeechLevel) * alpha;
      speechBrightness += (tts.brightness - speechBrightness) * alpha;
      audioClock.speechLevel = Math.max(0.06, Math.min(1.0, smoothedSpeechLevel));
      return;
    }

    smoothedSpeechLevel = Math.max(0, smoothedSpeechLevel - dt * 10);
    audioClock.speechTime = smoothedSpeechLevel > 0.02 ? speechPhaseSec : null;
    audioClock.speechLevel = smoothedSpeechLevel > 0.02 ? smoothedSpeechLevel : 0;
  }

  function applyCursorGaze(dt: number, expr: ExpressionAdapter | null): void {
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const sinceMoveSec = Math.max(0, (nowMs - lastPointerMoveMs) / 1000);
    const speaking = audioClock.speechTime !== null;

    // Most of the time (and always while speaking), look straight out at the user on the other side of the monitor.
    // Only glance lightly toward the cursor while it is actively moving (within ~1.3s), then return to center.
    const wantGlance = !speaking && hasPointer && sinceMoveSec < 1.3 ? 0.34 : 0;
    const glanceRate = wantGlance > glanceWeight ? 4.5 : 2.8;
    glanceWeight += (wantGlance - glanceWeight) * (dt > 0 ? Math.min(1, dt * glanceRate) : 1);

    let rawX = 0;
    let rawY = 0;
    if (hasPointer && typeof window !== 'undefined' && typeof canvas.getBoundingClientRect === 'function') {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const headAnchorX = rect.left + rect.width * 0.5;
        const headRatioY =
          state.cameraPreset === 'bust' ? 0.34 : state.cameraPreset === 'waist' ? 0.26 : 0.18;
        const headAnchorY = rect.top + rect.height * headRatioY;
        const spanX = Math.max(240, (window.innerWidth || 800) * 0.42);
        const spanY = Math.max(200, (window.innerHeight || 600) * 0.42);
        rawX = MathUtils.clamp((pointerClientX - headAnchorX) / spanX, -1, 1);
        rawY = MathUtils.clamp((pointerClientY - headAnchorY) / spanY, -1, 1);
      }
    }

    const targetX = rawX * glanceWeight;
    const targetY = rawY * glanceWeight;

    const headLerp = dt > 0 ? Math.min(1, dt * 6.5) : 1;
    const eyeLerp = dt > 0 ? Math.min(1, dt * 14.0) : 1;
    lookX += (targetX - lookX) * headLerp;
    lookY += (targetY - lookY) * headLerp;
    eyeLookX += (targetX * 1.35 - eyeLookX) * eyeLerp;
    eyeLookY += (targetY * 1.35 - eyeLookY) * eyeLerp;

    const dir = currentVrm?.meta?.metaVersion === '0' ? -1 : 1;
    const upperChest = getBoneNode('upperChest');
    const neck = getBoneNode('neck');
    const head = getBoneNode('head');
    const leftEye = getBoneNode('leftEye');
    const rightEye = getBoneNode('rightEye');

    if (upperChest) {
      if (!clipPlayer?.playing) {
        const rest = gazeRestQuats.get('upperChest');
        if (rest) upperChest.quaternion.copy(rest);
      }
      scratchEuler.set(dir * lookY * 0.06, lookX * 0.09, 0, 'YXZ');
      upperChest.quaternion.multiply(scratchQuat.setFromEuler(scratchEuler));
    }

    if (neck) {
      if (!clipPlayer?.playing) {
        const rest = gazeRestQuats.get('neck');
        if (rest) neck.quaternion.copy(rest);
      }
      scratchEuler.set(dir * lookY * 0.14, lookX * 0.22, dir * (-lookX * 0.04), 'YXZ');
      neck.quaternion.multiply(scratchQuat.setFromEuler(scratchEuler));
    }

    if (head) {
      if (!clipPlayer?.playing) {
        const rest = gazeRestQuats.get('head');
        if (rest) head.quaternion.copy(rest);
        const speaking = audioClock.speechTime !== null;
        const idlePitch =
          state.activity === 'thinking' || state.activity === 'tool'
            ? -0.1 + Math.sin(elapsedSec * 2.0) * 0.03
            : speaking
              ? Math.sin(elapsedSec * 6.5) * 0.04
              : Math.sin(elapsedSec * 1.4) * 0.02;
        const idleYaw = Math.sin(elapsedSec * 1.1) * 0.04;
        scratchEuler.set(dir * idlePitch, idleYaw, 0, 'YXZ');
        head.quaternion.multiply(scratchQuat.setFromEuler(scratchEuler));
      }
      scratchEuler.set(dir * lookY * 0.24, lookX * 0.34, dir * (-lookX * 0.06), 'YXZ');
      head.quaternion.multiply(scratchQuat.setFromEuler(scratchEuler));
    }

    // Eye bone rotation (relative to rest pose so it never accumulates across frames)
    for (const [eyeName, eyeNode] of [
      ['leftEye', leftEye],
      ['rightEye', rightEye],
    ] as const) {
      if (!eyeNode) continue;
      const rest = gazeRestQuats.get(eyeName);
      if (rest) eyeNode.quaternion.copy(rest);
      scratchEuler.set(dir * eyeLookY * 0.16, eyeLookX * 0.25, 0, 'YXZ');
      eyeNode.quaternion.multiply(scratchQuat.setFromEuler(scratchEuler));
    }

    // Position 3D lookAtTarget on the camera plane in front of the avatar for VRMLookAt
    scratchCamRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
    scratchCamUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    lookAtTarget.position
      .copy(camera.position)
      .addScaledVector(scratchCamRight, eyeLookX * 1.2)
      .addScaledVector(scratchCamUp, -eyeLookY * 0.9);
    lookAtTarget.updateMatrixWorld(true);

    // Also set lookLeft / lookRight / lookUp / lookDown expressions for morph-based VRM eyes & Holo-Rig
    if (expr) {
      expr.setValue('lookRight', Math.max(0, eyeLookX));
      expr.setValue('lookLeft', Math.max(0, -eyeLookX));
      expr.setValue('lookUp', Math.max(0, -eyeLookY));
      expr.setValue('lookDown', Math.max(0, eyeLookY));
    }
  }

  function drawFrame(dt: number): void {
    if (disposed || !state.active || width <= 0 || height <= 0) return;

    updateSpeechClock(dt);

    const expr = getExpressionAdapter();
    if (companionPlayer) {
      companionPlayer.update(dt, {
        thinking: state.activity === 'thinking' || state.activity === 'tool',
        listening: state.activity === 'listening',
        enabled: state.animated,
      });
    }

    if (expr) {
      const speaking = audioClock.speechTime !== null;
      // Smoothly pulse and decay facial mood preset back to neutral so the face never gets stuck in a smile
      if (moodHoldSec > 0 && !speaking) {
        moodHoldSec = Math.max(0, moodHoldSec - dt);
        moodPulseWeight = Math.min(1, moodPulseWeight + (dt > 0 ? dt * 4.0 : 1));
      } else {
        moodHoldSec = 0;
        moodPulseWeight = Math.max(0, moodPulseWeight - (dt > 0 ? dt * 2.5 : 1));
      }
      for (const name of PRESET_EXPRESSIONS) {
        if (name === activePulsePreset && moodPulseWeight > 0.001) {
          expr.setValue(name, moodPulseWeight * 0.45);
        } else if (customMoodWeights.size === 0) {
          expr.setValue(name, 0);
        }
      }
      if (moodPulseWeight <= 0.001) {
        activePulsePreset = null;
      }

      // Natural periodic blink every 4.4s
      const blink = state.animated
        ? Math.max(0, 1 - Math.abs(((elapsedSec % 4.4) - 4.1) / 0.11))
        : 0;
      expr.setValue('blink', state.emotionalBase === 'asleep' ? 1 : blink);
      // Secondary VRM 1.0 & 0.x vowel visemes driven by live TTS amplitude & brightness
      const lvl = audioClock.speechLevel;
      expr.setValue('aa', speaking ? Math.min(1, lvl * 0.95) : 0);
      expr.setValue(
        'ih',
        speaking ? Math.max(0, lvl * speechBrightness * (0.45 + 0.35 * Math.sin(speechPhaseSec * 14.0))) : 0,
      );
      expr.setValue(
        'ou',
        speaking ? Math.max(0, lvl * (1 - speechBrightness * 0.5) * (0.4 + 0.3 * Math.cos(speechPhaseSec * 11.0))) : 0,
      );
      expr.setValue(
        'ee',
        speaking ? Math.max(0, lvl * speechBrightness * (0.3 + 0.25 * Math.cos(speechPhaseSec * 17.0))) : 0,
      );
      expr.setValue(
        'oh',
        speaking ? Math.max(0, lvl * (0.35 + 0.25 * Math.sin(speechPhaseSec * 9.5))) : 0,
      );
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
      if (lUpper) {
        lUpper.rotation.z = dir * (-1.02 + Math.sin(elapsedSec * 1.6) * 0.03);
        lUpper.rotation.x = speaking ? Math.sin(elapsedSec * 5.2) * 0.14 : 0.06;
      }
      if (rUpper) {
        rUpper.rotation.z = waving
          ? dir * (-2.1 + Math.sin(elapsedSec * 9.0) * 0.25)
          : dir * (1.02 - Math.sin(elapsedSec * 1.6) * 0.03);
        rUpper.rotation.x = speaking ? Math.cos(elapsedSec * 4.8) * 0.14 : 0.06;
      }
      if (lLower) lLower.rotation.z = speaking ? 0.25 + Math.sin(elapsedSec * 6.0) * 0.12 : 0.12;
      if (rLower) rLower.rotation.z = waving ? -0.45 + Math.sin(elapsedSec * 10.0) * 0.3 : speaking ? -0.25 : -0.12;
      if (chest) {
        chest.rotation.x = Math.sin(elapsedSec * 1.7) * 0.025;
        chest.rotation.y = Math.sin(elapsedSec * 0.8) * 0.04;
      }
    }

    applyCursorGaze(dt, expr);
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
      orbitYaw = orbitYaw + deltaYaw;
      orbitPitch = MathUtils.clamp(orbitPitch + deltaPitch, -0.75, 0.85);
      applyCameraFraming();
      if (!disposed && state.active && width > 0 && height > 0) {
        renderer.render(scene, camera);
      }
    },
    nudgeZoom(factor: number): void {
      orbitZoom = MathUtils.clamp(orbitZoom * factor, 0.55, 2.2);
      applyCameraFraming();
      if (!disposed && state.active && width > 0 && height > 0) {
        renderer.render(scene, camera);
      }
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
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('pointermove', onWindowPointerMove);
        window.removeEventListener('mousemove', onWindowPointerMove);
      }
      stopLoop();
      resizeObserver?.disconnect();
      clearCurrentModel();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
