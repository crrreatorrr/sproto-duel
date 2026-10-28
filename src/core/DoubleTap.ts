/**
 * Detects the same key pressed twice in quick succession (the "99" god-mode cheat).
 * Feed it key presses with their time; it returns true on the second press of a pair.
 */
export class DoubleTap {
  private last = -Infinity;

  constructor(
    private readonly codes: readonly string[],
    /** Max milliseconds between the two presses. */
    private readonly windowMs: number,
  ) {}

  /** Returns true when this press completes a double tap. A third press starts a new pair. */
  press(code: string, timeMs: number): boolean {
    if (!this.codes.includes(code)) {
      this.last = -Infinity; // any other key breaks the sequence
      return false;
    }
    if (timeMs - this.last <= this.windowMs) {
      this.last = -Infinity;
      return true;
    }
    this.last = timeMs;
    return false;
  }

  reset(): void {
    this.last = -Infinity;
  }
}
