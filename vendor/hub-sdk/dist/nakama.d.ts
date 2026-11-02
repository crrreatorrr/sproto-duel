/** Local Nakama origin. This client never embeds a server credential. */
export declare const LOCAL_NAKAMA: {
    readonly serverUrl: "http://127.0.0.1:7350";
};
export interface NakamaRpcOptions {
    /** Session token from custom auth. The only credential an RPC sends. */
    token?: string;
    keepalive?: boolean;
}
export interface NakamaClient {
    authenticateDevice(deviceId: string, vars?: Record<string, string>): Promise<{
        token: string;
        userId: string;
    }>;
    /**
     * Redeem a portal ticket (`id` is `t:` + ticket, `create` is false).
     * Returns the session token used for every later call.
     */
    authenticateCustom(id: string, create?: boolean, vars?: Record<string, string>): Promise<{
        token: string;
        userId: string;
    }>;
    rpc<T>(id: string, body: object, opts?: NakamaRpcOptions): Promise<T>;
}
export interface NakamaClientOptions {
    serverUrl: string;
    fetchImpl?: typeof fetch;
}
export interface ProfileResult {
    playerId: string;
    relics: string[];
    gameBeaten: string[];
    scope: string;
    verse?: number;
    verseEarned?: {
        gameId: string;
        lifetime: number;
    }[];
    /** Remaining Tickets this game can still earn today. Present on a game session. */
    ticketsCapLeft?: number;
}
export interface PortalEnterResult {
    ticket: string;
    sessionId: string;
    expiresAt: number;
}
export interface RedeemResult {
    token: string;
    playerId: string;
    ranked: boolean;
    sid: string;
    relics: string[];
    effects: Record<string, number | boolean | string>;
    ticketsCapLeft: number;
    gameBeaten: string[];
}
export interface RecoveryCodeResult {
    code: string;
}
export interface RecoveryRedeemResult {
    restored: boolean;
    userId: string;
    token: string;
}
export declare function userIdFromToken(token: string): string;
export declare function createNakamaClient(options: NakamaClientOptions): NakamaClient;
