// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { CrashGuard, createFrameLoop, type CrashReport } from './crash';
import { showCrashPanel } from '../ui/CrashPanel';

/** A manual rAF: frames run only when the test pumps them. */
function fakeRaf() {
  const queue: ((now: number) => void)[] = [];
  let scheduled = 0;
  return {
    raf: (cb: (now: number) => void) => {
      scheduled++;
      queue.push(cb);
    },
    pump(n: number) {
      for (let i = 0; i < n; i++) queue.shift()?.(i * 16);
    },
    get scheduled() {
      return scheduled;
    },
    get pending() {
      return queue.length;
    },
  };
}

/** A frame like Game.advance: fixed steps, each running every system in order. */
function makeWorld(throwAtStep: number | null) {
  const ran: string[] = [];
  let step = 0;
  const systems = {
    spells: () => ran.push(`spells${step}`),
    physics: () => {
      if (step === throwAtStep) throw new Error('physics exploded');
      ran.push(`physics${step}`);
    },
    arena: () => ran.push(`arena${step}`),
  };
  const advance = () => {
    for (let i = 0; i < 3; i++) {
      step++;
      systems.spells();
      systems.physics();
      systems.arena();
    }
  };
  return { ran, advance };
}

describe('createFrameLoop', () => {
  it('keeps scheduling after a system throws, pauses with the panel after 3 failing frames, logs once', () => {
    const log = vi.fn();
    const guard = new CrashGuard({ threshold: 3, log });
    const fatal: CrashReport[] = [];
    guard.onFatal((r) => fatal.push(r));
    const r = fakeRaf();
    const world = makeWorld(null);
    const advance = vi.fn(() => {
      world.advance();
      throw new TypeError("Cannot read properties of undefined (reading 'pos')");
    });
    const frame = createFrameLoop(advance, { guard, raf: r.raf });
    frame(0);
    r.pump(20);

    expect(r.pending).toBe(1); // still scheduled: one throw never stops the loop for good
    expect(r.scheduled).toBe(21);
    expect(advance).toHaveBeenCalledTimes(3); // paused after the third failing frame
    expect(guard.paused).toBe(true);
    expect(guard.errors).toBe(3);
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toMatchObject({ source: 'frame', fatal: true, count: 3 });
    expect(log).toHaveBeenCalledTimes(1); // the same error is not logged every frame
  });

  it('a throw inside a fixed step stops the rest of that frame', () => {
    const guard = new CrashGuard({ log: () => {} });
    const r = fakeRaf();
    const world = makeWorld(2);
    createFrameLoop(world.advance, { guard, raf: r.raf })(0);
    expect(world.ran).toEqual(['spells1', 'physics1', 'arena1', 'spells2']);
    expect(r.pending).toBe(1);
  });

  it('a good frame resets the run of failures', () => {
    const guard = new CrashGuard({ threshold: 3, log: () => {} });
    const r = fakeRaf();
    let n = 0;
    createFrameLoop(() => {
      if (++n % 3 !== 0) throw new Error('flaky');
    }, { guard, raf: r.raf })(0);
    r.pump(30);
    expect(guard.paused).toBe(false);
    expect(guard.errors).toBeGreaterThan(10);
  });

  it('a deliberate stop ends the loop without counting an error', () => {
    const guard = new CrashGuard({ log: () => {} });
    const r = fakeRaf();
    let stopped = false;
    const step = vi.fn(() => {
      stopped = true;
    });
    createFrameLoop(step, { guard, raf: r.raf, stop: () => stopped })(0);
    expect(step).toHaveBeenCalledTimes(1);
    expect(r.pending).toBe(0);
    expect(guard.errors).toBe(0);
  });

  it('hands each distinct frame error to the browser once, and does not count it twice', () => {
    const target = new EventTarget() as unknown as Window;
    const surface = vi.fn((err: unknown) => {
      target.dispatchEvent(Object.assign(new Event('error'), { error: err, message: String(err) }));
    });
    const guard = new CrashGuard({ threshold: 1000, log: () => {}, surface });
    guard.install(target);
    const err = new Error('same');
    for (let i = 0; i < 5; i++) guard.report(err, 'frame');
    expect(surface).toHaveBeenCalledTimes(1);
    expect(guard.errors).toBe(5);
  });

  it('logs at most maxLogs distinct errors', () => {
    const log = vi.fn();
    const guard = new CrashGuard({ threshold: 1000, maxLogs: 2, log });
    for (let i = 0; i < 10; i++) guard.report(new Error(`e${i}`), 'frame');
    expect(log).toHaveBeenCalledTimes(2);
    expect(guard.suppressed).toBe(8);
  });
});

describe('CrashGuard page listeners and onCrash', () => {
  it('feeds window error and unhandledrejection into the same counter and hook', () => {
    const log = vi.fn();
    const guard = new CrashGuard({ threshold: 3, log });
    const seen: CrashReport[] = [];
    guard.onCrash((r) => seen.push(r));
    const target = new EventTarget() as unknown as Window;
    const uninstall = guard.install(target);

    const err = new Error('async boom');
    target.dispatchEvent(Object.assign(new Event('error'), { error: err, message: err.message }));
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'nope' }));
    target.dispatchEvent(Object.assign(new Event('error'), { error: null, message: 'ResizeObserver loop completed' }));
    expect(guard.errors).toBe(2);
    expect(seen.map((r) => r.source)).toEqual(['error', 'unhandledrejection']);
    expect(seen[0].stack).toContain('async boom');
    expect(log).toHaveBeenCalledTimes(2);

    uninstall();
    target.dispatchEvent(Object.assign(new Event('error'), { error: err, message: err.message }));
    expect(guard.errors).toBe(2);
  });

  it('a boot failure opens the panel at once', () => {
    const guard = new CrashGuard({ log: () => {} });
    const fatal = vi.fn();
    guard.onFatal(fatal);
    guard.report(new Error('404 arena.glb'), 'boot');
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(guard.paused).toBe(true);
  });

  it('a throwing listener does not break reporting', () => {
    const guard = new CrashGuard({ threshold: 1, log: () => {} });
    guard.onCrash(() => {
      throw new Error('listener');
    });
    const fatal = vi.fn();
    guard.onFatal(fatal);
    expect(() => guard.report(new Error('x'), 'frame')).not.toThrow();
    expect(fatal).toHaveBeenCalledTimes(1);
  });
});

describe('showCrashPanel', () => {
  it('renders error text as text, with Reload for a runtime crash', () => {
    const reload = vi.fn();
    const report: CrashReport = { source: 'frame', message: '<img src=x onerror=alert(1)>', stack: '', count: 3, fatal: true };
    const panel = showCrashPanel(report, { reload });
    expect(panel.querySelector('img')).toBeNull();
    expect(panel.querySelector('pre')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(panel.querySelector('h2')?.textContent).toBe('Something broke');
    const button = panel.querySelector('button')!;
    expect(button.textContent).toBe('Reload');
    button.click();
    expect(reload).toHaveBeenCalledTimes(1);
    panel.remove();
  });

  it('offers Retry after a boot failure and replaces an older panel', () => {
    showCrashPanel({ source: 'frame', message: 'a', stack: '', count: 1, fatal: true });
    const panel = showCrashPanel({ source: 'boot', message: 'b', stack: 'Error: b\n  at load', count: 1, fatal: true });
    expect(document.querySelectorAll('.crash-panel')).toHaveLength(1);
    expect(panel.querySelector('button')?.textContent).toBe('Retry');
    expect(panel.querySelector('pre')?.textContent).toBe('Error: b\n  at load');
    panel.remove();
  });
});
