import { describe, expect, it, vi } from 'vitest';
import type { HubSdk } from '@metaverse/hub-sdk';
import { HubLink } from './link';

function fakeApi(): HubSdk & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const api: HubSdk = {
    init: vi.fn(async () => null),
    reportEvent: vi.fn(async (...args) => {
      calls.push(['event', ...args]);
      return { granted: 'tinubu_crown' };
    }),
    earnTickets: vi.fn(async (...args) => {
      calls.push(['earn', ...args]);
      return { balance: 20, capped: false };
    }),
    exchange: vi.fn(async () => ({ verse: 1, ticketsLeft: 10, receiptId: 'rcpt' })),
    submitScore: vi.fn(async (...args) => {
      calls.push(['score', ...args]);
    }),
    exit: vi.fn(),
  };
  return Object.assign(api, { calls });
}

describe('HubLink', () => {
  it('does not call the hub for a standalone win', async () => {
    const api = fakeApi();
    const link = new HubLink(api);
    const notes: string[] = [];
    await link.onDuelWin({ playerWon: true, bossId: 'tinubu', godMode: false, elapsed: 10 }, (title) => notes.push(title));
    expect(api.calls).toEqual([]);
    expect(notes).toEqual([]);
  });

  it('earns 20 Tickets and reports Tinubu once connected', async () => {
    const api = fakeApi();
    const link = new HubLink(api);
    link.attach({ playerId: 'p', ranked: false, relics: [], effects: {}, ticketsCapLeft: 100 });
    const notes: string[] = [];
    await link.onDuelWin({ playerWon: true, bossId: 'tinubu', godMode: true, elapsed: 40 }, (title, sub) => notes.push(`${title}|${sub}`));
    expect(api.earnTickets).toHaveBeenCalledWith(20, 'duel_win', expect.stringMatching(/^sproto:win:/));
    expect(api.reportEvent).toHaveBeenCalledWith(
      'sproto.boss_defeated',
      { boss: 'tinubu', elapsed: 40 },
      expect.stringMatching(/^sproto\.boss_defeated:/),
    );
    expect(api.submitScore).not.toHaveBeenCalled();
    expect(notes[0]).toContain("+20 Tickets");
    expect(notes[0]).toContain("Tinubu's Crown");
    expect(link.balance).toBe(20);
  });

  it('shows a portal error instead of calling exchange while standalone', async () => {
    const api = fakeApi();
    const link = new HubLink(api);
    const result = await link.exchangeTickets(10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/portal/i);
    expect(api.exchange).not.toHaveBeenCalled();
  });

  it('rejects a Ticket amount that is not a Verse step', async () => {
    const api = fakeApi();
    const link = new HubLink(api);
    link.attach({ playerId: 'p', ranked: true, relics: [], effects: {}, ticketsCapLeft: 0 });
    const result = await link.exchangeTickets(15);
    expect(result.ok).toBe(false);
    expect(api.exchange).not.toHaveBeenCalled();
  });

  it('records the receipt and the Tickets left after an exchange', async () => {
    const api = fakeApi();
    const link = new HubLink(api);
    link.attach({ playerId: 'p', ranked: true, relics: [], effects: {}, ticketsCapLeft: 80 });
    const result = await link.exchangeTickets(10);
    expect(result).toEqual({ ok: true, verse: 1, ticketsLeft: 10, receiptId: 'rcpt' });
    expect(link.balance).toBe(10);
    expect(api.exchange).toHaveBeenCalledWith(10, expect.stringMatching(/^sproto:exchange:/));
  });
});
