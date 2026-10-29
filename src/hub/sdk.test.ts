import { describe, expect, it, vi } from 'vitest';
import { createHubSdk, exitSlug, memoryStorage, readPortalTicket, type HubEnv } from '@metaverse/hub-sdk';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function harness(opts: { hash?: string; fetchImpl?: HubEnv['fetch'] } = {}) {
  const location = {
    href: `http://play.example/sproto-duel/${opts.hash ?? ''}`,
    origin: 'http://play.example',
    assigned: '',
    assign(url: string) {
      this.assigned = url;
    },
  };
  const history = {
    replaceState(_state: unknown, _title: string, url?: string | null) {
      location.href = new URL(url || '/', location.href).toString();
    },
  };
  const calls: { url: string; body: unknown; authorization: string | null }[] = [];
  const slot: { fetch: HubEnv['fetch'] } = {
    fetch: opts.fetchImpl ?? (async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const headers = new Headers(init?.headers);
      calls.push({ url, body, authorization: headers.get('Authorization') });
      if (url.includes('/v2/rpc/session.redeem')) {
        return jsonResponse({
          token: 'tok',
          refresh_token: 'ref',
          player_id: 'player-1',
          ranked: true,
          relics: ['tinubu_crown'],
          effects: { staff: 'moonward' },
          tickets_cap_left: 80,
          hub_origin: 'http://hub.example',
        });
      }
      if (url.includes('/v2/rpc/tickets.earn')) return jsonResponse({ balance: 20, capped: false });
      if (url.includes('/v2/rpc/tickets.exchange')) return jsonResponse({ verse: 2, tickets_left: 0, receipt_id: 'rcpt-1' });
      if (url.includes('/v2/rpc/session.event')) return jsonResponse({ granted: 'tinubu_crown' });
      if (url.includes('/v2/rpc/session.close')) return jsonResponse({});
      if (url.includes('/v2/rpc/score.submit')) return jsonResponse({});
      return jsonResponse({ message: 'daily verse cap reached' }, 409);
    }),
  };
  const env: HubEnv = {
    location,
    history,
    sessionStorage: memoryStorage(),
    localStorage: memoryStorage(),
    fetch: (input, init) => slot.fetch(input, init),
    exitPointerLock: vi.fn(),
    dropBeforeUnload: vi.fn(),
    nakamaUrl: 'http://127.0.0.1:7350',
    httpKey: 'defaulthttpkey',
    hubOrigin: '',
  };
  return { sdk: createHubSdk(env), location, calls, env, slot };
}

describe('hub sdk', () => {

  it('reads a portal ticket from the fragment and ignores anything else', () => {
    expect(readPortalTicket('#t=abc')).toBe('abc');
    expect(readPortalTicket('#from=sproto-duel')).toBeNull();
    expect(readPortalTicket('')).toBeNull();
  });

  it('exits Sproto Duel to the hub portal slug', () => {
    expect(exitSlug('sproto')).toBe('sproto-duel');
  });

  it('stays standalone when the fragment has no ticket', async () => {
    const { sdk, calls } = harness();
    await expect(sdk.init('sproto')).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it('redeems a ticket, strips it, and caches the session', async () => {
    const { sdk, calls, location, env } = harness({ hash: '#t=ticket-1' });
    const session = await sdk.init('sproto');
    expect(session).toMatchObject({ playerId: 'player-1', ranked: true, ticketsCapLeft: 80, relics: ['tinubu_crown'] });
    expect(calls[0].url).toContain('/v2/rpc/session.redeem');
    expect(calls[0].url).toContain('http_key=defaulthttpkey');
    expect(calls[0].authorization).toBeNull();
    expect(calls[0].body).toEqual({ ticket: 'ticket-1', game_id: 'sproto' });
    expect(location.href).not.toContain('t=ticket-1');
    expect(env.sessionStorage.getItem('hub:sproto:session')).toContain('player-1');
  });

  it('resumes a cached session on reload without a ticket', async () => {
    const first = harness({ hash: '#t=ticket-1' });
    await first.sdk.init('sproto');
    const second = harness();
    second.env.sessionStorage = first.env.sessionStorage;
    const sdk = createHubSdk(second.env);
    const session = await sdk.init('sproto');
    expect(session?.playerId).toBe('player-1');
    expect(second.calls.some((call) => call.url.includes('session.redeem'))).toBe(false);
  });

  it('earns Tickets with the game session and exchanges them', async () => {
    const { sdk, calls } = harness({ hash: '#t=ticket-1' });
    await sdk.init('sproto');
    const earned = await sdk.earnTickets(20, 'duel_win', 'sproto:win:1');
    expect(earned).toEqual({ balance: 20, capped: false });
    const traded = await sdk.exchange(20, 'sproto:exchange:1');
    expect(traded).toEqual({ verse: 2, ticketsLeft: 0, receiptId: 'rcpt-1' });
    const earnCall = calls.find((call) => call.url.includes('tickets.earn'));
    expect(earnCall?.authorization).toBe('Bearer tok');
    expect(earnCall?.body).toEqual({ amount: 20, reason: 'duel_win', key: 'sproto:win:1' });
  });

  it('surfaces a server exchange error', async () => {
    const { sdk } = harness({
      hash: '#t=ticket-1',
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('session.redeem')) {
          return jsonResponse({ token: 'tok', player_id: 'player-1', ranked: false, relics: [], effects: {}, tickets_cap_left: 0 });
        }
        return jsonResponse({ message: 'daily verse cap reached' }, 409);
      },
    });
    await sdk.init('sproto');
    await expect(sdk.exchange(10, 'k')).rejects.toThrow(/daily verse cap reached/);
  });

  it('queues an earn when the hub cannot be reached and flushes it next time', async () => {
    const { sdk, env, slot } = harness({ hash: '#t=ticket-1' });
    await sdk.init('sproto');
    slot.fetch = async () => {
      throw new Error('offline');
    };
    await expect(sdk.earnTickets(20, 'duel_win', 'sproto:win:queued')).rejects.toThrow(/Saved to send/);
    expect(env.localStorage.getItem('hub:sproto:outbox')).toContain('sproto:win:queued');

    const flushed: unknown[] = [];
    slot.fetch = async (_input, init) => {
      flushed.push(JSON.parse(String(init?.body)));
      return jsonResponse({ balance: 20, capped: false });
    };
    await sdk.earnTickets(20, 'duel_win', 'sproto:win:other');
    expect(flushed).toEqual([
      { amount: 20, reason: 'duel_win', key: 'sproto:win:queued' },
      { amount: 20, reason: 'duel_win', key: 'sproto:win:other' },
    ]);
    expect(env.localStorage.getItem('hub:sproto:outbox')).toBeNull();
  });

  it('returns to /hub#from=sproto-duel and releases pointer lock', async () => {
    const { sdk, location, env } = harness({ hash: '#t=ticket-1' });
    await sdk.init('sproto');
    sdk.exit('return');
    await vi.waitFor(() => expect(location.assigned).toBe('http://hub.example/hub#from=sproto-duel'));
    expect(env.exitPointerLock).toHaveBeenCalled();
    expect(env.dropBeforeUnload).toHaveBeenCalled();
    expect(env.sessionStorage.getItem('hub:sproto:session')).toBeNull();
  });

  it('uses a path on this origin when the hub origin is unknown', () => {
    const { sdk, location } = harness();
    sdk.exit();
    return vi.waitFor(() => expect(location.assigned).toBe('/hub#from=sproto-duel'));
  });
});
