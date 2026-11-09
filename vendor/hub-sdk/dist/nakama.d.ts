/**
 * Local compose origin. Credentials are not embedded: the app passes `serverKey`
 * (dev builds inject the compose server key).
 */
export declare const LOCAL_NAKAMA: {
    readonly serverUrl: 'http://127.0.0.1:7350';
    readonly serverKey: '';
    readonly [extra: string]: string;
};
export interface NakamaRpcOptions {
    token?: string;
    keepalive?: boolean;
}
export interface CustomAuthResult {
    token: string;
    refreshToken: string;
    userId: string;
}
export interface NakamaClient {
    authenticateDevice(deviceId: string, vars?: Record<string, string>): Promise<{
        token: string;
        userId: string;
    }>;
    /**
     * Optional so existing test doubles that only stub `rpc` still typecheck.
     * `createNakamaClient` always implements it.
     */
    authenticateCustom?(id: string, create?: boolean, vars?: Record<string, string>): Promise<CustomAuthResult>;
    rpc<T>(id: string, body: object, opts?: NakamaRpcOptions): Promise<T>;
    /** POST /v2/account/session/refresh with the server key. Optional so older doubles still typecheck. */
    sessionRefresh?(refreshToken: string): Promise<{
        token: string;
        refreshToken: string;
    }>;
}
export interface NakamaClientOptions {
    serverUrl: string;
    serverKey?: string;
    fetchImpl?: typeof fetch;
    /** Ignored. The client sends the server key only. */
    [extra: string]: unknown;
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
    /** Present on a game session minted by ticket custom-auth. */
    effects?: Record<string, number | boolean | string>;
    ranked?: boolean;
    /** Nakama server clock, epoch milliseconds. */
    serverTime?: number;
    /** Hub pets. Sent once `profile.get` is wired to `HubPets.profilePets` (docs/m6-server-prep.md). */
    pets?: {
        owned: string[];
        active: string | null;
    };
    /** Owned item union. Present once the server ships hub gates. Not a list of missing items. */
    items?: string[];
    /**
     * Enabled hub gates with an unlocked bool. No missing-item list and no required item ids.
     * `target` is an allowlisted realm id or session/zone key, never a URL.
     */
    gates?: {
        gateId: string;
        unlocked: boolean;
        actionType: string;
        target: string | null;
        lockedHintPool: string | null;
    }[];
}
export interface PortalEnterResult {
    ticket: string;
    sessionId: string;
    expiresAt: number;
    /** Nakama server clock, epoch milliseconds. */
    serverTime: number;
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
    /** Nakama server clock, epoch milliseconds. */
    serverTime: number;
}
export interface RecoveryCodeResult {
    code: string;
}
export interface RecoveryRedeemResult {
    restored: boolean;
    userId: string;
    token: string;
}
/** Session vars Nakama stores under `vrs` (scope, game, sid, ranked). */
export declare function sessionVarsFromToken(token: string): Record<string, string>;
/** JWT `exp` in epoch ms, or 0 when the token has none. */
export declare function tokenExpiryMs(token: string): number;
export declare function userIdFromToken(token: string): string;
export declare function createNakamaClient(options: NakamaClientOptions): NakamaClient;
