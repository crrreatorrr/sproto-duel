import { describe, expect, it } from 'vitest';
import { seededRandom } from './transport';
import {
  asInput, asOutcome, asResult, asRound, asStart, GAME_ID, matchmakerRequest, NET_VERSION, normalizeRoomCode, normalizeStaff,
  OP, parseLabel, ROOM_ALPHABET, roomCode,
} from './protocol';

describe('protocol', () => {
  it('uses the hub game id and the frozen opcodes', () => {
    expect(GAME_ID).toBe('sproto');
    expect(OP).toMatchObject({ HELLO: 1, START: 2, SIGNAL: 3, INPUT: 10, SNAPSHOT: 11, ROUND: 12, RESULT: 13, OUTCOME: 14, CANCEL: 15, PEER: 16, PING: 17, FORFEIT: 18, REMATCH: 23 });
    expect(matchmakerRequest()).toEqual({
      query: `+properties.game:sproto +properties.v:${NET_VERSION}`, minCount: 2, maxCount: 2, stringProperties: { game: 'sproto', v: NET_VERSION },
    });
  });

  it('makes 6-character room codes from the unambiguous alphabet', () => {
    const rnd = seededRandom(7);
    for (let i = 0; i < 200; i++) {
      const c = roomCode(rnd);
      expect(c).toHaveLength(6);
      for (const ch of c) expect(ROOM_ALPHABET).toContain(ch);
    }
    expect(ROOM_ALPHABET).not.toMatch(/[01ILO]/);
    expect(ROOM_ALPHABET).toHaveLength(31);
  });

  it('normalizes typed codes and rejects impossible ones', () => {
    expect(normalizeRoomCode(' ab-c 234 ')).toBe('ABC234');
    expect(normalizeRoomCode('ABC23')).toBeNull();
    expect(normalizeRoomCode('ABC2O4')).toBeNull();
    expect(normalizeRoomCode('ABC214')).toBeNull();
  });

  it('validates bodies', () => {
    expect(asStart({ seat: 1, hostSeat: 0, names: ['a', 'b'], staffs: ['duel_staff_nobu', 'x'], seed: 4 })).toEqual({
      seat: 1, hostSeat: 0, names: ['a', 'b'], staffs: ['duel_staff_nobu', 'duel_staff_sproto'], rules: 'online1', seed: 4,
    });
    expect(asStart({ seat: 2, hostSeat: 0 })).toBeNull();
    expect(asInput({ t: 5, f: [1, 2] })).toEqual({ t: 5, f: [1, 2] });
    expect(asInput({ t: 'x', f: [] })).toBeNull();
    expect(asRound({ round: 1, winnerSeat: null, reason: 'time', wins: [0, 0] })).not.toBeNull();
    expect(asRound({ round: 1, winnerSeat: 3, reason: 'ko', wins: [1, 0] })).toBeNull();
    expect(asResult({ winnerSeat: 0, wins: [2, 1], rounds: 3 })).toEqual({ winnerSeat: 0, wins: [2, 1], rounds: 3 });
    expect(asResult({ winnerSeat: 0, wins: [2], rounds: 3 })).toBeNull();
    expect(asOutcome({ status: 'verified', winnerSeat: 1, reason: 'agreed', paid: { u: 20, bad: 'x' } })).toEqual({ status: 'verified', winnerSeat: 1, reason: 'agreed', paid: { u: 20 }, balances: undefined });
    expect(asOutcome({ status: 'nope' })).toBeNull();
    expect(normalizeStaff('duel_staff_momentum')).toBe('duel_staff_momentum');
    expect(normalizeStaff(42)).toBe('duel_staff_sproto');
  });

  it('parses arena labels', () => {
    expect(parseLabel('{"game":"sproto","kind":"sproto_arena","v":"1","open":true,"code":"ABC234"}')).toEqual({ game: 'sproto', kind: 'sproto_arena', v: '1', open: true, code: 'ABC234' });
    expect(parseLabel('{"kind":"hub"}')).toBeNull();
    expect(parseLabel(null)).toBeNull();
  });
});
