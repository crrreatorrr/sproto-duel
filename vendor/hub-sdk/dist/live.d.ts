import { type HubSdkEnv } from './env';
import type { NakamaClient } from './nakama';
import { type HubSdk } from './types';
/** IndexedDB database for earn, event, and exchange writes that have not been acked. */
export declare const HUB_OUTBOX_DB = "hub-outbox";
/**
 * Hub SDK backed by Nakama. `init` reads `#t=<ticket>`, strips it, and redeems it
 * with custom auth. Later calls send only that session token. Without a ticket or a
 * cached session every call no-ops so the game still runs standalone.
 */
export declare function createLiveHubSdk(env: HubSdkEnv, client: NakamaClient): HubSdk;
