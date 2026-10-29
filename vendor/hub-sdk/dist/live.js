import { resolveHubEnv } from './env';
import { HubSdkError } from './errors';
import { defaultLiveOutbox, sameBody } from './outbox';
import { getOrCreateDeviceId } from './storage';
import { readTicketParam, stripTicketParam } from './ticket';
import { GAME_IDS, isBoardId, isGameId, isRelicId, } from './types';
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
const TERMINAL = new Set([
    'idempotency_mismatch',
    'bad_key',
    'bad_event',
    'bad_amount',
    'bad_reason',
    'bad_json',
    'bad_game',
]);
function isRetryable(error) {
    if (!(error instanceof HubSdkError))
        return true;
    if (error.code === 'queued')
        return true;
    if (error.code !== 'rpc_failed')
        return false;
    const status = error.status ?? 0;
    return status === 0 || status === 408 || status === 429 || status >= 500;
}
function operationId(playerId, rpc, callerKey) {
    return `${playerId}:${rpc}:${callerKey}`;
}
/**
 * Hub SDK backed by Nakama. `init` reads `#t=<ticket>`, strips it, and exchanges it
 * for a game-scoped session cached in sessionStorage. Without a ticket or a cached
 * session every call no-ops so the game still runs standalone.
 */
export function createLiveHubSdk(env, client) {
    const resolved = resolveHubEnv(env);
    const outbox = env.outbox ?? defaultLiveOutbox();
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
    function profileOf(session) {
        return {
            playerId: session.playerId,
            ranked: session.ranked,
            relics: [...session.relics],
            effects: { ...session.effects },
            ticketsCapLeft: session.ticketsCapLeft,
        };
    }
    function standalone() {
        active = null;
        return {
            playerId: getOrCreateDeviceId(resolved.local),
            ranked: false,
            relics: [],
            effects: {},
            ticketsCapLeft: 0,
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
    async function deliver(session, row, keepalive = false) {
        const response = await client.rpc(row.rpc, { ...row.body, key: row.idemKey }, { token: session.token, keepalive });
        await outbox.settle(row, response);
        if (row.rpc === 'session.event')
            noteGrant(session, response);
        return response;
    }
    async function flush(session, except) {
        await outbox.ready();
        const rows = outbox
            .list(session.playerId)
            .filter((row) => row.game === session.game && row.opId !== except && !TERMINAL.has(row.lastError ?? ''))
            .sort((a, b) => a.createdAt - b.createdAt || a.idemKey.localeCompare(b.idemKey));
        for (const row of rows) {
            try {
                await deliver(session, row);
            }
            catch (error) {
                const code = error instanceof HubSdkError ? error.code : 'queued';
                if (TERMINAL.has(code))
                    await outbox.markError(row.opId, code);
                if (isRetryable(error))
                    return;
            }
        }
    }
    async function flushStored() {
        await outbox.ready();
        const rows = outbox
            .all()
            .filter((row) => row.token && !TERMINAL.has(row.lastError ?? ''))
            .sort((a, b) => a.createdAt - b.createdAt || a.idemKey.localeCompare(b.idemKey));
        for (const row of rows) {
            try {
                const response = await client.rpc(row.rpc, { ...row.body, key: row.idemKey }, { token: row.token });
                await outbox.settle(row, response);
            }
            catch (error) {
                const code = error instanceof HubSdkError ? error.code : 'queued';
                if (TERMINAL.has(code))
                    await outbox.markError(row.opId, code);
                if (isRetryable(error))
                    return;
            }
        }
    }
    async function send(session, rpc, callerKey, body) {
        const opId = operationId(session.playerId, rpc, callerKey);
        try {
            await outbox.ready();
        }
        catch {
            throw new HubSdkError('outbox', 'Could not save this request.');
        }
        await flush(session, opId);
        const done = outbox.settled(opId);
        if (done) {
            if (done.rpc !== rpc || !sameBody(done.body, body)) {
                throw new HubSdkError('idempotency_mismatch', 'Idempotency key was reused with a different request');
            }
            if (rpc === 'session.event')
                noteGrant(session, done.response);
            return done.response;
        }
        const row = await outbox.claim({
            opId,
            rpc,
            playerId: session.playerId,
            game: session.game,
            body,
            token: session.token,
            createdAt: Date.now(),
        });
        if (row.rpc !== rpc || !sameBody(row.body, body)) {
            throw new HubSdkError('idempotency_mismatch', 'Idempotency key was reused with a different request');
        }
        try {
            return (await deliver(session, row));
        }
        catch (error) {
            if (isRetryable(error))
                throw new HubSdkError('queued', 'Saved to send when the hub is reachable.');
            const code = error instanceof HubSdkError ? error.code : 'rpc_failed';
            if (TERMINAL.has(code))
                await outbox.markError(row.opId, code);
            throw error;
        }
    }
    return {
        async init(gameId) {
            if (!isGameId(gameId))
                throw new HubSdkError('bad_game', `Unknown game "${gameId}"`);
            const token = readTicketParam(resolved.readHash());
            if (token) {
                const body = await client.rpc('session.redeem', { ticket: token, gameId }, { httpKey: true });
                if (!body.token || !body.playerId || !body.sid) {
                    throw new HubSdkError('ticket_invalid', 'Redeem did not return a session');
                }
                resolved.writeHash(stripTicketParam(resolved.readHash()));
                const session = {
                    game: gameId,
                    playerId: body.playerId,
                    ranked: body.ranked === true,
                    sid: body.sid,
                    token: body.token,
                    effects: flatEffects(body.effects),
                    relics: asRelics(body.relics),
                    ticketsCapLeft: typeof body.ticketsCapLeft === 'number' ? body.ticketsCapLeft : 0,
                };
                writeCached(session);
                await flush(session).catch(() => undefined);
                return profileOf(session);
            }
            const cached = readCached(gameId);
            if (!cached) {
                await flushStored().catch(() => undefined);
                return standalone();
            }
            try {
                const profile = await client.rpc('profile.get', {}, { token: cached.token });
                cached.relics = asRelics(profile.relics);
                if (profile.playerId)
                    cached.playerId = profile.playerId;
                if (typeof profile.ticketsCapLeft === 'number')
                    cached.ticketsCapLeft = profile.ticketsCapLeft;
                writeCached(cached);
            }
            catch {
                active = cached;
            }
            await flush(cached).catch(() => undefined);
            return profileOf(cached);
        },
        async reportEvent(eventId, data, key) {
            if (!key)
                throw new HubSdkError('bad_key', 'Idempotency key is required');
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
                throw new HubSdkError('bad_event', 'Event data must be an object');
            }
            if (!active)
                return {};
            const result = await send(active, 'session.event', key, { eventId, data });
            return result.granted && isRelicId(result.granted) ? { granted: result.granted } : {};
        },
        async submitScore(boardId, value, meta) {
            if (!isBoardId(boardId))
                throw new HubSdkError('bad_board', `Unknown board "${boardId}"`);
            if (!Number.isFinite(value) || value < 0)
                throw new HubSdkError('bad_score', 'Score must be a non-negative number');
            if (!active || !active.ranked)
                return;
            await client.rpc('score.submit', { boardId, value, meta: meta ?? {} }, { token: active.token });
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
            return send(active, 'tickets.earn', key, { amount: Math.floor(amount), reason });
        },
        async exchange(tickets, key) {
            if (!key)
                throw new HubSdkError('bad_key', 'Idempotency key is required');
            if (!Number.isFinite(tickets) || tickets <= 0) {
                throw new HubSdkError('bad_amount', 'Exchange amount must be positive');
            }
            if (!active)
                return { verse: 0, ticketsLeft: 0, receiptId: 'noop' };
            return send(active, 'tickets.exchange', key, { tickets: Math.floor(tickets) });
        },
        exit(reason) {
            if (!active)
                return;
            const session = active;
            const game = session.game;
            const pending = outbox
                .list(session.playerId)
                .filter((row) => row.game === game && !TERMINAL.has(row.lastError ?? ''))
                .sort((a, b) => a.createdAt - b.createdAt || a.idemKey.localeCompare(b.idemKey));
            for (const row of pending) {
                void client
                    .rpc(row.rpc, { ...row.body, key: row.idemKey }, { token: session.token, keepalive: true })
                    .then((response) => outbox.settle(row, response))
                    .catch((error) => {
                    const code = error instanceof HubSdkError ? error.code : 'queued';
                    if (TERMINAL.has(code))
                        void outbox.markError(row.opId, code);
                });
            }
            resolved.session.removeItem(sessionKey(game));
            active = null;
            resolved.clearBeforeUnload();
            resolved.releasePointer();
            void client.rpc('session.close', { reason: reason ?? '' }, { token: session.token, keepalive: true }).catch(() => undefined);
            const base = resolved.hubUrl.replace(/\/$/, '');
            resolved.assign(`${base}/#from=${game}`);
        },
    };
}
//# sourceMappingURL=live.js.map