import type { Vector3 } from 'three';
import type { Wizard } from '../wizard/Wizard';
import type { SpellId } from '../spells/types';
import type { BossDef, ProjectileSkin } from '../campaign/levels';

export type DamageKind = SpellId | 'fire' | 'splash';

/** Everything gameplay announces. UI, audio and FX subscribe; gameplay never calls them directly. */
export interface GameEvents {
  cast: { wizard: Wizard; spell: SpellId; pos: Vector3 };
  /**
   * A bolt or blast with an object look (a boss's rug, phone, bullet...; see ProjectileSkins) left
   * the caster's hand: one per projectile, volley shots and sidekick throws included. Audio plays
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
   * (stage 0) when the rival stops being a boss. The AI and HUD follow it. See BossStages.
   */
  bossStage: { wizard: Wizard; boss: BossDef | null; stage: number };
  /** A campaign boss starts transforming from stage `from` into `stage` (a big hit can skip one). */
  bossEvolve: { wizard: Wizard; boss: BossDef; stage: number; from: number; pos: Vector3 };
  /** A boss fired its signature multi-shot (levels.ts VolleyDef). */
  volley: { wizard: Wizard; name: string; count: number; pos: Vector3 };
  /** Text popup without damage, e.g. "PERFECT!" or "DODGE". */
  callout: { pos: Vector3; text: string; style: 'perfect' | 'info' | 'stun' | 'block' | 'boss' };
  /** Golden tickets (src/arena/GoldenTickets.ts). `pos` is the ticket's centre; `id` is unique per ticket. */
  ticketSpawn: { id: number; pos: Vector3 };
  /** A wizard collected a ticket: its mana boost starts (or refreshes). */
  ticketPickup: { id: number; pos: Vector3; wizard: Wizard; refreshed: boolean };
  /** An uncollected ticket vanished: its lifetime ran out, or the closing fire ring reached it. */
  ticketExpire: { id: number; pos: Vector3; reason: 'timeout' | 'fire' };
  /** A wizard's golden-ticket mana boost ran out (mana is back to the normal max). */
  manaBoostEnd: { wizard: Wizard };
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
