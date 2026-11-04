/**
 * Host side: the guest's intent frames, played back one per host sim tick through a small jitter
 * buffer. Pure.
 *
 * - Frames are keyed by the guest's own tick; duplicates (the guest re-sends recent frames for
 *   redundancy) are ignored.
 * - Playback starts at the first frame once `delay` frames are buffered, and adapts by one tick when
 *   the buffer runs dry (underrun: hold the last movement and held buttons, never repeat a press)
 *   or fills past `delay + slack` (overrun: skip a frame, carrying its presses into the next).
 * - A press is never lost: presses of frames that are skipped, or arrive after their tick was
 *   played, are merged into the next frame played (unless older than `maxLag`).
 */
import type { IntentFrame } from './intent';

export interface RemoteInputOptions {
  /** Target buffer depth (ticks). CONFIG.net.inputDelayTicks. */
  delay: number;
  /** Frames this far behind the playhead are dropped outright. CONFIG.net.maxInputLagTicks. */
  maxLag: number;
  /** Depth above `delay` tolerated before skipping ahead. */
  slack?: number;
}

export class RemoteInputBuffer {
  private readonly frames = new Map<number, IntentFrame>();
  /** Guest tick of the next frame to play; null until the first frame arrives. */
  private playhead: number | null = null;
  private newest = -Infinity;
  private last: IntentFrame | null = null;
  /** Press bits owed to the next played frame (late or skipped frames). */
  private owed = 0;
  private primed = false;
  /** Current target depth (adapts within delay..delay+4). */
  delay: number;
  underruns = 0;
  overruns = 0;
  /** Guest tick of the last frame played (the snapshot `ack`), -1 before any. */
  lastApplied = -1;

  constructor(private readonly opts: RemoteInputOptions) {
    this.delay = opts.delay;
  }

  /** Frames received but not yet played. */
  get depth(): number {
    return this.playhead === null ? 0 : Math.max(0, this.newest - this.playhead + 1);
  }

  push(frames: readonly IntentFrame[]): void {
    for (const f of frames) {
      if (this.playhead !== null && f.tick < this.playhead) {
        // Already played past it: keep its presses (a late tap still happens), unless far too late.
        if (!this.seen.has(f.tick) && this.playhead - f.tick <= this.opts.maxLag) this.owed |= f.press;
        this.seen.add(f.tick);
        continue;
      }
      if (this.frames.has(f.tick) || this.seen.has(f.tick)) continue;
      this.frames.set(f.tick, f);
      this.seen.add(f.tick);
      if (f.tick > this.newest) this.newest = f.tick;
    }
    if (this.playhead === null && this.frames.size) this.playhead = Math.min(...this.frames.keys());
    this.trimSeen();
  }

  /** Ticks whose frame was received (so a re-sent copy, or a late original, counts once). */
  private readonly seen = new Set<number>();

  private trimSeen(): void {
    if (this.playhead === null || this.seen.size < 256) return;
    const floor = this.playhead - this.opts.maxLag * 2;
    for (const t of this.seen) if (t < floor) this.seen.delete(t);
  }

  /**
   * The frame to apply this host tick: the guest's frame for the playhead (presses owed merged
   * in), a hold of the last one (no presses) on underrun, or null before anything arrived.
   */
  next(): IntentFrame | null {
    if (this.playhead === null) return null;
    // Playback starts once `delay` frames are in (the jitter cushion).
    if (!this.primed) {
      if (this.depth < this.delay) return null;
      this.primed = true;
    }
    const slack = this.opts.slack ?? 3;
    // Overrun: too far behind the guest; skip one frame (its presses carry over).
    if (this.depth > this.delay + slack) {
      const skipped = this.frames.get(this.playhead);
      if (skipped) {
        this.owed |= skipped.press;
        this.frames.delete(this.playhead);
      }
      this.playhead++;
      this.overruns++;
    }
    const f = this.frames.get(this.playhead);
    if (!f) {
      // Underrun: hold movement and held buttons, wait a tick (the delay grows by one).
      this.underruns++;
      if (this.delay < this.opts.delay + 4) this.delay++;
      return this.last ? { ...this.last, press: 0 } : null;
    }
    this.frames.delete(this.playhead);
    this.lastApplied = this.playhead;
    this.playhead++;
    const out: IntentFrame = this.owed ? { ...f, press: f.press | this.owed } : f;
    this.owed = 0;
    this.last = f;
    // A comfortably deep buffer eases the target back toward the configured delay.
    if (this.delay > this.opts.delay && this.depth > this.delay) this.delay--;
    return out;
  }

  /** Forget everything (a new round, a reconnect). */
  reset(): void {
    this.frames.clear();
    this.seen.clear();
    this.playhead = null;
    this.newest = -Infinity;
    this.last = null;
    this.owed = 0;
    this.primed = false;
    this.delay = this.opts.delay;
    this.lastApplied = -1;
  }

  /** The peer stopped sending (dropped): hold nothing, so the wizard stops instead of running on. */
  clearHeld(): void {
    if (this.last) this.last = { ...this.last, mx: 0, mz: 0, held: 0, press: 0 };
  }
}
