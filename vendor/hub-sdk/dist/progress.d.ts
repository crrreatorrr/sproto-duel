import { type KeyValue } from './storage';
import type { GameId, HubSdk } from './types';
/**
 * A game's progress, described once so the store can keep, merge and sync it.
 *
 * Progress only advances. `merge` must keep everything either copy has earned (union the
 * sets, keep the better record) and must be commutative, associative and idempotent. That
 * is what lets two devices, two tabs and the cloud copy be combined in any order without
 * one overwriting the other.
 */
export interface ProgressModel<T> {
    /** Progress of a player who has done nothing yet. */
    empty(): T;
    /** Reads anything from storage or the cloud into a valid `T`. Never throws. */
    normalize(raw: unknown): T;
    /** Combines two copies without losing progress from either. */
    merge(a: T, b: T): T;
    /** The cloud form, a JSON object of at most `SAVE_MAX_BYTES`. Defaults to `T` itself. */
    toCloud?(value: T): Record<string, unknown>;
    /** Reads the cloud form back, before `normalize`. Defaults to the object itself. */
    fromCloud?(data: Record<string, unknown>): unknown;
}
/**
 * Whose progress the store holds.
 * - `device`: play outside a hub session. Kept in this browser only, under the base key.
 * - `pending`: a hub visit is starting and the account is not known yet. Kept in memory and
 *   given to the account (or back to the device) once the visit resolves.
 * - `account`: a hub player. Kept in this browser under the player's own key and synced
 *   to the player's cloud save, so it follows the account to other devices.
 */
export type ProgressOwner = {
    kind: 'device';
} | {
    kind: 'pending';
} | {
    kind: 'account';
    playerId: string;
};
/** Cloud state for an account: `local` (device or pending), `syncing`, `synced`, `offline` (will retry), `error` (will not). */
export type ProgressSync = 'local' | 'syncing' | 'synced' | 'offline' | 'error';
export type ProgressCloud = Pick<HubSdk, 'loadSave' | 'writeSave'>;
export interface ProgressStoreOptions<T> {
    /** Storage key of the device copy. An account's copy is `${key}@${playerId}`. */
    key: string;
    model: ProgressModel<T>;
    /** Defaults to localStorage, or memory when it is unavailable. Null keeps progress in memory. */
    storage?: KeyValue | null;
    /** Progress kept under older keys, merged into the device copy only. */
    readLegacy?(storage: KeyValue): unknown;
    /** Wait after an update before pushing to the cloud, so a burst becomes one write. Default 1500 ms. */
    pushDelayMs?: number;
    /** First retry after a failed push. Doubles up to 2 minutes. Default 5000 ms. */
    retryDelayMs?: number;
    /** Called when a cloud read or write fails. */
    onError?(error: unknown): void;
}
export interface ProgressStore<T> {
    /** The current progress. Treat it as read-only. */
    get(): T;
    owner(): ProgressOwner;
    sync(): ProgressSync;
    /** False when the last local write failed, so progress lasts only for this visit. */
    persistent(): boolean;
    /**
     * Advances progress: `advance` gets the current progress and returns the next. The result
     * is merged with the current copy, so nothing earned can be lost here. Saved at once and,
     * for an account, pushed to the cloud shortly after.
     */
    update(advance: (current: T) => T): T;
    /** Re-reads storage, for progress another tab saved. */
    refresh(): void;
    /** True when a `storage` event with this key concerns the current copy. */
    watches(key: string | null): boolean;
    subscribe(listener: () => void): () => void;
    /** A hub visit is starting: keep new progress in memory until `attach` or `release`. */
    hold(): void;
    /** Switch to `playerId`'s progress and sync it with the cloud save. */
    attach(cloud: ProgressCloud, playerId: string): Promise<void>;
    /** Back to the device copy, for play without a hub session. */
    release(): void;
    /** Pushes any unsynced account progress now. Resolves when done or failed. */
    flush(): Promise<void>;
}
/**
 * One game's progress, owned by the device or by a hub account.
 *
 * Every copy (this tab, other tabs, the cloud) is combined with `model.merge`, so the
 * order of reads and writes never loses progress. `save.put` has no compare-and-swap: two
 * devices writing at once can each miss the other's latest win, but the device that lost
 * still holds it locally and puts it back on its next push.
 */
export declare function createProgressStore<T>(options: ProgressStoreOptions<T>): ProgressStore<T>;
/**
 * True when this page load is starting or resuming a hub visit for `game`: a portal ticket
 * in the URL fragment, or a live session from earlier in this tab. Games call
 * `store.hold()` when it is true, before `init` resolves, so a moment of play before the
 * account is known never lands in the device copy.
 */
export declare function hubVisitStarting(game: GameId, hash?: string, session?: KeyValue): boolean;
