/** Game ids stored on the server and used in `/hub#from=<game>` and `play/<game>`. */
export declare const GAME_IDS: readonly ["hpos10i", "nobu", "peoples-bitcoin", "sproto"];
export type GameId = (typeof GAME_IDS)[number];
/** Earn-once relics. The primary key on the server is (user, relic). */
export declare const RELIC_IDS: readonly ["hpos10i_core", "genesis_shard", "cones_tip", "tinubu_crown"];
export type RelicId = (typeof RELIC_IDS)[number];
export declare const RELIC_BY_GAME: Record<GameId, RelicId>;
/**
 * Nakama leaderboard ids. Sort direction matches the architecture:
 * times are ascending best, XP and meta are set, Sproto wins increment.
 */
export declare const BoardId: {
    readonly Hpos10iActTime: "hpos10i_act_time";
    readonly NobuTrialTime: "nobu_trial_time";
    readonly PbTotalXp: "pb_total_xp";
    readonly SprotoWins: "sproto_wins";
    readonly Meta: "meta";
};
export type BoardId = (typeof BoardId)[keyof typeof BoardId];
export declare const BOARD_IDS: readonly BoardId[];
/** 10 Tickets = 1 Verse. At most 50 Verse per game per day. */
export declare const TICKETS_PER_VERSE = 10;
export declare const VERSE_DAILY_CAP = 50;
/** Mock-only daily earn cap. The real per-event caps arrive with the Go module. */
export declare const MOCK_TICKET_EARN_CAP = 1000;
/** Portal tickets are single-use and short-lived. */
export declare const MOCK_TICKET_TTL_SECONDS = 60;
export interface InitResult {
    playerId: string;
    ranked: boolean;
    relics: RelicId[];
    /** Resolved effects for this game only. Empty until the server ships the matrix. */
    effects: Record<string, number | boolean | string>;
    ticketsCapLeft: number;
    /** Nakama server clock at this response, epoch milliseconds. */
    serverTime: number;
}
export interface EarnResult {
    balance: number;
    capped: boolean;
}
export interface ExchangeResult {
    /** Verse wallet balance after the exchange. */
    verse: number;
    ticketsLeft: number;
    /** Ticket wallet after the exchange. Same number as ticketsLeft. */
    balance: number;
    receiptId: string;
    /** Verse this game can still earn today. Omitted by older servers. */
    verseCapLeft?: number;
}
export interface SpendResult {
    shop_id: string;
    item_id: string;
    packs: number;
    units: number;
    spent: number;
    balance: number;
}
export interface SellResult {
    shop_id: string;
    item_id: string;
    packs: number;
    units: number;
    credited: number;
    balance: number;
}
export interface TicketBalanceResult {
    balance: number;
    /** Tickets this session can still credit before `session_ticket_cap`. */
    sessionCapLeft: number;
    /** Tickets this game can still credit today before `daily_ticket_cap`. */
    dailyCapLeft: number;
    /** Nakama server clock at this response, epoch milliseconds. */
    serverTime: number;
}
export interface EventResult {
    granted?: RelicId;
}
/** Nakama session from `redeemTicket`. The HTTP key is not involved. */
export interface RedeemedSession {
    token: string;
    refreshToken: string;
}
/**
 * Surface the games call. Outside a redeemed ticket the methods no-op so a
 * game still runs standalone. HPOS10I reaches the same object through
 * `JavaScriptBridge.get_interface("hubSdk")` once `installHubSdk` has run.
 */
export interface HubSdk {
    /**
     * Read `#t=` from the page hash, strip it immediately, and exchange it for a
     * Nakama session using the server key only (`authenticateCustom`, create=false).
     */
    redeemTicket(input: {
        game: GameId;
    }): Promise<RedeemedSession>;
    init(gameId: GameId): Promise<InitResult>;
    reportEvent(eventId: string, data: object, key: string): Promise<EventResult>;
    submitScore(boardId: string, value: number, meta?: object): Promise<void>;
    earnTickets(amount: number, reason: string, key: string): Promise<EarnResult>;
    exchange(tickets: number, key: string): Promise<ExchangeResult>;
    /** Buy `packs` from `shopId` at the server price per pack. The caller mints `key` once. */
    spendTickets(shopId: string, itemId: string, packs: number, key: string): Promise<SpendResult>;
    /** Sell `packs` back to `shopId` at the server sell price per pack. The caller mints `key` once. */
    sellItem(shopId: string, itemId: string, packs: number, key: string): Promise<SellResult>;
    getTicketBalance(): Promise<TicketBalanceResult>;
    exit(reason?: string): void;
}
export declare function isGameId(value: string): value is GameId;
/** True when `value` is a stored game id. */
export declare function canonicalGameId(value: string): GameId | null;
export declare function isRelicId(value: string): value is RelicId;
export declare function isBoardId(value: string): value is BoardId;
declare global {
    interface Window {
        hubSdk?: HubSdk;
    }
}
