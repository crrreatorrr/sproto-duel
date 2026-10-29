import { describe, expect, it } from 'vitest';
import { TICKETS_PER_WIN, TINUBU_EVENT, WINS_BOARD } from './config';
import { planDuelWin, type DuelWin } from './report';

const win = (over: Partial<DuelWin> = {}): DuelWin => ({
  playerWon: true,
  bossId: null,
  godMode: false,
  ranked: false,
  elapsed: 12.4,
  matchId: 'match-1',
  ...over,
});

describe('planDuelWin', () => {
  it('locks the flat Ticket amount at 20', () => {
    expect(TICKETS_PER_WIN).toBe(20);
  });

  it('reports nothing for a loss', () => {
    expect(planDuelWin(win({ playerWon: false, bossId: 'tinubu', ranked: true }))).toEqual([]);
  });

  it('earns 20 Tickets for a Quick Duel win and skips the board when unranked', () => {
    expect(planDuelWin(win())).toEqual([
      { kind: 'earn', amount: 20, reason: 'duel_win', key: 'sproto:win:match-1' },
    ]);
  });

  it('posts one win on the ranked board', () => {
    const calls = planDuelWin(win({ ranked: true, bossId: 'sahil' }));
    expect(calls).toContainEqual({
      kind: 'score',
      boardId: WINS_BOARD,
      value: 1,
      meta: { matchId: 'match-1', boss: 'sahil' },
    });
  });

  it('keeps Tickets and the Tinubu event in god mode, and skips the score', () => {
    const calls = planDuelWin(win({ bossId: 'tinubu', godMode: true, ranked: true, elapsed: 90.6 }));
    expect(calls.map((call) => call.kind)).toEqual(['earn', 'event']);
    expect(calls[1]).toEqual({
      kind: 'event',
      eventId: TINUBU_EVENT,
      data: { boss: 'tinubu', elapsed: 91 },
      key: 'sproto.boss_defeated:match-1',
    });
  });

  it('reports Tinubu with a ranked score when the fight was clean', () => {
    const kinds = planDuelWin(win({ bossId: 'tinubu', ranked: true })).map((call) => call.kind);
    expect(kinds).toEqual(['earn', 'event', 'score']);
  });

  it('uses the same idempotency keys for the same match id', () => {
    const a = planDuelWin(win({ bossId: 'tinubu' }));
    const b = planDuelWin(win({ bossId: 'tinubu', elapsed: 90 }));
    expect(a.map((call) => ('key' in call ? call.key : ''))).toEqual(b.map((call) => ('key' in call ? call.key : '')));
  });
});
