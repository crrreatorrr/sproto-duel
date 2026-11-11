/** Feel checks: the sim's movement and spell numbers match the tuning the game had (src/config.ts). */
import { describe, expect, it } from 'vitest';
import { layoutSpots } from '../arena/layouts';
import { CONFIG } from '../config';
import { ARENA_IDS, ARENA_LAYOUTS, ONE, SimArena, SimWorld, emptyInput, type SimInput } from './index';

const W = CONFIG.wizard;

function fight(): SimWorld {
  const w = new SimWorld({ seed: 1, rules: 'versus', arena: 'moonlit', staffs: [null, null] });
  // Skip the intro countdown.
  while (w.actionsLocked) w.step([null, null]);
  return w;
}

const press = (bit: number): SimInput => ({ ...emptyInput(), press: 1 << bit });
const m = (v: number) => v / ONE;

describe('movement feel', () => {
  it('walks at moveSpeed and sprints at sprintSpeed', () => {
    const w = fight();
    const go: SimInput = { ...emptyInput(), move: 1 + ((8 << 2) | 3) }; // +x, full
    for (let i = 0; i < 30; i++) w.step([go, null]);
    expect(m(w.wizards[0].vel.x)).toBeCloseTo(W.moveSpeed, 2);
    const run: SimInput = { ...go, held: 2 };
    for (let i = 0; i < 30; i++) w.step([run, null]);
    expect(m(w.wizards[0].vel.x)).toBeCloseTo(W.sprintSpeed, 2);
    expect(w.wizards[0].sprinting).toBe(true);
  });

  it('jumps to a 1.4 m apex and lands after ~0.68 s', () => {
    const w = fight();
    w.step([press(6), null]);
    let apex = 0, t = 1;
    while (!w.wizards[0].grounded && t < 200) {
      apex = Math.max(apex, m(w.wizards[0].pos.y));
      w.step([null, null]);
      t++;
    }
    expect(apex).toBeGreaterThan(1.36);
    expect(apex).toBeLessThan(1.42);
    expect(t / 60).toBeGreaterThan(0.64);
    expect(t / 60).toBeLessThan(0.72);
  });

  it('a dodge roll covers the configured distance', () => {
    const w = fight();
    const z0 = w.wizards[0].pos.z;
    w.step([{ ...press(5), move: 1 + ((0 << 2) | 3) }, null]);
    for (let i = 0; i < 40; i++) w.step([null, null]);
    // integral of speed (1 - 0.55 t^2) over the duration: speed * duration * (1 - 0.55 / 3), then the stop.
    const roll = W.dodge.speed * W.dodge.duration * (1 - 0.55 / 3);
    expect(m(w.wizards[0].pos.z - z0)).toBeGreaterThan(roll);
    expect(m(w.wizards[0].pos.z - z0)).toBeLessThan(roll + 1.5);
  });
});

describe('roll cooldown and its input buffer', () => {
  const idle = [null, null];
  /** Roll once, then press again `early` s before the cooldown is over; true if a second roll came. */
  function secondRoll(early: number): boolean {
    const w = fight();
    const p = w.wizards[0];
    w.step([press(5), null]);
    expect(p.stats.dodges).toBe(1);
    const wait = Math.round((W.dodge.duration + W.dodge.cooldown - early) * 60) - 1;
    for (let i = 0; i < wait; i++) w.step(idle);
    w.step([press(5), null]);
    for (let i = 0; i < 40; i++) w.step(idle);
    return p.stats.dodges === 2;
  }

  it('a press up to dodge.inputBuffer before the roll is ready still rolls', () => {
    expect(W.dodge.inputBuffer).toBeGreaterThan(CONFIG.feel.inputBuffer);
    expect(secondRoll(W.dodge.inputBuffer - 0.05)).toBe(true);
    // Earlier than that it is forgotten (other actions keep the shorter buffer).
    expect(secondRoll(W.dodge.inputBuffer + 0.1)).toBe(false);
  });

  it('cannot be rolled again until duration + cooldown have passed', () => {
    const w = fight();
    const p = w.wizards[0];
    let rolls = 0;
    w.events.on('dodge', (e) => {
      if (e.w === 0) rolls++;
    });
    for (let i = 0; i < 600; i++) w.step([press(5), null]);
    const cycle = W.dodge.duration + W.dodge.cooldown;
    expect(rolls).toBe(Math.ceil(10 / cycle));
    // Invulnerable for under a fifth of the time when rolled on cooldown.
    expect(W.dodge.iframes / cycle).toBeLessThan(0.2);
    expect(p.stats.dodges).toBe(rolls);
  });
});

describe('mana economy', () => {
  const S = CONFIG.spells;
  const fire: SimInput = { ...emptyInput(), held: 1, aimDist: 15 };

  it('held fire drains the bar slowly instead of emptying it in a few seconds', () => {
    const w = fight();
    const p = w.wizards[0];
    expect(m(p.mana)).toBe(W.maxMana);
    // Five seconds of held fire used to leave nothing (100 mana, 29 a second, no regen while firing).
    for (let i = 0; i < 300; i++) w.step([fire, null]);
    expect(m(p.mana)).toBeGreaterThan(W.maxMana - 5 * 14);
    // A full bar lasts at least ten seconds before a Blast is out of reach.
    for (let i = 0; i < 300; i++) w.step([fire, null]);
    expect(m(p.mana)).toBeGreaterThanOrEqual(S.blast.manaCost);
  });

  it('never locks the kit: at the floor, two seconds off the trigger buys a Blast', () => {
    const w = fight();
    const p = w.wizards[0];
    for (let i = 0; i < 60 * 40; i++) w.step([fire, null]);
    expect(m(p.mana)).toBeLessThan(S.blast.manaCost);
    // Still firing at the regen rate: about manaRegen / cost a second.
    const casts = p.stats.casts;
    for (let i = 0; i < 600; i++) w.step([fire, null]);
    const perSecond = (p.stats.casts - casts) / 10;
    expect(perSecond).toBeGreaterThan((W.manaRegen / S.bolt.manaCost) * 0.85);
    for (let i = 0; i < 120; i++) w.step([null, null]);
    expect(m(p.mana)).toBeGreaterThanOrEqual(S.blast.manaCost);
  });

  it('regen does not wait after a spend', () => {
    const w = fight();
    const p = w.wizards[0];
    w.step([{ ...press(1), aimDist: 15 }, null]);
    for (let i = 0; i < 20; i++) w.step([null, null]);
    const after = p.mana;
    expect(m(after)).toBeLessThan(W.maxMana);
    w.step([null, null]);
    expect(p.mana).toBeGreaterThan(after);
  });
});

describe('arena parity', () => {
  it('builds the same obstacles, in the same order, as the game layouts', () => {
    for (const id of ARENA_IDS) {
      const sim = new SimArena(id);
      const spots = layoutSpots(ARENA_LAYOUTS[id]);
      expect(sim.obstacles.length).toBe(spots.length);
      sim.obstacles.forEach((ob, i) => {
        expect(m(ob.x)).toBeCloseTo(spots[i].x, 3);
        expect(m(ob.z)).toBeCloseTo(spots[i].z, 3);
        expect(ob.kind).toBe(spots[i].shape.kind);
        expect(m(ob.maxHp)).toBe(spots[i].shape.hp);
      });
    }
  });
});

describe('determinism', () => {
  it('same seed and inputs give the same hash; a different seed differs', () => {
    const run = (seed: number) => {
      const w = new SimWorld({ seed, rules: 'quick', arena: 'office', staffs: ['duel_staff_momentum', null] });
      for (let t = 0; t < 3000; t++) {
        const a: SimInput = { ...emptyInput(), move: 1 + (((t >> 5) % 32) << 2 | 3), held: t % 200 < 120 ? 1 : 2, press: t % 97 === 0 ? 1 << 5 : t % 61 === 0 ? 1 << 1 : 0, aimYaw: (t * 7) & 1023, aimDist: 15 };
        w.step([a, { ...emptyInput(), facing: 512, held: 1, aimYaw: 512, aimDist: 15 }]);
      }
      return w.hash();
    };
    expect(run(5)).toBe(run(5));
    expect(run(5)).not.toBe(run(6));
  });
});
