/**
 * Persistent outbox for live earn, relic, and exchange calls.
 * The server idempotency key is a UUIDv7 minted once when the row is created.
 * The row is committed before the RPC. Retries resend that same key.
 */
export type EconomyRpc = 'tickets.earn' | 'session.event' | 'tickets.exchange';
export interface OutboxPending {
    opId: string;
    idemKey: string;
    rpc: EconomyRpc;
    playerId: string;
    game: string;
    body: Record<string, unknown>;
    token: string;
    createdAt: number;
    lastError?: string;
}
export interface OutboxSettled {
    opId: string;
    idemKey: string;
    rpc: EconomyRpc;
    playerId: string;
    game: string;
    body: Record<string, unknown>;
    response: unknown;
}
export interface LiveOutbox {
    ready(): Promise<void>;
    list(playerId: string): OutboxPending[];
    all(): OutboxPending[];
    settled(opId: string): OutboxSettled | null;
    /** Insert the row if this operation is new. An existing row keeps its idemKey. */
    claim(draft: Omit<OutboxPending, 'idemKey'>): Promise<OutboxPending>;
    settle(row: OutboxPending, response: unknown): Promise<void>;
    markError(opId: string, code: string): Promise<void>;
}
export declare function uuidV7(now?: number): string;
export declare function sameBody(left: Record<string, unknown>, right: Record<string, unknown>): boolean;
export declare function createMemoryOutbox(): LiveOutbox;
export declare function createIndexedDbOutbox(): LiveOutbox;
export declare function defaultLiveOutbox(): LiveOutbox;
//# sourceMappingURL=outbox.d.ts.map