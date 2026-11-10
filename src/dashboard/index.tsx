/**
 * hermes-psfn-avatar — Hermes Web Dashboard entry (window.__HERMES_PLUGIN_SDK__).
 *
 * Registers:
 * 1. The `/vrm-avatar` Studio tab (`window.__HERMES_PLUGINS__.register`).
 * 2. The global `"overlay"` shell slot (`window.__HERMES_PLUGINS__.registerSlot`)
 *    so the 3D VTuber companion floats in the corner of the Web Dashboard too.
 */

import type { ClipManifestEntry } from '../engine/companion-player.ts';
import { MOOD_NAMES, type EmotionalBase } from '../engine/emotion-mapping.ts';
import { createStageRenderer, type CameraPreset, type StageRendererHandle } from '../engine/stage-renderer.ts';
import type { BakedMotionClip } from '../engine/vrm-clip-player.ts';

const PLUGIN_ID = 'hermes-psfn-avatar';

interface DashboardSdk {
  React: {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => unknown;
  };
  hooks: {
    useState: <T>(init: T | (() => T)) => [T, (next: T | ((prev: T) => T)) => void];
    useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => void;
    useRef: <T>(init: T) => { current: T };
  };
  fetchJSON: <T>(url: string, init?: RequestInit) => Promise<T>;
}

interface DashboardPluginsRegistry {
  register: (name: string, component: unknown) => void;
  registerSlot?: (name: string, slot: string, component: unknown) => void;
}

interface DashboardState {
  seq: number;
  activity: 'idle' | 'thinking' | 'listening' | 'talking' | 'tool';
  mood: string;
  emotional_base: EmotionalBase;
  vad: { valence: number; arousal: number; dominance: number };
  reaction: string | null;
  clip: string | null;
  speech_text: string;
  speech_Id: number;
  camera: CameraPreset;
  corner: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  scale: number;
  mode: 'floating' | 'pane' | 'hidden';
  muted: boolean;
  active_model: {
    kind: 'holo' | 'vrm' | 'glb';
    name: string;
    filename: string | null;
  };
  psfn_lite: {
    connected: boolean;
    companion_id: string | null;
    concerns_count: number;
  };
}

function mountDashboardPlugin(): void {
  const win = window as unknown as {
    __HERMES_PLUGIN_SDK__?: DashboardSdk;
    __HERMES_PLUGINS__?: DashboardPluginsRegistry;
  };
  const SDK = win.__HERMES_PLUGIN_SDK__;
  const REG = win.__HERMES_PLUGINS__;
  if (!SDK || !REG) return;

  const h = SDK.React.createElement;
  const { useState, useEffect, useRef } = SDK.hooks;

  const apiBase = `/api/plugins/${PLUGIN_ID}`;

  function fetchClip(url: string): Promise<BakedMotionClip> {
    const file = url.split('/').pop() ?? url;
    return SDK.fetchJSON<BakedMotionClip>(`${apiBase}/clips/${encodeURIComponent(file)}`);
  }

  async function fetchClipsManifest(): Promise<ClipManifestEntry[]> {
    const res = await SDK.fetchJSON<{ ok?: boolean; clips?: ClipManifestEntry[] }>(`${apiBase}/clips`);
    return Array.isArray(res?.clips) ? res.clips : [];
  }

  function useBackendState(): {
    state: DashboardState | null;
    perform: (patch: Record<string, unknown>) => Promise<void>;
    syncPsfn: () => Promise<void>;
  } {
    const [state, setState] = useState<DashboardState | null>(null);

    useEffect(() => {
      let alive = true;
      const poll = () => {
        SDK.fetchJSON<{ ok?: boolean; state?: DashboardState }>(`${apiBase}/state`)
          .then((res) => {
            if (alive && res?.state) setState(res.state);
          })
          .catch(() => {});
      };
      poll();
      const timer = window.setInterval(poll, 2500);
      return () => {
        alive = false;
        window.clearInterval(timer);
      };
    }, []);

    const perform = async (patch: Record<string, unknown>) => {
      const res = await SDK.fetchJSON<{ ok?: boolean; state?: DashboardState }>(`${apiBase}/perform`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (res?.state) setState(res.state);
    };

    const syncPsfn = async () => {
      const res = await SDK.fetchJSON<{ ok?: boolean; state?: DashboardState }>(`${apiBase}/psfn-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res?.state) setState(res.state);
    };

    return { state, perform, syncPsfn };
  }

  function StageCanvas({ state, heightPx }: { state: DashboardState; heightPx: number }) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const stageRef = useRef<StageRendererHandle | null>(null);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      let stage: StageRendererHandle | null = null;
      try {
        stage = createStageRenderer({
          canvas,
          fetchClip,
          fetchClipsManifest,
        });
        stageRef.current = stage;
      } catch {
        // Ignore if WebGL is unavailable in headless browser
      }
      return () => {
        stage?.dispose();
        if (stageRef.current === stage) stageRef.current = null;
      };
    }, []);

    const filename = state.active_model?.filename || 'Nous-Girl.vrm';
    const modelName = state.active_model?.name || 'Nous-Girl (VRM 0.x)';

    useEffect(() => {
      const stage = stageRef.current;
      if (!stage) return;
      const fallbackUrl =
        filename === 'DeepSeek-chan.vrm'
          ? 'https://raw.githubusercontent.com/tegnike/deepseek-chan-vrm/3aceb037df7a8b8126efea89d3a75664d1af868d/DeepSeek-chan.vrm'
          : 'https://raw.githubusercontent.com/CGIC-AI/nous-girl-vrm/d923c0567622403083f994a249b6a42997bd2049/nous-girl.vrm';
      fetch(`${apiBase}/models/file/${encodeURIComponent(filename)}`)
        .then((r) => (r.ok ? r.arrayBuffer() : fetch(fallbackUrl).then((r2) => r2.arrayBuffer())))
        .then((buf) => stage.loadVrmBuffer(buf, modelName))
        .catch(() => {});
    }, [filename, modelName]);

    useEffect(() => {
      stageRef.current?.updateState({
        active: state.mode !== 'hidden',
        animated: true,
        activity: state.activity,
        mood: state.mood,
        emotionalBase: state.emotional_base,
        reaction: state.reaction,
        clipFile: state.clip,
        cameraPreset: state.camera,
        speechText: state.speech_text,
        speechId: state.speech_Id,
        muted: state.muted,
      });
    }, [state]);

    return h('canvas', {
      ref: canvasRef,
      className: 'psfn-vrm-canvas',
      style: { width: '100%', height: `${heightPx}px`, display: 'block' },
    });
  }

  function DashboardFloatingOverlay() {
    const { state, perform } = useBackendState();
    if (!state || state.mode === 'hidden') return null;

    const w = Math.round(220 * (state.scale || 1));
    const hPx = Math.round(275 * (state.scale || 1));

    return h(
      'div',
      {
        className: `psfn-vrm-overlay corner-${state.corner || 'bottom-right'}`,
        style: { width: `${w}px`, height: `${hPx}px` },
      },
      h(StageCanvas, { state, heightPx: hPx }),
      h(
        'div',
        { className: 'psfn-vrm-overlay-pill' },
        h('span', null, `🎭 ${state.mood}`),
        h(
          'button',
          {
            type: 'button',
            onClick: () => void perform({ reaction: 'wave', mood: 'joy' }),
          },
          '👋',
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: () =>
              void perform({
                camera: state.camera === 'bust' ? 'waist' : state.camera === 'waist' ? 'full' : 'bust',
              }),
          },
          state.camera,
        ),
      ),
    );
  }

  function DashboardStudioPage() {
    const { state, perform, syncPsfn } = useBackendState();
    if (!state) {
      return h('div', { className: 'p-6 text-sm' }, 'Loading 3D VRM Avatar Studio…');
    }

    return h(
      'div',
      { className: 'psfn-vrm-studio' },
      h(
        'div',
        { className: 'psfn-vrm-studio-header' },
        h('h2', null, '3D VRM Avatar Studio · PSFN Embodiment'),
        h(
          'div',
          { className: 'psfn-vrm-btn-row' },
          (['floating', 'hidden'] as const).map((m) =>
            h(
              'button',
              {
                key: m,
                type: 'button',
                className: `psfn-vrm-btn ${state.mode === m ? 'active' : ''}`,
                onClick: () => void perform({ mode: m }),
              },
              m === 'floating' ? 'Floating Overlay On' : 'Overlay Hidden',
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'psfn-vrm-btn',
              onClick: () => void syncPsfn(),
            },
            'Sync PSFN Lite',
          ),
        ),
      ),
      h(
        'div',
        { className: 'psfn-vrm-studio-grid' },
        h(
          'div',
          { className: 'psfn-vrm-card' },
          h(StageCanvas, { state, heightPx: 360 }),
        ),
        h(
          'div',
          { className: 'psfn-vrm-card' },
          h('h3', null, `28 GoEmotions Moods (Active: ${state.mood})`),
          h(
            'div',
            { className: 'psfn-vrm-btn-wrap' },
            MOOD_NAMES.map((mood) =>
              h(
                'button',
                {
                  key: mood,
                  type: 'button',
                  className: `psfn-vrm-chip ${state.mood === mood ? 'active' : ''}`,
                  onClick: () => void perform({ mood }),
                },
                mood,
              ),
            ),
          ),
        ),
      ),
    );
  }

  REG.register(PLUGIN_ID, DashboardStudioPage);
  REG.registerSlot?.(PLUGIN_ID, 'overlay', DashboardFloatingOverlay);
}

mountDashboardPlugin();
