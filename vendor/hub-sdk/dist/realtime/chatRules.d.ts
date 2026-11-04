export declare const CHAT_TEXT_MAX = 120;
export declare const CHAT_RAW_MAX_BYTES = 512;
export declare const CHAT_COLORS: readonly ["yellow", "red", "green", "cyan", "purple", "white", "flash1", "flash2", "flash3", "glow1", "glow2", "glow3"];
export declare const CHAT_EFFECTS: readonly ["wave", "wave2", "shake", "scroll", "slide"];
/** Burst and refill of the per-user token bucket. Guests refill slower. */
export declare const CHAT_RATE: {
    readonly burst: 5;
    readonly refillMs: 1500;
    readonly guestRefillMs: 3000;
    readonly duplicateWindowMs: 30000;
};
export type ChatRuleResult = {
    ok: true;
    content: {
        text: string;
        color?: string;
        effect?: string;
    };
} | {
    ok: false;
    code: 'chat_rejected' | 'chat_empty' | 'chat_too_long' | 'chat_bad_json';
};
/** Normalised text: NFC, control and zero-width characters removed, whitespace collapsed, trimmed. */
export declare function normalizeChatText(text: string): string;
/**
 * Validate raw channel content (the JSON string Nakama carries). Unknown keys are
 * dropped, colour and effect must be on the allowlists (otherwise dropped), and the
 * text must be 1..120 characters after normalising.
 */
export declare function validateChatContent(raw: string): ChatRuleResult;
/** Shared fixture: raw content → expected outcome (code, or the normalised text). */
export declare const CHAT_RULE_FIXTURES: readonly {
    raw: string;
    expect: string;
}[];
/** Outcome string in the fixture format. */
export declare function chatRuleOutcome(result: ChatRuleResult): string;
/** Token bucket stored as `"<tokens>:<lastMs>"` (localcache values must be scalars). */
export declare function takeChatToken(state: string | null, now: number, refillMs: number, burst?: number): {
    allowed: boolean;
    state: string;
};
