/**
 * One online 1v1, from the menu to the outcome: idle → connecting → searching | hosting-room |
 * joining-room → starting → playing → ended. Owns the match transport, the seat and host role,
 * the host's RemoteInputBuffer and the guest's SnapshotBuffer, PING/RTT, the opponent's presence
 * and the RESULT → OUTCOME handshake. Pure (no DOM, no Game): App wires it to the game.
 */
import { packFrames, unpackFrames, type IntentFrame } from './intent';
import {
  asCancel, asInput, asOutcome, asPeer, asPing, asStart, NET_VERSION, normalizeRoomCode, OP, parseJson,
  type OutcomeMsg, type PeerMsg, type ResultMsg, type RoundMsg, type StartMsg,
} from './protocol';
import { RemoteInputBuffer } from './RemoteInputBuffer';
import { SnapshotBuffer } from './SnapshotBuffer';
import { decodeSnapshot, SnapshotVersionError, type EncodedSnapshot, type Snapshot } from './state';
import type { NetTransport, Scheduler, Unsubscribe } from './transport';

export type SessionState = 'idle' | 'connecting' | 'searching' | 'hosting-room' | 'joining-room' | 'starting' | 'playing' | 'ended';

/** Matchmaking and rooms: the hub realtime client (HubLobby) or FakeArenaServer's lobby. */
export interface OnlineLobby {
  readonly selfId: string | null;
  connect(): Promise<void>;
  /** Resolves once matched and joined. */
  quickMatch(): Promise<NetTransport>;
  createRoom(): Promise<{ code: string; transport: NetTransport }>;
  /** Rejects with 'room_not_found' / 'version_mismatch'. */
  joinRoom(code: string): Promise<NetTransport>;
  /** Give up a pending quickMatch. */
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

  async quickMatch(): Promise<void> {
    await this.begin('searching', async () => this.lobby.quickMatch());
  }

  async createRoom(): Promise<string | null> {
    await this.begin('hosting-room', async () => {
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
    await this.begin('joining-room', async () => this.lobby.joinRoom(code));
  }

  private async begin(waiting: SessionState, open: () => Promise<NetTransport>): Promise<void> {
    if (this.active) return;
    this.reset();
    this.setState('connecting');
    try {
      await this.lobby.connect();
      if (this.state !== 'connecting') return;
      this.setState(waiting);
      const t = await open();
      if (this.state !== waiting) {
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
    this.peerPresent = true;
    this.peerGraceS = 0;
    this.sentFrames.length = 0;
    this.unsent = 0;
    this.remoteInput.reset();
    this.snapshots.clear();
  }

  /** Joined a match: say HELLO and wait for START. */
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
    if (this.state !== 'hosting-room') this.setState('starting');
    this.startDeadline = this.opts.scheduler.now() + (this.opts.startTimeoutMs ?? 30_000);
    this.send(OP.HELLO, { v: this.opts.version ?? NET_VERSION, staff: this.opts.staff });
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
        this.end(o.status);
        return;
      }
      case OP.CANCEL: {
        const c = asCancel(parseJson(data));
        this.end(c?.reason ?? 'cancelled');
        return;
      }
      default:
        return;
    }
  }

  /** Call every frame: PINGs, and the START timeout. */
  update(nowMs = this.opts.scheduler.now()): void {
    if (this.state === 'starting' && nowMs > this.startDeadline) {
      this.end('start_timeout');
      return;
    }
    if ((this.state === 'playing' || this.state === 'starting') && nowMs >= this.nextPing) {
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

  /** Back out: cancels matchmaking, leaves the match (the server treats it as leaving). */
  leave(): void {
    if (this.state === 'searching') this.lobby.cancel();
    if (this.active) this.end('left');
  }

  private end(reason: string): void {
    if (this.state === 'ended') return;
    this.endReason = reason;
    for (const u of this.subs) u();
    this.subs = [];
    const t = this.transport;
    this.transport = null;
    t?.close();
    this.setState('ended');
    if (!this.outcome) this.emit('cancel', reason);
  }
}

function errorCode(err: unknown): string {
  const raw = (err as { code?: unknown })?.code ?? (err instanceof Error ? err.message : String(err));
  const m = /^(?:Error: )?([a-z0-9_:.-]+)/i.exec(String(raw));
  return m ? m[1] : 'error';
}
