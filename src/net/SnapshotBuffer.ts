/**
 * Guest side: the host's snapshots by arrival, sampled for smooth rendering. Pure.
 *
 * Wizards are interpolated `interpDelayMs` behind the host's estimated present (positions and
 * facing, the angle wrapping the short way); projectiles are extrapolated from the newest
 * snapshot along their velocity for at most `extrapolateMaxMs`.
 *
 * Host time comes from the snapshot tick (tick × tickMs). The host-to-local clock offset is the
 * smallest `arrival − hostTime` seen recently (the least-delayed packet), which jitter can only
 * push up, eased upward slowly so a lasting change in latency is followed.
 */
import type { ProjectileState, Snapshot, WizardState } from './state';

export interface SnapshotBufferOptions {
  interpDelayMs: number;
  extrapolateMaxMs: number;
  /** Host sim tick length (ms). */
  tickMs: number;
  /** Snapshots kept. */
  capacity?: number;
}

export interface WizardPose {
  pos: [number, number, number];
  vel: [number, number];
  vy: number;
  facing: number;
  grounded: boolean;
}

const TAU = Math.PI * 2;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}

export class SnapshotBuffer {
  private readonly snaps: { snap: Snapshot; hostMs: number }[] = [];
  private offset: number | null = null;
  private lastArrival = 0;

  constructor(private readonly opts: SnapshotBufferOptions) {}

  get newest(): Snapshot | null {
    return this.snaps.length ? this.snaps[this.snaps.length - 1].snap : null;
  }

  get size(): number {
    return this.snaps.length;
  }

  /** Add a snapshot that arrived at `arrivalMs` (local clock). Older-than-newest ones are ignored. */
  push(snap: Snapshot, arrivalMs: number): boolean {
    const n = this.newest;
    if (n && snap.tick <= n.tick) return false;
    const hostMs = snap.tick * this.opts.tickMs;
    const off = arrivalMs - hostMs;
    if (this.offset === null || off < this.offset) this.offset = off;
    else this.offset += Math.min(off - this.offset, (arrivalMs - this.lastArrival) * 0.002);
    this.lastArrival = arrivalMs;
    this.snaps.push({ snap, hostMs });
    const cap = this.opts.capacity ?? 32;
    if (this.snaps.length > cap) this.snaps.splice(0, this.snaps.length - cap);
    return true;
  }

  /** The host time (ms) shown now: its estimated present minus the interpolation delay. */
  renderHostMs(nowMs: number): number {
    return nowMs - (this.offset ?? nowMs) - this.opts.interpDelayMs;
  }

  /** Interpolated movement of wizard `seat` at `nowMs`. False when there is nothing to show. */
  sampleWizard(seat: number, nowMs: number, out: WizardPose): boolean {
    const list = this.snaps;
    if (!list.length) return false;
    const t = this.renderHostMs(nowMs);
    let a = list[0], b = list[0];
    if (t <= list[0].hostMs) {
      a = b = list[0];
    } else if (t >= list[list.length - 1].hostMs) {
      a = b = list[list.length - 1];
    } else {
      for (let i = 1; i < list.length; i++) {
        if (list[i].hostMs >= t) {
          a = list[i - 1];
          b = list[i];
          break;
        }
      }
    }
    const wa = a.snap.wizards[seat], wb = b.snap.wizards[seat];
    if (!wa || !wb) return false;
    const k = b.hostMs > a.hostMs ? Math.min(1, Math.max(0, (t - a.hostMs) / (b.hostMs - a.hostMs))) : 1;
    writePose(out, wa, wb, k);
    return true;
  }

  /** The newest snapshot's projectiles moved along their velocity to now (clamped). */
  extrapolatedProjectiles(nowMs: number): ProjectileState[] {
    const last = this.snaps[this.snaps.length - 1];
    if (!last) return [];
    const ahead = this.renderHostMs(nowMs) + this.opts.interpDelayMs - last.hostMs;
    const dt = Math.max(0, Math.min(this.opts.extrapolateMaxMs, ahead)) / 1000;
    return last.snap.projectiles.map((p) => ({
      ...p,
      pos: [p.pos[0] + p.vel[0] * dt, p.pos[1] + p.vel[1] * dt, p.pos[2] + p.vel[2] * dt],
    }));
  }

  clear(): void {
    this.snaps.length = 0;
    this.offset = null;
  }
}

function writePose(out: WizardPose, a: WizardState, b: WizardState, k: number): void {
  out.pos[0] = lerp(a.pos[0], b.pos[0], k);
  out.pos[1] = lerp(a.pos[1], b.pos[1], k);
  out.pos[2] = lerp(a.pos[2], b.pos[2], k);
  out.vel[0] = lerp(a.vel[0], b.vel[0], k);
  out.vel[1] = lerp(a.vel[1], b.vel[1], k);
  out.vy = lerp(a.vy, b.vy, k);
  out.facing = ((lerpAngle(a.facing, b.facing, k) % TAU) + TAU) % TAU;
  out.grounded = k < 0.5 ? a.grounded : b.grounded;
}

export function emptyPose(): WizardPose {
  return { pos: [0, 0, 0], vel: [0, 0], vy: 0, facing: 0, grounded: true };
}
