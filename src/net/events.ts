/**
 * Host events for the guest. The host records a whitelist of GameEvents (wizards as seats,
 * vectors as integer centimetres) and ships them in each SNAPSHOT (`ev`), numbered. The guest
 * re-emits each one once on its own event bus, so HUD, audio, effects and damage numbers work
 * unchanged on a replica that runs no gameplay. Pure: wizards and vectors come in through the
 * `EventWorld` functions.
 */

/** Field kinds: w wizard (seat, -1 for none), v vector (cm), n number, s string, b boolean. */
type Kind = 'w' | 'v' | 'n' | 's' | 'b';
type Schema = readonly (readonly [string, Kind])[];

/**
 * Event name → its fields in wire order. The index of the name in this list is its wire id:
 * append only.
 */
export const NET_EVENTS = [
  ['cast', [['wizard', 'w'], ['spell', 's'], ['pos', 'v']]],
  ['castStart', [['wizard', 'w'], ['spell', 's'], ['pos', 'v']]],
  ['skinLaunch', [['wizard', 'w'], ['kind', 's'], ['skin', 's'], ['pos', 'v']]],
  ['damage', [['target', 'w'], ['source', 'w'], ['amount', 'n'], ['point', 'v'], ['kind', 's']]],
  ['impact', [['pos', 'v'], ['spell', 's'], ['surface', 's']]],
  ['explosion', [['pos', 'v'], ['radius', 'n'], ['owner', 'w']]],
  ['shieldUp', [['wizard', 'w']]],
  ['block', [['wizard', 'w'], ['pos', 'v'], ['perfect', 'b'], ['spell', 's']]],
  ['clash', [['pos', 'v'], ['winner', 's']]],
  ['dodge', [['wizard', 'w']]],
  ['dodgeEvade', [['wizard', 'w'], ['pos', 'v']]],
  ['jump', [['wizard', 'w'], ['pos', 'v']]],
  ['land', [['wizard', 'w'], ['pos', 'v'], ['speed', 'n']]],
  ['stunned', [['wizard', 'w']]],
  ['burn', [['wizard', 'w']]],
  ['pillarHit', [['pos', 'v']]],
  ['pillarBreak', [['pos', 'v'], ['glass', 'b']]],
  ['ultReady', [['wizard', 'w']]],
  ['ultWave', [['wizard', 'w'], ['pos', 'v']]],
  ['noMana', [['wizard', 'w']]],
  ['ko', [['loser', 'w'], ['winner', 'w']]],
  ['roundIntro', [['round', 'n']]],
  ['countdown', [['value', 'n']]],
  ['roundStart', [['round', 'n']]],
  ['roundEnd', [['winner', 'w'], ['reason', 's']]],
  ['matchEnd', [['winner', 'w']]],
  ['suddenDeath', []],
  ['callout', [['pos', 'v'], ['text', 's'], ['style', 's']]],
  ['ticketSpawn', [['id', 'n'], ['pos', 'v']]],
  ['ticketPickup', [['id', 'n'], ['pos', 'v'], ['wizard', 'w'], ['refreshed', 'b']]],
  ['ticketExpire', [['id', 'n'], ['pos', 'v'], ['reason', 's']]],
  ['manaBoostEnd', [['wizard', 'w']]],
] as const satisfies readonly (readonly [string, Schema])[];

export type NetEventName = (typeof NET_EVENTS)[number][0];
export const NET_EVENT_NAMES: readonly NetEventName[] = NET_EVENTS.map((e) => e[0]);
const INDEX = new Map<string, number>(NET_EVENTS.map((e, i) => [e[0], i]));

/** How encode / decode reach the game's wizards and vectors. */
export interface EventWorld<W, V> {
  seatOf(w: W): number;
  wizardAt(seat: number): W | null;
  vec(x: number, y: number, z: number): V;
}

type Vecish = { x: number; y: number; z: number };
const cm = (v: number) => Math.round((Number.isFinite(v) ? v : 0) * 100);

/** One event as a flat array: [wireId, ...fields]. Null for events not replicated. */
export function encodeEvent<W, V>(name: string, payload: Record<string, unknown>, world: EventWorld<W, V>): unknown[] | null {
  const id = INDEX.get(name);
  if (id === undefined) return null;
  const out: unknown[] = [id];
  for (const [field, kind] of NET_EVENTS[id][1] as Schema) {
    const v = payload[field];
    switch (kind) {
      case 'w':
        out.push(v == null ? -1 : world.seatOf(v as W));
        break;
      case 'v': {
        const p = v as Vecish | undefined;
        out.push(p ? [cm(p.x), cm(p.y), cm(p.z)] : [0, 0, 0]);
        break;
      }
      case 'n':
        out.push(typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);
        break;
      case 's':
        // Missile appearance is in the projectile snapshot. Use the gunshot cue clients already know.
        out.push(name === 'skinLaunch' && field === 'skin' && v === 'missile' ? 'bullet' : v == null ? null : String(v));
        break;
      case 'b':
        out.push(v ? 1 : 0);
        break;
    }
  }
  return out;
}

/** The event back: its name and payload with seats as wizards and vectors rebuilt. Null if malformed. */
export function decodeEvent<W, V>(raw: unknown, world: EventWorld<W, V>): { name: NetEventName; payload: Record<string, unknown> } | null {
  if (!Array.isArray(raw) || typeof raw[0] !== 'number') return null;
  const def = NET_EVENTS[raw[0]];
  if (!def) return null;
  const schema = def[1] as Schema;
  if (raw.length !== schema.length + 1) return null;
  const payload: Record<string, unknown> = {};
  for (let i = 0; i < schema.length; i++) {
    const [field, kind] = schema[i];
    const v = raw[i + 1];
    switch (kind) {
      case 'w': {
        const seat = typeof v === 'number' ? v : -1;
        const w = seat >= 0 ? world.wizardAt(seat) : null;
        if (seat >= 0 && !w) return null;
        payload[field] = w;
        break;
      }
      case 'v': {
        if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => typeof n === 'number')) return null;
        payload[field] = world.vec(v[0] / 100, v[1] / 100, v[2] / 100);
        break;
      }
      case 'n':
        if (typeof v !== 'number') return null;
        payload[field] = v;
        break;
      case 's':
        payload[field] = v === null ? null : String(v);
        break;
      case 'b':
        payload[field] = v === 1;
        break;
    }
  }
  return { name: def[0], payload };
}

/**
 * Host side: events recorded since the last snapshot, each with a sequence number (`seq` of the
 * first in `take()`'s batch travels as the batch's first element).
 */
export class EventRecorder<W, V> {
  private queue: unknown[] = [];
  /** Sequence number of the next event recorded. */
  seq = 0;

  constructor(private readonly world: EventWorld<W, V>) {}

  record(name: string, payload: Record<string, unknown>): void {
    const e = encodeEvent(name, payload, this.world);
    if (!e) return;
    this.queue.push(e);
  }

  /** The batch for the next snapshot: [firstSeq, ...events], or null when there is none. Clears it. */
  take(): unknown[] | null {
    if (!this.queue.length) return null;
    const out = [this.seq, ...this.queue];
    this.seq += this.queue.length;
    this.queue = [];
    return out;
  }
}

/**
 * Guest side: hands each host event to `emit` exactly once, in order, whatever batches repeat or
 * overlap (a resent snapshot) or arrive with gaps (a lost one: those events are skipped).
 */
export class EventPlayer<W, V> {
  /** Sequence number of the next event not yet emitted. */
  next = 0;
  malformed = 0;

  constructor(
    private readonly world: EventWorld<W, V>,
    private readonly emit: (name: NetEventName, payload: Record<string, unknown>) => void,
  ) {}

  play(batch: unknown): void {
    if (!Array.isArray(batch) || typeof batch[0] !== 'number') return;
    const first = batch[0];
    for (let i = 1; i < batch.length; i++) {
      const seq = first + i - 1;
      if (seq < this.next) continue;
      this.next = seq + 1;
      const e = decodeEvent(batch[i], this.world);
      if (!e) {
        this.malformed++;
        continue;
      }
      this.emit(e.name, e.payload);
    }
  }

  reset(): void {
    this.next = 0;
  }
}
