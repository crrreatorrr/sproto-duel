import { type HubSdkEnv } from './env';
import type { NakamaClient } from './nakama';
import { type HubSdk } from './types';
/**
 * Hub SDK backed by Nakama. `init` reads `#t=<ticket>`, strips it, and exchanges it
 * for a game-scoped session cached in sessionStorage. Without a ticket or a cached
 * session every call no-ops so the game still runs standalone.
 */
export declare function createLiveHubSdk(env: HubSdkEnv, client: NakamaClient): HubSdk;
//# sourceMappingURL=live.d.ts.map