/**
 * The boss reward spells: beating a Boss Gauntlet boss teaches the player that boss's themed spell
 * for good. Names, descriptions and icons live here (UI, saves, QA); the rules are in
 * RewardSpells.ts and the numbers in CONFIG.rewardSpells.
 */

export type RewardSpellId = 'carpet' | 'pump' | 'vape' | 'lockon' | 'breath';

/** In gauntlet order: fight N teaches REWARD_SPELLS[N - 1]. */
export const REWARD_SPELLS: readonly RewardSpellId[] = ['carpet', 'pump', 'vape', 'lockon', 'breath'];

export interface RewardSpellInfo {
  id: RewardSpellId;
  name: string;
  /** One or two lines for How to Play and the reveal screen. */
  description: string;
  /** A few words for the HUD tooltip and the boss card. */
  short: string;
  /** Callout over the caster when cast. */
  callout: string;
  /** Icon under public/assets/ (256x256, round alpha). */
  icon: string;
  /** CSS accent colour (slot glow, reveal screen). */
  color: string;
}

export const REWARD_SPELL_INFO: Record<RewardSpellId, RewardSpellInfo> = {
  carpet: {
    id: 'carpet',
    name: 'Magic Carpet',
    description: 'Summon a flying carpet for 2.5 s: more than twice as fast, hovering over lava, fire and low cover. No casting while you ride; press it again to hop off.',
    short: 'Fly fast for 2.5 s, over lava and fire',
    callout: 'MAGIC CARPET',
    icon: 'ui/spells/spell_carpet.png',
    color: '#ffb347',
  },
  pump: {
    id: 'pump',
    name: 'Pump It',
    description: 'A 6 s power surge: +50% spell damage and 1.5× Ultimate charge. Number go up.',
    short: '6 s of +50% damage, 1.5× Ultimate charge',
    callout: 'PUMP IT!',
    icon: 'ui/spells/spell_pump.png',
    color: '#5dff8a',
  },
  vape: {
    id: 'vape',
    name: 'Vape Cloud',
    description: 'Drop a 5 m smoke screen for 6 s. Enemies inside it or looking through it lose track of you and fire at where you were. You heal 2 HP/s inside, but attacking from it gives you away and pauses the healing.',
    short: 'Smoke screen: enemies lose you, you heal',
    callout: 'VAPE CLOUD',
    icon: 'ui/spells/spell_vape.png',
    color: '#c7b8ff',
  },
  lockon: {
    id: 'lockon',
    name: 'Lock-On',
    description: 'For 6 s your bolts home in on the nearest enemy in front of you. Gentle tracking: a roll still slips them and a shield still stops them.',
    short: '6 s of homing bolts',
    callout: 'LOCK-ON',
    icon: 'ui/spells/spell_lockon.png',
    color: '#7dff6a',
  },
  breath: {
    id: 'breath',
    name: 'Hellfire Breath',
    description: 'Channel a 6 m cone of fire from your staff for 2 s. It burns everything in it and leaves them burning. You move slowly while you breathe fire.',
    short: 'A 2 s cone of fire that leaves foes burning',
    callout: 'HELLFIRE BREATH',
    icon: 'ui/spells/spell_breath.png',
    color: '#ff6a2a',
  },
};

export const isRewardSpell = (x: unknown): x is RewardSpellId => typeof x === 'string' && (REWARD_SPELLS as readonly string[]).includes(x);
