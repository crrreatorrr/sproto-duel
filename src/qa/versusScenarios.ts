import type { App } from '../App';
import { CONFIG } from '../config';
import type { Game } from '../core/Game';
import { GamepadInput } from '../core/Gamepad';
import { ReplaySource } from '../input/ReplaySource';
import type { DeviceBinding } from '../input/IntentSource';
import { applySnapshot, captureSnapshot } from '../net/snapshot';
import { decodeSnapshot, encodeSnapshot } from '../net/state';
import { FakePad } from './gamepadScenarios';
import type { QAHarness } from './QAHarness';

const DT = CONFIG.sim.fixedDt;
/** P1 keyboard + mouse, P2 a pad at index 1 (no real pad needed: seat 1 is replaced in scenarios). */
const DEVICES: [DeviceBinding, DeviceBinding] = [{ keyboardMouse: true, pad: null }, { keyboardMouse: false, pad: 1 }];

/** Run `fn` inside a Local Versus match, then back to the menu (one screen, AI rival). */
function withVersus(game: Game, app: App, fn: () => void): void {
  const seat0 = game.controllers[0];
  app.startVersus(DEVICES);
  game.simulating = false;
  try {
    fn();
  } finally {
    game.controllers[0] = seat0;
    game.qaMode = true;
    app.toMenu();
    game.simulating = false;
    game.playerControl = false;
  }
}

/** A pad at a given navigator.getGamepads() index. */
function padAt(index: number): FakePad {
  const p = new FakePad();
  Object.defineProperty(p, 'index', { value: index });
  return p;
}

export function registerVersusScenarios(qa: QAHarness, game: Game, app: App): void {
  qa.add('versus.kos-decide-sides', (c) => {
    withVersus(game, app, () => {
      const m = app.match;
      c.expect(m.rules.kind === 'versus' && game.split && game.enemyController === null && game.controllers[1]?.kind === 'local',
        `versus not set up: rules ${m.rules.kind}, split ${game.split}, ai ${game.enemyController !== null}`);
      c.expect(!game.spells.rewardSpellsEnabled && game.player.learned.size === 0, 'reward spells are on in Versus');
      game.controllers[1] = new ReplaySource(game.enemy, () => {});
      const ko = (target = game.enemy, by = game.player) => {
        m.phase = 'fight';
        game.qaMode = false; // the Match ends rounds on a KO only outside QA mode
        try {
          game.spells.dealDamage(target, by, 1e4, target.pos, 'bolt');
        } finally {
          game.qaMode = true;
        }
      };
      ko();
      c.expect(m.phase === 'roundEnd' && m.wins[0] === 1 && m.wins[1] === 0 && m.lastWinner === game.player, `P2 KO: ${m.phase} ${m.wins.join('-')}`);
      m.startRound();
      ko(game.player, game.enemy);
      c.expect(m.wins[0] === 1 && m.wins[1] === 1 && m.lastWinner === game.enemy, `P1 KO: ${m.wins.join('-')}`);
    });
  });

  qa.add('versus.both-cast', (c) => {
    withVersus(game, app, () => {
      c.setup({ player: [0, -8], enemy: [0, 8] });
      game.actionsLocked = false;
      const aim = (w: typeof game.player, at: typeof game.player) => at.chest(w.aimPoint);
      game.controllers[0] = new ReplaySource(game.player, (w, t) => {
        aim(w, game.enemy);
        if (t === 2) w.intent.press('bolt');
      });
      game.controllers[1] = new ReplaySource(game.enemy, (w, t) => {
        aim(w, game.player);
        if (t === 5) w.intent.press('blast');
      });
      c.step(1.6);
      c.expect(game.player.stats.casts >= 1 && game.enemy.stats.casts >= 1, `casts P1 ${game.player.stats.casts}, P2 ${game.enemy.stats.casts}`);
      c.expect(game.player.stats.damageDealt > 0 || game.enemy.stats.damageDealt > 0, 'neither spell landed');
    });
  });

  qa.add('versus.split-renders', (c) => {
    withVersus(game, app, () => {
      const r = game.renderer;
      c.expect(r.views.length === 2 && r.views[0].rect.w === 0.5, `views ${r.views.length}`);
      c.expect(r.views.every((v) => Math.abs(v.camera.aspect - window.innerWidth / 2 / window.innerHeight) < 0.02), 'view aspect is not half-width');
      game.warmUp();
      for (let i = 0; i < 3; i++) game.advance(DT);
      const programs = r.programCount;
      for (let i = 0; i < 5; i++) game.advance(DT);
      const calls = r.renderer.info.render.calls;
      c.expect(r.programCount === programs, `${r.programCount - programs} programs compiled after warm-up`);
      // Both halves drew something (read straight after a render, before the buffer is swapped).
      game.advance(DT);
      const gl = r.renderer.getContext();
      const px = new Uint8Array(4);
      const lit: boolean[] = [];
      for (const fx of [0.25, 0.75]) {
        gl.readPixels(Math.floor(gl.drawingBufferWidth * fx), Math.floor(gl.drawingBufferHeight * 0.5), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        lit.push(px[0] + px[1] + px[2] > 0);
      }
      c.expect(lit[0] && lit[1], `blank half: left ${lit[0]}, right ${lit[1]}`);
      const shadow = game.arena.sun.shadow.mapSize.x;
      c.expect(shadow === CONFIG.versus.shadowMapSize, `shadow map ${shadow} in split-screen`);
      c.note(`${calls} draw calls for two views, ${programs} programs`);
    });
    c.expect(game.renderer.views.length === 1 && game.arena.sun.shadow.mapSize.x === CONFIG.render.shadowMapSize, 'split-screen not undone on leaving Versus');
  });

  qa.add('versus.pad-slots', (c) => {
    const pads = [padAt(0), padAt(1)];
    const own = Object.getOwnPropertyDescriptor(navigator, 'getGamepads');
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, writable: true, value: () => [pads[0], pads[1], null, null] });
    try {
      const a = new GamepadInput(), b = new GamepadInput(), any = new GamepadInput(), none = new GamepadInput();
      a.slot = 0;
      b.slot = 1;
      none.slot = null;
      any.excluded.add(1);
      let now = 1000;
      const frame = () => {
        now += 16;
        for (const g of [a, b, any, none]) {
          g.endFrame();
          g.update(now);
        }
      };
      frame();
      pads[1].set('a', 1);
      frame();
      c.expect(b.wasPressed(['a']) && !a.wasPressed(['a']), `P2's press: b ${b.wasPressed(['a'])}, a ${a.wasPressed(['a'])}`);
      c.expect(!any.wasPressed(['a']), "'any' picked up the excluded pad");
      c.expect(!none.connected && !none.isDown(['a']), 'a pad-less seat reads a pad');
      pads[1].set('a', 0);
      pads[0].set('x', 1);
      pads[0].stick('left', 0.9, 0);
      frame();
      c.expect(a.wasPressed(['x']) && !b.isDown(['x']) && a.move.x > 0.5 && b.move.x === 0, 'P1 pad leaked into P2');
    } finally {
      if (own) Object.defineProperty(navigator, 'getGamepads', own);
      else delete (navigator as unknown as Record<string, unknown>).getGamepads;
    }
  });

  qa.add('versus.one-pad-handover-no-pause', (c) => {
    // One pad: it was the active device in the menus (P2 pressed A with it), then P1 gives it up.
    // That must not read as "the pad in use was unplugged" (which pauses).
    const pad = padAt(0);
    const own = Object.getOwnPropertyDescriptor(navigator, 'getGamepads');
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, writable: true, value: () => [pad, null, null, null] });
    const gp = game.input.pad;
    const wasLock = app.requireLock;
    try {
      app.requireLock = false;
      gp.reset();
      pad.set('a', 1);
      gp.endFrame();
      gp.update(1000);
      c.expect(gp.device === 'gamepad', `the pad did not become active (${gp.device})`);
      pad.set('a', 0);
      app.startVersus([{ keyboardMouse: true, pad: null }, { keyboardMouse: false, pad: 0 }]);
      game.qaMode = false; // the unplugged-pad pause only acts outside QA mode
      try {
        for (let i = 0; i < 5; i++) {
          game.input.endFrame();
          for (const p of game.extraPads) p.endFrame();
          gp.update(2000 + i * 16);
          app.padFrame(DT);
        }
      } finally {
        game.qaMode = true;
      }
      c.expect(app.state === 'playing', `state ${app.state} after the handover`);
      c.expect(!gp.connected && app.p2Pad.connected && app.p2Pad.device === 'gamepad', `P1 pad ${gp.connected}, P2 pad ${app.p2Pad.connected}/${app.p2Pad.device}`);
    } finally {
      if (own) Object.defineProperty(navigator, 'getGamepads', own);
      else delete (navigator as unknown as Record<string, unknown>).getGamepads;
      app.toMenu();
      gp.reset();
      app.requireLock = wasLock;
      game.simulating = false;
      game.playerControl = false;
    }
  });

  qa.add('net.snapshot-apply', (c) => {
    c.setup({ player: [-2, -7], enemy: [3, 6] });
    const m = app.match;
    const seat0 = game.controllers[0];
    try {
      game.controllers[0] = new ReplaySource(game.player, (w, t) => {
        game.enemy.chest(w.aimPoint);
        w.intent.move.set(0.6, 0, 0.3);
        if (t % 10 === 0) w.intent.press('bolt');
      });
      game.controllers[1] = new ReplaySource(game.enemy, (w, t) => {
        game.player.chest(w.aimPoint);
        if (t === 4) w.intent.press('blast');
        if (t === 20) w.intent.press('shield');
      });
      c.step(0.45);
      game.arena.pillars[0]?.damage(1e6, game.arena.pillars[0].position.clone().setY(1));
      game.tickets.spawnAt(5, -3);
      const snap = captureSnapshot(game, m, game.simTick, 77);
      c.expect(snap.projectiles.length > 0, 'no projectiles in flight to replicate');
      const wire = JSON.parse(JSON.stringify(encodeSnapshot(snap)));
      // Scramble, then apply the decoded snapshot.
      game.player.pos.set(9, 0, 9);
      game.enemy.health = 1;
      game.enemy.cd.blast = 0;
      game.spells.pool.releaseAll();
      game.arena.pillars[0]?.reset();
      game.tickets.clear();
      applySnapshot(game, m, decodeSnapshot(wire));
      const back = captureSnapshot(game, m, game.simTick, 77);
      const near = (a: number, b: number, tol: number, what: string) => c.expect(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);
      for (let i = 0; i < 2; i++) {
        const a = snap.wizards[i], b = back.wizards[i];
        for (let k = 0; k < 3; k++) near(b.pos[k], a.pos[k], 0.006, `wizard ${i} pos[${k}]`);
        near(b.health, a.health, 0.06, `wizard ${i} health`);
        near(b.mana, a.mana, 0.06, `wizard ${i} mana`);
        for (let k = 0; k < a.cd.length; k++) near(b.cd[k], a.cd[k], 0.006, `wizard ${i} cd[${k}]`);
        c.expect(b.alive === a.alive && (b.cast?.spell ?? null) === (a.cast?.spell ?? null), `wizard ${i} alive/cast`);
      }
      c.expect(back.projectiles.length === snap.projectiles.length, `projectiles ${back.projectiles.length} vs ${snap.projectiles.length}`);
      back.projectiles.forEach((p, i) => {
        const q = snap.projectiles[i];
        c.expect(p.id === q.id && p.kind === q.kind && p.owner === q.owner, `projectile ${i} identity`);
        near(p.pos[0], q.pos[0], 0.006, `projectile ${i} x`);
        near(p.vel[2], q.vel[2], 0.06, `projectile ${i} vz`);
      });
      c.expect(JSON.stringify(back.arena.pillars) === JSON.stringify(snap.arena.pillars), 'pillars differ');
      c.expect(back.arena.tickets.length === snap.arena.tickets.length, 'tickets differ');
      c.note(`${snap.projectiles.length} projectiles, ${JSON.stringify(wire).length} bytes`);
    } finally {
      game.controllers[0] = seat0;
      game.controllers[1] = null;
    }
  });
}
