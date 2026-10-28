import * as THREE from 'three';
import { CONFIG } from '../config';
import type { App } from '../App';
import type { AssetLoader, ModelInstance } from '../assets/AssetLoader';
import { MODELS, type ModelKey } from '../assets/manifest';
import { STAGE_COUNT, stageForHealth, stageProfile } from '../campaign/BossStages';
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

/** Bring the boss down to `fraction` of its health with one hit from the player. */
function hitTo(game: Game, fraction: number): void {
  const e = game.enemy;
  game.spells.dealDamage(e, game.player, (e.health - e.maxHealth * fraction) / game.player.damageMultiplier, e.chest(new THREE.Vector3()), 'bolt');
}

/** A stand-in GLB: one box in a group, enough for WizardVisual to treat it as a real model. */
function fakeModel(): ModelInstance {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(0.6, 2, 0.4), new THREE.MeshStandardMaterial()));
  return { root, animations: [] };
}

export function registerStageScenarios(qa: QAHarness, game: Game, app: App): void {
  const st = game.stages;

  qa.add('stages.thresholds_trigger_stage_2_and_3', (c) => {
    withBoss(c, game, SAHIL, () => {
      const e = game.enemy;
      const done = record('bossEvolve');
      c.expect(st.stage === 0 && !e.evolving, `round starts in stage ${st.stage + 1}`);
      hitTo(game, C.stageThresholds[0] + 0.02);
      c.expect(st.stage === 0, 'evolved above the first threshold');
      hitTo(game, C.stageThresholds[0] - 0.01);
      c.expect(st.stage === 1 && e.evolving, `crossing ${C.stageThresholds[0].toFixed(2)} gave stage ${st.stage + 1}, evolving=${e.evolving}`);
      const hp = e.health;
      finishEvolve(c);
      c.expect(!e.evolving && e.health === hp, 'evolving changed health (one bar across stages)');
      hitTo(game, C.stageThresholds[1] - 0.01);
      c.expect(st.stage === 2 && e.evolving, `crossing ${C.stageThresholds[1].toFixed(2)} gave stage ${st.stage + 1}`);
      finishEvolve(c);
      const seen = done();
      c.expect(seen.length === 2 && seen[0].from === 0 && seen[0].stage === 1 && seen[1].from === 1 && seen[1].stage === 2, `bossEvolve events ${JSON.stringify(seen.map((s) => [s.from, s.stage]))}`);
      c.expect(stageForHealth(1) === 0 && stageForHealth(0.5) === 1 && stageForHealth(0.2) === 2, 'stageForHealth bands');
    });
  });

  qa.add('stages.big_hit_skips_to_stage_3', (c) => {
    withBoss(c, game, SAHIL, () => {
      const done = record('bossEvolve');
      hitTo(game, C.stageThresholds[1] - 0.05);
      finishEvolve(c);
      const seen = done();
      c.expect(st.stage === 2, `big hit left the boss in stage ${st.stage + 1}`);
      c.expect(seen.length === 1 && seen[0].from === 0 && seen[0].stage === 2, `expected one transformation 1 -> 3, got ${JSON.stringify(seen.map((s) => [s.from, s.stage]))}`);
      // A killing blow is a KO, not an evolution.
      c.setup();
      const again = record('bossEvolve');
      hitTo(game, 0);
      c.expect(again().length === 0 && !game.enemy.alive && !game.enemy.evolving, 'a KO started a transformation');
    });
  });

  qa.add('stages.reset_every_round_and_boss', (c) => {
    withBoss(c, game, SAHIL, () => {
      const e = game.enemy;
      st.evolveTo(2);
      finishEvolve(c);
      c.expect(st.stage === 2, 'could not force stage 3');
      // Round start (Match.startRound -> resetArena) puts stage 1 back, instantly.
      const stages = record('bossStage');
      c.setup();
      const ev = stages();
      c.expect(st.stage === 0 && !e.evolving && st.lookScale === 1, `after a round reset: stage ${st.stage + 1}, scale ${st.lookScale}`);
      c.expect(ev.some((x) => x.wizard === e && x.stage === 0 && x.boss === SAHIL), 'no bossStage(0) event at round reset');
      c.expect(e.damageMultiplier === SAHIL.damageMultiplier * C.stageDamage[0], `stage 1 damage multiplier ${e.damageMultiplier}`);
      // Mid-transformation resets too.
      hitTo(game, 0.5);
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
    } finally {
      app.toMenu();
      game.setupEnemy(prev);
    }
  });

  qa.add('stages.transform_immune_and_frozen', (c) => {
    withBoss(c, game, SAHIL, () => {
      const e = game.enemy, p = game.player;
      hitTo(game, 0.6);
      c.expect(e.evolving && Math.abs(e.evolveTime - C.evolveTime) < 1e-6, `evolveTime ${e.evolveTime}`);
      const hp = e.health;
      // Hits register but deal nothing, with an IMMUNE popup like god mode.
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
      c.expect(e.health === hp, 'stun beam hurt a transforming boss');
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
      hitTo(game, 0.6);
      c.expect(p.knock.length() > C.evolveKnockback * 0.5, `knockback ${p.knock.length().toFixed(2)} on a player 5 m away`);
      const away = new THREE.Vector3().subVectors(p.pos, e.pos).setY(0).normalize();
      c.expect(p.knock.clone().normalize().dot(away) > 0.99, 'shockwave did not push straight away from the boss');
      const start = p.pos.distanceTo(e.pos);
      c.step(0.6);
      c.note(`pushed ${(p.pos.distanceTo(e.pos) - start).toFixed(2)} m`);
      c.expect(p.pos.distanceTo(e.pos) > start + 1, 'player was not pushed back');
      // Out of reach: no push.
      c.setup({ player: [0, -C.evolveRadius - 2], enemy: [0, 1] });
      hitTo(game, 0.6);
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
          c.expect(p.burst[0] === boss.ai.burst[0] + A.burstBonus[s] && p.burst[1] === boss.ai.burst[1] + A.burstBonus[s], `s${s + 1} burst ${p.burst}`);
          c.expect(Math.abs(p.burstPause[1] - boss.ai.burstPause[1] * A.burstPause[s]) < 1e-9, `s${s + 1} burstPause ${p.burstPause}`);
          c.expect(Math.abs(p.strafeSpeed - boss.ai.strafeSpeed * A.strafeSpeed[s]) < 1e-9, `s${s + 1} strafe ${p.strafeSpeed}`);
          c.expect(p.dodgeChance <= A.maxChance && p.dodgeChance >= boss.ai.dodgeChance, `s${s + 1} dodge ${p.dodgeChance}`);
          c.expect(ai.attacks === boss.stages[s].attacks, `s${s + 1} attacks not the stage's`);
          c.expect(Math.abs(game.enemy.damageMultiplier - boss.damageMultiplier * C.stageDamage[s]) < 1e-9, `s${s + 1} damage x${game.enemy.damageMultiplier}`);
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
                e.health = e.maxHealth * (s === 0 ? 1 : C.stageThresholds[s - 1] - 0.01); // never crosses the next threshold
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
      c.near(hp - p.health, B.damage * 0.6 * 1.5, 1e-6, 'one fan hit (x damage multiplier)');
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
      c.near(CONFIG.wizard.maxHealth - p.health, 7 * B.damage * 0.5 * e.damageMultiplier, B.damage, 'burst damage');
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

  qa.add('stages.quick_duel_has_none', (c) => {
    withBoss(c, game, null, () => {
      const e = game.enemy;
      const evolves = record('bossEvolve');
      for (const f of [0.6, 0.3, 0.05]) hitTo(game, f);
      c.step(0.5);
      st.evolveTo(2);
      c.expect(evolves().length === 0 && st.stage === 0 && !e.evolving && st.current === null, 'the default rival evolved');
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
