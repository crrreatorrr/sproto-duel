import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import { applyLatch, GamepadInput, latchHeld, PAD_BUTTONS, padsHolding, shapeStick, type PadButton } from './Gamepad';

const G = CONFIG.gamepad;

/** A fake standard-mapping pad, shaped like the snapshots navigator.getGamepads() returns. */
class FakePad {
  connected = true;
  mapping = 'standard';
  axes = [0, 0, 0, 0];
  buttons = PAD_BUTTONS.map(() => ({ pressed: false, touched: false, value: 0 }));
  constructor(
    public index = 0,
    public id = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
  ) {}
  set(b: PadButton, value: number): void {
    this.buttons[PAD_BUTTONS.indexOf(b)] = { pressed: value > 0.5, touched: value > 0, value };
  }
}

let slots: (FakePad | null)[] = [];
let ownDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  slots = [null, null, null, null];
  ownDescriptor = Object.getOwnPropertyDescriptor(navigator, 'getGamepads');
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, writable: true, value: () => slots });
});

afterEach(() => {
  if (ownDescriptor) Object.defineProperty(navigator, 'getGamepads', ownDescriptor);
  else delete (navigator as unknown as Record<string, unknown>).getGamepads;
});

/** One rendered frame for `gp`: mark stale, poll. */
function rig(gp = new GamepadInput()) {
  let now = 1000;
  return {
    gp,
    frame() {
      now += 16;
      gp.endFrame();
      gp.update(now);
    },
  };
}

describe('shapeStick', () => {
  const out = { x: 0, y: 0 };
  it('uses the shared convention deadzones (0.2 left, 0.15 right)', () => {
    expect(G.deadzone.move).toBe(0.2);
    expect(G.deadzone.look).toBe(0.15);
  });
  it('is radial: drift inside the radius is zero, a diagonal past it is not', () => {
    expect(shapeStick(0.13, -0.13, G.deadzone.move, 1, out)).toBe(0); // 0.184
    expect(out).toEqual({ x: 0, y: 0 });
    expect(shapeStick(0.17, -0.17, G.deadzone.move, 1, out)).toBeGreaterThan(0); // 0.240
  });
  it('rescales from 0 at the deadzone to 1 at the outer edge, keeping direction', () => {
    expect(shapeStick(G.deadzone.move + 1e-4, 0, G.deadzone.move, 1, out)).toBeLessThan(0.001);
    expect(shapeStick(0, -1, G.deadzone.move, 1, out)).toBe(1);
    expect(out.y).toBe(-1);
    const half = (G.deadzone.move + G.outerDeadzone) / 2;
    expect(shapeStick(half, 0, G.deadzone.move, 1, out)).toBeCloseTo(0.5, 5);
    expect(shapeStick(half, 0, G.deadzone.move, 2, out)).toBeCloseTo(0.25, 5);
  });
});

describe('latch helpers', () => {
  it('masks buttons held at connect until each is released once', () => {
    const latched = new Uint8Array(4);
    latchHeld([1, 0, 1, 0], latched);
    const down = Uint8Array.from([1, 1, 1, 0]);
    applyLatch(down, latched);
    expect([...down]).toEqual([0, 1, 0, 0]);
    // Button 0 released, button 2 still held.
    const next = Uint8Array.from([0, 1, 1, 0]);
    applyLatch(next, latched);
    expect([...next]).toEqual([0, 1, 0, 0]);
    expect([...latched]).toEqual([0, 0, 1, 0]);
    const again = Uint8Array.from([1, 1, 1, 0]);
    applyLatch(again, latched);
    expect([...again]).toEqual([1, 1, 0, 0]);
  });
});

describe('GamepadInput', () => {
  it('edge detection: a press counts once, a held button never re-triggers', () => {
    const pad = new FakePad();
    slots[0] = pad;
    const r = rig();
    r.frame();
    pad.set('a', 1);
    r.frame();
    expect(r.gp.wasPressed(['a'])).toBe(true);
    expect(r.gp.isDown(['a'])).toBe(true);
    for (let i = 0; i < 5; i++) {
      r.frame();
      expect(r.gp.wasPressed(['a'])).toBe(false);
      expect(r.gp.isDown(['a'])).toBe(true);
    }
    pad.set('a', 0);
    r.frame();
    expect(r.gp.isDown(['a'])).toBe(false);
  });

  it('polls at most once per frame, so every reader sees the same edge', () => {
    const pad = new FakePad();
    slots[0] = pad;
    const r = rig();
    r.frame();
    pad.set('b', 1);
    r.frame();
    r.gp.update(5000); // a second reader in the same frame
    expect(r.gp.wasPressed(['b'])).toBe(true);
  });

  it('latches buttons held when the pad first appears (the hub A does not leak)', () => {
    const pad = new FakePad();
    const r = rig();
    r.frame();
    expect(r.gp.connected).toBe(false);
    pad.set('a', 1);
    pad.set('rt', 1);
    slots[0] = pad; // the browser exposes the pad on that press
    for (let i = 0; i < 4; i++) {
      r.frame();
      expect(r.gp.connected).toBe(true);
      expect(r.gp.wasPressed(['a'])).toBe(false);
      expect(r.gp.isDown(['a', 'rt'])).toBe(false);
      expect(r.gp.rt).toBe(0);
    }
    // Still counts as the player picking up the pad (prompts switch to pad glyphs).
    expect(r.gp.device).toBe('gamepad');
    pad.set('a', 0);
    r.frame();
    pad.set('a', 1);
    r.frame();
    expect(r.gp.wasPressed(['a'])).toBe(true);
    // RT is still latched until it is let go.
    expect(r.gp.isDown(['rt'])).toBe(false);
    pad.set('rt', 0);
    r.frame();
    pad.set('rt', 1);
    r.frame();
    expect(r.gp.wasPressed(['rt'])).toBe(true);
    expect(r.gp.rt).toBe(1);
  });

  it('latches again on reconnect (hot-plug) and after reset()', () => {
    const pad = new FakePad();
    slots[0] = pad;
    const r = rig();
    r.frame();
    slots[0] = null;
    r.frame();
    expect(r.gp.connected).toBe(false);
    pad.set('x', 1);
    slots[0] = pad;
    r.frame();
    expect(r.gp.connected).toBe(true);
    expect(r.gp.wasPressed(['x'])).toBe(false);
    pad.set('x', 0);
    r.frame();
    pad.set('y', 1);
    r.gp.reset();
    r.frame();
    expect(r.gp.wasPressed(['y'])).toBe(false);
  });

  it('does not latch a press on a pad that was already connected', () => {
    const a = new FakePad(0);
    const b = new FakePad(1, 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)');
    slots[0] = a;
    slots[1] = b;
    const r = rig();
    r.frame();
    b.set('a', 1); // the second pad takes over the 'any' slot with this press
    r.frame();
    expect(r.gp.wasPressed(['a'])).toBe(true);
    expect(r.gp.style).toBe('playstation');
  });

  it('a fixed slot reads only its own pad', () => {
    const a = new FakePad(0);
    const b = new FakePad(1);
    slots[0] = a;
    slots[1] = b;
    const p1 = rig(Object.assign(new GamepadInput(), { slot: 0 }));
    const p2 = rig(Object.assign(new GamepadInput(), { slot: 1 }));
    p1.frame();
    p2.frame();
    b.set('a', 1);
    p1.frame();
    p2.frame();
    expect(p2.gp.wasPressed(['a'])).toBe(true);
    expect(p1.gp.isDown(['a'])).toBe(false);
  });

  it('ignores non-standard mappings and stick drift for device switching', () => {
    const odd = new FakePad();
    odd.mapping = '';
    slots[0] = odd;
    const r = rig();
    r.frame();
    expect(r.gp.connected).toBe(false);
    const pad = new FakePad();
    pad.axes = [0.1, -0.1, 0.05, 0.05];
    slots[0] = pad;
    r.frame();
    r.frame();
    expect(r.gp.connected).toBe(true);
    expect(r.gp.device).toBe('kbm');
    expect(r.gp.move).toEqual({ x: 0, y: 0 });
    expect(r.gp.look).toEqual({ x: 0, y: 0 });
  });

  it('trigger counts as pressed past its threshold, with hysteresis on release', () => {
    const pad = new FakePad();
    slots[0] = pad;
    const r = rig();
    r.frame();
    pad.set('lt', G.deadzone.trigger * 0.9);
    r.frame();
    expect(r.gp.isDown(['lt'])).toBe(false);
    pad.set('lt', G.deadzone.trigger * 1.2);
    r.frame();
    expect(r.gp.wasPressed(['lt'])).toBe(true);
    pad.set('lt', G.deadzone.trigger * 0.8); // inside the hysteresis band: still held
    r.frame();
    expect(r.gp.isDown(['lt'])).toBe(true);
    pad.set('lt', 0);
    r.frame();
    expect(r.gp.isDown(['lt'])).toBe(false);
  });

  it('padsHolding lists every standard pad holding a button', () => {
    const a = new FakePad(0);
    const b = new FakePad(2);
    slots[0] = a;
    slots[2] = b;
    a.set('b', 1);
    b.set('b', 1);
    b.set('a', 1);
    expect(padsHolding('b')).toEqual([0, 2]);
    expect(padsHolding('a')).toEqual([2]);
  });
});

describe('default bindings (Sproto controller convention)', () => {
  const b = G.bindings;
  it('never binds Home or View, pauses on Menu / Start', () => {
    const all = Object.values(b).flat();
    expect(all).not.toContain('home');
    expect(all).not.toContain('back');
    expect(b.pause).toEqual(['start']);
  });
  it('binds every button at most once', () => {
    const all = Object.values(b).flat();
    expect(new Set(all).size).toBe(all.length);
  });
  it('menu auto-repeat is about 350 ms then 120 ms, stick threshold 0.5', () => {
    expect(G.menu.repeatDelay).toBeCloseTo(0.35, 2);
    expect(G.menu.repeatInterval).toBeCloseTo(0.12, 2);
    expect(G.menu.stickThreshold).toBe(0.5);
  });
});
