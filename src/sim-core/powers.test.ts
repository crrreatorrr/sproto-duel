/** Boss powers in the sim: each kind hits a wizard standing in it and is evaded its own way. */
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import type { PowerDef } from '../campaign/levels';
import type { SimEvent } from './events';
import { ONE, fx, sec } from './fixed';
import { emptyInput } from './wizard';
import { SimWorld } from './world';

type Kind = PowerDef['kind'];
type Dodge = 'none' | 'roll' | 'air' | 'away';

interface Run {
  world: SimWorld;
  def: PowerDef;
  /** Player HP lost (Q16). */
  lost: number;
  events: SimEvent[];
  ticks: number;
}

/**
 * A fight against `bossId` with the cover cleared, the player `dist` m in front of the boss; the
 * boss casts its `kind` power and we step until it has played out.
 */
function play(bossId: string, kind: Kind, dodge: Dodge, opts: { dist?: number; seed?: number; name?: string } = {}): Run {
  const world = new SimWorld({ seed: opts.seed ?? 7, rules: 'gauntlet', arena: 'moonlit', staffs: [null, null], bossId });
  world.ais.length = 0; // these tests drive the powers themselves
  for (let i = 1; i < world.wizards.length; i++) for (const d of world.stages[i - 1].boss.powers) world.powers.setCooldown(world.wizards[i], d, 0);
  while (world.actionsLocked) world.step([emptyInput()]);
  world.events.take();
  // Open floor: cover is tested separately.
  world.arena.obstacles.length = 0;
  const player = world.wizards[0];
  const boss = world.wizards[1];
  const powers = world.boss!.powers.filter((p) => p.kind === kind && (!opts.name || p.name === opts.name));
  const def = powers[0];
  expect(def).toBeTruthy();
  boss.pos.x = 0;
  boss.pos.z = fx(4);
  player.pos.x = 0;
  player.pos.z = boss.pos.z - fx(opts.dist ?? 5);
  const hp0 = player.health;
  expect(world.powers.cast(boss, def, player, 0)).toBe(true);
  expect(world.powers.busy(boss)).toBe(true);
  expect(world.powers.cast(boss, def, player, 0)).toBe(false);
  if (kind === 'flash') {
    // Land it right in front of the player (or behind, to look away).
    const h = world.powers.hazards[0];
    h.at.x = player.pos.x;
    h.at.z = player.pos.z + (dodge === 'away' ? -fx(1.5) : fx(1.5));
  }
  const events: SimEvent[] = world.events.take();
  let ticks = 0;
  while (world.powers.busy(boss) && ticks < 1200) {
    if (dodge === 'roll') player.iframes = sec(1);
    if (dodge === 'air') {
      player.pos.y = fx(kind === 'cloud' ? CONFIG.powers.cloudHeight + 0.5 : CONFIG.wizard.jump.waveClearance + 0.4);
      player.grounded = false;
      player.vy = 0;
    }
    // Standing still: no drift from knockback between checks.
    world.step([emptyInput()]);
    const ev = world.events.take();
    for (let i = 0; i < ev.length; i++) events.push(ev[i]);
    ticks++;
  }
  expect(ticks).toBeLessThan(1200);
  return { world, def, lost: hp0 - player.health, events, ticks };
}

const count = (r: Run, type: string, w = 0) => r.events.filter((e) => e.type === type && e.w === w).length;
const phases = (r: Run) => r.events.filter((e) => e.type === 'bossPower').map((e) => e.s);

const CASES: { kind: Kind; boss: string; dist?: number; evade: Dodge; name?: string }[] = [
  { kind: 'strike', boss: 'agent', evade: 'roll' },
  { kind: 'barrage', boss: 'broccoli', evade: 'roll' },
  { kind: 'march', boss: 'obama', dist: 4.4, evade: 'roll' },
  { kind: 'rings', boss: 'obama', evade: 'air' },
  { kind: 'sweep', boss: 'sahil', evade: 'air' },
  { kind: 'cone', boss: 'broccoli', evade: 'roll' },
  { kind: 'seekers', boss: 'obama', dist: 8, evade: 'roll' },
  { kind: 'flash', boss: 'agent', evade: 'away' },
  { kind: 'cloud', boss: 'broccoli', evade: 'roll' },
];

describe('boss powers', () => {
  for (const c of CASES) {
    it(`${c.kind} hits a wizard standing in it`, () => {
      const r = play(c.boss, c.kind, 'none', { dist: c.dist });
      expect(r.lost).toBeGreaterThan(0);
      const kind = c.kind === 'cloud' ? 'toxic' : 'power';
      expect(r.events.some((e) => e.type === 'damage' && e.w === 0 && e.s === kind && e.n > 0)).toBe(true);
      expect(count(r, 'evaded')).toBe(0);
      const ph = phases(r);
      expect(ph[0]).toBe('cast');
      expect(ph.indexOf('fire')).toBeGreaterThan(0);
      const cast = r.events.filter((e) => e.type === 'bossPower')[0];
      expect(cast.w).toBe(1);
      expect(cast.o).toBe(r.world.boss!.powers.indexOf(r.def));
    });

    it(`${c.kind} is evaded (${c.evade})`, () => {
      const r = play(c.boss, c.kind, c.evade, { dist: c.dist });
      expect(r.lost).toBe(0);
      if (c.kind === 'flash') expect(count(r, 'lookedAway')).toBe(1);
      // The cloud just does no damage (no callout, as in the game).
      else if (c.kind !== 'cloud') expect(count(r, 'evaded')).toBeGreaterThan(0);
    });
  }

  it('rolling evades the flashbang and the rings too', () => {
    expect(play('agent', 'flash', 'roll').lost).toBe(0);
    expect(play('obama', 'rings', 'roll').lost).toBe(0);
    expect(play('sahil', 'sweep', 'roll').lost).toBe(0);
    // Above the cloud's height.
    expect(play('broccoli', 'cloud', 'air').lost).toBe(0);
  });

  it('the flashbang blinds a wizard looking at it', () => {
    const r = play('agent', 'flash', 'none');
    expect(count(r, 'blinded')).toBe(1);
    expect(count(r, 'stunned')).toBe(1);
  });

  it('jumping does not clear a zone', () => {
    // Feet above the wave clearance are still inside a strike's circle.
    const r = play('agent', 'strike', 'air');
    expect(r.lost).toBeGreaterThan(0);
  });

  it('Infection drains mana and ends a golden-ticket boost', () => {
    const world0 = play('tinubu', 'seekers', 'none', { dist: 8 });
    const p = world0.world.wizards[0];
    expect(world0.lost).toBeGreaterThan(0);
    expect(count(world0, 'infected')).toBeGreaterThan(0);
    expect(p.mana).toBeLessThan(fx(CONFIG.wizard.maxMana));
    expect(p.manaBoost).toBe(0);
  });

  it('cover stops the cone', () => {
    const world = new SimWorld({ seed: 3, rules: 'gauntlet', arena: 'moonlit', staffs: [null, null], bossId: 'broccoli' });
  world.ais.length = 0; // these tests drive the powers themselves
  for (let i = 1; i < world.wizards.length; i++) for (const d of world.stages[i - 1].boss.powers) world.powers.setCooldown(world.wizards[i], d, 0);
    while (world.actionsLocked) world.step([emptyInput()]);
    const ob = world.arena.obstacles[0];
    const boss = world.wizards[1], player = world.wizards[0];
    // Boss and player on either side of the first piece of cover.
    boss.pos.x = ob.x;
    boss.pos.z = ob.z + fx(3.5);
    player.pos.x = ob.x;
    player.pos.z = ob.z - fx(3);
    expect(world.arena.clear(boss.pos.x, boss.pos.y + boss.chestY, boss.pos.z, player.pos.x, player.pos.y + player.chestY, player.pos.z, true)).toBe(false);
    const def = world.boss!.powers.filter((p) => p.kind === 'cone')[0];
    const hp0 = player.health;
    world.events.take();
    expect(world.powers.cast(boss, def, player, 0)).toBe(true);
    let covered = 0;
    for (let i = 0; i < 200 && world.powers.busy(boss); i++) {
      world.step([emptyInput()]);
      covered += world.events.take().filter((e) => e.type === 'cover' && e.w === 0).length;
    }
    expect(covered).toBe(1);
    expect(player.health).toBe(hp0);
  });

  it('recharges, keeps the gap and is called off when the boss transforms', () => {
    const world = new SimWorld({ seed: 1, rules: 'gauntlet', arena: 'moonlit', staffs: [null, null], bossId: 'agent' });
  world.ais.length = 0; // these tests drive the powers themselves
  for (let i = 1; i < world.wizards.length; i++) for (const d of world.stages[i - 1].boss.powers) world.powers.setCooldown(world.wizards[i], d, 0);
    while (world.actionsLocked) world.step([emptyInput()]);
    const boss = world.wizards[1], player = world.wizards[0];
    const def = world.boss!.powers[0];
    expect(world.powers.open).toBe(true);
    expect(world.powers.cast(boss, def, player, 2)).toBe(true);
    expect(world.powers.open).toBe(false);
    expect(world.powers.cooldown(boss, def)).toBe(world.powers.recharge(def, 2));
    expect(world.powers.recharge(def, 2)).toBe(sec(def.cooldown * CONFIG.powers.stageRecharge[2]));
    world.step([emptyInput()]);
    expect(world.powers.cooldown(boss, def)).toBe(world.powers.recharge(def, 2) - 100);
    expect(world.powers.busy(boss)).toBe(true);
    // The stage-1 bar breaks: it transforms and the strike is called off.
    world.spells.dealDamage(boss, player, boss.health + ONE, { x: 0, y: 0, z: 0 }, 'bolt', null, 0);
    world.step([emptyInput()]);
    expect(boss.evolving).toBe(true);
    expect(world.powers.busy(boss)).toBe(false);
    for (let i = 0; i < sec(CONFIG.powers.gap) / 100; i++) world.step([emptyInput()]);
    expect(world.powers.open).toBe(true);
  });

  it('the cone and the sweep make their caster channel, facing the beam', () => {
    const world = new SimWorld({ seed: 2, rules: 'gauntlet', arena: 'moonlit', staffs: [null, null], bossId: 'sahil' });
  world.ais.length = 0; // these tests drive the powers themselves
  for (let i = 1; i < world.wizards.length; i++) for (const d of world.stages[i - 1].boss.powers) world.powers.setCooldown(world.wizards[i], d, 0);
    while (world.actionsLocked) world.step([emptyInput()]);
    const boss = world.wizards[1], player = world.wizards[0];
    expect(world.powers.channelFacing(boss)).toBe(-1);
    world.powers.cast(boss, world.boss!.powers.filter((p) => p.kind === 'sweep')[0], player, 0);
    expect(world.powers.channeling(boss)).toBe(true);
    const f = world.powers.channelFacing(boss);
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThan(65536);
  });

  it('is deterministic', () => {
    for (const c of CASES) {
      const a = play(c.boss, c.kind, 'none', { dist: c.dist, seed: 11 });
      const b = play(c.boss, c.kind, 'none', { dist: c.dist, seed: 11 });
      expect(a.world.hash()).toBe(b.world.hash());
      expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    }
  });
});
