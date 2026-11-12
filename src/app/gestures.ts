// Turns hand positions from the webcam, frame by frame, into gestures: pinch to grab, move to drag,
// open the fingers to let go, and a quick sideways sweep of an open hand to swipe.

/** One hand's 21 landmarks, as MediaPipe gives them: x and y from 0 to 1 across the camera picture. */
export type Hand = { x: number; y: number }[];

export type Gesture =
  | { type: 'grab' }
  /** How far the hand moved since the last frame, as a share of the picture, already mirrored so right is the user's right. */
  | { type: 'drag'; dx: number; dy: number }
  | { type: 'release' }
  | { type: 'swipe'; direction: 'left' | 'right' };

const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_TIP = 8;
const MIDDLE_KNUCKLE = 9;
/** Thumb and index closer than this share of the hand's size: a pinch. Opened past the second: let go. */
const PINCH = 0.35;
const OPEN = 0.5;
/** A pinch must last this many frames, so a passing flicker grabs nothing. */
const HOLD_FRAMES = 2;
/** A swipe: the hand crosses this share of the picture within the time, mostly sideways. */
const SWIPE_DISTANCE = 0.25;
const SWIPE_MS = 400;
const SWIPE_REST_MS = 800;
/** Hand movement is smoothed over frames, so a shaky hand gives a steady drag. */
const SMOOTHING = 0.5;

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

export class Gestures {
  #pinching = false;
  #pinchFrames = 0;
  #last: { x: number; y: number } | undefined;
  #trail: { x: number; y: number; at: number }[] = [];
  #restUntil = 0;

  /** Feeds one camera frame (no hand: undefined) taken at `at` milliseconds; returns what the hand did. */
  update(hand: Hand | undefined, at: number): Gesture[] {
    if (!hand || hand.length < 21) {
      this.#trail = [];
      this.#last = undefined;
      this.#pinchFrames = 0;
      if (!this.#pinching) return [];
      this.#pinching = false; // the hand left the picture: let go
      return [{ type: 'release' }];
    }
    const size = distance(hand[WRIST]!, hand[MIDDLE_KNUCKLE]!) || 1;
    const gap = distance(hand[THUMB_TIP]!, hand[INDEX_TIP]!) / size;
    // The camera sees the user from the front, so its left is his right.
    const raw = { x: 1 - hand[MIDDLE_KNUCKLE]!.x, y: hand[MIDDLE_KNUCKLE]!.y };
    const point = this.#last ? { x: this.#last.x + (raw.x - this.#last.x) * SMOOTHING, y: this.#last.y + (raw.y - this.#last.y) * SMOOTHING } : raw;
    const out: Gesture[] = [];

    if (!this.#pinching) {
      this.#pinchFrames = gap < PINCH ? this.#pinchFrames + 1 : 0;
      if (this.#pinchFrames >= HOLD_FRAMES) {
        this.#pinching = true;
        this.#trail = [];
        out.push({ type: 'grab' });
      } else if (gap > OPEN) {
        out.push(...this.#swipe(raw, at));
      }
    } else if (gap > OPEN) {
      this.#pinching = false;
      this.#pinchFrames = 0;
      out.push({ type: 'release' });
    } else if (this.#last) {
      const dx = point.x - this.#last.x;
      const dy = point.y - this.#last.y;
      if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) out.push({ type: 'drag', dx, dy });
    }
    this.#last = point;
    return out;
  }

  #swipe(point: { x: number; y: number }, at: number): Gesture[] {
    this.#trail = [...this.#trail.filter((one) => at - one.at <= SWIPE_MS), { ...point, at }];
    if (at < this.#restUntil) return [];
    const first = this.#trail[0]!;
    const dx = point.x - first.x;
    const dy = point.y - first.y;
    if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dy) > Math.abs(dx) * 0.5) return [];
    this.#trail = [];
    this.#restUntil = at + SWIPE_REST_MS;
    return [{ type: 'swipe', direction: dx > 0 ? 'right' : 'left' }];
  }
}

type Box = { x: number; y: number; width: number; height: number };
/** A hand crossing the whole camera picture moves the window across about a screen. */
const GAIN = 1.2;

/** Where a dragged window goes: moved with the hand, and kept wholly on the screen so it cannot be lost. */
export function dragTo(from: { x: number; y: number }, move: { dx: number; dy: number }, area: Box, size: { width: number; height: number }): { x: number; y: number } {
  const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));
  return {
    x: clamp(from.x + move.dx * area.width * GAIN, area.x, area.x + area.width - size.width),
    y: clamp(from.y + move.dy * area.height * GAIN, area.y, area.y + area.height - size.height),
  };
}
