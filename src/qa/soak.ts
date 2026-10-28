import type { ArenaThemeId } from '../arena/themes';
import { CONFIG, type Difficulty } from '../config';
import { BOSSES, bossDisplayName, type BossDef } from '../campaign/levels';
import { GauntletClock } from '../core/Match';
import { events } from '../core/events';
import { nearestStanding, type Game } from '../core/Game';
import { AIController } from '../enemy/AIController';
import { withSeededRandom } from './campaignScenarios';
import type { QAHarness } from './QAHarness';

const DT = CONFIG.sim.fixedDt;
const M = CONFIG.match;
const A = CONFIG.arena;
const F = CONFIG.campaign.fight;

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
  /** Golden tickets per round: spawned, collected by each side (wizard 0 / wizard 1), expired. */
  tickets: { spawned: number; side0: number; side1: number; expired: number };
  errors: string[];
}

/**
 * One headless round with the real timer and sudden death, until the player or every enemy is down
 * or time runs out. `player` drives game.player and switches to the nearest standing enemy each
 * tick (a double fight has two); `enemies` drive the rest. `each` runs after every tick. Returns the
 * round length in seconds.
 */
function playRound(
  game: Game, player: AIController, enemies: AIController[], onNaN: () => void, states?: Record<string, number>, each?: () => void,
): number {
  const p = game.player;
  const brains = [player, ...enemies];
  let t = 0;
  // Golden tickets spawn during the fight, and every AI knows about them.
  game.tickets.enabled = true;
  for (const b of brains) b.tickets = game.tickets;
  while (t < M.roundTime && p.alive && game.enemies.some((w) => w.alive)) {
    const foe = nearestStanding(p, game.enemies);
    if (foe) player.setTarget(foe);
    for (const b of brains) b.update(DT);
    if (states) for (const b of brains) states[b.state] = (states[b.state] ?? 0) + DT;
    game.tick(DT);
    each?.();
    t += DT;
    const left = M.roundTime - t;
    if (left < A.suddenDeathAt) {
      game.arena.fireRadius = A.suddenDeathMinRadius + (A.fireRadius - A.suddenDeathMinRadius) * (left / A.suddenDeathAt);
    }
    if (!game.wizards.every((w) => Number.isFinite(w.pos.x + w.pos.z))) {
      onNaN();
      break;
    }
  }
  game.tickets.enabled = false;
  return t;
}

/** One headless Boss Gauntlet fight's outcome (see playFight). */
export interface FightResult {
  seconds: number;
  won: boolean;
  /** A safety cap was reached (the fire ring closed in): `stageCapped` seconds past a stage cap. */
  capped: boolean;
  stageCapped: number;
  /** Furthest stage (0..2) of each boss: [boss] or [boss, partner]. */
  stages: number[];
  /** Seconds each of the lead boss's stages took to empty (completed stages only). */
  stageSeconds: number[];
  /** Damage the bosses dealt to the player in each lead-boss stage, and seconds spent in it (outside transformations). */
  stageDamage: number[];
  stageTime: number[];
  packsSpawned: number;
  packsCollected: number;
  healed: number;
  /** Damage the player took over the whole fight (more than max health = only the packs kept it alive). */
  damageTaken: number;
  /** That damage by kind (bolt, blast, stun, ultimate, fire...). */
  byKind: Record<string, number>;
  /** Health checks over a long fight: a NaN position ended it; the most projectiles and tickets alive at once. */
  nan: boolean;
  peak: { projectiles: number; tickets: number };
}

/**
 * One headless single-life gauntlet fight against `boss` (already dressed, stages live): the real
 * simulation with golden tickets at the gauntlet pace and life packs, no round timer, and the
 * safety cap closing the fire ring (Match's rule). Ends on the player's KO or every boss's last
 * stage depleted, or at a hard stop well past the cap. `player` drives the player and targets the
 * nearest standing boss; `enemies` drive the bosses. `immortal`: the player is refilled every tick
 * (a probe of stage lengths and per-stage damage).
 */
function playFight(game: Game, player: AIController, enemies: AIController[], immortal = false): FightResult {
  const p = game.player, e = game.enemy;
  const st = game.stages;
  const brains = [player, ...enemies];
  const hardStop = F.safetyCap + F.capCloseTime + 120;
  const out: FightResult = {
    seconds: 0, won: false, capped: false, stageCapped: 0, stages: [], stageSeconds: [], stageDamage: [0, 0, 0], stageTime: [0, 0, 0],
    packsSpawned: 0, packsCollected: 0, healed: 0, damageTaken: 0, byKind: {},
    nan: false, peak: { projectiles: 0, tickets: 0 },
  };
  let stageStart = 0;
  let t = 0;
  const clock = new GauntletClock();
  const offs = [
    events.on('damage', (ev) => {
      if (ev.target !== p) return;
      out.byKind[ev.kind] = (out.byKind[ev.kind] ?? 0) + ev.amount;
      if (!ev.source || ev.source.side !== 1) return;
      out.stageDamage[st.stage] += ev.amount;
      out.damageTaken += ev.amount;
    }),
    events.on('bossEvolve', (ev) => {
      if (ev.wizard !== e || ev.enraged) return;
      out.stageSeconds.push(t - stageStart);
      stageStart = t;
    }),
    events.on('lifePackPickup', (ev) => (out.healed += ev.healed)),
  ];
  game.tickets.enabled = true;
  game.tickets.spawnInterval = CONFIG.tickets.bossSpawnInterval;
  game.lifePacks.reset();
  game.lifePacks.enabled = true;
  for (const b of brains) b.tickets = game.tickets;
  player.lifePacks = game.lifePacks;
  try {
    while (t < hardStop && p.alive && game.enemies.some((w) => w.alive)) {
      const foe = nearestStanding(p, game.enemies);
      if (foe) player.setTarget(foe);
      for (const b of brains) b.update(DT);
      game.tick(DT);
      t += DT;
      game.arena.fireRadius = clock.update(DT, game.fightProgress());
      if (!e.evolving && e.alive && p.alive) out.stageTime[st.stage] += DT;
      if (clock.stageCapped) out.stageCapped += DT;
      const pk = out.peak;
      pk.projectiles = Math.max(pk.projectiles, game.spells.pool.active.length);
      pk.tickets = Math.max(pk.tickets, game.tickets.activeCount);
      if (!game.wizards.every((w) => Number.isFinite(w.pos.x + w.pos.z + w.health))) {
        out.nan = true;
        break;
      }
      // Immortal: back to full every tick, so the bosses' damage still counts (per stage) but never kills.
      if (immortal) p.health = p.maxHealth;
    }
  } finally {
    offs.forEach((off) => off());
    game.tickets.enabled = false;
    game.lifePacks.enabled = false;
    game.tickets.spawnInterval = CONFIG.tickets.spawnInterval;
    player.lifePacks = null;
  }
  out.seconds = t;
  out.won = p.alive && game.enemies.every((w) => !w.alive);
  out.capped = clock.capped || out.stageCapped > 0;
  out.stages = game.enemies.map((w) => game.stagesOf(w)?.stage ?? 0);
  if (out.won) out.stageSeconds.push(t - stageStart);
  out.packsSpawned = game.lifePacks.spawned;
  out.packsCollected = game.lifePacks.collected;
  return out;
}

export interface BossSoakRow {
  boss: string;
  fights: number;
  /** Fights the reference player AI won (one life: it beat every stage of every boss). */
  wins: number;
  winRate: string;
  /** Fight length, minutes. */
  avgMinutes: number;
  minMinutes: number;
  maxMinutes: number;
  /** Average furthest stage reached (1..3), the boss's (and a pair's partner's). */
  avgStage: number | string;
  /** Average minutes each stage took to empty, over the fights that emptied it (stage 1 / 2 / 3). */
  stageMinutes: string;
  /** The bosses' damage per second to the player in each stage (time outside transformations). */
  dps: string;
  /** Life packs per fight: collected / spawned; share of fights that used all of them. */
  packs: string;
  allPacks: string;
  /** Wins where the player took more than its max health: lost without the life packs. */
  savedByPacks: number;
  /** Fights that reached the safety cap. */
  capped: number;
  /** Share of the damage the player took, by kind. */
  damageShare: string;
  /** Fights that hit a NaN, and the busiest any fight got (projectiles / tickets alive). */
  nan: number;
  peak: string;
}

const avgOf = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const fmt1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '-');

/** Summarise `results` against one boss as a soak row. */
export function summarizeFights(boss: BossDef, results: FightResult[]): BossSoakRow {
  const n = Math.max(1, results.length);
  const wins = results.filter((r) => r.won).length;
  const mins = results.map((r) => r.seconds / 60);
  const stageMins = [0, 1, 2].map((s) => avgOf(results.filter((r) => r.stageSeconds.length > s).map((r) => r.stageSeconds[s] / 60)));
  const dps = [0, 1, 2].map((s) => {
    const dmg = results.reduce((a, r) => a + r.stageDamage[s], 0);
    const time = results.reduce((a, r) => a + r.stageTime[s], 0);
    return time > 1 ? dmg / time : NaN;
  });
  const lead = avgOf(results.map((r) => r.stages[0] + 1));
  const partner = boss.partner ? avgOf(results.map((r) => (r.stages[1] ?? 0) + 1)) : NaN;
  const max = CONFIG.lifePacks.maxPerFight;
  return {
    boss: bossDisplayName(boss),
    fights: results.length,
    wins,
    winRate: `${((wins / n) * 100).toFixed(1)}%`,
    avgMinutes: +avgOf(mins).toFixed(2),
    minMinutes: +Math.min(...mins).toFixed(2),
    maxMinutes: +Math.max(...mins).toFixed(2),
    avgStage: boss.partner ? `${lead.toFixed(2)} / ${partner.toFixed(2)}` : +lead.toFixed(2),
    stageMinutes: stageMins.map(fmt1).join(' / '),
    dps: dps.map((d) => (Number.isFinite(d) ? d.toFixed(2) : '-')).join(' / '),
    packs: `${avgOf(results.map((r) => r.packsCollected)).toFixed(1)} / ${avgOf(results.map((r) => r.packsSpawned)).toFixed(1)}`,
    allPacks: `${Math.round((results.filter((r) => r.packsCollected >= max).length / n) * 100)}%`,
    savedByPacks: results.filter((r) => r.won && r.damageTaken >= CONFIG.wizard.maxHealth).length,
    capped: results.filter((r) => r.capped).length,
    nan: results.filter((r) => r.nan).length,
    peak: ['projectiles', 'tickets'].map((k) => Math.max(...results.map((r) => r.peak[k as keyof FightResult['peak']]))).join(' / '),
    damageShare: (() => {
      const tot: Record<string, number> = {};
      for (const r of results) for (const [k, v] of Object.entries(r.byKind)) tot[k] = (tot[k] ?? 0) + v;
      const all = Object.values(tot).reduce((a, b) => a + b, 0) || 1;
      return Object.entries(tot).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${Math.round((v / all) * 100)}%`).join(' ');
    })(),
  };
}

/**
 * One single-life fight against `boss`, synchronously, inside a QA sandbox (campaignSoak runs one
 * per sandbox; scenarios can call it directly): stages live, the boss's stats and AI (and its
 * partner's), a reference player AI with stock stats; the previous rival is restored afterwards.
 */
export function fightBoss(qa: QAHarness, game: Game, boss: BossDef, reference: Difficulty = 'normal', immortal = false): FightResult {
  const p = game.player, e = game.enemy, q = game.partner;
  const prev = game.boss;
  const suspended = [game.stages.suspended, game.partnerStages.suspended];
  // The sandbox runs on stock stats with stages suspended; a real fight has neither.
  game.stages.suspended = game.partnerStages.suspended = false;
  game.setupEnemy(boss);
  const brainA = new AIController(p, e, game.spells, game.physics, game.arena, reference);
  const enemyBrains = [new AIController(e, p, game.spells, game.physics, game.arena)];
  enemyBrains[0].setProfile(boss.ai);
  if (game.partnerActive && boss.partner) {
    const c = new AIController(q, p, game.spells, game.physics, game.arena);
    c.setProfile(boss.partner.ai);
    enemyBrains.push(c);
  }
  for (const b of enemyBrains) b.allies = game.enemies;
  try {
    qa.reset();
    p.maxHealth = CONFIG.wizard.maxHealth;
    p.health = p.maxHealth;
    p.damageMultiplier = 1;
    for (const b of [brainA, ...enemyBrains]) b.reset();
    return playFight(game, brainA, enemyBrains, immortal);
  } finally {
    brainA.dispose();
    for (const b of enemyBrains) b.dispose();
    game.setupEnemy(prev);
    [game.stages.suspended, game.partnerStages.suspended] = suspended;
    qa.reset();
  }
}

export interface CampaignSoakOptions {
  /** Reference AI for the player (default the Quick Duel rival's Adept profile). */
  reference?: Difficulty;
  /** Only these fights (0-based gauntlet indices). */
  only?: number[];
  /**
   * The player is refilled to full health every tick: measures how long each stage takes to empty
   * and how much damage per second each stage deals, without the fight ending early.
   */
  immortal?: boolean;
  /** Seed for Math.random, per fight (seed + fight number), so runs repeat. */
  seed?: number;
  /** Called after every fight (progress for long runs). */
  progress?: (boss: BossDef, done: number, result: FightResult) => void;
}

/**
 * Boss Gauntlet balance: a reference player AI (default Adept) fights each boss `fights` times as
 * the real single-life fight: one life, every stage's own health bar, the boss's stage AI, attacks
 * and damage, life packs and golden tickets, in the boss's own arena, until one side is out (or the
 * safety cap closes the ring). A double fight runs both bosses (the reference AI targets the nearest
 * standing one). Fights run a few to a sandbox, yielding about every second, so long runs keep the
 * page alive. Reports per boss: win rate, fight length, stage reached, minutes per stage, the
 * bosses' damage per second per stage, life pack use, wins the packs saved, capped fights.
 * `await __duel.qa.campaignSoak(12)`.
 */
export async function campaignSoak(qa: QAHarness, game: Game, fights = 4, opts: CampaignSoakOptions = {}): Promise<BossSoakRow[]> {
  const rows: BossSoakRow[] = [];
  const arena = game.arena;
  const prevTheme = arena.theme;
  const prevDev = arena.devTheme;
  try {
    for (let bi = 0; bi < BOSSES.length; bi++) {
      if (opts.only && !opts.only.includes(bi)) continue;
      const boss = BOSSES[bi];
      arena.devTheme = null;
      await arena.applyTheme(boss.theme);
      const results: FightResult[] = [];
      let f = 0;
      while (f < fights) {
        // A few fights per sandbox (about a second of work), then yield so the page stays alive.
        await qa.sandbox(() => {
          const t0 = performance.now();
          do {
            const n = f;
            const run = () => fightBoss(qa, game, boss, opts.reference ?? 'normal', opts.immortal);
            const r = opts.seed !== undefined ? withSeededRandom(opts.seed + bi * 1000 + n, run) : run();
            results.push(r);
            f++;
            opts.progress?.(boss, f, r);
          } while (f < fights && performance.now() - t0 < 1000);
        });
      }
      rows.push(summarizeFights(boss, results));
    }
  } finally {
    arena.devTheme = prevDev;
    await arena.applyTheme(prevTheme);
  }
  console.table(rows);
  return rows;
}

/**
 * Headless AI-vs-AI rounds using the real simulation, timer and sudden death. Measures pacing
 * (round length vs the 60-90 s target) and how damage is distributed across spells. With `theme`,
 * the rounds are fought in that environment (and its cover layout), then the previous one returns.
 */
export async function soak(qa: QAHarness, game: Game, difficulty: Difficulty, rounds: number, theme?: ArenaThemeId): Promise<SoakReport> {
  const arena = game.arena;
  const prevTheme = arena.theme;
  const prevDev = arena.devTheme;
  if (theme) {
    arena.devTheme = null;
    void arena.applyTheme(theme);
  }
  try {
    return await soakRounds(qa, game, difficulty, rounds);
  } finally {
    if (theme) {
      void arena.applyTheme(prevTheme);
      arena.devTheme = prevDev;
    }
  }
}

async function soakRounds(qa: QAHarness, game: Game, difficulty: Difficulty, rounds: number): Promise<SoakReport> {
  const durations: number[] = [];
  const dmg: Record<string, number> = {};
  const casts: Record<string, number> = {};
  let ko = 0, timeout = 0, clashes = 0, pillars = 0, perfects = 0, dodges = 0, hpLost = 0;
  const states: Record<string, number> = {};
  const errors: string[] = [];
  const tickets = { spawned: 0, side0: 0, side1: 0, expired: 0 };
  const offs = [
    events.on('damage', (e) => (dmg[e.kind] = (dmg[e.kind] ?? 0) + e.amount)),
    events.on('cast', (e) => (casts[e.spell] = (casts[e.spell] ?? 0) + 1)),
    events.on('clash', () => clashes++),
    events.on('pillarBreak', () => pillars++),
    events.on('ticketSpawn', () => tickets.spawned++),
    events.on('ticketPickup', (e) => (e.wizard.index === 0 ? tickets.side0++ : tickets.side1++)),
    events.on('ticketExpire', () => tickets.expired++),
  ];

  await qa.sandbox(() => {
    const p = game.player, e = game.enemy;
    const brainA = new AIController(p, e, game.spells, game.physics, game.arena, difficulty);
    const brainB = new AIController(e, p, game.spells, game.physics, game.arena, difficulty);
    try {
      for (let r = 0; r < rounds; r++) {
        qa.reset();
        brainA.reset();
        brainB.reset();
        const t = playRound(game, brainA, [brainB], () => errors.push(`NaN position in round ${r}`), states);
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
    tickets: {
      spawned: +(tickets.spawned / Math.max(1, durations.length)).toFixed(1),
      side0: +(tickets.side0 / Math.max(1, durations.length)).toFixed(1),
      side1: +(tickets.side1 / Math.max(1, durations.length)).toFixed(1),
      expired: +(tickets.expired / Math.max(1, durations.length)).toFixed(1),
    },
    errors,
  };
}
