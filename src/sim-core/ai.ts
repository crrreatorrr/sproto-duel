/**
 * The CPU rival's and the bosses' brain in the sim: the deterministic port of
 * src/enemy/AIController.ts. STUB until the port lands.
 */
import type { AIProfile } from '../config';
import type { BossFighter } from '../campaign/levels';
import type { SimWizard } from './wizard';
import type { SimWorld } from './world';

export class SimAI {
  constructor(
    protected readonly world: SimWorld,
    readonly self: SimWizard,
    public target: SimWizard,
    public profile: AIProfile,
    readonly boss: BossFighter | null,
  ) {}

  reset(): void {}

  update(_dt: number): void {}
}
