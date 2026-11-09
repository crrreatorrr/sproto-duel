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
 * - Global `error` / `unhandledrejection` events are counted and logged, but they only extend a
 *   streak that a failing frame started, so with no frames running (async boot, hidden tab)
 *   unrelated page errors never pause the game. Cross-origin errors (extensions, third-party
 *   scripts, a bare "Script error.") and AbortError / NotAllowedError rejections are ignored. A
 *   visibility change resets the streak.
 * - A step may return `false` for "nothing to judge this frame": the streak neither grows nor
 *   resets, so a fixed tick that throws every time it runs still pauses the game even when most
 *   frames run no tick.
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
  /** The page origin; `error` events from scripts on other origins are ignored. */
  origin?: string | null;
}

/** Browser noise that is not a game error (Chrome reports it through window.onerror). */
const BENIGN = /ResizeObserver loop/;
/** Rejections the browser raises for cancelled fetches and refused autoplay or fullscreen. */
const BENIGN_REJECTIONS = new Set(['AbortError', 'NotAllowedError']);

/**
 * True for an `error` event that is not the game's: a muted cross-origin "Script error." with no
 * error object, or one raised by a script on another origin (an extension, an ad blocker).
 */
export function isForeignError(e: Pick<ErrorEvent, 'error' | 'message' | 'filename'>, origin: string | null): boolean {
  if (e.error == null && /^Script error\.?$/i.test(e.message ?? '')) return true;
  if (!e.filename || !origin) return false;
  try {
    return new URL(e.filename, origin).origin !== origin;
  } catch {
    return false;
  }
}

/** True for a rejection that is expected browser behaviour, not a game error. */
export function isBenignRejection(reason: unknown): boolean {
  if (typeof reason !== 'object' || reason === null) return false;
  const name = (reason as { name?: unknown }).name;
  return typeof name === 'string' && BENIGN_REJECTIONS.has(name);
}

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
  /** Failing frames since the last good frame, plus the global errors that came after them. */
  consecutive = 0;
  /** Set once the panel is up: the loop keeps scheduling but runs no more frames. */
  paused = false;
  /** Distinct errors that were not logged because `maxLogs` was reached. */
  suppressed = 0;
  private logged = 0;
  private readonly seen = new Set<string>();
  private readonly log: (...args: unknown[]) => void;
  private readonly surface: ((err: unknown) => void) | null;
  private readonly origin: string | null;
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
    const loc = (globalThis as { location?: { origin?: string } }).location;
    this.origin = opts.origin !== undefined ? opts.origin : (loc?.origin ?? null);
  }

  /** A frame finished without throwing. */
  frameOk(): void {
    this.consecutive = 0;
  }

  /** Forget the current run of failures (the tab was hidden or shown, so frames stopped). */
  resetStreak(): void {
    this.consecutive = 0;
  }

  /** Count an error. Logs it once, tells crash listeners, and pauses after `threshold` in a row. */
  report(err: unknown, source: CrashSource): void {
    const { message, stack } = describeError(err);
    if (source !== 'frame' && source !== 'boot' && BENIGN.test(message)) return;
    this.errors++;
    // A page error only extends a streak that a failing frame started.
    if (source === 'frame' || this.consecutive > 0) this.consecutive++;
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

  /**
   * Feed the page's uncaught errors and rejections into this guard, and reset the streak when
   * `doc` changes visibility. Returns an uninstall function.
   */
  install(
    target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
    doc?: Pick<Document, 'addEventListener' | 'removeEventListener'>,
  ): () => void {
    const onError = (e: ErrorEvent) => {
      if (typeof e.error === 'object' && e.error !== null && this.surfaced.has(e.error)) return;
      if (isForeignError(e, this.origin)) return;
      this.report(e.error ?? e.message, 'error');
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      if (isBenignRejection(e.reason)) return;
      this.report(e.reason, 'unhandledrejection');
    };
    const onVisibility = () => this.resetStreak();
    target.addEventListener('error', onError);
    target.addEventListener('unhandledrejection', onRejection);
    doc?.addEventListener('visibilitychange', onVisibility);
    return () => {
      target.removeEventListener('error', onError);
      target.removeEventListener('unhandledrejection', onRejection);
      doc?.removeEventListener('visibilitychange', onVisibility);
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
 * scheduled in `finally`, and nothing runs while the guard is paused. A step that returns `false`
 * did no work worth judging (no fixed tick was due), so it does not reset the failure streak.
 */
export function createFrameLoop(step: (now: number) => boolean | void, opts: FrameLoopOptions = {}): (now: number) => void {
  const guard = opts.guard ?? crashGuard;
  const raf = opts.raf ?? ((cb: (now: number) => void) => requestAnimationFrame(cb));
  const frame = (now: number) => {
    if (opts.stop?.()) return;
    try {
      if (guard.paused) return;
      if (step(now) !== false) guard.frameOk();
    } catch (err) {
      guard.report(err, 'frame');
    } finally {
      if (!opts.stop?.()) raf(frame);
    }
  };
  return frame;
}
