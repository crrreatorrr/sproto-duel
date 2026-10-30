import { isGameId, MOCK_TICKET_TTL_SECONDS } from './types';
/**
 * Dev-only HMAC key. M0 tickets are shaped like the real fragment (`#t=`)
 * but are not a credential. M1 replaces this with `portal.enter`.
 */
export const MOCK_TICKET_KEY = 'metaverse-hub-m0-mock-ticket-key';
const ISSUER = 'hub-mock';
export function bytesToBase64Url(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1)
        binary += String.fromCharCode(bytes[i] ?? 0);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
export function base64UrlToBytes(value) {
    const pad = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1)
        bytes[i] = binary.charCodeAt(i);
    return bytes;
}
async function hmac(payload) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(MOCK_TICKET_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    return bytesToBase64Url(new Uint8Array(sig));
}
export async function mintMockTicket(options) {
    const now = options.now ?? Date.now();
    const claims = {
        jti: options.jti ?? crypto.randomUUID(),
        game: options.game,
        ranked: options.ranked ?? false,
        iat: Math.floor(now / 1000),
        exp: Math.floor(now / 1000) + (options.ttlSeconds ?? MOCK_TICKET_TTL_SECONDS),
        iss: ISSUER,
        playerId: options.playerId,
    };
    const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
    const sig = await hmac(payload);
    return `${payload}.${sig}`;
}
export async function verifyMockTicket(token) {
    const parts = token.split('.');
    if (parts.length !== 2)
        return null;
    const payload = parts[0];
    const sig = parts[1];
    if (!payload || !sig)
        return null;
    const expected = await hmac(payload);
    if (expected !== sig)
        return null;
    try {
        const json = new TextDecoder().decode(base64UrlToBytes(payload));
        const claims = JSON.parse(json);
        if (claims.iss !== ISSUER)
            return null;
        if (typeof claims.jti !== 'string' || typeof claims.playerId !== 'string')
            return null;
        if (typeof claims.game !== 'string' || !isGameId(claims.game))
            return null;
        if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number')
            return null;
        if (typeof claims.ranked !== 'boolean')
            return null;
        return claims;
    }
    catch {
        return null;
    }
}
export function readTicketParam(hash) {
    const raw = hash.startsWith('#') ? hash.slice(1) : hash;
    if (!raw)
        return null;
    return new URLSearchParams(raw).get('t');
}
export function stripTicketParam(hash) {
    const raw = hash.startsWith('#') ? hash.slice(1) : hash;
    const params = new URLSearchParams(raw);
    params.delete('t');
    const next = params.toString();
    return next ? `#${next}` : '';
}
