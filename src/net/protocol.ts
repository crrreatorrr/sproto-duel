/**
 * Sproto Duel online protocol (client side of `sproto_arena` in metaverse-hub). Opcodes, message
 * shapes and validators; pure. The server constants in
 * metaverse-hub/server/modules/src/games/sproto_arena.ts must match this file.
 */

/** Bumped on any wire change (opcodes, bodies, snapshot format). Matchmaking and rooms only pair equal versions. */
export const NET_VERSION = '1';
/** Hub game id (Contract C1): matchmaker property, label `game`, ctx.vars.game. Never "sproto-duel". */
export const GAME_ID = 'sproto';
export const MATCH_KIND = 'sproto_arena';
export const RPC_ROOM_CREATE = 'sproto.room_create';
export const RPC_ROOM_JOIN = 'sproto.room_join';

export const OP = {
  HELLO: 1,
  START: 2,
  SIGNAL: 3,
  INPUT: 10,
  SNAPSHOT: 11,
  ROUND: 12,
  RESULT: 13,
  OUTCOME: 14,
  CANCEL: 15,
  PEER: 16,
  PING: 17,
  FORFEIT: 18,
  REMATCH: 19,
  /**
   * Host -> server: one chunk of the match's input log (src/sim-core, docs/SERVER-SIM.md), sent after
   * RESULT or FORFEIT so the referee can replay the match. Body `{ c: '<id>:<i>:<n>:<part>' }`, each
   * at most CHUNK_BYTES; reassemble with DuelSim.joinChunks. Additive: a server that does not know
   * it ignores it.
   */
  LOG: 20,
} as const;
export type OpCode = (typeof OP)[keyof typeof OP];

/** Staff ids the server accepts in HELLO (cosmetic only online). */
export const STAFF_WHITELIST = ['duel_staff_sproto', 'duel_staff_momentum', 'duel_staff_moonward', 'duel_staff_nobu'] as const;
export const DEFAULT_STAFF = 'duel_staff_sproto';

export interface HelloMsg { v: string; staff: string }
export interface StartMsg { seat: 0 | 1; hostSeat: 0 | 1; names: [string, string]; staffs: [string, string]; rules: 'online1'; seed: number }
export interface InputMsg { t: number; f: number[] }
export interface RoundMsg { round: number; winnerSeat: 0 | 1 | null; reason: 'ko' | 'time'; wins: [number, number] }
export interface ResultMsg { winnerSeat: 0 | 1 | null; wins: [number, number]; rounds: number }
export type OutcomeStatus = 'verified' | 'disputed' | 'forfeit' | 'draw' | 'timeout' | 'both_left' | 'server_shutdown';
export interface OutcomeMsg { status: OutcomeStatus; winnerSeat: 0 | 1 | null; reason: string; paid: Record<string, number>; balances?: Record<string, number> }
export interface CancelMsg { reason: string; seat?: number }
export interface PeerMsg { seat: number; present: boolean; graceS: number }
export interface PingMsg { c: number; s?: number }
export interface LogMsg { c: string }

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isSeat = (x: unknown): x is 0 | 1 => x === 0 || x === 1;
const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);
const isPair = (x: unknown): x is [number, number] => Array.isArray(x) && x.length === 2 && x.every((n) => isInt(n) && n >= 0 && n <= 9);

/** Parse a message body (JSON text). Null on anything malformed. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function asStart(x: unknown): StartMsg | null {
  if (!isObj(x) || !isSeat(x.seat) || !isSeat(x.hostSeat)) return null;
  const names = Array.isArray(x.names) && x.names.length === 2 ? x.names.map((n) => String(n ?? '').slice(0, 24)) : ['Player 1', 'Player 2'];
  const staffs = Array.isArray(x.staffs) && x.staffs.length === 2 ? x.staffs.map((s) => normalizeStaff(s)) : [DEFAULT_STAFF, DEFAULT_STAFF];
  return { seat: x.seat, hostSeat: x.hostSeat, names: names as [string, string], staffs: staffs as [string, string], rules: 'online1', seed: isInt(x.seed) ? x.seed : 0 };
}

export function asInput(x: unknown): InputMsg | null {
  if (!isObj(x) || !isInt(x.t) || !Array.isArray(x.f)) return null;
  return { t: x.t, f: x.f as number[] };
}

export function asRound(x: unknown): RoundMsg | null {
  if (!isObj(x) || !isInt(x.round) || !isPair(x.wins) || (x.reason !== 'ko' && x.reason !== 'time')) return null;
  if (x.winnerSeat !== null && !isSeat(x.winnerSeat)) return null;
  return { round: x.round, winnerSeat: x.winnerSeat as 0 | 1 | null, reason: x.reason, wins: x.wins };
}

export function asResult(x: unknown): ResultMsg | null {
  if (!isObj(x) || !isPair(x.wins) || !isInt(x.rounds)) return null;
  if (x.winnerSeat !== null && !isSeat(x.winnerSeat)) return null;
  return { winnerSeat: x.winnerSeat as 0 | 1 | null, wins: x.wins, rounds: x.rounds };
}

const STATUSES: readonly OutcomeStatus[] = ['verified', 'disputed', 'forfeit', 'draw', 'timeout', 'both_left', 'server_shutdown'];
export function asOutcome(x: unknown): OutcomeMsg | null {
  if (!isObj(x) || !STATUSES.includes(x.status as OutcomeStatus)) return null;
  const paid: Record<string, number> = {};
  if (isObj(x.paid)) for (const [k, v] of Object.entries(x.paid)) if (typeof v === 'number' && Number.isFinite(v)) paid[k] = v;
  const balances: Record<string, number> = {};
  if (isObj(x.balances)) for (const [k, v] of Object.entries(x.balances)) if (typeof v === 'number' && Number.isFinite(v)) balances[k] = v;
  return {
    status: x.status as OutcomeStatus,
    winnerSeat: isSeat(x.winnerSeat) ? x.winnerSeat : null,
    reason: typeof x.reason === 'string' ? x.reason : '',
    paid,
    balances: isObj(x.balances) ? balances : undefined,
  };
}

export function asCancel(x: unknown): CancelMsg | null {
  if (!isObj(x) || typeof x.reason !== 'string') return null;
  return { reason: x.reason, seat: isInt(x.seat) ? x.seat : undefined };
}

export function asPeer(x: unknown): PeerMsg | null {
  if (!isObj(x) || !isSeat(x.seat) || typeof x.present !== 'boolean') return null;
  return { seat: x.seat, present: x.present, graceS: typeof x.graceS === 'number' ? x.graceS : 0 };
}

export function asPing(x: unknown): PingMsg | null {
  if (!isObj(x) || typeof x.c !== 'number') return null;
  return { c: x.c, s: typeof x.s === 'number' ? x.s : undefined };
}

export function normalizeStaff(s: unknown): string {
  const id = String(s ?? '');
  return (STAFF_WHITELIST as readonly string[]).includes(id) ? id : DEFAULT_STAFF;
}

/** Room code alphabet: no 0/O, 1/I/L. 31 symbols, 6 characters. */
export const ROOM_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 6;

export function roomCode(random: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) out += ROOM_ALPHABET[Math.floor(random() * ROOM_ALPHABET.length) % ROOM_ALPHABET.length];
  return out;
}

/**
 * What a player typed as a room code, or null if it can't be one. Case, spaces and dashes don't
 * matter. Anything outside the alphabet is rejected rather than guessed (0/O and 1/I/L are not in it).
 */
export function normalizeRoomCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of code) if (!ROOM_ALPHABET.includes(ch)) return null;
  return code;
}

/** Matchmaker request for a quick match (Contract §5.2). */
export function matchmakerRequest(v = NET_VERSION) {
  return {
    query: `+properties.game:${GAME_ID} +properties.v:${v}`,
    minCount: 2,
    maxCount: 2,
    stringProperties: { game: GAME_ID, v },
  };
}

/** Label of a sproto_arena match (Contract C7). */
export interface ArenaLabel { game: string; kind: string; v: string; open: boolean; code: string }
export function parseLabel(label: string | null): ArenaLabel | null {
  const x = parseJson(label ?? '');
  if (!isObj(x) || x.kind !== MATCH_KIND) return null;
  return { game: String(x.game), kind: MATCH_KIND, v: String(x.v), open: x.open === true, code: String(x.code ?? '') };
}
