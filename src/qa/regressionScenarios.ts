import * as THREE from 'three';
import { CONFIG } from '../config';
import { feel } from '../core/feel';
import type { Game } from '../core/Game';
import type { QAHarness } from './QAHarness';

const DT = CONFIG.sim.fixedDt;
const W = CONFIG.wizard;
const P = CONFIG.arena.pillars;

/** Regression scenarios from QA reports. */
export function registerRegressionScenarios(qa: QAHarness, game: Game): void {
  qa.add('camera.no_clip_pillars', (c) => {
    // Stand in front of each pillar facing away from it, sweeping sideways, so the pillar sits
    // behind the camera, behind the shoulder, and just off the pull-back line.
    const rig = game.rig;
    let worst = Infinity;
    let maxJump = 0;
    let blocked = 0;
    for (const pillar of game.arena.pillars) {
      const away = pillar.position.clone().setY(0).normalize().negate();
      const yaw = Math.atan2(away.x, away.z);
      const rx = -Math.cos(yaw), rz = Math.sin(yaw);
      for (const back of [1.4, 2.2, 3.5]) {
        c.setup({ player: [pillar.position.x + away.x * back, pillar.position.z + away.z * back], enemy: [0, 0] });
        rig.snap(c.player.pos, yaw);
        let last: THREE.Vector3 | null = null;
        // Strafe across the pillar from left to right.
        for (let f = 0; f <= 60; f++) {
          const side = -2 + (4 * f) / 60;
          const x = pillar.position.x + away.x * back + rx * side;
          const z = pillar.position.z + away.z * back + rz * side;
          c.player.pos.set(x, 0, z);
          rig.update(1 / 60, c.player.pos, game.physics, false, false);
          const cam = rig.camera.position;
          if (last && f > 2) maxJump = Math.max(maxJump, cam.distanceTo(last));
          last = cam.clone();
          if (rig.camera.position.distanceTo(c.player.pos) < CONFIG.camera.distance) blocked++;
          for (const p of game.arena.pillars) {
            if (cam.y > P.height) continue;
            worst = Math.min(worst, Math.hypot(cam.x - p.position.x, cam.z - p.position.z) - P.radius);
          }
        }
      }
    }
    c.note(`closest camera-to-pillar=${worst.toFixed(3)}m maxJump=${maxJump.toFixed(2)}m blockedFrames=${blocked}`);
    c.expect(blocked > 20, 'test never put a pillar behind the camera');
    c.expect(worst >= 0.15, `camera came within ${worst.toFixed(3)} m of a pillar surface`);
    // Pulling in when a pillar crosses behind the camera is deliberately instant (anything slower
    // clips), so only the clearance is asserted; the jump size is reported for tuning.
  });

  qa.add('move.sprint_exhausts', (c) => {
    c.setup({ player: [0, 0], enemy: [10, 10] });
    let toggles = 0;
    let was = false;
    let dryAt = -1;
    let t = 0;
    let distAfterDry = 0;
    let prev = c.player.pos.clone();
    c.step(25, () => {
      t += DT;
      // Run in a tight circle (radius ~6 m) so we never reach the fire.
      c.player.intent.move.set(Math.cos(t * 1.5), 0, Math.sin(t * 1.5));
      c.player.intent.sprint = true;
      if (c.player.sprinting !== was) toggles++;
      was = c.player.sprinting;
      if (dryAt < 0 && c.player.mana <= 0) dryAt = t;
      if (dryAt >= 0 && t > dryAt + 1) distAfterDry += c.player.pos.distanceTo(prev);
      prev = c.player.pos.clone();
    });
    c.expect(dryAt > 0, 'sprint never ran out of mana');
    const avg = distAfterDry / (25 - dryAt - 1);
    c.note(`dry at ${dryAt.toFixed(1)}s, avg speed after=${avg.toFixed(2)}, toggles=${toggles}`);
    // Holding Shift forever may pulse sprint as mana recovers, but never sustain it or flicker.
    c.expect(toggles <= 25, `sprint toggled ${toggles} times in 25 s`);
    c.expect(avg < W.sprintSpeed * 0.9, `sprint effectively never runs out (avg ${avg.toFixed(2)} m/s)`);
  });

  qa.add('feel.hitstop_budget', (c) => {
    c.setup();
    feel.reset();
    let ticks = 0;
    let acc = 0;
    const frames = 180;
    for (let f = 0; f < frames; f++) {
      const scale = feel.update(1 / 60);
      acc += (1 / 60) * scale;
      while (acc >= DT) {
        c.player.intent.holdBolt = true;
        c.player.mana = 1e6;
        c.enemy.health = W.maxHealth;
        game.tick(DT);
        acc -= DT;
        ticks++;
      }
    }
    const ratio = ticks / frames;
    c.note(`game time ${(ratio * 100).toFixed(0)}% of real time, hits=${c.player.stats.hits}`);
    c.expect(c.player.stats.hits > 5, 'test did not land hits');
    c.expect(ratio >= 0.9, `hit-stop ate ${((1 - ratio) * 100).toFixed(0)}% of game time`);
  });

  qa.add('bolt.dead_target_passthrough', (c) => {
    c.setup();
    game.spells.dealDamage(c.enemy, c.player, 1e6, c.enemy.pos, 'bolt');
    c.expect(!c.enemy.alive, 'enemy did not die');
    feel.reset();
    c.player.intent.press('bolt');
    let passed = false;
    c.step(0.6, () => {
      for (const p of game.spells.pool.active) if (p.pos.z > c.enemy.pos.z + 1) passed = true;
    });
    c.expect(passed, 'bolt stopped at a knocked-out wizard');
    c.expect(feel.hitStop <= 0, 'hit-stop triggered on a dead wizard');
  });

  qa.add('pillar.stump_blocks_walking', (c) => {
    const pillar = game.arena.pillars[0];
    pillar.damage(1e6, pillar.position.clone().setY(1));
    c.expect(!pillar.alive, 'pillar did not crumble');
    const dir = pillar.position.clone().setY(0).normalize();
    const start = pillar.position.clone().addScaledVector(dir, -3);
    c.setup({ player: [start.x, start.z], enemy: [0, 0] });
    pillar.damage(1e6, pillar.position.clone().setY(1)); // setup() restored it
    game.physics.step();
    c.player.intent.move.copy(dir);
    c.step(1.5);
    const d = Math.hypot(c.player.pos.x - pillar.position.x, c.player.pos.z - pillar.position.z);
    c.expect(d > P.radius, `walked into the stump (d=${d.toFixed(2)})`);
  });

  qa.add('input.bolt_buffered_through_roll', (c) => {
    c.setup();
    c.player.intent.move.set(1, 0, 0);
    c.player.intent.press('dodge');
    c.step(0.06);
    c.player.intent.press('bolt');
    c.step(W.dodge.duration + 0.1);
    c.expect(c.player.stats.casts === 1, `bolt pressed mid-roll was dropped (casts=${c.player.stats.casts})`);
  });

  qa.add('input.no_cast_on_lock_click', (c) => {
    c.setup();
    const input = game.input;
    if (!input.mouseNeedsLock) {
      c.note('skipped: pointer lock disabled (?nolock)');
      return;
    }
    input.endFrame();
    game.renderer.canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    const pressed = input.wasMousePressed(0) || input.isMouseDown(0);
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    input.endFrame();
    c.expect(input.locked || !pressed, 'a click without pointer lock registered as a cast');
  });

  qa.add('render.drawcalls_counted', (c) => {
    c.setup();
    game.renderer.render();
    const calls = game.renderer.renderer.info.render.calls;
    c.note(`drawCalls=${calls}`);
    c.expect(calls > 10, `renderer reports ${calls} draw calls`);
  });
}
