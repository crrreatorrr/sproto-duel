import type { AIProfile, TeamPalette } from '../config';
import type { ArenaThemeId } from '../arena/themes';
import type { ModelKey } from '../assets/manifest';
import { BOSS_PORTRAITS } from '../assets/manifest';

export type BossId = keyof typeof BOSS_PORTRAITS;

/** One campaign fight: who you face, where, and how hard they are. */
export interface BossDef {
  id: BossId;
  name: string;
  /** Epithet shown under the name, e.g. "the Hedge Witch". */
  title: string;
  /** One line for the pre-fight card. */
  intro: string;
  theme: ArenaThemeId;
  model: ModelKey;
  /** Robe and spell colours used by the placeholder model and the boss's spells. */
  palette: TeamPalette;
  ai: AIProfile;
  /** Multiplies the boss's max health. */
  healthMultiplier: number;
  /** Multiplies all damage the boss deals. */
  damageMultiplier: number;
}

/**
 * The boss ladder, easiest first, and the game's only difficulty progression (Quick Duel has one
 * fixed rival). Fight 1 is deliberately gentle (slower and less accurate than even the old
 * Apprentice preset, CONFIG.ai.difficulty.easy); each fight after it is a clear step up.
 * `__duel.qa.run('campaign.ladder_escalates')` and `__duel.qa.campaignSoak()` measure the ladder.
 */
export const BOSSES: BossDef[] = [
  {
    id: 'bramble',
    name: 'Bramble',
    title: 'the Hedge Witch',
    intro: 'A forest witch who would rather be gardening. Learn your spells here.',
    theme: 'grove',
    model: 'bossBramble',
    palette: { name: 'Bramble', robe: 0x3f6b2a, trim: 0xd9c27a, spell: 0x8fe05a, blast: 0xc8e04a, stun: 0xe6ffd0, ultimate: 0xa8f070 },
    ai: {
      label: 'Bramble',
      reactionTime: 0.85,
      aimError: 0.26,
      leadFactor: 0,
      dodgeChance: 0.08,
      shieldPreference: 0.2,
      perfectShieldChance: 0,
      burst: [1, 2],
      burstPause: [1.8, 2.8],
      blastChance: 0.12,
      stunChance: 0.04,
      punishChance: 0.05,
      strafeSpeed: 0.4,
      preferredRange: [10, 15],
    },
    healthMultiplier: 0.7,
    damageMultiplier: 0.55,
  },
  {
    id: 'cinder',
    name: 'Cinder',
    title: 'the Ember Adept',
    intro: 'Hot-headed and fond of explosions. Shield the big orbs.',
    theme: 'volcano',
    model: 'bossCinder',
    palette: { name: 'Cinder', robe: 0x5a1a10, trim: 0xffb347, spell: 0xff6a2a, blast: 0xff9a1a, stun: 0xffe0b0, ultimate: 0xff5020 },
    ai: {
      label: 'Cinder',
      reactionTime: 0.45,
      aimError: 0.15,
      leadFactor: 0.15,
      dodgeChance: 0.25,
      shieldPreference: 0.3,
      perfectShieldChance: 0.05,
      burst: [2, 3],
      burstPause: [1.0, 1.7],
      blastChance: 0.5,
      stunChance: 0.12,
      punishChance: 0.25,
      strafeSpeed: 0.65,
      preferredRange: [10, 15],
    },
    healthMultiplier: 0.9,
    damageMultiplier: 0.8,
  },
  {
    id: 'ysolde',
    name: 'Ysolde',
    title: 'the Frost Warden',
    intro: 'Patient and precise. Her stun beam sets up everything else.',
    theme: 'glacier',
    model: 'bossYsolde',
    palette: { name: 'Ysolde', robe: 0x3a3f7a, trim: 0xe8eeff, spell: 0xc9b8ff, blast: 0x9f8cff, stun: 0xf0f4ff, ultimate: 0xd6c8ff },
    ai: {
      label: 'Ysolde',
      reactionTime: 0.28,
      aimError: 0.09,
      leadFactor: 0.45,
      dodgeChance: 0.5,
      shieldPreference: 0.45,
      perfectShieldChance: 0.25,
      burst: [3, 4],
      burstPause: [0.7, 1.2],
      blastChance: 0.3,
      stunChance: 0.6,
      punishChance: 0.6,
      strafeSpeed: 0.85,
      preferredRange: [9, 14],
    },
    healthMultiplier: 1.0,
    damageMultiplier: 1.0,
  },
  {
    id: 'khepri',
    name: 'Khepri',
    title: 'the Sand Magus',
    intro: 'Relentless pressure from behind every pillar. Punishes every whiff.',
    theme: 'desert',
    model: 'bossKhepri',
    palette: { name: 'Khepri', robe: 0x1f5a5a, trim: 0xf2c14e, spell: 0xffd34a, blast: 0x3fd6c0, stun: 0xfff2c0, ultimate: 0xffc21a },
    ai: {
      label: 'Khepri',
      reactionTime: 0.2,
      aimError: 0.06,
      leadFactor: 0.7,
      dodgeChance: 0.65,
      shieldPreference: 0.5,
      perfectShieldChance: 0.45,
      burst: [4, 5],
      burstPause: [0.5, 0.9],
      blastChance: 0.6,
      stunChance: 0.45,
      punishChance: 0.85,
      strafeSpeed: 0.95,
      preferredRange: [8, 13],
    },
    healthMultiplier: 1.05,
    damageMultiplier: 1.0,
  },
  {
    id: 'morvane',
    name: 'Morvane',
    title: 'the Archlich',
    intro: 'The final duel. Reflects your spells and never stops attacking.',
    theme: 'void',
    model: 'bossMorvane',
    palette: { name: 'Morvane', robe: 0x2a1240, trim: 0x9cff7a, spell: 0xb05aff, blast: 0x7aff6a, stun: 0xe8d0ff, ultimate: 0xc070ff },
    ai: {
      label: 'Morvane',
      reactionTime: 0.13,
      aimError: 0.04,
      leadFactor: 0.9,
      dodgeChance: 0.82,
      shieldPreference: 0.55,
      perfectShieldChance: 0.7,
      burst: [4, 7],
      burstPause: [0.3, 0.7],
      blastChance: 0.7,
      stunChance: 0.6,
      punishChance: 1.0,
      strafeSpeed: 1.05,
      preferredRange: [8, 13],
    },
    healthMultiplier: 1.15,
    damageMultiplier: 1.05,
  },
];

/** Display names for the arena environments, shown on the boss cards. */
export const ARENA_NAMES: Record<ArenaThemeId, string> = {
  moonlit: 'Moonlit Ruins',
  grove: 'Thornwood Grove',
  volcano: 'Ember Caldera',
  glacier: 'Frostspire Glacier',
  desert: 'Sunken Dunes',
  void: 'The Hollow Void',
};
