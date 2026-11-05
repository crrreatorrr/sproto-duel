/**
 * Casting rules, projectiles and every spell interaction in the sim: the deterministic port of
 * src/spells/SpellSystem.ts (bolts, blasts, shields with perfect reflects and deflects, the stun
 * beam, the Ultimate's shockwave, mid-air clashes, splash damage, the Momentum blink trail and the
 * single damage rule).
 */
import { CONFIG } from '../config';
import { HIT_NONE, HIT_OBSTACLE, HIT_WIZARD, type ArenaQuery, type Body, type Hit, type SimArena, obstacleDistance } from './arena';
import type { SimEvents } from './events';
import {
  DT, ONE, abs, atan2, clamp, cos, deg, fx, sin, isqrt, len2, len3, lerp, max, min, mul, muldiv, sec, setLength3, vt, type V3,
} from './fixed';
import type { Rng } from './rng';
import type { SimRewards } from './rewards';
import type { SimPowers } from './powers';
import type { VolleyDef } from '../campaign/levels';
import {
  A_BLAST, A_BOLT, A_SHIELD, A_STUN, A_ULT, CD_BLAST, CD_BOLT, CD_SHIELD, CD_STUN, type CastKind, type SimWizard,
} from './wizard';

const K_0_8 = fx(0.8);
const K_0_75 = fx(0.75);
const K_0_4 = fx(0.4);
const K_0_3 = fx(0.3);
const K_1_6 = fx(1.6);
const K_0_05 = fx(0.05);
const K_0_6 = fx(0.6);
const K_0_35 = fx(0.35);
const K_1_5 = fx(1.5);
const K_1_2 = fx(1.2);
const K_0_01 = fx(0.01);
const S = CONFIG.spells;
const B = S.bolt;
const BL = S.blast;
const SH = S.shield;
const ST = S.stun;
const U = S.ultimate;

const BOLT_SPEED = fx(B.speed);
const BOLT_RADIUS = fx(B.radius);
const BOLT_DAMAGE = fx(B.damage);
const BOLT_MANA = fx(B.manaCost);
const BOLT_INTERVAL = sec(B.fireInterval);
const BOLT_LIFE = sec(B.lifetime);
const BOLT_POWER = fx(B.power);
const BOLT_KNOCK = fx(B.knockback);
const BLAST_SPEED = fx(BL.speed);
const BLAST_RADIUS = fx(BL.radius);
const BLAST_DAMAGE = fx(BL.damage);
const BLAST_MANA = fx(BL.manaCost);
const BLAST_CD = sec(BL.cooldown);
const BLAST_LIFE = sec(BL.lifetime);
const BLAST_POWER = fx(BL.power);
const BLAST_KNOCK = fx(BL.knockback);
const SPLASH = fx(BL.splashRadius);
const SPLASH_FALLOFF = fx(BL.splashFalloff);
const SHIELD_R = fx(SH.radius);
const SHIELD_MANA = fx(SH.manaCost);
const SHIELD_TIME = sec(SH.duration);
const SHIELD_CD = sec(SH.cooldown);
const PERFECT = sec(SH.perfectWindow);
const REFLECT_SPEED = fx(SH.reflectSpeedMultiplier);
const REFLECT_DAMAGE = fx(SH.reflectDamageMultiplier);
const DEFLECT_DAMAGE = fx(SH.deflectDamageMultiplier);
const PERFECT_ULT = fx(SH.perfectUltCharge);
const STUN_TIME = sec(ST.duration);
const STUN_CD = sec(ST.cooldown);
const STUN_MANA = fx(ST.manaCost);
const STUN_RANGE = fx(ST.range);
const STUN_DAMAGE = fx(ST.damage);
const ULT_MAX = fx(U.chargeMax);
const ULT_PER_DEALT = fx(U.chargePerDamageDealt);
const ULT_DAMAGE = fx(U.damage);
const WAVE_SPEED = fx(U.waveSpeed);
const WAVE_MAX = fx(U.maxRadius);
const ULT_SHIELD = fx(U.shieldMultiplier);
const ULT_PILLAR = fx(U.pillarDamage);
const ULT_KNOCK = fx(U.knockback);
const WAVE_CLEAR = fx(CONFIG.wizard.jump.waveClearance);
const CLASH_SCALE = K_1_6;
const CLASH_KEEP = fx(CONFIG.clash.winnerSpeedKeep);
const WALL_EDGE = fx(CONFIG.arena.wallRadius);
const CAST_TIME = { blast: sec(BL.castTime), stun: sec(ST.castTime), ultimate: sec(U.castTime) };
const PUMP_DAMAGE = fx(CONFIG.rewardSpells.pump.damageMultiplier);
/** 7 rad/s homing turn (SpellSystem.steerHoming) per tick, in angle units. */
const HOMING_TURN = Math.round(((7 / 60) / (2 * Math.PI)) * 65536);
const BOLT_CAP = 64;
const VOLLEY_MANA = fx(CONFIG.campaign.volley.manaCost);
const BLAST_CAP = 12;

export type ProjectileKind = 'bolt' | 'blast';

/** Damage kinds (src/core/events.ts DamageKind). Ordinary spells are scaled by spellDamageScale. */
const SPELL_KINDS: Record<string, boolean> = { bolt: true, blast: true, stun: true, ultimate: true, splash: true };

export interface SimProjectile {
  id: number;
  kind: ProjectileKind;
  owner: SimWizard;
  caster: SimWizard;
  readonly pos: V3;
  readonly prev: V3;
  readonly vel: V3;
  radius: number;
  damage: number;
  knockback: number;
  power: number;
  basePower: number;
  life: number;
  reflected: boolean;
  /** Perfect-reflect homing target (index) or -1; lock-on seek target or -1. */
  homing: number;
  seek: number;
  /** Wizard it already announced a DODGE for, or -1. */
  evaded: number;
  /** Volley shots keep their kind 'volley' for presentation. */
  volley: boolean;
  /** AI bookkeeping: bit per wizard index that already judged this projectile (Projectile.seenMask). */
  seen: number;
}

export interface UltWave {
  owner: SimWizard;
  x: number;
  z: number;
  radius: number;
  hitWizards: number[];
  hitObstacles: number[];
}

export interface BlinkTrail {
  owner: SimWizard;
  readonly from: V3;
  readonly to: V3;
  width: number;
  dps: number;
  life: number;
  age: number;
  frozen: boolean;
  /** Unapplied damage per wizard index (Q16). */
  bank: number[];
}

/** The world the spells act on. */
export interface SpellWorld {
  readonly wizards: SimWizard[];
  readonly arena: SimArena;
  readonly rng: Rng;
  readonly events: SimEvents;
  readonly rewards: SimRewards;
  readonly powers: SimPowers;
  /** A wizard was knocked out (the round may end this tick: Match.onKO). */
  handleKo(): void;
}

const tmp: V3 = { x: 0, y: 0, z: 0 };
const tmpDir: V3 = { x: 0, y: 0, z: 0 };
const tmpC: V3 = { x: 0, y: 0, z: 0 };
const hit: Hit = { kind: 0, index: -1, t: 0 };
const SCRATCH_U: V3 = { x: 0, y: 0, z: 0 };
const spellQuery: ArenaQuery = { world: true, seeThrough: false, floor: true, bodies: null };
const worldOnly: ArenaQuery = { world: true, seeThrough: false, floor: false, bodies: null };

/**
 * Distance along the unit direction u from o to where a sphere (center c, radius r) is entered,
 * within [0, len]; 0 when o is inside; -1 on a miss (math/segmentSphere with a unit direction).
 */
export function raySphere(o: V3, u: V3, len: number, c: V3, r: number): number {
  const mx = Math.floor((o.x - c.x) / 64), my = Math.floor((o.y - c.y) / 64), mz = Math.floor((o.z - c.z) / 64);
  const rr = Math.floor(r / 64);
  const cc = mx * mx + my * my + mz * mz - rr * rr;
  if (cc <= 0) return 0;
  if (abs(mx) > 65536 || abs(my) > 65536 || abs(mz) > 65536) return -1;
  const ux = Math.floor(u.x / 64), uy = Math.floor(u.y / 64), uz = Math.floor(u.z / 64);
  const a = ux * ux + uy * uy + uz * uz;
  if (a === 0) return -1;
  const b = mx * ux + my * uy + mz * uz;
  if (b > 0) return -1;
  const disc = b * b - a * cc;
  if (disc < 0) return -1;
  const t = Math.floor(((-b - isqrt(disc)) * ONE) / a);
  return t <= len ? t : -1;
}

export class SimSpells {
  /** Live projectiles (swap-removed like the game's pool, so iteration order matches). */
  readonly active: SimProjectile[] = [];
  readonly waves: UltWave[] = [];
  readonly trails: BlinkTrail[] = [];
  private nextId = 1;
  private bolts = 0;
  private blasts = 0;
  private readonly bodies: Body[] = [];

  /** Learned reward spells can be cast (MatchRules.rewardSpells). */
  rewardSpells = true;
  /** Burst volleys still firing: caster, def, shots fired, TU to the next. */
  private readonly volleys: { w: SimWizard; def: VolleyDef; fired: number; timer: number }[] = [];

  constructor(private readonly world: SpellWorld) {}

  clear(): void {
    this.volleys.length = 0;
    this.active.length = 0;
    this.waves.length = 0;
    this.trails.length = 0;
    this.bolts = this.blasts = 0;
  }

  update(dt: number): void {
    const ws = this.world.wizards;
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      if (!w.active) continue;
      this.updateCast(w, dt);
      this.handleIntents(w);
    }
    this.world.rewards.update(dt);
    this.world.powers.update(dt);
    this.updateVolleys(dt);
    this.updateProjectiles(dt);
    this.resolveClashes();
    this.updateWaves(dt);
    this.updateTrails(dt);
  }

  /** The blink trails follow their dashers and burn (BlinkTrails.update, last in SpellSystem.update). */
  private updateTrails(dt: number): void {
    for (let i = this.trails.length - 1; i >= 0; i--) {
      const t = this.trails[i];
      if (t.owner.blinking) copy(t.to, t.owner.pos);
      else if (!t.frozen) {
        copy(t.to, t.owner.pos);
        t.frozen = true;
      }
      t.age += dt;
      this.hurtTrail(t, dt);
      if (t.age >= t.life) {
        this.trails[i] = this.trails[this.trails.length - 1];
        this.trails.pop();
      }
    }
  }

  /** A blink just started (Wizard.startBlink): lay its trail. */
  spawnTrail(w: SimWizard): void {
    const b = w.staff && w.staff.blink;
    if (!b) return;
    const bank: number[] = [];
    for (let i = 0; i < this.world.wizards.length; i++) bank.push(0);
    this.trails.push({ owner: w, from: { x: w.blinkFrom.x, y: w.blinkFrom.y, z: w.blinkFrom.z }, to: { x: w.pos.x, y: w.pos.y, z: w.pos.z }, width: b.trailWidth, dps: b.trailDps, life: b.trailTime, age: 0, frozen: false, bank });
  }

  private hurtTrail(t: BlinkTrail, dt: number): void {
    const reach = t.width >> 1;
    const ws = this.world.wizards;
    for (let i = 0; i < ws.length; i++) {
      const target = ws[i];
      if (target === t.owner || !target.active || !target.alive || target.invulnerable) continue;
      if (distPointSeg(target.pos.x, target.pos.z, t.from.x, t.from.z, t.to.x, t.to.z) > reach) continue;
      const bank = t.bank[i] + vt(t.dps, dt);
      if (bank < ONE) {
        t.bank[i] = bank;
        continue;
      }
      const whole = Math.floor(bank / ONE) * ONE;
      t.bank[i] = bank - whole;
      tmp.x = (t.from.x + t.to.x) >> 1;
      tmp.y = target.pos.y + K_0_8;
      tmp.z = (t.from.z + t.to.z) >> 1;
      this.dealDamage(target, t.owner, whole, tmp, 'trail', null, 0);
    }
  }

  // ------------------------------------------------------------------ casting

  private handleIntents(w: SimWizard): void {
    if (!w.alive || w.stunned || w.evolving) return;
    if (w.wants(A_SHIELD) && !w.dodging && !w.shielded && !w.riding) {
      if (this.raiseShield(w)) w.consume(A_SHIELD);
    }
    // Boss reward spells (only wizards that learned them: the player), unless the rules forbid them.
    if (this.rewardSpells && (w.learned !== 0 || w.side === 0)) this.world.rewards.handleIntents(w);
    // On the Magic Carpet: bolts only (drive-by).
    if (w.riding) {
      if (!w.dodging && w.cast === null && (w.holdBolt || w.wants(A_BOLT)) && this.castBolt(w)) w.consume(A_BOLT);
      return;
    }
    if (!w.canAct) return;
    if (w.wants(A_ULT) && this.beginCast(w, 'ultimate')) {
      w.consume(A_ULT);
      return;
    }
    if (w.wants(A_STUN) && this.beginCast(w, 'stun')) {
      w.consume(A_STUN);
      return;
    }
    if (w.wants(A_BLAST) && this.beginCast(w, 'blast')) {
      w.consume(A_BLAST);
      return;
    }
    if (w.holdBolt || w.wants(A_BOLT)) {
      if (this.castBolt(w)) w.consume(A_BOLT);
    }
  }

  /** Unit direction from `from` toward the aim point (facing when the aim is within 1 m). */
  aimDirection(w: SimWizard, from: V3, out: V3): V3 {
    const aim = w.aimPoint();
    const dx = aim.x - from.x, dy = aim.y - from.y, dz = aim.z - from.z;
    if (len3(dx, dy, dz) < ONE || !setLength3(out, dx, dy, dz, ONE)) {
      out.x = w.forwardX();
      out.y = 0;
      out.z = w.forwardZ();
    }
    return out;
  }

  /** The muzzle point for `kind`, kept on the caster's side of cover and inside the wall. */
  muzzleOrigin(w: SimWizard, kind: CastKind, index: number, radius: number, out: V3): V3 {
    w.castPoint(kind, out, index);
    return this.clearOrigin(w, out, radius);
  }

  private clearOrigin(w: SimWizard, point: V3, radius: number): V3 {
    const ax = w.pos.x, ay = min(point.y, w.pos.y + w.chestY), az = w.pos.z;
    const sx = point.x - ax, sy = point.y - ay, sz = point.z - az;
    const len = len3(sx, sy, sz);
    if (len < 7) return point;
    const u = tmpC;
    setLength3(u, sx, sy, sz, ONE);
    this.world.arena.cast(ax, ay, az, u.x, u.y, u.z, len + radius, 0, worldOnly, hit);
    let reach = hit.kind !== HIT_NONE ? max(0, min(len, hit.t - radius)) : len;
    // The outer wall is low: a raised staff may reach over it. Stay inside its radius.
    const edge = WALL_EDGE - radius;
    const ex = ax + mul(u.x, reach), ez = az + mul(u.z, reach);
    if (len2(ex, ez) > edge) {
      // Exit of the 2D circle along (u.x, u.z) from (ax, az).
      const a = mul(u.x, u.x) + mul(u.z, u.z);
      if (a > 0) {
        const b = mul(ax, u.x) + mul(az, u.z);
        const c = mul(ax, ax) + mul(az, az) - mul(edge, edge);
        const disc = mul(b, b) - mul(a, c);
        if (disc >= 0) reach = max(0, min(reach, muldiv(-b + isqrt(disc * ONE), ONE, a)));
      }
    }
    if (reach < len) {
      point.x = ax + mul(u.x, reach);
      point.y = ay + mul(u.y, reach);
      point.z = az + mul(u.z, reach);
    }
    return point;
  }

  noMana(w: SimWizard): void {
    this.world.events.push('noMana', w.index);
  }

  private beginCast(w: SimWizard, spell: 'blast' | 'stun' | 'ultimate'): boolean {
    if (spell === 'ultimate') {
      if (w.ult < ULT_MAX) {
        this.world.events.push('notCharged', w.index);
        return true;
      }
    } else {
      const cd = spell === 'blast' ? CD_BLAST : CD_STUN;
      if (w.cd[cd] > 0) return false;
      if (w.mana < (spell === 'blast' ? BLAST_MANA : STUN_MANA)) {
        this.noMana(w);
        return true;
      }
    }
    w.cast = { spell, elapsed: 0, duration: CAST_TIME[spell] };
    this.world.events.atPos('castStart', w.pos, w.index, spell);
    return true;
  }

  private updateCast(w: SimWizard, dt: number): void {
    const c = w.cast;
    if (!c) return;
    if (!w.alive || w.stunned || w.evolving) {
      w.cast = null;
      return;
    }
    c.elapsed += dt;
    if (c.elapsed < c.duration) return;
    w.cast = null;
    if (c.spell === 'blast') this.releaseBlast(w);
    else if (c.spell === 'stun') this.releaseStun(w);
    else this.releaseUltimate(w);
  }

  private boltInterval(w: SimWizard): number {
    return w.staff ? mul(BOLT_INTERVAL, w.staff.boltInterval) : BOLT_INTERVAL;
  }

  private castBolt(w: SimWizard): boolean {
    if (w.cd[CD_BOLT] > 0) return false;
    if (!w.spendMana(BOLT_MANA)) {
      if (w.wants(A_BOLT)) this.noMana(w);
      w.cd[CD_BOLT] = this.boltInterval(w) * 2;
      return true;
    }
    w.cd[CD_BOLT] = this.boltInterval(w);
    const muzzle = w.muzzleIndex('bolt');
    const from = this.muzzleOrigin(w, 'bolt', muzzle, BOLT_RADIUS, { x: 0, y: 0, z: 0 });
    const damage = w.staff ? mul(BOLT_DAMAGE, w.staff.boltDamage) : BOLT_DAMAGE;
    if (this.launchBolt(w, from, this.aimDirection(w, from, tmpDir), damage, false)) w.castPulse = ONE;
    return true;
  }

  private spawn(kind: ProjectileKind): SimProjectile | null {
    if (kind === 'bolt' ? this.bolts >= BOLT_CAP : this.blasts >= BLAST_CAP) return null;
    if (kind === 'bolt') this.bolts++;
    else this.blasts++;
    const p: SimProjectile = {
      id: this.nextId++, kind, owner: null as unknown as SimWizard, caster: null as unknown as SimWizard,
      pos: { x: 0, y: 0, z: 0 }, prev: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
      radius: 0, damage: 0, knockback: 0, power: 0, basePower: 0, life: 0, reflected: false, homing: -1, seek: -1, evaded: -1, volley: false, seen: 0,
    };
    this.active.push(p);
    return p;
  }

  release(p: SimProjectile): void {
    const i = this.active.indexOf(p);
    if (i < 0) return;
    if (p.kind === 'bolt') this.bolts--;
    else this.blasts--;
    this.active[i] = this.active[this.active.length - 1];
    this.active.pop();
  }

  /** Spawn one bolt (held fire and volleys). */
  launchBolt(w: SimWizard, from: V3, dir: V3, damage: number, volley: boolean): SimProjectile | null {
    const p = this.spawn('bolt');
    if (!p) return null;
    copy(p.pos, from);
    copy(p.prev, from);
    p.vel.x = mul(dir.x, BOLT_SPEED);
    p.vel.y = mul(dir.y, BOLT_SPEED);
    p.vel.z = mul(dir.z, BOLT_SPEED);
    p.owner = p.caster = w;
    p.radius = BOLT_RADIUS;
    p.damage = damage;
    p.knockback = w.staff && w.staff.boltKnockback >= 0 ? w.staff.boltKnockback : BOLT_KNOCK;
    p.power = p.basePower = mul(BOLT_POWER, w.clashPowerMultiplier);
    p.life = BOLT_LIFE;
    p.volley = volley;
    // Lock-On: the bolt curves toward the nearest enemy in front of the caster.
    if (w.lockedOn) p.seek = this.world.rewards.lockTarget(w);
    w.stats.casts++;
    w.advanceMuzzle();
    this.world.events.atPos('cast', p.pos, w.index, volley ? 'volley' : 'bolt', p.id);
    return p;
  }

  /**
   * A boss's signature multi-shot (SpellSystem.castVolley): `count` bolts at `damageScale` x bolt
   * damage, fanned across `spreadDeg` at once or one every `interval` s. The AI owns the cooldown.
   */
  castVolley(w: SimWizard, def: VolleyDef): boolean {
    if (!w.canAct || this.volleyFiring(w) || def.count < 1) return false;
    if (!w.spendMana(VOLLEY_MANA)) return false;
    w.castPulse = ONE;
    this.world.events.push('volley', w.index, def.name, def.count, -1, w.pos.x, w.pos.y + w.chestY, w.pos.z);
    if (def.interval <= 0) {
      for (let i = 0; i < def.count; i++) this.volleyShot(w, def, i);
      return true;
    }
    this.volleyShot(w, def, 0);
    if (def.count > 1) this.volleys.push({ w, def, fired: 1, timer: sec(def.interval) });
    return true;
  }

  volleyFiring(w: SimWizard): boolean {
    for (let i = 0; i < this.volleys.length; i++) if (this.volleys[i].w === w) return true;
    return false;
  }

  /** Call off a caster's burst (a boss leaving the fight). */
  cancelVolleys(w: SimWizard): void {
    for (let i = this.volleys.length - 1; i >= 0; i--) if (this.volleys[i].w === w) this.volleys.splice(i, 1);
  }

  private updateVolleys(dt: number): void {
    for (let i = 0; i < this.volleys.length; i++) {
      const v = this.volleys[i];
      const w = v.w;
      if (!w.alive || w.stunned || w.evolving) {
        this.volleys.splice(i--, 1);
        continue;
      }
      v.timer -= dt;
      while (v.timer <= 0 && v.fired < v.def.count) {
        this.volleyShot(w, v.def, v.fired++);
        v.timer += sec(v.def.interval);
      }
      if (v.fired >= v.def.count) this.volleys.splice(i--, 1);
    }
  }

  /** Shot `i`: aimed like a bolt, then turned across the spread (left to right). */
  private volleyShot(w: SimWizard, def: VolleyDef, i: number): void {
    const t = def.count > 1 ? muldiv(i, ONE, def.count - 1) - (ONE >> 1) : 0;
    const muzzle = w.muzzleIndex('volley');
    const from = this.muzzleOrigin(w, 'volley', muzzle, BOLT_RADIUS, { x: 0, y: 0, z: 0 });
    const d = this.aimDirection(w, from, { x: 0, y: 0, z: 0 });
    // Rotate about +y by -t x spread (three's applyAxisAngle: x' = x c + z s, z' = -x s + z c).
    const a = -mul(t, deg(def.spreadDeg));
    const c = cos(a), sn = sin(a);
    const dir = { x: mul(d.x, c) + mul(d.z, sn), y: d.y, z: -mul(d.x, sn) + mul(d.z, c) };
    this.launchBolt(w, from, dir, mul(BOLT_DAMAGE, fx(def.damageScale)), true);
  }

  private releaseBlast(w: SimWizard): void {
    if (!w.spendMana(BLAST_MANA)) {
      this.noMana(w);
      return;
    }
    w.cd[CD_BLAST] = BLAST_CD;
    const p = this.spawn('blast');
    if (!p) return;
    const muzzle = w.muzzleIndex('blast');
    this.muzzleOrigin(w, 'blast', muzzle, BLAST_RADIUS, p.pos);
    copy(p.prev, p.pos);
    this.aimDirection(w, p.pos, tmpDir);
    p.vel.x = mul(tmpDir.x, BLAST_SPEED);
    p.vel.y = mul(tmpDir.y, BLAST_SPEED);
    p.vel.z = mul(tmpDir.z, BLAST_SPEED);
    p.owner = p.caster = w;
    p.radius = BLAST_RADIUS;
    p.damage = BLAST_DAMAGE;
    p.knockback = BLAST_KNOCK;
    p.power = p.basePower = mul(BLAST_POWER, w.clashPowerMultiplier);
    p.life = BLAST_LIFE;
    w.castPulse = ONE;
    w.stats.casts++;
    w.advanceMuzzle();
    this.world.events.atPos('cast', p.pos, w.index, 'blast', p.id);
  }

  private raiseShield(w: SimWizard): boolean {
    if (w.cd[CD_SHIELD] > 0) return false;
    if (!w.spendMana(SHIELD_MANA)) {
      this.noMana(w);
      return true;
    }
    w.cast = null;
    w.breathTime = 0;
    w.shieldTime = SHIELD_TIME;
    w.shieldAge = 0;
    w.cd[CD_SHIELD] = SHIELD_CD;
    w.stats.casts++;
    this.world.events.push('shieldUp', w.index);
    this.world.events.atPos('cast', w.pos, w.index, 'shield');
    return true;
  }

  private releaseStun(w: SimWizard): void {
    if (!w.spendMana(STUN_MANA)) {
      this.noMana(w);
      return;
    }
    w.cd[CD_STUN] = STUN_CD;
    w.castPulse = ONE;
    w.stats.casts++;
    const muzzle = w.muzzleIndex('stun');
    const origin = this.muzzleOrigin(w, 'stun', muzzle, 0, { x: 0, y: 0, z: 0 });
    const dir = this.aimDirection(w, origin, { x: 0, y: 0, z: 0 });
    this.world.events.atPos('cast', origin, w.index, 'stun');
    w.advanceMuzzle();
    this.fireBeam(w, origin, dir, false);
  }

  private enemyBodies(side: number): Body[] {
    const out = this.bodies;
    out.length = 0;
    for (const o of this.world.wizards) {
      if (!o.active || !o.alive || o.invulnerable || o.side === side) continue;
      out.push(o.body());
    }
    return out;
  }

  /** Hitscan stun beam. Shields block it; a perfect shield bounces it back onto the caster. */
  private fireBeam(caster: SimWizard, origin: V3, dir: V3, reflected: boolean): void {
    const ev = this.world.events;
    let shieldDist = -1;
    let shieldOwner: SimWizard | null = null;
    for (const o of this.world.wizards) {
      if (!o.active || o.side === caster.side || !o.alive || !o.shielded) continue;
      tmpC.x = o.pos.x;
      tmpC.y = o.pos.y + o.shieldCenterY;
      tmpC.z = o.pos.z;
      const t = raySphere(origin, dir, STUN_RANGE, tmpC, SHIELD_R);
      if (t >= 0 && (shieldDist < 0 || t < shieldDist)) {
        shieldDist = t;
        shieldOwner = o;
      }
    }
    spellQuery.bodies = this.enemyBodies(caster.side);
    this.world.arena.cast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, STUN_RANGE, 0, spellQuery, hit);
    spellQuery.bodies = null;
    const hitKind = hit.kind, hitIndex = hit.index;
    const hitDist = hitKind !== HIT_NONE ? hit.t : STUN_RANGE;
    const reach = shieldDist >= 0 ? min(hitDist, shieldDist) : hitDist;

    for (const o of this.world.wizards) {
      if (!o.active || o.side === caster.side || !o.alive || !o.invulnerable) continue;
      tmpC.x = o.pos.x;
      tmpC.y = o.pos.y + o.chestY;
      tmpC.z = o.pos.z;
      if (raySphere(origin, dir, reach, tmpC, K_0_8) >= 0) ev.atPos('dodgeEvade', tmpC, o.index);
    }
    const end = { x: origin.x + mul(dir.x, reach), y: origin.y + mul(dir.y, reach), z: origin.z + mul(dir.z, reach) };
    ev.push('beam', caster.index, reflected ? 'reflected' : '', 0, -1, origin.x, origin.y, origin.z);
    ev.atPos('beamEnd', end, caster.index);

    if (shieldOwner && shieldDist <= hitDist) {
      const perfect = shieldOwner.shieldAge <= PERFECT;
      ev.atPos('block', end, shieldOwner.index, 'stun', 0, -1, perfect);
      if (perfect && !reflected && caster.alive) {
        this.perfectFeedback(shieldOwner, end);
        const back = { x: 0, y: 0, z: 0 };
        if (!setLength3(back, caster.pos.x - end.x, caster.pos.y + caster.chestY - end.y, caster.pos.z - end.z, ONE)) back.z = ONE;
        this.fireBeam(shieldOwner, end, back, true);
      }
      return;
    }
    if (hitKind === HIT_WIZARD) {
      const target = this.world.wizards[hitIndex];
      const stuns = !target.evolving;
      target.applyStun(STUN_TIME);
      this.dealDamage(target, caster, STUN_DAMAGE, end, 'stun', null, 0);
      ev.atPos('impact', end, target.index, 'stun');
      if (stuns) ev.push('stunned', target.index);
    } else if (hitKind === HIT_OBSTACLE) {
      this.damageObstacle(hitIndex, STUN_DAMAGE, end);
    }
  }

  private releaseUltimate(w: SimWizard): void {
    w.ult = 0;
    w.ultAnnounced = false;
    w.castPulse = ONE;
    w.stats.casts++;
    this.waves.push({ owner: w, x: w.pos.x, z: w.pos.z, radius: K_0_6, hitWizards: [], hitObstacles: [] });
    this.world.events.push('cast', w.index, 'ultimate', 0, -1, w.pos.x, 0, w.pos.z);
    this.world.events.push('ultWave', w.index, '', 0, -1, w.pos.x, 0, w.pos.z);
  }

  // ------------------------------------------------------------------ projectiles

  private updateProjectiles(dt: number): void {
    const list = this.active;
    for (let i = list.length - 1; i >= 0; i--) {
      if (i >= list.length) continue;
      const p = list[i];
      copy(p.prev, p.pos);
      p.life -= dt;
      if (p.life <= 0) {
        if (p.kind === 'blast') this.explode(p.pos, p.owner, p.damage, null, null);
        else this.world.events.atPos('fizzle', p.pos, p.owner.index, p.kind, p.id);
        this.release(p);
        continue;
      }
      if (p.homing >= 0) this.steerHoming(p);
      else if (p.seek >= 0) this.world.rewards.steer(p, dt);
      const mx = vt(p.vel.x, dt), my = vt(p.vel.y, dt), mz = vt(p.vel.z, dt);
      const len = len3(mx, my, mz);
      if (len < 4) continue;
      const u = SCRATCH_U;
      setLength3(u, mx, my, mz, ONE);
      if (this.checkShields(p, u, len)) continue;
      this.checkEvade(p, u, len);
      spellQuery.bodies = this.enemyBodies(p.owner.side);
      this.world.arena.cast(p.pos.x, p.pos.y, p.pos.z, u.x, u.y, u.z, len, p.radius, spellQuery, hit);
      spellQuery.bodies = null;
      if (hit.kind !== HIT_NONE) {
        p.pos.x += mul(u.x, hit.t);
        p.pos.y += mul(u.y, hit.t);
        p.pos.z += mul(u.z, hit.t);
        this.impact(p, hit.kind, hit.index);
        continue;
      }
      p.pos.x += mx;
      p.pos.y += my;
      p.pos.z += mz;
    }
  }

  /** Perfect reflects curve toward the original caster (7 rad/s). */
  private steerHoming(p: SimProjectile): void {
    const target = this.world.wizards[p.homing];
    if (!target.alive) {
      p.homing = -1;
      return;
    }
    const speed = len3(p.vel.x, p.vel.y, p.vel.z);
    const want = { x: 0, y: 0, z: 0 };
    if (!setLength3(want, target.pos.x - p.pos.x, target.pos.y + target.chestY - p.pos.y, target.pos.z - p.pos.z, ONE)) return;
    const d = { x: 0, y: 0, z: 0 };
    if (!setLength3(d, p.vel.x, p.vel.y, p.vel.z, ONE)) return;
    const dot = clamp(mul(d.x, want.x) + mul(d.y, want.y) + mul(d.z, want.z), -ONE, ONE);
    const cx = mul(d.y, want.z) - mul(d.z, want.y);
    const cy = mul(d.z, want.x) - mul(d.x, want.z);
    const cz = mul(d.x, want.y) - mul(d.y, want.x);
    const angle = atan2(len3(cx, cy, cz), dot);
    if (angle > 11) {
      const k = min(ONE, muldiv(HOMING_TURN, ONE, angle));
      d.x += mul(want.x - d.x, k);
      d.y += mul(want.y - d.y, k);
      d.z += mul(want.z - d.z, k);
      setLength3(d, d.x, d.y, d.z, ONE);
    }
    p.vel.x = mul(d.x, speed);
    p.vel.y = mul(d.y, speed);
    p.vel.z = mul(d.z, speed);
  }

  private checkShields(p: SimProjectile, u: V3, len: number): boolean {
    for (const o of this.world.wizards) {
      if (!o.active || o.side === p.owner.side || !o.alive || !o.shielded) continue;
      tmpC.x = o.pos.x;
      tmpC.y = o.pos.y + o.shieldCenterY;
      tmpC.z = o.pos.z;
      const t = raySphere(p.pos, u, len, tmpC, SHIELD_R + p.radius);
      if (t < 0) continue;
      const point = { x: p.pos.x + mul(u.x, t), y: p.pos.y + mul(u.y, t), z: p.pos.z + mul(u.z, t) };
      this.shieldBlock(p, o, { x: tmpC.x, y: tmpC.y, z: tmpC.z }, point);
      return true;
    }
    return false;
  }

  private shieldBlock(p: SimProjectile, o: SimWizard, center: V3, point: V3): void {
    const ev = this.world.events;
    const perfect = o.shieldAge <= PERFECT;
    const n = { x: 0, y: 0, z: 0 };
    if (!setLength3(n, point.x - center.x, point.y - center.y, point.z - center.z, ONE)) n.y = ONE;
    ev.atPos('block', point, o.index, p.kind, p.id, -1, perfect);
    const out = SHIELD_R + p.radius + K_0_05;
    if (perfect) {
      const victim = p.owner;
      p.owner = o;
      p.reflected = true;
      p.seek = -1;
      p.homing = victim.alive ? victim.index : -1;
      const speed = mul(p.kind === 'bolt' ? BOLT_SPEED : BLAST_SPEED, REFLECT_SPEED);
      const d = { x: 0, y: 0, z: 0 };
      if (!setLength3(d, victim.pos.x - point.x, victim.pos.y + victim.chestY - point.y, victim.pos.z - point.z, ONE)) d.z = ONE;
      p.vel.x = mul(d.x, speed);
      p.vel.y = mul(d.y, speed);
      p.vel.z = mul(d.z, speed);
      p.damage = mul(p.damage, REFLECT_DAMAGE);
      p.life = p.kind === 'bolt' ? BOLT_LIFE : BLAST_LIFE;
      p.pos.x = center.x + mul(n.x, out);
      p.pos.y = center.y + mul(n.y, out);
      p.pos.z = center.z + mul(n.z, out);
      copy(p.prev, p.pos);
      this.perfectFeedback(o, point);
      return;
    }
    if (p.kind === 'blast') {
      this.explode(point, p.owner, p.damage, o, null);
      this.release(p);
      return;
    }
    // Deflect: glance off the bubble in a scattered direction and fizzle out.
    const vn = mul(p.vel.x, n.x) + mul(p.vel.y, n.y) + mul(p.vel.z, n.z);
    const vx = p.vel.x - 2 * mul(n.x, vn), vy = p.vel.y - 2 * mul(n.y, vn), vz = p.vel.z - 2 * mul(n.z, vn);
    const rng = this.world.rng;
    const d = { x: 0, y: 0, z: 0 };
    if (!setLength3(d, vx, vy, vz, ONE)) d.y = ONE;
    d.x += rng.frac() - (ONE >> 1);
    d.y += K_0_6 + mul(rng.frac(), K_0_4);
    d.z += rng.frac() - (ONE >> 1);
    if (!setLength3(d, d.x, d.y, d.z, ONE)) d.y = ONE;
    const speed = mul(BOLT_SPEED, K_0_6);
    p.vel.x = mul(d.x, speed);
    p.vel.y = mul(d.y, speed);
    p.vel.z = mul(d.z, speed);
    p.owner = o;
    p.seek = -1;
    p.damage = mul(p.damage, DEFLECT_DAMAGE);
    p.life = min(p.life, sec(0.35));
    p.pos.x = center.x + mul(n.x, out);
    p.pos.y = center.y + mul(n.y, out);
    p.pos.z = center.z + mul(n.z, out);
    copy(p.prev, p.pos);
  }

  private perfectFeedback(o: SimWizard, point: V3): void {
    o.stats.perfects++;
    o.addUlt(PERFECT_ULT);
    this.world.events.atPos('perfect', point, o.index);
  }

  private checkEvade(p: SimProjectile, u: V3, len: number): void {
    for (const o of this.world.wizards) {
      if (!o.active || o.side === p.owner.side || !o.invulnerable || p.evaded === o.index || !o.alive) continue;
      tmpC.x = o.pos.x;
      tmpC.y = o.pos.y + o.chestY;
      tmpC.z = o.pos.z;
      if (raySphere(p.pos, u, len, tmpC, K_0_75 + p.radius) < 0) continue;
      p.evaded = o.index;
      this.world.events.atPos('dodgeEvade', tmpC, o.index);
    }
  }

  private impact(p: SimProjectile, kind: number, index: number): void {
    const ev = this.world.events;
    if (p.kind === 'blast') {
      this.explode(p.pos, p.owner, p.damage, null, kind === HIT_WIZARD ? this.world.wizards[index] : null);
      ev.atPos('impact', p.pos, p.owner.index, 'blast', p.id, kind === HIT_WIZARD ? index : -1);
      this.release(p);
      return;
    }
    if (kind === HIT_WIZARD) {
      const target = this.world.wizards[index];
      this.dealDamage(target, p.owner, p.damage, p.pos, 'bolt', p.vel, p.knockback);
      ev.atPos('impact', p.pos, p.owner.index, 'bolt', p.id, index, p.reflected);
    } else if (kind === HIT_OBSTACLE) {
      this.damageObstacle(index, p.damage, p.pos);
      ev.atPos('impact', p.pos, p.owner.index, 'bolt', p.id, -1);
    } else {
      ev.atPos('impact', p.pos, p.owner.index, 'bolt', p.id, -1);
    }
    this.release(p);
  }

  damageObstacle(index: number, amount: number, point: V3): void {
    const arena = this.world.arena;
    const ob = arena.obstacles[index];
    if (!ob || !ob.alive) return;
    this.world.events.atPos('pillarHit', point, -1, '', index);
    if (arena.damageObstacle(ob, amount)) {
      this.world.events.push('pillarBreak', -1, ob.seeThrough ? 'glass' : '', index, -1, ob.x, ob.height >> 1, ob.z);
    }
  }

  /** Blast explosion: splash with falloff, blocked by cover, shields and i-frames. */
  private explode(pos: V3, owner: SimWizard, damage: number, ignore: SimWizard | null, direct: SimWizard | null): void {
    const arena = this.world.arena;
    const ox = pos.x, oy = max(pos.y, K_0_4), oz = pos.z;
    let hitAny = false;
    for (const o of this.world.wizards) {
      if (!o.active || !o.alive || o.side === owner.side || o === ignore) continue;
      const k = o.sizeScale;
      const y = clamp(oy, o.pos.y + mul(K_0_3, k), o.pos.y + mul(K_1_6, k));
      const d = max(0, len3(o.pos.x - ox, y - oy, o.pos.z - oz) - o.radius);
      if (d > SPLASH) continue;
      tmpC.x = o.pos.x;
      tmpC.y = o.pos.y + o.chestY;
      tmpC.z = o.pos.z;
      if (o.invulnerable) {
        this.world.events.atPos('dodgeEvade', tmpC, o.index);
        continue;
      }
      if (o.shielded) {
        this.world.events.atPos('block', tmpC, o.index, 'blast', 0, -1, false);
        continue;
      }
      if (!arena.clear(ox, oy, oz, tmpC.x, tmpC.y, tmpC.z, false)) continue;
      const falloff = o === direct ? ONE : lerp(ONE, SPLASH_FALLOFF, muldiv(d, ONE, SPLASH));
      let dx = o.pos.x - ox, dz = o.pos.z - oz;
      if (len2(dx, dz) < K_0_01) {
        dx = this.world.rng.frac() - (ONE >> 1);
        dz = this.world.rng.frac() - (ONE >> 1);
      }
      const chest = { x: tmpC.x, y: tmpC.y, z: tmpC.z };
      this.dealDamage(o, owner, mul(damage, falloff), chest, 'blast', { x: dx, y: 0, z: dz }, mul(BLAST_KNOCK, falloff));
      hitAny = true;
    }
    for (const ob of arena.obstacles) {
      if (!ob.alive) continue;
      const d = obstacleDistance(ob, ox, oz);
      if (d > SPLASH) continue;
      this.damageObstacle(ob.index, mul(damage, lerp(ONE, K_0_35, muldiv(max(0, d), ONE, SPLASH))), { x: ob.x, y: oy, z: ob.z });
    }
    this.world.events.push('explosion', owner.index, hitAny ? 'hit' : '', SPLASH, -1, ox, oy, oz);
  }

  // ------------------------------------------------------------------ clashes

  private resolveClashes(): void {
    const list = this.active;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.owner.side === b.owner.side) continue;
        const rx = a.prev.x - b.prev.x, ry = a.prev.y - b.prev.y, rz = a.prev.z - b.prev.z;
        const dx = a.pos.x - a.prev.x - (b.pos.x - b.prev.x);
        const dy = a.pos.y - a.prev.y - (b.pos.y - b.prev.y);
        const dz = a.pos.z - a.prev.z - (b.pos.z - b.prev.z);
        const dd = mul(dx, dx) + mul(dy, dy) + mul(dz, dz);
        const t = dd > 0 ? clamp(-muldiv(mul(rx, dx) + mul(ry, dy) + mul(rz, dz), ONE, dd), 0, ONE) : 0;
        const cx = rx + mul(dx, t), cy = ry + mul(dy, t), cz = rz + mul(dz, t);
        const reach = mul(a.radius + b.radius, CLASH_SCALE);
        if (len3(cx, cy, cz) > reach) continue;
        this.clash(a, b);
        i = -1;
        break;
      }
    }
  }

  private clash(a: SimProjectile, b: SimProjectile): void {
    const pos = { x: (a.pos.x + b.pos.x) >> 1, y: (a.pos.y + b.pos.y) >> 1, z: (a.pos.z + b.pos.z) >> 1 };
    let winner: SimProjectile | null = null;
    if (a.power === b.power) {
      this.release(a);
      this.release(b);
    } else {
      winner = a.power > b.power ? a : b;
      const loser = winner === a ? b : a;
      const before = winner.power;
      winner.power -= loser.power;
      winner.damage = muldiv(winner.damage, winner.power, before);
      const base = winner.kind === 'bolt' ? BOLT_RADIUS : BLAST_RADIUS;
      const k = max(ONE >> 1, isqrt(muldiv(winner.power, ONE, winner.basePower) * ONE));
      winner.radius = mul(base, k);
      winner.vel.x = mul(winner.vel.x, CLASH_KEEP);
      winner.vel.y = mul(winner.vel.y, CLASH_KEEP);
      winner.vel.z = mul(winner.vel.z, CLASH_KEEP);
      this.release(loser);
    }
    this.world.events.atPos('clash', pos, a.owner.index, winner ? winner.kind : '', winner ? winner.id : 0, b.owner.index);
  }

  // ------------------------------------------------------------------ ultimate

  private updateWaves(dt: number): void {
    const arena = this.world.arena;
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const wave = this.waves[i];
      const prev = wave.radius;
      wave.radius += vt(WAVE_SPEED, dt);
      for (const ob of arena.obstacles) {
        if (!ob.alive || wave.hitObstacles.indexOf(ob.index) >= 0) continue;
        if (obstacleDistance(ob, wave.x, wave.z) > wave.radius) continue;
        wave.hitObstacles.push(ob.index);
        this.damageObstacle(ob.index, ULT_PILLAR, { x: ob.x, y: K_1_5, z: ob.z });
      }
      for (const o of this.world.wizards) {
        if (!o.active || o.side === wave.owner.side || !o.alive || wave.hitWizards.indexOf(o.index) >= 0) continue;
        const d = len2(o.pos.x - wave.x, o.pos.z - wave.z) - o.radius;
        if (d > wave.radius) continue;
        wave.hitWizards.push(o.index);
        this.waveHit(wave, o);
      }
      const list = this.active;
      for (let k = list.length - 1; k >= 0; k--) {
        if (k >= list.length) continue;
        const p = list[k];
        if (p.owner.side === wave.owner.side) continue;
        const d = len2(p.pos.x - wave.x, p.pos.z - wave.z);
        if (d > wave.radius + K_0_3 || d < prev - K_1_5) continue;
        this.world.events.atPos('clash', p.pos, p.owner.index, '', 0, wave.owner.index);
        this.release(p);
      }
      if (wave.radius >= WAVE_MAX) this.waves.splice(i, 1);
    }
  }

  private waveHit(wave: UltWave, o: SimWizard): void {
    const ev = this.world.events;
    const chest = { x: o.pos.x, y: o.pos.y + o.chestY, z: o.pos.z };
    if (o.invulnerable || o.airHeight >= WAVE_CLEAR || o.riding) {
      ev.atPos('evaded', chest, o.index);
      return;
    }
    if (!this.world.arena.clear(wave.x, K_1_2, wave.z, chest.x, chest.y, chest.z, false)) {
      ev.atPos('cover', chest, o.index);
      return;
    }
    let damage = ULT_DAMAGE, knock = ULT_KNOCK;
    if (o.shielded) {
      damage = mul(damage, ULT_SHIELD);
      knock = mul(knock, K_0_4);
      ev.atPos('block', chest, o.index, 'ultimate', 0, -1, false);
    }
    this.dealDamage(o, wave.owner, damage, chest, 'ultimate', { x: o.pos.x - wave.x, y: 0, z: o.pos.z - wave.z }, knock);
  }

  // ------------------------------------------------------------------ damage

  /**
   * The single place damage is applied (SpellSystem.dealDamage): source multipliers, immunity,
   * stats, Ultimate charge, knockback, events, KO. Never between allies.
   */
  dealDamage(target: SimWizard, source: SimWizard | null, amount: number, point: V3, kind: string, knockDir: V3 | null, knockback: number): number {
    if (!target.alive) return 0;
    if (source && source !== target && source.side === target.side) return 0;
    if (source && source !== target) {
      amount = mul(amount, source.damageMultiplier);
      if (source.pumped) amount = mul(amount, PUMP_DAMAGE);
      if (SPELL_KINDS[kind]) amount = mul(amount, source.spellDamageScale);
    }
    const ev = this.world.events;
    if (target.immune || target.evolving) {
      if (kind !== 'fire' && kind !== 'scorch') target.hitFlash = sec(CONFIG.wizard.hitFlashTime);
      if (source && source !== target) source.stats.hits++;
      if (knockDir && knockback > 0 && !target.evolving) target.addKnockback(knockDir.x, knockDir.z, knockback);
      ev.atPos('damage', point, target.index, kind, 0, source ? source.index : -1);
      return 0;
    }
    const dealt = target.takeDamage(amount);
    if (dealt <= 0) return 0;
    if (source && source !== target) {
      source.stats.damageDealt += dealt;
      source.stats.hits++;
      if (kind !== 'ultimate') source.addUlt(mul(dealt, ULT_PER_DEALT));
    }
    if (knockDir && knockback > 0) target.addKnockback(knockDir.x, knockDir.z, knockback);
    ev.atPos('damage', point, target.index, kind, dealt, source ? source.index : -1);
    if (!target.alive) {
      ev.push('ko', target.index, '', 0, source && source !== target ? source.index : -1);
      this.world.handleKo();
    }
    return dealt;
  }
}

function copy(o: V3, a: V3): void {
  o.x = a.x;
  o.y = a.y;
  o.z = a.z;
}

function distPointSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax, abz = bz - az;
  const ab2 = mul(abx, abx) + mul(abz, abz);
  const t = ab2 <= 0 ? 0 : clamp(muldiv(mul(px - ax, abx) + mul(pz - az, abz), ONE, ab2), 0, ONE);
  return len2(px - (ax + mul(abx, t)), pz - (az + mul(abz, t)));
}

export { DT };
