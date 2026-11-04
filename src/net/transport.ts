/**
 * How online messages move: one match connection seen as opcode + text. Implemented over the hub
 * SDK's realtime MatchHandle (HubRealtimeTransport) and in memory (LoopbackTransport pairs, for
 * tests and the `?netsim=` dev mode). Pure: no DOM; timers come from a Scheduler.
 */
import type { MatchHandle, RealtimePresence } from '@metaverse/hub-sdk';

export type Unsubscribe = () => void;

export interface NetPeer {
  userId: string;
  username: string;
}

export interface NetTransport {
  /** Enqueue a message (synchronous; safe at 30+ per second). */
  send(op: number, data: string): void;
  /** `sender` is null for the server (authoritative match). */
  onMessage(fn: (op: number, data: string, sender: NetPeer | null) => void): Unsubscribe;
  onPresence(fn: (e: { joins: NetPeer[]; leaves: NetPeer[] }) => void): Unsubscribe;
  /** After a reconnect re-joined the match (ask for a fresh state). */
  onRejoin(fn: () => void): Unsubscribe;
  onClose(fn: (reason: string) => void): Unsubscribe;
  close(): void;
}

/** Time and deferred calls (manual in tests, real timers in the browser). */
export interface Scheduler {
  now(): number;
  at(timeMs: number, fn: () => void): void;
}

/** setTimeout-backed scheduler on performance.now() (or Date.now()). */
export const realScheduler: Scheduler = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  at(timeMs, fn) {
    setTimeout(fn, Math.max(0, timeMs - this.now()));
  },
};

/** A clock you advance by hand; deferred calls run in time order (ties in call order). */
export class ManualScheduler implements Scheduler {
  private t = 0;
  private seq = 0;
  private readonly queue: { t: number; seq: number; fn: () => void }[] = [];

  now(): number {
    return this.t;
  }

  at(timeMs: number, fn: () => void): void {
    this.queue.push({ t: Math.max(timeMs, this.t), seq: this.seq++, fn });
    this.queue.sort((a, b) => a.t - b.t || a.seq - b.seq);
  }

  /** Move the clock forward, running everything due on the way. */
  advance(ms: number): void {
    const end = this.t + ms;
    while (this.queue.length && this.queue[0].t <= end) {
      const job = this.queue.shift()!;
      this.t = job.t;
      job.fn();
    }
    this.t = end;
  }

  get pending(): number {
    return this.queue.length;
  }
}

export interface LinkOptions {
  /** One-way latency (ms). */
  latencyMs?: number;
  /** Extra random delay 0..jitterMs. Order is kept (the socket is ordered). */
  jitterMs?: number;
  /** Chance a message is dropped (0..1). A WebSocket never drops; this models a bad relay. */
  loss?: number;
  random?: () => number;
}

/** A deterministic PRNG for tests (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Listeners<A extends unknown[]> {
  private readonly fns: ((...a: A) => void)[] = [];
  add(fn: (...a: A) => void): Unsubscribe {
    this.fns.push(fn);
    return () => {
      const i = this.fns.indexOf(fn);
      if (i >= 0) this.fns.splice(i, 1);
    };
  }
  emit(...a: A): void {
    for (const fn of [...this.fns]) fn(...a);
  }
}

/**
 * One end of an in-memory link. Messages sent here arrive at the other end after the link's
 * latency; `sender` is what the other end reports as the sender (null = "the server").
 */
export class LoopbackTransport implements NetTransport {
  peer: LoopbackTransport | null = null;
  closed = false;
  /** Messages sent / dropped (QA and tests). */
  sent = 0;
  dropped = 0;
  private lastArrival = 0;
  private readonly messages = new Listeners<[number, string, NetPeer | null]>();
  private readonly presence = new Listeners<[{ joins: NetPeer[]; leaves: NetPeer[] }]>();
  private readonly rejoins = new Listeners<[]>();
  private readonly closes = new Listeners<[string]>();

  constructor(
    private readonly scheduler: Scheduler,
    private readonly opts: LinkOptions,
    /** How the far end sees this end's messages. */
    readonly identity: NetPeer | null,
  ) {}

  send(op: number, data: string): void {
    const to = this.peer;
    if (this.closed || !to || to.closed) return;
    this.sent++;
    const rnd = this.opts.random ?? Math.random;
    if (this.opts.loss && rnd() < this.opts.loss) {
      this.dropped++;
      return;
    }
    const now = this.scheduler.now();
    const at = Math.max(this.lastArrival, now + (this.opts.latencyMs ?? 0) + (this.opts.jitterMs ? rnd() * this.opts.jitterMs : 0));
    this.lastArrival = at;
    const from = this.identity;
    this.scheduler.at(at, () => {
      if (!to.closed) to.messages.emit(op, data, from);
    });
  }

  onMessage(fn: (op: number, data: string, sender: NetPeer | null) => void): Unsubscribe {
    return this.messages.add(fn);
  }
  onPresence(fn: (e: { joins: NetPeer[]; leaves: NetPeer[] }) => void): Unsubscribe {
    return this.presence.add(fn);
  }
  onRejoin(fn: () => void): Unsubscribe {
    return this.rejoins.add(fn);
  }
  onClose(fn: (reason: string) => void): Unsubscribe {
    return this.closes.add(fn);
  }

  /** Tests: tell this end someone joined or left. */
  emitPresence(e: { joins: NetPeer[]; leaves: NetPeer[] }): void {
    this.presence.emit(e);
  }

  emitRejoin(): void {
    this.rejoins.emit();
  }

  close(reason = 'left'): void {
    if (this.closed) return;
    this.closed = true;
    this.closes.emit(reason);
    const p = this.peer;
    if (p && !p.closed) this.scheduler.at(this.scheduler.now() + (this.opts.latencyMs ?? 0), () => p.remoteClosed(this.identity));
  }

  /** Called on the far end when this end closed: a presence leave (the far end stays open). */
  private remoteClosed(who: NetPeer | null): void {
    if (who) this.presence.emit({ joins: [], leaves: [who] });
  }
}

/** Two connected ends. `aIdentity` is how b sees a's messages, and the other way round. */
export function loopbackPair(scheduler: Scheduler, opts: LinkOptions = {}, aIdentity: NetPeer | null = null, bIdentity: NetPeer | null = null): [LoopbackTransport, LoopbackTransport] {
  const a = new LoopbackTransport(scheduler, opts, aIdentity);
  const b = new LoopbackTransport(scheduler, opts, bIdentity);
  a.peer = b;
  b.peer = a;
  return [a, b];
}

const peerOf = (p: RealtimePresence | null): NetPeer | null => (p ? { userId: p.userId, username: p.username } : null);

/** NetTransport over a hub-sdk MatchHandle (Contract C9). */
export class HubRealtimeTransport implements NetTransport {
  constructor(readonly handle: MatchHandle) {}

  send(op: number, data: string): void {
    this.handle.send(op, data);
  }
  onMessage(fn: (op: number, data: string, sender: NetPeer | null) => void): Unsubscribe {
    return this.handle.onMessage((m) => fn(m.opCode, m.text(), peerOf(m.sender)));
  }
  onPresence(fn: (e: { joins: NetPeer[]; leaves: NetPeer[] }) => void): Unsubscribe {
    return this.handle.onPresence((e) => fn({ joins: e.joins.map((p) => peerOf(p)!), leaves: e.leaves.map((p) => peerOf(p)!) }));
  }
  onRejoin(fn: () => void): Unsubscribe {
    return this.handle.onRejoin(fn);
  }
  onClose(fn: (reason: string) => void): Unsubscribe {
    return this.handle.onClose((r) => fn(r));
  }
  close(): void {
    void this.handle.leave();
  }
}
