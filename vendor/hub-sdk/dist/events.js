import { RELIC_BY_GAME } from './types';
/**
 * Event ids games report through `reportEvent`.
 * `ready` is the boot handshake. `game_beaten` is accepted but grants nothing: the
 * server has no open rule for it (migration 0008), so a client cannot claim a relic
 * by saying it won. The six relic triggers from the architecture doc are unchanged.
 * `hpos10i.boss_defeated` is the Deathbot Life Medal event. It is not a Relic trigger,
 * so `relicForEvent` does not grant from it.
 * `coop.stage_clear` with `{ stage: 1 }` (Sproto Coop Battle, Tidebreak Marina) grants the Marina
 * Anchor, and `shooter.wave_clear` with `{ wave: 1 }` (Sproto Shooter, Wave Mode) grants the Dragon
 * Scale. Both count in God Mode. `coop.boss_clear` and `shooter.boss_clear` are server-only names
 * and are not listed here: the server refuses them from a client.
 */
export const HubEvent = {
    Ready: 'ready',
    GameBeaten: 'game_beaten',
    Hpos10iLevelComplete: 'hpos10i.level_complete',
    Hpos10iBossDefeated: 'hpos10i.boss_defeated',
    PbQuestComplete: 'pb.quest_complete',
    NobuBossDefeated: 'nobu.boss_defeated',
    SprotoBossDefeated: 'sproto.boss_defeated',
    FighterStoryLevelComplete: 'fighter.story_level_complete',
    ArcadeBossDefeated: 'arcade.boss_defeated',
    CoopStageClear: 'coop.stage_clear',
    ShooterWaveClear: 'shooter.wave_clear',
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
    if (eventId === HubEvent.Ready || eventId === HubEvent.GameBeaten)
        return undefined;
    if (eventId === HubEvent.Hpos10iLevelComplete && game === 'hpos10i') {
        if (payload.zone === 'z1_retro_rush_hills' && payload.act === 1)
            return own;
        return undefined;
    }
    if (eventId === HubEvent.PbQuestComplete && game === 'peoples-bitcoin') {
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
    if (eventId === HubEvent.FighterStoryLevelComplete && game === 'sproto-fighter') {
        if (payload.world === 1)
            return own;
        return undefined;
    }
    if (eventId === HubEvent.ArcadeBossDefeated && game === 'sproto-arcade') {
        if (payload.boss === 'bront')
            return own;
        return undefined;
    }
    if (eventId === HubEvent.CoopStageClear && game === 'sproto-coop-battle') {
        if (payload.stage === 1)
            return own;
        return undefined;
    }
    if (eventId === HubEvent.ShooterWaveClear && game === 'sproto-shooter') {
        if (payload.wave === 1)
            return own;
        return undefined;
    }
    return undefined;
}
