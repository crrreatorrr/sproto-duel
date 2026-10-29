import { CONFIG } from '../config';
import { BOSSES, type BossDef } from '../campaign/levels';
import { events, type GameEvents } from '../core/events';
import type { Game } from '../core/Game';
import { AIController } from '../enemy/AIController';
import type { ShiftFeature } from '../arena/ArenaShifts';
import { withSeededRandom } from './campaignScenarios';
import type { QAHarness } from './QAHarness';

const DT = CONFIG.sim.fixedDt;
const S = CONFIG.arenaShifts;
const A = CONFIG.arena;

type Ctx = Parameters<Parameters<QAHarness['add']>[1]>[0];

function record<K extends keyof GameEvents>(type: K): GameEvents[K][] & { off: () => void } {
  const seen = [] as unknown as GameEvents[K][] & { off: () => void };
  seen.off = events.on(type, (e) => void seen.push({ ...e }));
  return seen;
}

const byId = (id: string): BossDef => BOSSES.find((b) => b.id === id)!;

/**
 * Run `fn` in a fight against `boss` with its stages live; `stage` 1 or 2 puts that stage's shift
 * in place through a real transformation (released at once) and lets its features grow in.
 * Seeded, so the layout of the features is the same every run.
 */
function withShift(c: Ctx, game: Game, boss: BossDef, stage: number, fn: () => void): void {
  const prev = game.boss;
  game.stages.suspended = game.partnerStages.suspended = false;
  game.setupEnemy(boss);
  try {
    withSeededRandom(4242, () => {
      c.setup({ player: [0, -6], enemy: [0, 6], partner: [6, 6] });
      for (let s = 1; s <= stage; s++) {
        game.stages.evolveTo(s);
        game.stages.release(0);
        c.step(DT * 2);
      }
      if (stage > 0) c.step(S.growTime + 0.05);
      fn();
    });
  } finally {
    game.setupEnemy(prev);
    c.setup();
  }
}

/** Stand `w` on (x, z), still. */
function standAt(game: Game, x: number, z: number, who = game.player): void {
  who.spawn(x, z, 0);
  who.vel.set(0, 0, 0);
  who.knock.set(0, 0, 0);
}

/** Damage `kind` the player took in `seen`. */
const taken = (seen: GameEvents['damage'][], game: Game, kinds: string[]) =>
  seen.filter((d) => d.target === game.player && kinds.includes(d.kind) && d.amount > 0).reduce((s, d) => s + d.amount, 0);

/**
 * Arena shifts (src/arena/ArenaShifts.ts): every boss's arena changes at stages 2 and 3, in its own
 * theme: pools that burn (quicksand also slows), a spring that heals, vents that warn and erupt,
 * the fire ring pulling in. Each waits for the transformation, fades in harmless, sits on open
 * floor, hurts boss and player alike, and is gone the next round; the AI keeps out of the pools and
 * vents and the reference AI drinks from the spring.
 */
export function registerArenaShiftScenarios(qa: QAHarness, game: Game): void {
  qa.add('shifts.every_boss_reshapes_its_arena', (c) => {
    const rows: string[] = [];
    for (const boss of BOSSES) {
      withShift(c, game, boss, 0, () => {
        const shifts = record('arenaShift');
        try {
          c.expect(game.shifts.features.length === 0 && game.arena.ringCap === A.fireRadius, `${boss.name}: arena shifted before any stage`);
          game.stages.evolveTo(1);
          game.stages.release(0);
          c.step(DT * 2);
          const pools = game.shifts.of('pool'), springs = game.shifts.of('spring');
          c.expect(game.shifts.stage === 1 && shifts.length === 1 && shifts[0].shift === boss.shift, `${boss.name}: stage 2 brought no shift`);
          c.expect(pools.length >= 2 && springs.length === 1 && game.shifts.of('vent').length === 0, `${boss.name}: stage 2 grew ${pools.length} pools, ${springs.length} springs`);
          c.step(S.growTime + 3);
          c.near(game.arena.ringCap, S.ringRadius[1], 0.01, `${boss.name}: stage 2 ring`);
          game.stages.evolveTo(2);
          game.stages.release(0);
          c.step(DT * 2);
          const vents = game.shifts.of('vent');
          c.expect(game.shifts.stage === 2 && shifts.length === 2 && vents.length >= 2, `${boss.name}: stage 3 grew ${vents.length} vents`);
          // Everything on open floor: inside the final ring, off the spawn lane, clear of cover and of each other.
          const all = game.shifts.features;
          for (const f of all) {
            c.expect(Math.hypot(f.x, f.z) + f.radius <= S.ringRadius[2] - S.ringMargin + 1e-6, `${boss.name}: ${f.kind} at (${f.x.toFixed(1)}, ${f.z.toFixed(1)}) reaches the closing fire`);
            c.expect(Math.abs(f.x) >= f.radius + 2 || Math.abs(f.z) >= A.spawnDistance / 2 + f.radius + 2, `${boss.name}: ${f.kind} on the spawn lane`);
            for (const p of game.arena.pillars) c.expect(p.surfaceDistance(f.x, f.z) >= f.radius + S.coverClearance - 1e-6, `${boss.name}: ${f.kind} under cover`);
            for (const o of all) if (o !== f) c.expect(Math.hypot(o.x - f.x, o.z - f.z) >= o.radius + f.radius + S.spacing - 1e-6, `${boss.name}: two features overlap`);
          }
          c.expect(game.arena.shiftHazards.length === all.filter((f) => f.kind !== 'spring').length, `${boss.name}: pools and vents not kept out for the AI`);
          c.step(4);
          c.near(game.arena.ringCap, S.ringRadius[2], 0.01, `${boss.name}: stage 3 ring`);
          c.expect(game.arena.fireRadius <= S.ringRadius[2] + 1e-6 || !game.stages.active, `${boss.name}: fire ring ${game.arena.fireRadius.toFixed(1)} m, not pulled in`);
          rows.push(`${boss.name} ${pools.length}p/${springs.length}s/${vents.length}v`);
        } finally {
          shifts.off();
        }
      });
    }
    c.note(rows.join(' | '));
  });

  qa.add('shifts.waits_for_the_transformation_and_fades_in', (c) => {
    withShift(c, game, byId('broccoli'), 0, () => {
      game.stages.evolveTo(1);
      c.step(0.5);
      c.expect(game.enemy.evolving && game.shifts.stage === 0, 'the arena shifted mid-transformation');
      game.stages.release(0);
      c.step(DT * 2);
      c.expect(game.shifts.stage === 1, 'no shift once the transformation ended');
      // Fading in: standing in a new pool does nothing yet.
      const pool = game.shifts.of('pool')[0];
      const seen = record('damage');
      try {
        c.step(S.growTime - 0.2, () => {
          standAt(game, pool.x, pool.z);
          game.player.health = game.player.maxHealth;
        });
        c.expect(taken(seen, game, ['pool', 'fire']) === 0, 'a pool burned while fading in');
      } finally {
        seen.off();
      }
    });
  });

  qa.add('shifts.pools_burn_quicksand_slows_flyers_and_riders_spared', (c) => {
    // Broccoli's runoff burns at its dps; Sahil's quicksand slows to half; up in the air, on the
    // carpet, or flying, nothing happens; the boss burns as well.
    withShift(c, game, byId('broccoli'), 1, () => {
      const pool = game.shifts.of('pool')[0];
      const p = game.player;
      const seen = record('damage');
      try {
        standAt(game, pool.x, pool.z);
        c.step(2, () => { p.intent.move.set(0, 0, 0); });
        c.near(taken(seen, game, ['pool']), byId('broccoli').shift.pools.dps * 2, 3, 'runoff damage over 2 s');
        // The boss burns in it too.
        seen.length = 0;
        standAt(game, pool.x, pool.z, game.enemy);
        standAt(game, 0, 0); // the middle of the spawn lane: never under a feature
        c.step(1);
        c.expect(seen.some((d) => d.target === game.enemy && d.kind === 'pool'), 'the boss did not burn in the pool');
        // Airborne: no burn.
        seen.length = 0;
        standAt(game, pool.x, pool.z);
        c.step(1, () => {
          p.pos.y = 1.2;
          p.health = p.maxHealth;
        });
        c.expect(taken(seen, game, ['pool']) === 0, 'burned in the air above a pool');
        // On the Magic Carpet, or a flyer (The Midget's last stage): the pool is no floor of theirs.
        standAt(game, pool.x, pool.z);
        p.carpetTime = 1;
        c.expect(game.shifts.poolAt(p) === null, 'a pool burns a carpet rider');
        p.carpetTime = 0;
        p.flyHeight = 1.7;
        c.expect(game.shifts.poolAt(p) === null, 'a pool burns a flyer');
        p.flyHeight = 0;
        c.expect(game.shifts.poolAt(p) === pool, 'standing in the pool does not count');
      } finally {
        seen.off();
      }
    });
    withShift(c, game, byId('sahil'), 1, () => {
      const pool = game.shifts.of('pool')[0];
      const p = game.player;
      game.playerControl = false;
      try {
        // Run through: the speed while in the quicksand.
        standAt(game, pool.x, pool.z);
        let speed = 0;
        standAt(game, pool.x - pool.radius + 0.4, pool.z);
        c.step(0.6, () => {
          p.intent.move.set(1, 0, 0);
          p.intent.sprint = false;
          if (Math.hypot(p.pos.x - pool.x, p.pos.z - pool.z) < pool.radius - 0.2) speed = Math.max(speed, Math.hypot(p.vel.x, p.vel.z));
        });
        c.near(speed, CONFIG.wizard.moveSpeed * byId('sahil').shift.pools.slow!, 0.15, 'top speed in quicksand');
        c.expect(p.groundSlow < 1, 'quicksand does not slow');
        standAt(game, 0, 0); // the middle of the spawn lane: never under a feature
        c.step(DT * 2);
        c.expect(p.groundSlow === 1, 'still slowed out of the quicksand');
      } finally {
        game.playerControl = true;
      }
    });
  });

  qa.add('shifts.spring_heals_until_dry_next_stage_refills', (c) => {
    withShift(c, game, byId('agent'), 1, () => {
      const spring = game.shifts.of('spring')[0];
      const p = game.player;
      const heals = record('springHeal');
      try {
        p.health = p.maxHealth * 0.3;
        const before = p.health;
        standAt(game, spring.x, spring.z);
        c.step(2, () => p.intent.move.set(0, 0, 0));
        c.near(p.health - before, S.spring.heal * 2, 1.5, 'healed over 2 s');
        c.expect(heals.length >= 1 && heals.every((h) => h.wizard === p), 'no heal shown');
        // Drink it dry: it stops at its charge and stays dry.
        c.step(S.spring.charge / S.spring.heal + 1, () => p.intent.move.set(0, 0, 0));
        c.near(p.health - before, S.spring.charge, 0.6, 'healed in all (one fill)');
        c.expect(spring.charge === 0, 'spring not dry');
        const dry = p.health;
        c.step(20, () => p.intent.move.set(0, 0, 0));
        c.expect(p.health === dry && spring.charge === 0, 'a dry spring healed or refilled within its stage');
        // The next stage fills it again.
        standAt(game, 0, 0);
        game.stages.evolveTo(2);
        game.stages.release(0);
        c.step(DT * 2);
        c.expect(spring.charge === S.spring.charge, 'stage 3 did not refill the spring');
        // Full health: it keeps its charge.
        p.health = p.maxHealth;
        c.step(1);
        c.expect(spring.charge === S.spring.charge, 'spring drained by a healthy wizard');
      } finally {
        heals.off();
      }
    });
  });

  qa.add('shifts.vents_warn_erupt_shove_and_a_roll_slips_through', (c) => {
    const boss = byId('tinubu');
    withShift(c, game, boss, 2, () => {
      const vent = game.shifts.of('vent')[0];
      const p = game.player;
      const warns = record('ventWarn'), erupts = record('ventErupt'), seen = record('damage');
      try {
        // Only this vent: the others wait.
        for (const v of game.shifts.of('vent')) if (v !== vent) v.clock = -100;
        vent.clock = vent.period - S.vent.warn - 0.3;
        standAt(game, vent.x, vent.z);
        let warnAt = -1, hitAt = -1, t = 0;
        c.step(S.vent.warn + 1.2, () => {
          t += DT;
          if (warnAt < 0 && warns.length) warnAt = t;
          if (hitAt < 0 && taken(seen, game, ['vent']) > 0) hitAt = t;
          if (hitAt < 0) {
            p.intent.move.set(0, 0, 0);
            p.spawn(vent.x, vent.z, 0);
          }
        });
        c.expect(warnAt >= 0 && hitAt >= 0, `warn ${warnAt.toFixed(2)} s, hit ${hitAt.toFixed(2)} s`);
        c.expect(hitAt - warnAt >= S.vent.warn - 0.05, `only ${(hitAt - warnAt).toFixed(2)} s of warning`);
        c.near(taken(seen, game, ['vent']), boss.shift.vents.damage, 0.01, 'vent damage');
        c.expect(erupts.length === 1, `${erupts.length} eruptions`);
        c.expect(Math.hypot(p.pos.x - vent.x, p.pos.z - vent.z) > vent.radius, 'not thrown out of the vent');
        // A roll's i-frames slip through the next one.
        seen.length = 0;
        vent.clock = vent.period - 0.05;
        standAt(game, vent.x, vent.z);
        p.iframes = 0.3;
        c.step(0.15);
        c.expect(taken(seen, game, ['vent']) === 0, 'a roll did not slip through the eruption');
      } finally {
        warns.off();
        erupts.off();
        seen.off();
      }
    });
  });

  qa.add('shifts.cleared_every_round_never_in_quick_duel', (c) => {
    withShift(c, game, byId('obama'), 2, () => {
      c.expect(game.shifts.features.length > 0, 'nothing shifted');
      c.setup({ player: [0, -6], enemy: [0, 6] });
      c.expect(game.shifts.features.length === 0 && game.shifts.stage === 0, 'features survived the round');
      c.expect(game.arena.shiftHazards.length === 0 && game.arena.ringCap === A.fireRadius, 'kept-out floor or ring survived the round');
      c.expect(game.renderer.scene.children.every((o) => !o.name.startsWith('shift:') || !o.visible), 'feature decals left showing');
    });
    // Quick Duel: no boss, no shift whatever the stage counters say.
    game.setupEnemy(null);
    c.setup();
    game.shifts.applyStage(2);
    c.step(1);
    c.expect(game.shifts.features.length === 0, 'Quick Duel arena shifted');
  });

  qa.add('shifts.double_fight_follows_the_furthest_boss', (c) => {
    withShift(c, game, byId('obama'), 0, () => {
      // Only The Midget changes stage: the arena still shifts.
      game.partnerStages.evolveTo(1);
      game.partnerStages.release(0);
      c.step(DT * 2);
      c.expect(game.shifts.stage === 1, `partner at stage 2, arena at shift ${game.shifts.stage}`);
      game.stages.evolveTo(1);
      game.stages.release(0);
      c.step(DT * 2);
      c.expect(game.shifts.stage === 1 && game.shifts.of('spring').length === 1, 'the second boss reaching stage 2 shifted again');
    });
  });

  qa.add('shifts.ai_keeps_out_and_reference_drinks', (c) => {
    // A boss's AI chasing the player across a shifted arena keeps its feet out of the pools and
    // vents; the soak's reference AI, hurt, walks to the spring and drinks.
    withShift(c, game, byId('broccoli'), 2, () => {
      const p = game.player, e = game.enemy;
      const bossAI = new AIController(e, p, game.spells, game.physics, game.arena);
      const ref = new AIController(p, e, game.spells, game.physics, game.arena);
      try {
        const inside = (f: ShiftFeature, x: number, z: number) => Math.hypot(x - f.x, z - f.z) < f.radius;
        let bossIn = 0;
        // The player sits in a pool's far side; the boss comes for it.
        const pool = game.shifts.of('pool')[0];
        c.step(8, () => {
          bossAI.update(DT);
          p.health = p.maxHealth;
          e.health = e.maxHealth;
          for (const f of game.shifts.features) if (f.kind !== 'spring' && f.age >= S.growTime && inside(f, e.pos.x, e.pos.z)) bossIn += DT;
          standAt(game, pool.x + pool.radius + 1.5, pool.z);
        });
        c.expect(bossIn < 0.5, `boss AI stood ${bossIn.toFixed(2)} s in pools and vents`);
        ref.shifts = game.shifts;
        p.health = p.maxHealth * 0.35;
        const spring = game.shifts.of('spring')[0];
        standAt(game, spring.x + (spring.x > 0 ? -7 : 7), spring.z);
        const before = p.health;
        c.step(8, () => {
          ref.update(DT);
          e.health = e.maxHealth;
          e.intent.clear();
        });
        c.expect(p.health > before + 10, `reference AI did not drink (health ${before.toFixed(0)} -> ${p.health.toFixed(0)}, at ${p.pos.x.toFixed(1)}, ${p.pos.z.toFixed(1)})`);
      } finally {
        bossAI.dispose();
        ref.dispose();
      }
    });
  });
}
