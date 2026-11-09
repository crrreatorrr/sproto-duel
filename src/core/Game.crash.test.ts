// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import { CrashGuard, createFrameLoop } from './crash';
import { Game } from './Game';

const FIXED = CONFIG.sim.fixedDt;

/**
 * Just the fields Game.advance reads, with a fixed step that throws once `throwing` is set (after
 * bumping simTime/simTick, as the real tick does before its systems run).
 */
function fakeGame(opts: { throwing?: boolean } = {}) {
  const ends = { input: 0, pads: 0 };
  const g = {
    throwing: opts.throwing ?? false,
    steps: 0,
    simTime: 0,
    simTick: 0,
    accumulator: 0,
    simulating: true,
    fixedTimeScale: true,
    playerControl: false,
    cinematicScale: 1,
    localSeats: [],
    controllers: [],
    input: { consumeMouseDelta() {}, endFrame: () => ends.input++ },
    extraPads: [{ endFrame: () => ends.pads++ }],
    trackPerf() {},
    renderFrame() {},
    advanceFrame: (Game.prototype as unknown as { advanceFrame: unknown }).advanceFrame,
    tick(dt: number) {
      this.simTime += dt;
      this.simTick++;
      if (this.throwing) throw new Error('spell system threw');
      this.steps++;
    },
  };
  const advance = (dt: number) => (Game.prototype.advance as (this: unknown, dt: number) => boolean).call(g, dt);
  return { g, ends, advance };
}

describe('Game.advance under a throwing step', () => {
  it('drops the backlog so the failed step is not rerun on half-applied state', () => {
    const { g, advance } = fakeGame({ throwing: true });
    expect(() => advance(FIXED * 3.5)).toThrow('spell system threw');
    expect(g.simTick).toBe(1);
    expect(g.accumulator).toBe(0);
    // The next short frame has no step due: the failed one is not retried at once.
    g.throwing = false;
    advance(FIXED * 0.5);
    expect(g.simTick).toBe(1);
  });

  it('still ends the input frame, so one-frame presses do not replay (no double cast)', () => {
    const { ends, advance } = fakeGame({ throwing: true });
    expect(() => advance(FIXED)).toThrow();
    expect(ends).toEqual({ input: 1, pads: 1 });
  });

  it('reports a frame with no step due as nothing to judge, and a clean step as good', () => {
    const { g, advance } = fakeGame();
    expect(advance(FIXED / 2.4)).toBe(false); // 144 Hz: no step due yet
    expect(advance(FIXED)).toBe(true);
    g.simulating = false;
    expect(advance(FIXED / 2.4)).toBe(true); // menus: sim time is stopped, the frame is good
  });

  it('a step that always throws trips the panel at 144 Hz', () => {
    const { advance } = fakeGame({ throwing: true });
    const guard = new CrashGuard({ threshold: 3, log: () => {}, surface: null });
    const queue: ((now: number) => void)[] = [];
    createFrameLoop(() => advance(1 / 144), { guard, raf: (cb) => queue.push(cb) })(0);
    for (let i = 0; i < 200 && !guard.paused; i++) queue.shift()?.(i);
    expect(guard.paused).toBe(true);
  });
});
