// @vitest-environment happy-dom
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DamageNumbers } from './DamageNumbers';

describe('popup callouts', () => {
  const make = () => new DamageNumbers(document.createElement('div'), new THREE.PerspectiveCamera());
  const at = new THREE.Vector3(1, 1.2, 3);

  it('stacks a second callout at the same spot above the first instead of on top of it', () => {
    const d = make();
    d.spawn(at, 'PERFECT!', 'perfect');
    d.spawn(at, 'PERFECT!', 'perfect');
    d.spawn(at, 'STUNNED', 'stun');
    const [a, b, c] = d.active;
    expect(a.stackY).toBe(0);
    // A perfect callout is 30 px type at 1.5x: the next one clears it.
    expect(b.stackY).toBeLessThanOrEqual(-45);
    expect(c.stackY).toBeLessThanOrEqual(b.stackY - 45);
  });

  it('leaves callouts elsewhere, and damage numbers, where they are', () => {
    const d = make();
    d.spawn(at, 'PERFECT!', 'perfect');
    d.spawn(new THREE.Vector3(20, 1.2, 3), 'PERFECT!', 'perfect');
    d.spawn(at, '4', 'dmg');
    expect(d.active.map((p) => p.stackY)).toEqual([0, 0, 0]);
  });

  it('starts a fresh stack once the earlier callouts are gone', () => {
    const d = make();
    d.spawn(at, 'PERFECT!', 'perfect');
    d.update(10);
    d.spawn(at, 'PERFECT!', 'perfect');
    expect(d.active.map((p) => p.stackY)).toEqual([0]);
  });
});
