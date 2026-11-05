import { CONFIG } from '../config';

/** What kind of match is being played, and what it allows. Match reads it instead of mode flags. */
export interface MatchRules {
  kind: 'quick' | 'gauntlet' | 'versus' | 'online';
  /** Rounds a side needs (the gauntlet's one life is 1). */
  roundsToWin: number;
  /** Seconds per round on the clock (the gauntlet has none: it counts up). */
  roundTime: number;
  /** Life packs spawn during the fight. */
  lifePacks: boolean;
  /** Learned boss reward spells can be cast. */
  rewardSpells: boolean;
  /** Golden tickets (mana boost) spawn during the fight. */
  tickets: boolean;
  /** God mode (F9, "99", `?god`, Settings) may be used. */
  godModeAllowed: boolean;
  /** The match can pause (online never does: the sim keeps running). */
  pause: boolean;
  /** A win is reported to the hub by the client (Quick Duel and the gauntlet only). */
  reportToHub: boolean;
}

const M = CONFIG.match;

export const QUICK: Readonly<MatchRules> = Object.freeze({
  kind: 'quick', roundsToWin: M.roundsToWin, roundTime: M.roundTime, lifePacks: CONFIG.lifePacks.quickDuel,
  rewardSpells: true, tickets: true, godModeAllowed: true, pause: true, reportToHub: true,
});

export const GAUNTLET: Readonly<MatchRules> = Object.freeze({
  kind: 'gauntlet', roundsToWin: 1, roundTime: M.roundTime, lifePacks: true,
  rewardSpells: true, tickets: true, godModeAllowed: true, pause: true, reportToHub: true,
});

/** Local Versus: two people, one screen. Even and unreported: no reward spells, packs, god mode or hub. */
export const VERSUS: Readonly<MatchRules> = Object.freeze({
  kind: 'versus', roundsToWin: M.roundsToWin, roundTime: M.roundTime, lifePacks: false,
  rewardSpells: false, tickets: true, godModeAllowed: false, pause: true, reportToHub: false,
});

/** Online 1v1: Versus rules, never paused. Stake is 0 Tickets; the client never mints for a win. */
export const ONLINE: Readonly<MatchRules> = Object.freeze({ ...VERSUS, kind: 'online', pause: false });

export function rulesFor(kind: MatchRules['kind']): Readonly<MatchRules> {
  return kind === 'gauntlet' ? GAUNTLET : kind === 'versus' ? VERSUS : kind === 'online' ? ONLINE : QUICK;
}
