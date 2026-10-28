import { CONFIG, type Difficulty } from '../config';
import { BOSSES } from '../campaign/levels';
import { events } from '../core/events';
import type { Game } from '../core/Game';
import { AIController } from '../enemy/AIController';
import type { QAHarness } from './QAHarness';

const DT = CONFIG.sim.fixedDt;
const M = CONFIG.match;
const A = CONFIG.arena;

export interface SoakReport {
  difficulty: Difficulty;
  rounds: number;
  avgSeconds: number;
  minSeconds: number;
  maxSeconds: number;
  koRounds: number;
  timeoutRounds: number;
  /** Share of all damage by source. */
  damageShare: Record<string, string>;
  casts: Record<string, number>;
  perfects: number;
  dodges: number;
  clashes: number;
  pillarsBroken: number;
  /** Average HP lost per wizard per round. */
  avgDamageTaken: number;
  /** Average seconds per round each AI spent in each state. */
  stateSeconds: Record<string, number>;
  errors: string[];
}

/**
 * One headless round with the real timer and sudden death, until a KO or time runs out.
 * Returns the round length in seconds.
 */
function playRound(game: Game, brainA: AIController, brainB: AIController, onNaN: () => void, states?: Record<string, number>): number {
  const [p, e] = game.wizards;
  let t = 0;
  while (t < M.roundTime && p.alive && e.alive) {
    brainA.update(DT);
    brainB.update(DT);
    if (states) {
      states[brainA.state] = (states[brainA.state] ?? 0) + DT;
      states[brainB.state] = (states[brainB.state] ?? 0) + DT;
    }
    game.tick(DT);
    t += DT;
    const left = M.roundTime - t;
    if (left < A.suddenDeathAt) {
      game.arena.fireRadius = A.suddenDeathMinRadius + (A.fireRadius - A.suddenDeathMinRadius) * (left / A.suddenDeathAt);
    }
    if (!Number.isFinite(p.pos.x + e.pos.x)) {
      onNaN();
      break;
    }
  }
  return t;
}

export interface BossSoakRow {
  boss: string;
  rounds: number;
  avgSeconds: number;
  minSeconds: number;
  maxSeconds: number;
  /** Rounds the reference player AI won (KO or more health at time). */
  playerWins: number;
  koRounds: number;
  timeoutRounds: number;
  /** Average HP the boss took / dealt per round. */
  bossHpLost: number;
  playerHpLost: number;
}

/**
 * Boss Gauntlet pacing: a reference player AI (default Adept) duels each boss, with the boss's
 * stats and AI, for `rounds` rounds. Reports round lengths and who wins, per boss.
 * `await __duel.qa.campaignSoak(4)`.
 */
export async function campaignSoak(qa: QAHarness, game: Game, rounds = 4, reference: Difficulty = 'normal'): Promise<BossSoakRow[]> {
  const rows: BossSoakRow[] = [];
  for (const boss of BOSSES) {
    await qa.sandbox(() => {
      const [p, e] = game.wizards;
      const prev = game.boss;
      game.setupEnemy(boss);
      const brainA = new AIController(p, e, game.spells, game.physics, game.arena, reference);
      const brainB = new AIController(e, p, game.spells, game.physics, game.arena);
      brainB.setProfile(boss.ai);
      const durations: number[] = [];
      let wins = 0, ko = 0, bossLost = 0, playerLost = 0;
      try {
        for (let r = 0; r < rounds; r++) {
          qa.reset();
          brainA.reset();
          brainB.reset();
          durations.push(playRound(game, brainA, brainB, () => undefined));
          if (!p.alive || !e.alive) ko++;
          if (!e.alive || (p.alive && p.health / p.maxHealth > e.health / e.maxHealth)) wins++;
          bossLost += e.maxHealth - e.health;
          playerLost += p.maxHealth - p.health;
        }
      } finally {
        brainA.dispose();
        brainB.dispose();
        game.setupEnemy(prev);
      }
      const avg = durations.reduce((a, b) => a + b, 0) / Math.max(1, durations.length);
      rows.push({
        boss: boss.name,
        rounds: durations.length,
        avgSeconds: +avg.toFixed(1),
        minSeconds: +Math.min(...durations).toFixed(1),
        maxSeconds: +Math.max(...durations).toFixed(1),
        playerWins: wins,
        koRounds: ko,
        timeoutRounds: durations.length - ko,
        bossHpLost: +(bossLost / Math.max(1, durations.length)).toFixed(1),
        playerHpLost: +(playerLost / Math.max(1, durations.length)).toFixed(1),
      });
    });
  }
  console.table(rows);
  return rows;
}

/**
 * Headless AI-vs-AI rounds using the real simulation, timer and sudden death. Measures pacing
 * (round length vs the 60-90 s target) and how damage is distributed across spells.
 */
export async function soak(qa: QAHarness, game: Game, difficulty: Difficulty, rounds: number): Promise<SoakReport> {
  const durations: number[] = [];
  const dmg: Record<string, number> = {};
  const casts: Record<string, number> = {};
  let ko = 0, timeout = 0, clashes = 0, pillars = 0, perfects = 0, dodges = 0, hpLost = 0;
  const states: Record<string, number> = {};
  const errors: string[] = [];
  const offs = [
    events.on('damage', (e) => (dmg[e.kind] = (dmg[e.kind] ?? 0) + e.amount)),
    events.on('cast', (e) => (casts[e.spell] = (casts[e.spell] ?? 0) + 1)),
    events.on('clash', () => clashes++),
    events.on('pillarBreak', () => pillars++),
  ];

  await qa.sandbox(() => {
    const [p, e] = game.wizards;
    const brainA = new AIController(p, e, game.spells, game.physics, game.arena, difficulty);
    const brainB = new AIController(e, p, game.spells, game.physics, game.arena, difficulty);
    try {
      for (let r = 0; r < rounds; r++) {
        qa.reset();
        brainA.reset();
        brainB.reset();
        const t = playRound(game, brainA, brainB, () => errors.push(`NaN position in round ${r}`), states);
        durations.push(t);
        if (!p.alive || !e.alive) ko++;
        else timeout++;
        perfects += p.stats.perfects + e.stats.perfects;
        hpLost += p.maxHealth + e.maxHealth - p.health - e.health;
        dodges += p.stats.dodges + e.stats.dodges;
      }
    } catch (err) {
      errors.push(String((err as Error)?.stack ?? err));
    } finally {
      brainA.dispose();
      brainB.dispose();
    }
  });
  offs.forEach((off) => off());

  const total = Object.values(dmg).reduce((a, b) => a + b, 0) || 1;
  const damageShare: Record<string, string> = {};
  for (const [k, v] of Object.entries(dmg)) damageShare[k] = `${Math.round((v / total) * 100)}%`;
  const avg = durations.reduce((a, b) => a + b, 0) / Math.max(1, durations.length);
  return {
    difficulty,
    rounds: durations.length,
    avgSeconds: +avg.toFixed(1),
    minSeconds: +Math.min(...durations).toFixed(1),
    maxSeconds: +Math.max(...durations).toFixed(1),
    koRounds: ko,
    timeoutRounds: timeout,
    damageShare,
    casts,
    perfects,
    dodges,
    clashes,
    pillarsBroken: pillars,
    avgDamageTaken: +(hpLost / Math.max(1, durations.length) / 2).toFixed(1),
    stateSeconds: Object.fromEntries(Object.entries(states).map(([k, v]) => [k, +(v / Math.max(1, durations.length) / 2).toFixed(1)])),
    errors,
  };
}
