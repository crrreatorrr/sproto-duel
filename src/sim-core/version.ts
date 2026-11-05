/**
 * The sim version. In the server bundle, `DUEL_SIM_VERSION` is the top-level global the build
 * writes on its first line (sha256 of the bundle body, first 16 hex digits). Running from source
 * (the game, tests) there is no such global and the version is 'dev'; the game stamps logs with
 * the version of the bundle built from the same source (see scripts/build-server-sim.mjs).
 */
declare const DUEL_SIM_VERSION: string | undefined;

let override: string | null = null;

export function simVersion(): string {
  if (override !== null) return override;
  return typeof DUEL_SIM_VERSION === 'string' ? DUEL_SIM_VERSION : 'dev';
}

/** The game sets the version of the bundle it was built with (logs must name it). */
export function setSimVersion(v: string | null): void {
  override = v;
}
