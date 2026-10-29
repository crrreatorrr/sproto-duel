/** Game ids stored on the server and used in `/hub#from=<game>` and `play/<game>`. */
export const GAME_IDS = ['hpos10i', 'nobu', 'pb', 'sproto'];
/** Earn-once relics. The primary key on the server is (user, relic). */
export const RELIC_IDS = ['hpos10i_core', 'genesis_shard', 'cones_tip', 'tinubu_crown'];
export const RELIC_BY_GAME = {
    hpos10i: 'hpos10i_core',
    pb: 'genesis_shard',
    nobu: 'cones_tip',
    sproto: 'tinubu_crown',
};
/**
 * Nakama leaderboard ids. Sort direction matches the architecture:
 * times are ascending best, XP and meta are set, Sproto wins increment.
 */
export const BoardId = {
    Hpos10iActTime: 'hpos10i_act_time',
    NobuTrialTime: 'nobu_trial_time',
    PbTotalXp: 'pb_total_xp',
    SprotoWins: 'sproto_wins',
    Meta: 'meta',
};
export const BOARD_IDS = [
    BoardId.Hpos10iActTime,
    BoardId.NobuTrialTime,
    BoardId.PbTotalXp,
    BoardId.SprotoWins,
    BoardId.Meta,
];
/** 10 Tickets = 1 Verse. At most 50 Verse per game per day. */
export const TICKETS_PER_VERSE = 10;
export const VERSE_DAILY_CAP = 50;
/** Mock-only daily earn cap. The real per-event caps arrive with the Go module. */
export const MOCK_TICKET_EARN_CAP = 1000;
/** Portal tickets are single-use and short-lived. */
export const MOCK_TICKET_TTL_SECONDS = 60;
export function isGameId(value) {
    return GAME_IDS.includes(value);
}
export function isRelicId(value) {
    return RELIC_IDS.includes(value);
}
export function isBoardId(value) {
    return BOARD_IDS.includes(value);
}
//# sourceMappingURL=types.js.map