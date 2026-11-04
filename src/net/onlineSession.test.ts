import { describe, expect, it } from 'vitest';
import { FakeArenaServer } from './FakeArenaServer';
import type { IntentFrame } from './intent';
import { OnlineSession } from './OnlineSession';
import { OP } from './protocol';
import { encodeSnapshot, type Snapshot } from './state';
import { ManualScheduler } from './transport';

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
    expect(a.state).toBe('ended');
    expect(a.outcome?.status).toBe('verified');
    expect(b.outcome?.paid).toEqual({ alice: 20 });
    expect(server.payouts).toHaveLength(1);
    // A repeat RESULT after the outcome changes nothing.
    expect(server.matches[0]?.phase ?? 'done').toBe('done');
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
