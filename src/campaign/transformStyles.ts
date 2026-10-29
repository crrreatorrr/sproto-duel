import * as THREE from 'three';
import { CONFIG } from '../config';
import { Debris } from '../arena/Debris';
import type { WizardClip } from '../assets/manifest';
import { events } from '../core/events';
import { feel } from '../core/feel';
import { clamp } from '../core/math';
import type { Game } from '../core/Game';
import type { SkinSlot, SkinTarget } from '../spells/ProjectileSkins';
import type { ObjectSkin } from '../spells/skinLooks';
import type { Animator } from '../wizard/Animator';
import type { MuzzleType } from '../wizard/muzzles';
import type { Wizard } from '../wizard/Wizard';
import type { BossFighter } from './levels';

const S = CONFIG.campaign.cinematic.styles;

/** Each boss's own transformation (BossFighter.transform). */
export type TransformStyleId = keyof typeof S;

/** Sound cues a transformation plays on top of the shot's own beats (AudioManager maps them). */
export type CineCue =
  | 'whoosh' | 'coins' | 'phone' | 'candle' | 'crash' | 'oink' | 'hop' | 'thud'
  | 'inhale' | 'exhale' | 'crunch' | 'beep' | 'glitch' | 'gunfire' | 'casing' | 'fire' | 'roar';

/** The shot as a style sees it (BossCinematic's Shot). */
export interface ShotView {
  readonly w: Wizard;
  readonly boss: BossFighter;
  readonly stage: number;
  /** 1 for stage 2, 2 for stage 3. */
  readonly tier: 1 | 2;
  readonly duration: number;
  /** Cinematic seconds. */
  readonly t: number;
  readonly speed: number;
  readonly burst: boolean;
  readonly slam: boolean;
  /** How high he floats right now (m). */
  readonly rise: number;
  /** His look's height (m), smoothed across the swap. */
  readonly height: number;
  /** The arena's light factor (bright arenas get less glow). */
  readonly light: number;
  readonly color: number;
  readonly colorHi: number;
}

/** This frame of the shot. */
export interface Beat {
  /** His feet where the fight left him (the pose adds the rise and offsets on top). */
  readonly base: THREE.Vector3;
  /** Real seconds this frame (0 while paused). */
  readonly run: number;
  /** A clock for shaders (real seconds). */
  readonly time: number;
  /** End of the stagger, the burst, the slam (cinematic s), and the fall before the slam. */
  readonly tStag: number;
  readonly tBurst: number;
  readonly tSlam: number;
  readonly fall: number;
  /** 0 -> 1 to the burst. */
  readonly charge: number;
  /** Highest float of this shot (m). */
  readonly riseMax: number;
}

/** The pose the shot gives his root this frame; a style adjusts it (BossCinematic applies it). */
export interface Body {
  /** Height above his feet (m). */
  y: number;
  /** Turn on top of his facing (rad). */
  yaw: number;
  /** Offsets on the floor (m). */
  dx: number;
  dz: number;
  /** Lean back (rad, negative leans back). */
  tilt: number;
  /** Look scale across and up. */
  sx: number;
  sy: number;
}

/** What the styles share: the game, the prop pool, and hooks into the cinematic. */
export interface StyleKit {
  readonly game: Game;
  readonly props: PropSet;
  /** The cinematic's real-time stone debris (in the arena's look). */
  readonly debris: Debris;
  /** Put a class on the cinematic overlay for `seconds` of real time (a screen effect). */
  flash(cls: string, seconds: number): void;
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Color();
const tmpC2 = new THREE.Color();
const dummy = new THREE.Object3D();

const sat = (x: number) => clamp(x, 0, 1);
const smooth = (a: number, b: number, x: number) => {
  const t = sat((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const easeOut3 = (t: number) => 1 - Math.pow(1 - sat(t), 3);
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

// ------------------------------------------------------------------ props

/**
 * A boss's own projectile look (rug, carpet, phone, pig, floret, bullet, skull...) used as a prop in
 * his transformation: an instance in his skin batches (ProjectileSkins) at a position the style
 * sets, tumbling on its own clock through the freeze.
 */
class Prop implements SkinTarget {
  kind: 'bolt' | 'blast' = 'bolt';
  readonly group = new THREE.Object3D();
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3(0, 0, 1);
  radius = 0.16;
  caster: Wizard = null!;
  color = 0xffffff;
  age = 0;
  skin: ObjectSkin = 'phone';
  slot: SkinSlot | null = null;
  /** Orbit: start angle, radius (m), height above his feet (m), angular speed (rad/s) and bob phase. */
  angle = 0;
  orbitR = 1;
  orbitY = 1;
  orbitSpeed = 1;
  bob = 0;
  /** Free flight after the burst: falls and expires. */
  flying = false;
  life = 0;
  gravity = 0;
  drag = 0;
}

/** Pooled props over ProjectileSkins. Nothing is allocated once warm. */
export class PropSet {
  private readonly pool: Prop[] = [];
  readonly live: Prop[] = [];

  constructor(private readonly game: Game) {}

  /** A `skin` prop in `caster`'s palette, `scale` x the projectile's own size; null if its batch is full. */
  take(skin: ObjectSkin, kind: 'bolt' | 'blast', caster: Wizard, scale: number): Prop | null {
    const p = this.pool.pop() ?? new Prop();
    p.skin = skin;
    p.kind = kind;
    p.radius = CONFIG.spells[kind].radius * scale;
    p.caster = caster;
    p.color = caster.team.spell;
    p.age = Math.random() * 4;
    p.flying = false;
    p.life = 0;
    p.vel.set(0, 0, 1);
    p.slot = this.game.spells.pool.skins.acquire(skin, caster.index, p);
    if (!p.slot) {
      this.pool.push(p);
      return null;
    }
    this.live.push(p);
    return p;
  }

  /** Set a prop flying from where it is. */
  launch(p: Prop, vx: number, vy: number, vz: number, gravity: number, drag: number, life: number): void {
    p.flying = true;
    p.vel.set(vx, vy, vz);
    p.gravity = gravity;
    p.drag = drag;
    p.life = life;
  }

  /** Every frame (real time): flying props fall, bounce and expire; every prop tumbles. */
  update(dt: number): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.age += dt;
      if (p.flying && dt > 0) {
        p.vel.y -= p.gravity * dt;
        const k = Math.exp(-p.drag * dt);
        p.vel.x *= k;
        p.vel.z *= k;
        p.pos.addScaledVector(p.vel, dt);
        if (p.pos.y < 0.12) {
          p.pos.y = 0.12;
          p.vel.y = Math.abs(p.vel.y) * 0.3;
          p.vel.x *= 0.6;
          p.vel.z *= 0.6;
        }
        p.life -= dt;
        if (p.life <= 0) {
          this.drop(i);
          continue;
        }
      }
      p.group.position.copy(p.pos);
    }
  }

  private drop(i: number): void {
    const p = this.live[i];
    const skins = this.game.spells.pool.skins;
    if (p.slot) {
      // A pig pops in a pink puff (the skin's own ending).
      if (p.skin === 'pig') skins.ended(p.slot, p);
      skins.release(p.slot);
    }
    p.slot = null;
    this.live[i] = this.live[this.live.length - 1];
    this.live.pop();
    this.pool.push(p);
  }

  /** Release every prop. */
  clear(): void {
    for (let i = this.live.length - 1; i >= 0; i--) this.drop(i);
  }
}

// ------------------------------------------------------------------ choreography

/** A clip over one phase of the shot: scrubbed from `from` to `to` s across it, or played from `from` at `rate`. */
interface ClipCue {
  clip: WizardClip;
  from: number;
  to?: number;
  rate?: number;
  /** Played instead when the look has no `clip`. */
  alt?: WizardClip;
}

/** The rig's part in a transformation: reel, charge, burst out as the new form, land. */
interface Choreo {
  stagger: ClipCue;
  charge: ClipCue;
  burst: ClipCue;
  slam: ClipCue;
}

const STAGGER: ClipCue = { clip: 'hit', from: 0.04, rate: 1, alt: 'stunned' };
const SLAM: ClipCue = { clip: 'castBig', from: 0.72, to: 1.3 };

/** Rise and turn multipliers. */
export interface Motion {
  rise: number;
  spins: number;
}

/**
 * One boss's transformation, on top of the shot every boss shares (BossCinematic: the freeze, the
 * camera, glow, vortex, burst, landing, card). A style choreographs the rig (which clip, scrubbed
 * how, in each phase), bends the body's motion (hops, glitch snaps, inflating), and brings its own
 * props, meshes, particles and sound cues. Every mesh is built once at start-up (and so compiled by
 * the fight's warm-up); props are pooled instances in the boss's own skin batches.
 */
export abstract class TransformStyle {
  abstract readonly id: TransformStyleId;
  abstract readonly choreo: Choreo;
  /** Cues played during the current shot (QA). */
  readonly cues: CineCue[] = [];
  /** Until the burst the camera follows his posed height (smoothed) rather than the shot's planned float. */
  readonly followBody: boolean = false;

  constructor(protected readonly kit: StyleKit, readonly motion: Motion) {}

  protected get game(): Game {
    return this.kit.game;
  }

  protected get props(): PropSet {
    return this.kit.props;
  }

  /** The shot starts. */
  begin(_s: ShotView, _f: Beat): void {}
  /** Every frame of the play phase, after the body is posed. */
  update(_s: ShotView, _f: Beat): void {}
  /** The old form bursts. */
  burst(_s: ShotView, _f: Beat): void {}
  /** He lands. */
  slam(_s: ShotView, _f: Beat): void {}
  /** Bend the shot's body pose. */
  body(_s: ShotView, _f: Beat, _b: Body): void {}
  /** Every frame, shot or not (real time): what fades on after the shot. */
  tick(_run: number): void {}

  /** The play phase is over: props go, the shot's own meshes hide. */
  end(): void {
    this.props.clear();
  }

  /** Stop everything at once (leaving the fight). */
  reset(): void {
    this.end();
  }

  /** Pose the rig for this moment (its clip, scrubbed through the phase). */
  pose(s: ShotView, f: Beat): void {
    const anim = s.w.visual.animator;
    if (!anim) return;
    if (this.custom(s, f, anim)) return;
    const c = this.choreo;
    const slamFrom = f.tSlam - f.fall;
    if (s.t < f.tStag) this.play(anim, c.stagger, s.t, f.tStag);
    else if (!s.burst) this.play(anim, c.charge, s.t - f.tStag, f.tBurst - f.tStag);
    else if (s.t < slamFrom) this.play(anim, c.burst, s.t - f.tBurst, slamFrom - f.tBurst);
    else this.play(anim, c.slam, s.t - slamFrom, s.duration - slamFrom);
  }

  /** A style's own pose for this frame (true when it posed the rig). */
  protected custom(_s: ShotView, _f: Beat, _anim: Animator): boolean {
    return false;
  }

  protected play(anim: Animator, cue: ClipCue, e: number, len: number, fade = 0.15): void {
    const time = cue.to !== undefined ? cue.from + (cue.to - cue.from) * smooth(0, 1, e / Math.max(1e-3, len)) : cue.from + e * (cue.rate ?? 1);
    if (anim.direct(cue.clip, time, fade)) return;
    if (!cue.alt || !anim.direct(cue.alt, time, fade)) anim.direct(null);
  }

  protected cue(s: ShotView, cue: CineCue, rate = 1): void {
    this.cues.push(cue);
    events.emit('bossCinematicCue', { wizard: s.w, style: this.id, cue, rate });
  }

  /** His size relative to a 2.2 m look (orbits and effects scale with it). */
  protected size(s: ShotView): number {
    return clamp(s.height / 2.2, 0.55, 1.5);
  }

  /** Props orbiting his feet, tightening and speeding up with the charge. */
  protected orbit(list: readonly Prop[], s: ShotView, f: Beat, spin: number, tighten: number, lift: number): void {
    const k = this.size(s);
    for (const p of list) {
      if (p.flying || !p.slot) continue;
      const a = p.angle + spin * p.orbitSpeed;
      const r = p.orbitR * k * (1 - tighten * f.charge);
      p.pos.set(
        f.base.x + Math.sin(a) * r,
        f.base.y + s.rise * lift + p.orbitY * s.height + Math.sin(f.time * 2.3 + p.bob) * 0.12 * k,
        f.base.z + Math.cos(a) * r,
      );
      // Heading along the orbit (the skin faces its velocity).
      const dir = Math.sign(p.orbitSpeed) || 1;
      p.vel.set(Math.cos(a) * dir, 0.1, -Math.sin(a) * dir);
    }
  }

  /** Throw orbiting props outward and up from his centre. */
  protected scatter(list: readonly Prop[], f: Beat, speed: [number, number], up: [number, number], gravity: number, drag: number, life: number): void {
    for (const p of list) {
      if (p.flying || !p.slot) continue;
      tmpA.set(p.pos.x - f.base.x, 0, p.pos.z - f.base.z);
      if (tmpA.lengthSq() < 1e-4) tmpA.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      tmpA.normalize().multiplyScalar(rnd(speed[0], speed[1]));
      this.props.launch(p, tmpA.x, rnd(up[0], up[1]), tmpA.z, gravity, drag, life * rnd(0.8, 1.2));
    }
  }

  /** `n` props of one skin set to orbit (angle spread evenly), each tweaked by `setup`. */
  protected ring(s: ShotView, skin: ObjectSkin, kind: 'bolt' | 'blast', scale: number, n: number, setup: (p: Prop, i: number) => void): Prop[] {
    const out: Prop[] = [];
    for (let i = 0; i < n; i++) {
      const p = this.props.take(skin, kind, s.w, scale);
      if (!p) break;
      p.angle = (i / n) * Math.PI * 2 + rnd(-0.2, 0.2);
      p.bob = Math.random() * 6;
      setup(p, i);
      out.push(p);
    }
    return out;
  }

  /** Where his look's muzzle of `type` is right now, else a point `up` x his height above his feet. */
  protected muzzle(s: ShotView, f: Beat, type: MuzzleType, up: number, out: THREE.Vector3): THREE.Vector3 {
    const v = s.w.visual;
    const i = v.muzzleOfType(type);
    if (i >= 0) {
      v.muzzleNow(i, out);
      if (Number.isFinite(out.x)) return out;
    }
    return out.set(f.base.x, f.base.y + s.rise + s.height * up, f.base.z);
  }

  /** Particles spiralling round him (a sand or dust devil). */
  protected devil(s: ShotView, f: Beat, rate: number, color: THREE.Color, size: number): void {
    const fx = this.game.fx;
    const k = this.size(s);
    const n = Math.round(rate * f.run + Math.random() * 0.5);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = rnd(1.4, 2.6) * k;
      const sx = Math.sin(a), cz = Math.cos(a);
      fx.smoke.emit(f.base.x + sx * r, f.base.y + rnd(0.05, 1.1) * s.height, f.base.z + cz * r,
        cz * 6 - sx * 1.5, rnd(0.8, 2), -sx * 6 - cz * 1.5,
        color, 0.6, size * k, rnd(0.6, 1), { drag: 0.7, gravity: -0.6, sizeEnd: size * 2.4 * k });
    }
  }
}

// ------------------------------------------------------------------ Sahil

/** Sahil the RugMaster: his stock takes flight. */
class Bazaar extends TransformStyle {
  readonly id = 'bazaar' as const;
  readonly choreo: Choreo = {
    stagger: STAGGER,
    // Gathers and raises the staff, then holds it to the sky while the carpets whirl.
    charge: { clip: 'castBig', from: 0, to: 0.7 },
    burst: { clip: 'victory', from: 0.75, rate: 0.6, alt: 'castBig' },
    slam: SLAM,
  };
  private carpets: Prop[] = [];
  private rolls: Prop[] = [];
  private ride: Prop | null = null;
  private spin = 0;
  private readonly sand = new THREE.Color(0x9a7646);
  private readonly gold = new THREE.Color(0xffc93a);

  begin(s: ShotView): void {
    const C = S.bazaar;
    this.spin = 0;
    this.carpets = this.ring(s, 'carpet', 'blast', 0.42, C.carpets[s.tier], (p, i) => {
      p.orbitR = 1.55 + (i % 2) * 0.4;
      p.orbitY = 0.15 + (0.95 * (i + 0.5)) / C.carpets[s.tier];
      p.orbitSpeed = rnd(2.2, 2.7);
    });
    this.rolls = this.ring(s, 'rugRoll', 'bolt', 1.1, C.rolls[s.tier], (p) => {
      p.orbitR = 2.1;
      p.orbitY = rnd(0.2, 0.55);
      p.orbitSpeed = rnd(3.2, 3.8);
    });
    // The magic carpet he rides up on.
    this.ride = this.props.take('carpet', 'blast', s.w, 0.01);
    this.cue(s, 'whoosh', 0.8);
  }

  update(s: ShotView, f: Beat): void {
    const k = f.charge;
    this.spin += f.run * (1 + 2.2 * k);
    if (s.burst) return;
    this.orbit(this.carpets, s, f, this.spin, 0.3, 0.6);
    this.orbit(this.rolls, s, f, this.spin, 0.2, 0.3);
    const ride = this.ride;
    if (ride && !ride.flying && ride.slot) {
      // Under his feet as he lifts off, turning with him.
      const root = s.w.visual.root;
      ride.radius = CONFIG.spells.blast.radius * 1.05 * this.size(s) * sat(s.rise / 0.35);
      ride.pos.set(root.position.x, root.position.y + 0.04, root.position.z);
      ride.vel.set(Math.sin(root.rotation.y), 0, Math.cos(root.rotation.y));
    }
    if (f.charge > 0.05) this.devil(s, f, S.bazaar.sand * (0.4 + k), this.sand, 0.5);
    // Coins glinting off the whirling stock.
    const fx = this.game.fx;
    for (const p of this.carpets) {
      if (Math.random() < 6 * f.run) fx.sparks.emit(p.pos.x, p.pos.y, p.pos.z, rnd(-1, 1), rnd(0, 2), rnd(-1, 1), this.gold, 1.6, 0.09, 0.7, { gravity: 9 });
    }
  }

  burst(s: ShotView, f: Beat): void {
    const all = this.ride ? [...this.carpets, ...this.rolls, this.ride] : [...this.carpets, ...this.rolls];
    this.scatter(all, f, [6, 11], [3, 7], 7, 0.7, 1.5);
    // A shower of gold.
    const n = Math.round(S.bazaar.coins[s.tier] * (0.4 + 0.6 * s.light));
    tmpA.set(f.base.x, f.base.y + s.rise + s.height * 0.6, f.base.z);
    this.game.fx.sparks.burst(tmpA, n, this.gold, 1.6, 4, 11, 0.13, 1.3, { gravity: 10, drag: 0.8 });
    this.cue(s, 'coins');
    this.cue(s, 'whoosh', 1.2);
  }

  slam(s: ShotView, f: Beat): void {
    // A ring of sand thrown out along the floor.
    const fx = this.game.fx;
    const k = this.size(s);
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      const sp = rnd(6, 9);
      fx.smoke.emit(f.base.x + Math.sin(a) * 0.8, 0.2, f.base.z + Math.cos(a) * 0.8, Math.sin(a) * sp, rnd(0.5, 1.5), Math.cos(a) * sp,
        this.sand, 0.65, 0.6 * k, rnd(0.8, 1.2), { drag: 2.2, sizeEnd: 1.9 * k });
    }
    this.cue(s, 'thud');
  }

  end(): void {
    super.end();
    this.carpets = [];
    this.rolls = [];
    this.ride = null;
  }
}

// ------------------------------------------------------------------ Bitcoin Obama

/** Bitcoin Obama: shills the pump (phones, flying pigs, green candles), then the dump. */
class Shill extends TransformStyle {
  readonly id = 'shill' as const;
  readonly choreo: Choreo = {
    stagger: STAGGER,
    // Hypes the crowd, arms up; throws at the burst.
    charge: { clip: 'victory', from: 0, rate: 1.1, alt: 'castBig' },
    burst: { clip: 'castBig', from: 0.55, to: 1.0 },
    slam: SLAM,
  };
  private phones: Prop[] = [];
  private pigs: Prop[] = [];
  private spin = 0;
  /** The candle chart: bodies and wicks, one instanced draw. */
  private readonly candles: THREE.InstancedMesh;
  private readonly n: number;
  private readonly angle: Float32Array;
  private readonly bottom: Float32Array;
  private readonly top: Float32Array;
  private readonly grown: Float32Array;
  private opened = 0;
  private readonly center = new THREE.Vector3();
  private crashT = -1;
  private readonly green = new THREE.Color(0.15, 1.5, 0.45);
  private readonly red = new THREE.Color(1.7, 0.14, 0.1);
  private readonly orange = new THREE.Color(0xf7931a);

  constructor(kit: StyleKit, motion: Motion) {
    super(kit, motion);
    const n = (this.n = S.shill.candles);
    this.angle = new Float32Array(n);
    this.bottom = new Float32Array(n);
    this.top = new Float32Array(n);
    this.grown = new Float32Array(n);
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, fog: true });
    this.candles = new THREE.InstancedMesh(geo, mat, n * 2);
    this.candles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < n * 2; i++) this.candles.setColorAt(i, this.green);
    this.candles.frustumCulled = false;
    this.candles.visible = false;
    this.candles.name = 'cine:candles';
    kit.game.renderer.scene.add(this.candles);
  }

  begin(s: ShotView, f: Beat): void {
    const C = S.shill;
    this.spin = 0;
    this.phones = this.ring(s, 'phone', 'bolt', 1.5, C.phones[s.tier], (p, i) => {
      p.orbitR = 1.45 + (i % 2) * 0.35;
      p.orbitY = 0.45 + 0.15 * (i % 3);
      p.orbitSpeed = rnd(2.8, 3.4);
    });
    // When pigs fly.
    this.pigs = this.ring(s, 'pig', 'blast', 0.38, C.pigs[s.tier], (p) => {
      p.orbitR = 2.0;
      p.orbitY = rnd(1.0, 1.25);
      p.orbitSpeed = -rnd(1.1, 1.5);
    });
    // The chart: a ring of candles round him, each opening where the last one closed (a pump).
    this.center.copy(f.base);
    const [h0, h1] = C.candleHeight;
    const start = Math.random() * Math.PI * 2;
    for (let i = 0; i < this.n; i++) {
      this.angle[i] = start + (i / this.n) * Math.PI * 2;
      const climb = (i / this.n) * (h1 - h0);
      this.bottom[i] = 0.1 + climb * 0.85;
      this.top[i] = this.bottom[i] + h0 * rnd(0.45, 0.9);
      this.grown[i] = 0;
    }
    for (let i = 0; i < this.n * 2; i++) this.candles.setColorAt(i, this.green);
    this.candles.instanceColor!.needsUpdate = true;
    this.opened = 0;
    this.crashT = -1;
    this.candles.visible = true;
    this.cue(s, 'phone');
  }

  update(s: ShotView, f: Beat): void {
    this.spin += f.run * (1 + 1.5 * f.charge);
    if (!s.burst) {
      this.orbit(this.phones, s, f, this.spin, 0.15, 0.7);
      this.orbit(this.pigs, s, f, this.spin, 0.1, 0.6);
      // Candles open one after another through the charge, each a step up the scale.
      const want = Math.min(this.n, Math.floor((smooth(f.tStag, f.tBurst * 0.95, s.t)) * this.n + 1e-6));
      while (this.opened < want) {
        if (this.opened % 2 === 0) this.cue(s, 'candle', 0.8 + (0.7 * this.opened) / this.n);
        this.opened++;
      }
    }
    // Grow the open ones (overshooting a little); after the burst they turn red and crash.
    const crash = this.crashT >= 0 ? sat((s.t - this.crashT) / 0.55) : 0;
    const R = S.shill.candleRadius;
    for (let i = 0; i < this.n; i++) {
      const target = i < this.opened ? 1 : 0;
      this.grown[i] += (target - this.grown[i]) * (1 - Math.exp(-11 * f.run));
      const g = this.grown[i] * (1 + 0.08 * Math.sin(f.time * 9 + i) * (1 - crash));
      const fallK = crash * crash;
      const bottom = this.bottom[i] * (1 - fallK);
      const body = Math.max(0, (this.top[i] - this.bottom[i]) * g * (1 - crash));
      const a = this.angle[i];
      const x = this.center.x + Math.sin(a) * R, z = this.center.z + Math.cos(a) * R;
      dummy.position.set(x, bottom, z);
      dummy.rotation.set(0, a, 0);
      dummy.scale.set(0.42, Math.max(1e-3, body), 0.42);
      dummy.updateMatrix();
      this.candles.setMatrixAt(i * 2, dummy.matrix);
      // The wick runs past both ends.
      dummy.position.y = Math.max(0, bottom - 0.3 * g);
      dummy.scale.set(0.07, Math.max(1e-3, body + 0.65 * g * (1 - crash)), 0.07);
      dummy.updateMatrix();
      this.candles.setMatrixAt(i * 2 + 1, dummy.matrix);
    }
    this.candles.instanceMatrix.needsUpdate = true;
  }

  burst(s: ShotView, f: Beat): void {
    this.scatter(this.phones, f, [8, 13], [2, 6], 9, 0.5, 1.2);
    this.scatter(this.pigs, f, [5, 9], [4, 8], 8, 0.4, 1.3);
    // The dump: every candle turns red and crashes.
    for (let i = 0; i < this.n * 2; i++) this.candles.setColorAt(i, this.red);
    this.candles.instanceColor!.needsUpdate = true;
    this.crashT = s.t;
    tmpA.set(f.base.x, f.base.y + s.rise + s.height * 0.6, f.base.z);
    this.game.fx.sparks.burst(tmpA, Math.round(70 * s.tier * (0.5 + 0.5 * s.light)), this.orange, 1.8, 4, 12, 0.14, 0.9, { gravity: 6, drag: 1 });
    this.cue(s, 'crash');
    this.cue(s, 'oink');
  }

  slam(s: ShotView, f: Beat): void {
    this.game.fx.dust(tmpA.set(f.base.x, 0.2, f.base.z), 6, 1.8 * this.size(s));
    this.cue(s, 'thud');
  }

  end(): void {
    super.end();
    this.phones = [];
    this.pigs = [];
    this.candles.visible = false;
  }
}

// ------------------------------------------------------------------ The Midget

/** The Midget: a hopping tantrum, a leap, a spin like a top and a ground-pound. */
class Tantrum extends TransformStyle {
  readonly id = 'tantrum' as const;
  readonly followBody = true;
  readonly choreo: Choreo = {
    stagger: STAGGER,
    charge: { clip: 'jump', from: 0, rate: 1 },
    burst: { clip: 'victory', from: 0.5, rate: 1.2, alt: 'castBig' },
    slam: { clip: 'castBig', from: 0.8, to: 1.3 },
  };
  private phones: Prop[] = [];
  private spin = 0;
  private hop = -1;
  /** Hops end and the leap starts at this share of the charge. */
  private static readonly HOPS_END = 0.74;
  private readonly dust = new THREE.Color(0x9a8a78);

  begin(s: ShotView): void {
    this.spin = 0;
    this.hop = -1;
    this.phones = this.ring(s, 'phone', 'bolt', 0.9, S.tantrum.phones[s.tier], (p, i) => {
      p.orbitR = 1.25;
      p.orbitY = 0.55 + 0.12 * (i % 2);
      p.orbitSpeed = rnd(6, 7.5);
    });
    this.cue(s, 'phone', 1.3);
  }

  /** Hop progress through the charge (hops done, fraction), or null outside the hops. */
  private hopAt(s: ShotView, f: Beat): number | null {
    const end = f.tBurst * Tantrum.HOPS_END;
    if (s.burst || s.t < f.tStag || s.t >= end) return null;
    return ((s.t - f.tStag) / (end - f.tStag)) * S.tantrum.hops[s.tier];
  }

  protected custom(s: ShotView, f: Beat, anim: Animator): boolean {
    const k = this.hopAt(s, f);
    if (k === null) return false;
    // One jump clip per hop.
    const ph = k % 1;
    if (!anim.direct('jump', ph * anim.duration('jump'), 0.06)) anim.direct('hit', 0.1 + ph * 0.3, 0.06);
    return true;
  }

  body(s: ShotView, f: Beat, b: Body): void {
    if (s.burst || s.t < f.tStag) return;
    const k = this.hopAt(s, f);
    const H = s.height;
    if (k !== null) {
      // Hops, higher as the tantrum builds, landing squashed; turning in quarter snaps.
      const ph = k % 1;
      const grow = 0.6 + (0.7 * k) / S.tantrum.hops[s.tier];
      b.y = S.tantrum.hopHeight * H * grow * 4 * ph * (1 - ph);
      const land = 1 - sat(ph / 0.14);
      b.sy *= 1 - 0.2 * land;
      b.sx *= 1 + 0.11 * land;
      b.yaw = Math.round(b.yaw / (Math.PI / 2)) * (Math.PI / 2);
      b.tilt = 0.12 * Math.sin(ph * Math.PI * 2);
    } else {
      // The leap, spinning up like a top.
      const end = f.tBurst * Tantrum.HOPS_END;
      const u = (s.t - end) / (f.tBurst - end);
      b.y = f.riseMax * easeOut3(u);
      b.yaw += u * u * Math.PI * 4;
    }
  }

  update(s: ShotView, f: Beat): void {
    this.spin += f.run * (1 + 2 * f.charge);
    if (s.burst) return;
    this.orbit(this.phones, s, f, this.spin, 0.25, 0.9);
    const k = this.hopAt(s, f);
    if (k !== null && Math.floor(k) !== this.hop) {
      // Touchdown (the first hop is the takeoff).
      if (this.hop >= 0) {
        this.game.fx.dust(tmpA.set(f.base.x, 0.15, f.base.z), 3, 0.6 * this.size(s));
        feel.shake(0.12);
        this.cue(s, 'hop', 1 + 0.12 * this.hop);
      }
      this.hop = Math.floor(k);
    }
    if (f.charge > 0.08) this.devil(s, f, S.tantrum.dust * (0.3 + f.charge), this.dust, 0.45);
  }

  burst(s: ShotView, f: Beat): void {
    this.scatter(this.phones, f, [9, 13], [2, 5], 9, 0.5, 1.1);
    this.cue(s, 'whoosh', 1.4);
  }

  slam(s: ShotView, f: Beat): void {
    // A ground-pound out of all proportion to him.
    const k = this.size(s);
    this.game.fx.dust(tmpA.set(f.base.x, 0.2, f.base.z), 6, 1.6);
    this.kit.debris.spawn(tmpB.set(f.base.x, 0.3, f.base.z), 6 + 4 * s.tier, 0.6 + 0.3 * k);
    feel.shake(0.35);
    this.cue(s, 'thud', 0.8);
  }

  end(): void {
    super.end();
    this.phones = [];
  }
}

// ------------------------------------------------------------------ Broccoli Head

const RING_VERT = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vN = normalize(mat3(modelMatrix) * normal);
    vV = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
/** A soft smoke ring: opaque where it faces the camera, feathered at its silhouette. */
const RING_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    float facing = abs(dot(normalize(vN), normalize(vV)));
    float a = uOpacity * pow(facing, 1.6);
    gl_FragColor = vec4(uColor * (0.75 + 0.25 * facing), a);
  }
`;

interface SmokeRing {
  mesh: THREE.Mesh<THREE.TorusGeometry, THREE.ShaderMaterial>;
  t: number;
  duration: number;
  from: number;
  to: number;
  y: number;
  climb: number;
}

/** Broccoli Head: one enormous drag on the vape (he puffs up), then the exhale. */
class Vape extends TransformStyle {
  readonly id = 'vape' as const;
  readonly choreo: Choreo = {
    stagger: STAGGER,
    // Woozy and swaying while he holds it in; arms up as the cloud bursts out.
    charge: { clip: 'stunned', from: 0, rate: 0.7, alt: 'idle' },
    burst: { clip: 'victory', from: 0.6, rate: 0.7, alt: 'castBig' },
    slam: SLAM,
  };
  private readonly rings: SmokeRing[] = [];
  private readonly vapor = new THREE.Color(0xe6f5e2);
  private readonly cloud = new THREE.Color(0xd5e4d2);

  constructor(kit: StyleKit, motion: Motion) {
    super(kit, motion);
    const geo = new THREE.TorusGeometry(1, 0.13, 12, 56).rotateX(Math.PI / 2);
    for (let i = 0; i < 2; i++) {
      const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
        vertexShader: RING_VERT, fragmentShader: RING_FRAG,
        uniforms: { uColor: { value: new THREE.Color(0xeaf5e6) }, uOpacity: { value: 0 } },
        transparent: true, depthWrite: false,
      }));
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 11;
      mesh.name = 'cine:smokeRing';
      kit.game.renderer.scene.add(mesh);
      this.rings.push({ mesh, t: 0, duration: 1, from: 0.4, to: 6, y: 0, climb: 0 });
    }
  }

  begin(s: ShotView): void {
    this.cue(s, 'inhale');
  }

  body(s: ShotView, f: Beat, b: Body): void {
    if (s.burst || s.t < f.tStag) return;
    // He fills up with vapour.
    const k = Math.pow(smooth(f.tStag, f.tBurst, s.t), 1.5);
    b.sx *= 1 + S.vape.inflate * k;
    b.sy *= 1 + S.vape.inflate * 0.3 * k;
  }

  update(s: ShotView, f: Beat): void {
    if (s.burst || s.t < f.tStag) return;
    const fx = this.game.fx;
    const k = f.charge;
    const z = this.size(s);
    const tip = this.muzzle(s, f, 'vape', 0.8, tmpA);
    const v = s.w.visual;
    const vi = v.muzzleOfType('vape');
    if (vi >= 0) v.flare(vi, 0.5 + 0.5 * k);
    // The drag: vapour pulled in from all round into the tip.
    const n = Math.round((30 + 60 * k) * f.run + Math.random() * 0.5);
    for (let i = 0; i < n; i++) {
      tmpB.set(rnd(-1, 1), rnd(-0.4, 1), rnd(-1, 1)).normalize().multiplyScalar(rnd(1.5, 2.6) * z);
      fx.smoke.emit(tip.x + tmpB.x, tip.y + tmpB.y, tip.z + tmpB.z, -tmpB.x * 2.4, -tmpB.y * 2.4, -tmpB.z * 2.4,
        this.vapor, 0.9, 0.28 * z, 0.4, { sizeEnd: 0.05 });
    }
    // He rises on a cushion of cloud.
    const m = Math.round((12 + 20 * k) * f.run + Math.random() * 0.5);
    for (let i = 0; i < m; i++) {
      const a = Math.random() * Math.PI * 2, r = rnd(0.2, 1.1) * z;
      fx.smoke.emit(f.base.x + Math.sin(a) * r, f.base.y + s.rise * 0.2 + 0.1, f.base.z + Math.cos(a) * r,
        Math.sin(a) * 0.9, rnd(0.1, 0.4), Math.cos(a) * 0.9, this.cloud, 0.85, 0.7 * z, rnd(0.9, 1.3), { drag: 0.8, sizeEnd: 1.9 * z });
    }
  }

  burst(s: ShotView, f: Beat): void {
    const fx = this.game.fx;
    const z = this.size(s);
    const tip = this.muzzle(s, f, 'vape', 0.8, tmpA);
    // The exhale: a cloud blown out all round (fast, so the new form shows through it) and a smoke ring.
    const n = Math.round(S.vape.puffs[s.tier] * (0.6 + 0.4 * s.light));
    for (let i = 0; i < n; i++) {
      tmpB.set(rnd(-1, 1), rnd(-0.1, 0.8), rnd(-1, 1)).normalize().multiplyScalar(rnd(8, 13));
      fx.smoke.emit(tip.x, tip.y, tip.z, tmpB.x, tmpB.y, tmpB.z, this.cloud, 0.8, 0.5 * z, rnd(0.9, 1.4), { drag: 2.4, gravity: -0.6, sizeEnd: 2 * z });
    }
    this.startRing(tip.y, 0.5 * z, S.vape.ringRadius[s.tier] * z, 1.6, 1.4, f.base);
    const florets = this.ring(s, 'floret', 'bolt', 1.4, S.vape.florets[s.tier], () => {});
    for (const p of florets) p.pos.copy(tip);
    this.scatter(florets, f, [5, 9], [4, 8], 12, 0.3, 1.3);
    this.cue(s, 'exhale');
    this.cue(s, 'crunch', 0.8);
  }

  slam(s: ShotView, f: Beat): void {
    const fx = this.game.fx;
    const z = this.size(s);
    this.startRing(0.35, 0.4 * z, S.vape.ringRadius[s.tier] * 0.7 * z, 0.9, 0.3, f.base);
    for (let i = 0; i < 30; i++) {
      const a = (i / 30) * Math.PI * 2, sp = rnd(5, 8);
      fx.smoke.emit(f.base.x, 0.25, f.base.z, Math.sin(a) * sp, rnd(0.2, 1), Math.cos(a) * sp, this.cloud, 0.9, 0.6 * z, 1.1, { drag: 2.4, sizeEnd: 2 * z });
    }
    this.cue(s, 'thud');
  }

  private startRing(y: number, from: number, to: number, duration: number, climb: number, at: THREE.Vector3): void {
    const r = this.rings.find((x) => !x.mesh.visible) ?? this.rings[0];
    Object.assign(r, { t: 0, duration, from, to, y, climb });
    r.mesh.position.set(at.x, y, at.z);
    r.mesh.visible = true;
  }

  tick(run: number): void {
    for (const r of this.rings) {
      if (!r.mesh.visible) continue;
      r.t += run;
      const p = r.t / r.duration;
      if (p >= 1) {
        r.mesh.visible = false;
        continue;
      }
      const e = 1 - (1 - p) * (1 - p);
      const R = r.from + (r.to - r.from) * e;
      r.mesh.scale.set(R, Math.max(0.6, R * 0.6), R);
      r.mesh.position.y = r.y + r.climb * e;
      r.mesh.rotation.y += run * 0.8;
      r.mesh.material.uniforms.uOpacity.value = 0.85 * (1 - p) * (1 - p) * smooth(0, 0.08, p);
    }
  }

  reset(): void {
    super.reset();
    for (const r of this.rings) r.mesh.visible = false;
  }
}

// ------------------------------------------------------------------ Glowie

/** Glowie: glitches in place under laser sights, then empties a magazine into the sky. */
class Glitch extends TransformStyle {
  readonly id = 'glitch' as const;
  readonly choreo: Choreo = {
    stagger: STAGGER,
    // Guns up and aimed through the charge.
    charge: { clip: 'castBig', from: 0.2, to: 0.62 },
    burst: { clip: 'castBig', from: 0.62, rate: 0.5 },
    slam: SLAM,
  };
  private readonly lasers: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>[] = [];
  private readonly laserMat: THREE.MeshBasicMaterial;
  private readonly scan: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  private readonly casings: Debris;
  private nextSnap = 0;
  private ox = 0;
  private oz = 0;
  private oyaw = 0;
  private nextBeep = 0;
  private shotsLeft = 0;
  private nextShot = 0;
  private shotEvery = 0.05;
  /** Real seconds until the last casing thrown has gone (the pool is hidden after). */
  private casingTime = 0;
  private readonly pixel = new THREE.Color(0x9fe8ff);
  private readonly brass = new THREE.Color(0xffd27a);

  constructor(kit: StyleKit, motion: Motion) {
    super(kit, motion);
    const scene = kit.game.renderer.scene;
    this.laserMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.15, 0.1), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const beam = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5);
    for (let i = 0; i < S.glitch.lasers; i++) {
      const m = new THREE.Mesh(beam, this.laserMat);
      m.visible = false;
      m.frustumCulled = false;
      m.renderOrder = 12;
      m.name = 'cine:laser';
      scene.add(m);
      this.lasers.push(m);
    }
    this.scan = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 1, 48, 1, true),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 1.6, 2.2), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
    );
    this.scan.visible = false;
    this.scan.frustumCulled = false;
    this.scan.renderOrder = 12;
    this.scan.name = 'cine:scan';
    scene.add(this.scan);
    const casing = new THREE.CylinderGeometry(0.035, 0.035, 0.11, 8);
    const brass = new THREE.MeshStandardMaterial({ color: 0xc8963a, metalness: 0.85, roughness: 0.3, emissive: 0x2a1a00 });
    this.casings = new Debris(scene, 64, brass, casing, 0.035);
    this.casings.visible = false;
  }

  private throwCasing(at: THREE.Vector3, vx: number, vy: number, vz: number, life: number): void {
    this.casings.visible = true;
    this.casingTime = Math.max(this.casingTime, life);
    this.casings.throw(at, vx, vy, vz, 1, life);
  }

  protected custom(s: ShotView, f: Beat, anim: Animator): boolean {
    const since = s.t - f.tBurst;
    if (!s.burst || since > 0.85) return false;
    // Firing: the cast's thrust snapping forward with every shot.
    const ph = (since / this.shotEvery) % 1;
    return anim.direct('cast', 0.36 + 0.16 * (1 - ph), 0.04);
  }

  begin(s: ShotView): void {
    this.nextSnap = 0;
    this.ox = this.oz = this.oyaw = 0;
    this.nextBeep = 0;
    this.shotsLeft = 0;
    for (const l of this.lasers) l.visible = true;
    this.scan.visible = true;
    this.cue(s, 'glitch');
  }

  body(s: ShotView, f: Beat, b: Body): void {
    const since = s.burst ? s.t - f.tBurst : -1;
    const glitching = (!s.burst && s.t >= f.tStag) || (since >= 0 && since < 0.35);
    if (!glitching) {
      this.ox = this.oz = this.oyaw = 0;
      return;
    }
    const k = s.burst ? 0.5 : f.charge;
    if (s.t >= this.nextSnap) {
      // A snap: he skips to a nearby spot and heading, as if frames went missing.
      const G = S.glitch;
      this.nextSnap = s.t + G.snapEvery * rnd(0.6, 1.4) / (0.6 + k);
      const a = Math.random() * Math.PI * 2, r = G.snapDistance * (0.3 + k) * Math.sqrt(Math.random());
      this.ox = Math.sin(a) * r;
      this.oz = Math.cos(a) * r;
      this.oyaw = (Math.random() - 0.5) * Math.PI * 0.7 * k;
      this.pixels(s, f, 10 + Math.round(16 * k));
    }
    b.dx += this.ox;
    b.dz += this.oz;
    // No smooth spin: only the snaps turn him.
    b.yaw = this.oyaw;
  }

  /** Bright square-ish motes off his body (dropped pixels). */
  private pixels(s: ShotView, f: Beat, n: number): void {
    const fx = this.game.fx;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = rnd(0.2, 0.55) * this.size(s);
      fx.sparks.emit(f.base.x + this.ox + Math.sin(a) * r, f.base.y + s.rise + rnd(0.1, 1) * s.height, f.base.z + this.oz + Math.cos(a) * r,
        Math.sin(a) * rnd(0.5, 2), rnd(-0.5, 0.5), Math.cos(a) * rnd(0.5, 2), this.pixel, 1.6, rnd(0.06, 0.12), rnd(0.15, 0.3), { drag: 4 });
    }
  }

  update(s: ShotView, f: Beat): void {
    const k = f.charge;
    if (!s.burst) {
      // Laser sights sweeping the room from his gun, and a scanner running up and down him.
      const gun = this.muzzle(s, f, 'gun', 0.55, tmpA);
      const on = smooth(f.tStag, f.tStag + 0.4, s.t);
      this.laserMat.opacity = 0.85 * on;
      const n = this.lasers.length;
      for (let i = 0; i < n; i++) {
        const yaw = f.time * (0.7 + 0.25 * i) * (i % 2 ? -1 : 1) + (i / n) * Math.PI * 2;
        const pitch = -0.04 + 0.07 * Math.sin(f.time * 1.3 + i * 1.7);
        const l = this.lasers[i];
        l.position.copy(gun);
        tmpB.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).add(gun);
        l.lookAt(tmpB);
        l.scale.set(0.028, 0.028, 32);
      }
      const v = s.w.visual;
      const R = v.boundsRadius * v.root.scale.x * 1.3;
      this.scan.position.set(f.base.x + this.ox, f.base.y + s.rise + s.height * (0.5 + 0.47 * Math.sin(f.time * 4.5)), f.base.z + this.oz);
      this.scan.scale.set(R, 0.045 * s.height, R);
      this.scan.material.opacity = 0.9 * on;
      // Target-lock beeps, faster and higher as it builds.
      if (s.t >= this.nextBeep && s.t >= f.tStag) {
        this.nextBeep = s.t + 0.45 - 0.3 * k;
        this.cue(s, 'beep', 0.9 + 0.6 * k);
      }
    }
    // Full auto into the air after the burst.
    while (this.shotsLeft > 0 && s.t >= this.nextShot) {
      this.fire(s, f);
      this.shotsLeft--;
      this.nextShot += this.shotEvery;
    }
  }

  private fire(s: ShotView, f: Beat): void {
    const fx = this.game.fx;
    const v = s.w.visual;
    const gi = v.muzzleOfType('gun');
    const gun = this.muzzle(s, f, 'gun', 0.55, tmpA);
    const yaw = Math.random() * Math.PI * 2, pitch = rnd(0.6, 1.25);
    tmpB.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    fx.muzzleFlash(gun, tmpB, s.boss.palette.spell, 0.7 * this.size(s), 5 * s.light, 0.045);
    if (gi >= 0) v.flare(gi, 1);
    const p = this.props.take('bullet', 'bolt', s.w, 1.2);
    if (p) {
      p.pos.copy(gun);
      p.group.position.copy(gun);
      this.props.launch(p, tmpB.x * 55, tmpB.y * 55, tmpB.z * 55, 0, 0, 0.45);
    }
    // The casing kicks out sideways.
    const side = yaw + Math.PI / 2;
    this.throwCasing(gun, Math.sin(side) * rnd(1.5, 3), rnd(2.5, 4), Math.cos(side) * rnd(1.5, 3), 2.4);
    feel.shake(0.05);
    this.cue(s, 'gunfire', rnd(0.92, 1.08));
  }

  burst(s: ShotView, f: Beat): void {
    for (const l of this.lasers) l.visible = false;
    this.scan.visible = false;
    this.shotsLeft = S.glitch.shots[s.tier];
    this.shotEvery = 0.75 / this.shotsLeft;
    this.nextShot = s.t;
    this.kit.flash('glitch', 0.35);
    this.pixels(s, f, 40);
    tmpA.set(f.base.x, f.base.y + s.rise + s.height * 0.6, f.base.z);
    this.game.fx.sparks.burst(tmpA, 30, this.brass, 1.6, 3, 9, 0.1, 0.5, { drag: 2 });
    this.cue(s, 'glitch', 0.7);
  }

  slam(s: ShotView, f: Beat): void {
    // The magazine's worth of casings comes down round him.
    const n = S.glitch.casings[s.tier];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, r = rnd(0.4, 2.4);
      tmpA.set(f.base.x + Math.sin(a) * r, s.height * rnd(1.2, 2.4), f.base.z + Math.cos(a) * r);
      this.throwCasing(tmpA, rnd(-1, 1), rnd(-2, 0), rnd(-1, 1), rnd(1.6, 2.6));
    }
    this.cue(s, 'casing');
  }

  tick(run: number): void {
    if (this.casingTime <= 0) return;
    this.casings.update(run);
    this.casingTime -= run;
    if (this.casingTime <= 0) {
      this.casings.clear();
      this.casings.visible = false;
    }
  }

  end(): void {
    super.end();
    this.shotsLeft = 0;
    for (const l of this.lasers) l.visible = false;
    this.scan.visible = false;
  }

  reset(): void {
    super.reset();
    this.casings.clear();
    this.casings.visible = false;
    this.casingTime = 0;
  }
}

// ------------------------------------------------------------------ Tinubu

const FLOOR_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
/** A summoning circle: rings, a band of glyphs and spokes, turning. */
const SIGIL_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uSpin;
  varying vec2 vUv;
  float h(float n) { return fract(sin(n) * 43758.5453); }
  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    if (r > 1.0) discard;
    float w = fwidth(r) * 1.5;
    float rings = smoothstep(w + 0.012, 0.0, abs(r - 0.96)) + smoothstep(w + 0.008, 0.0, abs(r - 0.84)) + smoothstep(w + 0.008, 0.0, abs(r - 0.5));
    float a = atan(p.y, p.x);
    // Glyphs: a band of short marks between the outer rings, turning one way...
    float g = (a + uSpin) / 6.28318 * 40.0;
    float id = floor(g), f = fract(g);
    float band = step(0.86, r) * step(r, 0.94);
    float glyph = band * step(0.3, f) * step(f, 0.7) * step(0.3, h(id)) * step(0.35, fract((r - 0.86) / 0.08 * 2.0 + h(id + 3.0)));
    // ...and seven spokes inside, turning the other.
    float s = (a - uSpin * 0.6) / 6.28318 * 7.0;
    float spoke = smoothstep(0.035, 0.0, abs(fract(s) - 0.5) * r * 0.9) * step(0.5, r) * step(r, 0.84);
    float core = smoothstep(0.5, 0.0, r) * 0.25;
    float m = clamp(rings + glyph * 0.9 + spoke * 0.8 + core, 0.0, 1.0) * uOpacity;
    gl_FragColor = vec4(uColor * m, m);
  }
`;
/** A column of fire: noise flames scrolling up, fading toward its top. */
const COLUMN_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uHot;
  uniform float uOpacity;
  uniform float uTime;
  varying vec2 vUv;
  float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  // Value noise that wraps every 10 cells round the column.
  float n(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    vec2 i1 = vec2(mod(i.x + 1.0, 10.0), i.y);
    i.x = mod(i.x, 10.0);
    return mix(mix(h(i), h(vec2(i1.x, i.y)), f.x), mix(h(i + vec2(0.0, 1.0)), h(vec2(i1.x, i.y + 1.0)), f.x), f.y);
  }
  void main() {
    vec2 q = vec2(vUv.x * 10.0, vUv.y * 4.0 - uTime * 2.6);
    float f = n(q) * 0.62 + n(q * 2.0 + vec2(3.0, 0.0)) * 0.38;
    float base = smoothstep(0.0, 0.06, vUv.y);
    float flame = smoothstep(0.38, 0.8, f + (1.0 - vUv.y) * 0.5) * base * (1.0 - smoothstep(0.55, 1.0, vUv.y + f * 0.25));
    vec3 col = mix(uColor, uHot, smoothstep(0.6, 1.0, f + (1.0 - vUv.y) * 0.35));
    float a = flame * uOpacity;
    gl_FragColor = vec4(col * a, a);
  }
`;

/** Tinubu: a circle opens under him, hellfire rises, skulls circle; it erupts. */
class Hellfire extends TransformStyle {
  readonly id = 'hellfire' as const;
  readonly choreo: Choreo = {
    stagger: STAGGER,
    // Arms raised, summoning; the roar at the burst.
    charge: { clip: 'victory', from: 0.4, rate: 0.55, alt: 'castBig' },
    burst: { clip: 'castBig', from: 0.5, to: 0.95 },
    slam: SLAM,
  };
  private readonly sigil: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly column: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>;
  private skulls: Prop[] = [];
  private spin = 0;
  private nextBreath = 0;
  /** Seconds since the slam's flash of the circle (-1: none), and the circle's fade after the shot. */
  private flashT = -1;
  private fade = 0;
  private readonly ember = new THREE.Color(0xff7a1a);
  private readonly hot = new THREE.Color(0xffd36a);
  private readonly soot = new THREE.Color(0x2a1612);

  constructor(kit: StyleKit, motion: Motion) {
    super(kit, motion);
    const scene = kit.game.renderer.scene;
    this.sigil = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2),
      new THREE.ShaderMaterial({
        vertexShader: FLOOR_VERT, fragmentShader: SIGIL_FRAG,
        uniforms: { uColor: { value: new THREE.Color() }, uOpacity: { value: 0 }, uSpin: { value: 0 } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      }),
    );
    this.sigil.visible = false;
    this.sigil.renderOrder = 7;
    this.sigil.name = 'cine:sigil';
    scene.add(this.sigil);
    this.column = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1.15, 1, 40, 1, true).translate(0, 0.5, 0),
      new THREE.ShaderMaterial({
        vertexShader: FLOOR_VERT, fragmentShader: COLUMN_FRAG,
        uniforms: { uColor: { value: new THREE.Color(0xff3a10) }, uHot: { value: new THREE.Color(0xffc24a) }, uOpacity: { value: 0 }, uTime: { value: 0 } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
      }),
    );
    this.column.visible = false;
    this.column.frustumCulled = false;
    this.column.renderOrder = 12;
    this.column.name = 'cine:hellfire';
    scene.add(this.column);
  }

  begin(s: ShotView, f: Beat): void {
    this.spin = 0;
    this.nextBreath = f.tStag;
    this.flashT = -1;
    this.fade = 0;
    this.skulls = this.ring(s, 'skull', 'blast', 0.42, S.hellfire.skulls[s.tier], (p, i) => {
      p.orbitR = 1.7 + (i % 2) * 0.35;
      p.orbitY = 0.55 + 0.25 * (i % 3);
      p.orbitSpeed = rnd(1.0, 1.3);
    });
    this.sigil.material.uniforms.uColor.value.setHex(s.color).multiplyScalar(1.6 * (0.6 + 0.4 * s.light));
    this.sigil.position.set(f.base.x, 0.05, f.base.z);
    this.sigil.visible = true;
    this.column.visible = true;
    this.cue(s, 'fire', 0.7);
  }

  update(s: ShotView, f: Beat): void {
    const fx = this.game.fx;
    const k = f.charge;
    const z = this.size(s);
    this.spin += f.run * (0.6 + 0.8 * k);
    // The circle opens under him and turns.
    const open = easeOut3((s.t - f.tStag * 0.5) / (f.tBurst * 0.55));
    const R = S.hellfire.circleRadius * z * Math.max(0.01, open);
    this.sigil.scale.set(R, 1, R);
    const su = this.sigil.material.uniforms;
    su.uSpin.value = f.time * 0.7;
    const flash = this.flashT >= 0 ? Math.exp(-(s.t - this.flashT) * 3) : 0;
    su.uOpacity.value = (0.75 + 0.25 * Math.sin(f.time * 7)) * open + 0.8 * flash;
    // The column: rising with the charge, then the eruption at the burst.
    const cu = this.column.material.uniforms;
    cu.uTime.value = f.time;
    const v = s.w.visual;
    const width = v.boundsRadius * v.root.scale.x * 1.7 + 0.25;
    const since = s.burst ? s.t - f.tBurst : -1;
    let height: number, alpha: number, wide = 1;
    if (since < 0) {
      height = S.hellfire.columnHeight * 0.35 * k * z;
      alpha = 0.34 * k * (0.6 + 0.4 * s.light);
    } else {
      // Bursts up to full height and fades fast, so the new form reads through it.
      height = S.hellfire.columnHeight * z * (0.35 + 0.65 * easeOut3(since / 0.15));
      wide = 1 + 0.6 * easeOut3(since / 0.2);
      alpha = 0.5 * Math.exp(-since * 9) * (0.6 + 0.4 * s.light);
    }
    this.column.position.set(f.base.x, f.base.y, f.base.z);
    this.column.scale.set(width * wide, Math.max(0.01, height), width * wide);
    cu.uOpacity.value = alpha;
    this.column.visible = alpha > 0.004;
    if (s.burst) return;
    this.orbit(this.skulls, s, f, this.spin, 0.15, 0.7);
    // Embers rising off the circle.
    const n = Math.round((30 + 80 * k) * f.run * (0.6 + 0.4 * s.light) + Math.random() * 0.5);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * R;
      fx.sparks.emit(f.base.x + Math.sin(a) * r, 0.1, f.base.z + Math.cos(a) * r, rnd(-0.4, 0.4), rnd(1.5, 4.5), rnd(-0.4, 0.4),
        Math.random() < 0.3 ? this.hot : this.ember, 2, rnd(0.07, 0.14), rnd(0.8, 1.5), { gravity: -2.5, drag: 0.6 });
    }
    // Fire from his mouth, again and again.
    if (s.t >= this.nextBreath && s.t >= f.tStag) {
      this.nextBreath = s.t + S.hellfire.breathEvery;
      const mouth = this.muzzle(s, f, 'mouth', 0.85, tmpA);
      const root = v.root;
      const fwdX = Math.sin(root.rotation.y), fwdZ = Math.cos(root.rotation.y);
      for (let i = 0; i < 26; i++) {
        fx.sparks.emit(mouth.x, mouth.y, mouth.z, fwdX * rnd(2, 5) + rnd(-1, 1), rnd(4, 8), fwdZ * rnd(2, 5) + rnd(-1, 1),
          i % 3 ? this.ember : this.hot, 2.4, rnd(0.12, 0.22) * z, rnd(0.35, 0.6), { drag: 2, gravity: -1 });
      }
      fx.smoke.emit(mouth.x, mouth.y + 0.3, mouth.z, fwdX, 3, fwdZ, this.soot, 0.6, 0.5 * z, 0.9, { drag: 1.5, gravity: -1, sizeEnd: 1.6 * z });
      this.cue(s, 'fire', rnd(0.9, 1.15));
    }
  }

  burst(s: ShotView, f: Beat): void {
    const fx = this.game.fx;
    this.scatter(this.skulls, f, [6, 10], [5, 9], 9, 0.5, 1.4);
    tmpA.set(f.base.x, f.base.y + s.rise + s.height * 0.5, f.base.z);
    const n = Math.round(110 * s.tier * (0.5 + 0.5 * s.light));
    tmpC.copy(this.ember);
    fx.sparks.burst(tmpA, n, tmpC, 2, 4, 13, 0.16, 0.9, { gravity: -1, drag: 1.2 });
    for (let i = 0; i < 16; i++) {
      tmpB.set(rnd(-1, 1), rnd(0.2, 1), rnd(-1, 1)).normalize().multiplyScalar(rnd(3, 6));
      fx.smoke.emit(tmpA.x, tmpA.y, tmpA.z, tmpB.x, tmpB.y, tmpB.z, this.soot, 0.7, 0.8, 1.4, { drag: 1.8, gravity: -1.2, sizeEnd: 2.6 });
    }
    this.cue(s, 'roar');
  }

  slam(s: ShotView, f: Beat): void {
    const fx = this.game.fx;
    const R = S.hellfire.circleRadius * this.size(s);
    // Fire erupts all round the circle.
    for (let j = 0; j < 8; j++) {
      const a = (j / 8) * Math.PI * 2 + this.spin;
      const x = f.base.x + Math.sin(a) * R, z = f.base.z + Math.cos(a) * R;
      for (let i = 0; i < 18; i++) {
        tmpC2.copy(i % 3 ? this.ember : this.hot);
        fx.sparks.emit(x, 0.15, z, rnd(-1, 1), rnd(6, 11), rnd(-1, 1), tmpC2, 2.2, rnd(0.12, 0.2), rnd(0.5, 0.9), { gravity: 9, drag: 0.8 });
      }
      fx.smoke.emit(x, 0.4, z, 0, 3, 0, this.soot, 0.6, 0.7, 1.2, { drag: 1.2, gravity: -1, sizeEnd: 2.2 });
    }
    this.flashT = s.t;
    this.cue(s, 'fire', 0.75);
  }

  tick(run: number): void {
    // The circle fades out after the shot.
    if (this.fade > 0) {
      this.fade = Math.max(0, this.fade - run);
      this.sigil.material.uniforms.uOpacity.value = this.fade / 1.2;
      this.sigil.visible = this.fade > 0;
    }
  }

  end(): void {
    super.end();
    this.skulls = [];
    this.column.visible = false;
    if (this.sigil.visible && this.fade <= 0) this.fade = 1.2;
  }

  reset(): void {
    super.reset();
    this.fade = 0;
    this.sigil.visible = false;
  }
}

// ------------------------------------------------------------------ registry

/** Build every style once (their meshes join the scene hidden and are compiled by the warm-up). */
export function createStyles(kit: StyleKit): Record<TransformStyleId, TransformStyle> {
  return {
    bazaar: new Bazaar(kit, S.bazaar),
    shill: new Shill(kit, S.shill),
    tantrum: new Tantrum(kit, S.tantrum),
    vape: new Vape(kit, S.vape),
    glitch: new Glitch(kit, S.glitch),
    hellfire: new Hellfire(kit, S.hellfire),
  };
}
