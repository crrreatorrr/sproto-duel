import * as THREE from 'three';
import type { App } from '../App';
import type { ArenaThemeId } from '../arena/themes';
import { Campaign } from '../campaign/Campaign';
import { BOSSES, bossDisplayName, rewardsBefore } from '../campaign/levels';
import { CONFIG, type AIProfile } from '../config';
import { events } from '../core/events';
import { rewardLabels } from '../core/Gamepad';
import type { Game } from '../core/Game';
import { AIController } from '../enemy/AIController';
import { REWARD_SPELLS, REWARD_SPELL_INFO, type RewardSpellId } from '../spells/rewardCatalog';
import type { Wizard } from '../wizard/Wizard';
import { button, finishMatch, record, withMatchFlow, withSeededRandom, withStashedSave } from './campaignScenarios';
import { FakePad, withPad } from './gamepadScenarios';
import type { QAHarness } from './QAHarness';

const DT = CONFIG.sim.fixedDt;
const W = CONFIG.wizard;
const RS = CONFIG.rewardSpells;
const B = CONFIG.spells.bolt;

type Ctx = Parameters<Parameters<QAHarness['add']>[1]>[0];

const tmp = new THREE.Vector3();

/** Give `w` exactly these reward spells. */
function learn(w: Wizard, ids: readonly RewardSpellId[]): void {
  w.learned.clear();
  for (const id of ids) w.learned.add(id);
}

/** Press `id` and run one tick: true if it was cast (a rewardCast event for `w`). */
function cast(c: Ctx, w: Wizard, id: RewardSpellId): boolean {
  const seen = record('rewardCast');
  w.intent.press(id);
  c.step(DT);
  return seen().some((e) => e.wizard === w && e.spell === id);
}

/** Horizontal speed (m/s) over `seconds` while `each` runs. */
function speedOver(c: Ctx, w: Wizard, seconds: number, each?: () => void): number {
  const a = w.pos.clone().setY(0);
  c.step(seconds, each);
  return w.pos.clone().setY(0).distanceTo(a) / seconds;
}

/**
 * Boss reward spells (src/spells/RewardSpells.ts): unlocks and their save, the locks, god mode, each
 * spell's effect, cooldowns and mana, keys and pad buttons, the HUD row, Quick Duel, the boss card,
 * How to Play, the "new spell learned" reveal, the reference AI's use of them; and the small-window
 * menu layout (ui.menus_fit_900x560).
 */
export function registerRewardSpellScenarios(qa: QAHarness, game: Game, app: App): void {
  const arena = game.arena;
  const inTheme = (id: ArenaThemeId, fn: () => void) => {
    const dev = arena.devTheme;
    const start = arena.theme;
    arena.devTheme = null;
    try {
      void arena.applyTheme(id);
      fn();
    } finally {
      void arena.applyTheme(start);
      arena.devTheme = dev;
    }
  };

  qa.add('rewards.unlock_per_boss_and_persist', (c) => {
    const key = 'arcane-duel-campaign-qa-rewards';
    try {
      const a = new Campaign(key);
      a.reset();
      c.expect(a.unlocked.length === 0, 'a fresh save knows spells');
      BOSSES.forEach((b, i) => {
        a.index = i;
        a.recordWin();
        c.expect(a.lastLearned === b.reward && a.hasLearned(b.reward), `beating ${b.id} did not teach ${b.reward} (last ${a.lastLearned})`);
        // A fresh Campaign (as after a reload) reads the same spells, in gauntlet order.
        const again = new Campaign(key);
        c.expect(again.unlocked.join() === BOSSES.slice(0, i + 1).map((x) => x.reward).join(), `saved spells after ${b.id}: ${again.unlocked.join()}`);
      });
      // Beating a boss again teaches nothing new; a new gauntlet keeps them; the setting forgets them.
      a.index = 0;
      a.recordWin();
      c.expect(a.lastLearned === null && a.unlocked.length === REWARD_SPELLS.length, `a repeat win: last ${a.lastLearned}, ${a.unlocked.length} spells`);
      a.startNew();
      c.expect(new Campaign(key).unlocked.length === REWARD_SPELLS.length, 'New Gauntlet forgot the spells');
      const raw = JSON.parse(localStorage.getItem(key) ?? '{}');
      c.expect(raw.version === 2 && Array.isArray(raw.unlockedSpells), `save format ${JSON.stringify(raw)}`);
      a.forgetSpells();
      const f = new Campaign(key);
      c.expect(f.unlocked.length === 0 && f.saved.clears === 1, `forget: ${JSON.stringify(f.saved)}`);
    } finally {
      try {
        localStorage.removeItem(key);
      } catch {
        // ignore
      }
    }
  });

  qa.add('rewards.save_migration', (c) => {
    const key = 'arcane-duel-campaign-qa-migrate';
    const put = (v: unknown) => localStorage.setItem(key, JSON.stringify(v));
    try {
      // A save from before the spells: every boss before `next` was beaten.
      put({ next: 3, clears: 0 });
      const a = new Campaign(key);
      c.expect(a.unlocked.join() === 'carpet,pump,vape' && a.saved.next === 3, `next 3 -> ${a.unlocked.join()}`);
      const written = JSON.parse(localStorage.getItem(key)!);
      c.expect(written.version === 2 && written.unlockedSpells.join() === 'carpet,pump,vape', `not written back: ${JSON.stringify(written)}`);
      // A cleared gauntlet: all five.
      put({ next: 0, clears: 2 });
      c.expect(new Campaign(key).unlocked.length === REWARD_SPELLS.length, 'a cleared save did not get all five');
      put({ next: 0, clears: 0 });
      c.expect(new Campaign(key).unlocked.length === 0, 'a fresh old save got spells');
      // Junk and duplicates are dropped; the order is the gauntlet's.
      put({ version: 2, next: 1, clears: 0, unlockedSpells: ['vape', 'bogus', 'carpet', 'vape', 7] });
      c.expect(new Campaign(key).unlocked.join() === 'carpet,vape', `cleaned: ${new Campaign(key).unlocked.join()}`);
      localStorage.setItem(key, '{oops');
      c.expect(new Campaign(key).unlocked.length === 0, 'a corrupt save learned something');
    } finally {
      try {
        localStorage.removeItem(key);
      } catch {
        // ignore
      }
    }
  });

  qa.add('rewards.duo_teaches_once_both_are_down', (c) => {
    withStashedSave(app, () => {
      app.campaign.reset();
      app.campaign.index = 1;
      app.startBossFight();
      const m = app.match, p = game.player;
      c.expect(game.partnerActive, 'fight 2 is not a double fight');
      c.setup();
      m.phase = 'fight';
      game.actionsLocked = false;
      withMatchFlow(game, () => {
        game.spells.dealDamage(game.enemy, p, 1e6, game.enemy.chest(tmp), 'blast');
        // Obama's other stages are skipped by the sandbox's suspended stages: he is down.
        c.step(0.5);
      });
      c.expect(!game.enemy.alive && game.partner.alive && !app.campaign.hasLearned('pump'), `one boss down: learned ${app.campaign.unlocked.join()}`);
      withMatchFlow(game, () => {
        game.spells.dealDamage(game.partner, p, 1e6, game.partner.chest(tmp), 'blast');
        c.step(CONFIG.match.roundEndTime + 0.2);
      });
      c.expect((m.phase as string) === 'matchEnd' && app.campaign.hasLearned('pump') && app.campaign.lastLearned === 'pump', `both down: phase ${m.phase}, learned ${app.campaign.unlocked.join()}`);
      c.expect(p.learned.has('pump'), 'the player cannot cast the new spell yet');
    });
  });

  qa.add('rewards.locked_until_learned_god_unlocks_all', (c) => {
    const prev = CONFIG.debug.godMode;
    withStashedSave(app, () => {
      try {
        c.setup();
        const p = game.player;
        learn(p, []);
        const callouts = record('callout');
        for (const id of REWARD_SPELLS) c.expect(!cast(c, p, id), `${id} cast before it was learned`);
        c.expect(callouts().filter((e) => e.text === 'NOT LEARNED').length === REWARD_SPELLS.length, 'no NOT LEARNED feedback');
        learn(p, ['pump']);
        c.expect(cast(c, p, 'pump') && !cast(c, p, 'vape'), 'only the learned spell casts');
        // God mode: all five, never saved.
        app.campaign.reset();
        app.setGodMode(true);
        c.expect(p.learned.size === REWARD_SPELLS.length, `god mode knows ${p.learned.size} spells`);
        c.expect(app.campaign.unlocked.length === 0 && new Campaign().unlocked.length === 0, 'god mode saved spells');
        c.setup();
        for (const id of ['pump', 'vape', 'lockon'] as const) c.expect(cast(c, p, id), `god mode could not cast ${id}`);
        app.setGodMode(false);
        c.expect(p.learned.size === 0, `god mode off still knows ${[...p.learned].join()}`);
      } finally {
        app.setGodMode(prev);
      }
    });
  });

  qa.add('rewards.carpet_speed_hover_and_lava', (c) => {
    inTheme('volcano', () => {
      const p = game.player;
      const C = RS.carpet;
      const pool = arena.hazards[0];
      c.setup({ player: [0, -6], enemy: [0, 10] });
      learn(p, ['carpet']);
      const mana = p.mana;
      c.expect(cast(c, p, 'carpet') && p.riding, 'the carpet did not start');
      c.near(mana - p.mana, C.manaCost, 1e-6, 'carpet mana');
      c.near(p.rcd.carpet, C.cooldown, 1e-6, 'carpet cooldown');
      c.step(0.3, () => p.intent.move.set(1, 0, 0));
      const v = speedOver(c, p, 0.6, () => p.intent.move.set(1, 0, 0));
      c.near(v, W.moveSpeed * C.speedMultiplier, 0.4, 'carpet m/s');
      c.near(p.pos.y, C.hover, 0.05, 'hover height');
      // No casting on the carpet: bolts, blasts and the shield stay off.
      const casts = p.stats.casts;
      p.intent.press('bolt');
      p.intent.press('blast');
      p.intent.press('shield');
      c.step(0.1);
      c.expect(p.stats.casts === casts && !p.shielded, 'cast while riding');
      // Over a lava pool and through the fire ring: no burn.
      p.carpetTime = C.duration;
      p.pos.set(pool.x, C.hover, pool.z);
      p.placeBody();
      const hp = p.health;
      c.step(0.8, () => p.intent.move.set(0, 0, 0));
      c.expect(p.health === hp, `burned riding over lava (${hp - p.health})`);
      p.carpetTime = C.duration;
      p.spawn(CONFIG.arena.fireRadius - 0.1, 0, 0);
      p.carpetTime = C.duration;
      c.step(0.5);
      c.expect(p.health === hp, `burned riding through the fire ring (${hp - p.health})`);
      // Press it again: off at once, dropping to the floor; on lava that burns.
      p.spawn(pool.x, pool.z, 0);
      p.carpetTime = C.duration;
      c.step(0.3);
      const before = p.health;
      p.intent.press('carpet');
      c.step(DT);
      c.expect(!p.riding, 'pressing the carpet again did not land it');
      c.step(1);
      c.expect(p.pos.y < 0.01 && p.health < before, `after landing on lava: y ${p.pos.y.toFixed(2)}, hp ${before} -> ${p.health}`);
      c.note(`speed ${v.toFixed(1)} m/s`);
    });
  });

  qa.add('rewards.carpet_glides_over_rug_piles', (c) => {
    inTheme('desert', () => {
      const p = game.player;
      const rug = arena.pillars.find((x) => x.shape.kind === 'rugs');
      c.expect(!!rug, 'the bazaar has no rug pile');
      const r = rug!.position;
      // Walk into the rug pile: it stops you. Ride into it: you glide over the top.
      const start: [number, number] = [r.x - 4.5, r.z];
      c.setup({ player: start, enemy: [0, 14] });
      c.step(1.2, () => p.intent.move.set(1, 0, 0));
      c.expect(p.pos.x < r.x - 0.6 && p.pos.y < 0.01, `walked through/onto the rugs (x ${p.pos.x.toFixed(2)} vs ${r.x.toFixed(2)})`);
      c.setup({ player: start, enemy: [0, 14] });
      learn(p, ['carpet']);
      p.intent.press('carpet');
      let top = 0;
      c.step(1.1, () => {
        p.intent.move.set(1, 0, 0);
        if (Math.abs(p.pos.x - r.x) < 0.5) top = Math.max(top, p.pos.y);
      });
      c.expect(p.pos.x > r.x + 1.5, `the carpet stopped at the rugs (x ${p.pos.x.toFixed(2)} vs ${r.x.toFixed(2)})`);
      c.expect(top > rug!.shape.height, `glided at ${top.toFixed(2)} m over a ${rug!.shape.height} m pile`);
      c.note(`over the rugs at ${top.toFixed(2)} m`);
    });
  });

  qa.add('rewards.pump_damage_and_ult_charge', (c) => {
    const p = game.player, e = game.enemy;
    c.setup();
    learn(p, ['pump']);
    let hp = e.health;
    p.intent.press('bolt');
    c.step(0.6);
    const plain = hp - e.health;
    const ultPlain = p.ult;
    c.setup();
    learn(p, ['pump']);
    c.expect(cast(c, p, 'pump') && p.pumped, 'Pump It did not start');
    hp = e.health;
    p.intent.press('bolt');
    c.step(0.6);
    const pumped = hp - e.health;
    c.near(pumped / plain, RS.pump.damageMultiplier, 1e-6, 'damage x');
    c.near(p.ult / ultPlain, RS.pump.damageMultiplier * RS.pump.ultChargeMultiplier, 1e-6, 'ult charge x (more damage, 1.5x charge)');
    c.step(RS.pump.duration);
    c.expect(!p.pumped, 'Pump It never ended');
  });

  qa.add('rewards.vape_hides_and_heals', (c) => {
    const p = game.player, e = game.enemy;
    const V = RS.vape;
    // A sharp-eyed AI: no aim error, no lead, so its aim shows where it thinks you are.
    const profile: AIProfile = { ...CONFIG.ai.difficulty.normal, aimError: 0, leadFactor: 0, dodgeChance: 0, burstPause: [0.2, 0.3] };
    const ai = new AIController(e, p, game.spells, game.physics, arena, 'normal');
    ai.setProfile(profile);
    try {
      c.setup({ player: [0, -5], enemy: [0, 6] });
      learn(p, ['vape']);
      p.health = 100;
      c.step(0.6, () => ai.update(DT));
      c.expect(Math.abs(e.aimPoint.x - p.pos.x) < 0.3, 'the AI was not tracking the player');
      c.expect(cast(c, p, 'vape') && arena.smokes.length === 1, 'no smoke screen');
      const s = arena.smokes[0];
      c.near(s.radius * 2, 5, 1e-6, 'cloud m across');
      c.expect(arena.obscured(e.chest(new THREE.Vector3()), p.chest(tmp)), 'the cloud does not hide the player');
      // Slip sideways inside the cloud: the AI keeps aiming at the last known spot.
      const seenAt = p.pos.x;
      c.step(0.25, () => {
        ai.update(DT);
        p.intent.move.set(1, 0, 0);
      });
      p.intent.move.set(0, 0, 0);
      c.step(0.5, () => ai.update(DT));
      c.expect(Math.hypot(p.pos.x - s.x, p.pos.z - s.z) < s.radius, 'walked out of the cloud');
      c.expect(Math.abs(e.aimPoint.x - seenAt) < 0.35 && Math.abs(e.aimPoint.x - p.pos.x) > 1, `the AI still tracks you (aim x ${e.aimPoint.x.toFixed(2)}, you ${p.pos.x.toFixed(2)}, last seen ${seenAt.toFixed(2)})`);
      // Healing inside: 3 HP/s (the AI's blind fire is ignored for the measurement).
      const heals = record('rewardHeal');
      p.immune = true;
      const hp = p.health;
      c.step(2);
      p.immune = false;
      c.near(p.health - hp, V.healPerSecond * 2, 0.1, 'healed HP in 2 s');
      c.expect(heals().length >= 1, 'no heal popups');
      // Outside it: no healing; and it clears after its duration.
      p.spawn(s.x + 6, s.z, 0);
      const out = p.health;
      c.step(1);
      c.expect(p.health === out, 'healed outside the cloud');
      c.step(V.duration);
      c.expect(arena.smokes.length === 0 && !arena.obscured(e.chest(new THREE.Vector3()), new THREE.Vector3(s.x, 1.2, s.z)), 'the cloud never cleared');
    } finally {
      ai.dispose();
    }
  });

  qa.add('rewards.lockon_homes_respects_rolls_and_reflects', (c) => {
    const p = game.player, e = game.enemy;
    // Aim 2.4 m to the side of a target 14 m away: a plain bolt misses.
    const offAim = () => e.chest(p.aimPoint).add(tmp.set(2.4, 0, 0));
    c.setup({ player: [0, -7], enemy: [0, 7] });
    learn(p, ['lockon']);
    let hp = e.health;
    offAim();
    p.intent.press('bolt');
    c.step(0.8);
    c.expect(e.health === hp, 'the off-target bolt hit without Lock-On');
    c.setup({ player: [0, -7], enemy: [0, 7] });
    learn(p, ['lockon']);
    c.expect(cast(c, p, 'lockon') && p.lockedOn, 'Lock-On did not start');
    c.expect(game.spells.rewards.lockTarget(p) === e, 'no lock target in front');
    hp = e.health;
    offAim();
    p.intent.press('bolt');
    c.step(0.05);
    const bolt = game.spells.pool.active.find((x) => x.owner === p);
    c.expect(!!bolt && bolt.seek === e, 'the bolt is not homing');
    c.step(0.8);
    c.near(hp - e.health, B.damage, 1e-6, 'homing bolt damage');
    // Gentle: aimed well wide (40 degrees off), it curves but can't make the turn.
    c.setup({ player: [0, -7], enemy: [0, 7] });
    learn(p, ['lockon']);
    p.lockTime = RS.lockon.duration;
    hp = e.health;
    e.chest(p.aimPoint);
    p.aimPoint.sub(p.chest(tmp)).applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(32)).add(p.chest(tmp));
    p.intent.press('bolt');
    c.step(0.8);
    c.expect(e.health === hp, 'a bolt fired 32 degrees wide still turned onto the target');
    // A roll still slips it (i-frames).
    c.setup({ player: [0, -7], enemy: [0, 7] });
    learn(p, ['lockon']);
    p.lockTime = RS.lockon.duration;
    hp = e.health;
    offAim();
    p.intent.press('bolt');
    c.step(0.6, () => (e.iframes = 0.1));
    c.expect(e.health === hp, 'a homing bolt hit a rolling target');
    // A perfect shield reflects it, and it stops homing on its old target.
    c.setup({ player: [0, -7], enemy: [0, 7] });
    learn(p, ['lockon']);
    p.lockTime = RS.lockon.duration;
    offAim();
    p.intent.press('bolt');
    c.step(0.12);
    e.intent.press('shield');
    let reflected = false;
    c.step(0.4, () => {
      const b = game.spells.pool.active.find((x) => x.reflected);
      if (b) reflected ||= b.seek === null && b.owner === e;
    });
    c.expect(reflected, 'the homing bolt was not reflected (or kept seeking)');
    // Behind you: nothing to lock.
    c.setup({ player: [0, -7], enemy: [0, 7] });
    p.aimPoint.set(0, 1.2, -30);
    c.expect(game.spells.rewards.lockTarget(p) === null, 'locked onto an enemy behind');
  });

  qa.add('rewards.breath_cone_damage_and_burning', (c) => {
    const p = game.player, e = game.enemy;
    const Br = RS.breath;
    c.setup({ player: [0, 0], enemy: [0, 3] });
    learn(p, ['breath']);
    const mana = p.mana;
    const hits = record('damage');
    c.expect(cast(c, p, 'breath') && p.breathing, 'the breath did not start');
    c.near(mana - p.mana, Br.manaCost, 1e-6, 'breath mana');
    c.step(Br.duration + 0.05, () => game.player.chest(tmp) && e.chest(p.aimPoint));
    const seen = hits();
    const cone = seen.filter((d) => d.kind === 'breath' && d.target === e).reduce((a, d) => a + d.amount, 0);
    c.near(cone, Br.dps * Br.duration, Br.dps * Br.tick + 0.01, 'cone damage');
    c.expect(!p.breathing && e.scorched, 'no burning after the breath');
    // The burn keeps going after the flames stop.
    const burns = record('damage');
    c.step(Br.burnTime + 0.2);
    const burned = burns().filter((d) => d.kind === 'scorch' && d.target === e).reduce((a, d) => a + d.amount, 0);
    c.near(burned, Br.burnDps * Br.burnTime, Br.burnDps * Br.burnTick * 2, 'burn damage after');
    c.expect(!e.scorched, 'the burn never ended');
    // Out of the cone (to the side) and out of range: untouched.
    for (const [x, z, why] of [[2.6, 1.2, 'beside'], [0, Br.range + 2.5, 'beyond range']] as const) {
      c.setup({ player: [0, 0], enemy: [x, z] });
      learn(p, ['breath']);
      const hp = e.health;
      p.aimPoint.set(0, 1.2, 10);
      p.intent.facing = p.facing = 0;
      p.intent.press('breath');
      c.step(Br.duration, () => p.aimPoint.set(0, 1.2, 10));
      c.expect(e.health === hp, `burned an enemy ${why} the cone`);
    }
    // Slow while channelling.
    c.setup({ player: [0, 0], enemy: [8, 8] });
    learn(p, ['breath']);
    p.intent.press('breath');
    c.step(0.3, () => p.intent.move.set(1, 0, 0));
    const v = speedOver(c, p, 0.8, () => p.intent.move.set(1, 0, 0));
    c.near(v, W.moveSpeed * Br.moveMultiplier, 0.25, 'breathing m/s');
    // A shield blocks it.
    c.setup({ player: [0, 0], enemy: [0, 3] });
    learn(p, ['breath']);
    const hp = e.health;
    p.intent.press('breath');
    c.step(Br.duration, () => {
      e.shieldTime = 0.5;
      e.chest(p.aimPoint);
    });
    c.expect(e.health === hp, 'the breath went through a shield');
  });

  qa.add('rewards.cooldowns_and_mana', (c) => {
    const p = game.player;
    for (const id of REWARD_SPELLS) {
      c.setup({ player: [0, -6], enemy: [0, 12] });
      learn(p, REWARD_SPELLS);
      const S = RS[id];
      const mana = p.mana;
      c.expect(cast(c, p, id), `${id} did not cast`);
      c.near(mana - p.mana, S.manaCost, 0.5, `${id} mana`);
      c.near(p.rcd[id], S.cooldown, 1e-6, `${id} cooldown`);
      // Let the effect end, then press again before the cooldown is up: nothing (it waits, buffered).
      c.step(Math.min(S.cooldown - 0.5, S.duration + 0.4));
      if (id === 'carpet') c.step(0.6);
      c.expect(!cast(c, p, id), `${id} recast during its cooldown`);
      p.intent.consume(id);
      // Cooldown over but too little mana: NO MANA, no cast.
      p.rcd[id] = 0;
      if (S.manaCost > 0) {
        p.mana = S.manaCost - 1;
        const nm = record('noMana');
        c.expect(!cast(c, p, id) && nm().length === 1, `${id} cast without mana`);
      }
      p.mana = W.maxMana;
      c.expect(cast(c, p, id), `${id} not ready again after its cooldown`);
    }
    // God mode's no-cooldowns covers them too.
    c.setup();
    learn(p, ['pump']);
    p.noCooldowns = true;
    cast(c, p, 'pump');
    c.step(DT);
    c.expect(p.rcd.pump === 0, 'no-cooldowns left a reward cooldown');
    p.noCooldowns = false;
  });

  qa.add('rewards.key_and_pad_bindings', (c) => {
    const p = game.player;
    const pc = game.playerController;
    c.setup();
    // Keyboard: Z X V G T.
    for (const id of REWARD_SPELLS) {
      p.intent.clear();
      const code = CONFIG.controls[id][0];
      window.dispatchEvent(new KeyboardEvent('keydown', { code }));
      pc.update();
      game.input.endFrame();
      window.dispatchEvent(new KeyboardEvent('keyup', { code }));
      c.expect(p.intent.wants(id), `${code} did not ask for ${id}`);
    }
    c.expect(CONFIG.controls.carpet[0] === 'KeyZ' && CONFIG.controls.pump[0] === 'KeyX' && CONFIG.controls.vape[0] === 'KeyV' && CONFIG.controls.lockon[0] === 'KeyG' && CONFIG.controls.breath[0] === 'KeyT', 'keys moved');
    // Controller: D-pad left/up/right/down and X.
    withPad(game, app, (r) => {
      for (const id of REWARD_SPELLS) {
        p.intent.clear();
        const b = CONFIG.gamepad.bindings[id][0] as Parameters<FakePad['set']>[0];
        r.tap(b);
        c.expect(p.intent.wants(id), `pad ${b} did not ask for ${id}`);
      }
      const labels = rewardLabels('gamepad', 'xbox');
      c.expect(labels.join(' ') === '← ↑ → ↓ X', `pad labels ${labels.join(' ')}`);
    });
    // No reward key collides with another control.
    const used = new Map<string, string>();
    for (const [action, codes] of Object.entries(CONFIG.controls)) {
      if (!Array.isArray(codes)) continue;
      for (const code of codes as string[]) {
        c.expect(!used.has(code), `${code} is bound to both ${used.get(code)} and ${action}`);
        used.set(code, action);
      }
    }
    const padUsed = new Map<string, string>();
    for (const [action, bs] of Object.entries(CONFIG.gamepad.bindings)) {
      for (const b of bs) {
        c.expect(!padUsed.has(b), `pad ${b} is bound to both ${padUsed.get(b)} and ${action}`);
        padUsed.set(b, action);
      }
    }
  });

  qa.add('rewards.hud_slots', (c) => {
    const p = game.player;
    const root = app.hud.root;
    try {
      app.hud.show(true);
      c.setup();
      learn(p, []);
      app.hud.update(0);
      const row = root.querySelector('.reward-slots') as HTMLElement;
      c.expect(getComputedStyle(row).display === 'none', 'the reward row shows with nothing learned');
      learn(p, ['carpet', 'vape']);
      app.hud.setRewardKeyLabels(rewardLabels('kbm', 'xbox'));
      app.hud.update(0);
      const slot = (id: RewardSpellId) => root.querySelector(`.rslot-${id}`) as HTMLElement;
      const shown = REWARD_SPELLS.filter((id) => getComputedStyle(slot(id)).display !== 'none');
      c.expect(getComputedStyle(row).display !== 'none' && shown.join() === 'carpet,vape', `slots shown: ${shown.join()}`);
      c.expect(slot('carpet').querySelector('kbd')!.textContent === 'Z' && !!slot('carpet').querySelector('.slot-icon img, .slot-icon svg'), 'carpet slot key/icon');
      // Riding: the active ring runs; then the cooldown sweep; low mana locks it.
      p.intent.press('carpet');
      c.step(0.5);
      app.hud.update(0);
      const ring = slot('carpet').querySelector('rect')!.style.getPropertyValue('stroke-dasharray');
      c.expect(slot('carpet').classList.contains('active') && parseFloat(ring) > 50, `active ring ${ring}`);
      c.step(RS.carpet.duration);
      p.mana = 5;
      app.hud.update(0);
      const cd = slot('carpet').querySelector('.slot-sweep') as HTMLElement;
      c.expect(slot('carpet').classList.contains('cooling') && parseFloat(cd.style.getPropertyValue('--cd')) > 0, 'no cooldown sweep');
      c.expect(slot('carpet').classList.contains('nomana') && !slot('vape').classList.contains('nomana'), 'mana lock wrong (vape costs none)');
      c.expect(/\d/.test(slot('carpet').querySelector('.slot-time')!.textContent ?? ''), 'no cooldown seconds');
      // Pad glyphs.
      app.hud.setRewardKeyLabels(rewardLabels('gamepad', 'playstation'));
      c.expect(slot('vape').querySelector('kbd')!.textContent === '→', 'pad glyph on the vape slot');
      // Lock-On's reticle.
      learn(p, ['lockon']);
      c.setup();
      p.intent.press('lockon');
      c.step(DT);
      app.hud.update(0);
      c.expect(root.querySelector('.lock-reticle')!.classList.contains('on'), 'no lock reticle');
    } finally {
      app.hud.setRewardKeyLabels(rewardLabels(game.input.pad.device, game.input.pad.style));
      app.hud.show(app.state === 'playing' || app.state === 'paused');
    }
  });

  qa.add('rewards.quick_duel_and_gauntlet_use_unlocked', (c) => {
    withStashedSave(app, () => {
      app.campaign.reset();
      app.campaign.index = 0;
      app.campaign.recordWin();
      app.campaign.index = 1;
      app.campaign.recordWin();
      app.startMatch();
      const p = game.player;
      c.expect([...p.learned].join() === 'carpet,pump', `Quick Duel spells: ${[...p.learned].join()}`);
      c.expect(game.enemy.learned.size === 0, 'the rival learned spells');
      app.hud.update(0);
      c.expect(!!app.hud.root.querySelector('.reward-slots.on'), 'Quick Duel HUD has no reward row');
      // A later gauntlet fight has them too (and the boss none).
      app.campaign.index = 3;
      app.startBossFight();
      c.expect(p.learned.has('carpet') && p.learned.has('pump') && game.enemy.learned.size === 0, 'gauntlet fight 4 spells');
      c.setup();
      game.actionsLocked = false; // past the intro countdown
      learn(p, ['carpet', 'pump']);
      c.expect(cast(c, p, 'pump'), 'could not cast Pump It in a fight');
    });
  });

  qa.add('rewards.reveal_after_victory_and_boss_card', (c) => {
    withStashedSave(app, () => {
      app.campaign.reset();
      app.newGauntlet();
      const card = app.menus.root.querySelector('.boss-reward')?.textContent ?? '';
      c.expect(/defeat to learn/i.test(card) && card.includes(REWARD_SPELL_INFO.carpet.name), `boss card reward line "${card.trim()}"`);
      button(app, 'begin')!.click();
      finishMatch(app, true);
      c.expect((app.menus.root.querySelector('.result-learned')?.textContent ?? '').includes('Magic Carpet'), 'results do not name the new spell');
      const primary = button(app, 'rematch')!;
      c.expect(/continue/i.test(primary.textContent ?? ''), `results primary "${primary.textContent}"`);
      primary.click();
      const text = app.menus.root.textContent ?? '';
      c.expect(app.menus.current === 'reveal' && /new spell learned/i.test(text) && text.includes('Magic Carpet') && text.includes('Z'), `reveal screen: ${app.menus.current} "${text.slice(0, 120)}"`);
      c.expect(!!app.menus.root.querySelector('.reveal-icon img, .reveal-icon svg'), 'reveal has no icon');
      button(app, 'continue')!.click();
      c.expect(app.menus.current === 'boss' && (app.menus.root.textContent ?? '').includes(REWARD_SPELL_INFO.pump.name), 'continue did not reach the next boss card');
      // Beating Sahil again: nothing new, no reveal.
      app.campaign.index = 0;
      app.startBossFight();
      finishMatch(app, true);
      c.expect(!app.menus.root.querySelector('.result-learned') && (button(app, 'rematch')!.textContent ?? '').includes(bossDisplayName(BOSSES[1])), 'a repeat win offered a reveal');
      // The card of a boss whose spell you know says so.
      app.campaign.index = 0;
      app.showBossCard();
      c.expect(/already learned/i.test(app.menus.root.querySelector('.boss-reward')?.textContent ?? ''), 'a known reward still says "defeat to learn"');
      // How to Play lists all five.
      app.menus.showHowTo(() => app.toMenu());
      const how = app.menus.root.textContent ?? '';
      c.expect(REWARD_SPELLS.every((id) => how.includes(REWARD_SPELL_INFO[id].name)), 'How to Play misses a boss spell');
      c.expect((app.menus.root.querySelectorAll('.reward-list li.learned').length) === 1, 'How to Play learned marks');
    });
  });

  qa.add('rewards.forget_in_settings', (c) => {
    withStashedSave(app, () => {
      app.campaign.reset();
      app.campaign.index = 0;
      app.campaign.recordWin();
      app.toMenu();
      c.expect(game.player.learned.has('carpet'), 'the menu player has not learned the carpet');
      app.menus.showSettings(() => app.toMenu());
      const btn = button(app, 'forget')!;
      btn.click();
      c.expect(app.campaign.unlocked.length === 1, 'one press forgot already (no confirmation)');
      btn.click();
      c.expect(app.campaign.unlocked.length === 0 && game.player.learned.size === 0 && new Campaign().unlocked.length === 0, 'Forget did not forget');
      c.expect(app.campaign.saved.next === 1, 'Forget lost the gauntlet progress');
    });
  });

  qa.add('rewards.bosses_never_cast_them', (c) => {
    const prev = game.boss;
    const casts = record('rewardCast');
    try {
      for (const boss of BOSSES) {
        game.setupEnemy(boss);
        c.setup({ player: [0, -4], enemy: [0, 5] });
        const ais = game.enemies.map((w) => {
          const ai = new AIController(w, game.player, game.spells, game.physics, arena, 'normal');
          ai.setProfile(boss.ai);
          return ai;
        });
        c.expect(game.enemies.every((w) => w.learned.size === 0), `${boss.id} learned spells`);
        // Even pressed, a boss can't cast one.
        for (const id of REWARD_SPELLS) game.enemy.intent.press(id);
        c.step(4, () => ais.forEach((a) => a.update(DT)));
        ais.forEach((a) => a.dispose());
      }
      c.expect(casts().every((e) => e.wizard.side === 0), 'a boss cast a reward spell');
    } finally {
      game.setupEnemy(prev);
    }
  });

  qa.add('rewards.reference_ai_uses_them', (c) => {
    // The soak's reference player with every spell, against a hard opponent, for a while: it uses
    // them by its rules (carpet out of trouble, vape when low, pump before bursts, lock-on on a
    // strafer, breath up close).
    const p = game.player, e = game.enemy;
    c.expect(rewardsBefore(0).length === 0 && rewardsBefore(4).join() === 'carpet,pump,vape,lockon', `ladder spells ${rewardsBefore(4).join()}`);
    const used = new Set<RewardSpellId>();
    const off = events.on('rewardCast', (ev) => {
      if (ev.wizard === p) used.add(ev.spell);
    });
    const me = new AIController(p, e, game.spells, game.physics, arena, 'normal');
    const foe = new AIController(e, p, game.spells, game.physics, arena, 'hard');
    try {
      withSeededRandom(77, () => {
        for (let round = 0; round < 3; round++) {
          c.setup({ player: [0, -5], enemy: [0, 5] });
          learn(p, REWARD_SPELLS);
          me.reset();
          foe.reset();
          c.step(25, () => {
            me.update(DT);
            foe.update(DT);
            // Keep the duel going: nobody dies, the player stays hurt enough for its escape rules.
            e.health = e.maxHealth;
            if (!p.alive) return;
            p.health = Math.min(p.health, p.maxHealth * 0.3);
            if (p.health < 30) p.health = p.maxHealth * 0.3;
          });
        }
      });
    } finally {
      off();
      me.dispose();
      foe.dispose();
    }
    c.note(`used: ${[...used].join(', ')}`);
    for (const id of ['carpet', 'pump', 'vape', 'lockon'] as const) c.expect(used.has(id), `the reference AI never used ${id}`);
  });

  qa.add('ui.menus_fit_900x560', (c) => {
    // Every menu panel at 900x560 (the menus are a size container, so this works in any window):
    // its main button and its Back/Main Menu button are fully on screen without scrolling.
    const root = app.menus.root;
    const prevStyle = root.getAttribute('style');
    const prevLearned = [...game.player.learned];
    const problems: string[] = [];
    const sizes: string[] = [];
    try {
      root.style.cssText = 'position:absolute;left:0;top:0;right:auto;bottom:auto;width:900px;height:560px;';
      learn(game.player, REWARD_SPELLS.slice(0, 2));
      const check = (name: string) => {
        const screen = root.querySelector('.menu-screen') as HTMLElement;
        const box = root.getBoundingClientRect();
        const buttons = [...screen.querySelectorAll<HTMLButtonElement>('button.primary, [data-act="back"], [data-act="menu"], [data-act="quit"]')];
        if (!buttons.length) problems.push(`${name}: no buttons`);
        for (const b of buttons) {
          const r = b.getBoundingClientRect();
          let ok = r.height > 0 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5 && r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
          // Not clipped by a scrolling ancestor either (main menu panel, the screen).
          for (let el = b.parentElement; ok && el && el !== root; el = el.parentElement) {
            const cs = getComputedStyle(el);
            if (cs.overflowY === 'visible' && cs.overflowX === 'visible') continue;
            const a = el.getBoundingClientRect();
            if (r.top < a.top - 0.5 || r.bottom > a.bottom + 0.5) ok = false;
          }
          if (!ok) problems.push(`${name}: "${b.textContent?.trim()}" at ${Math.round(r.top)}..${Math.round(r.bottom)} of ${Math.round(box.height)}`);
        }
        sizes.push(`${name} ${screen.scrollHeight}`);
      };
      const stats = { damageDealt: 120, casts: 300, hits: 120, perfects: 2, dodges: 9 };
      const screens: [string, () => void][] = [
        ['main', () => app.menus.showMain()],
        ['howto', () => app.menus.showHowTo(() => {})],
        ['settings', () => app.menus.showSettings(() => {})],
        ['pause', () => app.menus.showPause('Fight 2 of 5 · Bitcoin Obama & The Midget, the Pump & Dump Duo', [
          { index: 2, name: 'Dump', who: 'Bitcoin Obama' }, { index: 1, name: 'To the Moon', who: 'The Midget', down: true }])],
        ...BOSSES.map((b, i) => [`boss card ${i + 1}`, () => app.menus.showBossIntro({ boss: b, index: i, total: BOSSES.length }, { begin() {}, back() {} })] as [string, () => void]),
        ['results (boss win)', () => app.menus.showResults({
          title: 'Victory', subtitle: 'Bitcoin Obama & The Midget, the Pump & Dump Duo, fall.', victory: true, names: ['You', 'Bitcoin Obama & The Midget'], rounds: [],
          eyebrow: 'Fight 2 of 5 cleared', boss: BOSSES[1], tag: 'God mode · progress not saved', learned: 'Pump It',
          facts: [{ label: 'Fight time', value: '17:42' }, { label: 'Stages reached', value: 'Bitcoin Obama III · The Midget III' }, { label: 'Life packs', value: '3 of 3' }, { label: 'Health left', value: '12%' }],
          primary: { label: 'Continue', action() {} }, player: stats, enemy: stats,
        })],
        ['results (quick duel)', () => app.menus.showResults({ title: 'Defeat', subtitle: 'The Rival wins this time.', victory: false, names: ['You', 'Rival'], rounds: ['win', 'lose', 'lose'], player: stats, enemy: stats })],
        ['complete', () => app.menus.showCampaignComplete({ clears: 2 }, { again() {}, menu() {} })],
        ...REWARD_SPELLS.map((id) => [`reveal ${id}`, () => app.menus.showSpellReveal(id, { next: { label: 'Next: Bitcoin Obama & The Midget', action() {} }, menu() {} })] as [string, () => void]),
      ];
      for (const [name, show] of screens) {
        show();
        check(name);
      }
      c.note(sizes.join(', '));
      c.expect(problems.length === 0, problems.join(' | '));
    } finally {
      if (prevStyle === null) root.removeAttribute('style');
      else root.setAttribute('style', prevStyle);
      learn(game.player, prevLearned);
      app.toMenu();
    }
  });
}
