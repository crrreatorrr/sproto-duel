import { TINUBU_BOSS_ID, TINUBU_EVENT, TICKETS_PER_WIN, WIN_REASON, WINS_BOARD } from './config';

export interface DuelWin {
  playerWon: boolean;
  /** Campaign boss id, or null for a Quick Duel. */
  bossId: string | null;
  /** God mode was on during the live fight. Those wins still earn Tickets and the Relic. */
  godMode: boolean;
  /** Ranked portal sessions are the only ones that post a score. */
  ranked: boolean;
  /** Fight length in seconds (gauntlet clock). Rounded into the event payload. */
  elapsed: number;
  /** Stable for retries of this win, new for the next win. */
  matchId: string;
}

export interface EarnCall {
  kind: 'earn';
  amount: number;
  reason: string;
  key: string;
}

export interface EventCall {
  kind: 'event';
  eventId: string;
  data: { boss: string; elapsed: number };
  key: string;
}

export interface ScoreCall {
  kind: 'score';
  boardId: string;
  value: number;
  meta: { matchId: string; boss: string | null };
}

export type HubCall = EarnCall | EventCall | ScoreCall;

/**
 * What a finished duel reports to the hub.
 * A loss reports nothing. A win earns a flat Ticket amount. Beating Tinubu also reports the
 * Relic event. God-mode and unranked wins skip the leaderboard.
 */
export function planDuelWin(win: DuelWin): HubCall[] {
  if (!win.playerWon) return [];
  const calls: HubCall[] = [
    {
      kind: 'earn',
      amount: TICKETS_PER_WIN,
      reason: WIN_REASON,
      key: `sproto:win:${win.matchId}`,
    },
  ];
  if (win.bossId === TINUBU_BOSS_ID) {
    calls.push({
      kind: 'event',
      eventId: TINUBU_EVENT,
      data: { boss: TINUBU_BOSS_ID, elapsed: Math.round(win.elapsed) },
      key: `${TINUBU_EVENT}:${win.matchId}`,
    });
  }
  if (!win.godMode && win.ranked) {
    calls.push({
      kind: 'score',
      boardId: WINS_BOARD,
      value: 1,
      meta: { matchId: win.matchId, boss: win.bossId },
    });
  }
  return calls;
}
