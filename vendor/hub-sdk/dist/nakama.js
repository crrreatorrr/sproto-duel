import { HubSdkError } from './errors';
import { base64UrlToBytes } from './ticket';
/** Local compose defaults. The HTTP key is a dev credential used only to exchange a portal ticket. */
export const LOCAL_NAKAMA = {
    serverUrl: 'http://127.0.0.1:7350',
    serverKey: 'defaultkey',
    httpKey: 'localhttpkey',
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
    const serverKey = options.serverKey ?? LOCAL_NAKAMA.serverKey;
    const httpKey = options.httpKey ?? LOCAL_NAKAMA.httpKey;
    const fetchImpl = options.fetchImpl ?? fetch;
    return {
        async authenticateDevice(deviceId, vars) {
            const response = await fetchImpl(`${serverUrl}/v2/account/authenticate/device?create=true`, {
                method: 'POST',
                headers: {
                    Authorization: `Basic ${btoa(`${serverKey}:`)}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(vars ? { id: deviceId, vars } : { id: deviceId }),
            });
            const text = await response.text();
            if (!response.ok)
                throw new HubSdkError('auth_failed', text || `HTTP ${response.status}`);
            const body = JSON.parse(text);
            if (!body.token)
                throw new HubSdkError('auth_failed', 'Device auth did not return a token');
            return { token: body.token, userId: userIdFromToken(body.token) };
        },
        async rpc(id, body, opts) {
            const params = new URLSearchParams({ unwrap: 'true' });
            const headers = { 'Content-Type': 'application/json' };
            if (opts?.token)
                headers.Authorization = `Bearer ${opts.token}`;
            else if (opts?.httpKey)
                params.set('http_key', httpKey);
            else
                throw new HubSdkError('unauthorized', 'Missing session');
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
            if (parsed.error)
                throw new HubSdkError(parsed.error, parsed.message || parsed.error);
            return parsed;
        },
    };
}
//# sourceMappingURL=nakama.js.map