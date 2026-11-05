import { STORY_BOSS_IDS, TINUBU_EVENT, WINS_BOARD } from './config';

const STORY_BOSSES: ReadonlySet<string> = new Set(STORY_BOSS_IDS);

export interface DuelWin {
  /**
   * What was played. Local Versus and online report nothing from the client: Versus could be
   * farmed on one screen, and an online win mints no Tickets (stake is 0). Quick Duel posts a
   * ranked score only. A Boss Gauntlet win against a story boss posts `sproto.boss_defeated`.
   */
  mode?: 'quick' | 'gauntlet' | 'versus' | 'online';
  playerWon: boolean;
  /** Campaign boss id, or null for a Quick Duel. */
  bossId: string | null;
  /** God mode was on during the live fight. Those wins skip the leaderboard. The boss event still posts. */
  godMode: boolean;
  /** Ranked portal sessions are the only ones that post a score. */
  ranked: boolean;
  /** Fight length in seconds (gauntlet clock). Rounded into the event payload. */
  elapsed: number;
  /** Stable for retries of this win, new for the next win. */
  matchId: string;
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

export type HubCall = EventCall | ScoreCall;

/**
 * What a finished duel reports to the hub.
 * A loss reports nothing, and so do Local Versus and online. Quick Duel posts no Tickets.
 * A Boss Gauntlet win against sahil, obama, broccoli, agent, or tinubu posts
 * `sproto.boss_defeated` with that id. The client does not mint Tickets.
 * God-mode and unranked wins skip the leaderboard.
 */
export function planDuelWin(win: DuelWin): HubCall[] {
  if (!win.playerWon) return [];
  if (win.mode === 'versus' || win.mode === 'online') return [];
  const calls: HubCall[] = [];
  // Boss Gauntlet only. Quick Duel is a free CPU fight and passes mode 'quick'.
  // Versus and online already returned. A caller that names a story boss and no mode
  // keeps Tinubu's existing report (and the same report for the other four ids).
  // `midget` is not in STORY_BOSSES.
  if (win.mode !== 'quick' && win.bossId !== null && STORY_BOSSES.has(win.bossId)) {
    calls.push({
      kind: 'event',
      eventId: TINUBU_EVENT,
      data: { boss: win.bossId, elapsed: Math.round(win.elapsed) },
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
