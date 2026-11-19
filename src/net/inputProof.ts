/**
 * What lets the referee check that the host's input log is the guest's own input. Pure.
 *
 * The host runs the sim and uploads the input log (OP.LOG), so a cheating host could write the
 * guest's inputs into it as it pleases. The server relays every guest OP.INPUT, so it can see
 * what the guest really sent. Two pieces join those up:
 *
 * - `InputDigest` (guest): FNV-1a over each of its intent frames once, in tick order, as packed
 *   for the wire (packFrames). The guest sends it with its OP.RESULT (`inputs`). The server
 *   computes the same over the frames it relayed (`digestFrames`, the reference) and compares.
 * - `GuestTickMap` (host): for every sim tick, which guest frame tick the host played
 *   (RemoteInputBuffer), or a hold. The host puts it in OP.LOG's JSON as `net.guestFrames`,
 *   beside the sim log's own fields (the replay ignores keys it does not know, so old verifiers
 *   still read the log). With it, a verifier can rebuild the guest seat's sim input on every tick
 *   from the relayed frames and compare it with `inputs[guestSeat]`.
 *
 * CLAUDE_HANDOFF_STATUS.md (§2.3) spells out the server-side comparison.
 */
import { packFrames, type IntentFrame } from './intent';

/** Sent with the guest's OP.RESULT. */
export interface InputDigestMsg {
  /** Frames hashed, and the first and last of their ticks (-1 when none). */
  n: number;
  first: number;
  last: number;
  /** FNV-1a 32-bit, as 8 lowercase hex digits. */
  fnv: string;
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function mix(h: number, v: number): number {
  // Each packed number as a little-endian int32.
  let x = h;
  for (let k = 0; k < 4; k++) {
    x ^= (v >>> (k * 8)) & 0xff;
    x = Math.imul(x, FNV_PRIME) >>> 0;
  }
  return x;
}

const hex = (h: number) => (h >>> 0).toString(16).padStart(8, '0');

/** Guest: the running digest of the frames it has sent, each tick once. */
export class InputDigest {
  private h = FNV_OFFSET;
  private n = 0;
  private first = -1;
  private last = -1;

  /** A frame sent for the first time. A tick at or before the last one hashed is ignored. */
  add(frame: IntentFrame): void {
    if (this.n > 0 && frame.tick <= this.last) return;
    for (const v of packFrames([frame])) this.h = mix(this.h, v | 0);
    if (this.n === 0) this.first = frame.tick;
    this.last = frame.tick;
    this.n++;
  }

  get value(): InputDigestMsg {
    return { n: this.n, first: this.first, last: this.last, fnv: hex(this.h) };
  }
}

/**
 * The reference: the digest of a set of frames (the server's view: every frame it relayed,
 * repeats included), each tick once (its first copy), in tick order.
 */
export function digestFrames(frames: Iterable<IntentFrame>): InputDigestMsg {
  const byTick = new Map<number, IntentFrame>();
  for (const f of frames) if (!byTick.has(f.tick)) byTick.set(f.tick, f);
  const d = new InputDigest();
  for (const t of [...byTick.keys()].sort((a, b) => a - b)) d.add(byTick.get(t)!);
  return d.value;
}

/**
 * Host: guest frame tick played per sim tick, as runs `[simTick, guestTick, count]`. Within a run
 * the guest tick goes up by one per sim tick; `guestTick` -1 is a run of holds (the buffer ran
 * dry, or had not started: the guest's last frame again, presses cleared, or idle before any).
 */
export class GuestTickMap {
  readonly runs: [number, number, number][] = [];

  /** Sim tick `simTick` (0-based, as the log counts) played guest frame `guestTick` (-1: a hold). */
  record(simTick: number, guestTick: number): void {
    const r = this.runs[this.runs.length - 1];
    if (r && r[0] + r[2] === simTick && (guestTick < 0 ? r[1] < 0 : r[1] >= 0 && r[1] + r[2] === guestTick)) {
      r[2]++;
      return;
    }
    this.runs.push([simTick, guestTick < 0 ? -1 : guestTick, 1]);
  }

  /** The guest frame tick played at `simTick`: -1 for a hold, null when not recorded. */
  at(simTick: number): number | null {
    for (const [s, g, n] of this.runs) {
      if (simTick < s || simTick >= s + n) continue;
      return g < 0 ? -1 : g + (simTick - s);
    }
    return null;
  }
}
