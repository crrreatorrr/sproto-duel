export type SpellId = 'bolt' | 'blast' | 'shield' | 'stun' | 'ultimate';
export const SPELL_ORDER: readonly SpellId[] = ['bolt', 'blast', 'shield', 'stun', 'ultimate'];

/** Spells with a windup before release. */
export type ChanneledSpell = 'blast' | 'stun' | 'ultimate';

export interface PendingCast {
  spell: ChanneledSpell;
  elapsed: number;
  duration: number;
}
