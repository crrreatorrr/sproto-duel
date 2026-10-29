import * as THREE from 'three';
import { CONFIG, type AIProfile } from '../config';
import type { App } from '../App';
import { resolveAsset } from '../assets/AssetLoader';
import { MODELS } from '../assets/manifest';
import { STAGE_COUNT, stageProfile } from '../campaign/BossStages';
import { CAMPAIGN_STORAGE_KEY, Campaign } from '../campaign/Campaign';
import { BOSSES, bossDisplayName, bossFighters, type BossDef } from '../campaign/levels';
import { events, type GameEvents } from '../core/events';
import { nearestStanding, type Game } from '../core/Game';
import { AIController } from '../enemy/AIController';
import { loadSettings } from '../ui/Menus';
import type { QAHarness } from './QAHarness';
import { fightBoss, summarizeFights } from './soak';

const DT = CONFIG.sim.fixedDt;
const W = CONFIG.wizard;
const B = CONFIG.spells.bolt;

type Ctx = Parameters<Parameters<QAHarness['add']>[1]>[0];

export interface ThreatSample {
  name: string;
  /** Damage per second the AI deals to a strafing target that never shoots back. */
  dps: number;
  /** Fraction of perfectly-led bolts that land on the AI. */
  hitRate: number;
  /** Seconds for the AI to kill a 220 HP player at that rate. */
  killsYouIn: number;
  /** Seconds for sustained (mana-limited) bolt fire to kill the AI at that hit rate. */
  youKillIn: number;
  /**
   * Damage you take while killing them, as a share of your health (youKillIn / killsYouIn for one
   * opponent): higher is harder. A pair is fought one at a time (see fightThreat).
   */
  threat: number;
  /** Per opponent (the boss, then a double fight's partner): damage per second and max health. */
  dpsBy: number[];
  hpBy: number[];
  /** A staged boss: damage per second in each stage. */
  stageDps?: number[];
}

/** Sustained bolt DPS once mana is the limit (what a player can keep up). */
const SUSTAINED_BOLT_DPS = (W.manaRegen / B.manaCost) * B.damage;

/** Run `fn` with Math.random replaced by a seeded generator (mulberry32), so AI rolls repeat. */
export function withSeededRandom<T>(seed: number, fn: () => T): T {
  const original = Math.random;
  let s = seed >>> 0;
  Math.random = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

/** Health of everyone in a fight, all stage bars together (both bosses of a double fight). */
const fightHp = (boss: BossDef | null) => (boss ? bossFighters(boss).map((f) => f.stageHealth.reduce((a, b) => a + b, 0)) : [W.maxHealth]);

/**
 * Threat of a fight from each opponent's damage per second and health, at `hitRate`. One opponent:
 * the damage it deals in the time you need to kill it. A pair is fought one at a time, in the better
 * order: both hit you until the first falls, then the survivor alone (it keeps its own stage), at
 * `survivorDps` if given.
 */
function fightThreat(name: string, dpsBy: number[], hpBy: number[], hitRate: number, survivorDps = dpsBy): ThreatSample {
  const rate = Math.max(0.01, SUSTAINED_BOLT_DPS * hitRate);
  const t = hpBy.map((h) => h / rate);
  const dps = dpsBy.reduce((a, b) => a + b, 0);
  let taken = dps * t[0];
  if (dpsBy.length === 2) {
    const order = (a: number, b: number) => dps * t[a] + survivorDps[b] * t[b];
    taken = Math.min(order(0, 1), order(1, 0));
  }
  const youKillIn = t.reduce((a, b) => a + b, 0);
  return { name, dps, hitRate, killsYouIn: W.maxHealth / Math.max(0.01, dps), youKillIn, threat: taken / W.maxHealth, dpsBy, hpBy };
}

/**
 * Headless difficulty probe for one opponent: (1) its AI attacks a target strafing left/right
 * that never shoots back, (2) a scripted shooter fires perfectly-led bolts at it. The rival is
 * dressed with `boss` (null = default rival stats). With `stage`, the boss fights as that stage:
 * its scaled profile, gated attacks and stage damage (`profile` is then ignored). A double fight
 * runs both bosses (each its own AI, in the same stage, damage counted per boss) and the shooter
 * aims at the nearest; you have to get through both health bars (fightThreat).
 */
export function measureThreat(c: Ctx, game: Game, boss: BossDef | null, profile: AIProfile, seconds = 12, trials = 2, stage?: number): ThreatSample {
  const prevBoss = game.boss;
  game.setupEnemy(boss);
  const p = game.player;
  const staged = boss && stage !== undefined;
  const fighters = boss ? bossFighters(boss) : [];
  const ais = game.enemies.map((w, i) => {
    const ai = new AIController(w, p, game.spells, game.physics, game.arena, 'normal');
    const f = fighters[i];
    ai.setProfile(staged && f ? stageProfile(f, stage) : f && i > 0 ? f.ai : profile);
    if (staged && f) {
      ai.attacks = f.stages[stage].attacks;
      w.damageMultiplier = f.damageMultiplier * CONFIG.campaign.stageDamage[stage];
    } else if (f && i > 0) {
      w.damageMultiplier = f.damageMultiplier;
    }
    ai.allies = game.enemies;
    return ai;
  });
  const dmg = game.enemies.map(() => 0);
  let time = 0;
  const off = events.on('damage', (ev) => {
    const i = ev.source && ev.target === p ? game.enemies.indexOf(ev.source) : -1;
    if (i >= 0) dmg[i] += ev.amount;
  });
  let hits = 0;
  let shots = 0;
  const full = () => {
    p.health = p.maxHealth;
    for (const w of game.enemies) w.health = w.maxHealth;
  };
  try {
    for (let trial = 0; trial < trials; trial++) {
      // Offense: the target strafes, reversing every ~1.3 s, and never fires.
      c.setup();
      for (const ai of ais) ai.reset();
      let t = 0;
      c.step(seconds, () => {
        t += DT;
        for (const ai of ais) ai.update(DT);
        full();
        const e = game.enemy;
        p.intent.move.set(Math.sin(t * 2.4 + trial) > 0 ? 1 : -1, 0, 0);
        p.intent.facing = Math.atan2(e.pos.x - p.pos.x, e.pos.z - p.pos.z);
      });
      time += seconds;

      // Defense: perfectly-led bolts at the (nearest) AI, unlimited mana.
      c.setup();
      for (const ai of ais) ai.reset();
      c.step(seconds * 0.75, () => {
        for (const ai of ais) ai.update(DT);
        full();
        p.mana = 1e6;
        const e = nearestStanding(p, game.enemies) ?? game.enemy;
        const travel = p.pos.distanceTo(e.pos) / B.speed;
        e.chest(p.aimPoint).addScaledVector(e.vel, travel);
        p.intent.holdBolt = true;
      });
      p.intent.holdBolt = false;
      hits += p.stats.hits;
      shots += p.stats.casts;
    }
  } finally {
    off();
    for (const ai of ais) ai.dispose();
    game.setupEnemy(prevBoss);
  }
  const hitRate = hits / Math.max(1, shots);
  return fightThreat(boss ? bossDisplayName(boss) : profile.label, dmg.map((d) => d / time), fightHp(boss), hitRate);
}

/**
 * A boss over its whole fight: each stage probed in turn, damage and hit rate averaged across the
 * stages. In a double fight the survivor fights on in its own stage (the other's fall changes nothing).
 */
function measureBossThreat(c: Ctx, game: Game, boss: BossDef, seed: number, seconds: number, trials: number): ThreatSample {
  const per = Array.from({ length: STAGE_COUNT }, (_, s) => withSeededRandom(seed + s * 101, () => measureThreat(c, game, boss, boss.ai, seconds, trials, s)));
  const dpsBy = per[0].dpsBy.map((_, i) => per.reduce((a, x) => a + x.dpsBy[i], 0) / per.length);
  const hitRate = per.reduce((a, x) => a + x.hitRate, 0) / per.length;
  const out = fightThreat(bossDisplayName(boss), dpsBy, fightHp(boss), hitRate);
  // One life through every stage: each stage's bars (both bosses') take HP / (sustained bolt damage x
  // that stage's hit rate) to empty, at that stage's damage per second.
  let taken = 0;
  for (let s = 0; s < STAGE_COUNT; s++) {
    const hp = bossFighters(boss).reduce((a, f) => a + f.stageHealth[s], 0);
    const t = hp / Math.max(0.01, SUSTAINED_BOLT_DPS * per[s].hitRate);
    taken += per[s].dps * t;
  }
  out.threat = taken / W.maxHealth;
  out.stageDps = per.map((x) => x.dps);
  return out;
}

const fmt = (s: ThreatSample) => `${s.name}: ${s.dps.toFixed(1)}dps hit${(s.hitRate * 100).toFixed(0)}% threat=${s.threat.toFixed(2)}`;

/** Run `fn` with the real campaign save stashed away, then put it back. */
export function withStashedSave(app: App, fn: () => void): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(CAMPAIGN_STORAGE_KEY);
  } catch {
    // no storage: nothing to restore
  }
  try {
    fn();
  } finally {
    try {
      if (saved === null) localStorage.removeItem(CAMPAIGN_STORAGE_KEY);
      else localStorage.setItem(CAMPAIGN_STORAGE_KEY, saved);
    } catch {
      // ignore
    }
    app.campaign.reload();
    app.toMenu();
  }
}

/** Finish the current match as if `playerWon` (1-0 in the gauntlet, 2-0 in Quick Duel), then show results immediately. */
export function finishMatch(app: App, playerWon: boolean): void {
  const g = app.game;
  const m = app.match;
  const n = m.roundsToWin;
  m.wins[0] = playerWon ? n : 0;
  m.wins[1] = playerWon ? 0 : n;
  m.roundWinners = Array.from({ length: n }, () => (playerWon ? g.player : g.enemy));
  m.phase = 'matchEnd';
  events.emit('matchEnd', { winner: playerWon ? g.player : g.enemy });
  app.showResults();
}

export const button = (app: App, act: string) => app.menus.root.querySelector<HTMLButtonElement>(`.menu-screen [data-act="${act}"]`);

/** Collect events of `type` until the returned function is called; it returns what was seen. */
export function record<K extends keyof GameEvents>(type: K): () => GameEvents[K][] {
  const seen: GameEvents[K][] = [];
  const off = events.on(type, (e) => void seen.push({ ...e }));
  return () => {
    off();
    return seen;
  };
}

/** Let Match see KOs and the clock while `fn` runs (scenarios run in qaMode, which it ignores). */
export function withMatchFlow(game: Game, fn: () => void): void {
  game.qaMode = false;
  try {
    fn();
  } finally {
    game.qaMode = true;
  }
}

const F = CONFIG.campaign.fight;
const A = CONFIG.arena;

export function registerCampaignScenarios(qa: QAHarness, game: Game, app: App): void {
  qa.add('campaign.ladder_escalates', (c) => {
    // Quick per-stage probe (the full one-life ladder is campaign.ladder_reference_win_rates): each
    // boss's AI attacks a strafing target that never shoots back, and takes perfectly-led bolts,
    // in each stage (stage profile, attacks and damage). Seeded; 3 trials of 12 s + 9 s per stage.
    const samples = BOSSES.map((b, i) => measureBossThreat(c, game, b, 1000 + i, 12, 3));
    const apprentice = withSeededRandom(999, () => measureThreat(c, game, null, CONFIG.ai.difficulty.easy, 12, 4));
    c.note(samples.map(fmt).join(' | '));
    c.note(`ref ${fmt(apprentice)}`);
    const first = samples[0], last = samples[samples.length - 1];
    c.expect(first.dps < last.dps * 0.75, `fight 1 deals ${first.dps.toFixed(2)} dps vs fight 5 ${last.dps.toFixed(2)}: not gentler`);
    c.expect(first.hitRate > last.hitRate * 1.15, `fight 1 is hit ${(first.hitRate * 100).toFixed(0)}% vs fight 5 ${(last.hitRate * 100).toFixed(0)}%`);
    // Fights are long now (one life, five-minute stages), so compare the pressure per second.
    c.expect(first.dps < apprentice.dps, `fight 1 (${first.dps.toFixed(2)} dps) hits harder than the Apprentice (${apprentice.dps.toFixed(2)} dps)`);
    // Every boss hits harder stage by stage.
    for (const smp of samples) {
      const d = smp.stageDps!;
      // (Short probes of slow, burst-y bosses are noisy: the later stages must beat stage 1, one of them clearly.)
      c.expect(d[2] > d[0] && Math.max(d[1], d[2]) > d[0] * 1.2, `${smp.name}: stages ${d.map((x) => x.toFixed(2)).join(' / ')} dps do not escalate`);
    }
    c.note(`stage dps ${samples.map((x) => x.stageDps!.map((d) => d.toFixed(2)).join('/')).join(' | ')}`);
  });

  qa.add('campaign.one_life_gauntlet_best_of_3_quick_duel', (c) => {
    try {
      // The gauntlet: one round, one life. A KO ends the match at once.
      app.campaign.index = 0;
      app.startBossFight();
      const m = app.match, p = game.player, e = game.enemy;
      c.expect(m.single && m.roundsToWin === 1, `gauntlet single=${m.single} roundsToWin=${m.roundsToWin}`);
      c.setup();
      m.phase = 'fight';
      game.actionsLocked = false;
      app.hud.update(0);
      const root = app.hud.root;
      const pip = root.querySelector('.pip-row') as HTMLElement;
      const timer = root.querySelector('.timer')!.textContent ?? '';
      const label = root.querySelector('.round-label')!.textContent ?? '';
      c.expect(root.classList.contains('single') && getComputedStyle(pip).display === 'none', 'round pips shown in a gauntlet fight');
      c.expect(/^\d+:\d\d$/.test(timer) && label.includes('One life') && !/round/i.test(label), `HUD timer "${timer}" label "${label}"`);
      const ends = record('matchEnd');
      withMatchFlow(game, () => {
        game.spells.dealDamage(p, e, 1e5, p.chest(new THREE.Vector3()), 'blast');
        c.step(CONFIG.match.roundEndTime + 0.1);
      });
      const end = ends();
      c.expect((m.phase as string) === 'matchEnd' && end.length === 1 && end[0].winner === e && m.round === 1, `after one KO: phase ${m.phase}, round ${m.round}`);
      // No round clock: a long fight never times out.
      app.startBossFight();
      c.setup();
      m.phase = 'fight';
      game.actionsLocked = false;
      withMatchFlow(game, () => c.step(CONFIG.match.roundTime + 5));
      c.expect((m.phase as string) === 'fight' && m.elapsed > CONFIG.match.roundTime, `gauntlet timed out (phase ${m.phase})`);
      // Quick Duel: best of three on the 80 s clock.
      app.startMatch();
      c.expect(!m.single && m.roundsToWin === CONFIG.match.roundsToWin && m.timer === CONFIG.match.roundTime, 'Quick Duel is not best of three');
      c.setup();
      m.phase = 'fight';
      game.actionsLocked = false;
      app.hud.update(0);
      c.expect(!root.classList.contains('single') && getComputedStyle(pip).display !== 'none', 'Quick Duel lost its round pips');
      withMatchFlow(game, () => {
        game.spells.dealDamage(p, e, 1e5, p.chest(new THREE.Vector3()), 'blast');
        c.step(CONFIG.match.roundEndTime + 0.1);
      });
      c.expect(m.round === 2 && m.wins[1] === 1 && (m.phase as string) === 'intro', `Quick Duel after one KO: round ${m.round}, phase ${m.phase}`);
    } finally {
      app.toMenu();
    }
  });

  qa.add('campaign.safety_caps_close_the_ring', (c) => {
    try {
      app.campaign.index = 0;
      app.startBossFight();
      const m = app.match, p = game.player;
      game.stages.suspended = false; // the sandbox restores it
      c.setup({ player: [0, -4], enemy: [0, 4] });
      m.phase = 'fight';
      game.actionsLocked = false;
      // A stage running past its cap pulls the ring in, toward close quarters...
      const caps = record('fightCap');
      m.clock.stageElapsed = F.stageCap - 0.5;
      m.clock.elapsed = F.stageCap - 0.5;
      withMatchFlow(game, () => c.step(F.capCloseTime * 0.5));
      const r1 = game.arena.fireRadius;
      c.expect(r1 < A.fireRadius - 2 && r1 > F.stageCapRadius, `stage cap radius ${r1.toFixed(1)}`);
      c.expect(caps().length === 1 && m.capped && m.phase === 'fight', 'no fightCap at the stage cap');
      withMatchFlow(game, () => c.step(F.capCloseTime));
      c.near(game.arena.fireRadius, F.stageCapRadius, 0.01, 'stage cap floor m');
      // ...and opens again once the stage ends (as far as stage 2's arena shift lets it).
      game.stages.evolveTo(1);
      game.stages.release(0);
      withMatchFlow(game, () => c.step(5));
      c.expect(game.arena.fireRadius > CONFIG.arenaShifts.ringRadius[1] - 1 && !m.capped, `ring did not reopen (${game.arena.fireRadius.toFixed(1)})`);
      // Past the fight's safety cap it closes completely, and the fight ends.
      m.clock.elapsed = F.safetyCap + F.capCloseTime;
      p.health = 30;
      withMatchFlow(game, () => c.step(4));
      c.expect(game.arena.fireRadius <= F.capMinRadius + 1e-6 && !p.alive && m.phase !== 'fight', `after the safety cap: radius ${game.arena.fireRadius.toFixed(1)}, player alive=${p.alive}, phase ${m.phase}`);
      c.note(`stage cap at ${F.stageCap / 60} min -> ${F.stageCapRadius} m; safety cap at ${F.safetyCap / 60} min`);
    } finally {
      app.toMenu();
    }
  });

  qa.add('campaign.god_mode_progress_policy', (c) => {
    const prev = CONFIG.debug.godMode;
    withStashedSave(app, () => {
      try {
        app.campaign.reset();
        app.newGauntlet();
        button(app, 'begin')!.click();
        c.expect(!app.godUsed, 'god mode marked at the start of a clean fight');
        // Turned on for a moment mid-fight: the win saves nothing.
        app.setGodMode(true);
        app.setGodMode(false);
        c.expect(app.godUsed, 'god mode use not noted');
        finishMatch(app, true);
        c.expect(app.campaign.saved.next === 0 && app.campaign.saved.clears === 0, `god-mode win saved progress ${JSON.stringify(app.campaign.saved)}`);
        const tag = app.menus.root.querySelector('.result-tag')?.textContent ?? '';
        c.expect(/god mode/i.test(tag), `results tag "${tag}"`);
        // It still moves on in this session.
        const next = button(app, 'rematch')!;
        c.expect(next.textContent!.includes(BOSSES[1].name), `results button "${next.textContent}"`);
        next.click();
        c.expect(app.campaign.index === 1 && app.campaign.saved.next === 0, 'Next did not move on (or saved)');
        // A clean win right after it saves nothing either: fight 1 isn't in the save (more in
        // campaign.god_win_then_legit_win_keeps_save).
        app.startBossFight();
        c.expect(!app.godUsed, 'a fresh fight with god mode off is still marked');
        finishMatch(app, true);
        c.expect(app.campaign.saved.next === 0 && /not saved/i.test(app.menus.root.querySelector('.result-tag')?.textContent ?? ''), `a win after a god-mode win saved ${JSON.stringify(app.campaign.saved)}`);
        // A clean run saves as usual.
        app.newGauntlet();
        button(app, 'begin')!.click();
        finishMatch(app, true);
        c.expect(app.campaign.saved.next === 1 && !app.menus.root.querySelector('.result-tag'), `clean win saved ${JSON.stringify(app.campaign.saved)}`);
        // The final boss with god mode on: no clear counted.
        game.setGodMode(true);
        app.campaign.index = BOSSES.length - 1;
        app.startBossFight();
        c.expect(app.godUsed, 'god mode on at the start not noted');
        finishMatch(app, true);
        button(app, 'rematch')!.click();
        c.expect(app.menus.current === 'complete' && app.campaign.saved.clears === 0, `god clear counted: ${JSON.stringify(app.campaign.saved)}`);
        c.expect(/not counted/i.test(app.menus.root.textContent ?? ''), 'completion screen does not say the clear is not counted');
      } finally {
        game.setGodMode(prev);
      }
    });
  });

  qa.add('campaign.god_win_then_legit_win_keeps_save', (c) => {
    // The QA repro: god mode wins fights 1 and 2 (nothing saved), F9 turns it off on fight 3's card,
    // fight 3 is won fairly. The save must not skip to fight 4 (Magic Carpet and Pump It were never
    // learned): a win saves only when every earlier fight of the run is saved.
    const prev = CONFIG.debug.godMode;
    const rewardLine = () => app.menus.root.querySelector('.boss-reward small')?.textContent ?? '';
    const saved = () => JSON.stringify(app.campaign.saved);
    const win = () => {
      button(app, 'begin')!.click();
      c.expect(app.state === 'playing', 'Begin did not start the fight');
      finishMatch(app, true);
    };
    withStashedSave(app, () => {
      try {
        app.setGodMode(false);
        app.campaign.reset();
        app.setGodMode(true);
        app.newGauntlet();
        c.expect(/god mode: progress not saved/i.test(rewardLine()), `fight 1 card with god mode on: "${rewardLine()}"`);
        win();
        button(app, 'rematch')!.click();
        c.expect(app.menus.current === 'boss' && app.campaign.index === 1, 'a god-mode win did not lead to the fight 2 card');
        c.expect(/god mode: progress not saved/i.test(rewardLine()), `fight 2 card with god mode on: "${rewardLine()}"`);
        win();
        button(app, 'rematch')!.click();
        c.expect(app.campaign.index === 2 && app.campaign.saved.next === 0, `after two god-mode wins: index ${app.campaign.index}, save ${saved()}`);
        // F9 off on fight 3's card: the reward line now says this run can't be saved.
        app.setGodMode(false);
        c.expect(/not saved/i.test(rewardLine()) && !/defeat to learn/i.test(rewardLine()), `fight 3 card after god mode off: "${rewardLine()}"`);
        win();
        c.expect(!app.godUsed && app.winUnsaved === 'skipped', `fight 3's clean win: godUsed ${app.godUsed}, unsaved ${app.winUnsaved}`);
        const fresh = new Campaign().saved;
        c.expect(app.campaign.saved.next === 0 && app.campaign.unlocked.length === 0 && fresh.next === 0 && fresh.unlockedSpells.length === 0, `the save skipped ahead: ${saved()}`);
        const root = app.menus.root;
        c.expect(/not saved/i.test(root.querySelector('.result-tag')?.textContent ?? '') && /not saved/i.test(root.querySelector('.results-boss .boss-fight')?.textContent ?? ''), 'results do not say the win was not saved');
        c.expect(!root.querySelector('.result-learned'), 'results teach a spell for an unsaved win');
        const onward = button(app, 'rematch')!;
        c.expect(/next fight/i.test(onward.textContent ?? '') && onward.textContent!.includes(BOSSES[3].name), `results button "${onward.textContent}"`);
        button(app, 'quit')!.click();
        c.expect(!button(app, 'continue'), 'the main menu offers Continue after a run with no saved win');

        // From a real save: fight 1 won fairly (saved), fight 2 in god mode, fight 3 fairly: only
        // fight 1 counts. Continue picks the saved run back up at fight 2, and a fair win there saves.
        app.newGauntlet();
        win();
        c.expect(app.campaign.saved.next === 1 && app.campaign.hasLearned(BOSSES[0].reward), `fight 1 not saved: ${saved()}`);
        button(app, 'rematch')!.click();
        if (app.menus.current === 'reveal') button(app, 'continue')!.click();
        c.expect(app.menus.current === 'boss' && app.campaign.index === 1, 'no fight 2 card');
        app.setGodMode(true);
        win();
        button(app, 'rematch')!.click();
        app.setGodMode(false);
        win();
        c.expect(app.campaign.saved.next === 1 && !app.campaign.hasLearned(BOSSES[1].reward) && !app.campaign.hasLearned(BOSSES[2].reward), `wins past the save were saved: ${saved()}`);
        button(app, 'quit')!.click();
        const cont = button(app, 'continue');
        c.expect(!!cont && cont.textContent!.includes(BOSSES[1].name), `Continue is not at fight 2: "${cont?.textContent}"`);
        cont!.click();
        c.expect(app.campaign.index === 1 && /defeat to learn/i.test(rewardLine()), `Continue's card: index ${app.campaign.index}, "${rewardLine()}"`);
        win();
        c.expect(app.campaign.saved.next === 2 && app.campaign.hasLearned(BOSSES[1].reward) && app.winUnsaved === null, `a fair win on the saved run was not saved: ${saved()}`);
      } finally {
        app.setGodMode(prev);
      }
    });
  });

  qa.add('campaign.ladder_reference_win_rates', (c) => {
    // The real single-life fight, headless and seeded, against every boss: Sahil is a near-certain
    // win, each fight after it is won no more often than the one before (one fight of slack for
    // the small sample), Tinubu almost never falls (at most 1 of 16: tuned to ~4% for the reference
    // AI), and each stage lasts about five minutes.
    const arena = game.arena;
    const prevTheme = arena.theme, prevDev = arena.devTheme;
    const n = [4, 4, 4, 4, 16];
    const rows: ReturnType<typeof summarizeFights>[] = [];
    try {
      arena.devTheme = null;
      BOSSES.forEach((boss, bi) => {
        void arena.applyTheme(boss.theme);
        rows.push(summarizeFights(boss, Array.from({ length: n[bi] }, (_, i) => withSeededRandom(500 + bi * 100 + i, () => fightBoss(qa, game, boss)))));
      });
    } finally {
      arena.devTheme = prevDev;
      void arena.applyTheme(prevTheme);
    }
    c.note(rows.map((r) => `${r.boss} ${r.wins}/${r.fights} in ${r.avgMinutes} min (stage ${r.avgStage}; ${r.stageMinutes})`).join(' | '));
    const [sahil] = rows, tinubu = rows[rows.length - 1];
    c.expect(sahil.wins >= n[0] - 1, `Sahil won only ${sahil.wins}/${n[0]} for the reference AI`);
    for (let i = 1; i < rows.length; i++) {
      const rate = (r: (typeof rows)[number], k: number) => r.wins / n[k];
      c.expect(rate(rows[i], i) <= rate(rows[i - 1], i - 1) + 1 / n[i - 1] + 1e-9, `${rows[i].boss} (${rows[i].wins}/${n[i]}) is easier than ${rows[i - 1].boss} (${rows[i - 1].wins}/${n[i - 1]})`);
    }
    c.expect(tinubu.wins <= 1, `Tinubu lost ${tinubu.wins}/${n[4]} fights: not almost impossible`);
    const stageMins = sahil.stageMinutes.split(' / ').map(Number);
    c.expect(stageMins.every((m) => m >= 4.5), `Sahil stages ${sahil.stageMinutes} min: under ~5`);
    c.expect(rows.every((r) => r.nan === 0), 'a long fight hit a NaN');
  });

  qa.add('campaign.boss_setup_applies', (c) => {
    const prev = game.boss;
    try {
      for (const boss of BOSSES) {
        game.setupEnemy(boss);
        c.setup();
        const e = game.enemy;
        c.expect(e.name === boss.name, `${boss.id}: name ${e.name}`);
        c.expect(e.team === boss.palette, `${boss.id}: palette not applied`);
        c.expect(e.visual.team === boss.palette, `${boss.id}: visual palette not applied`);
        const want = new THREE.Color(boss.palette.spell).multiplyScalar(1.8);
        const got = game.spells.pool.teamBoltColor(e.index);
        c.expect(Math.abs(got.r - want.r) + Math.abs(got.g - want.g) + Math.abs(got.b - want.b) < 1e-3, `${boss.id}: bolt colour not re-skinned`);
        const hp = boss.stageHealth[0];
        // The QA sandbox runs on default stats; setupEnemy above re-applied the boss's.
        c.expect(e.maxHealth === hp && e.health === hp, `${boss.id}: health ${e.health}/${e.maxHealth}, expected ${hp}`);
        c.expect(e.damageMultiplier === boss.damageMultiplier, `${boss.id}: damage multiplier ${e.damageMultiplier}`);
        const before = game.player.health;
        game.spells.dealDamage(game.player, e, 10, game.player.pos, 'bolt');
        c.near(before - game.player.health, 10 * boss.damageMultiplier, 1e-6, `${boss.id} dmg`);
        // Each round opens in stage 1, in stage 1's model (later stages swap in their own, see stages.*).
        const stage1 = boss.stages[0].model;
        c.expect(boss.model === stage1 && boss.stages.every((s) => s.model in MODELS), `${boss.id}: stage model keys ${boss.stages.map((s) => s.model)}`);
        const hasGlb = resolveAsset(MODELS[stage1].path) !== null;
        c.expect(e.visual.usesModel === hasGlb, `${boss.id}: usesModel=${e.visual.usesModel} but GLB ${hasGlb ? 'exists' : 'missing'}`);
        if (!hasGlb) {
          let robe = false;
          e.visual.root.traverse((o) => {
            const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
            if (m?.color?.getHex() === boss.palette.robe) robe = true;
          });
          c.expect(robe, `${boss.id}: placeholder not in the boss palette`);
        }
      }
      c.note(`stage models: ${BOSSES.map((b) => `${b.id}=${b.stages.map((s) => (resolveAsset(MODELS[s.model].path) ? 'glb' : '-')).join('/')}`).join(' ')}`);
    } finally {
      game.setupEnemy(prev);
    }
  });

  qa.add('campaign.flow_theme_and_names', (c) => {
    withStashedSave(app, () => {
      app.campaign.reset();
      app.newGauntlet();
      const b0 = BOSSES[0];
      c.expect(app.menus.current === 'boss', `expected boss card, got ${app.menus.current}`);
      c.expect(game.arena.theme === b0.theme, `card arena theme ${game.arena.theme}, expected ${b0.theme}`);
      c.expect(app.ai.profile === b0.ai, 'boss AI profile not applied on the card');
      const card = app.menus.root.textContent ?? '';
      c.expect(card.includes(b0.name) && card.includes(b0.title) && card.includes(`Fight 1 of ${BOSSES.length}`), 'card misses name/title/fight number');
      button(app, 'begin')!.click();
      c.expect(app.state === 'playing' && app.match.boss === b0, `Begin did not start the ${b0.name} fight`);
      c.expect(game.arena.theme === b0.theme, 'fight not in the boss theme');
      const plate = app.hud.root.querySelector('.plate-right')!.textContent ?? '';
      c.expect(plate.includes(b0.name) && plate.includes(b0.title), `HUD plate shows "${plate.trim()}"`);
      c.note(`theme=${game.arena.theme} plate="${plate.replace(/\s+/g, ' ').trim()}"`);
    });
  });

  qa.add('campaign.progress_persists_and_continues', (c) => {
    // Storage round trip on a private key.
    const key = 'arcane-duel-campaign-qa';
    try {
      const a = new Campaign(key);
      a.reset();
      a.startNew();
      c.expect(!a.canContinue, 'fresh run offers Continue');
      c.expect(a.recordWin() === 'next', 'first win did not advance');
      const b = new Campaign(key);
      c.expect(b.canContinue && b.saved.next === 1, `save not persisted (next=${b.saved.next})`);
      c.expect(b.resume() === BOSSES[1], 'resume did not pick fight 2');
      for (let i = 1; i < BOSSES.length - 1; i++) {
        c.expect(b.recordWin() === 'next', `win ${i + 1} did not advance`);
        b.advance();
      }
      c.expect(b.boss === BOSSES[BOSSES.length - 1] && b.recordWin() === 'complete', 'final win did not complete the gauntlet');
      const d = new Campaign(key);
      c.expect(!d.canContinue && d.saved.clears === 1 && d.saved.next === 0, `after completion: ${JSON.stringify(d.saved)}`);
    } finally {
      try {
        localStorage.removeItem(key);
      } catch {
        // ignore
      }
    }

    // The real flow: win fight 1, go to the menu, Continue resumes at fight 2.
    withStashedSave(app, () => {
      app.campaign.reset();
      app.newGauntlet();
      button(app, 'begin')!.click();
      finishMatch(app, true);
      c.expect(app.campaign.saved.next === 1, `win not saved (next=${app.campaign.saved.next})`);
      // A first win teaches the boss's spell: the results lead to its reveal, then on to fight 2.
      button(app, 'rematch')!.click();
      c.expect(app.menus.current === 'reveal', `results led to ${app.menus.current}, not the spell reveal`);
      const next = button(app, 'continue')!;
      c.expect(next.textContent!.includes(BOSSES[1].name), `reveal button reads "${next.textContent}"`);
      next.click();
      c.expect(app.menus.current === 'boss' && app.campaign.boss === BOSSES[1], 'Next did not show the fight 2 card');
      c.expect(game.enemy.name === BOSSES[1].name && game.arena.theme === BOSSES[1].theme, 'fight 2 rival/arena not applied');
      button(app, 'menu')!.click();
      c.expect(app.menus.current === 'main', 'card Main Menu did not return to the menu');
      const cont = button(app, 'continue');
      c.expect(!!cont && cont.textContent!.includes(BOSSES[1].name), 'main menu has no Continue for fight 2');
      // A fresh Campaign (as after a reload) sees the same save.
      c.expect(new Campaign().saved.next === 1, 'progress not in localStorage');
      cont!.click();
      c.expect(app.menus.current === 'boss' && app.campaign.index === 1, 'Continue did not resume at fight 2');
      // Last boss (fights 2-4 saved as won): winning leads to the completion screen and resets the run.
      for (let i = 1; i < BOSSES.length - 1; i++) {
        app.campaign.index = i;
        app.campaign.recordWin();
      }
      app.campaign.index = BOSSES.length - 1;
      app.startBossFight();
      finishMatch(app, true);
      button(app, 'rematch')!.click();
      // Its spell is new too: the reveal, then the completion screen.
      if (app.menus.current === 'reveal') button(app, 'continue')!.click();
      c.expect(app.menus.current === 'complete', `final win led to ${app.menus.current}`);
      c.expect(!app.campaign.canContinue && app.campaign.saved.clears >= 1, 'completion did not reset the run');
    });
  });

  qa.add('campaign.defeat_retry_same_boss', (c) => {
    withStashedSave(app, () => {
      app.campaign.reset();
      app.campaign.startNew();
      app.campaign.advance();
      app.campaign.advance();
      const boss = BOSSES[2];
      app.startBossFight();
      finishMatch(app, false);
      c.expect(app.campaign.saved.next === 0, 'a defeat changed saved progress');
      const retry = button(app, 'rematch')!;
      c.expect(/retry/i.test(retry.textContent ?? ''), `defeat button reads "${retry.textContent}"`);
      retry.click();
      c.expect(app.state === 'playing' && app.match.boss === boss && app.campaign.index === 2, 'Retry did not restart the same boss');
      c.expect(app.match.wins[0] === 0 && app.match.wins[1] === 0 && app.match.round === 1, 'Retry did not reset the match');
      c.expect(game.enemy.name === boss.name && game.enemy.health === game.enemy.maxHealth, 'Retry rival not reset');
      c.expect(app.match.single && game.stages.stage === 0 && game.enemy.maxHealth === boss.stageHealth[0] && game.lifePacks.spawned === 0, 'Retry is not a fresh one-life fight at stage 1');
      // Pause -> Quit returns to the main menu.
      app.pause();
      c.expect(app.menus.current === 'pause' && (app.menus.root.textContent ?? '').includes(boss.name), 'pause menu missing boss line');
      button(app, 'quit')!.click();
      c.expect(app.state === 'menu' && app.menus.current === 'main', 'Quit did not return to the menu');
    });
  });

  qa.add('campaign.god_mode', (c) => {
    const prev = CONFIG.debug.godMode;
    const p = game.player, e = game.enemy;
    try {
      game.setGodMode(true);
      c.setup();
      let immunePopup = 0;
      const off = events.on('damage', (ev) => {
        if (ev.target === p && ev.amount === 0) immunePopup++;
      });
      game.spells.dealDamage(p, e, 30, p.pos, 'blast');
      c.expect(p.health === p.maxHealth, `god player took damage (${p.health})`);
      c.expect(p.hitFlash > 0 && immunePopup === 1, 'no hit feedback on an immune hit');
      const popup = [...game.ui.querySelectorAll('.popup')].some((el) => el.textContent === 'IMMUNE');
      c.expect(popup, 'no IMMUNE popup');
      // Real enemy bolts don't hurt either.
      e.intent.press('bolt');
      c.step(0.6);
      c.expect(p.health === p.maxHealth, 'enemy bolt hurt the god player');
      // Fire ring neither.
      p.spawn(CONFIG.arena.fireRadius - 0.1, 0, 0);
      c.step(0.6);
      c.expect(p.health === p.maxHealth, 'fire hurt the god player');
      // Double damage and double clash power.
      c.setup();
      const hp = e.health;
      p.intent.press('bolt');
      c.step(0.05);
      const bolt = game.spells.pool.active.find((x) => x.owner === p);
      c.expect(!!bolt && bolt.power === B.power * CONFIG.debug.godClashMultiplier, `bolt clash power ${bolt?.power}`);
      c.step(0.8);
      c.near(hp - e.health, B.damage * CONFIG.debug.godPowerMultiplier, 1e-6, 'god bolt dmg');
      // No cooldowns: Blast, Shield and Stun are ready again on the next tick; the Ultimate stays charged.
      c.setup();
      const S = CONFIG.spells;
      p.cd.blast = S.blast.cooldown;
      p.cd.shield = S.shield.cooldown;
      p.cd.stun = S.stun.cooldown;
      p.ult = 0;
      c.step(1 / 60);
      c.expect(p.cd.blast === 0 && p.cd.shield === 0 && p.cd.stun === 0, `god cooldowns ${p.cd.blast}/${p.cd.shield}/${p.cd.stun}`);
      c.expect(p.ult === S.ultimate.chargeMax, `god ult charge ${p.ult}`);
      p.intent.press('shield');
      c.step(S.shield.duration + 0.1);
      p.intent.press('shield');
      c.step(1 / 60);
      c.expect(p.shieldTime > 0, 'shield not ready again right after the last one ended');
      off();
      // Off again: normal rules.
      game.setGodMode(false);
      c.setup();
      game.spells.dealDamage(p, e, 10, p.pos, 'bolt');
      c.expect(p.health === p.maxHealth - 10, 'god mode off still immune');
      const hp2 = e.health;
      game.spells.dealDamage(e, p, 10, e.pos, 'bolt');
      c.expect(hp2 - e.health === 10, 'god mode off still doubles damage');
      // F9 toggles during play; HUD badge follows.
      app.startMatch();
      const f9 = () => window.dispatchEvent(new KeyboardEvent('keydown', { code: CONFIG.debug.godHotkey }));
      f9();
      c.expect(CONFIG.debug.godMode && p.immune, 'F9 did not enable god mode');
      app.hud.update(0);
      c.expect(app.hud.root.querySelector('.god-badge.on') !== null, 'no GOD MODE badge');
      f9();
      c.expect(!CONFIG.debug.godMode && !p.immune, 'F9 did not disable god mode');
      app.hud.update(0);
      c.expect(app.hud.root.querySelector('.god-badge.on') === null, 'badge still shown');
      app.toMenu();
    } finally {
      game.setGodMode(prev);
    }
  });

  qa.add('campaign.god_hazard_ticks_dont_flash', (c) => {
    // God mode in lava (or the fire ring): every tick deals 0 and must not set the hit flash, or the
    // player stays solid white. Real hits still flash.
    const prev = CONFIG.debug.godMode;
    const p = game.player;
    try {
      game.setGodMode(true);
      c.setup();
      let flashed = 0;
      const burns = record('damage');
      p.spawn(CONFIG.arena.fireRadius - 0.1, 0, 0);
      c.step(1.2, () => {
        if (p.hitFlash > 0) flashed++;
      });
      const ticks = burns().filter((d) => d.target === p && d.kind === 'fire').length;
      c.expect(ticks > 0, 'test setup: no fire ticks');
      c.expect(p.health === p.maxHealth && flashed === 0, `${ticks} fire ticks flashed the god-mode player for ${flashed} ticks (hp ${p.health})`);
      game.spells.dealDamage(p, game.enemy, 10, p.pos, 'bolt');
      c.expect(p.hitFlash > 0, 'an immune bolt hit no longer flashes');
    } finally {
      game.setGodMode(prev);
    }
  });

  qa.add('campaign.god_cheat_99', (c) => {
    const prev = CONFIG.debug.godMode;
    const [k9, kp9] = CONFIG.debug.godCheatKeys;
    const win = CONFIG.debug.godCheatWindowMs;
    const p = game.player;
    try {
      game.setGodMode(false);
      // Timing rules on the detector itself.
      const tap = app.godCheat;
      tap.reset();
      c.expect(!tap.press(k9, 1000), 'a single 9 toggled');
      c.expect(!tap.press(k9, 1000 + win + 150), 'two 9s too far apart toggled');
      c.expect(tap.press(k9, 1000 + win + 150 + win * 0.5), 'two quick 9s did not trigger');
      tap.reset();
      c.expect(!tap.press(k9, 5000) && !tap.press('KeyW', 5100) && !tap.press(k9, 5200), '9, W, 9 triggered');
      tap.reset();
      c.expect(!tap.press(kp9, 6000) && tap.press(kp9, 6200), 'numpad 99 did not trigger');
      tap.reset();

      // Real key events during play: toggles, and never casts or buffers anything.
      app.startMatch();
      const key = (code: string) => window.dispatchEvent(new KeyboardEvent('keydown', { code }));
      key(k9);
      c.expect(!CONFIG.debug.godMode, 'a single 9 keydown toggled god mode');
      key(k9);
      c.expect(CONFIG.debug.godMode && p.immune && p.infiniteMana, '99 did not enable god mode');
      const toast = game.ui.querySelector('.toast.show');
      c.expect(!!toast && /god mode on/i.test(toast.textContent ?? ''), 'no GOD MODE ON toast');
      c.expect(Object.values(p.intent.buffered).every((v) => v === 0) && p.stats.casts === 0, '9 key buffered an action or cast');
      game.playerController.update();
      c.expect(Object.values(p.intent.buffered).every((v) => v === 0) && !p.intent.holdBolt, '9 key reached the spell bindings');
      key(k9);
      key(k9);
      c.expect(!CONFIG.debug.godMode && !p.immune && !p.infiniteMana, '99 did not disable god mode');
      c.expect(/god mode off/i.test(game.ui.querySelector('.toast.show')?.textContent ?? ''), 'no GOD MODE OFF toast');
      // Works in menus too, and the Settings checkbox follows.
      app.toMenu();
      app.menus.showSettings(() => app.menus.showMain());
      key(k9);
      key(k9);
      const box = app.menus.root.querySelector<HTMLInputElement>('input[data-god]');
      c.expect(CONFIG.debug.godMode && !!box?.checked, '99 in the menu did not enable god mode / sync Settings');
      key(k9);
      key(k9);
      c.expect(!CONFIG.debug.godMode && !box?.checked, '99 in the menu did not disable god mode');
      app.toMenu();
    } finally {
      for (const code of CONFIG.debug.godCheatKeys) window.dispatchEvent(new KeyboardEvent('keyup', { code }));
      app.godCheat.reset();
      game.setGodMode(prev);
    }
  });

  qa.add('campaign.god_unlimited_mana', (c) => {
    const prev = CONFIG.debug.godMode;
    const p = game.player;
    const S = CONFIG.spells;
    try {
      game.setGodMode(true);
      c.setup();
      let noMana = 0;
      const off = events.on('noMana', (ev) => {
        if (ev.wizard === p) noMana++;
      });
      let minMana = Infinity;
      // Sprinting pauses while a spell winds up, and with no cooldowns Blast winds up constantly, so
      // count only the ticks where sprint was possible (no cast pending).
      let sprintTicks = 0;
      let sprintable = 0;
      let t = 0;
      // Spam every spell and sprint in circles for 8 s.
      c.step(8, () => {
        t += CONFIG.sim.fixedDt;
        p.intent.move.set(Math.cos(t * 1.5), 0, Math.sin(t * 1.5));
        p.intent.sprint = true;
        p.intent.holdBolt = true;
        if (Math.floor(t * 10) % 3 === 0) p.intent.press('blast');
        if (Math.floor(t * 10) % 7 === 0) p.intent.press('stun');
        if (Math.floor(t * 10) % 11 === 0) p.intent.press('shield');
        game.enemy.health = game.enemy.maxHealth;
        if (p.cast === null) {
          sprintable++;
          if (p.sprinting) sprintTicks++;
        }
        minMana = Math.min(minMana, p.mana);
      });
      off();
      const casts = p.stats.casts;
      const sprintShare = sprintTicks / Math.max(1, sprintable);
      c.note(`casts=${casts} minMana=${minMana.toFixed(1)} sprint=${(sprintShare * 100).toFixed(0)}% of ${sprintable} free ticks`);
      c.expect(noMana === 0, `${noMana} NO MANA in god mode`);
      c.expect(minMana >= CONFIG.wizard.maxMana - S.blast.manaCost, `mana dropped to ${minMana.toFixed(1)}`);
      c.expect(p.mana >= CONFIG.wizard.maxMana - 1, `mana ended at ${p.mana.toFixed(1)}`);
      c.expect(casts > 40, `only ${casts} casts in 8 s of spam`);
      c.expect(sprintShare > 0.9, 'sprint stalled during the spell spam in god mode');
      // Long sprint while firing bolts (no wind-ups): it must never run dry.
      let longSprint = 0;
      c.step(6, () => {
        t += CONFIG.sim.fixedDt;
        p.intent.move.set(Math.cos(t * 1.5), 0, Math.sin(t * 1.5));
        p.intent.sprint = true;
        p.intent.holdBolt = true;
        if (p.sprinting) longSprint++;
      });
      c.expect(longSprint * CONFIG.sim.fixedDt > 5.7, `sprint exhausted in god mode (${(longSprint * CONFIG.sim.fixedDt).toFixed(2)} of 6 s)`);
      // Without god mode the same spam runs dry.
      game.setGodMode(false);
      c.setup();
      c.step(4, () => {
        p.intent.holdBolt = true;
        p.intent.sprint = true;
        p.intent.move.set(1, 0, 0);
      });
      c.expect(p.mana < 20, `mortal mana stayed at ${p.mana.toFixed(1)}`);
    } finally {
      game.setGodMode(prev);
    }
  });

  qa.add('campaign.single_difficulty_menu', (c) => {
    app.toMenu();
    const menu = app.menus.root;
    c.expect(menu.querySelectorAll('[data-diff], .diff').length === 0, 'main menu still offers a difficulty choice');
    const text = menu.textContent ?? '';
    for (const p of Object.values(CONFIG.ai.difficulty)) c.expect(!text.includes(p.label), `menu mentions "${p.label}"`);
    c.expect(!('difficulty' in loadSettings()), 'settings still carry a difficulty');
    c.expect(!!button(app, 'start') && !!button(app, 'gauntlet'), 'Quick Duel / Boss Gauntlet buttons missing');
  });

  qa.add('campaign.quick_duel_restores_defaults', (c) => {
    withStashedSave(app, () => {
      app.campaign.index = BOSSES.length - 1;
      app.showBossCard();
      c.expect(game.enemy.name === BOSSES[BOSSES.length - 1].name, 'boss not applied');
      button(app, 'menu')!.click();
      button(app, 'start')!.click();
      c.expect(app.state === 'playing' && app.mode === 'quick', 'Quick Duel did not start');
      const e = game.enemy;
      const team = CONFIG.teams[1];
      c.expect(e.name === team.name && e.team === team && e.visual.team === team, `rival look not restored (${e.name})`);
      c.expect(e.maxHealth === W.maxHealth && e.health === W.maxHealth && e.damageMultiplier === 1, `rival stats ${e.health}/${e.maxHealth} x${e.damageMultiplier}`);
      c.expect(game.arena.theme === 'moonlit', `theme ${game.arena.theme}`);
      c.expect(app.ai.profile === CONFIG.ai.difficulty.normal, 'Quick Duel AI is not the fixed rival profile');
      c.expect(app.match.boss === null && game.boss === null, 'match still has a boss');
      const want = new THREE.Color(team.spell).multiplyScalar(1.8);
      const got = game.spells.pool.teamBoltColor(1);
      c.expect(Math.abs(got.r - want.r) + Math.abs(got.g - want.g) + Math.abs(got.b - want.b) < 1e-3, 'bolt colour not restored');
      c.expect(e.visual.usesModel === (resolveAsset(MODELS.wizardRival.path) !== null), 'rival model not restored');
      c.expect(game.ui.style.getPropertyValue('--rival') === '', 'rival HUD colour not cleared');
      const plate = app.hud.root.querySelector('.plate-right')!.textContent ?? '';
      c.expect(plate.includes(team.name) && !plate.includes(BOSSES[BOSSES.length - 1].title), `plate "${plate.trim()}"`);
      c.expect(!Object.values(CONFIG.ai.difficulty).some((d) => plate.includes(d.label)), `plate shows a difficulty: "${plate.trim()}"`);
    });
  });
}
