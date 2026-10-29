import { resolveHubEnv } from './env';
import { HubSdkError } from './errors';
import { relicForEvent } from './events';
import { createLiveHubSdk } from './live';
import { createNakamaClient, LOCAL_NAKAMA } from './nakama';
import { getOrCreateDeviceId, readNumber, writeNumber } from './storage';
import { readTicketParam, stripTicketParam, verifyMockTicket } from './ticket';
import { GAME_IDS, MOCK_TICKET_EARN_CAP, TICKETS_PER_VERSE, VERSE_DAILY_CAP, isBoardId, isRelicId, } from './types';
const BOARD_MODE = {
    hpos10i_act_time: 'asc-best',
    nobu_trial_time: 'asc-best',
    pb_total_xp: 'desc-set',
    sproto_wins: 'desc-incr',
    meta: 'desc-set',
};
function dayKey(now) {
    return new Date(now).toISOString().slice(0, 10);
}
function stable(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value))
        return `[${value.map((item) => stable(item)).join(',')}]`;
    const obj = value;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(obj[key])}`).join(',')}}`;
}
async function sha256(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    const bytes = new Uint8Array(digest);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1)
        binary += String.fromCharCode(bytes[i] ?? 0);
    return btoa(binary);
}
/**
 * Game-facing hub SDK. Pass `serverUrl` (or a `client`) to talk to Nakama.
 * Omit both and the in-memory mock stays in place for unit tests and for a
 * game that is running outside the hub. With no ticket and no session every
 * call no-ops, so the game still runs standalone.
 */
export function createHubSdk(env = {}) {
    if (!env.useMock && (env.client || env.serverUrl != null)) {
        const client = env.client ??
            createNakamaClient({
                serverUrl: env.serverUrl ?? '',
                serverKey: env.serverKey ?? LOCAL_NAKAMA.serverKey,
                httpKey: env.httpKey ?? LOCAL_NAKAMA.httpKey,
            });
        return createLiveHubSdk(env, client);
    }
    return createMockHubSdk(env);
}
function createMockHubSdk(env) {
    const resolved = resolveHubEnv(env);
    let active = null;
    function sessionKey(game) {
        return `hub:${game}:session`;
    }
    function spentKey() {
        return 'hub:spent-jti';
    }
    function spentSet() {
        const raw = resolved.session.getItem(spentKey());
        if (!raw)
            return new Set();
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed))
                return new Set();
            return new Set(parsed.filter((item) => typeof item === 'string'));
        }
        catch {
            return new Set();
        }
    }
    function markSpent(jti) {
        const next = [...spentSet(), jti].slice(-64);
        resolved.session.setItem(spentKey(), JSON.stringify(next));
    }
    function readRelics() {
        const raw = resolved.local.getItem('hub:relics');
        if (!raw)
            return [];
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed))
                return [];
            return parsed.filter((item) => typeof item === 'string' && isRelicId(item));
        }
        catch {
            return [];
        }
    }
    function writeRelics(relics) {
        resolved.local.setItem('hub:relics', JSON.stringify(relics));
    }
    function ticketsKey(game) {
        return `hub:tickets:${game}`;
    }
    function bucketNow() {
        return env.serverNow ? env.serverNow() : resolved.now();
    }
    function earnKey(game) {
        return `hub:earn:${game}:${dayKey(bucketNow())}`;
    }
    function verseDayKey(game) {
        return `hub:verseDay:${game}:${dayKey(bucketNow())}`;
    }
    function capLeft(game) {
        return Math.max(0, MOCK_TICKET_EARN_CAP - readNumber(resolved.local, earnKey(game)));
    }
    function profile(session) {
        return {
            playerId: session.playerId,
            ranked: session.ranked,
            relics: readRelics(),
            effects: { ...session.effects },
            ticketsCapLeft: capLeft(session.game),
        };
    }
    function standaloneProfile() {
        return {
            playerId: getOrCreateDeviceId(resolved.local),
            ranked: false,
            relics: [],
            effects: {},
            ticketsCapLeft: 0,
        };
    }
    function openSession(claims) {
        for (const game of GAME_IDS)
            resolved.session.removeItem(sessionKey(game));
        const session = {
            game: claims.game,
            playerId: claims.playerId,
            ranked: claims.ranked,
            sid: crypto.randomUUID(),
            ticketJti: claims.jti,
            effects: {},
        };
        resolved.session.setItem(sessionKey(claims.game), JSON.stringify(session));
        active = session;
        return session;
    }
    async function withIdem(playerId, key, rpc, body, run) {
        if (!key)
            throw new HubSdkError('bad_key', 'Idempotency key is required');
        const hash = await sha256(`${rpc}:${body}`);
        const storageKey = `hub:idem:${playerId}:${key}`;
        const existing = resolved.local.getItem(storageKey);
        if (existing) {
            const rec = JSON.parse(existing);
            if (rec.rpc !== rpc || rec.hash !== hash) {
                throw new HubSdkError('idempotency_mismatch', 'Idempotency key was reused with a different request');
            }
            return rec.response;
        }
        const response = run();
        resolved.local.setItem(storageKey, JSON.stringify({ rpc, hash, response }));
        return response;
    }
    return {
        async init(gameId) {
            if (!GAME_IDS.includes(gameId)) {
                throw new HubSdkError('bad_game', `Unknown game "${gameId}"`);
            }
            const token = readTicketParam(resolved.readHash());
            if (token) {
                const claims = await verifyMockTicket(token);
                if (!claims)
                    throw new HubSdkError('ticket_invalid', 'Ticket signature or payload is not valid');
                if (claims.exp * 1000 <= resolved.now())
                    throw new HubSdkError('ticket_expired', 'Ticket expired');
                if (claims.game !== gameId)
                    throw new HubSdkError('ticket_game', 'Ticket is for a different game');
                if (spentSet().has(claims.jti))
                    throw new HubSdkError('ticket_used', 'Ticket was already redeemed');
                markSpent(claims.jti);
                resolved.writeHash(stripTicketParam(resolved.readHash()));
                return profile(openSession(claims));
            }
            const saved = resolved.session.getItem(sessionKey(gameId));
            if (saved) {
                try {
                    const session = JSON.parse(saved);
                    if (session.game === gameId && session.playerId) {
                        active = session;
                        return profile(session);
                    }
                }
                catch {
                    resolved.session.removeItem(sessionKey(gameId));
                }
            }
            active = null;
            return standaloneProfile();
        },
        async reportEvent(eventId, data, key) {
            if (!key)
                throw new HubSdkError('bad_key', 'Idempotency key is required');
            if (!data || typeof data !== 'object')
                throw new HubSdkError('bad_event', 'Event data must be an object');
            if (!active)
                return {};
            const session = active;
            return withIdem(session.playerId, key, 'session.event', stable({ eventId, data }), () => {
                const relic = relicForEvent(session.game, eventId, data);
                if (!relic)
                    return {};
                const owned = readRelics();
                if (owned.includes(relic))
                    return {};
                writeRelics([...owned, relic]);
                return { granted: relic };
            });
        },
        async submitScore(boardId, value, meta) {
            if (!isBoardId(boardId))
                throw new HubSdkError('bad_board', `Unknown board "${boardId}"`);
            if (!Number.isFinite(value) || value < 0)
                throw new HubSdkError('bad_score', 'Score must be a non-negative number');
            if (!active || !active.ranked)
                return;
            const storageKey = `hub:score:${active.playerId}:${boardId}`;
            const previous = readNumber(resolved.local, storageKey);
            const hasPrevious = resolved.local.getItem(storageKey) !== null;
            const mode = BOARD_MODE[boardId];
            let next = value;
            if (mode === 'asc-best')
                next = hasPrevious ? Math.min(previous, value) : value;
            if (mode === 'desc-incr')
                next = previous + value;
            writeNumber(resolved.local, storageKey, next);
            if (meta && typeof meta === 'object')
                resolved.local.setItem(`${storageKey}:meta`, stable(meta));
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
            const session = active;
            const whole = Math.floor(amount);
            return withIdem(session.playerId, key, 'tickets.earn', stable({ amount: whole, reason }), () => {
                const room = capLeft(session.game);
                const applied = Math.min(whole, room);
                const earned = readNumber(resolved.local, earnKey(session.game)) + applied;
                const balance = readNumber(resolved.local, ticketsKey(session.game)) + applied;
                writeNumber(resolved.local, earnKey(session.game), earned);
                writeNumber(resolved.local, ticketsKey(session.game), balance);
                return { balance, capped: applied < whole };
            });
        },
        async exchange(tickets, key) {
            if (!key)
                throw new HubSdkError('bad_key', 'Idempotency key is required');
            if (!Number.isFinite(tickets) || tickets <= 0) {
                throw new HubSdkError('bad_amount', 'Exchange amount must be positive');
            }
            if (!active)
                return { verse: 0, ticketsLeft: 0, receiptId: 'noop' };
            const session = active;
            const requested = Math.floor(tickets);
            return withIdem(session.playerId, key, 'tickets.exchange', stable({ tickets: requested }), () => {
                let verseOut = Math.floor(requested / TICKETS_PER_VERSE);
                if (verseOut <= 0) {
                    throw new HubSdkError('below_rate', `Need at least ${TICKETS_PER_VERSE} Tickets to mint 1 Verse`);
                }
                const today = readNumber(resolved.local, verseDayKey(session.game));
                const room = VERSE_DAILY_CAP - today;
                if (room <= 0)
                    throw new HubSdkError('verse_cap', 'Daily Verse cap reached for this game');
                verseOut = Math.min(verseOut, room);
                const debit = verseOut * TICKETS_PER_VERSE;
                const balance = readNumber(resolved.local, ticketsKey(session.game));
                if (balance < debit)
                    throw new HubSdkError('insufficient_tickets', 'Not enough Tickets');
                const ticketsLeft = balance - debit;
                const verse = readNumber(resolved.local, 'hub:verse') + verseOut;
                writeNumber(resolved.local, ticketsKey(session.game), ticketsLeft);
                writeNumber(resolved.local, 'hub:verse', verse);
                writeNumber(resolved.local, verseDayKey(session.game), today + verseOut);
                return { verse, ticketsLeft, receiptId: crypto.randomUUID() };
            });
        },
        exit(_reason) {
            if (!active)
                return;
            const game = active.game;
            resolved.session.removeItem(sessionKey(game));
            active = null;
            resolved.clearBeforeUnload();
            resolved.releasePointer();
            const base = resolved.hubUrl.replace(/\/$/, '');
            resolved.assign(`${base}/#from=${game}`);
        },
    };
}
/** Puts the SDK on `window.hubSdk` for the Godot JavaScriptBridge and plain script tags. */
export function installHubSdk(sdk = createHubSdk()) {
    if (typeof window !== 'undefined')
        window.hubSdk = sdk;
    return sdk;
}
//# sourceMappingURL=createHubSdk.js.map