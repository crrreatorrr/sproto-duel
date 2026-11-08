/**
 * Crash guard for the render loop and the page: one thrown error must never freeze the game,
 * spam the console every frame, or fail silently.
 *
 * - The rAF loop always reschedules (try/finally). A throw ends that frame, so no further fixed
 *   steps run in it.
 * - Every error is counted. Each distinct error is logged once, with its stack, up to `maxLogs`.
 *   A caught frame error is also passed once to `reportError`, so the browser (and QA harnesses
 *   listening for page errors) still see it as uncaught.
 * - After `threshold` failing frames in a row (or a boot failure), the game pauses and the
 *   fatal handlers run (the "Something broke" panel).
 * - Global `error` / `unhandledrejection` events feed the same counter.
 * - `onCrash(fn)` is the hook for the opt-in Diagnostics crash reporter. Nothing is sent anywhere.
 */

export type CrashSource = 'frame' | 'error' | 'unhandledrejection' | 'boot';

/** What a crash listener receives. Plain data: safe to show as text or hand to a reporter. */
export interface CrashReport {
  source: CrashSource;
  message: string;
  stack: string;
  /** Errors counted so far this session, from every source. */
  count: number;
  /** True for the one report that paused the game and opened the panel. */
  fatal: boolean;
}

export interface CrashGuardOptions {
  /** Failing frames in a row before the game pauses. */
  threshold?: number;
  /** Distinct errors written to the console per session. Repeats are only counted. */
  maxLogs?: number;
  log?: (...args: unknown[]) => void;
  /** Hands a caught frame error back to the browser once. Defaults to `globalThis.reportError`. */
  surface?: ((err: unknown) => void) | null;
}

/** Browser noise that is not a game error (Chrome reports it through window.onerror). */
const BENIGN = /ResizeObserver loop/;

export function describeError(err: unknown): { message: string; stack: string } {
  if (err instanceof Error) return { message: err.message || err.name, stack: err.stack ?? '' };
  if (typeof err === 'string') return { message: err, stack: '' };
  try {
    return { message: String(err), stack: '' };
  } catch {
    return { message: 'Unknown error', stack: '' };
  }
}

export class CrashGuard {
  readonly threshold: number;
  readonly maxLogs: number;
  /** Errors counted this session. */
  errors = 0;
  /** Failing frames (or global errors) since the last good frame. */
  consecutive = 0;
  /** Set once the panel is up: the loop keeps scheduling but runs no more frames. */
  paused = false;
  /** Distinct errors that were not logged because `maxLogs` was reached. */
  suppressed = 0;
  private logged = 0;
  private readonly seen = new Set<string>();
  private readonly log: (...args: unknown[]) => void;
  private readonly surface: ((err: unknown) => void) | null;
  /** Errors handed to `surface`: the page listener must not count them a second time. */
  private readonly surfaced = new WeakSet<object>();
  private readonly listeners = new Set<(r: CrashReport) => void>();
  private readonly fatalHandlers = new Set<(r: CrashReport) => void>();

  constructor(opts: CrashGuardOptions = {}) {
    this.threshold = Math.max(1, opts.threshold ?? 3);
    this.maxLogs = Math.max(0, opts.maxLogs ?? 5);
    this.log = opts.log ?? ((...args) => console.error(...args));
    const report = (globalThis as { reportError?: (err: unknown) => void }).reportError;
    this.surface = opts.surface !== undefined ? opts.surface : typeof report === 'function' ? (e) => report(e) : null;
  }

  /** A frame finished without throwing. */
  frameOk(): void {
    this.consecutive = 0;
  }

  /** Count an error. Logs it once, tells crash listeners, and pauses after `threshold` in a row. */
  report(err: unknown, source: CrashSource): void {
    const { message, stack } = describeError(err);
    if (source !== 'frame' && source !== 'boot' && BENIGN.test(message)) return;
    this.errors++;
    this.consecutive++;
    const firstFrame = stack.split('\n').find((l) => /\d:\d/.test(l)) ?? '';
    const sig = `${message}\n${firstFrame}`;
    if (!this.seen.has(sig)) {
      this.seen.add(sig);
      if (this.logged < this.maxLogs) {
        this.logged++;
        this.log(`[crash] ${source}:`, err);
      } else {
        this.suppressed++;
      }
      this.emit(this.listeners, { source, message, stack, count: this.errors, fatal: false });
      if (source === 'frame' && this.surface && typeof err === 'object' && err !== null) {
        this.surfaced.add(err);
        try {
          this.surface(err);
        } catch {
          // Surfacing is best effort.
        }
      }
    }
    if (!this.paused && (source === 'boot' || this.consecutive >= this.threshold)) {
      this.paused = true;
      const report = { source, message, stack, count: this.errors, fatal: true };
      this.emit(this.listeners, report);
      this.emit(this.fatalHandlers, report);
    }
  }

  /** Subscribe to crash reports (for the Diagnostics reporter). Returns an unsubscribe function. */
  onCrash(fn: (r: CrashReport) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Run `fn` once the game pauses (shows the panel). Returns an unsubscribe function. */
  onFatal(fn: (r: CrashReport) => void): () => void {
    this.fatalHandlers.add(fn);
    return () => this.fatalHandlers.delete(fn);
  }

  /** Feed the page's uncaught errors and rejections into this guard. Returns an uninstall function. */
  install(target: Pick<Window, 'addEventListener' | 'removeEventListener'>): () => void {
    const onError = (e: ErrorEvent) => {
      if (typeof e.error === 'object' && e.error !== null && this.surfaced.has(e.error)) return;
      this.report(e.error ?? e.message, 'error');
    };
    const onRejection = (e: PromiseRejectionEvent) => this.report(e.reason, 'unhandledrejection');
    target.addEventListener('error', onError);
    target.addEventListener('unhandledrejection', onRejection);
    return () => {
      target.removeEventListener('error', onError);
      target.removeEventListener('unhandledrejection', onRejection);
    };
  }

  private emit(set: Set<(r: CrashReport) => void>, report: CrashReport): void {
    for (const fn of [...set]) {
      try {
        fn(report);
      } catch {
        // A broken listener must not take the guard down with it.
      }
    }
  }
}

/** The game-wide guard: the loop, the page listeners and the panel all share it. */
export const crashGuard = new CrashGuard();

/** Hook for the opt-in Diagnostics crash reporter. Nothing is sent anywhere yet. */
export function onCrash(fn: (r: CrashReport) => void): () => void {
  return crashGuard.onCrash(fn);
}

export interface FrameLoopOptions {
  guard?: CrashGuard;
  raf?: (cb: (now: number) => void) => unknown;
  /** A deliberate stop (not a crash): when true the loop ends and does not reschedule. */
  stop?: () => boolean;
}

/**
 * A rAF loop that survives exceptions: `step(now)` runs inside try/catch, the next frame is always
 * scheduled in `finally`, and nothing runs while the guard is paused.
 */
export function createFrameLoop(step: (now: number) => void, opts: FrameLoopOptions = {}): (now: number) => void {
  const guard = opts.guard ?? crashGuard;
  const raf = opts.raf ?? ((cb: (now: number) => void) => requestAnimationFrame(cb));
  const frame = (now: number) => {
    if (opts.stop?.()) return;
    try {
      if (guard.paused) return;
      step(now);
      guard.frameOk();
    } catch (err) {
      guard.report(err, 'frame');
    } finally {
      if (!opts.stop?.()) raf(frame);
    }
  };
  return frame;
}
