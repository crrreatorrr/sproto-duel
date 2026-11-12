import { resolveHubEnv } from './env';
import { HubSdkError } from './errors';
import { sessionVarsFromToken, tokenExpiryMs, userIdFromToken } from './nakama';
import { getOrCreateDeviceId } from './storage';
import { EMPTY_SAVE, encodeSave, readSaveResult } from './save';
import { readTicketParam, stripTicketParam } from './ticket';
import { GAME_IDS, canonicalGameId, isBoardId, isRelicId, } from './types';
/** IndexedDB database for earn, event, and exchange writes that have not been acked. */
export const HUB_OUTBOX_DB = 'hub-outbox';
const OUTBOX_STORE = 'writes';
const memoryWrites = new Map();
function flatEffects(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return {};
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'number' || typeof item === 'boolean' || typeof item === 'string')
            out[key] = item;
    }
    return out;
}
function asRelics(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === 'string' && isRelicId(item));
}
function clockMs(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
function cloneBody(body) {
    return JSON.parse(JSON.stringify(body));
}
function useIndexedDb() {
    return typeof indexedDB !== 'undefined';
}
function openOutbox() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(HUB_OUTBOX_DB, 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(OUTBOX_STORE))
                db.createObjectStore(OUTBOX_STORE, { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'));
    });
}
function requestDone(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'));
    });
}
function transactionDone(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('indexedDB transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'));
    });
}
async function withStore(mode, run) {
    const db = await openOutbox();
    try {
        const tx = db.transaction(OUTBOX_STORE, mode);
        const done = transactionDone(tx);
        const result = await run(tx.objectStore(OUTBOX_STORE));
        await done;
        return result;
    }
    finally {
        db.close();
    }
}
async function readWrite(key) {
    if (!useIndexedDb())
        return memoryWrites.get(key) ?? null;
    return withStore('readonly', (store) => requestDone(store.get(key))).then((row) => row ?? null);
}
async function listWrites() {
    if (!useIndexedDb())
        return [...memoryWrites.values()];
    return withStore('readonly', (store) => requestDone(store.getAll()));
}
async function putWrite(record) {
    if (!useIndexedDb()) {
        memoryWrites.set(record.key, record);
        return;
    }
    await withStore('readwrite', (store) => {
        store.put(record);
    });
}
/** Commit the record before any RPC. An existing key is left untouched. */
async function remember(record) {
    const existing = await readWrite(record.key);
    if (existing)
        return existing;
    const stored = { ...record, body: cloneBody(record.body) };
    await putWrite(stored);
    return stored;
}
function tokenUser(token) {
    try {
        return userIdFromToken(token);
    }
    catch {
        return null;
    }
}
/**
 * The token's game session is gone: closed by a newer portal, by exit, or past its
 * lease. Nakama answers an expired JWT with HTTP 401.
 */
function deadSession(error) {
    if (!(error instanceof HubSdkError))
        return false;
    if (error.code === 'session_closed' || error.code === 'unauthorized' || error.code === 'not_game_session')
        return true;
    return error.code === 'rpc_failed' && error.status === 401;
}
/** The access token itself was refused (an expired 2 h JWT). A refresh can cure it. */
function expiredToken(error) {
    if (!(error instanceof HubSdkError))
        return false;
    return error.code === 'unauthorized' || (error.code === 'rpc_failed' && error.status === 401);
}
/**
 * The refresh itself was refused: the refresh token is expired or revoked, or the answer
 * had no token. A network failure, a 5xx, a 408 or a 429 is not a refusal.
 */
function refreshRefused(error) {
    if (!(error instanceof HubSdkError))
        return false;
    // 408 (timeout) and 429 (throttled) say "try again later", not "this token is no good".
    if (error.status === 408 || error.status === 429)
        return false;
    if (error.status !== undefined)
        return error.status >= 400 && error.status < 500;
    return error.code === 'auth_failed' || error.code === 'bad_token' || error.code === 'unauthorized';
}
/** Codes a server can answer in a 2xx body that a later attempt of the same write can still pass. */
const RETRY_CODES = new Set(['rate_limited', 'missing_ticket_key', 'missing_recovery_pepper']);
/**
 * The server answered this write with a final refusal in a 2xx `{error}` body:
 * amount_over_rule, a Ticket cap, idempotency_mismatch, unknown_reason, bad_amount and
 * the like. Resending the same body and key gets the same answer, so the outbox drops
 * the row. A network failure, any HTTP error status (5xx, or 401 for an expired token),
 * and a session problem (deadSession) are not final and stay queued.
 */
function finalRefusal(error) {
    if (!(error instanceof HubSdkError))
        return false;
    if (error.status !== undefined || error.code === 'rpc_failed')
        return false;
    return !deadSession(error) && !RETRY_CODES.has(error.code);
}
async function forget(key) {
    if (!useIndexedDb()) {
        memoryWrites.delete(key);
        return;
    }
    await withStore('readwrite', (store) => {
        store.delete(key);
    });
}
/**
 * Hub SDK backed by Nakama. A `#t=` ticket is exchanged with `authenticateCustom`
 * (`t:` + ticket, create=false) and the server key only. Without a ticket or a
 * cached session every call no-ops so the game still runs standalone.
 */
export function createLiveHubSdk(env, client) {
    const resolved = resolveHubEnv(env);
    let active = null;
    function sessionKey(game) {
        return `hub:${game}:session`;
    }
    function readCached(game) {
        const raw = resolved.session.getItem(sessionKey(game));
        if (!raw)
            return null;
        try {
            const parsed = JSON.parse(raw);
            if (parsed.game !== game || !parsed.token || !parsed.playerId || !parsed.sid)
                return null;
            if (typeof parsed.ranked !== 'boolean')
                return null;
            return {
                game,
                playerId: parsed.playerId,
                ranked: parsed.ranked,
                sid: parsed.sid,
                token: parsed.token,
                refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : undefined,
                effects: flatEffects(parsed.effects),
                relics: asRelics(parsed.relics),
                ticketsCapLeft: typeof parsed.ticketsCapLeft === 'number' ? parsed.ticketsCapLeft : 0,
            };
        }
        catch {
            resolved.session.removeItem(sessionKey(game));
            return null;
        }
    }
    function writeCached(session) {
        for (const game of GAME_IDS)
            resolved.session.removeItem(sessionKey(game));
        resolved.session.setItem(sessionKey(session.game), JSON.stringify(session));
        active = session;
    }
    function sessionInfo(session) {
        return {
            token: session.token,
            playerId: session.playerId,
            game: session.game,
            ranked: session.ranked,
            expiresAt: tokenExpiryMs(session.token),
        };
    }
    let shownItems;
    let shownGates;
    /** Copy items and gates. Drop any missing-item list a payload might carry. */
    function readInventory(profile) {
        shownItems = undefined;
        shownGates = undefined;
        if (Array.isArray(profile.items)) {
            const items = [];
            for (const id of profile.items) {
                if (typeof id === 'string' && id && !id.includes('://') && !id.includes('/'))
                    items.push(id);
            }
            shownItems = items;
        }
        if (!Array.isArray(profile.gates))
            return;
        const gates = [];
        for (const row of profile.gates) {
            if (!row || typeof row !== 'object' || Array.isArray(row))
                continue;
            const gate = row;
            if (typeof gate.gateId !== 'string' || !gate.gateId)
                continue;
            const target = typeof gate.target === 'string' ? gate.target : null;
            gates.push({
                gateId: gate.gateId,
                unlocked: gate.unlocked === true,
                actionType: typeof gate.actionType === 'string' ? gate.actionType : '',
                target: target && !target.includes('://') && !target.includes('/') ? target : null,
                lockedHintPool: typeof gate.lockedHintPool === 'string' && gate.lockedHintPool ? gate.lockedHintPool : null,
            });
        }
        shownGates = gates;
    }
    function withInventory(result) {
        if (shownItems)
            result.items = shownItems;
        if (shownGates)
            result.gates = shownGates;
        return result;
    }
    function profileOf(session, serverTime) {
        return {
            playerId: session.playerId,
            ranked: session.ranked,
            relics: [...session.relics],
            effects: { ...session.effects },
            ticketsCapLeft: session.ticketsCapLeft,
            serverTime,
        };
    }
    function standalone(serverTime) {
        active = null;
        return {
            playerId: getOrCreateDeviceId(resolved.local),
            ranked: false,
            relics: [],
            effects: {},
            ticketsCapLeft: 0,
            serverTime,
        };
    }
    function noteGrant(session, response) {
        if (!response || typeof response !== 'object')
            return;
        const granted = response.granted;
        if (typeof granted !== 'string' || !isRelicId(granted) || session.relics.includes(granted))
            return;
        session.relics.push(granted);
        writeCached(session);
    }
    /**
     * One attempt. A lost response rejects and leaves the queued record in place. A final
     * refusal from the server drops the record and still rejects, so the caller sees it.
     */
    async function transmit(row) {
        let response;
        try {
            response = await client.rpc(row.rpc, { ...row.body, key: row.key }, { token: row.token });
        }
        catch (error) {
            if (finalRefusal(error))
                await forget(row.key).catch(() => undefined);
            throw error;
        }
        await forget(row.key);
        if (active && row.gameId === active.game && row.rpc === 'session.event')
            noteGrant(active, response);
        return response;
    }
    /**
     * A queued row keeps the token it was first sent with. When that session has since
     * closed, the same player's live session for the same game carries it instead.
     * The server keys idempotency by (user, key) and checks it before the session, so
     * a row the old session already applied returns its saved response, not a second
     * credit. Another player's or another game's row is never re-pointed.
     */
    async function rebind(row) {
        if (!active || row.gameId !== active.game || row.token === active.token)
            return row;
        const owner = tokenUser(row.token);
        if (!owner || owner !== tokenUser(active.token))
            return row;
        const next = { ...row, token: active.token };
        await putWrite(next);
        return next;
    }
    async function sendOnce(session, rpc, key, body) {
        const row = await rebind(await remember({ rpc, body, key, token: session.token, gameId: session.game }));
        return transmit(row);
    }
    /** End the active session: closed by a newer portal or by exit, or past its lease. */
    function dropActive() {
        if (active)
            resolved.session.removeItem(sessionKey(active.game));
        active = null;
        shownItems = undefined;
        shownGates = undefined;
    }
    /**
     * One refresh in flight per refresh token, shared by init(), refreshSession() and the
     * realtime getToken path (which calls refreshSession). Nakama may rotate refresh tokens,
     * so sending the same one twice can get the second call refused.
     */
    let refreshing = null;
    function refreshShared(refreshToken) {
        if (refreshing && refreshing.refreshToken === refreshToken)
            return refreshing.promise;
        if (!client.sessionRefresh)
            return Promise.reject(new HubSdkError('auth_failed', 'Session refresh is unavailable'));
        const promise = client.sessionRefresh(refreshToken).finally(() => {
            if (refreshing && refreshing.promise === promise)
                refreshing = null;
        });
        refreshing = { refreshToken, promise };
        return promise;
    }
    /** A session for this game holding a different token than `staleToken`: someone already refreshed. */
    function newerSession(game, staleToken) {
        if (active && active.game === game && active.token !== staleToken)
            return active;
        const cached = readCached(game);
        return cached && cached.token !== staleToken ? cached : null;
    }
    function warnRow(what, error) {
        // A HubSdkError is a server or session answer and is expected here. Anything else may be
        // a bug, so say so instead of hiding it.
        if (error instanceof HubSdkError)
            return;
        console.warn(`hub-sdk: ${what}; left queued`, error);
    }
    /**
     * Send the queued rows. Every game shares the `hub-outbox` database on one origin.
     *
     * - This game's rows may move onto this session's token (rebind).
     * - Another game's row (or one with no game) goes out on its own stored token only, so a
     *   game the player never relaunches still gets its writes delivered. It is never
     *   re-pointed, it is dropped only on its own final refusal, and its failure never
     *   affects this game.
     *
     * No single row fails init:
     * - a final refusal is dropped by transmit (the write that queued it already got that error);
     * - a row on a dead session this session cannot carry waits for its own player's next session;
     * - a network failure, an HTTP error or a storage error leaves the row queued for the
     *   next init, and the rows after it are still sent.
     *
     * profile.get does not report a closed session today, so a row on this session's own token
     * that comes back dead is the signal: the session ends (standalone, cache cleared) and no
     * more rows go out on that token.
     */
    async function drain(game) {
        let rows;
        try {
            rows = await listWrites();
        }
        catch (error) {
            console.warn('hub-sdk: could not read the outbox; queued writes wait for the next init', error);
            return;
        }
        let deadToken = null;
        for (const queued of rows) {
            const own = typeof queued.gameId === 'string' && canonicalGameId(queued.gameId) === game;
            if (!own) {
                // Another game's row on an expired token can only land through its own game's rebind.
                const expiresAt = tokenExpiryMs(queued.token);
                if (expiresAt && expiresAt <= resolved.now())
                    continue;
            }
            let row = queued;
            try {
                if (own)
                    row = await rebind(queued);
                if (deadToken !== null && row.token === deadToken)
                    continue;
                await transmit(row);
            }
            catch (error) {
                if (own && active && row.token === active.token && deadSession(error)) {
                    deadToken = active.token;
                    dropActive();
                    continue;
                }
                warnRow(`outbox row ${queued.key} failed`, error);
            }
        }
    }
    async function rememberAuth(game, auth) {
        const vars = sessionVarsFromToken(auth.token);
        let relics = [];
        let effects = {};
        let ticketsCapLeft = 0;
        let playerId = auth.userId;
        let ranked = vars.ranked === '1';
        let serverTime = 0;
        try {
            const profile = await client.rpc('profile.get', {}, { token: auth.token });
            relics = asRelics(profile.relics);
            effects = flatEffects(profile.effects);
            readInventory(profile);
            if (typeof profile.ticketsCapLeft === 'number')
                ticketsCapLeft = profile.ticketsCapLeft;
            if (profile.playerId)
                playerId = profile.playerId;
            if (profile.ranked === true)
                ranked = true;
            serverTime = clockMs(profile.serverTime);
        }
        catch {
            // The session token is still valid. The next init can load the profile.
        }
        if (!vars.sid)
            return serverTime;
        writeCached({
            game,
            playerId,
            ranked,
            sid: vars.sid,
            token: auth.token,
            refreshToken: auth.refreshToken || undefined,
            effects,
            relics,
            ticketsCapLeft,
        });
        return serverTime;
    }
    async function redeemCustom(game, ticket) {
        const authenticateCustom = client.authenticateCustom;
        if (!authenticateCustom)
            throw new HubSdkError('auth_failed', 'Custom authentication is unavailable');
        const auth = await authenticateCustom(`t:${ticket}`, false, { game });
        const serverTime = await rememberAuth(game, auth);
        return { token: auth.token, refreshToken: auth.refreshToken, serverTime };
    }
    return {
        async redeemTicket({ game: gameId }) {
            const game = canonicalGameId(gameId);
            if (!game)
                throw new HubSdkError('bad_game', `Unknown game "${gameId}"`);
            const ticket = readTicketParam(resolved.readHash());
            resolved.writeHash(stripTicketParam(resolved.readHash()));
            if (!ticket)
                throw new HubSdkError('ticket_invalid', 'Missing ticket');
            return redeemCustom(game, ticket);
        },
        async init(gameId) {
            const game = canonicalGameId(gameId);
            if (!game)
                throw new HubSdkError('bad_game', `Unknown game "${gameId}"`);
            const token = readTicketParam(resolved.readHash());
            let serverTime = 0;
            shownItems = undefined;
            shownGates = undefined;
            if (token) {
                resolved.writeHash(stripTicketParam(resolved.readHash()));
                const redeemed = await redeemCustom(game, token);
                serverTime = redeemed.serverTime;
                if (!active)
                    throw new HubSdkError('ticket_invalid', 'Redeem did not return a session');
            }
            else {
                const cached = readCached(game);
                if (!cached) {
                    active = null;
                }
                else {
                    const loadProfile = (sessionToken) => client.rpc('profile.get', {}, { token: sessionToken });
                    let profile = null;
                    let dead = false;
                    let current = cached;
                    const retryProfile = async () => {
                        try {
                            profile = await loadProfile(current.token);
                        }
                        catch (retryError) {
                            dead = deadSession(retryError);
                        }
                    };
                    try {
                        profile = await loadProfile(current.token);
                    }
                    catch (error) {
                        if (expiredToken(error) && current.refreshToken && client.sessionRefresh) {
                            // The 2 h access token lapsed (a tab restored after sleep) while the refresh
                            // token and the lease may still hold: refresh, keep it, and retry once.
                            const staleToken = current.token;
                            try {
                                const fresh = await refreshShared(current.refreshToken);
                                current.token = fresh.token;
                                current.refreshToken = fresh.refreshToken || current.refreshToken;
                                writeCached(current);
                                await retryProfile();
                            }
                            catch (refreshError) {
                                // Another path may already have rotated the token: keep that session.
                                const newer = refreshRefused(refreshError) ? newerSession(game, staleToken) : null;
                                if (newer) {
                                    current = newer;
                                    await retryProfile();
                                }
                                else {
                                    dead = refreshRefused(refreshError);
                                }
                            }
                        }
                        else {
                            dead = deadSession(error);
                        }
                    }
                    if (dead) {
                        // Run standalone until the hub sends a fresh ticket. Do not keep showing it as live.
                        resolved.session.removeItem(sessionKey(game));
                        active = null;
                    }
                    else if (profile) {
                        const loaded = profile;
                        current.relics = asRelics(loaded.relics);
                        readInventory(loaded);
                        if (loaded.playerId)
                            current.playerId = loaded.playerId;
                        if (typeof loaded.ticketsCapLeft === 'number')
                            current.ticketsCapLeft = loaded.ticketsCapLeft;
                        serverTime = clockMs(loaded.serverTime);
                        writeCached(current);
                    }
                    else {
                        // Offline or a server hiccup: the token may still be good. The next init retries.
                        active = current;
                    }
                }
            }
            await drain(game);
            return withInventory(active ? profileOf(active, serverTime) : standalone(serverTime));
        },
        async reportEvent(eventId, data, key) {
            if (!key)
                throw new HubSdkError('bad_key', 'Idempotency key is required');
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
                throw new HubSdkError('bad_event', 'Event data must be an object');
            }
            if (!active)
                return {};
            const result = await sendOnce(active, 'session.event', key, { eventId, data });
            const answer = result && typeof result === 'object' ? result : {};
            const out = {};
            if (typeof answer.granted === 'string' && isRelicId(answer.granted))
                out.granted = answer.granted;
            // The server names `tickets` only when this event credited some (a story boss, 0.7.1).
            if (typeof answer.tickets === 'number' && Number.isSafeInteger(answer.tickets) && answer.tickets >= 0)
                out.tickets = answer.tickets;
            return out;
        },
        async submitScore(boardId, value, meta) {
            if (!isBoardId(boardId))
                throw new HubSdkError('bad_board', `Unknown board "${boardId}"`);
            if (!Number.isFinite(value) || value < 0)
                throw new HubSdkError('bad_score', 'Score must be a non-negative number');
            // The server owns eligibility (ranked gate, god mode, bounds), so unranked sessions post too.
            if (!active)
                return;
            const godMode = meta?.godMode === true;
            return client.rpc('score.submit', { boardId, value, meta: meta ?? {}, godMode }, { token: active.token });
        },
        getSession() {
            return active ? sessionInfo(active) : null;
        },
        async refreshSession() {
            if (!active)
                return null;
            const session = active;
            const expiresAt = tokenExpiryMs(session.token);
            if (!expiresAt || expiresAt - resolved.now() > 300_000)
                return sessionInfo(session);
            if (!client.sessionRefresh || !session.refreshToken)
                return sessionInfo(session);
            const staleToken = session.token;
            let fresh;
            try {
                fresh = await refreshShared(session.refreshToken);
            }
            catch (error) {
                // init() or another instance already rotated the token: use that session.
                const newer = active ? newerSession(active.game, staleToken) : null;
                if (newer)
                    return sessionInfo(newer);
                throw error;
            }
            if (active !== session)
                return active ? sessionInfo(active) : null;
            if (session.token !== staleToken)
                return sessionInfo(session);
            session.token = fresh.token;
            session.refreshToken = fresh.refreshToken;
            writeCached(session);
            return sessionInfo(session);
        },
        async getLeaderboard(boardId, opts) {
            if (!isBoardId(boardId))
                throw new HubSdkError('bad_board', `Unknown board "${boardId}"`);
            const variant = opts?.variant ?? '';
            if (!active)
                return { boardId, variant, order: boardId === 'hpos10i_act_time' || boardId === 'nobu_trial_time' ? 'asc' : 'desc', rows: [], me: null };
            const body = { boardId };
            if (opts?.variant !== undefined)
                body.variant = opts.variant;
            if (opts?.limit !== undefined)
                body.limit = opts.limit;
            return client.rpc('leaderboard.top', body, { token: active.token });
        },
        async loadSave() {
            if (!active)
                return { ...EMPTY_SAVE };
            return readSaveResult(await client.rpc('save.get', {}, { token: active.token }));
        },
        async writeSave(data) {
            encodeSave(data);
            if (!active)
                return { ...EMPTY_SAVE };
            return readSaveResult(await client.rpc('save.put', { data }, { token: active.token }));
        },
        async feedbackAccess() {
            if (!active)
                return { ok: false, reason: 'standalone' };
            try {
                const result = await client.rpc('feedback.can', {}, { token: active.token });
                return { ok: true, username: result.username };
            }
            catch (error) {
                if (error instanceof HubSdkError && error.code !== 'rpc_failed')
                    return { ok: false, reason: error.code };
                return { ok: false, reason: 'offline' };
            }
        },
        async submitFeedback(input) {
            if (!active)
                throw new HubSdkError('standalone', 'Feedback needs a hub session');
            const result = await client.rpc('feedback.submit', input, { token: active.token });
            return { id: result.id };
        },
        async earnTickets(amount, reason, key) {
            if (!key)
                throw new HubSdkError('bad_key', 'Idempotency key is required');
            if (!Number.isFinite(amount) || amount <= 0)
                throw new HubSdkError('bad_amount', 'Ticket amount must be positive');
            if (!reason)
                throw new HubSdkError('bad_reason', 'A reason is required');
            if (!active)
                return { balance: 0, capped: false };
            return sendOnce(active, 'tickets.earn', key, { amount: Math.floor(amount), reason });
        },
        async exchange(tickets, key) {
            if (!key)
                throw new HubSdkError('bad_key', 'Idempotency key is required');
            if (!Number.isFinite(tickets) || tickets <= 0) {
                throw new HubSdkError('bad_amount', 'Exchange amount must be positive');
            }
            if (!active)
                return { verse: 0, ticketsLeft: 0, balance: 0, receiptId: 'noop', verseCapLeft: 0 };
            return sendOnce(active, 'tickets.exchange', key, { tickets: Math.floor(tickets) });
        },
        async spendTickets(shopId, itemId, packs, key) {
            if (!key)
                throw new HubSdkError('bad_key', 'Idempotency key is required');
            if (!shopId || !itemId)
                throw new HubSdkError('unknown_item', 'Unknown item');
            if (!Number.isFinite(packs) || packs <= 0 || Math.floor(packs) !== packs) {
                throw new HubSdkError('bad_amount', 'Quantity must be a positive integer');
            }
            const packsOut = Math.floor(packs);
            if (!active)
                return { shop_id: shopId, item_id: itemId, packs: packsOut, units: packsOut, spent: 0, balance: 0 };
            return sendOnce(active, 'tickets.spend', key, {
                game: active.game,
                shop_id: shopId,
                item_id: itemId,
                packs: packsOut,
            });
        },
        async sellItem(shopId, itemId, packs, key) {
            if (!key)
                throw new HubSdkError('bad_key', 'Idempotency key is required');
            if (!shopId || !itemId)
                throw new HubSdkError('unknown_item', 'Unknown item');
            if (!Number.isFinite(packs) || packs <= 0 || Math.floor(packs) !== packs) {
                throw new HubSdkError('bad_amount', 'Quantity must be a positive integer');
            }
            const packsOut = Math.floor(packs);
            if (!active)
                return { shop_id: shopId, item_id: itemId, packs: packsOut, units: packsOut, credited: 0, balance: 0 };
            return sendOnce(active, 'tickets.sell', key, {
                game: active.game,
                shop_id: shopId,
                item_id: itemId,
                packs: packsOut,
            });
        },
        async getTicketBalance() {
            if (!active)
                return { balance: 0, sessionCapLeft: 0, dailyCapLeft: 0, serverTime: 0 };
            const body = await client.rpc('tickets.balance', { game: active.game }, { token: active.token });
            return {
                balance: typeof body.balance === 'number' ? body.balance : 0,
                sessionCapLeft: typeof body.sessionCapLeft === 'number' ? body.sessionCapLeft : 0,
                dailyCapLeft: typeof body.dailyCapLeft === 'number' ? body.dailyCapLeft : 0,
                serverTime: clockMs(body.serverTime),
            };
        },
        exit(reason) {
            if (!active)
                return;
            const game = active.game;
            const token = active.token;
            resolved.session.removeItem(sessionKey(game));
            active = null;
            resolved.clearBeforeUnload();
            resolved.releasePointer();
            void client.rpc('session.close', { reason: reason ?? '' }, { token, keepalive: true }).catch(() => undefined);
            const base = resolved.hubUrl.replace(/\/$/, '');
            resolved.assign(`${base}/#from=${game}`);
        },
    };
}
