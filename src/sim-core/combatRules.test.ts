/** Mid-fight god mode, the stunned damage bonus and the boss-phase heal potion (sim-core). */
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import { ONE, fx, mul, sec } from './fixed';
import { replay, type DuelLog } from './index';
import { REWARDS } from './rewards';
import { BUSY, Bot } from './testing/bot';
import { recordMatch } from './testing/record';
import { SimWorld } from './world';

const any = { anyVersion: true };
const m = (v: number) => v / ONE;
const STUNNED = CONFIG.spells.stun.stunnedDamageMultiplier;
const POTION = CONFIG.campaign.phasePotionHeal;
const ALL = (1 << REWARDS.length) - 1;

function fight(bossId = 'broccoli', learned: string[] = []): SimWorld {
  const w = new SimWorld({ seed: 7, rules: 'gauntlet', arena: 'moonlit', staffs: [null, null], bossId, learned });
  w.ais.length = 0;
  while (w.actionsLocked) w.step([null]);
  return w;
}

const at = (w: SimWorld) => ({ x: w.wizards[1].pos.x, y: ONE, z: w.wizards[1].pos.z });

describe('god mode mid-fight', () => {
  it('turns on and off on the world, and gives back only the spells brought', () => {
    const w = fight('broccoli', ['carpet']);
    const p = w.wizards[0];
    expect(p.immune).toBe(false);
    expect(p.learned).toBe(1);
    w.setGodMode(true);
    expect(p.immune && p.infiniteMana && p.noCooldowns).toBe(true);
    expect(m(p.damageMultiplier)).toBe(CONFIG.debug.godPowerMultiplier);
    expect(p.learned).toBe(ALL);
    w.setGodMode(false);
    expect(p.immune || p.infiniteMana || p.noCooldowns).toBe(false);
    expect(p.damageMultiplier).toBe(ONE);
    expect(p.clashPowerMultiplier).toBe(ONE);
    expect(p.learned).toBe(1);
  });

  it('starting in god mode teaches all five spells', () => {
    const w = new SimWorld({ seed: 7, rules: 'gauntlet', arena: 'moonlit', staffs: [null, null], bossId: 'broccoli', learned: [], godMode: true });
    expect(w.wizards[0].learned).toBe(ALL);
    expect(w.wizards[0].immune).toBe(true);
  });

  it('is ignored under even rules', () => {
    const w = new SimWorld({ seed: 7, rules: 'versus', arena: 'moonlit', staffs: [null, null] });
    w.setGodMode(true);
    expect(w.wizards[0].immune).toBe(false);
  });

  it('a log with mid-fight toggles replays to the same end, and differs without them', () => {
    const godToggles = [{ tick: 300, on: true }, { tick: 2400, on: false }, { tick: 3000, on: true }];
    const rec = recordMatch({ seed: 5, rules: 'quick', arena: 'moonlit', staffs: [null, null] }, [new Bot(11, 0, BUSY)], { godToggles });
    expect(rec.world.over).toBe(true);
    expect(rec.log.godToggles).toEqual(godToggles.filter((g) => g.tick < rec.log.ticks));
    const r = replay(rec.log, any);
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.endHash).toBe(rec.world.hash());
    const without: DuelLog = { ...rec.log, godToggles: undefined, claimed: undefined };
    const r2 = replay(without, any);
    expect(r2.ok === false || r2.endHash !== r.endHash).toBe(true);
  });

  it('rejects malformed toggles', () => {
    const rec = recordMatch({ seed: 5, rules: 'quick', arena: 'moonlit', staffs: [null, null] }, [new Bot(11, 0, BUSY)], { maxTicks: 60 * 60 * 40 });
    const base: DuelLog = JSON.parse(JSON.stringify(rec.log));
    const bad = (godToggles: unknown) => replay({ ...base, godToggles } as DuelLog, any);
    expect(bad([{ tick: 10, on: 'yes' }]).error).toBe('bad godToggles');
    expect(bad([{ tick: 20, on: true }, { tick: 10, on: false }]).error).toBe('bad godToggles');
    expect(bad([{ tick: base.ticks, on: true }]).error).toBe('bad godToggles');
    expect(bad({ tick: 1, on: true }).error).toBe('bad godToggles');
  });
});

describe('stunned damage', () => {
  it('a stunned wizard takes more, and its hits deal more', () => {
    const w = fight();
    const [p, e] = w.wizards;
    const hit = (to: typeof p, from: typeof p) => {
      to.health = to.maxHealth;
      return w.spells.dealDamage(to, from, fx(10), at(w), 'fire', null, 0);
    };
    const plain = hit(e, p);
    expect(m(plain)).toBeCloseTo(m(mul(fx(10), e === p ? ONE : p.damageMultiplier)), 3);
    e.applyStun(sec(1));
    expect(m(hit(e, p))).toBeCloseTo(m(plain) * STUNNED, 2);
    e.stunTime = 0;
    p.applyStun(sec(1));
    expect(m(hit(e, p))).toBeCloseTo(m(plain) * STUNNED, 2);
    e.applyStun(sec(1));
    expect(m(hit(e, p))).toBeCloseTo(m(plain) * STUNNED * STUNNED, 2);
  });

  it("the stun beam's own hit gets no bonus, the next hit does", () => {
    const w = fight();
    const [p, e] = w.wizards;
    e.pos.x = p.pos.x;
    e.pos.z = p.pos.z + fx(3);
    const origin = { x: p.pos.x, y: p.pos.y + p.chestY, z: p.pos.z };
    w.events.list.length = 0;
    (w.spells as unknown as { fireBeam(c: typeof p, o: typeof origin, d: typeof origin, r: boolean): void }).fireBeam(p, origin, { x: 0, y: 0, z: ONE }, false);
    expect(e.stunned).toBe(true);
    const beam = w.events.list.find((x) => x.type === 'damage' && x.s === 'stun' && x.w === e.index);
    expect(m(beam!.n)).toBeCloseTo(CONFIG.spells.stun.damage * m(p.spellDamageScale), 2);
    const before = e.health;
    w.spells.dealDamage(e, p, fx(CONFIG.spells.stun.damage), at(w), 'stun', null, 0);
    expect(m(before - e.health)).toBeCloseTo(m(beam!.n) * STUNNED, 2);
  });
});

describe('phase heal potion', () => {
  const nextStage = (w: SimWorld) => {
    const boss = w.wizards[1];
    w.spells.dealDamage(boss, w.wizards[0], boss.health, at(w), 'bolt', null, 0);
  };

  it('each boss transformation heals the player by a share of max health', () => {
    const w = fight();
    const p = w.wizards[0];
    w.events.list.length = 0;
    p.health = mul(p.maxHealth, fx(0.3));
    nextStage(w);
    expect(m(p.health) / m(p.maxHealth)).toBeCloseTo(0.3 + POTION, 2);
    const ev = w.events.list.find((e) => e.type === 'phasePotion');
    expect(ev?.w).toBe(0);
    expect(m(ev!.n) / m(p.maxHealth)).toBeCloseTo(POTION, 2);
    // Never above max health.
    p.health = p.maxHealth - fx(1);
    w.wizards[1].evolveTime = 0;
    nextStage(w);
    expect(p.health).toBe(p.maxHealth);
  });
});
