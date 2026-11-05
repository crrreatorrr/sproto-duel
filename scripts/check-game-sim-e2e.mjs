#!/usr/bin/env node
/**
 * End to end in Chromium: start the real game (Vite dev server, SwiftShader WebGL), play a Quick
 * Duel and a Boss Gauntlet fight (god mode, so it ends) with a scripted human driving the player's
 * intent, render some frames, and check the match's input log, recorded by the game itself
 * (Game.sim), replays with the server bundle (dist/duel-sim.server.js) to the game's own end hash.
 *
 *   node scripts/check-game-sim-e2e.mjs            # both
 *   node scripts/check-game-sim-e2e.mjs quick
 * Slow under SwiftShader (a few minutes); not part of CI.
 */
import fs from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const modes = process.argv[2] ? [process.argv[2]] : ['quick', 'boss'];
const bundle = fs.readFileSync('dist/duel-sim.server.js', 'utf8');
const { DuelSim, DUEL_SIM_VERSION } = new Function(bundle + '; return { DuelSim, DUEL_SIM_VERSION };')();

const vite = await createServer({ server: { port: 4199, strictPort: true, host: '127.0.0.1', hmr: false, watch: null }, logLevel: 'warn' });
await vite.listen();
let failed = 0;
try {
  for (const mode of modes) {
    const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://127.0.0.1:4199/');
    await page.waitForFunction(() => window.__duel && window.__duel.game, null, { timeout: 180000 });
    await page.evaluate((mode) => {
      const { app, game, config } = window.__duel;
      if (mode === 'quick') app.startMatch();
      else {
        config.debug.godMode = true;
        app.startBossFight();
      }
      const p = game.player;
      let t = 0;
      // A scripted human: strafe round the opponent holding fire, roll, blast and shield now and then.
      game.controllers[0] = {
        kind: 'replay',
        tick() {
          t++;
          const e = game.enemy;
          const a = Math.atan2(e.pos.x - p.pos.x, e.pos.z - p.pos.z);
          const side = Math.floor(t / 90) % 2 ? 1 : -1;
          p.intent.move.set(Math.sin(a + side * 1.3), 0, Math.cos(a + side * 1.3));
          p.intent.facing = a;
          p.intent.holdBolt = t % 120 < 80;
          p.aimPoint.set(e.pos.x, e.pos.y + 1.2, e.pos.z);
          if (t % 97 === 0) p.intent.press('dodge');
          if (t % 211 === 0) p.intent.press('blast');
          if (t % 389 === 0) p.intent.press('shield');
        },
      };
    }, mode);
    let state;
    for (let batch = 0; batch < 80; batch++) {
      state = await page.evaluate((render) => {
        const g = window.__duel.game;
        // Mostly bare ticks (fast); some fully rendered frames to exercise the presentation.
        if (render) for (let i = 0; i < 60; i++) g.advance(1 / 60);
        for (let i = 0; i < 1200 && g.sim && !g.sim.over; i++) {
          g.input.endFrame();
          g.tick(1 / 60);
        }
        return { over: !!g.sim && g.sim.over, tick: g.sim ? g.sim.world.tick : -1, wins: g.match.wins.slice(), stage: g.stages.stage };
      }, batch === 1 || batch === 3);
      if (state.over) break;
    }
    const fin = await page.evaluate(() => ({ log: window.__duel.game.sim.log(), hash: window.__duel.game.sim.world.hash() }));
    await browser.close();
    const r = DuelSim.replay({ ...fin.log, simVersion: DUEL_SIM_VERSION });
    const ok = r.ok && r.endHash === fin.hash && errors.length === 0 && state.over;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode}: ${state.tick} ticks, wins ${JSON.stringify(state.wins)}, boss stage ${state.stage}, log ${JSON.stringify(fin.log).length} B, replay ${JSON.stringify({ ok: r.ok, error: r.error, winnerSeat: r.winnerSeat, bossId: r.bossId })}, hash ${r.endHash === fin.hash ? 'matches' : `${r.endHash} != ${fin.hash}`}, page errors ${JSON.stringify(errors.slice(0, 3))}`);
  }
} finally {
  await vite.close();
}
process.exit(failed ? 1 : 0);
