/**
 * One online 1v1, from the menu to the outcome: idle → connecting → searching | hosting-room |
 * joining-room → accepting (quick match) → starting → playing → rematch → ended. Owns the match transport, the seat and host role,
 * the host's RemoteInputBuffer and the guest's SnapshotBuffer, PING/RTT, the opponent's presence
 * and the RESULT → OUTCOME handshake. Pure (no DOM, no Game): App wires it to the game.
 */
import { packFrames, unpackFrames, type IntentFrame } from './intent';
import {
  asAcceptEnd, asCancel, asFound, asInput, asOutcome, asPeer, asPing, asRematchState, asStart, NET_VERSION, normalizeRoomCode, OP, parseJson,
  type AcceptEndMsg, type FoundMsg, type OnlineCount, type OutcomeMsg, type PeerMsg, type RematchStateMsg, type ResultMsg, type RoundMsg, type StartMsg,
} from './protocol';
import { RemoteInputBuffer } from './RemoteInputBuffer';
import { SnapshotBuffer } from './SnapshotBuffer';
import { decodeSnapshot, SnapshotVersionError, type EncodedSnapshot, type Snapshot } from './state';
import type { NetTransport, Scheduler, Unsubscribe } from './transport';

export type SessionState = 'idle' | 'connecting' | 'searching' | 'hosting-room' | 'joining-room' | 'accepting' | 'starting' | 'playing' | 'rematch' | 'ended';

/** Matchmaking and rooms: the hub realtime client (HubLobby) or FakeArenaServer's lobby. */
export interface OnlineLobby {
  readonly selfId: string | null;
  connect(): Promise<void>;
  /** Resolves once matched and joined. Quick matches then wait for ACCEPT. */
  quickMatch(): Promise<NetTransport>;
  createRoom(): Promise<{ code: string; transport: NetTransport }>;
  /** Rejects with 'room_not_found' / 'version_mismatch'. */
  joinRoom(code: string): Promise<NetTransport>;
  /** Join a match id the server already created (a rematch). */
  joinMatch(matchId: string): Promise<NetTransport>;
  /** `sproto.online_count`. The caller polls at most every 10 s. */
  onlineCount(): Promise<OnlineCount>;
  /** Give up a pending quickMatch (Nakama MatchmakerRemove). */
  cancel(): void;
}

export interface SessionOptions {
  scheduler: Scheduler;
  /** Equipped staff (cosmetic online). */
  staff: string;
  version?: string;
  /** No START this long after joining → ended ('start_timeout'). */
  startTimeoutMs?: number;
  pingEveryMs?: number;
  inputDelayTicks: number;
  maxInputLagTicks: number;
  interpDelayMs: number;
  extrapolateMaxMs: number;
  /** Host sim tick (ms). */
  tickMs: number;
  /** Frames per INPUT message, the newest of which are new (the rest repeat for redundancy). */
  inputFramesPerMessage?: number;
  /** Guest ticks between INPUT messages. */
  inputEveryTicks?: number;
}

export interface SessionEvents {
  state: SessionState;
  start: StartMsg;
  snapshot: Snapshot;
  peer: PeerMsg;
  outcome: OutcomeMsg;
  cancel: string;
  rejoin: undefined;
  /** Quick-match accept window, including later updates as seats accept. */
  found: FoundMsg;
  /** Accept window closed. `next` is this seat's own step. */
  acceptEnd: AcceptEndMsg;
  rematch: RematchStateMsg;
}

export class OnlineSession {
  state: SessionState = 'idle';
  start: StartMsg | null = null;
  outcome: OutcomeMsg | null = null;
  /** Why it ended without an outcome: a CANCEL reason, 'start_timeout', 'disconnected', 'room_not_found'... */
  endReason: string | null = null;
  roomCode: string | null = null;
  /** Round-trip time (ms) from the last PING, -1 before one. */
  rttMs = -1;
  /** Quick-match accept window. Null outside one. */
  found: FoundMsg | null = null;
  /** This seat already sent ACCEPT. */
  youAccepted = false;
  /** This seat already sent REMATCH yes. */
  rematchYes = false;
  /** Rematch window after the outcome. Null until the server opens one. */
  rematchState: RematchStateMsg | null = null;
  /** The opponent is connected (PEER), and the seconds they have left to come back. */
  peerPresent = true;
  peerGraceS = 0;
  readonly remoteInput: RemoteInputBuffer;
  readonly snapshots: SnapshotBuffer;
  /** Snapshots that failed to decode (another version). */
  badSnapshots = 0;

  private transport: NetTransport | null = null;
  private subs: Unsubscribe[] = [];
  private startDeadline = Infinity;
  private nextPing = 0;
  /** Quick match (accept window) or a direct join (room / rematch, HELLO then START). */
  private joinKind: 'quick' | 'direct' = 'direct';
  /** Set while a rematch close is already being handled, so leave does not send a second No. */
  private rematchClosing = false;
  /** Match id we are already joining from REMATCH_STATE started. */
  private rematchMatchId = '';
  /** No REMATCH_STATE this long after the outcome: the window is not coming. */
  private rematchOpenDeadline = Infinity;
  /** Local copy of the server's rematch clock, plus a short grace before we give up. */
  private rematchClockEnd = Infinity;
  private readonly sentFrames: IntentFrame[] = [];
  private unsent = 0;
  private readonly listeners: { [K in keyof SessionEvents]?: ((v: SessionEvents[K]) => void)[] } = {};

  constructor(
    private readonly lobby: OnlineLobby,
    private readonly opts: SessionOptions,
  ) {
    this.remoteInput = new RemoteInputBuffer({ delay: opts.inputDelayTicks, maxLag: opts.maxInputLagTicks });
    this.snapshots = new SnapshotBuffer({ interpDelayMs: opts.interpDelayMs, extrapolateMaxMs: opts.extrapolateMaxMs, tickMs: opts.tickMs });
  }

  on<K extends keyof SessionEvents>(event: K, fn: (v: SessionEvents[K]) => void): Unsubscribe {
    const list = (this.listeners[event] ??= []) as ((v: SessionEvents[K]) => void)[];
    list.push(fn);
    return () => list.splice(list.indexOf(fn), 1);
  }

  private emit<K extends keyof SessionEvents>(event: K, v: SessionEvents[K]): void {
    for (const fn of [...((this.listeners[event] ?? []) as ((v: SessionEvents[K]) => void)[])]) fn(v);
  }

  private setState(s: SessionState): void {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }

  get seat(): number {
    return this.start?.seat ?? -1;
  }
  get hostSeat(): number {
    return this.start?.hostSeat ?? -1;
  }
  get isHost(): boolean {
    return this.start !== null && this.start.seat === this.start.hostSeat;
  }
  get active(): boolean {
    return this.state !== 'idle' && this.state !== 'ended';
  }

  /** Cosmetic staff for the next HELLO or ACCEPT. The results screen can change it before a rematch. */
  set staffId(id: string) {
    this.opts.staff = id;
  }

  async quickMatch(): Promise<void> {
    await this.begin('searching', 'quick', async () => this.lobby.quickMatch());
  }

  async createRoom(): Promise<string | null> {
    await this.begin('hosting-room', 'direct', async () => {
      const r = await this.lobby.createRoom();
      this.roomCode = r.code;
      return r.transport;
    });
    return this.roomCode;
  }

  async joinRoom(input: string): Promise<void> {
    const code = normalizeRoomCode(input);
    if (!code) {
      this.end('bad_code');
      return;
    }
    this.roomCode = code;
    await this.begin('joining-room', 'direct', async () => this.lobby.joinRoom(code));
  }

  private async begin(waiting: SessionState, kind: 'quick' | 'direct', open: () => Promise<NetTransport>): Promise<void> {
    if (this.active) return;
    this.reset();
    this.joinKind = kind;
    this.setState('connecting');
    try {
      await this.lobby.connect();
      if (this.state !== 'connecting') return;
      this.setState(waiting);
      const t = await open();
      if (this.state !== waiting) {
        // Cancelled while the matchmaker was pairing. Leaving an accept-phase match is a decline.
        if (kind === 'quick') t.send(OP.DECLINE, '{}');
        t.close();
        return;
      }
      this.attach(t);
    } catch (err) {
      if (this.active) this.end(errorCode(err));
    }
  }

  private reset(): void {
    this.start = this.outcome = null;
    this.endReason = this.roomCode = null;
    this.rttMs = -1;
    this.found = null;
    this.youAccepted = false;
    this.rematchYes = false;
    this.rematchState = null;
    this.rematchClosing = false;
    this.rematchMatchId = '';
    this.rematchOpenDeadline = Infinity;
    this.rematchClockEnd = Infinity;
    this.peerPresent = true;
    this.peerGraceS = 0;
    this.sentFrames.length = 0;
    this.unsent = 0;
    this.remoteInput.reset();
    this.snapshots.clear();
  }

  /** Drop the fight buffers but keep the session (a rematch joins a new match id). */
  private clearFight(): void {
    this.start = this.outcome = null;
    this.endReason = null;
    this.found = null;
    this.youAccepted = false;
    this.rematchYes = false;
    this.rematchState = null;
    this.peerPresent = true;
    this.peerGraceS = 0;
    this.sentFrames.length = 0;
    this.unsent = 0;
    this.badSnapshots = 0;
    this.remoteInput.reset();
    this.snapshots.clear();
  }

  /** Joined a match. Quick matches wait for FOUND / ACCEPT. Rooms and rematches say HELLO. */
  private attach(t: NetTransport): void {
    this.transport = t;
    this.subs.push(
      t.onMessage((op, data) => this.onMessage(op, data)),
      t.onPresence(() => {}),
      t.onRejoin(() => this.emit('rejoin', undefined)),
      t.onClose((reason) => {
        if (this.active) this.end(reason === 'ended' ? 'match_ended' : 'disconnected');
      }),
    );
    if (this.joinKind === 'quick') this.setState('accepting');
    else if (this.state !== 'hosting-room') this.setState('starting');
    this.startDeadline = this.opts.scheduler.now() + (this.opts.startTimeoutMs ?? 30_000);
    this.send(OP.HELLO, { v: this.opts.version ?? NET_VERSION, staff: this.opts.staff });
  }

  private detachTransport(): void {
    for (const u of this.subs) u();
    this.subs = [];
    const t = this.transport;
    this.transport = null;
    t?.close();
  }

  private send(op: number, body: unknown): void {
    this.transport?.send(op, typeof body === 'string' ? body : JSON.stringify(body));
  }

  private onMessage(op: number, data: string): void {
    const now = this.opts.scheduler.now();
    switch (op) {
      case OP.START: {
        const s = asStart(parseJson(data));
        if (!s) return;
        // START begins the match we are still waiting on: the accept window, a room, or the
        // new match joined after REMATCH_STATE started. A replay on a match that already
        // started (including one sitting in the rematch window) is not another fight.
        if (this.state !== 'accepting' && this.state !== 'starting' && this.state !== 'hosting-room' && this.state !== 'joining-room') return;
        const first = this.start === null;
        this.start = s;
        this.startDeadline = Infinity;
        this.setState('playing');
        if (first) this.emit('start', s);
        return;
      }
      case OP.SNAPSHOT: {
        if (this.isHost) return;
        let snap: Snapshot;
        try {
          snap = decodeSnapshot(parseJson(data) as EncodedSnapshot);
        } catch (err) {
          if (err instanceof SnapshotVersionError) this.badSnapshots++;
          return;
        }
        if (this.snapshots.push(snap, now)) this.emit('snapshot', snap);
        return;
      }
      case OP.INPUT: {
        if (!this.isHost) return;
        const m = asInput(parseJson(data));
        if (m) this.remoteInput.push(unpackFrames(m.f));
        return;
      }
      case OP.PEER: {
        const p = asPeer(parseJson(data));
        if (!p || p.seat === this.seat) return;
        this.peerPresent = p.present;
        this.peerGraceS = p.graceS;
        if (!p.present) this.remoteInput.clearHeld();
        this.emit('peer', p);
        return;
      }
      case OP.PING: {
        const p = asPing(parseJson(data));
        if (p) this.rttMs = Math.max(0, now - p.c);
        return;
      }
      case OP.OUTCOME: {
        const o = asOutcome(parseJson(data));
        if (!o) return;
        this.outcome = o;
        this.emit('outcome', o);
        // A shutdown, or a peer already gone, does not open a rematch window.
        if (o.status === 'server_shutdown' || !this.peerPresent) {
          this.end(o.status);
          return;
        }
        this.endReason = o.status;
        this.rematchOpenDeadline = now + 3_000;
        this.rematchClockEnd = Infinity;
        this.setState('rematch');
        return;
      }
      case OP.CANCEL: {
        const c = asCancel(parseJson(data));
        this.end(c?.reason ?? 'cancelled');
        return;
      }
      case OP.FOUND: {
        if (this.state !== 'accepting') return;
        const f = asFound(parseJson(data));
        if (!f) return;
        this.found = f;
        this.emit('found', f);
        return;
      }
      case OP.ACCEPT_END: {
        const m = asAcceptEnd(parseJson(data));
        if (!m) return;
        this.endReason = m.status;
        this.end(m.status, m);
        return;
      }
      case OP.REMATCH_STATE: {
        const m = asRematchState(parseJson(data));
        if (!m) return;
        this.rematchState = m;
        this.rematchOpenDeadline = Infinity;
        if (m.phase === 'open' || m.phase === 'offered') this.rematchClockEnd = now + m.waitS * 1000 + 1_500;
        if (m.phase === 'started') {
          this.rematchClockEnd = Infinity;
          void this.followRematch(m.matchId);
        } else if (m.phase === 'closed') {
          this.rematchClosing = true;
          this.rematchClockEnd = Infinity;
        }
        this.emit('rematch', m);
        if (m.phase === 'closed') this.end(m.reason);
        return;
      }
      default:
        return;
    }
  }

  /** Accept the quick-match window. Private rooms never call this. */
  accept(): void {
    if (this.state !== 'accepting' || this.youAccepted) return;
    this.youAccepted = true;
    this.send(OP.ACCEPT, { v: this.opts.version ?? NET_VERSION, staff: this.opts.staff });
    if (this.found) {
      const accepted: [boolean, boolean] = [...this.found.accepted];
      accepted[this.found.seat] = true;
      this.found = { ...this.found, accepted };
      this.emit('found', this.found);
    }
  }

  /** Decline the quick-match window. The server answers with ACCEPT_END. */
  decline(): void {
    if (this.state !== 'accepting') return;
    this.send(OP.DECLINE, {});
  }

  /** Yes or no to the rematch window. */
  rematch(yes: boolean): void {
    if (this.state !== 'rematch' || this.rematchClosing) return;
    this.send(OP.REMATCH, { yes });
    if (yes) this.rematchYes = true;
    else this.rematchClosing = true;
  }

  /** REMATCH_STATE started: leave the old match and HELLO into the new one. No accept window. */
  private async followRematch(matchId: string): Promise<void> {
    if (this.rematchMatchId) return;
    this.rematchMatchId = matchId;
    this.joinKind = 'direct';
    this.detachTransport();
    this.clearFight();
    this.setState('starting');
    try {
      const t = await this.lobby.joinMatch(matchId);
      if (this.state !== 'starting' || this.rematchMatchId !== matchId) {
        t.close();
        return;
      }
      this.attach(t);
    } catch (err) {
      if (this.active) this.end(errorCode(err));
    }
  }

  /** Call every frame: PINGs, the START timeout, and a local fallback if the rematch clock never closes. */
  update(nowMs = this.opts.scheduler.now()): void {
    if ((this.state === 'starting' || this.state === 'accepting') && nowMs > this.startDeadline) {
      this.end('start_timeout');
      return;
    }
    if (this.state === 'rematch' && !this.rematchClosing) {
      if (nowMs > this.rematchOpenDeadline || nowMs > this.rematchClockEnd) {
        this.rematchClosing = true;
        const reason = this.rematchState ? 'rematch_timeout' : (this.outcome?.status ?? 'rematch_timeout');
        const closed: RematchStateMsg = { phase: 'closed', reason: 'rematch_timeout', next: 'lobby', waitS: 0 };
        if (!this.rematchState || this.rematchState.phase === 'open' || this.rematchState.phase === 'offered') {
          this.rematchState = closed;
          this.emit('rematch', closed);
        }
        this.end(reason);
        return;
      }
    }
    if ((this.state === 'playing' || this.state === 'starting' || this.state === 'accepting' || this.state === 'rematch') && nowMs >= this.nextPing) {
      this.nextPing = nowMs + (this.opts.pingEveryMs ?? 1000);
      this.send(OP.PING, { c: nowMs });
    }
  }

  /**
   * Guest: one sampled intent frame per sim tick. Every `inputEveryTicks` ticks an INPUT goes out
   * with the newest frames, the last few repeated for redundancy.
   */
  queueInput(frame: IntentFrame): void {
    if (this.state !== 'playing' || this.isHost) return;
    this.sentFrames.push(frame);
    const per = this.opts.inputFramesPerMessage ?? 4;
    if (this.sentFrames.length > per) this.sentFrames.splice(0, this.sentFrames.length - per);
    if (++this.unsent < (this.opts.inputEveryTicks ?? 2)) return;
    this.unsent = 0;
    this.send(OP.INPUT, { t: this.sentFrames[0].tick, f: packFrames(this.sentFrames) });
  }

  /** Host: the snapshot for this send tick (already encoded). */
  sendSnapshot(snap: EncodedSnapshot): void {
    if (this.state === 'playing' && this.isHost) this.send(OP.SNAPSHOT, snap);
  }

  /** Host: a round just ended (the server's sanity record). */
  sendRound(msg: RoundMsg): void {
    if (this.state === 'playing' && this.isHost) this.send(OP.ROUND, msg);
  }

  /** Both: how the match ended, as this client saw it. The server's OUTCOME follows. */
  sendResult(msg: ResultMsg): void {
    if (this.state === 'playing') this.send(OP.RESULT, msg);
  }

  forfeit(): void {
    if (this.state === 'playing') this.send(OP.FORFEIT, {});
  }

  /** Host: the match's input log, chunked for the socket (OP.LOG), for the referee's replay. */
  sendLog(chunks: readonly string[]): void {
    for (const c of chunks) this.send(OP.LOG, { c });
  }

  /**
   * Back out. Searching removes the matchmaker ticket. The accept window sends DECLINE.
   * A rematch window sends No. Mid-fight still just leaves, which the server forfeits.
   */
  leave(): void {
    if (this.state === 'searching') this.lobby.cancel();
    if (this.state === 'accepting') this.send(OP.DECLINE, {});
    if (this.state === 'rematch' && !this.rematchClosing) this.send(OP.REMATCH, { yes: false });
    if (this.active) this.end('left');
  }

  private end(reason: string, acceptEnd?: AcceptEndMsg): void {
    if (this.state === 'ended') return;
    this.endReason = reason;
    this.detachTransport();
    this.setState('ended');
    if (acceptEnd) this.emit('acceptEnd', acceptEnd);
    else if (!this.outcome) this.emit('cancel', reason);
  }
}

function errorCode(err: unknown): string {
  const raw = (err as { code?: unknown })?.code ?? (err instanceof Error ? err.message : String(err));
  const m = /^(?:Error: )?([a-z0-9_:.-]+)/i.exec(String(raw));
  return m ? m[1] : 'error';
}
