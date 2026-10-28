import * as THREE from 'three';
import { CONFIG } from '../config';
import { pillarFitScale } from '../arena/themeKit';
import { THEME_IDS, THEMES, type ArenaThemeId } from '../arena/themes';
import { THEME_ASSETS } from '../assets/manifest';
import type { Game } from '../core/Game';
import type { QAHarness } from './QAHarness';

const A = CONFIG.arena;
const W = CONFIG.wizard;
/** Draw calls allowed per frame (shadow pass and post-processing included). */
const DRAW_CALL_BUDGET = 230;

/** Arena size, fire, layout and environment-theme scenarios. */
export function registerArenaScenarios(qa: QAHarness, game: Game): void {
  const arena = game.arena;
  const renderer = game.renderer;
  const gl = renderer.renderer;

  /** Run with the `?theme=` override off, then restore the theme that was showing. */
  const withThemes = (fn: () => void) => {
    const dev = arena.devTheme;
    const start = arena.theme;
    arena.devTheme = null;
    try {
      fn();
    } finally {
      void arena.applyTheme(start);
      arena.devTheme = dev;
    }
  };
  const render = () => {
    renderer.render();
    return gl.info.render.calls;
  };
  const glErrors = () => {
    const ctx = gl.getContext();
    const errs: number[] = [];
    for (let e = ctx.getError(), n = 0; e !== ctx.NO_ERROR && n < 8; e = ctx.getError(), n++) errs.push(e);
    // three attaches `diagnostics` to programs that failed to compile or link.
    const programs = (gl.info.programs ?? []) as unknown as { diagnostics?: { runnable: boolean } }[];
    const bad = programs.filter((p) => p.diagnostics && !p.diagnostics.runnable).length;
    return { errs, bad };
  };

  qa.add('arena.wall_contains_every_direction', (c) => {
    let worst = 0;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2 + 0.13;
      const dx = Math.sin(a), dz = Math.cos(a);
      c.setup({ player: [dx * 3, dz * 3], enemy: [-dx * 4, -dz * 4] });
      arena.fireRadius = 1e3; // fire off: test the hard wall itself
      c.step(7, () => {
        arena.fireRadius = 1e3;
        c.player.intent.move.set(dx, 0, dz);
        c.player.intent.sprint = true;
        c.player.mana = W.maxMana;
        c.player.intent.press('dodge');
      });
      c.player.addKnockback(dx, dz, 40);
      c.step(0.5, () => (arena.fireRadius = 1e3));
      const r = Math.hypot(c.player.pos.x, c.player.pos.z);
      worst = Math.max(worst, r);
      c.expect(r < A.wallRadius, `escaped the wall heading ${(a * 180 / Math.PI).toFixed(0)}°: r=${r.toFixed(2)}`);
      c.expect(r > A.wallRadius - 1.5, `never reached the wall heading ${(a * 180 / Math.PI).toFixed(0)}° (r=${r.toFixed(2)}; blocked by a pillar?)`);
    }
    c.note(`max r=${worst.toFixed(2)} (wall ${A.wallRadius})`);
  });

  qa.add('arena.fire_burns_at_new_radius', (c) => {
    // Just inside the fire: safe.
    const safe = A.fireRadius - W.radius - 0.25;
    c.setup({ player: [safe, 0], enemy: [0, -4] });
    c.step(0.6);
    c.expect(c.player.health === W.maxHealth, `burned at r=${safe.toFixed(1)}, inside the fire ring`);
    // Touching it: burns and shoves inward.
    const hot = A.fireRadius + 0.1;
    c.setup({ player: [hot, 0], enemy: [0, -4] });
    c.step(0.4);
    const r = Math.hypot(c.player.pos.x, c.player.pos.z);
    c.expect(c.player.health < W.maxHealth, `no burn at r=${hot.toFixed(1)}`);
    c.expect(r < hot - 0.3, `not pushed inward (r=${r.toFixed(2)})`);
    // The flames are drawn where the damage is.
    game.fire.updateVisual(0, arena.fireRadius);
    c.near(game.fire.describe().radius, A.fireRadius, 0.01, 'visual fire radius');
    // Sudden death: the ring has closed to its minimum radius.
    c.setup({ player: [0, A.suddenDeathMinRadius + 0.2], enemy: [0, -3] });
    arena.fireRadius = A.suddenDeathMinRadius;
    c.step(0.4, () => (arena.fireRadius = A.suddenDeathMinRadius));
    c.expect(c.player.health < W.maxHealth, 'sudden-death ring did not burn');
  });

  qa.add('arena.layout_and_spawns', (c) => {
    const expected = A.pillars.rings.reduce((n, r) => n + r.count, 0);
    c.expect(arena.pillars.length === expected, `${arena.pillars.length} pillars, expected ${expected}`);
    const P = A.pillars;
    let minGap = Infinity;
    for (const p of arena.pillars) {
      const r = Math.hypot(p.position.x, p.position.z);
      c.expect(r + P.radius < A.fireRadius - 3, `pillar at r=${r.toFixed(1)} crowds the fire`);
      for (const q of arena.pillars) if (q !== p) minGap = Math.min(minGap, p.position.distanceTo(q.position) - 2 * P.radius);
    }
    c.expect(minGap > 4 * W.radius + 1, `pillars only ${minGap.toFixed(1)} m apart`);
    // Spawns face each other with nothing in between.
    c.setup();
    game.spawnWizards();
    const d = A.spawnDistance / 2;
    c.expect(Math.abs(c.player.pos.z + d) < 0.01 && Math.abs(c.enemy.pos.z - d) < 0.01, 'wizards not on their spawn marks');
    const los = game.physics.lineOfSight(c.player.chest(new THREE.Vector3()), c.enemy.chest(new THREE.Vector3()));
    c.expect(los, 'a pillar blocks the spawn line');
    for (const p of arena.pillars) {
      c.expect(Math.abs(p.position.z) > d + 1 || Math.abs(p.position.x) > P.radius + 2, 'pillar sits on the spawn line');
    }
    c.note(`${expected} pillars, min gap ${minGap.toFixed(1)} m, spawn distance ${A.spawnDistance} m`);
  });

  qa.add('arena.themes_apply_and_differ', (c) => {
    withThemes(() => {
      void arena.applyTheme('moonlit');
      const base = arena.describe();
      render();
      glErrors();
      for (const id of THEME_IDS) {
        if (id === 'moonlit') continue;
        void arena.applyTheme(id);
        render();
        const d = arena.describe();
        const t = THEMES[id];
        const e = glErrors();
        c.expect(e.errs.length === 0, `${id}: WebGL errors ${e.errs.join(',')}`);
        c.expect(e.bad === 0, `${id}: ${e.bad} shader programs failed to compile`);
        c.expect(d.theme === id, `${id}: theme not set`);
        c.expect((d.fog as unknown[])[0] === new THREE.Color(t.fog.color).getHexString(), `${id}: fog colour not applied`);
        for (const k of ['fog', 'skyHorizon', 'fire', 'hemi', 'floor', 'props', 'pillar', 'brazier']) {
          c.expect(JSON.stringify(d[k]) !== JSON.stringify(base[k]), `${id}: ${k} unchanged from moonlit`);
        }
        c.expect(String(d.pillar).startsWith(id), `${id}: pillars show ${d.pillar}`);
      }
      c.note(`${THEME_IDS.length} themes applied, render clean`);
    });
  });

  qa.add('arena.moonlit_restores_original', (c) => {
    withThemes(() => {
      void arena.applyTheme('moonlit');
      const before = JSON.stringify(arena.describe());
      for (const id of THEME_IDS) void arena.applyTheme(id);
      void arena.applyTheme('moonlit');
      const after = arena.describe();
      c.expect(JSON.stringify(after) === before, `moonlit differs after a round trip:\n${before}\n${JSON.stringify(after)}`);
      // And moonlit is still the original look.
      const fire = after.fire as { root: number[]; glow: number[] };
      c.expect((after.fog as unknown[])[0] === '140c22', 'moonlit fog colour changed');
      c.expect(JSON.stringify(after.skyHorizon) === JSON.stringify([0.32, 0.13, 0.22]), 'moonlit sky changed');
      c.expect(fire.glow.map((v) => +v.toFixed(3)).join() === '1,0.38,0.08', 'moonlit fire glow changed');
      c.expect(fire.root.map((v) => +v.toFixed(3)).join() === '1,0.62,0.18', 'moonlit flame colour changed');
      c.expect(JSON.stringify(after.hemi) === JSON.stringify(['6a78c8', '2a1a24', 1.1]), 'moonlit hemisphere light changed');
      c.expect(after.ground !== null && (after.ground as unknown[])[0] === '1a1420', 'moonlit outer ground changed');
      c.expect(JSON.stringify(after.ambient) === '[false,false]', 'moonlit has ambient particles');
    });
  });

  qa.add('arena.pillars_block_and_crumble_every_theme', (c) => {
    withThemes(() => {
      for (const id of THEME_IDS) {
        void arena.applyTheme(id);
        const pillar = arena.pillars[0];
        const p = pillar.position;
        const dir = new THREE.Vector3(p.x, 0, p.z).normalize();
        c.setup({ player: [p.x - dir.x * 6, p.z - dir.z * 6], enemy: [p.x + dir.x * 3, p.z + dir.z * 3] });
        const hp = c.enemy.health;
        c.player.intent.press('bolt');
        c.step(0.6);
        c.expect(c.enemy.health === hp, `${id}: bolt went through a pillar`);
        c.expect(pillar.hp < pillar.shape.hp, `${id}: pillar took no damage`);
        const shown = pillar.describe();
        c.expect(shown.wholeVisible && !shown.stumpVisible, `${id}: pillar not standing before the crumble`);
        pillar.damage(1e6, p.clone().setY(1.2));
        const broken = pillar.describe();
        c.expect(!pillar.alive && !broken.wholeVisible && broken.stumpVisible, `${id}: crumble did not swap to the stump`);
        c.step(0.5);
        const before = c.enemy.health;
        c.player.intent.press('bolt');
        c.step(0.8);
        c.expect(c.enemy.health < before, `${id}: bolt still blocked after the pillar crumbled`);
        arena.reset();
        const again = pillar.describe();
        c.expect(pillar.alive && again.wholeVisible && !again.stumpVisible, `${id}: reset did not restore the pillar`);
      }
      c.note(`blocked and crumbled under ${THEME_IDS.length} themes`);
    });
  });

  qa.add('arena.theme_cycle_no_leaks', (c) => {
    withThemes(() => {
      const scene = renderer.scene;
      // Warm up: every theme built and drawn once.
      for (const id of THEME_IDS) {
        void arena.applyTheme(id);
        render();
      }
      void arena.applyTheme('moonlit');
      render();
      const children = scene.children.length;
      const mem = { ...gl.info.memory };
      const programs = gl.info.programs?.length ?? 0;
      let peakTex = 0, peakGeo = 0;
      for (let cycle = 0; cycle < 10; cycle++) {
        for (const id of [...THEME_IDS.slice(1), 'moonlit'] as ArenaThemeId[]) {
          void arena.applyTheme(id);
          render();
          peakTex = Math.max(peakTex, gl.info.memory.textures);
          peakGeo = Math.max(peakGeo, gl.info.memory.geometries);
          c.expect(scene.children.length === children, `scene.children ${children} -> ${scene.children.length} after ${id}`);
        }
      }
      const now = gl.info.memory;
      c.expect(now.textures === mem.textures, `textures ${mem.textures} -> ${now.textures}`);
      c.expect(now.geometries === mem.geometries, `geometries ${mem.geometries} -> ${now.geometries}`);
      c.expect((gl.info.programs?.length ?? 0) <= programs, `shader programs ${programs} -> ${gl.info.programs?.length}`);
      c.note(`children=${children} textures=${mem.textures} (peak ${peakTex}) geometries=${mem.geometries} (peak ${peakGeo}) programs=${programs}`);
    });
  });

  qa.add('arena.drawcalls_per_theme', (c) => {
    const rig = game.rig;
    const wasOrbit = rig.orbit;
    const notes: string[] = [];
    withThemes(() => {
      for (const id of THEME_IDS) {
        void arena.applyTheme(id);
        c.setup();
        game.spawnWizards();
        rig.orbit = false;
        rig.update(1 / 60, c.player.pos, game.physics, false, false);
        const play = render();
        rig.orbit = true;
        rig.updateOrbit(0);
        const menu = render();
        notes.push(`${id} ${play}/${menu}`);
        c.expect(Math.max(play, menu) <= DRAW_CALL_BUDGET, `${id}: ${Math.max(play, menu)} draw calls (budget ${DRAW_CALL_BUDGET})`);
      }
    });
    rig.orbit = wasOrbit;
    c.note(`draw calls play/menu: ${notes.join(', ')}`);
  });

  qa.add('arena.glb_pillar_fits_collider', (c) => {
    // A stand-in "generated" pillar: wrong scale, a wide base and capital around a 2.4 m shaft.
    const mat = new THREE.MeshStandardMaterial({ color: 0x998877 });
    const fake = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 8, 16, 6), mat);
    shaft.position.y = 5;
    const base = new THREE.Mesh(new THREE.BoxGeometry(4, 1, 4), mat);
    base.position.y = 0.5;
    const cap = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.8, 3.6), mat);
    cap.position.y = 9.4;
    fake.add(shaft, base, cap);
    const spec = THEME_ASSETS.glacier.pillar;
    withThemes(() => {
      try {
        game.assets.provideModel(spec, fake, 'qa-fake-pillar');
        void arena.applyTheme('glacier');
        void arena.invalidateThemeAssets('glacier');
        const pillar = arena.pillars[3];
        const key = pillar.describe().key ?? '';
        c.expect(key.startsWith('glacier:glb'), `GLB pillar not shown (${key})`);
        const col = pillar.column!;
        col.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(col);
        const h = box.max.y - box.min.y;
        c.near(h, A.pillars.height, 0.05, 'height');
        const fit = pillarFitScale(col);
        c.near(fit, 1, 0.08, 'shaft/collider ratio');
        c.expect(box.min.y > -0.05 && box.min.y < 0.05, `model floats or sinks (min y ${box.min.y.toFixed(2)})`);
      } finally {
        game.assets.forgetModel(spec.path);
        void arena.invalidateThemeAssets('glacier');
      }
      c.expect(arena.pillars[3].describe().key === 'glacier', 'placeholder pillar not restored');
    });
    shaft.geometry.dispose();
    base.geometry.dispose();
    cap.geometry.dispose();
  });

  qa.add('arena.dev_theme_override', (c) => {
    const dev = arena.devTheme;
    const start = arena.theme;
    try {
      arena.devTheme = 'volcano';
      void arena.applyTheme('moonlit');
      c.expect(arena.theme === 'volcano', `?theme override ignored (${arena.theme})`);
      void arena.applyTheme('glacier');
      c.expect(arena.theme === 'glacier', 'boss theme overridden by ?theme');
    } finally {
      arena.devTheme = null;
      void arena.applyTheme(start);
      arena.devTheme = dev;
    }
  });
}
