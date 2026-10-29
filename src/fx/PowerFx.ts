import * as THREE from 'three';
import { CONFIG } from '../config';
import { events } from '../core/events';
import { feel } from '../core/feel';
import type { BossPowers, Hazard } from '../spells/BossPowers';
import type { ProjectileSkins, SkinSlot, SkinTarget } from '../spells/ProjectileSkins';
import type { Wizard } from '../wizard/Wizard';
import type { Effects } from './Effects';
import { glowTexture } from './textures';

const P = CONFIG.powers;

/**
 * A telegraph on the floor. Modes: 0 a circle that fills from its centre as the warning runs out
 * (blinking near the end); 1 a reticle still following its target (crosshair, turning ticks); 2 a
 * sector (the cone, the sweep's arc) that fills outward; 3 a toxic pool (a standing cloud).
 */
const DECAL_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const DECAL_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uFill;
  uniform float uTime;
  uniform float uAlpha;
  uniform float uHalf;
  uniform float uSoft;
  uniform int uMode;
  varying vec2 vUv;
  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    if (r > 1.0) discard;
    float w = fwidth(r) * 1.5;
    // shade: the area it covers (darkened, so it reads on bright floors); glow: its lit lines and fill.
    float shade = 0.0, glow = 0.0;
    if (uMode == 2) {
      // Sector about +Y of the plane (the mesh is turned to the heading).
      float ang = abs(atan(p.x, p.y));
      float inside = 1.0 - smoothstep(uHalf - 0.01, uHalf + 0.01, ang);
      float edge = smoothstep(0.035, 0.0, abs(ang - uHalf) * r) * step(0.05, r);
      float rim = smoothstep(w + 0.02, 0.0, abs(r - 0.985));
      float fill = (1.0 - smoothstep(uFill - 0.02, uFill, r)) * 0.55 * uSoft;
      shade = inside * uSoft;
      glow = inside * (fill + rim * 0.8) + edge * 0.9;
    } else if (uMode == 1) {
      // A reticle: ring, crosshair, turning ticks.
      float ring = smoothstep(w + 0.03, 0.0, abs(r - 0.92));
      float cross = (smoothstep(0.025, 0.0, abs(p.x)) + smoothstep(0.025, 0.0, abs(p.y))) * step(0.25, r) * step(r, 0.8);
      float ang = atan(p.y, p.x) + uTime * 2.5;
      float ticks = step(0.75, fract(ang / 6.28318 * 8.0)) * smoothstep(0.08, 0.0, abs(r - 0.78));
      shade = 0.4;
      glow = ring * 0.9 + cross * 0.7 + ticks * 0.8;
    } else if (uMode == 3) {
      // A standing toxic pool: churning, brighter at its edge.
      float n = sin(p.x * 7.0 + uTime * 1.7) * sin(p.y * 6.0 - uTime * 1.3) * 0.5 + 0.5;
      float rim = smoothstep(w + 0.05, 0.0, abs(r - 0.96));
      shade = 1.0 - smoothstep(0.85, 1.0, r);
      glow = (0.15 + 0.25 * n) * shade + rim * 0.7;
    } else {
      // A circle filling from its centre; the rim blinks as it is about to hit.
      float rim = smoothstep(w + 0.03, 0.0, abs(r - 0.97));
      float fill = (1.0 - smoothstep(uFill - 0.025, uFill, r)) * 0.6;
      float blink = uFill > 0.75 ? 0.55 + 0.45 * step(0.5, fract(uTime * 9.0)) : 1.0;
      shade = 1.0;
      glow = fill + rim * 0.95 * blink;
    }
    float a = clamp(shade * 0.32 + glow, 0.0, 0.95) * uAlpha;
    vec3 col = mix(uColor * 0.08, uColor * 1.25, clamp(glow / (shade * 0.32 + glow + 1e-3), 0.0, 1.0));
    gl_FragColor = vec4(col, a);
  }
`;

/** A shockwave rolling along the floor: a low band, bright at the bottom, fading up. */
const BAND_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAlpha;
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    float up = 1.0 - vUv.y;
    float flicker = 0.85 + 0.15 * sin(vUv.x * 80.0 + uTime * 20.0);
    float a = pow(up, 1.6) * uAlpha * flicker;
    gl_FragColor = vec4(uColor * (1.0 + up) * a, a);
  }
`;

interface Vis {
  hazard: Hazard | null;
  decal: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | null;
  band: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial> | null;
  beam: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial> | null;
  glow: THREE.Sprite | null;
  prop: FxProp | null;
  stamp: number;
}

/** A boss's own projectile look used as a falling or homing object (an instance in its skin batch). */
class FxProp implements SkinTarget {
  kind: 'bolt' | 'blast' = 'bolt';
  readonly group = new THREE.Object3D();
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3(0, -1, 0);
  radius = 0.16;
  caster: Wizard = null!;
  color = 0xffffff;
  age = 0;
  slot: SkinSlot | null = null;
}

const tmpColor = new THREE.Color();
const tmpA = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const TOXIC = new THREE.Color(0x7dff5a);
const SMOKE = new THREE.Color(0x6f8f5a);
const FLASH = new THREE.Color(0xffffff);
/** Telegraphs lean toward this warning red, whatever the boss's colours. */
const DANGER = new THREE.Color(0xff2a14);

/**
 * What boss special powers look like (src/spells/BossPowers.ts): every hazard's telegraph on the
 * floor (filling circles, following reticles, the cone's and the sweep's sectors, a pulse where
 * rings will start), shockwave bands, the sweep's beam, objects falling into their circles, homing
 * seekers with a glow and a trail, a toxic pool; and bursts as each piece fires. Pooled meshes in the
 * boss's colours, built at start (compiled by the fight's warm-up). Render time: pausing freezes it.
 */
export class PowerFx {
  private readonly decals: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>[] = [];
  private readonly bands: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>[] = [];
  private readonly beams: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>[] = [];
  private readonly glows: THREE.Sprite[] = [];
  private readonly props: FxProp[] = [];
  private readonly vis = new Map<number, Vis>();
  private readonly spare: Vis[] = [];
  private time = 0;
  private stamp = 0;

  constructor(scene: THREE.Scene, private readonly fx: Effects, private readonly skins: ProjectileSkins, private readonly player: () => Wizard) {
    const plane = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    for (let i = 0; i < 28; i++) {
      const m = new THREE.Mesh(plane, new THREE.ShaderMaterial({
        vertexShader: DECAL_VERT, fragmentShader: DECAL_FRAG,
        uniforms: { uColor: { value: new THREE.Color() }, uFill: { value: 0 }, uTime: { value: 0 }, uAlpha: { value: 1 }, uHalf: { value: 0.5 }, uSoft: { value: 1 }, uMode: { value: 0 } },
        transparent: true, depthWrite: false, toneMapped: false,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      }));
      m.visible = false;
      m.renderOrder = 8;
      m.frustumCulled = false;
      m.name = 'power:decal';
      scene.add(m);
      this.decals.push(m);
    }
    const band = new THREE.CylinderGeometry(1, 1, 1, 72, 1, true).translate(0, 0.5, 0);
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(band, new THREE.ShaderMaterial({
        vertexShader: DECAL_VERT, fragmentShader: BAND_FRAG,
        uniforms: { uColor: { value: new THREE.Color() }, uAlpha: { value: 1 }, uTime: { value: 0 } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
      }));
      m.visible = false;
      m.renderOrder = 12;
      m.frustumCulled = false;
      m.name = 'power:ring';
      scene.add(m);
      this.bands.push(m);
    }
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5);
    for (let i = 0; i < 2; i++) {
      const m = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      m.visible = false;
      m.renderOrder = 12;
      m.frustumCulled = false;
      m.name = 'power:beam';
      scene.add(m);
      this.beams.push(m);
    }
    const tex = glowTexture();
    for (let i = 0; i < 10; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
      s.visible = false;
      s.renderOrder = 11;
      s.name = 'power:glow';
      scene.add(s);
      this.glows.push(s);
    }
    events.on('bossPower', (e) => this.burst(e.wizard, e.power.kind, e.phase, e.pos, e.hazard));
  }

  /** Per render frame, after the sim: draw every hazard in play. */
  update(dt: number, powers: BossPowers): void {
    this.time += dt;
    const stamp = ++this.stamp;
    for (const h of powers.hazards) {
      if (!h.active || h.delay > 0) continue;
      let v = this.vis.get(h.id);
      if (!v) {
        v = this.spare.pop() ?? { hazard: null, decal: null, band: null, beam: null, glow: null, prop: null, stamp: 0 };
        v.hazard = h;
        this.vis.set(h.id, v);
      }
      v.stamp = stamp;
      this.draw(h, v, dt);
    }
    for (const [id, v] of this.vis) {
      if (v.stamp === stamp) continue;
      this.drop(v);
      this.vis.delete(id);
    }
  }

  private draw(h: Hazard, v: Vis, dt: number): void {
    const team = h.owner.team;
    switch (h.kind) {
      case 'zone':
      case 'flash':
      case 'cloud': {
        const d = (v.decal ??= this.takeDecal());
        if (!d) return;
        const u = d.material.uniforms;
        const tracking = h.track > 0;
        const cloud = h.kind === 'cloud' && h.fired;
        u.uMode.value = cloud ? 3 : tracking ? 1 : 0;
        u.uFill.value = tracking ? 0 : 1 - h.warn / Math.max(1e-3, h.warnTotal);
        u.uTime.value = this.time;
        u.uColor.value.setHex(h.kind === 'cloud' ? 0x6fe03a : h.kind === 'flash' ? 0xfff2c0 : tracking ? 0xff3030 : team.blast);
        if (h.kind === 'zone' && !tracking) u.uColor.value.lerp(DANGER, 0.7);
        // A fired zone fades out with its burst; a cloud stands until it thins out at the end.
        u.uAlpha.value = h.fired ? (cloud ? Math.min(1, (h.life - h.t) / 0.6, h.t / 0.3) : Math.max(0, h.linger / 0.4) * 0.6) : 1;
        d.position.set(h.at.x, 0.05, h.at.z);
        d.scale.set(h.radius, 1, h.radius);
        d.rotation.y = 0;
        if (cloud) this.cloudSmoke(h, dt);
        // Something falls into it during the last moment of its warning.
        const skin = h.power.skin;
        if (skin && h.kind !== 'cloud' && !tracking && !h.fired && h.warn < P.fallTime) {
          const p = (v.prop ??= this.takeProp(h, skin, h.kind === 'flash' ? 1.4 : 1.6));
          if (p) {
            const k = 1 - h.warn / P.fallTime;
            p.pos.set(h.at.x, 0.3 + P.fallHeight * (1 - k * k), h.at.z);
            p.group.position.copy(p.pos);
            p.vel.set(0.15, -1, 0.1);
            p.age += dt;
          }
        } else if (v.prop) {
          this.dropProp(v.prop);
          v.prop = null;
        }
        break;
      }
      case 'cone':
      case 'sweep': {
        const d = (v.decal ??= this.takeDecal());
        if (!d) return;
        const u = d.material.uniforms;
        u.uMode.value = 2;
        u.uTime.value = this.time;
        u.uColor.value.setHex(team.blast).lerp(DANGER, 0.7);
        const sweep = h.kind === 'sweep';
        u.uHalf.value = Math.min(Math.PI - 0.01, h.arc / 2);
        // The cone fills in; the sweep's wide arc stays faint (its beam is the warning).
        u.uSoft.value = sweep ? 0.25 : 1;
        u.uFill.value = h.fired ? 1 : 1 - h.warn / Math.max(1e-3, h.warnTotal);
        u.uAlpha.value = h.fired ? (sweep ? 0.35 : Math.max(0, h.linger / 0.5)) : 1;
        d.position.set(h.at.x, 0.05, h.at.z);
        d.scale.set(h.radius, 1, h.radius);
        // The sector's middle is the plane's +Y, which lies along -Z once flat: turn it half round.
        d.rotation.y = (sweep ? h.start + (h.dir * h.arc) / 2 : h.angle) + Math.PI;
        if (sweep) {
          const b = (v.beam ??= this.takeBeam());
          if (b) {
            const live = h.fired;
            b.position.set(h.at.x, live ? P.sweepHeight * 0.5 : 0.08, h.at.z);
            b.rotation.set(0, h.angle, 0);
            b.scale.set(live ? 0.32 : 0.2, live ? P.sweepHeight : 0.1, h.radius);
            b.material.color.setHex(team.blast).multiplyScalar(live ? 2.2 : 2);
            b.material.opacity = live ? 0.9 : 0.6 + 0.4 * Math.sin(this.time * 18);
            if (live && Math.random() < 0.8) {
              // Sparks along the beam.
              const r = Math.random() * h.radius;
              tmpColor.setHex(team.blast);
              this.fx.sparks.emit(h.at.x + Math.sin(h.angle) * r, 0.3, h.at.z + Math.cos(h.angle) * r, 0, 1.5 + Math.random() * 2, 0, tmpColor, 2, 0.12, 0.3, { gravity: 6 });
            }
          }
        }
        break;
      }
      case 'ring': {
        if (!h.fired) {
          // Where it will start: a pulsing circle round the boss.
          const d = (v.decal ??= this.takeDecal());
          if (!d) return;
          const u = d.material.uniforms;
          u.uMode.value = 0;
          u.uTime.value = this.time;
          u.uFill.value = 1 - h.warn / Math.max(1e-3, h.warnTotal);
          u.uAlpha.value = h.index === 0 ? 1 : 0.5;
          u.uColor.value.setHex(team.ultimate).lerp(DANGER, 0.5);
          d.position.set(h.at.x, 0.05, h.at.z);
          d.scale.setScalar(1.6 + 0.6 * h.index);
          break;
        }
        if (v.decal) {
          this.dropDecal(v.decal);
          v.decal = null;
        }
        const b = (v.band ??= this.takeBand());
        if (!b) return;
        b.position.set(h.at.x, 0, h.at.z);
        b.scale.set(Math.max(0.2, h.radius), P.ringHeight, Math.max(0.2, h.radius));
        const u = b.material.uniforms;
        u.uColor.value.setHex(team.ultimate).multiplyScalar(1.3);
        u.uAlpha.value = 1 - Math.pow(h.radius / h.life, 3);
        u.uTime.value = this.time;
        break;
      }
      case 'seeker': {
        const p = (v.prop ??= this.takeProp(h, h.power.skin ?? 'hellfire', 1.5));
        if (p) {
          p.pos.copy(h.at);
          p.group.position.copy(h.at);
          p.vel.copy(h.vel);
          p.age += dt;
        }
        const g = (v.glow ??= this.takeGlow());
        if (g) {
          g.position.copy(h.at);
          g.material.color.setHex(team.spell).multiplyScalar(1.6);
          g.scale.setScalar(0.9 + 0.15 * Math.sin(this.time * 14 + h.id));
        }
        this.fx.trail(h.at, team.spell, 0.22, 1);
        break;
      }
    }
  }

  private cloudSmoke(h: Hazard, dt: number): void {
    const n = Math.round(14 * dt * h.radius + Math.random() * 0.6);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * h.radius * 0.9;
      this.fx.smoke.emit(h.at.x + Math.sin(a) * r, 0.2, h.at.z + Math.cos(a) * r, 0, 0.5 + Math.random() * 0.6, 0,
        Math.random() < 0.5 ? TOXIC : SMOKE, 0.55, 0.8, 1.6, { drag: 0.6, gravity: -0.3, sizeEnd: 2.2 });
    }
  }

  /** Bursts as a piece of a power fires (zones land, cones blast, seekers launch and pop, flashbangs). */
  private burst(w: Wizard, kind: string, phase: string, pos: THREE.Vector3, id: number): void {
    const team = w.team;
    if (phase === 'end' && kind === 'seekers') {
      this.fx.explosion(pos, team.spell, 1.2);
      return;
    }
    if (phase !== 'fire') return;
    switch (kind) {
      case 'strike':
      case 'barrage': {
        const h = this.vis.get(id)?.hazard;
        const r = h?.radius ?? 2;
        tmpA.set(pos.x, 0.4, pos.z);
        this.fx.explosion(tmpA, team.blast, r * (kind === 'barrage' ? 0.7 : 1));
        this.fx.dust(tmpA, 4, r * 0.6);
        // One strike lights up the floor; a barrage's many drops don't (they would white out the view).
        if (kind === 'strike') this.fx.light(tmpA.setY(1), team.blast, 6, 0.2);
        feel.shakeAt(tmpA, kind === 'strike' ? 0.3 : 0.15);
        break;
      }
      case 'march': {
        // An eruption: a column of fire and sparks out of the floor.
        tmpColor.setHex(team.blast);
        for (let i = 0; i < 26; i++) {
          this.fx.sparks.emit(pos.x + (Math.random() - 0.5) * 1.2, 0.2, pos.z + (Math.random() - 0.5) * 1.2,
            (Math.random() - 0.5) * 2, 7 + Math.random() * 7, (Math.random() - 0.5) * 2, tmpColor, 2.4, 0.2, 0.55, { gravity: 10, drag: 0.6 });
        }
        this.fx.flash(tmpA.set(pos.x, 1.2, pos.z), team.blast, 3, 0.18);
        this.fx.dust(tmpA.set(pos.x, 0.2, pos.z), 2, 0.8);
        break;
      }
      case 'flash': {
        tmpA.set(pos.x, 0.8, pos.z);
        this.fx.flash(tmpA, 0xffffff, 9, 0.35);
        this.fx.light(tmpA, 0xffffff, 30, 0.3);
        this.fx.sparks.burst(tmpA, 40, FLASH, 3, 4, 12, 0.12, 0.4, { drag: 3 });
        if (this.player().stunned) feel.screenFlash(0xffffff, 0.6);
        break;
      }
      case 'cloud':
        tmpA.set(pos.x, 0.5, pos.z);
        this.fx.smoke.burst(tmpA, 24, TOXIC, 0.6, 1, 4, 1.2, 1.4, { drag: 2, gravity: -0.4, sizeEnd: 2.4 });
        break;
      case 'cone': {
        const h = this.vis.get(id)?.hazard;
        if (!h) break;
        tmpColor.setHex(team.spell);
        for (let i = 0; i < 70; i++) {
          const a = h.angle + (Math.random() - 0.5) * h.arc;
          const sp = 10 + Math.random() * 12;
          this.fx.sparks.emit(pos.x + Math.sin(a) * 0.8, 1.2, pos.z + Math.cos(a) * 0.8, Math.sin(a) * sp, Math.random() * 2, Math.cos(a) * sp,
            tmpColor, 2, 0.25, 0.55 + Math.random() * 0.2, { drag: 1.5 });
        }
        for (let i = 0; i < 18; i++) {
          const a = h.angle + (Math.random() - 0.5) * h.arc;
          const sp = 6 + Math.random() * 6;
          this.fx.smoke.emit(pos.x, 1.2, pos.z, Math.sin(a) * sp, Math.random(), Math.cos(a) * sp, tmpColor, 0.7, 0.7, 1, { drag: 2, sizeEnd: 2.4 });
        }
        break;
      }
      case 'rings':
        this.fx.dust(tmpA.set(pos.x, 0.2, pos.z), 5, 1.2);
        feel.shakeAt(tmpA, 0.3);
        break;
      case 'seekers':
        this.fx.muzzle(pos, UP, team.spell, 1);
        break;
    }
  }

  // ------------------------------------------------------------------ pools

  private takeDecal() {
    const d = this.decals.find((m) => !m.visible) ?? null;
    if (d) d.visible = true;
    return d;
  }

  private dropDecal(d: THREE.Mesh) {
    d.visible = false;
  }

  private takeBand() {
    const b = this.bands.find((m) => !m.visible) ?? null;
    if (b) b.visible = true;
    return b;
  }

  private takeBeam() {
    const b = this.beams.find((m) => !m.visible) ?? null;
    if (b) b.visible = true;
    return b;
  }

  private takeGlow() {
    const g = this.glows.find((m) => !m.visible) ?? null;
    if (g) g.visible = true;
    return g;
  }

  private takeProp(h: Hazard, skin: NonNullable<Hazard['power']['skin']>, scale: number): FxProp | null {
    const p = this.props.pop() ?? new FxProp();
    p.kind = 'bolt';
    p.radius = CONFIG.spells.bolt.radius * scale;
    p.caster = h.owner;
    p.color = h.owner.team.spell;
    p.age = Math.random() * 3;
    p.pos.copy(h.at);
    p.group.position.copy(h.at);
    p.slot = this.skins.acquire(skin, h.owner.index, p);
    if (!p.slot) {
      this.props.push(p);
      return null;
    }
    return p;
  }

  private dropProp(p: FxProp): void {
    if (p.slot) this.skins.release(p.slot);
    p.slot = null;
    this.props.push(p);
  }

  private drop(v: Vis): void {
    if (v.decal) this.dropDecal(v.decal);
    if (v.band) v.band.visible = false;
    if (v.beam) v.beam.visible = false;
    if (v.glow) v.glow.visible = false;
    if (v.prop) this.dropProp(v.prop);
    v.decal = v.band = v.beam = v.glow = v.prop = null;
    v.hazard = null;
    this.spare.push(v);
  }

  /** Everything off (a round reset). */
  clear(): void {
    for (const v of this.vis.values()) this.drop(v);
    this.vis.clear();
  }
}
