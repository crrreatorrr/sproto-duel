import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG } from '../config';
import type { App } from '../App';
import type { GoldenTicket } from '../arena/GoldenTickets';
import { MODELS } from '../assets/manifest';
import { events } from '../core/events';
import type { Game } from '../core/Game';
import { AIController } from '../enemy/AIController';
import { GROUP } from '../physics/Physics';
import { Wizard } from '../wizard/Wizard';
import { WizardVisual } from '../wizard/WizardVisual';
import { withSeededRandom } from './campaignScenarios';
import type { QAHarness } from './QAHarness';

const DT = CONFIG.sim.fixedDt;
const T = CONFIG.tickets;
const W = CONFIG.wizard;
const P = CONFIG.arena.pillars;

type Ctx = Parameters<Parameters<QAHarness['add']>[1]>[0];

/**
 * Independent check of a spawn spot (not via GoldenTickets.isValidSpot): '' if fine, else why not.
 * `extra` is an additional obstacle test (e.g. distance to a test box).
 */
function spotProblem(game: Game, x: number, z: number, extra?: (x: number, z: number) => string): string {
  const r = Math.hypot(x, z);
  const limit = game.arena.fireRadius - T.fireMargin;
  if (r > limit + 1e-6) return `(${x.toFixed(1)}, ${z.toFixed(1)}) r=${r.toFixed(2)} outside ${limit.toFixed(2)}`;
  for (const w of game.wizards) {
    const d = Math.hypot(w.pos.x - x, w.pos.z - z);
    if (d < T.minWizardDistance) return `(${x.toFixed(1)}, ${z.toFixed(1)}) ${d.toFixed(2)} m from ${w.name}`;
  }
  for (const p of game.arena.pillars) {
    const d = Math.hypot(p.position.x - x, p.position.z - z);
    const solid = p.alive ? P.radius : P.radius * 1.15;
    if (d < solid + T.obstacleClearance - 0.02) return `(${x.toFixed(1)}, ${z.toFixed(1)}) ${d.toFixed(2)} m from a ${p.alive ? 'pillar' : 'stump'}`;
  }
  return extra?.(x, z) ?? '';
}

/** Feed a fixed-tick Match update by hand (QA mode keeps tick hooks out of `game.tick`). */
type MatchInternals = { update(dt: number): void };

export function registerTicketScenarios(qa: QAHarness, game: Game, app: App): void {
  const tk = game.tickets;

  qa.add('tickets.max_three_and_valid_spots_in_long_fight', (c) => {
    // Five minutes of AI-vs-AI with the round's fire ring cycle (sudden death shrinks it), health
    // topped up so nobody dies. Every spawn is checked; the count never exceeds the cap.
    withSeededRandom(4242, () => {
      c.setup({ player: [0, -8], enemy: [0, 8] });
      const a = new AIController(c.player, c.enemy, game.spells, game.physics, game.arena);
      const b = new AIController(c.enemy, c.player, game.spells, game.physics, game.arena);
      a.tickets = b.tickets = tk;
      let maxActive = 0, spawns = 0, expired = 0, t = 0;
      const picks = [0, 0];
      const bad: string[] = [];
      const offs = [
        events.on('ticketSpawn', (e) => {
          spawns++;
          const why = spotProblem(game, e.pos.x, e.pos.z);
          if (why) bad.push(why);
        }),
        events.on('ticketPickup', (e) => picks[e.wizard.index]++),
        events.on('ticketExpire', () => expired++),
      ];
      tk.enabled = true;
      try {
        c.step(300, () => {
          t += DT;
          const left = CONFIG.match.roundTime - (t % CONFIG.match.roundTime);
          const A = CONFIG.arena;
          game.arena.fireRadius = left < A.suddenDeathAt ? A.suddenDeathMinRadius + (A.fireRadius - A.suddenDeathMinRadius) * (left / A.suddenDeathAt) : A.fireRadius;
          a.update(DT);
          b.update(DT);
          for (const w of game.wizards) w.health = w.maxHealth;
          maxActive = Math.max(maxActive, tk.activeCount);
        });
      } finally {
        offs.forEach((off) => off());
        a.dispose();
        b.dispose();
        tk.enabled = false;
      }
      c.expect(maxActive <= T.maxActive, `${maxActive} tickets at once (max ${T.maxActive})`);
      c.expect(spawns >= 20, `only ${spawns} tickets in 300 s`);
      c.expect(bad.length === 0, `invalid spawn spots: ${bad.slice(0, 4).join('; ')}`);
      c.expect(picks[0] + picks[1] > 0, 'nobody ever picked a ticket up');
      c.note(`spawned ${spawns}, peak ${maxActive}, picked ${picks[0]}/${picks[1]}, expired ${expired}`);
    });
  });

  qa.add('tickets.cap_holds_when_nobody_collects', (c) => {
    // Idle wizards and very long lifetimes: the timer keeps trying, the pool stops at maxActive.
    c.setup({ player: [0, -20], enemy: [0, 20] });
    const life = T.lifetime;
    T.lifetime = 1e6;
    let spawns = 0;
    const off = events.on('ticketSpawn', () => spawns++);
    tk.enabled = true;
    try {
      c.step(90);
      c.expect(tk.activeCount === T.maxActive, `${tk.activeCount} on the floor after 90 s, expected ${T.maxActive}`);
      c.expect(spawns === T.maxActive, `${spawns} spawns, expected ${T.maxActive}`);
      c.expect(!tk.spawn() || tk.activeCount <= T.maxActive, 'spawn() went over the cap');
      c.expect(tk.spawnAt(0, 0) === null, 'spawnAt() went over the cap');
    } finally {
      off();
      T.lifetime = life;
      tk.enabled = false;
    }
  });

  qa.add('tickets.only_during_fight_cleared_on_reset', (c) => {
    // Drive the real Match flow by hand: intro/countdown, fight, KO, round end, next round.
    const m = app.match;
    const mu = m as unknown as MatchInternals;
    const saved = { phase: m.phase, round: m.round, timer: m.timer, phaseTime: m.phaseTime, boss: m.boss, wins: [...m.wins], winners: [...m.roundWinners], last: m.lastWinner };
    const tick = () => {
      game.tick(DT);
      mu.update(DT);
    };
    try {
      c.setup();
      m.boss = null;
      m.round = 1;
      m.wins[0] = m.wins[1] = 0;
      m.startRound();
      const firstTimer = tk.spawnTimer;
      let introTicks = 0;
      while (m.phase === 'intro' && introTicks < 600) {
        tick();
        introTicks++;
        c.expect(tk.activeCount === 0, `a ticket appeared during the intro/countdown (tick ${introTicks})`);
      }
      c.expect(m.phase === 'fight', `phase ${m.phase} after the intro`);
      c.expect(tk.spawnTimer === firstTimer, 'the spawn clock ran during the intro/countdown');
      let fightTime = 0;
      while (tk.activeCount === 0 && fightTime < 20) {
        tick();
        fightTime += DT;
      }
      c.expect(tk.activeCount > 0, 'no ticket in the first 20 s of the fight');
      c.note(`first ticket ${fightTime.toFixed(1)} s into the fight`);
      // Let a second one come, give the player a boost, then KO the rival.
      for (let i = 0; i < 60 * 14; i++) tick();
      const onFloor = tk.activeCount;
      game.player.manaBoost = 10;
      game.qaMode = false; // the Match only ends rounds on a KO outside QA mode
      try {
        game.spells.dealDamage(game.enemy, game.player, 1e4, game.enemy.pos, 'bolt');
      } finally {
        game.qaMode = true;
      }
      mu.update(0); // the rest of the KO tick: the Match hook runs after gameplay
      c.expect(m.phase === 'roundEnd', `phase ${m.phase} after the KO`);
      tk.spawnTimer = 0;
      const ages = tk.pool.filter((t) => t.active).map((t) => t.age);
      tick();
      c.expect(tk.activeCount <= onFloor, 'a ticket spawned during the round end');
      c.expect(tk.pool.filter((t) => t.active).every((t, i) => t.age === ages[i]), 'tickets kept ageing during the round end');
      let guard = 0;
      while (m.phase === 'roundEnd' && guard++ < 600) tick();
      c.expect(m.phase === 'intro' && m.round === 2, `expected round 2 intro, got ${m.phase} round ${m.round}`);
      c.expect(tk.activeCount === 0, `${tk.activeCount} tickets survived the round reset`);
      c.expect(tk.pool.every((t) => !t.root.visible), 'a ticket mesh is still visible after the reset');
      c.expect(game.player.manaBoost === 0 && game.player.mana === W.maxMana, `boost not cleared on reset (${game.player.manaBoost}, mana ${game.player.mana})`);
      c.note(`${onFloor} on the floor at the KO`);
    } finally {
      Object.assign(m, { phase: saved.phase, round: saved.round, timer: saved.timer, phaseTime: saved.phaseTime, boss: saved.boss, roundWinners: saved.winners, lastWinner: saved.last });
      m.wins[0] = saved.wins[0];
      m.wins[1] = saved.wins[1];
      tk.enabled = false;
    }
  });

  qa.add('tickets.spawn_spots_avoid_obstacles', (c) => {
    c.setup({ player: [0, -16], enemy: [0, 16] });
    // Physics query sanity: open floor, pillars, their clearance ring.
    c.expect(!tk.blocked(0, 0), 'the arena centre counts as blocked');
    for (const p of game.arena.pillars) {
      const out = new THREE.Vector3(p.position.x, 0, p.position.z).normalize();
      const at = (d: number) => tk.blocked(p.position.x + out.x * d, p.position.z + out.z * d);
      c.expect(at(0), 'a pillar centre is not blocked');
      c.expect(at(P.radius + T.obstacleClearance - 0.3), 'inside a pillar\'s clearance is not blocked');
      c.expect(!at(P.radius + T.obstacleClearance + 0.3), 'just outside a pillar\'s clearance is blocked');
    }
    // A box-shaped obstacle (like a cubicle wall), rotated, and a crumbled pillar's stump.
    const box = { x: 4, z: 3, hx: 2.2, hz: 0.3, yaw: 0.6 };
    const body = game.physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(box.x, 1.5, box.z)
      .setRotation({ x: 0, y: Math.sin(box.yaw / 2), z: 0, w: Math.cos(box.yaw / 2) }));
    game.physics.world.createCollider(RAPIER.ColliderDesc.cuboid(box.hx, 1.5, box.hz)
      .setCollisionGroups(((GROUP.WORLD & 0xffff) << 16) | 0xffff), body);
    const stump = game.arena.pillars[0];
    stump.damage(1e4, stump.position);
    game.physics.step();
    const boxGap = (x: number, z: number) => {
      // Distance from (x, z) to the rotated rectangle.
      const dx = x - box.x, dz = z - box.z;
      const c0 = Math.cos(box.yaw), s0 = Math.sin(box.yaw);
      const lx = c0 * dx - s0 * dz, lz = s0 * dx + c0 * dz;
      const ex = Math.max(0, Math.abs(lx) - box.hx), ez = Math.max(0, Math.abs(lz) - box.hz);
      const d = Math.hypot(ex, ez);
      return d < T.obstacleClearance - 0.02 ? `(${x.toFixed(1)}, ${z.toFixed(1)}) ${d.toFixed(2)} m from the box` : '';
    };
    try {
      c.expect(tk.blocked(box.x, box.z), 'the box obstacle is not blocked');
      c.expect(tk.blocked(stump.position.x, stump.position.z), 'a stump is not blocked');
      const bad: string[] = [];
      let made = 0;
      for (const [radius, tries] of [[CONFIG.arena.fireRadius, 300], [14, 120], [9, 80]] as const) {
        game.arena.fireRadius = radius;
        for (let i = 0; i < tries; i++) {
          tk.clear();
          if (!tk.spawn()) continue;
          made++;
          const t = tk.pool.find((p) => p.active)!;
          const why = spotProblem(game, t.pos.x, t.pos.z, boxGap);
          if (why) bad.push(`ring ${radius}: ${why}`);
        }
      }
      c.expect(bad.length === 0, `bad spots: ${bad.slice(0, 4).join('; ')}`);
      c.expect(made > 450, `only ${made}/500 spawns found a spot`);
      // Wizards in the middle of a tiny ring: no spot is far enough from both, so nothing spawns.
      game.arena.fireRadius = 6;
      c.player.spawn(0, -0.5, 0);
      c.enemy.spawn(0, 0.5, 0);
      tk.clear();
      c.expect(!tk.spawn(), 'spawned within 4 m of a wizard in a 3 m ring');
      c.note(`${made} spawns checked`);
    } finally {
      game.physics.world.removeRigidBody(body);
      game.arena.fireRadius = CONFIG.arena.fireRadius;
      tk.clear();
    }
  });

  qa.add('tickets.pickup_by_player_and_enemy', (c) => {
    c.setup({ player: [-6, 0], enemy: [6, 0] });
    tk.enabled = true;
    const got: { who: Wizard; mana: number; max: number; airborne: boolean }[] = [];
    const off = events.on('ticketPickup', (e) => got.push({ who: e.wizard, mana: e.wizard.mana, max: e.wizard.maxMana, airborne: !e.wizard.grounded }));
    try {
      // Too far to touch, and nothing while the fight is off.
      const near = tk.spawnAt(-6 + T.pickupRadius + 0.3, 0)!;
      c.step(0.3);
      c.expect(near.active, 'collected from beyond the pickup radius');
      tk.enabled = false;
      const off2 = tk.spawnAt(-6, 0.5)!;
      c.step(0.2);
      c.expect(off2.active && got.length === 0, 'collected while tickets were disabled');
      tk.clear();
      tk.enabled = true;

      c.player.mana = 20;
      tk.spawnAt(-6, 3);
      c.step(1.2, () => c.player.intent.move.set(0, 0, 1));
      c.player.intent.move.set(0, 0, 0);
      c.expect(got.length === 1 && got[0].who === c.player, 'the player did not collect the ticket in front of them');
      c.near(got[0].mana, W.maxMana * T.maxManaMultiplier, 1e-6, 'player mana at pickup');

      tk.spawnAt(6, -3);
      c.step(1.2, () => c.enemy.intent.move.set(0, 0, -1));
      c.enemy.intent.move.set(0, 0, 0);
      c.expect(got.length === 2 && got[1].who === c.enemy, 'the enemy did not collect the ticket in front of it');
      c.expect(c.enemy.manaBoost > 0 && c.enemy.maxMana === W.maxMana * T.maxManaMultiplier, 'the enemy got no boost');

      // Mid-jump (feet ~1.4 m up at the apex) still collects.
      c.step(0.5);
      c.player.intent.press('jump');
      c.step(CONFIG.wizard.jump.velocity / CONFIG.wizard.jump.gravity);
      c.expect(!c.player.grounded && c.player.pos.y > 1, `jump apex ${c.player.pos.y.toFixed(2)} m`);
      tk.spawnAt(c.player.pos.x, c.player.pos.z);
      c.step(DT * 2);
      c.expect(got.length === 3 && got[2].who === c.player && got[2].airborne, 'a ticket under a jumping wizard was not collected');
    } finally {
      off();
      tk.enabled = false;
    }
  });

  qa.add('tickets.boost_raises_max_regen_and_ends', (c) => {
    c.setup({ player: [-10, 0], enemy: [10, 0] });
    const p = c.player;
    const ends: Wizard[] = [];
    const off = events.on('manaBoostEnd', (e) => ends.push(e.wizard));
    let refreshed: boolean | null = null;
    const off2 = events.on('ticketPickup', (e) => (refreshed = e.refreshed));
    try {
      // Normal regen (with its delay) for reference.
      p.mana = 50;
      p.spendMana(10);
      c.step(1);
      c.near(p.mana, 40 + W.manaRegen * (1 - W.manaRegenDelay), 0.4, 'normal regen 1s');

      p.mana = 30;
      tk.collect(tk.spawnAt(-10, 6)!, p);
      c.expect(refreshed === false, 'first pickup flagged as a refresh');
      c.near(p.maxMana, W.maxMana * T.maxManaMultiplier, 1e-6, 'boosted max');
      c.near(p.mana, p.maxMana, 1e-6, 'refilled mana');
      // Doubled regen with no delay right after spending.
      p.mana = 50;
      p.spendMana(10);
      c.step(1);
      c.near(p.mana, 40 + W.manaRegen * T.regenMultiplier, 0.4, 'boosted regen 1s');
      // Re-pickup refreshes to the full duration without stacking.
      c.step(9);
      c.near(p.manaBoost, T.boostDuration - 10, 0.05, 'boost left after 10 s');
      tk.collect(tk.spawnAt(-10, 6)!, p);
      c.expect(refreshed === true, 'second pickup not flagged as a refresh');
      c.near(p.manaBoost, T.boostDuration, 1e-6, 'refreshed boost');
      c.near(p.maxMana, W.maxMana * T.maxManaMultiplier, 1e-6, 'max after a second ticket (no stacking)');
      // Runs out after the full duration and clamps mana back to the normal max.
      let t = 0;
      c.step(T.boostDuration + 0.5, () => {
        if (p.manaBoost > 0) {
          t += DT;
          p.mana = p.maxMana;
        }
      });
      c.near(t, T.boostDuration, DT * 1.5, 'boost duration');
      c.expect(ends.length === 1 && ends[0] === p, `manaBoostEnd fired ${ends.length} times`);
      c.near(p.mana, W.maxMana, 1e-6, 'mana after the boost');
      c.near(p.maxMana, W.maxMana, 1e-6, 'max after the boost');
      // God mode's unlimited mana keeps the (bigger) bar full while boosted.
      p.infiniteMana = true;
      tk.collect(tk.spawnAt(-10, 6)!, p);
      c.step(1, () => {
        p.intent.holdBolt = true;
        c.aimAt(p, c.enemy);
      });
      p.intent.holdBolt = false;
      c.expect(p.stats.casts > 3, 'god mode stopped casting');
      c.near(p.mana, W.maxMana * T.maxManaMultiplier, 1e-6, 'god mode mana while boosted');
      c.step(T.boostDuration);
      c.near(p.mana, W.maxMana, 1e-6, 'god mode mana after the boost');
    } finally {
      off();
      off2();
      p.infiniteMana = false;
    }
  });

  qa.add('tickets.despawn_after_lifetime', (c) => {
    c.setup({ player: [0, -12], enemy: [0, 12] });
    const gone: { id: number; reason: string; at: number }[] = [];
    let time = 0;
    const off = events.on('ticketExpire', (e) => gone.push({ id: e.id, reason: e.reason, at: time }));
    try {
      // Frozen while tickets are disabled (round end).
      const frozen = tk.spawnAt(0, 0)!;
      c.step(30);
      c.expect(frozen.active && frozen.age === 0, 'a ticket aged while tickets were disabled');
      tk.clear();
      tk.enabled = true;
      tk.spawnTimer = 1e9;
      const t = tk.spawnAt(0, 0)!;
      const id = t.id;
      c.step(T.lifetime - T.blinkTime + 0.5, () => (time += DT));
      c.expect(t.active && t.remaining < T.blinkTime, `not in its blinking phase (remaining ${t.remaining.toFixed(2)})`);
      let shown = 0, hidden = 0;
      for (let i = 0; i < 60; i++) {
        tk.updateVisual(1 / 60);
        if (t.card.visible) shown++;
        else hidden++;
      }
      c.expect(shown > 0 && hidden > 0, `no blink (${shown} shown / ${hidden} hidden frames)`);
      c.step(T.blinkTime, () => (time += DT));
      c.expect(!t.active, 'still on the floor after its lifetime');
      c.expect(gone.length === 1 && gone[0].id === id && gone[0].reason === 'timeout', `expire events: ${JSON.stringify(gone)}`);
      c.near(gone[0].at, T.lifetime, DT * 1.5, 'lifetime');
      // The closing fire ring burns a ticket it reaches.
      const edge = tk.spawnAt(0, 20)!;
      c.step(0.2);
      c.expect(edge.active, 'a ticket inside the ring vanished');
      game.arena.fireRadius = 20;
      c.step(DT);
      c.expect(!edge.active && gone[gone.length - 1].reason === 'fire', 'the fire ring did not burn the ticket');
    } finally {
      off();
      tk.enabled = false;
      game.arena.fireRadius = CONFIG.arena.fireRadius;
    }
  });

  /**
   * The rival AI with a free ticket behind it (off its path to the player, so only a deliberate
   * detour reaches it). `shoot`: the player pours bolts at it, starting a second before the ticket appears.
   */
  const aiNearTicket = (c: Ctx, shoot: boolean) => {
    c.setup({ player: [0, -12], enemy: [0, 6] });
    const ai = new AIController(c.enemy, c.player, game.spells, game.physics, game.arena);
    ai.tickets = tk;
    tk.enabled = true;
    tk.spawnTimer = 1e9;
    let sought = 0, collectedBy: Wizard | null = null;
    const off = events.on('ticketPickup', (e) => (collectedBy = e.wizard));
    const each = () => {
      ai.update(DT);
      if (ai.seekingTicket) sought++;
      if (shoot) {
        c.player.mana = 1e6;
        c.enemy.chest(c.player.aimPoint);
        c.player.intent.facing = Math.atan2(c.enemy.pos.x - c.player.pos.x, c.enemy.pos.z - c.player.pos.z);
        c.player.intent.holdBolt = true;
      }
    };
    let ticket: GoldenTicket;
    try {
      c.step(1, each);
      const spot: [number, number] = [c.enemy.pos.x + 3, Math.max(c.enemy.pos.z + 5, 9)];
      if (!tk.isValidSpot(spot[0], spot[1])) spot[0] = c.enemy.pos.x - 3;
      c.expect(tk.isValidSpot(spot[0], spot[1]), `test ticket spot (${spot[0].toFixed(1)}, ${spot[1].toFixed(1)}) is not valid`);
      ticket = tk.spawnAt(spot[0], spot[1])!;
      c.step(8, each);
    } finally {
      off();
      ai.dispose();
      c.player.intent.holdBolt = false;
      tk.enabled = false;
    }
    return { sought: sought * DT, collectedBy: collectedBy as Wizard | null, ticket, casts: c.enemy.stats.casts };
  };

  qa.add('tickets.ai_detours_when_safe', (c) => {
    const r = withSeededRandom(77, () => aiNearTicket(c, false));
    c.expect(r.sought > 0, 'the AI never went for the ticket');
    c.expect(r.collectedBy === c.enemy, `ticket collected by ${r.collectedBy?.name ?? 'nobody'}`);
    c.expect(r.casts > 0, 'the AI stopped fighting while detouring');
    c.note(`detoured ${r.sought.toFixed(1)} s, cast ${r.casts}`);
  });

  qa.add('tickets.ai_holds_back_under_fire', (c) => {
    const r = withSeededRandom(77, () => aiNearTicket(c, true));
    c.expect(r.sought === 0, `the AI went for the ticket under fire (${r.sought.toFixed(1)} s)`);
    c.note(`enemy hp ${c.enemy.health.toFixed(0)}, ticket ${r.ticket.active ? 'left alone' : `collected by ${r.collectedBy?.name}`}`);
  });

  qa.add('tickets.pool_meshes_reused', (c) => {
    c.setup({ player: [0, -20], enemy: [0, 20] });
    const scene = game.renderer.scene;
    const children = scene.children.length;
    const roots = new Set(tk.pool.map((t) => t.root));
    const cards = new Set(tk.pool.map((t) => t.card));
    tk.enabled = true;
    try {
      for (let i = 0; i < 40; i++) {
        const t = tk.spawnAt((i % 5) * 4 - 8, 0) ?? tk.pool[0];
        if (i % 2) tk.collect(t, c.player);
        else {
          t.age = T.lifetime;
          c.step(DT);
        }
        tk.updateVisual(0.4);
      }
      c.expect(tk.pool.length === T.maxActive, `pool grew to ${tk.pool.length}`);
      c.expect(scene.children.length === children, `scene grew from ${children} to ${scene.children.length} objects`);
      c.expect(tk.pool.every((t) => roots.has(t.root) && cards.has(t.card)), 'ticket meshes were replaced');
    } finally {
      tk.enabled = false;
    }
  });

  qa.add('tickets.works_with_three_wizards', (c) => {
    // A temporary third wizard: spawn spots avoid it, it can collect, all three get auras and boosts.
    c.setup({ player: [-10, 0], enemy: [10, 0] });
    const third = new Wizard(game.wizards.length, CONFIG.teams[1], 'Third', new WizardVisual(CONFIG.teams[1], null, MODELS.wizardRival), game.physics);
    game.wizards.push(third);
    const ends = new Set<Wizard>();
    let collector: Wizard | null = null;
    const offs = [events.on('manaBoostEnd', (e) => ends.add(e.wizard)), events.on('ticketPickup', (e) => (collector = e.wizard))];
    tk.enabled = true;
    tk.spawnTimer = 1e9;
    try {
      third.spawn(0, 8, 0);
      game.physics.step();
      c.expect(!tk.isValidSpot(0, 10), 'a spot 2 m from the third wizard counted as valid');
      tk.spawnAt(0, 11);
      c.step(1.5, () => third.intent.move.set(0, 0, 1));
      third.intent.move.set(0, 0, 0);
      c.expect(collector === third, `collected by ${(collector as Wizard | null)?.name ?? 'nobody'}`);
      c.expect(third.manaBoost > 0 && third.maxMana === W.maxMana * T.maxManaMultiplier, 'third wizard got no boost');
      tk.collect(tk.spawnAt(-10, 4)!, c.player);
      tk.collect(tk.spawnAt(10, 4)!, c.enemy);
      tk.updateVisual(1 / 60);
      c.expect(tk.visibleAuras === 3, `${tk.visibleAuras} auras for 3 boosted wizards`);
      c.step(T.boostDuration + 0.5);
      c.expect(ends.size === 3 && ends.has(third), `boost ended for ${ends.size} wizards`);
      c.expect(third.mana <= W.maxMana, `third wizard mana ${third.mana} after the boost`);
      tk.updateVisual(1 / 60);
      c.expect(tk.visibleAuras === 0, 'auras still shown after the boosts ended');
    } finally {
      offs.forEach((off) => off());
      tk.enabled = false;
      game.wizards.splice(game.wizards.indexOf(third), 1);
      game.physics.world.removeRigidBody(third.body);
    }
  });
}
