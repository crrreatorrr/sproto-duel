import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FIST_LOOK, OBJECT_SKINS, SKIN_LOOKS } from './skinLooks';

describe("Fighter's Might fist bolt look", () => {
  it('is a registered object skin', () => {
    expect(OBJECT_SKINS).toContain('fist');
    expect(SKIN_LOOKS.fist).toBe(FIST_LOOK);
  });

  it('is a cheap low-poly mesh facing +z, knuckles first', () => {
    const geo = FIST_LOOK.solid(FIST_LOOK.atlas);
    const tris = (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
    expect(tris).toBeLessThan(400);
    geo.computeBoundingBox();
    const box = geo.boundingBox!;
    const size = box.getSize(new THREE.Vector3());
    // Chunky but bolt-sized (the hitbox stays the bolt radius, 0.16 m).
    expect(size.x).toBeGreaterThan(0.2);
    expect(size.x).toBeLessThan(0.4);
    // Knuckles lead (+z), the cuff trails.
    expect(box.max.z).toBeGreaterThan(0.1);
    expect(box.min.z).toBeLessThan(-0.15);
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
      expect(uv.getX(i)).toBeLessThanOrEqual(1);
    }
    geo.dispose();
  });

  it('has a short additive streak behind it', () => {
    const aura = FIST_LOOK.aura!.geometry();
    aura.computeBoundingBox();
    expect(aura.boundingBox!.max.z).toBeLessThanOrEqual(0);
    expect(aura.boundingBox!.min.z).toBeGreaterThan(-1);
    aura.dispose();
  });
});
