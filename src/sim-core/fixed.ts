/**
 * Deterministic fixed-point math for the duel sim.
 *
 * Every simulated quantity is an integer held in a JS number, kept well inside +-2^53 so every
 * add, subtract and multiply is exact. Division and square root go through `Math.floor` of an
 * IEEE-754 double result, which every conforming engine (V8, SpiderMonkey, JSC, goja) computes
 * identically. No Math.sin/cos/atan2/exp/pow/hypot/random: their last bits differ between
 * engines. Trigonometry uses the integer tables in tables.ts.
 *
 * Units:
 * - distance, speed, health, mana, ult charge, multipliers: Q16 (ONE = 65536 = 1.0)
 * - time: TU = 1/6000 s, so one 60 Hz tick is exactly DT = 100 TU
 * - angles: 1/65536 of a full turn (u16, wraps), yaw 0 faces +z, a quarter turn faces +x
 *
 * Code here must stay ES5 once lowered (no Map/Set iteration, no ES2015 built-ins), because the
 * server bundle runs on goja (see docs/SERVER-SIM.md).
 */
import { ATAN_T, CORDIC_K, SIN_Q } from './tables';

export const ONE = 65536;
export const HALF = 32768;
/** Time units per second. */
export const TU = 6000;
/** Fixed tick rate (Hz) and its step in TU. */
export const TICK_HZ = 60;
export const DT = 100;
/** A full turn in angle units. */
export const TURN = 65536;
export const QUARTER = 16384;

/** Real number to Q16 (config numbers; deterministic: one IEEE multiply, then round). */
export function fx(x: number): number {
  return Math.round(x * ONE);
}

/** Seconds to TU. */
export function sec(x: number): number {
  return Math.round(x * TU);
}

/** Radians to angle units. */
export function rad(x: number): number {
  return Math.round((x / (2 * Math.PI)) * TURN);
}

/** Degrees to angle units. */
export function deg(x: number): number {
  return Math.round((x / 360) * TURN);
}

/** Q16 product, floored. |a*b| must stay below 2^53. */
export function mul(a: number, b: number): number {
  return Math.floor((a * b) / ONE);
}

/** Q16 quotient, floored. b must be non-zero. */
export function div(a: number, b: number): number {
  return Math.floor((a * ONE) / b);
}

/** floor(a * b / c) for integers. */
export function muldiv(a: number, b: number, c: number): number {
  return Math.floor((a * b) / c);
}

/** Integer quotient, floored. */
export function idiv(a: number, b: number): number {
  return Math.floor(a / b);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function abs(v: number): number {
  return v < 0 ? -v : v;
}

export function min(a: number, b: number): number {
  return a < b ? a : b;
}

export function max(a: number, b: number): number {
  return a > b ? a : b;
}

/** floor(sqrt(n)) for an integer 0 <= n < 2^53, exact on every engine. */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r--;
  while ((r + 1) * (r + 1) <= n) r++;
  return r;
}

/** Length of a Q16 2D vector, Q16. */
export function len2(x: number, z: number): number {
  return isqrt(x * x + z * z);
}

/** Length of a Q16 3D vector, Q16. */
export function len3(x: number, y: number, z: number): number {
  return isqrt(x * x + y * y + z * z);
}

/** Speed (Q16 per second) times time (TU), Q16 distance. */
export function vt(v: number, t: number): number {
  return Math.floor((v * t) / TU);
}

/** Linear blend a + (b - a) * t, t in Q16. */
export function lerp(a: number, b: number, t: number): number {
  return a + mul(b - a, t);
}

// ------------------------------------------------------------------ angles

/** Wrap an angle into [-TURN/2, TURN/2). */
export function wrapAngle(a: number): number {
  let x = a % TURN;
  if (x < -HALF) x += TURN;
  else if (x >= HALF) x -= TURN;
  return x;
}

/** The quarter wave, sampled every 16 angle units and linearly interpolated (u in 0..QUARTER). */
function quarterSin(u: number): number {
  const i = Math.floor(u / 16);
  const f = u - i * 16;
  if (i >= 1024) return SIN_Q[1024];
  return SIN_Q[i] + Math.floor(((SIN_Q[i + 1] - SIN_Q[i]) * f) / 16);
}

/** sin of an angle, Q16. */
export function sin(a: number): number {
  let x = a % TURN;
  if (x < 0) x += TURN;
  const q = Math.floor(x / QUARTER);
  const r = x - q * QUARTER;
  if (q === 0) return quarterSin(r);
  if (q === 1) return quarterSin(QUARTER - r);
  if (q === 2) return -quarterSin(r);
  return -quarterSin(QUARTER - r);
}

export function cos(a: number): number {
  return sin(a + QUARTER);
}

const POW2: number[] = [];
for (let i = 0, p = 1; i < 32; i++, p *= 2) POW2.push(p);

/** Yaw (angle units, 0..TURN) of the direction (x, z): forward is +z, a quarter turn is +x. */
export function atan2(x: number, z: number): number {
  if (x === 0 && z === 0) return 0;
  // CORDIC vectoring on (z, x): rotate onto the +z axis, summing the rotations.
  let a = z, b = x, acc = 0;
  if (a < 0) {
    // Rotate by half a turn first so the CORDIC range (+-99 degrees) covers it.
    a = -a;
    b = -b;
    acc = HALF * 256;
  }
  // Scale up small vectors for precision; inputs are Q16 and below ~2^31.
  while (abs(a) < 0x40000000 && abs(b) < 0x40000000) {
    a *= 2;
    b *= 2;
  }
  for (let i = 0; i < ATAN_T.length; i++) {
    const p = POW2[i];
    const na = b > 0 ? a + Math.floor(b / p) : a - Math.floor(b / p);
    const nb = b > 0 ? b - Math.floor(a / p) : b + Math.floor(a / p);
    acc += b > 0 ? ATAN_T[i] : -ATAN_T[i];
    a = na;
    b = nb;
  }
  let out = Math.floor(acc / 256 + 0.5) % TURN;
  if (out < 0) out += TURN;
  return out;
}

/** CORDIC gain, exported for tests. */
export const CORDIC_GAIN = CORDIC_K;

/** Angle units to radians (presentation only, never inside the sim). */
export function toRadians(a: number): number {
  return (a / TURN) * Math.PI * 2;
}

// ------------------------------------------------------------------ vectors

/** A mutable Q16 vector. */
export interface V3 {
  x: number;
  y: number;
  z: number;
}

export function v3(x = 0, y = 0, z = 0): V3 {
  return { x, y, z };
}

export function set3(o: V3, x: number, y: number, z: number): V3 {
  o.x = x;
  o.y = y;
  o.z = z;
  return o;
}

export function copy3(o: V3, a: V3): V3 {
  o.x = a.x;
  o.y = a.y;
  o.z = a.z;
  return o;
}

/**
 * Scale (x, z) to length `len` (Q16). Returns false and leaves `o` alone when (x, z) is too short
 * to have a direction.
 */
export function setLength2(o: V3, x: number, z: number, len: number): boolean {
  const l = len2(x, z);
  if (l < 4) return false;
  o.x = muldiv(x, len, l);
  o.z = muldiv(z, len, l);
  return true;
}

/** Scale (x, y, z) to length `len`. False when it has no direction. */
export function setLength3(o: V3, x: number, y: number, z: number, len: number): boolean {
  const l = len3(x, y, z);
  if (l < 4) return false;
  o.x = muldiv(x, len, l);
  o.y = muldiv(y, len, l);
  o.z = muldiv(z, len, l);
  return true;
}

// ------------------------------------------------------------------ 32-bit helpers

/** Math.imul without ES2015 (goja-safe). */
export function imul(a: number, b: number): number {
  const ah = (a >>> 16) & 0xffff, al = a & 0xffff;
  const bh = (b >>> 16) & 0xffff, bl = b & 0xffff;
  return (al * bl + ((((ah * bl + al * bh) << 16) >>> 0) | 0)) | 0;
}
