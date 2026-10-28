import * as THREE from 'three';
import { CONFIG } from '../config';
import { events } from '../core/events';
import type { Game } from '../core/Game';
import { AIController } from '../enemy/AIController';
import type { Pillar } from '../arena/Pillar';
import { pillarFitScale } from '../arena/themeKit';
import type { ArenaThemeId } from '../arena/themes';
import { resolveAsset } from '../assets/AssetLoader';
import { THEME_ASSETS } from '../assets/manifest';
import type { Wizard } from '../wizard/Wizard';
import type { QAHarness } from './QAHarness';

const DT = CONFIG.sim.fixedDt;
const A = CONFIG.arena;
const C = A.cubicles;
const W = CONFIG.wizard;
const J = W.jump;
const S = CONFIG.spells;
const APEX = (J.velocity * J.velocity) / (2 * J.gravity);

/** Gap between a wizard's capsule and an obstacle (standing or stump). Negative = inside it. */
function clearance(w: Wizard, p: Pillar): number {
  const segBottom = w.pos.y + 0.02 + W.radius;
  const v = Math.max(0, segBottom - p.top);
  return Math.hypot(p.surfaceDistance(w.pos.x, w.pos.z), v) - W.radius;
}

/** Distance from a point (e.g. the camera) to an obstacle's live collider. */
function pointGap(p: Pillar, v: THREE.Vector3): number {
  return Math.hypot(p.surfaceDistance(v.x, v.z), Math.max(0, v.y - p.top));
}

/**
 * The office (Glowie) and Los Angeles (Broccoli Head) environments: the cubicle layout (spawns,
 * lanes, fairness), cubicles as cover (bolts, line of sight, blasts, the Ultimate, round reset,
 * landings, camera), the AI in the office, and the generated GLBs' fit.
 */
export function registerOfficeScenarios(qa: QAHarness, game: Game): void {
  const arena = game.arena;
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();

  // Start the optional GLB loads now, so the fit checks can see them by the time they run.
  for (const id of ['city', 'office'] as const) {
    void game.assets.loadModelAsset(THEME_ASSETS[id].pillar);
    void game.assets.loadModelAsset(THEME_ASSETS[id].prop);
  }

  /** Run `fn` in a theme (with the `?theme=` override off), then restore what was showing. */
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
  const cubicles = () => arena.pillars.filter((p) => p.shape.kind === 'cubicle');
  /** The cubicle closest to (x, z). */
  const cubicleAt = (x: number, z: number) => cubicles().reduce((a, b) => (a.position.distanceTo(tmpA.set(x, 0, z)) < b.position.distanceTo(tmpA.set(x, 0, z)) ? a : b));
  const stepUntil = (done: () => boolean, limit: number, each?: () => void) => {
    let t = 0;
    while (t < limit && !done()) {
      each?.();
      game.tick(DT);
      t += DT;
    }
    return t;
  };

  qa.add('office.layout_spawns_lanes_and_symmetry', (c) => {
    inTheme('office', () => {
      c.expect(arena.layout === 'cubicles', `office layout is ${arena.layout}`);
      const all = arena.pillars;
      const cubs = cubicles();
      c.expect(cubs.length >= 12 && cubs.length <= 18, `${cubs.length} cubicles (want 12-18)`);
      c.expect(all.every((p) => p.active) && arena.obstaclesFor('rings').every((p) => !p.active), 'inactive layout still live');
      for (const p of all) {
        const r = Math.hypot(p.position.x, p.position.z) + p.boundingRadius;
        c.expect(r < A.fireRadius - 3, `${p.shape.kind} at (${p.position.x.toFixed(1)}, ${p.position.z.toFixed(1)}) reaches r=${r.toFixed(1)}, crowding the fire`);
        // Mirror symmetry: the same cover exists for the other spawn.
        c.expect(all.some((q) => q.shape.kind === p.shape.kind && Math.hypot(q.position.x + p.position.x, q.position.z + p.position.z) < 0.01),
          `${p.shape.kind} at (${p.position.x}, ${p.position.z}) has no mirror for the other spawn`);
      }
      // Gaps between pieces: joined (a back-to-back pod) or wide enough to walk through.
      let narrowest = Infinity;
      const ring = 48;
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const p = all[i], q = all[j];
          let gap = Infinity;
          for (let k = 0; k < ring; k++) {
            const a = (k / ring) * Math.PI * 2;
            p.closestPoint(p.position.x + Math.cos(a) * 9, p.position.z + Math.sin(a) * 9, tmpA);
            gap = Math.min(gap, q.surfaceDistance(tmpA.x, tmpA.z));
          }
          if (gap > 0.05) narrowest = Math.min(narrowest, gap);
          c.expect(gap < 0.05 || gap > 2 * W.radius + 0.5, `${p.shape.kind}/${q.shape.kind} leave a ${gap.toFixed(2)} m slot (snags wizards)`);
        }
      }
      // Spawns: clear ground, facing each other with nothing in between.
      c.setup();
      game.spawnWizards();
      for (const w of game.wizards) {
        const near = Math.min(...all.map((p) => p.surfaceDistance(w.pos.x, w.pos.z)));
        c.expect(near > 2.5, `${w.name} spawns ${near.toFixed(2)} m from cover`);
      }
      c.expect(game.physics.lineOfSight(c.player.chest(tmpA), c.enemy.chest(tmpB)), 'cover blocks the spawn line');
      // Lanes: from each spawn, most directions are open at chest height for 12 m.
      const open: number[] = [];
      for (const w of game.wizards) {
        let clear = 0;
        for (let k = 0; k < 36; k++) {
          const a = (k / 36) * Math.PI * 2;
          w.chest(tmpA);
          tmpB.set(tmpA.x + Math.sin(a) * 12, tmpA.y, tmpA.z + Math.cos(a) * 12);
          if (game.physics.lineOfSight(tmpA, tmpB)) clear++;
        }
        open.push(clear);
        c.expect(clear >= 18, `${w.name}: only ${clear}/36 open sight lines from the spawn`);
      }
      c.note(`${cubs.length} cubicles + ${all.length - cubs.length} small pieces, narrowest aisle ${narrowest.toFixed(2)} m, open sight lines ${open.join('/')}/36`);
    });
  });

  qa.add('office.cubicle_blocks_bolts_and_sight_then_crumbles', (c) => {
    inTheme('office', () => {
      const cub = cubicleAt(9.2, 9.0);
      const p = cub.position;
      const dir = new THREE.Vector3(p.x, 0, p.z).normalize();
      const ext = cub.extentToward(dir.x, dir.z);
      c.setup({ player: [p.x - dir.x * (ext + 5), p.z - dir.z * (ext + 5)], enemy: [p.x + dir.x * (ext + 1.2), p.z + dir.z * (ext + 1.2)] });
      c.expect(!game.physics.lineOfSight(c.player.chest(tmpA), c.enemy.chest(tmpB)), 'a cubicle does not block line of sight');
      const hp = c.enemy.health;
      c.step(1.2, () => {
        c.player.intent.holdBolt = true;
        c.player.mana = W.maxMana;
      });
      c.player.intent.holdBolt = false;
      c.step(0.5);
      const chipped = C.hp - cub.hp;
      c.expect(c.enemy.health === hp, `bolts went through a cubicle (${hp - c.enemy.health} dmg)`);
      c.expect(chipped > 0, 'cubicle took no damage from bolts');
      const shown = cub.describe();
      c.expect(shown.wholeVisible && !shown.stumpVisible, 'cubicle not standing before the crumble');
      let broke = 0;
      const off = events.on('pillarBreak', () => broke++);
      try {
        cub.damage(1e6, p.clone().setY(1));
      } finally {
        off();
      }
      const after = cub.describe();
      c.expect(!cub.alive && broke === 1 && !after.wholeVisible && after.stumpVisible, 'crumble did not swap to the desk stump');
      c.expect(game.arena.debris.geometry.type === 'BoxGeometry', 'office debris is not partition panels');
      game.physics.step();
      c.expect(game.physics.lineOfSight(c.player.chest(tmpA), c.enemy.chest(tmpB)), 'the desk stump still blocks chest-height sight');
      const before = c.enemy.health;
      c.player.intent.press('bolt');
      c.step(0.8);
      c.expect(c.enemy.health < before, 'bolts still blocked after the cubicle crumbled');
      game.resetArena();
      game.physics.step();
      const again = cub.describe();
      c.expect(cub.alive && cub.hp === C.hp && again.wholeVisible && !again.stumpVisible, 'round reset did not restore the cubicle');
      c.expect(!game.physics.lineOfSight(c.player.chest(tmpA), c.enemy.chest(tmpB)), 'restored cubicle has no collision');
      c.note(`bolts chipped ${chipped.toFixed(0)}/${C.hp} hp off the cubicle, none reached the wizard behind it`);
    });
  });

  qa.add('office.blast_and_ultimate_crumble_cubicles', (c) => {
    inTheme('office', () => {
      // Blasts at the foot of a cubicle chip it; enough of them crumble it.
      const cub = cubicleAt(15.6, 3.4);
      const p = cub.position;
      c.setup({ player: [p.x - 7, p.z], enemy: [-6, -12] });
      c.player.facing = c.player.intent.facing = Math.PI / 2;
      let blasts = 0;
      c.step(14, () => {
        c.player.aimPoint.set(p.x - C.size / 2, 0.5, p.z);
        c.player.mana = W.maxMana;
        c.player.cd.blast = 0;
        if (cub.alive && !c.player.cast && c.player.stats.casts === blasts) {
          c.player.intent.press('blast');
          blasts++;
        }
      });
      c.expect(!cub.alive, `${blasts} blasts never crumbled a cubicle (hp=${cub.hp.toFixed(1)})`);
      // The Ultimate's wave damages every cubicle it reaches.
      c.setup({ player: [0, 0], enemy: [0, 14] });
      const hp = cubicles().map((q) => q.hp);
      c.player.ult = S.ultimate.chargeMax;
      c.player.intent.press('ultimate');
      c.step(2.5);
      const hit = cubicles().filter((q, i) => q.hp < hp[i]).length;
      c.expect(hit === cubicles().length, `the Ultimate reached ${hit}/${cubicles().length} cubicles`);
      c.player.ult = S.ultimate.chargeMax;
      c.player.intent.press('ultimate');
      c.step(2.5);
      const down = cubicles().filter((q) => !q.alive).length;
      c.expect(down === cubicles().length, `two Ultimates crumbled ${down}/${cubicles().length} cubicles`);
      game.resetArena();
      c.expect(arena.pillars.every((q) => q.alive), 'round reset left office cover broken');
      c.note(`${blasts} blasts to crumble one; two Ultimates flatten all ${down}`);
    });
  });

  qa.add('office.land_on_cubicle_top_and_stump', (c) => {
    inTheme('office', () => {
      const cub = cubicleAt(15.6, 3.4);
      const p = cub.position;
      const edge = p.x - C.size / 2;
      c.setup({ player: [p.x - 7.5, p.z], enemy: [-6, -12] });
      const w = c.player;
      let worst = Infinity;
      const track = () => (worst = Math.min(worst, clearance(w, cub)));
      let jumped = false;
      // Run at it along +x, take off ~1.95 m before the edge, let go once over it.
      const landings = w.landings;
      stepUntil(() => w.landings > landings && w.grounded && w.pos.y > 0.5, 4, () => {
        w.intent.move.set(w.pos.x < edge + 0.5 ? 1 : 0, 0, 0);
        if (!jumped && edge - w.pos.x <= 1.95) {
          w.intent.press('jump');
          jumped = true;
        }
        track();
      });
      // Touchdown registers within the controller's skin; the ground probe settles it in a few ticks.
      w.intent.move.set(0, 0, 0);
      c.step(0.15, track);
      c.near(w.pos.y, C.height, 0.03, 'standing height on a cubicle');
      const y0 = w.pos.y;
      c.step(1, track);
      c.expect(w.grounded && Math.abs(w.pos.y - y0) < 0.005, `drifted on the cubicle: ${y0.toFixed(3)} -> ${w.pos.y.toFixed(3)}`);
      c.expect(cub.surfaceDistance(w.pos.x, w.pos.z) === 0, 'not over the cubicle');
      // Walk off the far side and land on the floor.
      w.intent.move.set(1, 0, 0);
      stepUntil(() => !w.grounded, 2, track);
      stepUntil(() => w.grounded, 2, track);
      c.step(0.2, track);
      c.expect(w.grounded && w.pos.y === 0, `did not end on the floor (y=${w.pos.y.toFixed(3)})`);
      // The crumbled desk stump is a lower step, like a pillar stump.
      c.setup({ player: [p.x - 7.5, p.z], enemy: [-6, -12] });
      cub.damage(1e6, p.clone().setY(1));
      game.physics.step();
      jumped = false;
      const l2 = w.landings;
      stepUntil(() => w.landings > l2 && w.grounded && w.pos.y > 0.3, 4, () => {
        w.intent.move.set(w.pos.x < edge + 0.6 ? 1 : 0, 0, 0);
        if (!jumped && edge - w.pos.x <= 1.6) {
          w.intent.press('jump');
          jumped = true;
        }
        track();
      });
      c.near(w.pos.y, C.stumpHeight, 0.05, 'standing height on the desk stump');
      c.note(`min clearance=${worst.toFixed(3)} m (apex ${APEX.toFixed(2)} m over ${C.height} m partitions)`);
      c.expect(worst > -0.02, `capsule went ${(-worst).toFixed(3)} m into a cubicle`);
    });
  });

  qa.add('office.camera_no_clip_and_under_ceiling', (c) => {
    inTheme('office', () => {
      const rig = game.rig;
      let worst = Infinity;
      let blocked = 0;
      let maxY = 0;
      for (const cub of cubicles().slice(0, 8)) {
        const away = cub.position.clone().setY(0).normalize().negate();
        const yaw = Math.atan2(away.x, away.z);
        const rx = -Math.cos(yaw), rz = Math.sin(yaw);
        for (const back of [1.6, 2.6]) {
          for (const pitch of [-0.07, 0.45]) {
            const ext = cub.extentToward(away.x, away.z);
            const bx = cub.position.x + away.x * (ext + back), bz = cub.position.z + away.z * (ext + back);
            c.setup({ player: [bx, bz], enemy: [0, 0] });
            rig.snap(c.player.pos, yaw);
            rig.pitch = pitch;
            for (let f = 0; f <= 40; f++) {
              const side = -2.5 + (5 * f) / 40;
              c.player.pos.set(bx + rx * side, 0, bz + rz * side);
              rig.update(1 / 60, c.player.pos, game.physics, false, false);
              const cam = rig.camera.position;
              if (cam.distanceTo(tmpA.copy(c.player.pos).setY(c.player.pos.y + CONFIG.camera.height)) < CONFIG.camera.distance - 0.3) blocked++;
              for (const p of arena.pillars) worst = Math.min(worst, pointGap(p, cam));
            }
          }
        }
      }
      // Highest the play camera gets: standing on a cubicle at the top of a jump, looking down, pulled back.
      c.setup({ player: [0, -4], enemy: [0, 8] });
      c.player.pos.y = C.height + APEX;
      rig.snap(c.player.pos, 0);
      rig.kickBack(4);
      rig.pitch = CONFIG.camera.minPitch;
      for (let i = 0; i < 90; i++) {
        rig.update(1 / 60, c.player.pos, game.physics, false, false);
        rig.pitch = CONFIG.camera.minPitch;
        maxY = Math.max(maxY, rig.camera.position.y);
      }
      const orbit = CONFIG.render.orbitHeight;
      c.note(`closest camera-to-cover=${worst.toFixed(3)} m, blocked frames=${blocked}, highest play camera ${maxY.toFixed(2)} m, menu orbit ${orbit} m, ceiling ${C.ceilingHeight} m`);
      c.expect(blocked > 10, 'test never put a cubicle behind the camera');
      c.expect(worst >= 0.15, `camera came within ${worst.toFixed(3)} m of office cover`);
      c.expect(maxY < C.ceilingHeight - 1 && orbit < C.ceilingHeight - 1, `camera reaches ${Math.max(maxY, orbit).toFixed(2)} m under a ${C.ceilingHeight} m ceiling`);
    });
  });

  qa.add('office.ai_cover_spots_and_finds_hidden_player', (c) => {
    inTheme('office', () => {
      // Retreat cover: spots behind office cover, outside every footprint, hidden from the target.
      c.setup({ player: [0, -8], enemy: [0, 8] });
      const ai = new AIController(game.enemy, game.player, game.spells, game.physics, game.arena, 'normal');
      const brain = ai as unknown as { findCover(): void; hasCover: boolean; coverPoint: THREE.Vector3 };
      let hidden = 0;
      const trials = 6;
      try {
        for (let k = 0; k < trials; k++) {
          const a = (k / trials) * Math.PI * 2;
          c.setup({ player: [Math.sin(a) * 12, Math.cos(a) * 12], enemy: [-Math.sin(a) * 4, -Math.cos(a) * 4] });
          brain.findCover();
          c.expect(brain.hasCover, 'AI found no cover in the office');
          const spot = brain.coverPoint;
          const inside = arena.pillars.some((p) => p.surfaceDistance(spot.x, spot.z) < W.radius);
          c.expect(!inside, `cover spot (${spot.x.toFixed(1)}, ${spot.z.toFixed(1)}) is inside office cover`);
          tmpB.set(spot.x, 1.2, spot.z);
          if (!game.physics.lineOfSight(c.player.chest(tmpA), tmpB)) hidden++;
        }
      } finally {
        ai.dispose();
      }
      c.expect(hidden >= trials - 1, `only ${hidden}/${trials} cover spots are hidden from the target`);

      // A player crouched behind the inner pod: the AI walks around and lands hits.
      const pod = cubicleAt(5.6, -1.1);
      const hide: [number, number] = [pod.position.x + C.size / 2 + 0.9, -0.4];
      c.setup({ player: hide, enemy: [0, 8] });
      c.expect(!game.physics.lineOfSight(c.player.chest(tmpA), c.enemy.chest(tmpB)), 'test setup: player not hidden');
      const hunter = new AIController(game.enemy, game.player, game.spells, game.physics, game.arena, 'normal');
      let firstHit = -1;
      let t = 0;
      try {
        c.step(25, () => {
          hunter.update(DT);
          t += DT;
          c.player.intent.move.set(0, 0, 0);
          if (c.player.health < W.maxHealth && firstHit < 0) firstHit = t;
          c.player.health = W.maxHealth;
        });
      } finally {
        hunter.dispose();
      }
      c.note(`cover spots hidden ${hidden}/${trials}; first hit on a hidden player after ${firstHit.toFixed(1)} s (AI casts ${c.enemy.stats.casts}, hits ${c.enemy.stats.hits})`);
      c.expect(firstHit > 0, 'AI never hit a player hiding behind a cubicle in 25 s');
    });
  });

  qa.add('office.ai_duel_in_the_office', (c) => {
    inTheme('office', () => {
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
          const left = CONFIG.match.roundTime - t;
          if (left < A.suddenDeathAt) arena.fireRadius = A.suddenDeathMinRadius + (A.fireRadius - A.suddenDeathMinRadius) * (left / A.suddenDeathAt);
          for (const w of game.wizards) {
            if (!Number.isFinite(w.pos.x + w.pos.z)) bad = 'NaN';
            for (const p of arena.pillars) if (clearance(w, p) < -0.05) bad = `${w.name} inside a ${p.shape.kind}`;
          }
        }
      } finally {
        a.dispose();
        b.dispose();
      }
      const lost = [c.player, c.enemy].map((w) => w.maxHealth - w.health);
      c.note(`round ${t.toFixed(1)} s, ${!c.player.alive || !c.enemy.alive ? 'KO' : 'time'}, damage taken ${lost.map((v) => v.toFixed(0)).join('/')}, hits ${c.player.stats.hits}/${c.enemy.stats.hits}`);
      c.expect(!bad, bad);
      c.expect(lost[0] > 20 && lost[1] > 20, 'the AIs barely hurt each other in the office');
    });
  });

  qa.add('office.generated_glbs_fit_when_present', (c) => {
    const notes: string[] = [];
    // The real files, if they exist and have loaded (loads start when these scenarios register).
    const checks: [ArenaThemeId, () => void][] = [
      ['city', () => {
        const col = arena.pillars[0].column!;
        col.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(col);
        c.near(box.max.y - box.min.y, A.pillars.height, 0.06, 'city column height');
        c.near(pillarFitScale(col), 1, 0.12, 'city shaft/collider ratio');
      }],
      ['office', () => {
        game.renderer.scene.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(cubicles()[0].column!);
        const size = box.getSize(new THREE.Vector3());
        c.near(size.y, C.height, 0.05, 'office cubicle height');
        c.near(Math.max(size.x, size.z), C.size, 0.06, 'office cubicle footprint');
      }],
    ];
    for (const [id, check] of checks) {
      const spec = THEME_ASSETS[id].pillar;
      if (!resolveAsset(spec.path)) {
        notes.push(`${id}: no pillar.glb (procedural)`);
        continue;
      }
      const t = game.assets.peekModel(spec.path);
      if (t === undefined) {
        notes.push(`${id}: pillar.glb still loading, skipped`);
        continue;
      }
      inTheme(id, () => {
        c.expect((arena.pillars.find((p) => p.shape.kind === 'pillar' || p.shape.kind === 'cubicle')!.describe().key ?? '').startsWith(`${id}:glb`), `${id}: GLB cover not shown`);
        check();
      });
      notes.push(`${id}: GLB fits`);
    }
    c.note(notes.join('; '));
  });

  qa.add('office.glb_cubicle_fits_box_collider', (c) => {
    // A stand-in "generated" cubicle in Tripo proportions (1 x 0.678 x 1, facing +X).
    const mat = new THREE.MeshStandardMaterial({ color: 0x8a9098 });
    const fake = new THREE.Group();
    const parts = [
      new THREE.Mesh(new THREE.BoxGeometry(1, 0.678, 0.04), mat),
      new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.678, 1), mat),
      new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.03, 0.3), mat),
    ];
    parts[0].position.set(0, 0.339, -0.48);
    parts[1].position.set(-0.48, 0.339, 0);
    parts[2].position.set(-0.1, 0.33, -0.3);
    fake.add(...parts);
    const spec = THEME_ASSETS.office.pillar;
    const real = game.assets.peekModel(spec.path);
    inTheme('office', () => {
      try {
        game.assets.provideModel(spec, fake, 'qa-fake-cubicle');
        void arena.invalidateThemeAssets('office');
        const cub = cubicles()[2];
        c.expect((cub.describe().key ?? '').startsWith('office:glb'), `GLB cubicle not shown (${cub.describe().key})`);
        game.renderer.scene.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(cub.column!);
        const size = box.getSize(new THREE.Vector3());
        c.near(size.x, C.size, 0.05, 'width');
        c.near(size.z, C.size, 0.05, 'depth');
        c.near(size.y, C.height, 0.05, 'height');
        c.expect(Math.abs(box.min.y) < 0.03, `model floats or sinks (min y ${box.min.y.toFixed(2)})`);
        const center = box.getCenter(new THREE.Vector3());
        c.expect(Math.hypot(center.x - cub.position.x, center.z - cub.position.z) < 0.05, 'model off its collider');
        // Cabinets, copiers and coolers keep their procedural looks next to the GLB cubicles.
        const cab = arena.pillars.find((p) => p.shape.kind === 'cabinet')!;
        c.expect(!!cab.column && cab.column.children.length > 0, 'cabinets lost their look');
      } finally {
        game.assets.forgetModel(spec.path);
        void arena.invalidateThemeAssets('office');
      }
      c.expect(cubicles()[2].describe().key === 'office', 'procedural cubicle not restored');
    });
    for (const p of parts) p.geometry.dispose();
    mat.dispose();
    c.note(real ? 'the generated office/pillar.glb is on disk too' : 'no generated cubicle on disk (procedural in play)');
  });

  qa.add('office.dev_theme_override_new_themes', (c) => {
    const dev = arena.devTheme;
    const start = arena.theme;
    try {
      for (const id of ['city', 'office'] as const) {
        arena.devTheme = id;
        void arena.applyTheme('moonlit');
        c.expect(arena.theme === id, `?theme=${id} ignored (${arena.theme})`);
        c.expect(arena.layout === (id === 'office' ? 'cubicles' : 'streets'), `?theme=${id} has layout ${arena.layout}`);
      }
      arena.devTheme = null;
      void arena.applyTheme('moonlit');
      c.expect(arena.layout === 'rings' && arena.pillars.length === 14, 'moonlit did not get its pillar rings back');
    } finally {
      arena.devTheme = null;
      void arena.applyTheme(start);
      arena.devTheme = dev;
    }
  });
}
