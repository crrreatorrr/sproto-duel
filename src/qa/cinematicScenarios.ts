import * as THREE from 'three';
import { CONFIG } from '../config';
import type { App } from '../App';
import { BOSSES } from '../campaign/levels';
import { events, type GameEvents } from '../core/events';
import type { Game } from '../core/Game';
import type { BossStages } from '../campaign/BossStages';
import type { Wizard } from '../wizard/Wizard';
import type { QAHarness } from './QAHarness';

const K = CONFIG.campaign.cinematic;
const C = CONFIG.campaign;
const DT = CONFIG.sim.fixedDt;
const FRAME = 1 / 60;

type Ctx = Parameters<Parameters<QAHarness['add']>[1]>[0];

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
function withLiveFight(c: Ctx, game: Game, app: App, index: number, fn: () => void, setup?: Parameters<Ctx['setup']>[0]): void {
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
function frames(game: Game, seconds: number, each?: () => void): void {
  const n = Math.round(seconds / FRAME);
  for (let i = 0; i < n; i++) {
    each?.();
    game.advance(FRAME);
  }
}

/** Put a boss straight into `stage` (full bar), without leaving a cinematic for it behind. */
function jump(st: BossStages, stage: number): void {
  st.evolveTo(stage);
  st.release(0);
  cineOf(st)?.abort();
}

let cineOf: (st: BossStages) => App['cinematic'] | null = () => null;

/** Empty `w`'s current stage bar with one big hit from the player. */
function deplete(game: Game, w: Wizard): void {
  game.spells.dealDamage(w, game.player, (w.health + 500) / game.player.damageMultiplier, w.chest(new THREE.Vector3()), 'blast');
}

/** Screen rect of a wizard's look: the cylinder it stands in (posed root, look radius, top). */
function screenRect(game: Game, w: Wizard): { left: number; right: number; top: number; bottom: number } {
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
 * Boss transformation cinematics (src/campaign/BossCinematic.ts): they freeze combat (no ticks, no
 * damage, no input), frame the boss, return the camera to the player, escalate for stage 3 and the
 * enrage, keep their title card clear of the boss and the timer, pause with the game, and never
 * play headless.
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

  qa.add('cinematic.duo_enrage_with_full_last_bar', (c) => {
    withLiveFight(c, game, app, 1, () => {
      const e = game.enemy, q = game.partner;
      const pst = game.partnerStages, st = game.stages;
      const mid = BOSSES[1].partner!;
      // Obama down to his last stage, then knocked out: The Midget is enraged.
      jump(st, 2);
      c.step(DT);
      q.health = q.maxHealth * 0.5;
      deplete(game, e);
      c.expect(!e.alive && pst.stage === 2 && !!cine.state?.enraged && cine.state?.wizard === q, `enrage shot ${JSON.stringify(cine.state && { ...cine.state, wizard: cine.state.wizard.name })}`);
      c.expect(cine.state!.duration === K.enrageDuration, 'enrage has its own length');
      c.expect(q.maxHealth === mid.stageHealth[2], `enraged bar max ${q.maxHealth}`);
      frames(game, K.enrageDuration * K.burstAt + 0.2);
      c.expect((game.ui.querySelector('.cine-title')?.textContent ?? '').includes('is enraged!') && game.ui.querySelector('.cine.enrage') !== null, 'no enrage card');
      let guard = 0;
      while (cine.active && guard++ < 800) game.advance(FRAME);
      c.expect(q.health === q.maxHealth && q.maxHealth === mid.stageHealth[2], `after the enrage: ${q.health}/${q.maxHealth}`);
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
}
