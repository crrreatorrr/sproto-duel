// @metaverse/hub-sdk/core: a lean sub-path (0.9.0). The root entry still exports everything.
export { BOARD_IDS, BoardId, FOUR_LIGHTS_RELIC_IDS, GAME_IDS, MOCK_TICKET_EARN_CAP, MOCK_TICKET_TTL_SECONDS, NOBU_TRIAL_CEIL_MS, NOBU_TRIAL_FLOOR_MS, RELIC_BY_GAME, RELIC_IDS, SAVE_MAX_BYTES, TICKETS_PER_VERSE, VERSE_DAILY_CAP, canonicalGameId, isBoardId, isGameId, isRelicId, } from '../types';
export { HubEvent, relicForEvent } from '../events';
export { EMPTY_SAVE, encodeSave, readSaveResult } from '../save';
export { DEVICE_ID_KEY, getOrCreateDeviceId, memoryKeyValue } from '../storage';
export { MOCK_TICKET_KEY, mintMockTicket, readTicketParam, stripTicketParam, verifyMockTicket, } from '../ticket';
export { createHubSdk, installHubSdk } from '../createHubSdk';
export { HubSdkError } from '../errors';
export { HUB_OUTBOX_DB } from '../live';
export { LOCAL_NAKAMA, createNakamaClient, tokenExpiryMs, userIdFromToken, } from '../nakama';
