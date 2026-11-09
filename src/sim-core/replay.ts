/**
 * Re-run a match from its input log (the hub's `DuelSim.replay`), and record one (the game).
 * `replay` is pure and never throws: anything wrong comes back as `ok: false` with an `error`.
 */
import { Hasher } from './hash';
import { LOG_SCHEMA, SeatReader, SeatWriter, fromBase64, type DuelLog } from './log';
import { isRulesId } from './rules';
import { staffStats } from './staffs';
import { simVersion } from './version';
import { SimWorld, type SimSetup } from './world';
import type { SimInput } from './wizard';
import { isArenaId, type ArenaId } from './arena';
import { bossArena, isBossId } from './bosses';
import { REWARDS } from './rewards';

/** Longest log accepted: 45 minutes of ticks (a Boss Gauntlet fight's safety cap is 35). */
export const MAX_TICKS = 60 * 60 * 45;
/** Most mid-fight god-mode toggles one log may hold. */
export const MAX_GOD_TOGGLES = 256;

export interface ReplayResult {
  ok: boolean;
  error?: string;
  simVersion: string;
  winnerSeat: 0 | 1 | null;
  wins: [number, number];
  rounds: number;
  ticks: number;
  bossId?: string;
  endHash: string;
  /** Additive: how the match ended ('ko', 'time', 'forfeit'), '' when it did not finish. */
  endReason: string;
}

export interface ReplayOptions {
  /** Tests and golden runs from source: accept any simVersion. The bundle never sets it. */
  anyVersion?: boolean;
}

/** The arena a log's rules play in (duels: the moonlit arena; bosses pick theirs in A5). */
export function arenaFor(rules: string, bossId: string | null | undefined): ArenaId {
  return rules === 'gauntlet' && bossId ? bossArena(bossId) : 'moonlit';
}

function emptyHash(): string {
  return new Hasher().str('empty').hex();
}

function fail(error: string, world: SimWorld | null): ReplayResult {
  const r = world ? summarize(world) : { ok: false, simVersion: simVersion(), winnerSeat: null, wins: [0, 0] as [number, number], rounds: 0, ticks: 0, endHash: emptyHash(), endReason: '' };
  r.ok = false;
  r.error = error;
  return r;
}

function summarize(w: SimWorld): ReplayResult {
  const m = w.match;
  const r: ReplayResult = {
    ok: true,
    simVersion: simVersion(),
    winnerSeat: m.phase === 'matchEnd' && (m.winner === 0 || m.winner === 1) ? (m.winner as 0 | 1) : null,
    wins: [m.wins[0], m.wins[1]],
    rounds: m.roundWinners.length,
    ticks: w.tick,
    endHash: w.hash(),
    endReason: m.phase !== 'matchEnd' ? '' : m.forfeit >= 0 ? 'forfeit' : m.lastReason,
  };
  if (w.setup.bossId) r.bossId = w.setup.bossId;
  return r;
}

const isArray = (x: unknown): x is unknown[] => Object.prototype.toString.call(x) === '[object Array]';
const isInt = (x: unknown): x is number => typeof x === 'number' && isFinite(x) && Math.floor(x) === x;

/** Validate a log's header and build the world it describes; a string is an error. */
export function setupFromLog(log: DuelLog): SimSetup | string {
  if (!log || typeof log !== 'object') return 'log is not an object';
  if (log.schema !== LOG_SCHEMA) return 'unsupported schema';
  if (!isInt(log.seed)) return 'seed must be an integer';
  if (!isRulesId(log.rules)) return 'unknown rules';
  if (!isArray(log.staffs) || log.staffs.length !== 2) return 'staffs must list two seats';
  for (let i = 0; i < 2; i++) {
    const s = log.staffs[i];
    if (s !== null && (typeof s !== 'string' || !staffStats(s))) return 'unknown staff';
  }
  if (log.rules === 'gauntlet') {
    if (!isBossId(log.bossId)) return 'unknown bossId';
  } else if (log.bossId !== undefined && log.bossId !== null) return 'bossId outside a boss fight';
  if (log.godMode !== undefined && typeof log.godMode !== 'boolean') return 'godMode must be a boolean';
  const learned: string[] = [];
  if (log.learned !== undefined && log.learned !== null) {
    if (!isArray(log.learned)) return 'learned must be a list';
    for (let i = 0; i < log.learned.length; i++) {
      const id = log.learned[i];
      if (typeof id !== 'string' || (REWARDS as readonly string[]).indexOf(id) < 0 || learned.indexOf(id) >= 0) return 'bad learned spell';
      learned.push(id);
    }
  }
  const arena = arenaFor(log.rules, log.bossId);
  if (!isArenaId(arena)) return 'unknown arena';
  return { seed: log.seed | 0, rules: log.rules, arena, staffs: [log.staffs[0], log.staffs[1]], bossId: log.bossId || null, learned, godMode: !!log.godMode };
}

/** Re-run `log`. Never throws. */
export function replay(log: DuelLog, opts?: ReplayOptions): ReplayResult {
  let world: SimWorld | null = null;
  try {
    if (!log || typeof log !== 'object') return fail('log is not an object', null);
    if (!(opts && opts.anyVersion) && log.simVersion !== simVersion()) return fail('simVersion mismatch', null);
    const setup = setupFromLog(log);
    if (typeof setup === 'string') return fail(setup, null);
    if (!isInt(log.ticks) || log.ticks < 1 || log.ticks > MAX_TICKS) return fail('bad ticks', null);
    world = new SimWorld(setup);
    world.events.enabled = false;
    const seats = world.inputSeats();
    if (!isArray(log.inputs) || log.inputs.length !== seats.length) return fail('inputs must list ' + seats.length + ' seat streams', world);
    const readers: SeatReader[] = [];
    for (let i = 0; i < seats.length; i++) {
      const bytes = fromBase64(log.inputs[i]);
      if (!bytes) return fail('bad base64 in seat ' + i, world);
      readers.push(new SeatReader(bytes));
    }
    const ff = log.forfeit;
    if (ff !== undefined && ff !== null && (!isInt(ff.tick) || ff.tick < 0 || ff.tick > log.ticks || (ff.seat !== 0 && ff.seat !== 1))) return fail('bad forfeit', world);
    const gt = log.godToggles;
    if (gt !== undefined && gt !== null) {
      if (!isArray(gt) || gt.length > MAX_GOD_TOGGLES) return fail('bad godToggles', world);
      for (let i = 0; i < gt.length; i++) {
        const g = gt[i];
        if (!g || typeof g !== 'object' || !isInt(g.tick) || g.tick < 0 || g.tick >= log.ticks || typeof g.on !== 'boolean' || (i > 0 && g.tick < gt[i - 1].tick)) return fail('bad godToggles', world);
      }
    }
    let gi = 0;
    const frames: (SimInput | null)[] = [null, null, null];
    for (let t = 0; t < log.ticks; t++) {
      while (gt && gi < gt.length && gt[gi].tick === t) world.setGodMode(gt[gi++].on);
      if (ff && ff.tick === t) {
        world.forfeit(ff.seat);
        break;
      }
      if (world.over) return fail('log continues after the match ended', world);
      for (let i = 0; i < seats.length; i++) {
        const f = readers[i].next();
        if (!f) return fail('seat ' + seats[i] + ': ' + readers[i].error + ' at tick ' + t, world);
        frames[seats[i]] = f;
      }
      world.step(frames);
      for (let i = 0; i < seats.length; i++) {
        const w = world.wizards[seats[i]];
        const f = frames[seats[i]]!;
        if (w.missingInput) return fail('seat ' + seats[i] + ': facing or aim missing at tick ' + t, world);
        if ((!f.noFacing && !w.facingRead) || (!f.noAim && !w.aimRead)) return fail('seat ' + seats[i] + ': unused facing or aim at tick ' + t, world);
      }
    }
    if (ff && ff.tick === log.ticks && !world.over) world.forfeit(ff.seat);
    for (let i = 0; i < readers.length; i++) if (readers[i].leftover) return fail('seat ' + seats[i] + ': input continues past the last tick', world);
    if (!world.over) return fail('match did not finish', world);
    const r = summarize(world);
    const c = log.claimed;
    if (c && typeof c === 'object') {
      if (c.winnerSeat !== undefined && c.winnerSeat !== r.winnerSeat) return withError(r, 'claimed winnerSeat differs');
      if (isArray(c.wins) && (c.wins[0] !== r.wins[0] || c.wins[1] !== r.wins[1])) return withError(r, 'claimed wins differ');
      if (c.rounds !== undefined && c.rounds !== r.rounds) return withError(r, 'claimed rounds differ');
      if (c.ticks !== undefined && c.ticks !== r.ticks) return withError(r, 'claimed ticks differ');
      if (c.bossId !== undefined && c.bossId !== null && c.bossId !== r.bossId) return withError(r, 'claimed bossId differs');
    }
    return r;
  } catch (e) {
    return fail('replay crashed: ' + String(e && (e as Error).message ? (e as Error).message : e), world);
  }
}

function withError(r: ReplayResult, error: string): ReplayResult {
  r.ok = false;
  r.error = error;
  return r;
}

/**
 * Records a match as it is played: call `frame` with each input seat's input before `world.step`,
 * then `after()` once the step ran. `log()` builds the DuelLog.
 */
export class LogRecorder {
  private readonly writers: SeatWriter[] = [];
  private readonly pending: (SimInput | null)[] = [];
  private forfeit: { tick: number; seat: number } | null = null;
  private readonly godToggles: { tick: number; on: boolean }[] = [];
  ticks = 0;

  constructor(private readonly world: SimWorld) {
    for (let i = 0; i < world.inputSeats().length; i++) this.writers.push(new SeatWriter());
  }

  /** This tick's input for input seat number `i` (index into world.inputSeats()). */
  frame(i: number, input: SimInput): void {
    this.pending[i] = input;
  }

  /** The step ran: write what each seat pressed and what the sim read. */
  after(): void {
    const seats = this.world.inputSeats();
    for (let i = 0; i < seats.length; i++) {
      const w = this.world.wizards[seats[i]];
      const f = this.pending[i];
      this.writers[i].push(f || EMPTY, w.facingRead, w.aimRead);
      this.pending[i] = null;
    }
    this.ticks++;
  }

  /** A seat left before the next tick. */
  markForfeit(seat: number): void {
    this.forfeit = { tick: this.ticks, seat };
  }

  /** God mode turned on or off before the next tick; false (not recorded) once the log is full. */
  markGodMode(on: boolean): boolean {
    if (this.godToggles.length >= MAX_GOD_TOGGLES) return false;
    this.godToggles.push({ tick: this.ticks, on });
    return true;
  }

  /** Encoded bytes so far (all seats). */
  get size(): number {
    let n = 0;
    for (const w of this.writers) n += w.size;
    return n;
  }

  log(claimed?: DuelLog['claimed']): DuelLog {
    const s = this.world.setup;
    const out: DuelLog = {
      schema: LOG_SCHEMA,
      simVersion: simVersion(),
      seed: s.seed,
      rules: s.rules,
      staffs: [s.staffs[0] ?? null, s.staffs[1] ?? null],
      ticks: this.ticks,
      inputs: this.writers.map((w) => w.encode()),
    };
    if (s.bossId) out.bossId = s.bossId;
    if (s.learned && s.learned.length) out.learned = s.learned.slice();
    if (s.godMode) out.godMode = true;
    if (this.forfeit) out.forfeit = this.forfeit;
    // A toggle after the last tick changed nothing.
    const gt = this.godToggles.filter((g) => g.tick < this.ticks);
    if (gt.length) out.godToggles = gt;
    if (claimed) out.claimed = claimed;
    return out;
  }
}

const EMPTY: SimInput = { move: 0, held: 0, press: 0, facing: 0, aimYaw: 0, aimPitch: 0, aimDist: 0 };
