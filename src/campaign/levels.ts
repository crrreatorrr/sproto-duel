import type { AIProfile, TeamPalette } from '../config';
import type { ArenaThemeId } from '../arena/themes';
import type { ModelKey } from '../assets/manifest';
import { BOSS_PORTRAITS } from '../assets/manifest';

export type BossId = keyof typeof BOSS_PORTRAITS;

/** What a boss's spells look like in flight (each a small code-built mesh, recoloured by the palette). */
export type ProjectileSkin =
  | 'orb' // the default glowing spell orb
  | 'rugRoll' // a rolled-up carpet, tumbling
  | 'carpet' // an unrolled flying carpet, rippling
  | 'pig' // a chubby pink pig, legs flailing
  | 'phone' // a spinning smartphone with a lit screen
  | 'pig' // a chubby pink pig, legs flailing
  | 'floret' // a broccoli floret
  | 'broccoli' // a whole head of broccoli
  | 'bullet' // a tracer round
  | 'grenade' // a lobbed grenade
  | 'hellfire' // a flaming orb with a smoky tail
  | 'skull'; // a burning skull

/** A signature multi-shot attack: `count` bolt-skinned shots in a fan (`spreadDeg`) or a burst (`interval` s apart). */
export interface VolleyDef {
  name: string;
  count: number;
  spreadDeg: number;
  interval: number;
  /** Seconds between volleys. */
  cooldown: number;
  /** Damage of each shot relative to a normal bolt. */
  damageScale: number;
}

/** Attacks a boss may use in one stage. Bolts, shield and dodge-roll are always allowed. */
export interface StageAttacks {
  blast: boolean;
  stun: boolean;
  ultimate: boolean;
  volley?: VolleyDef;
  /** The boss's sidekick (if any) also throws bolts. */
  sidekickFires?: boolean;
}

/** One of a boss's three forms. Stage 1 starts each round; 2 and 3 begin at CONFIG.campaign.stageThresholds. */
export interface BossStage {
  name: string;
  model: ModelKey;
  attacks: StageAttacks;
}

/** One campaign fight: who you face, where, and how hard they are. */
export interface BossDef {
  id: BossId;
  name: string;
  /** Epithet shown under the name, e.g. "the RugMaster". */
  title: string;
  /** One line for the pre-fight card. */
  intro: string;
  theme: ArenaThemeId;
  /** Stage 1's model (same as `stages[0].model`). */
  model: ModelKey;
  stages: [BossStage, BossStage, BossStage];
  /** Projectile looks for bolts (and volleys) and blasts. Stun and Ultimate keep the spell effects. */
  skins: { bolt: ProjectileSkin; blast: ProjectileSkin };
  /** A smaller companion who follows the boss around (purely visual unless a stage sets `sidekickFires`). */
  sidekick?: { name: string; model: ModelKey };
  /** Robe and spell colours used by the placeholder model and the boss's spells. */
  palette: TeamPalette;
  /** Base AI for stage 1; later stages scale it by CONFIG.campaign.stageAI. */
  ai: AIProfile;
  /** Multiplies the boss's max health. */
  healthMultiplier: number;
  /** Multiplies all damage the boss deals. */
  damageMultiplier: number;
}

type BossInput = Omit<BossDef, 'model'>;
const boss = (b: BossInput): BossDef => ({ ...b, model: b.stages[0].model });

const NONE: StageAttacks = { blast: false, stun: false, ultimate: false };
const SPELLS: StageAttacks = { blast: true, stun: true, ultimate: false };
const ALL: StageAttacks = { blast: true, stun: true, ultimate: true };

/**
 * The boss ladder, easiest first. Fight 1 is deliberately gentle (slower and less accurate than
 * the old Apprentice difficulty); each fight after it is a clear step up. Within a fight, every
 * boss evolves twice and unlocks more attacks each time.
 */
export const BOSSES: BossDef[] = [
  boss({
    id: 'sahil',
    name: 'Sahil',
    title: 'the RugMaster',
    intro: 'Every rug comes with a lifetime guarantee. The rug pull is free.',
    theme: 'desert',
    stages: [
      { name: 'Friendly Discount', model: 'bossSahil1', attacks: NONE },
      { name: 'No Refunds', model: 'bossSahil2', attacks: SPELLS },
      {
        name: 'Full Rug Pull',
        model: 'bossSahil3',
        attacks: { ...ALL, volley: { name: 'Rug Barrage', count: 3, spreadDeg: 22, interval: 0, cooldown: 5, damageScale: 0.8 } },
      },
    ],
    skins: { bolt: 'rugRoll', blast: 'carpet' },
    palette: { name: 'Sahil', robe: 0x7a1f2b, trim: 0xe8b04a, spell: 0xff9a3c, blast: 0xd94a2a, stun: 0xffe2b0, ultimate: 0xffb347 },
    ai: {
      label: 'Sahil',
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
  }),
  boss({
    id: 'obama',
    name: 'Bitcoin Obama',
    title: 'and The Midget',
    intro: 'Shiller shills',
    theme: 'void',
    stages: [
      { name: 'Pump', model: 'bossObama1', attacks: NONE },
      { name: 'Hype Cycle', model: 'bossObama2', attacks: { blast: true, stun: false, ultimate: false, sidekickFires: true } },
      {
        name: 'Dump',
        model: 'bossObama3',
        attacks: { ...ALL, sidekickFires: true, volley: { name: 'Pump & Dump', count: 4, spreadDeg: 30, interval: 0, cooldown: 4.5, damageScale: 0.7 } },
      },
    ],
    skins: { bolt: 'phone', blast: 'pig' },
    sidekick: { name: 'The Midget', model: 'bossObamaSidekick' },
    palette: { name: 'Bitcoin Obama', robe: 0x18181f, trim: 0xe0b23a, spell: 0xf7931a, blast: 0x3fb8ff, stun: 0xfff0c0, ultimate: 0xf7931a },
    ai: {
      label: 'Bitcoin Obama',
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
  }),
  boss({
    id: 'broccoli',
    name: 'Broccoli Head',
    title: 'the Floret Lord',
    intro: 'Leads the LA Vape Cabal.',
    theme: 'grove',
    stages: [
      { name: 'Sprout', model: 'bossBroccoli1', attacks: NONE },
      { name: 'Overgrown', model: 'bossBroccoli2', attacks: SPELLS },
      {
        name: 'Floret Colossus',
        model: 'bossBroccoli3',
        attacks: { ...ALL, volley: { name: 'Floret Spray', count: 5, spreadDeg: 36, interval: 0, cooldown: 4, damageScale: 0.6 } },
      },
    ],
    skins: { bolt: 'floret', blast: 'broccoli' },
    palette: { name: 'Broccoli Head', robe: 0x2f5a1f, trim: 0x9bd35a, spell: 0x6fe03a, blast: 0x3a9a2a, stun: 0xe6ffd0, ultimate: 0x8fff5a },
    ai: {
      label: 'Broccoli Head',
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
  }),
  boss({
    id: 'agent',
    name: 'Glowie',
    title: 'Government Enforcement',
    intro: 'Unknown',
    theme: 'glacier',
    stages: [
      { name: 'Routine Inquiry', model: 'bossAgent1', attacks: NONE },
      {
        name: 'Armed Response',
        model: 'bossAgent2',
        attacks: { blast: true, stun: false, ultimate: false, volley: { name: 'Burst Fire', count: 3, spreadDeg: 3, interval: 0.09, cooldown: 3.5, damageScale: 0.6 } },
      },
      {
        name: 'Black Ops',
        model: 'bossAgent3',
        attacks: { ...ALL, volley: { name: 'Full Auto', count: 7, spreadDeg: 7, interval: 0.07, cooldown: 4.5, damageScale: 0.5 } },
      },
    ],
    skins: { bolt: 'bullet', blast: 'grenade' },
    palette: { name: 'Glowie', robe: 0x16181d, trim: 0xd8dde6, spell: 0xffd27a, blast: 0xff5a2a, stun: 0xbfe8ff, ultimate: 0xff3030 },
    ai: {
      label: 'Glowie',
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
  }),
  boss({
    id: 'tinubu',
    name: 'Tinubu',
    title: 'the Unshackled Demon',
    intro: 'Infects you to make you sell your tickets.',
    theme: 'volcano',
    stages: [
      { name: 'Emi Lokan', model: 'bossTinubu1', attacks: { blast: true, stun: false, ultimate: false } },
      {
        name: 'Unshackled',
        model: 'bossTinubu2',
        attacks: { ...SPELLS, volley: { name: 'Hellfire', count: 3, spreadDeg: 20, interval: 0, cooldown: 4.5, damageScale: 0.7 } },
      },
      {
        name: 'Inferno Incarnate',
        model: 'bossTinubu3',
        attacks: { ...ALL, volley: { name: 'Inferno', count: 5, spreadDeg: 40, interval: 0, cooldown: 3.5, damageScale: 0.7 } },
      },
    ],
    skins: { bolt: 'hellfire', blast: 'skull' },
    palette: { name: 'Tinubu', robe: 0xe9dcc0, trim: 0xd4a017, spell: 0xff3a1a, blast: 0xff7a00, stun: 0xffd0c0, ultimate: 0xff2000 },
    ai: {
      label: 'Tinubu',
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
  }),
];

/** Display names for the arena environments, shown on the boss cards. */
export const ARENA_NAMES: Record<ArenaThemeId, string> = {
  moonlit: 'Moonlit Ruins',
  grove: 'The Vegetable Grove',
  volcano: 'Hellfire Caldera',
  glacier: 'Frostspire Black Site',
  desert: 'The Grand Bazaar',
  void: 'The Blockchain Void',
};
