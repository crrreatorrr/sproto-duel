import type { HubSdkError } from '../errors';
export type Unsubscribe = () => void;
export type RealtimeState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
export interface RealtimePresence {
    userId: string;
    sessionId: string;
    username: string;
}
export interface RealtimeOptions {
    /** Nakama HTTP origin; '' or omitted = same origin (ws(s)://<host>/ws). */
    serverUrl?: string;
    /** Called before every connect and reconnect; return a valid (refreshed) session token. */
    getToken: () => string | Promise<string>;
    /** Default { maxAttempts: Infinity, baseDelayMs: 500, maxDelayMs: 15000 }, full jitter. false = never reconnect. */
    reconnect?: false | {
        maxAttempts?: number;
        baseDelayMs?: number;
        maxDelayMs?: number;
    };
    /** Nakama status presence (friends see you online). Default false. */
    appearOnline?: boolean;
    /** Per-request timeout for cid-correlated calls. Default 10000. */
    requestTimeoutMs?: number;
    WebSocketImpl?: new (url: string) => WebSocket;
    fetchImpl?: typeof fetch;
    timers?: {
        setTimeout: typeof setTimeout;
        clearTimeout: typeof clearTimeout;
    };
}
export interface MatchQuery {
    /** Nakama label query, e.g. '+label.kind:pb_world +label.open:T'. */
    query?: string;
    label?: string;
    minSize?: number;
    maxSize?: number;
    limit?: number;
}
export interface MatchListing {
    matchId: string;
    size: number;
    label: string | null;
    authoritative: boolean;
}
export interface MatchData {
    matchId: string;
    opCode: number;
    data: Uint8Array;
    sender: RealtimePresence | null;
    reliable: boolean;
    text(): string;
    json<T = unknown>(): T;
}
export type MatchCloseReason = 'left' | 'kicked' | 'ended' | 'rejoin_failed';
export interface MatchHandle {
    readonly matchId: string;
    readonly label: string | null;
    readonly self: RealtimePresence;
    /** Other presences, kept current. */
    readonly presences: readonly RealtimePresence[];
    /** object → JSON text, string → UTF-8, Uint8Array as is. `to` omitted = whole match (server decides for authoritative matches). */
    send(opCode: number, data?: string | Uint8Array | object, opts?: {
        to?: readonly RealtimePresence[];
        reliable?: boolean;
    }): void;
    onMessage(cb: (msg: MatchData) => void): Unsubscribe;
    onPresence(cb: (event: {
        joins: RealtimePresence[];
        leaves: RealtimePresence[];
    }) => void): Unsubscribe;
    /** Fired after a reconnect when re-joining this matchId succeeded; ask the server for a resync. */
    onRejoin(cb: () => void): Unsubscribe;
    onClose(cb: (reason: MatchCloseReason) => void): Unsubscribe;
    leave(): Promise<void>;
}
export interface MatchmakerRequest {
    query: string;
    minCount: number;
    maxCount: number;
    countMultiple?: number;
    stringProperties?: Record<string, string>;
    numericProperties?: Record<string, number>;
}
export interface MatchmakerUser {
    presence: RealtimePresence;
    stringProperties: Record<string, string>;
    numericProperties: Record<string, number>;
}
export interface MatchmakerMatched {
    ticket: string;
    matchId: string | null;
    token: string | null;
    self: MatchmakerUser;
    users: MatchmakerUser[];
}
export type ChatTarget = {
    room: string;
} | {
    direct: string;
} | {
    group: string;
};
export interface ChatContent {
    text: string;
    color?: string;
    effect?: string;
    [extra: string]: unknown;
}
export interface ChatMessage {
    channelId: string;
    messageId: string;
    senderId: string;
    username: string;
    content: ChatContent;
    createdAt: number;
    persistent: boolean;
}
export interface ChatChannel {
    readonly id: string;
    readonly target: ChatTarget;
    readonly presences: readonly RealtimePresence[];
    send(content: ChatContent | string): Promise<{
        messageId: string;
    }>;
    /** Newest first. cursor null = no more. */
    history(opts?: {
        limit?: number;
        cursor?: string | null;
    }): Promise<{
        messages: ChatMessage[];
        cursor: string | null;
    }>;
    onMessage(cb: (msg: ChatMessage) => void): Unsubscribe;
    onPresence(cb: (event: {
        joins: RealtimePresence[];
        leaves: RealtimePresence[];
    }) => void): Unsubscribe;
    leave(): Promise<void>;
}
export interface RealtimeNotification {
    id: string;
    subject: string;
    code: number;
    content: unknown;
    senderId: string;
    persistent: boolean;
    createdAt: number;
}
export type FriendState = 0 | 1 | 2 | 3;
export interface Friend {
    userId: string;
    username: string;
    online: boolean;
    state: FriendState;
}
export interface HubFriends {
    list(state?: FriendState): Promise<Friend[]>;
    add(target: {
        userId?: string;
        username?: string;
    }): Promise<void>;
    remove(userId: string): Promise<void>;
    block(userId: string): Promise<void>;
}
export interface HubRealtime {
    readonly state: RealtimeState;
    /** Set once connected; sessionId changes after a reconnect. */
    readonly self: RealtimePresence | null;
    connect(): Promise<void>;
    /** Close for good: no reconnect; matches/channels close with 'left'. */
    disconnect(): void;
    onState(cb: (state: RealtimeState, info: {
        attempt: number;
        code?: number;
        reason?: string;
    }) => void): Unsubscribe;
    joinMatch(target: {
        matchId: string;
    } | {
        token: string;
    }, metadata?: Record<string, string>): Promise<MatchHandle>;
    listMatches(query?: MatchQuery): Promise<MatchListing[]>;
    /** Lists by query and joins the least-full (or fullest) listing below maxSize; null when none. */
    joinMatchByQuery(query: MatchQuery & {
        pick?: 'emptiest' | 'fullest';
    }): Promise<MatchHandle | null>;
    /** Server-side placement: RPC returns { matchId } (e.g. hub.join); then joins it. Preferred for sharded worlds. */
    joinViaRpc(rpcId: string, body?: object, metadata?: Record<string, string>): Promise<MatchHandle>;
    addMatchmaker(req: MatchmakerRequest): Promise<{
        ticket: string;
    }>;
    removeMatchmaker(ticket: string): Promise<void>;
    onMatchmakerMatched(cb: (matched: MatchmakerMatched) => void): Unsubscribe;
    joinChat(target: ChatTarget, opts?: {
        persistence?: boolean;
        hidden?: boolean;
    }): Promise<ChatChannel>;
    /** RPC over the socket with this session (game-registered RPCs). Throws HubSdkError on { error }. */
    rpc<T = unknown>(id: string, body?: object): Promise<T>;
    onNotification(cb: (n: RealtimeNotification) => void): Unsubscribe;
    onError(cb: (error: HubSdkError) => void): Unsubscribe;
    readonly friends: HubFriends;
}
