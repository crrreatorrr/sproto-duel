import {
  createNakamaClient,
  createRealtime,
  getOrCreateDeviceId,
  tokenExpiryMs,
  type HubRealtime,
  type NakamaClient,
} from '@metaverse/hub-sdk';

/** Hub RPC from metaverse-hub `sproto.standalone_session`. The server mints the vars. */
export const RPC_STANDALONE_SESSION = 'sproto.standalone_session';
/** Public app marker. Not a secret. The server ignores every other field. */
export const STANDALONE_APP = 'sproto-duel';

const REFRESH_EARLY_MS = 5 * 60 * 1000;

export interface StandaloneMint {
  token: string;
  sid: string;
}

/**
 * Hub-scope device auth, then the standalone Duel session.
 * The client sends only `{app:"sproto-duel"}`. Scope, game, sid, and ranked come back on the token.
 */
export async function mintStandaloneToken(
  client: Pick<NakamaClient, 'authenticateDevice' | 'rpc'>,
  deviceId: string,
): Promise<StandaloneMint> {
  const hub = await client.authenticateDevice(deviceId);
  const minted = await client.rpc<{ token?: string; sid?: string }>(
    RPC_STANDALONE_SESSION,
    { app: STANDALONE_APP },
    { token: hub.token },
  );
  if (!minted.token) throw new Error('no_token');
  return { token: minted.token, sid: typeof minted.sid === 'string' ? minted.sid : '' };
}

export interface GuestRealtimeOptions {
  serverUrl: string;
  serverKey: string;
  deviceId?: string;
  client?: Pick<NakamaClient, 'authenticateDevice' | 'rpc'>;
  now?: () => number;
}

/** Mints on the first read and again inside 5 minutes of expiry. One mint is shared while it is in flight. */
export function standaloneTokenGetter(opts: {
  client: Pick<NakamaClient, 'authenticateDevice' | 'rpc'>;
  deviceId: string;
  now?: () => number;
  /** Test hook. Production reads the JWT `exp`. */
  expiryMs?: (token: string) => number;
}): () => Promise<string> {
  const now = opts.now ?? (() => Date.now());
  const expiryMs = opts.expiryMs ?? tokenExpiryMs;
  let token = '';
  let exp = 0;
  let job: Promise<string> | null = null;
  return () => {
    if (token && exp - now() > REFRESH_EARLY_MS) return Promise.resolve(token);
    job ??= mintStandaloneToken(opts.client, opts.deviceId)
      .then((minted) => {
        token = minted.token;
        exp = expiryMs(minted.token);
        return token;
      })
      .finally(() => {
        job = null;
      });
    return job;
  };
}

/**
 * Realtime client for a visit with no portal ticket. The socket opens on connect.
 * There is no refresh token on this session.
 */
export function openGuestRealtime(opts: GuestRealtimeOptions): HubRealtime {
  const client = opts.client ?? createNakamaClient({ serverUrl: opts.serverUrl, serverKey: opts.serverKey });
  const deviceId = opts.deviceId ?? getOrCreateDeviceId();
  return createRealtime({
    serverUrl: opts.serverUrl,
    getToken: standaloneTokenGetter({ client, deviceId, now: opts.now }),
  });
}
