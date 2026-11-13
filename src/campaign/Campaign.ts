import type { KeyValue, ProgressCloud, ProgressOwner, ProgressStore, ProgressSync } from '@metaverse/hub-sdk';
import { BOSSES, bossFighters, type BossDef } from './levels';
import type { RewardSpellId } from '../spells/rewardCatalog';
import {
  LEGACY_CAMPAIGN_KEY,
  LEGACY_SETTINGS_KEY,
  PROGRESS_KEY,
  canonicalFighters,
  createCampaignStore,
  learnedSpells,
  legacyRunCursor,
  type CampaignProgress,
  type CampaignStoreOptions,
} from './progress';

export { migratedDefeated, migratedSpells } from './progress';

/** What the Boss Gauntlet remembers between sessions, as menus and QA read it. */
export interface CampaignSave {
  /** Index of the next boss to fight. 0 with `clears > 0` means the last run was finished. */
  next: number;
  /** How many times the whole gauntlet has been beaten. */
  clears: number;
  /**
   * Boss reward spells learned for good (in gauntlet order). They survive New Gauntlet; only
   * Settings' "Forget learned spells" clears them.
   */
  unlockedSpells: RewardSpellId[];
  /** Fighter ids beaten in a saved win (bosses and partners, gauntlet order): their skins are unlocked. */
  defeated: string[];
}

/** The device copy of the progress store. Kept for QA, which stashes it around its scenarios. */
export const CAMPAIGN_STORAGE_KEY = PROGRESS_KEY;
/** Every key the device's gauntlet uses on this browser: QA stashes them all. */
export const CAMPAIGN_DEVICE_KEYS: readonly string[] = [PROGRESS_KEY, `${PROGRESS_KEY}-run`, LEGACY_CAMPAIGN_KEY];

const clampIndex = (i: number) => Math.max(0, Math.min(BOSSES.length - 1, Math.floor(Number.isFinite(i) ? i : 0)));
const clampNext = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.min(BOSSES.length, Math.floor(v))) : 0;
};

function defaultStorage(): KeyValue | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Boss Gauntlet progress: five single-life boss fights in a row. Beating a boss saves the next one,
 * so "Continue" resumes there; losing keeps you on the same boss. Beating a boss also teaches its
 * reward spell for good and unlocks its fighters' skins.
 *
 * What the player earned (spells, skins, clears, Practice done) lives in one hub progress store
 * (`./progress`): this browser's copy outside a hub session, the hub account's own copy (synced to
 * its cloud save) inside one. It only ever moves forward, through `store.update`.
 *
 * The run cursor (`next`, the boss Continue resumes at) goes back to fight 1 on New Gauntlet and
 * after a clear, so it is not in the store. It is kept on this browser per owner: the device's
 * under `<key>-run`, an account's under `<key>-run@<playerId>`, so one account never continues
 * another's run (a win there would teach spells the account never earned). It does not follow
 * an account to another device.
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
  private readonly key: string;
  private readonly storage: KeyValue | null;
  private readonly storeOptions: CampaignStoreOptions;
  private store: ProgressStore<CampaignProgress>;
  /** The run cursor of the current owner. */
  private next = 0;
  /** The run moved while the owner was pending: it goes to the account (or device) with the wins. */
  private pendingRunMoved = false;
  private readonly listeners = new Set<() => void>();
  /** Run cursors when there is no storage (private mode), per owner. */
  private readonly memoryRuns = new Map<string, number>();
  private unsubscribe: () => void;

  /** A string is a private storage key (QA); the options are for tests. */
  constructor(options: string | (CampaignStoreOptions & { storage?: KeyValue | null }) = {}) {
    const opts = typeof options === 'string' ? { key: options } : options;
    this.key = opts.key ?? PROGRESS_KEY;
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    this.storeOptions = { ...opts, key: this.key, storage: this.storage };
    this.store = createCampaignStore(this.storeOptions);
    this.unsubscribe = this.store.subscribe(() => this.emit());
    this.migrateDevice();
    this.next = this.readRun();
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

  get progress(): Readonly<CampaignProgress> {
    return this.store.get();
  }

  get saved(): Readonly<CampaignSave> {
    const p = this.store.get();
    return { next: this.next, clears: p.clears, unlockedSpells: learnedSpells(p), defeated: [...p.defeated] };
  }

  /** Reward spells learned so far (saved). */
  get unlocked(): readonly RewardSpellId[] {
    return learnedSpells(this.store.get());
  }

  /** Fighter ids beaten in saved wins (their skins are unlocked). */
  get defeated(): readonly string[] {
    return this.store.get().defeated;
  }

  /** The Practice lessons were finished once. */
  get practiceDone(): boolean {
    return this.store.get().practiceDone;
  }

  hasLearned(id: RewardSpellId): boolean {
    return this.unlocked.includes(id);
  }

  /**
   * Every fight before the current one is in the save: a win here can be saved. False once the
   * run went past the save through god-mode wins (which are never saved).
   */
  get continuesSave(): boolean {
    return this.index <= this.next;
  }

  /** A run is in progress past fight 1, so the menu offers "Continue". */
  get canContinue(): boolean {
    return this.next > 0 && this.next < BOSSES.length;
  }

  /**
   * Start over at fight 1 (keeps the clear count and the learned spells: they are permanent). App
   * calls it when Begin is pressed on fight 1's card, so backing out of New Gauntlet keeps the save.
   */
  startNew(): BossDef {
    this.index = 0;
    this.writeRun(0);
    return this.boss;
  }

  /** Pick up at the saved fight. */
  resume(): BossDef {
    this.index = clampIndex(this.next);
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
    this.lastLearned = this.hasLearned(reward) ? null : reward;
    const fighters = bossFighters(this.boss).map((f) => f.id);
    const last = this.isLast;
    this.store.update((p) => ({
      ...p,
      clears: last ? p.clears + 1 : p.clears,
      defeated: canonicalFighters([...p.defeated, ...fighters]),
      // Learned at the current forget count: learned now, and after any earlier forget.
      spells: learnedSpells(p).includes(reward) ? p.spells : { ...p.spells, [reward]: p.forgets },
    }));
    if (last) {
      this.writeRun(0);
      return 'complete';
    }
    this.writeRun(Math.max(this.next, this.index + 1));
    return 'next';
  }

  /** Move on to the next boss after a win. */
  advance(): BossDef {
    this.index = clampIndex(this.index + 1);
    return this.boss;
  }

  /** The Practice lessons are done: the main menu stops pointing at them. */
  markPracticeDone(): void {
    if (!this.practiceDone) this.store.update((p) => ({ ...p, practiceDone: true }));
  }

  /** Forget the learned reward spells (Settings), on every device of the account. Progress and clears stay. */
  forgetSpells(): void {
    this.lastLearned = null;
    this.store.update((p) => ({ ...p, forgets: p.forgets + 1 }));
  }

  /**
   * QA restored a snapshot of storage: read it back as it is. For device play the copy in memory
   * is replaced (a scenario's wins must not survive its stash); an account's only merges.
   */
  reload(): void {
    if (this.store.owner().kind === 'device') this.rebuildStore();
    else this.store.refresh();
    this.next = this.readRun();
    this.emit();
  }

  /** Another tab saved progress or moved the run: merge it in. */
  refresh(): void {
    this.store.refresh();
    this.next = this.readRun();
    this.emit();
  }

  /** True when a `storage` event with this key changes the progress or run shown. */
  watches(key: string | null): boolean {
    return this.store.watches(key) || key === this.runKey(this.store.owner());
  }

  /**
   * QA only: forget this browser's device progress (the device copy, the old campaign save and the
   * run). Progress only moves forward otherwise, and an account's cloud copy would bring it back,
   * so this does nothing outside device play. Scenarios stash `CAMPAIGN_DEVICE_KEYS` around it.
   */
  reset(): void {
    if (this.store.owner().kind !== 'device') return;
    this.index = 0;
    this.lastLearned = null;
    for (const k of [this.key, this.runKey(this.store.owner()), ...(this.key === PROGRESS_KEY ? [LEGACY_CAMPAIGN_KEY] : [])]) {
      try {
        if (k) this.storage?.removeItem(k);
      } catch {
        // ignore
      }
    }
    this.rebuildStore();
    this.next = 0;
    this.writeRun(0);
    this.emit();
  }

  /** Whose progress this is: the browser, a hub visit still starting, or a hub account. */
  owner(): ProgressOwner {
    return this.store.owner();
  }

  /** Cloud state of an account's progress. */
  sync(): ProgressSync {
    return this.store.sync();
  }

  /** A hub visit is starting: wins are held in memory until the account is known. */
  hold(): void {
    this.store.hold();
    this.index = 0;
    this.lastLearned = null;
    this.next = 0;
    this.pendingRunMoved = false;
  }

  /** Show and save `playerId`'s progress, synced with their hub cloud save. */
  attach(cloud: ProgressCloud, playerId: string): Promise<void> {
    const carried = this.carriedRun();
    const done = this.store.attach(cloud, playerId);
    this.switchedOwner(carried);
    return done;
  }

  /** Back to this browser's own progress, for play without a hub session. */
  release(): void {
    const carried = this.carriedRun();
    this.store.release();
    this.switchedOwner(carried);
  }

  /** Push any unsynced account progress now. */
  flush(): Promise<void> {
    return this.store.flush();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A fresh device store read from storage. */
  private rebuildStore(): void {
    this.unsubscribe();
    this.store = createCampaignStore(this.storeOptions);
    this.unsubscribe = this.store.subscribe(() => this.emit());
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private carriedRun(): number | null {
    return this.store.owner().kind === 'pending' && this.pendingRunMoved ? this.next : null;
  }

  private switchedOwner(carried: number | null): void {
    this.pendingRunMoved = false;
    this.lastLearned = null;
    this.next = this.readRun();
    if (carried !== null) this.writeRun(carried);
    this.index = clampIndex(this.next);
    this.emit();
  }

  /** Write the device copy once from the old saves, so it no longer depends on them. */
  private migrateDevice(): void {
    if (this.key !== PROGRESS_KEY || !this.storage) return;
    try {
      if (this.storage.getItem(PROGRESS_KEY) !== null) return;
      if (this.storage.getItem(LEGACY_CAMPAIGN_KEY) === null && this.storage.getItem(LEGACY_SETTINGS_KEY) === null) return;
    } catch {
      return;
    }
    this.store.update((p) => p);
  }

  private runKey(owner: ProgressOwner): string | null {
    if (owner.kind === 'device') return `${this.key}-run`;
    if (owner.kind === 'account') return `${this.key}-run@${owner.playerId}`;
    return null;
  }

  private readRun(): number {
    const owner = this.store.owner();
    const key = this.runKey(owner);
    if (!key) return 0;
    if (!this.storage) return this.memoryRuns.get(key) ?? 0;
    try {
      const raw = this.storage.getItem(key);
      if (raw !== null) return clampNext(JSON.parse(raw));
      // The device's run starts where the old campaign save left it.
      if (owner.kind === 'device' && this.key === PROGRESS_KEY) return legacyRunCursor(this.storage) ?? 0;
    } catch {
      // Corrupt or blocked: start at fight 1.
    }
    return 0;
  }

  private writeRun(next: number): void {
    this.next = clampNext(next);
    const owner = this.store.owner();
    if (owner.kind === 'pending') this.pendingRunMoved = true;
    const key = this.runKey(owner);
    if (!key) return;
    this.memoryRuns.set(key, this.next);
    try {
      if (!this.storage) return;
      this.storage.setItem(key, JSON.stringify(this.next));
    } catch {
      // Private mode or blocked storage: the run lasts for this session only.
    }
  }
}
