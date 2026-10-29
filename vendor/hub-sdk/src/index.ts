/**
 * @metaverse/hub-sdk 0.1.0
 *
 * Browser client for a game page opened from the metaverse hub.
 * `init` reads `#t=<ticket>`, redeems it for a game-scoped Nakama session, and caches that
 * session under `hub:<game>:session` so a reload still works. With no ticket and no cache,
 * every call is a no-op and the game runs standalone.
 *
 * RPCs (Nakama HTTP, unwrap): session.redeem, session.event, tickets.earn, tickets.exchange,
 * score.submit, session.close.
 */

export type GameId = 'sproto' | 'hpos10i' | 'pb' | 'nobu' | (string & {});

export interface HubSession {
  playerId: string;
  ranked: boolean;
  relics: string[];
  effects: Record<string, number | boolean | string>;
  ticketsCapLeft: number;
}

export interface EarnResult {
  balance: number;
  capped: boolean;
}

export interface ExchangeResult {
  verse: number;
  ticketsLeft: number;
  receiptId: string;
}

export interface EventResult {
  granted?: string;
}

export class HubError extends Error {
  /** The call never reached a definitive server answer and was written to the outbox. */
  readonly queued: boolean;
  constructor(message: string, queued = false) {
    super(message);
    this.name = 'HubError';
    this.queued = queued;
  }
}

interface CachedSession extends HubSession {
  token: string;
  refreshToken?: string;
  hubOrigin?: string;
}

interface OutboxItem {
  rpc: 'tickets.earn' | 'tickets.exchange' | 'session.event' | 'score.submit';
  body: Record<string, unknown>;
  key: string;
}

export interface HubEnv {
  location: { href: string; origin: string; assign(url: string): void };
  history: { replaceState(state: unknown, title: string, url?: string | null): void };
  sessionStorage: Storage;
  localStorage: Storage;
  fetch: typeof fetch;
  exitPointerLock(): void;
  dropBeforeUnload(): void;
  nakamaUrl: string;
  httpKey: string;
  hubOrigin: string;
}

const EXIT_SLUG: Record<string, string> = {
  sproto: 'sproto-duel',
  'sproto-duel': 'sproto-duel',
  hpos10i: 'hpos10i',
  pb: 'peoples-bitcoin',
  nobu: 'nobu',
};

export function exitSlug(gameId: string): string {
  return EXIT_SLUG[gameId] ?? gameId;
}

/** Portal ticket in the URL fragment (`#t=<ticket>`), or null. */
export function readPortalTicket(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  const ticket = new URLSearchParams(raw).get('t');
  return ticket ? ticket : null;
}

function envString(name: 'VITE_NAKAMA_URL' | 'VITE_NAKAMA_HTTP_KEY' | 'VITE_HUB_ORIGIN'): string {
  const env = import.meta.env as Record<string, string | undefined> | undefined;
  const value = env?.[name];
  return typeof value === 'string' ? value : '';
}

function defaultEnv(): HubEnv {
  const hasWindow = typeof window !== 'undefined';
  return {
    location: hasWindow
      ? window.location
      : { href: 'http://localhost/', origin: 'http://localhost', assign() {} },
    history: hasWindow ? window.history : { replaceState() {} },
    sessionStorage: hasWindow ? window.sessionStorage : memoryStorage(),
    localStorage: hasWindow ? window.localStorage : memoryStorage(),
    fetch: globalThis.fetch.bind(globalThis),
    exitPointerLock() {
      if (hasWindow && document.pointerLockElement) document.exitPointerLock();
    },
    dropBeforeUnload() {
      if (hasWindow) window.onbeforeunload = null;
    },
    nakamaUrl: (envString('VITE_NAKAMA_URL') || 'http://127.0.0.1:7350').replace(/\/$/, ''),
    httpKey: envString('VITE_NAKAMA_HTTP_KEY') || 'defaulthttpkey',
    hubOrigin: envString('VITE_HUB_ORIGIN').replace(/\/$/, ''),
  };
}

export function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
}

function storageGet(store: Storage, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(store: Storage, key: string, value: string): void {
  try {
    store.setItem(key, value);
  } catch {
    // Private mode or a full quota: the session just won't survive a reload.
  }
}

function storageRemove(store: Storage, key: string): void {
  try {
    store.removeItem(key);
  } catch {
    // Ignore.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function field(obj: unknown, ...keys: string[]): unknown {
  if (!isRecord(obj)) return undefined;
  for (const key of keys) if (key in obj) return obj[key];
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function effectsOf(value: unknown): Record<string, number | boolean | string> {
  if (!isRecord(value)) return {};
  const out: Record<string, number | boolean | string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'number' || typeof item === 'boolean' || typeof item === 'string') out[key] = item;
  }
  return out;
}

function relicsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Hints a portal ticket may carry (hub origin, Nakama URL). Unsigned; the server still checks the ticket. */
export function ticketHints(ticket: string): { hubOrigin?: string; nakamaUrl?: string } {
  const parts = ticket.split('.');
  if (parts.length < 2) return {};
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json: unknown = JSON.parse(atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '=')));
    return {
      hubOrigin: asString(field(json, 'hub', 'hub_origin', 'hubOrigin')),
      nakamaUrl: asString(field(json, 'nakama', 'nakama_url', 'nakamaUrl')),
    };
  } catch {
    return {};
  }
}

function unwrapPayload(json: unknown): unknown {
  if (isRecord(json) && typeof json.payload === 'string') {
    try {
      return JSON.parse(json.payload);
    } catch {
      return json;
    }
  }
  return json;
}

function errorMessage(json: unknown, status: number, rpc: string): string {
  const body = unwrapPayload(json);
  if (isRecord(body)) {
    const message = asString(field(body, 'message', 'error', 'msg'));
    if (message && message !== 'rpc error') return message;
  }
  return `Hub ${rpc} failed (${status})`;
}

export function createHubSdk(overrides: Partial<HubEnv> = {}) {
  const env: HubEnv = { ...defaultEnv(), ...overrides };
  let gameId = 'sproto';
  let session: CachedSession | null = null;
  let nakamaUrl = env.nakamaUrl;

  const sessionKey = () => `hub:${gameId}:session`;
  const outboxKey = () => `hub:${gameId}:outbox`;

  function loadSession(): CachedSession | null {
    const raw = storageGet(env.sessionStorage, sessionKey());
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      const token = asString(field(parsed, 'token'));
      const playerId = asString(field(parsed, 'playerId', 'player_id'));
      if (!token || !playerId) return null;
      return {
        token,
        refreshToken: asString(field(parsed, 'refreshToken', 'refresh_token')),
        playerId,
        ranked: asBool(field(parsed, 'ranked')) ?? false,
        relics: relicsOf(field(parsed, 'relics')),
        effects: effectsOf(field(parsed, 'effects')),
        ticketsCapLeft: asNumber(field(parsed, 'ticketsCapLeft', 'tickets_cap_left')) ?? 0,
        hubOrigin: asString(field(parsed, 'hubOrigin', 'hub_origin')),
      };
    } catch {
      return null;
    }
  }

  function saveSession(): void {
    if (!session) {
      storageRemove(env.sessionStorage, sessionKey());
      return;
    }
    storageSet(env.sessionStorage, sessionKey(), JSON.stringify(session));
  }

  function readOutbox(): OutboxItem[] {
    const raw = storageGet(env.localStorage, outboxKey());
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is OutboxItem => isRecord(item) && typeof item.rpc === 'string' && typeof item.key === 'string' && isRecord(item.body));
    } catch {
      return [];
    }
  }

  function writeOutbox(items: OutboxItem[]): void {
    if (!items.length) storageRemove(env.localStorage, outboxKey());
    else storageSet(env.localStorage, outboxKey(), JSON.stringify(items));
  }

  function enqueue(item: OutboxItem): void {
    const items = readOutbox().filter((existing) => existing.key !== item.key);
    items.push(item);
    writeOutbox(items);
  }

  function currentUrl(): URL | null {
    try {
      return new URL(env.location.href);
    } catch {
      return null;
    }
  }

  /** Remove `#t=` without navigating. A failed read leaves the fragment alone. */
  function stripTicket(): void {
    const url = currentUrl();
    if (!url || !readPortalTicket(url.hash)) return;
    const params = new URLSearchParams(url.hash.replace(/^#/, ''));
    params.delete('t');
    const next = params.toString();
    url.hash = next ? `#${next}` : '';
    env.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }

  async function rpc(id: string, body: unknown, opts: { auth: boolean; retried?: boolean }): Promise<unknown> {
    const url = new URL(`/v2/rpc/${encodeURIComponent(id)}`, nakamaUrl.endsWith('/') ? nakamaUrl : `${nakamaUrl}/`);
    url.searchParams.set('unwrap', 'true');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (opts.auth) {
      if (!session) throw new HubError('No hub session. Enter from the hub portal.');
      headers.Authorization = `Bearer ${session.token}`;
    } else {
      url.searchParams.set('http_key', env.httpKey);
    }
    let response: Response;
    try {
      response = await env.fetch(url.toString(), { method: 'POST', headers, body: JSON.stringify(body) });
    } catch {
      throw new HubError('Could not reach the hub.', true);
    }
    const text = await response.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new HubError(`Hub ${id} returned an unreadable response (${response.status})`);
      }
    }
    if (response.status === 401 && opts.auth && !opts.retried && session?.refreshToken) {
      const refreshed = await refresh();
      if (refreshed) return rpc(id, body, { auth: true, retried: true });
    }
    if (!response.ok) {
      throw new HubError(errorMessage(json, response.status, id), response.status >= 500);
    }
    return unwrapPayload(json);
  }

  async function refresh(): Promise<boolean> {
    if (!session?.refreshToken) return false;
    const url = new URL('/v2/session/refresh', `${nakamaUrl}/`);
    let response: Response;
    try {
      response = await env.fetch(url.toString(), {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.refreshToken}`, Accept: 'application/json' },
      });
    } catch {
      return false;
    }
    if (!response.ok) {
      session = null;
      saveSession();
      return false;
    }
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      return false;
    }
    const token = asString(field(json, 'token'));
    if (!token || !session) return false;
    session = { ...session, token, refreshToken: asString(field(json, 'refresh_token', 'refreshToken')) ?? session.refreshToken };
    saveSession();
    return true;
  }

  function applyRedeem(json: unknown, hints: { hubOrigin?: string; nakamaUrl?: string }): HubSession {
    const token = asString(field(json, 'token'));
    const playerId = asString(field(json, 'player_id', 'playerId', 'user_id', 'userId'));
    if (!token || !playerId) throw new HubError(errorMessage(json, 200, 'session.redeem'));
    const hubOrigin = asString(field(json, 'hub_origin', 'hubOrigin')) ?? hints.hubOrigin;
    session = {
      token,
      refreshToken: asString(field(json, 'refresh_token', 'refreshToken')),
      playerId,
      ranked: asBool(field(json, 'ranked')) ?? false,
      relics: relicsOf(field(json, 'relics')),
      effects: effectsOf(field(json, 'effects')),
      ticketsCapLeft: asNumber(field(json, 'tickets_cap_left', 'ticketsCapLeft')) ?? 0,
      hubOrigin,
    };
    saveSession();
    return publicSession();
  }

  function publicSession(): HubSession {
    if (!session) throw new HubError('No hub session. Enter from the hub portal.');
    return {
      playerId: session.playerId,
      ranked: session.ranked,
      relics: session.relics,
      effects: session.effects,
      ticketsCapLeft: session.ticketsCapLeft,
    };
  }

  async function flush(): Promise<void> {
    const pending = readOutbox();
    if (!pending.length || !session) return;
    const left: OutboxItem[] = [];
    for (const item of pending) {
      try {
        await rpc(item.rpc, item.body, { auth: true });
      } catch (err) {
        if (err instanceof HubError && err.queued) left.push(item);
        // A definitive rejection is dropped: retrying the same body will not succeed.
      }
    }
    writeOutbox(left);
  }

  function exitTarget(): string {
    const slug = exitSlug(gameId);
    const origin = (session?.hubOrigin || env.hubOrigin || '').replace(/\/$/, '');
    if (!origin || origin === env.location.origin) return `/hub#from=${slug}`;
    return `${origin}/hub#from=${slug}`;
  }

  async function sendOrQueue(rpcName: OutboxItem['rpc'], body: Record<string, unknown>, key: string): Promise<unknown> {
    await flush();
    try {
      return await rpc(rpcName, body, { auth: true });
    } catch (err) {
      if (err instanceof HubError && err.queued) {
        enqueue({ rpc: rpcName, body, key });
        throw new HubError(`${err.message} Saved to send when the hub is reachable.`, true);
      }
      throw err;
    }
  }

  return {
    /** Redeem `#t=` or resume the cached session. Null when this visit is standalone. */
    async init(id: GameId): Promise<HubSession | null> {
      gameId = id;
      const ticket = readPortalTicket(currentUrl()?.hash ?? '');
      if (ticket) {
        const hints = ticketHints(ticket);
        if (hints.nakamaUrl) nakamaUrl = hints.nakamaUrl.replace(/\/$/, '');
        try {
          const json = await rpc('session.redeem', { ticket, game_id: id }, { auth: false });
          stripTicket();
          const opened = applyRedeem(json, hints);
          await flush();
          return opened;
        } catch (err) {
          // A rejected ticket must not sit in the URL. A dropped connection can be retried by reloading.
          if (!(err instanceof HubError && err.queued)) stripTicket();
          throw err;
        }
      }
      session = loadSession();
      if (!session) return null;
      await flush();
      return publicSession();
    },

    async reportEvent(eventId: string, data: object, key: string): Promise<EventResult> {
      const json = await sendOrQueue('session.event', { event_id: eventId, data, key }, key);
      const granted = asString(field(json, 'granted', 'relic', 'relic_id', 'relicId'));
      return granted ? { granted } : {};
    },

    async earnTickets(amount: number, reason: string, key: string): Promise<EarnResult> {
      if (!Number.isFinite(amount) || amount <= 0) throw new HubError('Ticket amount must be positive.');
      const json = await sendOrQueue('tickets.earn', { amount, reason, key }, key);
      const balance = asNumber(field(json, 'balance'));
      const capped = asBool(field(json, 'capped'));
      if (balance === undefined || capped === undefined) throw new HubError(errorMessage(json, 200, 'tickets.earn'));
      return { balance, capped };
    },

    async exchange(tickets: number, key: string): Promise<ExchangeResult> {
      if (!Number.isInteger(tickets) || tickets <= 0) throw new HubError('Exchange a positive number of Tickets.');
      const json = await sendOrQueue('tickets.exchange', { tickets, key }, key);
      const verse = asNumber(field(json, 'verse'));
      const ticketsLeft = asNumber(field(json, 'tickets_left', 'ticketsLeft'));
      const receiptId = asString(field(json, 'receipt_id', 'receiptId'));
      if (verse === undefined || ticketsLeft === undefined || !receiptId) throw new HubError(errorMessage(json, 200, 'tickets.exchange'));
      return { verse, ticketsLeft, receiptId };
    },

    async submitScore(boardId: string, value: number, meta?: object): Promise<void> {
      const key = `score:${boardId}:${asString(field(meta, 'matchId')) ?? String(value)}`;
      await sendOrQueue('score.submit', { board_id: boardId, value, meta: meta ?? {} }, key);
    },

    exit(reason?: string): void {
      const go = () => {
        try {
          env.exitPointerLock();
        } catch {
          // Pointer lock may already be released.
        }
        env.dropBeforeUnload();
        const target = exitTarget();
        session = null;
        saveSession();
        env.location.assign(target);
      };
      void (async () => {
        try {
          if (session) {
            await flush();
            await rpc('session.close', { reason: reason ?? 'exit' }, { auth: true });
          }
        } catch {
          // Leaving the game still wins over a close call that failed.
        }
        go();
      })();
    },
  };
}

export type HubSdk = ReturnType<typeof createHubSdk>;

export const hubSdk = createHubSdk();

export const init = hubSdk.init;
export const reportEvent = hubSdk.reportEvent;
export const earnTickets = hubSdk.earnTickets;
export const exchange = hubSdk.exchange;
export const submitScore = hubSdk.submitScore;
export const exit = hubSdk.exit;

if (typeof window !== 'undefined') {
  (window as unknown as { hubSdk: HubSdk }).hubSdk = hubSdk;
}
