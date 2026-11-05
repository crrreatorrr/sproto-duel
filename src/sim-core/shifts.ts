/**
 * Arena shifts in the sim: the deterministic port of src/arena/ArenaShifts.ts gameplay (hazard pools
 * with quicksand slow, the healing spring, erupting vents, the fire ring pulling in per stage). STUB.
 */
import type { Hazard } from './arena';
import type { SimWizard } from './wizard';
import type { SimWorld } from './world';

export type ShiftKind = 'pool' | 'spring' | 'vent';

export interface SimShiftFeature {
  id: number;
  kind: ShiftKind;
  x: number;
  z: number;
  r: number;
  /** TU since it appeared (it fades in harmlessly for growTime). */
  age: number;
  /** Spring: health left to give (Q16). Vent: TU to the next eruption, and its period. */
  charge: number;
  timer: number;
  period: number;
}

export class SimShifts {
  readonly features: SimShiftFeature[] = [];
  /** Live hazard pools as arena hazards (AI avoidance, pickup exclusion). */
  readonly hazards: Hazard[] = [];
  /** The furthest stage applied this round. */
  stage = 0;

  constructor(protected readonly world: SimWorld) {}

  /** Bring in stage `stage`'s features (1: pools and a spring; 2: vents and a refill). */
  applyStage(_stage: number): void {}

  /** Before movement: pool burns and slows, spring heals, vents erupt, the ring cap eases in. */
  update(_dt: number): void {}

  /** A spring still running within `range` of `w` that the AI may walk to, or null. */
  springFor(_w: SimWizard, _range: number): SimShiftFeature | null {
    return null;
  }

  clear(): void {
    this.features.length = 0;
    this.hazards.length = 0;
    this.stage = 0;
  }
}
