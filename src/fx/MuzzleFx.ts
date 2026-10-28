import * as THREE from 'three';
import type { Wizard } from '../wizard/Wizard';
import type { CastKind } from '../wizard/muzzles';
import type { Effects } from './Effects';

/** Point lights shared by every muzzle (charging staffs, cast flashes): always present, so the light count never changes. */
const LIGHT_COUNT = 2;
/** Notification bubbles popping off phones, pooled. */
const BUBBLE_COUNT = 18;
const LIGHT_INTENSITY = 3;
/** The light sits this far (m, times the look's scale) in front of the muzzle, so it lights the prop and the floor, not the robe it touches. */
const LIGHT_AHEAD = 0.35;

interface Bubble {
  sprite: THREE.Sprite;
  active: boolean;
  t: number;
  life: number;
  size: number;
  readonly vel: THREE.Vector3;
}

const tmpColor = new THREE.Color();
const tmpColor2 = new THREE.Color();
const tmpSide = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const tmpPos = new THREE.Vector3();
const tmpOrigin = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const WHITE = new THREE.Color(1, 1, 1);
/** Vape clouds: pink, lavender, mint, baby blue, peach. */
const PASTELS = [0xff8fc8, 0xb48cff, 0x7fe8b8, 0x86c8ff, 0xffb08a].map((c) => new THREE.Color(c));
/** Fire, hot to cool. */
const FIRE = [0xfff1a8, 0xffc23a, 0xff7a1a, 0xff3a10].map((c) => new THREE.Color(c));
const SOOT = new THREE.Color(0x2a1a16);
const BRASS = new THREE.Color(0xe0b04a);

let badgeTextures: THREE.Texture[] | null = null;

/** The notification bubbles: a red "1" badge and a blue chat bubble with three dots. */
function bubbleTextures(): THREE.Texture[] {
  if (badgeTextures) return badgeTextures;
  const make = (draw: (g: CanvasRenderingContext2D) => void) => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    draw(c.getContext('2d')!);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  badgeTextures = [
    make((g) => {
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(32, 32, 30, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#ff3b30';
      g.beginPath();
      g.arc(32, 32, 25, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#ffffff';
      g.font = 'bold 34px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('1', 32, 34);
    }),
    make((g) => {
      g.fillStyle = '#2f8cff';
      g.beginPath();
      g.roundRect(4, 10, 56, 38, 16);
      g.fill();
      g.beginPath();
      g.moveTo(14, 44);
      g.lineTo(8, 58);
      g.lineTo(26, 46);
      g.fill();
      g.fillStyle = '#ffffff';
      for (const x of [20, 32, 44]) {
        g.beginPath();
        g.arc(x, 29, 4.5, 0, Math.PI * 2);
        g.fill();
      }
    }),
  ];
  return badgeTextures;
}

/**
 * Muzzle effects: what plays where a spell leaves its caster, by muzzle type (src/wizard/muzzles.ts).
 *
 * - staff: the orb flares, a spark burst and flash (also the generic wand of a look without muzzles)
 * - phone: a bright screen flash and notification bubbles popping off it
 * - vape: a pastel vapour puff (bigger each stage) and a lingering haze wisp; the cannon billows
 * - gun: a hard muzzle star on the barrel each shot (Full Auto strobes) plus a light; bullets also
 *   get ProjectileSkins' gunshot flash, and a brass casing flicks out
 * - hand: a fiery palm flare and a burst of flame
 * - mouth: a cone of fire breath and a jaw glow
 *
 * The glows anchored to the prop (charging, idle, flash) are WizardVisual's; the bursts here use the
 * shared Effects particles and flashes, plus a small pool of bubble sprites and two point lights
 * given to the brightest muzzles each frame. Nothing is allocated per cast or per frame.
 */
export class MuzzleFx {
  private readonly lights: THREE.PointLight[] = [];
  private readonly bubbles: Bubble[] = [];
  /** Casts since start, per muzzle type (QA). */
  readonly counts: Record<string, number> = { staff: 0, phone: 0, vape: 0, gun: 0, hand: 0, mouth: 0, wand: 0 };
  private seed = 0x2545f491;
  /**
   * Cosmetic dice: muzzle effects draw from their own generator, so however many sparks and puffs
   * they throw they never shift the gameplay's Math.random (AI rolls, which seeded QA runs replay).
   */
  private readonly rand = () => {
    this.seed = (this.seed + 0x6d2b79f5) >>> 0;
    let t = this.seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  constructor(scene: THREE.Scene, private readonly fx: Effects) {
    for (let i = 0; i < LIGHT_COUNT; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 7, 2);
      scene.add(light);
      this.lights.push(light);
    }
    const tex = bubbleTextures();
    for (let i = 0; i < BUBBLE_COUNT; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex[i % tex.length], transparent: true, depthWrite: false, toneMapped: false }));
      sprite.visible = false;
      sprite.renderOrder = 13;
      scene.add(sprite);
      this.bubbles.push({ sprite, active: false, t: 0, life: 1, size: 0.1, vel: new THREE.Vector3() });
    }
  }

  /**
   * A spell of `kind` just left `w` through muzzle `index` (-1: the generic wand) at `pos`, heading
   * along unit `dir`. On a rigged look whose muzzle rides a bone, the effects play at that socket
   * (the animated staff, phone or vape) rather than the spawn point.
   */
  cast(w: Wizard, kind: CastKind, index: number, spawn: THREE.Vector3, dir: THREE.Vector3): void {
    const pos = w.visual.muzzleFxOrigin(index, spawn, tmpOrigin);
    const color = kind === 'blast' ? w.team.blast : kind === 'stun' ? w.team.stun : kind === 'ultimate' ? w.team.ultimate : w.team.spell;
    // The spell leaving: a spark burst and flash in its colour, as every cast has always had (and on
    // the game's own dice, exactly as many draws as before, so seeded AI runs replay unchanged).
    if (kind !== 'ultimate') this.fx.muzzle(pos, dir, color, kind === 'blast' ? 1.8 : kind === 'stun' ? 1.2 : 0.8);
    // The device's own flavour on top, on cosmetic dice.
    const real = Math.random;
    Math.random = this.rand;
    try {
      this.emit(w, kind, index, pos, dir, color);
    } finally {
      Math.random = real;
    }
  }

  private emit(w: Wizard, kind: CastKind, index: number, pos: THREE.Vector3, dir: THREE.Vector3, color: number): void {
    const v = w.visual;
    const type = index >= 0 ? v.muzzleType(index) : null;
    const size = index >= 0 ? v.muzzleSize(index) : 1;
    // Blasts and the Ultimate are bigger moments than a bolt.
    const weight = kind === 'blast' || kind === 'ultimate' ? 1.8 : kind === 'stun' ? 1.3 : 0.8;
    if (index >= 0) v.flare(index, 1);
    this.counts[type ?? 'wand']++;
    const fx = this.fx;
    switch (type) {
      case null:
        // The generic wand: just the spell's burst (and the Ultimate's).
        if (kind === 'ultimate') fx.muzzle(pos, dir, color, weight);
        return;
      case 'staff': {
        // The orb flares (WizardVisual) and throws off a ring of motes.
        fx.sparks.burst(pos, Math.round(8 * weight), tmpColor.setHex(color).lerp(WHITE, 0.35), 2.6, 1.5 * size, 3.5 * size, 0.07 * size, 0.35, { drag: 4, gravity: -1.5 });
        if (kind !== 'bolt' && kind !== 'volley') fx.light(tmpPos.copy(pos).addScaledVector(dir, 0.6), color, 14 * weight, 0.18);
        return;
      }
      case 'phone':
        this.phone(pos, dir, color, size, weight);
        return;
      case 'vape':
        this.vape(pos, dir, color, size, weight);
        return;
      case 'gun': {
        if (kind !== 'bolt' && kind !== 'volley') {
          // Bullets get ProjectileSkins' gunshot flash; anything else from the barrel gets one here.
          fx.flash(pos, 0xfff2c8, 1.2 * size * weight, 0.07);
          fx.light(tmpPos.copy(pos).addScaledVector(dir, 0.6), 0xffc070, 16, 0.08);
        }
        // A brass casing flicks out to the right.
        tmpSide.crossVectors(dir, UP).normalize();
        fx.sparks.emit(pos.x, pos.y, pos.z, tmpSide.x * 2.5 - dir.x, 2 + Math.random(), tmpSide.z * 2.5 - dir.z, BRASS, 1.6, 0.05 * size, 0.6, { gravity: 12, drag: 1 });
        return;
      }
      case 'hand':
        this.handFire(pos, dir, size, weight);
        return;
      case 'mouth':
        this.fireBreath(pos, dir, size, weight);
        return;
    }
  }

  /** Screen flash and notification bubbles. */
  private phone(pos: THREE.Vector3, dir: THREE.Vector3, color: number, size: number, weight: number): void {
    const fx = this.fx;
    fx.flash(pos, 0xe8f4ff, 0.8 * size * weight, 0.07);
    fx.sparks.burst(pos, Math.round(5 * weight), tmpColor.setHex(color).lerp(WHITE, 0.5), 2.4, 1, 3 * size, 0.05 * size, 0.3, { drag: 4, gravity: -1 });
    const n = weight > 1 ? 3 : Math.random() < 0.6 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const b = this.takeBubble();
      b.active = true;
      b.t = 0;
      b.life = 0.7 + Math.random() * 0.35;
      b.size = (0.11 + Math.random() * 0.05) * Math.max(0.7, size);
      // Up and off to either side, a little along the shot.
      tmpSide.crossVectors(dir, UP).normalize().multiplyScalar((Math.random() - 0.5) * 1.6);
      b.vel.copy(tmpSide).addScaledVector(dir, 0.5).add(tmpUp.set(0, 1.3 + Math.random() * 0.8, 0));
      b.sprite.position.copy(pos).addScaledVector(dir, 0.05);
      b.sprite.material.rotation = (Math.random() - 0.5) * 0.5;
      b.sprite.visible = true;
    }
  }

  /** Pastel vapour: a puff along the shot that grows with the vape, a slow haze wisp, a billow from the cannon. */
  private vape(pos: THREE.Vector3, dir: THREE.Vector3, color: number, size: number, weight: number): void {
    const smoke = this.fx.smoke;
    const puffs = Math.round((7 + 4 * size) * (weight > 1 ? 1.5 : 1));
    for (let i = 0; i < puffs; i++) {
      const c = PASTELS[(Math.random() * PASTELS.length) | 0];
      const sp = 0.5 + Math.random() * 1.8;
      smoke.emit(
        pos.x + (Math.random() - 0.5) * 0.06 * size, pos.y + (Math.random() - 0.5) * 0.06 * size, pos.z + (Math.random() - 0.5) * 0.06 * size,
        dir.x * sp + (Math.random() - 0.5) * 0.8, dir.y * sp + 0.25 + Math.random() * 0.5, dir.z * sp + (Math.random() - 0.5) * 0.8,
        c, 0.85, (0.14 + Math.random() * 0.1) * size, 0.7 + Math.random() * 0.5, { drag: 2.6, gravity: -0.35, sizeEnd: (0.5 + Math.random() * 0.3) * size },
      );
    }
    // The haze that hangs around the mouthpiece and drifts up.
    for (let i = 0; i < 2; i++) {
      const c = PASTELS[(Math.random() * PASTELS.length) | 0];
      smoke.emit(pos.x, pos.y + 0.03, pos.z, (Math.random() - 0.5) * 0.25, 0.25 + Math.random() * 0.2, (Math.random() - 0.5) * 0.25,
        c, 0.6, 0.1 * size, 2.2 + Math.random() * 1.2, { drag: 0.8, gravity: -0.12, sizeEnd: 0.9 * size });
    }
    // The cannon (stage 3) billows: a big rolling cloud.
    if (size >= 2) {
      for (let i = 0; i < 7; i++) {
        const c = PASTELS[(Math.random() * PASTELS.length) | 0];
        const sp = 0.6 + Math.random() * 1.6;
        smoke.emit(pos.x, pos.y, pos.z,
          dir.x * sp + (Math.random() - 0.5) * 1.6, 0.3 + Math.random() * 0.9, dir.z * sp + (Math.random() - 0.5) * 1.6,
          c, 0.8, 0.26 * size, 1.3 + Math.random() * 0.8, { drag: 1.8, gravity: -0.25, sizeEnd: 0.7 * size });
      }
    }
    this.fx.sparks.burst(pos, 3, tmpColor.setHex(color), 2, 0.5, 1.5, 0.05 * size, 0.3, { drag: 3 });
  }

  /** Tinubu's palm: a burst of flame thrown forward with licks rising off the hand. */
  private handFire(pos: THREE.Vector3, dir: THREE.Vector3, size: number, weight: number): void {
    const fx = this.fx;
    const n = Math.round(14 * weight);
    for (let i = 0; i < n; i++) {
      const c = FIRE[(Math.random() * FIRE.length) | 0];
      const sp = 2 + Math.random() * 5;
      fx.sparks.emit(pos.x, pos.y, pos.z,
        dir.x * sp + (Math.random() - 0.5) * 3, dir.y * sp + 0.5 + Math.random() * 2.5, dir.z * sp + (Math.random() - 0.5) * 3,
        c, 2.6, (0.08 + Math.random() * 0.08) * size, 0.25 + Math.random() * 0.25, { drag: 3.5, gravity: -3 });
    }
    fx.smoke.emit(pos.x, pos.y + 0.05, pos.z, (Math.random() - 0.5) * 0.3, 0.8, (Math.random() - 0.5) * 0.3,
      SOOT, 0.35, 0.12 * size, 0.6, { drag: 2, gravity: -0.8, sizeEnd: 0.5 * size });
    fx.flash(pos, 0xff9a3a, 0.9 * size * weight, 0.08);
    if (weight > 1) fx.light(tmpPos.copy(pos).addScaledVector(dir, 0.6), 0xff7a1a, 18, 0.2);
  }

  /** Tinubu's mouth: a cone of fire breath along the shot, soot, and a hot flash at the lips. */
  private fireBreath(pos: THREE.Vector3, dir: THREE.Vector3, size: number, weight: number): void {
    const fx = this.fx;
    // Two axes across the cone.
    tmpSide.crossVectors(dir, UP);
    if (tmpSide.lengthSq() < 1e-6) tmpSide.set(1, 0, 0);
    tmpSide.normalize();
    tmpUp.crossVectors(tmpSide, dir).normalize();
    const spread = 0.32;
    const n = Math.round(26 * weight);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * spread;
      const sx = Math.cos(a) * r, sy = Math.sin(a) * r;
      const sp = (6 + Math.random() * 9) * Math.sqrt(size);
      tmpPos.copy(dir).addScaledVector(tmpSide, sx).addScaledVector(tmpUp, sy).normalize().multiplyScalar(sp);
      // Hot at the core of the cone, redder at its edge.
      const c = FIRE[Math.min(FIRE.length - 1, Math.floor((r / spread) * FIRE.length + Math.random()))];
      fx.sparks.emit(pos.x, pos.y, pos.z, tmpPos.x, tmpPos.y, tmpPos.z,
        c, 2.8, (0.1 + Math.random() * 0.1) * size, 0.18 + Math.random() * 0.22, { drag: 4.5, gravity: -2.5 });
    }
    for (let i = 0; i < 3; i++) {
      fx.smoke.emit(pos.x, pos.y, pos.z,
        dir.x * 2 + (Math.random() - 0.5), dir.y * 2 + 0.6, dir.z * 2 + (Math.random() - 0.5),
        SOOT, 0.4, 0.15 * size, 0.7 + Math.random() * 0.4, { drag: 2.2, gravity: -0.9, sizeEnd: 0.7 * size });
    }
    fx.flash(tmpPos.copy(pos).addScaledVector(dir, 0.15 * size), 0xffa040, 1.1 * size * weight, 0.09);
    if (weight > 1) fx.light(tmpPos.copy(pos).addScaledVector(dir, 0.8), 0xff5a10, 22, 0.22);
  }

  private takeBubble(): Bubble {
    let oldest = this.bubbles[0];
    for (const b of this.bubbles) {
      if (!b.active) return b;
      if (b.t / b.life > oldest.t / oldest.life) oldest = b;
    }
    return oldest;
  }

  /** Per render frame: bubbles drift and pop; the two muzzle lights go to the brightest muzzles. */
  update(dt: number, wizards: readonly Wizard[]): void {
    for (const b of this.bubbles) {
      if (!b.active) continue;
      b.t += dt;
      const p = b.t / b.life;
      if (p >= 1) {
        b.active = false;
        b.sprite.visible = false;
        continue;
      }
      b.vel.multiplyScalar(Math.exp(-2.2 * dt));
      b.sprite.position.addScaledVector(b.vel, dt);
      // Pop in with a little overshoot, then shrink away.
      const grow = p < 0.15 ? (p / 0.15) * 1.25 : p < 0.25 ? 1.25 - ((p - 0.15) / 0.1) * 0.25 : 1;
      b.sprite.scale.setScalar(b.size * grow * (p > 0.8 ? 1 - (p - 0.8) * 3 : 1));
      b.sprite.material.opacity = p > 0.7 ? 1 - (p - 0.7) / 0.3 : 1;
    }

    // The two brightest muzzle light requests (WizardVisual.lightLevel) get the lights.
    let a: Wizard | null = null, b: Wizard | null = null;
    for (const w of wizards) {
      const level = w.visual.lightLevel;
      if (level <= 0.02 || !w.visual.root.visible) continue;
      if (!a || level > a.visual.lightLevel) {
        b = a;
        a = w;
      } else if (!b || level > b.visual.lightLevel) b = w;
    }
    this.place(0, a);
    this.place(1, b);
  }

  private place(i: number, w: Wizard | null): void {
    const light = this.lights[i];
    if (!w) {
      light.intensity = 0;
      return;
    }
    const v = w.visual;
    const ahead = LIGHT_AHEAD * Math.max(0.7, v.fxScale);
    light.position.copy(v.lightPos);
    light.position.x += Math.sin(w.facing) * ahead;
    light.position.z += Math.cos(w.facing) * ahead;
    light.color.copy(tmpColor2.copy(v.lightColor));
    light.intensity = Math.min(2, v.lightLevel) * LIGHT_INTENSITY * Math.max(0.7, v.fxScale);
  }

  clear(): void {
    for (const b of this.bubbles) {
      b.active = false;
      b.sprite.visible = false;
    }
    for (const l of this.lights) l.intensity = 0;
  }

  /** Pool sizes and use (QA: the pools never grow). */
  stats(): { lights: number; bubbles: number; bubblesActive: number } {
    let active = 0;
    for (const b of this.bubbles) if (b.active) active++;
    return { lights: this.lights.length, bubbles: this.bubbles.length, bubblesActive: active };
  }
}
