import type { Vector3 } from 'three';
import type { Wizard } from '../wizard/Wizard';
import type { SpellId } from '../spells/types';

export type DamageKind = SpellId | 'fire' | 'splash';

/** Everything gameplay announces. UI, audio and FX subscribe; gameplay never calls them directly. */
export interface GameEvents {
  cast: { wizard: Wizard; spell: SpellId; pos: Vector3 };
  castStart: { wizard: Wizard; spell: SpellId; pos: Vector3 };
  damage: { target: Wizard; source: Wizard | null; amount: number; point: Vector3; kind: DamageKind };
  impact: { pos: Vector3; spell: SpellId; surface: 'wizard' | 'pillar' | 'floor' | 'wall' };
  explosion: { pos: Vector3; radius: number; owner: Wizard };
  shieldUp: { wizard: Wizard };
  block: { wizard: Wizard; pos: Vector3; perfect: boolean; spell: SpellId };
  clash: { pos: Vector3; winner: SpellId | null };
  dodge: { wizard: Wizard };
  dodgeEvade: { wizard: Wizard; pos: Vector3 };
  /** Takeoff. `pos` is the feet. */
  jump: { wizard: Wizard; pos: Vector3 };
  /** Touchdown on the floor or a stump. `speed` is the downward impact speed (m/s). */
  land: { wizard: Wizard; pos: Vector3; speed: number };
  stunned: { wizard: Wizard };
  burn: { wizard: Wizard };
  pillarHit: { pos: Vector3 };
  pillarBreak: { pos: Vector3 };
  ultReady: { wizard: Wizard };
  noMana: { wizard: Wizard };
  ultWave: { wizard: Wizard; pos: Vector3 };
  ko: { loser: Wizard; winner: Wizard | null };
  roundIntro: { round: number };
  countdown: { value: number };
  roundStart: { round: number };
  roundEnd: { winner: Wizard | null; reason: 'ko' | 'time' };
  matchEnd: { winner: Wizard | null };
  suddenDeath: Record<string, never>;
  /** Text popup without damage, e.g. "PERFECT!" or "DODGE". */
  callout: { pos: Vector3; text: string; style: 'perfect' | 'info' | 'stun' | 'block' };
}

type Handler<T> = (payload: T) => void;

export class Emitter<T extends object> {
  private handlers: { [K in keyof T]?: Handler<T[K]>[] } = {};

  on<K extends keyof T>(type: K, fn: Handler<T[K]>): () => void {
    (this.handlers[type] ??= []).push(fn);
    return () => {
      const list = this.handlers[type];
      if (list) list.splice(list.indexOf(fn), 1);
    };
  }

  emit<K extends keyof T>(type: K, payload: T[K]): void {
    const list = this.handlers[type];
    if (!list) return;
    for (let i = 0; i < list.length; i++) list[i](payload);
  }
}

export const events = new Emitter<GameEvents>();
