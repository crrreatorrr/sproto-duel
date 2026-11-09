/**
 * Local Versus join screen, one step per frame, pure: which pad joined as P2, and what the
 * players asked for. App feeds it the pads holding A / B right now (navigator.getGamepads()).
 *
 * - A on a controller joins it as P2. With two or more controllers the first one (lowest index)
 *   is P1's and does not join (controller 1 = P1, controller 2 = P2), so P1 pressing A again on
 *   the join screen never takes P2's seat.
 * - Once P2 is in, A on P2's controller (or on any controller, when there are two) starts.
 * - B on any controller: P2 leaves; with nobody joined, back to the main menu.
 *
 * A and B are edge-triggered: a button must be released after the screen opens (the A that picked
 * Local Versus is still held) and between presses.
 */
export interface JoinState {
  p2: number | null;
  aReleased: boolean;
  bReleased: boolean;
}

export type JoinAction = 'none' | 'joined' | 'left' | 'start' | 'back';

export interface JoinInput {
  /** Connected standard pads' indices. */
  pads: readonly number[];
  /** Indices of pads holding A / B this frame. */
  aHeld: readonly number[];
  bHeld: readonly number[];
}

export function newJoinState(): JoinState {
  return { p2: null, aReleased: false, bReleased: false };
}

/** The controller that is P1's when there are two or more (the first one), else null. */
export function p1PadOf(pads: readonly number[]): number | null {
  return pads.length >= 2 ? Math.min(...pads) : null;
}

export function joinStep(s: JoinState, input: JoinInput): JoinAction {
  const { pads, aHeld, bHeld } = input;
  if (aHeld.length === 0) s.aReleased = true;
  if (bHeld.length === 0) s.bReleased = true;
  if (s.aReleased && aHeld.length > 0) {
    s.aReleased = false;
    if (s.p2 === null) {
      const p1 = p1PadOf(pads);
      const joiner = aHeld.find((i) => i !== p1);
      if (joiner === undefined) return 'none';
      s.p2 = joiner;
      return 'joined';
    }
    if (aHeld.includes(s.p2) || pads.length > 1) return 'start';
    return 'none';
  }
  if (s.bReleased && bHeld.length > 0) {
    s.bReleased = false;
    if (s.p2 !== null) {
      s.p2 = null;
      return 'left';
    }
    return 'back';
  }
  return 'none';
}
