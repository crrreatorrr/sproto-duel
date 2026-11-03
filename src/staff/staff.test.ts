import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../config';
import {
  STAFF_IDS,
  equipStaff,
  staffBoltDamage,
  staffBoltInterval,
  staffModelPath,
  staffName,
  type StaffId,
} from './catalog';
import { LOADOUT_STORAGE_KEY, getLoadout, getOwnedStaffs, setSelectedStaff, setSessionRelics } from './loadout';

const MIGHT: StaffId = 'duel_staff_fighters_might';

function installLocalStorage(): Map<string, string> {
  const map = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  });
  return map;
}

describe("Fighter's Might ownership", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installLocalStorage();
    setSessionRelics(null);
  });

  afterEach(() => {
    setSessionRelics(null);
    vi.unstubAllGlobals();
  });

  it('is in the catalog', () => {
    expect(STAFF_IDS).toContain(MIGHT);
    expect(staffName(MIGHT)).toBe("Fighter's Might");
  });

  it('is unlocked by the Tidebreaker Belt', () => {
    setSessionRelics(['tidebreaker_belt']);
    expect(getOwnedStaffs()).toEqual(['duel_staff_sproto', MIGHT]);
    expect(setSelectedStaff(MIGHT)).toBe(true);
    expect(getLoadout().staff).toBe(MIGHT);
  });

  it('is not owned without the Belt', () => {
    setSessionRelics(['hpos10i_core', 'genesis_shard', 'cones_tip', 'tinubu_crown']);
    expect(getOwnedStaffs()).not.toContain(MIGHT);
    expect(setSelectedStaff(MIGHT)).toBe(false);
    setSessionRelics([]);
    expect(getOwnedStaffs()).toEqual(['duel_staff_sproto']);
  });

  it('falls back to Sproto when a saved Fighter\'s Might is no longer owned', () => {
    setSessionRelics(['tidebreaker_belt']);
    expect(setSelectedStaff(MIGHT)).toBe(true);
    setSessionRelics([]);
    const load = getLoadout();
    expect(load.staff).toBe('duel_staff_sproto');
    expect(load.replaced).toBe("Fighter's Might");
  });

  it('stacks with the other relic staffs in catalog order', () => {
    setSessionRelics(['tidebreaker_belt', 'cones_tip', 'hpos10i_core', 'genesis_shard']);
    expect(getOwnedStaffs()).toEqual([...STAFF_IDS]);
  });

  it('caches the Belt unlock for a visit without a hub session', () => {
    setSessionRelics(['tidebreaker_belt']);
    expect(JSON.parse(store.get(LOADOUT_STORAGE_KEY)!).owned).toContain(MIGHT);
    setSessionRelics(null);
    expect(getOwnedStaffs()).toContain(MIGHT);
  });
});

describe("Fighter's Might bolt", () => {
  const B = CONFIG.spells.bolt;

  it('deals 2× damage and fires 1.85× slower', () => {
    const staff = equipStaff(MIGHT, false);
    expect(staff.boltDamageMult).toBe(2);
    expect(staff.boltIntervalMult).toBe(1.85);
    expect(staffBoltDamage(staff)).toBe(B.damage * 2);
    expect(staffBoltInterval(staff)).toBeCloseTo(B.fireInterval * 1.85, 10);
  });

  it('stays a sidegrade: held-fire DPS above the starter but at most 1.1×', () => {
    const dps = (id: StaffId) => {
      const s = equipStaff(id, false);
      return staffBoltDamage(s) / staffBoltInterval(s);
    };
    const starter = dps('duel_staff_sproto');
    expect(starter).toBeCloseTo(B.damage / B.fireInterval, 10);
    const ratio = dps(MIGHT) / starter;
    expect(ratio).toBeGreaterThan(1);
    expect(ratio).toBeLessThanOrEqual(1.1);
    // Moonward's 1.5× stays the high-DPS staff.
    expect(dps('duel_staff_moonward')).toBeGreaterThan(dps(MIGHT));
  });

  it('every other staff keeps the stock fire rate', () => {
    for (const id of STAFF_IDS) {
      if (id === MIGHT) continue;
      expect(equipStaff(id, false).boltIntervalMult).toBe(1);
    }
    expect(staffBoltInterval(null)).toBe(B.fireInterval);
    expect(staffBoltDamage(null)).toBe(B.damage);
  });

  it('ranked strips the gameplay params but keeps the fist look and colours', () => {
    const staff = equipStaff(MIGHT, true);
    expect(staff.boltDamageMult).toBe(1);
    expect(staff.boltIntervalMult).toBe(1);
    expect(staff.boltSkin).toBe('fist');
    expect(staff.boltColor).toBe(0xffd21f);
  });

  it('flies as a fist; other staffs keep the orb', () => {
    expect(equipStaff(MIGHT, false).boltSkin).toBe('fist');
    for (const id of STAFF_IDS) if (id !== MIGHT) expect(equipStaff(id, false).boltSkin).toBeNull();
  });

  it('loads its GLB from the staff_fighters_might placeholder path', () => {
    expect(staffModelPath(MIGHT)).toBe('models/staffs/staff_fighters_might-lod1.glb');
    expect(equipStaff(MIGHT, false).clip).toBe('staff_fighters_might_idle');
  });
});
