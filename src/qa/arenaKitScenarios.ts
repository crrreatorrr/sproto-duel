import * as THREE from 'three';
import { CONFIG } from '../config';
import { events } from '../core/events';
import type { Game } from '../core/Game';
import { AIController } from '../enemy/AIController';
import type { ColliderPart, Pillar } from '../arena/Pillar';
import type { ArenaThemeId } from '../arena/themes';
import type { Wizard } from '../wizard/Wizard';
import type { QAHarness } from './QAHarness';
import { withSeededRandom } from './campaignScenarios';

const DT = CONFIG.sim.fixedDt;
const A = CONFIG.arena;
const W = CONFIG.wizard;
const J = W.jump;
const APEX = (J.velocity * J.velocity) / (2 * J.gravity);
/** The boss arenas with their own obstacle kits. */
const BOSS_ARENAS: ArenaThemeId[] = ['desert', 'void', 'city', 'office', 'volcano'];

/** A world point in an obstacle part's own axes. */
function inPart(p: Pillar, part: ColliderPart, x: number, z: number): [number, number] {
  const dx = x - p.position.x, dz = z - p.position.z;
  const y = p.shape.yaw;
  const lx = dx * Math.cos(y) - dz * Math.sin(y) - part.x;
  const lz = dx * Math.sin(y) + dz * Math.cos(y) - part.z;
  const c = Math.cos(part.yaw), s = Math.sin(part.yaw);
  return [lx * c - lz * s, lx * s + lz * c];
}

/** 3D distance from a point to an obstacle's standing collider parts (roofs included). */
function partGap(p: Pillar, v: THREE.Vector3): number {
  if (!p.alive || !p.active) return Infinity;
  let best = Infinity;
  for (const part of p.shape.parts) {
    const [px, pz] = inPart(p, part, v.x, v.z);
    const h = part.shape === 'box'
      ? Math.hypot(Math.max(0, Math.abs(px) - part.halfX), Math.max(0, Math.abs(pz) - part.halfZ))
      : Math.max(0, Math.hypot(px, pz) - part.radius);
    const vy = v.y > part.height ? v.y - part.height : v.y < part.y0 ? part.y0 - v.y : 0;
    best = Math.min(best, Math.hypot(h, vy));
  }
  return best;
}

/** Gap between a wizard capsule and an obstacle's live collider. Negative = inside it. */
function capsuleGap(w: Wizard, p: Pillar): number {
  const bottom = w.pos.y + 0.02 + W.radius, top = w.pos.y + W.height - W.radius;
  let best = Infinity;
  const parts = p.alive ? p.shape.parts : p.shape.stumpHeight > 0 ? p.shape.parts.filter((q) => q.y0 === 0) : [];
  for (const part of parts) {
    const ph = p.alive ? part.height : Math.min(part.height, p.shape.stumpHeight);
    const [px, pz] = inPart(p, part, w.pos.x, w.pos.z);
    const h = part.shape === 'box'
      ? Math.hypot(Math.max(0, Math.abs(px) - part.halfX), Math.max(0, Math.abs(pz) - part.halfZ))
      : Math.max(0, Math.hypot(px, pz) - part.radius);
    const vy = bottom > ph ? bottom - ph : top < part.y0 ? part.y0 - top : 0;
    best = Math.min(best, Math.hypot(h, vy) - W.radius);
  }
  return best;
}

/**
 * The boss arenas' own kits: fair layouts, cover that blocks and breaks, low cover you can stand
 * on, sliding blocks, vape clouds, glass, lava, tickets, the camera and the AI in each.
 */
export function registerArenaKitScenarios(qa: QAHarness, game: Game): void {
  const arena = game.arena;
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();

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
  const stepUntil = (done: () => boolean, limit: number, each?: () => void) => {
    let t = 0;
    while (t < limit && !done()) {
      each?.();
      game.tick(DT);
      t += DT;
    }
    return t;
  };
  const solid = () => arena.pillars.filter((p) => p.active);

  qa.add('arenas.layouts_fair_clear_and_inside_the_fire', (c) => {
    const notes: string[] = [];
    for (const id of BOSS_ARENAS) {
      inTheme(id, () => {
        const all = solid();
        const kinds = new Set(all.map((p) => p.shape.kind));
        c.expect(kinds.size >= 2, `${id}: only ${kinds.size} obstacle kinds`);
        for (const p of all) {
          const reach = Math.hypot(p.position.x, p.position.z) + p.boundingRadius;
          c.expect(reach < A.fireRadius - 3, `${id}: ${p.shape.kind} at (${p.position.x.toFixed(1)}, ${p.position.z.toFixed(1)}) reaches r=${reach.toFixed(1)}`);
          const mirrored = all.some((q) => q.shape.kind === p.shape.kind && (
            Math.hypot(q.position.x + p.position.x, q.position.z + p.position.z) < 0.05 ||
            Math.hypot(q.position.x + p.position.x, q.position.z - p.position.z) < 0.05 ||
            Math.hypot(q.position.x - p.position.x, q.position.z + p.position.z) < 0.05 || p.moving));
          c.expect(mirrored, `${id}: ${p.shape.kind} at (${p.position.x}, ${p.position.z}) has no mirror for the other spawn`);
        }
        for (const h of arena.hazards) {
          c.expect(Math.hypot(h.x, h.z) + h.radius < A.fireRadius - 2, `${id}: lava at (${h.x}, ${h.z}) touches the fire`);
          c.expect(Math.abs(h.x) > h.radius + 1.5 || Math.abs(h.z) > A.spawnDistance / 2 + h.radius + 1, `${id}: lava on the spawn lane`);
        }
        c.setup();
        game.spawnWizards();
        for (const w of game.wizards) {
          const near = Math.min(...all.map((p) => p.surfaceDistance(w.pos.x, w.pos.z)));
          c.expect(near > 2.2, `${id}: ${w.name} spawns ${near.toFixed(2)} m from cover`);
          c.expect(!arena.hazardAt(w.pos.x, w.pos.z, 2), `${id}: ${w.name} spawns by lava`);
        }
        c.expect(game.physics.lineOfSight(c.player.chest(tmpA), c.enemy.chest(tmpB)), `${id}: cover blocks the spawn line`);
        if (id === 'void') {
          // The double boss fight (Bitcoin Obama & The Midget) spawns the pair side by side here.
          for (const sx of [-1, 1]) {
            const x = (sx * CONFIG.campaign.duo.spawnSpacing) / 2;
            const z = A.spawnDistance / 2;
            const near = Math.min(...all.map((p) => p.surfaceDistance(x, z)));
            c.expect(near > 2.2, `${id}: duo spawn (${x}, ${z}) is ${near.toFixed(2)} m from cover`);
            tmpB.set(x, 1.2, z); // a full-size wizard's chest (Wizard.chest)
            c.expect(game.physics.lineOfSight(c.player.chest(tmpA), tmpB), `${id}: cover blocks the duo spawn (${x}, ${z})`);
          }
        }
        let open = 0;
        for (const w of game.wizards) {
          for (let k = 0; k < 36; k++) {
            const a = (k / 36) * Math.PI * 2;
            w.chest(tmpA);
            tmpB.set(tmpA.x + Math.sin(a) * 12, tmpA.y, tmpA.z + Math.cos(a) * 12);
            if (game.physics.lineOfSight(tmpA, tmpB)) open++;
          }
        }
        c.expect(open >= 36, `${id}: only ${open}/72 open sight lines from the spawns`);
        notes.push(`${id} ${all.length} pieces/${kinds.size} kinds, ${open}/72 lanes`);
      });
    }
    c.note(notes.join('; '));
  });

  qa.add('arenas.low_cover_is_jumpable_and_standable', (c) => {
    const notes: string[] = [];
    // [theme, kind]: run at it along its long axis, jump ~1.95 m out, land on top. A low candlestick
    // bar is too narrow to stop on at a run, so for it the jump only has to clear it.
    const cases: [ArenaThemeId, string][] = [['desert', 'rugs'], ['desert', 'cart'], ['city', 'car'], ['city', 'dumpster'], ['void', 'candle'], ['office', 'cabinet']];
    for (const [id, kind] of cases) {
      inTheme(id, () => {
        const pick = solid().filter((p) => p.shape.kind === kind && p.shape.parts[0].height < APEX - 0.05).sort((a, b) => a.shape.height - b.shape.height)[0];
        c.expect(!!pick, `${id}: no low ${kind}`);
        const p = pick;
        // Approach along the obstacle's own x axis, from whichever end has a clear run-up.
        const ax = Math.cos(p.shape.yaw), az = -Math.sin(p.shape.yaw);
        const runUp = (sgn: number) => {
          const ddx = sgn * ax, ddz = sgn * az;
          const e = p.extentToward(-ddx, -ddz);
          let clear = Infinity;
          for (let k = 1.5; k <= e + 4.5; k += 0.5) {
            const x = p.position.x - ddx * (e + k), z = p.position.z - ddz * (e + k);
            for (const q of solid()) if (q !== p) clear = Math.min(clear, q.surfaceDistance(x, z));
          }
          return { ddx, ddz, e, clear };
        };
        const r1 = runUp(1), r2 = runUp(-1);
        const best = r1.clear >= r2.clear ? r1 : r2;
        const dx = best.ddx, dz = best.ddz, edge = best.e;
        const sx = p.position.x - dx * (edge + 4.5), sz = p.position.z - dz * (edge + 4.5);
        c.setup({ player: [sx, sz], enemy: [-sx * 0.2, -sz * 0.2 - 6] });
        const w = c.player;
        let jumped = false;
        let worst = Infinity;
        const landings = w.landings;
        const hopOver = kind === 'candle';
        const along = () => (w.pos.x - p.position.x) * dx + (w.pos.z - p.position.z) * dz; // < 0 before the centre
        if (hopOver) {
          stepUntil(() => along() > edge + 1, 4, () => {
            const toEdge = -along() - edge;
            w.intent.move.set(dx, 0, dz);
            if (!jumped && toEdge <= 1.2) {
              w.intent.press('jump');
              jumped = true;
            }
            for (const q of solid()) worst = Math.min(worst, capsuleGap(w, q));
          });
          c.expect(along() > edge + 1, `${id}: could not hop over a ${p.shape.height.toFixed(2)} m ${kind}`);
          c.expect(worst > -0.03, `${id}: capsule went ${(-worst).toFixed(3)} m into cover`);
          notes.push(`hopped a ${p.shape.height.toFixed(2)} m ${kind}`);
          return;
        }
        stepUntil(() => w.landings > landings && w.grounded && w.pos.y > 0.4, 4, () => {
          const toEdge = -along() - edge;
          w.intent.move.set(along() < -0.3 ? dx : 0, 0, along() < -0.3 ? dz : 0);
          if (!jumped && toEdge <= 1.95) {
            w.intent.press('jump');
            jumped = true;
          }
          for (const q of solid()) worst = Math.min(worst, capsuleGap(w, q));
        });
        w.intent.move.set(0, 0, 0);
        c.step(0.3);
        const onTop = w.grounded && w.pos.y > 0.5 && p.surfaceDistance(w.pos.x, w.pos.z) === 0;
        c.expect(onTop, `${id}: did not land on the ${kind} (y=${w.pos.y.toFixed(2)})`);
        c.expect(worst > -0.03, `${id}: capsule went ${(-worst).toFixed(3)} m into cover`);
        notes.push(`${kind} ${w.pos.y.toFixed(2)} m`);
        // A car's roof is a second hop from its hood.
        if (kind === 'car' && w.pos.y < 1.2) {
          const roof = p.shape.parts[1];
          const rx = p.position.x + roof.x * Math.cos(p.shape.yaw), rz = p.position.z - roof.x * Math.sin(p.shape.yaw);
          w.intent.press('jump');
          c.step(0.05);
          stepUntil(() => w.grounded && w.vy === 0 && w.pos.y > 1.2, 2, () => {
            const ddx = rx - w.pos.x, ddz = rz - w.pos.z, d = Math.hypot(ddx, ddz);
            w.intent.move.set(d > 0.3 ? ddx / d : 0, 0, d > 0.3 ? ddz / d : 0);
          });
          w.intent.move.set(0, 0, 0);
          c.step(0.3);
          c.expect(w.grounded && Math.abs(w.pos.y - roof.height) < 0.05, `${id}: could not hop from the hood onto the car roof (y=${w.pos.y.toFixed(2)})`);
          notes.push(`car roof ${w.pos.y.toFixed(2)} m`);
        }
      });
    }
    c.note(notes.join(', '));
  });

  qa.add('arenas.void_blocks_slide_never_crush_and_block', (c) => {
    inTheme('void', () => {
      const movers = arena.movingCover;
      c.expect(movers.length >= 2 && movers.length <= 4, `${movers.length} moving blocks`);
      c.setup({ player: [0, -10], enemy: [0, 10] });
      const start = movers.map((m) => m.position.clone());
      c.step(3);
      const moved = movers.map((m, i) => m.position.distanceTo(start[i]));
      c.expect(moved.every((d) => d > 2), `blocks barely moved (${moved.map((d) => d.toFixed(1)).join(', ')} m)`);
      // Stand in a block's way: it must turn back, never overlap the wizard.
      const m = movers[0];
      c.setup({ player: [0, -10], enemy: [0, 10] });
      const ahead = new THREE.Vector3(m.position.x + 4, 0, m.position.z);
      c.player.spawn(ahead.x, ahead.z, 0);
      game.physics.step();
      let worst = Infinity;
      let minX = Infinity, maxX = -Infinity;
      c.step(6, () => {
        worst = Math.min(worst, capsuleGap(c.player, m));
        maxX = Math.max(maxX, m.position.x);
        minX = Math.min(minX, m.position.x);
      });
      c.expect(worst > -0.02, `a sliding block went ${(-worst).toFixed(3)} m into a wizard`);
      c.expect(maxX < ahead.x - 0.9 - W.radius + 0.1, `block slid through the wizard (reached x=${maxX.toFixed(2)})`);
      c.expect(maxX - minX > 1, 'block never turned back after reaching the wizard');
      // A moving block stops bolts and sight like any cover.
      c.setup({ player: [0, -10], enemy: [0, 10] });
      m.moveTo(0, m.position.z, true);
      game.physics.step();
      c.player.spawn(0, m.position.z - 6, 0);
      c.enemy.spawn(0, m.position.z + 3, Math.PI);
      game.physics.step();
      c.aimAt(c.player, c.enemy);
      c.expect(!game.physics.lineOfSight(c.player.chest(tmpA), c.enemy.chest(tmpB)), 'a moving block does not block sight');
      const hp = c.enemy.health;
      c.player.intent.press('bolt');
      c.step(0.5, () => m.moveTo(0, m.position.z, false));
      c.expect(c.enemy.health === hp, 'a bolt went through a moving block');
      c.note(`moved ${moved.map((d) => d.toFixed(1)).join('/')} m in 3 s, closest to a blocking wizard ${worst.toFixed(3)} m`);
    });
  });

  qa.add('arenas.city_vape_clouds_hide_from_the_ai', (c) => {
    inTheme('city', () => {
      const clouds = arena.softZones;
      c.expect(clouds.length >= 2 && clouds.length <= 3, `${clouds.length} vape clouds`);
      c.setup({ player: [0, -10], enemy: [0, 10] });
      const cl = arena.softZones[0];
      // A bolt passes straight through a cloud.
      c.player.spawn(cl.x, cl.z - 6, 0);
      c.enemy.spawn(cl.x, cl.z, Math.PI);
      game.physics.step();
      c.aimAt(c.player, c.enemy);
      c.expect(arena.obscured(c.player.chest(tmpA), c.enemy.chest(tmpB)), 'standing in a cloud does not obscure');
      c.expect(game.physics.lineOfSight(c.player.chest(tmpA), c.enemy.chest(tmpB)), 'test setup: solid cover in the way');
      const hp = c.enemy.health;
      c.player.intent.press('bolt');
      c.step(0.5);
      c.expect(c.enemy.health < hp, 'a vape cloud stopped a bolt');
      // The AI loses track: it keeps firing at where it last saw you, then gives up.
      c.setup({ player: [0, -10], enemy: [0, 10] });
      const cloud = arena.softZones[0];
      c.player.spawn(cloud.x + cloud.radius + 3, cloud.z, 0);
      c.enemy.spawn(cloud.x + cloud.radius + 3, cloud.z + 12, Math.PI);
      game.physics.step();
      const ai = new AIController(game.enemy, game.player, game.spells, game.physics, game.arena, 'normal');
      let aimAtOld = 0, aimAtTrue = 0, frames = 0, castsHidden = 0;
      try {
        c.step(1.2, () => {
          ai.update(DT);
          c.player.health = W.maxHealth;
        });
        const seen = c.player.pos.clone();
        // Duck into the cloud.
        c.player.spawn(cloud.x, cloud.z, 0);
        game.physics.step();
        const casts = c.enemy.stats.casts;
        c.step(2, () => {
          ai.update(DT);
          c.player.health = W.maxHealth;
          const now = arena.softZones[0];
          c.player.pos.set(now.x, 0, now.z);
          c.player.placeBody();
          frames++;
          if (Math.hypot(c.enemy.aimPoint.x - seen.x, c.enemy.aimPoint.z - seen.z) < 3) aimAtOld++;
          if (Math.hypot(c.enemy.aimPoint.x - now.x, c.enemy.aimPoint.z - now.z) < 1) aimAtTrue++;
        });
        castsHidden = c.enemy.stats.casts - casts;
      } finally {
        ai.dispose();
      }
      c.note(`AI aimed at the last known spot ${aimAtOld}/${frames} frames (at the hidden wizard ${aimAtTrue}), fired ${castsHidden} spells into the haze`);
      c.expect(aimAtOld > frames * 0.5 && aimAtTrue < frames * 0.2, `AI tracked a wizard hidden in a cloud (${aimAtOld}/${frames} at the last known spot, ${aimAtTrue} on target)`);
    });
  });

  qa.add('arenas.office_glass_stops_spells_then_shatters_and_resets', (c) => {
    inTheme('office', () => {
      const glass = solid().find((p) => p.shape.kind === 'glass' && Math.abs(p.shape.yaw) < 0.1 && p.position.x > 0 && p.position.z > 0)!;
      c.expect(!!glass, 'no glass partition');
      const g = glass.position;
      c.setup({ player: [g.x, g.z - 6], enemy: [g.x, g.z + 3] });
      c.expect(game.physics.lineOfSight(c.player.chest(tmpA), c.enemy.chest(tmpB)), 'glass blocks sight (should be see-through)');
      const hp = c.enemy.health;
      c.player.intent.press('bolt');
      c.step(0.5);
      c.expect(c.enemy.health === hp && glass.alive && glass.hp < glass.shape.hp, 'the first bolt did not stop at the glass');
      let shattered = 0;
      const off = events.on('pillarBreak', (e) => {
        if (e.glass) shattered++;
      });
      try {
        c.step(3, () => {
          c.player.mana = W.maxMana;
          c.player.intent.holdBolt = glass.alive;
        });
      } finally {
        off();
      }
      c.player.intent.holdBolt = false;
      const bolts = c.player.stats.casts;
      c.expect(!glass.alive && shattered === 1, `glass did not shatter (${bolts} bolts, hp ${glass.hp})`);
      const before = c.enemy.health;
      c.step(0.3);
      c.player.intent.press('bolt');
      c.step(0.6);
      c.expect(c.enemy.health < before, 'bolts still stopped after the glass shattered');
      game.resetArena();
      game.physics.step();
      c.expect(glass.alive && glass.describe().wholeVisible, 'glass not restored for the next round');
      c.note(`${bolts} bolts to shatter (${glass.shape.hp} hp)`);
    });
  });

  qa.add('arenas.caldera_lava_burns_and_the_ai_avoids_it', (c) => {
    inTheme('volcano', () => {
      const pools = arena.hazards;
      c.expect(pools.length >= 3 && pools.length <= 4, `${pools.length} lava pools`);
      const h = pools[0];
      c.setup({ player: [h.x, h.z], enemy: [0, 0] });
      const hp = c.player.health;
      c.step(1);
      const burned = hp - c.player.health;
      c.near(burned, A.lavaDps, A.lavaDps * 0.3, 'lava damage per second');
      // Jumping over a pool: no burn while airborne.
      c.setup({ player: [h.x, h.z], enemy: [0, 0] });
      c.player.intent.press('jump');
      c.step(0.12);
      const mid = c.player.health;
      c.step(0.4);
      c.expect(c.player.health === mid, 'burned while in the air over lava');
      // Retreat cover spots and AI movement keep out of lava.
      c.setup({ player: [0, -8], enemy: [0, 8] });
      const ai = new AIController(game.enemy, game.player, game.spells, game.physics, game.arena, 'normal');
      const brain = ai as unknown as { findCover(): void; hasCover: boolean; coverPoint: THREE.Vector3 };
      let lavaSpots = 0;
      let lavaTime = 0;
      try {
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * Math.PI * 2;
          c.player.spawn(Math.sin(a) * 14, Math.cos(a) * 14, 0);
          brain.findCover();
          if (brain.hasCover && arena.hazardAt(brain.coverPoint.x, brain.coverPoint.z, W.radius)) lavaSpots++;
        }
        // The player waits on the far side of a pool; the AI has to come around it.
        const p = pools[0];
        const out = new THREE.Vector3(p.x, 0, p.z).normalize();
        c.setup({ player: [p.x + out.x * (p.radius + 2.5), p.z + out.z * (p.radius + 2.5)], enemy: [p.x - out.x * (p.radius + 5), p.z - out.z * (p.radius + 5)] });
        c.step(20, () => {
          ai.update(DT);
          c.player.health = c.enemy.health = W.maxHealth;
          if (game.fire.inLava(c.enemy)) lavaTime += DT;
        });
      } finally {
        ai.dispose();
      }
      c.note(`burn ${burned.toFixed(1)} hp/s, AI cover spots in lava ${lavaSpots}/12, AI time in lava ${lavaTime.toFixed(2)} s of 20`);
      c.expect(lavaSpots === 0, `${lavaSpots} AI cover spots in lava`);
      c.expect(lavaTime < 0.5, `AI stood in lava for ${lavaTime.toFixed(2)} s`);
    });
  });

  qa.add('arenas.tickets_never_spawn_in_lava_clouds_or_rails', (c) => {
    const notes: string[] = [];
    for (const id of ['volcano', 'city', 'void'] as ArenaThemeId[]) {
      inTheme(id, () => {
        c.setup({ player: [0, -8], enemy: [0, 8] });
        const t = game.tickets;
        let bad = 0, spawned = 0;
        for (let i = 0; i < 60; i++) {
          t.clear();
          if (!t.spawn()) continue;
          const tk = t.pool.find((x) => x.active);
          if (!tk) continue;
          spawned++;
          if (arena.excludesPickup(tk.pos.x, tk.pos.z)) bad++;
        }
        t.clear();
        // Every point inside a hazard or cloud is refused outright.
        for (const h of arena.hazards) c.expect(!t.isValidSpot(h.x, h.z), `${id}: ticket allowed in lava`);
        for (const cl of arena.softZones) c.expect(!t.isValidSpot(cl.x, cl.z), `${id}: ticket allowed in a vape cloud`);
        c.expect(spawned > 20 && bad === 0, `${id}: ${bad}/${spawned} tickets in an excluded zone`);
        notes.push(`${id} ${spawned} spawns clean`);
      });
    }
    c.note(notes.join(', '));
  });

  qa.add('arenas.camera_never_clips_boss_cover', (c) => {
    const rig = game.rig;
    const notes: string[] = [];
    for (const id of BOSS_ARENAS) {
      inTheme(id, () => {
        let worst = Infinity;
        let blocked = 0;
        const tall = solid().filter((p) => p.shape.height > 1.6 && !p.moving).slice(0, 6);
        for (const p of tall) {
          const away = p.position.clone().setY(0).normalize().negate();
          const yaw = Math.atan2(away.x, away.z);
          const rx = -Math.cos(yaw), rz = Math.sin(yaw);
          const ext = p.extentToward(away.x, away.z);
          for (const back of [1.4, 2.4]) {
            const bx = p.position.x + away.x * (ext + back), bz = p.position.z + away.z * (ext + back);
            c.setup({ player: [bx, bz], enemy: [0, 0] });
            rig.snap(c.player.pos, yaw);
            for (let f = 0; f <= 30; f++) {
              const side = -2 + (4 * f) / 30;
              c.player.pos.set(bx + rx * side, 0, bz + rz * side);
              rig.update(1 / 60, c.player.pos, game.physics, false, false);
              const cam = rig.camera.position;
              if (cam.distanceTo(tmpA.copy(c.player.pos).setY(CONFIG.camera.height)) < CONFIG.camera.distance - 0.3) blocked++;
              for (const q of solid()) worst = Math.min(worst, partGap(q, cam));
            }
          }
        }
        notes.push(`${id} ${worst.toFixed(2)} m`);
        c.expect(blocked > 5, `${id}: test never put cover behind the camera`);
        c.expect(worst >= 0.15, `${id}: camera came within ${worst.toFixed(3)} m of cover`);
      });
    }
    c.note(`closest camera-to-cover: ${notes.join(', ')}`);
  });

  qa.add('arenas.ai_duels_in_every_boss_arena', (c) => {
    const notes: string[] = [];
    // Seeded so the duel replays identically (unseeded, the void's sliding blocks made it flaky).
    for (const [i, id] of BOSS_ARENAS.entries()) {
      withSeededRandom(4100 + i, () => inTheme(id, () => {
        c.setup();
        game.spawnWizards();
        const a = new AIController(game.player, game.enemy, game.spells, game.physics, game.arena, 'normal');
        const b = new AIController(game.enemy, game.player, game.spells, game.physics, game.arena, 'normal');
        let t = 0;
        let bad = '';
        try {
          while (t < CONFIG.match.roundTime && c.player.alive && c.enemy.alive) {
            a.update(DT);
            b.update(DT);
            game.tick(DT);
            t += DT;
            for (const w of game.wizards) {
              if (!Number.isFinite(w.pos.x + w.pos.z)) bad = 'NaN';
              for (const p of solid()) if (capsuleGap(w, p) < -0.05) bad = `${w.name} inside a ${p.shape.kind}`;
            }
          }
        } finally {
          a.dispose();
          b.dispose();
        }
        const lost = [c.player, c.enemy].map((w) => w.maxHealth - w.health);
        notes.push(`${id} ${t.toFixed(0)}s ${lost.map((v) => v.toFixed(0)).join('/')}`);
        c.expect(!bad, `${id}: ${bad}`);
        c.expect(lost[0] + lost[1] > 100, `${id}: the AIs barely hurt each other in a full round`);
      }));
    }
    c.note(`one-round AI duels (length, damage taken): ${notes.join(', ')}`);
  });
}
