import type { NakamaClient } from './nakama';
import { type KeyValue } from './storage';
export interface HubSdkEnv {
    /** Page the game returns to. `exit` appends `#from=<game>`. */
    hubUrl?: string;
    /**
     * Nakama HTTP origin. Empty string means same-origin (the Vite dev server proxies `/v2`).
     * Set this to use the live server. Omit it, and the SDK keeps the in-memory mock used by unit tests.
     */
    serverUrl?: string;
    /** Injected Nakama client. When set, the SDK uses the live path. */
    client?: NakamaClient;
    /** Keep the in-memory mock even if a server URL or client is set. */
    useMock?: boolean;
    local?: KeyValue;
    session?: KeyValue;
    now?: () => number;
    /** UTC clock for mock daily Ticket and Verse buckets. Falls back to `now`. */
    serverNow?: () => number;
    readHash?: () => string;
    writeHash?: (hash: string) => void;
    assign?: (url: string) => void;
    releasePointer?: () => void;
    clearBeforeUnload?: () => void;
}
export interface ResolvedEnv {
    hubUrl: string;
    local: KeyValue;
    session: KeyValue;
    now: () => number;
    readHash: () => string;
    writeHash: (hash: string) => void;
    assign: (url: string) => void;
    releasePointer: () => void;
    clearBeforeUnload: () => void;
}
export declare function resolveHubEnv(env: HubSdkEnv): ResolvedEnv;
