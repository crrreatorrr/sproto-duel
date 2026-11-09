import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import { DirRepeat, menuKey } from './MenuNav';

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

describe('menu keys', () => {
  it('arrows and W / S move, Enter / Space press', () => {
    expect(menuKey('ArrowUp', 'button')).toBe('up');
    expect(menuKey('KeyW', 'button')).toBe('up');
    expect(menuKey('ArrowDown', 'button')).toBe('down');
    expect(menuKey('KeyS', 'button')).toBe('down');
    expect(menuKey('ArrowLeft', 'button')).toBe('left');
    expect(menuKey('ArrowRight', 'button')).toBe('right');
    for (const code of ['Enter', 'NumpadEnter', 'Space']) expect(menuKey(code, 'button')).toBe('confirm');
    // A / D and gameplay keys are not menu keys; Esc is App's (back / resume).
    for (const code of ['KeyA', 'KeyD', 'KeyQ', 'Escape', 'KeyP']) expect(menuKey(code, 'button')).toBeNull();
  });
  it('with nothing focused any menu key still counts (it focuses the first control)', () => {
    expect(menuKey('KeyS', 'none')).toBe('down');
    expect(menuKey('Enter', 'none')).toBe('confirm');
    expect(menuKey('KeyX', 'none')).toBeNull();
  });
  it('a slider keeps its own left / right; up / down leave it', () => {
    expect(menuKey('ArrowLeft', 'range')).toBeNull();
    expect(menuKey('ArrowRight', 'range')).toBeNull();
    expect(menuKey('ArrowDown', 'range')).toBe('down');
    expect(menuKey('KeyW', 'range')).toBe('up');
    expect(menuKey('Enter', 'range')).toBeNull();
  });
  it('a text field types W, S, Space and submits Enter itself; only up / down arrows leave it', () => {
    for (const code of ['KeyW', 'KeyS', 'Space', 'Enter', 'ArrowLeft', 'ArrowRight']) expect(menuKey(code, 'text')).toBeNull();
    expect(menuKey('ArrowUp', 'text')).toBe('up');
    expect(menuKey('ArrowDown', 'text')).toBe('down');
  });
});
