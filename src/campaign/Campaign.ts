import { BOSSES, type BossDef } from './levels';
import { REWARD_SPELLS, isRewardSpell, type RewardSpellId } from '../spells/rewardCatalog';

/** What the Boss Gauntlet remembers between sessions. */
export interface CampaignSave {
  /** Save format. 1 (or missing): no `unlockedSpells` (migrated from progress on read). */
  version: 2;
  /** Index of the next boss to fight. 0 with `clears > 0` means the last run was finished. */
  next: number;
  /** How many times the whole gauntlet has been beaten. */
  clears: number;
  /**
   * Boss reward spells learned for good (in gauntlet order). They survive New Gauntlet; only
   * Settings' "Forget learned spells" (or `reset`) clears them.
   */
  unlockedSpells: RewardSpellId[];
}

export const CAMPAIGN_STORAGE_KEY = 'arcane-duel-campaign';
export const CAMPAIGN_SAVE_VERSION = 2;

const clampIndex = (i: number) => Math.max(0, Math.min(BOSSES.length - 1, Math.floor(Number.isFinite(i) ? i : 0)));
/** Known spell ids only, once each, in gauntlet order. */
const canonical = (ids: readonly unknown[]): RewardSpellId[] => REWARD_SPELLS.filter((id) => ids.includes(id));

/**
 * The spells an old (version 1) save has earned: every boss before `next` was beaten, and a cleared
 * gauntlet means all of them were.
 */
export function migratedSpells(next: number, clears: number): RewardSpellId[] {
  if (clears > 0) return [...REWARD_SPELLS];
  return BOSSES.slice(0, Math.max(0, Math.min(BOSSES.length, next))).map((b) => b.reward);
}

/**
 * Boss Gauntlet progress: five single-life boss fights in a row. Beating a boss saves the next one,
 * so "Continue" resumes there; losing keeps you on the same boss. Beating a boss also teaches its
 * reward spell for good (`unlockedSpells`). Saved in localStorage (if allowed).
 *
 * The save never claims a fight that wasn't won fairly. A win with god mode on is never saved (App
 * skips recordWin) but still moves the run on in this session; from then on the run is ahead of the
 * save (`continuesSave` is false) and no later win of it saves anything either, nor teaches a spell,
 * until the player starts over (New Gauntlet) or picks the saved run back up (Continue).
 */
export class Campaign {
  /** The boss being fought (or about to be). */
  index = 0;
  /** The spell the last recordWin taught for the first time (the reveal screen shows it), or null. */
  lastLearned: RewardSpellId | null = null;
  private save: CampaignSave;

  constructor(private readonly storageKey = CAMPAIGN_STORAGE_KEY) {
    this.save = this.read();
  }

  get boss(): BossDef {
    return BOSSES[this.index];
  }

  get total(): number {
    return BOSSES.length;
  }

  get isLast(): boolean {
    return this.index >= BOSSES.length - 1;
  }

  /** The boss after the current one, if any. */
  get nextBoss(): BossDef | null {
    return BOSSES[this.index + 1] ?? null;
  }

  get saved(): Readonly<CampaignSave> {
    return this.save;
  }

  /** Reward spells learned so far (saved). */
  get unlocked(): readonly RewardSpellId[] {
    return this.save.unlockedSpells;
  }

  hasLearned(id: RewardSpellId): boolean {
    return this.save.unlockedSpells.includes(id);
  }

  /**
   * Every fight before the current one is in the save: a win here can be saved. False once the
   * run went past the save through god-mode wins (which are never saved).
   */
  get continuesSave(): boolean {
    return this.index <= this.save.next;
  }

  /** A run is in progress past fight 1, so the menu offers "Continue". */
  get canContinue(): boolean {
    return this.save.next > 0 && this.save.next < BOSSES.length;
  }

  /**
   * Start over at fight 1 (keeps the clear count and the learned spells: they are permanent). App
   * calls it when Begin is pressed on fight 1's card, so backing out of New Gauntlet keeps the save.
   */
  startNew(): BossDef {
    this.index = 0;
    this.write({ ...this.save, next: 0 });
    return this.boss;
  }

  /** Pick up at the saved fight. */
  resume(): BossDef {
    this.index = clampIndex(this.save.next);
    return this.boss;
  }

  /**
   * The current boss was beaten: save progress and learn its reward spell (`lastLearned` says
   * whether it is new). Returns 'complete' after the final boss (the run resets to fight 1 and the
   * clear count goes up), otherwise 'next'. `index` still points at the beaten boss until `advance()`.
   * A run that went past the save (`continuesSave` false: earlier fights won in god mode) saves and
   * teaches nothing: 'unsaved'. Progress never moves backwards.
   */
  recordWin(): 'next' | 'complete' | 'unsaved' {
    if (!this.continuesSave) {
      this.lastLearned = null;
      return 'unsaved';
    }
    const reward = this.boss.reward;
    const learned = this.hasLearned(reward);
    this.lastLearned = learned ? null : reward;
    const unlockedSpells = learned ? this.save.unlockedSpells : canonical([...this.save.unlockedSpells, reward]);
    if (this.isLast) {
      this.write({ ...this.save, next: 0, clears: this.save.clears + 1, unlockedSpells });
      return 'complete';
    }
    this.write({ ...this.save, next: Math.max(this.save.next, this.index + 1), unlockedSpells });
    return 'next';
  }

  /** Move on to the next boss after a win. */
  advance(): BossDef {
    this.index = clampIndex(this.index + 1);
    return this.boss;
  }

  /** Re-read storage (another tab, or QA restoring a snapshot). */
  reload(): void {
    this.save = this.read();
  }

  /** Forget the learned reward spells (Settings). Progress and clears stay. */
  forgetSpells(): void {
    this.lastLearned = null;
    this.write({ ...this.save, unlockedSpells: [] });
  }

  /** Forget all progress, spells included. */
  reset(): void {
    this.index = 0;
    this.lastLearned = null;
    this.write({ version: CAMPAIGN_SAVE_VERSION, next: 0, clears: 0, unlockedSpells: [] });
  }

  private read(): CampaignSave {
    const fresh: CampaignSave = { version: CAMPAIGN_SAVE_VERSION, next: 0, clears: 0, unlockedSpells: [] };
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return fresh;
      const data = JSON.parse(raw) as Partial<CampaignSave> & { unlockedSpells?: unknown };
      const n = Number(data.next);
      const c = Number(data.clears);
      const next = Number.isFinite(n) ? Math.max(0, Math.min(BOSSES.length, Math.floor(n))) : 0;
      const clears = Number.isFinite(c) ? Math.max(0, Math.floor(c)) : 0;
      // Saves from before the reward spells: everything the progress has earned.
      const spells = Array.isArray(data.unlockedSpells) ? canonical(data.unlockedSpells.filter(isRewardSpell)) : migratedSpells(next, clears);
      const save: CampaignSave = { version: CAMPAIGN_SAVE_VERSION, next, clears, unlockedSpells: spells };
      // Write a migrated save back in the current format.
      if (data.version !== CAMPAIGN_SAVE_VERSION || !Array.isArray(data.unlockedSpells)) this.persist(save);
      return save;
    } catch {
      // Storage unavailable or corrupt: start fresh.
      return fresh;
    }
  }

  private write(save: CampaignSave): void {
    this.save = save;
    this.persist(save);
  }

  private persist(save: CampaignSave): void {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(save));
    } catch {
      // Private mode or blocked storage: progress lasts for this session only.
    }
  }
}
