/**
 * Golden tickets in the sim (src/arena/GoldenTickets.ts gameplay): up to three floating pickups
 * during the fight phase; touching one gives a 15 s mana boost. Spawn spots come from the seeded
 * PRNG, so the server places them exactly where the player saw them.
 */
import { CONFIG } from '../config';
import type { Hazard, SimArena } from './arena';
import type { SimEvents } from './events';
import { ONE, cos, fx, isqrt, len2, mul, sec, sin } from './fixed';
import type { Rng } from './rng';
import type { SimWizard } from './wizard';

const T = CONFIG.tickets;
const A = CONFIG.arena;
const PICK_R = fx(T.pickupRadius);
const PICK_H = fx(T.pickupMaxHeight);
const LIFE = sec(T.lifetime);
const BURN = fx(T.fireBurnMargin);
const MARGIN = fx(T.fireMargin);
const CLEAR = fx(T.obstacleClearance);
const PROBE_TOP = fx(T.hoverHeight + 1.5 + 0.05);
const MIN_WIZ = fx(T.minWizardDistance);
const MIN_TICKET = fx(T.minTicketDistance);
const ZONE = fx(A.pickupZoneMargin);
const BOOST = sec(T.boostDuration);
const RETRY = sec(T.retryDelay);
const NO_HAZARDS: readonly Hazard[] = [];

export interface SimTicket {
  id: number;
  x: number;
  z: number;
  age: number;
}

export class SimTickets {
  enabled = false;
  readonly list: SimTicket[] = [];
  spawnTimer = 0;
  /** [min, max] TU between spawns (gauntlet fights use the slower interval). */
  interval: [number, number] = [sec(T.spawnInterval[0]), sec(T.spawnInterval[1])];
  nextId = 1;

  constructor(
    private readonly arena: SimArena,
    private readonly wizards: readonly SimWizard[],
    private readonly rng: Rng,
    private readonly events: SimEvents,
    /** Kept-out floor an arena shift added (Arena.shiftHazards). */
    private readonly shiftHazards: () => readonly Hazard[] = () => NO_HAZARDS,
  ) {}

  /** Round reset: no tickets, the first-spawn clock restarts. */
  clear(): void {
    this.list.length = 0;
    this.spawnTimer = this.rng.range(sec(T.firstSpawnDelay[0]), sec(T.firstSpawnDelay[1]));
  }

  update(dt: number): void {
    const fire = this.arena.fireRadius - BURN;
    for (let i = 0; i < this.list.length; i++) {
      const t = this.list[i];
      if (len2(t.x, t.z) > fire) {
        this.remove(i--, 'ticketExpire', 'fire', -1);
        continue;
      }
      if (!this.enabled) continue;
      t.age += dt;
      if (t.age >= LIFE) {
        this.remove(i--, 'ticketExpire', 'timeout', -1);
        continue;
      }
      const w = this.toucher(t);
      if (w) {
        const refreshed = w.manaBoost > 0;
        w.manaBoost = BOOST;
        w.mana = w.maxMana;
        this.remove(i--, 'ticketPickup', refreshed ? 'refreshed' : '', w.index);
      }
    }
    if (!this.enabled || this.list.length >= T.maxActive) return;
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) this.spawnTimer = this.spawn() ? this.rng.range(this.interval[0], this.interval[1]) : RETRY;
  }

  private remove(i: number, type: string, why: string, who: number): void {
    const t = this.list[i];
    this.list.splice(i, 1);
    this.events.push(type, who, why, t.id, -1, t.x, fx(T.hoverHeight), t.z);
  }

  private toucher(t: SimTicket): SimWizard | null {
    let best: SimWizard | null = null;
    let bestD = PICK_R;
    for (const w of this.wizards) {
      if (!w.active || !w.alive || w.pos.y > PICK_H) continue;
      const d = len2(w.pos.x - t.x, w.pos.z - t.z);
      if (d <= bestD) {
        bestD = d;
        best = w;
      }
    }
    return best;
  }

  private spawn(): boolean {
    const radius = this.arena.fireRadius - MARGIN;
    if (radius < ONE) return false;
    for (let i = 0; i < T.spawnAttempts; i++) {
      const r = mul(radius, isqrt(this.rng.frac() * ONE));
      const a = this.rng.next() >>> 16;
      const x = mul(sin(a), r), z = mul(cos(a), r);
      if (this.validSpot(x, z)) {
        const t: SimTicket = { id: this.nextId++, x, z, age: 0 };
        this.list.push(t);
        this.events.push('ticketSpawn', -1, '', t.id, -1, x, fx(T.hoverHeight), z);
        return true;
      }
    }
    return false;
  }

  /** Open floor for a pickup (GoldenTickets.isValidSpot; life packs reuse it). */
  validSpot(x: number, z: number): boolean {
    if (len2(x, z) > this.arena.fireRadius - MARGIN) return false;
    if (this.excluded(x, z)) return false;
    for (const w of this.wizards) if (w.active && len2(w.pos.x - x, w.pos.z - z) < MIN_WIZ) return false;
    for (const t of this.list) if (len2(t.x - x, t.z - z) < MIN_TICKET) return false;
    return !this.arena.blocked(x, z, CLEAR, PROBE_TOP);
  }

  /** Out of lava, vape clouds and the rails of sliding cover (Arena.excludesPickup). */
  private excluded(x: number, z: number): boolean {
    const a = this.arena;
    if (a.hazardAt(x, z, ZONE, this.shiftHazards())) return true;
    for (const c of a.clouds) if (len2(x - c.cx, z - c.cz) < c.r + ZONE) return true;
    for (const ob of a.obstacles) {
      const m = ob.mover;
      if (!m) continue;
      const along = m.axis === 'x' ? Math.abs(x - m.cx) : Math.abs(z - m.cz);
      const across = m.axis === 'x' ? Math.abs(z - m.cz) : Math.abs(x - m.cx);
      if (along < m.half + ob.halfX + ZONE && across < Math.max(ob.halfX, ob.halfZ) + ZONE) return true;
    }
    return false;
  }
}
