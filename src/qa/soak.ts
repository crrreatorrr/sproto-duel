import { CONFIG, type Difficulty } from '../config';
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
        let t = 0;
        while (t < M.roundTime && p.alive && e.alive) {
          brainA.update(DT);
          brainB.update(DT);
          states[brainA.state] = (states[brainA.state] ?? 0) + DT;
          states[brainB.state] = (states[brainB.state] ?? 0) + DT;
          game.tick(DT);
          t += DT;
          const left = M.roundTime - t;
          if (left < A.suddenDeathAt) {
            game.arena.fireRadius = A.suddenDeathMinRadius + (A.fireRadius - A.suddenDeathMinRadius) * (left / A.suddenDeathAt);
          }
          if (!Number.isFinite(p.pos.x + e.pos.x)) {
            errors.push(`NaN position in round ${r}`);
            break;
          }
        }
        durations.push(t);
        if (!p.alive || !e.alive) ko++;
        else timeout++;
        perfects += p.stats.perfects + e.stats.perfects;
        hpLost += 2 * CONFIG.wizard.maxHealth - p.health - e.health;
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
