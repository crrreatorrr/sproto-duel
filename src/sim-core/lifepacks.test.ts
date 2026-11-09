/** Life packs in the sim (src/sim-core/lifepacks.ts): when they come, where, what they heal. */
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import { ONE, fx, len2, mul, sec } from './fixed';
import { SimWorld } from './world';
import { emptyInput } from './wizard';

const L = CONFIG.lifePacks;
const m = (v: number) => v / ONE;

function fight(seed = 21, bossId = 'broccoli'): SimWorld {
  const w = new SimWorld({ seed, rules: 'gauntlet', arena: 'moonlit', staffs: [null, null], bossId, learned: [] });
  w.ais.length = 0; // bosses stand still in these tests
  while (w.actionsLocked) w.step([null]);
  return w;
}

function ticks(w: SimWorld, n: number): void {
  for (let i = 0; i < n; i++) w.step([emptyInput()]);
}

function nextStage(w: SimWorld): void {
  const boss = w.wizards[1];
  w.spells.dealDamage(boss, w.wizards[0], boss.health, { x: boss.pos.x, y: ONE, z: boss.pos.z }, 'bolt', null, 0);
}

/** Step until a pack is out (at most `max` ticks); the ticks it took. */
function untilPack(w: SimWorld, max: number): number {
  let t = 0;
  while (!w.lifePacks.pack.active && t < max) {
    ticks(w, 1);
    t++;
  }
  return t;
}

describe('life packs', () => {
  it('a low player gets the stage pack early, a dash away and clear of the boss; touching it heals half', () => {
    const w = fight();
    const p = w.wizards[0], boss = w.wizards[1];
    p.health = mul(p.maxHealth, fx(0.3));
    const t = untilPack(w, sec(L.lowHealthDelay) / 100 + 5);
    expect(w.lifePacks.pack.active).toBe(true);
    expect(t / 60).toBeGreaterThanOrEqual(L.lowHealthDelay - 0.05);
    const pk = w.lifePacks.pack;
    const dp = m(len2(pk.x - p.pos.x, pk.z - p.pos.z));
    expect(dp).toBeGreaterThanOrEqual(L.playerDistance[0] - 0.01);
    expect(dp).toBeLessThanOrEqual(L.playerDistance[1] + 0.01);
    expect(m(len2(pk.x - boss.pos.x, pk.z - boss.pos.z))).toBeGreaterThanOrEqual(L.bossDistance);
    expect(m(len2(pk.x, pk.z))).toBeLessThan(m(w.arena.fireRadius) - CONFIG.tickets.fireMargin);
    expect(w.lifePacks.bestFor(p, fx(30))).toBe(pk);
    expect(w.events.list.some((e) => e.type === 'lifePackSpawn' && e.f)).toBe(true);

    const before = p.health;
    p.pos.x = pk.x;
    p.pos.z = pk.z;
    ticks(w, 1);
    expect(pk.active).toBe(false);
    expect(m(p.health - before)).toBeCloseTo(m(mul(p.maxHealth, fx(L.heal))), 2);
    expect(w.lifePacks.collected).toBe(1);
    expect(w.events.list.some((e) => e.type === 'lifePackPickup' && e.w === 0)).toBe(true);
    // One pack per stage reached: none more in stage 1.
    p.health = mul(p.maxHealth, fx(0.2));
    ticks(w, sec(L.minGap) / 100 + 60);
    expect(pk.active).toBe(false);
    expect(w.lifePacks.spawned).toBe(1);
  });

  it('an uncollected pack expires after its lifetime; the next stage brings another after minGap; at most three a fight', () => {
    const w = fight(22);
    const p = w.wizards[0];
    p.health = mul(p.maxHealth, fx(0.3));
    untilPack(w, 2000);
    expect(w.lifePacks.spawned).toBe(1);
    // The boss must not be the one touching it: only the player collects.
    const boss = w.wizards[1];
    boss.pos.x = w.lifePacks.pack.x;
    boss.pos.z = w.lifePacks.pack.z;
    ticks(w, sec(L.lifetime) / 100);
    expect(w.lifePacks.pack.active).toBe(false);
    expect(w.lifePacks.expired).toBe(1);
    expect(w.events.list.some((e) => e.type === 'lifePackExpire')).toBe(true);
    boss.pos.x = 0;
    boss.pos.z = fx(8);

    nextStage(w);
    // The phase's heal potion topped the player up: back below the low-health line.
    p.health = mul(p.maxHealth, fx(0.3));
    const t = untilPack(w, 4000);
    expect(w.lifePacks.spawned).toBe(2);
    expect(t / 60).toBeGreaterThanOrEqual(L.lowHealthDelay - 0.05);
    w.lifePacks.collect(p);
    nextStage(w);
    p.health = mul(p.maxHealth, fx(0.3));
    untilPack(w, 4000);
    expect(w.lifePacks.spawned).toBe(3);
    w.lifePacks.collect(p);
    expect(w.lifePacks.remaining).toBe(0);
    expect(w.lifePacks.spawnAt(0, 0)).toBeNull();
  });

  it('a healthy player waits for the stage due time', () => {
    const w = fight(23);
    ticks(w, 60);
    const due = w.lifePacks.dueAt;
    expect(due).toBeGreaterThanOrEqual(sec(L.firstDelay[0]));
    expect(due).toBeLessThanOrEqual(sec(L.firstDelay[1]));
    ticks(w, sec(L.lowHealthDelay) / 100 + 60);
    expect(w.lifePacks.pack.active).toBe(false);
  });

  it('stays off in duels', () => {
    const w = new SimWorld({ seed: 1, rules: 'versus', arena: 'moonlit', staffs: [null, null] });
    w.ais.length = 0; // bosses stand still in these tests
    w.wizards[0].health = fx(10);
    for (let i = 0; i < 1500; i++) w.step([null, null]);
    expect(w.lifePacks.spawned).toBe(0);
  });

  it('is deterministic', () => {
    const run = () => {
      const w = fight(24);
      w.wizards[0].health = mul(w.wizards[0].maxHealth, fx(0.3));
      untilPack(w, 2000);
      ticks(w, 300);
      return w.hash() + ':' + w.lifePacks.pack.x + ',' + w.lifePacks.pack.z;
    };
    expect(run()).toBe(run());
  });
});
