/** Arena shifts in the sim (src/sim-core/shifts.ts): features per boss stage, their effects, the ring. */
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import { obstacleDistance } from './arena';
import { ONE, fx, len2, sec } from './fixed';
import { SimWorld } from './world';
import { emptyInput } from './wizard';

const S = CONFIG.arenaShifts;
const m = (v: number) => v / ONE;

function fight(bossId = 'sahil', seed = 5): SimWorld {
  const w = new SimWorld({ seed, rules: 'gauntlet', arena: 'moonlit', staffs: [null, null], bossId, learned: [] });
  while (w.actionsLocked) w.step([null]);
  return w;
}

function ticks(w: SimWorld, n: number): void {
  for (let i = 0; i < n; i++) w.step([emptyInput()]);
}

/** Empty the boss's bar: it transforms; the shift comes in once the transformation's grace ends. */
function nextStage(w: SimWorld): void {
  const boss = w.wizards[1];
  w.spells.dealDamage(boss, w.wizards[0], boss.health, { x: boss.pos.x, y: ONE, z: boss.pos.z }, 'bolt', null, 0);
  ticks(w, sec(CONFIG.campaign.cinematic.grace) / 100 + 2);
}

/** Park the player on (x, z), standing still. */
function standAt(w: SimWorld, x: number, z: number): void {
  const p = w.wizards[0];
  p.pos.x = x;
  p.pos.z = z;
  p.vel.x = p.vel.z = p.knock.x = p.knock.z = 0;
}

describe('arena shifts', () => {
  it('stage 2 grows pools and a spring on open floor; stage 3 adds vents and refills the spring', () => {
    const w = fight();
    expect(w.shifts.features.length).toBe(0);
    nextStage(w);
    expect(w.stages[0].stage).toBe(1);
    expect(w.shifts.stage).toBe(1);
    const pools = w.shifts.features.filter((f) => f.kind === 'pool');
    const springs = w.shifts.features.filter((f) => f.kind === 'spring');
    expect(pools.length).toBe(S.pool.count);
    expect(springs.length).toBe(1);
    expect(w.shifts.hazards.length).toBe(S.pool.count);
    for (const f of w.shifts.features) {
      expect(m(len2(f.x, f.z) + f.r)).toBeLessThanOrEqual(S.ringRadius[2] - S.ringMargin + 1e-3);
      for (const ob of w.arena.obstacles) expect(m(obstacleDistance(ob, f.x, f.z) - f.r)).toBeGreaterThanOrEqual(S.coverClearance - 1e-3);
      for (const g of w.shifts.features) if (g !== f) expect(m(len2(f.x - g.x, f.z - g.z) - f.r - g.r)).toBeGreaterThanOrEqual(S.spacing - 1e-3);
      if (f.kind === 'pool') {
        expect(m(f.r)).toBeGreaterThanOrEqual(S.pool.radius[0]);
        expect(m(f.r)).toBeLessThanOrEqual(S.pool.radius[1]);
        // Golden tickets (and life packs) keep out of the pools.
        expect(w.tickets.validSpot(f.x, f.z)).toBe(false);
      }
    }
    // The ring eases in to stage 2's radius.
    ticks(w, 120);
    expect(m(w.arena.ringCap)).toBeLessThan(S.ringRadius[0]);
    ticks(w, 60);
    expect(m(w.arena.ringCap)).toBeCloseTo(S.ringRadius[1], 3);
    expect(w.arena.fireRadius).toBeLessThanOrEqual(w.arena.ringCap);

    const spring = springs[0];
    spring.charge = 0;
    nextStage(w);
    expect(w.shifts.stage).toBe(2);
    expect(w.shifts.features.filter((f) => f.kind === 'vent').length).toBe(S.vent.count);
    expect(m(spring.charge)).toBe(S.spring.charge);
    expect(w.events.list.filter((e) => e.type === 'arenaShift').map((e) => e.n)).toEqual([1, 2]);
  });

  it('pools burn and slow whoever stands in them, once grown in', () => {
    const w = fight('sahil');
    nextStage(w);
    const pool = w.shifts.features.filter((f) => f.kind === 'pool')[0];
    const p = w.wizards[0];
    // Still fading in: harmless.
    standAt(w, pool.x, pool.z);
    const h0 = p.health;
    ticks(w, 1);
    expect(p.health).toBe(h0);
    expect(p.groundSlow).toBe(ONE);
    standAt(w, 0, -fx(8));
    ticks(w, sec(S.growTime) / 100);
    standAt(w, pool.x, pool.z);
    const h1 = p.health;
    for (let i = 0; i < 60; i++) {
      standAt(w, pool.x, pool.z);
      ticks(w, 1);
    }
    const dps = w.boss!.shift.pools.dps;
    expect(m(h1 - p.health)).toBeCloseTo(dps + dps * CONFIG.arena.fireTickInterval, 3); // burns at once on entering
    expect(p.groundSlow).toBe(fx(w.boss!.shift.pools.slow!));
    expect(w.events.list.some((e) => e.type === 'damage' && e.s === 'pool' && e.w === 0)).toBe(true);
    // Out of the pool: no burn, normal speed.
    standAt(w, 0, -fx(8));
    ticks(w, 1);
    const h2 = p.health;
    ticks(w, 30);
    expect(p.health).toBe(h2);
    expect(p.groundSlow).toBe(ONE);
  });

  it('the spring heals until its charge runs dry', () => {
    const w = fight();
    nextStage(w);
    ticks(w, sec(S.growTime) / 100 + 1);
    const spring = w.shifts.features.filter((f) => f.kind === 'spring')[0];
    const p = w.wizards[0];
    p.health = fx(100);
    standAt(w, spring.x, spring.z);
    for (let i = 0; i < 60; i++) {
      standAt(w, spring.x, spring.z);
      ticks(w, 1);
    }
    expect(m(p.health)).toBeCloseTo(100 + S.spring.heal, 0);
    expect(m(spring.charge)).toBeCloseTo(S.spring.charge - S.spring.heal, 0);
    expect(w.shifts.springFor(p, fx(20))).toBe(spring);
    for (let i = 0; i < 600; i++) {
      standAt(w, spring.x, spring.z);
      ticks(w, 1);
    }
    expect(spring.charge).toBe(0);
    expect(m(p.health)).toBeCloseTo(100 + S.spring.charge, 3);
    expect(w.shifts.springFor(p, fx(20))).toBeNull();
    expect(w.events.list.some((e) => e.type === 'springHeal')).toBe(true);
  });

  it('vents warn, then erupt: damage and a shove', () => {
    const w = fight('obama');
    nextStage(w);
    nextStage(w);
    ticks(w, sec(S.growTime) / 100 + 1);
    const vent = w.shifts.features.filter((f) => f.kind === 'vent')[0];
    const p = w.wizards[0];
    w.events.take();
    let hit = false;
    for (let i = 0; i < sec(S.vent.period[1]) / 100 + 10 && !hit; i++) {
      standAt(w, vent.x, vent.z);
      ticks(w, 1);
      hit = w.events.list.some((e) => e.type === 'damage' && e.s === 'vent' && e.w === 0);
    }
    expect(hit).toBe(true);
    expect(w.events.list.some((e) => e.type === 'ventWarn')).toBe(true);
    expect(w.events.list.some((e) => e.type === 'ventErupt')).toBe(true);
    expect(len2(p.knock.x, p.knock.z)).toBeGreaterThan(fx(S.vent.knockback / 2));
  });

  it('clears with the round and stays out of duels', () => {
    const duel = new SimWorld({ seed: 1, rules: 'quick', arena: 'moonlit', staffs: [null, null] });
    duel.shifts.applyStage(2);
    ticks(duel, 10);
    expect(duel.shifts.features.length).toBe(0);
    const w = fight();
    nextStage(w);
    w.shifts.clear();
    expect(w.shifts.features.length).toBe(0);
    expect(w.shifts.hazards.length).toBe(0);
  });

  it('is deterministic', () => {
    const run = (seed: number) => {
      const w = fight('tinubu', seed);
      nextStage(w);
      ticks(w, 600);
      nextStage(w);
      ticks(w, 900);
      return w.hash() + w.shifts.features.map((f) => f.x + ',' + f.z).join(';');
    };
    expect(run(9)).toBe(run(9));
    expect(run(9)).not.toBe(run(10));
  });
});
