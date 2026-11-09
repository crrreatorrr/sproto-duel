import { describe, expect, it } from 'vitest';
import { STAFF_IDS } from '../staff/catalog';
import { titleStaffCycle } from './titleStaffs';

const ids = (list: { id: string }[]) => list.map((s) => s.id);
const locked = (list: { id: string; locked: boolean }[]) => list.filter((s) => s.locked).map((s) => s.id);

describe('titleStaffCycle', () => {
  it('cycles only the owned staffs with a hub session, none locked', () => {
    const list = titleStaffCycle(true, ['duel_staff_sproto', 'duel_staff_nobu']);
    expect(ids(list)).toEqual(['duel_staff_sproto', 'duel_staff_nobu']);
    expect(locked(list)).toEqual([]);
  });

  it('always includes the starter staff with a session that owns nothing else', () => {
    expect(ids(titleStaffCycle(true, []))).toEqual(['duel_staff_sproto']);
  });

  it('cycles every staff without a session, the unowned ones locked', () => {
    const list = titleStaffCycle(false, ['duel_staff_sproto']);
    expect(ids(list)).toEqual([...STAFF_IDS]);
    expect(locked(list)).toEqual(['duel_staff_momentum', 'duel_staff_moonward', 'duel_staff_nobu', 'duel_staff_fighters_might', 'duel_staff_alien_ray']);
  });

  it('unlocks staffs the local cache owns when there is no session', () => {
    const list = titleStaffCycle(false, ['duel_staff_sproto', 'duel_staff_moonward']);
    expect(ids(list)).toEqual([...STAFF_IDS]);
    expect(locked(list)).toEqual(['duel_staff_momentum', 'duel_staff_nobu', 'duel_staff_fighters_might', 'duel_staff_alien_ray']);
  });

  it('starts at the equipped staff and keeps catalog order after it', () => {
    const list = titleStaffCycle(true, [...STAFF_IDS], 'duel_staff_moonward');
    expect(ids(list)).toEqual(['duel_staff_moonward', 'duel_staff_nobu', 'duel_staff_fighters_might', 'duel_staff_alien_ray', 'duel_staff_sproto', 'duel_staff_momentum']);
  });

  it('ignores a start staff that is not in the cycle', () => {
    expect(ids(titleStaffCycle(true, [], 'duel_staff_nobu'))).toEqual(['duel_staff_sproto']);
  });

  it('carries the name and accent from the catalog', () => {
    const [sproto] = titleStaffCycle(false, []);
    expect(sproto).toMatchObject({ id: 'duel_staff_sproto', name: 'Sproto Staff', accent: '#ffd21f', locked: false });
  });
});
