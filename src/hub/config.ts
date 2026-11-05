import { CONFIG } from '../config';

/**
 * Hub identity for Sproto Duel.
 * Server game id matches the Nakama schema (`sproto`).
 * Return to Hub uses `VITE_HUB_URL` plus `#from=sproto-duel`.
 */
export const HUB_GAME_ID = 'sproto';
/** Portal slug in the hub return hash (`#from=sproto-duel`). */
export const HUB_EXIT_SLUG = 'sproto-duel';

/**
 * Former flat win amount. The client does not send it. Story bosses are paid by the hub
 * on `sproto.boss_defeated` (20 T, once per player per boss per UTC day).
 */
export const TICKETS_PER_WIN = CONFIG.hub.ticketsPerWin;
export const TICKETS_PER_VERSE = CONFIG.hub.ticketsPerVerse;
export const VERSE_DAILY_CAP = CONFIG.hub.verseDailyCap;

/** `session.event` id for a story-boss win. The hub matches `data.boss`. */
export const TINUBU_EVENT = 'sproto.boss_defeated';
export const TINUBU_BOSS_ID = 'tinubu';
export const TINUBU_RELIC = 'tinubu_crown';
/**
 * Story bosses the hub pays for. The Midget (`midget`) is Obama's partner and is not a boss id.
 * Quick Duel, online, and Local Versus do not post this event.
 */
export const STORY_BOSS_IDS = ['sahil', 'obama', 'broccoli', 'agent', TINUBU_BOSS_ID] as const;

/** Nakama leaderboard. Increment boards take the delta, not a lifetime total. */
export const WINS_BOARD = 'sproto_wins';
/** Not sent. The hub ceiling for this reason is 0. */
export const WIN_REASON = 'duel_win';
