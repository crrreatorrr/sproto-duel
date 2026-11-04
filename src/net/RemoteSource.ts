import type { IntentSource } from '../input/IntentSource';
import type { Wizard } from '../wizard/Wizard';
import { applyIntentFrame } from './intent';
import type { RemoteInputBuffer } from './RemoteInputBuffer';

/** Host side: drives the guest's wizard from its buffered intent frames, one per fixed tick. */
export class RemoteSource implements IntentSource {
  readonly kind = 'remote' as const;

  constructor(
    private readonly wizard: Wizard,
    readonly buffer: RemoteInputBuffer,
  ) {}

  tick(): void {
    const f = this.buffer.next();
    if (f) applyIntentFrame(f, this.wizard.intent, this.wizard.aimPoint);
  }

  reset(): void {
    this.buffer.reset();
  }
}
