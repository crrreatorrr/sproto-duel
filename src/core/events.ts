import type { Vector3 } from 'three';
import type { Wizard } from '../wizard/Wizard';
import type { SpellId } from '../spells/types';
import type { BossFighter, ProjectileSkin } from '../campaign/levels';

export type DamageKind = SpellId | 'fire' | 'splash';

/** Everything gameplay announces. UI, audio and FX subscribe; gameplay never calls them directly. */
export interface GameEvents {
  cast: { wizard: Wizard; spell: SpellId; pos: Vector3 };
  /**
   * A bolt or blast with an object look (a boss's rug, phone, bullet...; see ProjectileSkins) left
   * the caster's hand: one per projectile, volley shots included. Audio plays
   * the object's launch sound instead of the spell's cast sound.
   */
  skinLaunch: { wizard: Wizard; kind: 'bolt' | 'blast'; skin: ProjectileSkin; pos: Vector3 };
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
  /**
   * A campaign boss's stage was set: 0 at every round start, 1 or 2 when it evolves. `boss` is null
   * (stage 0) when the wizard stops being a boss. The AI and HUD follow it. See BossStages. Fired
   * per boss wizard: the rival, and in a double fight its partner too.
   */
  bossStage: { wizard: Wizard; boss: BossFighter | null; stage: number };
  /**
   * A campaign boss starts transforming from stage `from` into `stage` (a big hit can skip one).
   * `enraged`: its partner just fell, so it goes straight to its last stage.
   */
  bossEvolve: { wizard: Wizard; boss: BossFighter; stage: number; from: number; pos: Vector3; enraged: boolean };
  /** A boss fired its signature multi-shot (levels.ts VolleyDef). */
  volley: { wizard: Wizard; name: string; count: number; pos: Vector3 };
  /** Text popup without damage, e.g. "PERFECT!" or "DODGE". */
  callout: { pos: Vector3; text: string; style: 'perfect' | 'info' | 'stun' | 'block' | 'boss' };
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
