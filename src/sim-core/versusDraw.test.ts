import { describe, expect, it } from 'vitest';
import { HELD_BOLT, SimWorld, emptyInput } from './index';
import type { RulesId } from './rules';

const world = (rules: RulesId) => new SimWorld({ seed: 9, rules, arena: 'moonlit', staffs: [null, null] });
const MINUTES_10 = 60 * 600;

describe('Local Versus: drawn rounds', () => {
  it('two players who never fight get a drawn match after the second drawn round', () => {
    const w = world('versus');
    const ends: number[] = [];
    w.events.on('matchEnd', (e) => ends.push(e.w));
    const idle = [emptyInput(), emptyInput()];
    for (let t = 0; t < MINUTES_10 && !w.over; t++) w.step(idle);
    expect(w.over).toBe(true);
    expect(w.match.roundWinners).toEqual([-1, -1]);
    expect(w.match.wins).toEqual([0, 0]);
    expect(w.match.winner).toBe(-1);
    expect(w.match.lastReason).toBe('time');
    expect(ends).toEqual([-1]);
  });

  it('the side ahead on rounds takes a match that stalls', () => {
    const w = world('versus');
    const fire = emptyInput();
    fire.held = HELD_BOLT;
    fire.aimDist = 15;
    const idle = emptyInput();
    const other = emptyInput();
    other.facing = 512;
    for (let t = 0; t < MINUTES_10 && !w.over; t++) w.step([w.match.wins[0] === 0 ? fire : idle, other]);
    expect(w.over).toBe(true);
    expect(w.match.roundWinners).toEqual([0, -1, -1]);
    expect(w.match.winner).toBe(0);
  });

  it('a single drawn round is replayed, and online rounds are untouched', () => {
    const v = world('versus');
    const idle = [emptyInput(), emptyInput()];
    while (v.match.roundWinners.length < 1) v.step(idle);
    for (let t = 0; t < 600; t++) v.step(idle);
    expect(v.over).toBe(false);
    expect(v.match.round).toBe(2);

    const o = world('online');
    for (let t = 0; t < MINUTES_10 && o.match.roundWinners.length < 3; t++) o.step(idle);
    expect(o.match.roundWinners).toEqual([-1, -1, -1]);
    expect(o.over).toBe(false);
  });
});
