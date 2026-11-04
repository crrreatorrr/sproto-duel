// Chat content rules shared by the mock server and (re-implemented in ES5) the
// Nakama chat guard (server/modules/src/chat_guard.ts). A fixture test keeps
// the two in agreement.
export const CHAT_TEXT_MAX = 120;
export const CHAT_RAW_MAX_BYTES = 512;
export const CHAT_COLORS = ['yellow', 'red', 'green', 'cyan', 'purple', 'white', 'flash1', 'flash2', 'flash3', 'glow1', 'glow2', 'glow3'];
export const CHAT_EFFECTS = ['wave', 'wave2', 'shake', 'scroll', 'slide'];
/** Burst and refill of the per-user token bucket. Guests refill slower. */
export const CHAT_RATE = { burst: 5, refillMs: 1500, guestRefillMs: 3000, duplicateWindowMs: 30_000 };
// C0/C1 controls, zero-width and bidi controls, BOM.
const STRIP = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁯﻿]/g;
/** Normalised text: NFC, control and zero-width characters removed, whitespace collapsed, trimmed. */
export function normalizeChatText(text) {
    let out = text;
    try {
        out = out.normalize('NFC');
    }
    catch {
        // Older runtimes without normalize keep the raw text.
    }
    return out.replace(/[\t\n\r\f\v]/g, ' ').replace(STRIP, '').replace(/\s+/g, ' ').trim();
}
function byteLength(text) {
    let n = 0;
    for (let i = 0; i < text.length; i += 1) {
        const c = text.charCodeAt(i);
        if (c < 0x80)
            n += 1;
        else if (c < 0x800)
            n += 2;
        else if (c >= 0xd800 && c <= 0xdbff) {
            n += 4;
            i += 1;
        }
        else
            n += 3;
    }
    return n;
}
/**
 * Validate raw channel content (the JSON string Nakama carries). Unknown keys are
 * dropped, colour and effect must be on the allowlists (otherwise dropped), and the
 * text must be 1..120 characters after normalising.
 */
export function validateChatContent(raw) {
    if (typeof raw !== 'string' || byteLength(raw) > CHAT_RAW_MAX_BYTES)
        return { ok: false, code: 'chat_too_long' };
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return { ok: false, code: 'chat_bad_json' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return { ok: false, code: 'chat_bad_json' };
    const body = parsed;
    if (typeof body.text !== 'string')
        return { ok: false, code: 'chat_bad_json' };
    const text = normalizeChatText(body.text);
    if (!text)
        return { ok: false, code: 'chat_empty' };
    if (text.length > CHAT_TEXT_MAX)
        return { ok: false, code: 'chat_too_long' };
    const content = { text };
    if (typeof body.color === 'string' && CHAT_COLORS.includes(body.color))
        content.color = body.color;
    if (typeof body.effect === 'string' && CHAT_EFFECTS.includes(body.effect))
        content.effect = body.effect;
    return { ok: true, content };
}
/** Shared fixture: raw content → expected outcome (code, or the normalised text). */
export const CHAT_RULE_FIXTURES = [
    { raw: '{"text":"hello"}', expect: 'ok:hello' },
    { raw: '{"text":"  hi   there \\n you "}', expect: 'ok:hi there you' },
    { raw: '{"text":"a\\u200bb\\u0007c"}', expect: 'ok:abc' },
    { raw: '{"text":"   "}', expect: 'chat_empty' },
    { raw: '{"text":""}', expect: 'chat_empty' },
    { raw: `{"text":"${'x'.repeat(121)}"}`, expect: 'chat_too_long' },
    { raw: `{"text":"${'x'.repeat(120)}"}`, expect: `ok:${'x'.repeat(120)}` },
    { raw: `{"text":"${'x'.repeat(600)}"}`, expect: 'chat_too_long' },
    { raw: 'not json', expect: 'chat_bad_json' },
    { raw: '"just a string"', expect: 'chat_bad_json' },
    { raw: '[1,2]', expect: 'chat_bad_json' },
    { raw: '{"text":5}', expect: 'chat_bad_json' },
    { raw: '{"text":"e\\u0301"}', expect: 'ok:é' },
    { raw: '{"text":"hey","color":"red","effect":"wave","extra":1}', expect: 'ok:hey|red|wave' },
    { raw: '{"text":"hey","color":"blink","effect":"spin"}', expect: 'ok:hey' },
];
/** Outcome string in the fixture format. */
export function chatRuleOutcome(result) {
    if (!result.ok)
        return result.code;
    const parts = [result.content.text];
    if (result.content.color)
        parts.push(result.content.color);
    if (result.content.effect)
        parts.push(result.content.effect);
    return `ok:${parts.join('|')}`;
}
/** Token bucket stored as `"<tokens>:<lastMs>"` (localcache values must be scalars). */
export function takeChatToken(state, now, refillMs, burst = CHAT_RATE.burst) {
    let tokens = burst;
    let last = now;
    if (state) {
        const [t, l] = state.split(':');
        const pt = Number(t);
        const pl = Number(l);
        if (Number.isFinite(pt) && Number.isFinite(pl)) {
            tokens = Math.min(burst, pt + Math.max(0, now - pl) / refillMs);
            last = now;
        }
    }
    if (tokens < 1)
        return { allowed: false, state: `${tokens}:${last}` };
    return { allowed: true, state: `${tokens - 1}:${last}` };
}
