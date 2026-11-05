import { describe, expect, it } from 'vitest';
import { SimWorld, emptyInput, HELD_BOLT, atan2, sin, cos, ONE, isqrt } from './index';

describe('sim-core smoke', () => {
  it('trig sanity', () => {
    expect(sin(0)).toBe(0);
    expect(sin(16384)).toBe(ONE);
    expect(Math.abs(cos(32768) + ONE)).toBeLessThan(2);
    expect(atan2(0, ONE)).toBe(0);
    expect(Math.abs(atan2(ONE, 0) - 16384)).toBeLessThan(3);
    expect(Math.abs(atan2(0, -ONE) - 32768)).toBeLessThan(3);
    expect(Math.abs(atan2(-ONE, 0) - 49152)).toBeLessThan(3);
    expect(Math.abs(atan2(ONE, ONE) - 8192)).toBeLessThan(3);
    expect(isqrt(1e15)).toBe(31622776);
  });
  it('a duel where seat 0 holds fire at seat 1', () => {
    const w = new SimWorld({ seed: 7, rules: 'versus', arena: 'moonlit', staffs: ['duel_staff_sproto', null] });
    const a = emptyInput();
    a.held = HELD_BOLT;
    a.aimDist = 15;
    const b = emptyInput();
    b.facing = 512;
    let t = 0;
    for (; t < 60 * 300 && !w.over; t++) w.step([a, b]);
    console.log('ticks', t, w.match, w.wizards.map((x) => [x.health / ONE, x.mana / ONE]));
    expect(w.over).toBe(true);
    expect(w.match.winner).toBe(0);
  });
});
