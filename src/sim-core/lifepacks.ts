/**
 * Life packs in the sim: the deterministic port of src/arena/LifePacks.ts gameplay (Boss Gauntlet
 * health pickups for the player, at most three a fight, spread over the stages). The flask, beam
 * and sparkles stay in the game.
 */
import { CONFIG } from '../config';
import { ONE, cos, fx, len2, mul, sec, sin } from './fixed';
import type { SimWizard } from './wizard';
import type { SimWorld } from './world';

const L = CONFIG.lifePacks;
const TK = CONFIG.tickets;
const FIRST0 = sec(L.firstDelay[0]);
const FIRST1 = sec(L.firstDelay[1]);
const LOW = fx(L.lowHealth);
const LOW_DELAY = sec(L.lowHealthDelay);
const MIN_GAP = sec(L.minGap);
const LIFE = sec(L.lifetime);
const HEAL = fx(L.heal);
const PLAYER_D0 = fx(L.playerDistance[0]);
const PLAYER_D1 = fx(L.playerDistance[1]);
const BOSS_D = fx(L.bossDistance);
const RETRY = sec(L.retryDelay);
const PICK_R = fx(L.pickupRadius);
const PICK_H = fx(L.pickupMaxHeight);
const HOVER = fx(L.hoverHeight);
const BURN = fx(TK.fireBurnMargin);
const MARGIN = fx(TK.fireMargin);
/** "Never yet" for the time since the last pack (LifePacks sinceLast = 1e9 s). */
const OPEN = 1e9;

export interface SimLifePack {
  id: number;
  active: boolean;
  x: number;
  z: number;
  age: number;
}

/**
 * Events (position = the pack at hover height; `o` = the pack id): lifePackSpawn (n = packs left
 * this fight, f = the fight's first), lifePackPickup (w = collector, n = HP healed, Q16),
 * lifePackExpire.
 */
export class SimLifePacks {
  /** Spawning, ageing and pickups run only while true (the gauntlet's fight phase). */
  enabled = false;
  readonly pack: SimLifePack = { id: 0, active: false, x: 0, z: 0, age: 0 };
  /** This fight so far. */
  spawned = 0;
  collected = 0;
  expired = 0;
  private nextId = 1;
  /** Fight-phase TU in the current boss stage, and that stage. */
  stageTime = 0;
  stageSeen = -1;
  /** When the current stage's pack is due (stage TU). */
  dueAt = 0;
  /** TU since the last pack ended (collected or expired); starts open. */
  sinceLast = OPEN;
  retry = 0;

  constructor(protected readonly world: SimWorld) {}

  /** Packs this fight can still produce. */
  get remaining(): number {
    return Math.max(0, L.maxPerFight - this.spawned);
  }

  /** A new fight (match start): the fight's pack count and clocks reset. */
  reset(): void {
    this.spawned = this.collected = this.expired = 0;
    this.stageSeen = -1;
    this.stageTime = 0;
    this.sinceLast = OPEN;
    this.retry = 0;
    this.clearPack();
  }

  /** A checkpoint hands back `n` of the fight's spent packs (none on the floor, no gap to wait out). */
  restore(n: number): void {
    this.clearPack();
    this.spawned = Math.max(0, this.spawned - n);
    this.sinceLast = OPEN;
    this.retry = 0;
  }

  /** Round start: no pack on the floor. */
  clearPack(): void {
    this.pack.active = false;
  }

  /** The furthest boss stage reached this fight (0..2). */
  private stage(): number {
    let far = 0;
    const st = this.world.stages;
    for (let i = 0; i < st.length; i++) if (st[i].stage > far) far = st[i].stage;
    return far;
  }

  private get player(): SimWizard {
    return this.world.wizards[0];
  }

  update(dt: number): void {
    const p = this.pack;
    if (p.active && len2(p.x, p.z) > this.world.arena.fireRadius - BURN) this.expire();
    if (!this.enabled) return;
    const stage = this.stage();
    if (stage !== this.stageSeen) {
      this.stageSeen = stage;
      this.stageTime = 0;
      this.dueAt = this.world.rng.range(FIRST0, FIRST1);
    }
    this.stageTime += dt;
    if (this.sinceLast < OPEN) this.sinceLast += dt;
    if (p.active) {
      p.age += dt;
      if (p.age >= LIFE) this.expire();
      else if (this.touching(this.player)) this.collect(this.player);
      return;
    }
    if (this.retry > 0) {
      this.retry -= dt;
      return;
    }
    if (this.isDue() && !this.spawn()) this.retry = RETRY;
  }

  /** A pack should appear now (none on the floor). */
  isDue(): boolean {
    if (this.spawned >= Math.min(L.maxPerFight, this.stageSeen + 1) || this.sinceLast < MIN_GAP) return false;
    const pl = this.player;
    const low = pl.alive && pl.health < mul(pl.maxHealth, LOW) && this.stageTime >= LOW_DELAY;
    return low || this.stageTime >= this.dueAt;
  }

  private touching(w: SimWizard): boolean {
    const p = this.pack;
    return w.alive && w.pos.y <= PICK_H && len2(w.pos.x - p.x, w.pos.z - p.z) <= PICK_R;
  }

  /** Heal `w` (never above max health) and remove the pack. */
  collect(w: SimWizard): void {
    const p = this.pack;
    if (!p.active) return;
    const before = w.health;
    w.health = Math.min(w.maxHealth, w.health + mul(w.maxHealth, HEAL));
    const healed = w.health - before;
    this.collected++;
    this.end();
    this.world.events.push('lifePackPickup', w.index, '', healed, p.id, p.x, HOVER, p.z);
  }

  private expire(): void {
    const p = this.pack;
    this.expired++;
    this.end();
    this.world.events.push('lifePackExpire', -1, '', 0, p.id, p.x, HOVER, p.z);
  }

  private end(): void {
    this.pack.active = false;
    this.sinceLast = 0;
  }

  /** Try random spots until one is valid; false if none was found this time. */
  spawn(): boolean {
    if (this.world.arena.fireRadius - MARGIN < ONE) return false;
    const pl = this.player.pos;
    const rng = this.world.rng;
    for (let i = 0; i < L.spawnAttempts; i++) {
      // Around the player, inside the ring.
      const d = rng.range(PLAYER_D0, PLAYER_D1);
      const a = rng.next() >>> 16;
      const x = pl.x + mul(sin(a), d), z = pl.z + mul(cos(a), d);
      if (this.isValidSpot(x, z)) return this.spawnAt(x, z) !== null;
    }
    return false;
  }

  /**
   * Open floor for a pack: everything a golden ticket needs, `playerDistance` from the player and
   * at least `bossDistance` from every standing boss.
   */
  isValidSpot(x: number, z: number): boolean {
    const pl = this.player.pos;
    const dp = len2(pl.x - x, pl.z - z);
    // The original allows 1e-6 m of slack: 1 Q16 unit covers the rounding of sin/cos x d.
    if (dp < PLAYER_D0 - 1 || dp > PLAYER_D1 + 1) return false;
    const ws = this.world.wizards;
    for (let i = 1; i < ws.length; i++) {
      const e = ws[i];
      if (e.active && e.alive && len2(e.pos.x - x, e.pos.z - z) < BOSS_D) return false;
    }
    return this.world.tickets.validSpot(x, z);
  }

  /** Put the pack at (x, z) without any checks. Null if one is already out or the budget is spent. */
  spawnAt(x: number, z: number): SimLifePack | null {
    const p = this.pack;
    if (p.active || this.spawned >= L.maxPerFight) return null;
    const first = this.spawned === 0;
    this.spawned++;
    p.active = true;
    p.id = this.nextId++;
    p.age = 0;
    p.x = x;
    p.z = z;
    this.world.events.push('lifePackSpawn', -1, '', this.remaining, p.id, x, HOVER, z, first);
    return p;
  }

  /** The pack if it is active, within `range` of `w` and in sight (AI), else null. */
  bestFor(w: SimWizard, range: number): SimLifePack | null {
    const p = this.pack;
    if (!p.active) return null;
    if (len2(w.pos.x - p.x, w.pos.z - p.z) > range) return null;
    return this.world.arena.clear(w.pos.x, w.pos.y + w.chestY, w.pos.z, p.x, HOVER, p.z, false) ? p : null;
  }
}
