import { Vector3 } from 'three';

export const clamp = (v: number, min: number, max: number) => (v < min ? min : v > max ? max : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const saturate = (v: number) => clamp(v, 0, 1);
export const rand = (min: number, max: number) => min + Math.random() * (max - min);
export const randInt = (min: number, max: number) => Math.floor(rand(min, max + 1));
export const chance = (p: number) => Math.random() < p;

/** Frame-rate independent exponential smoothing. Higher sharpness = snappier. */
export const damp = (current: number, target: number, sharpness: number, dt: number) =>
  lerp(current, target, 1 - Math.exp(-sharpness * dt));

export function dampVec3(v: Vector3, target: Vector3, sharpness: number, dt: number): Vector3 {
  return v.lerp(target, 1 - Math.exp(-sharpness * dt));
}

export function wrapAngle(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

export function dampAngle(current: number, target: number, sharpness: number, dt: number): number {
  return current + wrapAngle(target - current) * (1 - Math.exp(-sharpness * dt));
}

/** Yaw (radians) of a horizontal direction, matching three.js rotation.y for a +Z-forward object. */
export const yawOf = (x: number, z: number) => Math.atan2(x, z);

/**
 * Segment p0 -> p0+d against a sphere. Returns the segment parameter t in [0,1] of the first hit, or -1.
 * A segment that starts inside the sphere returns 0.
 */
export function segmentSphere(p0: Vector3, d: Vector3, center: Vector3, radius: number): number {
  const mx = p0.x - center.x, my = p0.y - center.y, mz = p0.z - center.z;
  const c = mx * mx + my * my + mz * mz - radius * radius;
  if (c <= 0) return 0;
  const a = d.x * d.x + d.y * d.y + d.z * d.z;
  if (a < 1e-9) return -1;
  const b = mx * d.x + my * d.y + mz * d.z;
  if (b > 0) return -1;
  const disc = b * b - a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / a;
  return t <= 1 ? t : -1;
}

/** Scratch vectors for hot paths. Never hold on to these across calls. */
export const TMP = {
  a: new Vector3(),
  b: new Vector3(),
  c: new Vector3(),
  d: new Vector3(),
};
