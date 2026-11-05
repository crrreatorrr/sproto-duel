/**
 * Boss special powers in the sim: the deterministic port of src/spells/BossPowers.ts (strike,
 * barrage, march, rings, sweep, cone, seekers, flash, cloud).
 *
 * A boss's AI starts one (`cast`) when it has recharged and the target is in range; it becomes
 * hazards that telegraph on the floor for a moment, then fire: zones detonate, rings and the sweep
 * roll out, the cone blasts, seekers chase, the flashbang pops, the toxic cloud lingers. Rolling
 * (i-frames) evades every one. Nothing hurts its own side. A transforming or KO'd boss's hazards
 * are called off.
 *
 * Units: distances and speeds Q16, time TU, angles 1/65536 turn (yaw = atan2(x, z)). PowerDef
 * numbers (seconds, metres, degrees) are converted once per def (`conv`).
 *
 * Presentation events (the game's `bossPower`, callouts and `dodgeEvade`):
 * - 'bossPower': w owner, s phase ('cast' | 'lock' | 'fire' | 'end'), n hazard id (0 on cast),
 *   o the power's index in the owner's boss `powers`, x/y/z position.
 * - 'evaded' (EVADED + dodgeEvade), 'lookedAway' (LOOKED AWAY + dodgeEvade), 'cover' (COVER),
 *   'block' (BLOCK, s = 'power', n = hazard id), 'stunned' + 'blinded' (BLINDED), 'infected'
 *   (INFECTED): w the wizard, at its chest.
 * - 'powerHit': w the wizard hit, o the caster, n hazard id, at its chest (hit-stop and shake).
 */
import { CONFIG } from '../config';
import type { PowerDef } from '../campaign/levels';
import { HALF, ONE, TU, TURN, abs, atan2, clamp, cos, deg, fx, isqrt, len2, len3, max, min, mul, muldiv, rad, sec, setLength3, sin, vt, wrapAngle, type V3 } from './fixed';
import type { SimWizard } from './wizard';
import type { SimWorld } from './world';

const P = CONFIG.powers;
const J = CONFIG.wizard.jump;

export type HazardKind = 'zone' | 'flash' | 'cloud' | 'ring' | 'sweep' | 'cone' | 'seeker';

/** One telegraphed piece of a power in play (BossPowers Hazard), in sim units (Q16, TU, angle units). */
export interface SimHazard {
  active: boolean;
  id: number;
  kind: HazardKind;
  power: PowerDef;
  owner: SimWizard;
  target: SimWizard | null;
  index: number;
  /** TU before it appears. */
  delay: number;
  placeOnAppear: boolean;
  readonly at: V3;
  radius: number;
  track: number;
  warn: number;
  warnTotal: number;
  t: number;
  /** TU live (sweep, cloud, seeker); a ring's farthest radius (Q16). */
  life: number;
  speed: number;
  /**
   * Headings in angle units (yaw: atan2(x, z)); arc in angle units; dir +1/-1. A sweep's headings
   * are not wrapped (they run from `start` through `start + dir * arc`): wrap before comparing.
   */
  angle: number;
  start: number;
  arc: number;
  dir: number;
  prev: number;
  fired: boolean;
  linger: number;
  /** Wizard indices it already hit or that evaded it. */
  done: number[];
  readonly vel: V3;
  passUntil: number;
  tick: number;
  /** AI bookkeeping (bits by wizard index): noticed this hazard, and decided to react to it. */
  seen: number;
  heeded: number;
}

/** `firesIn` of a hazard that is not counting down yet (Infinity in the game). */
export const NEVER = 0x7fffffff;

/** TU until `h` hits (a zone detonates, a cone blasts), from now; NEVER while it waits or a strike still tracks. */
export function firesIn(h: SimHazard): number {
  if (h.delay > 0 || h.track > 0) return NEVER;
  return h.fired ? 0 : h.warn;
}

// ------------------------------------------------------------------ constants

const STAGE_RECHARGE = P.stageRecharge;
const GAP = sec(P.gap);
const ZONE_GRACE = fx(P.zoneGrace);
const KNOCK_ZONE = fx(P.knockback.zone);
const KNOCK_RING = fx(P.knockback.ring);
const KNOCK_SWEEP = fx(P.knockback.sweep);
const KNOCK_SEEKER = fx(3);
const CLOUD_TICK = sec(P.cloudTick);
const CLOUD_HEIGHT = fx(P.cloudHeight);
const SEEKER_R = fx(P.seekerRadius);
const SEEKER_PASS = sec(P.seekerPass);
const DRAIN_MANA = fx(P.drainMana);
const WAVE_CLEAR = fx(J.waveClearance);
/** 1 - exp(-7 dt) for one 60 Hz tick: a strike reticle closing on its target. */
const TRACK_K = 7217;
const SEEKER_DELAY = sec(0.18);
const SEEKER_FAN = rad(1.6);
const SEEKER_UP = fx(0.45);
const SEEKER_FLOOR = fx(0.35);
const MARCH_FIRST = fx(1.8);
const RING_EDGE = fx(0.5);
const FLASH_MARGIN = fx(0.5);
const FLASH_EYE = fx(0.6);
const LOW_Y = fx(0.5);
const SWEEP_MIN = fx(0.3);
const CONE_MIN = fx(0.5);
const NEAR = fx(0.01);
const LINGER_ZONE = sec(0.4);
const LINGER_CONE = sec(0.5);
const SHIELD_KNOCK = fx(0.4);
const FAR_PAST = -1000000000;
const K_0_6 = fx(0.6);

/** A PowerDef's numbers in sim units (converted once per def). */
interface Conv {
  /** Damage per hit after CONFIG.powers.damageScale (Q16); a cloud's per damage tick. */
  damage: number;
  /** Recharge (TU) by boss stage. */
  recharge: number[];
  radius: number;
  track: number;
  warn: number;
  spread: number;
  duration: number;
  spacing: number;
  step: number;
  interval: number;
  speed: number;
  maxRadius: number;
  length: number;
  /** Sweep arc, cone angle, flash facing (angle units). */
  arc: number;
  knockback: number;
  /** Seeker turn rate (angle units per second). */
  turn: number;
  life: number;
  stun: number;
}

function convert(def: PowerDef): Conv {
  const d = def as PowerDef & Record<string, number | undefined>;
  const n = (k: string): number => (typeof d[k] === 'number' ? (d[k] as number) : 0);
  let arc = 0;
  if (def.kind === 'sweep') arc = deg(def.arc);
  else if (def.kind === 'cone') arc = deg(def.angle);
  else if (def.kind === 'flash') arc = deg(def.facing);
  return {
    damage: def.kind === 'cloud' ? fx(def.damage * P.damageScale * P.cloudTick) : fx(def.damage * P.damageScale),
    recharge: [sec(def.cooldown * STAGE_RECHARGE[0]), sec(def.cooldown * STAGE_RECHARGE[1]), sec(def.cooldown * STAGE_RECHARGE[2])],
    radius: fx(n('radius')),
    track: sec(n('track')),
    warn: sec(n('warn')),
    spread: fx(n('spread')),
    duration: sec(n('duration')),
    spacing: fx(n('spacing')),
    step: sec(n('step')),
    interval: sec(n('interval')),
    speed: fx(n('speed')),
    maxRadius: fx(n('maxRadius')),
    length: fx(n('length')),
    arc,
    knockback: fx(n('knockback')),
    turn: rad(n('turn')),
    life: sec(n('life')),
    stun: sec(n('stun')),
  };
}

function newHazard(): SimHazard {
  return {
    active: false, id: 0, kind: 'zone', power: null as unknown as PowerDef, owner: null as unknown as SimWizard, target: null, index: 0,
    delay: 0, placeOnAppear: false, at: { x: 0, y: 0, z: 0 }, radius: 0, track: 0, warn: 0, warnTotal: 1, t: 0, life: 0, speed: 0,
    angle: 0, start: 0, arc: 0, dir: 1, prev: 0, fired: false, linger: 0, done: [], vel: { x: 0, y: 0, z: 0 }, passUntil: 0, tick: 0,
    seen: 0, heeded: 0,
  };
}

const tmpA: V3 = { x: 0, y: 0, z: 0 };
const tmpB: V3 = { x: 0, y: 0, z: 0 };
const tmpDir: V3 = { x: 0, y: 0, z: 0 };
const tmpEvent: V3 = { x: 0, y: 0, z: 0 };

function chestOf(w: SimWizard, out: V3): V3 {
  out.x = w.pos.x;
  out.y = w.pos.y + w.chestY;
  out.z = w.pos.z;
  return out;
}

export class SimPowers {
  /** Hazards in play (swap-removed like the game's pool, so iteration order matches). */
  readonly hazards: SimHazard[] = [];
  private readonly free: SimHazard[] = [];
  /** Recharges: caster index, def, TU left (parallel arrays). */
  private readonly cdWho: number[] = [];
  private readonly cdDef: PowerDef[] = [];
  private readonly cdLeft: number[] = [];
  /** Converted defs (parallel arrays). */
  private readonly convDefs: PowerDef[] = [];
  private readonly convs: Conv[] = [];
  /** Sim time (TU) and when the last power (anyone's) was started. */
  private time = 0;
  private lastAt = FAR_PAST;
  private nextId = 1;

  constructor(protected readonly world: SimWorld) {}

  /** `def` in sim units. */
  conv(def: PowerDef): Conv {
    const i = this.convDefs.indexOf(def);
    if (i >= 0) return this.convs[i];
    const c = convert(def);
    this.convDefs.push(def);
    this.convs.push(c);
    return c;
  }

  // ------------------------------------------------------------------ recharge

  private cdSlot(w: SimWizard, def: PowerDef): number {
    for (let i = 0; i < this.cdDef.length; i++) if (this.cdDef[i] === def && this.cdWho[i] === w.index) return i;
    return -1;
  }

  /** TU until `w` can use `def` again (0: ready). */
  cooldown(w: SimWizard, def: PowerDef): number {
    const i = this.cdSlot(w, def);
    return i >= 0 ? this.cdLeft[i] : 0;
  }

  setCooldown(w: SimWizard, def: PowerDef, tu: number): void {
    const i = this.cdSlot(w, def);
    const v = max(0, tu);
    if (i >= 0) this.cdLeft[i] = v;
    else {
      this.cdWho.push(w.index);
      this.cdDef.push(def);
      this.cdLeft.push(v);
    }
  }

  /** The recharge (TU) `def` starts with after use in boss stage `stage`. */
  recharge(def: PowerDef, stage: number): number {
    return this.conv(def).recharge[clamp(stage, 0, 2)];
  }

  /** CONFIG.powers.gap has passed since anyone's last power. */
  get open(): boolean {
    return this.time - this.lastAt >= GAP;
  }

  /** `w` is winding up or channelling a power it stands still for (the cone, the sweep, its rings). */
  channeling(w: SimWizard): boolean {
    for (let i = 0; i < this.hazards.length; i++) {
      const h = this.hazards[i];
      if (!h.active || h.owner !== w) continue;
      if ((h.kind === 'cone' || h.kind === 'ring') && !h.fired && h.index === 0) return true;
      if (h.kind === 'sweep') return true;
    }
    return false;
  }

  /** The yaw (angle units, 0..TURN) a channelling caster faces, or -1. */
  channelFacing(w: SimWizard): number {
    for (let i = 0; i < this.hazards.length; i++) {
      const h = this.hazards[i];
      if (h.active && h.owner === w && (h.kind === 'cone' || h.kind === 'sweep')) {
        let a = h.angle % TURN;
        if (a < 0) a += TURN;
        return a;
      }
    }
    return -1;
  }

  /** `w`'s `def` is playing out right now. */
  firing(w: SimWizard, def: PowerDef): boolean {
    for (let i = 0; i < this.hazards.length; i++) {
      const h = this.hazards[i];
      if (h.active && h.owner === w && h.power === def) return true;
    }
    return false;
  }

  /** `w` has a power still playing out (it starts no other until it is done). */
  busy(w: SimWizard): boolean {
    for (let i = 0; i < this.hazards.length; i++) if (this.hazards[i].active && this.hazards[i].owner === w) return true;
    return false;
  }

  // ------------------------------------------------------------------ casting

  /**
   * `w` (a boss in stage `stage`) uses `def` on `target`: it starts recharging and its hazards
   * telegraph. False if it isn't ready, `w` can't act or the target is down.
   */
  cast(w: SimWizard, def: PowerDef, target: SimWizard, stage: number): boolean {
    if (!w.canAct || !w.alive || !target.alive || this.cooldown(w, def) > 0) return false;
    const c = this.conv(def);
    this.setCooldown(w, def, this.recharge(def, stage));
    this.lastAt = this.time;
    w.castPulse = ONE;
    w.sinceAttack = 0;
    const rng = this.world.rng;
    const heading = atan2(target.pos.x - w.pos.x, target.pos.z - w.pos.z);
    switch (def.kind) {
      case 'strike': {
        const h = this.take('zone', def, w, target, 0);
        h.at.x = target.pos.x;
        h.at.y = 0;
        h.at.z = target.pos.z;
        h.radius = c.radius;
        h.track = c.track;
        h.warn = h.warnTotal = c.warn;
        break;
      }
      case 'barrage':
        for (let i = 0; i < def.count; i++) {
          const h = this.take('zone', def, w, target, i);
          h.delay = muldiv(i, c.duration, def.count);
          h.placeOnAppear = true;
          h.radius = c.radius;
          h.warn = h.warnTotal = c.warn;
          if (i === 0) this.place(h, c);
        }
        break;
      case 'march': {
        const dx = sin(heading), dz = cos(heading);
        const limit = this.world.arena.fireRadius - RING_EDGE;
        for (let i = 0; i < def.count; i++) {
          const d = MARCH_FIRST + i * c.spacing;
          const x = w.pos.x + mul(dx, d), z = w.pos.z + mul(dz, d);
          if (len2(x, z) > limit) break;
          const h = this.take('zone', def, w, target, i);
          h.at.x = x;
          h.at.y = 0;
          h.at.z = z;
          h.radius = c.radius;
          h.warn = h.warnTotal = c.warn + i * c.step;
        }
        break;
      }
      case 'rings':
        for (let i = 0; i < def.count; i++) {
          const h = this.take('ring', def, w, target, i);
          h.at.x = w.pos.x;
          h.at.y = 0;
          h.at.z = w.pos.z;
          h.radius = 0;
          h.speed = c.speed;
          h.life = c.maxRadius;
          h.warn = h.warnTotal = c.warn + i * c.interval;
        }
        break;
      case 'sweep': {
        const h = this.take('sweep', def, w, target, 0);
        h.at.x = w.pos.x;
        h.at.y = 0;
        h.at.z = w.pos.z;
        h.radius = c.length;
        h.arc = c.arc;
        h.dir = rng.chance(HALF) ? 1 : -1;
        // It passes through the target halfway.
        h.start = h.angle = h.prev = heading - h.dir * (h.arc >> 1);
        h.life = c.duration;
        h.warn = h.warnTotal = c.warn;
        break;
      }
      case 'cone': {
        const h = this.take('cone', def, w, target, 0);
        h.at.x = w.pos.x;
        h.at.y = 0;
        h.at.z = w.pos.z;
        h.radius = c.length;
        h.angle = heading;
        h.arc = c.arc;
        h.warn = h.warnTotal = c.warn;
        break;
      }
      case 'seekers':
        for (let i = 0; i < def.count; i++) {
          const h = this.take('seeker', def, w, target, i);
          h.delay = i * SEEKER_DELAY;
          h.speed = c.speed;
          h.life = c.life;
          h.warn = h.warnTotal = 0;
          chestOf(w, h.at);
          // Fanned out and up; they curve in.
          const fan = def.count > 1 ? muldiv(i, SEEKER_FAN, def.count - 1) - (SEEKER_FAN >> 1) : 0;
          const a = heading + fan;
          if (!setLength3(h.vel, sin(a), SEEKER_UP, cos(a), c.speed)) h.vel.x = h.vel.y = h.vel.z = 0;
        }
        break;
      case 'flash': {
        const h = this.take('flash', def, w, target, 0);
        // It lands a step or two off the target.
        const a = rng.frac(), r = ONE + rng.frac();
        h.at.x = target.pos.x + mul(sin(a), r);
        h.at.y = 0;
        h.at.z = target.pos.z + mul(cos(a), r);
        this.inside(h.at, FLASH_MARGIN);
        h.radius = c.radius;
        h.warn = h.warnTotal = c.warn;
        break;
      }
      case 'cloud': {
        const h = this.take('cloud', def, w, target, 0);
        h.at.x = target.pos.x;
        h.at.y = 0;
        h.at.z = target.pos.z;
        h.radius = c.radius;
        h.warn = h.warnTotal = c.warn;
        h.life = c.life;
        break;
      }
    }
    this.emit(w, def, 'cast', chestOf(w, tmpEvent), 0);
    return true;
  }

  /** A pooled hazard, set up for `def` cast by `owner`. */
  private take(kind: HazardKind, def: PowerDef, owner: SimWizard, target: SimWizard, index: number): SimHazard {
    const h = this.free.length ? (this.free.pop() as SimHazard) : newHazard();
    h.active = true;
    h.id = this.nextId++;
    h.kind = kind;
    h.power = def;
    h.owner = owner;
    h.target = target;
    h.index = index;
    h.delay = h.track = h.t = h.life = h.speed = h.linger = h.tick = h.passUntil = 0;
    h.prev = h.angle = h.start = h.arc = 0;
    h.radius = 0;
    h.warn = 0;
    h.warnTotal = 1;
    h.dir = 1;
    h.placeOnAppear = h.fired = false;
    h.done.length = 0;
    h.seen = h.heeded = 0;
    h.at.x = h.at.y = h.at.z = 0;
    h.vel.x = h.vel.y = h.vel.z = 0;
    this.hazards.push(h);
    return h;
  }

  /** Put a barrage drop round its target: the first right on it, the rest where it's heading and round it. */
  private place(h: SimHazard, c: Conv): void {
    const t = h.target as SimWizard;
    if (h.index === 0) {
      h.at.x = t.pos.x;
      h.at.z = t.pos.z;
    } else {
      const rng = this.world.rng;
      const a = rng.frac();
      const r = mul(isqrt(rng.frac() * ONE), c.spread);
      const lead = HALF + mul(rng.frac(), K_0_6);
      h.at.x = t.pos.x + mul(t.vel.x, lead) + mul(sin(a), r);
      h.at.z = t.pos.z + mul(t.vel.z, lead) + mul(cos(a), r);
    }
    h.at.y = 0;
    this.inside(h.at, h.radius >> 1);
  }

  /** Keep a point inside the fire ring (`margin` in). */
  private inside(p: V3, margin: number): void {
    const r = len2(p.x, p.z), lim = this.world.arena.fireRadius - margin;
    if (r > lim && r > 0) {
      p.x = muldiv(p.x, lim, r);
      p.y = muldiv(p.y, lim, r);
      p.z = muldiv(p.z, lim, r);
    }
  }

  // ------------------------------------------------------------------ update

  update(dt: number): void {
    this.time += dt;
    for (let i = 0; i < this.cdLeft.length; i++) if (this.cdLeft[i] > 0) this.cdLeft[i] = max(0, this.cdLeft[i] - dt);
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      if (i >= this.hazards.length) continue;
      const h = this.hazards[i];
      // A KO'd or transforming boss's powers are called off.
      if (!h.owner.alive || h.owner.evolving) {
        this.release(i);
        continue;
      }
      if (h.delay > 0) {
        h.delay -= dt;
        if (h.delay > 0) continue;
        if (h.placeOnAppear && h.power.kind === 'barrage') this.place(h, this.conv(h.power));
        if (h.kind === 'seeker') {
          chestOf(h.owner, h.at);
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
      // A hit can end the round (and clear everything) mid-loop.
      if (!keep && h.active && this.hazards[i] === h) this.release(i);
    }
  }

  private updateZone(h: SimHazard, dt: number): boolean {
    if (h.fired) {
      if (h.kind === 'cloud') return this.updateCloud(h, dt);
      h.linger -= dt;
      return h.linger > 0;
    }
    if (h.track > 0) {
      // The reticle follows the target, a step behind, then locks.
      const t = h.target;
      if (t && t.alive) {
        const k = dt === 100 ? TRACK_K : clamp(muldiv(TRACK_K, dt, 100), 0, ONE);
        h.at.x += mul(t.pos.x - h.at.x, k);
        h.at.z += mul(t.pos.z - h.at.z, k);
      }
      h.track -= dt;
      if (h.track <= 0) this.emit(h.owner, h.power, 'lock', h.at, h.id);
      return true;
    }
    h.warn -= dt;
    if (h.warn > 0) return true;
    h.fired = true;
    h.linger = LINGER_ZONE;
    if (h.kind === 'flash') this.pop(h);
    else if (h.kind === 'zone') this.detonate(h);
    this.emit(h.owner, h.power, 'fire', h.at, h.id);
    return true;
  }

  /** A strike, a barrage drop or a march eruption lands: everyone (else) in the circle is hit. */
  private detonate(h: SimHazard): void {
    const ws = this.world.wizards;
    const damage = this.conv(h.power).damage;
    for (let i = 0; i < ws.length; i++) {
      const o = ws[i];
      if (!this.hittable(h, o)) continue;
      const d = len2(o.pos.x - h.at.x, o.pos.z - h.at.z);
      if (d > h.radius + mul(o.radius, ZONE_GRACE)) continue;
      if (o.invulnerable) {
        this.evaded(h, o);
        continue;
      }
      tmpDir.x = o.pos.x - h.at.x;
      tmpDir.y = 0;
      tmpDir.z = o.pos.z - h.at.z;
      if (d < NEAR) {
        const f = o.face();
        tmpDir.x = -sin(f);
        tmpDir.z = -cos(f);
      }
      this.hit(h, o, damage, tmpDir, KNOCK_ZONE);
    }
  }

  /** The flashbang pops: anyone in range, in its line of sight and looking at it is blinded. */
  private pop(h: SimHazard): void {
    const c = this.conv(h.power);
    const ws = this.world.wizards;
    const ev = this.world.events;
    for (let i = 0; i < ws.length; i++) {
      const o = ws[i];
      if (!this.hittable(h, o)) continue;
      if (len2(o.pos.x - h.at.x, o.pos.z - h.at.z) > h.radius) continue;
      const eye = chestOf(o, tmpB);
      if (!this.world.arena.clear(h.at.x, FLASH_EYE, h.at.z, eye.x, eye.y, eye.z, false)) continue;
      if (o.invulnerable) {
        this.evaded(h, o);
        continue;
      }
      const toward = atan2(h.at.x - o.pos.x, h.at.z - o.pos.z);
      if (abs(wrapAngle(toward - o.face())) * 2 > c.arc) {
        h.done.push(o.index);
        ev.atPos('lookedAway', eye, o.index, '', h.id);
        continue;
      }
      this.hit(h, o, c.damage, null, 0);
      if (o.alive) {
        o.applyStun(c.stun);
        if (o.stunned) {
          ev.push('stunned', o.index);
          ev.atPos('blinded', chestOf(o, tmpB), o.index, '', h.id);
        }
      }
    }
  }

  /** A toxic cloud standing: everyone (else) inside takes its damage per second, in ticks. */
  private updateCloud(h: SimHazard, dt: number): boolean {
    h.t += dt;
    if (h.t >= h.life) return false;
    h.tick -= dt;
    if (h.tick > 0) return true;
    h.tick += CLOUD_TICK;
    const damage = this.conv(h.power).damage;
    const ws = this.world.wizards;
    for (let i = 0; i < ws.length; i++) {
      const o = ws[i];
      if (!o.active || o.side === h.owner.side || !o.alive || o.invulnerable || o.airHeight > CLOUD_HEIGHT) continue;
      if (len2(o.pos.x - h.at.x, o.pos.z - h.at.z) > h.radius) continue;
      this.world.spells.dealDamage(o, h.owner, damage, chestOf(o, tmpB), 'toxic', null, 0);
    }
    return true;
  }

  private updateRing(h: SimHazard, dt: number): boolean {
    if (!h.fired) {
      h.warn -= dt;
      if (h.warn > 0) return true;
      h.fired = true;
      this.emit(h.owner, h.power, 'fire', h.at, h.id);
    }
    h.prev = h.radius;
    h.radius += vt(h.speed, dt);
    const ws = this.world.wizards;
    for (let i = 0; i < ws.length; i++) {
      const o = ws[i];
      if (!this.hittable(h, o)) continue;
      const d = len2(o.pos.x - h.at.x, o.pos.z - h.at.z) - o.radius;
      if (d > h.radius || d < h.prev - ONE) continue;
      this.lowHit(h, o, KNOCK_RING);
    }
    return h.radius < h.life;
  }

  private updateSweep(h: SimHazard, dt: number): boolean {
    if (!h.fired) {
      h.warn -= dt;
      if (h.warn > 0) return true;
      h.fired = true;
      this.emit(h.owner, h.power, 'fire', h.at, h.id);
    }
    h.t += dt;
    h.prev = h.angle;
    h.angle = h.start + h.dir * (h.life > 0 ? muldiv(h.arc, min(h.t, h.life), h.life) : h.arc);
    const swept = abs(wrapAngle(h.angle - h.prev));
    const ws = this.world.wizards;
    for (let i = 0; i < ws.length; i++) {
      const o = ws[i];
      if (!this.hittable(h, o)) continue;
      const dx = o.pos.x - h.at.x, dz = o.pos.z - h.at.z;
      const d = len2(dx, dz);
      if (d > h.radius + o.radius || d < SWEEP_MIN) continue;
      // Did the beam cross it this tick (its heading, give or take its body)?
      const a = atan2(dx, dz);
      const body = atan2(o.radius, d);
      const into = wrapAngle(a - h.prev) * h.dir;
      if (into < -body || into > swept + body) continue;
      this.lowHit(h, o, KNOCK_SWEEP);
    }
    return h.t < h.life;
  }

  private updateCone(h: SimHazard, dt: number): boolean {
    if (h.fired) {
      h.linger -= dt;
      return h.linger > 0;
    }
    h.warn -= dt;
    if (h.warn > 0) return true;
    h.fired = true;
    h.linger = LINGER_CONE;
    this.emit(h.owner, h.power, 'fire', h.at, h.id);
    const c = this.conv(h.power);
    const from = chestOf(h.owner, tmpA);
    const ws = this.world.wizards;
    const ev = this.world.events;
    for (let i = 0; i < ws.length; i++) {
      const o = ws[i];
      if (!this.hittable(h, o)) continue;
      const dx = o.pos.x - h.at.x, dz = o.pos.z - h.at.z;
      const d = len2(dx, dz);
      if (d > h.radius + o.radius) continue;
      const off = abs(wrapAngle(atan2(dx, dz) - h.angle)) - atan2(o.radius, max(d, CONE_MIN));
      if (off * 2 > h.arc) continue;
      if (o.invulnerable) {
        this.evaded(h, o);
        continue;
      }
      const chest = chestOf(o, tmpB);
      if (!this.world.arena.clear(from.x, from.y, from.z, chest.x, chest.y, chest.z, true)) {
        h.done.push(o.index);
        ev.atPos('cover', chest, o.index, '', h.id);
        continue;
      }
      tmpDir.x = sin(h.angle);
      tmpDir.y = 0;
      tmpDir.z = cos(h.angle);
      let damage = c.damage, knock = c.knockback;
      if (o.shielded) {
        damage = mul(damage, HALF);
        knock = mul(knock, SHIELD_KNOCK);
        ev.atPos('block', chest, o.index, 'power', h.id, -1, false);
      }
      this.hit(h, o, damage, tmpDir, knock);
    }
    return true;
  }

  private updateSeeker(h: SimHazard, dt: number): boolean {
    h.t += dt;
    if (h.t >= h.life) {
      this.emit(h.owner, h.power, 'end', h.at, h.id);
      return false;
    }
    const c = this.conv(h.power);
    const t = h.target;
    if (t && t.alive) {
      // Turn toward the target's chest at a limited rate: a late roll makes it overshoot.
      chestOf(t, tmpA);
      if (setLength3(tmpA, tmpA.x - h.at.x, tmpA.y - h.at.y, tmpA.z - h.at.z, ONE) && setLength3(tmpB, h.vel.x, h.vel.y, h.vel.z, ONE)) {
        const turn = muldiv(c.turn, dt, TU);
        const dot = clamp(mul(tmpB.x, tmpA.x) + mul(tmpB.y, tmpA.y) + mul(tmpB.z, tmpA.z), -ONE, ONE);
        const cx = mul(tmpB.y, tmpA.z) - mul(tmpB.z, tmpA.y);
        const cy = mul(tmpB.z, tmpA.x) - mul(tmpB.x, tmpA.z);
        const cz = mul(tmpB.x, tmpA.y) - mul(tmpB.y, tmpA.x);
        // The angle between them (acos of the dot), in angle units: 0..HALF.
        const ang = atan2(len3(cx, cy, cz), dot);
        if (ang > 0) {
          const f = turn >= ang ? ONE : muldiv(turn, ONE, ang);
          const nx = tmpB.x + mul(tmpA.x - tmpB.x, f), ny = tmpB.y + mul(tmpA.y - tmpB.y, f), nz = tmpB.z + mul(tmpA.z - tmpB.z, f);
          // A degenerate blend (exactly opposite) keeps the old heading.
          setLength3(tmpB, nx, ny, nz, ONE);
        }
        setLength3(h.vel, tmpB.x, tmpB.y, tmpB.z, h.speed);
      }
    }
    tmpA.x = h.at.x + vt(h.vel.x, dt);
    tmpA.y = h.at.y + vt(h.vel.y, dt);
    tmpA.z = h.at.z + vt(h.vel.z, dt);
    if (tmpA.y < SEEKER_FLOOR) tmpA.y = SEEKER_FLOOR;
    // Cover stops it.
    if (!this.world.arena.clear(h.at.x, h.at.y, h.at.z, tmpA.x, tmpA.y, tmpA.z, true)) {
      this.emit(h.owner, h.power, 'end', h.at, h.id);
      return false;
    }
    h.at.x = tmpA.x;
    h.at.y = tmpA.y;
    h.at.z = tmpA.z;
    const ws = this.world.wizards;
    const ev = this.world.events;
    for (let i = 0; i < ws.length; i++) {
      const o = ws[i];
      if (!o.active || o.side === h.owner.side || !o.alive) continue;
      const chest = chestOf(o, tmpB);
      if (len3(chest.x - h.at.x, chest.y - h.at.y, chest.z - h.at.z) > SEEKER_R + o.radius) continue;
      if (this.time < h.passUntil) continue;
      if (o.invulnerable) {
        // Rolled through: it loses its lock and flies on.
        h.passUntil = this.time + SEEKER_PASS;
        if (h.target === o) h.target = null;
        ev.atPos('evaded', chest, o.index, '', h.id);
        continue;
      }
      if (o.shielded) {
        ev.atPos('block', chest, o.index, 'power', h.id, -1, false);
        this.emit(h.owner, h.power, 'end', h.at, h.id);
        return false;
      }
      tmpDir.x = h.vel.x;
      tmpDir.y = 0;
      tmpDir.z = h.vel.z;
      this.hit(h, o, c.damage, tmpDir, KNOCK_SEEKER);
      if (h.power.kind === 'seekers' && h.power.drain && o.alive) {
        // Infected: it drains mana and ends a golden-ticket boost ("sell your tickets").
        o.mana = max(0, o.mana - DRAIN_MANA);
        o.manaBoost = 0;
        ev.atPos('infected', chestOf(o, tmpB), o.index, '', h.id);
      }
      this.emit(h.owner, h.power, 'end', h.at, h.id);
      return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ hits

  /** `o` could be hit by `h` now (an enemy of its caster, standing, not already hit or evaded). */
  private hittable(h: SimHazard, o: SimWizard): boolean {
    return o.active && o.side !== h.owner.side && o.alive && h.done.indexOf(o.index) < 0;
  }

  /** A ring or the sweep reaches `o`: jumped (feet above the clearance) or rolled, else hit, unless cover is in the way. */
  private lowHit(h: SimHazard, o: SimWizard, knock: number): void {
    // Rolled, jumped clear, or skimming over it on the Magic Carpet.
    if (o.invulnerable || o.airHeight >= WAVE_CLEAR || o.riding) {
      this.evaded(h, o);
      return;
    }
    if (!this.world.arena.clear(h.at.x, LOW_Y, h.at.z, o.pos.x, LOW_Y, o.pos.z, true)) {
      h.done.push(o.index);
      this.world.events.atPos('cover', chestOf(o, tmpB), o.index, '', h.id);
      return;
    }
    tmpDir.x = o.pos.x - h.at.x;
    tmpDir.y = 0;
    tmpDir.z = o.pos.z - h.at.z;
    this.hit(h, o, this.conv(h.power).damage, tmpDir, knock);
  }

  /** `amount` is already scaled by CONFIG.powers.damageScale. */
  private hit(h: SimHazard, o: SimWizard, amount: number, knockDir: V3 | null, knock: number): void {
    h.done.push(o.index);
    const chest = chestOf(o, tmpEvent);
    this.world.spells.dealDamage(o, h.owner, amount, chest, 'power', knockDir, knockDir ? knock : 0);
    this.world.events.atPos('powerHit', chestOf(o, tmpEvent), o.index, '', h.id, h.owner.index);
  }

  private evaded(h: SimHazard, o: SimWizard): void {
    h.done.push(o.index);
    this.world.events.atPos('evaded', chestOf(o, tmpEvent), o.index, '', h.id);
  }

  /** The power's index in its owner's boss `powers` (-1 if not found). */
  private powerIndex(w: SimWizard, def: PowerDef): number {
    const st = this.world.stages;
    for (let i = 0; i < st.length; i++) if (st[i].owner === w) return st[i].boss.powers.indexOf(def);
    return -1;
  }

  private emit(w: SimWizard, def: PowerDef, phase: 'cast' | 'lock' | 'fire' | 'end', pos: V3, hazard: number): void {
    this.world.events.push('bossPower', w.index, phase, hazard, this.powerIndex(w, def), pos.x, pos.y, pos.z);
  }

  // ------------------------------------------------------------------ lifetime

  private release(i: number): void {
    const h = this.hazards[i];
    h.active = false;
    this.hazards[i] = this.hazards[this.hazards.length - 1];
    this.hazards.pop();
    this.free.push(h);
  }

  /** Call off everything `w` has in play (a KO'd or transforming boss). */
  cancel(w: SimWizard): void {
    for (let i = this.hazards.length - 1; i >= 0; i--) if (this.hazards[i].owner === w) this.release(i);
  }

  /** Clear everything: hazards, recharges and the gap. */
  clear(): void {
    for (let i = this.hazards.length - 1; i >= 0; i--) this.release(i);
    this.cdWho.length = 0;
    this.cdDef.length = 0;
    this.cdLeft.length = 0;
    this.lastAt = FAR_PAST;
  }
}
