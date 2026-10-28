import * as THREE from 'three';
import { CONFIG, type AIProfile } from '../config';
import type { App } from '../App';
import { resolveAsset } from '../assets/AssetLoader';
import { MODELS } from '../assets/manifest';
import { CAMPAIGN_STORAGE_KEY, Campaign } from '../campaign/Campaign';
import { BOSSES, type BossDef } from '../campaign/levels';
import { events } from '../core/events';
import type { Game } from '../core/Game';
import { AIController } from '../enemy/AIController';
import { loadSettings } from '../ui/Menus';
import type { QAHarness } from './QAHarness';

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
  /** youKillIn / killsYouIn: higher is harder. */
  threat: number;
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

/**
 * Headless difficulty probe for one opponent: (1) its AI attacks a target strafing left/right
 * that never shoots back, (2) a scripted shooter fires perfectly-led bolts at it. The rival is
 * dressed with `boss` (null = default rival stats).
 */
export function measureThreat(c: Ctx, game: Game, boss: BossDef | null, profile: AIProfile, seconds = 12, trials = 2): ThreatSample {
  const prevBoss = game.boss;
  game.setupEnemy(boss);
  const p = game.player, e = game.enemy;
  const ai = new AIController(e, p, game.spells, game.physics, game.arena, 'normal');
  ai.setProfile(profile);
  let dmg = 0;
  let time = 0;
  const off = events.on('damage', (ev) => {
    if (ev.source === e && ev.target === p) dmg += ev.amount;
  });
  let hits = 0;
  let shots = 0;
  try {
    for (let trial = 0; trial < trials; trial++) {
      // Offense: the target strafes, reversing every ~1.3 s, and never fires.
      c.setup();
      ai.reset();
      let t = 0;
      c.step(seconds, () => {
        t += DT;
        ai.update(DT);
        p.health = p.maxHealth;
        e.health = e.maxHealth;
        p.intent.move.set(Math.sin(t * 2.4 + trial) > 0 ? 1 : -1, 0, 0);
        p.intent.facing = Math.atan2(e.pos.x - p.pos.x, e.pos.z - p.pos.z);
      });
      time += seconds;

      // Defense: perfectly-led bolts at the AI, unlimited mana.
      c.setup();
      ai.reset();
      c.step(seconds * 0.75, () => {
        ai.update(DT);
        p.health = p.maxHealth;
        e.health = e.maxHealth;
        p.mana = 1e6;
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
    ai.dispose();
    game.setupEnemy(prevBoss);
  }
  const dps = dmg / time;
  const hitRate = hits / Math.max(1, shots);
  const maxHp = Math.round(W.maxHealth * (boss?.healthMultiplier ?? 1));
  const killsYouIn = W.maxHealth / Math.max(0.01, dps);
  const youKillIn = maxHp / Math.max(0.01, SUSTAINED_BOLT_DPS * hitRate);
  return { name: boss?.name ?? profile.label, dps, hitRate, killsYouIn, youKillIn, threat: youKillIn / killsYouIn };
}

const fmt = (s: ThreatSample) => `${s.name}: ${s.dps.toFixed(1)}dps hit${(s.hitRate * 100).toFixed(0)}% threat=${s.threat.toFixed(2)}`;

/** Run `fn` with the real campaign save stashed away, then put it back. */
function withStashedSave(app: App, fn: () => void): void {
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

/** Finish the current match as if `playerWon` (2-0), then show results immediately. */
function finishMatch(app: App, playerWon: boolean): void {
  const g = app.game;
  const m = app.match;
  m.wins[0] = playerWon ? 2 : 0;
  m.wins[1] = playerWon ? 0 : 2;
  m.roundWinners = playerWon ? [g.player, g.player] : [g.enemy, g.enemy];
  m.phase = 'matchEnd';
  events.emit('matchEnd', { winner: playerWon ? g.player : g.enemy });
  app.showResults();
}

const button = (app: App, act: string) => app.menus.root.querySelector<HTMLButtonElement>(`.menu-screen [data-act="${act}"]`);

export function registerCampaignScenarios(qa: QAHarness, game: Game, app: App): void {
  qa.add('campaign.ladder_escalates', (c) => {
    // Fight 1 must be clearly easier than fight 5 (and easier than the Apprentice quick duel).
    // Seeded so the AI's dice rolls repeat between runs; 4 trials of 12 s + 9 s per opponent.
    const samples = BOSSES.map((b, i) => withSeededRandom(1000 + i, () => measureThreat(c, game, b, b.ai, 12, 4)));
    const apprentice = withSeededRandom(999, () => measureThreat(c, game, null, CONFIG.ai.difficulty.easy, 12, 4));
    c.note(samples.map(fmt).join(' | '));
    c.note(`ref ${fmt(apprentice)}`);
    const first = samples[0], last = samples[samples.length - 1];
    c.expect(first.dps < last.dps * 0.5, `fight 1 deals ${first.dps.toFixed(1)} dps vs fight 5 ${last.dps.toFixed(1)}: not clearly gentler`);
    c.expect(first.hitRate > last.hitRate * 1.3, `fight 1 is hit ${(first.hitRate * 100).toFixed(0)}% vs fight 5 ${(last.hitRate * 100).toFixed(0)}%`);
    c.expect(last.threat > first.threat * 4, `threat only rises ${(last.threat / first.threat).toFixed(1)}x over the ladder`);
    c.expect(first.threat < apprentice.threat, `fight 1 (threat ${first.threat.toFixed(2)}) is not easier than the Apprentice (${apprentice.threat.toFixed(2)})`);
    for (let i = 1; i < samples.length; i++) {
      // Allow sampling noise, but each fight must not be meaningfully easier than the one before.
      c.expect(samples[i].threat > samples[i - 1].threat * 0.9, `${samples[i].name} is easier than ${samples[i - 1].name}`);
    }
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
        const hp = Math.round(W.maxHealth * boss.healthMultiplier);
        // The QA sandbox runs on default stats; setupEnemy above re-applied the boss's.
        c.expect(e.maxHealth === hp && e.health === hp, `${boss.id}: health ${e.health}/${e.maxHealth}, expected ${hp}`);
        c.expect(e.damageMultiplier === boss.damageMultiplier, `${boss.id}: damage multiplier ${e.damageMultiplier}`);
        const before = game.player.health;
        game.spells.dealDamage(game.player, e, 10, game.player.pos, 'bolt');
        c.near(before - game.player.health, 10 * boss.damageMultiplier, 1e-6, `${boss.id} dmg`);
        const hasGlb = resolveAsset(MODELS[boss.model].path) !== null;
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
      c.note(`models: ${BOSSES.map((b) => `${b.id}=${resolveAsset(MODELS[b.model].path) ? 'glb' : 'placeholder'}`).join(' ')}`);
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
      const next = button(app, 'rematch')!;
      c.expect(next.textContent!.includes(BOSSES[1].name), `results button reads "${next.textContent}"`);
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
      // Last boss: winning leads to the completion screen and resets the run.
      app.campaign.index = BOSSES.length - 1;
      app.startBossFight();
      finishMatch(app, true);
      button(app, 'rematch')!.click();
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
      let sprintTicks = 0;
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
        if (p.sprinting) sprintTicks++;
        minMana = Math.min(minMana, p.mana);
      });
      off();
      const casts = p.stats.casts;
      c.note(`casts=${casts} minMana=${minMana.toFixed(1)} sprint=${((sprintTicks * CONFIG.sim.fixedDt) / 8 * 100).toFixed(0)}%`);
      c.expect(noMana === 0, `${noMana} NO MANA in god mode`);
      c.expect(minMana >= CONFIG.wizard.maxMana - S.blast.manaCost, `mana dropped to ${minMana.toFixed(1)}`);
      c.expect(p.mana >= CONFIG.wizard.maxMana - 1, `mana ended at ${p.mana.toFixed(1)}`);
      c.expect(casts > 40, `only ${casts} casts in 8 s of spam`);
      c.expect(sprintTicks * CONFIG.sim.fixedDt > 6.5, 'sprint exhausted in god mode');
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
