import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import { DirRepeat } from './MenuNav';

const M = CONFIG.gamepad.menu;

describe('menu auto-repeat', () => {
  it('steps on the first frame, again after the delay, then at the interval', () => {
    const r = new DirRepeat(M.repeatDelay, M.repeatInterval);
    const dt = 1 / 60;
    const steps: number[] = [];
    for (let f = 0; f < 60; f++) if (r.step('down', dt)) steps.push(f);
    // 1 s held: frame 0, then ~0.35 s, then every ~0.12 s.
    expect(steps[0]).toBe(0);
    expect(steps[1] * dt).toBeCloseTo(M.repeatDelay, 1);
    expect((steps[2] - steps[1]) * dt).toBeCloseTo(M.repeatInterval, 1);
    expect(steps.length).toBe(1 + 1 + Math.floor((60 * dt - steps[1] * dt) / M.repeatInterval + 1e-9));
  });
  it('a new direction steps at once; release resets', () => {
    const r = new DirRepeat(0.35, 0.12);
    expect(r.step('down', 0.016)).toBe(true);
    expect(r.step('down', 0.016)).toBe(false);
    expect(r.step('right', 0.016)).toBe(true);
    expect(r.step(null, 0.016)).toBe(false);
    expect(r.step('right', 0.016)).toBe(true);
  });
  it('hold(): a direction already held when a screen opens does not step until the delay', () => {
    const r = new DirRepeat(0.35, 0.12);
    r.hold('up');
    expect(r.step('up', 0.016)).toBe(false);
    let t = 0.016;
    while (!r.step('up', 0.016)) t += 0.016;
    expect(t).toBeGreaterThan(0.3);
  });
});
