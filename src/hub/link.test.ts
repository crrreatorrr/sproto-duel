import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventResult, HubSdk, InitResult } from '@metaverse/hub-sdk';
import { describe, expect, it, vi } from 'vitest';
import { connectHub, HubLink } from './link';

const STORY_BOSSES = ['sahil', 'obama', 'broccoli', 'agent', 'tinubu'] as const;

const profile = (): InitResult => ({
  playerId: 'player-1',
  ranked: false,
  relics: [],
  effects: {},
  ticketsCapLeft: 0,
  serverTime: 0,
});

function fakeApi(): HubSdk & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const api: HubSdk = {
    init: vi.fn(async (): Promise<InitResult> => profile()),
    reportEvent: vi.fn(async (...args): Promise<EventResult> => {
      calls.push(['event', ...args]);
      return { granted: 'tinubu_crown' };
    }),
    earnTickets: vi.fn(async (...args) => {
      calls.push(['earn', ...args]);
      return { balance: 20, capped: false };
    }),
    exchange: vi.fn(async () => ({ verse: 1, ticketsLeft: 10, balance: 10, receiptId: 'rcpt' })),
    submitScore: vi.fn(async (...args) => {
      calls.push(['score', ...args]);
    }),
    redeemTicket: vi.fn(),
    spendTickets: vi.fn(),
    sellItem: vi.fn(),
    getTicketBalance: vi.fn(),
    exit: vi.fn(),
  };
  return Object.assign(api, { calls });
}

describe('HubLink online', () => {
  it('never notifies or earns for an online outcome', async () => {
    const api = fakeApi();
    const link = new HubLink(api);
    link.attach(profile());
    const notify = vi.fn();

    await link.onOnlineOutcome({ status: 'verified', paid: {} }, 'me', notify);
    await link.onOnlineOutcome({ status: 'verified', paid: { me: 0 } }, 'me', notify);
    await link.onOnlineOutcome({ status: 'verified', paid: { me: 20 } }, 'me', notify);
    await link.onOnlineOutcome({ status: 'verified', paid: { other: 20 }, balances: { me: 140 } }, 'me', notify);
    await link.onOnlineOutcome({ status: 'forfeit', paid: {} }, 'me', notify);
    await link.onOnlineOutcome({ status: 'forfeit', paid: { me: 0 }, balances: { me: 160 } }, 'me', notify);
    await link.onOnlineOutcome({ status: 'forfeit', paid: { me: 20 }, balances: { me: 160 } }, 'me', notify);

    expect(notify).not.toHaveBeenCalled();
    expect(api.earnTickets).not.toHaveBeenCalled();
    expect(api.reportEvent).not.toHaveBeenCalled();
    expect(api.calls).toEqual([]);
  });

  it('a standalone visit has no realtime client', () => {
    expect(new HubLink(fakeApi()).realtime(() => {
      throw new Error('not called standalone');
    })).toBeNull();
  });
});

describe('HubLink', () => {
  it('calls init with the sproto game id and stays standalone without a hub session', async () => {
    const api = fakeApi();
    const link = await connectHub(api);
    expect(api.init).toHaveBeenCalledTimes(1);
    expect(api.init).toHaveBeenCalledWith('sproto');
    expect(link.connected).toBe(false);
    expect(link.error).toBeNull();
  });

  it('does not call the hub for a standalone win', async () => {
    const api = fakeApi();
    const link = new HubLink(api);
    const notes: string[] = [];
    await link.onDuelWin({ playerWon: true, bossId: 'tinubu', godMode: false, elapsed: 10 }, (title) => notes.push(title));
    expect(api.calls).toEqual([]);
    expect(notes).toEqual([]);
  });

  it('posts boss_defeated for Tinubu once and does not earn', async () => {
    const api = fakeApi();
    (api.getTicketBalance as ReturnType<typeof vi.fn>).mockResolvedValue({ balance: 20, sessionCapLeft: 0, dailyCapLeft: 0, serverTime: 0 });
    const link = new HubLink(api);
    link.attach({ playerId: 'p', ranked: false, relics: [], effects: {}, ticketsCapLeft: 100, serverTime: 0 });
    const notes: string[] = [];
    await link.onDuelWin({ playerWon: true, bossId: 'tinubu', godMode: true, elapsed: 40 }, (title, sub) => notes.push(`${title}|${sub}`));
    expect(api.earnTickets).not.toHaveBeenCalled();
    expect(api.reportEvent).toHaveBeenCalledTimes(1);
    expect(api.reportEvent).toHaveBeenCalledWith(
      'sproto.boss_defeated',
      { boss: 'tinubu', elapsed: 40 },
      expect.stringMatching(/^sproto\.boss_defeated:/),
    );
    expect(api.getTicketBalance).toHaveBeenCalledTimes(1);
    expect(api.submitScore).not.toHaveBeenCalled();
    expect(notes).toEqual(["Tinubu's Crown|Tinubu's Crown"]);
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
    link.attach({ playerId: 'p', ranked: true, relics: [], effects: {}, ticketsCapLeft: 0, serverTime: 0 });
    const result = await link.exchangeTickets(15);
    expect(result.ok).toBe(false);
    expect(api.exchange).not.toHaveBeenCalled();
  });

  it('records the receipt and the Tickets left after an exchange', async () => {
    const api = fakeApi();
    const link = new HubLink(api);
    link.attach({ playerId: 'p', ranked: true, relics: [], effects: {}, ticketsCapLeft: 80, serverTime: 0 });
    const result = await link.exchangeTickets(10);
    expect(result).toEqual({ ok: true, verse: 1, ticketsLeft: 10, receiptId: 'rcpt' });
    expect(link.balance).toBe(10);
    expect(api.exchange).toHaveBeenCalledWith(10, expect.stringMatching(/^sproto:exchange:/));
  });
});

function eventPosts(api: ReturnType<typeof fakeApi>): { data: { boss: string; elapsed: number }; key: string }[] {
  return (api.reportEvent as ReturnType<typeof vi.fn>).mock.calls.map((call) => ({
    data: call[1] as { boss: string; elapsed: number },
    key: call[2] as string,
  }));
}

function connected(api: ReturnType<typeof fakeApi>, ranked = false): HubLink {
  const link = new HubLink(api);
  link.attach({ playerId: 'p', ranked, relics: [], effects: {}, ticketsCapLeft: 100, serverTime: 0 });
  return link;
}

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourcesUnder(path));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

describe('story boss payout', () => {
  it('posts boss_defeated once per Gauntlet boss with that boss id', async () => {
    for (const boss of STORY_BOSSES) {
      const api = fakeApi();
      const link = connected(api);
      await link.onDuelWin({ mode: 'gauntlet', playerWon: true, bossId: boss, godMode: false, elapsed: 10 });
      expect(api.reportEvent).toHaveBeenCalledTimes(1);
      expect(api.reportEvent).toHaveBeenCalledWith(
        'sproto.boss_defeated',
        { boss, elapsed: 10 },
        expect.stringMatching(/^sproto\.boss_defeated:/),
      );
      expect(api.earnTickets).not.toHaveBeenCalled();
    }
  });

  it('posts nothing for a Midget, Quick Duel, or online win', async () => {
    const wins = [
      { mode: 'gauntlet' as const, bossId: 'midget', ranked: false },
      { mode: 'quick' as const, bossId: null, ranked: false },
      { mode: 'quick' as const, bossId: 'sahil', ranked: false },
      { mode: 'online' as const, bossId: 'tinubu', ranked: true },
    ];
    for (const win of wins) {
      const api = fakeApi();
      const link = connected(api, win.ranked);
      await link.onDuelWin({ mode: win.mode, playerWon: true, bossId: win.bossId, godMode: false, elapsed: 10 });
      expect(api.reportEvent).not.toHaveBeenCalled();
      expect(api.earnTickets).not.toHaveBeenCalled();
      expect(api.submitScore).not.toHaveBeenCalled();
      expect(api.calls).toEqual([]);
    }
  });

  it('posts boss_defeated once when the win handler fires twice', async () => {
    const api = fakeApi();
    (api.reportEvent as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const link = connected(api);
    const win = { mode: 'gauntlet' as const, playerWon: true, bossId: 'agent', godMode: false, elapsed: 11 };
    await link.onDuelWin(win);
    await link.onDuelWin(win);
    expect(api.reportEvent).toHaveBeenCalledTimes(1);
    expect(api.reportEvent).toHaveBeenCalledWith(
      'sproto.boss_defeated',
      { boss: 'agent', elapsed: 11 },
      expect.stringMatching(/^sproto\.boss_defeated:/),
    );
    expect(api.earnTickets).not.toHaveBeenCalled();
  });

  it('posts once on one key when the same fight id is passed twice', async () => {
    const api = fakeApi();
    (api.reportEvent as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const link = connected(api);
    const matchId = 'fight-same';
    const win = { mode: 'gauntlet' as const, playerWon: true, bossId: 'sahil', godMode: false, elapsed: 10, matchId };
    await link.onDuelWin(win);
    await link.onDuelWin(win);
    const posts = eventPosts(api);
    expect(posts).toHaveLength(1);
    expect(posts[0].key).toBe('sproto.boss_defeated:fight-same');
    expect(posts[0].data).toEqual({ boss: 'sahil', elapsed: 10 });
    expect(api.earnTickets).not.toHaveBeenCalled();
  });

  it('posts two distinct keys for two Gauntlet fights against the same boss', async () => {
    const api = fakeApi();
    (api.reportEvent as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const link = connected(api);
    const first = link.beginFight();
    await link.onDuelWin({ mode: 'gauntlet', playerWon: true, bossId: 'obama', godMode: false, elapsed: 10, matchId: first });
    const second = link.beginFight();
    await link.onDuelWin({ mode: 'gauntlet', playerWon: true, bossId: 'obama', godMode: false, elapsed: 10, matchId: second });
    const posts = eventPosts(api);
    expect(first).not.toBe(second);
    expect(posts).toHaveLength(2);
    expect(posts.map((post) => post.key)).toEqual([
      `sproto.boss_defeated:${first}`,
      `sproto.boss_defeated:${second}`,
    ]);
    expect(new Set(posts.map((post) => post.key)).size).toBe(2);
    expect(api.earnTickets).not.toHaveBeenCalled();
  });

  it('posts a different boss once on a new key', async () => {
    const api = fakeApi();
    (api.reportEvent as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const link = connected(api);
    await link.onDuelWin({ mode: 'gauntlet', playerWon: true, bossId: 'sahil', godMode: false, elapsed: 10 });
    await link.onDuelWin({ mode: 'gauntlet', playerWon: true, bossId: 'broccoli', godMode: false, elapsed: 10 });
    const posts = eventPosts(api);
    expect(posts).toHaveLength(2);
    expect(posts[1].key).not.toBe(posts[0].key);
    expect(posts.filter((post) => post.data.boss === 'broccoli')).toHaveLength(1);
    expect(posts[1].data).toEqual({ boss: 'broccoli', elapsed: 10 });
    expect(api.earnTickets).not.toHaveBeenCalled();
  });

  it('sends boss_defeated data as exactly { boss, elapsed }', async () => {
    const api = fakeApi();
    (api.reportEvent as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const link = connected(api);
    await link.onDuelWin({ mode: 'gauntlet', playerWon: true, bossId: 'agent', godMode: false, elapsed: 12.4 });
    const posts = eventPosts(api);
    expect(posts).toHaveLength(1);
    expect(posts[0].data).toEqual({ boss: 'agent', elapsed: 12 });
    expect(Object.keys(posts[0].data)).toEqual(['boss', 'elapsed']);
  });

  it('does not post boss_defeated for a Quick Duel fight id', async () => {
    const api = fakeApi();
    const link = connected(api);
    const matchId = link.beginFight();
    await link.onDuelWin({ mode: 'quick', playerWon: true, bossId: 'tinubu', godMode: false, elapsed: 10, matchId });
    await link.onDuelWin({ mode: 'quick', playerWon: true, bossId: 'agent', godMode: false, elapsed: 22, matchId });
    expect(api.reportEvent).not.toHaveBeenCalled();
    expect(api.earnTickets).not.toHaveBeenCalled();
  });

  it('toasts the Ticket delta only when getTicketBalance rose', async () => {
    const api = fakeApi();
    (api.reportEvent as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const link = connected(api);
    const notes: string[] = [];
    const toast = (title: string, sub: string) => notes.push(`${title}|${sub}`);
    const balance = (n: number) => {
      (api.getTicketBalance as ReturnType<typeof vi.fn>).mockResolvedValue({ balance: n, sessionCapLeft: 0, dailyCapLeft: 0, serverTime: 0 });
    };
    const beat = (boss: string) => link.onDuelWin({ mode: 'gauntlet', playerWon: true, bossId: boss, godMode: false, elapsed: 9 }, toast);

    balance(50);
    await beat('sahil');
    expect(notes).toEqual([]);
    expect(link.balance).toBe(50);

    balance(50);
    await beat('obama');
    expect(notes).toEqual([]);
    expect(link.balance).toBe(50);

    balance(65);
    await beat('broccoli');
    expect(notes).toEqual(['+15 Tickets|Balance 65']);
    expect(link.balance).toBe(65);
    expect(api.earnTickets).not.toHaveBeenCalled();
  });

  it('never calls earnTickets anywhere in the client', () => {
    const src = fileURLToPath(new URL('..', import.meta.url));
    const hits: string[] = [];
    for (const file of sourcesUnder(src)) {
      if (/earnTickets\s*\(/.test(readFileSync(file, 'utf8'))) hits.push(file);
    }
    expect(hits).toEqual([]);
  });

  it('gives no toast and does not repost when getTicketBalance fails', async () => {
    const api = fakeApi();
    (api.reportEvent as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (api.getTicketBalance as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('balance down'));
    const link = connected(api);
    link.balance = 40;
    const notify = vi.fn();
    await link.onDuelWin({ mode: 'gauntlet', playerWon: true, bossId: 'broccoli', godMode: false, elapsed: 8 }, notify);
    expect(notify).not.toHaveBeenCalled();
    expect(api.reportEvent).toHaveBeenCalledTimes(1);
    expect(api.reportEvent).toHaveBeenCalledWith(
      'sproto.boss_defeated',
      { boss: 'broccoli', elapsed: 8 },
      expect.stringMatching(/^sproto\.boss_defeated:/),
    );
    expect(api.earnTickets).not.toHaveBeenCalled();
    expect(link.balance).toBe(40);
  });
});
