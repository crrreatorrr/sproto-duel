/**
 * Balance probes on the shipping simulation (src/sim-core), with no rendering: scripted players
 * against the Quick Duel rival, AI-against-AI soaks and boss-stage probes. Pure (no DOM, no
 * three), so the same code runs in the dev build (`__duel.qa.sim`) and in Node (`npm run
 * probe:sim`). Results are deterministic for a given seed and tuning.
 *
 * The scripted players (docs/gameplay-improvement-plan.md section 2):
 * - `holdFire`: stands still, aims at the opponent and holds the bolt button.
 * - `attacker`: the same while strafing, casting Blast, Stun, Shield and the Ultimate whenever
 *   they are affordable. `attackerPaused` also lets go of fire for 2 s in every 5.
 * - `idle`, `strafe`, `rollSpam` (strafes and rolls whenever the roll is ready): never attack.
 */
import { CONFIG, type AIProfile, type Difficulty } from '../config';
import { ONE, atan2, len2 } from '../sim-core/fixed';
import { SimAI } from '../sim-core/ai';
import { SimWorld } from '../sim-core/world';
import type { SimInput } from '../sim-core/wizard';
import { quantizeAim } from '../sim-core/testing/bot';

export type ScriptKind = 'holdFire' | 'attacker' | 'attackerPaused' | 'idle' | 'strafe' | 'rollSpam';
export const SCRIPT_KINDS: readonly ScriptKind[] = ['holdFire', 'attacker', 'attackerPaused', 'idle', 'strafe', 'rollSpam'];

const S = CONFIG.spells;
const TICKS = 60;
const q = (v: number) => v / ONE;
const P_BLAST = 1 << 1, P_SHIELD = 1 << 2, P_STUN = 1 << 3, P_ULT = 1 << 4, P_DODGE = 1 << 5;
const SPELL_KINDS = ['bolt', 'blast', 'stun', 'ultimate'] as const;

/** One scripted seat. `aim`: 'perfect' aims at the chest every tick; 'human' adds a slow wobble. */
export class ScriptedPlayer {
  private strafe = 1;
  private strafeLeft = 0;
  private t = 0;
  private wob = 0;

  constructor(readonly kind: ScriptKind, readonly seat = 0, private lcg = 12345, private readonly aim: 'perfect' | 'human' = 'perfect') {}

  private rand(): number {
    this.lcg = (Math.imul(this.lcg, 1103515245) + 12345) & 0x7fffffff;
    return this.lcg / 0x7fffffff;
  }

  input(world: SimWorld): SimInput {
    const f: SimInput = { move: 0, held: 0, press: 0, facing: 0, aimYaw: 0, aimPitch: 0, aimDist: 0 };
    const me = world.wizards[this.seat];
    let foe = world.wizards[this.seat === 0 ? 1 : 0];
    // A double boss fight: the nearest boss still standing.
    for (let i = 1; i < world.wizards.length && this.seat === 0; i++) {
      const w = world.wizards[i];
      if (!w.active || !w.alive) continue;
      if (!foe.alive || len2(w.pos.x - me.pos.x, w.pos.z - me.pos.z) < len2(foe.pos.x - me.pos.x, foe.pos.z - me.pos.z)) foe = w;
    }
    this.t++;
    const dx = foe.pos.x - me.pos.x, dz = foe.pos.z - me.pos.z;
    quantizeAim(world, this.seat, foe.pos.x, foe.pos.y + foe.chestY, foe.pos.z, f);
    if (this.aim === 'human') {
      this.wob = Math.max(-24, Math.min(24, this.wob + Math.round((this.rand() - 0.5) * 8)));
      f.aimYaw = (f.aimYaw + this.wob) & 1023;
    }
    f.facing = f.aimYaw;
    const k = this.kind;
    if (k === 'idle') return f;
    if (k !== 'holdFire') {
      if (--this.strafeLeft <= 0) {
        this.strafe = this.rand() < 0.5 ? 1 : -1;
        this.strafeLeft = 45 + Math.floor(this.rand() * 75);
      }
      const dist = len2(dx, dz);
      let dir = ((atan2(dx, dz) >> 6) / 1024) * 32 + this.strafe * 8;
      if (dist > 15 * ONE) dir -= this.strafe * 4;
      else if (dist < 8 * ONE) dir += this.strafe * 4;
      // Keep off the fire ring (it closes in during sudden death).
      if (len2(me.pos.x, me.pos.z) > world.arena.fireRadius - 5 * ONE) dir = ((atan2(-me.pos.x, -me.pos.z) >> 6) / 1024) * 32;
      f.move = 1 + (((Math.round(dir) & 31) << 2) | 3);
    }
    if (k === 'rollSpam') f.press |= P_DODGE;
    if (k === 'holdFire' || k === 'attacker') f.held |= 1;
    if (k === 'attackerPaused' && this.t % (5 * TICKS) < 3 * TICKS) f.held |= 1;
    if (k === 'attacker' || k === 'attackerPaused') {
      const mana = q(me.mana);
      if (q(me.ult) >= S.ultimate.chargeMax) f.press |= P_ULT;
      if (me.cd[1] <= 0 && mana >= S.blast.manaCost) f.press |= P_BLAST;
      else if (me.cd[3] <= 0 && mana >= S.stun.manaCost) f.press |= P_STUN;
      // Shield when a spell is about to arrive.
      if (me.cd[2] <= 0 && mana >= S.shield.manaCost) {
        for (const p of world.spells.active) {
          if (p.owner.side === me.side) continue;
          const px = me.pos.x - p.pos.x, pz = me.pos.z - p.pos.z;
          if (len2(px, pz) < 5 * ONE && px * p.vel.x + pz * p.vel.z > 0) {
            f.press |= P_SHIELD;
            break;
          }
        }
      }
    }
    return f;
  }
}

/** A Quick Duel world whose rival plays `difficulty` (the sim setup's own field, as the game sets it). */
export function quickWorld(seed: number, difficulty: Difficulty = 'normal', staff: string | null = null): SimWorld {
  const world = new SimWorld({ seed, rules: 'quick', arena: 'moonlit', staffs: [staff, null], difficulty });
  world.events.enabled = false;
  return world;
}

/** Seat 0 played by the sim's own AI at `profile` (soaks, reference players). */
export function addSeat0AI(world: SimWorld, profile: AIProfile): SimAI {
  const w = world.wizards[0];
  w.ai = true;
  const ai = new SimAI(world, w, world.wizards[1], profile, null);
  (world.ais as SimAI[]).unshift(ai);
  ai.reset();
  return ai;
}

interface Tally {
  dealt: Record<string, number>;
  taken: Record<string, number>;
  casts: Record<string, number>;
}

function tally(world: SimWorld, seat = 0): Tally {
  const t: Tally = { dealt: {}, taken: {}, casts: {} };
  world.events.on('damage', (e) => {
    const n = q(e.n);
    if (e.w === seat) t.taken[e.s] = (t.taken[e.s] ?? 0) + n;
    else if (e.o === seat) t.dealt[e.s] = (t.dealt[e.s] ?? 0) + n;
  });
  world.events.on('cast', (e) => {
    if (e.w === seat) t.casts[e.s] = (t.casts[e.s] ?? 0) + 1;
  });
  return t;
}

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const r1 = (x: number) => Math.round(x * 10) / 10;
const pct = (x: number) => `${Math.round(x * 100)}%`;

export interface ScriptedReport {
  script: ScriptKind;
  difficulty: Difficulty;
  matches: number;
  rounds: number;
  roundsWon: number;
  matchesWon: number;
  /** Seat 0's mana sampled twice a second during fight phases while alive. */
  mana: { samples: number; mean: number; atLeastBlast: string; atMost10: string };
  /** Fight seconds of each match's first round until seat 0 fell (the round length if it did not). */
  survival: { mean: number; min: number; max: number; ko: number };
  avgRoundSeconds: number;
  castsPerRound: Record<string, number>;
  /** Rounds in which Blast, Shield, Stun and the Ultimate were each cast at least once. */
  roundsWithAllFour: number;
  /** Bolts per second while fire was held, over fight time. */
  boltsPerSecond: number;
  damageDealtPerRound: number;
  damageTakenPerRound: number;
  /** Share of the rival's bolts that hit seat 0 (its accuracy against this script). */
  rivalBoltAccuracy: string;
}

/**
 * `matches` Quick Duels with seat 0 scripted. `firstRoundOnly` stops after round 1 (survival
 * probes). `aim`: see ScriptedPlayer.
 */
export function scripted(
  script: ScriptKind, difficulty: Difficulty = 'normal', matches = 6,
  opts: { seed?: number; firstRoundOnly?: boolean; staff?: string | null; aim?: 'perfect' | 'human' } = {},
): ScriptedReport {
  const seed0 = opts.seed ?? 1000;
  let rounds = 0, roundsWon = 0, matchesWon = 0, samples = 0, manaSum = 0, hi = 0, lo = 0, fightTicks = 0, allFour = 0;
  let rivalBolts = 0, rivalBoltHits = 0;
  const survival: number[] = [];
  let kos = 0;
  const casts: Record<string, number> = {};
  let dealt = 0, taken = 0;
  for (let m = 0; m < matches; m++) {
    const world = quickWorld(seed0 + m, difficulty, opts.staff ?? null);
    const bot = new ScriptedPlayer(script, 0, 777 + m, opts.aim ?? 'perfect');
    const t = tally(world);
    world.events.on('cast', (e) => {
      if (e.w === 1 && e.s === 'bolt') rivalBolts++;
    });
    world.events.on('damage', (e) => {
      if (e.w === 0 && e.o === 1 && e.s === 'bolt') rivalBoltHits++;
    });
    const p = world.wizards[0];
    let roundCasts: Record<string, number> = {};
    world.events.on('cast', (e) => {
      if (e.w === 0) roundCasts[e.s] = (roundCasts[e.s] ?? 0) + 1;
    });
    world.events.on('shieldUp', (e) => {
      if (e.w === 0) roundCasts.shield = (roundCasts.shield ?? 0) + 1;
    });
    let round = 1, roundTicks = 0, first = true;
    const frames: (SimInput | null)[] = [null, null, null];
    while (!world.over) {
      frames[0] = bot.input(world);
      const phase = world.match.phase;
      world.step(frames);
      if (phase === 'fight') {
        roundTicks++;
        fightTicks++;
        if (p.alive && world.tick % 30 === 0) {
          const mana = q(p.mana);
          samples++;
          manaSum += mana;
          if (mana >= S.blast.manaCost) hi++;
          if (mana <= 10) lo++;
        }
      }
      if (world.match.round !== round || world.over || (phase === 'fight' && world.match.phase === 'roundEnd')) {
        if (phase === 'fight') {
          rounds++;
          const won = world.match.lastWinner === 0;
          if (won) roundsWon++;
          if (first) {
            survival.push(roundTicks / TICKS);
            if (!p.alive) kos++;
            first = false;
          }
          for (const k of Object.keys(roundCasts)) casts[k] = (casts[k] ?? 0) + roundCasts[k];
          if (roundCasts.blast && roundCasts.shield && roundCasts.stun && roundCasts.ultimate) allFour++;
          roundCasts = {};
          roundTicks = 0;
          if (opts.firstRoundOnly) break;
        }
        round = world.match.round;
      }
    }
    if (world.over && world.match.winner === 0) matchesWon++;
    dealt += sum(t.dealt);
    taken += sum(t.taken);
  }
  const n = Math.max(1, rounds);
  const per: Record<string, number> = {};
  for (const k of Object.keys(casts)) per[k] = r1(casts[k] / n);
  return {
    script, difficulty, matches, rounds, roundsWon, matchesWon,
    mana: { samples, mean: r1(manaSum / Math.max(1, samples)), atLeastBlast: pct(hi / Math.max(1, samples)), atMost10: pct(lo / Math.max(1, samples)) },
    survival: { mean: r1(avg(survival)), min: r1(Math.min(...survival)), max: r1(Math.max(...survival)), ko: kos },
    avgRoundSeconds: r1(fightTicks / TICKS / n),
    castsPerRound: per,
    roundsWithAllFour: allFour,
    boltsPerSecond: r1((casts.bolt ?? 0) / Math.max(1, fightTicks / TICKS)),
    damageDealtPerRound: r1(dealt / n),
    damageTakenPerRound: r1(taken / n),
    rivalBoltAccuracy: pct(rivalBoltHits / Math.max(1, rivalBolts)),
  };
}

export interface SimSoakReport {
  difficulty: Difficulty;
  rounds: number;
  avgSeconds: number;
  minSeconds: number;
  maxSeconds: number;
  koRounds: number;
  timeoutRounds: number;
  /** Share of spell damage by spell (both seats). */
  damageShare: Record<string, string>;
  castsPerRound: Record<string, number>;
  seat0Wins: number;
}

/** AI against AI at `difficulty` on the sim: `matches` best-of-three Quick Duels. */
export function simSoak(difficulty: Difficulty = 'normal', matches = 8, seed = 5000): SimSoakReport {
  const secs: number[] = [];
  let ko = 0, time = 0, seat0 = 0;
  const dmg: Record<string, number> = {};
  const casts: Record<string, number> = {};
  for (let m = 0; m < matches; m++) {
    const world = quickWorld(seed + m, difficulty);
    addSeat0AI(world, { ...CONFIG.ai.difficulty[difficulty] });
    world.events.on('damage', (e) => {
      dmg[e.s] = (dmg[e.s] ?? 0) + q(e.n);
    });
    world.events.on('cast', (e) => {
      casts[e.s] = (casts[e.s] ?? 0) + 1;
    });
    world.events.on('roundEnd', (e) => {
      secs.push(world.match.elapsed / 6000);
      if (e.s === 'ko') ko++;
      else time++;
      if (e.w === 0) seat0++;
    });
    const frames: (SimInput | null)[] = [null, null, null];
    while (!world.over) world.step(frames);
  }
  const total = SPELL_KINDS.reduce((a, k) => a + (dmg[k] ?? 0), 0) || 1;
  const share: Record<string, string> = {};
  for (const k of SPELL_KINDS) share[k] = pct((dmg[k] ?? 0) / total);
  const per: Record<string, number> = {};
  for (const k of Object.keys(casts)) per[k] = r1(casts[k] / Math.max(1, secs.length));
  return {
    difficulty, rounds: secs.length, avgSeconds: r1(avg(secs)), minSeconds: r1(Math.min(...secs)), maxSeconds: r1(Math.max(...secs)),
    koRounds: ko, timeoutRounds: time, damageShare: share, castsPerRound: per, seat0Wins: seat0,
  };
}

export interface BossProbeReport {
  boss: string;
  player: string;
  fights: number;
  /** Fight seconds measured (each fight runs until it ends or `seconds` pass). */
  seconds: number;
  /** The player's damage per second to the bosses, and the bosses' to the player. */
  dpsDealt: number;
  dpsTaken: number;
  damageTakenPer4Min: number;
  /** Average seconds each stage of the lead boss took to empty (stages emptied in every fight only). */
  stageSeconds: number[];
  wins: number;
  playerKos: number;
  checkpoints: number;
}

/**
 * Gauntlet fights against `bossId` on the sim. `player`: a script, or 'ai:<difficulty>' for the
 * sim's AI in the player's seat (no reward spells). `immortal` refills the player every tick, so
 * every fight runs all three stages (stage lengths and damage rates without an early loss).
 */
export function bossProbe(
  bossId: string, player: ScriptKind | `ai:${Difficulty}` = 'attacker',
  opts: { fights?: number; seconds?: number; immortal?: boolean; seed?: number; staff?: string | null; aim?: 'perfect' | 'human' } = {},
): BossProbeReport {
  const fights = opts.fights ?? 3;
  const cap = (opts.seconds ?? 45 * 60) * TICKS;
  let ticks = 0, dealt = 0, taken = 0, wins = 0, kos = 0, checkpoints = 0;
  const stage: number[][] = [[], [], []];
  for (let i = 0; i < fights; i++) {
    const world = new SimWorld({ seed: (opts.seed ?? 9000) + i, rules: 'gauntlet', arena: 'moonlit', staffs: [opts.staff ?? null, null], bossId });
    world.events.enabled = false;
    const p = world.wizards[0];
    const script = player.startsWith('ai:') ? null : new ScriptedPlayer(player as ScriptKind, 0, 99 + i, opts.aim ?? 'perfect');
    const ai = script ? null : addSeat0AI(world, { ...CONFIG.ai.difficulty[player.slice(3) as Difficulty] });
    const t = tally(world);
    let stageStart = 0, fightTicks = 0;
    world.events.on('bossEvolve', (e) => {
      if (e.w !== 1) return;
      stage[e.n - 1].push((fightTicks - stageStart) / TICKS);
      stageStart = fightTicks;
    });
    world.events.on('checkpoint', () => {
      checkpoints++;
    });
    const frames: (SimInput | null)[] = [null, null, null];
    while (!world.over && fightTicks < cap) {
      if (script) frames[0] = script.input(world);
      else if (ai && world.wizards.length > 2) {
        // A double fight: the reference AI takes on the nearest boss still standing.
        let best = ai.target;
        for (let k = 1; k < world.wizards.length; k++) {
          const w = world.wizards[k];
          if (!w.active || !w.alive) continue;
          if (!best.alive || len2(w.pos.x - p.pos.x, w.pos.z - p.pos.z) < len2(best.pos.x - p.pos.x, best.pos.z - p.pos.z)) best = w;
        }
        ai.target = best;
      }
      const fighting = world.match.phase === 'fight';
      world.step(frames);
      if (fighting) fightTicks++;
      if (opts.immortal && p.alive) p.health = p.maxHealth;
    }
    if (world.over && world.match.winner === 0) {
      wins++;
      stage[2].push((fightTicks - stageStart) / TICKS);
    } else if (world.over) kos++;
    ticks += fightTicks;
    dealt += sum(t.dealt);
    taken += sum(t.taken);
  }
  const s = Math.max(1, ticks / TICKS);
  return {
    boss: bossId, player, fights, seconds: Math.round(s), dpsDealt: Math.round((dealt / s) * 100) / 100, dpsTaken: Math.round((taken / s) * 100) / 100,
    damageTakenPer4Min: Math.round((taken / s) * 240), stageSeconds: stage.map((xs) => Math.round(avg(xs))), wins, playerKos: kos, checkpoints,
  };
}

/** Everything docs/gameplay-improvement-plan.md section 9 asks to re-measure, in one object. */
export function balanceReport(scale = 1): Record<string, unknown> {
  const n = (x: number) => Math.max(1, Math.round(x * scale));
  return {
    tuning: {
      manaRegen: CONFIG.wizard.manaRegen, manaRegenDelay: CONFIG.wizard.manaRegenDelay, maxMana: CONFIG.wizard.maxMana,
      boltManaCost: S.bolt.manaCost, boltDamage: S.bolt.damage, dodge: CONFIG.wizard.dodge,
    },
    holdFire: scripted('holdFire', 'normal', n(6)),
    attacker: scripted('attacker', 'normal', n(6)),
    attackerPaused: scripted('attackerPaused', 'normal', n(6)),
    survival: {
      idle: scripted('idle', 'normal', n(12), { firstRoundOnly: true }).survival,
      strafe: scripted('strafe', 'normal', n(12), { firstRoundOnly: true }).survival,
      rollSpam: scripted('rollSpam', 'normal', n(12), { firstRoundOnly: true }).survival,
    },
    soak: { easy: simSoak('easy', n(8)), normal: simSoak('normal', n(8)), hard: simSoak('hard', n(8)) },
    sahilStage1: bossProbe('sahil', 'attackerPaused', { fights: n(3), seconds: 240, immortal: true }),
  };
}
