/**
 * Turn what a local player (or a remote guest's intent frame) asks for into the quantized SimInput
 * the deterministic sim consumes and the input log stores. Float math is fine here: only the
 * resulting integers enter the sim, and they are logged exactly.
 */
import { AIM_DIST, ONE, type SimInput, type SimWizard } from '../sim-core';
import { ACTION_BITS } from '../net/intent';

const TAU = Math.PI * 2;

/** What a sampler reads: a WizardIntent's shape (structural, so tests need no Wizard). */
export interface IntentSample {
  readonly move: { x: number; z: number };
  sprint: boolean;
  holdBolt: boolean;
  facing: number;
  readonly presses: Record<string, number>;
}

/** Fresh press counters for one sampled seat. */
export function simPressCounters(): Record<string, number> {
  const r: Record<string, number> = {};
  for (const k of ACTION_BITS) r[k] = 0;
  return r;
}

/** Move vector (world XZ, length 0..1) to the sim's move code: 32 directions x 4 speeds. */
export function quantizeMove(x: number, z: number): number {
  const len = Math.hypot(x, z);
  if (!(len >= 0.05)) return 0;
  const dir = Math.round((Math.atan2(x, z) / TAU) * 32) & 31;
  const mag = Math.max(1, Math.min(4, Math.ceil(Math.min(1, len) * 4 - 1e-9)));
  return 1 + ((dir << 2) | (mag - 1));
}

/** Yaw (radians) to 1/1024 turn. */
export function quantizeYaw(a: number): number {
  return Math.round(((((a % TAU) + TAU) % TAU) / TAU) * 1024) & 1023;
}

/** The nearest aim distance bucket (log spaced, AIM_DIST). */
export function quantizeDist(d: number): number {
  const q = d * ONE;
  let best = 0;
  for (let k = 1; k < AIM_DIST.length; k++) if (Math.abs(AIM_DIST[k] - q) < Math.abs(AIM_DIST[best] - q)) best = k;
  return best;
}

/**
 * One tick of `intent` + `aim` (world point, metres) for a seat whose sim wizard is `w` (its
 * position before this tick's step: the sim rebuilds the aim from the same chest point).
 * `last` holds the press counters seen at the previous sample and is updated in place.
 */
export function sampleSimInput(intent: IntentSample, aim: { x: number; y: number; z: number }, last: Record<string, number>, w: SimWizard): SimInput {
  let press = 0;
  for (let i = 0; i < ACTION_BITS.length; i++) {
    const k = ACTION_BITS[i];
    const n = intent.presses[k] ?? 0;
    if (n !== last[k]) {
      press |= 1 << i;
      last[k] = n;
    }
  }
  const cx = w.pos.x / ONE, cy = (w.pos.y + w.chestY) / ONE, cz = w.pos.z / ONE;
  const dx = aim.x - cx, dy = aim.y - cy, dz = aim.z - cz;
  const h = Math.hypot(dx, dz);
  const pitch = Math.round((Math.atan2(dy, h) / TAU) * 1024);
  return {
    move: quantizeMove(intent.move.x, intent.move.z),
    held: (intent.holdBolt ? 1 : 0) | (intent.sprint ? 2 : 0),
    press,
    facing: quantizeYaw(intent.facing),
    aimYaw: quantizeYaw(Math.atan2(dx, dz)),
    aimPitch: Math.max(-256, Math.min(256, pitch)),
    aimDist: quantizeDist(Math.hypot(dx, dy, dz)),
  };
}
