import * as THREE from 'three';

/**
 * Fighter's Might idle animation, built in code because the staff has no GLB yet. It is a normal
 * `THREE.AnimationClip` named like every staff's idle (`staff_<slug>_idle`), 4 s, 33 linear keys
 * per channel, so WizardVisual plays it through the same mixer path as the GLB staffs' clips:
 * - the holographic belt ring spins two turns per loop (Momentum's rings and Sproto's rings do the same);
 * - the inner ring counter-spins one turn on a slight tilt, so the two read as separate layers;
 * - three hard-light shards orbit the gauntlet once per loop (Moonward's comet);
 * - the gauntlet bobs, sways a little and throws a short jab every loop (the "flex");
 * - the two magnetic clamps breathe in and out with the jab, as if holding it in place.
 *
 * Node names are shared with the procedural staff (FightersMightStaff.ts). A delivered GLB that
 * splits its head into nodes with these names can play this clip unchanged.
 */
export const FIGHTERS_MIGHT_NODES = {
  ring: 'staff_fighters_might_ring',
  ringInner: 'staff_fighters_might_ring_inner',
  shards: 'staff_fighters_might_shards',
  gauntlet: 'staff_fighters_might_gauntlet',
  clampL: 'staff_fighters_might_clamp_l',
  clampR: 'staff_fighters_might_clamp_r',
} as const;

export const FIGHTERS_MIGHT_IDLE = {
  clip: 'staff_fighters_might_idle',
  duration: 4,
  keys: 33,
  /** Gauntlet rest height (m, staff frame) and how far it bobs. */
  gauntletY: 0.781,
  bob: 0.018,
  /** Sway about the shaft (rad). */
  sway: 0.22,
  /** The jab: up the shaft by this much (m), starting at `jabAt` of the loop and lasting `jabFor`. */
  jab: 0.07,
  jabAt: 0.7,
  jabFor: 0.12,
  /** Clamp rest x (m) and how far they open during the jab. */
  clampX: 0.1,
  clampOpen: 0.018,
  /** Inner ring tilt (rad). */
  tilt: 0.18,
  /** How far up the shaft the gauntlet punches when a bolt is cast (m, scaled by the cast flash). */
  castPush: 0.09,
} as const;

/** 0..1 jab pulse: a fast punch out and an eased return inside [jabAt, jabAt + jabFor]. */
export function jabAmount(phase: number): number {
  const { jabAt, jabFor } = FIGHTERS_MIGHT_IDLE;
  const t = (phase - jabAt) / jabFor;
  if (t <= 0 || t >= 1) return 0;
  return t < 0.3 ? t / 0.3 : 1 - (t - 0.3) / 0.7;
}

function yaw(angle: number, tilt = 0): number[] {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, angle, 0, 'YXZ'));
  return [q.x, q.y, q.z, q.w];
}

/** The idle clip. Pure Three.js (no DOM), so it is unit-tested directly. */
export function fightersMightIdleClip(): THREE.AnimationClip {
  const I = FIGHTERS_MIGHT_IDLE;
  const N = FIGHTERS_MIGHT_NODES;
  const times: number[] = [];
  const ring: number[] = [];
  const inner: number[] = [];
  const shards: number[] = [];
  const gauntletPos: number[] = [];
  const gauntletRot: number[] = [];
  const clampL: number[] = [];
  const clampR: number[] = [];
  for (let k = 0; k < I.keys; k++) {
    const phase = k / (I.keys - 1);
    const turn = Math.PI * 2 * phase;
    times.push(phase * I.duration);
    ring.push(...yaw(turn * 2));
    inner.push(...yaw(-turn, I.tilt));
    shards.push(...yaw(-turn));
    const jab = jabAmount(phase);
    gauntletPos.push(0, I.gauntletY + Math.sin(turn * 2) * I.bob + jab * I.jab, 0);
    // Knuckles up (-90° about X), swaying about the shaft.
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, Math.sin(turn) * I.sway, 'YXZ'));
    gauntletRot.push(q.x, q.y, q.z, q.w);
    const open = jab * I.clampOpen;
    clampL.push(-(I.clampX + open), 0.74, 0);
    clampR.push(I.clampX + open, 0.74, 0);
  }
  return new THREE.AnimationClip(I.clip, I.duration, [
    new THREE.QuaternionKeyframeTrack(`${N.ring}.quaternion`, times, ring),
    new THREE.QuaternionKeyframeTrack(`${N.ringInner}.quaternion`, times, inner),
    new THREE.QuaternionKeyframeTrack(`${N.shards}.quaternion`, times, shards),
    new THREE.VectorKeyframeTrack(`${N.gauntlet}.position`, times, gauntletPos),
    new THREE.QuaternionKeyframeTrack(`${N.gauntlet}.quaternion`, times, gauntletRot),
    new THREE.VectorKeyframeTrack(`${N.clampL}.position`, times, clampL),
    new THREE.VectorKeyframeTrack(`${N.clampR}.position`, times, clampR),
  ]);
}
