import { HubSdkError } from './errors';
import { browserKeyValue, memoryKeyValue } from './storage';
function defaultEnv() {
    if (typeof window === 'undefined') {
        throw new HubSdkError('no_window', 'createHubSdk() needs a browser, or pass an env for tests');
    }
    return {
        hubUrl: '/hub/',
        local: browserKeyValue('local'),
        session: browserKeyValue('session'),
        now: () => Date.now(),
        readHash: () => window.location.hash,
        writeHash: (hash) => {
            const next = `${window.location.pathname}${window.location.search}${hash}`;
            window.history.replaceState(null, '', next);
        },
        assign: (url) => {
            window.location.assign(url);
        },
        releasePointer: () => {
            if (document.pointerLockElement)
                document.exitPointerLock();
        },
        clearBeforeUnload: () => {
            window.onbeforeunload = null;
        },
    };
}
export function resolveHubEnv(env) {
    const browser = typeof window !== 'undefined' ? defaultEnv() : null;
    return {
        hubUrl: env.hubUrl ?? browser?.hubUrl ?? '/hub/',
        local: env.local ?? browser?.local ?? memoryKeyValue(),
        session: env.session ?? browser?.session ?? memoryKeyValue(),
        now: env.now ?? browser?.now ?? (() => Date.now()),
        readHash: env.readHash ?? browser?.readHash ?? (() => ''),
        writeHash: env.writeHash ?? browser?.writeHash ?? (() => undefined),
        assign: env.assign ?? browser?.assign ?? (() => undefined),
        releasePointer: env.releasePointer ?? browser?.releasePointer ?? (() => undefined),
        clearBeforeUnload: env.clearBeforeUnload ?? browser?.clearBeforeUnload ?? (() => undefined),
    };
}
