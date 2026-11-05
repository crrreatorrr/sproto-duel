/**
 * Life packs in the sim: the deterministic port of src/arena/LifePacks.ts gameplay (Boss Gauntlet
 * health pickups for the player, at most three a fight, spread over the stages). STUB.
 */
import type { SimWizard } from './wizard';
import type { SimWorld } from './world';

export interface SimLifePack {
  id: number;
  active: boolean;
  x: number;
  z: number;
  age: number;
}

export class SimLifePacks {
  /** Spawning, ageing and pickups run only while true (the gauntlet's fight phase). */
  enabled = false;
  readonly pack: SimLifePack = { id: 0, active: false, x: 0, z: 0, age: 0 };

  constructor(protected readonly world: SimWorld) {}

  /** A new fight (match start): the fight's pack count and clocks reset. */
  reset(): void {}

  /** Round start: no pack on the floor. */
  clearPack(): void {
    this.pack.active = false;
  }

  update(_dt: number): void {}

  /** The pack if it is active and within `range` of `w` (AI), else null. */
  bestFor(_w: SimWizard, _range: number): SimLifePack | null {
    return null;
  }
}
