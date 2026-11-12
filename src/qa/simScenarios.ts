/**
 * Scenarios on the shipping path. The older scenarios drive the legacy engine (Game.tick's own
 * gameplay code); a real match runs on src/sim-core through SimDriver. These run the sim itself
 * (`sim.*`: balance figures from simProbe, deterministic) and the real game on it (`sim.live_*`:
 * a match started through the App, ticked like the game does, with a scripted player).
 */
import type { App } from '../App';
import { CONFIG } from '../config';
import type { Game } from '../core/Game';
import { replay } from '../sim-core';
import type { QAHarness } from './QAHarness';
import { bossProbe, scripted, simSoak } from './simProbe';

const DT = CONFIG.sim.fixedDt;
const S = CONFIG.spells;
const W = CONFIG.wizard;

/**
 * Run `fn` with the match flow live and on the sim (scenarios otherwise run headless in qaMode, on
 * the legacy engine), then leave through the main menu so nothing of the match is left running.
 */
function live(game: Game, app: App, fn: () => void): void {
  const lock = app.requireLock;
  app.requireLock = false;
  game.qaMode = false;
  game.inSandbox = false;
  try {
    fn();
  } finally {
    game.controllers[0] = game.playerController;
    app.toMenu();
    app.requireLock = lock;
    game.qaMode = true;
    game.inSandbox = true;
  }
}

/** The player's seat driven by a script (as scripts/check-game-sim-e2e.mjs does). */
function script(game: Game, each: (t: number) => void): void {
  let t = 0;
  game.controllers[0] = {
    kind: 'replay',
    tick() {
      const p = game.player, e = game.enemy;
      p.intent.facing = Math.atan2(e.pos.x - p.pos.x, e.pos.z - p.pos.z);
      p.aimPoint.set(e.pos.x, e.pos.y + 1.2, e.pos.z);
      each(t++);
    },
  };
}

function ticks(game: Game, n: number, until?: () => boolean): number {
  let i = 0;
  for (; i < n && !(until && until()); i++) {
    game.input.endFrame();
    game.tick(DT);
  }
  return i;
}

export function registerSimScenarios(qa: QAHarness, game: Game, app: App): void {
  // ---------------------------------------------------------------- balance figures (pure sim)

  qa.add('sim.mana_held_fire_keeps_a_blast_in_reach', (c) => {
    // Plan B1: holding fire used to sit at 0-10 mana with the rest of the kit locked.
    // Against the Archmage: the share is time above a Blast's mana over round length, and against
    // the gentler rivals a player who only stands and fires lives about twice as long (about 20%).
    const r = scripted('holdFire', 'hard', 6);
    const share = parseInt(r.mana.atLeastBlast, 10);
    c.note(`hold fire: mana >= ${S.blast.manaCost} in ${r.mana.atLeastBlast} of ${r.mana.samples} samples, <= 10 in ${r.mana.atMost10}, mean ${r.mana.mean}`);
    c.expect(share >= 33, `held fire has a Blast's mana in only ${r.mana.atLeastBlast} of samples (want a third)`);
  });

  qa.add('sim.attacker_casts_all_four_spells_each_round', (c) => {
    const r = scripted('attackerPaused', 'normal', 6);
    c.note(`attacker with pauses: all four spells in ${r.roundsWithAllFour}/${r.rounds} rounds, casts per round ${JSON.stringify(r.castsPerRound)}`);
    c.expect(r.roundsWithAllFour === r.rounds, `Blast, Shield, Stun and the Ultimate were all cast in only ${r.roundsWithAllFour} of ${r.rounds} rounds`);
  });

  qa.add('sim.roll_on_cooldown_survival_vs_strafing', (c) => {
    // Plan B2. Seconds of round 1 survived doing nothing else, against the Archmage: the gentler
    // rivals take most of the 80 s round to knock out anything that moves, which hides the gap.
    const idle = scripted('idle', 'hard', 48, { firstRoundOnly: true }).survival.mean;
    const strafe = scripted('strafe', 'hard', 48, { firstRoundOnly: true }).survival.mean;
    const roll = scripted('rollSpam', 'hard', 48, { firstRoundOnly: true }).survival.mean;
    c.note(`survival against the Archmage: idle ${idle} s, strafing ${strafe} s, rolling on cooldown ${roll} s (+${Math.round((roll / strafe - 1) * 100)}%)`);
    c.expect(idle < strafe, `standing still (${idle} s) outlasts strafing (${strafe} s)`);
    // The plan's goal is within about 15% of strafing (CONFIG.ai.rollPunishWindow: the rival punishes
    // rolls that dodge nothing). About 14% over 240 rounds; this sample moves a few points.
    c.expect(roll < strafe * 1.25, `rolling on cooldown survives ${roll} s against ${strafe} s strafing`);
    c.expect(W.dodge.iframes / (W.dodge.duration + W.dodge.cooldown) < 0.2, 'a roll on cooldown is invulnerable a fifth of the time or more');
  });

  qa.add('sim.ai_soak_round_lengths_and_spell_share', (c) => {
    // AI against AI at each profile: rounds of about 51-70 s, and the big spells keep their share.
    const rows = (['easy', 'normal', 'hard'] as const).map((d) => simSoak(d, 10));
    c.note(rows.map((r) => `${r.difficulty}: ${r.avgSeconds} s (${r.minSeconds}-${r.maxSeconds}), ${r.koRounds}/${r.rounds} KO, bolt ${r.damageShare.bolt} blast ${r.damageShare.blast} stun ${r.damageShare.stun} ult ${r.damageShare.ultimate}`).join(' | '));
    for (const r of rows) {
      c.expect(r.avgSeconds >= 44 && r.avgSeconds <= 72, `${r.difficulty} rounds average ${r.avgSeconds} s (want about 51-70)`);
      c.expect(r.koRounds >= r.rounds * 0.75, `${r.difficulty}: only ${r.koRounds} of ${r.rounds} rounds ended in a knockout`);
    }
    const hard = rows[2];
    c.expect(parseInt(hard.damageShare.bolt, 10) < 75, `Archmage rounds are ${hard.damageShare.bolt} bolt damage (plan B3: under 70%)`);
  });

  qa.add('sim.easier_rivals_are_easier', (c) => {
    const won = (['easy', 'normal', 'hard'] as const).map((d) => {
      const r = scripted('attackerPaused', d, 6);
      return r.roundsWon / r.rounds;
    });
    c.note(`scripted attacker round win rate: Apprentice ${won[0].toFixed(2)}, Adept ${won[1].toFixed(2)}, Archmage ${won[2].toFixed(2)}`);
    c.expect(won[0] > won[1] && won[1] >= won[2], `win rates do not fall with difficulty: ${won.map((x) => x.toFixed(2)).join(' / ')}`);
    c.expect(won[0] >= 0.5, `the scripted attacker wins only ${(won[0] * 100).toFixed(0)}% of rounds against the Apprentice`);
    c.expect(won[1] >= 0.25 && won[1] <= 0.7, `the Adept is not a middle step: the scripted attacker wins ${(won[1] * 100).toFixed(0)}% of rounds`);
  });

  qa.add('sim.first_boss_stage_pace', (c) => {
    // Plan C2: a scripted attacker (perfect aim, pauses) on Sahil for four minutes.
    const r = bossProbe('sahil', 'attackerPaused', { fights: 2, seconds: 240, immortal: true });
    const stage1 = r.dpsDealt;
    c.note(`Sahil, scripted attacker: ${r.dpsDealt} damage a second dealt, ${r.damageTakenPer4Min} taken in four minutes`);
    c.expect(stage1 > 6 && stage1 < 16, `the scripted attacker deals ${stage1} damage a second to Sahil`);
  });

  // ---------------------------------------------------------------- the real game on the sim

  qa.add('sim.live_quick_duel_follows_the_sim', (c) => {
    live(game, app, () => {
      app.startMatch();
      const d = game.sim;
      c.expect(!!d, 'a Quick Duel did not start on the sim');
      if (!d) return;
      const p = game.player, sp = d.world.wizards[0];
      c.expect(d.world.setup.rules === 'quick' && d.world.setup.difficulty === game.simDifficulty, `sim setup ${JSON.stringify({ rules: d.world.setup.rules, difficulty: d.world.setup.difficulty })}`);
      script(game, () => {
        p.intent.holdBolt = true;
      });
      ticks(game, 600, () => !game.actionsLocked);
      c.expect(!game.actionsLocked, 'the countdown never ended');
      // Five seconds of held fire: the game's wizard mirrors the sim's, and there is mana left.
      ticks(game, 300);
      c.near(p.mana, sp.mana / 65536, 0.01, 'player mana vs the sim');
      c.near(p.health, sp.health / 65536, 0.01, 'player health vs the sim');
      c.expect(p.stats.casts >= 20, `only ${p.stats.casts} bolts in five seconds of held fire`);
      c.expect(p.mana > W.maxMana * 0.5, `five seconds of held fire left ${p.mana.toFixed(0)} mana`);
      c.expect(game.spells.pool.active.length === d.world.spells.active.length, 'projectiles on screen differ from the sim');
      // The log the game recorded replays to where the sim is now... once the match is over.
      script(game, () => {});
      ticks(game, 60 * 400, () => d.over);
      c.expect(d.over, 'the match did not end');
      const r = replay(d.log(), { anyVersion: true });
      c.expect(r.ok && r.endHash === d.world.hash(), `the game's log does not replay: ${r.error ?? 'hash differs'}`);
      c.note(`${d.world.tick} ticks, wins ${d.world.match.wins.join('-')}, log ${JSON.stringify(d.log()).length} B`);
    });
    // Back in the menu the match's sim is gone: the background duel is not its leftovers.
    c.expect(game.sim === null, 'the finished match keeps simulating behind the menu');
  });

  qa.add('sim.live_practice_runs_every_lesson', (c) => {
    // The Practice tutorial, played by a script that does what each lesson asks.
    const saved = localStorage.getItem('arcane-duel-settings');
    let menu = '';
    live(game, app, () => {
      app.startPractice();
      const d = game.sim, tut = app.tutorial;
      c.expect(!!d && d.world.setup.rules === 'versus' && tut.active && game.practice, 'Practice did not start on the sim');
      if (!d) return;
      const w = d.world;
      const p = game.player;
      const seen: string[] = [];
      const lessonEl = game.ui.querySelector('.lesson') as HTMLElement;
      script(game, () => {
        const id = tut.run?.lesson?.id;
        if (id && seen[seen.length - 1] !== id) seen.push(id);
        const it = p.intent;
        it.holdBolt = id === 'bolt' || id === 'mana';
        it.move.set(0, 0, 0);
        if (id === 'blast') it.press('blast');
        if (id === 'roll') it.press('dodge');
        if (id === 'shield' || id === 'perfect') {
          // The dummy's bolt: raise the shield early for a plain block, at the last moment for a perfect one.
          const bolt = w.spells.active.find((b) => b.owner.index === 1);
          if (bolt) {
            const dist = Math.hypot(bolt.pos.x - w.wizards[0].pos.x, bolt.pos.z - w.wizards[0].pos.z) / 65536;
            const eta = dist / S.bolt.speed;
            if (id === 'shield' ? eta < 0.5 : eta < S.shield.perfectWindow * 0.6) it.press('shield');
          }
        }
        if (id === 'ticket') {
          const t = w.tickets.list[0];
          if (t) {
            const dx = t.x / 65536 - p.pos.x, dz = t.z / 65536 - p.pos.z;
            const len = Math.hypot(dx, dz) || 1;
            it.move.set(dx / len, 0, dz / len);
          }
        }
      });
      const n = ticks(game, 60 * 150, () => tut.result !== null);
      c.note(`lessons ${seen.join(' > ')} in ${(n / 60).toFixed(0)} s`);
      c.expect(seen.join(',') === 'bolt,mana,recover,blast,roll,shield,perfect,ticket', `lessons seen: ${seen.join(', ')}`);
      c.expect(tut.result !== null && tut.result.earned === tut.result.count, `Practice did not finish by doing every lesson: ${JSON.stringify(tut.result)} at "${lessonEl.textContent?.trim().slice(0, 80)}"`);
      // Nobody fell, the clock never ran down, and the dummy took real hits.
      c.expect(!d.over && w.match.round === 1 && w.match.timer > w.rules.roundTime - 6000, `the lesson fight moved on: round ${w.match.round}, over ${d.over}, clock ${w.match.timer / 6000}`);
      c.expect(game.enemy.alive && p.alive && game.enemy.stats.casts > 0, 'the dummy never fired, or someone fell');
      // The app's next frame shows the "Ready to duel" screen and remembers the lessons were done.
      game.advance(1 / 60);
      menu = app.menus.current ?? '';
      c.expect(menu === 'practice-done', `after the last lesson the menu is "${menu}"`);
      c.expect(game.sim === null && !game.practice && lessonEl.classList.contains('hidden'), 'Practice was not torn down');
      c.expect(JSON.parse(localStorage.getItem('arcane-duel-settings') ?? '{}').practiceDone === true, 'practiceDone was not saved');
    });
    if (saved === null) localStorage.removeItem('arcane-duel-settings');
    else localStorage.setItem('arcane-duel-settings', saved);
  });

  qa.add('sim.live_boss_checkpoint_restarts_the_stage', (c) => {
    live(game, app, () => {
      app.campaign.index = 0;
      app.startBossFight();
      // Transformations stay headless: this scenario ticks the sim itself, with no frames for a cinematic.
      app.cinematic.armed = false;
      const d = game.sim;
      c.expect(!!d && d.world.rules.single, 'the boss fight did not start on the sim');
      if (!d) return;
      const w = d.world;
      const banners: string[] = [];
      const hud = app.hud as unknown as { showBanner: (...a: unknown[]) => void };
      const showBanner = hud.showBanner;
      hud.showBanner = function (this: unknown, ...a: unknown[]) {
        banners.push(String(a[0]));
        return showBanner.apply(this, a);
      };
      try {
        script(game, () => {});
        ticks(game, 600, () => !game.actionsLocked);
        c.expect(!game.checkpointReady, 'stage 1 shows a checkpoint');
        // Into stage 2 (the cinematic is headless here), then a knockout.
        w.wizards[1].health = 0;
        ticks(game, 60);
        c.expect(w.stages[0].stage === 1, `boss stage ${w.stages[0].stage} after its first bar emptied`);
        ticks(game, 5);
        c.expect(game.checkpointReady, 'no checkpoint ready in stage 2');
        const sp = w.wizards[0];
        // All three life packs are spent (in the sim and on the HUD's hearts) before the knockout.
        w.lifePacks.spawned = game.lifePacks.spawned = CONFIG.lifePacks.maxPerFight;
        w.spells.dealDamage(sp, null, sp.maxHealth * 2, { x: sp.pos.x, y: 65536, z: sp.pos.z }, 'fire', null, 0);
        ticks(game, 2);
        c.expect(game.player.alive && game.player.health === game.player.maxHealth, `after the checkpoint: alive ${game.player.alive}, health ${game.player.health}`);
        c.expect(!game.checkpointReady && game.actionsLocked, 'the stage did not restart with a countdown');
        c.expect(banners.includes('Checkpoint'), `no Checkpoint banner (${banners.join(', ')})`);
        const back = CONFIG.lifePacks.maxPerFight - CONFIG.campaign.checkpoint.lifePacks;
        c.expect(w.lifePacks.spawned === back && game.lifePacks.spawned === back, `life packs after the checkpoint: sim ${w.lifePacks.spawned}, hearts ${game.lifePacks.spawned}`);
        // The returned pack shows up on the floor when the sim spawns it.
        ticks(game, 600, () => !game.actionsLocked);
        const spot = [sp.pos.x + 6 * 65536, sp.pos.z] as const;
        c.expect(w.lifePacks.spawnAt(spot[0], spot[1]) !== null, 'the sim refused the returned pack');
        ticks(game, 2);
        c.expect(game.lifePacks.pack.active && game.lifePacks.spawned === CONFIG.lifePacks.maxPerFight, 'the returned life pack is not on screen');
        c.expect(app.state === 'playing' && !app.match.decided, 'the checkpoint ended the fight');
        w.spells.dealDamage(sp, null, sp.maxHealth * 2, { x: sp.pos.x, y: 65536, z: sp.pos.z }, 'fire', null, 0);
        ticks(game, 2);
        c.expect(!game.player.alive && app.match.decided, 'a second knockout in the stage did not end the fight');
      } finally {
        hud.showBanner = showBanner as typeof hud.showBanner;
      }
    });
  });
}
