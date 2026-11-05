/** Boss reward spells in the sim (src/sim-core/rewards.ts): cast rules and each spell's effect. */
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import { ONE, fx, sec } from './fixed';
import { R_BREATH, R_CARPET, R_LOCKON, R_PUMP, R_VAPE } from './rewards';
import { quantizeAim } from './testing/bot';
import { SimWorld } from './world';
import { emptyInput, type SimInput } from './wizard';

const RS = CONFIG.rewardSpells;
const ALL = ['carpet', 'pump', 'vape', 'lockon', 'breath'];
const m = (v: number) => v / ONE;

function fight(learned = ALL, bossId = 'sahil', seed = 3): SimWorld {
  const w = new SimWorld({ seed, rules: 'gauntlet', arena: 'moonlit', staffs: [null, null], bossId, learned });
  while (w.actionsLocked) w.step([null]);
  return w;
}

const idle = (): SimInput => emptyInput();
const cast = (i: number, extra: Partial<SimInput> = {}): SimInput => ({ ...emptyInput(), press: 1 << (7 + i), ...extra });
/** Move code for direction d (0 = +z, 8 = +x), full speed. */
const move = (d: number) => 1 + ((d << 2) | 3);

/** Input aiming (and facing) at a world point. */
function aimAt(w: SimWorld, x: number, y: number, z: number, base: SimInput = emptyInput()): SimInput {
  const f = { ...base };
  quantizeAim(w, 0, x, y, z, f);
  f.facing = f.aimYaw;
  return f;
}

function events(w: SimWorld, type: string) {
  return w.events.list.filter((e) => e.type === type);
}

describe('reward spell casting rules', () => {
  it('needs the spell learned, a free caster, no cooldown and the mana', () => {
    const w = fight(['pump']);
    const p = w.wizards[0];
    w.events.take();
    w.step([cast(R_VAPE)]);
    expect(events(w, 'callout').some((e) => e.s === 'NOT LEARNED')).toBe(true);
    expect(p.wants(7 + R_VAPE)).toBe(false);
    expect(w.rewards.smokes.length).toBe(0);

    p.mana = fx(10);
    w.step([cast(R_PUMP)]);
    expect(events(w, 'noMana').length).toBe(1);
    expect(p.pumped).toBe(false);

    p.mana = p.maxMana;
    w.step([cast(R_PUMP)]);
    expect(p.pumped).toBe(true);
    expect(p.rcd[R_PUMP]).toBe(sec(RS.pump.cooldown)); // set this tick, after the timers ran
    expect(m(p.maxMana - p.mana)).toBeCloseTo(RS.pump.manaCost, 0);
    expect(events(w, 'rewardCast').map((e) => e.s)).toEqual(['pump']);

    // On cooldown: the press stays buffered instead of being used up.
    w.step([cast(R_PUMP)]);
    expect(p.wants(7 + R_PUMP)).toBe(true);
  });
});

describe('Magic Carpet', () => {
  it('takes off at the burst speed, hovers, rams once and lands on a second press', () => {
    const w = fight();
    const p = w.wizards[0], boss = w.wizards[1];
    const hp = boss.health;
    w.events.take();
    w.step([cast(R_CARPET, { move: move(0) })]);
    expect(p.riding).toBe(true);
    const launch = CONFIG.wizard.moveSpeed * RS.carpet.speedMultiplier * (1 + RS.carpet.boost);
    expect(m(p.vel.z)).toBeGreaterThan(launch * 0.95);
    for (let i = 0; i < 20; i++) w.step([{ ...idle(), move: move(0) }]);
    expect(m(p.pos.y)).toBeGreaterThan(RS.carpet.hover * 0.8);
    expect(m(p.pos.y)).toBeLessThan(RS.carpet.hover * 1.2);
    // Fly on into the boss (16 m ahead).
    for (let i = 0; i < 80 && boss.health === hp; i++) w.step([{ ...idle(), move: move(0) }]);
    expect(m(hp - boss.health)).toBeCloseTo(RS.carpet.ramDamage, 3);
    expect(events(w, 'carpetRam').length).toBe(1);
    expect(boss.knock.z).toBeGreaterThan(0);
    for (let i = 0; i < 30; i++) w.step([{ ...idle(), move: move(0) }]);
    expect(events(w, 'carpetRam').length).toBe(1); // once per ride
    expect(p.riding).toBe(true);
    w.step([cast(R_CARPET)]);
    expect(p.riding).toBe(false);
  });
});

describe('Pump It', () => {
  it('multiplies the caster damage by 1.5', () => {
    const w = fight();
    const p = w.wizards[0], boss = w.wizards[1];
    const pt = { x: 0, y: ONE, z: 0 };
    const plain = w.spells.dealDamage(boss, p, fx(10), pt, 'bolt', null, 0);
    w.step([cast(R_PUMP)]);
    const pumped = w.spells.dealDamage(boss, p, fx(10), pt, 'bolt', null, 0);
    expect(m(plain)).toBeCloseTo(10, 3);
    expect(m(pumped)).toBeCloseTo(10 * RS.pump.damageMultiplier, 3);
    for (let i = 0; i < sec(RS.pump.duration) / 100 + 1; i++) w.step([idle()]);
    expect(p.pumped).toBe(false);
  });
});

describe('Vape Cloud', () => {
  it('heals the caster inside its own cloud, not just after attacking, and clears after its lifetime', () => {
    const w = fight();
    const p = w.wizards[0];
    w.spells.dealDamage(p, null, fx(50), { x: 0, y: ONE, z: 0 }, 'fire', null, 0);
    w.step([cast(R_VAPE)]);
    expect(w.rewards.smokes.length).toBe(1);
    expect(w.rewards.smokeAt(p.pos.x, p.pos.z, 0)).not.toBeNull();
    const h0 = p.health;
    for (let i = 0; i < 60; i++) w.step([idle()]);
    expect(m(p.health - h0)).toBeCloseTo(RS.vape.healPerSecond, 1);

    // Attacking gives you away: no healing for castHealPause.
    p.sinceAttack = 0;
    const h1 = p.health;
    for (let i = 0; i < 30; i++) w.step([idle()]);
    expect(p.health).toBe(h1);

    for (let i = 0; i < sec(RS.vape.duration) / 100; i++) w.step([idle()]);
    expect(w.rewards.smokes.length).toBe(0);
    expect(events(w, 'rewardEnd').some((e) => e.s === 'vape')).toBe(true);
  });

  it('keeps at most four smoke screens', () => {
    const w = fight();
    for (let i = 0; i < 6; i++) w.rewards.addSmoke(0, fx(i), 0, fx(2.5), fx(3.2), sec(6));
    expect(w.rewards.smokes.length).toBe(4);
    expect(w.rewards.smokes[0].x).toBe(fx(2));
  });
});

describe('Lock-On', () => {
  /** Fire one bolt aimed 18 degrees right of the boss; does it hit? */
  function shot(lock: boolean): { hit: boolean; seek: number } {
    const w = fight();
    const p = w.wizards[0], boss = w.wizards[1];
    if (lock) {
      w.step([cast(R_LOCKON)]);
      expect(p.lockedOn).toBe(true);
    }
    const d = boss.pos.z - p.pos.z;
    const tx = Math.round(d * Math.tan((18 * Math.PI) / 180));
    const hp = boss.health;
    w.step([aimAt(w, tx, boss.pos.y + boss.chestY, boss.pos.z, { ...emptyInput(), press: 1 })]);
    const bolt = w.spells.active.find((b) => b.owner === p);
    expect(bolt).toBeDefined();
    const seek = bolt!.seek;
    for (let i = 0; i < 90; i++) w.step([idle()]);
    return { hit: boss.health < hp, seek };
  }

  it('bolts curve into the target in the cone; without it they miss', () => {
    const on = shot(true);
    expect(on.seek).toBe(1);
    expect(on.hit).toBe(true);
    const off = shot(false);
    expect(off.seek).toBe(-1);
    expect(off.hit).toBe(false);
  });
});

describe('Hellfire Breath', () => {
  it('damages enemies in the cone, sets them burning, and a shield blocks it', () => {
    const w = fight();
    const p = w.wizards[0], boss = w.wizards[1];
    p.pos.z = boss.pos.z - fx(4);
    const hp = boss.health;
    const at = (b: SimInput) => aimAt(w, boss.pos.x, boss.pos.y + boss.chestY, boss.pos.z, b);
    w.events.take();
    w.step([at(cast(R_BREATH))]);
    expect(p.breathing).toBe(true);
    expect(boss.scorched).toBe(true);
    expect(boss.scorchBy).toBe(0);
    for (let i = 0; i < sec(RS.breath.duration) / 100 + 2; i++) w.step([at(idle())]);
    expect(p.breathing).toBe(false);
    const breath = events(w, 'damage').filter((e) => e.w === 1 && e.s === 'breath');
    expect(breath.length).toBeGreaterThanOrEqual(8);
    expect(breath.length).toBeLessThanOrEqual(9);
    expect(m(breath[0].n)).toBeCloseTo(RS.breath.dps * RS.breath.tick, 3);
    expect(events(w, 'rewardEnd').some((e) => e.s === 'breath')).toBe(true);
    // Burning carries on after the flames.
    const after = boss.health;
    for (let i = 0; i < 120; i++) w.step([idle()]);
    expect(boss.health).toBeLessThan(after);
    expect(events(w, 'damage').some((e) => e.w === 1 && e.s === 'scorch')).toBe(true);
    expect(boss.health).toBeLessThan(hp);

    // A shield stops the flames.
    const w2 = fight();
    const p2 = w2.wizards[0], b2 = w2.wizards[1];
    p2.pos.z = b2.pos.z - fx(4);
    b2.shieldTime = sec(5);
    const hp2 = b2.health;
    w2.events.take();
    w2.step([aimAt(w2, b2.pos.x, b2.pos.y + b2.chestY, b2.pos.z, cast(R_BREATH))]);
    expect(b2.health).toBe(hp2);
    expect(b2.scorched).toBe(false);
    expect(events(w2, 'callout').some((e) => e.s === 'BLOCK')).toBe(true);
  });

  it('misses an enemy outside the cone', () => {
    const w = fight();
    const p = w.wizards[0], boss = w.wizards[1];
    p.pos.z = boss.pos.z - fx(4);
    const hp = boss.health;
    // Aim 90 degrees off to the side.
    w.step([aimAt(w, p.pos.x + fx(5), p.pos.y + p.chestY, p.pos.z, cast(R_BREATH))]);
    for (let i = 0; i < 30; i++) w.step([aimAt(w, p.pos.x + fx(5), p.pos.y + p.chestY, p.pos.z)]);
    expect(boss.health).toBe(hp);
  });
});

describe('reward spell determinism', () => {
  it('the same casts give the same hash', () => {
    const run = () => {
      const w = fight(ALL, 'sahil', 11);
      const boss = w.wizards[1];
      for (let t = 0; t < 1500; t++) {
        let f: SimInput = { ...emptyInput(), move: move((t >> 4) % 32), held: t % 180 < 60 ? 1 : 0 };
        if (t % 150 === 10) f.press = 1 << (7 + ((t / 150) | 0) % 5);
        f = aimAt(w, boss.pos.x, boss.pos.y + boss.chestY, boss.pos.z, f);
        w.step([f]);
      }
      return w.hash();
    };
    expect(run()).toBe(run());
  });
});
