import { HubSdkError } from './errors';
import { base64UrlToBytes } from './ticket';
/** Local Nakama origin. This client never embeds a server credential. */
export const LOCAL_NAKAMA = {
    serverUrl: 'http://127.0.0.1:7350',
};
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
    const fetchImpl = options.fetchImpl ?? fetch;
    async function postJson(url, body) {
        const response = await fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const text = await response.text();
        if (!response.ok)
            throw new HubSdkError('auth_failed', text || `HTTP ${response.status}`);
        const parsed = text ? JSON.parse(text) : {};
        if (!parsed.token)
            throw new HubSdkError('auth_failed', 'Auth did not return a session token');
        return { token: parsed.token, userId: userIdFromToken(parsed.token) };
    }
    return {
        async authenticateDevice(deviceId, vars) {
            return postJson(`${serverUrl}/v2/account/authenticate/device?create=true`, vars ? { id: deviceId, vars } : { id: deviceId });
        },
        /**
         * Exchange a portal ticket for a Nakama session.
         * The body is the custom id (`t:` + ticket). No server credential is sent.
         * Callers then authorize every RPC with the returned session token.
         */
        async authenticateCustom(id, create = false, vars) {
            const params = new URLSearchParams({ create: create ? 'true' : 'false' });
            return postJson(`${serverUrl}/v2/account/authenticate/custom?${params}`, vars ? { id, vars } : { id });
        },
        async rpc(id, body, opts) {
            if (!opts?.token)
                throw new HubSdkError('unauthorized', 'Missing session');
            const params = new URLSearchParams({ unwrap: 'true' });
            const response = await fetchImpl(`${serverUrl}/v2/rpc/${encodeURIComponent(id)}?${params}`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${opts.token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
                keepalive: opts?.keepalive,
            });
            const text = await response.text();
            if (!response.ok)
                throw new HubSdkError('rpc_failed', text || `HTTP ${response.status}`, response.status);
            const parsed = (text ? JSON.parse(text) : {});
            if (parsed.error)
                throw new HubSdkError(parsed.error, parsed.message || parsed.error);
            return parsed;
        },
    };
}
