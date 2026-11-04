// Nakama realtime JSON envelopes (snake_case, int64 as strings, binary as base64).
// Only the fields this SDK reads or writes are typed.
import { HubSdkError } from '../errors';
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();
export function utf8Encode(text) {
    return utf8Encoder.encode(text);
}
export function utf8Decode(bytes) {
    return utf8Decoder.decode(bytes);
}
export function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}
export function base64ToBytes(text) {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1)
        out[i] = binary.charCodeAt(i);
    return out;
}
/** object → JSON text, string → UTF-8, Uint8Array as is. */
export function encodePayload(data) {
    if (data === undefined)
        return new Uint8Array(0);
    if (data instanceof Uint8Array)
        return data;
    if (typeof data === 'string')
        return utf8Encode(data);
    return utf8Encode(JSON.stringify(data));
}
export function presenceFromWire(p) {
    return { userId: p?.user_id ?? '', sessionId: p?.session_id ?? '', username: p?.username ?? '' };
}
export function presenceToWire(p) {
    return { user_id: p.userId, session_id: p.sessionId, username: p.username };
}
export function matchmakerUserFromWire(u) {
    return {
        presence: presenceFromWire(u?.presence),
        stringProperties: { ...(u?.string_properties ?? {}) },
        numericProperties: { ...(u?.numeric_properties ?? {}) },
    };
}
export function labelFromWire(label) {
    if (label === null || label === undefined)
        return null;
    if (typeof label === 'string')
        return label;
    return typeof label.value === 'string' ? label.value : null;
}
export function opCodeFromWire(op) {
    const n = typeof op === 'number' ? op : Number(op ?? 0);
    return Number.isFinite(n) ? n : 0;
}
export function timeFromWire(value) {
    if (typeof value === 'number')
        return value;
    if (!value)
        return 0;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
}
/** Nakama channel types: 1 room, 2 direct message, 3 group. */
export function channelJoinBody(target, persistence, hidden) {
    if ('room' in target)
        return { target: target.room, type: 1, persistence, hidden };
    if ('direct' in target)
        return { target: target.direct, type: 2, persistence, hidden };
    return { target: target.group, type: 3, persistence, hidden };
}
export function chatContentFromWire(raw) {
    if (!raw)
        return { text: '' };
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const obj = parsed;
            return { ...obj, text: typeof obj.text === 'string' ? obj.text : '' };
        }
        return { text: typeof parsed === 'string' ? parsed : String(parsed) };
    }
    catch {
        return { text: raw };
    }
}
export function chatMessageFromWire(m) {
    return {
        channelId: m.channel_id ?? '',
        messageId: m.message_id ?? '',
        senderId: m.sender_id ?? '',
        username: m.username ?? '',
        content: chatContentFromWire(m.content),
        createdAt: timeFromWire(m.create_time),
        persistent: m.persistent === true,
    };
}
/**
 * Server-thrown hook errors look like `Error: room_not_allowed at rtBeforeChannelJoin (index.js:37:199(22))`.
 * The code is the first `[a-z0-9_:.-]+` token after an optional `Error: ` prefix.
 */
export function errorCodeFromMessage(message, fallback) {
    if (!message)
        return fallback;
    const stripped = message.replace(/^\s*(?:Error:\s*)?/, '');
    const match = /^[a-z0-9_:.-]+/.exec(stripped);
    return match ? match[0] : fallback;
}
/** Nakama realtime error codes (rtapi.Error.Code). */
export const RT_ERROR = {
    RUNTIME_EXCEPTION: 0,
    UNRECOGNIZED_PAYLOAD: 1,
    MISSING_PAYLOAD: 2,
    BAD_INPUT: 3,
    MATCH_NOT_FOUND: 4,
    MATCH_JOIN_REJECTED: 5,
    RUNTIME_FUNCTION_NOT_FOUND: 6,
    RUNTIME_FUNCTION_EXCEPTION: 7,
};
export function errorFromEnvelope(error, kind = 'other') {
    const message = error.message ?? '';
    if (error.code === RT_ERROR.MATCH_NOT_FOUND)
        return new HubSdkError('match_not_found', message || 'Match not found');
    if (error.code === RT_ERROR.MATCH_JOIN_REJECTED || (kind === 'match_join' && error.code !== RT_ERROR.RUNTIME_EXCEPTION)) {
        const reason = errorCodeFromMessage(message, 'rejected');
        return new HubSdkError(`match_rejected:${reason}`, message || 'Match join rejected');
    }
    return new HubSdkError(errorCodeFromMessage(message, 'rt_error'), message || 'Realtime error');
}
