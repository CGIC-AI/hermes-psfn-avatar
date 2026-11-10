/**
 * hermes-psfn-avatar — Hermes Desktop Plugin (@hermes/plugin-sdk).
 *
 * Provides:
 * 1. Floating VTuber Corner Overlay (transparent Three.js + @pixiv/three-vrm canvas
 *    mounted via permanent statusBar.right contribution, draggable, scalable, with
 *    head/cheek/body touch reactions and live speech bubble).
 * 2. Optional Dockable Stage Pane (`panes` area, toggled live).
 * 3. Full VRM Avatar Studio route (`/vrm-avatar`), sidebar nav, ⌘K palette commands,
 *    and Settings → Plugins page (`ctx.registerSettingsPage`).
 * 4. Transcript directive `::avatar{mood="joy" reaction="wave" say="..."}`.
 * 5. Automatic reactivity to Hermes `host.state.busy` / `awaitingResponse` / gateway
 *    events, plus automatic emotional continuity bridge when `psfn_lite` is installed.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  COMPOSER_AREAS,
  PALETTE_AREA,
  PANES_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  TITLEBAR_AREAS,
  TRANSCRIPT_DIRECTIVE_AREA,
  host,
  useValue,
} from '@hermes/plugin-sdk';
import type { ClipManifestEntry } from '../engine/companion-player.ts';
import {
  DISCRETE_BASE,
  MOOD_NAMES,
  vadQuadrantBase,
  type EmotionalBase,
} from '../engine/emotion-mapping.ts';
import {
  AVATAR_REGION_GESTURES,
  LONG_PRESS_MS,
  MOVE_GESTURE_PX,
  REACTION_COPY,
  TOUCH_TO_REACTION_CLIP,
  classifyAvatarGesture,
  mapAvatarInteraction,
  type TouchRegion,
  type TouchStimulusKind,
} from '../engine/interactions.ts';
import { isRecord, validateLocalAvatarFile } from '../engine/load-avatar.ts';
import {
  createStageRenderer,
  type CameraPreset,
  type StagePlaybackState,
  type StageRendererHandle,
} from '../engine/stage-renderer.ts';
import type { BakedMotionClip } from '../engine/vrm-clip-player.ts';

export const PLUGIN_ID = 'hermes-psfn-avatar';

interface ModelRecord {
  readonly id: string;
  readonly kind: 'holo' | 'vrm' | 'glb';
  readonly name: string;
  readonly filename: string | null;
  readonly size_bytes?: number;
  readonly sha256?: string;
  readonly url?: string;
  readonly source?: string;
  readonly cached?: boolean;
}

interface PsfnLiteStatus {
  readonly connected: boolean;
  readonly companion_id: string | null;
  readonly last_synced_at: string | number | null;
  readonly discrete: ReadonlyArray<{ label: string; score: number }>;
  readonly concerns_count: number;
}

interface BackendAvatarState {
  readonly seq: number;
  readonly activity: 'idle' | 'thinking' | 'listening' | 'talking' | 'tool';
  readonly mood: string;
  readonly emotional_base: EmotionalBase;
  readonly vad: { valence: number; arousal: number; dominance: number };
  readonly reaction: string | null;
  readonly clip: string | null;
  readonly speech_text: string;
  readonly speech_Id: number;
  readonly camera: CameraPreset;
  readonly corner: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  readonly scale: number;
  readonly mode: 'floating' | 'pane' | 'hidden';
  readonly muted: boolean;
  readonly active_model: {
    readonly kind: 'holo' | 'vrm' | 'glb';
    readonly name: string;
    readonly filename: string | null;
  };
  readonly psfn_lite: PsfnLiteStatus;
}

const DEFAULT_BACKEND_STATE: BackendAvatarState = {
  seq: 1,
  activity: 'idle',
  mood: 'neutral',
  emotional_base: 'neutral',
  vad: { valence: 0, arousal: 0.1, dominance: 0 },
  reaction: null,
  clip: 'Neutral_Idle_01.json',
  speech_text: '',
  speech_Id: 0,
  camera: 'bust',
  corner: 'bottom-right',
  scale: 1.0,
  mode: 'floating',
  muted: false,
  active_model: {
    kind: 'vrm',
    name: 'Nous-Girl (VRM 0.x)',
    filename: 'Nous-Girl.vrm',
  },
  psfn_lite: {
    connected: false,
    companion_id: null,
    last_synced_at: null,
    discrete: [],
    concerns_count: 0,
  },
};

const QUICK_REACTIONS: ReadonlyArray<{ label: string; reaction: string; mood: string }> = [
  { label: 'Wave', reaction: 'wave', mood: 'joy' },
  { label: 'Nod', reaction: 'nod', mood: 'approval' },
  { label: 'Celebrate', reaction: 'celebrate', mood: 'excitement' },
  { label: 'Curious', reaction: 'none', mood: 'curiosity' },
  { label: 'Laugh', reaction: 'laugh', mood: 'amusement' },
  { label: 'Love', reaction: 'reach', mood: 'love' },
];

type RestFn = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

interface SharedController {
  getState(): BackendAvatarState;
  getModels(): readonly ModelRecord[];
  getClips(): readonly ClipManifestEntry[];
  subscribe(listener: () => void): () => void;
  perform(patch: Record<string, unknown>): Promise<void>;
  selectModel(idOrFilename: string): Promise<void>;
  uploadModelFile(file: File): Promise<void>;
  loadLocalBuffer(file: File): Promise<void>;
  getLocalBuffer(): { name: string; buffer: ArrayBuffer } | null;
  syncPsfnLite(): Promise<void>;
  fetchClip(clipUrl: string): Promise<BakedMotionClip>;
  fetchClipsManifest(): Promise<ClipManifestEntry[]>;
  fetchModelBuffer(filename: string): Promise<ArrayBuffer>;
}

const CLIPS_CDN_BASE =
  'https://raw.githubusercontent.com/axAilotl/hermes-psfn-avatar/7b9a7f7f677b2fd25ed889b56e5ec83055202463/clips';

export const REMOTE_MODEL_CATALOG: ReadonlyArray<ModelRecord> = [
  {
    id: 'file:Nous-Girl.vrm',
    kind: 'vrm',
    name: 'Nous-Girl (VRM 0.x)',
    filename: 'Nous-Girl.vrm',
    size_bytes: 11491944,
    sha256: '2732b6431ceea8cc4da25d3ae416d1ba6ca8255720339c46803e7d9a78a6be5d',
    url: 'https://raw.githubusercontent.com/CGIC-AI/nous-girl-vrm/d923c0567622403083f994a249b6a42997bd2049/nous-girl.vrm',
    source: 'CGIC-AI/nous-girl-vrm (Default)',
  },
  {
    id: 'file:DeepSeek-chan.vrm',
    kind: 'vrm',
    name: 'DeepSeek-chan (CC BY-NC-SA 4.0)',
    filename: 'DeepSeek-chan.vrm',
    size_bytes: 33616628,
    sha256: '9fa455e48ee2271dc7c2b62f2f2edcd47709406ca89067b6f544979589958f42',
    url: 'https://raw.githubusercontent.com/tegnike/deepseek-chan-vrm/3aceb037df7a8b8126efea89d3a75664d1af868d/DeepSeek-chan.vrm',
    source: 'tegnike/deepseek-chan-vrm (CC BY-NC-SA 4.0)',
  },
  {
    id: 'file:aletheia.vrm',
    kind: 'vrm',
    name: 'Aletheia (Eidoverse)',
    filename: 'aletheia.vrm',
    size_bytes: 30976184,
    sha256: 'c0f4c8bb0b5a0ea1f79171f83b2c1ab9c21121fe9a5f1feb1cf84fe83ce6672c',
    url: 'https://raw.githubusercontent.com/SkyeShark/eidoverse-video/404a00e7db3068af51bd914d61e608e6b8dc9b82/eidoverse/assets/vrms/aletheia.vrm',
    source: 'SkyeShark/eidoverse-video',
  },
  {
    id: 'file:aporia.vrm',
    kind: 'vrm',
    name: 'Aporia (Eidoverse)',
    filename: 'aporia.vrm',
    size_bytes: 29971076,
    sha256: '0b0c5dee6485a5a7017abdff6ea8b32cc3ef472f648ea1655ff23cb4740d7b19',
    url: 'https://raw.githubusercontent.com/SkyeShark/eidoverse-video/404a00e7db3068af51bd914d61e608e6b8dc9b82/eidoverse/assets/vrms/aporia.vrm',
    source: 'SkyeShark/eidoverse-video',
  },
  {
    id: 'file:claude.vrm',
    kind: 'vrm',
    name: 'Claude (Eidoverse)',
    filename: 'claude.vrm',
    size_bytes: 848636,
    sha256: '883eb1d6c63c7409e1cbebb335509af346e92d046c4c9916ebc7695da4c64073',
    url: 'https://raw.githubusercontent.com/SkyeShark/eidoverse-video/404a00e7db3068af51bd914d61e608e6b8dc9b82/eidoverse/assets/vrms/claude.vrm',
    source: 'SkyeShark/eidoverse-video',
  },
  {
    id: 'file:claude_suit.vrm',
    kind: 'vrm',
    name: 'Claude Suit (Eidoverse)',
    filename: 'claude_suit.vrm',
    size_bytes: 10595332,
    sha256: '7be6286215c0d7e4251633ec741d9f5bde943dc635f05a312ca7d1b45bceaa5d',
    url: 'https://raw.githubusercontent.com/SkyeShark/eidoverse-video/404a00e7db3068af51bd914d61e608e6b8dc9b82/eidoverse/assets/vrms/claude_suit.vrm',
    source: 'SkyeShark/eidoverse-video',
  },
  {
    id: 'file:claude_suit_wardrobe.vrm',
    kind: 'vrm',
    name: 'Claude Suit Wardrobe (Eidoverse)',
    filename: 'claude_suit_wardrobe.vrm',
    size_bytes: 35444376,
    sha256: '54a6d71ceefdc44b6688b3174b3a858b006ba526e51a268060080fe3d59cd65a',
    url: 'https://raw.githubusercontent.com/SkyeShark/eidoverse-video/404a00e7db3068af51bd914d61e608e6b8dc9b82/eidoverse/assets/vrms/claude_suit_wardrobe.vrm',
    source: 'SkyeShark/eidoverse-video',
  },
  {
    id: 'file:claude_robot_2k.vrm',
    kind: 'vrm',
    name: 'Claude Robot 2K (Eidoverse)',
    filename: 'claude_robot_2k.vrm',
    size_bytes: 20852556,
    sha256: 'e04e19c594ee55d3017360e21bf499c9f56ed13a1deb17cc04e9acf881696ef4',
    url: 'https://raw.githubusercontent.com/SkyeShark/eidoverse-video/404a00e7db3068af51bd914d61e608e6b8dc9b82/eidoverse/assets/vrms/claude_robot_2k.vrm',
    source: 'SkyeShark/eidoverse-video',
  },
  {
    id: 'file:claude_robot.vrm',
    kind: 'vrm',
    name: 'Claude Robot 4K (Eidoverse)',
    filename: 'claude_robot.vrm',
    size_bytes: 38561864,
    sha256: 'fbeaa3b4162b4fd6d893b13e4172a9a9e8e78eb964e4ae4a3373c1a5bb2ca2f0',
    url: 'https://raw.githubusercontent.com/SkyeShark/eidoverse-video/404a00e7db3068af51bd914d61e608e6b8dc9b82/eidoverse/assets/vrms/claude_robot.vrm',
    source: 'SkyeShark/eidoverse-video',
  },
];

const memoryModelCache = new Map<string, Promise<ArrayBuffer>>();

async function readIdbModelCache(key: string): Promise<ArrayBuffer | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const { promise: openP, resolve: openRes, reject: openRej } = Promise.withResolvers<IDBDatabase>();
    const req = indexedDB.open('hermes-psfn-avatar-vrm-cache', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('models');
    };
    req.onsuccess = () => openRes(req.result);
    req.onerror = () => openRej(req.error);
    const db = await openP;
    const { promise: getP, resolve: getRes, reject: getRej } = Promise.withResolvers<ArrayBuffer | null>();
    const tx = db.transaction('models', 'readonly');
    const getReq = tx.objectStore('models').get(key);
    getReq.onsuccess = () => getRes(getReq.result instanceof ArrayBuffer ? getReq.result : null);
    getReq.onerror = () => getRej(getReq.error);
    return await getP;
  } catch {
    return null;
  }
}

async function writeIdbModelCache(key: string, buf: ArrayBuffer): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    const { promise: openP, resolve: openRes, reject: openRej } = Promise.withResolvers<IDBDatabase>();
    const req = indexedDB.open('hermes-psfn-avatar-vrm-cache', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('models');
    };
    req.onsuccess = () => openRes(req.result);
    req.onerror = () => openRej(req.error);
    const db = await openP;
    const tx = db.transaction('models', 'readwrite');
    tx.objectStore('models').put(buf, key);
  } catch {
    // Ignore IndexedDB quota errors
  }
}

function createSharedController(ctx: {
  rest: RestFn;
  storage: { get<T>(k: string, d: T): T; set(k: string, v: unknown): void };
  pet?: { say?: (text: string, opts?: { id?: string; ttlMs?: number }) => () => void };
}): SharedController {
  const storedActiveModel = ctx.storage.get<BackendAvatarState['active_model'] | null>(
    'active_model',
    null,
  );
  const initialActiveModel: BackendAvatarState['active_model'] =
    storedActiveModel &&
    storedActiveModel.kind !== 'holo' &&
    typeof storedActiveModel.filename === 'string' &&
    storedActiveModel.filename.length > 0
      ? storedActiveModel
      : DEFAULT_BACKEND_STATE.active_model;
  let lockedActiveModel: BackendAvatarState['active_model'] | null =
    storedActiveModel &&
    storedActiveModel.kind !== 'holo' &&
    typeof storedActiveModel.filename === 'string' &&
    storedActiveModel.filename.length > 0
      ? storedActiveModel
      : null;

  let state: BackendAvatarState = {
    ...DEFAULT_BACKEND_STATE,
    active_model: initialActiveModel,
    camera: ctx.storage.get<CameraPreset>('camera', 'bust'),
    corner: ctx.storage.get<BackendAvatarState['corner']>('corner', 'bottom-right'),
    scale: ctx.storage.get<number>('scale', 1.0),
    mode: ctx.storage.get<BackendAvatarState['mode']>('mode', 'floating'),
  };
  let models: ModelRecord[] = [...REMOTE_MODEL_CATALOG];
  if (
    initialActiveModel.filename &&
    !models.some((m) => m.filename === initialActiveModel.filename)
  ) {
    models.push({
      id: `file:${initialActiveModel.filename}`,
      kind: initialActiveModel.kind === 'glb' ? 'glb' : 'vrm',
      name: initialActiveModel.name,
      filename: initialActiveModel.filename,
      source: 'Local Upload',
    });
  }
  let clips: ClipManifestEntry[] = [];
  let localBuffer: { name: string; buffer: ArrayBuffer } | null = null;
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const fn of listeners) fn();
  }

  function mergeServerState(raw: unknown, allowModelOverride = false): void {
    if (!isRecord(raw)) return;
    const nextSeq = typeof raw.seq === 'number' ? raw.seq : state.seq + 1;
    const rawActive = isRecord(raw.active_model)
      ? (raw.active_model as BackendAvatarState['active_model'])
      : null;
    const validRawActive =
      rawActive &&
      rawActive.kind !== 'holo' &&
      typeof rawActive.filename === 'string' &&
      rawActive.filename.length > 0
        ? rawActive
        : null;
    const nextActiveModel =
      allowModelOverride && validRawActive
        ? validRawActive
        : lockedActiveModel ?? state.active_model ?? validRawActive ?? DEFAULT_BACKEND_STATE.active_model;

    state = {
      ...state,
      ...(raw as Partial<BackendAvatarState>),
      active_model: nextActiveModel,
      seq: nextSeq,
    };
    ctx.storage.set('active_model', state.active_model);
    ctx.storage.set('camera', state.camera);
    ctx.storage.set('corner', state.corner);
    ctx.storage.set('scale', state.scale);
    ctx.storage.set('mode', state.mode);
    emit();
  }

  async function refreshFromBackend(): Promise<void> {
    try {
      const res = await ctx.rest<{
        ok?: boolean;
        state?: unknown;
        models?: ModelRecord[];
      }>('/state');
      if (Array.isArray(res?.models)) {
        const filtered = res.models.filter((m) => m.kind !== 'holo' && Boolean(m.filename));
        if (filtered.length > 0) models = filtered;
      }
      if (res?.state) mergeServerState(res.state, false);
    } catch {
      // Backend half is optional: standalone desktop-only installs still work in-memory.
    }
  }

  async function perform(patch: Record<string, unknown>): Promise<void> {
    // Optimistic local update so UI & 3D stage respond in 0ms
    const nextMood = typeof patch.mood === 'string' ? patch.mood.toLowerCase() : state.mood;
    const nextBase = DISCRETE_BASE[nextMood] ?? state.emotional_base;
    const nextSpeechText =
      typeof patch.say === 'string'
        ? patch.say
        : typeof patch.speech_text === 'string'
          ? patch.speech_text
          : state.speech_text;
    const nextSpeechId =
      patch.say !== undefined || patch.speech_text !== undefined ? state.speech_Id + 1 : state.speech_Id;

    mergeServerState({
      ...state,
      ...patch,
      active_model: state.active_model,
      mood: nextMood,
      emotional_base: nextBase,
      speech_text: nextSpeechText,
      speech_Id: nextSpeechId,
      seq: state.seq + 1,
    });

    if (typeof patch.say === 'string' && patch.say.trim()) {
      ctx.pet?.say?.(patch.say.trim(), { id: 'avatar-say', ttlMs: 6000 });
    }

    try {
      const res = await ctx.rest<{ ok?: boolean; state?: unknown }>('/perform', {
        method: 'POST',
        body: { ...patch, active_model: state.active_model },
      });
      if (res?.state) mergeServerState(res.state, false);
    } catch {
      // Keep optimistic state when backend half is offline
    }
  }

  async function selectModel(idOrFilename: string): Promise<void> {
    const cleanFile = idOrFilename.replace(/^file:/, '');
    const found = models.find((m) => m.id === idOrFilename || m.filename === cleanFile);
    const nextActive: BackendAvatarState['active_model'] =
      found && found.filename
        ? {
            kind: found.kind === 'glb' ? 'glb' : 'vrm',
            name: found.name,
            filename: found.filename,
          }
        : cleanFile === 'DeepSeek-chan.vrm'
          ? {
              kind: 'vrm',
              name: 'DeepSeek-chan (CC BY-NC-SA 4.0)',
              filename: 'DeepSeek-chan.vrm',
            }
          : {
              kind: cleanFile.toLowerCase().endsWith('.glb') ? 'glb' : 'vrm',
              name:
                cleanFile === 'Nous-Girl.vrm'
                  ? 'Nous-Girl (VRM 0.x)'
                  : cleanFile.replace(/\.(?:vrm|glb)$/i, ''),
              filename: cleanFile || 'Nous-Girl.vrm',
            };
    lockedActiveModel = nextActive;
    ctx.storage.set('active_model', nextActive);
    mergeServerState(
      {
        ...state,
        active_model: nextActive,
      },
      true,
    );
    try {
      const res = await ctx.rest<{ ok?: boolean; state?: unknown }>('/models/select', {
        method: 'POST',
        body: { id: idOrFilename, filename: nextActive.filename },
      });
      if (res?.state) mergeServerState(res.state, true);
    } catch {
      // Offline fallback
    }
  }

  async function loadLocalBuffer(file: File): Promise<void> {
    validateLocalAvatarFile(file);
    const buffer = await file.arrayBuffer();
    localBuffer = { name: file.name, buffer };
    await writeIdbModelCache(file.name, buffer);
    const ext = file.name.toLowerCase().endsWith('.vrm') ? 'vrm' : 'glb';
    const nextActive: BackendAvatarState['active_model'] = {
      kind: ext,
      name: file.name.replace(/\.(?:vrm|glb)$/i, ''),
      filename: file.name,
    };
    if (!models.some((m) => m.filename === file.name)) {
      models = [
        ...models,
        {
          id: `file:${file.name}`,
          kind: ext,
          name: nextActive.name,
          filename: file.name,
          size_bytes: file.size,
        },
      ];
    }
    lockedActiveModel = nextActive;
    ctx.storage.set('active_model', nextActive);
    mergeServerState(
      {
        ...state,
        active_model: nextActive,
      },
      true,
    );
  }

  async function uploadModelFile(file: File): Promise<void> {
    await loadLocalBuffer(file);
    try {
      const { promise, resolve, reject } = Promise.withResolvers<string>();
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.onerror = () => reject(new Error('Failed to encode file'));
      reader.readAsDataURL(file);
      const dataUrl = await promise;
      const commaIdx = dataUrl.indexOf(',');
      const data_base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
      const res = await ctx.rest<{
        ok?: boolean;
        models?: ModelRecord[];
        state?: unknown;
      }>('/models/upload', {
        method: 'POST',
        body: { filename: file.name, data_base64 },
      });
      if (Array.isArray(res?.models)) {
        const filtered = res.models.filter((m) => m.kind !== 'holo' && Boolean(m.filename));
        if (filtered.length > 0) models = filtered;
      }
      if (res?.state) mergeServerState(res.state, false);
    } catch {
      // Local session buffer + IndexedDB cache are already active even if backend upload isn't mounted
    }
  }

  async function syncPsfnLite(): Promise<void> {
    try {
      const res = await ctx.rest<{ ok?: boolean; state?: unknown }>('/psfn-sync', {
        method: 'POST',
        body: {},
      });
      if (res?.state) mergeServerState(res.state);
    } catch {
      // Ignore if backend is offline
    }
  }

  async function fetchClipsManifest(): Promise<ClipManifestEntry[]> {
    if (clips.length > 0) return clips;
    try {
      const res = await ctx.rest<{ ok?: boolean; clips?: ClipManifestEntry[] }>('/clips');
      if (Array.isArray(res?.clips) && res.clips.length > 0) {
        clips = res.clips;
        emit();
        return clips;
      }
    } catch {
      // Fallback to pinned GitHub raw clips manifest when backend route is not mounted yet
    }
    try {
      const resp = await fetch(`${CLIPS_CDN_BASE}/clips.json`);
      if (resp.ok) {
        const list = (await resp.json()) as ClipManifestEntry[];
        if (Array.isArray(list)) {
          clips = list;
          emit();
          return clips;
        }
      }
    } catch {
      // Offline fallback
    }
    return [];
  }

  async function fetchClip(clipUrl: string): Promise<BakedMotionClip> {
    const filename = clipUrl.split('/').pop() ?? clipUrl;
    try {
      return await ctx.rest<BakedMotionClip>(`/clips/${encodeURIComponent(filename)}`);
    } catch {
      const resp = await fetch(`${CLIPS_CDN_BASE}/${encodeURIComponent(filename)}`);
      if (!resp.ok) throw new Error(`Clip fetch failed: ${filename}`);
      return (await resp.json()) as BakedMotionClip;
    }
  }

  async function fetchModelBuffer(filename: string): Promise<ArrayBuffer> {
    if (localBuffer && localBuffer.name === filename) {
      return localBuffer.buffer;
    }
    const existingPromise = memoryModelCache.get(filename);
    if (existingPromise) return await existingPromise;

    const loadPromise = (async () => {
      const cached = await readIdbModelCache(filename);
      if (cached) return cached;

      try {
        const localResp = await fetch(
          `/api/plugins/${PLUGIN_ID}/models/file/${encodeURIComponent(filename)}`,
        );
        if (localResp.ok) {
          const buf = await localResp.arrayBuffer();
          await writeIdbModelCache(filename, buf);
          return buf;
        }
      } catch {
        // Fall through to pinned upstream CDN if backend route is unavailable
      }

      const remoteEntry = REMOTE_MODEL_CATALOG.find((m) => m.filename === filename);
      if (remoteEntry && remoteEntry.url) {
        const resp = await fetch(remoteEntry.url);
        if (resp.ok) {
          const buf = await resp.arrayBuffer();
          if (remoteEntry.sha256 && typeof crypto !== 'undefined' && crypto.subtle) {
            const hashBuf = await crypto.subtle.digest('SHA-256', buf);
            const hex = Array.from(new Uint8Array(hashBuf))
              .map((b) => b.toString(16).padStart(2, '0'))
              .join('');
            if (hex !== remoteEntry.sha256) {
              throw new Error(`${filename} SHA-256 verification failed`);
            }
          }
          await writeIdbModelCache(filename, buf);
          return buf;
        }
      }

      throw new Error(`Failed to fetch model ${filename}`);
    })().catch((err) => {
      memoryModelCache.delete(filename);
      throw err;
    });

    memoryModelCache.set(filename, loadPromise);
    return await loadPromise;
  }

  void refreshFromBackend();
  void fetchClipsManifest();

  return {
    getState: () => state,
    getModels: () => models,
    getClips: () => clips,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    perform,
    selectModel,
    uploadModelFile,
    loadLocalBuffer,
    getLocalBuffer: () => localBuffer,
    syncPsfnLite,
    fetchClip,
    fetchClipsManifest,
    fetchModelBuffer,
  };
}

function useControllerState(controller: SharedController): BackendAvatarState {
  const [, setTick] = useState(0);
  useEffect(() => controller.subscribe(() => setTick((t) => t + 1)), [controller]);
  return controller.getState();
}

/** 3D Canvas Stage shared by the Floating VTuber Overlay, Docked Pane, and Studio Page. */
function AvatarStageView({
  controller,
  heightPx,
  interactiveTouch = true,
  compactHud = true,
  onOverlayDragDelta,
}: {
  controller: SharedController;
  heightPx: number;
  interactiveTouch?: boolean;
  compactHud?: boolean;
  onOverlayDragDelta?: (dx: number, dy: number, commit: boolean) => void;
}) {
  const state = useControllerState(controller);
  const busy = useValue(host.state.busy);
  const awaiting = useValue(host.state.awaitingResponse);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<StageRendererHandle | null>(null);
  const pointerStartRef = useRef<{
    id: number;
    region: TouchRegion;
    atMs: number;
    x: number;
    y: number;
    lastX: number;
    lastY: number;
    wantOrbit: boolean;
    mode: 'undecided' | 'orbit' | 'move-window';
  } | null>(null);
  const lastTapAtRef = useRef<Record<TouchRegion, number>>({
    head: -Infinity,
    cheek: -Infinity,
    body: -Infinity,
  });

  const [statusInfo, setStatusInfo] = useState<{ format: string; state: string; error?: string }>({
    format: 'Holo-Rig 3D',
    state: 'Idle',
  });
  const [touchBanner, setTouchBanner] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const hoverLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleHoverEnter = useCallback(() => {
    if (hoverLeaveTimerRef.current !== null) {
      clearTimeout(hoverLeaveTimerRef.current);
      hoverLeaveTimerRef.current = null;
    }
    setHovered(true);
  }, []);

  const handleHoverLeave = useCallback(() => {
    if (hoverLeaveTimerRef.current !== null) {
      clearTimeout(hoverLeaveTimerRef.current);
    }
    hoverLeaveTimerRef.current = setTimeout(() => {
      hoverLeaveTimerRef.current = null;
      setHovered(false);
    }, 380);
  }, []);

  useEffect(() => {
    return () => {
      if (hoverLeaveTimerRef.current !== null) {
        clearTimeout(hoverLeaveTimerRef.current);
      }
    };
  }, []);

  const effectiveActivity: StagePlaybackState['activity'] =
    state.activity === 'tool'
      ? 'tool'
      : awaiting || busy || state.activity === 'thinking'
        ? 'thinking'
        : state.activity === 'talking'
          ? 'idle'
          : state.activity;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let stage: StageRendererHandle | null = null;
    try {
      stage = createStageRenderer({
        canvas,
        fetchClip: (url) => controller.fetchClip(url),
        fetchClipsManifest: () => controller.fetchClipsManifest(),
        onStatus: (info) => setStatusInfo(info),
      });
      stageRef.current = stage;
    } catch (err) {
      setStatusInfo({
        format: 'Unavailable',
        state: 'Error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return () => {
      stage?.dispose();
      if (stageRef.current === stage) stageRef.current = null;
    };
  }, [controller]);

  // Reload model when active_model changes
  const activeFilename = state.active_model?.filename || 'Nous-Girl.vrm';
  const activeName = state.active_model?.name || 'Nous-Girl (VRM 0.x)';

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const local = controller.getLocalBuffer();
    if (local && local.name === activeFilename) {
      void stage.loadVrmBuffer(local.buffer, activeName).catch((err) => {
        setStatusInfo({
          format: 'Error',
          state: 'Model Load Failed',
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return;
    }
    void controller
      .fetchModelBuffer(activeFilename)
      .then((buf) => stage.loadVrmBuffer(buf, activeName))
      .catch((err) => {
        setStatusInfo({
          format: 'Error',
          state: 'Model Load Failed',
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }, [controller, activeFilename, activeName]);

  // Push playback state updates into the 3D stage
  useEffect(() => {
    stageRef.current?.updateState({
      active: state.mode !== 'hidden',
      animated: true,
      activity: effectiveActivity,
      mood: state.mood,
      emotionalBase: state.emotional_base,
      reaction: state.reaction,
      clipFile: state.clip,
      cameraPreset: state.camera,
      speechText: state.speech_text,
      speechId: state.speech_Id,
      muted: state.muted,
    });
  }, [
    state.mode,
    effectiveActivity,
    state.mood,
    state.emotional_base,
    state.reaction,
    state.clip,
    state.camera,
    state.speech_text,
    state.speech_Id,
    state.muted,
  ]);

  const onRegionPointerDown = useCallback(
    (region: TouchRegion, e: React.PointerEvent) => {
      e.preventDefault();
      const wantOrbit =
        e.shiftKey || e.button === 2 || e.button === 1 || !onOverlayDragDelta;
      pointerStartRef.current = {
        id: e.pointerId,
        region,
        atMs: Date.now(),
        x: e.clientX,
        y: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        wantOrbit,
        mode: wantOrbit ? 'orbit' : 'undecided',
      };
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    [onOverlayDragDelta],
  );

  const onRegionPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const start = pointerStartRef.current;
      if (!start || start.id !== e.pointerId) return;
      const stepDx = e.clientX - start.lastX;
      const stepDy = e.clientY - start.lastY;
      start.lastX = e.clientX;
      start.lastY = e.clientY;

      const totalDx = e.clientX - start.x;
      const totalDy = e.clientY - start.y;
      const totalDist = Math.hypot(totalDx, totalDy);

      if (
        start.mode === 'undecided' &&
        (e.shiftKey || (e.buttons & 2) !== 0 || (e.buttons & 4) !== 0 || !onOverlayDragDelta)
      ) {
        start.wantOrbit = true;
        start.mode = 'orbit';
      } else if (start.mode === 'undecided' && totalDist >= 4) {
        start.mode = start.wantOrbit ? 'orbit' : 'move-window';
      }

      if (start.mode === 'orbit') {
        if (stepDx !== 0 || stepDy !== 0) {
          stageRef.current?.nudgeOrbit(-stepDx * 0.012, stepDy * 0.009);
        }
        return;
      }

      if (start.mode === 'move-window' && onOverlayDragDelta) {
        onOverlayDragDelta(totalDx, totalDy, false);
      }
    },
    [onOverlayDragDelta],
  );

  const onRegionPointerCancel = useCallback((e: React.PointerEvent) => {
    const start = pointerStartRef.current;
    if (!start || start.id !== e.pointerId) return;
    pointerStartRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }, []);

  const onRegionPointerUp = useCallback(
    (region: TouchRegion, e: React.PointerEvent) => {
      const start = pointerStartRef.current;
      if (!start || start.id !== e.pointerId) return;
      pointerStartRef.current = null;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      const endedAt = Date.now();
      const durationMs = Math.max(0, endedAt - start.atMs);
      const deltaX = e.clientX - start.x;
      const deltaY = e.clientY - start.y;
      const dist = Math.hypot(deltaX, deltaY);

      if (start.mode === 'orbit' || start.wantOrbit || e.shiftKey || e.button !== 0) {
        return;
      }

      if (start.mode === 'move-window' && onOverlayDragDelta) {
        onOverlayDragDelta(deltaX, deltaY, true);
        return;
      }

      const tapLike = dist < MOVE_GESTURE_PX && durationMs < LONG_PRESS_MS;
      const sinceLastTapMs = tapLike ? endedAt - lastTapAtRef.current[region] : Infinity;
      const gesture = classifyAvatarGesture(
        { durationMs, deltaX, deltaY, sinceLastTapMs },
        AVATAR_REGION_GESTURES[region],
      );
      if (tapLike) {
        lastTapAtRef.current[region] = gesture === 'double-tap' ? -Infinity : endedAt;
      }
      const interaction = mapAvatarInteraction(region, gesture, durationMs);
      if (!interaction) return;
      const reactionCopy = REACTION_COPY[interaction.kind as TouchStimulusKind];
      const mapped = TOUCH_TO_REACTION_CLIP[interaction.kind as TouchStimulusKind];
      setTouchBanner(reactionCopy);
      void controller.perform({
        mood: mapped.mood,
        reaction: mapped.reaction,
        say: reactionCopy,
      });
      setTimeout(() => setTouchBanner(null), 1600);
    },
    [controller, onOverlayDragDelta],
  );

  return (
    <div
      onContextMenu={(e) => e.preventDefault()}
      onMouseEnter={handleHoverEnter}
      onMouseLeave={handleHoverLeave}
      onWheel={(e) => {
        e.preventDefault();
        stageRef.current?.nudgeZoom(e.deltaY > 0 ? 1.08 : 0.92);
      }}
      style={{
        height: `${heightPx}px`,
        position: 'relative',
        touchAction: 'none',
        width: '100%',
      }}
    >
      <canvas
        aria-label="3D VRM Companion Avatar"
        ref={canvasRef}
        style={{
          display: 'block',
          height: '100%',
          pointerEvents: compactHud ? 'none' : 'auto',
          width: '100%',
        }}
      />

      {/* Active hover bridge connecting the avatar silhouette down to the full width of the Mini-HUD */}
      {compactHud && hovered && (
        <div
          aria-hidden="true"
          onContextMenu={(e) => e.preventDefault()}
          onMouseEnter={handleHoverEnter}
          onMouseLeave={handleHoverLeave}
          onPointerCancel={onRegionPointerCancel}
          onPointerDown={(e) => onRegionPointerDown('body', e)}
          onPointerMove={onRegionPointerMove}
          onPointerUp={(e) => onRegionPointerUp('body', e)}
          style={{
            bottom: 0,
            cursor: 'grab',
            left: '2%',
            pointerEvents: 'auto',
            position: 'absolute',
            right: '2%',
            top: '30%',
            touchAction: 'none',
            zIndex: 1,
          }}
        />
      )}

      {/* Narrow anatomical silhouette hitboxes so surrounding transparent space clicks through */}
      {interactiveTouch && (
        <div
          style={{
            inset: '6% 18% 2% 18%',
            pointerEvents: 'none',
            position: 'absolute',
            zIndex: 2,
          }}
        >
          <button
            aria-label="Headpat avatar"
            onContextMenu={(e) => e.preventDefault()}
            onMouseEnter={handleHoverEnter}
            onMouseLeave={handleHoverLeave}
            onPointerCancel={onRegionPointerCancel}
            onPointerDown={(e) => onRegionPointerDown('head', e)}
            onPointerMove={onRegionPointerMove}
            onPointerUp={(e) => onRegionPointerUp('head', e)}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'grab',
              height: '30%',
              left: '10%',
              pointerEvents: 'auto',
              position: 'absolute',
              top: 0,
              touchAction: 'none',
              width: '80%',
            }}
            title="Tap for headpat · Drag to move · Shift+drag or Right-drag to orbit 3D view"
            type="button"
          />
          <button
            aria-label="Boop avatar cheek"
            onContextMenu={(e) => e.preventDefault()}
            onMouseEnter={handleHoverEnter}
            onMouseLeave={handleHoverLeave}
            onPointerCancel={onRegionPointerCancel}
            onPointerDown={(e) => onRegionPointerDown('cheek', e)}
            onPointerMove={onRegionPointerMove}
            onPointerUp={(e) => onRegionPointerUp('cheek', e)}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'grab',
              height: '22%',
              left: '14%',
              pointerEvents: 'auto',
              position: 'absolute',
              top: '30%',
              touchAction: 'none',
              width: '72%',
            }}
            title="Tap cheek to boop · Drag to move · Shift+drag or Right-drag to orbit 3D view"
            type="button"
          />
          <button
            aria-label="Interact with avatar torso"
            onContextMenu={(e) => e.preventDefault()}
            onMouseEnter={handleHoverEnter}
            onMouseLeave={handleHoverLeave}
            onPointerCancel={onRegionPointerCancel}
            onPointerDown={(e) => onRegionPointerDown('body', e)}
            onPointerMove={onRegionPointerMove}
            onPointerUp={(e) => onRegionPointerUp('body', e)}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'grab',
              height: '48%',
              left: '4%',
              pointerEvents: 'auto',
              position: 'absolute',
              top: '52%',
              touchAction: 'none',
              width: '92%',
            }}
            title="Drag to move · Tap for hug · Shift+drag or Right-drag to orbit 3D view"
            type="button"
          />
        </div>
      )}

      {/* Touch reaction heart / status toast */}
      {touchBanner && (
        <div
          style={{
            background: 'var(--ui-surface-elevated, rgba(15, 23, 42, 0.88))',
            border: '1px solid var(--ui-accent, #2dd4bf)',
            borderRadius: '999px',
            color: 'var(--ui-text-primary, #f8fafc)',
            fontSize: '11px',
            fontWeight: 600,
            left: '50%',
            padding: '2px 10px',
            pointerEvents: 'none',
            position: 'absolute',
            top: '8px',
            transform: 'translateX(-50%)',
            whiteSpace: 'nowrap',
            zIndex: 4,
          }}
        >
          {touchBanner}
        </div>
      )}

      {/* Speech / Activity Bubble */}
      {(state.speech_text || effectiveActivity !== 'idle') && ! touchBanner && (
        <div
          style={{
            background: 'var(--ui-surface-elevated, rgba(15, 23, 42, 0.86))',
            border: '1px solid var(--ui-stroke-secondary, rgba(148, 163, 184, 0.25))',
            borderRadius: '10px',
            color: 'var(--ui-text-primary, #f8fafc)',
            fontSize: '11px',
            left: '8px',
            lineHeight: 1.35,
            maxWidth: 'calc(100% - 16px)',
            padding: '5px 9px',
            pointerEvents: 'none',
            position: 'absolute',
            top: '6px',
            zIndex: 3,
          }}
        >
          <div
            style={{
              color: 'var(--ui-accent, #2dd4bf)',
              fontSize: '9.5px',
              fontWeight: 600,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
            }}
          >
            {effectiveActivity} · {state.mood}
            {state.psfn_lite?.connected ? ' · PSFN' : ''}
          </div>
          {state.speech_text && (
            <div
              style={{
                display: '-webkit-box',
                overflow: 'hidden',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: 2,
              }}
            >
              {state.speech_text}
            </div>
          )}
        </div>
      )}

      {/* Hover Mini-HUD */}
      {compactHud && hovered && (
        <div
          onMouseEnter={handleHoverEnter}
          onMouseLeave={handleHoverLeave}
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            alignItems: 'center',
            background: 'var(--ui-surface-elevated, rgba(15, 23, 42, 0.94))',
            border: '1px solid var(--ui-stroke-secondary, rgba(148, 163, 184, 0.35))',
            borderRadius: '999px',
            bottom: '6px',
            boxShadow: '0 4px 14px rgba(0, 0, 0, 0.35)',
            display: 'flex',
            gap: '4px',
            left: '50%',
            padding: '4px 8px',
            pointerEvents: 'auto',
            position: 'absolute',
            transform: 'translateX(-50%)',
            whiteSpace: 'nowrap',
            zIndex: 6,
          }}
        >
          {(['bust', 'waist', 'full'] as const).map((cam) => (
            <button
              key={cam}
              onClick={() => {
                stageRef.current?.resetCamera();
                void controller.perform({ camera: cam });
              }}
              style={{
                background: state.camera === cam ? 'var(--ui-accent, #2dd4bf)' : 'transparent',
                border: 'none',
                borderRadius: '999px',
                color:
                  state.camera === cam
                    ? 'var(--ui-surface-primary, #0f172a)'
                    : 'var(--ui-text-secondary, #cbd5e1)',
                cursor: 'pointer',
                fontSize: '10.5px',
                fontWeight: 600,
                padding: '2px 7px',
                textTransform: 'capitalize',
              }}
              title={`Camera preset: ${cam}`}
              type="button"
            >
              {cam}
            </button>
          ))}
          <button
            onClick={() => void controller.perform({ reaction: 'wave', mood: 'joy' })}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--ui-text-secondary, #cbd5e1)',
              cursor: 'pointer',
              fontSize: '10.5px',
              padding: '2px 6px',
            }}
            title="Wave hello"
            type="button"
          >
            👋
          </button>
          <button
            onClick={() =>
              void controller.perform({
                mode: state.mode === 'floating' ? 'pane' : 'floating',
              })
            }
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--ui-text-secondary, #cbd5e1)',
              cursor: 'pointer',
              fontSize: '10.5px',
              padding: '2px 6px',
            }}
            title={state.mode === 'floating' ? 'Dock into side pane' : 'Pop out as floating corner overlay'}
            type="button"
          >
            {state.mode === 'floating' ? 'Dock' : 'Float'}
          </button>
          <button
            onClick={() => host.navigate('/vrm-avatar')}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--ui-accent, #2dd4bf)',
              cursor: 'pointer',
              fontSize: '10.5px',
              fontWeight: 600,
              padding: '2px 6px',
            }}
            title="Open VRM Avatar Studio"
            type="button"
          >
            Studio
          </button>
        </div>
      )}

      {statusInfo.error && (
        <div
          style={{
            bottom: '34px',
            color: 'var(--ui-text-tertiary)',
            fontSize: '10px',
            left: '8px',
            position: 'absolute',
            right: '8px',
            textAlign: 'center',
          }}
        >
          {statusInfo.error}
        </div>
      )}
    </div>
  );
}

function StatusbarAndFloatingOverlay({
  controller,
  storage,
  compactButton = false,
  renderOverlay = false,
}: {
  controller: SharedController;
  storage: { get<T>(k: string, d: T): T; set(k: string, v: unknown): void };
  compactButton?: boolean;
  renderOverlay?: boolean;
}) {
  const state = useControllerState(controller);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>(() =>
    storage.get('dragOffsetV2', { x: 0, y: 0 }),
  );
  const [liveDelta, setLiveDelta] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const widthPx = Math.round(215 * (state.scale || 1));
  const heightPx = Math.round(265 * (state.scale || 1));

  const dx = dragOffset.x + liveDelta.x;
  const dy = dragOffset.y + liveDelta.y;

  // Default bottom is 148px so the avatar sits perched ABOVE the chat composer input bar, never covering it.
  const anchorStyle: React.CSSProperties =
    state.corner === 'bottom-left'
      ? { left: `${16 + dx}px`, bottom: `${148 - dy}px` }
      : state.corner === 'top-right'
        ? { right: `${16 - dx}px`, top: `${46 + dy}px` }
        : state.corner === 'top-left'
          ? { left: `${16 + dx}px`, top: `${46 + dy}px` }
          : { right: `${16 - dx}px`, bottom: `${148 - dy}px` };
  const cycleMode = () => {
    const next =
      state.mode === 'floating' ? 'pane' : state.mode === 'pane' ? 'hidden' : 'floating';
    void controller.perform({ mode: next });
  };

  return (
    <>
      <button
        className="px-1.5 text-[0.6875rem] text-(--ui-text-tertiary) hover:text-(--ui-text-primary)"
        onClick={cycleMode}
        onContextMenu={(e) => {
          e.preventDefault();
          host.navigate('/vrm-avatar');
        }}
        title="Click: cycle Floating / Pane / Hidden · Right-click: open VRM Studio"
        type="button"
      >
        {compactButton ? `🎭 ${state.mood}` : `🎭 ${state.mood} (${state.mode})`}
      </button>

      {renderOverlay && state.mode === 'floating' && (
        <div
          aria-label="Floating VTuber Avatar Overlay"
          style={{
            ...anchorStyle,
            height: `${heightPx}px`,
            pointerEvents: 'none',
            position: 'fixed',
            userSelect: 'none',
            width: `${widthPx}px`,
            zIndex: 55,
          }}
        >
          <AvatarStageView
            compactHud
            controller={controller}
            heightPx={heightPx}
            interactiveTouch
            onOverlayDragDelta={(deltaX, deltaY, commit) => {
              if (commit) {
                const next = { x: dragOffset.x + deltaX, y: dragOffset.y + deltaY };
                setDragOffset(next);
                setLiveDelta({ x: 0, y: 0 });
                storage.set('dragOffsetV2', next);
              } else {
                setLiveDelta({ x: deltaX, y: deltaY });
              }
            }}
          />
        </div>
      )}
    </>
  );
}

/** Docked Side Pane view when `mode === 'pane'`. */
function DockedAvatarPane({ controller }: { controller: SharedController }) {
  const state = useControllerState(controller);
  return (
    <div className="flex h-full flex-col gap-2 p-2.5 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-medium text-(--ui-text-primary)">
          {state.active_model?.name ?? 'VRM Companion'}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            className="rounded px-1.5 py-0.5 text-[11px] text-(--ui-text-secondary) hover:text-(--ui-text-primary)"
            onClick={() => void controller.perform({ mode: 'floating' })}
            type="button"
          >
            Float Corner
          </button>
          <button
            className="rounded px-1.5 py-0.5 text-[11px] text-(--ui-accent)"
            onClick={() => host.navigate('/vrm-avatar')}
            type="button"
          >
            Studio
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded border border-(--ui-stroke-secondary)">
        <AvatarStageView
          compactHud={false}
          controller={controller}
          heightPx={340}
          interactiveTouch
        />
      </div>

      <div className="flex flex-wrap gap-1">
        {QUICK_REACTIONS.map((item) => (
          <button
            className="rounded border border-(--ui-stroke-secondary) px-2 py-0.5 text-[11px] text-(--ui-text-secondary) hover:text-(--ui-text-primary)"
            key={item.label}
            onClick={() =>
              void controller.perform({ mood: item.mood, reaction: item.reaction })
            }
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Full VRM Avatar Studio & Settings Page (`/vrm-avatar` route and Settings → Plugins). */
function AvatarStudioPage({ controller }: { controller: SharedController }) {
  const state = useControllerState(controller);
  const models = controller.getModels();
  const clips = controller.getClips();
  const [uploadStatus, setUploadStatus] = useState<string>('');

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    setUploadStatus(`Loading ${file.name}…`);
    try {
      await controller.uploadModelFile(file);
      setUploadStatus(`Loaded ${file.name}`);
    } catch (err) {
      setUploadStatus(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-5 text-sm text-(--ui-text-primary)">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-(--ui-stroke-secondary) pb-3">
        <div>
          <h1 className="text-base font-semibold">3D VRM Avatar Studio (PSFN Embodiment)</h1>
          <p className="text-xs text-(--ui-text-tertiary)">
            Three.js + @pixiv/three-vrm floating VTuber overlay, 42 ARDY motion-capture clips, 27 GoEmotions moods, and PSFN Lite continuity bridge.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {(['floating', 'pane', 'hidden'] as const).map((m) => (
            <button
              className="rounded border border-(--ui-stroke-secondary) px-2.5 py-1 text-xs capitalize"
              key={m}
              onClick={() => void controller.perform({ mode: m })}
              style={{
                borderColor: state.mode === m ? 'var(--ui-accent)' : undefined,
                color: state.mode === m ? 'var(--ui-accent)' : undefined,
              }}
              type="button"
            >
              {m === 'floating' ? 'Floating Corner' : m === 'pane' ? 'Docked Pane' : 'Hidden'}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Live 3D Stage Preview */}
        <div className="flex flex-col gap-3 rounded-lg border border-(--ui-stroke-secondary) p-3 lg:col-span-5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium">
              Stage Preview · {state.active_model?.name ?? 'Holo-Rig'}
            </span>
            <span className="text-(--ui-text-tertiary)">
              VAD ({state.vad.valence.toFixed(2)}, {state.vad.arousal.toFixed(2)}, {state.vad.dominance.toFixed(2)})
            </span>
          </div>

          <div className="overflow-hidden rounded border border-(--ui-stroke-secondary)">
            <AvatarStageView
              compactHud={false}
              controller={controller}
              heightPx={360}
              interactiveTouch
            />
          </div>

          {/* Framing & Corner Controls */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <div className="mb-1 text-(--ui-text-tertiary)">Camera Framing</div>
              <div className="flex gap-1">
                {(['bust', 'waist', 'full'] as const).map((cam) => (
                  <button
                    className="flex-1 rounded border border-(--ui-stroke-secondary) py-1 capitalize"
                    key={cam}
                    onClick={() => void controller.perform({ camera: cam })}
                    style={{
                      borderColor: state.camera === cam ? 'var(--ui-accent)' : undefined,
                      color: state.camera === cam ? 'var(--ui-accent)' : undefined,
                    }}
                    type="button"
                  >
                    {cam}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1 text-(--ui-text-tertiary)">Overlay Corner</div>
              <select
                className="w-full rounded border border-(--ui-stroke-secondary) bg-transparent px-2 py-1 text-xs"
                onChange={(e) => void controller.perform({ corner: e.target.value })}
                value={state.corner}
              >
                <option value="bottom-right">Bottom Right</option>
                <option value="bottom-left">Bottom Left</option>
                <option value="top-right">Top Right</option>
                <option value="top-left">Top Left</option>
              </select>
            </div>
          </div>

          <div className="flex items-center gap-3 text-xs">
            <span className="text-(--ui-text-tertiary)">Overlay Scale ({state.scale.toFixed(2)}×)</span>
            <input
              className="flex-1"
              max="1.8"
              min="0.6"
              onChange={(e) => void controller.perform({ scale: Number(e.target.value) })}
              step="0.05"
              type="range"
              value={state.scale}
            />
          </div>
        </div>

        {/* Right Column: Model Picker, 28 Moods, 42 Clips, PSFN Lite Bridge */}
        <div className="flex flex-col gap-4 lg:col-span-7">
          {/* Model Selection & Upload */}
          <div className="rounded-lg border border-(--ui-stroke-secondary) p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-(--ui-text-secondary)">
                1. Avatar Model & On-Demand VRM Download Catalog ({models.length})
              </span>
              <label className="cursor-pointer rounded border border-(--ui-accent) px-2.5 py-1 text-xs font-medium text-(--ui-accent)">
                Load Local .VRM / .GLB
                <input
                  accept=".vrm,.glb"
                  className="hidden"
                  onChange={(e) => void handleFileChange(e)}
                  type="file"
                />
              </label>
            </div>
            {uploadStatus && (
              <div className="mb-2 text-xs text-(--ui-text-tertiary)">{uploadStatus}</div>
            )}
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {models.map((m) => {
                const isSelected = Boolean(
                  m.filename && state.active_model?.filename === m.filename,
                );
                const sizeMb =
                  typeof m.size_bytes === 'number' && m.size_bytes > 0
                    ? `${(m.size_bytes / (1024 * 1024)).toFixed(1)} MB`
                    : null;
                return (
                  <button
                    className="flex items-center justify-between rounded border border-(--ui-stroke-secondary) px-2.5 py-1.5 text-left text-xs"
                    key={m.id}
                    onClick={() => void controller.selectModel(m.id)}
                    style={{
                      borderColor: isSelected ? 'var(--ui-accent)' : undefined,
                      color: isSelected ? 'var(--ui-accent)' : undefined,
                    }}
                    type="button"
                  >
                    <span className="truncate font-medium">{m.name}</span>
                    <span className="ml-2 shrink-0 text-[10px] text-(--ui-text-tertiary)">
                      {sizeMb ? `${sizeMb} · ` : ''}
                      {isSelected ? 'Active' : m.cached ? 'Cached' : 'Download'}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="mt-2 text-[11px] text-(--ui-text-tertiary)">
              3rd-party VRM binaries are fetched on demand from commit-pinned URLs, verified via SHA-256, and cached locally in IndexedDB — zero binaries are bundled in the plugin repo. Sources:{' '}
              <a
                className="underline"
                href="https://github.com/CGIC-AI/nous-girl-vrm/blob/d923c0567622403083f994a249b6a42997bd2049/LICENSE.md"
                rel="noreferrer"
                target="_blank"
              >
                CGIC-AI/nous-girl-vrm
              </a>{' '}
              (Default) ·{' '}
              <a
                className="underline"
                href="https://github.com/tegnike/deepseek-chan-vrm"
                rel="noreferrer"
                target="_blank"
              >
                tegnike/deepseek-chan-vrm
              </a>{' '}
              (CC BY-NC-SA 4.0) ·{' '}
              <a
                className="underline"
                href="https://github.com/SkyeShark/eidoverse-video/tree/main/eidoverse/assets/vrms"
                rel="noreferrer"
                target="_blank"
              >
                SkyeShark/eidoverse-video
              </a>
              .
            </div>
          </div>

          {/* 28 GoEmotions Mood Performances */}
          <div className="rounded-lg border border-(--ui-stroke-secondary) p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-(--ui-text-secondary)">
                2. 28 GoEmotions Mood Body + Facial Performances
              </span>
              <span className="text-xs text-(--ui-text-tertiary)">
                Active: <strong className="text-(--ui-accent)">{state.mood}</strong> ({state.emotional_base})
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {MOOD_NAMES.map((mood) => (
                <button
                  className="rounded border border-(--ui-stroke-secondary) px-2 py-0.5 text-[11px] capitalize hover:text-(--ui-text-primary)"
                  key={mood}
                  onClick={() => void controller.perform({ mood })}
                  style={{
                    borderColor: state.mood === mood ? 'var(--ui-accent)' : undefined,
                    color: state.mood === mood ? 'var(--ui-accent)' : 'var(--ui-text-secondary)',
                  }}
                  type="button"
                >
                  {mood}
                </button>
              ))}
            </div>
          </div>

          {/* Reactions & Baked ARDY Clip Audition */}
          <div className="rounded-lg border border-(--ui-stroke-secondary) p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-(--ui-text-secondary)">
                3. One-Shot Reactions & 42 Baked ARDY Motion Clips
              </span>
              <span className="text-xs text-(--ui-text-tertiary)">Clip: {state.clip}</span>
            </div>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {QUICK_REACTIONS.map((r) => (
                <button
                  className="rounded border border-(--ui-stroke-secondary) px-2.5 py-1 text-xs"
                  key={r.label}
                  onClick={() =>
                    void controller.perform({
                      mood: r.mood,
                      reaction: r.reaction,
                      say: r.label,
                    })
                  }
                  type="button"
                >
                  {r.label}
                </button>
              ))}
            </div>
            {clips.length > 0 && (
              <select
                className="w-full rounded border border-(--ui-stroke-secondary) bg-transparent px-2 py-1 text-xs"
                onChange={(e) => void controller.perform({ clip: e.target.value })}
                value={state.clip ?? ''}
              >
                {clips.map((c) => {
                  const file = c.url.split('/').pop() ?? c.url;
                  return (
                    <option key={file} value={file}>
                      [{c.state}] {c.name} ({file})
                    </option>
                  );
                })}
              </select>
            )}
          </div>

          {/* PSFN Lite Emotional Continuity Bridge */}
          <div className="rounded-lg border border-(--ui-stroke-secondary) p-3">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-(--ui-text-secondary)">
                4. PSFN Lite Emotional Continuity Bridge
              </span>
              <button
                className="rounded border border-(--ui-accent) px-2.5 py-0.5 text-xs text-(--ui-accent)"
                onClick={() => void controller.syncPsfnLite()}
                type="button"
              >
                Sync from PSFN Lite
              </button>
            </div>
            <p className="text-xs text-(--ui-text-tertiary)">
              {state.psfn_lite?.connected
                ? `Connected to PSFN Lite companion (${state.psfn_lite.companion_id ?? 'active'}) · Open concerns: ${state.psfn_lite.concerns_count}`
                : 'Standalone mode active. When psfn_lite is configured in this Hermes profile, continuous VAD + 28 GoEmotions state syncs automatically on every turn.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Inline transcript card rendered for `::avatar{mood="joy" reaction="wave" say="..."}` */
function AvatarTranscriptDirective({
  attrs,
  controller,
}: {
  attrs: Readonly<Record<string, string>>;
  controller: SharedController;
}) {
  const mood = attrs.mood || attrs.emotion || 'joy';
  const reaction = attrs.reaction || attrs.action || '';
  const say = attrs.say || '';
  const camera = attrs.camera || '';

  useEffect(() => {
    void controller.perform({
      ...(mood ? { mood } : {}),
      ...(reaction ? { reaction } : {}),
      ...(camera ? { camera } : {}),
      ...(say ? { say } : {}),
    });
  }, [controller, mood, reaction, camera, say]);

  return (
    <div className="my-1 inline-flex items-center gap-2 rounded-full border border-(--ui-stroke-secondary) px-3 py-1 text-xs text-(--ui-text-secondary)">
      <span>🎭</span>
      <span className="font-medium capitalize text-(--ui-text-primary)">{mood}</span>
      {reaction && <span className="text-(--ui-accent)">· {reaction}</span>}
      {say && <span className="italic text-(--ui-text-tertiary)">“{say}”</span>}
      <button
        className="ml-1 text-[11px] text-(--ui-accent) hover:underline"
        onClick={() =>
          void controller.perform({
            ...(mood ? { mood } : {}),
            ...(reaction ? { reaction } : {}),
            ...(say ? { say } : {}),
          })
        }
        type="button"
      >
        Replay
      </button>
    </div>
  );
}

const plugin = {
  id: PLUGIN_ID,
  name: 'PSFN 3D VRM Avatar',
  register(ctx: {
    register: (c: Record<string, unknown>) => () => void;
    registerMany: (cs: Array<Record<string, unknown>>) => () => void;
    registerSettingsPage?: (p: Record<string, unknown>) => () => void;
    rest: RestFn;
    onEvent: (type: string, fn: (ev: { type?: string; payload?: unknown }) => void) => () => void;
    onDispose: (fn: () => void) => void;
    storage: { get<T>(k: string, d: T): T; set(k: string, v: unknown): void };
    pet?: { say?: (text: string, opts?: { id?: string; ttlMs?: number }) => () => void };
  }) {
    const controller = createSharedController(ctx);

    // Dynamically register/unregister the docked right-hand pane when mode === 'pane'
    let disposePane: (() => void) | null = null;
    const syncPaneRegistration = () => {
      const wantPane = controller.getState().mode === 'pane';
      if (wantPane && !disposePane) {
        disposePane = ctx.register({
          id: 'stage-pane',
          area: PANES_AREA,
          title: 'VRM Avatar',
          data: { placement: 'right', width: '300px' },
          render: () => <DockedAvatarPane controller={controller} />,
        });
      } else if (!wantPane && disposePane) {
        disposePane();
        disposePane = null;
      }
    };
    syncPaneRegistration();
    const unsubPane = controller.subscribe(syncPaneRegistration);
    ctx.onDispose(() => {
      unsubPane();
      disposePane?.();
    });

    // Listen to Python backend broadcasts (`broadcast_plugin_event('hermes-psfn-avatar', 'state', ...)`)
    ctx.onEvent(`plugin.${PLUGIN_ID}.state`, ({ payload }) => {
      if (isRecord(payload)) {
        void controller.perform(payload);
      }
    });

    // Reset activity state to idle when turn streaming completes
    ctx.onEvent('message.complete', () => {
      void controller.perform({ activity: 'idle' });
    });

    // Register Settings → Plugins entry
    ctx.registerSettingsPage?.({
      id: 'settings',
      title: 'VRM Avatar',
      icon: 'smiley',
      order: 20,
      render: () => <AvatarStudioPage controller={controller} />,
    });

    ctx.registerMany([
      {
        id: 'titlebar-overlay',
        area: TITLEBAR_AREAS.right,
        order: 95,
        render: () => (
          <StatusbarAndFloatingOverlay
            compactButton
            controller={controller}
            renderOverlay
            storage={ctx.storage}
          />
        ),
      },
      {
        id: 'composer-overlay',
        area: COMPOSER_AREAS.actions,
        order: 95,
        render: () => (
          <StatusbarAndFloatingOverlay
            compactButton
            controller={controller}
            storage={ctx.storage}
          />
        ),
      },
      {
        id: 'statusbar-overlay',
        area: STATUSBAR_AREAS.right,
        order: 115,
        render: () => (
          <StatusbarAndFloatingOverlay controller={controller} storage={ctx.storage} />
        ),
      },
      {
        id: 'studio-route',
        area: ROUTES_AREA,
        data: { path: '/vrm-avatar' },
        render: () => <AvatarStudioPage controller={controller} />,
      },
      {
        id: 'studio-nav',
        area: SIDEBAR_NAV_AREA,
        data: { path: '/vrm-avatar', label: 'VRM Avatar', codicon: 'smiley' },
      },
      {
        id: 'directive-avatar',
        area: TRANSCRIPT_DIRECTIVE_AREA,
        data: {
          name: 'avatar',
          render: ({ attrs }: { attrs: Readonly<Record<string, string>> }) => (
            <AvatarTranscriptDirective attrs={attrs ?? {}} controller={controller} />
          ),
        },
      },
      {
        id: 'palette-open-studio',
        area: PALETTE_AREA,
        data: {
          id: `${PLUGIN_ID}.studio`,
          label: 'VRM Avatar: Open 3D Avatar Studio',
          keywords: ['vrm', 'avatar', 'vtuber', '3d', 'psfn', 'persephone'],
          run: () => host.navigate('/vrm-avatar'),
        },
      },
      {
        id: 'palette-toggle-overlay',
        area: PALETTE_AREA,
        data: {
          id: `${PLUGIN_ID}.toggle`,
          label: 'VRM Avatar: Toggle Floating Corner / Docked Pane / Hidden',
          keywords: ['vrm', 'avatar', 'overlay', 'float', 'dock'],
          run: () => {
            const cur = controller.getState().mode;
            const next = cur === 'floating' ? 'pane' : cur === 'pane' ? 'hidden' : 'floating';
            void controller.perform({ mode: next });
          },
        },
      },
    ]);
  },
};

export default plugin;
