/**
 * The versioned input log: everything needed to re-run a match (seed, rules, loadouts, per-tick
 * inputs per seat), and its compact codec (run-length gaps between changed ticks, range-coded
 * fields; see SeatWriter). Pure ES5-safe code: the server bundle decodes it.
 */
import { ByteModel, RangeDecoder, RangeEncoder } from './rc';
import type { SimInput } from './wizard';

export const LOG_SCHEMA = 1;

export const F_MOVE = 1;
export const F_HELD = 2;
export const F_PRESS = 4;
export const F_FACING = 8;
export const F_AIM = 16;

export interface DuelLog {
  schema: number;
  simVersion: string;
  seed: number;
  rules: string;
  /** Staff item id per seat (null: none). */
  staffs: (string | null)[];
  /** Gauntlet: the boss fought (hub story-boss id). */
  bossId?: string | null;
  /** Ticks simulated, up to and including the tick the match ended. */
  ticks: number;
  /** One encoded stream per seat that plays from input (CPU seats are simulated). */
  inputs: string[];
  /** A seat leaving: applied before the tick with this index (0-based). */
  forfeit?: { tick: number; seat: number } | null;
  /** What the client says happened; compared with the replay. */
  claimed?: { winnerSeat?: number | null; wins?: number[]; rounds?: number; ticks?: number; bossId?: string | null };
}

// ------------------------------------------------------------------ base64 (no atob/btoa on goja)

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = i + 1 < bytes.length ? bytes[i + 1] : 0, c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63);
    out += i + 1 < bytes.length ? B64.charAt((n >> 6) & 63) : '=';
    out += i + 2 < bytes.length ? B64.charAt(n & 63) : '=';
  }
  return out;
}

/** Decode base64; null when malformed. */
export function fromBase64(s: string): number[] | null {
  if (typeof s !== 'string' || s.length % 4 !== 0) return null;
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 4) {
    let n = 0, pad = 0;
    for (let k = 0; k < 4; k++) {
      const ch = s.charAt(i + k);
      let v: number;
      if (ch === '=') {
        if (i + 4 !== s.length || k < 2) return null;
        pad++;
        v = 0;
      } else {
        if (pad) return null;
        v = B64.indexOf(ch);
        if (v < 0) return null;
      }
      n = (n << 6) | v;
    }
    out.push((n >> 16) & 255);
    if (pad < 2) out.push((n >> 8) & 255);
    if (pad < 1) out.push(n & 255);
  }
  return out;
}

// ------------------------------------------------------------------ field models

const zig = (v: number) => (v << 1) ^ (v >> 31);
const unzig = (v: number) => (v >>> 1) ^ -(v & 1);

/** Wrap a 10-bit angle delta into -512..511. */
function wrap10(d: number): number {
  let x = d % 1024;
  if (x < -512) x += 1024;
  else if (x >= 512) x -= 1024;
  return x;
}

/** One adaptive model per field, so each learns its own statistics. */
class Models {
  readonly gap = new ByteModel();
  readonly gapBig = new ByteModel();
  readonly flags = new ByteModel();
  readonly move = new ByteModel();
  readonly held = new ByteModel();
  readonly pressLo = new ByteModel();
  readonly pressHi = new ByteModel();
  readonly facingLo = new ByteModel();
  readonly facingHi = new ByteModel();
  readonly yawLo = new ByteModel();
  readonly yawHi = new ByteModel();
  readonly pitchLo = new ByteModel();
  readonly pitchHi = new ByteModel();
  readonly dist = new ByteModel();
}

function putVarint(out: number[], v: number): void {
  let x = v;
  while (x >= 128) {
    out.push((x % 128) | 128);
    x = Math.floor(x / 128);
  }
  out.push(x);
}

// ------------------------------------------------------------------ writer

/**
 * Builds one seat's stream tick by tick (the game, and test drivers).
 *
 * Stream: varint record count, then the records range-coded field by field (rc.ts), each field
 * with its own adaptive model:
 *   gap        ticks skipped since the previous record (254 or less, else 255 + 4 bytes)
 *   flags      F_MOVE | F_HELD | F_PRESS | F_FACING | F_AIM
 *   move       new move code (persists)          held   new held bits (persists)
 *   press      12 bits, this tick only
 *   facing     zigzag delta to the previous logged facing, wrapped to +-512 (10 bits)
 *   aim        yaw delta (10 bits), pitch delta (zigzag, 10 bits), distance bucket delta (6 bits)
 */
export class SeatWriter {
  private readonly rc = new RangeEncoder();
  private readonly m = new Models();
  private records = 0;
  private gap = 0;
  private move = 0;
  private held = 0;
  private facing = 0;
  private yaw = 0;
  private pitch = 0;
  private dist = 0;

  /** Record tick `input`; `facing` / `aim`: whether the sim read them this tick. */
  push(input: SimInput, facing: boolean, aim: boolean): void {
    let flags = 0;
    const mv = input.move | 0, hd = input.held & 3, pr = input.press & 4095;
    if (mv !== this.move) flags |= F_MOVE;
    if (hd !== this.held) flags |= F_HELD;
    if (pr) flags |= F_PRESS;
    if (facing) flags |= F_FACING;
    if (aim) flags |= F_AIM;
    if (!flags) {
      this.gap++;
      return;
    }
    const rc = this.rc, m = this.m;
    this.records++;
    if (this.gap < 255) rc.byte(m.gap, this.gap);
    else {
      rc.byte(m.gap, 255);
      for (let k = 3; k >= 0; k--) rc.byte(m.gapBig, Math.floor(this.gap / [1, 256, 65536, 16777216][k]) & 255);
    }
    this.gap = 0;
    rc.byte(m.flags, flags);
    if (flags & F_MOVE) {
      rc.byte(m.move, mv);
      this.move = mv;
    }
    if (flags & F_HELD) {
      rc.byte(m.held, hd);
      this.held = hd;
    }
    if (flags & F_PRESS) {
      rc.byte(m.pressLo, pr & 255);
      rc.byte(m.pressHi, pr >> 8);
    }
    if (flags & F_FACING) {
      const f = input.facing & 1023;
      const z = zig(wrap10(f - this.facing));
      rc.byte(m.facingLo, z & 255);
      rc.byte(m.facingHi, z >> 8);
      this.facing = f;
    }
    if (flags & F_AIM) {
      const y = input.aimYaw & 1023, p = input.aimPitch | 0, d = input.aimDist & 31;
      const zy = zig(wrap10(y - this.yaw)), zp = zig(p - this.pitch);
      rc.byte(m.yawLo, zy & 255);
      rc.byte(m.yawHi, zy >> 8);
      rc.byte(m.pitchLo, zp & 255);
      rc.byte(m.pitchHi, zp >> 8);
      rc.byte(m.dist, (d - this.dist) & 63);
      this.yaw = y;
      this.pitch = p;
      this.dist = d;
    }
  }

  /** Encoded bytes so far (approximate until finished). */
  get size(): number {
    return this.rc.out.length + 6;
  }

  encode(): string {
    const head: number[] = [];
    putVarint(head, this.records);
    if (!this.records) return toBase64(head);
    const body = this.rc.finish();
    return toBase64(head.concat(body));
  }
}

// ------------------------------------------------------------------ reader

/** Replays one seat's stream as SimInput frames. `next()` returns null on a malformed stream. */
export class SeatReader {
  private readonly rc: RangeDecoder | null = null;
  private readonly m = new Models();
  private left = 0;
  /** Ticks until the next record (-1: no more records). */
  private wait = -1;
  private dist = 0;
  private readonly frame: SimInput = { move: 0, held: 0, press: 0, facing: 0, aimYaw: 0, aimPitch: 0, aimDist: 0, noFacing: true, noAim: true };
  error = '';

  constructor(bytes: number[]) {
    let v = 0, scale = 1, pos = 0;
    for (;;) {
      if (pos >= bytes.length || pos > 4) {
        this.error = 'truncated input stream';
        return;
      }
      const b = bytes[pos++];
      v += (b & 127) * scale;
      if (b < 128) break;
      scale *= 128;
    }
    this.left = v;
    if (v > 0) {
      this.rc = new RangeDecoder(bytes, pos);
      this.wait = this.readGap();
    } else if (pos !== bytes.length) this.error = 'trailing bytes';
  }

  private readGap(): number {
    const rc = this.rc!;
    let g = rc.byte(this.m.gap);
    if (g === 255) {
      g = 0;
      for (let k = 0; k < 4; k++) g = g * 256 + rc.byte(this.m.gapBig);
    }
    if (rc.overrun > 4) this.error = 'truncated input stream';
    return g;
  }

  /** The frame for the next tick (reused object), or null on a malformed stream. */
  next(): SimInput | null {
    const f = this.frame;
    f.press = 0;
    f.noFacing = f.noAim = true;
    if (this.error) return null;
    if (this.wait > 0) {
      this.wait--;
      return f;
    }
    if (this.wait < 0) return f;
    const rc = this.rc!, m = this.m;
    const flags = rc.byte(m.flags);
    if (flags & ~31 || !flags) {
      this.error = 'bad record flags';
      return null;
    }
    if (flags & F_MOVE) {
      f.move = rc.byte(m.move);
      if (f.move > 128) this.error = 'bad move code';
    }
    if (flags & F_HELD) {
      f.held = rc.byte(m.held);
      if (f.held > 3) this.error = 'bad held bits';
    }
    if (flags & F_PRESS) {
      f.press = rc.byte(m.pressLo) | (rc.byte(m.pressHi) << 8);
      if (f.press > 4095 || f.press <= 0) this.error = 'bad press bits';
    }
    if (flags & F_FACING) {
      const z = rc.byte(m.facingLo) | (rc.byte(m.facingHi) << 8);
      f.facing = (f.facing + unzig(z)) & 1023;
      f.noFacing = false;
    }
    if (flags & F_AIM) {
      const zy = rc.byte(m.yawLo) | (rc.byte(m.yawHi) << 8);
      const zp = rc.byte(m.pitchLo) | (rc.byte(m.pitchHi) << 8);
      f.aimYaw = (f.aimYaw + unzig(zy)) & 1023;
      f.aimPitch = f.aimPitch + unzig(zp);
      this.dist = (this.dist + rc.byte(m.dist)) & 63;
      f.aimDist = this.dist;
      if (f.aimPitch < -256 || f.aimPitch > 256 || f.aimDist > 31) this.error = 'bad aim';
      f.noAim = false;
    }
    if (rc.overrun > 4) this.error = 'truncated input stream';
    if (this.error) return null;
    this.left--;
    this.wait = this.left > 0 ? this.readGap() : -1;
    if (this.error) return null;
    return f;
  }

  /** Records left unread after the last tick (a longer log than claimed). */
  get leftover(): boolean {
    return this.wait >= 0;
  }
}

// ------------------------------------------------------------------ socket chunks

/** Most bytes per socket message (hub). */
export const CHUNK_BYTES = 4096;
/** Most bytes per whole log (hub). */
export const LOG_MAX_BYTES = 16 * 1024;

/**
 * Split a log's JSON into socket messages of at most CHUNK_BYTES each: `"<id>:<i>:<n>:" + part`.
 * The JSON is ASCII (base64 streams, ids), so characters are bytes.
 */
export function chunkLog(json: string, id: string): string[] {
  const parts: string[] = [];
  const head = (i: number, n: number) => id + ':' + i + ':' + n + ':';
  let n = 1;
  for (;;) {
    const room = CHUNK_BYTES - head(n - 1, n).length;
    const need = Math.ceil(json.length / room) || 1;
    if (need <= n) break;
    n = need;
  }
  const room = CHUNK_BYTES - head(n - 1, n).length;
  for (let i = 0; i < n; i++) parts.push(head(i, n) + json.substr(i * room, room));
  return parts;
}

/** Reassemble chunks (any order) into the JSON; null if incomplete or inconsistent. */
export function joinChunks(chunks: string[]): string | null {
  if (!chunks || !chunks.length) return null;
  let id = '', n = -1;
  const got: string[] = [];
  for (let k = 0; k < chunks.length; k++) {
    const c = chunks[k];
    if (typeof c !== 'string' || c.length > CHUNK_BYTES) return null;
    const a = c.indexOf(':'), b = c.indexOf(':', a + 1), d = c.indexOf(':', b + 1);
    if (a < 0 || b < 0 || d < 0) return null;
    const cid = c.substring(0, a), i = parseInt(c.substring(a + 1, b), 10), cn = parseInt(c.substring(b + 1, d), 10);
    if (!(i >= 0) || !(cn > 0) || i >= cn) return null;
    if (n < 0) {
      n = cn;
      id = cid;
    } else if (cn !== n || cid !== id) return null;
    got[i] = c.substring(d + 1);
  }
  let out = '';
  for (let i = 0; i < n; i++) {
    if (typeof got[i] !== 'string') return null;
    out += got[i];
  }
  return out;
}
