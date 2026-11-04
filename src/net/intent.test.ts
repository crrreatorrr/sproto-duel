import { describe, expect, it } from 'vitest';
import { ACTION_KEYS, type ActionKey } from '../wizard/Wizard';
import { ACTION_BITS, applyIntentFrame, dequantizeAngle, encodeIntent, packFrames, pressCounters, quantizeAngle, unpackFrames, type IntentLike, type Vec3Like } from './intent';

function vec(): Vec3Like {
  return { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } };
}

function fakeIntent(): IntentLike & { log: ActionKey[] } {
  const presses = pressCounters();
  const log: ActionKey[] = [];
  return {
    move: vec(), sprint: false, holdBolt: false, facing: 0, presses, log,
    press(a) { presses[a]++; log.push(a); },
  };
}

describe('intent frames', () => {
  it('keeps the bit order of Wizard ACTION_KEYS', () => {
    expect([...ACTION_BITS]).toEqual([...ACTION_KEYS]);
  });

  it('round-trips within quantization', () => {
    const a = fakeIntent();
    a.move.set(0.6, 0, -0.8);
    a.facing = 2.5;
    a.holdBolt = true;
    a.press('blast');
    a.press('jump');
    const aim = vec();
    aim.set(3.217, 1.204, -18.5);
    const frame = encodeIntent(a, aim, pressCounters(), 42);
    const [back] = unpackFrames(packFrames([frame]));
    expect(back).toEqual(frame);

    const b = fakeIntent();
    const aimB = vec();
    applyIntentFrame(back, b, aimB);
    expect(b.move.x).toBeCloseTo(0.6, 1);
    expect(b.move.z).toBeCloseTo(-0.8, 1);
    expect(Math.abs(b.facing - 2.5)).toBeLessThan(2e-4);
    expect(Math.abs(aimB.x - 3.217)).toBeLessThanOrEqual(0.005);
    expect(aimB.z).toBeCloseTo(-18.5, 2);
    expect(b.holdBolt).toBe(true);
    expect(b.sprint).toBe(false);
    expect(b.log.sort()).toEqual(['blast', 'jump']);
  });

  it('sets each press bit once, however many samples follow', () => {
    const a = fakeIntent();
    const last = pressCounters();
    a.press('dodge');
    const f1 = encodeIntent(a, vec(), last, 1);
    const f2 = encodeIntent(a, vec(), last, 2);
    expect(f1.press).toBe(1 << ACTION_BITS.indexOf('dodge'));
    expect(f2.press).toBe(0);
    // Batched with others: the edge survives packing.
    a.press('shield');
    const frames = [f1, f2, encodeIntent(a, vec(), last, 3)];
    const back = unpackFrames(packFrames(frames));
    expect(back.map((f) => f.press)).toEqual(frames.map((f) => f.press));
  });

  it('ignores unknown bits and clamps out-of-range values', () => {
    const b = fakeIntent();
    const aim = vec();
    applyIntentFrame({ tick: 1, mx: 900, mz: -900, facing: 99999, aim: [1e12, 0, -1e12], held: 0xff, press: 0xffffffff }, b, aim);
    expect(Math.hypot(b.move.x, b.move.z)).toBeLessThanOrEqual(1 + 1e-9);
    expect(b.facing).toBeGreaterThanOrEqual(0);
    expect(b.facing).toBeLessThan(Math.PI * 2);
    expect(Math.abs(aim.x)).toBeLessThanOrEqual(500);
    expect(b.log.length).toBe(ACTION_BITS.length);
    // Garbage in packed form is skipped, not thrown.
    expect(unpackFrames('nope')).toEqual([]);
    expect(unpackFrames([1, 2, 'x', 4, 5, 6, 7, 8, 1, 0, 0, 0, 0, 0, 0, 0])).toHaveLength(1);
  });

  it('wraps angles', () => {
    expect(quantizeAngle(-Math.PI / 2)).toBe(quantizeAngle(Math.PI * 1.5));
    expect(dequantizeAngle(quantizeAngle(Math.PI))).toBeCloseTo(Math.PI, 3);
  });
});
