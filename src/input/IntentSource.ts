/**
 * Something that drives one wizard's intent. Each seat (wizard index) has at most one; Game calls
 * `frame` once per rendered frame on local humans (devices + camera aim, so presses during
 * hit-stop are never missed) and `tick` once per fixed tick on all of them (AI, a remote player's
 * buffered frames, a replay), unless actions are locked.
 */
export interface IntentSource {
  readonly kind: 'local' | 'ai' | 'remote' | 'replay';
  /** Once per rendered frame (local humans: devices + camera aim). */
  frame?(realDt: number): void;
  /** Once per fixed tick, before the sim reads intents (AI, remote buffer, replay). */
  tick?(dt: number, simTick: number): void;
  reset?(): void;
}

/** Which devices a local human uses: keyboard + mouse, and a pad (fixed index, 'any' active pad, or none). */
export interface DeviceBinding {
  keyboardMouse: boolean;
  pad: number | 'any' | null;
}

/** Single player: keyboard + mouse and whichever pad was used last. */
export const SOLO_DEVICES: DeviceBinding = { keyboardMouse: true, pad: 'any' };
