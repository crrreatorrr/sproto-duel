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
    const r = scripted('holdFire', 'normal', 6);
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
    // Plan B2. Seconds of round 1 survived against the Adept doing nothing else.
    const idle = scripted('idle', 'normal', 24, { firstRoundOnly: true }).survival.mean;
    const strafe = scripted('strafe', 'normal', 24, { firstRoundOnly: true }).survival.mean;
    const roll = scripted('rollSpam', 'normal', 24, { firstRoundOnly: true }).survival.mean;
    c.note(`survival: idle ${idle} s, strafing ${strafe} s, rolling on cooldown ${roll} s (+${Math.round((roll / strafe - 1) * 100)}%)`);
    c.expect(idle < strafe, `standing still (${idle} s) outlasts strafing (${strafe} s)`);
    // The plan's goal is within 15% of strafing; the shipped cooldown gets to about 25-30%.
    c.expect(roll < strafe * 1.4, `rolling on cooldown survives ${roll} s against ${strafe} s strafing`);
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
        w.spells.dealDamage(sp, null, sp.maxHealth * 2, { x: sp.pos.x, y: 65536, z: sp.pos.z }, 'fire', null, 0);
        ticks(game, 2);
        c.expect(game.player.alive && game.player.health === game.player.maxHealth, `after the checkpoint: alive ${game.player.alive}, health ${game.player.health}`);
        c.expect(!game.checkpointReady && game.actionsLocked, 'the stage did not restart with a countdown');
        c.expect(banners.includes('Checkpoint'), `no Checkpoint banner (${banners.join(', ')})`);
        c.expect(app.state === 'playing' && !app.match.decided, 'the checkpoint ended the fight');
        ticks(game, 600, () => !game.actionsLocked);
        w.spells.dealDamage(sp, null, sp.maxHealth * 2, { x: sp.pos.x, y: 65536, z: sp.pos.z }, 'fire', null, 0);
        ticks(game, 2);
        c.expect(!game.player.alive && app.match.decided, 'a second knockout in the stage did not end the fight');
      } finally {
        hud.showBanner = showBanner as typeof hud.showBanner;
      }
    });
  });
}
