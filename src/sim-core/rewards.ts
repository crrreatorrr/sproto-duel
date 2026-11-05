/**
 * Boss reward spells in the sim: the deterministic port of src/spells/RewardSpells.ts (Magic
 * Carpet, Pump It, Vape Cloud, Lock-On, Hellfire Breath, burning, carpet rams). STUB: the interface
 * the world, spells and AI use; the port fills in the bodies. Carpet and flight movement live in
 * wizard.ts already.
 */
import type { SimProjectile } from './spells';
import type { SimWizard } from './wizard';
import type { SimWorld } from './world';

/** REWARD_SPELLS order (src/spells/rewardCatalog.ts); SimWizard.learned bit i and rcd[i]. */
export const REWARDS = ['carpet', 'pump', 'vape', 'lockon', 'breath'] as const;
export const R_CARPET = 0, R_PUMP = 1, R_VAPE = 2, R_LOCKON = 3, R_BREATH = 4;
/** Action index (wizard.ts ACTIONS) of reward spell i is 7 + i. */
export const REWARD_ACTION = 7;

/** A smoke screen a wizard dropped (Arena smokes). */
export interface SimSmoke {
  owner: number;
  x: number;
  z: number;
  r: number;
  height: number;
  age: number;
  life: number;
}

export class SimRewards {
  readonly smokes: SimSmoke[] = [];

  constructor(protected readonly world: SimWorld) {}

  /** `w` could cast reward spell `id` (REWARDS index) right now. */
  ready(_w: SimWizard, _id: number): boolean {
    return false;
  }

  /** Buffered reward presses into casts; runs in SimSpells.handleIntents before the core spells. */
  handleIntents(_w: SimWizard): void {}

  /** Effects over time: the breath cone, burning, vape healing, carpet rams, smoke expiry. */
  update(_dt: number): void {}

  /** Lock-On's target for a bolt `w` launches now (wizard index), or -1. */
  lockTarget(_w: SimWizard): number {
    return -1;
  }

  /** Curve a lock-on bolt toward its target. */
  steer(_p: SimProjectile, _dt: number): void {}

  /** The smoke `owner` (index, -1 anyone) dropped that (x, z) stands in, or null. */
  smokeAt(_x: number, _z: number, _owner: number): SimSmoke | null {
    return null;
  }

  clear(): void {
    this.smokes.length = 0;
  }
}
