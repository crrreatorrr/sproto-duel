import { CONFIG } from '../config';
import type { App } from '../App';
import { BOSSES } from '../campaign/levels';
import { events, type GameEvents } from '../core/events';
import type { Game } from '../core/Game';
import { AIController } from '../enemy/AIController';
import type { QAHarness } from './QAHarness';

const L = CONFIG.lifePacks;
const TK = CONFIG.tickets;
const DT = CONFIG.sim.fixedDt;

type Ctx = Parameters<Parameters<QAHarness['add']>[1]>[0];

function record<K extends keyof GameEvents>(type: K): () => GameEvents[K][] {
  const seen: GameEvents[K][] = [];
  const off = events.on(type, (e) => void seen.push({ ...e }));
  return () => {
    off();
    return seen;
  };
}

/** Run `fn` in a live gauntlet setup against `boss` (stages running) with life packs enabled. */
function withPacks(c: Ctx, game: Game, bossIndex: number, fn: () => void): void {
  const prev = game.boss;
  game.stages.suspended = game.partnerStages.suspended = false;
  game.setupEnemy(BOSSES[bossIndex]);
  try {
    c.setup({ player: [0, -8], enemy: [0, 8] });
    game.lifePacks.reset();
    game.lifePacks.enabled = true;
    fn();
  } finally {
    game.lifePacks.enabled = false;
    game.lifePacks.reset();
    game.setupEnemy(prev);
  }
}

/**
 * Life packs: health pickups in the Boss Gauntlet (src/arena/LifePacks.ts). At most three per fight,
 * one per stage, only the player collects, the heal is capped at max health, spawn spots are valid,
 * and a new fight (Retry) starts a fresh budget. Quick Duel has none.
 */
export function registerLifePackScenarios(qa: QAHarness, game: Game, app: App): void {
  const lp = game.lifePacks;

  qa.add('lifepacks.max_three_per_fight', (c) => {
    withPacks(c, game, 0, () => {
      const st = game.stages;
      const spawns = record('lifePackSpawn');
      const expires = record('lifePackExpire');
      // Stage 1 allows one: even 20 minutes in stage 1 brings no second.
      c.step(L.firstDelay[1] + L.lifetime + 2, () => {
        game.player.health = game.player.maxHealth; // not low: only the timer makes it due
      });
      c.expect(lp.spawned === 1, `stage 1 spawned ${lp.spawned}`);
      c.step(600);
      c.expect(lp.spawned === 1 && !lp.pack.active, `stage 1 after 10 more min: spawned ${lp.spawned}`);
      // Stages 2 and 3 each bring one more; an uncollected pack still counts.
      st.evolveTo(1);
      st.release(0);
      c.step(L.firstDelay[1] + L.lifetime + 2);
      st.evolveTo(2);
      st.release(0);
      c.step(L.firstDelay[1] + L.lifetime + 2);
      c.step(900);
      const s = spawns(), x = expires();
      c.expect(lp.spawned === L.maxPerFight && s.length === L.maxPerFight, `spawned ${lp.spawned}, events ${s.length}`);
      c.expect(x.length === L.maxPerFight && lp.expired === L.maxPerFight && lp.remaining === 0, `expired ${x.length}`);
      c.expect(s[0].first && !s[1].first && s[0].left === 2 && s[2].left === 0, `first/left flags ${JSON.stringify(s.map((e) => [e.first, e.left]))}`);
      // The budget is spent: forcing one is refused too.
      c.expect(lp.spawnAt(0, 0) === null, 'a fourth pack spawned');
    });
  });

  qa.add('lifepacks.low_health_brings_it_early', (c) => {
    withPacks(c, game, 0, () => {
      const p = game.player;
      p.health = p.maxHealth * (L.lowHealth - 0.1);
      c.step(L.lowHealthDelay + 1, () => (p.health = p.maxHealth * (L.lowHealth - 0.1)));
      c.expect(lp.spawned === 1 && lp.pack.active, `low health: spawned ${lp.spawned} after ${L.lowHealthDelay + 1} s`);
      c.expect(L.lowHealthDelay + 1 < L.firstDelay[0], 'test needs lowHealthDelay below firstDelay');
    });
  });

  qa.add('lifepacks.player_only_heal_capped', (c) => {
    withPacks(c, game, 0, () => {
      const p = game.player, e = game.enemy;
      // A pack at the boss's feet: he walks over it, it stays.
      c.setup({ player: [0, -10], enemy: [0, 8] });
      lp.reset();
      lp.enabled = true;
      c.expect(lp.spawnAt(e.pos.x, e.pos.z) !== null, 'spawnAt refused');
      c.step(1, () => (e.intent.move.set(0, 0, 0)));
      c.expect(lp.pack.active && lp.collected === 0, 'the boss collected the life pack');
      // The player walks onto it: heals 40% of max.
      p.health = p.maxHealth * 0.3;
      const before = p.health;
      const picks = record('lifePackPickup');
      p.spawn(e.pos.x + 0.3, e.pos.z - 0.6, 0);
      c.step(DT * 2);
      const got = picks();
      c.expect(!lp.pack.active && lp.collected === 1 && got.length === 1 && got[0].wizard === p, `pickup ${got.length}`);
      c.near(p.health - before, p.maxHealth * L.heal, 1e-6, 'heal HP');
      c.near(got[0].healed, p.maxHealth * L.heal, 1e-6, 'event healed');
      c.expect([...game.ui.querySelectorAll('.popup')].some((el) => el.textContent === `+${Math.round(p.maxHealth * L.heal)} HP`), 'no "+HP" popup');
      // Nearly full: capped at max health.
      lp.spawnAt(p.pos.x + 0.2, p.pos.z);
      p.health = p.maxHealth - 10;
      c.step(DT * 2);
      c.expect(p.health === p.maxHealth && lp.collected === 2, `capped heal: ${p.health}/${p.maxHealth}`);
      c.expect(record('lifePackPickup')().length === 0, 'stray pickup');
    });
  });

  qa.add('lifepacks.valid_spawn_spots', (c) => {
    // Every arena: spots are inside the ring, clear of cover, lava, clouds and rails, a dash from
    // the player and away from the bosses.
    const arena = game.arena;
    const prevTheme = arena.theme, prevDev = arena.devTheme;
    const rows: string[] = [];
    try {
      for (let bi = 0; bi < BOSSES.length; bi++) {
        arena.devTheme = null;
        void arena.applyTheme(BOSSES[bi].theme);
        withPacks(c, game, bi, () => {
          const p = game.player;
          let ok = 0;
          for (let i = 0; i < 30; i++) {
            p.spawn((Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, 0);
            game.physics.step();
            lp.reset();
            if (!lp.spawn()) continue;
            const pos = lp.pack.pos;
            const dp = Math.hypot(pos.x - p.pos.x, pos.z - p.pos.z);
            c.expect(Math.hypot(pos.x, pos.z) <= arena.fireRadius - TK.fireMargin + 1e-6, `${BOSSES[bi].id}: spot outside the ring`);
            c.expect(!arena.excludesPickup(pos.x, pos.z), `${BOSSES[bi].id}: spot in lava/cloud/rail`);
            c.expect(!game.tickets.blocked(pos.x, pos.z), `${BOSSES[bi].id}: spot blocked by cover`);
            c.expect(dp >= L.playerDistance[0] - 1e-6 && dp <= L.playerDistance[1] + 1e-6, `${BOSSES[bi].id}: ${dp.toFixed(1)} m from the player`);
            for (const e of game.enemies) c.expect(Math.hypot(pos.x - e.pos.x, pos.z - e.pos.z) >= L.bossDistance - 1e-6, `${BOSSES[bi].id}: next to a boss`);
            ok++;
          }
          c.expect(ok >= 20, `${BOSSES[bi].id}: only ${ok}/30 spawns found a spot`);
          rows.push(`${BOSSES[bi].id}:${ok}/30`);
        });
      }
    } finally {
      arena.devTheme = prevDev;
      void arena.applyTheme(prevTheme);
    }
    c.note(rows.join(' '));
  });

  qa.add('lifepacks.reset_on_retry_none_in_quick_duel', (c) => {
    try {
      app.campaign.index = 2;
      app.startBossFight();
      lp.spawnAt(3, 3);
      lp.collect(game.player);
      lp.spawnAt(4, 4);
      c.expect(lp.spawned === 2, 'setup');
      // Retry (the results button and pause Restart both start the fight again).
      app.restart();
      c.expect(lp.spawned === 0 && lp.collected === 0 && !lp.pack.active && lp.remaining === L.maxPerFight, `after Retry: spawned ${lp.spawned}, active ${lp.pack.active}`);
      app.hud.update(0);
      const icons = [...app.hud.root.querySelectorAll('.life-packs i')];
      c.expect(app.hud.root.querySelector('.life-packs.on') !== null && icons.length === L.maxPerFight && icons.every((i) => i.className === ''), `HUD packs ${icons.map((i) => i.className)}`);
      // The fight phase enables them in the gauntlet, never in Quick Duel.
      const m = app.match;
      m.phase = 'fight';
      game.qaMode = false;
      try {
        c.step(DT);
        c.expect(lp.enabled, 'life packs not enabled in a gauntlet fight');
        app.startMatch();
        m.phase = 'fight';
        c.step(DT);
        c.expect(!lp.enabled && !CONFIG.lifePacks.quickDuel, 'life packs enabled in Quick Duel');
        app.hud.update(0);
        c.expect(app.hud.root.querySelector('.life-packs.on') === null, 'Quick Duel HUD shows life packs');
      } finally {
        game.qaMode = true;
      }
    } finally {
      app.toMenu();
    }
  });

  qa.add('lifepacks.reference_ai_collects', (c) => {
    // The soak's reference AI (driving the player) goes for a pack when hurt; a boss's AI never does.
    withPacks(c, game, 0, () => {
      const p = game.player, e = game.enemy;
      const ref = new AIController(p, e, game.spells, game.physics, game.arena);
      const boss = new AIController(e, p, game.spells, game.physics, game.arena);
      try {
        ref.lifePacks = lp;
        p.health = p.maxHealth * 0.4;
        c.expect(lp.spawnAt(p.pos.x + 9, p.pos.z - 1) !== null, 'spawnAt refused');
        c.expect(lp.bestFor(p, L.aiSeekRange) === lp.pack, 'bestFor does not see the pack');
        c.step(6, () => {
          ref.update(DT);
          boss.update(DT);
          e.health = e.maxHealth;
        });
        c.expect(lp.collected === 1, `reference AI did not collect the pack (player at ${p.pos.x.toFixed(1)}, ${p.pos.z.toFixed(1)})`);
        // A boss's AI has no life packs: it ignores one at its feet.
        c.expect(boss.lifePacks === null, 'boss AI has life packs');
      } finally {
        ref.dispose();
        boss.dispose();
      }
    });
  });
}
