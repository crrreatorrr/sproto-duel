import { RELIC_BY_GAME } from './types';
/**
 * Event ids games report through `reportEvent`.
 * `ready` is the boot handshake. `game_beaten` grants that game's relic.
 * The four `*.` ids are the production triggers from the architecture doc.
 */
export const HubEvent = {
    Ready: 'ready',
    GameBeaten: 'game_beaten',
    Hpos10iLevelComplete: 'hpos10i.level_complete',
    PbQuestComplete: 'pb.quest_complete',
    NobuBossDefeated: 'nobu.boss_defeated',
    SprotoBossDefeated: 'sproto.boss_defeated',
};
function record(data) {
    return data;
}
/**
 * Returns the relic this event would grant for an open session of `game`,
 * or undefined when the payload is not that game's completion trigger.
 */
export function relicForEvent(game, eventId, data) {
    const payload = record(data);
    const own = RELIC_BY_GAME[game];
    if (eventId === HubEvent.Ready)
        return undefined;
    if (eventId === HubEvent.GameBeaten) {
        const requested = payload.relicId;
        if (typeof requested === 'string' && requested !== own)
            return undefined;
        return own;
    }
    if (eventId === HubEvent.Hpos10iLevelComplete && game === 'hpos10i') {
        if (payload.zone === 'z1_retro_rush_hills' && payload.act === 1)
            return own;
        return undefined;
    }
    if (eventId === HubEvent.PbQuestComplete && game === 'pb') {
        if (payload.questId === 'quest_tutorial')
            return own;
        return undefined;
    }
    if (eventId === HubEvent.NobuBossDefeated && game === 'nobu') {
        if (payload.boss === 'cone')
            return own;
        return undefined;
    }
    if (eventId === HubEvent.SprotoBossDefeated && game === 'sproto') {
        if (payload.boss === 'tinubu')
            return own;
        return undefined;
    }
    return undefined;
}
