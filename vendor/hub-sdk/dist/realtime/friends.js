import { HubSdkError } from '../errors';
/** REST friends (/v2/friend) are stretch work. Every call rejects with `not_implemented` until then. */
export function createFriendsStub() {
    const nope = () => Promise.reject(new HubSdkError('not_implemented', 'Friends are not available yet'));
    return { list: nope, add: nope, remove: nope, block: nope };
}
