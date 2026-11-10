/**
 * Avatar pointer gesture classification and touch-region interaction mapping.
 * Ported from psfn-framework companion-ui/src/lib/avatar-interactions.ts.
 */

export type TouchRegion = 'head' | 'cheek' | 'body';
export type TouchStimulusKind = 'headpat' | 'petting' | 'hug' | 'kiss';
export type AvatarGesture = 'tap' | 'double-tap' | 'long-press' | 'drag';

export interface TouchInteractionInput {
  readonly kind: TouchStimulusKind;
  readonly region: TouchRegion;
  readonly durationMs: number;
}

export interface AvatarGestureSample {
  readonly durationMs: number;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly sinceLastTapMs: number;
}

export const DOUBLE_TAP_MS = 340;
export const LONG_PRESS_MS = 550;
export const MOVE_GESTURE_PX = 18;

export const AVATAR_REGION_GESTURES: Readonly<Record<TouchRegion, readonly AvatarGesture[]>> = {
  head: ['tap', 'drag'],
  cheek: ['double-tap', 'tap'],
  body: ['long-press', 'tap'],
};

export const REACTION_COPY: Readonly<Record<TouchStimulusKind, string>> = {
  headpat: 'Headpat ♥',
  petting: 'Gentle petting ✦',
  hug: 'Hug ♡',
  kiss: 'Boop ♥',
};

export const TOUCH_TO_REACTION_CLIP: Readonly<Record<TouchStimulusKind, { mood: string; reaction: string }>> = {
  headpat: { mood: 'joy', reaction: 'celebrate' },
  petting: { mood: 'caring', reaction: 'nod' },
  hug: { mood: 'love', reaction: 'reach' },
  kiss: { mood: 'embarrassment', reaction: 'thanks' },
};

export function classifyAvatarGesture(
  sample: AvatarGestureSample,
  supported: readonly AvatarGesture[],
): AvatarGesture {
  const distancePx = Math.hypot(sample.deltaX, sample.deltaY);
  if (distancePx >= MOVE_GESTURE_PX && supported.includes('drag')) return 'drag';
  if (sample.durationMs >= LONG_PRESS_MS && supported.includes('long-press')) return 'long-press';
  if (sample.sinceLastTapMs <= DOUBLE_TAP_MS && supported.includes('double-tap')) return 'double-tap';
  return 'tap';
}

export function mapAvatarInteraction(
  region: TouchRegion,
  gesture: AvatarGesture,
  durationMs: number,
): TouchInteractionInput | null {
  if (region === 'head' && gesture === 'tap') {
    return { kind: 'headpat', region, durationMs };
  }
  if (region === 'head' && gesture === 'drag') {
    return { kind: 'petting', region, durationMs };
  }
  if (region === 'body' && (gesture === 'long-press' || gesture === 'tap')) {
    return { kind: 'hug', region, durationMs };
  }
  if (region === 'cheek' && (gesture === 'double-tap' || gesture === 'tap')) {
    return { kind: 'kiss', region, durationMs };
  }
  return null;
}
