import { BOSSES, type BossDef } from './levels';

/** What the Boss Gauntlet remembers between sessions. */
export interface CampaignSave {
  /** Index of the next boss to fight. 0 with `clears > 0` means the last run was finished. */
  next: number;
  /** How many times the whole gauntlet has been beaten. */
  clears: number;
}

export const CAMPAIGN_STORAGE_KEY = 'arcane-duel-campaign';

const clampIndex = (i: number) => Math.max(0, Math.min(BOSSES.length - 1, Math.floor(Number.isFinite(i) ? i : 0)));

/**
 * Boss Gauntlet progress: five best-of-3 duels in a row. Beating a boss saves the next one, so
 * "Continue" resumes there; losing keeps you on the same boss. Saved in localStorage (if allowed).
 */
export class Campaign {
  /** The boss being fought (or about to be). */
  index = 0;
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

  /** A run is in progress past fight 1, so the menu offers "Continue". */
  get canContinue(): boolean {
    return this.save.next > 0 && this.save.next < BOSSES.length;
  }

  /** Start over at fight 1 (keeps the clear count). */
  startNew(): BossDef {
    this.index = 0;
    this.write({ next: 0, clears: this.save.clears });
    return this.boss;
  }

  /** Pick up at the saved fight. */
  resume(): BossDef {
    this.index = clampIndex(this.save.next);
    return this.boss;
  }

  /**
   * The current boss was beaten: save progress. Returns 'complete' after the final boss
   * (the run resets to fight 1 and the clear count goes up), otherwise 'next'.
   * `index` still points at the beaten boss until `advance()`.
   */
  recordWin(): 'next' | 'complete' {
    if (this.isLast) {
      this.write({ next: 0, clears: this.save.clears + 1 });
      return 'complete';
    }
    this.write({ next: this.index + 1, clears: this.save.clears });
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

  /** Forget all progress. */
  reset(): void {
    this.index = 0;
    this.write({ next: 0, clears: 0 });
  }

  private read(): CampaignSave {
    const fresh: CampaignSave = { next: 0, clears: 0 };
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return fresh;
      const data = JSON.parse(raw) as Partial<CampaignSave>;
      const next = Number(data.next);
      const clears = Number(data.clears);
      return {
        next: Number.isFinite(next) ? Math.max(0, Math.min(BOSSES.length, Math.floor(next))) : 0,
        clears: Number.isFinite(clears) ? Math.max(0, Math.floor(clears)) : 0,
      };
    } catch {
      // Storage unavailable or corrupt: start fresh.
      return fresh;
    }
  }

  private write(save: CampaignSave): void {
    this.save = save;
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(save));
    } catch {
      // Private mode or blocked storage: progress lasts for this session only.
    }
  }
}
