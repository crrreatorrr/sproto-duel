/**
 * Sproto Duel online protocol (client side of `sproto_arena` in metaverse-hub). Opcodes, message
 * shapes and validators; pure. The server constants in
 * metaverse-hub/server/modules/src/games/sproto_arena.ts must match this file.
 */

/** Bumped on any wire change (opcodes, bodies, snapshot format). Matchmaking and rooms only pair equal versions. */
export const NET_VERSION = '2';
/** Hub game id (Contract C1): matchmaker property, label `game`, ctx.vars.game. Never "sproto-duel". */
export const GAME_ID = 'sproto';
export const MATCH_KIND = 'sproto_arena';
export const RPC_ROOM_CREATE = 'sproto.room_create';
export const RPC_ROOM_JOIN = 'sproto.room_join';
/** Read-only menu count. The server caches it for 3 s; the client polls at most every 10 s. */
export const RPC_ONLINE_COUNT = 'sproto.online_count';
/** Quick-match accept window, and the rematch offer window. The server owns both clocks. */
export const ACCEPT_S = 10;
export const REMATCH_S = 15;

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
  ACCEPT: 19,
  DECLINE: 20,
  FOUND: 21,
  ACCEPT_END: 22,
  REMATCH: 23,
  REMATCH_STATE: 24,
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

/** Quick-match accept window. `accepted[seat]` is that seat's answer so far. */
export interface FoundMsg {
  acceptS: number;
  seat: 0 | 1;
  accepted: [boolean, boolean];
  names: [string, string];
}

export interface AcceptEndMsg {
  status: 'declined' | 'accept_timeout';
  bySeat: number | null;
  next: 'queue' | 'lobby';
}

export type RematchPhase = 'open' | 'offered' | 'started' | 'closed';
export type RematchStateMsg =
  | { phase: 'open'; waitS: number }
  | { phase: 'offered'; seat: 0 | 1; waitS: number }
  | { phase: 'started'; matchId: string; waitS: number }
  | { phase: 'closed'; reason: 'declined' | 'rematch_timeout'; next: 'lobby'; waitS: number };

/** `sproto.online_count`. `ageMs` is how old the server's cache is. */
export interface OnlineCount {
  online: number;
  queued: number;
  ageMs: number;
}

const pairNames = (x: unknown): [string, string] | null => {
  if (!Array.isArray(x) || x.length !== 2) return null;
  return [String(x[0] ?? '').slice(0, 24), String(x[1] ?? '').slice(0, 24)];
};

const pairBools = (x: unknown): [boolean, boolean] | null => {
  if (!Array.isArray(x) || x.length !== 2 || typeof x[0] !== 'boolean' || typeof x[1] !== 'boolean') return null;
  return [x[0], x[1]];
};

export function asFound(x: unknown): FoundMsg | null {
  if (!isObj(x) || !isSeat(x.seat)) return null;
  const names = pairNames(x.names);
  const accepted = pairBools(x.accepted);
  if (!names || !accepted) return null;
  const acceptS = typeof x.acceptS === 'number' && x.acceptS > 0 ? x.acceptS : ACCEPT_S;
  return { acceptS, seat: x.seat, accepted, names };
}

export function asAcceptEnd(x: unknown): AcceptEndMsg | null {
  if (!isObj(x)) return null;
  if (x.status !== 'declined' && x.status !== 'accept_timeout') return null;
  if (x.next !== 'queue' && x.next !== 'lobby') return null;
  return { status: x.status, bySeat: x.bySeat === null || isSeat(x.bySeat) ? x.bySeat : null, next: x.next };
}

export function asRematchState(x: unknown): RematchStateMsg | null {
  if (!isObj(x)) return null;
  const waitS = typeof x.waitS === 'number' && x.waitS >= 0 ? x.waitS : 0;
  if (x.phase === 'open') return { phase: 'open', waitS };
  if (x.phase === 'offered' && isSeat(x.seat)) return { phase: 'offered', seat: x.seat, waitS };
  if (x.phase === 'started' && typeof x.matchId === 'string' && x.matchId) return { phase: 'started', matchId: x.matchId, waitS };
  if (x.phase === 'closed' && (x.reason === 'declined' || x.reason === 'rematch_timeout') && x.next === 'lobby') {
    return { phase: 'closed', reason: x.reason, next: 'lobby', waitS };
  }
  return null;
}

export function asOnlineCount(x: unknown): OnlineCount | null {
  if (!isObj(x) || typeof x.online !== 'number' || typeof x.queued !== 'number') return null;
  return {
    online: Math.max(0, Math.floor(x.online)),
    queued: Math.max(0, Math.floor(x.queued)),
    ageMs: typeof x.ageMs === 'number' && x.ageMs >= 0 ? x.ageMs : 0,
  };
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
