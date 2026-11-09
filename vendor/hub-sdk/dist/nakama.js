import { HubSdkError } from './errors';
import { base64UrlToBytes } from './ticket';
/**
 * Local compose origin. Credentials are not embedded: the app passes `serverKey`
 * (dev builds inject the compose server key).
 */
export const LOCAL_NAKAMA = {
    serverUrl: 'http://127.0.0.1:7350',
    serverKey: '',
};
/** Session vars Nakama stores under `vrs` (scope, game, sid, ranked). */
export function sessionVarsFromToken(token) {
    const part = token.split('.')[1];
    if (!part)
        return {};
    try {
        const json = JSON.parse(new TextDecoder().decode(base64UrlToBytes(part)));
        if (!json.vrs || typeof json.vrs !== 'object' || Array.isArray(json.vrs))
            return {};
        const out = {};
        for (const [key, value] of Object.entries(json.vrs)) {
            if (typeof value === 'string')
                out[key] = value;
        }
        return out;
    }
    catch {
        return {};
    }
}
/** JWT `exp` in epoch ms, or 0 when the token has none. */
export function tokenExpiryMs(token) {
    const part = token.split('.')[1];
    if (!part)
        return 0;
    try {
        const json = JSON.parse(new TextDecoder().decode(base64UrlToBytes(part)));
        return typeof json.exp === 'number' && Number.isFinite(json.exp) ? json.exp * 1000 : 0;
    }
    catch {
        return 0;
    }
}
export function userIdFromToken(token) {
    const part = token.split('.')[1];
    if (!part)
        throw new HubSdkError('bad_token', 'Session token is missing a payload');
    try {
        const json = JSON.parse(new TextDecoder().decode(base64UrlToBytes(part)));
        if (!json.uid)
            throw new HubSdkError('bad_token', 'Session token has no user id');
        return json.uid;
    }
    catch (error) {
        if (error instanceof HubSdkError)
            throw error;
        throw new HubSdkError('bad_token', 'Session token payload is not valid');
    }
}
export function createNakamaClient(options) {
    const serverUrl = options.serverUrl.replace(/\/$/, '');
    const serverKey = options.serverKey ?? LOCAL_NAKAMA.serverKey;
    const fetchImpl = options.fetchImpl ?? fetch;
    async function postAuth(path, body) {
        const response = await fetchImpl(`${serverUrl}${path}`, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${btoa(`${serverKey}:`)}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        const text = await response.text();
        if (!response.ok)
            throw new HubSdkError('auth_failed', text || `HTTP ${response.status}`, response.status);
        const parsed = JSON.parse(text);
        if (!parsed.token)
            throw new HubSdkError('auth_failed', 'Auth did not return a token');
        return {
            token: parsed.token,
            refreshToken: parsed.refreshToken || parsed.refresh_token || '',
            userId: userIdFromToken(parsed.token),
        };
    }
    return {
        async authenticateDevice(deviceId, vars) {
            const auth = await postAuth('/v2/account/authenticate/device?create=true', vars ? { id: deviceId, vars } : { id: deviceId });
            return { token: auth.token, userId: auth.userId };
        },
        async authenticateCustom(id, create = false, vars) {
            const params = new URLSearchParams({ create: create ? 'true' : 'false' });
            // Nakama maps this route with body: "account", so the JSON body is the account itself.
            const body = vars ? { id, vars } : { id };
            const auth = await postAuth(`/v2/account/authenticate/custom?${params}`, body);
            if (!auth.refreshToken)
                throw new HubSdkError('auth_failed', 'Auth did not return a refresh token');
            return auth;
        },
        async sessionRefresh(refreshToken) {
            const auth = await postAuth('/v2/account/session/refresh', { token: refreshToken });
            return { token: auth.token, refreshToken: auth.refreshToken || refreshToken };
        },
        async rpc(id, body, opts) {
            const params = new URLSearchParams({ unwrap: 'true' });
            const headers = { 'Content-Type': 'application/json' };
            if (!opts?.token)
                throw new HubSdkError('unauthorized', 'Missing session');
            headers.Authorization = `Bearer ${opts.token}`;
            const response = await fetchImpl(`${serverUrl}/v2/rpc/${encodeURIComponent(id)}?${params}`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                keepalive: opts?.keepalive,
            });
            const text = await response.text();
            if (!response.ok)
                throw new HubSdkError('rpc_failed', text || `HTTP ${response.status}`, response.status);
            const parsed = (text ? JSON.parse(text) : {});
            if (parsed.error) {
                const num = (value) => (typeof value === 'number' ? value : undefined);
                const sessionCapLeft = num(parsed.sessionCapLeft);
                const dailyCapLeft = num(parsed.dailyCapLeft);
                const capLeft = num(parsed.capLeft) ?? sessionCapLeft ?? dailyCapLeft;
                throw new HubSdkError(parsed.error, parsed.message || parsed.error, undefined, capLeft, sessionCapLeft, dailyCapLeft);
            }
            return parsed;
        },
    };
}
