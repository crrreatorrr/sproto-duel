import type { HubFriends } from './types';
/** REST friends (/v2/friend) are stretch work. Every call rejects with `not_implemented` until then. */
export declare function createFriendsStub(): HubFriends;
