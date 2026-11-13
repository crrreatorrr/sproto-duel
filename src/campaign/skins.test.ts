import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODELS } from '../assets/manifest';
import { CAMPAIGN_STORAGE_KEY, Campaign, migratedDefeated } from './Campaign';
import { LEGACY_CAMPAIGN_KEY } from './progress';
import { BOSSES } from './levels';
import { DEFAULT_SKIN, SKINS, SKIN_STORAGE_KEY, getSelectedSkin, setSelectedSkin, skinDef, skinScale } from './skins';

function installLocalStorage(): Map<string, string> {
  const map = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  });
  return map;
}

describe('character skins', () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = installLocalStorage();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lists Sproto and every boss fighter, partner included, with stage-1 looks', () => {
    expect(SKINS[0].id).toBe(DEFAULT_SKIN);
    expect(SKINS.map((s) => s.id)).toEqual(['sproto', 'sahil', 'obama', 'midget', 'broccoli', 'agent', 'tinubu']);
    expect(skinDef('midget')!.unlockedBy).toBe('Bitcoin Obama & The Midget');
    expect(skinDef('tinubu')!.model).toBe('bossTinubu1');
    // Scaled to the player's height whatever the boss's.
    for (const s of SKINS) expect((MODELS[s.model].fitHeight ?? 0) * skinScale(s)).toBeCloseTo(MODELS.wizardPlayer.fitHeight, 6);
  });

  it('remembers the choice; unknown ids fall back to Sproto', () => {
    expect(getSelectedSkin()).toBe(DEFAULT_SKIN);
    expect(setSelectedSkin('broccoli')).toBe(true);
    expect(getSelectedSkin()).toBe('broccoli');
    expect(setSelectedSkin('nobody')).toBe(false);
    store.set(SKIN_STORAGE_KEY, 'nobody');
    expect(getSelectedSkin()).toBe(DEFAULT_SKIN);
  });

  it('a saved win unlocks the boss (and its partner); a skipped run unlocks nothing', () => {
    const c = new Campaign();
    expect(c.defeated).toEqual([]);
    c.startNew();
    expect(c.recordWin()).toBe('next');
    expect(c.defeated).toEqual(['sahil']);
    c.advance();
    expect(c.recordWin()).toBe('next');
    expect(c.defeated).toEqual(['sahil', 'obama', 'midget']);
    // Saved, and survives forgetting the spells.
    c.forgetSpells();
    expect(new Campaign().defeated).toEqual(['sahil', 'obama', 'midget']);
    // Past the save (earlier fights won in god mode): nothing new.
    c.advance();
    c.advance();
    expect(c.recordWin()).toBe('unsaved');
    expect(c.defeated).toEqual(['sahil', 'obama', 'midget']);
    c.reset();
    expect(c.defeated).toEqual([]);
  });

  it('older saves derive the beaten bosses from progress', () => {
    expect(migratedDefeated(0, 0, [])).toEqual([]);
    expect(migratedDefeated(2, 0, [])).toEqual(['sahil', 'obama', 'midget']);
    expect(migratedDefeated(0, 0, [BOSSES[3].reward])).toEqual(['agent']);
    expect(migratedDefeated(0, 1, [])).toEqual(SKINS.slice(1).map((s) => s.id));
    // A save from before skins, under the old campaign key: read into this browser's progress copy.
    store.set(LEGACY_CAMPAIGN_KEY, JSON.stringify({ version: 2, next: 1, clears: 0, unlockedSpells: ['carpet'] }));
    const c = new Campaign();
    expect(c.defeated).toEqual(['sahil']);
    expect(JSON.parse(store.get(CAMPAIGN_STORAGE_KEY)!).defeated).toEqual(['sahil']);
  });
});
