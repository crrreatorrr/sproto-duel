/**
 * Arena shifts in the sim: the deterministic port of src/arena/ArenaShifts.ts gameplay (hazard pools
 * with quicksand slow, the healing spring, erupting vents, the fire ring pulling in per stage). The
 * decals, mood and particles stay in the game.
 */
import { CONFIG } from '../config';
import { obstacleDistance, type Hazard } from './arena';
import { ONE, abs, cos, fx, isqrt, len2, max, min, mul, sec, sin, vt } from './fixed';
import type { SimWizard } from './wizard';
import type { SimWorld } from './world';

const S = CONFIG.arenaShifts;
const A = CONFIG.arena;

export type ShiftKind = 'pool' | 'spring' | 'vent';

export interface SimShiftFeature {
  id: number;
  kind: ShiftKind;
  x: number;
  z: number;
  r: number;
  /** TU since it appeared (it fades in harmlessly for growTime). */
  age: number;
  /** Spring: health left to give (Q16). Vent: TU to the next eruption, and its period. */
  charge: number;
  timer: number;
  period: number;
  /** Vent: this cycle has warned. */
  warned: boolean;
}

const RING = [fx(S.ringRadius[0]), fx(S.ringRadius[1]), fx(S.ringRadius[2])];
const RING_SPEED = fx(S.ringSpeed);
const RING_MARGIN = fx(S.ringMargin);
const GROW = sec(S.growTime);
const WIZ_CLEAR = fx(S.wizardClearance);
const COVER_CLEAR = fx(S.coverClearance);
const SPACING = fx(S.spacing);
const POOL_R0 = fx(S.pool.radius[0]);
const POOL_R1 = fx(S.pool.radius[1]);
const SPRING_R = fx(S.spring.radius);
const SPRING_HEAL = fx(S.spring.heal);
const SPRING_CHARGE = fx(S.spring.charge);
const VENT_R = fx(S.vent.radius);
const VENT_P0 = sec(S.vent.period[0]);
const VENT_P1 = sec(S.vent.period[1]);
const VENT_WARN = sec(S.vent.warn);
const VENT_HALF_S = sec(0.5);
const VENT_KNOCK = fx(S.vent.knockback);
const VENT_TOP = fx(4);
const FIRE_TICK = sec(A.fireTickInterval);
const ZONE = fx(A.pickupZoneMargin);
const SPAWN_LANE = fx(A.spawnDistance / 2);
const TWO = fx(2);
const POOL_FEET = fx(0.15);
const SPRING_FEET = fx(0.4);
const K_0_3 = fx(0.3);
const K_0_1 = fx(0.1);
/** Shown heal popups: at least 1 HP, about once a second. */
const SHOW_TU = sec(1);

export class SimShifts {
  readonly features: SimShiftFeature[] = [];
  /** Kept-out floor (pools and vents, as Arena.shiftHazards): AI avoidance, pickup exclusion. */
  readonly hazards: Hazard[] = [];
  /** The furthest stage applied this round. */
  stage = 0;
  /** A stage the world reported that waits for the transformation to finish. */
  private pending = 0;
  private nextId = 1;
  /** Per wizard index: pool burn tick timer (-1 out of every pool), spring heal not yet shown and its clock. */
  private readonly burnTimer: number[] = [];
  private readonly healShown: number[] = [];
  private readonly healClock: number[] = [];

  constructor(protected readonly world: SimWorld) {
    this.resetPerWizard();
  }

  /**
   * Bring in stage `stage`'s features (1: pools and a spring; 2: vents and a refill). As in the game,
   * a transformation in progress finishes first: the stage is put in place by the next `update` once
   * no boss is evolving (the game's ArenaShifts.update waits on `evolving` too; the world reports a
   * stage before the transformation's grace starts). `placeStages` puts it in place at once.
   */
  applyStage(stage: number): void {
    if (stage > this.pending) this.pending = stage;
  }

  /** Put stages up to `stage` in place now (ArenaShifts.applyStage). */
  placeStages(stage: number): void {
    const shift = this.world.boss ? this.world.boss.shift : null;
    if (!shift) return;
    while (this.stage < min(stage, 2)) {
      this.stage++;
      if (this.stage === 1) {
        for (let i = 0; i < S.pool.count; i++) this.place('pool', this.world.rng.range(POOL_R0, POOL_R1));
        this.place('spring', SPRING_R);
      } else {
        for (let i = 0; i < S.vent.count; i++) this.place('vent', VENT_R);
        // The spring wells up again.
        for (let i = 0; i < this.features.length; i++) if (this.features[i].kind === 'spring') this.features[i].charge = SPRING_CHARGE;
      }
      this.world.events.push('arenaShift', -1, '', this.stage);
    }
  }

  private bossEvolving(): boolean {
    const ws = this.world.wizards;
    for (let i = 1; i < ws.length; i++) if (ws[i].active && ws[i].evolving) return true;
    return false;
  }

  /** The furthest stage any boss has reached (Game.furthestStage). */
  private furthest(): number {
    let far = 0;
    const st = this.world.stages;
    for (let i = 0; i < st.length; i++) if (st[i].stage > far) far = st[i].stage;
    return far;
  }

  /** Before movement: pool burns and slows, spring heals, vents erupt, the ring cap eases in. */
  update(dt: number): void {
    const ws = this.world.wizards;
    for (let i = 0; i < ws.length; i++) ws[i].groundSlow = ONE;
    const shift = this.world.boss ? this.world.boss.shift : null;
    if (!shift) return;
    const want = max(this.furthest(), this.pending);
    if (want > this.stage && !this.bossEvolving()) this.placeStages(want);

    const arena = this.world.arena;
    const ring = RING[this.stage];
    if (arena.ringCap > ring) arena.ringCap = max(ring, arena.ringCap - vt(RING_SPEED, dt));
    arena.fireRadius = min(arena.fireRadius, arena.ringCap);

    for (let i = 0; i < this.features.length; i++) {
      const f = this.features[i];
      f.age += dt;
      if (f.age < GROW) continue;
      if (f.kind === 'pool') this.updatePool(f, shift.pools, dt);
      else if (f.kind === 'spring') this.updateSpring(f, dt);
      else this.updateVent(f, shift.vents.damage, dt);
    }
    // Out of every pool: the next one burns at once.
    for (let i = 0; i < ws.length; i++) if (this.burnTimer[i] >= 0 && !this.poolAt(ws[i])) this.burnTimer[i] = -1;
    // Show what the springs healed about once a second.
    for (let i = 0; i < ws.length; i++) {
      if (this.healClock[i] < 0) continue;
      this.healClock[i] += dt;
      if (this.healShown[i] >= ONE && (this.healClock[i] >= SHOW_TU || !this.inSpring(ws[i]))) {
        this.world.events.push('springHeal', i, '', this.healShown[i], -1, ws[i].pos.x, ws[i].pos.y, ws[i].pos.z);
        this.healShown[i] = 0;
        this.healClock[i] = 0;
      }
    }
  }

  /** Inside a live pool (feet down, centre within it), or null. */
  poolAt(w: SimWizard): SimShiftFeature | null {
    if (w.pos.y > POOL_FEET || w.fireproof) return null;
    for (let i = 0; i < this.features.length; i++) {
      const f = this.features[i];
      if (f.kind === 'pool' && f.age >= GROW && len2(w.pos.x - f.x, w.pos.z - f.z) < f.r) return f;
    }
    return null;
  }

  inSpring(w: SimWizard): SimShiftFeature | null {
    if (w.pos.y > SPRING_FEET) return null;
    for (let i = 0; i < this.features.length; i++) {
      const f = this.features[i];
      if (f.kind === 'spring' && f.age >= GROW && len2(w.pos.x - f.x, w.pos.z - f.z) < f.r) return f;
    }
    return null;
  }

  /** A spring still running within `range` of `w` that the AI may walk to, or null. */
  springFor(w: SimWizard, range: number): SimShiftFeature | null {
    let best: SimShiftFeature | null = null;
    let bestD = range;
    for (let i = 0; i < this.features.length; i++) {
      const f = this.features[i];
      if (f.kind !== 'spring' || f.age < GROW || f.charge <= 0) continue;
      const d = len2(w.pos.x - f.x, w.pos.z - f.z);
      if (d < bestD) {
        best = f;
        bestD = d;
      }
    }
    return best;
  }

  private updatePool(f: SimShiftFeature, P: { dps: number; look: string; slow?: number }, dt: number): void {
    const ws = this.world.wizards;
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      if (!w.alive || this.poolAt(w) !== f) continue;
      if (P.slow !== undefined) w.groundSlow = min(w.groundSlow, fx(P.slow));
      if (P.dps <= 0) continue;
      let t = (this.burnTimer[i] >= 0 ? this.burnTimer[i] : FIRE_TICK) + dt;
      const amount = fx(P.dps * A.fireTickInterval);
      while (t >= FIRE_TICK) {
        t -= FIRE_TICK;
        this.world.spells.dealDamage(w, null, amount, { x: w.pos.x, y: K_0_3, z: w.pos.z }, P.look === 'magma' ? 'fire' : 'pool', null, 0);
      }
      this.burnTimer[i] = t;
    }
  }

  private updateSpring(f: SimShiftFeature, dt: number): void {
    if (f.charge <= 0) return;
    const ws = this.world.wizards;
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      if (!w.alive || w.health >= w.maxHealth || this.inSpring(w) !== f) continue;
      const amount = min(min(vt(SPRING_HEAL, dt), f.charge), w.maxHealth - w.health);
      w.health += amount;
      f.charge -= amount;
      if (this.healClock[i] < 0) this.healClock[i] = 0;
      this.healShown[i] += amount;
      if (f.charge <= 0) {
        f.charge = 0;
        break;
      }
    }
  }

  private updateVent(f: SimShiftFeature, damage: number, dt: number): void {
    f.timer += dt;
    const ev = this.world.events;
    if (!f.warned && f.timer >= f.period - VENT_WARN) {
      f.warned = true;
      ev.push('ventWarn', -1, '', f.id, -1, f.x, K_0_1, f.z);
    }
    if (f.timer < f.period) return;
    f.timer = 0;
    f.period = this.world.rng.range(VENT_P0, VENT_P1);
    f.warned = false;
    // Eruption: everyone over it (a roll's i-frames slip through) takes the hit and is thrown out.
    const ws = this.world.wizards;
    const hit = fx(damage);
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      if (!w.alive || !w.active || w.invulnerable) continue;
      let dx = w.pos.x - f.x, dz = w.pos.z - f.z;
      const d = len2(dx, dz);
      if (d > f.r + w.radius || w.pos.y > VENT_TOP) continue;
      if (d < 65) {
        dx = ONE;
        dz = 0;
      }
      this.world.spells.dealDamage(w, null, hit, { x: w.pos.x, y: w.pos.y + w.chestY, z: w.pos.z }, 'vent', { x: dx, y: 0, z: dz }, VENT_KNOCK);
    }
    ev.push('ventErupt', -1, '', f.id, -1, f.x, K_0_1, f.z);
  }

  /** Grow a feature on open floor: clear of wizards, cover, other features, lava and the ring. */
  private place(kind: ShiftKind, radius: number): SimShiftFeature | null {
    const rng = this.world.rng;
    const ring = RING[2] - RING_MARGIN - radius;
    for (let i = 0; i < S.attempts; i++) {
      const a = rng.next() >>> 16;
      const d = mul(ring, isqrt(rng.frac() * ONE));
      const x = mul(sin(a), d), z = mul(cos(a), d);
      if (!this.isOpen(x, z, radius)) continue;
      const f: SimShiftFeature = {
        id: this.nextId++, kind, x, z, r: radius, age: 0, charge: kind === 'spring' ? SPRING_CHARGE : 0,
        timer: 0, period: rng.range(VENT_P0, VENT_P1), warned: false,
      };
      if (kind !== 'spring') this.hazards.push({ x, z, r: radius });
      // Vents start at a random point of their cycle (never inside the first warning).
      if (kind === 'vent') f.timer = rng.range(0, f.period - VENT_WARN - VENT_HALF_S);
      this.features.push(f);
      return f;
    }
    return null;
  }

  /** Open floor for a feature of `radius` at (x, z). */
  isOpen(x: number, z: number, radius: number): boolean {
    const arena = this.world.arena;
    if (len2(x, z) + radius > RING[2] - RING_MARGIN) return false;
    if (arena.hazardAt(x, z, radius + SPACING, this.hazards) || this.excludesPickup(x, z)) return false;
    for (let i = 0; i < this.features.length; i++) {
      const f = this.features[i];
      if (len2(x - f.x, z - f.z) < f.r + radius + SPACING) return false;
    }
    const ws = this.world.wizards;
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      if (w.alive && w.active && len2(w.pos.x - x, w.pos.z - z) < radius + WIZ_CLEAR) return false;
    }
    const obs = arena.obstacles;
    for (let i = 0; i < obs.length; i++) if (obstacleDistance(obs[i], x, z) < radius + COVER_CLEAR) return false;
    // Not on the spawn lane (the next round starts there).
    if (abs(x) < radius + TWO && abs(z) < SPAWN_LANE + radius + TWO) return false;
    return true;
  }

  /** Out of lava and shift hazards, layout clouds and the rails of sliding cover (Arena.excludesPickup). */
  excludesPickup(x: number, z: number): boolean {
    const a = this.world.arena;
    if (a.hazardAt(x, z, ZONE, this.hazards)) return true;
    for (let i = 0; i < a.clouds.length; i++) {
      const c = a.clouds[i];
      if (len2(x - c.cx, z - c.cz) < c.r + ZONE) return true;
    }
    for (let i = 0; i < a.obstacles.length; i++) {
      const ob = a.obstacles[i];
      const m = ob.mover;
      if (!m) continue;
      const along = m.axis === 'x' ? abs(x - m.cx) : abs(z - m.cz);
      const across = m.axis === 'x' ? abs(z - m.cz) : abs(x - m.cx);
      if (along < m.half + ob.halfX + ZONE && across < max(ob.halfX, ob.halfZ) + ZONE) return true;
    }
    return false;
  }

  private resetPerWizard(): void {
    this.burnTimer.length = this.healShown.length = this.healClock.length = 0;
    const ws = this.world.wizards;
    for (let i = 0; i < ws.length; i++) {
      this.burnTimer.push(-1);
      this.healShown.push(0);
      this.healClock.push(-1);
    }
  }

  clear(): void {
    this.features.length = 0;
    this.hazards.length = 0;
    this.stage = 0;
    this.pending = 0;
    this.resetPerWizard();
    const ws = this.world.wizards;
    for (let i = 0; i < ws.length; i++) ws[i].groundSlow = ONE;
  }
}
