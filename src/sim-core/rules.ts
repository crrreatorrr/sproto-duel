/** Match rules per mode (src/core/rules.ts), as the sim reads them. */
import { CONFIG } from '../config';
import { sec } from './fixed';

export type RulesId = 'quick' | 'gauntlet' | 'versus' | 'online';
export const RULES_IDS: readonly RulesId[] = ['quick', 'gauntlet', 'versus', 'online'];

export interface SimRules {
  id: RulesId;
  roundsToWin: number;
  /** TU on the round clock (the gauntlet counts up instead). */
  roundTime: number;
  tickets: boolean;
  lifePacks: boolean;
  rewardSpells: boolean;
  /** Staffs are looks only (starter stats) and no reward spells. */
  even: boolean;
  /** One round, one life, boss stages (a boss fight). */
  single: boolean;
}

const M = CONFIG.match;

export function simRules(id: RulesId): SimRules {
  switch (id) {
    case 'gauntlet':
      return { id, roundsToWin: 1, roundTime: sec(M.roundTime), tickets: true, lifePacks: true, rewardSpells: true, even: false, single: true };
    case 'versus':
    case 'online':
      return { id, roundsToWin: M.roundsToWin, roundTime: sec(M.roundTime), tickets: true, lifePacks: false, rewardSpells: false, even: true, single: false };
    default:
      return { id: 'quick', roundsToWin: M.roundsToWin, roundTime: sec(M.roundTime), tickets: true, lifePacks: CONFIG.lifePacks.quickDuel, rewardSpells: true, even: false, single: false };
  }
}

export function isRulesId(x: unknown): x is RulesId {
  return x === 'quick' || x === 'gauntlet' || x === 'versus' || x === 'online';
}
