import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FIGHTERS_MIGHT_IDLE, FIGHTERS_MIGHT_NODES, fightersMightIdleClip, jabAmount } from './fightersMightIdle';
import { equipStaff } from './catalog';

/** The node tree the clip drives, as the procedural staff names it. */
function rig(): { root: THREE.Group; nodes: Record<keyof typeof FIGHTERS_MIGHT_NODES, THREE.Object3D> } {
  const root = new THREE.Group();
  const nodes = {} as Record<keyof typeof FIGHTERS_MIGHT_NODES, THREE.Object3D>;
  for (const [key, name] of Object.entries(FIGHTERS_MIGHT_NODES) as [keyof typeof FIGHTERS_MIGHT_NODES, string][]) {
    const o = new THREE.Object3D();
    o.name = name;
    root.add(o);
    nodes[key] = o;
  }
  return { root, nodes };
}

describe("Fighter's Might idle clip", () => {
  it('is named like every staff idle and loops like the GLB staffs (4 s, 33 keys)', () => {
    const clip = fightersMightIdleClip();
    expect(clip.name).toBe(equipStaff('duel_staff_fighters_might', false).clip);
    expect(clip.duration).toBe(4);
    for (const track of clip.tracks) expect(track.times.length).toBe(33);
    expect(clip.validate()).toBe(true);
  });

  it('only targets nodes the procedural staff has', () => {
    const names = new Set(Object.values(FIGHTERS_MIGHT_NODES));
    for (const track of fightersMightIdleClip().tracks) expect(names.has(track.name.split('.')[0] as never)).toBe(true);
  });

  it('starts and ends on the same pose, so the loop has no pop', () => {
    for (const track of fightersMightIdleClip().tracks) {
      const size = track.getValueSize();
      const first = Array.from(track.values.slice(0, size));
      const last = Array.from(track.values.slice(-size));
      // A quaternion and its negation are the same rotation.
      const sameSign = first.every((v, i) => Math.abs(v - last[i]) < 1e-5);
      const flipped = first.every((v, i) => Math.abs(v + last[i]) < 1e-5);
      expect(sameSign || (track instanceof THREE.QuaternionKeyframeTrack && flipped)).toBe(true);
    }
  });

  it('moves the head when played: the ring spins, the shards orbit, the gauntlet bobs and jabs', () => {
    const { root, nodes } = rig();
    const mixer = new THREE.AnimationMixer(root);
    mixer.clipAction(fightersMightIdleClip()).play();
    mixer.update(0);
    const ring0 = nodes.ring.quaternion.clone();
    const shards0 = nodes.shards.quaternion.clone();
    mixer.update(0.5);
    expect(nodes.ring.quaternion.angleTo(ring0)).toBeGreaterThan(1);
    expect(nodes.shards.quaternion.angleTo(shards0)).toBeGreaterThan(0.3);
    expect(Math.abs(nodes.gauntlet.position.y - FIGHTERS_MIGHT_IDLE.gauntletY)).toBeLessThanOrEqual(FIGHTERS_MIGHT_IDLE.bob + 1e-6);
    // Peak of the jab: the gauntlet is well above its bob range and the clamps open.
    const peak = (FIGHTERS_MIGHT_IDLE.jabAt + FIGHTERS_MIGHT_IDLE.jabFor * 0.3) * FIGHTERS_MIGHT_IDLE.duration;
    mixer.setTime(peak);
    expect(nodes.gauntlet.position.y).toBeGreaterThan(FIGHTERS_MIGHT_IDLE.gauntletY + FIGHTERS_MIGHT_IDLE.bob + 0.03);
    expect(nodes.clampR.position.x).toBeGreaterThan(FIGHTERS_MIGHT_IDLE.clampX + 0.01);
    expect(nodes.clampL.position.x).toBeLessThan(-(FIGHTERS_MIGHT_IDLE.clampX + 0.01));
  });

  it('jabs once per loop and rests otherwise', () => {
    expect(jabAmount(0)).toBe(0);
    expect(jabAmount(0.5)).toBe(0);
    expect(jabAmount(FIGHTERS_MIGHT_IDLE.jabAt + FIGHTERS_MIGHT_IDLE.jabFor * 0.3)).toBeCloseTo(1);
    expect(jabAmount(FIGHTERS_MIGHT_IDLE.jabAt + FIGHTERS_MIGHT_IDLE.jabFor)).toBe(0);
  });
});
