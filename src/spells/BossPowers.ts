import * as THREE from 'three';
import { CONFIG } from '../config';
import { events, type GameEvents } from '../core/events';
import { feel } from '../core/feel';
import { clamp, wrapAngle } from '../core/math';
import type { Arena } from '../arena/Arena';
import type { PowerDef } from '../campaign/levels';
import type { Physics } from '../physics/Physics';
import type { Wizard } from '../wizard/Wizard';

const P = CONFIG.powers;
const J = CONFIG.wizard.jump;

/** What part of a power a hazard is: a circle on the floor, a shockwave, the sweep, the cone, a seeker. */
export type HazardKind = 'zone' | 'flash' | 'cloud' | 'ring' | 'sweep' | 'cone' | 'seeker';

type Of<K extends PowerDef['kind']> = Extract<PowerDef, { kind: K }>;

/**
 * One telegraphed piece of a power in play (pooled): a strike's reticle, one barrage drop or march
 * eruption, one shockwave, the sweep, the cone, one seeker, the flashbang, the toxic cloud.
 */
export class Hazard {
  active = false;
  /** Unique per hazard (effects key on it). */
  id = 0;
  kind: HazardKind = 'zone';
  power: PowerDef = null!;
  owner: Wizard = null!;
  target: Wizard | null = null;
  /** Its place in its power's cast (march order, barrage drop, ring, seeker). */
  index = 0;
  /** Seconds before it appears at all (barrage drops, later rings and seekers). */
  delay = 0;
  /** A barrage drop is placed round the target when it appears. */
  placeOnAppear = false;
  /** Centre (zones) or origin (rings, sweep, cone); a seeker's position. */
  readonly at = new THREE.Vector3();
  /** Zone radius; ring front radius; sweep and cone length. */
  radius = 1;
  /** A strike's reticle follows the target this much longer before it locks. */
  track = 0;
  /** Seconds of telegraph left, and its full length. */
  warn = 0;
  warnTotal = 1;
  /** Seconds live after the telegraph (ring, sweep, cloud, seeker), and how long it lives. */
  t = 0;
  life = 0;
  /** Ring and seeker speed (m/s). */
  speed = 0;
  /** Cone and sweep heading (rad, atan2(x, z)); the sweep's start heading, arc (rad) and turn direction. */
  angle = 0;
  start = 0;
  arc = 0;
  dir = 1;
  /** Ring radius or sweep heading at the previous tick. */
  prev = 0;
  /** Fired (detonated, blasted, rolling out); a fired zone or cone stays `linger` s for its effects. */
  fired = false;
  linger = 0;
  /** Wizards it already hit, or that evaded it. */
  readonly done: Wizard[] = [];
  /** Seeker flight. */
  readonly vel = new THREE.Vector3();
  /** A seeker rolled through can't hit again until this sim time. */
  passUntil = 0;
  /** Seconds to the next toxic-cloud damage tick. */
  tick = 0;
  /** AI bookkeeping (bits by wizard index): noticed this hazard, and decided to react to it. */
  seen = 0;
  heeded = 0;

  /** Seconds until it hits (a zone detonates, a cone blasts), from now; Infinity while a strike still tracks. */
  get firesIn(): number {
    if (this.delay > 0 || this.track > 0) return Infinity;
    return this.fired ? 0 : this.warn;
  }
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const tmpEvent = new THREE.Vector3();

type Damage = (target: Wizard, source: Wizard | null, amount: number, point: THREE.Vector3, kind: 'power' | 'toxic', knockDir?: THREE.Vector3, knockback?: number) => number;
type Callout = (pos: THREE.Vector3, text: string, style: GameEvents['callout']['style']) => void;

/**
 * Boss special powers (each boss's `powers` in levels.ts, CONFIG.powers). A boss's AI starts one
 * (`cast`) when it has recharged and the target is in range; it becomes hazards that telegraph on
 * the floor for a moment, then fire: zones detonate, rings and the sweep roll out, the cone blasts,
 * seekers chase, the flashbang pops, the toxic cloud lingers. Each is evaded its own way (see
 * levels.ts PowerDef), and rolling (i-frames) evades every one: an "EVADED" callout and the
 * `dodgeEvade` event, like the Ultimate. Nothing hurts its own side. Sim time only: the freeze of a
 * cinematic, hit-stop and pause stop it. A transforming or KO'd boss's hazards are called off.
 * Effects and sounds follow the `bossPower` events (PowerFx, AudioManager, HUD).
 */
export class BossPowers {
  /** Hazards in play (and the free ones: check `active`). */
  readonly hazards: Hazard[] = [];
  private readonly free: Hazard[] = [];
  /** Seconds until each power can be used again, per caster. */
  private readonly cds = new Map<Wizard, Map<PowerDef, number>>();
  private time = 0;
  /** Sim time the last power (anyone's) was started. */
  private lastAt = -1e9;
  private nextId = 1;

  constructor(
    private readonly physics: Physics,
    private readonly wizards: Wizard[],
    private readonly arena: Arena,
    /** SpellSystem.dealDamage. */
    private readonly damage: Damage,
    private readonly callout: Callout,
  ) {}

  // ------------------------------------------------------------------ recharge

  /** Seconds until `w` can use `def` again (0: ready). */
  cooldown(w: Wizard, def: PowerDef): number {
    return this.cds.get(w)?.get(def) ?? 0;
  }

  setCooldown(w: Wizard, def: PowerDef, seconds: number): void {
    let m = this.cds.get(w);
    if (!m) this.cds.set(w, (m = new Map()));
    m.set(def, Math.max(0, seconds));
  }

  /** The recharge `def` starts with after use in boss stage `stage` (0-2). */
  recharge(def: PowerDef, stage: number): number {
    return def.cooldown * P.stageRecharge[clamp(stage, 0, 2)];
  }

  /** The gap since anyone's last power has passed (a double fight's bosses take turns). */
  get open(): boolean {
    return this.time - this.lastAt >= P.gap;
  }

  /** `w` is winding up or channelling a power it stands still for (the cone, the sweep, its rings). */
  channeling(w: Wizard): boolean {
    for (const h of this.hazards) {
      if (!h.active || h.owner !== w) continue;
      if ((h.kind === 'cone' || h.kind === 'ring') && !h.fired && h.index === 0) return true;
      if (h.kind === 'sweep') return true;
    }
    return false;
  }

  /** The heading a channelling `w` faces (the cone's, the sweep beam's), or null. */
  channelFacing(w: Wizard): number | null {
    for (const h of this.hazards) {
      if (h.active && h.owner === w && (h.kind === 'cone' || h.kind === 'sweep')) return h.angle;
    }
    return null;
  }

  /** `w`'s `def` is playing out right now. */
  firing(w: Wizard, def: PowerDef): boolean {
    for (const h of this.hazards) if (h.active && h.owner === w && h.power === def) return true;
    return false;
  }

  /** `w` has a power still playing out (it starts no other until it is done). */
  busy(w: Wizard): boolean {
    for (const h of this.hazards) if (h.active && h.owner === w) return true;
    return false;
  }

  // ------------------------------------------------------------------ casting

  /**
   * `w` (a boss in stage `stage`) uses `def` on `target`: it starts recharging and its hazards
   * telegraph. False if it isn't ready, `w` can't act or the target is down.
   */
  cast(w: Wizard, def: PowerDef, target: Wizard, stage: number): boolean {
    if (!w.canAct || !w.alive || !target.alive || this.cooldown(w, def) > 0) return false;
    this.setCooldown(w, def, this.recharge(def, stage));
    this.lastAt = this.time;
    w.castPulse = 1;
    w.sinceAttack = 0;
    const heading = Math.atan2(target.pos.x - w.pos.x, target.pos.z - w.pos.z);
    switch (def.kind) {
      case 'strike': {
        const h = this.take('zone', def, w, target);
        h.at.set(target.pos.x, 0, target.pos.z);
        h.radius = def.radius;
        h.track = def.track;
        h.warn = h.warnTotal = def.warn;
        break;
      }
      case 'barrage':
        for (let i = 0; i < def.count; i++) {
          const h = this.take('zone', def, w, target, i);
          h.delay = (i / def.count) * def.duration;
          h.placeOnAppear = true;
          h.radius = def.radius;
          h.warn = h.warnTotal = def.warn;
          if (i === 0) this.place(h, def);
        }
        break;
      case 'march': {
        const dx = Math.sin(heading), dz = Math.cos(heading);
        const limit = this.arena.fireRadius - 0.5;
        for (let i = 0; i < def.count; i++) {
          const d = 1.8 + i * def.spacing;
          const x = w.pos.x + dx * d, z = w.pos.z + dz * d;
          if (Math.hypot(x, z) > limit) break;
          const h = this.take('zone', def, w, target, i);
          h.at.set(x, 0, z);
          h.radius = def.radius;
          h.warn = h.warnTotal = def.warn + i * def.step;
        }
        break;
      }
      case 'rings':
        for (let i = 0; i < def.count; i++) {
          const h = this.take('ring', def, w, target, i);
          h.at.set(w.pos.x, 0, w.pos.z);
          h.radius = 0;
          h.speed = def.speed;
          h.life = def.maxRadius;
          h.warn = h.warnTotal = def.warn + i * def.interval;
        }
        break;
      case 'sweep': {
        const h = this.take('sweep', def, w, target);
        h.at.set(w.pos.x, 0, w.pos.z);
        h.radius = def.length;
        h.arc = THREE.MathUtils.degToRad(def.arc);
        h.dir = Math.random() < 0.5 ? 1 : -1;
        // It passes through the target halfway.
        h.start = h.angle = h.prev = heading - (h.dir * h.arc) / 2;
        h.life = def.duration;
        h.warn = h.warnTotal = def.warn;
        break;
      }
      case 'cone': {
        const h = this.take('cone', def, w, target);
        h.at.set(w.pos.x, 0, w.pos.z);
        h.radius = def.length;
        h.angle = heading;
        h.arc = THREE.MathUtils.degToRad(def.angle);
        h.warn = h.warnTotal = def.warn;
        break;
      }
      case 'seekers':
        for (let i = 0; i < def.count; i++) {
          const h = this.take('seeker', def, w, target, i);
          h.delay = i * 0.18;
          h.speed = def.speed;
          h.life = def.life;
          h.warn = h.warnTotal = 0;
          w.chest(h.at);
          // Fanned out and up; they curve in.
          const fan = (def.count > 1 ? i / (def.count - 1) - 0.5 : 0) * 1.6;
          h.vel.set(Math.sin(heading + fan), 0.45, Math.cos(heading + fan)).normalize().multiplyScalar(def.speed);
        }
        break;
      case 'flash': {
        const h = this.take('flash', def, w, target);
        // It lands a step or two off the target.
        const a = Math.random() * Math.PI * 2, r = 1 + Math.random();
        h.at.set(target.pos.x + Math.sin(a) * r, 0, target.pos.z + Math.cos(a) * r);
        this.inside(h.at, 0.5);
        h.radius = def.radius;
        h.warn = h.warnTotal = def.warn;
        break;
      }
      case 'cloud': {
        const h = this.take('cloud', def, w, target);
        h.at.set(target.pos.x, 0, target.pos.z);
        h.radius = def.radius;
        h.warn = h.warnTotal = def.warn;
        h.life = def.life;
        break;
      }
    }
    this.emit(w, def, 'cast', w.chest(tmpEvent), 0);
    return true;
  }

  /** A pooled hazard, set up for `def` cast by `owner`. */
  private take(kind: HazardKind, def: PowerDef, owner: Wizard, target: Wizard, index = 0): Hazard {
    const h = this.free.pop() ?? new Hazard();
    h.active = true;
    h.id = this.nextId++;
    h.kind = kind;
    h.power = def;
    h.owner = owner;
    h.target = target;
    h.index = index;
    h.delay = h.track = h.t = h.life = h.speed = h.linger = h.tick = h.passUntil = 0;
    h.prev = h.angle = h.start = h.arc = 0;
    h.dir = 1;
    h.placeOnAppear = h.fired = false;
    h.done.length = 0;
    h.seen = h.heeded = 0;
    this.hazards.push(h);
    return h;
  }

  /** Put a barrage drop round its target: the first right on it, the rest where it's heading and round it. */
  private place(h: Hazard, def: Of<'barrage'>): void {
    const t = h.target!;
    if (h.index === 0) h.at.set(t.pos.x, 0, t.pos.z);
    else {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * def.spread;
      const lead = 0.5 + Math.random() * 0.6;
      h.at.set(t.pos.x + t.vel.x * lead + Math.sin(a) * r, 0, t.pos.z + t.vel.z * lead + Math.cos(a) * r);
    }
    this.inside(h.at, h.radius * 0.5);
  }

  /** Keep a point inside the fire ring (`margin` m in). */
  private inside(p: THREE.Vector3, margin: number): void {
    const r = Math.hypot(p.x, p.z), max = this.arena.fireRadius - margin;
    if (r > max) p.multiplyScalar(max / r);
  }

  // ------------------------------------------------------------------ update

  update(dt: number): void {
    this.time += dt;
    for (const m of this.cds.values()) {
      for (const [def, left] of m) if (left > 0) m.set(def, Math.max(0, left - dt));
    }
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const h = this.hazards[i];
      // A KO'd or transforming boss's powers are called off.
      if (!h.owner.alive || h.owner.evolving) {
        this.release(i);
        continue;
      }
      if (h.delay > 0) {
        h.delay -= dt;
        if (h.delay > 0) continue;
        if (h.placeOnAppear && h.power.kind === 'barrage') this.place(h, h.power);
        if (h.kind === 'seeker') {
          h.owner.chest(h.at);
          this.emit(h.owner, h.power, 'fire', h.at, h.id);
        }
      }
      let keep = true;
      switch (h.kind) {
        case 'zone':
        case 'flash':
        case 'cloud':
          keep = this.updateZone(h, dt);
          break;
        case 'ring':
          keep = this.updateRing(h, dt);
          break;
        case 'sweep':
          keep = this.updateSweep(h, dt);
          break;
        case 'cone':
          keep = this.updateCone(h, dt);
          break;
        case 'seeker':
          keep = this.updateSeeker(h, dt);
          break;
      }
      if (!keep) this.release(i);
    }
  }

  private updateZone(h: Hazard, dt: number): boolean {
    if (h.fired) {
      if (h.kind === 'cloud') return this.updateCloud(h, dt);
      h.linger -= dt;
      return h.linger > 0;
    }
    if (h.track > 0) {
      // The reticle follows the target, a step behind, then locks.
      const t = h.target;
      if (t && t.alive) {
        const k = 1 - Math.exp(-7 * dt);
        h.at.x += (t.pos.x - h.at.x) * k;
        h.at.z += (t.pos.z - h.at.z) * k;
      }
      h.track -= dt;
      if (h.track <= 0) this.emit(h.owner, h.power, 'lock', h.at, h.id);
      return true;
    }
    h.warn -= dt;
    if (h.warn > 0) return true;
    h.fired = true;
    h.linger = 0.4;
    if (h.kind === 'flash') this.pop(h);
    else if (h.kind === 'zone') this.detonate(h);
    this.emit(h.owner, h.power, 'fire', h.at, h.id);
    return true;
  }

  /** A strike, a barrage drop or a march eruption lands: everyone (else) in the circle is hit. */
  private detonate(h: Hazard): void {
    for (const o of this.wizards) {
      if (!this.hittable(h, o)) continue;
      const d = Math.hypot(o.pos.x - h.at.x, o.pos.z - h.at.z);
      if (d > h.radius + o.radius * P.zoneGrace) continue;
      if (o.invulnerable) {
        this.evaded(h, o);
        continue;
      }
      tmpDir.set(o.pos.x - h.at.x, 0, o.pos.z - h.at.z);
      if (tmpDir.lengthSq() < 1e-4) tmpDir.set(Math.sin(o.facing), 0, Math.cos(o.facing)).negate();
      this.hit(h, o, h.power.damage, tmpDir.normalize(), P.knockback.zone);
    }
  }

  /** The flashbang pops: anyone in range, in its line of sight and looking at it is blinded. */
  private pop(h: Hazard): void {
    const def = h.power as Of<'flash'>;
    tmpA.set(h.at.x, 0.6, h.at.z);
    for (const o of this.wizards) {
      if (!this.hittable(h, o)) continue;
      if (Math.hypot(o.pos.x - h.at.x, o.pos.z - h.at.z) > h.radius) continue;
      const eye = o.chest(tmpB);
      if (!this.physics.lineOfSight(tmpA, eye)) continue;
      if (o.invulnerable) {
        this.evaded(h, o);
        continue;
      }
      const toward = Math.atan2(h.at.x - o.pos.x, h.at.z - o.pos.z);
      if (Math.abs(wrapAngle(toward - o.facing)) > THREE.MathUtils.degToRad(def.facing) / 2) {
        h.done.push(o);
        this.callout(eye, 'LOOKED AWAY', 'perfect');
        events.emit('dodgeEvade', { wizard: o, pos: eye.clone() });
        continue;
      }
      this.hit(h, o, def.damage, null, 0);
      if (o.alive) {
        o.applyStun(def.stun);
        if (o.stunned) {
          events.emit('stunned', { wizard: o });
          this.callout(o.chest(tmpB), 'BLINDED', 'stun');
        }
      }
    }
  }

  /** A toxic cloud standing: everyone (else) inside takes its damage per second, in ticks. */
  private updateCloud(h: Hazard, dt: number): boolean {
    h.t += dt;
    if (h.t >= h.life) return false;
    h.tick -= dt;
    if (h.tick > 0) return true;
    h.tick += P.cloudTick;
    for (const o of this.wizards) {
      if (o.side === h.owner.side || !o.alive || o.invulnerable || o.airHeight > P.cloudHeight) continue;
      if (Math.hypot(o.pos.x - h.at.x, o.pos.z - h.at.z) > h.radius) continue;
      this.damage(o, h.owner, h.power.damage * P.damageScale * P.cloudTick, o.chest(tmpB), 'toxic');
    }
    return true;
  }

  private updateRing(h: Hazard, dt: number): boolean {
    if (!h.fired) {
      h.warn -= dt;
      if (h.warn > 0) return true;
      h.fired = true;
      this.emit(h.owner, h.power, 'fire', h.at, h.id);
    }
    h.prev = h.radius;
    h.radius += h.speed * dt;
    for (const o of this.wizards) {
      if (!this.hittable(h, o)) continue;
      const d = Math.hypot(o.pos.x - h.at.x, o.pos.z - h.at.z) - o.radius;
      if (d > h.radius || d < h.prev - 1) continue;
      this.lowHit(h, o, P.knockback.ring);
    }
    return h.radius < h.life;
  }

  private updateSweep(h: Hazard, dt: number): boolean {
    if (!h.fired) {
      h.warn -= dt;
      if (h.warn > 0) return true;
      h.fired = true;
      this.emit(h.owner, h.power, 'fire', h.at, h.id);
    }
    h.t += dt;
    h.prev = h.angle;
    h.angle = h.start + h.dir * h.arc * Math.min(1, h.t / h.life);
    const swept = Math.abs(wrapAngle(h.angle - h.prev));
    for (const o of this.wizards) {
      if (!this.hittable(h, o)) continue;
      const d = Math.hypot(o.pos.x - h.at.x, o.pos.z - h.at.z);
      if (d > h.radius + o.radius || d < 0.3) continue;
      // Did the beam cross it this tick (its heading, give or take its body)?
      const a = Math.atan2(o.pos.x - h.at.x, o.pos.z - h.at.z);
      const body = Math.atan2(o.radius, d);
      const into = wrapAngle(a - h.prev) * h.dir;
      if (into < -body || into > swept + body) continue;
      this.lowHit(h, o, P.knockback.sweep);
    }
    return h.t < h.life;
  }

  private updateCone(h: Hazard, dt: number): boolean {
    if (h.fired) {
      h.linger -= dt;
      return h.linger > 0;
    }
    h.warn -= dt;
    if (h.warn > 0) return true;
    h.fired = true;
    h.linger = 0.5;
    this.emit(h.owner, h.power, 'fire', h.at, h.id);
    const def = h.power as Of<'cone'>;
    const from = h.owner.chest(tmpA);
    for (const o of this.wizards) {
      if (!this.hittable(h, o)) continue;
      const dx = o.pos.x - h.at.x, dz = o.pos.z - h.at.z;
      const d = Math.hypot(dx, dz);
      if (d > h.radius + o.radius) continue;
      const off = Math.abs(wrapAngle(Math.atan2(dx, dz) - h.angle)) - Math.atan2(o.radius, Math.max(d, 0.5));
      if (off > h.arc / 2) continue;
      if (o.invulnerable) {
        this.evaded(h, o);
        continue;
      }
      const chest = o.chest(tmpB);
      if (!this.physics.clearPath(from, chest)) {
        h.done.push(o);
        this.callout(chest, 'COVER', 'info');
        continue;
      }
      tmpDir.set(Math.sin(h.angle), 0, Math.cos(h.angle));
      let damage = def.damage, knock = def.knockback;
      if (o.shielded) {
        damage *= 0.5;
        knock *= 0.4;
        o.visual.shieldImpact(false);
        this.callout(chest, 'BLOCK', 'block');
      }
      this.hit(h, o, damage, tmpDir, knock);
    }
    return true;
  }

  private updateSeeker(h: Hazard, dt: number): boolean {
    h.t += dt;
    if (h.t >= h.life) {
      this.emit(h.owner, h.power, 'end', h.at, h.id);
      return false;
    }
    const t = h.target;
    if (t && t.alive) {
      // Turn toward the target's chest at a limited rate: a late roll makes it overshoot.
      const want = t.chest(tmpA).sub(h.at).normalize();
      const cur = tmpB.copy(h.vel).normalize();
      const turn = (h.power as Of<'seekers'>).turn * dt;
      const dot = clamp(cur.dot(want), -1, 1);
      const ang = Math.acos(dot);
      if (ang > 1e-4) cur.lerp(want, Math.min(1, turn / ang)).normalize();
      h.vel.copy(cur).multiplyScalar(h.speed);
    }
    tmpA.copy(h.at).addScaledVector(h.vel, dt);
    if (tmpA.y < 0.35) tmpA.y = 0.35;
    // Cover stops it.
    if (!this.physics.clearPath(h.at, tmpA)) {
      this.emit(h.owner, h.power, 'end', h.at, h.id);
      return false;
    }
    h.at.copy(tmpA);
    for (const o of this.wizards) {
      if (o.side === h.owner.side || !o.alive) continue;
      const chest = o.chest(tmpB);
      if (chest.distanceTo(h.at) > P.seekerRadius + o.radius) continue;
      if (this.time < h.passUntil) continue;
      if (o.invulnerable) {
        // Rolled through: it loses its lock and flies on.
        h.passUntil = this.time + P.seekerPass;
        if (h.target === o) h.target = null;
        this.callout(chest, 'EVADED', 'perfect');
        events.emit('dodgeEvade', { wizard: o, pos: chest.clone() });
        continue;
      }
      if (o.shielded) {
        o.visual.shieldImpact(false);
        this.callout(chest, 'BLOCK', 'block');
        events.emit('block', { wizard: o, pos: chest.clone(), perfect: false, spell: 'bolt' });
        this.emit(h.owner, h.power, 'end', h.at, h.id);
        return false;
      }
      tmpDir.copy(h.vel).setY(0).normalize();
      this.hit(h, o, h.power.damage, tmpDir, 3);
      if ((h.power as Of<'seekers'>).drain && o.alive) {
        // Infected: it drains mana and ends a golden-ticket boost ("sell your tickets").
        o.mana = Math.max(0, o.mana - P.drainMana);
        o.manaBoost = 0;
        this.callout(o.chest(tmpB), 'INFECTED', 'stun');
      }
      this.emit(h.owner, h.power, 'end', h.at, h.id);
      return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ hits

  /** `o` could be hit by `h` now (an enemy of its caster, standing, not already hit or evaded). */
  private hittable(h: Hazard, o: Wizard): boolean {
    return o.side !== h.owner.side && o.alive && !h.done.includes(o);
  }

  /** A ring or the sweep reaches `o`: jumped (feet above the clearance) or rolled, else hit, unless cover is in the way. */
  private lowHit(h: Hazard, o: Wizard, knock: number): void {
    const chest = o.chest(tmpB);
    // Rolled, jumped clear, or skimming over it on the Magic Carpet.
    if (o.invulnerable || o.airHeight >= J.waveClearance || o.riding) {
      this.evaded(h, o);
      return;
    }
    tmpA.set(h.at.x, 0.5, h.at.z);
    if (!this.physics.clearPath(tmpA, tmpEvent.set(o.pos.x, 0.5, o.pos.z))) {
      h.done.push(o);
      this.callout(chest, 'COVER', 'info');
      return;
    }
    tmpDir.set(o.pos.x - h.at.x, 0, o.pos.z - h.at.z).normalize();
    this.hit(h, o, h.power.damage, tmpDir, knock);
  }

  private hit(h: Hazard, o: Wizard, amount: number, knockDir: THREE.Vector3 | null, knock: number): void {
    h.done.push(o);
    const chest = o.chest(tmpB);
    this.damage(o, h.owner, amount * P.damageScale, chest, 'power', knockDir ?? undefined, knockDir ? knock : 0);
    feel.freeze(P.hitStopMs);
    feel.shakeAt(chest, P.shake);
  }

  private evaded(h: Hazard, o: Wizard): void {
    h.done.push(o);
    const chest = o.chest(tmpB);
    this.callout(chest, 'EVADED', 'perfect');
    events.emit('dodgeEvade', { wizard: o, pos: chest.clone() });
  }

  private emit(w: Wizard, power: PowerDef, phase: GameEvents['bossPower']['phase'], pos: THREE.Vector3, hazard: number): void {
    events.emit('bossPower', { wizard: w, power, phase, pos: pos.clone(), hazard });
  }

  // ------------------------------------------------------------------ lifetime

  private release(i: number): void {
    const h = this.hazards[i];
    h.active = false;
    this.hazards[i] = this.hazards[this.hazards.length - 1];
    this.hazards.pop();
    this.free.push(h);
  }

  /** Call off everything `w` has in play (a partner leaving, a round reset). */
  cancel(w: Wizard): void {
    for (let i = this.hazards.length - 1; i >= 0; i--) if (this.hazards[i].owner === w) this.release(i);
  }

  /** Clear everything: hazards, recharges and the gap. */
  clear(): void {
    for (let i = this.hazards.length - 1; i >= 0; i--) this.release(i);
    this.cds.clear();
    this.lastAt = -1e9;
  }
}
