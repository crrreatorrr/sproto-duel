/**
 * Entry of the server bundle (dist/duel-sim.server.js). The build wraps this in
 * `var DuelSim = (function () { ... })();` after a first line `var DUEL_SIM_VERSION = '...';`.
 */
import { replay as run, type ReplayResult } from './replay';
import { chunkLog, joinChunks, type DuelLog } from './log';
import { simVersion } from './version';

/** `DuelSim.replay(log)`: never throws (see docs/SERVER-SIM.md). Accepts the log object or its JSON. */
export function replay(log: DuelLog | string): ReplayResult {
  let parsed: DuelLog = log as DuelLog;
  if (typeof log === 'string') {
    try {
      parsed = JSON.parse(log);
    } catch (e) {
      parsed = null as unknown as DuelLog;
    }
  }
  return run(parsed);
}

export const DUEL_SIM_VERSION = simVersion();
export { chunkLog, joinChunks };
