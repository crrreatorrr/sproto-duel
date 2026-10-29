import { CONFIG } from '../config';

/**
 * Hub identity for Sproto Duel.
 * Server game id matches the Nakama schema (`sproto`). The exit hash uses the portal slug.
 */
export const HUB_GAME_ID = 'sproto';
export const HUB_EXIT_SLUG = 'sproto-duel';

/** Flat Tickets for each duel win. The only amount the game reports. */
export const TICKETS_PER_WIN = CONFIG.hub.ticketsPerWin;
export const TICKETS_PER_VERSE = CONFIG.hub.ticketsPerVerse;
export const VERSE_DAILY_CAP = CONFIG.hub.verseDailyCap;

/** Relic trigger the hub server grants Tinubu's Crown for. */
export const TINUBU_EVENT = 'sproto.boss_defeated';
export const TINUBU_BOSS_ID = 'tinubu';
export const TINUBU_RELIC = 'tinubu_crown';

/** Nakama leaderboard. Increment boards take the delta, not a lifetime total. */
export const WINS_BOARD = 'sproto_wins';
export const WIN_REASON = 'duel_win';
