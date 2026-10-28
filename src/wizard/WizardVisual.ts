import * as THREE from 'three';
import { CONFIG, type TeamPalette } from '../config';
import type { ModelInstance } from '../assets/AssetLoader';
import type { ModelAsset } from '../assets/manifest';
import { muzzleSetFor } from '../campaign/muzzleIndex';
import { glowTexture } from '../fx/textures';
import { clamp, damp, lerp, saturate, wrapAngle } from '../core/math';
import { Animator, type AnimInput } from './Animator';
import { PLACEHOLDER_MUZZLES, resolveMuzzles, type CastKind, type MuzzleType, type ResolvedMuzzles } from './muzzles';
import type { Wizard } from './Wizard';

const SHIELD_VERT = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vP;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vP = position;
    vN = normalize(mat3(modelMatrix) * normal);
    vV = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const SHIELD_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uOpacity;
  uniform float uPerfect;
  uniform float uHit;
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vP;
  void main() {
    float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
    float rim = pow(f, 2.2);
    vec3 p = normalize(vP);
    vec2 uv = vec2(atan(p.z, p.x) * 3.0, asin(clamp(p.y, -1.0, 1.0)) * 4.0);
    uv.x += 0.5 * floor(uv.y);
    vec2 g = abs(fract(uv) - 0.5);
    float line = smoothstep(0.4, 0.5, max(g.x, g.y));
    float scan = 0.5 + 0.5 * sin(vP.y * 9.0 - uTime * 9.0);
    float a = (rim * 0.85 + line * 0.3 + scan * 0.05 + uHit * 0.5) * uOpacity;
    vec3 c = uColor * (1.2 + rim * 2.0 + uPerfect * 2.5) + vec3(uPerfect * 0.8);
    gl_FragColor = vec4(c, a);
  }
`;

const J = CONFIG.wizard.jump;
/** Placeholder silhouettes: the default wizard hat, or a campaign boss's headgear. */
export type PlaceholderVariant = 'wizard' | 'obama' | 'midget' | 'tinubu' | 'agent' | 'sahil' | 'broccoli';

/** Placeholders built smaller than a standard wizard (The Midget's 1.25 m hitbox). */
const PLACEHOLDER_SCALE: Partial<Record<PlaceholderVariant, number>> = { midget: 1.25 / CONFIG.wizard.height };

/** Top of the default placeholder's hat, in meters. */
const WIZARD_TOP = 2.33;

/** Adds a placeholder part at (x, y, z) in feet-relative meters. */
type AddMesh = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent?: THREE.Object3D) => THREE.Mesh;

/** Placeholder skin (or, for Broccoli Head, stalk) colour per silhouette. */
const SKIN_TONES: Record<PlaceholderVariant, number> = {
  wizard: 0xe8c4a8,
  sahil: 0xc68d5e,
  obama: 0x7a4e34,
  midget: 0xd9a77e,
  broccoli: 0xa9c97a,
  agent: 0xe2bfa2,
  tinubu: 0x6b4630,
};

/** Placeholder robe hem radius (the widest thing at floor level). */
const SKIRT: Partial<Record<PlaceholderVariant, number>> = { sahil: 0.6, obama: 0.42, agent: 0.42 };

/** Most muzzle points one look has (Tinubu's hand and mouth, a phone in each hand). */
const MAX_MUZZLES = 3;

/**
 * How each muzzle type glows (meters at a 2 m look, times the point's size): tip glow colour
 * (0 = the team's spell colour) and idle level, glow and cast-flash sizes, the flash colour (0 = the
 * glow's), how far the glow is pulled toward the camera so the prop doesn't hide it, flash decay
 * per second, and how bright a muzzle light it asks for when flashing.
 */
const MUZZLE_LOOK: Record<MuzzleType, { color: number; idle: number; glow: number; flash: number; flashColor: number; pull: number; decay: number; light: number }> = {
  staff: { color: 0, idle: 0.55, glow: 0.42, flash: 0.85, flashColor: 0, pull: 0.11, decay: 7, light: 1 },
  phone: { color: 0xcfe8ff, idle: 0.32, glow: 0.24, flash: 0.8, flashColor: 0xf4f9ff, pull: 0.03, decay: 9, light: 0.8 },
  vape: { color: 0, idle: 0.45, glow: 0.1, flash: 0.22, flashColor: 0xe8b8ff, pull: 0.03, decay: 6, light: 0.35 },
  gun: { color: 0xffd27a, idle: 0, glow: 0.18, flash: 0.5, flashColor: 0xfff2c8, pull: 0.05, decay: 24, light: 1.6 },
  hand: { color: 0xff7a1a, idle: 0.4, glow: 0.42, flash: 1.0, flashColor: 0xffb347, pull: 0.06, decay: 6, light: 1.1 },
  mouth: { color: 0xff5a10, idle: 0.18, glow: 0.34, flash: 0.95, flashColor: 0xffa040, pull: 0.09, decay: 6, light: 1.1 },
};

/**
 * One muzzle point of the current look: its anchor in the feet frame (the measured point, or where
 * its bone socket is this frame on a rigged look), tip glow, cast flash and optional prop.
 */
interface MuzzleSlot {
  readonly anchor: THREE.Group;
  /** The measured point (feet frame): the gameplay origin (Wizard.castPoint). */
  readonly home: THREE.Vector3;
  /** Rigged look: an empty riding the socket's bone, which the anchor follows. */
  socket: THREE.Object3D | null;
  readonly glow: THREE.Sprite;
  readonly flash: THREE.Sprite;
  /** A code-built phone for an empty fist (MuzzlePoint.prop). */
  readonly phone: THREE.Group;
  readonly color: THREE.Color;
  readonly flashColor: THREE.Color;
  type: MuzzleType;
  size: number;
  /** 1 on a cast, decays: the flash. */
  flare: number;
  /** Smoothed windup glow, 0..1. */
  charge: number;
}

/**
 * Screen-door fade for a look's materials: below uFade 1 an ordered 4x4 dither discards that share
 * of the pixels (0 discards all), so a boss in front of the camera can be seen through with no
 * transparency sorting. Opaque materials stay opaque and keep writing depth.
 */
function addDitherFade(mat: THREE.Material, uniform: { value: number }): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFade = uniform;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uFade;
        float wizBayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
        float wizBayer4(vec2 a) { return wizBayer2(0.5 * a) * 0.25 + wizBayer2(a); }`,
      )
      .replace('void main() {', 'void main() {\n  if (uFade < 0.999 && uFade <= wizBayer4(gl_FragCoord.xy) + 0.03125) discard;');
  };
  mat.customProgramCacheKey = () => 'wizardFade';
}

/** Shared geometry for the code-built phone prop: a 1 m tall body (scaled per look) and its screen. */
let phoneGeo: { body: THREE.BoxGeometry; screen: THREE.PlaneGeometry } | null = null;

const tmpColor = new THREE.Color();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpAxis = new THREE.Vector3();
const tmpCam = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const tmpV = new THREE.Vector3();
const tmpInv = new THREE.Matrix4();
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const W = CONFIG.wizard;

/**
 * Procedural motion on a rigged look, as a share of a static mesh's (the clips carry most of it):
 * the lean into movement (`move`: none, the run, strafe and jump clips lean on their own), the bank
 * into turns and speed changes (`lean`), footstep bob, idle breathing and sway, the cast lunge, the
 * hit flinch. Jump squash and stretch stays at full strength. The weapon arms are left to the
 * clips (the rigs hold them aimed); the pivot moves the whole body.
 */
const RIG_PROC = { move: 0, lean: 0.4, bob: 0.12, idle: 0.3, lunge: 0.35, flinch: 0.55, menace: 0.6 };
const STATIC_PROC = { move: 1, lean: 1, bob: 1, idle: 1, lunge: 1, flinch: 1, menace: 1 };
/** No procedural motion at all (`proceduralOff`, QA). */
const NO_PROC = { move: 0, lean: 0, bob: 0, idle: 0, lunge: 0, flinch: 0, menace: 0 };

/** Vertex `i` of `mesh` in world space as rendered (a skinned mesh in its current pose). */
function posedVertex(mesh: THREE.Mesh, i: number, out: THREE.Vector3): THREE.Vector3 {
  if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) mesh.getVertexPosition(i, out);
  else out.fromBufferAttribute(mesh.geometry.attributes.position, i);
  return out.applyMatrix4(mesh.matrixWorld);
}

/**
 * Lowest points of a look toward one horizontal direction, as (reach, height) pairs: only those no
 * other point beats on both (further out and lower). A lean toward that side lifts the look by the
 * worst of them (see `leanLift`).
 */
function footFront(points: [number, number][]): Float32Array {
  points.sort((a, b) => b[0] - a[0]);
  const keep: number[] = [];
  let lowest = Infinity;
  for (const [u, h] of points) {
    if (h >= lowest || u <= 0) continue;
    lowest = h;
    keep.push(u, h);
  }
  return new Float32Array(keep);
}

/** Most a lean may tip a look's hem toward the floor (m) before its angle is capped: wide bosses lean less. */
const LEAN_DIP = 0.1;

/** The steepest lean toward a side with these lowest points (see footFront) before it dips LEAN_DIP. */
function leanCap(feet: Float32Array): number {
  for (let a = 0.01; a < 1.2; a += 0.01) if (leanDip(feet, a, 1, 1) > LEAN_DIP) return a - 0.01;
  return 1.2;
}

/**
 * How far a lean of `angle` (radians, about the hip pivot at 0.9 m) would push the lowest points
 * on its side below the floor, given the pivot's thin/squash scale. 0 when nothing dips.
 */
function leanDip(feet: Float32Array, angle: number, thin: number, squash: number): number {
  const s = Math.abs(Math.sin(angle)), c = Math.cos(angle);
  let dip = 0;
  for (let i = 0; i < feet.length; i += 2) dip = Math.max(dip, feet[i] * thin * s - feet[i + 1] * squash * c);
  return Math.max(0, dip - 0.9 * squash * (1 - c));
}

export class WizardVisual {
  /** World transform: interpolated position + facing. */
  readonly root = new THREE.Group();
  /** Procedural animation pivot at hip height (lean, roll, recoil). */
  private readonly pivot = new THREE.Group();
  private readonly armPivot = new THREE.Group();
  /** Holds the swappable look (GLB or placeholder); everything else on the root is shared. */
  private readonly body = new THREE.Group();
  private readonly tintMaterials: THREE.MeshStandardMaterial[] = [];
  /** GPU resources created for the current look, released on the next swap. */
  private readonly owned: { dispose(): void }[] = [];
  private readonly chargeGlow: THREE.Sprite;
  /** Muzzle anchors and their glows, in the look's feet frame (follows the lean, bob and squash). */
  private readonly muzzleRoot = new THREE.Group();
  private readonly slots: MuzzleSlot[] = [];
  /** The current look's muzzles (null: the generic wand offset, Wizard.castPoint). */
  muzzles: ResolvedMuzzles | null = null;
  /** Effect scale of the current look: 1 for a 2 m model, a short boss's placeholder its scale-down. */
  fxScale = 1;
  /** Muzzle light wanted this frame (MuzzleFx lights the brightest): level, colour and world position. */
  lightLevel = 0;
  readonly lightColor = new THREE.Color();
  readonly lightPos = new THREE.Vector3();
  /**
   * Visibility, 1 = solid: below 1 the look is dithered away (Game fades a boss near the camera or in
   * front of the player). Shared by every material of the look.
   */
  private readonly fadeUniform = { value: 1 };
  /** Horizontal radius of the look, meters before the root scale (camera fade bounds). */
  boundsRadius = 0.75;
  /** Lowest points toward +Z, -Z, +X and -X (see footFront), for the lean lift. */
  private feet: Float32Array[] = [];
  /** Steepest lean toward +Z, -Z, +X and -X (leanCap): a wide hem leans less. */
  private leanCaps = [Math.PI / 2, Math.PI / 2, Math.PI / 2, Math.PI / 2];
  /** Lift added under a lean this frame so wide looks don't dip into the floor (QA). */
  leanLift = 0;
  /** Camera position for the frame, set by Game before visuals update (muzzle glows face it). */
  static readonly viewer = new THREE.Vector3(0, 3, 12);
  private readonly shield: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly ice: THREE.Mesh;
  private readonly ring: THREE.Mesh;
  /** Clip state machine of a rigged look (null: a static mesh or placeholder, animated procedurally). */
  animator: Animator | null = null;
  private readonly animInput: AnimInput = { speed: 0, localX: 0, localZ: 0, celebrate: false, iceFormed: false, weight: 0 };
  /** Procedural motion strengths for the current look (RIG_PROC on a rigged one). */
  private proc = STATIC_PROC;
  /** The look's MotionStyle, and the eased values in use (a grown placeholder stage counts as heavier). */
  private styleWeight = 0;
  private styleMenace = 0;
  private weight = 0;
  private menace = 0;
  /** Split wing meshes or wing bones of the look (Tinubu), flapped slowly; empty when the wings are part of the body. */
  private readonly wings: THREE.Object3D[] = [];
  /** Hit flinch spring (lean angles, rad) and cast lunge spring (meters forward). */
  private flinchX = 0;
  private flinchXV = 0;
  private flinchZ = 0;
  private flinchZV = 0;
  private lunge = 0;
  private lungeV = 0;
  /** Smoothed facing turn rate (rad/s) and acceleration in the character's frame (m/s^2). */
  private turnRate = 0;
  private lastFacing = NaN;
  private accX = 0;
  private accZ = 0;
  private lastVX = 0;
  private lastVZ = 0;
  /** Footstep cycle (radians; one step per pi) and how much of the stride bob is in (eases in and out). */
  private stepPhase = 0;
  private stride = 0;
  /** Wing flap phase and how roused the wings are (casting, transforming), 0..1. */
  private wingPhase = 0;
  private wingRouse = 0;
  private lastPulse = 0;
  private lastHitFlash = 0;
  private time = Math.random() * 10;
  private deathT = 0;
  private iceScale = 0;
  private shieldScale = 0;
  private shieldHit = 0;
  private lastShieldAge = 0;
  private leanX = 0;
  private leanZ = 0;
  /** Jump squash/stretch spring: + stretches, - squashes (fraction of height). */
  private stretch = 0;
  private stretchVel = 0;
  /** Last takeoff/touchdown counts seen (-1 = not synced yet, so a fresh visual doesn't replay one). */
  private seenJumps = -1;
  private seenLandings = -1;
  celebrate = false;
  /** True when a GLB is shown, false for the primitive placeholder. */
  usesModel = false;
  /** True when the GLB is a rigged (skinned) variant from models/rigged/. */
  rigged = false;
  /**
   * Switch the procedural motion off (lean, sway, bob, lunge, flinch; jump squash and stretch, the
   * roll flip and the topple stay): QA compares a rigged look's clip pose with and without it, and a
   * cinematic that poses the look itself may want it off.
   */
  proceduralOff = false;
  /** Height of the top of the current look (hat, crown or model), in meters. The HUD tag sits above it. */
  topHeight = WIZARD_TOP;

  constructor(public team: TeamPalette, model: ModelInstance | null, modelSpec: ModelAsset) {
    this.root.add(this.pivot);
    this.pivot.position.y = 0.9;
    this.pivot.add(this.body);
    // The feet frame of the look, like a GLB's root: muzzle anchors sit at their measured points.
    this.muzzleRoot.position.y = -0.9;
    this.pivot.add(this.muzzleRoot);
    for (let i = 0; i < MAX_MUZZLES; i++) this.slots.push(this.makeSlot());

    // Spell charge glow (shown during windups), at the muzzle the spell will leave from.
    this.chargeGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTexture(), color: team.spell, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
    );
    this.chargeGlow.visible = false;
    this.muzzleRoot.add(this.chargeGlow);

    this.build(model, modelSpec, 'wizard');

    // Shield bubble.
    this.shield = new THREE.Mesh(
      new THREE.SphereGeometry(CONFIG.spells.shield.radius, 32, 20),
      new THREE.ShaderMaterial({
        vertexShader: SHIELD_VERT,
        fragmentShader: SHIELD_FRAG,
        uniforms: {
          uColor: { value: new THREE.Color(team.spell) },
          uTime: { value: 0 },
          uOpacity: { value: 1 },
          uPerfect: { value: 0 },
          uHit: { value: 0 },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.shield.position.y = 1.0;
    this.shield.visible = false;
    this.shield.renderOrder = 11;
    this.root.add(this.shield);

    // Ice shell (stunned).
    this.ice = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.75, 1),
      new THREE.MeshStandardMaterial({
        color: 0xbfefff, emissive: 0x3aa8ff, emissiveIntensity: 0.6, roughness: 0.15, metalness: 0.1,
        transparent: true, opacity: 0.55, flatShading: true, depthWrite: false,
      }),
    );
    this.ice.scale.set(1, 1.45, 1);
    this.ice.position.y = 1.0;
    this.ice.visible = false;
    this.root.add(this.ice);

    // Team ring on the floor for readability.
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.7, 40),
      new THREE.MeshBasicMaterial({ color: team.spell, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.03;
    this.root.add(this.ring);
  }

  /**
   * Swap the whole look at runtime: palette, and either a GLB instance or the primitive
   * placeholder (in `variant`'s silhouette). Used to dress the rival as each campaign boss.
   */
  setAppearance(team: TeamPalette, model: ModelInstance | null, modelSpec: ModelAsset, variant: PlaceholderVariant = 'wizard'): void {
    this.team = team;
    this.clearLook();
    this.build(model, modelSpec, variant);
    this.chargeGlow.material.color.setHex(team.spell);
    (this.shield.material.uniforms.uColor.value as THREE.Color).setHex(team.spell);
    (this.ring.material as THREE.MeshBasicMaterial).color.setHex(team.spell);
  }

  private build(model: ModelInstance | null, modelSpec: ModelAsset, variant: PlaceholderVariant): void {
    this.styleWeight = modelSpec.motion?.weight ?? 0;
    this.styleMenace = modelSpec.motion?.menace ?? 0;
    if (model) {
      this.usesModel = true;
      this.rigged = !!model.rig;
      const height = modelSpec.fitHeight ?? CONFIG.wizard.height;
      this.topHeight = height;
      model.root.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m && 'emissive' in m) {
          const clone = m.clone();
          addDitherFade(clone, this.fadeUniform);
          (o as THREE.Mesh).material = clone;
          this.tintMaterials.push(clone);
          this.owned.push(clone);
        }
        // Each copy of a skinned model has its own skeleton (and bone texture): free it with the look.
        const skinned = o as THREE.SkinnedMesh;
        if (skinned.isSkinnedMesh) {
          skinned.frustumCulled = false;
          this.owned.push(skinned.skeleton);
        }
        // Wings split onto their own bones (Tinubu's LeftWing/RightWing, no clip channels) or meshes.
        if (/wing/i.test(o.name) && ((o as THREE.Bone).isBone || ((o as THREE.Mesh).isMesh && !skinned.isSkinnedMesh))) {
          o.userData.wingRest = o.quaternion.clone();
          o.userData.wingSide = /left/i.test(o.name) ? 1 : /right/i.test(o.name) ? -1 : o.position.x >= 0 ? 1 : -1;
          this.wings.push(o);
        }
      });
      if (model.animations.length) {
        const anim = new Animator(model, modelSpec);
        if (anim.clips.length) this.animator = anim;
        else anim.dispose();
      }
      this.proc = this.animator ? RIG_PROC : STATIC_PROC;
      // Measured in its own frame (feet at the origin) and in the pose it starts in (a rig's idle).
      this.measureLook(model.root);
      model.root.position.y = -0.9;
      this.body.add(model.root);
      const set = muzzleSetFor(modelSpec);
      this.fxScale = height / 2;
      this.applyMuzzles(set ? resolveMuzzles(set, height) : null);
      this.attachSockets(model);
    } else {
      this.usesModel = false;
      this.rigged = false;
      this.proc = STATIC_PROC;
      this.buildPlaceholder(variant);
      const k = PLACEHOLDER_SCALE[variant] ?? 1;
      this.fxScale = k;
      this.applyMuzzles(resolveMuzzles(PLACEHOLDER_MUZZLES[variant], 1, k));
    }
  }

  /**
   * Rigged look: hang an empty on each muzzle's socket bone (manifest `rigged.sockets`, by muzzle
   * point name), so its glows follow the animated staff, phone or vape. Muzzles without a socket
   * keep their measured point.
   */
  private attachSockets(model: ModelInstance): void {
    const sockets = model.rig?.sockets;
    const points = this.muzzles?.points;
    if (!sockets || !points) return;
    const names = Object.keys(sockets);
    points.forEach((p, i) => {
      // By muzzle name; a lone muzzle takes a lone socket whatever it is called (phone / phoneR).
      const s = sockets[p.name] ?? (points.length === 1 && names.length === 1 ? sockets[names[0]] : undefined);
      const bone = s && model.root.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(s.bone));
      if (!s || !bone) return;
      const socket = new THREE.Object3D();
      socket.name = `socket:${p.name}`;
      const at = s.glowOffset ?? s.offset;
      socket.position.set(at[0], at[1], at[2]);
      bone.add(socket);
      this.slots[i].socket = socket;
    });
  }

  /** Lean-lift footprint and camera-fade radius of a GLB look, from its vertices (once per swap). */
  private measureLook(root: THREE.Object3D): void {
    root.updateMatrixWorld(true);
    const bands: [number, number][][] = [[], [], [], []];
    let r2 = 0;
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const pos = mesh.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        posedVertex(mesh, i, tmpV);
        r2 = Math.max(r2, tmpV.x * tmpV.x + tmpV.z * tmpV.z);
        if (tmpV.y > 0.3) continue;
        bands[0].push([tmpV.z, tmpV.y]);
        bands[1].push([-tmpV.z, tmpV.y]);
        bands[2].push([tmpV.x, tmpV.y]);
        bands[3].push([-tmpV.x, tmpV.y]);
      }
    });
    this.boundsRadius = Math.sqrt(r2);
    this.feet = bands.map(footFront);
    this.leanCaps = this.feet.map(leanCap);
  }

  /** Put the look's muzzle points on the anchors (null: none, the generic wand). */
  private applyMuzzles(resolved: ResolvedMuzzles | null): void {
    this.muzzles = resolved;
    for (let i = 0; i < MAX_MUZZLES; i++) {
      const slot = this.slots[i];
      const m = resolved?.points[i];
      slot.anchor.visible = !!m;
      slot.flare = slot.charge = 0;
      slot.flash.visible = false;
      slot.socket = null;
      if (!m) continue;
      slot.home.copy(m.local);
      slot.anchor.position.copy(m.local);
      slot.type = m.type;
      slot.size = m.size;
      const look = MUZZLE_LOOK[m.type];
      slot.color.setHex(look.color || this.team.spell);
      slot.flashColor.setHex(look.flashColor || look.color || this.team.spell);
      slot.phone.visible = m.prop;
      // A phone about 7.5 % of the model's height, poking up out of the fist, screen forward.
      const h = this.topHeight * 0.075;
      slot.phone.scale.setScalar(h);
      slot.phone.position.set(0, h * 0.3, 0);
    }
  }

  private makeSlot(): MuzzleSlot {
    const sprite = () => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false,
      }));
      s.renderOrder = 12;
      s.visible = false;
      return s;
    };
    const anchor = new THREE.Group();
    anchor.visible = false;
    const glow = sprite();
    const flash = sprite();
    phoneGeo ??= { body: new THREE.BoxGeometry(0.5, 1, 0.09), screen: new THREE.PlaneGeometry(0.43, 0.86) };
    const phone = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x15161b, roughness: 0.35, metalness: 0.4 });
    const screenMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x9fd0ff).multiplyScalar(1.6), toneMapped: false });
    addDitherFade(bodyMat, this.fadeUniform);
    addDitherFade(screenMat, this.fadeUniform);
    const body = new THREE.Mesh(phoneGeo.body, bodyMat);
    body.castShadow = true;
    const screen = new THREE.Mesh(phoneGeo.screen, screenMat);
    screen.position.z = 0.046;
    phone.add(body, screen);
    phone.visible = false;
    anchor.add(glow, flash, phone);
    this.muzzleRoot.add(anchor);
    return {
      anchor, home: new THREE.Vector3(), socket: null, glow, flash, phone,
      color: new THREE.Color(), flashColor: new THREE.Color(), type: 'staff', size: 1, flare: 0, charge: 0,
    };
  }

  // ------------------------------------------------------------------ muzzles

  /** Which muzzle point `kind` leaves from on shot number `turn` (alternating lists), or -1 (generic wand). */
  muzzleIndex(kind: CastKind, turn: number): number {
    const list = this.muzzles?.use[kind];
    return list ? list[turn % list.length] : -1;
  }

  /** Muzzle `index`'s point in the look's feet frame (meters, before the root's scale and yaw). */
  muzzlePoint(index: number, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.muzzles!.points[index].local);
  }

  /** The type of muzzle `index` ('staff' for the generic wand). */
  muzzleType(index: number): MuzzleType {
    return this.muzzles?.points[index]?.type ?? 'staff';
  }

  /** Effect size of muzzle `index`: the point's size times the look's scale. */
  muzzleSize(index: number): number {
    return (this.muzzles?.points[index]?.size ?? 1) * this.fxScale;
  }

  /** A spell just left muzzle `index`: its flash (gunfire strobes, a staff flares). */
  flare(index: number, strength = 1): void {
    const slot = this.slots[index];
    if (!slot || !slot.anchor.visible) return;
    slot.flare = Math.max(slot.flare, strength);
    // Every gunshot's star is turned a little differently.
    slot.flash.material.rotation = slot.type === 'gun' ? Math.random() * Math.PI : 0;
  }

  /** Current flash of muzzle `index` (QA). */
  muzzleFlare(index: number): number {
    return this.slots[index]?.flare ?? 0;
  }

  /** Muzzle `index`'s code-built phone is showing (QA). */
  muzzleProp(index: number): boolean {
    const slot = this.slots[index];
    return !!slot && slot.anchor.visible && slot.phone.visible;
  }

  /**
   * World position of muzzle `index` as last rendered (QA and effects): on a rigged look with a
   * socket, where the animated prop is; otherwise the measured point in the render pose.
   */
  muzzleWorld(index: number, out: THREE.Vector3): THREE.Vector3 {
    const slot = this.slots[index];
    return slot ? slot.anchor.getWorldPosition(out) : out.set(NaN, NaN, NaN);
  }

  /** World position of muzzle `index`'s measured point (the gameplay origin) in the render pose (QA). */
  muzzleHomeWorld(index: number, out: THREE.Vector3): THREE.Vector3 {
    const slot = this.slots[index];
    if (!slot) return out.set(NaN, NaN, NaN);
    this.muzzleRoot.updateWorldMatrix(true, false);
    return this.muzzleRoot.localToWorld(out.copy(slot.home));
  }

  /** Muzzle `index` rides a bone socket of a rigged look. */
  muzzleSocketed(index: number): boolean {
    return !!this.slots[index]?.socket && this.slots[index].anchor.visible;
  }

  /**
   * Where muzzle effects for `index` should play (MuzzleFx): its bone socket as last rendered when it
   * has one, else `spawn` (the projectile's spawn point, Wizard.castPoint).
   */
  muzzleFxOrigin(index: number, spawn: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return index >= 0 && this.muzzleSocketed(index) ? this.slots[index].anchor.getWorldPosition(out) : out.copy(spawn);
  }

  /** World position of the spell's windup glow, or NaN when none shows (QA). */
  chargeGlowWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.chargeGlow.visible ? this.chargeGlow.getWorldPosition(out) : out.set(NaN, NaN, NaN);
  }

  /** The visible meshes of the current look (model or placeholder parts), for QA ray and vertex tests. */
  lookMeshes(): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    this.body.traverseVisible((o) => {
      if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
    });
    return out;
  }

  /** Lowest point of the current look (model or placeholder) in world space, from its vertices (QA). */
  lookBottom(): number {
    this.root.updateMatrixWorld(true);
    let low = Infinity;
    this.body.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible) return;
      const pos = mesh.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) low = Math.min(low, posedVertex(mesh, i, tmpV).y);
    });
    return low;
  }

  /** The procedural hip pivot (QA: lean, sway, bob, lunge and squash all show on it). */
  get hipPivot(): THREE.Object3D {
    return this.pivot;
  }

  /** How far the procedural death topple has gone, 0..1 (0 while a defeat clip plays instead). */
  get topple(): number {
    return this.deathT;
  }

  /** Split wings found on the look (QA). */
  get wingCount(): number {
    return this.wings.length;
  }

  /** Eased MotionStyle in use: weight and menace (QA). */
  get motionStyle(): { weight: number; menace: number } {
    return { weight: this.weight, menace: this.menace };
  }

  /** Muzzle objects owned by this visual (QA: the count never changes). */
  get muzzleObjects(): number {
    let n = 1; // chargeGlow
    for (const s of this.slots) n += s.anchor.children.length + 1;
    return n;
  }

  // ------------------------------------------------------------- camera fade

  /** Visibility 0..1 (1 = solid). */
  get fade(): number {
    return this.fadeUniform.value;
  }

  /** Ease the look's visibility toward `target`; 0 applies at once, so nothing ever renders inside the camera. */
  setFade(target: number, dt: number): void {
    const f = target <= 0 ? 0 : damp(this.fadeUniform.value, target, 14, dt);
    this.fadeUniform.value = f > 0.995 ? 1 : f;
  }

  /** Remove the current look and free what it created (GLB geometry stays shared with its template). */
  private clearLook(): void {
    this.body.scale.setScalar(1);
    this.body.position.y = 0;
    this.animator?.dispose();
    this.animator = null;
    this.wings.length = 0;
    for (const s of this.slots) s.socket = null;
    this.armPivot.clear();
    this.body.clear();
    for (const r of this.owned) r.dispose();
    this.owned.length = 0;
    this.tintMaterials.length = 0;
  }

  private buildPlaceholder(variant: PlaceholderVariant): void {
    const t = this.team;
    const own = <T extends { dispose(): void }>(r: T): T => {
      this.owned.push(r);
      if (r instanceof THREE.Material) addDitherFade(r, this.fadeUniform);
      return r;
    };
    const standard = (color: number, roughness: number) => own(new THREE.MeshStandardMaterial({ color, roughness }));
    const glowing = (color: number, intensity: number) =>
      own(new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), toneMapped: false }));
    const robe = standard(t.robe, 0.85);
    const trim = standard(t.trim, 0.6);
    const skin = standard(SKIN_TONES[variant], 0.7);
    const wood = standard(0x3b2716, 0.6);
    this.tintMaterials.push(robe, trim, skin);
    const eye = glowing(t.spell, variant === 'tinubu' ? 5 : 3);
    const tip = glowing(t.spell, 4);

    const add: AddMesh = (geo, mat, x, y, z, parent = this.body) => {
      const m = new THREE.Mesh(own(geo), mat);
      m.position.set(x, y - 0.9, z);
      m.castShadow = true;
      parent.add(m);
      return m;
    };

    // Robe skirt: a broad one for the rug merchant, narrow for the long coat and the suit.
    const skirt = variant === 'sahil' ? 0.6 : variant === 'obama' || variant === 'agent' ? 0.42 : 0.52;
    add(new THREE.ConeGeometry(skirt, 1.25, 16), robe, 0, 0.62, 0);
    add(new THREE.CapsuleGeometry(0.25, 0.42, 4, 12), robe, 0, 1.22, 0); // torso
    add(new THREE.TorusGeometry(0.27, 0.05, 6, 16), trim, 0, 1.42, 0).rotation.x = Math.PI / 2; // collar
    add(new THREE.SphereGeometry(0.2, 16, 12), skin, 0, 1.6, 0.02); // head
    add(new THREE.SphereGeometry(0.035, 6, 6), eye, 0.075, 1.63, 0.19);
    add(new THREE.SphereGeometry(0.035, 6, 6), eye, -0.075, 1.63, 0.19);
    this.topHeight = this.buildHeadgear(variant, add, robe, trim, standard, glowing);

    // Right arm and what it casts with. Pivot at the shoulder so casting can thrust it forward.
    this.armPivot.position.set(-0.3, 1.36 - 0.9, 0);
    this.body.add(this.armPivot);
    // armPivot children are placed relative to the shoulder (add() subtracts 0.9 from y).
    const arm = add(new THREE.CapsuleGeometry(0.075, 0.36, 3, 8), robe, -0.02, 0.88, 0.2, this.armPivot);
    arm.rotation.x = Math.PI / 2;
    this.buildProp(variant, add, wood, tip, trim, skin, standard);

    // A short boss: the same build, scaled down about the feet.
    const k = PLACEHOLDER_SCALE[variant] ?? 1;
    if (k !== 1) {
      this.body.scale.setScalar(k);
      this.body.position.y = -0.9 * (1 - k);
      this.topHeight *= k;
    }
    // The robe hem is the lowest, widest thing: what a lean could tip into the floor.
    const hem = new Float32Array([(SKIRT[variant] ?? 0.52) * k, 0]);
    this.feet = [hem, hem, hem, hem];
    this.leanCaps = this.feet.map(leanCap);
    this.boundsRadius = 0.75 * k;
  }

  /**
   * The placeholder's prop in its right hand, matching PLACEHOLDER_MUZZLES: a staff with a glowing
   * orb (the wizards, Sahil), a phone (Obama, The Midget), a vape pen (Broccoli Head), a pistol
   * (Glowie), or an open palm (Tinubu, who also gets a mouth).
   */
  private buildProp(
    variant: PlaceholderVariant,
    add: AddMesh,
    wood: THREE.MeshStandardMaterial,
    tip: THREE.MeshBasicMaterial,
    trim: THREE.MeshStandardMaterial,
    skin: THREE.MeshStandardMaterial,
    standard: (color: number, roughness: number) => THREE.MeshStandardMaterial,
  ): void {
    // Shoulder-relative: the hand is at about (-0.04, 0, 0.45); add() wants y + 0.9.
    const hand = this.armPivot;
    const metal = () => standard(0x24262c, 0.4);
    switch (variant) {
      case 'obama':
      case 'midget': {
        add(new THREE.BoxGeometry(0.075, 0.145, 0.014), metal(), -0.04, 0.97, 0.475, hand);
        add(new THREE.PlaneGeometry(0.064, 0.125), tip, -0.04, 0.97, 0.4825, hand).castShadow = false;
        return;
      }
      case 'broccoli': {
        add(new THREE.CylinderGeometry(0.014, 0.014, 0.15, 8), metal(), -0.04, 0.96, 0.46, hand);
        add(new THREE.CylinderGeometry(0.008, 0.012, 0.03, 8), standard(0xd8d8e0, 0.3), -0.04, 1.05, 0.46, hand);
        add(new THREE.TorusGeometry(0.015, 0.004, 4, 12), tip, -0.04, 0.9, 0.46, hand).rotation.x = Math.PI / 2;
        return;
      }
      case 'agent': {
        const gun = metal();
        add(new THREE.BoxGeometry(0.035, 0.045, 0.2), gun, -0.04, 0.93, 0.6, hand);
        add(new THREE.BoxGeometry(0.03, 0.09, 0.04), gun, -0.04, 0.87, 0.52, hand).rotation.x = 0.25;
        return;
      }
      case 'tinubu': {
        // An open palm raised to the front, and a mouth for the fire breath.
        add(new THREE.SphereGeometry(0.065, 10, 8), skin, -0.04, 0.92, 0.47, hand).scale.set(1, 1.3, 0.45);
        add(new THREE.BoxGeometry(0.09, 0.022, 0.012), standard(0x3a0806, 0.6), 0, 1.53, 0.205);
        return;
      }
      default: {
        // A staff held upright, a glowing orb on top in a trim collar.
        const shaft = add(new THREE.CylinderGeometry(0.02, 0.028, 1.33, 6), wood, -0.04, 0.615, 0.44, hand);
        shaft.castShadow = false;
        add(new THREE.TorusGeometry(0.05, 0.012, 5, 12), trim, -0.04, 1.29, 0.44, hand).rotation.x = Math.PI / 2;
        add(new THREE.SphereGeometry(0.065, 12, 10), tip, -0.04, 1.34, 0.44, hand).castShadow = false;
      }
    }
  }

  /** Headgear and body cues for the placeholder (who it is at a glance). Returns the height of its top. */
  private buildHeadgear(
    variant: PlaceholderVariant,
    add: AddMesh,
    robe: THREE.MeshStandardMaterial,
    trim: THREE.MeshStandardMaterial,
    standard: (color: number, roughness: number) => THREE.MeshStandardMaterial,
    glowing: (color: number, intensity: number) => THREE.MeshBasicMaterial,
  ): number {
    const t = this.team;
    /** A cluster of spheres (beard, broccoli florets): [x, y, z, radius]. */
    const blobs = (list: number[][], mat: THREE.Material) => {
      for (const [x, y, z, r] of list) add(new THREE.SphereGeometry(r, 8, 6), mat, x, y, z);
    };

    switch (variant) {
      case 'sahil': {
        // The RugMaster: a round belly under a sash, a bushy beard and brows, a small red fez.
        add(new THREE.SphereGeometry(0.34, 16, 12), robe, 0, 1.05, 0.1).scale.set(1, 0.95, 0.9);
        add(new THREE.TorusGeometry(0.31, 0.035, 6, 20), trim, 0, 1.12, 0.08).rotation.x = Math.PI / 2 - 0.15;
        const hair = standard(0x3b2416, 0.95);
        blobs([
          [0, 1.48, 0.15, 0.11], [0.1, 1.51, 0.14, 0.09], [-0.1, 1.51, 0.14, 0.09], [0.16, 1.57, 0.09, 0.075],
          [-0.16, 1.57, 0.09, 0.075], [0, 1.4, 0.15, 0.09], [0.06, 1.555, 0.19, 0.045], [-0.06, 1.555, 0.19, 0.045],
          [0, 1.36, 0.25, 0.06], [0.08, 1.37, 0.23, 0.055], [-0.08, 1.37, 0.23, 0.055],
        ], hair);
        for (const side of [1, -1]) add(new THREE.BoxGeometry(0.08, 0.022, 0.03), hair, side * 0.075, 1.685, 0.18).rotation.z = side * 0.18;
        const fez = standard(0xb3122a, 0.6);
        add(new THREE.CylinderGeometry(0.11, 0.135, 0.17, 16), fez, 0, 1.84, -0.01);
        add(new THREE.CylinderGeometry(0.008, 0.008, 0.12, 4), hair, 0.09, 1.86, -0.02).rotation.z = -0.35;
        add(new THREE.SphereGeometry(0.025, 6, 5), glowing(t.spell, 2), 0.12, 1.8, -0.02);
        return 2.0;
      }
      case 'obama': {
        // Mustard wide-brim hat and a long black coat with a gold chain and a glowing coin.
        const mustard = standard(0xc9a032, 0.65);
        add(new THREE.CylinderGeometry(0.43, 0.43, 0.03, 28), mustard, 0, 1.765, 0);
        add(new THREE.CylinderGeometry(0.19, 0.22, 0.22, 20), mustard, 0, 1.88, 0);
        add(new THREE.CylinderGeometry(0.222, 0.222, 0.045, 20), standard(0x2a2214, 0.7), 0, 1.8, 0);
        const shirt = standard(0xe8e4dc, 0.7);
        add(new THREE.BoxGeometry(0.12, 0.24, 0.02), shirt, 0, 1.3, 0.235).rotation.x = -0.12;
        for (const side of [1, -1]) {
          const lapel = add(new THREE.BoxGeometry(0.09, 0.3, 0.025), robe, side * 0.09, 1.3, 0.245);
          lapel.rotation.set(-0.12, 0, side * 0.3);
        }
        add(new THREE.TorusGeometry(0.17, 0.012, 5, 20, Math.PI), trim, 0, 1.36, 0.17).rotation.set(Math.PI + 0.35, 0, 0);
        add(new THREE.CylinderGeometry(0.055, 0.055, 0.015, 16), glowing(t.spell, 2.2), 0, 1.19, 0.26).rotation.x = Math.PI / 2 - 0.15;
        return 2.02;
      }
      case 'midget': {
        // The Midget: a short gold top hat, a gold chain and a glowing coin (scaled down after).
        const gold = standard(t.trim, 0.4);
        add(new THREE.CylinderGeometry(0.3, 0.3, 0.03, 24), gold, 0, 1.77, 0);
        add(new THREE.CylinderGeometry(0.17, 0.18, 0.34, 20), gold, 0, 1.95, 0);
        add(new THREE.CylinderGeometry(0.185, 0.185, 0.05, 20), standard(t.robe, 0.7), 0, 1.81, 0);
        add(new THREE.TorusGeometry(0.17, 0.014, 5, 20, Math.PI), gold, 0, 1.36, 0.17).rotation.set(Math.PI + 0.35, 0, 0);
        add(new THREE.CylinderGeometry(0.06, 0.06, 0.015, 16), glowing(t.spell, 2.2), 0, 1.19, 0.26).rotation.x = Math.PI / 2 - 0.15;
        return 2.12;
      }
      case 'broccoli': {
        // A broccoli-floret head: florets crowd the top and back of a pale green stalk of a face.
        const floret = standard(t.robe, 0.9);
        floret.emissive.setHex(t.spell).multiplyScalar(0.12);
        const bright = standard(t.spell, 0.8);
        bright.emissive.setHex(t.spell).multiplyScalar(0.25);
        const cluster: number[][] = [[0, 1.86, -0.03, 0.17]];
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * Math.PI * 2;
          cluster.push([Math.sin(a) * 0.19, 1.76, Math.cos(a) * 0.17 - 0.04, 0.12]);
        }
        for (let i = 0; i < 6; i++) {
          const a = Math.PI * 0.55 + (i / 5) * Math.PI * 0.9;
          cluster.push([Math.sin(a) * 0.25, 1.62, Math.cos(a) * 0.22 - 0.03, 0.1]);
        }
        blobs(cluster, floret);
        blobs([[0.08, 1.95, 0.05, 0.06], [-0.1, 1.9, 0.08, 0.055], [0.15, 1.82, 0.1, 0.05], [-0.16, 1.8, 0.06, 0.05]], bright);
        return 2.05;
      }
      case 'agent': {
        // Black suit, white shirt and tie, slicked short hair, dark sunglasses (no hat).
        add(new THREE.SphereGeometry(0.207, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.42), standard(0x1a1410, 0.6), 0, 1.6, -0.005);
        // Sunglasses sit in front of the glowing eyes and hide them.
        const shades = standard(0x07080a, 0.15);
        add(new THREE.BoxGeometry(0.27, 0.05, 0.03), shades, 0, 1.64, 0.215);
        for (const side of [1, -1]) {
          add(new THREE.BoxGeometry(0.105, 0.08, 0.03), shades, side * 0.072, 1.627, 0.22);
          add(new THREE.BoxGeometry(0.012, 0.012, 0.2), shades, side * 0.165, 1.645, 0.11);
        }
        add(new THREE.SphereGeometry(0.012, 5, 4), glowing(t.spell, 3), 0.1, 1.65, 0.238); // lens glint
        const shirt = standard(0xf1f1f1, 0.6);
        add(new THREE.BoxGeometry(0.13, 0.26, 0.02), shirt, 0, 1.3, 0.235).rotation.x = -0.12;
        add(new THREE.BoxGeometry(0.035, 0.22, 0.012), standard(0x0b0b0e, 0.5), 0, 1.28, 0.25).rotation.x = -0.12;
        for (const side of [1, -1]) {
          const lapel = add(new THREE.BoxGeometry(0.08, 0.28, 0.025), robe, side * 0.095, 1.3, 0.245);
          lapel.rotation.set(-0.12, 0, side * 0.32);
        }
        add(new THREE.SphereGeometry(0.018, 6, 5), standard(0xd8d8d8, 0.3), -0.2, 1.6, 0.03); // earpiece
        return 1.84;
      }
      case 'tinubu': {
        // A tall fila cap folded to one side with a gold emblem, small red horns, wide agbada shoulders.
        add(new THREE.CylinderGeometry(0.17, 0.205, 0.34, 18), robe, 0.02, 1.9, -0.02).rotation.z = -0.18;
        add(new THREE.SphereGeometry(0.17, 14, 8), robe, 0.07, 2.06, -0.02).scale.set(1.05, 0.45, 1);
        add(new THREE.CylinderGeometry(0.06, 0.06, 0.02, 16), glowing(t.trim, 2), 0.0, 1.9, 0.19).rotation.x = Math.PI / 2;
        const horn = standard(0xb3141a, 0.45);
        horn.emissive.setHex(t.spell).multiplyScalar(0.3);
        for (const side of [1, -1]) {
          add(new THREE.ConeGeometry(0.05, 0.22, 8), horn, side * 0.21, 1.8, 0.03).rotation.set(0.15, 0, -side * 0.8);
          add(new THREE.SphereGeometry(0.17, 12, 8), robe, side * 0.3, 1.42, 0).scale.set(1.25, 0.45, 1);
          add(new THREE.TorusGeometry(0.17, 0.014, 5, 16), trim, side * 0.3, 1.42, 0).rotation.x = Math.PI / 2;
        }
        return 2.18;
      }
      default: {
        add(new THREE.CylinderGeometry(0.44, 0.44, 0.04, 24), robe, 0, 1.72, 0); // hat brim
        const hat = add(new THREE.ConeGeometry(0.27, 0.62, 16), robe, 0, 2.02, -0.04);
        hat.rotation.x = -0.18;
        add(new THREE.TorusGeometry(0.25, 0.03, 6, 16), trim, 0, 1.77, 0).rotation.x = Math.PI / 2; // hat band
        return WIZARD_TOP;
      }
    }
  }

  /** Brief flash on the shield when it blocks something. */
  shieldImpact(perfect: boolean): void {
    this.shieldHit = perfect ? 1.5 : 1;
  }

  /**
   * Muzzles each frame: the tip glow (staff orb, phone screen, vape LED, an ember in Tinubu's palm
   * and jaw), its windup glow when a spell will leave from it, and the cast flash; the spell's own
   * charge glow sits at that muzzle. Records the brightest as the light MuzzleFx should give.
   */
  private updateMuzzles(w: Wizard, dt: number, winding: number): void {
    const cast = w.cast;
    const m = this.muzzles;
    const fade = this.fadeUniform.value;
    // The camera in the feet frame, so glows sit on the camera's side of their prop.
    this.muzzleRoot.updateWorldMatrix(true, false);
    tmpInv.copy(this.muzzleRoot.matrixWorld).invert();
    tmpCam.copy(WizardVisual.viewer).applyMatrix4(tmpInv);
    // Rigged looks: anchors ride their bone sockets (posed by the Animator this frame).
    for (const slot of this.slots) {
      if (!slot.socket || !slot.anchor.visible) continue;
      slot.socket.updateWorldMatrix(true, false);
      slot.anchor.position.setFromMatrixPosition(slot.socket.matrixWorld).applyMatrix4(tmpInv);
    }
    this.lightLevel = 0;
    let first = -1;
    for (let i = 0; i < MAX_MUZZLES; i++) {
      const slot = this.slots[i];
      if (!slot.anchor.visible) continue;
      const look = MUZZLE_LOOK[slot.type];
      let target = 0;
      if (cast && m) {
        const list = m.use[cast.spell];
        if (cast.spell === 'ultimate' ? list.includes(i) : list[w.muzzleTurn % list.length] === i) target = winding;
      }
      if (target > 0 && first < 0) first = i;
      slot.charge = damp(slot.charge, target, 20, dt);
      slot.flare = Math.max(0, slot.flare - dt * look.decay);
      const s = this.fxScale * slot.size;
      tmpDir.subVectors(tmpCam, slot.anchor.position);
      const dist = tmpDir.length();
      tmpDir.multiplyScalar(dist > 1e-4 ? 1 / dist : 0);
      // Idle: embers flicker in the palm and jaw, the staff throbs slowly, a phone screen shows from the front.
      let idle = look.idle;
      if (slot.type === 'hand' || slot.type === 'mouth') idle *= 0.75 + 0.25 * Math.sin(this.time * 13 + i * 2.1) * Math.sin(this.time * 7.3 + i);
      else if (slot.type === 'staff') idle *= 0.85 + 0.15 * Math.sin(this.time * 2.6);
      const pulse = 1 + slot.charge * (slot.type === 'staff' ? 0.25 * Math.sin(this.time * 18) : 0.1 * Math.sin(this.time * 40));
      let level = (idle + slot.charge * 1.0 + slot.flare * 0.9) * pulse;
      if (slot.type === 'phone') level *= saturate(tmpDir.z * 1.6 + 0.35);
      if (!w.alive) level *= 0.3;
      slot.glow.visible = level * fade > 0.01;
      if (slot.glow.visible) {
        slot.glow.position.copy(tmpDir).multiplyScalar(look.pull * s);
        slot.glow.material.color.copy(slot.color).multiplyScalar(level * 1.6);
        slot.glow.material.opacity = fade;
        slot.glow.scale.setScalar(look.glow * s * (1 + slot.charge * 0.6 + slot.flare * 0.5) * pulse);
      }
      const f = slot.flare;
      slot.flash.visible = f > 0.01 && fade > 0.02;
      if (slot.flash.visible) {
        slot.flash.position.copy(tmpDir).multiplyScalar(look.pull * s * 1.5);
        slot.flash.material.color.copy(slot.flashColor).multiplyScalar(1.8 * f);
        slot.flash.material.opacity = fade * f;
        // Gunfire: a hard star that shrinks away; the rest bloom outward as they fade.
        slot.flash.scale.setScalar(look.flash * s * (slot.type === 'gun' ? 0.7 + 0.4 * f : 1.25 - 0.55 * f));
      }
      const light = (slot.charge * 0.9 + f * look.light) * fade;
      if (light > this.lightLevel) {
        this.lightLevel = light;
        this.lightColor.copy(f > slot.charge ? slot.flashColor : slot.color);
        slot.anchor.getWorldPosition(this.lightPos);
      }
    }

    // The spell's own windup glow (blast, stun or Ultimate colour), at the muzzle it leaves from.
    const glow = this.chargeGlow;
    if (!cast) {
      glow.visible = false;
      return;
    }
    glow.visible = fade > 0.02;
    if (first >= 0) {
      const slot = this.slots[first];
      glow.position.copy(slot.anchor.position).add(slot.glow.position);
    } else {
      // The generic wand (a look without muzzle data): in front of the right hand, scaled with the body.
      const k = w.sizeScale;
      glow.position.set(-0.34 * k, (1.36 + winding * 0.1) * k, (0.72 + this.armPivot.position.z) * k);
    }
    const spellColor = cast.spell === 'stun' ? w.team.stun : cast.spell === 'ultimate' ? w.team.ultimate : w.team.blast;
    // At a prop the muzzle's own glow does much of the work, so the spell's glow is a tighter core.
    const atProp = first >= 0;
    glow.material.color.setHex(spellColor).multiplyScalar(atProp ? 1.8 : 2.5);
    glow.material.opacity = fade;
    const size = (cast.spell === 'ultimate' ? 2.6 : 1.1) * (atProp ? 0.6 : 1) * (0.4 + winding) * (1 + Math.sin(this.time * 40) * 0.08);
    glow.scale.setScalar(size * Math.max(0.6, this.fxScale));
  }

  /**
   * Per render frame. `alpha` interpolates between the last two physics ticks.
   *
   * Procedural motion on the hip pivot gives every look life: all of it for a static mesh or
   * placeholder, a lighter share on top of a rigged look's clips (RIG_PROC). Breathing and a slow
   * idle sway; a lean into movement, acceleration and turns; a footstep bob and waddle paced by the
   * stride; jump squash and stretch; a flinch along the knockback when hit; a gather-and-lunge on
   * casts; on big boss stages a heavier gait and a looming sway (MotionStyle). Then the rig's
   * Animator poses the skeleton, muzzle anchors follow their bone sockets, and the glows, tint,
   * shield, ice and ring update.
   */
  update(w: Wizard, dt: number, alpha: number): void {
    this.time += dt;
    const P = this.proceduralOff ? NO_PROC : this.proc;
    const anim = this.animator;
    const x = lerp(w.prevPos.x, w.pos.x, alpha);
    const y = lerp(w.prevPos.y, w.pos.y, alpha);
    const z = lerp(w.prevPos.z, w.pos.z, alpha);
    this.root.position.set(x, y, z);
    const facing = w.prevFacing + wrapAngle(w.facing - w.prevFacing) * alpha;
    this.root.rotation.y = facing;

    // Velocity in local space for leaning (+x the character's left, +z forward), knockback included.
    const s = Math.sin(facing), c = Math.cos(facing);
    const vx = w.vel.x + w.knock.x, vz = w.vel.z + w.knock.z;
    const localX = vx * c - vz * s;
    const localZ = vx * s + vz * c;
    const speed = Math.hypot(vx, vz);
    const frozen = w.stunned;
    const alive = w.alive;

    // Motion style: the look's own; a placeholder stage grown by BossStages counts as heavier.
    const growth = Math.max(0, this.root.scale.x - 1);
    this.weight = damp(this.weight, Math.max(this.styleWeight, growth * 3), 2, dt);
    this.menace = damp(this.menace, Math.max(this.styleMenace, saturate((growth - 0.15) * 10)), 2, dt);
    const heavy = this.weight;
    const menace = this.menace * P.menace;

    // Turn rate and acceleration, smoothed: leaning into turns, starts and stops.
    if (dt > 0) {
      const yaw = Number.isNaN(this.lastFacing) ? 0 : wrapAngle(facing - this.lastFacing) / dt;
      this.turnRate = damp(this.turnRate, clamp(yaw, -10, 10), 12, dt);
      const ax = (vx - this.lastVX) / dt, az = (vz - this.lastVZ) / dt;
      this.accX = damp(this.accX, clamp(ax * c - az * s, -60, 60), 10, dt);
      this.accZ = damp(this.accZ, clamp(ax * s + az * c, -60, 60), 10, dt);
    }
    this.lastFacing = facing;
    this.lastVX = vx;
    this.lastVZ = vz;

    // Events: a hit (hitFlash is set again by every hit), a spell leaving (castPulse jumps to 1),
    // takeoffs and touchdowns (squash and stretch).
    if (w.hitFlash > this.lastHitFlash + 1e-4 && alive) this.flinch(w, s, c);
    this.lastHitFlash = w.hitFlash;
    if (w.castPulse > 0.9 && w.castPulse > this.lastPulse + 0.05) this.lungeV += 2.4;
    this.lastPulse = w.castPulse;
    if (this.seenJumps < 0) {
      this.seenJumps = w.jumps;
      this.seenLandings = w.landings;
    }
    if (w.jumps !== this.seenJumps) {
      this.seenJumps = w.jumps;
      this.stretch = Math.max(this.stretch, J.takeoffStretch);
      this.stretchVel = 0;
    }
    if (w.landings !== this.seenLandings) {
      this.seenLandings = w.landings;
      this.stretch = -Math.min(J.maxLandSquash, w.landSpeed * J.landSquash * (1 + 0.3 * heavy));
      this.stretchVel = 0;
    }
    // Elongate along the motion, rising or falling; neutral at the apex.
    this.springs(dt, w.grounded ? 0 : Math.min(0.08, Math.abs(w.vy) * 0.01));

    if (!frozen) {
      // Rising leans back a touch, falling tips forward into the landing; speeding up tips forward,
      // braking back; turning while moving banks into the turn.
      const air = w.grounded ? 0 : -w.vy * 0.012;
      const turn = clamp(-this.turnRate * saturate(speed / W.moveSpeed) * 0.045, -0.14, 0.14);
      const toX = ((localZ / W.sprintSpeed) * 0.28 + air) * P.move + clamp(this.accZ * 0.0035, -0.1, 0.1) * P.lean;
      const toZ = ((-localX / W.sprintSpeed) * 0.3) * P.move + (clamp(-this.accX * 0.0025, -0.08, 0.08) + turn) * P.lean;
      this.leanX = damp(this.leanX, toX, 10, dt);
      this.leanZ = damp(this.leanZ, toZ, 10, dt);
    }

    // Footsteps: one bob per step, paced by the stride (longer for big and heavy looks), with the
    // weight rolling onto the planted foot.
    const moving = speed > 0.5 && !w.dodging && alive && w.grounded;
    if (moving && !frozen) this.stepPhase += ((dt * speed) / (1.75 * w.sizeScale * this.root.scale.x * (1 + 0.25 * heavy))) * Math.PI;
    this.stride = damp(this.stride, moving ? 1 : 0, 8, dt);
    // Idle life (alive, unfrozen): breathing, a slow weight shift and look-around; a looming boss
    // hunches, sways side to side and breathes deep.
    const calm = alive && !frozen ? 1 - this.stride : 0;
    const breath = Math.sin((this.time * Math.PI * 2) / (3 * (1 + 0.4 * heavy)));
    const swayX = calm * (0.03 * menace + breath * 0.006 * P.idle);
    // Side to side: the waddle onto the planted foot, the idle weight shift, a looming boss's sway. A
    // narrow look rolls; a wide hem (small side lean caps) shifts its weight sideways instead, so it
    // never dips into the floor.
    const side = calm * (Math.sin(this.time * 0.9) * 0.014 * P.idle + Math.sin(this.time * 1.85) * 0.035 * menace) +
      this.stride * Math.sin(this.stepPhase) * 0.03 * P.bob;
    const roll = saturate((Math.min(this.leanCaps[2], this.leanCaps[3]) - 0.12) / 0.2);
    const swayZ = side * roll;
    const shift = side * (1 - roll) * 1.4 * w.sizeScale;
    const yaw = calm * (Math.sin(this.time * 0.53) * 0.025 * P.idle + Math.sin(this.time * 0.7 + 1) * 0.035 * menace);

    // Lean, sway, flinch and the cast's gather (back) and lunge (forward), capped so a wide hem never
    // tips far into the floor (the rest is lifted out below).
    // +X tips the front down, -X the back; +Z tips the right side (-X) down, -Z the left.
    const winding = w.cast ? saturate(w.cast.elapsed / w.cast.duration) : 0;
    const caps = this.leanCaps;
    const leanX = clamp(this.leanX + swayX + this.flinchX + (this.lunge - winding * 0.08) * P.lunge, -caps[1], caps[0]);
    const leanZ = clamp(this.leanZ + swayZ + this.flinchZ, -caps[2], caps[3]);
    tmpQ.setFromAxisAngle(X_AXIS, leanX);
    tmpQ2.setFromAxisAngle(Z_AXIS, leanZ);
    tmpQ.multiply(tmpQ2);
    if (yaw !== 0) tmpQ.premultiply(tmpQ2.setFromAxisAngle(Y_AXIS, yaw));

    // Dodge roll without a roll clip: full flip around the axis perpendicular to the roll direction.
    let squash = 1;
    if (w.dodging && !anim?.has('dodge')) {
      const p = 1 - w.dodgeTime / W.dodge.duration;
      const e = p * p * (3 - 2 * p);
      const dx = w.dodgeDir.x, dz = w.dodgeDir.z;
      const lx = dx * c - dz * s;
      const lz = dx * s + dz * c;
      tmpAxis.set(lz, 0, -lx).normalize();
      tmpQ2.setFromAxisAngle(tmpAxis, e * Math.PI * 2);
      tmpQ.premultiply(tmpQ2);
      squash = 1 - Math.sin(p * Math.PI) * 0.35;
    }

    // Death without a defeat clip: topple backwards (a defeat clip falls on its own).
    if (!alive && !anim?.has('defeat')) {
      this.deathT = Math.min(1, this.deathT + dt * 2.2);
      const e = 1 - (1 - this.deathT) * (1 - this.deathT);
      tmpQ2.setFromAxisAngle(X_AXIS, -e * 1.45);
      tmpQ.premultiply(tmpQ2);
    } else {
      this.deathT = 0;
    }
    this.pivot.quaternion.copy(tmpQ);

    // Squash and stretch, the windup's crouch, and breathing.
    squash *= (1 + this.stretch) * (1 - winding * 0.03 * P.lunge) * (1 + breath * 0.008 * calm * P.idle * (1 + menace));
    const thin = (1 - this.stretch * 0.5) * (1 - breath * 0.004 * calm * P.idle);

    // Bob: celebrate hops, footsteps, or the breath's rise and fall.
    let bob = 0;
    if (frozen || !w.grounded) bob = 0;
    else if (this.celebrate) bob = Math.abs(Math.sin(this.time * 7)) * 0.25 * (anim?.has('victory') ? 0.25 : 1);
    else {
      bob = this.stride * Math.abs(Math.sin(this.stepPhase)) * 0.055 * (1 + 0.6 * heavy) * P.bob;
      bob += calm * breath * 0.012 * (1 + menace) * P.idle;
    }
    // A lean about the hip tips a wide look's hem into the floor: lift it by whatever would dip
    // (nothing when standing straight).
    this.leanLift = 0;
    if (alive && !w.dodging && this.feet.length === 4) {
      this.leanLift = leanDip(this.feet[leanX >= 0 ? 0 : 1], leanX, thin, squash) + leanDip(this.feet[leanZ >= 0 ? 3 : 2], leanZ, thin, squash);
    }
    this.pivot.position.y = 0.9 * squash + bob + this.leanLift - this.deathT * 0.55;
    this.pivot.scale.set(thin, squash, thin);
    // The lunge carries the body forward; a stunned wizard shivers in the ice.
    this.pivot.position.z = this.lunge * 0.5 * P.lunge;
    this.pivot.position.x = frozen ? Math.sin(this.time * 97) * Math.sin(this.time * 61) * 0.015 : shift;

    // Arm thrust on release, raised a little during windup (the placeholder's prop stays near its muzzle).
    this.armPivot.position.z = w.castPulse * 0.16 + winding * 0.05;
    this.armPivot.rotation.x = -winding * 0.25 - w.castPulse * 0.15;

    // Ice shell (stunned): the rig's stun clip plays until it has formed, then the pose is frozen in it.
    this.iceScale = damp(this.iceScale, frozen ? 1 : 0, frozen ? 25 : 12, dt);
    this.ice.visible = this.iceScale > 0.02;
    if (this.ice.visible) {
      const k = this.iceScale * w.sizeScale;
      this.ice.scale.set(k, k * 1.45, k);
      this.ice.position.y = w.shieldCenterY;
      this.ice.rotation.y = this.time * 0.3;
    }

    // Clips (rigged looks): the legs follow movement only, not a knockback slide.
    if (anim) {
      const inp = this.animInput;
      inp.speed = Math.hypot(w.vel.x, w.vel.z);
      inp.localX = w.vel.x * c - w.vel.z * s;
      inp.localZ = w.vel.x * s + w.vel.z * c;
      inp.celebrate = this.celebrate;
      inp.iceFormed = this.iceScale > 0.85;
      inp.weight = heavy;
      anim.update(w, dt, inp);
    }
    // Split wings (Tinubu's LeftWing/RightWing): a slow, menacing flap about the bone's forward axis
    // (their bind axes are the model's; +Z lifts the left wing, -Z the right), beating faster and
    // wider while a spell winds up or leaves and through a transformation; nearly still when KO'd or
    // frozen. Within the rig's tested range, -25° (fold) to +30° (lift).
    if (this.wings.length) {
      const roused = w.cast !== null || w.castPulse > 0.2 || w.evolving ? 1 : 0;
      this.wingRouse = damp(this.wingRouse, roused, roused ? 8 : 2.5, dt);
      this.wingPhase += dt * ((1.9 - 0.5 * heavy) + 3.2 * this.wingRouse);
      const amp = (0.2 + 0.18 * this.wingRouse) * (alive && !frozen ? 1 : 0.15);
      const flap = clamp(0.05 + Math.sin(this.wingPhase) * amp, -0.43, 0.52);
      for (const wing of this.wings) {
        tmpQ2.setFromAxisAngle(Z_AXIS, flap * (wing.userData.wingSide as number));
        wing.quaternion.copy(wing.userData.wingRest as THREE.Quaternion).multiply(tmpQ2);
      }
    }

    // Muzzle glows (on their sockets when rigged), the windup glow at the muzzle and cast flashes.
    this.updateMuzzles(w, dt, winding);

    // Hit flash / stun tint.
    const flash = saturate(w.hitFlash / W.hitFlashTime);
    // Flash strength fades with the timer so rapid hits flicker instead of pinning the model white.
    const f = flash * flash * 1.4;
    tmpColor.setRGB(f, f, f);
    if (frozen) {
      tmpColor.r += 0.05;
      tmpColor.g += 0.35;
      tmpColor.b += 0.6;
    }
    for (const m of this.tintMaterials) m.emissive.copy(tmpColor);

    // Shield bubble.
    const shieldOn = w.shielded;
    this.shieldScale = damp(this.shieldScale, shieldOn ? 1 : 0, shieldOn ? 30 : 18, dt);
    this.shield.visible = this.shieldScale > 0.02;
    if (this.shield.visible) {
      if (shieldOn && w.shieldAge < this.lastShieldAge) this.shieldHit = 0;
      this.lastShieldAge = w.shieldAge;
      const u = this.shield.material.uniforms;
      u.uTime.value = this.time;
      u.uPerfect.value = shieldOn && w.shieldAge <= CONFIG.spells.shield.perfectWindow ? 1 : 0;
      this.shieldHit = Math.max(0, this.shieldHit - dt * 4);
      u.uHit.value = this.shieldHit;
      u.uOpacity.value = this.shieldScale;
      const pop = 1 + Math.max(0, 0.15 - w.shieldAge) * 1.5;
      this.shield.scale.setScalar(this.shieldScale * pop);
      this.shield.position.y = w.shieldCenterY;
    }

    // The team ring stays on the ground under an airborne wizard (a landing marker), shrinking with height.
    this.ring.visible = alive;
    const ground = Math.min(y, w.grounded ? y : w.groundY);
    const lift = y - ground;
    this.ring.position.y = 0.03 - lift;
    this.ring.scale.setScalar(1 - 0.3 * saturate(lift / 1.5));
    (this.ring.material as THREE.MeshBasicMaterial).opacity = (0.35 + (w.invulnerable ? 0.4 : 0)) * (1 - 0.4 * saturate(lift / 1.5));
  }

  /** A hit: tip the body along its knockback (back, for a blow from the front), and crumple a little. */
  private flinch(w: Wizard, s: number, c: number): void {
    const kx = w.knock.x, kz = w.knock.z;
    const k = Math.hypot(kx, kz);
    let lx = 0, lz = -1;
    if (k > 0.3) {
      lx = (kx * c - kz * s) / k;
      lz = (kx * s + kz * c) / k;
    }
    const kick = 3.2 * this.proc.flinch;
    this.flinchXV += lz * kick;
    this.flinchZV -= lx * kick;
    this.stretchVel -= 0.9 * this.proc.flinch;
  }

  /** The springs (squash/stretch toward `restStretch`, flinch, lunge), in fixed sub-steps so long frames stay stable. */
  private springs(dt: number, restStretch: number): void {
    for (let left = dt; left > 1e-5; left -= 1 / 120) {
      const h = Math.min(left, 1 / 120);
      this.stretchVel += (-320 * (this.stretch - restStretch) - 16 * this.stretchVel) * h;
      this.stretch += this.stretchVel * h;
      this.flinchXV += (-160 * this.flinchX - 11 * this.flinchXV) * h;
      this.flinchX += this.flinchXV * h;
      this.flinchZV += (-160 * this.flinchZ - 11 * this.flinchZV) * h;
      this.flinchZ += this.flinchZV * h;
      this.lungeV += (-200 * this.lunge - 15 * this.lungeV) * h;
      this.lunge += this.lungeV * h;
    }
  }
}
