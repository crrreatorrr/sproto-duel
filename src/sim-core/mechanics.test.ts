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
