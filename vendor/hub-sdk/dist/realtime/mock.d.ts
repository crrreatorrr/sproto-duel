import type { HubRealtime, MatchListing, MatchmakerRequest, RealtimePresence } from './types';
export interface MockMatchDispatcher {
    broadcast(opCode: number, data: string | Uint8Array | object, to?: readonly RealtimePresence[] | null, sender?: RealtimePresence | null): void;
    kick(presences: readonly RealtimePresence[]): void;
    setLabel(label: string): void;
    end(): void;
}
export interface MockMatchHandler<S = unknown> {
    init(params: Record<string, string>): {
        state: S;
        label?: string;
    };
    joinAttempt?(state: S, presence: RealtimePresence, metadata: Record<string, string>): {
        accept: boolean;
        reason?: string;
    };
    join?(state: S, presences: RealtimePresence[], d: MockMatchDispatcher): void;
    leave?(state: S, presences: RealtimePresence[], d: MockMatchDispatcher): void;
    loop?(state: S, messages: {
        sender: RealtimePresence;
        opCode: number;
        data: Uint8Array;
    }[], d: MockMatchDispatcher, tick: number): void;
}
export interface MockMatchmakerEntry {
    ticket: string;
    presence: RealtimePresence;
    request: MatchmakerRequest;
}
export interface MockRealtimeServer {
    /** A client for this user; connect() resolves immediately. */
    connect(user: {
        userId: string;
        username?: string;
    }): HubRealtime;
    registerMatch<S>(name: string, handler: MockMatchHandler<S>): void;
    /** No name = relay match (messages fan out to other presences). Returns matchId. */
    createMatch(name?: string, params?: Record<string, string>): string;
    /** Default: groups tickets with equal stringProperties.game into minCount and creates a relay match. Return a matchId to use an authoritative one. */
    onMatchmakerMatched(fn: (entries: MockMatchmakerEntry[]) => string | null | void): void;
    registerRpc(id: string, fn: (ctx: {
        userId: string;
    }, body: unknown) => unknown): void;
    /** Rooms accepted by joinChat; default all. Mirrors the server allowlist. */
    allowRooms(pattern: RegExp): void;
    /** Runs loop() of authoritative mock matches. */
    tick(count?: number): void;
    /** Resolves when all queued deliveries ran (delivery is async via microtasks). */
    flush(): Promise<void>;
    /** Simulate a dropped socket; the client goes reconnecting → open and re-joins. */
    drop(userId: string): void;
    matchesByLabel(query?: (label: string | null) => boolean): MatchListing[];
}
/** `+label.kind:hub +label.open:T +label.players:<90` against a JSON label. Terms without `+` are ignored. */
export declare function mockLabelMatches(label: string | null, query: string): boolean;
export declare function createMockRealtimeServer(options?: {
    now?: () => number;
}): MockRealtimeServer;
