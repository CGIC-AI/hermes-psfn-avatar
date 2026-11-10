/**
 * Browser runtime for the VRM + ARDY companion lane: behavior selection,
 * crossfade transitions, 27 clip-timed mood expression envelopes, and
 * speech-driven mouth motion.
 * Ported from /home/vega/Projects/psfn/avatar-demo/companion-player.js.
 */

import type { VrmClipPlayer } from './vrm-clip-player.ts';

export interface ExpressionAdapter {
  getValue?(name: string): number | null | undefined;
  setValue(name: string, value: number): void;
  resetValues?(): void;
}

export interface AudioClockAdapter {
  speechTime: number | null;
  speechLevel: number;
}

export interface ClipManifestEntry {
  readonly name: string;
  readonly url: string;
  readonly state: 'Idle' | 'Talking' | 'Thinking' | 'Listening' | 'Reaction' | 'Mood' | string;
  readonly expression: string;
  readonly loop?: boolean;
  readonly tags?: readonly string[];
  readonly sourceId?: string;
}

interface MoodOverlay {
  base: number;
  weight: number;
  release: { from: number; elapsed: number } | null;
}

export class CompanionPlayer {
  readonly body: VrmClipPlayer;
  readonly expressions: ExpressionAdapter | null;
  readonly audio: AudioClockAdapter;
  readonly onState?: (state: string, detail?: string) => void;
  readonly log?: (msg: string, level?: string) => void;
  readonly onExpression?: (name: string, value: number) => void;

  mode: 'auto' | 'preview' | 'stream' | string = 'auto';
  state: string | null = null;
  level = 0;
  library: ClipManifestEntry[] = [];
  ready = false;
  sequence = 0;
  variantByState = new Map<string, number>();
  selecting = false;
  previewLoading = false;
  moodOverlays = new Map<string, MoodOverlay>();
  activeMood: { name: string; from: number } | null = null;

  constructor(
    body: VrmClipPlayer,
    expressions: ExpressionAdapter | null,
    audio: AudioClockAdapter,
    callbacks: {
      onState?: (state: string, detail?: string) => void;
      log?: (msg: string, level?: string) => void;
      onExpression?: (name: string, value: number) => void;
    } = {},
  ) {
    this.body = body;
    this.expressions = expressions;
    this.audio = audio;
    this.onState = callbacks.onState;
    this.log = callbacks.log;
    this.onExpression = callbacks.onExpression;
  }

  async init(library: ClipManifestEntry[], preloadInitialOnly = true): Promise<void> {
    this.library = library;
    const toPreload = preloadInitialOnly
      ? library.filter((c) => c.state === 'Idle' || c.state === 'Talking' || c.state === 'Thinking')
      : library;
    await Promise.all(toPreload.map((clip) => this.body.preload(clip.url)));
    this.ready = true;
  }

  dispose(): void {
    this.ready = false;
    this.sequence++;
    this.body.cancelPendingLoad();
    for (const [name, overlay] of this.moodOverlays) {
      this.writeExpression(name, overlay.base);
    }
    this.moodOverlays.clear();
    this.activeMood = null;
  }

  writeExpression(name: string, value: number): void {
    this.expressions?.setValue(name, value);
    this.onExpression?.(name, value);
  }

  setExpression(name: string, value: number): void {
    if (this.activeMood?.name === name) this.activeMood = null;
    this.moodOverlays.delete(name);
    this.writeExpression(name, value);
  }

  resetExpressions(): void {
    this.activeMood = null;
    this.moodOverlays.clear();
    this.expressions?.resetValues?.();
  }

  releaseMood(): void {
    if (!this.activeMood) return;
    const overlay = this.moodOverlays.get(this.activeMood.name);
    if (overlay) {
      overlay.release = { from: overlay.weight, elapsed: 0 };
    }
    this.activeMood = null;
  }

  startMood(url: string): void {
    const clip = this.library.find((c) => c.url === url && c.state === 'Mood');
    const name = clip?.expression;
    if (!name) return;
    const base = this.expressions?.getValue?.(name) ?? 0;
    if (!Number.isFinite(base)) return;
    let overlay = this.moodOverlays.get(name);
    if (!overlay) {
      overlay = { base, weight: 0, release: null };
      this.moodOverlays.set(name, overlay);
    }
    overlay.release = null;
    this.activeMood = { name, from: overlay.weight };
  }

  updateMood(dt: number): void {
    const ease = (value: number): number => {
      const t = Math.max(0, Math.min(1, value));
      return t * t * (3 - 2 * t);
    };
    if (this.activeMood) {
      const { name, from } = this.activeMood;
      const overlay = this.moodOverlays.get(name);
      if (overlay) {
        const { t, duration, completedLoops } = this.body;
        const attack = Math.min(0.4, duration / 2);
        const release = Math.min(0.5, duration / 2);
        const start = completedLoops ? 0 : from;
        overlay.weight =
          (start + (1 - start) * ease(attack > 0 ? t / attack : 1)) *
          ease(release > 0 ? (duration - t) / release : 1);
        if (!this.body.loop && t >= duration) this.activeMood = null;
      }
    }
    for (const [name, overlay] of this.moodOverlays) {
      if (overlay.release) {
        overlay.release.elapsed += dt;
        overlay.weight = overlay.release.from * (1 - ease(overlay.release.elapsed / 0.4));
      }
      this.writeExpression(name, overlay.base + (1 - overlay.base) * overlay.weight);
      if (overlay.weight === 0 && this.activeMood?.name !== name) {
        this.moodOverlays.delete(name);
      }
    }
  }

  setMode(mode: string): void {
    this.releaseMood();
    this.mode = mode;
    this.state = null;
    this.previewLoading = false;
    this.selecting = false;
    this.sequence++;
    this.body.cancelPendingLoad();
  }

  async preview(url: string, loop = false): Promise<void> {
    this.setMode('preview');
    this.state = 'Preview';
    const sequence = this.sequence;
    this.previewLoading = true;
    try {
      await this.body.load(url);
      if (sequence !== this.sequence) return;
      this.body.play({ loop, fadeSeconds: 0.4 });
      this.startMood(url);
      this.onState?.('Preview', url.split('/').pop());
    } catch (error) {
      if (sequence === this.sequence) this.setMode('auto');
      throw error;
    } finally {
      if (sequence === this.sequence) this.previewLoading = false;
    }
  }

  async select(state: string, advance = false): Promise<void> {
    this.state = state;
    const sequence = ++this.sequence;
    this.body.cancelPendingLoad();
    let choices = this.library.filter(
      (c) => c.state === state && c.expression === 'Neutral' && c.loop !== false,
    );
    if (!choices.length) {
      choices = this.library.filter((c) => c.state === 'Idle' && c.expression === 'Neutral');
    }
    const previous = this.variantByState.get(state) ?? -1;
    const index = choices.length ? (previous + 1) % choices.length : 0;
    const clip = choices[index];
    if (!clip) {
      this.onState?.('Error', 'No idle clip available');
      return;
    }
    if (advance && choices.length < 2) return;
    this.variantByState.set(state, index);
    this.onState?.(
      state,
      clip.state === state ? clip.name : `using ${clip.state.toLowerCase()} motion`,
    );
    this.selecting = true;
    try {
      if (this.body.url !== clip.url || !this.body.playing) {
        const fadeSeconds = this.body.clip ? 0.4 : 0;
        await this.body.load(clip.url);
        if (sequence !== this.sequence) return;
        this.body.play({ loop: true, fadeSeconds });
        if (!fadeSeconds) this.body.update(0);
      }
    } catch (error) {
      if (sequence !== this.sequence) return;
      const msg = error instanceof Error ? error.message : String(error);
      this.onState?.('Error', msg);
      this.log?.(`motion: ${msg}`, 'err');
    } finally {
      if (sequence === this.sequence) this.selecting = false;
    }
  }

  update(
    dt: number,
    { thinking = false, listening = false, enabled = true }: { thinking?: boolean; listening?: boolean; enabled?: boolean } = {},
  ): void {
    const speaking = this.audio.speechTime !== null;
    if (this.ready && enabled && this.mode !== 'stream') {
      if (this.mode === 'preview') {
        if (!this.previewLoading && !this.body.playing) this.setMode('auto');
      }
      if (this.mode !== 'preview') {
        const nextState =
          this.mode === 'auto'
            ? speaking
              ? 'Talking'
              : thinking
                ? 'Thinking'
                : listening
                  ? 'Listening'
                  : 'Idle'
            : this.mode;
        if (nextState !== this.state) void this.select(nextState);
      }
      this.body.update(dt);
      if (this.mode !== 'preview' && !this.selecting && this.body.completedLoops >= 2 && this.state) {
        this.body.completedLoops = 0;
        void this.select(this.state, true);
      }
    }

    this.updateMood(dt);

    const target = speaking ? this.audio.speechLevel : 0;
    if (speaking || this.level > 0) {
      this.level +=
        (target - this.level) * (1 - Math.exp(-dt / (target > this.level ? 0.035 : 0.08)));
      if (!speaking && this.level < 0.001) this.level = 0;
      this.expressions?.setValue('aa', this.level);
    }
  }
}
