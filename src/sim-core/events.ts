/**
 * What happened during a tick, for presentation (audio, effects, HUD popups). The game turns these
 * into its own `events` bus (src/core/events.ts names). They never feed back into the sim and are
 * not part of the state hash.
 */
export interface SimEvent {
  type: string;
  /** Main wizard index (caster, target, loser...), or -1. */
  w: number;
  /** Second wizard index (source, winner...), or -1. */
  o: number;
  /** A position (Q16), when the event has one. */
  x: number;
  y: number;
  z: number;
  /** A number (damage amount Q16, round number, countdown value, ticket id...). */
  n: number;
  /** A label (spell, damage kind, reason...). */
  s: string;
  /** A flag (perfect block, refreshed boost...). */
  f: boolean;
}

export class SimEvents {
  readonly list: SimEvent[] = [];
  /** Off on the server replay: nothing reads them there. */
  enabled = true;

  /**
   * Sim-side listeners (the AI reacts to explosions, stuns, KOs...): called synchronously for
   * every event of their type, on the server too. They are part of the simulation.
   */
  private readonly listeners: Record<string, ((e: SimEvent) => void)[]> = {};

  on(type: string, fn: (e: SimEvent) => void): void {
    (this.listeners[type] || (this.listeners[type] = [])).push(fn);
  }

  push(type: string, w = -1, s = '', n = 0, o = -1, x = 0, y = 0, z = 0, f = false): void {
    const fns = this.listeners[type];
    if (!this.enabled && !fns) return;
    const e: SimEvent = { type, w, o, x, y, z, n, s, f };
    if (this.enabled) this.list.push(e);
    if (fns) for (let i = 0; i < fns.length; i++) fns[i](e);
  }

  atPos(type: string, p: { x: number; y: number; z: number }, w = -1, s = '', n = 0, o = -1, f = false): void {
    this.push(type, w, s, n, o, p.x, p.y, p.z, f);
  }

  take(): SimEvent[] {
    const out = this.list.slice();
    this.list.length = 0;
    return out;
  }
}
