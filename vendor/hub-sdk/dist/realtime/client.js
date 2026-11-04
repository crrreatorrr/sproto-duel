import { HubSdkError } from '../errors';
import { createFriendsStub } from './friends';
import { bytesToBase64, base64ToBytes, channelJoinBody, chatMessageFromWire, encodePayload, errorFromEnvelope, labelFromWire, matchmakerUserFromWire, opCodeFromWire, presenceFromWire, presenceToWire, timeFromWire, utf8Decode, } from './protocol';
class Emitter {
    list = new Set();
    on(cb) {
        this.list.add(cb);
        return () => {
            this.list.delete(cb);
        };
    }
    get size() {
        return this.list.size;
    }
    emit(...args) {
        for (const cb of [...this.list]) {
            try {
                cb(...args);
            }
            catch (error) {
                // A throwing subscriber must not break delivery to the others.
                console.error('[hub-sdk realtime] listener failed', error);
            }
        }
    }
    clear() {
        this.list.clear();
    }
}
const OPEN = 1;
function samePresence(a, b) {
    return a.userId === b.userId && a.sessionId === b.sessionId;
}
function matchData(matchId, opCode, data, sender, reliable) {
    let text = null;
    return {
        matchId,
        opCode,
        data,
        sender,
        reliable,
        text() {
            if (text === null)
                text = utf8Decode(data);
            return text;
        },
        json() {
            return JSON.parse(this.text());
        },
    };
}
/** userId and username from the Nakama JWT; sessionId is filled by the first join. */
function presenceFromToken(token) {
    try {
        const part = token.split('.')[1] ?? '';
        const json = JSON.parse(utf8Decode(base64ToBytes(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='))));
        return { userId: json.uid ?? '', sessionId: '', username: json.usn ?? '' };
    }
    catch {
        return { userId: '', sessionId: '', username: '' };
    }
}
function matchmakerBody(req) {
    const body = {
        query: req.query,
        min_count: req.minCount,
        max_count: req.maxCount,
        string_properties: req.stringProperties ?? {},
        numeric_properties: req.numericProperties ?? {},
    };
    if (req.countMultiple)
        body.count_multiple = req.countMultiple;
    return body;
}
/**
 * Dependency-free Nakama realtime client (WebSocket + JSON protocol). It reconnects
 * with jittered backoff, re-joins matches and channels, and re-adds matchmaker tickets.
 */
export function createRealtime(options) {
    const timers = options.timers ?? { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) };
    const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    const reconnectCfg = options.reconnect === false ? null : {
        maxAttempts: options.reconnect?.maxAttempts ?? Infinity,
        baseDelayMs: options.reconnect?.baseDelayMs ?? 500,
        maxDelayMs: options.reconnect?.maxDelayMs ?? 15_000,
    };
    let state = 'idle';
    let self = null;
    let socket = null;
    let cid = 0;
    let attempt = 0;
    let wanted = false;
    let reconnectTimer = null;
    let connecting = null;
    let lastToken = '';
    const pending = new Map();
    /** Match messages that arrived before their join reply, by match id. */
    const orphans = new Map();
    let joinsInFlight = 0;
    async function joinRequest(body) {
        joinsInFlight += 1;
        try {
            return await request({ match_join: body }, 'match_join');
        }
        finally {
            joinsInFlight -= 1;
        }
    }
    function takeOrphans(matchId) {
        const held = orphans.get(matchId) ?? [];
        orphans.delete(matchId);
        if (joinsInFlight === 0)
            orphans.clear();
        return held;
    }
    const matches = new Map();
    const channels = new Map();
    const matchmaker = new Map();
    const stateEvents = new Emitter();
    const matchedEvents = new Emitter();
    const notificationEvents = new Emitter();
    const errorEvents = new Emitter();
    function setState(next, info = {}) {
        if (state === next)
            return;
        state = next;
        stateEvents.emit(next, { attempt, ...info });
    }
    function httpBase() {
        if (options.serverUrl)
            return options.serverUrl.replace(/\/$/, '');
        if (typeof location !== 'undefined')
            return location.origin;
        throw new HubSdkError('no_server', 'serverUrl is required outside a browser');
    }
    function wsUrl(token) {
        const base = httpBase().replace(/^http/, 'ws');
        return `${base}/ws?lang=en&status=${options.appearOnline === true}&token=${encodeURIComponent(token)}`;
    }
    function rawSend(env) {
        if (!socket || socket.readyState !== OPEN)
            throw new HubSdkError('rt_closed', 'Realtime socket is not open');
        socket.send(JSON.stringify(env));
    }
    function request(env, kind = 'other') {
        if (!socket || socket.readyState !== OPEN || state !== 'open') {
            return Promise.reject(new HubSdkError(state === 'reconnecting' ? 'rt_disconnected' : 'rt_closed', 'Realtime socket is not open'));
        }
        cid += 1;
        const id = String(cid);
        return new Promise((resolve, reject) => {
            const timer = timers.setTimeout(() => {
                pending.delete(id);
                reject(new HubSdkError('rt_timeout', 'Realtime request timed out'));
            }, requestTimeoutMs);
            pending.set(id, { resolve, reject, timer, kind });
            try {
                rawSend({ cid: id, ...env });
            }
            catch (error) {
                timers.clearTimeout(timer);
                pending.delete(id);
                reject(error instanceof HubSdkError ? error : new HubSdkError('rt_closed', String(error)));
            }
        });
    }
    function rejectPending(code) {
        for (const [id, p] of pending) {
            timers.clearTimeout(p.timer);
            pending.delete(id);
            p.reject(new HubSdkError(code, 'Realtime socket closed'));
        }
    }
    function closeMatch(entry, reason) {
        if (entry.closed)
            return;
        entry.closed = true;
        matches.delete(entry.matchId);
        entry.close.emit(reason);
        entry.message.clear();
        entry.presence.clear();
        entry.rejoin.clear();
        entry.close.clear();
    }
    function onEnvelope(env) {
        if (env.cid) {
            const p = pending.get(env.cid);
            if (p) {
                pending.delete(env.cid);
                timers.clearTimeout(p.timer);
                if (env.error)
                    p.reject(errorFromEnvelope(env.error, p.kind));
                else
                    p.resolve(env);
            }
            return;
        }
        if (env.error) {
            errorEvents.emit(errorFromEnvelope(env.error));
            return;
        }
        if (env.match_data) {
            const d = env.match_data;
            const entry = matches.get(d.match_id ?? '');
            const sender = d.presence && d.presence.user_id ? presenceFromWire(d.presence) : null;
            const bytes = d.data ? base64ToBytes(d.data) : new Uint8Array(0);
            if (!entry) {
                // Nakama can deliver a match's first messages (sent from matchJoin) before the
                // join reply. Hold them briefly; joinMatch hands them to the new handle.
                if (joinsInFlight > 0 && d.match_id) {
                    const held = orphans.get(d.match_id) ?? [];
                    if (held.length < 64)
                        held.push(matchData(d.match_id, opCodeFromWire(d.op_code), bytes, sender, d.reliable !== false));
                    orphans.set(d.match_id, held);
                }
                return;
            }
            const msg = matchData(entry.matchId, opCodeFromWire(d.op_code), bytes, sender, d.reliable !== false);
            if (entry.message.size === 0) {
                if (entry.early.length < 256)
                    entry.early.push(msg);
            }
            else {
                entry.message.emit(msg);
            }
            return;
        }
        if (env.match_presence_event) {
            const e = env.match_presence_event;
            const entry = matches.get(e.match_id ?? '');
            if (!entry)
                return;
            const joins = (e.joins ?? []).map(presenceFromWire).filter((p) => !samePresence(p, entry.self));
            const leavesAll = (e.leaves ?? []).map(presenceFromWire);
            if (leavesAll.some((p) => samePresence(p, entry.self))) {
                closeMatch(entry, 'kicked');
                return;
            }
            for (const p of joins)
                if (!entry.presences.some((q) => samePresence(p, q)))
                    entry.presences.push(p);
            entry.presences = entry.presences.filter((q) => !leavesAll.some((p) => samePresence(p, q)));
            entry.presence.emit({ joins, leaves: leavesAll });
            return;
        }
        if (env.match_ended) {
            const entry = matches.get(env.match_ended.match_id ?? '');
            if (entry)
                closeMatch(entry, 'ended');
            return;
        }
        if (env.matchmaker_matched) {
            const m = env.matchmaker_matched;
            let ticket = m.ticket ?? '';
            for (const entry of matchmaker.values()) {
                if (entry.current === ticket) {
                    ticket = entry.original;
                    matchmaker.delete(entry.original);
                    break;
                }
            }
            matchedEvents.emit({
                ticket,
                matchId: m.match_id || null,
                token: m.token || null,
                self: matchmakerUserFromWire(m.self),
                users: (m.users ?? []).map(matchmakerUserFromWire),
            });
            return;
        }
        if (env.channel_message) {
            const msg = chatMessageFromWire(env.channel_message);
            const entry = channels.get(msg.channelId);
            if (entry)
                entry.message.emit(msg);
            return;
        }
        if (env.channel_presence_event) {
            const e = env.channel_presence_event;
            const entry = channels.get(e.channel_id ?? '');
            if (!entry)
                return;
            const joins = (e.joins ?? []).map(presenceFromWire);
            const leaves = (e.leaves ?? []).map(presenceFromWire);
            for (const p of joins)
                if (!entry.presences.some((q) => samePresence(p, q)))
                    entry.presences.push(p);
            entry.presences = entry.presences.filter((q) => !leaves.some((p) => samePresence(p, q)));
            entry.presence.emit({ joins, leaves });
            return;
        }
        if (env.notifications) {
            for (const n of env.notifications.notifications ?? []) {
                let content = n.content;
                try {
                    content = n.content ? JSON.parse(n.content) : null;
                }
                catch {
                    // Leave content as the raw string.
                }
                notificationEvents.emit({
                    id: n.id ?? '',
                    subject: n.subject ?? '',
                    code: typeof n.code === 'number' ? n.code : Number(n.code ?? 0),
                    content,
                    senderId: n.sender_id ?? '',
                    persistent: n.persistent === true,
                    createdAt: timeFromWire(n.create_time),
                });
            }
        }
    }
    async function openSocket() {
        const token = await options.getToken();
        lastToken = token;
        const Impl = options.WebSocketImpl ?? globalThis.WebSocket;
        if (!Impl)
            throw new HubSdkError('rt_unavailable', 'WebSocket is not available');
        const ws = new Impl(wsUrl(token));
        socket = ws;
        await new Promise((resolve, reject) => {
            let opened = false;
            ws.onopen = () => {
                opened = true;
                resolve();
            };
            ws.onerror = () => {
                if (!opened)
                    reject(new HubSdkError('rt_connect_failed', 'Realtime socket failed to open'));
            };
            ws.onclose = (event) => {
                if (!opened) {
                    reject(new HubSdkError('rt_connect_failed', `Realtime socket closed (${event.code})`));
                    return;
                }
                handleClose(ws, event.code, event.reason);
            };
            ws.onmessage = (event) => {
                if (socket !== ws)
                    return;
                let env;
                try {
                    env = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
                }
                catch {
                    return;
                }
                onEnvelope(env);
            };
        });
        self = presenceFromToken(token);
    }
    async function restore() {
        for (const entry of [...matches.values()]) {
            try {
                const env = await joinRequest({ match_id: entry.matchId, metadata: entry.metadata ?? {} });
                const m = env.match ?? {};
                const held = takeOrphans(entry.matchId);
                if (entry.message.size === 0)
                    entry.early.push(...held);
                else
                    for (const msg of held)
                        entry.message.emit(msg);
                entry.self = presenceFromWire(m.self);
                if (entry.self.sessionId)
                    self = entry.self;
                entry.label = labelFromWire(m.label);
                entry.presences = (m.presences ?? []).map(presenceFromWire).filter((p) => !samePresence(p, entry.self));
                entry.rejoin.emit();
            }
            catch (error) {
                if (error instanceof HubSdkError && (error.code === 'rt_disconnected' || error.code === 'rt_closed'))
                    throw error;
                closeMatch(entry, 'rejoin_failed');
            }
        }
        for (const entry of [...channels.values()]) {
            try {
                const env = await request({ channel_join: channelJoinBody(entry.target, entry.persistence, entry.hidden) });
                entry.presences = (env.channel?.presences ?? []).map(presenceFromWire);
                if (env.channel?.self?.session_id)
                    self = presenceFromWire(env.channel.self);
            }
            catch (error) {
                if (error instanceof HubSdkError && (error.code === 'rt_disconnected' || error.code === 'rt_closed'))
                    throw error;
                errorEvents.emit(error instanceof HubSdkError ? error : new HubSdkError('rt_error', String(error)));
            }
        }
        for (const entry of [...matchmaker.values()]) {
            try {
                const env = await request({ matchmaker_add: matchmakerBody(entry.request) });
                entry.current = env.matchmaker_ticket?.ticket ?? entry.current;
            }
            catch (error) {
                if (error instanceof HubSdkError && (error.code === 'rt_disconnected' || error.code === 'rt_closed'))
                    throw error;
                matchmaker.delete(entry.original);
                errorEvents.emit(error instanceof HubSdkError ? error : new HubSdkError('rt_error', String(error)));
            }
        }
    }
    async function establish(isReconnect) {
        await openSocket();
        attempt = 0;
        setState('open');
        if (isReconnect)
            await restore();
    }
    function scheduleReconnect(code, reason) {
        if (!reconnectCfg || !wanted || attempt >= reconnectCfg.maxAttempts) {
            wanted = false;
            setState('closed', { code, reason });
            for (const entry of [...matches.values()])
                closeMatch(entry, 'rejoin_failed');
            return;
        }
        setState('reconnecting', { code, reason });
        const delay = Math.min(reconnectCfg.maxDelayMs, reconnectCfg.baseDelayMs * 2 ** attempt) * Math.random();
        attempt += 1;
        reconnectTimer = timers.setTimeout(() => {
            reconnectTimer = null;
            if (!wanted)
                return;
            establish(true).catch((error) => {
                if (!wanted)
                    return;
                // restore() lost the socket mid-way: the close handler already scheduled the next try.
                if (reconnectTimer || (socket && socket.readyState === OPEN))
                    return;
                socket = null;
                scheduleReconnect(undefined, error instanceof Error ? error.message : String(error));
            });
        }, delay);
    }
    function handleClose(ws, code, reason) {
        if (socket !== ws)
            return;
        socket = null;
        rejectPending('rt_disconnected');
        if (!wanted) {
            setState('closed', { code, reason });
            return;
        }
        scheduleReconnect(code, reason);
    }
    function matchHandle(entry) {
        return {
            get matchId() { return entry.matchId; },
            get label() { return entry.label; },
            get self() { return entry.self; },
            get presences() { return entry.presences; },
            send(opCode, data, opts) {
                if (entry.closed || !socket || socket.readyState !== OPEN || state !== 'open')
                    return;
                const body = {
                    match_id: entry.matchId,
                    op_code: String(opCode),
                    data: bytesToBase64(encodePayload(data)),
                };
                if (opts?.to)
                    body.presences = opts.to.map(presenceToWire);
                if (opts?.reliable === false)
                    body.reliable = false;
                else
                    body.reliable = true;
                socket.send(JSON.stringify({ match_data_send: body }));
            },
            onMessage(cb) {
                const off = entry.message.on(cb);
                if (entry.early.length) {
                    const early = entry.early.splice(0);
                    for (const msg of early)
                        entry.message.emit(msg);
                }
                return off;
            },
            onPresence: (cb) => entry.presence.on(cb),
            onRejoin: (cb) => entry.rejoin.on(cb),
            onClose: (cb) => entry.close.on(cb),
            async leave() {
                if (entry.closed)
                    return;
                try {
                    if (state === 'open')
                        await request({ match_leave: { match_id: entry.matchId } });
                }
                catch {
                    // The server drops the presence when the socket goes anyway.
                }
                finally {
                    closeMatch(entry, 'left');
                }
            },
        };
    }
    function channelHandle(entry) {
        return {
            get id() { return entry.id; },
            get target() { return entry.target; },
            get presences() { return entry.presences; },
            async send(content) {
                const body = typeof content === 'string' ? { text: content } : content;
                const env = await request({ channel_message_send: { channel_id: entry.id, content: JSON.stringify(body) } });
                return { messageId: env.channel_message_ack?.message_id ?? '' };
            },
            async history(opts) {
                const params = new URLSearchParams({ limit: String(Math.max(1, Math.min(100, opts?.limit ?? 30))), forward: 'false' });
                if (opts?.cursor)
                    params.set('cursor', opts.cursor);
                const body = await rest(`/v2/channel/${encodeURIComponent(entry.id)}?${params}`);
                return {
                    messages: (body.messages ?? []).map(chatMessageFromWire),
                    cursor: body.next_cursor ? body.next_cursor : null,
                };
            },
            onMessage: (cb) => entry.message.on(cb),
            onPresence: (cb) => entry.presence.on(cb),
            async leave() {
                if (entry.closed)
                    return;
                entry.closed = true;
                channels.delete(entry.id);
                try {
                    if (state === 'open')
                        await request({ channel_leave: { channel_id: entry.id } });
                }
                catch {
                    // Ignore: the channel is gone for this client either way.
                }
                entry.message.clear();
                entry.presence.clear();
            },
        };
    }
    async function rest(path) {
        const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
        const token = lastToken || (await options.getToken());
        const response = await fetchImpl(`${httpBase()}${path}`, { headers: { Authorization: `Bearer ${token}` } });
        const text = await response.text();
        if (!response.ok)
            throw new HubSdkError('rest_failed', text || `HTTP ${response.status}`, response.status);
        return (text ? JSON.parse(text) : {});
    }
    async function ensureOpen() {
        if (state === 'open')
            return;
        if (state === 'idle' || state === 'closed')
            await api.connect();
        else if (connecting)
            await connecting;
        if (state !== 'open')
            throw new HubSdkError('rt_disconnected', 'Realtime socket is not open');
    }
    const api = {
        get state() { return state; },
        get self() { return self; },
        connect() {
            if (state === 'open')
                return Promise.resolve();
            if (connecting)
                return connecting;
            if (state === 'reconnecting') {
                return new Promise((resolve, reject) => {
                    const off = stateEvents.on((next) => {
                        if (next === 'open') {
                            off();
                            resolve();
                        }
                        else if (next === 'closed') {
                            off();
                            reject(new HubSdkError('rt_closed', 'Realtime socket closed'));
                        }
                    });
                });
            }
            wanted = true;
            attempt = 0;
            setState('connecting');
            connecting = establish(false)
                .catch((error) => {
                socket = null;
                wanted = false;
                setState('closed', { reason: error instanceof Error ? error.message : String(error) });
                throw error instanceof HubSdkError ? error : new HubSdkError('rt_connect_failed', String(error));
            })
                .finally(() => {
                connecting = null;
            });
            return connecting;
        },
        disconnect() {
            wanted = false;
            if (reconnectTimer) {
                timers.clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            const ws = socket;
            socket = null;
            rejectPending('rt_closed');
            for (const entry of [...matches.values()])
                closeMatch(entry, 'left');
            for (const entry of [...channels.values()]) {
                entry.closed = true;
                entry.message.clear();
                entry.presence.clear();
            }
            channels.clear();
            matchmaker.clear();
            if (ws) {
                try {
                    ws.close(1000, 'client disconnect');
                }
                catch {
                    // Already closed.
                }
            }
            setState('closed', { code: 1000, reason: 'client disconnect' });
        },
        onState: (cb) => stateEvents.on(cb),
        async joinMatch(target, metadata) {
            await ensureOpen();
            const body = 'matchId' in target ? { match_id: target.matchId } : { token: target.token };
            if (metadata)
                body.metadata = metadata;
            const env = await joinRequest(body);
            const m = env.match ?? {};
            const matchId = m.match_id ?? ('matchId' in target ? target.matchId : '');
            const existing = matches.get(matchId);
            if (existing)
                closeMatch(existing, 'left');
            const me = presenceFromWire(m.self);
            if (me.sessionId)
                self = me;
            const entry = {
                matchId,
                label: labelFromWire(m.label),
                self: me,
                presences: (m.presences ?? []).map(presenceFromWire).filter((p) => !samePresence(p, me)),
                metadata,
                message: new Emitter(),
                early: takeOrphans(matchId),
                presence: new Emitter(),
                rejoin: new Emitter(),
                close: new Emitter(),
                closed: false,
            };
            matches.set(matchId, entry);
            return matchHandle(entry);
        },
        async listMatches(query) {
            const params = new URLSearchParams({ authoritative: 'true', limit: String(query?.limit ?? 100) });
            if (query?.label !== undefined)
                params.set('label', query.label);
            if (query?.query !== undefined)
                params.set('query', query.query);
            if (query?.minSize !== undefined)
                params.set('min_size', String(query.minSize));
            if (query?.maxSize !== undefined)
                params.set('max_size', String(query.maxSize));
            const body = await rest(`/v2/match?${params}`);
            return (body.matches ?? []).map((m) => ({
                matchId: m.match_id ?? '',
                size: typeof m.size === 'number' ? m.size : Number(m.size ?? 0),
                label: labelFromWire(m.label),
                authoritative: m.authoritative !== false,
            }));
        },
        async joinMatchByQuery(query) {
            const list = await api.listMatches(query);
            const max = query.maxSize;
            const open = list.filter((m) => max === undefined || m.size < max);
            if (!open.length)
                return null;
            open.sort((a, b) => (query.pick === 'fullest' ? b.size - a.size : a.size - b.size));
            return api.joinMatch({ matchId: open[0].matchId });
        },
        async joinViaRpc(rpcId, body, metadata) {
            const placed = await api.rpc(rpcId, body ?? {});
            const matchId = placed.matchId ?? placed.match_id;
            if (!matchId)
                throw new HubSdkError('match_not_found', `${rpcId} returned no matchId`);
            return api.joinMatch({ matchId }, metadata);
        },
        async addMatchmaker(req) {
            await ensureOpen();
            const env = await request({ matchmaker_add: matchmakerBody(req) });
            const ticket = env.matchmaker_ticket?.ticket ?? '';
            matchmaker.set(ticket, { original: ticket, current: ticket, request: { ...req } });
            return { ticket };
        },
        async removeMatchmaker(ticket) {
            const entry = matchmaker.get(ticket);
            matchmaker.delete(ticket);
            if (state !== 'open')
                return;
            await request({ matchmaker_remove: { ticket: entry?.current ?? ticket } });
        },
        onMatchmakerMatched: (cb) => matchedEvents.on(cb),
        async joinChat(target, opts) {
            await ensureOpen();
            const persistence = opts?.persistence ?? true;
            const hidden = opts?.hidden ?? false;
            const env = await request({ channel_join: channelJoinBody(target, persistence, hidden) });
            const c = env.channel ?? {};
            const id = c.id ?? '';
            if (c.self?.session_id)
                self = presenceFromWire(c.self);
            const existing = channels.get(id);
            if (existing)
                return channelHandle(existing);
            const entry = {
                id,
                target,
                persistence,
                hidden,
                presences: (c.presences ?? []).map(presenceFromWire),
                message: new Emitter(),
                presence: new Emitter(),
                closed: false,
            };
            channels.set(id, entry);
            return channelHandle(entry);
        },
        async rpc(id, body) {
            await ensureOpen();
            const env = await request({ rpc: { id, payload: JSON.stringify(body ?? {}) } });
            const raw = env.rpc?.payload ?? '';
            const parsed = (raw ? JSON.parse(raw) : {});
            if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string') {
                throw new HubSdkError(parsed.error, parsed.message || parsed.error);
            }
            return parsed;
        },
        onNotification: (cb) => notificationEvents.on(cb),
        onError: (cb) => errorEvents.on(cb),
        friends: createFriendsStub(),
    };
    return api;
}
/** null when the SDK has no live session (standalone / mock without session), so games keep running offline. */
export function realtimeFromSdk(sdk, options) {
    if (!sdk.getSession || !sdk.getSession())
        return null;
    return createRealtime({
        ...options,
        getToken: async () => {
            const s = sdk.getSession?.();
            if (!s)
                throw new HubSdkError('no_session', 'No hub session');
            if (s.expiresAt && s.expiresAt - Date.now() < 300_000 && sdk.refreshSession) {
                const fresh = await sdk.refreshSession();
                if (!fresh)
                    throw new HubSdkError('no_session', 'No hub session');
                return fresh.token;
            }
            return s.token;
        },
    });
}
