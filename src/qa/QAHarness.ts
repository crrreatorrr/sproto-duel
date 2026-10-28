import * as THREE from 'three';
import { CONFIG } from '../config';
import type { Game } from '../core/Game';
import type { Wizard } from '../wizard/Wizard';

/**
 * In-browser QA harness. Scenarios pause the real loop, set up a situation, step the actual
 * fixed-tick simulation and assert on the outcome. Exposed as `window.__duel.qa`.
 *
 *   await __duel.qa.runAll()         -> { passed, failed, results[] }
 *   await __duel.qa.run('bolt.hits') -> single scenario
 *   await __duel.qa.perf(5)          -> real frame-time stats over 5 seconds
 *   __duel.qa.list()                 -> scenario names
 */

export interface ScenarioResult {
  name: string;
  pass: boolean;
  detail: string;
  ms: number;
}

interface Ctx {
  game: Game;
  player: Wizard;
  enemy: Wizard;
  /** Step the simulation for `seconds` of game time. */
  step(seconds: number, each?: () => void): void;
  /**
   * Reset everything and place the wizards. In a double fight the partner goes to `partner`
   * (default: CONFIG.campaign.duo.spawnSpacing to the enemy's side), facing the player.
   */
  setup(opts?: { player?: [number, number]; enemy?: [number, number]; partner?: [number, number] }): void;
  aimAt(w: Wizard, target: Wizard): void;
  expect(cond: boolean, msg: string): void;
  near(actual: number, expected: number, tolerance: number, label: string): void;
  note(msg: string): void;
}

/** A scenario; it may be async (awaiting a lazy asset load), the game loop stays detached meanwhile. */
type Scenario = (c: Ctx) => void | Promise<void>;

class AssertionError extends Error {}

const DT = CONFIG.sim.fixedDt;
const tmp = new THREE.Vector3();

export class QAHarness {
  private readonly scenarios = new Map<string, Scenario>();

  constructor(private readonly game: Game) {
    this.registerCore();
  }

  /** Other modules (AI, match flow) add their own scenarios. */
  add(name: string, fn: Scenario): void {
    this.scenarios.set(name, fn);
  }

  list(): string[] {
    return [...this.scenarios.keys()];
  }

  async runAll(filter?: string): Promise<{ passed: number; failed: number; results: ScenarioResult[] }> {
    const results: ScenarioResult[] = [];
    for (const name of this.scenarios.keys()) {
      if (filter && !name.includes(filter)) continue;
      results.push(await this.run(name));
    }
    const failed = results.filter((r) => !r.pass).length;
    const summary = { passed: results.length - failed, failed, results };
    console.table(results.map((r) => ({ scenario: r.name, pass: r.pass ? 'PASS' : 'FAIL', detail: r.detail })));
    return summary;
  }

  async run(name: string): Promise<ScenarioResult> {
    const fn = this.scenarios.get(name);
    if (!fn) return { name, pass: false, detail: 'unknown scenario', ms: 0 };
    const notes: string[] = [];
    const t0 = performance.now();
    let pass = true;
    let detail = '';
    await this.sandbox(async () => {
      try {
        await fn(this.makeCtx(notes));
        detail = notes.join('; ') || 'ok';
      } catch (err) {
        pass = false;
        detail = err instanceof AssertionError ? err.message : `EXCEPTION ${(err as Error)?.stack ?? err}`;
        if (notes.length) detail += ` | notes: ${notes.join('; ')}`;
      }
    });
    return { name, pass, detail, ms: Math.round(performance.now() - t0) };
  }

  /**
   * Run `fn` with the live loop, match flow and enemy controller detached, then restore a clean game.
   * Scenarios are 1v1: a double fight's partner is benched for the run (scenarios that want it dress
   * a boss with a partner themselves) and brought back afterwards if that fight is still set up.
   */
  async sandbox(fn: () => void | Promise<void>): Promise<void> {
    const g = this.game;
    const saved = { simulating: g.simulating, playerControl: g.playerControl, controller: g.enemyController, locked: g.actionsLocked };
    g.simulating = false;
    g.playerControl = false;
    g.actionsLocked = false;
    g.qaMode = true;
    g.inSandbox = true;
    g.enemyController = null;
    const duo = g.partnerActive ? g.boss : null;
    if (duo) g.setupPartner(null);
    // God mode applies only if a scenario turns it on (the menus hold it off the background duel).
    const godHeld = g.godHeld;
    g.holdGodMode(false);
    const restoreStats = g.useDefaultStats(); // boss and god-mode stats stay out of scenarios
    try {
      await fn();
    } finally {
      restoreStats();
      g.holdGodMode(godHeld);
      if (duo?.partner && g.boss === duo && !g.partnerActive) g.setupPartner(duo.partner);
      this.reset();
      g.qaMode = false;
      g.inSandbox = false;
      g.enemyController = saved.controller;
      g.enemyController?.reset?.();
      g.simulating = saved.simulating;
      g.playerControl = saved.playerControl;
      g.actionsLocked = saved.locked;
    }
    // setTimeout, not rAF: rAF never fires in hidden/background tabs.
    await new Promise((r) => setTimeout(r, 0));
  }

  /** Real-time frame statistics while the game runs normally. */
  async perf(seconds = 5): Promise<Record<string, number>> {
    const g = this.game;
    const samples: number[] = [];
    let last = performance.now();
    const end = last + seconds * 1000;
    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        samples.push(now - last);
        last = now;
        if (now < end) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    samples.shift();
    samples.sort((a, b) => a - b);
    const pct = (p: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    const info = g.renderer.renderer.info;
    return {
      frames: samples.length,
      avgFps: Math.round(1000 / avg),
      avgMs: +avg.toFixed(2),
      p95Ms: +pct(0.95).toFixed(2),
      p99Ms: +pct(0.99).toFixed(2),
      maxMs: +samples[samples.length - 1].toFixed(2),
      framesOver20ms: samples.filter((s) => s > 20).length,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      sparks: g.fx.sparks.alive,
      smoke: g.fx.smoke.alive,
      projectiles: g.spells.pool.active.length,
    };
  }

  reset(): void {
    const g = this.game;
    g.resetArena();
    for (const w of g.wizards) {
      w.resetForRound(false);
      w.resetStats();
    }
    g.spawnWizards();
  }

  private makeCtx(notes: string[]): Ctx {
    const g = this.game;
    const ctx: Ctx = {
      game: g,
      player: g.player,
      enemy: g.enemy,
      step(seconds, each) {
        const n = Math.round(seconds / DT);
        for (let i = 0; i < n; i++) {
          each?.();
          g.tick(DT);
        }
      },
      setup: (opts) => {
        this.reset();
        const [px, pz] = opts?.player ?? [0, -6];
        const [ex, ez] = opts?.enemy ?? [0, 6];
        g.player.spawn(px, pz, Math.atan2(ex - px, ez - pz));
        g.enemy.spawn(ex, ez, Math.atan2(px - ex, pz - ez));
        if (g.partnerActive) {
          const [qx, qz] = opts?.partner ?? [ex - CONFIG.campaign.duo.spawnSpacing, ez];
          g.partner.spawn(qx, qz, Math.atan2(px - qx, pz - qz));
        }
        g.physics.step();
        ctx.aimAt(g.player, g.enemy);
        ctx.aimAt(g.enemy, g.player);
        if (g.partnerActive) ctx.aimAt(g.partner, g.player);
      },
      aimAt(w, target) {
        target.chest(w.aimPoint);
        w.intent.facing = w.facing = Math.atan2(target.pos.x - w.pos.x, target.pos.z - w.pos.z);
      },
      expect(cond, msg) {
        if (!cond) throw new AssertionError(msg);
      },
      near(actual, expected, tolerance, label) {
        if (Math.abs(actual - expected) > tolerance) {
          throw new AssertionError(`${label}: expected ${expected.toFixed(2)} ±${tolerance}, got ${actual.toFixed(2)}`);
        }
        notes.push(`${label}=${actual.toFixed(2)}`);
      },
      note(msg) {
        notes.push(msg);
      },
    };
    return ctx;
  }

  private registerCore(): void {
    const W = CONFIG.wizard;
    const B = CONFIG.spells.bolt;

    this.add('move.walk_speed', (c) => {
      c.setup();
      const start = c.player.pos.clone();
      c.player.intent.move.set(1, 0, 0);
      c.step(0.5);
      const a = c.player.pos.clone();
      c.step(1);
      c.near(c.player.pos.distanceTo(a), W.moveSpeed, 0.15, 'm/s');
      c.expect(a.distanceTo(start) > 0, 'player did not move');
    });

    this.add('move.sprint_faster_and_drains_mana', (c) => {
      c.setup();
      c.player.intent.move.set(1, 0, 0);
      c.player.intent.sprint = true;
      c.step(0.5);
      const a = c.player.pos.clone();
      const mana = c.player.mana;
      c.step(1);
      c.near(c.player.pos.distanceTo(a), W.sprintSpeed, 0.2, 'sprint m/s');
      c.expect(c.player.mana < mana, 'sprint should drain mana');
    });

    this.add('move.wall_contains', (c) => {
      c.setup({ player: [0, 0], enemy: [5, 5] });
      c.player.intent.move.set(0, 0, -1);
      c.player.intent.sprint = true;
      c.step(6);
      const r = Math.hypot(c.player.pos.x, c.player.pos.z);
      c.expect(r < CONFIG.arena.wallRadius, `escaped wall: r=${r.toFixed(2)}`);
      c.note(`r=${r.toFixed(2)}`);
    });

    this.add('dodge.distance_and_iframes', (c) => {
      c.setup();
      c.player.intent.move.set(1, 0, 0);
      c.player.intent.press('dodge');
      const start = c.player.pos.clone();
      c.step(DT);
      c.expect(c.player.dodging && c.player.invulnerable, 'dodge did not start with i-frames');
      c.step(W.dodge.iframes + 0.02);
      c.expect(!c.player.invulnerable, 'i-frames lasted too long');
      c.player.intent.move.set(0, 0, 0);
      c.step(0.3);
      const d = c.player.pos.distanceTo(start);
      c.expect(d > 4 && d < 7.5, `roll distance ${d.toFixed(2)} outside 4..7.5`);
      c.note(`roll=${d.toFixed(2)}m`);
    });

    this.add('dodge.buffered_press_fires_after_cooldown', (c) => {
      c.setup();
      c.player.intent.press('dodge');
      c.step(W.dodge.duration + W.dodge.cooldown - 0.08);
      c.player.intent.press('dodge'); // pressed slightly early
      c.step(0.12);
      c.expect(c.player.stats.dodges === 2, `buffered dodge did not fire (dodges=${c.player.stats.dodges})`);
    });

    this.add('bolt.hits_static_target', (c) => {
      c.setup();
      const hp = c.enemy.health;
      c.player.intent.press('bolt');
      c.step(1);
      c.expect(c.player.stats.casts === 1, `expected 1 cast, got ${c.player.stats.casts}`);
      c.near(hp - c.enemy.health, B.damage, 0.01, 'damage');
    });

    this.add('bolt.hold_fire_rate_and_mana', (c) => {
      c.setup();
      const mana = c.player.mana;
      c.step(1, () => (c.player.intent.holdBolt = true));
      const casts = c.player.stats.casts;
      const expected = Math.floor(1 / B.fireInterval) + 1;
      c.expect(Math.abs(casts - expected) <= 1, `fire rate: ${casts} casts in 1s, expected ~${expected}`);
      c.expect(c.player.mana < mana, 'bolts should cost mana');
      c.note(`casts/s=${casts}`);
    });

    this.add('bolt.out_of_mana_stops_casting', (c) => {
      c.setup();
      c.player.mana = B.manaCost - 1;
      c.player.intent.press('bolt');
      c.step(0.1);
      c.expect(c.player.stats.casts === 0, 'cast with insufficient mana');
    });

    this.add('bolt.iframes_pass_through', (c) => {
      c.setup();
      const hp = c.enemy.health;
      c.player.intent.press('bolt');
      // Keep the enemy invulnerable as the bolt arrives (simulates a well-timed roll in place).
      c.step(0.6, () => (c.enemy.iframes = 0.1));
      c.expect(c.enemy.health === hp, 'bolt damaged a wizard with i-frames');
    });

    this.add('pillar.blocks_and_crumbles', (c) => {
      const pillar = c.game.arena.pillars[0];
      const p = pillar.position;
      const dir = tmp.copy(p).setY(0).normalize();
      // Enemy hides directly behind pillar 0, player in front of it.
      c.setup({ player: [p.x - dir.x * 6, p.z - dir.z * 6], enemy: [p.x + dir.x * 3, p.z + dir.z * 3] });
      const hp = c.enemy.health;
      c.player.intent.press('bolt');
      c.step(0.6);
      c.expect(c.enemy.health === hp, 'bolt went through a pillar');
      c.expect(pillar.hp < CONFIG.arena.pillars.hp, 'pillar took no damage');
      // Keep shooting until it breaks.
      c.player.mana = 1e6;
      c.step(10, () => {
        c.player.intent.holdBolt = pillar.alive;
        c.player.mana = 1e6;
      });
      c.expect(!pillar.alive, `pillar never crumbled (hp=${pillar.hp})`);
      c.player.intent.holdBolt = false;
      c.step(1);
      const before = c.enemy.health;
      c.player.intent.press('bolt');
      c.step(0.8);
      c.expect(c.enemy.health < before, 'bolt still blocked after pillar crumbled');
    });

    this.add('pool.projectiles_recycle', (c) => {
      c.setup({ player: [0, 0], enemy: [12, 12] });
      c.player.facing = c.player.intent.facing = 0;
      c.player.aimPoint.set(0, 1.4, 50);
      c.step(8, () => {
        c.player.intent.holdBolt = true;
        c.player.mana = 1e6;
      });
      c.player.intent.holdBolt = false;
      const casts = c.player.stats.casts;
      c.step(B.lifetime + 0.2);
      c.expect(c.game.spells.pool.active.length === 0, `${c.game.spells.pool.active.length} projectiles leaked`);
      c.note(`fired ${casts}`);
    });

    this.add('sim.no_nan_after_knockback_spam', (c) => {
      c.setup();
      for (let i = 0; i < 50; i++) c.enemy.addKnockback(Math.random() - 0.5, Math.random() - 0.5, 40);
      c.step(2);
      const ok = Number.isFinite(c.enemy.pos.x) && Number.isFinite(c.enemy.pos.z);
      c.expect(ok, 'NaN position');
      c.expect(Math.hypot(c.enemy.pos.x, c.enemy.pos.z) < CONFIG.arena.wallRadius, 'knocked through the wall');
    });
  }
}
