import type { Wizard } from '../wizard/Wizard';
import type { IntentSource } from './IntentSource';

/** Drives a wizard from a script, once per fixed tick (QA scenarios, soaks, netcode tests). */
export class ReplaySource implements IntentSource {
  readonly kind = 'replay' as const;
  /** Ticks this source has run. */
  ticks = 0;

  constructor(
    private readonly wizard: Wizard,
    /** Called every tick with this source's own tick count (from 0) and the sim tick. */
    private readonly script: (wizard: Wizard, tick: number, simTick: number) => void,
  ) {}

  tick(_dt: number, simTick: number): void {
    this.script(this.wizard, this.ticks++, simTick);
  }

  reset(): void {
    this.ticks = 0;
  }
}
