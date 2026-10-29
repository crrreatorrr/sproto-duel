import * as THREE from 'three';
import { CONFIG } from '../config';
import type { App } from '../App';
import { BOSSES } from '../campaign/levels';
import { events, type GameEvents } from '../core/events';
import type { Game } from '../core/Game';
import type { BossStages } from '../campaign/BossStages';
import type { Wizard } from '../wizard/Wizard';
import type { QAHarness } from './QAHarness';
import { lookPixels, type LookPixels } from './pixels';
import { GROUP } from '../physics/Physics';
import type { CineCue } from '../campaign/transformStyles';

const K = CONFIG.campaign.cinematic;
const C = CONFIG.campaign;
const DT = CONFIG.sim.fixedDt;
const FRAME = 1 / 60;

export type Ctx = Parameters<Parameters<QAHarness['add']>[1]>[0];

function record<K extends keyof GameEvents>(type: K): () => GameEvents[K][] {
  const seen: GameEvents[K][] = [];
  const off = events.on(type, (e) => void seen.push({ ...e }));
  return () => {
    off();
    return seen;
  };
}

const intersects = (a: DOMRect, b: { left: number; right: number; top: number; bottom: number }) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/**
 * Run `fn` in a live gauntlet fight against BOSSES[index] with cinematics playing (they never do
 * under QA otherwise), the loop driven by hand through Game.advance (no rAF), then leave it.
 */
export function withLiveFight(c: Ctx, game: Game, app: App, index: number, fn: () => void, setup?: Parameters<Ctx['setup']>[0]): void {
  const cine = app.cinematic;
  try {
    app.campaign.index = index;
    app.startBossFight();
    game.stages.suspended = game.partnerStages.suspended = false; // the sandbox restores them
    game.setupEnemy(BOSSES[index]);
    c.setup(setup ?? { player: [0, -8], enemy: [0, 8] });
    app.match.phase = 'fight';
    game.actionsLocked = false;
    game.simulating = true;
    game.playerControl = true;
    cine.allowInQa = true;
    fn();
  } finally {
    cine.allowInQa = false;
    cine.abort();
    game.simulating = false;
    game.playerControl = false;
    app.toMenu();
  }
}

/** Advance `seconds` of real frames through the whole loop (input, sim, camera, render, hooks). */
export function frames(game: Game, seconds: number, each?: () => void): void {
  const n = Math.round(seconds / FRAME);
  for (let i = 0; i < n; i++) {
    each?.();
    game.advance(FRAME);
  }
}

/** Put a boss straight into `stage` (full bar), without leaving a cinematic for it behind. */
export function jump(st: BossStages, stage: number): void {
  st.evolveTo(stage);
  st.release(0);
  cineOf(st)?.abort();
}

let cineOf: (st: BossStages) => App['cinematic'] | null = () => null;

/** Empty `w`'s current stage bar with one big hit from the player. */
export function deplete(game: Game, w: Wizard): void {
  game.spells.dealDamage(w, game.player, (w.health + 500) / game.player.damageMultiplier, w.chest(new THREE.Vector3()), 'blast');
}

/** Screen rect of a wizard's look: the cylinder it stands in (posed root, look radius, top). */
export function screenRect(game: Game, w: Wizard): { left: number; right: number; top: number; bottom: number } {
  const v = w.visual;
  const r = v.boundsRadius * v.root.scale.x;
  const base = v.root.position;
  const box = new THREE.Box3(new THREE.Vector3(base.x - r, base.y, base.z - r), new THREE.Vector3(base.x + r, base.y + v.topHeight * v.root.scale.y, base.z + r));
  const cam = game.renderer.camera;
  cam.updateMatrixWorld();
  const out = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
  const p = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(cam);
    const x = (p.x * 0.5 + 0.5) * innerWidth, y = (-p.y * 0.5 + 0.5) * innerHeight;
    out.left = Math.min(out.left, x);
    out.right = Math.max(out.right, x);
    out.top = Math.min(out.top, y);
    out.bottom = Math.max(out.bottom, y);
  }
  return out;
}

/**
 * Up to `count` boss spots hemmed in by cover: right up against the obstacles nearest his spawn,
 * on every side of them (behind him, beside him, in front), so some side of any orbit runs into
 * cover. Never in lava, the fire ring, near the player at (0, -8), or overlapping anything solid;
 * nearest the boss's spawn first and at least 2.5 m apart.
 */
function coverSpots(game: Game, count: number): [number, number][] {
  const out: [number, number][] = [];
  const spawn = new THREE.Vector3(0, 0, 8);
  const reach = game.arena.fireRadius - 3;
  const cands: { x: number; z: number; d: number }[] = [];
  const solid = (x: number, z: number) =>
    game.physics.sphereCast(new THREE.Vector3(x, 1.8, z), new THREE.Vector3(0, -1.3, 0), CONFIG.wizard.radius + 0.25, GROUP.WORLD) !== null;
  for (const p of game.arena.pillars) {
    if (!p.active || !p.alive || p.shape.height < 1.2) continue;
    const sh = p.shape;
    const cy = Math.cos(sh.yaw), sy = Math.sin(sh.yaw);
    const cx = p.position.x + sh.cx * cy + sh.cz * sy, cz = p.position.z - sh.cx * sy + sh.cz * cy;
    const ext = Math.max(sh.halfX, sh.halfZ, sh.radius);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      for (const gap of [0.9, 1.5]) {
        const d = ext + gap + CONFIG.wizard.radius;
        const x = cx + Math.sin(a) * d, z = cz + Math.cos(a) * d;
        if (Math.hypot(x, z) > reach || game.arena.hazardAt(x, z, 1) || Math.hypot(x, z + 8) < 6 || solid(x, z)) continue;
        cands.push({ x, z, d: Math.hypot(x - spawn.x, z - spawn.z) });
        break;
      }
    }
  }
  cands.sort((a, b) => a.d - b.d);
  for (const c of cands) {
    if (out.some(([ox, oz]) => Math.hypot(ox - c.x, oz - c.z) < 2.5)) continue;
    out.push([+c.x.toFixed(2), +c.z.toFixed(2)]);
    if (out.length >= count) break;
  }
  return out;
}

/**
 * Play the current shot through its slam (the camera only, 1/30 s frames) and return the camera's
 * distance from the boss as a share of the planned one, worst over the burst and the slam, and how
 * far (px, + = clear) the top of his look stays below the top letterbox bar at the slam.
 */
function shotCamera(game: Game, app: App): { burst: number; slam: number; head: number; lift: number } {
  const cine = app.cinematic;
  const D = cine.state!.duration;
  const tB = K.burstAt * D, tS = K.slamAt * D;
  const tier2 = game.ui.querySelector('.cine.tier2') !== null;
  const bar = (tier2 ? 0.15 : 0.12) * innerHeight;
  const out = { burst: Infinity, slam: Infinity, head: Infinity, lift: cine.state!.camera.lift };
  const p = new THREE.Vector3();
  for (let guard = 0; guard < 400; guard++) {
    game.advance(1 / 30);
    const s = cine.state;
    if (!s || s.phase !== 'play' || s.t > tS + 0.12) break;
    const ratio = s.camera.planned > 0 ? s.camera.actual / s.camera.planned : 0;
    if (s.t >= tB && s.t <= tB + 0.15) out.burst = Math.min(out.burst, ratio);
    if (s.t >= tS) {
      out.slam = Math.min(out.slam, ratio);
      const v = s.wizard.visual;
      const cam = game.renderer.camera;
      cam.updateMatrixWorld();
      p.set(v.root.position.x, v.root.position.y + v.topHeight * v.root.scale.y, v.root.position.z).project(cam);
      out.head = Math.min(out.head, (-p.y * 0.5 + 0.5) * innerHeight - bar);
    }
  }
  return out;
}

/** Advance real frames (1/60 s) until the shot reaches cinematic time `t` (false if it ends first). */
function untilShot(game: Game, app: App, t: number): boolean {
  for (let guard = 0; guard < 600; guard++) {
    const s = app.cinematic.state;
    if (!s || s.phase !== 'play') return false;
    if (s.t >= t) return true;
    game.advance(FRAME);
  }
  return false;
}

/**
 * Boss transformation cinematics (src/campaign/BossCinematic.ts): they freeze combat (no ticks, no
 * damage, no input), frame the boss, return the camera to the player, escalate for stage 3, play
 * for one double-fight boss at a time (the other's fall changes nothing), keep their title card clear
 * of the boss and the timer, pause with the game, and never play headless.
 */
export function registerCinematicScenarios(qa: QAHarness, game: Game, app: App): void {
  const cine = app.cinematic;
  cineOf = () => cine;

  qa.add('cinematic.freezes_combat_returns_camera_no_input', (c) => {
    withLiveFight(c, game, app, 0, () => {
      const p = game.player, e = game.enemy;
      const st = game.stages;
      // A bolt in flight, and a burning player (lava/fire must not tick during the freeze).
      c.aimAt(p, e);
      p.intent.press('bolt');
      c.step(DT * 4);
      const bolt = game.spells.pool.active.find((x) => x.owner === p);
      c.expect(!!bolt, 'no bolt in flight');
      const beats = record('bossCinematic');
      deplete(game, e);
      c.expect(cine.active && st.transforming && e.alive && e.evolving, `no cinematic (active ${cine.active})`);
      c.expect(cine.state?.duration === K.duration[1], `stage 2 cinematic lasts ${cine.state?.duration}`);
      // Into the freeze.
      frames(game, K.easeIn + 0.1);
      c.expect(game.cinematicScale === 0, `world not frozen (scale ${game.cinematicScale})`);
      const sim = game.simTime;
      const boltPos = bolt!.pos.clone();
      const pPos = p.pos.clone();
      const hp = p.health;
      p.pos.set(CONFIG.arena.fireRadius - 0.2, 0, 0); // in the fire: no burn while frozen
      const casts = p.stats.casts;
      // Input during the cinematic: keys and the mouse.
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2' }));
      game.renderer.canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
      frames(game, 0.3);
      window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
      for (const code of ['Digit1', 'Digit2']) window.dispatchEvent(new KeyboardEvent('keyup', { code }));
      // Mid-shot: the camera frames the boss between the letterbox bars.
      const cam = game.renderer.camera.position;
      const dBoss = cam.distanceTo(e.pos), dPlayer = cam.distanceTo(pPos);
      c.expect(dBoss < 9 && dBoss < dPlayer, `camera ${dBoss.toFixed(1)} m from the boss, ${dPlayer.toFixed(1)} m from the player`);
      c.expect(game.ui.classList.contains('cinematic') && game.ui.querySelector('.cine.on') !== null, 'no letterbox / cinematic HUD state');
      frames(game, K.duration[1] * 0.4);
      c.expect(game.simTime === sim, `the sim advanced ${(game.simTime - sim).toFixed(3)} s during the cinematic`);
      c.expect(bolt!.pos.distanceTo(boltPos) < 1e-9, 'a projectile moved during the freeze');
      c.expect(p.health === hp, `the player took ${hp - p.health} damage during the freeze`);
      c.expect(p.stats.casts === casts && Object.values(p.intent.buffered).every((v) => v === 0) && !p.intent.holdBolt, 'input during the cinematic reached the spells');
      p.pos.copy(pPos);
      p.prevPos.copy(pPos);
      // To the end: camera back on the player's shoulder, control back, the boss in stage 2 on a full bar.
      let guard = 0;
      while (cine.active && guard++ < 600) game.advance(FRAME);
      c.expect(!cine.active && game.cinematicScale === 1 && game.director === null, `cinematic never ended (scale ${game.cinematicScale})`);
      c.expect(!game.ui.classList.contains('cinematic'), 'HUD still in cinematic mode');
      const t = guard * FRAME;
      const expect = K.duration[1] * (1 - (K.easeIn + 0.4 + K.duration[1] * 0.4) / K.duration[1]) + K.resume + K.easeOut;
      c.expect(Math.abs(t - expect) < 0.5, `remaining shot ${t.toFixed(2)} s, expected ~${expect.toFixed(2)} s`);
      c.expect(st.stage === 1 && !st.transforming && e.maxHealth === BOSSES[0].stageHealth[1] && e.health === e.maxHealth, `after: stage ${st.stage + 1}, ${e.health}/${e.maxHealth}`);
      frames(game, 0.1);
      const back = game.renderer.camera.position.distanceTo(p.pos);
      c.expect(back < CONFIG.camera.distance + 2.5, `camera ${back.toFixed(1)} m from the player after the return`);
      c.expect(p.stats.casts === casts, `the keys pressed during the cinematic cast ${p.stats.casts - casts} spells afterwards`);
      frames(game, K.grace + 0.2);
      c.expect(!e.evolving, 'boss still frozen after the grace');
      const b: string[] = beats().map((x) => x.beat);
      c.expect(['start', 'burst', 'slam', 'resume', 'end'].every((x) => b.includes(x)) && b.filter((x) => x === 'count').length === 3, `beats ${b.join(',')}`);
      c.note(`shot end-to-end, camera back at ${back.toFixed(1)} m`);
    });
  });

  qa.add('cinematic.stage3_bigger_and_pauses', (c) => {
    withLiveFight(c, game, app, 4, () => {
      const e = game.enemy, st = game.stages;
      jump(st, 1);
      c.step(DT);
      deplete(game, e);
      c.expect(cine.state?.stage === 2 && cine.state.duration === K.duration[2] && K.duration[2] > K.duration[1], `stage 3 shot: stage ${cine.state?.stage}, ${cine.state?.duration} s`);
      c.expect(game.ui.querySelector('.cine.tier2') !== null, 'stage 3 is not the bigger cinematic');
      frames(game, K.duration[2] * K.burstAt + 0.3);
      const title = game.ui.querySelector('.cine-title')?.textContent ?? '';
      c.expect(title === BOSSES[4].stages[2].name, `card title "${title}"`);
      // Pausing freezes the cinematic, title card included.
      const t = cine.state!.t;
      const card = (game.ui.querySelector('.cine-card') as HTMLElement).style.opacity;
      game.simulating = false;
      frames(game, 1);
      c.expect(cine.state!.t === t && (game.ui.querySelector('.cine-card') as HTMLElement).style.opacity === card, 'the cinematic ran on while paused');
      game.simulating = true;
      let guard = 0;
      while (cine.active && guard++ < 800) game.advance(FRAME);
      c.expect(!cine.active && st.stage === 2 && e.maxHealth === BOSSES[4].stageHealth[2], 'stage 3 shot did not finish');
    });
  });

  qa.add('cinematic.duo_bosses_transform_on_their_own', (c) => {
    // A double fight's bosses are separate: The Midget's bar empties and only The Midget transforms
    // (his own shot, his name on the card); Obama knocked out leaves The Midget where he is (no shot,
    // same stage, same health).
    withLiveFight(c, game, app, 1, () => {
      const e = game.enemy, q = game.partner;
      const pst = game.partnerStages, st = game.stages;
      const mid = BOSSES[1].partner!;
      const evolves = record('bossEvolve');
      deplete(game, q);
      c.expect(cine.state?.wizard === q && pst.stage === 1 && st.stage === 0, `Midget's bar out: shot for ${cine.state?.wizard.name}, stages ${st.stage + 1}/${pst.stage + 1}`);
      frames(game, K.duration[1] * K.burstAt + 0.3);
      const eyebrow = game.ui.querySelector('.cine-eyebrow')?.textContent ?? '';
      c.expect(eyebrow.includes(q.name), `card eyebrow "${eyebrow}" doesn't name The Midget`);
      let guard = 0;
      while (cine.active && guard++ < 800) game.advance(FRAME);
      c.step(K.grace + 0.1);
      c.expect(st.stage === 0 && !e.evolving && e.health === e.maxHealth, `Obama changed with The Midget: stage ${st.stage + 1}, ${e.health}/${e.maxHealth}`);
      // Obama down to his last stage and knocked out: nothing happens to The Midget.
      jump(st, 2);
      c.step(DT);
      q.health = q.maxHealth * 0.5;
      const hp = q.health;
      deplete(game, e);
      c.step(DT * 3);
      c.expect(!e.alive && !cine.active && pst.stage === 1 && !q.evolving, `after Obama fell: shot ${cine.active}, Midget stage ${pst.stage + 1}, evolving ${q.evolving}`);
      c.expect(q.health === hp && q.maxHealth === mid.stageHealth[1], `The Midget's bar changed: ${q.health}/${q.maxHealth}`);
      // (Obama's own jump to stage 3 above is the test's doing.) The Midget transformed once, on his own bar.
      const ev = evolves().filter((x) => x.wizard === q);
      c.expect(ev.length === 1 && ev[0].stage === 1, `The Midget's transformations: ${ev.map((x) => `${x.from + 1}->${x.stage + 1}`).join(', ')}`);
    }, { player: [0, -8], enemy: [2, 8], partner: [-2, 8] });
  });

  qa.add('ui.stage_banner_clear_of_boss_and_timer', (c) => {
    const rows: string[] = [];
    for (const index of [0, 2, 4]) {
      withLiveFight(c, game, app, index, () => {
        const e = game.enemy, st = game.stages;
        for (const stage of [1, 2]) {
          // (Stage 2 came from the first shot; wait out its grace, when the boss is immune.)
          if (stage === 2) c.step(K.grace + 0.05);
          c.expect(st.stage === stage - 1, `${BOSSES[index].id}: in stage ${st.stage + 1} before the shot into stage ${stage + 1}`);
          deplete(game, e);
          const D = cine.state!.duration;
          frames(game, D * K.burstAt + 0.45);
          const card = (game.ui.querySelector('.cine-card') as HTMLElement).getBoundingClientRect();
          const timer = app.hud.root.querySelector('.timer')!.getBoundingClientRect();
          const boss = screenRect(game, e);
          const opacity = +(game.ui.querySelector('.cine-card') as HTMLElement).style.opacity;
          c.expect(opacity > 0.9, `${BOSSES[index].id} s${stage + 1}: card not shown (${opacity})`);
          c.expect(card.width > 50 && !intersects(card, boss), `${BOSSES[index].id} s${stage + 1}: card ${card.top.toFixed(0)}-${card.bottom.toFixed(0)} overlaps the boss ${boss.top.toFixed(0)}-${boss.bottom.toFixed(0)}`);
          c.expect(!intersects(card, timer), `${BOSSES[index].id} s${stage + 1}: card overlaps the timer`);
          c.expect(card.bottom <= innerHeight + 1 && card.top >= innerHeight * 0.7, `${BOSSES[index].id} s${stage + 1}: card not in the bottom band (${card.top.toFixed(0)})`);
          c.expect(C.evolveFlash <= 0.25, `flash ${C.evolveFlash}`);
          rows.push(`${BOSSES[index].id}${stage + 1}: boss ${boss.top.toFixed(0)}-${boss.bottom.toFixed(0)} card ${card.top.toFixed(0)}-${card.bottom.toFixed(0)}`);
          let guard = 0;
          while (cine.active && guard++ < 800) game.advance(FRAME);
        }
      });
    }
    c.note(`${innerWidth}x${innerHeight} ${rows.join(' | ')}`);
  });

  qa.add('cinematic.never_headless', (c) => {
    // QA runs and soaks (qaMode, nothing armed) transform on sim time, with no cinematic.
    const prev = game.boss;
    game.stages.suspended = false;
    game.setupEnemy(BOSSES[0]);
    try {
      c.setup();
      const e = game.enemy;
      deplete(game, e);
      c.expect(!cine.active && !cine.live && game.cinematicScale === 1 && e.evolving, `headless transform: cinematic ${cine.active}`);
      c.step(C.evolveTime + 0.05);
      c.expect(!e.evolving && game.stages.stage === 1 && e.health === e.maxHealth, 'headless transform did not finish on sim time');
    } finally {
      game.setupEnemy(prev);
    }
  });

  qa.add('cinematic.camera_min_distance_in_cluttered_arenas', (c) => {
    // In every boss arena, at the spawn and with cover right behind the boss, both shots (stage 2
    // and stage 3): the camera stays at >= 80% of its planned distance at the burst and the slam
    // (it used to pull in to 2.4 m of 4 against Sahil's stalls), and his head clears the letterbox.
    // The camera only: frames aren't drawn.
    const render = game.renderer.render;
    game.renderer.render = () => {};
    const rows: string[] = [];
    let worst = Infinity;
    try {
      for (let index = 0; index < BOSSES.length; index++) {
        withLiveFight(c, game, app, index, () => {
          const e = game.enemy, st = game.stages;
          const spots: [number, number][] = [[0, 8], ...coverSpots(game, 5)];
          const cells: string[] = [];
          for (const spot of spots) {
            for (const stage of [1, 2]) {
              c.setup({ player: [0, -8], enemy: spot });
              if (stage === 2) jump(st, 1);
              c.step(DT);
              game.advance(FRAME);
              deplete(game, e);
              const tag = `${BOSSES[index].id} (${spot.join(',')}) s${stage + 1}`;
              c.expect(cine.state?.stage === stage && cine.state.wizard === e, `${tag}: no shot`);
              const r = shotCamera(game, app);
              cine.abort();
              worst = Math.min(worst, r.burst, r.slam);
              c.expect(r.burst >= 0.8 && r.slam >= 0.8, `${tag}: camera at ${(r.burst * 100).toFixed(0)}% of its planned distance at the burst, ${(r.slam * 100).toFixed(0)}% at the slam`);
              c.expect(r.head >= -0.01 * innerHeight, `${tag}: his head is ${(-r.head).toFixed(0)} px under the top letterbox bar at the slam`);
              cells.push(`${spot.join(',')} s${stage + 1} ${(Math.min(r.burst, r.slam) * 100).toFixed(0)}%${r.lift ? ` lift ${r.lift}` : ''} head ${r.head.toFixed(0)}px`);
            }
          }
          rows.push(`${BOSSES[index].theme}: ${cells.join(', ')}`);
        });
      }
    } finally {
      game.renderer.render = render;
    }
    c.note(`worst ${(worst * 100).toFixed(0)}% | ${rows.join(' | ')}`);
  });

  qa.add('cinematic.new_form_readable', (c) => {
    // The new form reads at the burst and the slam in the brightest arenas: Sahil's stage 2 in the
    // desert, Tinubu's stage 3 in the volcano, and The Midget's stage 3 (under its sparks). Sampled
    // from the frame drawn, inside his silhouette: few blown-out (near-white) pixels, mean luminance
    // under a cap, and, when he is bright, a clear colour step across his outline (a washed-out form
    // melts into what's behind it). Before the fix: desert slam 73-76% luminance, the volcano slam
    // 65-68% with an outline step of 0.12, The Midget's burst 89-91% with 19-35% blown out.
    const BLOWN_MAX = 0.1, MEAN_MAX = 0.7, CONTRAST_MIN = 0.16, BRIGHT = 0.45;
    const failed: string[] = [];
    const midget3 = (): Wizard => {
      jump(game.partnerStages, 1);
      c.step(DT);
      deplete(game, game.partner);
      return game.partner;
    };
    const stage3 = (): Wizard => {
      jump(game.stages, 1);
      c.step(DT);
      deplete(game, game.enemy);
      return game.enemy;
    };
    const stage2 = (): Wizard => {
      deplete(game, game.enemy);
      return game.enemy;
    };
    const cases: { index: number; label: string; trigger: () => Wizard }[] = [
      { index: 0, label: 'desert s2', trigger: stage2 },
      { index: 4, label: 'volcano s3', trigger: stage3 },
      { index: 1, label: 'Midget s3', trigger: midget3 },
    ];
    const rows: string[] = [];
    const fmt = (p: LookPixels) => `${(p.mean * 100).toFixed(0)}/${(p.blown * 100).toFixed(0)}/${(p.background * 100).toFixed(0)}/${(p.contrast * 100).toFixed(0)}`;
    for (const k of cases) {
      withLiveFight(c, game, app, k.index, () => {
        game.advance(FRAME);
        const w = k.trigger();
        const s0 = cine.state;
        c.expect(!!s0 && s0.wizard === w, `${k.label}: no shot`);
        const D = s0!.duration;
        const at: [string, number][] = [['burst', K.burstAt * D + 0.3], ['slam', K.slamAt * D], ['slam+', K.slamAt * D + 0.15]];
        const cells: string[] = [];
        for (const [beat, t] of at) {
          c.expect(untilShot(game, app, t), `${k.label}: the shot ended before the ${beat}`);
          const p = lookPixels(game, w);
          cells.push(`${beat} ${fmt(p)}`);
          const tag = `${k.label} ${beat}`;
          c.expect(p.pixels > 400, `${tag}: the boss is not on screen (${p.pixels} px)`);
          if (p.blown > BLOWN_MAX) failed.push(`${tag}: ${(p.blown * 100).toFixed(0)}% blown out to white`);
          if (p.mean > MEAN_MAX) failed.push(`${tag}: washed out (mean luminance ${p.mean.toFixed(2)})`);
          // (A dark form against a dark backdrop isn't washed out: it reads by its shape.)
          if (p.mean > BRIGHT && p.contrast < CONTRAST_MIN) failed.push(`${tag}: melts into the bright background (colour step across his outline ${p.contrast.toFixed(2)})`);
        }
        rows.push(`${k.label}: ${cells.join(', ')}`);
      });
    }
    c.expect(failed.length === 0, `${failed.join('; ')} | mean/blown/bg/contrast % ${rows.join(' | ')}`);
    c.note(`mean/blown/bg/contrast % ${rows.join(' | ')}`);
  });

  qa.add('cinematic.signature_transformations', (c) => {
    // Every boss (and The Midget) transforms its own way (src/campaign/transformStyles.ts): his
    // style plays; the rig is posed by the shot (its own clip through the charge and after the
    // burst, handed back afterwards); his props come out of his own skin batches and all go back;
    // his sound cues play (a different set for each); and the style's meshes are hidden after.
    // The camera only: frames aren't drawn.
    const render = game.renderer.render;
    game.renderer.render = () => {};
    const skins = game.spells.pool.skins;
    const PROPS_IN_CHARGE: Record<string, boolean> = { bazaar: true, shill: true, tantrum: true, vape: false, glitch: false, hellfire: true };
    const sets = new Map<string, Set<CineCue>>();
    const rows: string[] = [];
    try {
      const cases = [...BOSSES.map((_, index) => ({ index, partner: false })), { index: 1, partner: true }];
      for (const k of cases) {
        withLiveFight(c, game, app, k.index, () => {
          const def = k.partner ? BOSSES[k.index].partner! : BOSSES[k.index];
          const w = k.partner ? game.partner : game.enemy;
          game.advance(FRAME);
          const before = skins.stats().active;
          const cues = record('bossCinematicCue');
          deplete(game, w);
          const s0 = cine.state;
          c.expect(s0?.style === def.transform && s0.wizard === w, `${def.id}: shot style ${s0?.style}, wanted ${def.transform}`);
          const D = s0!.duration;
          c.expect(untilShot(game, app, K.burstAt * D * 0.75), `${def.id}: shot ended before the charge`);
          const chargeClip = w.visual.animator?.directedClip ?? null;
          const props = skins.stats().active - before;
          c.expect(untilShot(game, app, K.burstAt * D + 0.25), `${def.id}: shot ended before the burst`);
          const burstClip = w.visual.animator?.directedClip ?? null;
          frames(game, D + K.resume + K.easeOut + 1.4);
          const got = cues().filter((e) => e.wizard === w).map((e) => e.cue);
          const tag = `${def.id} (${def.transform})`;
          c.expect(!cine.active, `${tag}: the shot never ended`);
          if (w.visual.animator) {
            c.expect(chargeClip !== null && burstClip !== null, `${tag}: rig not directed (charge ${chargeClip}, burst ${burstClip})`);
            c.expect(w.visual.animator.directedClip === null, `${tag}: rig still directed after the shot`);
          }
          c.expect(!PROPS_IN_CHARGE[def.transform] || props > 0, `${tag}: no props during the charge`);
          c.expect(skins.stats().active === before, `${tag}: ${skins.stats().active - before} props never handed back`);
          c.expect(got.length >= 3, `${tag}: only ${got.length} cues (${got.join(',')})`);
          const shown: string[] = [];
          game.renderer.scene.traverse((o) => {
            if (o.name.startsWith('cine:') && o.visible) shown.push(o.name);
          });
          c.expect(shown.length === 0, `${tag}: still showing ${shown.join(', ')}`);
          const set = sets.get(def.transform) ?? new Set<CineCue>();
          for (const g of got) set.add(g);
          sets.set(def.transform, set);
          rows.push(`${tag}: charge ${chargeClip} / burst ${burstClip}, ${props} props, cues ${[...new Set(got)].join('+')}`);
        });
      }
    } finally {
      game.renderer.render = render;
    }
    // Each sounds like itself.
    const keys = [...sets.keys()];
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const a = sets.get(keys[i])!, b = sets.get(keys[j])!;
        c.expect([...a].some((x) => !b.has(x)) && [...b].some((x) => !a.has(x)), `${keys[i]} and ${keys[j]} sound the same`);
      }
    }
    c.expect(keys.length === 6, `styles played: ${keys.join(', ')}`);
    c.note(rows.join(' | '));
  });
}
