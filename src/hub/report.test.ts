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

  it('reports nothing for Local Versus, online, or an unranked Quick Duel', () => {
    expect(planDuelWin(win({ mode: 'versus', ranked: true }))).toEqual([]);
    expect(planDuelWin(win({ mode: 'online', ranked: true, bossId: 'tinubu' }))).toEqual([]);
    expect(planDuelWin(win({ mode: 'quick' }))).toEqual([]);
  });

  it('reports nothing for a loss', () => {
    expect(planDuelWin(win({ playerWon: false, bossId: 'tinubu', ranked: true }))).toEqual([]);
  });

  it('posts nothing for an unranked Quick Duel and skips the board', () => {
    expect(planDuelWin(win({ mode: 'quick' }))).toEqual([]);
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

  it('posts the Tinubu event in god mode and skips the score', () => {
    const calls = planDuelWin(win({ bossId: 'tinubu', godMode: true, ranked: true, elapsed: 90.6 }));
    expect(calls.map((call) => call.kind)).toEqual(['event']);
    expect(calls[0]).toEqual({
      kind: 'event',
      eventId: TINUBU_EVENT,
      data: { boss: 'tinubu', elapsed: 91 },
      key: 'sproto.boss_defeated:match-1',
    });
  });

  it('reports Tinubu with a ranked score when the fight was clean', () => {
    const kinds = planDuelWin(win({ bossId: 'tinubu', ranked: true })).map((call) => call.kind);
    expect(kinds).toEqual(['event', 'score']);
  });

  it('uses the same idempotency keys for the same match id', () => {
    const a = planDuelWin(win({ bossId: 'tinubu' }));
    const b = planDuelWin(win({ bossId: 'tinubu', elapsed: 90 }));
    expect(a.map((call) => ('key' in call ? call.key : ''))).toEqual(b.map((call) => ('key' in call ? call.key : '')));
  });
});
