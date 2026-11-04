/**
 * An in-memory stand-in for the hub's `sproto_arena` match (metaverse-hub
 * server/modules/src/games/sproto_arena.ts), for unit tests and the `?netsim=` dev mode. It runs the
 * same referee rules on loopback links: HELLO/START, the INPUT (guest→host) and SNAPSHOT
 * (host→guest) relay, ROUND bookkeeping, RESULT agreement, forfeits on leave or FORFEIT, PING echo,
 * join timeout and version cancel. Payouts are recorded, not real (no pair/day caps here).
 */
import {
  asResult, asRound, normalizeStaff, NET_VERSION, OP, parseJson, roomCode,
  type OutcomeMsg, type ResultMsg, type RoundMsg,
} from './protocol';
import type { OnlineLobby } from './OnlineSession';
import { loopbackPair, type LinkOptions, type LoopbackTransport, type NetPeer, type NetTransport, type Scheduler } from './transport';

export const ARENA = {
  TICK_RATE: 30,
  JOIN_TIMEOUT_S: 30,
  RECONNECT_S: 10,
  STALL_S: 10,
  MAX_PLAY_S: 8 * 60,
  MIN_PLAY_S: 15,
  LINGER_S: 2,
  RESULT_WAIT_S: 5,
  ROUNDS_TO_WIN: 2,
  WIN_TICKETS: 20,
} as const;

interface Player {
  user: NetPeer;
  /** Server side of this player's link (null while disconnected). */
  link: LoopbackTransport | null;
  hello: boolean;
  staff: string;
  leftTick: number | null;
}

export class FakeArenaMatch {
  readonly id: string;
  players: Player[] = [];
  phase: 'joining' | 'playing' | 'done' = 'joining';
  hostSeat: 0 | 1;
  tick = 0;
  startedTick = -1;
  lastInputTick = 0;
  lastSnapTick = 0;
  readonly rounds: (RoundMsg & { tick: number })[] = [];
  implausible = false;
  readonly results: (ResultMsg | null)[] = [null, null];
  firstResultTick = -1;
  outcome: OutcomeMsg | null = null;
  doneTick = -1;
  /** Relayed message counts (tests). */
  readonly relayed = { input: 0, snapshot: 0, dropped: 0 };

  constructor(
    private readonly server: FakeArenaServer,
    readonly code: string,
    readonly isPrivate: boolean,
    hostSeat: 0 | 1,
  ) {
    this.id = `fake-${server.nextId++}`;
    this.hostSeat = hostSeat;
  }

  seatOf(userId: string): number {
    return this.players.findIndex((p) => p.user.userId === userId);
  }

  /** A client joins (or re-joins) this match: returns its end of a new link. */
  connect(user: NetPeer, linkOpts: LinkOptions): NetTransport | null {
    if (this.phase === 'done') return null;
    let seat = this.seatOf(user.userId);
    if (seat < 0) {
      if (this.players.length >= 2 || (this.phase !== 'joining')) return null;
      this.players.push({ user, link: null, hello: false, staff: 'duel_staff_sproto', leftTick: null });
      seat = this.players.length - 1;
    }
    const p = this.players[seat];
    const [client, serverEnd] = loopbackPair(this.server.scheduler, linkOpts, user, null);
    p.link = serverEnd;
    const wasAway = p.leftTick !== null;
    p.leftTick = null;
    serverEnd.onMessage((op, data) => this.onMessage(seat, op, data));
    serverEnd.onPresence((e) => {
      if (e.leaves.some((l) => l.userId === user.userId) && p.link === serverEnd) this.onLeave(seat);
    });
    if (wasAway && this.phase === 'playing') {
      this.sendTo(1 - seat, OP.PEER, { seat, present: true, graceS: 0 });
      this.sendStart(seat);
    }
    return client;
  }

  private onLeave(seat: number): void {
    const p = this.players[seat];
    p.link = null;
    p.leftTick = this.tick;
    if (this.phase === 'joining') {
      this.cancel('opponent_left');
      return;
    }
    if (this.phase === 'playing') this.sendTo(1 - seat, OP.PEER, { seat, present: false, graceS: ARENA.RECONNECT_S });
  }

  private sendTo(seat: number, op: number, body: unknown): void {
    this.players[seat]?.link?.send(op, typeof body === 'string' ? body : JSON.stringify(body));
  }

  private broadcast(op: number, body: unknown): void {
    for (let i = 0; i < this.players.length; i++) this.sendTo(i, op, body);
  }

  private sendStart(seat: number): void {
    const names = this.players.map((p) => p.user.username) as [string, string];
    const staffs = this.players.map((p) => p.staff) as [string, string];
    this.sendTo(seat, OP.START, { seat, hostSeat: this.hostSeat, names, staffs, rules: 'online1', seed: 1234 });
  }

  private onMessage(seat: number, op: number, data: string): void {
    if (this.phase === 'done') return;
    switch (op) {
      case OP.HELLO: {
        const m = parseJson(data) as { v?: unknown; staff?: unknown } | null;
        if (!m || m.v !== NET_VERSION) {
          this.cancel('version_mismatch', seat);
          return;
        }
        this.players[seat].hello = true;
        this.players[seat].staff = normalizeStaff(m.staff);
        return;
      }
      case OP.INPUT:
        if (this.phase !== 'playing' || seat === this.hostSeat || data.length > 2048) return void this.relayed.dropped++;
        this.lastInputTick = this.tick;
        this.relayed.input++;
        this.sendTo(this.hostSeat, OP.INPUT, data);
        return;
      case OP.SNAPSHOT:
        if (this.phase !== 'playing' || seat !== this.hostSeat || data.length > 8192) return void this.relayed.dropped++;
        this.lastSnapTick = this.tick;
        this.relayed.snapshot++;
        this.sendTo(1 - this.hostSeat, OP.SNAPSHOT, data);
        return;
      case OP.ROUND: {
        if (this.phase !== 'playing' || seat !== this.hostSeat) return;
        const r = asRound(parseJson(data));
        if (!r) return;
        const prev = this.rounds[this.rounds.length - 1];
        const wins = prev ? [...prev.wins] : [0, 0];
        if (r.winnerSeat !== null) wins[r.winnerSeat]++;
        const sinceTicks = this.tick - (prev ? prev.tick : this.startedTick);
        if (r.round !== this.rounds.length + 1 || wins[0] !== r.wins[0] || wins[1] !== r.wins[1] || sinceTicks < 2 * ARENA.TICK_RATE) this.implausible = true;
        this.rounds.push({ ...r, tick: this.tick });
        return;
      }
      case OP.RESULT: {
        if (this.phase !== 'playing') return;
        const r = asResult(parseJson(data));
        if (!r || this.results[seat]) return;
        this.results[seat] = r;
        if (this.firstResultTick < 0) this.firstResultTick = this.tick;
        if (this.results[0] && this.results[1]) this.decide();
        return;
      }
      case OP.PING: {
        const m = parseJson(data) as { c?: unknown } | null;
        if (m && typeof m.c === 'number') this.sendTo(seat, OP.PING, { c: m.c, s: this.tick });
        return;
      }
      case OP.FORFEIT:
        if (this.phase === 'playing') this.finish('forfeit', (1 - seat) as 0 | 1, 'forfeit');
        return;
      default:
        return;
    }
  }

  private elapsedS(): number {
    return this.startedTick < 0 ? 0 : (this.tick - this.startedTick) / ARENA.TICK_RATE;
  }

  private decide(): void {
    const [a, b] = this.results as [ResultMsg, ResultMsg];
    const same = a.winnerSeat === b.winnerSeat && a.wins[0] === b.wins[0] && a.wins[1] === b.wins[1] && a.rounds === b.rounds;
    if (!same) return this.finish('disputed', null, 'results_differ');
    if (a.winnerSeat === null) return this.finish('draw', null, 'draw');
    const last = this.rounds[this.rounds.length - 1];
    const consistent = !this.implausible && a.wins[a.winnerSeat] === ARENA.ROUNDS_TO_WIN && a.rounds === this.rounds.length &&
      !!last && last.wins[0] === a.wins[0] && last.wins[1] === a.wins[1];
    if (!consistent || this.elapsedS() < ARENA.MIN_PLAY_S) return this.finish('disputed', null, 'implausible');
    this.finish('verified', a.winnerSeat, 'agreed');
  }

  private finish(status: OutcomeMsg['status'], winnerSeat: 0 | 1 | null, reason: string): void {
    if (this.phase === 'done') return;
    const paid: Record<string, number> = {};
    const pays = status === 'verified' || (status === 'forfeit' && this.elapsedS() >= ARENA.MIN_PLAY_S && this.rounds.length >= 1);
    if (pays && winnerSeat !== null) {
      const uid = this.players[winnerSeat].user.userId;
      paid[uid] = ARENA.WIN_TICKETS;
      this.server.payouts.push({ matchId: this.id, userId: uid, amount: ARENA.WIN_TICKETS });
    }
    this.outcome = { status, winnerSeat, reason, paid };
    this.broadcast(OP.OUTCOME, this.outcome);
    this.phase = 'done';
    this.doneTick = this.tick;
  }

  private cancel(reason: string, seat?: number): void {
    this.broadcast(OP.CANCEL, { reason, seat });
    this.phase = 'done';
    this.doneTick = this.tick;
  }

  /** One server tick (30 Hz). Returns false once the match has ended and lingered. */
  loop(): boolean {
    this.tick++;
    const T = ARENA.TICK_RATE;
    if (this.phase === 'done') {
      if (this.tick - this.doneTick >= ARENA.LINGER_S * T) {
        for (const p of this.players) p.link?.close('ended');
        return false;
      }
      return true;
    }
    if (this.phase === 'joining') {
      if (this.players.length === 2 && this.players.every((p) => p.link && p.hello)) {
        this.phase = 'playing';
        this.startedTick = this.lastInputTick = this.lastSnapTick = this.tick;
        this.sendStart(0);
        this.sendStart(1);
      } else if (this.tick > (this.isPrivate && this.players.length < 2 ? 300 : ARENA.JOIN_TIMEOUT_S) * T) {
        this.cancel('join_timeout');
      }
      return true;
    }
    // Playing: leaves past the grace, stalls, the play cap, a lone result.
    const away = this.players.map((p) => p.leftTick !== null && this.tick - p.leftTick > ARENA.RECONNECT_S * T);
    if (away[0] && away[1]) this.finish('both_left', null, 'both_left');
    else if (away[0] || away[1]) this.finish('forfeit', (away[0] ? 1 : 0) as 0 | 1, 'left');
    else if (this.players.every((p) => p.link)) {
      const guest = 1 - this.hostSeat;
      if (this.tick - this.lastInputTick > ARENA.STALL_S * T && this.tick - this.lastSnapTick <= T) this.finish('forfeit', this.hostSeat, 'guest_stalled');
      else if (this.tick - this.lastSnapTick > ARENA.STALL_S * T && this.tick - this.lastInputTick <= T) this.finish('forfeit', guest as 0 | 1, 'host_stalled');
    }
    if (this.phase === 'playing' && this.elapsedS() > ARENA.MAX_PLAY_S) this.finish('timeout', null, 'max_play');
    if (this.phase === 'playing' && this.firstResultTick >= 0 && this.tick - this.firstResultTick > ARENA.RESULT_WAIT_S * T) {
      const missing = this.results[0] ? 1 : 0;
      if (this.players[missing].link === null) this.finish('forfeit', (1 - missing) as 0 | 1, 'left_before_result');
      else if (this.tick - this.firstResultTick > 3 * ARENA.RESULT_WAIT_S * T) this.finish('disputed', null, 'no_result');
    }
    return true;
  }
}

/** Matchmaking, rooms and the match loop for any number of FakeArenaMatches. */
export class FakeArenaServer {
  nextId = 1;
  readonly matches: FakeArenaMatch[] = [];
  readonly payouts: { matchId: string; userId: string; amount: number }[] = [];
  private queue: { user: NetPeer; resolve: (t: NetTransport) => void }[] = [];
  private running = false;
  /** Host seat for the next match (tests pin it; default alternates). */
  nextHostSeat: 0 | 1 | null = null;
  private flip: 0 | 1 = 0;

  constructor(
    readonly scheduler: Scheduler,
    readonly link: LinkOptions = {},
  ) {}

  private hostSeat(): 0 | 1 {
    if (this.nextHostSeat !== null) return this.nextHostSeat;
    this.flip = (1 - this.flip) as 0 | 1;
    return this.flip;
  }

  private create(code: string, isPrivate: boolean): FakeArenaMatch {
    const m = new FakeArenaMatch(this, code, isPrivate, this.hostSeat());
    this.matches.push(m);
    this.run();
    return m;
  }

  private run(): void {
    if (this.running) return;
    this.running = true;
    const step = () => {
      for (let i = this.matches.length - 1; i >= 0; i--) if (!this.matches[i].loop()) this.matches.splice(i, 1);
      if (this.matches.length) this.scheduler.at(this.scheduler.now() + 1000 / ARENA.TICK_RATE, step);
      else this.running = false;
    };
    this.scheduler.at(this.scheduler.now() + 1000 / ARENA.TICK_RATE, step);
  }

  /** The lobby a client of `user` sees. */
  lobby(user: NetPeer): OnlineLobby {
    const server = this;
    let waiting: ((t: NetTransport) => void) | null = null;
    return {
      selfId: user.userId,
      async connect() {},
      quickMatch() {
        return new Promise<NetTransport>((resolve) => {
          waiting = resolve;
          server.queue.push({ user, resolve });
          if (server.queue.length >= 2) {
            const [a, b] = server.queue.splice(0, 2);
            const m = server.create('', false);
            a.resolve(m.connect(a.user, server.link)!);
            b.resolve(m.connect(b.user, server.link)!);
          }
        });
      },
      async createRoom() {
        const m = server.create(roomCode(), true);
        return { code: m.code, transport: m.connect(user, server.link)! };
      },
      async joinRoom(code: string) {
        const m = server.matches.find((x) => x.isPrivate && x.code === code && x.phase === 'joining' && x.players.length < 2);
        if (!m) throw new Error('room_not_found');
        return m.connect(user, server.link)!;
      },
      cancel() {
        server.queue = server.queue.filter((q) => q.resolve !== waiting);
        waiting = null;
      },
    };
  }
}
