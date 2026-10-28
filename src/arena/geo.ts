import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Small geometry helpers for code-built props and obstacles (merged, vertex-coloured meshes). */

/** Deterministic pseudo-random so placeholder layouts are identical every load. */
export function rng(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

/** Translate (and optionally rotate) a geometry in place. */
export function at(geo: THREE.BufferGeometry, y: number, x = 0, z = 0, rotY = 0): THREE.BufferGeometry {
  if (rotY) geo.rotateY(rotY);
  geo.translate(x, y, z);
  return geo;
}

/** Merge parts into one geometry (one draw call); mixes indexed and non-indexed parts. */
export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const anyFlat = parts.some((g) => !g.index);
  const list = anyFlat ? parts.map((g) => (g.index ? g.toNonIndexed() : g)) : parts;
  const out = mergeGeometries(list, false);
  if (!out) throw new Error('themeKit merge: parts have different attributes');
  for (const g of parts) g.dispose();
  if (anyFlat) for (const g of list) g.dispose();
  return out;
}

/** Bake a flat vertex colour (glow parts share one vertex-coloured material). */
export function tint(geo: THREE.BufferGeometry, hex: number, intensity: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex).multiplyScalar(intensity);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** A box with a flat vertex colour (times `k`), centred at (x, y, z) and turned by `rotY`. */
export function box(w: number, h: number, d: number, x: number, y: number, z: number, hex: number, k = 1, rotY = 0): THREE.BufferGeometry {
  return at(tint(new THREE.BoxGeometry(w, h, d), hex, k), y, x, z, rotY);
}

/** A vertex-coloured cylinder centred at (x, y, z). */
export function cyl(rt: number, rb: number, h: number, seg: number, x: number, y: number, z: number, hex: number, k = 1): THREE.BufferGeometry {
  return at(tint(new THREE.CylinderGeometry(rt, rb, h, seg), hex, k), y, x, z);
}

/** A vertex-coloured box with a jagged broken top (stumps), its base on y = y0. */
export function brokenBox(w: number, h: number, d: number, x: number, y0: number, z: number, hex: number, seed: number, rotY = 0, jagAmount = 0.22): THREE.BufferGeometry {
  const g = jag(new THREE.BoxGeometry(w, h, d, Math.max(1, Math.round(w * 5)), 1, Math.max(1, Math.round(d * 5))), h / 2 - 0.01, jagAmount, seed);
  return at(tint(g, hex, 1), y0 + h / 2, x, z, rotY);
}

/** Map every UV of a geometry to one texel (a solid region of an atlas texture). */
export function flatUV(geo: THREE.BufferGeometry, u: number, v: number): THREE.BufferGeometry {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u, v);
  return geo;
}

/** Position-hashed noise in [-1, 1]: seam duplicates move together, so there are no cracks. */
export function hash3(x: number, y: number, z: number, seed: number): number {
  const s = Math.sin(Math.round(x * 97) * 12.9898 + Math.round(y * 97) * 78.233 + Math.round(z * 97) * 37.719 + seed) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

/** Jagged broken top for stumps. */
export function jag(geo: THREE.BufferGeometry, above: number, amount: number, seed: number): THREE.BufferGeometry {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y > above) pos.setY(i, y + (hash3(pos.getX(i), 0, pos.getZ(i), seed) * 0.5 + 0.35) * amount);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Gnarled, organic profile (grove columns). */
export function gnarl(geo: THREE.BufferGeometry, amount: number): THREE.BufferGeometry {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const a = Math.atan2(z, x);
    const k = 1 + amount * (Math.sin(y * 2.3 + a * 3) * 0.6 + Math.sin(y * 5.1 - a * 5) * 0.4);
    pos.setXYZ(i, x * k, y, z * k);
  }
  geo.computeVertexNormals();
  return geo;
}
