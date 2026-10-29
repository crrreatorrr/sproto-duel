import * as THREE from 'three';
import { CONFIG, type TeamPalette } from '../config';
import type { ProjectileSkin } from '../campaign/levels';
import { events } from '../core/events';
import type { Effects } from '../fx/Effects';
import type { Wizard } from '../wizard/Wizard';
import { SKIN_LOOKS as DEFS, type ObjectSkin } from './skinLooks';

export { OBJECT_SKINS } from './skinLooks';

/**
 * Boss projectile looks: rolled rugs, flying carpets, phones, pigs, broccoli, bullets, grenades,
 * hellfire and burning skulls instead of the spell orb.
 *
 * Every object is a low-poly mesh built in code with a canvas-painted texture atlas in the
 * caster's palette (the looks themselves are in skinLooks.ts). One skin in one wizard's palette
 * is a `SkinBatch`: an InstancedMesh (plus an additive one for tracers and flames) holding every
 * live projectile with that look, so a whole volley of rugs costs one or two draw calls. Batches are created on first use (Game.setupEnemy
 * prepares the boss's two so their shaders compile on the boss card, not on the first throw)
 * and their instance slots are pooled. Nothing is allocated per frame or per throw.
 *
 * Purely visual: a projectile's hitbox is still its spell radius.
 */

const K = CONFIG.projectileSkins;
const SP = CONFIG.spells;

/** What a skin reads from its projectile (Projectile implements it). */
export interface SkinTarget {
  readonly kind: 'bolt' | 'blast';
  /** Render-time (interpolated) placement. */
  readonly group: THREE.Object3D;
  /** Simulation position (launch and trail effects). */
  readonly pos: THREE.Vector3;
  readonly vel: THREE.Vector3;
  readonly radius: number;
  readonly caster: Wizard;
  /** The current owner's spell colour: trails and glow switch to whoever reflected it. */
  readonly color: number;
  /** Seconds of tumble and flicker to pose at, instead of render time since launch (cinematic props, which spin through the freeze). */
  readonly age?: number;
}

// ------------------------------------------------------------- pose scratch

const tmpColor = new THREE.Color();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const tmpScale2 = new THREE.Vector3();
const tmpMat = new THREE.Matrix4();
const tmpDir = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const RUG_AXIS = new THREE.Vector3(1, 0.18, 0).normalize();
const FLORET_AXIS = new THREE.Vector3(1, 0.45, 0.25).normalize();
const BROCCOLI_AXIS = new THREE.Vector3(1, 0.2, 0.35).normalize();
const GRENADE_AXIS = new THREE.Vector3(1, 0, 0.22).normalize();
const PIG_AXIS = new THREE.Vector3(1, 0.3, 0.15).normalize();
const PIG_PUFF = new THREE.Color(0xffb3c8);
const SMOKE = new THREE.Color(0x3a2624);
const FUSE_SMOKE = new THREE.Color(0x77736e);

/** Built geometry per skin, shared by both teams' batches. */
const geometries: Partial<Record<ObjectSkin, { solid: THREE.BufferGeometry; aura: THREE.BufferGeometry | null }>> = {};

function geometryOf(skin: ObjectSkin) {
  let g = geometries[skin];
  if (!g) {
    const def = DEFS[skin];
    g = geometries[skin] = { solid: def.solid(def.atlas), aura: def.aura ? def.aura.geometry() : null };
  }
  return g;
}

/**
 * Additive glow parts (tracers, flames): the painted texture, brighter where the surface faces
 * the camera and fading toward its silhouette, so cones and crossed planes read as soft light.
 */
const AURA_VERT = /* glsl */ `
  varying vec2 vUv;
  varying float vFacing;
  void main() {
    vUv = uv;
    mat4 m = modelMatrix;
    #ifdef USE_INSTANCING
      m = modelMatrix * instanceMatrix;
    #endif
    vec4 wp = m * vec4(position, 1.0);
    vFacing = abs(dot(normalize(mat3(m) * normal), normalize(cameraPosition - wp.xyz)));
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const AURA_FRAG = /* glsl */ `
  uniform sampler2D map;
  uniform float uIntensity;
  uniform float uEdge;
  varying vec2 vUv;
  varying float vFacing;
  void main() {
    vec3 c = texture2D(map, vUv).rgb;
    gl_FragColor = vec4(c * uIntensity * mix(uEdge, 1.0, smoothstep(0.0, 0.7, vFacing)), 1.0);
  }
`;

/** Shared clock for the vertex-animated skins (carpet ripple, pig legs). */
const rippleTime = { value: 0 };
const RIPPLE = K.carpet;

/** Rippling cloth on the GPU: waves run from the front (+z) to the tail, growing toward the tail. */
function addRipple(mat: THREE.MeshStandardMaterial): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = rippleTime;
    shader.uniforms.uRipple = { value: new THREE.Vector3(RIPPLE.rippleAmp, (Math.PI * 2) / RIPPLE.rippleLength, RIPPLE.rippleSpeed) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec3 uRipple;\nattribute float aPhase;')
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        float rw = position.z * uRipple.y + uTime * uRipple.z + aPhase;
        float tail = 0.35 + 0.65 * (1.0 - smoothstep(-0.8, 0.8, position.z));
        objectNormal.z -= cos(rw) * uRipple.x * uRipple.y * tail * objectNormal.y;`,
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.y += sin(rw) * uRipple.x * tail;');
  };
  mat.customProgramCacheKey = () => 'carpetRipple';
}

const FLAIL = K.pig;

/** Pig limbs on the GPU: each leg swings about its hip out of step with the others; the tail wags. */
function addFlail(mat: THREE.MeshStandardMaterial): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = rippleTime;
    shader.uniforms.uFlail = { value: new THREE.Vector2(FLAIL.flailSpeed, FLAIL.flailAngle) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec2 uFlail;\nattribute float aPhase;\nattribute float aLimb;\nattribute vec3 aPivot;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        if (aLimb > 0.5) {
          float a = sin(uTime * uFlail.x + aLimb * 1.9 + aPhase) * uFlail.y;
          float c = cos(a), s = sin(a);
          vec3 q = transformed - aPivot;
          q = aLimb > 4.5 ? vec3(q.x * c + q.z * s, q.y, -q.x * s + q.z * c) : vec3(q.x, q.y * c - q.z * s, q.y * s + q.z * c);
          transformed = q + aPivot;
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'pigFlail';
}

function canvas(w: number, h = w): CanvasRenderingContext2D {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c.getContext('2d')!;
}

function canvasTexture(g: CanvasRenderingContext2D): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(g.canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// --------------------------------------------------------------------- pooling

/** One live projectile's instance in a batch. */
export class SkinSlot {
  target: SkinTarget | null = null;
  /** Random phase so identical objects don't spin in lockstep. */
  phase = 0;
  /** Render time at launch. */
  born = 0;
  /** Last aim (kept while the projectile is momentarily still). */
  yaw = 0;
  pitch = 0;

  constructor(readonly skin: ObjectSkin, readonly team: number, readonly batch: SkinBatch) {}
}

/** Every live projectile with one skin in one team's palette: one instanced draw (two with an aura). */
class SkinBatch {
  readonly solid: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  readonly aura: THREE.InstancedMesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null = null;
  readonly active: SkinSlot[] = [];
  private readonly free: SkinSlot[] = [];
  private readonly colorAtlas: CanvasRenderingContext2D;
  private readonly glowAtlas: CanvasRenderingContext2D;
  private readonly auraAtlas: CanvasRenderingContext2D | null = null;
  private readonly textures: THREE.CanvasTexture[] = [];
  /** Own geometry copy (vertex-animated skins: carries the per-instance phase), else the shared one. */
  private readonly ownGeometry: THREE.BufferGeometry | null = null;
  private readonly phases: THREE.InstancedBufferAttribute | null = null;
  /** Frames to stay drawn while empty, so the shaders compile before the first throw. */
  private warm = 2;

  constructor(readonly skin: ObjectSkin, readonly team: number, palette: TeamPalette, scene: THREE.Scene, capacity: number) {
    const def = DEFS[skin];
    const geo = geometryOf(skin);
    this.colorAtlas = canvas(def.atlas);
    this.glowAtlas = canvas(def.atlas);
    const map = canvasTexture(this.colorAtlas);
    const emissiveMap = canvasTexture(this.glowAtlas);
    this.textures.push(map, emissiveMap);
    const mat = new THREE.MeshStandardMaterial({
      map, emissiveMap, emissive: 0xffffff, emissiveIntensity: def.emissive, roughness: def.roughness, metalness: 0,
      side: def.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    });
    let solidGeo = geo.solid;
    if (def.shader) {
      if (def.shader === 'ripple') addRipple(mat);
      else addFlail(mat);
      solidGeo = this.ownGeometry = geo.solid.clone();
      this.phases = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
      solidGeo.setAttribute('aPhase', this.phases);
    }
    this.solid = this.instanced(solidGeo, mat, capacity, scene);

    if (def.aura && geo.aura) {
      this.auraAtlas = canvas(def.aura.w, def.aura.h);
      const tex = canvasTexture(this.auraAtlas);
      this.textures.push(tex);
      const auraMat = new THREE.ShaderMaterial({
        vertexShader: AURA_VERT,
        fragmentShader: AURA_FRAG,
        uniforms: { map: { value: tex }, uIntensity: { value: def.aura.intensity }, uEdge: { value: def.aura.edge } },
        blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      });
      this.aura = this.instanced(geo.aura, auraMat, capacity, scene);
      this.aura.renderOrder = 6;
    }
    for (let i = 0; i < capacity; i++) this.free.push(new SkinSlot(skin, team, this));
    this.paint(palette);
  }

  private instanced<M extends THREE.Material>(geo: THREE.BufferGeometry, mat: M, capacity: number, scene: THREE.Scene) {
    const mesh = new THREE.InstancedMesh(geo, mat, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; // instances move every frame; the bounds would go stale
    mesh.count = 0;
    mesh.name = `skin:${this.skin}:${this.team}`;
    scene.add(mesh);
    return mesh;
  }

  /** (Re)paint the atlases in a palette. Live instances change colour too. */
  paint(pal: TeamPalette): void {
    const def = DEFS[this.skin];
    const n = def.atlas;
    const c = this.colorAtlas, gl = this.glowAtlas;
    c.clearRect(0, 0, n, n);
    def.paint(c, n, pal);
    gl.globalAlpha = 1;
    gl.fillStyle = '#000';
    gl.fillRect(0, 0, n, n);
    gl.globalAlpha = def.baseGlow;
    gl.drawImage(c.canvas, 0, 0);
    gl.globalAlpha = 1;
    def.glow?.(gl, n, pal);
    if (this.auraAtlas && def.aura) def.aura.paint(this.auraAtlas, def.aura.w, pal);
    for (const t of this.textures) t.needsUpdate = true;
  }

  take(target: SkinTarget, born: number): SkinSlot | null {
    const s = this.free.pop();
    if (!s) return null;
    s.target = target;
    s.born = born;
    s.phase = Math.random() * Math.PI * 2;
    s.yaw = Math.atan2(target.vel.x, target.vel.z);
    s.pitch = 0;
    this.active.push(s);
    return s;
  }

  give(s: SkinSlot): void {
    const i = this.active.indexOf(s);
    if (i < 0) return;
    this.active[i] = this.active[this.active.length - 1];
    this.active.pop();
    s.target = null;
    this.free.push(s);
  }

  /** Write every live instance's transform (dense, 0..n-1) and show/hide the meshes. */
  sync(time: number): void {
    const n = this.active.length;
    const show = n > 0 || this.warm > 0;
    if (n === 0 && this.warm > 0) this.warm--;
    this.solid.visible = show;
    this.solid.count = n;
    if (this.aura) {
      this.aura.visible = show;
      this.aura.count = n;
    }
    if (n === 0) return;
    for (let i = 0; i < n; i++) {
      const s = this.active[i];
      pose(s, s.target!.age ?? time - s.born);
      this.solid.setMatrixAt(i, poseSolid);
      if (this.aura) this.aura.setMatrixAt(i, poseAura);
      if (this.phases) this.phases.setX(i, s.phase);
    }
    const flag = (attr: THREE.BufferAttribute, items: number) => {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, items);
      attr.needsUpdate = true;
    };
    flag(this.solid.instanceMatrix, n * 16);
    if (this.aura) flag(this.aura.instanceMatrix, n * 16);
    if (this.phases) flag(this.phases, n);
  }

  get idle(): boolean {
    return this.active.length === 0;
  }

  dispose(): void {
    for (const m of [this.solid, this.aura]) {
      if (!m) continue;
      m.removeFromParent();
      m.material.dispose();
      m.dispose();
    }
    for (const t of this.textures) t.dispose();
    this.ownGeometry?.dispose();
  }
}

/** Pose outputs for the slot being written (module scratch, no allocation). */
const poseSolid = new THREE.Matrix4();
const poseAura = new THREE.Matrix4();

/** Orientation, tumble, wobble and flicker of one object at `age` seconds after launch. */
function pose(s: SkinSlot, age: number): void {
  const t = s.target!;
  const v = t.vel;
  const h = Math.hypot(v.x, v.z);
  const speed = Math.hypot(h, v.y);
  if (speed > 0.05) {
    s.yaw = Math.atan2(v.x, v.z);
    s.pitch = -Math.atan2(v.y, h);
  }
  const scale = t.radius / SP[t.kind].radius;
  tmpPos.copy(t.group.position);
  tmpScale.setScalar(scale);
  tmpScale2.setScalar(scale);
  const ph = s.phase;
  let auraQ: THREE.Quaternion | null = null;

  switch (s.skin) {
    case 'carpet': {
      // Flying flat but riding its front edge up, so an incoming carpet shows its face to its
      // target instead of a thin edge, swinging through gentle banks.
      tmpEuler.set(THREE.MathUtils.clamp(s.pitch * 0.6, -0.4, 0.4) - RIPPLE.noseUp, s.yaw, Math.sin(age * 2.4 + ph) * RIPPLE.bank, 'YXZ');
      tmpQ.setFromEuler(tmpEuler);
      tmpPos.y += Math.sin(age * 5 + ph) * 0.05 * scale;
      break;
    }
    case 'skull': {
      // Faces its target, weaving a little; the flames stay attached.
      tmpEuler.set(s.pitch + Math.sin(age * 4.1 + ph) * 0.12, s.yaw + Math.sin(age * 3.3 + ph) * 0.22, Math.sin(age * 2.7 + ph) * 0.15, 'YXZ');
      tmpQ.setFromEuler(tmpEuler);
      auraQ = tmpQ;
      flicker(age, ph, scale);
      break;
    }
    default: {
      tmpEuler.set(s.pitch, s.yaw, 0, 'YXZ');
      tmpQ.setFromEuler(tmpEuler);
      auraQ = tmpQ2.copy(tmpQ);
      switch (s.skin) {
        case 'rugRoll':
          tmpQ.multiply(tmpQ2.setFromAxisAngle(RUG_AXIS, age * K.spin.rugRoll + ph));
          auraQ = null;
          break;
        case 'phone':
          // Upright, leaning, spinning about its long axis: the lit screen flashes round.
          tmpQ.multiply(tmpQ2.setFromAxisAngle(Z_AXIS, 0.35)).multiply(tmpQ2.setFromAxisAngle(Y_AXIS, age * K.spin.phone + ph));
          auraQ = null;
          break;
        case 'floret':
          tmpQ.multiply(tmpQ2.setFromAxisAngle(FLORET_AXIS, age * K.spin.floret + ph));
          auraQ = null;
          break;
        case 'broccoli':
          tmpQ.multiply(tmpQ2.setFromAxisAngle(BROCCOLI_AXIS, age * K.spin.broccoli + ph));
          auraQ = null;
          break;
        case 'grenade':
          tmpQ.multiply(tmpQ2.setFromAxisAngle(GRENADE_AXIS, age * K.spin.grenade + ph));
          auraQ = null;
          break;
        case 'pig':
          tmpQ.multiply(tmpQ2.setFromAxisAngle(PIG_AXIS, age * K.spin.pig + ph));
          auraQ = null;
          break;
        case 'bullet':
          // The streak stretches with speed (a reflected round streaks longer).
          tmpScale2.z = Math.min(K.tracerMax, speed * K.tracerPerSpeed);
          break;
        case 'hellfire':
          tmpQ.multiply(tmpQ2.setFromAxisAngle(Z_AXIS, age * 5 + ph));
          auraQ = tmpQ2.setFromEuler(tmpEuler);
          flicker(age, ph, scale);
          break;
      }
    }
  }
  poseSolid.compose(tmpPos, tmpQ, tmpScale);
  if (auraQ) poseAura.compose(tmpPos, auraQ, tmpScale2);
}

/** Flame flicker on the aura scale. */
function flicker(age: number, ph: number, scale: number): void {
  const a = 1 + Math.sin(age * 31 + ph) * 0.1 + Math.sin(age * 17 + ph * 2) * 0.06;
  tmpScale2.set(scale * a, scale * a, scale * (1 + Math.sin(age * 23 + ph * 3) * 0.18));
}

/**
 * The object looks of every team, created on first use. Projectiles `acquire` a slot at launch
 * and `release` it when they end; `sync` writes all instance transforms once per frame.
 */
export class ProjectileSkins {
  /** Per wizard index (any number of wizards): its batches by skin. */
  private readonly batches: Partial<Record<ProjectileSkin, SkinBatch>>[] = [];
  /** The same batches as a flat list, for allocation-free per-frame iteration. */
  private readonly list: SkinBatch[] = [];
  private readonly palettes: TeamPalette[] = [...CONFIG.teams];
  private time = 0;
  /** Real seconds of transformation cinematics so far: a carpet prop's ripple runs on through the freeze. */
  cineTime = 0;

  constructor(private readonly scene: THREE.Scene, private readonly fx: Effects | null) {}

  /**
   * Make sure a team's batches for `skins` exist (their shaders compile on the next frame, before
   * anyone throws) and free that team's idle batches for skins it no longer uses.
   */
  prepare(team: number, skins: readonly ProjectileSkin[]): void {
    const own = this.teamBatches(team);
    for (const key of Object.keys(own) as ProjectileSkin[]) {
      const b = own[key]!;
      if (!skins.includes(key) && b.idle) {
        b.dispose();
        delete own[key];
        this.list.splice(this.list.indexOf(b), 1);
      }
    }
    for (const skin of skins) if (skin !== 'orb') this.batch(skin, team);
  }

  /** Repaint a team's objects in a new palette (campaign bosses). */
  setTeam(team: number, palette: TeamPalette): void {
    this.palettes[team] = palette;
    const own = this.teamBatches(team);
    for (const key of Object.keys(own) as ProjectileSkin[]) own[key]!.paint(palette);
  }

  /** An instance slot for `target` in `skin` drawn in `team`'s palette, or null if none is free. */
  acquire(skin: ObjectSkin, team: number, target: SkinTarget): SkinSlot | null {
    // A wizard index without a palette yet (an extra wizard) paints in its caster's colours.
    this.palettes[team] ??= target.caster.team;
    return this.batch(skin, team).take(target, this.time);
  }

  release(slot: SkinSlot): void {
    slot.batch.give(slot);
  }

  /** Launch cues at the caster: gunshot flash, grenade puff, and the `skinLaunch` event for audio. */
  launched(slot: SkinSlot, t: SkinTarget): void {
    const fx = this.fx;
    if (fx) {
      tmpDir.copy(t.vel).normalize();
      const pal = this.palettes[slot.team] ?? t.caster.team;
      if (slot.skin === 'bullet') {
        const M = K.muzzleFlash;
        fx.muzzleFlash(t.pos, tmpDir, pal.spell, M.size, M.light, M.duration);
      } else if (slot.skin === 'grenade') {
        fx.dust(t.pos, 4, 0.25);
      }
    }
    events.emit('skinLaunch', { wizard: t.caster, kind: t.kind, skin: slot.skin, pos: t.pos });
  }

  /** The projectile is gone (burst, clashed, swept away): the pig bursts in a little pink puff. */
  ended(slot: SkinSlot, t: SkinTarget): void {
    const fx = this.fx;
    if (!fx || slot.skin !== 'pig') return;
    const p = t.pos;
    for (let i = 0; i < 9; i++) {
      fx.smoke.emit(
        p.x + (Math.random() - 0.5) * 0.4, p.y + (Math.random() - 0.5) * 0.4, p.z + (Math.random() - 0.5) * 0.4,
        (Math.random() - 0.5) * 3, Math.random() * 2, (Math.random() - 0.5) * 3,
        PIG_PUFF, 0.75, 0.45, 0.6 + Math.random() * 0.3, { drag: 3, gravity: -0.6, sizeEnd: 1.5 },
      );
    }
    fx.sparks.burst(p, 14, PIG_PUFF, 2.2, 2, 6, 0.1, 0.4, { gravity: 5, drag: 2 });
  }

  /** Per-tick trail behind an object (the orb's own trail is in Projectile). */
  trail(slot: SkinSlot, t: SkinTarget): void {
    const fx = this.fx;
    if (!fx) return;
    const p = t.pos;
    const bolt = t.kind === 'bolt';
    const size = (bolt ? 0.22 : 0.5 * (t.radius / SP.blast.radius)) * K.trailScale;
    switch (slot.skin) {
      case 'bullet':
        fx.trail(p, t.color, 0.07, 1);
        return;
      case 'hellfire':
      case 'skull': {
        const big = slot.skin === 'skull' ? 1.6 : 1;
        fx.smoke.emit(
          p.x + (Math.random() - 0.5) * 0.15, p.y + (Math.random() - 0.5) * 0.15, p.z + (Math.random() - 0.5) * 0.15,
          (Math.random() - 0.5) * 0.6, 0.5 + Math.random() * 0.6, (Math.random() - 0.5) * 0.6,
          SMOKE, 0.2, 0.22 * big, 0.45 + Math.random() * 0.3, { drag: 2, gravity: -0.8, sizeEnd: 1.4 * big },
        );
        tmpColor.setHex(t.color);
        for (let i = 0; i < (bolt ? 1 : 3); i++) {
          fx.sparks.emit(p.x, p.y, p.z, (Math.random() - 0.5) * 2.5, 1 + Math.random() * 2, (Math.random() - 0.5) * 2.5,
            tmpColor, 2.6, 0.08 + Math.random() * 0.06, 0.35 + Math.random() * 0.25, { drag: 2, gravity: -1.5 });
        }
        return;
      }
      case 'grenade':
        fx.smoke.emit(p.x, p.y + 0.2, p.z, (Math.random() - 0.5) * 0.3, 0.6, (Math.random() - 0.5) * 0.3,
          FUSE_SMOKE, 0.5, 0.12, 0.4, { drag: 2, gravity: -0.5, sizeEnd: 0.45 });
        fx.trail(p, t.color, size, 1);
        return;
      case 'floret':
      case 'broccoli':
        fx.trail(p, t.color, size, bolt ? 1 : 2);
        if (Math.random() < (bolt ? 0.25 : 0.6)) {
          // Crumbs falling off.
          tmpColor.setHex(t.color).multiplyScalar(0.6);
          fx.sparks.emit(p.x, p.y, p.z, (Math.random() - 0.5) * 3, Math.random() * 2, (Math.random() - 0.5) * 3,
            tmpColor, 1.2, 0.07, 0.5, { gravity: 12, drag: 1 });
        }
        return;
      default:
        fx.trail(p, t.color, size, bolt ? 1 : 2);
    }
  }

  /** Glow sprite size multiplier for a skin (on top of CONFIG.projectileSkins.glowScale). */
  glowSize(skin: ObjectSkin): number {
    return DEFS[skin].glowSize;
  }

  /** Once per render frame, after projectiles placed their groups. */
  sync(time: number): void {
    this.time = time;
    rippleTime.value = time + this.cineTime;
    for (let i = 0; i < this.list.length; i++) this.list[i].sync(time);
  }

  /** Counts for QA and the perf overlay. */
  stats(): { batches: number; meshes: number; active: number; skins: string[] } {
    let batches = 0, meshes = 0, active = 0;
    const skins: string[] = [];
    this.batches.forEach((own, team) => {
      for (const key of Object.keys(own) as ProjectileSkin[]) {
        const b = own[key]!;
        batches++;
        meshes += b.aura ? 2 : 1;
        active += b.active.length;
        skins.push(`${key}:${team}`);
      }
    });
    return { batches, meshes, active, skins };
  }

  /** World position of a slot's instance as last synced (QA). */
  instancePosition(slot: SkinSlot, out: THREE.Vector3): THREE.Vector3 {
    const i = slot.batch.active.indexOf(slot);
    if (i < 0) return out.set(NaN, NaN, NaN);
    slot.batch.solid.getMatrixAt(i, tmpMat);
    return out.setFromMatrixPosition(tmpMat);
  }

  private teamBatches(team: number): Partial<Record<ProjectileSkin, SkinBatch>> {
    while (this.batches.length <= team) this.batches.push({});
    return this.batches[team];
  }

  private batch(skin: ObjectSkin, team: number): SkinBatch {
    const own = this.teamBatches(team);
    let b = own[skin];
    if (!b) {
      b = own[skin] = new SkinBatch(skin, team, this.palettes[team] ?? CONFIG.teams[team % CONFIG.teams.length], this.scene, K.batchCapacity);
      this.list.push(b);
    }
    return b;
  }
}
