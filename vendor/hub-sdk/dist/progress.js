import { HubSdkError } from './errors';
import { encodeSave } from './save';
import { browserKeyValue } from './storage';
import { readTicketParam } from './ticket';
const MAX_RETRY_MS = 120_000;
function stable(value) {
    return JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : v);
}
/** Errors that a retry cannot fix. */
function isFinal(error) {
    return error instanceof HubSdkError && (error.code === 'bad_save' || error.code === 'save_too_large');
}
/**
 * One game's progress, owned by the device or by a hub account.
 *
 * Every copy (this tab, other tabs, the cloud) is combined with `model.merge`, so the
 * order of reads and writes never loses progress. `save.put` has no compare-and-swap: two
 * devices writing at once can each miss the other's latest win, but the device that lost
 * still holds it locally and puts it back on its next push.
 */
export function createProgressStore(options) {
    const { key, model } = options;
    const storage = options.storage === undefined ? browserKeyValue('local') : options.storage;
    const pushDelay = options.pushDelayMs ?? 1500;
    const retryBase = options.retryDelayMs ?? 5000;
    const toCloud = (value) => model.toCloud ? model.toCloud(value) : value;
    const fromCloud = (data) => model.normalize(model.fromCloud ? model.fromCloud(data) : data);
    let owner = { kind: 'device' };
    let status = 'local';
    let persistent = !!storage;
    let cloud = null;
    let pushTimer = null;
    let retryTimer = null;
    let retryMs = retryBase;
    let pushing = null;
    /** Bumped on every owner change, so a push that outlives its account changes nothing. */
    let epoch = 0;
    const listeners = new Set();
    const slotKey = (o) => o.kind === 'device' ? key : o.kind === 'account' ? `${key}@${o.playerId}` : null;
    const dirtyKey = (o) => (o.kind === 'account' ? `${key}@${o.playerId}:unsynced` : null);
    function readRaw(k) {
        if (!storage)
            return null;
        let raw;
        try {
            raw = storage.getItem(k);
        }
        catch {
            // Blocked storage: progress lasts for this visit only.
            persistent = false;
            return null;
        }
        try {
            return raw ? JSON.parse(raw) : null;
        }
        catch {
            return null;
        }
    }
    function readSlot(o) {
        const k = slotKey(o);
        let value = model.normalize(k ? readRaw(k) : null);
        if (o.kind === 'device' && storage && options.readLegacy) {
            try {
                value = model.merge(value, model.normalize(options.readLegacy(storage)));
            }
            catch {
                /* Unreadable legacy progress is skipped. */
            }
        }
        return value;
    }
    function writeSlot(o, value) {
        const k = slotKey(o);
        if (!k)
            return;
        try {
            if (!storage)
                throw new Error('no storage');
            storage.setItem(k, JSON.stringify(value));
            persistent = true;
        }
        catch {
            persistent = false;
        }
    }
    function setDirty(o, dirty) {
        const k = dirtyKey(o);
        if (!k || !storage)
            return;
        try {
            if (dirty)
                storage.setItem(k, '1');
            else
                storage.removeItem(k);
        }
        catch {
            /* The next attach syncs anyway. */
        }
    }
    function isDirty(o) {
        const k = dirtyKey(o);
        if (!k || !storage)
            return false;
        try {
            return storage.getItem(k) === '1';
        }
        catch {
            return false;
        }
    }
    let value = readSlot(owner);
    const emit = () => {
        for (const listener of listeners)
            listener();
    };
    function clearTimers() {
        if (pushTimer)
            clearTimeout(pushTimer);
        if (retryTimer)
            clearTimeout(retryTimer);
        pushTimer = null;
        retryTimer = null;
    }
    function schedulePush(delay) {
        if (owner.kind !== 'account' || !cloud)
            return;
        if (pushTimer)
            clearTimeout(pushTimer);
        pushTimer = setTimeout(() => {
            pushTimer = null;
            void push();
        }, delay);
    }
    /** Read the cloud copy, merge it with ours, store the result here and there. */
    function push() {
        if (pushing) {
            // One push at a time; a later update gets a fresh push after this one.
            return pushing.then(() => (owner.kind === 'account' && isDirty(owner) ? push() : undefined));
        }
        const o = owner;
        const api = cloud;
        const at = epoch;
        if (o.kind !== 'account' || !api?.loadSave || !api.writeSave)
            return Promise.resolve();
        status = 'syncing';
        emit();
        pushing = (async () => {
            try {
                const remote = await api.loadSave();
                if (at !== epoch)
                    return;
                const theirs = remote.data ? fromCloud(remote.data) : null;
                value = model.merge(readSlot(o), theirs ? model.merge(value, theirs) : value);
                writeSlot(o, value);
                const body = toCloud(value);
                encodeSave(body);
                // No cloud save and nothing earned: nothing to write.
                if (stable(body) !== stable(toCloud(theirs ?? model.empty()))) {
                    await api.writeSave(body);
                    if (at !== epoch)
                        return;
                }
                setDirty(o, false);
                status = 'synced';
                retryMs = retryBase;
            }
            catch (error) {
                if (at !== epoch)
                    return;
                options.onError?.(error);
                if (isFinal(error)) {
                    status = 'error';
                }
                else {
                    status = 'offline';
                    if (retryTimer)
                        clearTimeout(retryTimer);
                    retryTimer = setTimeout(() => {
                        retryTimer = null;
                        void push();
                    }, retryMs);
                    retryMs = Math.min(MAX_RETRY_MS, retryMs * 2);
                }
            }
            finally {
                pushing = null;
                if (at === epoch)
                    emit();
            }
        })();
        return pushing;
    }
    function moveTo(next) {
        epoch += 1;
        clearTimers();
        retryMs = retryBase;
        owner = next;
    }
    return {
        get: () => value,
        owner: () => owner,
        sync: () => status,
        persistent: () => persistent,
        update(advance) {
            if (owner.kind !== 'pending')
                value = model.merge(value, readSlot(owner));
            value = model.merge(value, model.normalize(advance(value)));
            writeSlot(owner, value);
            if (owner.kind === 'account') {
                setDirty(owner, true);
                schedulePush(pushDelay);
            }
            emit();
            return value;
        },
        refresh() {
            if (owner.kind === 'pending')
                return;
            value = model.merge(value, readSlot(owner));
            emit();
        },
        watches(changed) {
            return changed === null || changed === slotKey(owner);
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        hold() {
            if (owner.kind === 'pending')
                return;
            moveTo({ kind: 'pending' });
            cloud = null;
            value = model.empty();
            status = 'local';
            emit();
        },
        async attach(api, playerId) {
            if (!playerId)
                throw new HubSdkError('bad_player', 'attach needs a player id');
            const earned = owner.kind === 'pending' ? value : null;
            const next = { kind: 'account', playerId };
            moveTo(next);
            cloud = api;
            value = readSlot(next);
            if (earned) {
                value = model.merge(value, earned);
                writeSlot(next, value);
                setDirty(next, true);
            }
            status = 'local';
            emit();
            await push();
        },
        release() {
            if (owner.kind === 'device')
                return;
            const earned = owner.kind === 'pending' ? value : null;
            moveTo({ kind: 'device' });
            cloud = null;
            value = readSlot(owner);
            if (earned) {
                value = model.merge(value, earned);
                writeSlot(owner, value);
            }
            status = 'local';
            emit();
        },
        flush() {
            if (owner.kind !== 'account' || !cloud)
                return Promise.resolve();
            if (pushTimer) {
                clearTimeout(pushTimer);
                pushTimer = null;
            }
            return push();
        },
    };
}
/**
 * True when this page load is starting or resuming a hub visit for `game`: a portal ticket
 * in the URL fragment, or a live session from earlier in this tab. Games call
 * `store.hold()` when it is true, before `init` resolves, so a moment of play before the
 * account is known never lands in the device copy.
 */
export function hubVisitStarting(game, hash, session) {
    const fragment = hash ?? (typeof location !== 'undefined' ? location.hash : '');
    if (readTicketParam(fragment))
        return true;
    try {
        const store = session ?? browserKeyValue('session');
        return store.getItem(`hub:${game}:session`) !== null;
    }
    catch {
        return false;
    }
}
