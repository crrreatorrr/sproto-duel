import type { HubSdk } from '../types';
import type { HubRealtime, RealtimeOptions } from './types';
/**
 * Dependency-free Nakama realtime client (WebSocket + JSON protocol). It reconnects
 * with jittered backoff, re-joins matches and channels, and re-adds matchmaker tickets.
 */
export declare function createRealtime(options: RealtimeOptions): HubRealtime;
/** null when the SDK has no live session (standalone / mock without session), so games keep running offline. */
export declare function realtimeFromSdk(sdk: HubSdk, options?: Omit<RealtimeOptions, 'getToken'>): HubRealtime | null;
