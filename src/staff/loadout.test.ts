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

  it('unlocks the Alien Ray Staff from the Breakwater Coin (Sproto Arcade, Bront beaten)', () => {
    setSessionRelics(['breakwater_coin']);
    expect(getOwnedStaffs()).toEqual(['duel_staff_sproto', 'duel_staff_alien_ray']);
    expect(setSelectedStaff('duel_staff_alien_ray')).toBe(true);
    expect(getLoadout()).toMatchObject({ staff: 'duel_staff_alien_ray', replaced: null });
  });

  it("owns the Nobu Staff and the Alien Ray Staff with Cone's Tip and the Breakwater Coin", () => {
    setSessionRelics(['cones_tip', 'breakwater_coin']);
    const owned = getOwnedStaffs();
    expect(owned).toEqual(['duel_staff_sproto', 'duel_staff_nobu', 'duel_staff_alien_ray']);
    const cached = JSON.parse(store.get(LOADOUT_STORAGE_KEY) ?? '{}') as { owned: string[] };
    expect(cached.owned).toEqual(['duel_staff_sproto', 'duel_staff_nobu', 'duel_staff_alien_ray']);
  });

  it('keeps the other relic staffs alongside the Breakwater Coin', () => {
    setSessionRelics(['hpos10i_core', 'genesis_shard', 'breakwater_coin', 'tinubu_crown']);
    expect(getOwnedStaffs()).toEqual(['duel_staff_sproto', 'duel_staff_momentum', 'duel_staff_moonward', 'duel_staff_alien_ray']);
  });

  it('drops an equipped Alien Ray Staff when the Breakwater Coin is not owned', () => {
    setSessionRelics(['breakwater_coin']);
    expect(setSelectedStaff('duel_staff_alien_ray')).toBe(true);
    setSessionRelics([]);
    expect(getLoadout()).toMatchObject({ staff: 'duel_staff_sproto', replaced: 'Alien Ray Staff' });
  });

  it('drops an equipped Nobu Staff when Cone\'s Tip is not owned', () => {
    setSessionRelics(['cones_tip']);
    expect(setSelectedStaff('duel_staff_nobu')).toBe(true);
    setSessionRelics([]);
    expect(getLoadout()).toMatchObject({ staff: 'duel_staff_sproto', replaced: 'Nobu Staff' });
  });
});
