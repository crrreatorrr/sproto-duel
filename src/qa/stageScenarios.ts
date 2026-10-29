import * as THREE from 'three';
import { CONFIG } from '../config';
import type { App } from '../App';
import type { AssetLoader, ModelInstance } from '../assets/AssetLoader';
import { MODELS, type ModelKey } from '../assets/manifest';
import { STAGE_COUNT, stageProfile } from '../campaign/BossStages';
import { BOSSES, type BossDef, type VolleyDef } from '../campaign/levels';
import { events, type GameEvents } from '../core/events';
import type { Game } from '../core/Game';
import { AIController } from '../enemy/AIController';
import type { SpellId } from '../spells/types';
import { withSeededRandom } from './campaignScenarios';
import type { QAHarness } from './QAHarness';

const DT = CONFIG.sim.fixedDt;
const C = CONFIG.campaign;
const B = CONFIG.spells.bolt;

type Ctx = Parameters<Parameters<QAHarness['add']>[1]>[0];

const SAHIL = BOSSES[0];

/**
 * Run `fn` as a live boss fight against `boss`: stages un-suspended (the sandbox suspends them and
 * restores the flag afterwards), boss stats on, arena reset. The rival is restored afterwards.
 */
function withBoss(c: Ctx, game: Game, boss: BossDef | null, fn: () => void, setup?: Parameters<Ctx['setup']>[0]): void {
  const prev = game.boss;
  game.stages.suspended = false;
  game.setupEnemy(boss);
  try {
    c.setup(setup);
    fn();
  } finally {
    game.setupEnemy(prev);
  }
}

/** Collect events of `type` until the returned function is called; it returns what was seen. */
function record<K extends keyof GameEvents>(type: K): () => GameEvents[K][] {
  const seen: GameEvents[K][] = [];
  const off = events.on(type, (e) => void seen.push({ ...e }));
  return () => {
    off();
    return seen;
  };
}

/** Run through the rest of a transformation. */
function finishEvolve(c: Ctx): void {
  c.step(C.evolveTime + 0.05);
}

/** Bring the boss down to `fraction` of its current stage's bar with one hit from the player (0 empties it). */
function hitTo(game: Game, fraction: number): void {
  const e = game.enemy;
  game.spells.dealDamage(e, game.player, (e.health - e.maxHealth * fraction) / game.player.damageMultiplier, e.chest(new THREE.Vector3()), 'bolt');
}

/** Put the boss straight into `stage` with that stage's full bar (no transformation to wait for). */
function jumpTo(game: Game, stage: number): void {
  game.stages.evolveTo(stage);
  game.stages.release(0);
}

/** A stand-in GLB: one box in a group, enough for WizardVisual to treat it as a real model. */
function fakeModel(): ModelInstance {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(0.6, 2, 0.4), new THREE.MeshStandardMaterial()));
  return { root, animations: [] };
}

export function registerStageScenarios(qa: QAHarness, game: Game, app: App): void {
  const st = game.stages;

  qa.add('stages.bar_per_stage_transform_and_refill', (c) => {
    withBoss(c, game, SAHIL, () => {
      const e = game.enemy, p = game.player;
      const done = record('bossEvolve');
      const kos = record('ko');
      const bars = SAHIL.stageHealth;
      c.expect(st.stage === 0 && !e.evolving && e.maxHealth === bars[0] && e.health === bars[0], `fight starts in stage ${st.stage + 1} at ${e.health}/${e.maxHealth}`);
      c.expect(bars[1] >= bars[0] && bars[2] >= bars[1], `stage bars do not grow: ${bars}`);
      // Most of stage 1's bar: still stage 1.
      hitTo(game, 0.02);
      c.expect(st.stage === 0 && !e.evolving, 'transformed before the bar was empty');
      // Empty it: no KO, a transformation into stage 2 that starts from an empty bar.
      hitTo(game, 0);
      c.expect(e.alive && st.stage === 1 && e.evolving && e.maxHealth === bars[1] && e.health === 0, `emptied stage 1: alive=${e.alive} stage ${st.stage + 1} ${e.health}/${e.maxHealth}`);
      // Immune while it lasts.
      game.spells.dealDamage(e, p, 500, e.chest(new THREE.Vector3()), 'blast');
      c.expect(e.alive && e.evolving && st.stage === 1, 'a hit during the transformation landed');
      // The bar refills (sweeps up) during the transformation.
      const mid: number[] = [];
      c.step(C.evolveTime + 0.05, () => mid.push(e.health));
      c.expect(mid.some((h) => h > 0 && h < bars[1]) && mid.every((h, i) => i === 0 || h >= mid[i - 1] - 1e-9), 'the bar did not sweep up');
      c.expect(!e.evolving && e.health === bars[1] && e.maxHealth === bars[1], `stage 2 bar ${e.health}/${e.maxHealth}`);
      // Stage 2's bar out: stage 3, full bar. Stage 3's bar out: a KO, no transformation.
      hitTo(game, 0);
      finishEvolve(c);
      c.expect(st.stage === 2 && e.health === bars[2] && e.maxHealth === bars[2], `stage 3 bar ${e.health}/${e.maxHealth}`);
      const before = done().length;
      const again = record('bossEvolve');
      hitTo(game, 0);
      c.expect(!e.alive && again().length === 0 && st.stage === 2, 'emptying the last stage did not KO');
      const k = kos();
      c.expect(k.length === 1 && k[0].loser === e, `ko events ${k.length}`);
      c.expect(before === 2, `bossEvolve events ${before}`);
    });
  });

  qa.add('stages.overflow_discarded_no_skip', (c) => {
    withBoss(c, game, SAHIL, () => {
      const e = game.enemy;
      const done = record('bossEvolve');
      // A huge hit empties stage 1 only: the overflow is lost, no skip to stage 3, no KO.
      game.spells.dealDamage(e, game.player, 1e6, e.chest(new THREE.Vector3()), 'ultimate');
      finishEvolve(c);
      const seen = done();
      c.expect(e.alive && st.stage === 1 && e.health === e.maxHealth && e.maxHealth === SAHIL.stageHealth[1], `after a 1e6 hit: stage ${st.stage + 1}, ${e.health}/${e.maxHealth}`);
      c.expect(seen.length === 1 && seen[0].from === 0 && seen[0].stage === 1, `transformations ${JSON.stringify(seen.map((x) => [x.from, x.stage]))}`);
      // The emptying hit reports only the HP it took.
      c.setup();
      const dmg = record('damage');
      const hp = e.health;
      game.spells.dealDamage(e, game.player, hp + 777, e.chest(new THREE.Vector3()), 'blast');
      const d = dmg().filter((x) => x.target === e);
      c.expect(d.length === 1 && Math.abs(d[0].amount - hp) < 1e-6, `damage event ${d[0]?.amount} for a ${hp} HP bar`);
      // With stages suspended (QA stock stats) an empty bar is a plain KO.
      c.setup();
      st.suspended = true;
      try {
        hitTo(game, 0);
        c.expect(!e.alive, 'a suspended boss survived an empty bar');
      } finally {
        st.suspended = false;
      }
    });
  });

  qa.add('stages.player_health_persists', (c) => {
    withBoss(c, game, SAHIL, () => {
      const p = game.player, e = game.enemy;
      p.health = p.maxHealth * 0.37;
      p.mana = 40;
      hitTo(game, 0);
      finishEvolve(c);
      c.expect(st.stage === 1 && Math.abs(p.health - p.maxHealth * 0.37) < 1e-6, `player health ${p.health.toFixed(1)} after the boss transformed`);
      hitTo(game, 0);
      finishEvolve(c);
      c.expect(st.stage === 2 && Math.abs(p.health - p.maxHealth * 0.37) < 1e-6, 'player health refilled at stage 3');
      c.note(`player ${p.health.toFixed(0)}/${p.maxHealth}, boss ${e.health}/${e.maxHealth}`);
    }, { player: [0, -12], enemy: [0, 8] });
  });

  qa.add('stages.reset_every_round_and_boss', (c) => {
    withBoss(c, game, SAHIL, () => {
      const e = game.enemy;
      st.evolveTo(2);
      finishEvolve(c);
      c.expect(st.stage === 2 && e.maxHealth === SAHIL.stageHealth[2], 'could not force stage 3');
      // Round start (Match.startRound -> resetArena) puts stage 1 back, instantly.
      const stages = record('bossStage');
      c.setup();
      const ev = stages();
      c.expect(st.stage === 0 && !e.evolving && st.lookScale === 1, `after a round reset: stage ${st.stage + 1}, scale ${st.lookScale}`);
      c.expect(e.maxHealth === SAHIL.stageHealth[0] && e.health === e.maxHealth && e.height === CONFIG.wizard.height, `stage 1 bar/hurtbox after a reset: ${e.health}/${e.maxHealth}, ${e.height}`);
      c.expect(ev.some((x) => x.wizard === e && x.stage === 0 && x.boss === SAHIL), 'no bossStage(0) event at round reset');
      c.expect(e.damageMultiplier === SAHIL.damageMultiplier * C.stageDamage[0], `stage 1 damage multiplier ${e.damageMultiplier}`);
      // Mid-transformation resets too.
      hitTo(game, 0);
      c.expect(e.evolving, 'no transformation');
      c.setup();
      c.expect(st.stage === 0 && !e.evolving, 'a round reset mid-transformation left it evolving');
      // A different boss starts at its stage 1.
      st.evolveTo(1);
      game.setupEnemy(BOSSES[1]);
      c.expect(st.boss === BOSSES[1] && st.stage === 0 && !e.evolving, `new boss in stage ${st.stage + 1}`);
    });
    // The real flow: Match.startRound between rounds.
    const prev = game.boss;
    try {
      game.stages.suspended = false;
      app.campaign.index = 0;
      app.startBossFight();
      st.evolveTo(2);
      app.match.startRound();
      c.expect(st.stage === 0 && st.boss === SAHIL, `Match.startRound left stage ${st.stage + 1}`);
      // Retry (a new match) too, with a full stage 1 bar.
      jumpTo(game, 2);
      app.restart();
      c.expect(st.stage === 0 && game.enemy.health === SAHIL.stageHealth[0] && game.enemy.maxHealth === SAHIL.stageHealth[0], `Retry left stage ${st.stage + 1}`);
    } finally {
      app.toMenu();
      game.setupEnemy(prev);
    }
  });

  qa.add('stages.transform_immune_and_frozen', (c) => {
    withBoss(c, game, SAHIL, () => {
      const e = game.enemy, p = game.player;
      hitTo(game, 0);
      c.expect(e.evolving && Math.abs(e.evolveTime - C.evolveTime) < 1e-6, `evolveTime ${e.evolveTime}`);
      const hp = e.health;
      // Hits register but deal nothing, with an IMMUNE popup like god mode (the bar only refills).
      const dmg = record('damage');
      game.spells.dealDamage(e, p, 30, e.chest(new THREE.Vector3()), 'blast');
      const seen = dmg();
      c.expect(e.health === hp && seen.length === 1 && seen[0].amount === 0, `damage during the transform: hp ${hp} -> ${e.health}`);
      c.expect([...game.ui.querySelectorAll('.popup')].some((el) => el.textContent === 'IMMUNE'), 'no IMMUNE popup');
      // Frozen: intents do nothing (no casting, no moving, no rolling), and stuns don't take.
      const pos = e.pos.clone();
      const casts = e.stats.casts;
      const stuns = record('stunned');
      p.intent.press('stun');
      c.step(C.evolveTime * 0.7, () => {
        e.intent.holdBolt = true;
        e.intent.move.set(1, 0, 0);
        e.intent.press('blast');
        e.intent.press('dodge');
        e.intent.press('shield');
        e.intent.press('jump');
      });
      c.expect(e.stats.casts === casts, `boss cast ${e.stats.casts - casts} times mid-transform`);
      c.expect(e.pos.distanceTo(pos) < 0.05, `boss moved ${e.pos.distanceTo(pos).toFixed(2)} m mid-transform`);
      c.expect(!e.stunned && stuns().length === 0, 'stun beam stunned a transforming boss');
      c.expect(e.health >= hp, 'stun beam hurt a transforming boss');
      // The AI is frozen too (its update writes no intent).
      const ai = new AIController(e, p, game.spells, game.physics, game.arena);
      try {
        e.intent.clear();
        ai.update(DT);
        c.expect(!e.intent.holdBolt && e.intent.move.lengthSq() === 0, 'AI wrote intents mid-transform');
        // Afterwards everything works again.
        c.step(C.evolveTime);
        c.expect(!e.evolving, 'transformation never ended');
        c.aimAt(e, p);
        c.step(1, () => ai.update(DT));
        c.expect(e.stats.casts > casts, 'boss never cast again after evolving');
      } finally {
        ai.dispose();
      }
    });
  });

  qa.add('stages.shockwave_knocks_player_back', (c) => {
    withBoss(c, game, SAHIL, () => {
      const e = game.enemy, p = game.player;
      hitTo(game, 0);
      c.expect(p.knock.length() > C.evolveKnockback * 0.5, `knockback ${p.knock.length().toFixed(2)} on a player 5 m away`);
      const away = new THREE.Vector3().subVectors(p.pos, e.pos).setY(0).normalize();
      c.expect(p.knock.clone().normalize().dot(away) > 0.99, 'shockwave did not push straight away from the boss');
      const start = p.pos.distanceTo(e.pos);
      c.step(0.6);
      c.note(`pushed ${(p.pos.distanceTo(e.pos) - start).toFixed(2)} m`);
      c.expect(p.pos.distanceTo(e.pos) > start + 1, 'player was not pushed back');
      // Out of reach: no push.
      c.setup({ player: [0, -C.evolveRadius - 2], enemy: [0, 1] });
      hitTo(game, 0);
      c.expect(p.knock.lengthSq() === 0, 'player beyond evolveRadius was pushed');
    }, { player: [0, -4], enemy: [0, 1] });
  });

  qa.add('stages.ai_profile_scales_per_stage', (c) => {
    withBoss(c, game, BOSSES[2], () => {
      const ai = new AIController(game.enemy, game.player, game.spells, game.physics, game.arena);
      const boss = BOSSES[2];
      try {
        c.setup();
        const A = C.stageAI;
        for (let s = 0; s < STAGE_COUNT; s++) {
          if (s > 0) {
            st.evolveTo(s);
            finishEvolve(c);
          }
          const p = ai.profile;
          c.near(p.reactionTime, boss.ai.reactionTime * A.reactionTime[s], 1e-9, `s${s + 1} reaction`);
          c.expect(Math.abs(p.aimError - boss.ai.aimError * A.aimError[s]) < 1e-9, `s${s + 1} aimError ${p.aimError}`);
          // On top of the stage scaling, every boss presses harder (CONFIG.campaign.aggression).
          const G = C.aggression;
          c.expect(p.burst[0] === boss.ai.burst[0] + A.burstBonus[s] && p.burst[1] === boss.ai.burst[1] + A.burstBonus[s] + G.burstExtra, `s${s + 1} burst ${p.burst}`);
          c.expect(Math.abs(p.burstPause[1] - boss.ai.burstPause[1] * A.burstPause[s] * G.burstPause) < 1e-9, `s${s + 1} burstPause ${p.burstPause}`);
          c.expect(Math.abs(p.strafeSpeed - boss.ai.strafeSpeed * A.strafeSpeed[s] * G.strafeSpeed) < 1e-9, `s${s + 1} strafe ${p.strafeSpeed}`);
          c.expect(p.preferredRange[1] < boss.ai.preferredRange[1], `s${s + 1} does not close in`);
          c.expect(p.dodgeChance <= A.maxChance && p.dodgeChance >= boss.ai.dodgeChance, `s${s + 1} dodge ${p.dodgeChance}`);
          c.expect(p.leadFactor >= boss.ai.leadFactor && p.punishChance >= boss.ai.punishChance && p.blastChance >= boss.ai.blastChance, `s${s + 1} lead/punish/blast not scaled up`);
          if (s > 0) {
            const q = stageProfile(boss, s - 1);
            c.expect(p.reactionTime < q.reactionTime && p.aimError < q.aimError && p.burstPause[1] < q.burstPause[1] && C.stageDamage[s] > C.stageDamage[s - 1], `s${s + 1} not harder than s${s}`);
          }
          c.expect(ai.attacks === boss.stages[s].attacks, `s${s + 1} attacks not the stage's`);
          c.expect(Math.abs(game.enemy.damageMultiplier - boss.damageMultiplier * C.stageDamage[s]) < 1e-9, `s${s + 1} damage x${game.enemy.damageMultiplier}`);
          c.expect(game.enemy.maxHealth === boss.stageHealth[s], `s${s + 1} bar ${game.enemy.maxHealth}`);
          c.expect(JSON.stringify(stageProfile(boss, s)) === JSON.stringify(p), `s${s + 1} profile differs from stageProfile`);
        }
        // Leaving the gauntlet clears the gating.
        game.setupEnemy(null);
        c.expect(ai.attacks === null, 'Quick Duel rival still gated by boss stages');
      } finally {
        ai.dispose();
      }
    });
  });

  qa.add('stages.ai_attack_gating_per_stage', (c) => {
    // Every boss, every stage: with eager blast/stun odds, a charged Ultimate (kept charged while it is
    // locked), a target whose roll is spent, and endless mana, the AI
    // casts exactly what the stage allows, and its volley only where the stage lists one.
    const rows: string[] = [];
    BOSSES.forEach((boss, bi) => {
      withBoss(c, game, boss, () => {
        const e = game.enemy, p = game.player;
        const ai = new AIController(e, p, game.spells, game.physics, game.arena);
        try {
          for (let s = 0; s < STAGE_COUNT; s++) {
            c.setup();
            if (s > 0) {
              st.evolveTo(s);
              finishEvolve(c);
            }
            ai.setProfile({ ...stageProfile(boss, s), blastChance: 1, stunChance: 1 });
            ai.reset();
            e.infiniteMana = true;
            e.ult = CONFIG.spells.ultimate.chargeMax; // charged from the start; locked stages must not cast it
            const casts: Partial<Record<SpellId, number>> = {};
            const offCast = events.on('cast', (ev) => {
              if (ev.wizard === e) casts[ev.spell] = (casts[ev.spell] ?? 0) + 1;
            });
            const charge = record('castStart');
            const volleys = record('volley');
            let t = 0;
            withSeededRandom(4000 + bi * 10 + s, () =>
              c.step(9, () => {
                t += DT;
                ai.update(DT);
                if (!boss.stages[s].attacks.ultimate) e.ult = CONFIG.spells.ultimate.chargeMax;
                e.health = e.maxHealth; // never empties its bar
                p.health = p.maxHealth;
                p.cd.dodge = 1; // a spent roll: the AI's cue that an Ultimate will land
                p.intent.move.set(Math.sin(t * 2.2) > 0 ? 1 : -1, 0, 0);
              }),
            );
            offCast();
            e.infiniteMana = false;
            const ults = charge().filter((x) => x.wizard === e && x.spell === 'ultimate').length;
            const v = volleys().filter((x) => x.wizard === e);
            const a = boss.stages[s].attacks;
            const tag = `${boss.id} s${s + 1}`;
            c.expect(st.stage === s, `${tag}: stage drifted to ${st.stage + 1}`);
            c.expect(!!casts.blast === a.blast, `${tag}: blast ${a.blast ? 'never cast' : `cast ${casts.blast}x while locked`}`);
            c.expect(!!casts.stun === a.stun, `${tag}: stun ${a.stun ? 'never cast' : `cast ${casts.stun}x while locked`}`);
            c.expect((ults > 0) === a.ultimate, `${tag}: ultimate ${a.ultimate ? 'never cast' : `charge-cast ${ults}x while locked`}`);
            c.expect((v.length > 0) === !!a.volley, `${tag}: ${v.length} volleys, stage has ${a.volley?.name ?? 'none'}`);
            c.expect(v.every((x) => x.name === a.volley?.name && x.count === a.volley?.count), `${tag}: wrong volley fired`);
            c.expect((casts.bolt ?? 0) > 0, `${tag}: no bolts`);
            rows.push(`${tag}:${casts.blast ?? 0}b/${casts.stun ?? 0}s/${ults}u/${v.length}v`);
          }
        } finally {
          e.infiniteMana = false;
          ai.dispose();
        }
      });
    });
    c.note(rows.join(' '));
  });

  qa.add('stages.volley_fan_count_spread_damage', (c) => {
    withBoss(c, game, SAHIL, () => {
      const e = game.enemy, p = game.player;
      const def: VolleyDef = { name: 'QA Fan', count: 5, spreadDeg: 36, interval: 0, cooldown: 1, damageScale: 0.6 };
      e.damageMultiplier = 1.5;
      c.aimAt(e, p);
      const before = game.spells.pool.active.length;
      const fired = record('volley');
      c.expect(game.spells.castVolley(e, def), 'castVolley refused a free caster');
      const shots = game.spells.pool.active.slice(before).filter((x) => x.owner === e);
      c.expect(shots.length === 5, `fan spawned ${shots.length} bolts`);
      // Yaw of each shot relative to the boss -> player line (the boss faces -z here, across the +-pi seam).
      const aim = new THREE.Vector3().subVectors(p.pos, e.pos).setY(0).normalize();
      const yaws = shots.map((x) => Math.atan2(aim.x * x.vel.z - aim.z * x.vel.x, aim.x * x.vel.x + aim.z * x.vel.z)).sort((a, b) => a - b);
      c.expect(Math.abs(yaws[2]) < THREE.MathUtils.degToRad(3), `middle shot ${THREE.MathUtils.radToDeg(yaws[2]).toFixed(1)} deg off the aim line`);
      const spread = THREE.MathUtils.radToDeg(yaws[4] - yaws[0]);
      c.near(spread, 36, 0.5, 'spread deg');
      c.near(THREE.MathUtils.radToDeg(yaws[1] - yaws[0]), 9, 0.3, 'step deg');
      c.expect(shots.every((x) => x.kind === 'bolt' && x.damage === B.damage * 0.6 && x.vel.length() > B.speed - 1e-6), 'fan shots are not standard bolts at damageScale');
      c.expect(fired().length === 1, 'no volley event');
      const hp = p.health;
      c.step(0.6);
      // The middle shot lands; the others pass to either side.
      c.near(hp - p.health, B.damage * 0.6 * 1.5 * e.spellDamageScale, 1e-6, 'one fan hit (x damage multiplier and spell scale)');
      c.expect([...game.ui.querySelectorAll('.popup')].some((el) => el.textContent === 'QA Fan!'), 'no "QA Fan!" popup over the boss');
    });
  });

  qa.add('stages.volley_burst_timing', (c) => {
    withBoss(c, game, SAHIL, () => {
      const e = game.enemy, p = game.player;
      const def: VolleyDef = { name: 'QA Burst', count: 7, spreadDeg: 7, interval: 0.07, cooldown: 1, damageScale: 0.5 };
      c.aimAt(e, p);
      const times: number[] = [];
      const off = events.on('cast', (ev) => {
        if (ev.wizard === e && ev.spell === 'bolt') times.push(game.simTime);
      });
      const t0 = game.simTime;
      c.expect(game.spells.castVolley(e, def), 'burst refused');
      c.expect(times.length === 1 && game.spells.volleyFiring(e), 'burst should fire one shot at once and keep firing');
      c.expect(!game.spells.castVolley(e, def), 'a second volley started mid-burst');
      c.step(0.6);
      off();
      c.expect(times.length === 7 && !game.spells.volleyFiring(e), `burst fired ${times.length} shots`);
      c.near(times[6] - t0, 6 * def.interval, DT + 1e-6, 'burst length s');
      for (let i = 1; i < times.length; i++) c.expect(Math.abs(times[i] - times[i - 1] - def.interval) <= DT + 1e-6, `gap ${i} = ${(times[i] - times[i - 1]).toFixed(3)} s`);
      // Each shot re-aims and sweeps the spread; all hit the near-static target at 0.5x.
      c.near(CONFIG.wizard.maxHealth - p.health, 7 * B.damage * 0.5 * e.damageMultiplier * e.spellDamageScale, B.damage * e.spellDamageScale, 'burst damage');
      // A stun cuts it short.
      c.setup();
      c.aimAt(e, p);
      times.length = 0;
      const off2 = events.on('cast', (ev) => {
        if (ev.wizard === e && ev.spell === 'bolt') times.push(game.simTime);
      });
      game.spells.castVolley(e, def);
      c.step(def.interval * 1.5);
      e.applyStun(1);
      c.step(0.6);
      off2();
      c.expect(times.length === 2 && !game.spells.volleyFiring(e), `stunned burst still fired ${times.length} shots`);
    }, { player: [0, -2], enemy: [0, 6] });
  });

  qa.add('stages.volley_shots_are_ordinary_bolts', (c) => {
    withBoss(c, game, SAHIL, () => {
      const e = game.enemy, p = game.player;
      // A perfect shield reflects a volley shot back at the boss like any bolt.
      c.aimAt(e, p);
      game.spells.castVolley(e, { name: 'QA One', count: 1, spreadDeg: 0, interval: 0, cooldown: 1, damageScale: 1 });
      const shot = game.spells.pool.active.find((x) => x.owner === e)!;
      let pressed = false;
      c.step(0.5, () => {
        if (!pressed && shot.active && shot.owner === e && shot.pos.distanceTo(p.chest(new THREE.Vector3())) < 3.5) {
          p.intent.press('shield');
          pressed = true;
        }
      });
      c.expect(p.stats.perfects === 1, `perfect reflects ${p.stats.perfects}`);
      c.expect(e.health < e.maxHealth, 'reflected volley shot did not hit the boss');
      // A volley shot clashes with an opposing bolt mid-air.
      c.setup();
      c.aimAt(e, p);
      c.aimAt(p, e);
      const clashes = record('clash');
      p.intent.press('bolt');
      game.spells.castVolley(e, { name: 'QA One', count: 1, spreadDeg: 0, interval: 0, cooldown: 1, damageScale: 1 });
      c.step(0.4);
      c.expect(clashes().length >= 1, 'volley shot did not clash with a bolt');
    }, { player: [0, -6], enemy: [0, 6] });
  });

  qa.add('stages.stage_models_and_placeholder_growth', (c) => {
    const boss = SAHIL;
    const keys = boss.stages.map((s) => s.model);
    const orig = game.assets.instantiate.bind(game.assets);
    const has = new Set<ModelKey>();
    // Control which stage GLBs "exist", independent of what is on disk.
    game.assets.instantiate = (key) => (keys.includes(key) ? (has.has(key) ? fakeModel() : null) : orig(key));
    try {
      c.expect(keys.every((k, i) => k in MODELS && MODELS[k].path.endsWith(`stage${i + 1}.glb`)), `stage model keys ${keys}`);
      // No GLBs: the placeholder stays and grows per stage.
      game.setupEnemy(null);
      withBoss(c, game, boss, () => {
        const v = game.enemy.visual;
        c.expect(!v.usesModel && st.modelShown === null && v.root.scale.x === 1, 'stage 1 placeholder');
        const top1 = v.topHeight * v.root.scale.y;
        st.evolveTo(1);
        c.step(C.evolveTime * C.evolveSwapAt * 0.5);
        c.expect(st.lookScale === 1, 'look changed before the swap point');
        finishEvolve(c);
        c.near(v.root.scale.x, C.placeholderScale[1], 1e-6, 'stage 2 placeholder scale');
        st.evolveTo(2);
        finishEvolve(c);
        c.near(v.root.scale.x, C.placeholderScale[2], 1e-6, 'stage 3 placeholder scale');
        c.expect(!v.usesModel, 'placeholder replaced without a GLB');
        c.expect(v.topHeight * v.root.scale.y > top1 * 1.2, 'HUD tag height does not follow the bigger boss');
      });
      // Stage 2's GLB only: stage 1 placeholder, stage 2 model at scale 1, stage 3 keeps it, grown relative to it.
      has.add(keys[1]);
      game.setupEnemy(null);
      withBoss(c, game, boss, () => {
        const v = game.enemy.visual;
        c.expect(!v.usesModel, 'stage 1 should be the placeholder');
        st.evolveTo(1);
        finishEvolve(c);
        c.expect(v.usesModel && st.modelShown === keys[1] && v.root.scale.x === 1, `stage 2 look: model=${st.modelShown} scale=${v.root.scale.x}`);
        c.near(v.topHeight, MODELS[keys[1]].fitHeight!, 1e-6, 'stage 2 topHeight (fitHeight)');
        c.expect(v.team === boss.palette, 'stage model lost the boss palette');
        st.evolveTo(2);
        finishEvolve(c);
        c.expect(st.modelShown === keys[1], 'stage 3 dropped the stage 2 model');
        c.near(v.root.scale.x, C.placeholderScale[2] / C.placeholderScale[1], 1e-6, 'stage 3 relative growth');
        c.setup();
        c.expect(!v.usesModel && st.modelShown === null && v.root.scale.x === 1, 'round reset did not restore the stage 1 look');
      });
      // All three GLBs: each stage wears its own model.
      keys.forEach((k) => has.add(k));
      game.setupEnemy(null);
      withBoss(c, game, boss, () => {
        const v = game.enemy.visual;
        c.expect(v.usesModel && st.modelShown === keys[0], 'stage 1 model');
        for (let s = 1; s < STAGE_COUNT; s++) {
          st.evolveTo(s);
          finishEvolve(c);
          c.expect(st.modelShown === keys[s] && v.root.scale.x === 1, `stage ${s + 1}: model ${st.modelShown} scale ${v.root.scale.x}`);
        }
      });
    } finally {
      delete (game.assets as Partial<AssetLoader>).instantiate;
      const prev = game.boss;
      game.setupEnemy(null);
      game.setupEnemy(prev);
    }
  });

  qa.add('stages.hurtbox_covers_stage_model', (c) => {
    // Every boss (and the double fight's partner), every stage: a bolt aimed at 85% of the stage
    // model's height lands, so heads, hats and wings are part of the target.
    const rows: string[] = [];
    for (const boss of BOSSES) {
      for (const who of boss.partner ? (['boss', 'partner'] as const) : (['boss'] as const)) {
        withBoss(c, game, boss, () => {
          const p = game.player;
          const w = who === 'boss' ? game.enemy : game.partner;
          const ws = game.stagesOf(w)!;
          const marks: string[] = [];
          for (let s = 0; s < STAGE_COUNT; s++) {
            c.setup({ player: [0, -6], enemy: [0, 6], partner: [-6, 6] });
            if (s > 0) {
              ws.evolveTo(s);
              ws.release(0);
            }
            c.expect(ws.stage === s, `${w.name}: could not reach stage ${s + 1}`);
            const top = w.visual.topHeight * ws.lookScale;
            const y = w.pos.y + 0.85 * top;
            p.aimPoint.set(w.pos.x, y, w.pos.z);
            p.facing = p.intent.facing = Math.atan2(w.pos.x - p.pos.x, w.pos.z - p.pos.z);
            const hp = w.health;
            p.intent.press('bolt');
            c.step(0.5);
            c.expect(w.health < hp, `${w.name} s${s + 1}: a bolt at ${y.toFixed(2)} m (0.85 x ${top.toFixed(2)} m) missed a ${w.height.toFixed(2)} m hurtbox`);
            c.expect(s === 0 || w.radius > C.hurtbox.radius[0] * (w.radius / C.hurtbox.radius[s]) - 1e-9, `${w.name} s${s + 1}: radius ${w.radius}`);
            marks.push(`${w.height.toFixed(2)}/${w.radius.toFixed(2)}`);
          }
          rows.push(`${boss.id}${who === 'partner' ? '+' : ''}:${marks.join(',')}`);
          // Back at stage 1 the capsule is the stage 1 one again.
          c.setup();
          c.expect(ws.stage === 0 && Math.abs(w.radius - (who === 'partner' ? boss.partner!.hitbox.radius : CONFIG.wizard.radius)) < 1e-9, `${w.name}: stage 1 hurtbox not restored`);
        });
      }
    }
    c.note(rows.join(' '));
  });

  qa.add('stages.quick_duel_has_none', (c) => {
    withBoss(c, game, null, () => {
      const e = game.enemy;
      const evolves = record('bossEvolve');
      for (const f of [0.6, 0.3, 0.05]) hitTo(game, f);
      c.step(0.5);
      st.evolveTo(2);
      c.expect(evolves().length === 0 && st.stage === 0 && !e.evolving && st.current === null, 'the default rival evolved');
      // No stage bars: an empty bar is a KO.
      hitTo(game, 0);
      c.expect(!e.alive, 'the Quick Duel rival survived an empty bar');
      c.expect(e.visual.root.scale.x === 1 && e.damageMultiplier === 1, 'rival look or damage changed');
    });
    app.startMatch();
    try {
      app.hud.update(0);
      c.expect(!app.hud.root.querySelector('.plate-right.staged'), 'Quick Duel HUD shows boss stages');
      c.expect(app.ai.attacks === null, 'Quick Duel AI is stage-gated');
    } finally {
      app.toMenu();
    }
  });

  qa.add('stages.hud_card_banner_pause', (c) => {
    const prev = game.boss;
    try {
      game.stages.suspended = false;
      app.campaign.index = 0;
      app.showBossCard();
      const items = [...app.menus.root.querySelectorAll('.boss-stages li')].map((li) => li.textContent ?? '');
      c.expect(items.length === 3 && SAHIL.stages.every((s, i) => items[i].includes(s.name)), `boss card stages: ${items.join(' | ')}`);
      c.expect(items[2].includes(SAHIL.stages[2].attacks.volley!.name), 'card does not name the stage 3 volley');
      app.startBossFight();
      app.hud.update(0);
      const plate = app.hud.root.querySelector('.plate-right')!;
      const pips = () => [...plate.querySelectorAll('.stage-pips i')].map((i) => i.className);
      c.expect(plate.classList.contains('staged') && pips().join(',') === 'on,,', `stage 1 pips ${pips()}`);
      c.expect((plate.querySelector('.stage-name')?.textContent ?? '') === SAHIL.stages[0].name, 'stage name missing on the plate');
      st.evolveTo(1);
      const banner = app.hud.root.querySelector('.banner')!;
      c.expect(banner.classList.contains('stage') && /stage 2/i.test(banner.textContent ?? '') && (banner.textContent ?? '').includes(SAHIL.stages[1].name), `banner "${banner.textContent}"`);
      app.hud.update(0);
      c.expect(pips().join(',') === 'done,on evolving,', `stage 2 pips ${pips()}`);
      c.expect(plate.querySelector('.stage-name')!.textContent === SAHIL.stages[1].name, 'plate stage name did not follow');
      app.pause();
      const pause = app.menus.root.querySelector('.pause-stage')?.textContent ?? '';
      c.expect(pause.includes('Stage 2') && pause.includes(SAHIL.stages[1].name), `pause shows "${pause}"`);
      c.note(`plate="${plate.textContent?.replace(/\s+/g, ' ').trim()}" pause="${pause}"`);
    } finally {
      app.toMenu();
      game.setupEnemy(prev);
    }
  });
}
