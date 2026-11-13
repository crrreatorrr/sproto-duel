import { createProgressStore, type KeyValue, type ProgressModel, type ProgressStore } from '@metaverse/hub-sdk';
import { BOSSES, bossFighters } from './levels';
import { REWARD_SPELLS, isRewardSpell, type RewardSpellId } from '../spells/rewardCatalog';

/**
 * What Sproto Duel's player has earned, kept in one hub progress store (SDK 0.8.0
 * `createProgressStore`). Play outside a hub session keeps it in this browser; a hub account keeps
 * its own copy here and in its cloud save, so it follows the account to any device.
 *
 * Everything here only moves forward, so two tabs, two devices and the cloud combine with `merge`
 * in any order without one overwriting the other:
 * - `clears`: the most gauntlet clears any copy has seen (the better record).
 * - `defeated`: fighters beaten in a saved win, which unlock their skins (union).
 * - `spells` + `forgets`: reward spells. Settings' "Forget learned spells" must still work and
 *   reach the account's other devices, so forgetting is a counter that only goes up: a spell is
 *   learned while the count it was learned at is not below `forgets`. Both merge with max.
 * - `practiceDone`: the Practice lessons were finished once (OR).
 *
 * The gauntlet's run cursor (the boss Continue resumes at) is not here: New Gauntlet and a
 * finished run send it back to fight 1. It is kept per owner on this browser (`Campaign`).
 */
export interface CampaignProgress {
  clears: number;
  defeated: string[];
  /** Reward spell id -> the `forgets` count it was learned at. */
  spells: Partial<Record<RewardSpellId, number>>;
  forgets: number;
  practiceDone: boolean;
}

/** The device copy for this build. An account's copy is `${PROGRESS_KEY}@<playerId>`. */
export const PROGRESS_KEY = 'arcane-duel-progress';
/** The campaign save before per-account progress. Read into the device copy, never written. */
export const LEGACY_CAMPAIGN_KEY = 'arcane-duel-campaign';
/** The settings key that held `practiceDone` before it moved into progress. Never written here. */
export const LEGACY_SETTINGS_KEY = 'arcane-duel-settings';

export const FIGHTER_IDS: readonly string[] = BOSSES.flatMap((b) => bossFighters(b).map((f) => f.id));

const count = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/** Known spell ids only, once each, in gauntlet order. */
export const canonicalSpells = (ids: readonly unknown[]): RewardSpellId[] => REWARD_SPELLS.filter((id) => ids.includes(id));
/** Known fighter ids only, once each, in gauntlet order. */
export const canonicalFighters = (ids: readonly unknown[]): string[] => FIGHTER_IDS.filter((id) => ids.includes(id));

/** The reward spells a progress copy has learned now, in gauntlet order. */
export function learnedSpells(p: CampaignProgress): RewardSpellId[] {
  return REWARD_SPELLS.filter((id) => (p.spells[id] ?? -1) >= p.forgets);
}

/**
 * The spells an old (version 1) save has earned: every boss before `next` was beaten, and a cleared
 * gauntlet means all of them were.
 */
export function migratedSpells(next: number, clears: number): RewardSpellId[] {
  if (clears > 0) return [...REWARD_SPELLS];
  return BOSSES.slice(0, Math.max(0, Math.min(BOSSES.length, next))).map((b) => b.reward);
}

/**
 * The fighters a save from before skins has beaten: every boss before `next`, every boss whose
 * spell was learned, and all of them after a clear.
 */
export function migratedDefeated(next: number, clears: number, spells: readonly RewardSpellId[]): string[] {
  const beaten = BOSSES.filter((b, i) => clears > 0 || i < next || spells.includes(b.reward));
  return canonicalFighters(beaten.flatMap((b) => bossFighters(b).map((f) => f.id)));
}

export const campaignProgressModel: ProgressModel<CampaignProgress> = {
  empty: () => ({ clears: 0, defeated: [], spells: {}, forgets: 0, practiceDone: false }),

  normalize(raw) {
    const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const spells: Partial<Record<RewardSpellId, number>> = {};
    const rawSpells = data.spells && typeof data.spells === 'object' && !Array.isArray(data.spells) ? (data.spells as Record<string, unknown>) : {};
    for (const id of REWARD_SPELLS) {
      if (id in rawSpells) spells[id] = count(rawSpells[id]);
    }
    return {
      clears: count(data.clears),
      defeated: Array.isArray(data.defeated) ? canonicalFighters(data.defeated) : [],
      spells,
      forgets: count(data.forgets),
      practiceDone: data.practiceDone === true,
    };
  },

  merge(a, b) {
    const spells: Partial<Record<RewardSpellId, number>> = {};
    for (const id of REWARD_SPELLS) {
      const x = a.spells[id];
      const y = b.spells[id];
      if (x !== undefined || y !== undefined) spells[id] = Math.max(x ?? 0, y ?? 0);
    }
    return {
      clears: Math.max(a.clears, b.clears),
      defeated: canonicalFighters([...a.defeated, ...b.defeated]),
      spells,
      forgets: Math.max(a.forgets, b.forgets),
      practiceDone: a.practiceDone || b.practiceDone,
    };
  },
};

function readJson(storage: KeyValue, key: string): Record<string, unknown> | null {
  try {
    const raw = storage.getItem(key);
    const data = raw ? (JSON.parse(raw) as unknown) : null;
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The run cursor of the old campaign save (`next`), for this browser's own run. */
export function legacyRunCursor(storage: KeyValue): number | null {
  const data = readJson(storage, LEGACY_CAMPAIGN_KEY);
  if (!data) return null;
  const n = Number(data.next);
  return Number.isFinite(n) ? Math.max(0, Math.min(BOSSES.length, Math.floor(n))) : 0;
}

/**
 * Progress kept under the keys of earlier builds: the campaign save (versions 1 and 2) and
 * `practiceDone` from the settings. The store merges it into the device copy only.
 */
export function readLegacyProgress(storage: KeyValue): CampaignProgress {
  const out = campaignProgressModel.empty();
  const camp = readJson(storage, LEGACY_CAMPAIGN_KEY);
  if (camp) {
    const next = legacyRunCursor(storage) ?? 0;
    const clears = count(camp.clears);
    // Saves from before the reward spells: everything the progress has earned.
    const learned = Array.isArray(camp.unlockedSpells) ? canonicalSpells(camp.unlockedSpells.filter(isRewardSpell)) : migratedSpells(next, clears);
    // Saves from before skins: the fighters the progress has beaten.
    out.defeated = Array.isArray(camp.defeated) ? canonicalFighters(camp.defeated) : migratedDefeated(next, clears, learned);
    out.clears = clears;
    for (const id of learned) out.spells[id] = 0;
  }
  out.practiceDone = readJson(storage, LEGACY_SETTINGS_KEY)?.practiceDone === true;
  return out;
}

export interface CampaignStoreOptions {
  key?: string;
  /** Defaults to localStorage. Null keeps progress in memory. */
  storage?: KeyValue | null;
  pushDelayMs?: number;
  retryDelayMs?: number;
}

export function createCampaignStore(options: CampaignStoreOptions = {}): ProgressStore<CampaignProgress> {
  const key = options.key ?? PROGRESS_KEY;
  return createProgressStore({
    key,
    model: campaignProgressModel,
    storage: options.storage,
    // A private key (QA) has no older saves.
    readLegacy: key === PROGRESS_KEY ? readLegacyProgress : undefined,
    pushDelayMs: options.pushDelayMs,
    retryDelayMs: options.retryDelayMs,
    onError: (err) => console.warn('[progress] cloud save', err),
  });
}
