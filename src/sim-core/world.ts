/**
 * The whole duel in one deterministic object: wizards, spells, arena, golden tickets, the fire
 * ring and the round flow (src/core/Game.ts tick order + src/core/Match.ts). `step()` advances one
 * 60 Hz tick from one input frame per seat. Nothing here reads a clock, the DOM or Math.random.
 */
import { CONFIG } from '../config';
import { SimArena, isArenaId, type ArenaId, type Body } from './arena';
import { SimEvents } from './events';
import { DT, HALF, ONE, fx, len2, max, mul, muldiv, sec } from './fixed';
import { Hasher } from './hash';
import { Rng } from './rng';
import { simRules, type RulesId, type SimRules } from './rules';
import { SimSpells } from './spells';
import { staffStats } from './staffs';
import { SimTickets } from './tickets';
import { SimWizard, emptyInput, type MuzzleSet, type SimInput } from './wizard';

const A = CONFIG.arena;
const M = CONFIG.match;
const W = CONFIG.wizard;

export type Phase = 'intro' | 'fight' | 'roundEnd' | 'matchEnd';

export interface SimSetup {
  /** Server-issued seed (online OP_START seed). */
  seed: number;
  rules: RulesId;
  arena: ArenaId;
  /** Staff item id per seat (null: none). Even rules (versus, online) ignore staff gameplay. */
  staffs: (string | null)[];
  /** Gauntlet boss id (A5), absent in duels. */
  bossId?: string | null;
}

export interface MatchState {
  phase: Phase;
  round: number;
  wins: [number, number];
  /** Round clock (TU) and the current phase's remaining time (TU). */
  timer: number;
  phaseTime: number;
  /** Side that took the last round, or -1 (draw / none yet). */
  lastWinner: number;
  /** Per finished round: winning side or -1 for a draw. */
  roundWinners: number[];
  lastReason: 'ko' | 'time' | '';
  /** Winning side of the match (-1 draw) once phase is matchEnd. */
  winner: number;
  /** Seat that forfeited, or -1. */
  forfeit: number;
  /** TU of fight phase this round. */
  elapsed: number;
}

const FIRE_RADIUS = fx(A.fireRadius);
const FIRE_DPS = fx(A.fireDps);
const LAVA_DPS = fx(A.lavaDps);
const FIRE_TICK = sec(A.fireTickInterval);
const FIRE_PUSH = fx(A.firePush);
const SUDDEN_AT = sec(A.suddenDeathAt);
const SUDDEN_MIN = fx(A.suddenDeathMinRadius);
const SPAWN_HALF = fx(A.spawnDistance / 2);
const WIZ_R = fx(W.radius);
const INTRO = sec(M.introTime);
const ROUND_END = sec(M.roundEndTime);
const LAVA_FEET = fx(0.15);

/** The player's look (manifest wizardPlayer muzzle [0.076, 0.916, 0.203] x fitHeight 1.9). */
export const PLAYER_MUZZLES: MuzzleSet = muzzleSet([[0.076, 0.916, 0.203]], 1.9);
/** The rival's placeholder staff (src/wizard/muzzles.ts PLACEHOLDER_MUZZLES.wizard, metres). */
export const RIVAL_MUZZLES: MuzzleSet = muzzleSet([[0.44, 1.8, 0.34]], 1);

/** Muzzle points given as [forward, up, right] fractions of a look `height` m tall. */
export function muzzleSet(points: [number, number, number][], height: number, use?: Partial<Record<'bolt' | 'volley' | 'blast' | 'stun' | 'ultimate', number[]>>): MuzzleSet {
  const all: number[] = [];
  const pts = points.map((p, i) => {
    all.push(i);
    return { x: fx(-p[2] * height), y: fx(p[1] * height), z: fx(p[0] * height) };
  });
  const bolt = use && use.bolt ? use.bolt : all;
  return {
    points: pts,
    bolt,
    volley: use && use.volley ? use.volley : bolt,
    blast: use && use.blast ? use.blast : bolt,
    stun: use && use.stun ? use.stun : bolt,
    ultimate: use && use.ultimate ? use.ultimate : bolt,
  };
}

export class SimWorld {
  readonly setup: SimSetup;
  readonly rules: SimRules;
  readonly rng: Rng;
  readonly events = new SimEvents();
  readonly arena: SimArena;
  /** By seat: [seat 0 (side 0), seat 1 (side 1)], plus a partner in double boss fights. */
  readonly wizards: SimWizard[] = [];
  readonly spells: SimSpells;
  readonly tickets: SimTickets;
  readonly match: MatchState = {
    phase: 'intro', round: 1, wins: [0, 0], timer: 0, phaseTime: 0, lastWinner: -1, roundWinners: [], lastReason: '', winner: -1, forfeit: -1, elapsed: 0,
  };
  tick = 0;
  /** Inputs are ignored while true (countdowns, round end): Game.actionsLocked. */
  actionsLocked = true;
  private lastCount = -1;
  private suddenAnnounced = false;
  private readonly bodies: Body[] = [];
  private readonly idle = emptyInput();

  constructor(setup: SimSetup) {
    if (!isArenaId(setup.arena)) throw new Error('unknown arena ' + String(setup.arena));
    this.setup = setup;
    this.rules = simRules(setup.rules);
    this.rng = new Rng(setup.seed | 0);
    this.arena = new SimArena(setup.arena);
    for (let i = 0; i < 2; i++) {
      const w = new SimWizard(i, i === 0 ? 0 : 1, this.events);
      w.staff = this.rules.even ? null : staffStats(setup.staffs[i]);
      w.muzzles = i === 0 ? PLAYER_MUZZLES : RIVAL_MUZZLES;
      w.onBlink = (b) => this.spells.spawnTrail(b);
      this.wizards.push(w);
    }
    this.spells = new SimSpells(this);
    this.tickets = new SimTickets(this.arena, this.wizards, this.rng, this.events);
    this.startMatch();
  }

  // ---------------------------------------------------------------- match flow

  private startMatch(): void {
    const m = this.match;
    m.round = 1;
    m.wins[0] = m.wins[1] = 0;
    m.roundWinners.length = 0;
    m.winner = -1;
    for (const w of this.wizards) {
      w.ult = 0;
      w.resetStats();
    }
    this.startRound();
  }

  private startRound(): void {
    this.spells.clear();
    this.tickets.clear();
    this.arena.reset();
    for (const w of this.wizards) w.resetForRound(M.ultCarriesOver);
    this.spawnWizards();
    const T = CONFIG.tickets;
    const iv = this.rules.single ? T.bossSpawnInterval : T.spawnInterval;
    this.tickets.interval = [sec(iv[0]), sec(iv[1])];
    const m = this.match;
    m.timer = this.rules.roundTime;
    m.elapsed = 0;
    m.phase = 'intro';
    m.phaseTime = INTRO;
    this.lastCount = -1;
    this.suddenAnnounced = false;
    this.actionsLocked = true;
    this.events.push('roundIntro', -1, '', m.round);
  }

  spawnSpot(w: SimWizard): [number, number, number] {
    if (w.side === 0) return [0, -SPAWN_HALF, 0];
    return [0, SPAWN_HALF, HALF];
  }

  private spawnWizards(): void {
    for (const w of this.wizards) {
      if (!w.active) continue;
      const s = this.spawnSpot(w);
      w.spawn(s[0], s[1], s[2]);
      w.aim.x = s[0];
      w.aim.y = fx(1.2);
      w.aim.z = -s[1];
    }
  }

  /** Side out of the fight: 0 when seat 0 is down, 1 when every enemy is down, else -1. */
  koWinnerSide(): number {
    if (!this.wizards[0].alive) return 1;
    for (let i = 1; i < this.wizards.length; i++) if (this.wizards[i].active && this.wizards[i].alive) return -1;
    return 0;
  }

  /** Called synchronously on a KO (Match.onKO). */
  private onKO(): void {
    if (this.match.phase !== 'fight') return;
    const side = this.koWinnerSide();
    if (side >= 0) this.endRound(side, 'ko');
  }

  /** Side winning on time (health fractions; equal is a draw, -1). */
  timeoutWinner(): number {
    const p = this.wizards[0];
    let hp = 0, maxHp = 0;
    for (let i = 1; i < this.wizards.length; i++) {
      const e = this.wizards[i];
      if (!e.active) continue;
      hp += e.health;
      maxHp += e.maxHealth;
    }
    // p.health / p.max vs hp / maxHp, cross-multiplied (exact).
    const a = p.health * maxHp, b = hp * p.maxHealth;
    return a === b ? -1 : a > b ? 0 : 1;
  }

  private endRound(side: number, reason: 'ko' | 'time'): void {
    const m = this.match;
    m.phase = 'roundEnd';
    m.phaseTime = ROUND_END;
    m.lastWinner = side;
    m.lastReason = reason;
    m.roundWinners.push(side);
    if (side >= 0) m.wins[side]++;
    this.events.push('roundEnd', side, reason, m.round);
  }

  private nextRound(): void {
    const m = this.match;
    const need = this.rules.roundsToWin;
    if (m.wins[0] >= need || m.wins[1] >= need) {
      m.phase = 'matchEnd';
      m.winner = m.wins[0] > m.wins[1] ? 0 : 1;
      this.actionsLocked = true;
      this.events.push('matchEnd', m.winner);
      return;
    }
    m.round++;
    this.startRound();
  }

  /** A seat leaves: the other side wins at once (online Resume / Forfeit, disconnects). */
  forfeit(seat: number): void {
    const m = this.match;
    if (m.phase === 'matchEnd') return;
    m.forfeit = seat;
    m.phase = 'matchEnd';
    m.winner = seat === 0 ? 1 : 0;
    this.actionsLocked = true;
    this.events.push('matchEnd', m.winner, 'forfeit');
  }

  /** Seats that play from input, in log order (CPU seats are driven by the sim's own AI). */
  inputSeats(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.wizards.length; i++) if (!this.wizards[i].ai) out.push(i);
    return out;
  }

  get over(): boolean {
    return this.match.phase === 'matchEnd';
  }

  /** Winner side once decided (Match.decided), else -1. */
  get decidedWinner(): number {
    const m = this.match;
    if (m.phase === 'matchEnd') return m.winner;
    const need = this.rules.roundsToWin;
    if (m.phase === 'roundEnd' && (m.wins[0] >= need || m.wins[1] >= need)) return m.wins[0] > m.wins[1] ? 0 : 1;
    return -1;
  }

  // ---------------------------------------------------------------- the tick

  /** One fixed tick. `inputs[seat]` (missing seats idle). */
  step(inputs: readonly (SimInput | null | undefined)[]): void {
    if (this.over) return;
    this.tick++;
    const ws = this.wizards;
    if (this.actionsLocked) {
      for (let i = 0; i < ws.length; i++) {
        ws[i].latch(inputs[i] || null);
        ws[i].clearIntent();
      }
    } else {
      for (let i = 0; i < ws.length; i++) ws[i].applyInput(inputs[i] || this.idle);
    }
    for (const w of ws) if (w.active) w.updateTimers(DT);
    this.spells.update(DT);
    for (const w of ws) if (w.active) w.updateMovement(DT, this.arena, ws);
    this.arena.update(DT, this.liveBodies());
    this.updateFire(DT);
    this.tickets.update(DT);
    this.updateMatch(DT);
  }

  private liveBodies(): Body[] {
    const out = this.bodies;
    out.length = 0;
    for (const w of this.wizards) if (w.active) out.push(w.body());
    return out;
  }

  /** Fire ring burn and push, lava burn (FireRing.updateDamage). */
  private updateFire(dt: number): void {
    const radius = this.arena.fireRadius;
    for (const w of this.wizards) {
      if (!w.active || !w.alive) continue;
      const r = len2(w.pos.x, w.pos.z);
      const ring = r + WIZ_R > radius;
      const lava = !ring && w.pos.y <= LAVA_FEET && this.arena.hazardAt(w.pos.x, w.pos.z, 0, []) !== null;
      if (ring) {
        const rr = r || ONE;
        const ix = -muldiv(w.pos.x, ONE, rr), iz = -muldiv(w.pos.z, ONE, rr);
        const inward = mul(w.knock.x, ix) + mul(w.knock.z, iz);
        if (inward < FIRE_PUSH) w.addKnockback(ix, iz, FIRE_PUSH - inward);
      }
      if ((!ring && !lava) || w.fireproof) {
        w.burning = false;
        w.burnTimer = 0;
        continue;
      }
      if (!w.burning) {
        w.burning = true;
        w.burnTimer = FIRE_TICK;
      }
      w.burnTimer += dt;
      while (w.burnTimer >= FIRE_TICK) {
        w.burnTimer -= FIRE_TICK;
        const amount = muldiv(lava ? LAVA_DPS : FIRE_DPS, FIRE_TICK, 6000);
        this.spells.dealDamage(w, null, amount, { x: w.pos.x, y: lava ? fx(0.3) : ONE, z: w.pos.z }, 'fire', null, 0);
        this.events.push('burn', w.index);
        if (!w.alive) break;
      }
    }
  }

  private updateMatch(dt: number): void {
    const m = this.match;
    this.actionsLocked = m.phase !== 'fight';
    this.tickets.enabled = m.phase === 'fight' && this.rules.tickets;
    switch (m.phase) {
      case 'intro': {
        m.phaseTime -= dt;
        const count = Math.ceil(m.phaseTime / Math.floor(INTRO / 3));
        if (count !== this.lastCount && count > 0 && count <= 3) {
          this.lastCount = count;
          this.events.push('countdown', -1, '', count);
        }
        if (m.phaseTime <= 0) {
          m.phase = 'fight';
          this.actionsLocked = false;
          this.events.push('roundStart', -1, '', m.round);
        }
        break;
      }
      case 'fight': {
        m.elapsed += dt;
        m.timer = max(0, m.timer - dt);
        if (m.timer < SUDDEN_AT) {
          if (!this.suddenAnnounced) {
            this.suddenAnnounced = true;
            this.events.push('suddenDeath');
          }
          this.arena.fireRadius = SUDDEN_MIN + muldiv(FIRE_RADIUS - SUDDEN_MIN, m.timer, SUDDEN_AT);
        }
        if (m.timer <= 0) this.endRound(this.timeoutWinner(), 'time');
        break;
      }
      case 'roundEnd': {
        m.phaseTime -= dt;
        if (m.phaseTime <= 0) this.nextRound();
        break;
      }
      default:
        break;
    }
  }

  /** The KO hook: SimSpells.dealDamage emits 'ko'; the world ends the round in the same tick. */
  handleKo(): void {
    this.onKO();
  }

  // ---------------------------------------------------------------- hashing

  /** Fingerprint of everything that decides the outcome. */
  hash(): string {
    const h = new Hasher();
    h.int(this.tick).bool(this.actionsLocked);
    const m = this.match;
    h.str(m.phase).int(m.round).int(m.wins[0]).int(m.wins[1]).int(m.timer).int(m.phaseTime).int(m.lastWinner).int(m.winner).int(m.forfeit);
    const r = this.rng.state();
    h.int(r[0]).int(r[1]).int(r[2]).int(r[3]);
    for (const w of this.wizards) {
      h.int(w.pos.x).int(w.pos.y).int(w.pos.z).int(w.vel.x).int(w.vel.z).int(w.knock.x).int(w.knock.z).int(w.vy);
      h.bool(w.grounded).int(w.facing).int(w.health).int(w.maxHealth).int(w.mana).int(w.ult).int(w.manaBoost).int(w.manaDelay);
      for (let i = 0; i < w.cd.length; i++) h.int(w.cd[i]);
      for (let i = 0; i < w.buffered.length; i++) h.int(w.buffered[i]);
      h.int(w.dodgeTime).int(w.iframes).int(w.blinkTime).int(w.stunTime).int(w.evolveTime).int(w.shieldTime).int(w.shieldAge);
      h.int(w.cast ? w.cast.elapsed + 1 : 0).str(w.cast ? w.cast.spell : '').bool(w.alive).bool(w.active).int(w.burnTimer).int(w.muzzleTurn);
      h.int(w.stats.damageDealt).int(w.stats.hits).int(w.stats.casts);
    }
    for (const p of this.spells.active) {
      h.int(p.id).str(p.kind).int(p.owner.index).int(p.pos.x).int(p.pos.y).int(p.pos.z).int(p.vel.x).int(p.vel.y).int(p.vel.z);
      h.int(p.radius).int(p.damage).int(p.power).int(p.life).int(p.homing);
    }
    for (const wv of this.spells.waves) h.int(wv.owner.index).int(wv.radius);
    for (const t of this.spells.trails) h.int(t.owner.index).int(t.age);
    for (const ob of this.arena.obstacles) h.int(ob.hp).bool(ob.alive).int(ob.x).int(ob.z);
    h.int(this.arena.fireRadius);
    for (const t of this.tickets.list) h.int(t.id).int(t.x).int(t.z).int(t.age);
    h.int(this.tickets.spawnTimer);
    return h.hex();
  }
}
