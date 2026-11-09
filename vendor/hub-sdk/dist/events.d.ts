import { type GameId, type RelicId } from './types';
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
export declare const HubEvent: {
    readonly Ready: "ready";
    readonly GameBeaten: "game_beaten";
    readonly Hpos10iLevelComplete: "hpos10i.level_complete";
    readonly Hpos10iBossDefeated: "hpos10i.boss_defeated";
    readonly PbQuestComplete: "pb.quest_complete";
    readonly NobuBossDefeated: "nobu.boss_defeated";
    readonly SprotoBossDefeated: "sproto.boss_defeated";
    readonly FighterStoryLevelComplete: "fighter.story_level_complete";
    readonly ArcadeBossDefeated: "arcade.boss_defeated";
    readonly CoopStageClear: "coop.stage_clear";
    readonly ShooterWaveClear: "shooter.wave_clear";
};
export type HubEventId = (typeof HubEvent)[keyof typeof HubEvent];
/**
 * Returns the relic this event would grant for an open session of `game`,
 * or undefined when the payload is not that game's completion trigger.
 */
export declare function relicForEvent(game: GameId, eventId: string, data: object): RelicId | undefined;
