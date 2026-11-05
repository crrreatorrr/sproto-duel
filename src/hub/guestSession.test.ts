import type { HubRealtime, HubSdk, NakamaClient } from '@metaverse/hub-sdk';
import { describe, expect, it, vi } from 'vitest';
import { HubLink } from './link';
import {
  mintStandaloneToken,
  RPC_STANDALONE_SESSION,
  STANDALONE_APP,
  standaloneTokenGetter,
} from './guestSession';

function fakeApi(): HubSdk {
  return {
    init: vi.fn(),
    reportEvent: vi.fn(),
    earnTickets: vi.fn(),
    exchange: vi.fn(),
    submitScore: vi.fn(),
    redeemTicket: vi.fn(),
    spendTickets: vi.fn(),
    sellItem: vi.fn(),
    getTicketBalance: vi.fn(),
    exit: vi.fn(),
  };
}

function fakeClient(token = 'game-token'): Pick<NakamaClient, 'authenticateDevice' | 'rpc'> {
  return {
    authenticateDevice: vi.fn(async () => ({ token: 'hub-token', userId: 'user-1' })),
    rpc: vi.fn(async () => ({ token, sid: 'sid-1' })),
  } as Pick<NakamaClient, 'authenticateDevice' | 'rpc'>;
}

describe('mintStandaloneToken', () => {
  it('asks for a Duel session and does not send scope, game, or ranked', async () => {
    const client = fakeClient();
    const minted = await mintStandaloneToken(client, 'device-1');
    expect(minted).toEqual({ token: 'game-token', sid: 'sid-1' });
    expect(client.authenticateDevice).toHaveBeenCalledWith('device-1');
    expect(client.rpc).toHaveBeenCalledWith(RPC_STANDALONE_SESSION, { app: STANDALONE_APP }, { token: 'hub-token' });
  });

  it('refuses a reply with no token', async () => {
    const client = fakeClient();
    (client.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({});
    await expect(mintStandaloneToken(client, 'device-1')).rejects.toThrow('no_token');
  });
});

describe('standaloneTokenGetter', () => {
  it('mints once while the token is fresh and again when it is about to expire', async () => {
    const client = fakeClient('game-token');
    let now = 1_000_000;
    const getToken = standaloneTokenGetter({
      client,
      deviceId: 'device-9',
      now: () => now,
      expiryMs: () => now + 60 * 60 * 1000,
    });
    expect(await getToken()).toBe('game-token');
    now += 1000;
    expect(await getToken()).toBe('game-token');
    expect(client.authenticateDevice).toHaveBeenCalledTimes(1);
    now += 56 * 60 * 1000;
    (client.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({ token: 'game-token-2', sid: 'sid-2' });
    expect(await getToken()).toBe('game-token-2');
    expect(client.authenticateDevice).toHaveBeenCalledTimes(2);
  });
});

describe('HubLink online realtime', () => {
  it('a standalone visit has no portal realtime client', () => {
    expect(new HubLink(fakeApi()).realtime(() => {
      throw new Error('not called standalone');
    })).toBeNull();
  });

  it('opens a guest client when the visit has no portal session', () => {
    const link = new HubLink(fakeApi());
    const rt = link.openOnlineRealtime(() => {
      throw new Error('portal factory');
    });
    expect(rt).toBeTruthy();
    rt?.disconnect();
  });

  it('keeps the portal client when this visit is linked', () => {
    const link = new HubLink(fakeApi());
    link.attach({ playerId: 'p', ranked: false, relics: [], effects: {}, ticketsCapLeft: 0, serverTime: 0 });
    const portal = { disconnect() {} } as unknown as HubRealtime;
    expect(link.openOnlineRealtime(() => portal)).toBe(portal);
  });

  it('does not replace a portal visit with a guest when the portal client is missing', () => {
    const link = new HubLink(fakeApi());
    link.attach({ playerId: 'p', ranked: false, relics: [], effects: {}, ticketsCapLeft: 0, serverTime: 0 });
    expect(link.openOnlineRealtime(() => null)).toBeNull();
  });
});
