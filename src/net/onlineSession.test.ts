import type { EventResult, HubSdk, InitResult } from '@metaverse/hub-sdk';
import { describe, expect, it, vi } from 'vitest';
import { TINUBU_EVENT } from '../hub/config';
import { HubLink } from '../hub/link';
import { ONLINE } from '../core/rules';
import { FakeArenaServer } from './FakeArenaServer';
import type { IntentFrame } from './intent';
import { OnlineSession, type SessionState } from './OnlineSession';
import { OP, type OutcomeMsg, type ResultMsg } from './protocol';
import { encodeSnapshot, type Snapshot } from './state';
import { type LoopbackTransport, ManualScheduler } from './transport';

const TICK = 1000 / 60;

function setup(latencyMs = 40) {
  const clock = new ManualScheduler();
  const server = new FakeArenaServer(clock, { latencyMs });
  server.nextHostSeat = 0;
  const mk = (id: string, version?: string) => new OnlineSession(server.lobby({ userId: id, username: id.toUpperCase() }), {
    scheduler: clock, staff: 'duel_staff_moonward', version, inputDelayTicks: 2, maxInputLagTicks: 30, interpDelayMs: 100, extrapolateMaxMs: 150, tickMs: TICK,
  });
  return { clock, server, a: mk('alice'), b: mk('bob'), mk };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
/** Advance the clock in frames, letting promises settle and the sessions update. */
async function run(clock: ManualScheduler, ms: number, sessions: OnlineSession[], each?: () => void) {
  for (let t = 0; t < ms; t += TICK) {
    each?.();
    clock.advance(TICK);
    for (const s of sessions) s.update();
    await flush();
  }
}

function snap(tick: number): Snapshot {
  return {
    v: 1, tick, ack: -1, wizards: [], projectiles: [], arena: { fireRadius: 27, pillars: [], tickets: [] },
    match: { phase: 'fight', round: 1, wins: [0, 0], timer: 60, phaseTime: 0, lastWinnerSeat: -1 },
  };
}

const frame = (tick: number, press = 0): IntentFrame => ({ tick, mx: 10, mz: 0, facing: 0, aim: [0, 0, 0], held: 0, press });

async function playing() {
  const env = setup();
  const { clock, a, b } = env;
  void a.quickMatch();
  void b.quickMatch();
  await flush();
  // Quick matches now wait in 'accepting' until both seats ACCEPT.
  await run(clock, 500, [a, b], () => {
    if (a.state === 'accepting') a.accept();
    if (b.state === 'accepting') b.accept();
  });
  await run(clock, 500, [a, b]);
  expect(a.state).toBe('playing');
  expect(b.state).toBe('playing');
  return env;
}

describe('OnlineSession with FakeArenaServer', () => {
  it('happy path: quick match, relay both ways, agreed result, verified payout', async () => {
    const { clock, server, a, b } = await playing();
    expect(a.isHost).toBe(true);
    expect(b.isHost).toBe(false);
    expect(b.start?.names).toEqual(['ALICE', 'BOB']);
    expect(a.start?.staffs).toEqual(['duel_staff_moonward', 'duel_staff_moonward']);
    // Guest input reaches the host's buffer; host snapshots reach the guest.
    let guestTick = 0, hostTick = 0, snapshots = 0;
    b.on('snapshot', () => snapshots++);
    await run(clock, 1000, [a, b], () => {
      b.queueInput(frame(++guestTick, guestTick === 5 ? 1 : 0));
      if (++hostTick % 2 === 0) a.sendSnapshot(encodeSnapshot(snap(hostTick)));
    });
    expect(a.remoteInput.depth).toBeGreaterThan(0);
    let presses = 0;
    for (let f = a.remoteInput.next(); f; f = a.remoteInput.next()) {
      presses += f.press;
      if (a.remoteInput.depth === 0) break;
    }
    expect(presses).toBe(1);
    expect(snapshots).toBeGreaterThan(20);
    expect(b.snapshots.size).toBeGreaterThan(10);
    expect(a.rttMs).toBeGreaterThanOrEqual(80);
    // Two rounds to the host, then both report the same result.
    await run(clock, 8000, [a, b]);
    a.sendRound({ round: 1, winnerSeat: 0, reason: 'ko', wins: [1, 0] });
    await run(clock, 8000, [a, b]);
    a.sendRound({ round: 2, winnerSeat: 0, reason: 'time', wins: [2, 0] });
    a.sendResult({ winnerSeat: 0, wins: [2, 0], rounds: 2 });
    b.sendResult({ winnerSeat: 0, wins: [2, 0], rounds: 2 });
    await run(clock, 300, [a, b]);
    // Peer still connected: the 15 s rematch window, not an end.
    expect(a.state).toBe('rematch');
    expect(b.state).toBe('rematch');
    expect(a.outcome?.status).toBe('verified');
    expect(b.outcome?.paid).toEqual({ alice: 20 });
    expect(server.payouts).toHaveLength(1);
    // A repeat RESULT after the outcome changes nothing.
    expect(server.matches[0]?.phase ?? 'done').toBe('done');
    // The server record is not a client mint. Online stake stays 0.
    const api = fakeApi();
    const link = new HubLink(api);
    link.attach(profile(true));
    const notes: string[] = [];
    await charge(link, a.outcome!, (title, sub) => notes.push(`${title}|${sub}`));
    expect(calls(api.earnTickets)).toEqual([]);
    expect(calls(api.reportEvent)).toEqual([]);
    expect(calls(api.submitScore)).toEqual([]);
    expect(notes.filter((n) => /ticket/i.test(n))).toEqual([]);
  });

  it('disagreeing results are disputed and pay nothing', async () => {
    const { clock, server, a, b } = await playing();
    await run(clock, 16000, [a, b]);
    a.sendRound({ round: 1, winnerSeat: 0, reason: 'ko', wins: [1, 0] });
    await run(clock, 3000, [a, b]);
    a.sendRound({ round: 2, winnerSeat: 0, reason: 'ko', wins: [2, 0] });
    a.sendResult({ winnerSeat: 0, wins: [2, 0], rounds: 2 });
    b.sendResult({ winnerSeat: 1, wins: [0, 2], rounds: 2 });
    await run(clock, 300, [a, b]);
    expect(a.outcome?.status).toBe('disputed');
    expect(server.payouts).toHaveLength(0);
  });

  it('opponent leaving forfeits after the grace (paid only after a round and MIN_PLAY)', async () => {
    const { clock, server, a, b } = await playing();
    let t = 0;
    const stream = () => {
      t++;
      a.sendSnapshot(encodeSnapshot(snap(t)));
      b.queueInput(frame(t));
    };
    await run(clock, 16000, [a, b], stream);
    a.sendRound({ round: 1, winnerSeat: 0, reason: 'ko', wins: [1, 0] });
    await run(clock, 200, [a, b]);
    const peers: boolean[] = [];
    a.on('peer', (p) => peers.push(p.present));
    b.leave();
    expect(b.state).toBe('ended');
    await run(clock, 11_000, [a, b]);
    expect(peers).toEqual([false]);
    expect(a.outcome?.status).toBe('forfeit');
    expect(a.outcome?.winnerSeat).toBe(0);
    expect(a.state).toBe('ended');
    expect(server.payouts).toEqual([{ matchId: expect.any(String), userId: 'alice', amount: 20 }]);
  });

  it('a guest that stops sending input forfeits (stall)', async () => {
    const { clock, a, b } = await playing();
    let t = 0;
    await run(clock, 11_000, [a, b], () => a.sendSnapshot(encodeSnapshot(snap(++t))));
    expect(a.outcome?.status).toBe('forfeit');
    expect(a.outcome?.reason).toBe('guest_stalled');
    expect(a.outcome?.paid).toEqual({});
  });

  it('a quick quit forfeits unpaid', async () => {
    const { clock, server, a, b } = await playing();
    b.forfeit();
    await run(clock, 300, [a, b]);
    expect(a.outcome?.status).toBe('forfeit');
    expect(a.outcome?.paid).toEqual({});
    expect(server.payouts).toHaveLength(0);
  });

  it('a version mismatch cancels before START; leaving the queue cancels', async () => {
    const { clock, a, mk } = setup();
    const old = mk('carol', '0');
    void a.quickMatch();
    void old.quickMatch();
    await run(clock, 500, [a, old]);
    expect(a.state).toBe('ended');
    expect(a.endReason).toBe('version_mismatch');
    const lone = mk('dave');
    void lone.quickMatch();
    await flush();
    lone.leave();
    expect(lone.state).toBe('ended');
    expect(lone.endReason).toBe('left');
  });

  it('private rooms: create, join by code (any case), bad and unknown codes', async () => {
    const { clock, a, b, mk } = setup();
    const code = await a.createRoom();
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    expect(a.state).toBe('hosting-room');
    void b.joinRoom(code!.toLowerCase());
    await run(clock, 500, [a, b]);
    expect(a.state).toBe('playing');
    expect(b.state).toBe('playing');
    const c = mk('erin');
    await c.joinRoom('nope');
    expect(c.endReason).toBe('bad_code');
    const d = mk('frank');
    await d.joinRoom('ZZZZZZ');
  expect(d.endReason).toBe('room_not_found');
  expect(OP.HELLO).toBe(1);
  });
});

/** Coarser than `run`: enough for accept, result, and rematch clocks. */
async function settle(clock: ManualScheduler, ms: number, sessions: OnlineSession[]) {
  const step = 100;
  for (let t = 0; t < ms; t += step) {
    clock.advance(Math.min(step, ms - t));
    for (const s of sessions) s.update();
    await flush();
  }
}

function watch(s: OnlineSession) {
  const states: SessionState[] = [];
  let playing = 0;
  let outcomes = 0;
  s.on('state', (st) => {
    states.push(st);
    if (st === 'playing') playing++;
  });
  s.on('outcome', () => { outcomes++; });
  return { states, playing: () => playing, outcomes: () => outcomes };
}

function ends(server: FakeArenaServer, userId: string) {
  const match = [...server.matches].reverse().find((m) => m.players.some((p) => p.user.userId === userId && p.link));
  const player = match?.players.find((p) => p.user.userId === userId);
  const serverEnd = player?.link;
  if (!match || !serverEnd?.peer) throw new Error(`no link for ${userId}`);
  return { match, serverEnd, clientEnd: serverEnd.peer };
}

function tap(link: LoopbackTransport): number[] {
  const ops: number[] = [];
  const send = link.send.bind(link);
  link.send = (op: number, data: string) => {
    ops.push(op);
    send(op, data);
  };
  return ops;
}

const matchIds = (server: FakeArenaServer) => new Set(server.matches.map((m) => m.id));

async function accepting() {
  const env = setup();
  const { clock, a, b } = env;
  const seen = new Set<SessionState>();
  const note = (st: SessionState) => { seen.add(st); };
  a.on('state', note);
  b.on('state', note);
  void a.quickMatch();
  void b.quickMatch();
  await flush();
  await run(clock, 300, [a, b]);
  expect(a.state).toBe('accepting');
  expect(b.state).toBe('accepting');
  return { ...env, seen };
}

const AGREED: ResultMsg = { winnerSeat: 0, wins: [2, 0], rounds: 2 };

function profile(ranked: boolean): InitResult {
  return { playerId: 'player-1', ranked, relics: [], effects: {}, ticketsCapLeft: 100, serverTime: 0 };
}

function fakeApi(): HubSdk {
  const api: HubSdk = {
    init: vi.fn(async (): Promise<InitResult> => profile(false)),
    reportEvent: vi.fn(async (): Promise<EventResult> => ({})),
    earnTickets: vi.fn(async () => ({ balance: 20, capped: false })),
    exchange: vi.fn(async () => ({ verse: 1, ticketsLeft: 10, balance: 10, receiptId: 'rcpt' })),
    submitScore: vi.fn(async () => {}),
    redeemTicket: vi.fn(),
    spendTickets: vi.fn(),
    sellItem: vi.fn(),
    getTicketBalance: vi.fn(),
    exit: vi.fn(),
  };
  return api;
}

const calls = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.calls;

/** What App does with an online outcome, plus the duel-win reporter fed mode 'online'. */
async function charge(link: HubLink, outcome: OutcomeMsg, toast: (title: string, sub: string) => void) {
  await link.onOnlineOutcome(outcome, 'alice', toast);
  await link.onDuelWin({
    mode: 'online',
    playerWon: outcome.winnerSeat === 0,
    bossId: 'tinubu',
    godMode: false,
    elapsed: 40,
  }, toast);
}

async function verified(env: ReturnType<typeof setup>, winnerSeat: 0 | 1) {
  const { clock, a, b } = env;
  const wins: [number, number] = winnerSeat === 0 ? [2, 0] : [0, 2];
  const mid: [number, number] = winnerSeat === 0 ? [1, 0] : [0, 1];
  await settle(clock, 16_000, [a, b]);
  expect(a.state).toBe('playing');
  expect(a.isHost).toBe(true);
  a.sendRound({ round: 1, winnerSeat, reason: 'ko', wins: mid });
  await settle(clock, 3_000, [a, b]);
  a.sendRound({ round: 2, winnerSeat, reason: 'time', wins });
  const result: ResultMsg = { winnerSeat, wins, rounds: 2 };
  a.sendResult(result);
  b.sendResult(result);
  await settle(clock, 400, [a, b]);
  return result;
}

describe('accept, decline, or timeout', () => {
  it('a decline before playing never starts and never posts a result, score, or boss_defeated', async () => {
    const { clock, server, a, b, seen } = await accepting();
    const api = fakeApi();
    const link = new HubLink(api);
    link.attach(profile(true));
    const notes: string[] = [];
    const toast = (title: string, sub: string) => notes.push(`${title}|${sub}`);
    const posted: OutcomeMsg[] = [];
    for (const s of [a, b]) {
      s.on('outcome', (o) => {
        posted.push(o);
        void charge(link, o, toast);
      });
    }
    const wire = tap(ends(server, 'alice').clientEnd);
    tap(ends(server, 'bob').clientEnd);
    a.accept();
    a.sendResult(AGREED);
    a.sendRound({ round: 1, winnerSeat: 0, reason: 'ko', wins: [1, 0] });
    b.decline();
    await settle(clock, 500, [a, b]);
    a.sendResult(AGREED);
    b.sendResult(AGREED);
    await flush();

    expect(seen.has('playing')).toBe(false);
    expect(a.state).toBe('ended');
    expect(b.state).toBe('ended');
    expect(a.endReason).toBe('declined');
    expect(b.endReason).toBe('declined');
    expect(posted).toEqual([]);
    expect(wire.filter((op) => op === OP.RESULT || op === OP.ROUND)).toEqual([]);
    expect(server.payouts).toEqual([]);
    const match = server.matches[0];
    expect(match?.outcome ?? null).toBeNull();
    expect(match?.results ?? [null, null]).toEqual([null, null]);
    expect(calls(api.earnTickets)).toEqual([]);
    expect(calls(api.reportEvent)).toEqual([]);
    expect(calls(api.reportEvent).some((c) => c[0] === TINUBU_EVENT)).toBe(false);
    expect(calls(api.submitScore)).toEqual([]);
    expect(notes.filter((n) => /ticket/i.test(n))).toEqual([]);
  });

  it('an accept timeout before playing never starts and never posts a result, score, or boss_defeated', async () => {
    const { clock, server, a, b, seen } = await accepting();
    const api = fakeApi();
    const link = new HubLink(api);
    link.attach(profile(true));
    const notes: string[] = [];
    const toast = (title: string, sub: string) => notes.push(`${title}|${sub}`);
    const posted: OutcomeMsg[] = [];
    for (const s of [a, b]) {
      s.on('outcome', (o) => {
        posted.push(o);
        void charge(link, o, toast);
      });
    }
    const wire = tap(ends(server, 'alice').clientEnd);
    a.accept();
    a.sendResult(AGREED);
    await settle(clock, 11_000, [a, b]);
    a.sendResult(AGREED);
    b.sendResult(AGREED);
    await flush();

    expect(seen.has('playing')).toBe(false);
    expect(a.state).toBe('ended');
    expect(b.state).toBe('ended');
    expect(a.endReason).toBe('accept_timeout');
    expect(b.endReason).toBe('accept_timeout');
    expect(posted).toEqual([]);
    expect(wire.filter((op) => op === OP.RESULT)).toEqual([]);
    expect(server.payouts).toEqual([]);
    const match = server.matches[0];
    expect(match?.outcome ?? null).toBeNull();
    expect(match?.results ?? [null, null]).toEqual([null, null]);
    expect(calls(api.earnTickets)).toEqual([]);
    expect(calls(api.reportEvent)).toEqual([]);
    expect(calls(api.submitScore)).toEqual([]);
    expect(notes.filter((n) => /ticket/i.test(n))).toEqual([]);
  });
});

describe('rematch', () => {
  it('yes and yes gives exactly one new match', async () => {
    const env = await playing();
    const { clock, server, a, b } = env;
    b.forfeit();
    await settle(clock, 400, [a, b]);
    expect(a.state).toBe('rematch');
    expect(b.state).toBe('rematch');
    const before = matchIds(server);
    let playsA = 0;
    let playsB = 0;
    a.on('state', (st) => { if (st === 'playing') playsA++; });
    b.on('state', (st) => { if (st === 'playing') playsB++; });
    a.rematch(true);
    b.rematch(true);
    await settle(clock, 1_000, [a, b]);
    const created = [...matchIds(server)].filter((id) => !before.has(id));
    expect(created).toHaveLength(1);
    expect(a.state).toBe('playing');
    expect(b.state).toBe('playing');
    expect(playsA).toBe(1);
    expect(playsB).toBe(1);
    await settle(clock, 500, [a, b]);
    expect([...matchIds(server)].filter((id) => !before.has(id))).toEqual(created);
  });

  it('a double yes from the local seat sends REMATCH once or is idempotent, and never starts two matches', async () => {
    const env = await playing();
    const { clock, server, a, b } = env;
    b.forfeit();
    await settle(clock, 400, [a, b]);
    expect(a.state).toBe('rematch');
    const before = matchIds(server);
    const ops = tap(ends(server, 'alice').clientEnd);
    const sentBefore = ops.filter((op) => op === OP.REMATCH).length;
    a.rematch(true);
    a.rematch(true);
    const sent = ops.filter((op) => op === OP.REMATCH).length - sentBefore;
    await settle(clock, 400, [a, b]);
    const early = [...matchIds(server)].filter((id) => !before.has(id));
    expect(early).toHaveLength(0);
    b.rematch(true);
    await settle(clock, 1_000, [a, b]);
    const created = [...matchIds(server)].filter((id) => !before.has(id));
    expect(created).toHaveLength(1);
    expect(sent === 1 || early.length === 0).toBe(true);
    expect(a.state).toBe('playing');
    expect(b.state).toBe('playing');
  });

  it('no goes back to the lobby with no new match', async () => {
    const env = await playing();
    const { clock, server, a, b } = env;
    b.forfeit();
    await settle(clock, 400, [a, b]);
    const before = matchIds(server);
    a.rematch(false);
    await settle(clock, 400, [a, b]);
    expect(a.state).toBe('ended');
    expect(b.state).toBe('ended');
    expect(a.endReason).toBe('declined');
    expect(b.endReason).toBe('declined');
    expect(a.rematchState).toMatchObject({ phase: 'closed', reason: 'declined', next: 'lobby' });
    expect(b.rematchState).toMatchObject({ phase: 'closed', reason: 'declined', next: 'lobby' });
    expect([...matchIds(server)].filter((id) => !before.has(id))).toEqual([]);
    expect(a.state).not.toBe('playing');
  });

  it('timeout goes back to the lobby with no new match', async () => {
    const env = await playing();
    const { clock, server, a, b } = env;
    b.forfeit();
    await settle(clock, 400, [a, b]);
    expect(a.state).toBe('rematch');
    const before = matchIds(server);
    await settle(clock, 17_000, [a, b]);
    expect(a.state).toBe('ended');
    expect(b.state).toBe('ended');
    expect(a.endReason).toBe('rematch_timeout');
    expect(b.endReason).toBe('rematch_timeout');
    expect(a.rematchState).toMatchObject({ phase: 'closed', reason: 'rematch_timeout', next: 'lobby' });
    expect([...matchIds(server)].filter((id) => !before.has(id))).toEqual([]);
  });
});

describe('online never earns', () => {
  it('quick-match win, loss, forfeit, and a rematch win do not earn, report, or toast', async () => {
    expect(ONLINE.kind).toBe('online');
    expect(ONLINE.reportToHub).toBe(false);
    const api = fakeApi();
    const link = new HubLink(api);
    link.attach(profile(true));
    const notes: string[] = [];
    const toast = (title: string, sub: string) => notes.push(`${title}|${sub}`);
    await link.onDuelWin({ mode: 'quick', playerWon: true, bossId: null, godMode: false, elapsed: 12 }, toast);
    const scoreBefore = calls(api.submitScore).map((c) => [...c]);
    expect(scoreBefore).toHaveLength(1);
    const quiet = () => {
      expect(calls(api.earnTickets)).toEqual([]);
      expect(calls(api.reportEvent)).toEqual([]);
      expect(calls(api.reportEvent).some((c) => c[0] === TINUBU_EVENT)).toBe(false);
      expect(calls(api.submitScore)).toEqual(scoreBefore);
      expect(notes.filter((n) => /ticket/i.test(n))).toEqual([]);
    };

    const win = await playing();
    await verified(win, 0);
    expect(win.a.outcome?.status).toBe('verified');
    expect(win.a.outcome?.winnerSeat).toBe(0);
    expect(win.a.outcome?.paid).toEqual({ alice: 20 });
    await charge(link, win.a.outcome!, toast);
    quiet();

    const loss = await playing();
    await verified(loss, 1);
    expect(loss.a.outcome?.status).toBe('verified');
    expect(loss.a.outcome?.winnerSeat).toBe(1);
    await charge(link, loss.a.outcome!, toast);
    quiet();

    const forfeited = await playing();
    forfeited.b.forfeit();
    await settle(forfeited.clock, 400, [forfeited.a, forfeited.b]);
    expect(forfeited.a.outcome?.status).toBe('forfeit');
    expect(forfeited.a.outcome?.winnerSeat).toBe(0);
    await charge(link, forfeited.a.outcome!, toast);
    quiet();

    const before = matchIds(forfeited.server);
    forfeited.a.rematch(true);
    forfeited.b.rematch(true);
    await settle(forfeited.clock, 1_000, [forfeited.a, forfeited.b]);
    expect([...matchIds(forfeited.server)].filter((id) => !before.has(id))).toHaveLength(1);
    expect(forfeited.a.state).toBe('playing');
    await verified(forfeited, 0);
    expect(forfeited.a.outcome?.status).toBe('verified');
    expect(forfeited.a.outcome?.winnerSeat).toBe(0);
    expect(forfeited.a.outcome?.paid).toEqual({ alice: 20 });
    await charge(link, forfeited.a.outcome!, toast);
    quiet();
  }, 30_000);
});

describe('replayed match messages', () => {
  it('a duplicate ACCEPT, START, or RESULT never plays twice or handles the result twice', async () => {
    const env = setup();
    const { clock, server, a, b } = env;
    const aliceWatch = watch(a);
    const bobWatch = watch(b);
    void a.quickMatch();
    void b.quickMatch();
    await flush();
    await run(clock, 300, [a, b]);
    const alice = ends(server, 'alice');
    const bob = ends(server, 'bob');
    alice.serverEnd.send(OP.ACCEPT, JSON.stringify({ v: '2', staff: 'duel_staff_moonward' }));
    alice.serverEnd.send(OP.ACCEPT, JSON.stringify({ v: '2', staff: 'duel_staff_moonward' }));
    a.accept();
    a.accept();
    b.accept();
    b.accept();
    await run(clock, 500, [a, b]);
    expect(a.state).toBe('playing');
    expect(b.state).toBe('playing');
    expect(aliceWatch.playing()).toBe(1);
    expect(bobWatch.playing()).toBe(1);

    const startBody = JSON.stringify({
      seat: a.start!.seat, hostSeat: a.start!.hostSeat, names: a.start!.names, staffs: a.start!.staffs, rules: 'online1', seed: a.start!.seed,
    });
    alice.serverEnd.send(OP.START, startBody);
    alice.serverEnd.send(OP.START, startBody);
    bob.serverEnd.send(OP.START, JSON.stringify({ ...a.start, seat: b.seat }));
    alice.serverEnd.send(OP.RESULT, JSON.stringify(AGREED));
    await run(clock, 200, [a, b]);
    expect(aliceWatch.playing()).toBe(1);
    expect(bobWatch.playing()).toBe(1);
    expect(aliceWatch.outcomes()).toBe(0);

    a.sendResult(AGREED);
    a.sendResult(AGREED);
    alice.clientEnd.send(OP.RESULT, JSON.stringify(AGREED));
    b.sendResult(AGREED);
    b.sendResult(AGREED);
    await run(clock, 400, [a, b]);
    const pays = server.payouts.length;
    expect(a.outcome).not.toBeNull();
    expect(aliceWatch.outcomes()).toBe(1);
    expect(bobWatch.outcomes()).toBe(1);
    expect(server.payouts).toHaveLength(pays);

    alice.serverEnd.send(OP.ACCEPT, '{}');
    alice.serverEnd.send(OP.RESULT, JSON.stringify(AGREED));
    bob.serverEnd.send(OP.RESULT, JSON.stringify(AGREED));
    alice.clientEnd.send(OP.RESULT, JSON.stringify(AGREED));
    await run(clock, 300, [a, b]);
    expect(aliceWatch.outcomes()).toBe(1);
    expect(bobWatch.outcomes()).toBe(1);
    expect(server.payouts).toHaveLength(pays);
    expect(aliceWatch.playing()).toBe(1);
    expect(a.state).toBe('rematch');
    expect(b.state).toBe('rematch');

    alice.serverEnd.send(OP.START, startBody);
    bob.serverEnd.send(OP.START, JSON.stringify({
      seat: b.start!.seat, hostSeat: b.start!.hostSeat, names: b.start!.names, staffs: b.start!.staffs, rules: 'online1', seed: b.start!.seed,
    }));
    await run(clock, 300, [a, b]);
    expect.soft(aliceWatch.playing()).toBe(1);
    expect.soft(bobWatch.playing()).toBe(1);
    expect.soft(aliceWatch.outcomes()).toBe(1);
    expect.soft(bobWatch.outcomes()).toBe(1);
    expect.soft(a.state).not.toBe('playing');
    expect.soft(b.state).not.toBe('playing');
  });

  it('honors the new match START in pre-play and ignores a START for the old match', async () => {
    const { clock, server, a, b } = await playing();
    const oldId = server.matches[0].id;
    const oldStart = JSON.stringify({
      seat: a.start!.seat, hostSeat: a.start!.hostSeat, names: a.start!.names, staffs: a.start!.staffs,
      rules: 'online1', seed: 111, matchId: oldId,
    });
    b.forfeit();
    await settle(clock, 400, [a, b]);
    expect(a.state).toBe('rematch');
    const oldLink = ends(server, 'alice');
    let plays = 0;
    let nextMatch = '';
    const phases: SessionState[] = [];
    a.on('state', (st) => {
      phases.push(st);
      if (st === 'playing') plays++;
    });
    a.on('rematch', (m) => { if (m.phase === 'started') nextMatch = m.matchId; });

    oldLink.serverEnd.send(OP.START, oldStart);
    await settle(clock, 200, [a, b]);
    expect(a.state).toBe('rematch');
    expect(plays).toBe(0);

    a.rematch(true);
    b.rematch(true);
    let sawPrePlay = false;
    for (let i = 0; i < 90 && a.state !== 'playing'; i++) {
      if (a.state === 'starting') {
        sawPrePlay = true;
        oldLink.serverEnd.send(OP.START, oldStart);
      }
      clock.advance(TICK);
      a.update();
      b.update();
      await flush();
    }

    expect(sawPrePlay).toBe(true);
    expect(phases).toContain('starting');
    expect(plays).toBe(1);
    expect(a.state).toBe('playing');
    expect(b.state).toBe('playing');
    expect(nextMatch).not.toBe('');
    expect(nextMatch).not.toBe(oldId);
    expect(server.matches.some((m) => m.id === nextMatch && m.phase === 'playing')).toBe(true);
    expect(a.start?.seed).toBe(1234);

    ends(server, 'alice').serverEnd.send(OP.START, oldStart);
    await settle(clock, 200, [a, b]);
    expect(plays).toBe(1);
    expect(a.state).toBe('playing');
    expect(a.start?.seed).toBe(1234);
  });
});
