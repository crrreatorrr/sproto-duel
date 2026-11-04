/**
 * Serializable intent frames: one fixed tick of what a player asked their wizard to do, quantized
 * for the wire. Pure (no DOM, no three.js at runtime): the host turns a guest's frames back into a
 * WizardIntent with `applyIntentFrame`, the guest samples its own with `encodeIntent`.
 */
import type { ActionKey } from '../wizard/Wizard';

/** Bit order of `IntentFrame.press`. Must match Wizard.ts ACTION_KEYS (a test checks). Append only. */
export const ACTION_BITS: readonly ActionKey[] = [
  'bolt', 'blast', 'shield', 'stun', 'ultimate', 'dodge', 'jump', 'carpet', 'pump', 'vape', 'lockon', 'breath',
];

export const HELD_BOLT = 1;
export const HELD_SPRINT = 2;
const HELD_MASK = HELD_BOLT | HELD_SPRINT;
const PRESS_MASK = (1 << ACTION_BITS.length) - 1;
/** Aim points are clamped to this box (m): far beyond the arena, inside int range in cm. */
const AIM_LIMIT = 500;
const TAU = Math.PI * 2;

export interface IntentFrame {
  /** Sim tick this frame is for. */
  tick: number;
  /** Move direction, int8 -127..127 per axis (world XZ). */
  mx: number;
  mz: number;
  /** Facing yaw as u16 of a full turn (0..65535). */
  facing: number;
  /** Aim point in integer centimetres. */
  aim: [number, number, number];
  /** Held inputs: bit0 holdBolt, bit1 sprint. */
  held: number;
  /** One bit per ACTION_BITS entry: pressed at least once since the previous frame. */
  press: number;
}

/** The parts of a WizardIntent a frame reads and writes (structural, so tests need no Wizard). */
export interface IntentLike {
  readonly move: { x: number; y: number; z: number; set(x: number, y: number, z: number): unknown };
  sprint: boolean;
  holdBolt: boolean;
  facing: number;
  readonly presses: Record<ActionKey, number>;
  press(action: ActionKey): void;
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
  set(x: number, y: number, z: number): unknown;
}

const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number.isFinite(v) ? v : 0)));

export function quantizeAngle(a: number): number {
  const t = ((a % TAU) + TAU) % TAU;
  return Math.round((t / TAU) * 65536) & 0xffff;
}

export function dequantizeAngle(q: number): number {
  return ((q & 0xffff) / 65536) * TAU;
}

/** Fresh press counters to pass to `encodeIntent` (one per sampled intent). */
export function pressCounters(): Record<ActionKey, number> {
  const r = {} as Record<ActionKey, number>;
  for (const k of ACTION_BITS) r[k] = 0;
  return r;
}

/**
 * Sample `intent` for `tick`. `lastPresses` holds the press counters seen at the previous sample
 * and is updated in place, so every press since then sets its bit exactly once.
 */
export function encodeIntent(intent: IntentLike, aimPoint: { x: number; y: number; z: number }, lastPresses: Record<ActionKey, number>, tick: number): IntentFrame {
  let press = 0;
  for (let i = 0; i < ACTION_BITS.length; i++) {
    const k = ACTION_BITS[i];
    const n = intent.presses[k];
    if (n !== lastPresses[k]) {
      press |= 1 << i;
      lastPresses[k] = n;
    }
  }
  const lim = AIM_LIMIT * 100;
  return {
    tick,
    mx: clampInt(intent.move.x * 127, -127, 127),
    mz: clampInt(intent.move.z * 127, -127, 127),
    facing: quantizeAngle(intent.facing),
    aim: [clampInt(aimPoint.x * 100, -lim, lim), clampInt(aimPoint.y * 100, -lim, lim), clampInt(aimPoint.z * 100, -lim, lim)],
    held: (intent.holdBolt ? HELD_BOLT : 0) | (intent.sprint ? HELD_SPRINT : 0),
    press,
  };
}

/**
 * Drive a wizard's intent from a frame: movement, facing, aim and held buttons are set; each press
 * bit calls `intent.press()` once. Values out of range are clamped and unknown bits ignored.
 */
export function applyIntentFrame(frame: IntentFrame, intent: IntentLike, aimPoint: Vec3Like, presses = true): void {
  let mx = clampInt(frame.mx, -127, 127) / 127;
  let mz = clampInt(frame.mz, -127, 127) / 127;
  const len = Math.hypot(mx, mz);
  if (len > 1) {
    mx /= len;
    mz /= len;
  }
  intent.move.set(mx, 0, mz);
  intent.facing = dequantizeAngle(clampInt(frame.facing, 0, 0xffff));
  const lim = AIM_LIMIT * 100;
  aimPoint.set(clampInt(frame.aim[0], -lim, lim) / 100, clampInt(frame.aim[1], -lim, lim) / 100, clampInt(frame.aim[2], -lim, lim) / 100);
  const held = frame.held & HELD_MASK;
  intent.holdBolt = (held & HELD_BOLT) !== 0;
  intent.sprint = (held & HELD_SPRINT) !== 0;
  if (!presses) return;
  const bits = frame.press & PRESS_MASK;
  for (let i = 0; i < ACTION_BITS.length; i++) if (bits & (1 << i)) intent.press(ACTION_BITS[i]);
}

/** Numbers per frame in a packed array. */
export const FRAME_FIELDS = 8;

/** Flat number array for JSON: [tick, mx, mz, facing, ax, ay, az, held|press<<2] per frame. */
export function packFrames(frames: readonly IntentFrame[]): number[] {
  const out: number[] = [];
  for (const f of frames) out.push(f.tick, f.mx, f.mz, f.facing, f.aim[0], f.aim[1], f.aim[2], (f.held & HELD_MASK) | ((f.press & PRESS_MASK) << 2));
  return out;
}

/** Inverse of packFrames. Malformed input (wrong length, non-numbers) gives the frames that parse. */
export function unpackFrames(data: unknown): IntentFrame[] {
  if (!Array.isArray(data)) return [];
  const out: IntentFrame[] = [];
  for (let i = 0; i + FRAME_FIELDS <= data.length; i += FRAME_FIELDS) {
    const v = data.slice(i, i + FRAME_FIELDS) as unknown[];
    if (!v.every((x) => typeof x === 'number' && Number.isFinite(x))) continue;
    const n = v as number[];
    out.push({
      tick: Math.trunc(n[0]),
      mx: clampInt(n[1], -127, 127),
      mz: clampInt(n[2], -127, 127),
      facing: clampInt(n[3], 0, 0xffff),
      aim: [Math.trunc(n[4]), Math.trunc(n[5]), Math.trunc(n[6])],
      held: n[7] & HELD_MASK,
      press: (n[7] >>> 2) & PRESS_MASK,
    });
  }
  return out;
}
