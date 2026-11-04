// Nakama's client server key. Custom-auth ticket redeem sends it as Basic auth; it is
// not the runtime HTTP key and not a secret. A production build takes
// VITE_NAKAMA_SERVER_KEY, or every redeem is refused (401 "Server key invalid") and the
// game runs without a hub session: no Tickets banked, no Relic sent, no Relic gear.
// `vite dev` falls back to the compose default, like the hub. So does a build served from
// this machine: the dev hub serves game builds from its public/play/<slug>/, and
// metaverse-hub's server/scripts/dev-env.sh keeps Nakama's stock key for local stacks.

export const LOCAL_SERVER_KEY = 'defaultkey';

const LOOPBACK_HOST = /^(localhost|[\w-]+\.localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i;

export interface ServerKeyInputs {
  envKey?: string;
  dev?: boolean;
  hostname?: string;
}

export function nakamaServerKey({ envKey, dev, hostname }: ServerKeyInputs = {}): string {
  if (envKey) return envKey;
  if (dev) return LOCAL_SERVER_KEY;
  return LOOPBACK_HOST.test(String(hostname ?? '')) ? LOCAL_SERVER_KEY : '';
}

/** The key for this page: VITE_NAKAMA_SERVER_KEY, else the local stock key in dev or on a loopback host. */
export function pageServerKey(): string {
  return nakamaServerKey({
    envKey: import.meta.env.VITE_NAKAMA_SERVER_KEY,
    dev: import.meta.env.DEV,
    hostname: typeof location !== 'undefined' ? location.hostname : '',
  });
}
