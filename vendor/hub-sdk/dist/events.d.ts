import { type GameId, type RelicId } from './types';
/**
 * Event ids games report through `reportEvent`.
 * `ready` is the boot handshake. `game_beaten` is accepted but grants nothing: the
 * server has no open rule for it (migration 0008), so a client cannot claim a relic
 * by saying it won. The five `*.` ids are the relic triggers from the architecture doc.
 */
export declare const HubEvent: {
    readonly Ready: "ready";
    readonly GameBeaten: "game_beaten";
    readonly Hpos10iLevelComplete: "hpos10i.level_complete";
    readonly PbQuestComplete: "pb.quest_complete";
    readonly NobuBossDefeated: "nobu.boss_defeated";
    readonly SprotoBossDefeated: "sproto.boss_defeated";
    readonly FighterStoryLevelComplete: "fighter.story_level_complete";
};
export type HubEventId = (typeof HubEvent)[keyof typeof HubEvent];
/**
 * Returns the relic this event would grant for an open session of `game`,
 * or undefined when the payload is not that game's completion trigger.
 */
export declare function relicForEvent(game: GameId, eventId: string, data: object): RelicId | undefined;
