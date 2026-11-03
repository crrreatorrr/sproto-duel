import * as THREE from 'three';
import { CONFIG } from '../config';
import { FIST_COLORS, FIST_LOOK } from '../spells/skinLooks';
import { FIGHTERS_MIGHT_IDLE, FIGHTERS_MIGHT_NODES as NODE, fightersMightIdleClip } from './fightersMightIdle';

/**
 * Procedural stand-in for the Fighter's Might staff while its GLB
 * (`models/staffs/staff_fighters_might-lod1.glb`) is not on disk. It follows the approved concept:
 * a royal-blue shaft with glossy red armour segments and yellow LED bands, a red-and-yellow taped
 * grip, and at the head a floating hard-light yellow gauntlet with red edges, held by two blue
 * magnetic clamps above a spinning red/yellow holographic championship-belt ring.
 *
 * Same frame as every staff prop: +Y up the shaft, grip at the origin, about 1.894 m long (-1.093
 * to the gauntlet's knuckles a little above 0.801). Geometry and materials are built once and shared; the gauntlet's material carries the
 * staff pulse name (CONFIG.staffs.fighters_might.pulse.material) so it glows like a GLB's would.
 * The head parts carry the node names of `fightersMightIdle.ts`, and the group's
 * `userData.animations` holds its idle clip, which WizardVisual plays like a GLB staff's clip. The
 * gauntlet's `userData.castPush` (m) punches it up the shaft on each cast.
 */
let idleClip: THREE.AnimationClip | null = null;

const PULSE_MATERIAL = CONFIG.staffs.fighters_might.pulse.material;
const BOTTOM = -1.093;
const TOP = 0.801;
/** The shaft stops under the ring; the gauntlet floats above it, to about the usual staff top. */
const SHAFT_TOP = 0.58;

interface Kit {
  shaft: THREE.CylinderGeometry;
  armor: THREE.CylinderGeometry;
  band: THREE.CylinderGeometry;
  tape: THREE.CylinderGeometry;
  cap: THREE.ConeGeometry;
  ring: THREE.TorusGeometry;
  ringInner: THREE.TorusGeometry;
  clamp: THREE.BoxGeometry;
  shard: THREE.OctahedronGeometry;
  fist: THREE.BufferGeometry;
  blue: THREE.MeshStandardMaterial;
  red: THREE.MeshStandardMaterial;
  yellow: THREE.MeshStandardMaterial;
  holoYellow: THREE.MeshBasicMaterial;
  holoRed: THREE.MeshBasicMaterial;
  gauntlet: THREE.MeshStandardMaterial;
}

let kit: Kit | null = null;

function paintedTexture(paint: (g: CanvasRenderingContext2D) => void, n: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d')!;
  paint(g);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildKit(): Kit {
  const n = FIST_LOOK.atlas;
  const pal = CONFIG.teams[0];
  const map = paintedTexture((g) => FIST_LOOK.paint(g, n, pal), n);
  const emissiveMap = paintedTexture((g) => {
    g.fillStyle = '#000';
    g.fillRect(0, 0, n, n);
    FIST_LOOK.glow?.(g, n, pal);
  }, n);
  const gauntlet = new THREE.MeshStandardMaterial({
    name: PULSE_MATERIAL,
    map,
    emissiveMap,
    emissive: 0xffffff,
    emissiveIntensity: 1.6,
    roughness: 0.35,
    metalness: 0,
  });
  return {
    shaft: new THREE.CylinderGeometry(0.032, 0.036, SHAFT_TOP - BOTTOM, 10),
    armor: new THREE.CylinderGeometry(0.05, 0.05, 0.13, 10),
    band: new THREE.CylinderGeometry(0.053, 0.053, 0.016, 10),
    tape: new THREE.CylinderGeometry(0.041, 0.041, 0.034, 10),
    cap: new THREE.ConeGeometry(0.045, 0.09, 10),
    ring: new THREE.TorusGeometry(0.15, 0.014, 6, 28),
    ringInner: new THREE.TorusGeometry(0.125, 0.007, 4, 28),
    clamp: new THREE.BoxGeometry(0.035, 0.11, 0.05),
    shard: new THREE.OctahedronGeometry(0.022, 0),
    fist: FIST_LOOK.solid(n),
    blue: new THREE.MeshStandardMaterial({ color: FIST_COLORS.blue, roughness: 0.4, metalness: 0.45 }),
    red: new THREE.MeshStandardMaterial({ color: FIST_COLORS.red, roughness: 0.18, metalness: 0.25 }),
    yellow: new THREE.MeshStandardMaterial({ color: FIST_COLORS.yellow, emissive: FIST_COLORS.yellow, emissiveIntensity: 1.4, roughness: 0.4 }),
    holoYellow: new THREE.MeshBasicMaterial({ color: new THREE.Color(FIST_COLORS.yellow).multiplyScalar(1.8), transparent: true, opacity: 0.85, toneMapped: false, depthWrite: false }),
    holoRed: new THREE.MeshBasicMaterial({ color: new THREE.Color(FIST_COLORS.red).multiplyScalar(1.6), transparent: true, opacity: 0.8, toneMapped: false, depthWrite: false }),
    gauntlet,
  };
}

function part(geo: THREE.BufferGeometry, mat: THREE.Material, y: number, shadow = true): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.y = y;
  m.castShadow = shadow;
  return m;
}

/** A new Fighter's Might staff group (shared geometry and materials). */
export function buildFightersMightStaff(): THREE.Group {
  kit ??= buildKit();
  const k = kit;
  const g = new THREE.Group();
  g.name = 'staff_fighters_might_fallback';

  g.add(part(k.shaft, k.blue, (BOTTOM + SHAFT_TOP) / 2));
  g.add(part(k.cap, k.red, BOTTOM + 0.02).rotateX(Math.PI));
  // Armour segments, each edged with LED bands.
  for (const y of [-0.82, -0.42, 0.28, 0.5]) {
    g.add(part(k.armor, k.red, y));
    g.add(part(k.band, k.yellow, y - 0.073, false), part(k.band, k.yellow, y + 0.073, false));
  }
  // Red-and-yellow taped grip around the hand.
  for (let i = 0; i < 8; i++) g.add(part(k.tape, i % 2 ? k.yellow : k.red, -0.14 + i * 0.036, false));

  // Head: the spinning holographic belt ring, flat round the shaft top.
  // Outer and inner rings are separate nodes so they spin against each other.
  const ring = new THREE.Group();
  ring.name = NODE.ring;
  ring.position.y = 0.6;
  const outer = new THREE.Mesh(k.ring, k.holoYellow);
  outer.rotation.x = Math.PI / 2;
  ring.add(outer);
  const innerRing = new THREE.Group();
  innerRing.name = NODE.ringInner;
  innerRing.position.y = 0.6;
  const inner = new THREE.Mesh(k.ringInner, k.holoRed);
  inner.rotation.x = Math.PI / 2;
  innerRing.add(inner);
  g.add(ring, innerRing);

  // Three hard-light shards orbiting the gauntlet (yellow, red, blue).
  const shards = new THREE.Group();
  shards.name = NODE.shards;
  shards.position.y = FIGHTERS_MIGHT_IDLE.gauntletY;
  [k.holoYellow, k.holoRed, k.blue].forEach((mat, i) => {
    const a = (i / 3) * Math.PI * 2;
    const shard = new THREE.Mesh(k.shard, mat);
    shard.position.set(Math.cos(a) * 0.15, (i - 1) * 0.03, Math.sin(a) * 0.15);
    shard.rotation.set(a, a * 0.5, 0);
    shards.add(shard);
  });
  g.add(shards);

  // Two blue magnetic clamps reaching up either side of the gauntlet.
  for (const side of [-1, 1]) {
    const c = part(k.clamp, k.blue, 0.74);
    c.name = side < 0 ? NODE.clampL : NODE.clampR;
    c.position.x = side * FIGHTERS_MIGHT_IDLE.clampX;
    c.rotation.z = side * 0.25;
    g.add(c);
  }

  // The floating gauntlet: the bolt's fist, knuckles up between the clamps. The idle clip bobs,
  // sways and jabs it; each cast punches it further up the shaft.
  const fist = new THREE.Mesh(k.fist, k.gauntlet);
  fist.name = NODE.gauntlet;
  fist.rotation.x = -Math.PI / 2;
  fist.scale.setScalar(0.85);
  fist.position.y = TOP - 0.02;
  fist.userData.castPush = FIGHTERS_MIGHT_IDLE.castPush;
  fist.castShadow = true;
  g.add(fist);

  idleClip ??= fightersMightIdleClip();
  g.userData.animations = [idleClip];
  return g;
}
