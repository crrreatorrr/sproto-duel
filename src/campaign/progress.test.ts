import { describe, expect, it } from 'vitest';
import { SAVE_MAX_BYTES, type KeyValue, type ProgressCloud, type SaveResult } from '@metaverse/hub-sdk';
import { Campaign } from './Campaign';
import { BOSSES, bossFighters } from './levels';
import { FIGHTER_IDS, LEGACY_CAMPAIGN_KEY, LEGACY_SETTINGS_KEY, PROGRESS_KEY, campaignProgressModel, type CampaignProgress } from './progress';
import { REWARD_SPELLS } from '../spells/rewardCatalog';

const disk = (seed: Record<string, string> = {}): KeyValue & { values: Map<string, string> } => {
  const values = new Map(Object.entries(seed));
  return { values, getItem: (k) => values.get(k) ?? null, setItem: (k, v) => void values.set(k, v), removeItem: (k) => void values.delete(k) };
};

/** Cloud saves on a fake hub, one per player. */
const hub = () => {
  const saves = new Map<string, SaveResult>();
  return {
    saves,
    as: (player: string): ProgressCloud => ({
      loadSave: async () => saves.get(player) ?? { data: null, updatedAt: 0 },
      writeSave: async (data) => {
        const saved = { data: JSON.parse(JSON.stringify(data)) as Record<string, unknown>, updatedAt: Date.now() };
        saves.set(player, saved);
        return saved;
      },
    }),
  };
};

const campaign = (storage: KeyValue) => new Campaign({ storage, pushDelayMs: 0 });

/** Win `count` fights of a fresh run. */
function winFights(c: Campaign, count: number): void {
  c.startNew();
  for (let i = 0; i < count; i++) {
    c.recordWin();
    c.advance();
  }
}

function winGauntlet(c: Campaign): void {
  c.startNew();
  for (let i = 0; i < BOSSES.length; i++) {
    expect(c.recordWin()).toBe(i === BOSSES.length - 1 ? 'complete' : 'next');
    c.advance();
  }
}

describe('campaign progress model', () => {
  const samples: CampaignProgress[] = [
    campaignProgressModel.empty(),
    { clears: 2, defeated: [FIGHTER_IDS[0]], spells: { [REWARD_SPELLS[0]]: 0 }, forgets: 0, practiceDone: false },
    { clears: 0, defeated: [FIGHTER_IDS[1]], spells: { [REWARD_SPELLS[0]]: 1, [REWARD_SPELLS[2]]: 0 }, forgets: 1, practiceDone: true },
    { clears: 5, defeated: [...FIGHTER_IDS], spells: { [REWARD_SPELLS[1]]: 3 }, forgets: 3, practiceDone: false },
  ];
  const m = campaignProgressModel.merge;

  it('merges in any order, and merging a copy with itself changes nothing', () => {
    for (const a of samples) {
      expect(m(a, a)).toEqual(a);
      for (const b of samples) {
        expect(m(a, b)).toEqual(m(b, a));
        for (const c of samples) expect(m(m(a, b), c)).toEqual(m(a, m(b, c)));
      }
    }
  });

  it('reads anything without throwing', () => {
    for (const raw of [null, 7, 'x', [], { clears: -3, defeated: 'no', spells: [], forgets: 'z' }, { spells: { nope: 4 } }]) {
      expect(campaignProgressModel.normalize(raw)).toEqual(campaignProgressModel.empty());
    }
  });
});

describe('campaign progress per hub account', () => {
  it('starts a new account empty on a browser that already has progress, and keeps accounts apart', async () => {
    const browser = disk();
    const server = hub();
    const c = campaign(browser);
    winFights(c, 2);
    c.markPracticeDone();
    expect(c.unlocked).toEqual([BOSSES[0].reward, BOSSES[1].reward]);
    expect(c.canContinue).toBe(true);

    await c.attach(server.as('new-account'), 'new-account');
    expect(c.owner().kind).toBe('account');
    expect(c.unlocked).toEqual([]);
    expect(c.defeated).toEqual([]);
    expect(c.practiceDone).toBe(false);
    expect(c.canContinue).toBe(false);
    expect(c.saved.clears).toBe(0);

    await c.attach(server.as('alice'), 'alice');
    winGauntlet(c);
    await c.flush();
    expect(c.sync()).toBe('synced');
    expect(server.saves.get('alice')?.data).toMatchObject({ clears: 1 });
    // Alice's wins went nowhere else.
    expect(server.saves.get('new-account')).toBeUndefined();

    c.release();
    expect(c.owner().kind).toBe('device');
    expect(c.saved.clears).toBe(0);
    expect(c.unlocked).toEqual([BOSSES[0].reward, BOSSES[1].reward]);
    expect(c.saved.next).toBe(2);
  });

  it('never moves device progress into an account, before or after it attaches', async () => {
    const browser = disk();
    const server = hub();
    const c = campaign(browser);
    winGauntlet(c);
    await c.attach(server.as('alice'), 'alice');
    await c.flush();
    expect(c.saved.clears).toBe(0);
    expect(server.saves.get('alice')).toBeUndefined();

    // Device play later on the same browser stays on the device.
    c.release();
    winGauntlet(c);
    const again = campaign(browser);
    await again.attach(server.as('alice'), 'alice');
    expect(again.saved.clears).toBe(0);
    expect(again.unlocked).toEqual([]);
  });

  it('loads the account on a second device from its cloud save', async () => {
    const server = hub();
    const laptop = campaign(disk());
    await laptop.attach(server.as('alice'), 'alice');
    winFights(laptop, 3);
    laptop.markPracticeDone();
    await laptop.flush();

    const phone = campaign(disk());
    await phone.attach(server.as('alice'), 'alice');
    expect(phone.unlocked).toEqual(BOSSES.slice(0, 3).map((b) => b.reward));
    expect(phone.defeated).toEqual(expect.arrayContaining(bossFighters(BOSSES[2]).map((f) => f.id)));
    expect(phone.practiceDone).toBe(true);
    // The run is this browser's: the phone starts its own.
    expect(phone.canContinue).toBe(false);
  });

  it('forgets spells on every device of the account, and relearns them', async () => {
    const server = hub();
    const laptop = campaign(disk());
    await laptop.attach(server.as('alice'), 'alice');
    winFights(laptop, 2);
    await laptop.flush();
    const phone = campaign(disk());
    await phone.attach(server.as('alice'), 'alice');
    expect(phone.unlocked.length).toBe(2);

    phone.forgetSpells();
    expect(phone.unlocked).toEqual([]);
    await phone.flush();
    await laptop.flush();
    expect(laptop.unlocked).toEqual([]);
    // Skins stay.
    expect(laptop.defeated.length).toBeGreaterThan(0);

    winFights(laptop, 1);
    expect(laptop.unlocked).toEqual([BOSSES[0].reward]);
    expect(laptop.lastLearned).toBe(BOSSES[0].reward);
  });

  it('gives wins made while the hub visit was starting to the account', async () => {
    const browser = disk();
    const server = hub();
    const c = campaign(browser);
    c.hold();
    expect(c.owner().kind).toBe('pending');
    winFights(c, 1);
    await c.attach(server.as('alice'), 'alice');
    expect(c.unlocked).toEqual([BOSSES[0].reward]);
    expect(c.saved.next).toBe(1);
    await c.flush();
    expect(server.saves.get('alice')?.data).toMatchObject({ spells: { [BOSSES[0].reward]: 0 } });
    // Nothing reached the device copy.
    const device = campaign(browser);
    expect(device.unlocked).toEqual([]);
    expect(device.canContinue).toBe(false);
  });

  it('keeps an older save on this browser only', async () => {
    const browser = disk({
      [LEGACY_CAMPAIGN_KEY]: JSON.stringify({ version: 2, next: 3, clears: 1, unlockedSpells: [REWARD_SPELLS[0], REWARD_SPELLS[1]], defeated: [FIGHTER_IDS[0]] }),
      [LEGACY_SETTINGS_KEY]: JSON.stringify({ sensitivity: 1, practiceDone: true }),
    });
    const c = campaign(browser);
    expect(c.saved).toEqual({ next: 3, clears: 1, unlockedSpells: [REWARD_SPELLS[0], REWARD_SPELLS[1]], defeated: [FIGHTER_IDS[0]] });
    expect(c.practiceDone).toBe(true);
    // The device copy is written once; the old keys are left as they were.
    expect(browser.values.has(PROGRESS_KEY)).toBe(true);
    expect(JSON.parse(browser.values.get(LEGACY_CAMPAIGN_KEY)!).next).toBe(3);

    const server = hub();
    await c.attach(server.as('alice'), 'alice');
    expect(c.saved).toEqual({ next: 0, clears: 0, unlockedSpells: [], defeated: [] });
    expect(c.practiceDone).toBe(false);
    await c.flush();
    expect(server.saves.get('alice')).toBeUndefined();
  });

  it('migrates a version 1 save (no spells or skins) into the device copy', () => {
    const c = campaign(disk({ [LEGACY_CAMPAIGN_KEY]: JSON.stringify({ next: 2, clears: 0 }) }));
    expect(c.unlocked).toEqual([BOSSES[0].reward, BOSSES[1].reward]);
    expect(c.saved.next).toBe(2);
  });

  it('merges progress another tab saved', () => {
    const browser = disk();
    const a = campaign(browser);
    const b = campaign(browser);
    winFights(a, 1);
    expect(b.watches(PROGRESS_KEY)).toBe(true);
    b.refresh();
    expect(b.unlocked).toEqual([BOSSES[0].reward]);
    expect(b.saved.next).toBe(1);
  });

  it('fits the largest possible save in one cloud save with room to spare', async () => {
    const server = hub();
    const c = campaign(disk());
    await c.attach(server.as('alice'), 'alice');
    winGauntlet(c);
    c.markPracticeDone();
    await c.flush();
    expect(c.sync()).toBe('synced');
    const data = server.saves.get('alice')!.data as unknown as CampaignProgress;
    // Worst case: every fighter, every spell, counters at their largest.
    const worst: CampaignProgress = {
      ...data,
      clears: Number.MAX_SAFE_INTEGER,
      forgets: Number.MAX_SAFE_INTEGER,
      defeated: [...FIGHTER_IDS],
      spells: Object.fromEntries(REWARD_SPELLS.map((id) => [id, Number.MAX_SAFE_INTEGER])),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(worst)).length;
    expect(bytes).toBeLessThan(SAVE_MAX_BYTES / 4);
  });
});
