/**
 * Emotion, VAD quadrant, 28-class GoEmotions discrete label, and tool-activity
 * mapping. Ported from psfn-framework companion-ui/src/lib/sprites/emotion-mapping.ts.
 */

export type EmotionalBase =
  | 'neutral'
  | 'content'
  | 'happy'
  | 'excited'
  | 'laughing'
  | 'love'
  | 'curious'
  | 'surprised'
  | 'sad'
  | 'tired'
  | 'anxious'
  | 'grumpy'
  | 'smug'
  | 'embarrassed'
  | 'thinking'
  | 'asleep';

export type MoodName =
  | 'neutral'
  | 'admiration'
  | 'amusement'
  | 'anger'
  | 'annoyance'
  | 'approval'
  | 'caring'
  | 'confusion'
  | 'curiosity'
  | 'desire'
  | 'disappointment'
  | 'disapproval'
  | 'disgust'
  | 'embarrassment'
  | 'excitement'
  | 'fear'
  | 'gratitude'
  | 'grief'
  | 'joy'
  | 'love'
  | 'nervousness'
  | 'optimism'
  | 'pride'
  | 'realization'
  | 'relief'
  | 'remorse'
  | 'sadness'
  | 'surprise';

export const MOOD_NAMES: readonly MoodName[] = [
  'neutral',
  'admiration',
  'amusement',
  'anger',
  'annoyance',
  'approval',
  'caring',
  'confusion',
  'curiosity',
  'desire',
  'disappointment',
  'disapproval',
  'disgust',
  'embarrassment',
  'excitement',
  'fear',
  'gratitude',
  'grief',
  'joy',
  'love',
  'nervousness',
  'optimism',
  'pride',
  'realization',
  'relief',
  'remorse',
  'sadness',
  'surprise',
] as const;

export interface EmotionVector {
  readonly valence: number;
  readonly arousal: number;
  readonly dominance: number;
}

export interface DiscreteEmotionScore {
  readonly label: string;
  readonly score: number;
}

export interface EmotionSnapshotInput {
  readonly vector: EmotionVector;
  readonly discrete?: readonly DiscreteEmotionScore[];
  readonly receivedAtMs?: number;
}

export const EMOTION_SNAPSHOT_STALE_MS = 120_000;
export const TOOL_STARTED_STALE_MS = 45_000;
export const TOOL_DONE_HOLD_MS = 5_000;
export const DISCRETE_OVERRIDE_MIN = 0.4;

const VALENCE_MARGIN = 0.15;
const AROUSAL_FLAT = 0.15;
const AROUSAL_DROWSY = 0;
const AROUSAL_CALM = 0.35;
const AROUSAL_HIGH = 0.6;

export function vadQuadrantBase(vector: EmotionVector): EmotionalBase {
  const { valence, arousal, dominance } = vector;
  if (Math.abs(valence) < VALENCE_MARGIN && Math.abs(arousal) < AROUSAL_FLAT) {
    return 'neutral';
  }
  if (valence >= VALENCE_MARGIN) {
    if (arousal >= AROUSAL_HIGH) return 'excited';
    if (arousal < AROUSAL_CALM) return 'content';
    return 'happy';
  }
  if (valence <= -VALENCE_MARGIN) {
    if (arousal < AROUSAL_DROWSY) return 'tired';
    if (arousal >= AROUSAL_CALM) {
      return dominance >= 0 ? 'grumpy' : 'anxious';
    }
    return 'sad';
  }
  return arousal >= AROUSAL_CALM ? 'curious' : 'neutral';
}

export const DISCRETE_BASE: Readonly<Record<string, EmotionalBase>> = {
  neutral: 'neutral',
  admiration: 'happy',
  amusement: 'laughing',
  anger: 'grumpy',
  annoyance: 'grumpy',
  approval: 'content',
  caring: 'love',
  confusion: 'curious',
  curiosity: 'curious',
  desire: 'love',
  disappointment: 'sad',
  disapproval: 'grumpy',
  disgust: 'grumpy',
  embarrassment: 'embarrassed',
  excitement: 'excited',
  fear: 'anxious',
  gratitude: 'happy',
  grief: 'sad',
  joy: 'happy',
  love: 'love',
  nervousness: 'anxious',
  optimism: 'happy',
  pride: 'smug',
  realization: 'surprised',
  relief: 'content',
  remorse: 'sad',
  sadness: 'sad',
  surprise: 'surprised',
};

export function emotionalBaseFromSnapshot(snapshot: EmotionSnapshotInput): EmotionalBase {
  const vadBase = vadQuadrantBase(snapshot.vector);
  const discrete = snapshot.discrete ?? [];
  let best: DiscreteEmotionScore | null = null;
  for (const item of discrete) {
    if (!Number.isFinite(item.score) || item.score < DISCRETE_OVERRIDE_MIN) continue;
    if (!best || item.score > best.score) best = item;
  }
  if (!best) return vadBase;
  const mapped = DISCRETE_BASE[best.label.toLowerCase()];
  return mapped ?? vadBase;
}

/** Standard VRM 0.x / 1.0 preset expression for each EmotionalBase. */
export const VRM_PRESET_FOR_BASE: Readonly<Record<EmotionalBase, 'happy' | 'relaxed' | 'surprised' | 'sad' | 'angry' | null>> = {
  neutral: null,
  content: 'relaxed',
  happy: 'happy',
  excited: 'happy',
  laughing: 'happy',
  love: 'happy',
  curious: 'surprised',
  surprised: 'surprised',
  sad: 'sad',
  tired: 'relaxed',
  anxious: 'sad',
  grumpy: 'angry',
  smug: 'happy',
  embarrassed: 'relaxed',
  thinking: null,
  asleep: 'relaxed',
};
