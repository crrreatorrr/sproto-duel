import type { HubSdk, InitResult } from '@metaverse/hub-sdk';
import { describe, expect, it, vi } from 'vitest';
import { HubLink } from './link';

const profile = (): InitResult => ({ playerId: 'player-1', ranked: false, relics: [], effects: {}, ticketsCapLeft: 0, serverTime: 0 });

/** Every Ticket-changing call throws: the chip's refresh may only read the balance. */
function readOnlyApi(getTicketBalance: HubSdk['getTicketBalance']): HubSdk {
  const forbidden = () => {
    throw new Error('the Ticket chip must not change Tickets');
  };
  return {
    init: vi.fn(async () => profile()),
    reportEvent: vi.fn(forbidden),
    earnTickets: vi.fn(forbidden),
    exchange: vi.fn(forbidden),
    submitScore: vi.fn(forbidden),
    redeemTicket: vi.fn(forbidden),
    spendTickets: vi.fn(forbidden),
    sellItem: vi.fn(forbidden),
    getTicketBalance: vi.fn(getTicketBalance),
    exit: vi.fn(),
  };
}

describe('HubLink.refreshBalance', () => {
  it('does not call the SDK without a hub session', async () => {
    const api = readOnlyApi(async () => ({ balance: 50, sessionCapLeft: 0, dailyCapLeft: 0, serverTime: 0 }));
    const link = new HubLink(api);
    expect(await link.refreshBalance()).toBeNull();
    expect(api.getTicketBalance).not.toHaveBeenCalled();
    expect(link.status().balance).toBeNull();
  });

  it('reads the balance once per gap and shares an in-flight read', async () => {
    const api = readOnlyApi(async () => ({ balance: 140, sessionCapLeft: 0, dailyCapLeft: 0, serverTime: 0 }));
    const link = new HubLink(api);
    link.attach(profile());
    const [a, b] = await Promise.all([link.refreshBalance(), link.refreshBalance()]);
    expect([a, b]).toEqual([140, 140]);
    expect(await link.refreshBalance()).toBe(140);
    expect(api.getTicketBalance).toHaveBeenCalledTimes(1);
    expect(link.status()).toMatchObject({ connected: true, balance: 140 });
    await link.refreshBalance(0);
    expect(api.getTicketBalance).toHaveBeenCalledTimes(2);
  });

  it('keeps the last known balance when a read fails', async () => {
    const api = readOnlyApi(async () => {
      throw new Error('offline');
    });
    const link = new HubLink(api);
    link.attach(profile());
    link.balance = 60;
    expect(await link.refreshBalance(0)).toBe(60);
    expect(link.status().balance).toBe(60);
  });
});
