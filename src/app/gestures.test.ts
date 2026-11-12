import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dragTo, type Hand, Gestures } from './gestures.ts';

/** A pretend hand centred at (x, y), with the thumb and index tips `gap` apart (the hand is 0.2 tall). */
const hand = (x: number, y: number, gap: number): Hand => {
  const points = Array.from({ length: 21 }, () => ({ x, y }));
  points[0] = { x, y: y + 0.2 }; // wrist
  points[9] = { x, y }; // middle knuckle
  points[4] = { x: x - gap / 2, y: y - 0.05 }; // thumb tip
  points[8] = { x: x + gap / 2, y: y - 0.05 }; // index tip
  return points;
};

test('a pinch held for two frames grabs, moving drags (mirrored), and opening the fingers lets go', () => {
  const gestures = new Gestures();
  assert.deepEqual(gestures.update(hand(0.5, 0.5, 0.02), 0), [], 'one frame is not enough');
  assert.deepEqual(gestures.update(hand(0.5, 0.5, 0.02), 33), [{ type: 'grab' }]);
  const moved = gestures.update(hand(0.4, 0.5, 0.02), 66);
  assert.equal(moved.length, 1);
  assert.equal(moved[0]!.type, 'drag');
  assert.ok(moved[0]!.type === 'drag' && moved[0]!.dx > 0, 'the camera\'s left is his right');
  assert.deepEqual(gestures.update(hand(0.4, 0.5, 0.15), 99), [{ type: 'release' }]);
});

test('a hand that leaves the picture lets go; a flicker of a pinch grabs nothing', () => {
  const gestures = new Gestures();
  gestures.update(hand(0.5, 0.5, 0.02), 0);
  gestures.update(hand(0.5, 0.5, 0.02), 33);
  assert.deepEqual(gestures.update(undefined, 66), [{ type: 'release' }]);
  assert.deepEqual(gestures.update(undefined, 99), []);
  assert.deepEqual(gestures.update(hand(0.5, 0.5, 0.02), 132), []);
  assert.deepEqual(gestures.update(hand(0.5, 0.5, 0.15), 165), []);
});

test('a quick sideways sweep of an open hand swipes, once, then rests', () => {
  const gestures = new Gestures();
  const seen = [0.8, 0.7, 0.6, 0.5, 0.4].flatMap((x, frame) => gestures.update(hand(x, 0.5, 0.15), frame * 50));
  assert.deepEqual(seen, [{ type: 'swipe', direction: 'right' }]);
  assert.deepEqual([0.3, 0.2].flatMap((x, frame) => gestures.update(hand(x, 0.5, 0.15), 250 + frame * 50)), [], 'no second swipe straight away');
  const slow = new Gestures();
  assert.deepEqual([0.8, 0.7, 0.6, 0.5, 0.4].flatMap((x, frame) => slow.update(hand(x, 0.5, 0.15), frame * 300)), [], 'a slow movement is not a swipe');
  const down = new Gestures();
  assert.deepEqual([0.2, 0.35, 0.5, 0.65].flatMap((y, frame) => down.update(hand(0.5, y, 0.15), frame * 50)), [], 'an up or down movement is not a sideways swipe');
});

test('a dragged window follows the hand but stays wholly on screen', () => {
  const area = { x: 0, y: 25, width: 1800, height: 1100 };
  const size = { width: 700, height: 470 };
  assert.deepEqual(dragTo({ x: 1000, y: 600 }, { dx: -0.1, dy: 0.025 }, area, size), { x: 784, y: 633 });
  assert.deepEqual(dragTo({ x: 1000, y: 600 }, { dx: -0.9, dy: -0.9 }, area, size), { x: 0, y: 25 });
  assert.deepEqual(dragTo({ x: 1000, y: 600 }, { dx: 0.9, dy: 0.9 }, area, size), { x: 1100, y: 655 });
});
