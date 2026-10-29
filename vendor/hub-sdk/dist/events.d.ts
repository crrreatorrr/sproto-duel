import { type GameId, type RelicId } from './types';
/**
 * Event ids games report through `reportEvent`.
 * `ready` is the boot handshake. `game_beaten` grants that game's relic.
 * The four `*.` ids are the production triggers from the architecture doc.
 */
export declare const HubEvent: {
    readonly Ready: "ready";
    readonly GameBeaten: "game_beaten";
    readonly Hpos10iLevelComplete: "hpos10i.level_complete";
    readonly PbQuestComplete: "pb.quest_complete";
    readonly NobuBossDefeated: "nobu.boss_defeated";
    readonly SprotoBossDefeated: "sproto.boss_defeated";
};
export type HubEventId = (typeof HubEvent)[keyof typeof HubEvent];
/**
 * Returns the relic this event would grant for an open session of `game`,
 * or undefined when the payload is not that game's completion trigger.
 */
export declare function relicForEvent(game: GameId, eventId: string, data: object): RelicId | undefined;
//# sourceMappingURL=events.d.ts.map