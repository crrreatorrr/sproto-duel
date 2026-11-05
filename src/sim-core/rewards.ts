/**
 * Boss reward spells in the sim: the deterministic port of src/spells/RewardSpells.ts (Magic
 * Carpet, Pump It, Vape Cloud, Lock-On, Hellfire Breath, burning, carpet rams) plus the Vape Cloud
 * smoke screens Arena.addSmoke keeps. Carpet and flight movement live in wizard.ts.
 */
import { CONFIG } from '../config';
import { REWARD_SPELL_INFO } from '../spells/rewardCatalog';
import { HIT_OBSTACLE, type ArenaQuery, type Hit } from './arena';
import { ONE, TU, abs, atan2, deg, fx, len2, len3, max, min, mul, muldiv, rad, sec, setLength2, setLength3, vt, type V3 } from './fixed';
import type { SimProjectile } from './spells';
import type { SimWizard } from './wizard';
import type { SimWorld } from './world';

/** REWARD_SPELLS order (src/spells/rewardCatalog.ts); SimWizard.learned bit i and rcd[i]. */
export const REWARDS = ['carpet', 'pump', 'vape', 'lockon', 'breath'] as const;
export const R_CARPET = 0, R_PUMP = 1, R_VAPE = 2, R_LOCKON = 3, R_BREATH = 4;
/** Action index (wizard.ts ACTIONS) of reward spell i is 7 + i. */
export const REWARD_ACTION = 7;

/** A smoke screen a wizard dropped (Arena smokes). */
export interface SimSmoke {
  owner: number;
  x: number;
  z: number;
  r: number;
  height: number;
  age: number;
  life: number;
}

/** What blocks a reward spell press (RewardSpells.blocked). */
export const BLOCK_NONE = 0, BLOCK_UNLEARNED = 1, BLOCK_BUSY = 2, BLOCK_COOLDOWN = 3, BLOCK_MANA = 4;

const RS = CONFIG.rewardSpells;
const MOVE = fx(CONFIG.wizard.moveSpeed);
/** Per REWARDS index. */
const COST = [fx(RS.carpet.manaCost), fx(RS.pump.manaCost), fx(RS.vape.manaCost), fx(RS.lockon.manaCost), fx(RS.breath.manaCost)];
const COOLDOWN = [sec(RS.carpet.cooldown), sec(RS.pump.cooldown), sec(RS.vape.cooldown), sec(RS.lockon.cooldown), sec(RS.breath.cooldown)];
const CALLOUT = [REWARD_SPELL_INFO.carpet.callout, REWARD_SPELL_INFO.pump.callout, REWARD_SPELL_INFO.vape.callout, REWARD_SPELL_INFO.lockon.callout, REWARD_SPELL_INFO.breath.callout];

const CARPET_TIME = sec(RS.carpet.duration);
/** Takeoff: moveSpeed x speedMultiplier x (1 + boost), as wizard.ts computes the full-boost speed. */
const CARPET_LAUNCH = mul(mul(MOVE, fx(RS.carpet.speedMultiplier)), ONE + fx(RS.carpet.boost));
const RAM_SPEED = fx(RS.carpet.ramSpeed);
const RAM_DAMAGE = fx(RS.carpet.ramDamage);
const RAM_KNOCK = fx(RS.carpet.ramKnockback);
const RAM_REACH = fx(0.35);
const RAM_DY = fx(1.6);
const PUMP_TIME = sec(RS.pump.duration);
const VAPE_R = fx(RS.vape.radius);
const VAPE_H = fx(RS.vape.height);
const VAPE_LIFE = sec(RS.vape.duration);
const VAPE_HEAL = fx(RS.vape.healPerSecond);
const VAPE_PAUSE = sec(RS.vape.castHealPause);
const LOCK_TIME = sec(RS.lockon.duration);
const LOCK_HALF = deg(RS.lockon.coneDegrees / 2);
const LOCK_RANGE = fx(RS.lockon.range);
/** Angle units per second. */
const LOCK_TURN = rad(RS.lockon.turnRate);
const LOCK_DROP = deg(RS.lockon.dropDegrees);
const BREATH_TIME = sec(RS.breath.duration);
const BREATH_RANGE = fx(RS.breath.range);
const BREATH_HALF = deg(RS.breath.coneDegrees / 2);
const BREATH_TICK = sec(RS.breath.tick);
const BREATH_HIT = fx(RS.breath.dps * RS.breath.tick);
const BURN_TIME = sec(RS.breath.burnTime);
const BURN_TICK = sec(RS.breath.burnTick);
const BURN_HIT = fx(RS.breath.burnDps * RS.breath.burnTick);
const BLOCK_SHOW = sec(0.6);
/** Body heights sampled by the breath cone (feet-relative, x sizeScale). */
const CONE_H = [fx(1.2), fx(0.5), fx(1.75)];
const K_0_3 = fx(0.3);
const K_0_1 = fx(0.1);
const CALLOUT_Y = fx(2.1);
/** Most dropped smoke screens at once (Arena MAX_SMOKES; the oldest clears early). */
const MAX_SMOKES = 4;

const breathQuery: ArenaQuery = { world: true, seeThrough: false, floor: true, bodies: null };
const breathHit: Hit = { kind: 0, index: -1, t: 0 };

/** The angle (angle units, 0..HALF turn) between Q16 vector v (length `d`) and unit vector u. */
function angleBetween(vx: number, vy: number, vz: number, ux: number, uy: number, uz: number): number {
  const dot = mul(vx, ux) + mul(vy, uy) + mul(vz, uz);
  const cx = mul(vy, uz) - mul(vz, uy), cy = mul(vz, ux) - mul(vx, uz), cz = mul(vx, uy) - mul(vy, ux);
  return atan2(len3(cx, cy, cz), dot);
}

export class SimRewards {
  readonly smokes: SimSmoke[] = [];
  /** Per wizard index: TU to the next breath lick (while channelling), and whether it is channelling. */
  private readonly breathTick: number[] = [];
  private readonly breathOn: boolean[] = [];
  /** Vape-cloud healing not yet shown as a popup, per wizard index. */
  private readonly healShown: number[] = [];
  /** Who each rider's carpet already rammed this ride (wizard indices), per rider index. */
  private readonly rammed: number[][] = [];
  /** Sim time (TU) of the last BLOCK callout a shield made against the breath, per shielder. */
  private readonly blockShownAt: number[] = [];
  private time = 0;
  private readonly tmpA: V3 = { x: 0, y: 0, z: 0 };
  private readonly tmpDir: V3 = { x: 0, y: 0, z: 0 };
  private readonly tmpPoint: V3 = { x: 0, y: 0, z: 0 };

  constructor(protected readonly world: SimWorld) {
    this.clear();
  }

  /** Why `w` can't cast reward spell `id` now (BLOCK_*), or BLOCK_NONE. */
  blocked(w: SimWizard, id: number): number {
    if (!w.knows(id)) return BLOCK_UNLEARNED;
    if (!w.canAct) return BLOCK_BUSY;
    if (w.rcd[id] > 0) return BLOCK_COOLDOWN;
    if (!w.infiniteMana && w.mana < COST[id]) return BLOCK_MANA;
    return BLOCK_NONE;
  }

  /** `w` could cast reward spell `id` (REWARDS index) right now. */
  ready(w: SimWizard, id: number): boolean {
    return this.blocked(w, id) === BLOCK_NONE;
  }

  /**
   * Buffered reward presses into casts; runs in SimSpells.handleIntents before the core spells.
   * Pressing the carpet while riding lands it; presses of spells still cooling down stay buffered.
   */
  handleIntents(w: SimWizard): void {
    if (!w.alive || w.stunned || w.evolving) return;
    for (let id = 0; id < REWARDS.length; id++) {
      const a = REWARD_ACTION + id;
      if (!w.wants(a)) continue;
      if (id === R_CARPET && w.riding) {
        w.consume(a);
        w.endRide();
        continue;
      }
      const why = this.blocked(w, id);
      if (why === BLOCK_COOLDOWN || why === BLOCK_BUSY) continue; // stays buffered until ready
      w.consume(a);
      if (why === BLOCK_UNLEARNED) {
        if (w.side === 0) this.world.events.push('callout', w.index, 'NOT LEARNED', 0, -1, w.pos.x, w.pos.y + w.chestY, w.pos.z);
        continue;
      }
      if (why === BLOCK_MANA) {
        this.world.spells.noMana(w);
        continue;
      }
      this.cast(w, id);
      return; // one cast per tick
    }
  }

  /** Cast `id` for `w` (rules already checked). */
  private cast(w: SimWizard, id: number): void {
    w.spendMana(COST[id]);
    w.rcd[id] = COOLDOWN[id];
    w.stats.casts++;
    w.castPulse = ONE;
    const px = w.pos.x, py = w.pos.y, pz = w.pos.z;
    switch (id) {
      case R_CARPET:
        w.carpetTime = CARPET_TIME;
        this.rammed[w.index] = [];
        // Takeoff at the burst's speed where you're steering (standing still, the burst waits).
        if (w.moveX * w.moveX + w.moveZ * w.moveZ > K_0_1 * K_0_1) {
          const v = this.tmpDir;
          if (setLength2(v, w.moveX, w.moveZ, CARPET_LAUNCH)) {
            w.vel.x = v.x;
            w.vel.y = 0;
            w.vel.z = v.z;
          }
        }
        break;
      case R_PUMP:
        w.pumpTime = PUMP_TIME;
        break;
      case R_VAPE:
        this.addSmoke(w.index, w.pos.x, w.pos.z, VAPE_R, VAPE_H, VAPE_LIFE);
        break;
      case R_LOCKON:
        w.lockTime = LOCK_TIME;
        break;
      case R_BREATH:
        w.breathTime = BREATH_TIME;
        // The first lick lands at once.
        this.breathTick[w.index] = 0;
        this.breathOn[w.index] = true;
        break;
    }
    const ev = this.world.events;
    if (RS.popups) ev.push('callout', w.index, CALLOUT[id], 0, -1, w.pos.x, w.pos.y + mul(CALLOUT_Y, w.sizeScale), w.pos.z);
    ev.push('rewardCast', w.index, REWARDS[id], id, -1, px, py, pz);
  }

  /** Drop a smoke screen (Arena.addSmoke): past MAX_SMOKES the oldest clears. */
  addSmoke(owner: number, x: number, z: number, r: number, height: number, life: number): SimSmoke {
    while (this.smokes.length >= MAX_SMOKES) this.expireSmoke(0);
    const s: SimSmoke = { owner, x, z, r, height, age: 0, life };
    this.smokes.push(s);
    return s;
  }

  private expireSmoke(i: number): void {
    const s = this.smokes[i];
    this.smokes.splice(i, 1);
    this.world.events.push('rewardEnd', s.owner, 'vape');
  }

  /** Effects over time: the breath cone, burning, carpet rams, vape healing, smoke expiry. */
  update(dt: number): void {
    this.time += dt;
    const ws = this.world.wizards;
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      if (w.breathing && w.alive) {
        w.sinceAttack = 0; // the flames give a vape-cloud hider away
        if (!this.breathOn[i]) {
          // Channelling without a cast through here (never in play): start ticking at once.
          this.breathOn[i] = true;
          this.breathTick[i] = 0;
        }
        this.breathe(w, dt);
      } else if (this.breathOn[i]) {
        this.breathOn[i] = false;
        this.breathTick[i] = 0;
        this.world.events.push('rewardEnd', i, 'breath');
      }
      if (w.scorched) this.burn(w, dt);
      if (w.riding && w.alive) this.ram(w);
    }
    this.healInSmoke(dt);
    // Arena.update ages the smoke after movement; here, after the healing it already gave.
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const s = this.smokes[i];
      s.age += dt;
      if (s.age >= s.life) this.expireSmoke(i);
    }
  }

  /** Magic Carpet ram: flying into an enemy fast enough hits it once per ride and knocks it back. */
  private ram(w: SimWizard): void {
    if (len2(w.vel.x, w.vel.z) < RAM_SPEED) return;
    let done = this.rammed[w.index];
    if (!done) done = this.rammed[w.index] = [];
    const ws = this.world.wizards;
    for (let i = 0; i < ws.length; i++) {
      const o = ws[i];
      if (o.side === w.side || !o.alive || !o.active || done.indexOf(i) >= 0) continue;
      const dx = o.pos.x - w.pos.x, dz = o.pos.z - w.pos.z;
      if (len2(dx, dz) > w.radius + o.radius + RAM_REACH || abs(o.pos.y - w.pos.y) > RAM_DY) continue;
      // Only what is ahead of the carpet.
      if (dx * w.vel.x + dz * w.vel.z <= 0) continue;
      done.push(i);
      if (o.invulnerable) continue;
      const point = { x: o.pos.x, y: o.pos.y + o.chestY, z: o.pos.z };
      this.world.spells.dealDamage(o, w, RAM_DAMAGE, point, 'ram', { x: w.vel.x, y: 0, z: w.vel.z }, RAM_KNOCK);
      const ev = this.world.events;
      ev.atPos('callout', point, i, 'RAMMED!');
      ev.atPos('carpetRam', point, w.index, '', 0, i);
    }
  }

  /** Hellfire Breath: every `tick`, damage and set alight every enemy inside the cone. */
  private breathe(w: SimWizard, dt: number): void {
    let t = this.breathTick[w.index] - dt;
    if (t > 0) {
      this.breathTick[w.index] = t;
      return;
    }
    t += BREATH_TICK;
    this.breathTick[w.index] = t;
    const origin = w.castPoint('blast', this.tmpA);
    const dir = this.aimDir(w, origin, this.tmpDir);
    const ws = this.world.wizards;
    for (let i = 0; i < ws.length; i++) {
      const o = ws[i];
      if (o.side === w.side || !o.alive || !o.active) continue;
      const point = this.inCone(origin, dir, o, this.tmpPoint);
      if (!point) continue;
      if (o.invulnerable) continue; // rolling through the flames
      if (o.shielded) {
        const last = this.blockShownAt[i];
        if (last === undefined || this.time - last > BLOCK_SHOW) {
          this.blockShownAt[i] = this.time;
          this.world.events.push('callout', i, 'BLOCK', 0, -1, o.pos.x, o.pos.y + o.chestY, o.pos.z);
        }
        continue;
      }
      this.world.spells.dealDamage(o, w, BREATH_HIT, { x: point.x, y: point.y, z: point.z }, 'breath', null, 0);
      if (!o.alive) continue;
      if (!o.scorched) o.scorchTimer = BURN_TICK;
      o.scorchTime = BURN_TIME;
      o.scorchBy = w.index;
    }
    // Glass stops the flames (inCone) and they crack it: a pane takes as many licks as bolts.
    const arena = this.world.arena;
    arena.cast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, BREATH_RANGE, 0, breathQuery, breathHit);
    if (breathHit.kind === HIT_OBSTACLE) {
      const ob = arena.obstacles[breathHit.index];
      if (ob && ob.seeThrough) {
        const p = { x: origin.x + mul(dir.x, breathHit.t), y: origin.y + mul(dir.y, breathHit.t), z: origin.z + mul(dir.z, breathHit.t) };
        this.world.spells.damageObstacle(breathHit.index, BREATH_HIT, p);
      }
    }
  }

  /**
   * The point of `o`'s body (chest, feet or head height) inside the breath's cone from `origin`
   * along unit `dir`, in range and with nothing in between (glass included), or null.
   */
  inCone(origin: V3, dir: V3, o: SimWizard, out: V3): V3 | null {
    for (let k = 0; k < CONE_H.length; k++) {
      out.x = o.pos.x;
      out.y = o.pos.y + mul(CONE_H[k], o.sizeScale);
      out.z = o.pos.z;
      const vx = out.x - origin.x, vy = out.y - origin.y, vz = out.z - origin.z;
      const d = len3(vx, vy, vz);
      if (d > BREATH_RANGE + o.radius) continue;
      if (d > 65) {
        const angle = angleBetween(vx, vy, vz, dir.x, dir.y, dir.z);
        if (angle > BREATH_HALF + atan2(o.radius, max(K_0_3, d))) continue;
      }
      if (!this.world.arena.clear(origin.x, origin.y, origin.z, out.x, out.y, out.z, true)) continue;
      return out;
    }
    return null;
  }

  /** The burning debuff's damage over time. */
  private burn(w: SimWizard, dt: number): void {
    w.scorchTime = max(0, w.scorchTime - dt);
    w.scorchTimer -= dt;
    while (w.scorchTimer <= 0 && w.alive) {
      w.scorchTimer += BURN_TICK;
      const by = w.scorchBy >= 0 ? this.world.wizards[w.scorchBy] : null;
      this.world.spells.dealDamage(w, by, BURN_HIT, { x: w.pos.x, y: w.pos.y + w.chestY, z: w.pos.z }, 'scorch', null, 0);
    }
    if (w.scorchTime <= 0) {
      w.scorchTime = 0;
      w.scorchBy = -1;
    }
  }

  /** Each smoke screen heals its owner while it stands inside, except just after it attacked. */
  private healInSmoke(dt: number): void {
    const ws = this.world.wizards;
    for (let k = 0; k < this.smokes.length; k++) {
      const s = this.smokes[k];
      const w = ws[s.owner];
      if (!w.alive || !w.active || w.pos.y > s.height || w.sinceAttack < VAPE_PAUSE) continue;
      if (len2(w.pos.x - s.x, w.pos.z - s.z) >= s.r) continue;
      const before = w.health;
      w.health = min(w.maxHealth, w.health + vt(VAPE_HEAL, dt));
      const healed = w.health - before;
      if (healed <= 0) continue;
      const shown = (this.healShown[s.owner] || 0) + healed;
      // One popup per few HP, so the heal reads without a stream of numbers.
      if (shown >= VAPE_HEAL) {
        this.world.events.push('rewardHeal', s.owner, '', shown);
        this.healShown[s.owner] = 0;
      } else this.healShown[s.owner] = shown;
    }
  }

  /** Unit direction from `from` toward `w`'s aim point (its facing if the aim point is too close). */
  aimDir(w: SimWizard, from: V3, out: V3): V3 {
    const a = w.aimPoint();
    const x = a.x - from.x, y = a.y - from.y, z = a.z - from.z;
    if (len3(x, y, z) < ONE || !setLength3(out, x, y, z, ONE)) {
      out.x = w.forwardX();
      out.y = 0;
      out.z = w.forwardZ();
    }
    return out;
  }

  /** Lock-On's target for a bolt `w` launches now (wizard index), or -1. */
  lockTarget(w: SimWizard): number {
    const origin = this.tmpA;
    origin.x = w.pos.x;
    origin.y = w.pos.y + w.chestY;
    origin.z = w.pos.z;
    const dir = this.aimDir(w, origin, this.tmpDir);
    let best = -1;
    let bestD = 0;
    const ws = this.world.wizards;
    for (let i = 0; i < ws.length; i++) {
      const o = ws[i];
      if (o.side === w.side || !o.alive || !o.active) continue;
      const vx = o.pos.x - origin.x, vy = o.pos.y + o.chestY - origin.y, vz = o.pos.z - origin.z;
      const d = len3(vx, vy, vz);
      if (d > LOCK_RANGE || d <= 65) continue;
      if (angleBetween(vx, vy, vz, dir.x, dir.y, dir.z) > LOCK_HALF) continue;
      if (best < 0 || d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** Lock-On homing for one bolt this tick: turn toward its target at the gentle `turnRate`. */
  steer(p: SimProjectile, dt: number): void {
    const t = this.world.wizards[p.seek];
    if (!t || !t.alive || !t.active || t.side === p.owner.side) {
      p.seek = -1;
      return;
    }
    const speed = len3(p.vel.x, p.vel.y, p.vel.z);
    if (speed <= 65) return;
    const want = this.tmpPoint;
    if (!setLength3(want, t.pos.x - p.pos.x, t.pos.y + t.chestY - p.pos.y, t.pos.z - p.pos.z, ONE)) return;
    const cur = this.tmpDir;
    cur.x = muldiv(p.vel.x, ONE, speed);
    cur.y = muldiv(p.vel.y, ONE, speed);
    cur.z = muldiv(p.vel.z, ONE, speed);
    const angle = angleBetween(cur.x, cur.y, cur.z, want.x, want.y, want.z);
    if (angle > LOCK_DROP) {
      p.seek = -1; // flew past it
      return;
    }
    const maxTurn = muldiv(LOCK_TURN, dt, TU);
    if (angle > 0) {
      const k = min(ONE, muldiv(maxTurn, ONE, angle));
      const x = cur.x + mul(want.x - cur.x, k), y = cur.y + mul(want.y - cur.y, k), z = cur.z + mul(want.z - cur.z, k);
      if (!setLength3(cur, x, y, z, ONE)) return;
    }
    p.vel.x = mul(cur.x, speed);
    p.vel.y = mul(cur.y, speed);
    p.vel.z = mul(cur.z, speed);
  }

  /** The smoke `owner` (index, -1 anyone) dropped that (x, z) stands in, or null. */
  smokeAt(x: number, z: number, owner: number): SimSmoke | null {
    for (let i = 0; i < this.smokes.length; i++) {
      const s = this.smokes[i];
      if ((owner < 0 || s.owner === owner) && len2(x - s.x, z - s.z) < s.r) return s;
    }
    return null;
  }

  clear(): void {
    this.smokes.length = 0;
    this.breathTick.length = this.breathOn.length = this.healShown.length = this.rammed.length = this.blockShownAt.length = 0;
    const n = this.world.wizards.length;
    for (let i = 0; i < n; i++) {
      this.breathTick.push(0);
      this.breathOn.push(false);
      this.healShown.push(0);
      this.rammed.push([]);
    }
    this.time = 0;
  }
}
