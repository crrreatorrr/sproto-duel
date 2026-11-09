import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOADOUT_STORAGE_KEY, getLoadout, getOwnedStaffs, setSelectedStaff, setSessionRelics } from './loadout';

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

describe('staff ownership from relics', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installLocalStorage();
  });

  afterEach(() => {
    setSessionRelics(null);
    vi.unstubAllGlobals();
  });

  it('owns only the starter with no relics', () => {
    setSessionRelics([]);
    expect(getOwnedStaffs()).toEqual(['duel_staff_sproto']);
  });

  it("unlocks the Nobu Staff from Cone's Tip", () => {
    setSessionRelics(['cones_tip']);
    expect(getOwnedStaffs()).toEqual(['duel_staff_sproto', 'duel_staff_nobu']);
  });

  it('unlocks the Nobu Staff from the Breakwater Coin alone', () => {
    setSessionRelics(['breakwater_coin']);
    expect(getOwnedStaffs()).toEqual(['duel_staff_sproto', 'duel_staff_nobu']);
    expect(setSelectedStaff('duel_staff_nobu')).toBe(true);
    expect(getLoadout()).toMatchObject({ staff: 'duel_staff_nobu', replaced: null });
  });

  it('owns the Nobu Staff once with both relics', () => {
    setSessionRelics(['cones_tip', 'breakwater_coin']);
    const owned = getOwnedStaffs();
    expect(owned).toEqual(['duel_staff_sproto', 'duel_staff_nobu']);
    const cached = JSON.parse(store.get(LOADOUT_STORAGE_KEY) ?? '{}') as { owned: string[] };
    expect(cached.owned).toEqual(['duel_staff_sproto', 'duel_staff_nobu']);
  });

  it('keeps the other relic staffs alongside the Breakwater Coin', () => {
    setSessionRelics(['hpos10i_core', 'genesis_shard', 'breakwater_coin', 'tinubu_crown']);
    expect(getOwnedStaffs()).toEqual(['duel_staff_sproto', 'duel_staff_momentum', 'duel_staff_moonward', 'duel_staff_nobu']);
  });

  it("unlocks Fighter's Might from the Tidebreaker Belt and lets it be equipped", () => {
    setSessionRelics(['tidebreaker_belt']);
    expect(getOwnedStaffs()).toEqual(['duel_staff_sproto', 'duel_staff_fighters_might']);
    expect(setSelectedStaff('duel_staff_fighters_might')).toBe(true);
    expect(getLoadout()).toMatchObject({ staff: 'duel_staff_fighters_might', replaced: null });
  });

  it("does not own Fighter's Might without the Tidebreaker Belt", () => {
    setSessionRelics(['hpos10i_core', 'genesis_shard', 'cones_tip', 'tinubu_crown', 'breakwater_coin']);
    expect(getOwnedStaffs()).not.toContain('duel_staff_fighters_might');
    expect(setSelectedStaff('duel_staff_fighters_might')).toBe(false);
  });

  it('owns every staff with every relic', () => {
    setSessionRelics(['hpos10i_core', 'genesis_shard', 'cones_tip', 'tinubu_crown', 'tidebreaker_belt', 'breakwater_coin']);
    expect(getOwnedStaffs()).toEqual([
      'duel_staff_sproto', 'duel_staff_momentum', 'duel_staff_moonward', 'duel_staff_nobu', 'duel_staff_fighters_might',
    ]);
  });

  it('drops an equipped Nobu Staff when neither relic is owned', () => {
    setSessionRelics(['breakwater_coin']);
    expect(setSelectedStaff('duel_staff_nobu')).toBe(true);
    setSessionRelics([]);
    expect(getLoadout()).toMatchObject({ staff: 'duel_staff_sproto', replaced: 'Nobu Staff' });
  });
});
