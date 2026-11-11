/**
 * Mouth shapes for spoken replies, derived from the reply text, without touching the host's audio.
 *
 * The plugin never patches browser or app objects, so it cannot read the audio Hermes plays. Instead it
 * reads the words of each finished reply (from the plugin's own turn hooks) and lays out a timeline of
 * vowel shapes, lip closures and punctuation pauses at a typical text-to-speech pace. Hosts that speak
 * with the Web Speech API are followed through the read-only `window.speechSynthesis.speaking` flag.
 *
 * The result tracks what is being said, not the exact waveform. Frame-accurate lip-sync needs the host
 * to expose its playback position or level to plugins.
 */

export type Vowel = 'aa' | 'ih' | 'ou' | 'ee' | 'oh';

export interface SpeechSample {
  /** True while a reply is estimated to be spoken, or the Web Speech API is speaking. */
  readonly speaking: boolean;
  /** Overall mouth openness (0..1). */
  readonly level: number;
  /** Target weight per vowel shape (0..1). */
  readonly visemes: Readonly<Record<Vowel, number>>;
}

interface Segment {
  readonly end: number;
  readonly vowel: Vowel | null;
  readonly open: number;
}

const NONE: Readonly<Record<Vowel, number>> = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
/** How wide each vowel opens the mouth. */
const OPEN: Readonly<Record<Vowel, number>> = { aa: 0.85, oh: 0.7, ou: 0.55, ee: 0.55, ih: 0.5 };
/** Letters spoken per second by the text-to-speech voices Hermes ships with. */
const LETTERS_PER_SECOND = 15.5;
/** Text-to-speech needs a moment to synthesize before any sound plays. */
const LEAD_IN_SEC = 0.7;
const MAX_SPEECH_SEC = 45;

const DIGRAPHS: Readonly<Record<string, Vowel>> = {
  oo: 'ou', ee: 'ee', ea: 'ee', ai: 'ee', ay: 'ee', ey: 'ee', ie: 'ee',
  oa: 'oh', ou: 'oh', ow: 'oh', au: 'oh', aw: 'oh', oi: 'oh', oy: 'oh', ue: 'ou', ew: 'ou',
};
const SINGLE: Readonly<Record<string, Vowel>> = { a: 'aa', e: 'ee', i: 'ih', o: 'oh', u: 'ou', y: 'ee' };

/** Lay out one word as (vowel, relative duration, openness) steps. */
function wordSteps(word: string): Array<[Vowel | null, number, number]> {
  const steps: Array<[Vowel | null, number, number]> = [];
  let last: Vowel = 'aa';
  for (let i = 0; i < word.length; i++) {
    const c = word[i]!;
    const pair = word.slice(i, i + 2);
    if (DIGRAPHS[pair]) {
      last = DIGRAPHS[pair]!;
      steps.push([last, 1.4, OPEN[last]]);
      i++;
    } else if (SINGLE[c] && !(c === 'y' && i === 0)) {
      // A final "e" after a consonant is usually silent ("make", "phone"), except in short words ("the", "me").
      if (c === 'e' && i === word.length - 1 && word.length > 3 && !SINGLE[word[i - 1]!]) continue;
      last = SINGLE[c]!;
      steps.push([last, 1.1, OPEN[last]]);
    } else if (c >= '0' && c <= '9') {
      steps.push(['ee', 2.2, OPEN.ee]);
    } else if ('bmp'.includes(c)) {
      steps.push([null, 0.7, 0]); // lips meet
    } else if ('fv'.includes(c)) {
      steps.push(['ih', 0.6, 0.18]);
    } else if (c === 'w') {
      steps.push(['ou', 0.6, 0.3]);
    } else {
      steps.push([last, 0.5, 0.2]); // other consonants: the mouth narrows but stays in shape
    }
  }
  return steps;
}

/** Build the viseme timeline (seconds from the first sound) for a reply. */
export function buildTimeline(text: string): Segment[] {
  const tokens = text.toLowerCase().match(/[a-z0-9']+|[.,!?;:—–-]+|\n+/g) ?? [];
  const segments: Segment[] = [];
  let t = 0;
  const push = (duration: number, vowel: Vowel | null, open: number): void => {
    t += duration;
    segments.push({ end: t, vowel, open });
  };
  for (const token of tokens) {
    if (t > MAX_SPEECH_SEC) break;
    if (/^[a-z0-9']/.test(token)) {
      const word = token.replace(/'/g, '');
      const steps = wordSteps(word);
      const units = steps.reduce((sum, s) => sum + s[1], 0);
      if (units <= 0) continue;
      // Each word takes as long as its letters, shared out among its sounds.
      const wordSec = Math.max(0.12, word.length / LETTERS_PER_SECOND);
      for (const [vowel, weight, open] of steps) push((wordSec * weight) / units, vowel, open);
      push(0.03, null, 0.08);
    } else {
      push(/[.!?\n]/.test(token) ? 0.6 : 0.14, null, 0);
    }
  }
  return segments;
}

export interface SpeechCadence {
  /** Start mouthing a reply; an empty string leaves the current one to finish. */
  noteReply(spoken: string): void;
  sample(dtSec: number): SpeechSample;
}

export function createSpeechCadence(): SpeechCadence {
  let clock = 0;
  let start = -1;
  let timeline: Segment[] = [];
  let index = 0;

  return {
    noteReply(spoken: string): void {
      const next = buildTimeline(spoken);
      if (next.length === 0) return;
      timeline = next;
      index = 0;
      start = clock + LEAD_IN_SEC;
    },

    sample(dtSec: number): SpeechSample {
      clock += Math.max(0, Math.min(0.1, dtSec));
      const at = clock - start;
      if (start >= 0 && at >= 0 && timeline.length > 0) {
        while (index < timeline.length && timeline[index]!.end <= at) index++;
        const seg = timeline[index];
        if (seg) {
          const visemes = seg.vowel ? { ...NONE, [seg.vowel]: seg.open } : NONE;
          return { speaking: true, level: seg.open, visemes };
        }
        timeline = [];
      }
      const webSpeech =
        typeof window !== 'undefined' &&
        Boolean(window.speechSynthesis?.speaking) &&
        !window.speechSynthesis.paused;
      if (!webSpeech) return { speaking: false, level: 0, visemes: NONE };
      // No text to follow here: fall back to a plain syllable rhythm.
      const level = Math.max(0.1, 0.5 + 0.32 * Math.sin(clock * Math.PI * 2 * 5.2) + 0.2 * Math.sin(clock * Math.PI * 2 * 8.3));
      const vowel: Vowel = (['aa', 'oh', 'ee', 'ih', 'ou'] as const)[Math.floor(clock * 4) % 5]!;
      return { speaking: true, level: Math.min(0.9, level), visemes: { ...NONE, [vowel]: Math.min(0.9, level) } };
    },
  };
}
