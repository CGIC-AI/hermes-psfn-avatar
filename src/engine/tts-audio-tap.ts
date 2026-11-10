/**
 * Non-intrusive real-time TTS audio tap for Hermes Desktop & Web Dashboard.
 *
 * Automatically detects and extracts real-time voice amplitude + vowel formants from:
 * 1. Web Audio `AudioBufferSourceNode.prototype.start` (Hermes Desktop `/api/audio/speak-stream` PCM stream).
 * 2. `HTMLMediaElement.prototype.play` (`new Audio(blobUrl | dataUrl)` in Hermes Desktop client-direct & fallback TTS).
 * 3. `window.speechSynthesis` (Browser Web Speech API fallback).
 *
 * Never reroutes `<audio>` elements through `createMediaElementSource`, so native audio playback
 * can never be muted or disrupted.
 */

export interface TtsAudioSample {
  /** True when any TTS audio stream or element is actively playing right now. */
  readonly speaking: boolean;
  /** Normalized mouth openness envelope (0..1). */
  readonly level: number;
  /** High-frequency zero-crossing ratio (0..1) for blending `aa` / `ih` / `ou` / `ee` / `oh` visemes. */
  readonly brightness: number;
}

interface ScheduledBufferSegment {
  readonly context: BaseAudioContext;
  readonly buffer: AudioBuffer;
  readonly startAt: number;
  readonly offset: number;
  readonly duration: number;
  stopped: boolean;
}

interface GlobalTapState {
  readonly segments: Set<ScheduledBufferSegment>;
  readonly mediaElements: Set<HTMLMediaElement>;
  readonly decodedBuffers: WeakMap<HTMLMediaElement, AudioBuffer>;
  readonly decodingSrcs: WeakMap<HTMLMediaElement, string>;
  decodeCtx: AudioContext | null;
  phaseSec: number;
  lastSampleMs: number;
}

const TAP_KEY = '__PSFN_TTS_AUDIO_TAP_V1__';

function measureBufferWindow(
  buffer: AudioBuffer,
  timeOffsetSec: number,
): { rms: number; zcr: number } {
  if (buffer.numberOfChannels <= 0 || buffer.length <= 0) {
    return { rms: 0, zcr: 0 };
  }
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate || 24000;
  const centerIdx = Math.floor(timeOffsetSec * sr);
  const halfWindow = Math.max(64, Math.floor(sr * 0.018)); // ~36ms window
  const startIdx = Math.max(0, centerIdx - halfWindow);
  const endIdx = Math.min(data.length, centerIdx + halfWindow);
  const count = endIdx - startIdx;
  if (count <= 1) {
    return { rms: 0, zcr: 0 };
  }

  let sumSq = 0;
  let crossings = 0;
  let prev = data[startIdx]!;
  for (let i = startIdx; i < endIdx; i++) {
    const s = data[i]!;
    sumSq += s * s;
    if ((s >= 0 && prev < 0) || (s < 0 && prev >= 0)) {
      crossings++;
    }
    prev = s;
  }

  const rms = Math.sqrt(sumSq / count);
  const zcr = Math.min(1, crossings / (count * 0.28));
  return { rms, zcr };
}

function getOrInstallGlobalTap(): GlobalTapState | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as Record<string, unknown>;
  const existing = win[TAP_KEY] as GlobalTapState | undefined;
  if (existing) return existing;

  const state: GlobalTapState = {
    segments: new Set(),
    mediaElements: new Set(),
    decodedBuffers: new WeakMap(),
    decodingSrcs: new WeakMap(),
    decodeCtx: null,
    phaseSec: 0,
    lastSampleMs: typeof performance !== 'undefined' ? performance.now() : Date.now(),
  };

  // 1. Hook AudioBufferSourceNode.prototype.start (Hermes `/api/audio/speak-stream` PCM playback)
  if (typeof AudioBufferSourceNode !== 'undefined' && AudioBufferSourceNode.prototype?.start) {
    const origStart = AudioBufferSourceNode.prototype.start;
    const origStop = AudioBufferSourceNode.prototype.stop;

    AudioBufferSourceNode.prototype.start = function (
      when?: number,
      offset?: number,
      duration?: number,
    ): void {
      try {
        const buf = this.buffer;
        if (buf && buf.duration > 0.01 && this.context) {
          const now = this.context.currentTime;
          const startAt = typeof when === 'number' && when > now ? when : now;
          const off = typeof offset === 'number' && offset > 0 ? offset : 0;
          const dur =
            typeof duration === 'number' && duration > 0
              ? duration
              : Math.max(0, buf.duration - off);
          if (dur > 0.01) {
            const seg: ScheduledBufferSegment = {
              context: this.context,
              buffer: buf,
              startAt,
              offset: off,
              duration: dur,
              stopped: false,
            };
            state.segments.add(seg);
            this.addEventListener(
              'ended',
              () => {
                seg.stopped = true;
                state.segments.delete(seg);
              },
              { once: true },
            );
            (this as unknown as { __psfnSeg?: ScheduledBufferSegment }).__psfnSeg = seg;
          }
        }
      } catch {
        // Never interfere with host audio
      }
      return origStart.apply(this, arguments as unknown as [number?, number?, number?]);
    };

    if (origStop) {
      AudioBufferSourceNode.prototype.stop = function (when?: number): void {
        try {
          const seg = (this as unknown as { __psfnSeg?: ScheduledBufferSegment }).__psfnSeg;
          if (seg && (when === undefined || when <= this.context.currentTime)) {
            seg.stopped = true;
            state.segments.delete(seg);
          }
        } catch {
          // Ignore
        }
        return origStop.apply(this, arguments as unknown as [number?]);
      };
    }
  }

  // 2. Hook HTMLMediaElement.prototype.play (Hermes client-direct & data-URL `new Audio(url)`)
  if (typeof HTMLMediaElement !== 'undefined' && HTMLMediaElement.prototype?.play) {
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (): Promise<void> {
      try {
        state.mediaElements.add(this);
        const cleanup = () => {
          state.mediaElements.delete(this);
        };
        this.addEventListener('ended', cleanup, { once: true });
        this.addEventListener('error', cleanup, { once: true });

        // Decode blob: or data: audio in the background so we get exact waveform RMS at `audio.currentTime`
        const src = this. currentSrc || this.src || '';
        if (
          (src.startsWith('blob:') || src.startsWith('data:audio/')) &&
          state.decodingSrcs.get(this) !== src
        ) {
          state.decodingSrcs.set(this, src);
          const el = this;
          void fetch(src)
            .then((r) => r.arrayBuffer())
            .then(async (ab) => {
              const Ctor =
                window.AudioContext ||
                (window as unknown as { webkitAudioContext?: typeof AudioContext })
                  .webkitAudioContext;
              if (!Ctor) return;
              if (!state.decodeCtx || state.decodeCtx.state === 'closed') {
                state.decodeCtx = new Ctor();
              }
              const decoded = await state.decodeCtx.decodeAudioData(ab.slice(0));
              state.decodedBuffers.set(el, decoded);
            })
            .catch(() => {
              // Fallback cadence envelope will be used automatically
            });
        }
      } catch {
        // Never interfere with host audio
      }
      return origPlay.apply(this, arguments as unknown as []);
    };
  }

  win[TAP_KEY] = state;
  return state;
}

/**
 * Sample the current live TTS audio state across the window.
 */
export function sampleTtsAudio(dtSec = 0.016): TtsAudioSample {
  const state = getOrInstallGlobalTap();
  if (!state) {
    return { speaking: false, level: 0, brightness: 0 };
  }

  state.phaseSec += Math.max(0, Math.min(0.1, dtSec));

  let activeSpeaking = false;
  let maxLevel = 0;
  let bestBrightness = 0.35;

  // 1. Check active Web Audio PCM segments (`/api/audio/speak-stream`)
  for (const seg of [...state.segments]) {
    const ctxState = (seg.context as AudioContext).state;
    const now = seg.context.currentTime;
    if (seg.stopped || ctxState === 'closed' || now > seg.startAt + seg.duration + 0.05) {
      state.segments.delete(seg);
      continue;
    }
    if (ctxState === 'running' && now >= seg.startAt - 0.02 && now <= seg.startAt + seg.duration) {
      activeSpeaking = true;
      const offsetInBuf = seg.offset + Math.max(0, now - seg.startAt);
      const { rms, zcr } = measureBufferWindow(seg.buffer, offsetInBuf);
      // Convert RMS (typically 0.02..0.28 for speech) into 0..1 mouth openness
      const level = Math.min(1, Math.max(0, (rms - 0.008) * 5.2));
      if (level >= maxLevel) {
        maxLevel = level;
        bestBrightness = zcr;
      }
    }
  }

  // 2. Check active HTMLMediaElements (`new Audio(url)`)
  for (const el of [...state.mediaElements]) {
    if (el.ended || el.error) {
      state.mediaElements.delete(el);
      continue;
    }
    if (!el.paused && el.readyState >= 2) {
      activeSpeaking = true;
      const decoded = state.decodedBuffers.get(el);
      if (decoded) {
        const { rms, zcr } = measureBufferWindow(decoded, el.currentTime);
        const level = Math.min(1, Math.max(0, (rms - 0.008) * 5.2));
        if (level >= maxLevel) {
          maxLevel = level;
          bestBrightness = zcr;
        }
      } else {
        // Natural syllable cadence while decoding or on cross-origin stream
        const t = state.phaseSec;
        const cadence =
          0.48 +
          0.32 * Math.sin(t * Math.PI * 2 * 5.4) +
          0.22 * Math.sin(t * Math.PI * 2 * 8.7) +
          0.12 * Math.cos(t * Math.PI * 2 * 3.1);
        const level = Math.max(0.1, Math.min(0.95, cadence));
        if (level >= maxLevel) {
          maxLevel = level;
          bestBrightness = 0.4 + 0.3 * Math.sin(t * 11.0);
        }
      }
    }
  }

  // 3. Check Web Speech API (`window.speechSynthesis`)
  if (
    typeof window !== 'undefined' &&
    window.speechSynthesis?.speaking &&
    !window.speechSynthesis.paused
  ) {
    activeSpeaking = true;
    const t = state.phaseSec;
    const cadence =
      0.5 +
      0.32 * Math.sin(t * Math.PI * 2 * 5.2) +
      0.2 * Math.sin(t * Math.PI * 2 * 8.3);
    maxLevel = Math.max(maxLevel, Math.max(0.12, Math.min(0.92, cadence)));
  }

  return {
    speaking: activeSpeaking,
    level: activeSpeaking ? maxLevel : 0,
    brightness: activeSpeaking ? bestBrightness : 0,
  };
}
