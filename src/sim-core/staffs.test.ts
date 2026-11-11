/** Staff bolt stats in the sim: the Alien Ray Staff's bolts deal three times the stock damage. */
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import { ONE, fx } from './fixed';
import { STAFFS } from './staffs';
import { CD_BOLT, HELD_BOLT, type SimInput } from './wizard';
import { SimWorld } from './world';

const FIRE: SimInput = { move: 0, held: HELD_BOLT, press: 0, facing: 0, aimYaw: 0, aimPitch: 0, aimDist: 10 };

/** Damage of the first bolt seat 0 fires with `staff` in a Quick Duel. */
function firstBoltDamage(staff: string | null): number {
  const w = new SimWorld({ seed: 3, rules: 'quick', arena: 'moonlit', staffs: [staff, null] });
  w.ais.length = 0;
  while (w.actionsLocked) w.step([null]);
  for (let i = 0; i < 30; i++) {
    w.step([FIRE]);
    const bolt = w.spells.active.find((p) => p.kind === 'bolt' && p.caster === w.wizards[0]);
    if (bolt) return bolt.damage / ONE;
  }
  throw new Error('no bolt fired');
}

describe('staff bolt damage', () => {
  it('the Alien Ray Staff is 3x the stock bolt at the stock fire rate', () => {
    expect(STAFFS.duel_staff_alien_ray.boltDamage).toBe(3 * ONE);
    expect(STAFFS.duel_staff_alien_ray.boltInterval).toBe(ONE);
    const stock = firstBoltDamage(null);
    expect(stock).toBe(CONFIG.spells.bolt.damage);
    expect(firstBoltDamage('duel_staff_alien_ray')).toBe(stock * 3);
  });

  it.each([
    ['duel_staff_fighter', 0, 10],
    ['duel_staff_shooter', 10, 24],
  ])('%s fires for %i mana and deals %i damage', (staff, mana, damage) => {
    const w = new SimWorld({ seed: 3, rules: 'quick', arena: 'moonlit', staffs: [staff, null] });
    w.ais.length = 0;
    while (w.actionsLocked) w.step([null]);
    const player = w.wizards[0];
    player.mana = fx(Math.max(0, mana - 1));
    player.manaDelay = 6000;
    w.step([FIRE]);
    if (mana > 0) {
      expect(w.spells.active).toHaveLength(0);
      player.cd[CD_BOLT] = 0;
      player.mana = fx(mana);
      w.step([FIRE]);
    }
    expect(player.mana).toBe(0);
    expect(w.spells.active[0]?.damage).toBe(fx(damage));
  });

  it('is a look only under even rules (Local Versus and online)', () => {
    const w = new SimWorld({ seed: 3, rules: 'versus', arena: 'moonlit', staffs: ['duel_staff_alien_ray', null] });
    expect(w.wizards[0].staff).toBeNull();
  });
});
