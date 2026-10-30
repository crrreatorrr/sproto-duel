import { type HubSdkEnv } from './env';
import { type HubSdk } from './types';
export type { HubSdkEnv };
/**
 * Game-facing hub SDK. Pass `serverUrl` (or a `client`) to talk to Nakama.
 * Omit both and the in-memory mock stays in place for unit tests and for a
 * game that is running outside the hub. With no ticket and no session every
 * call no-ops, so the game still runs standalone.
 */
export declare function createHubSdk(env?: HubSdkEnv): HubSdk;
/** Puts the SDK on `window.hubSdk` for the Godot JavaScriptBridge and plain script tags. */
export declare function installHubSdk(sdk?: HubSdk): HubSdk;
