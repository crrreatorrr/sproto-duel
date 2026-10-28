import type { AIProfile, TeamPalette } from '../config';
import type { ArenaThemeId } from '../arena/themes';
import type { ModelKey } from '../assets/manifest';
import { BOSS_PORTRAITS } from '../assets/manifest';
import { gunMuzzle, handAndMouth, phoneMuzzle, staffMuzzle, twoPhones, vapeMuzzle, type MuzzleSet } from '../wizard/muzzles';

export type BossId = keyof typeof BOSS_PORTRAITS;

/** What a boss's spells look like in flight (each a small code-built mesh, recoloured by the palette). */
export type ProjectileSkin =
  | 'orb' // the default glowing spell orb
  | 'rugRoll' // a rolled-up carpet, tumbling
  | 'carpet' // an unrolled flying carpet, rippling
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
}

/** One of a boss's three forms. Stage 1 starts each fight; each stage has its own health bar (BossFighter.stageHealth). */
export interface BossStage {
  name: string;
  model: ModelKey;
  attacks: StageAttacks;
  /**
   * Where this stage's model casts from (its staff, phones, vape, gun, hand and mouth): measured
   * points as [forward, up, right] fractions of the model's height from its feet. See
   * src/wizard/muzzles.ts and ASSETS.md. The placeholder look uses its own props instead.
   */
  muzzle: MuzzleSet;
}

/**
 * One boss wizard: look, stages, spells, AI and stats. Every BossDef is one, and so is a BossDef's
 * `partner` (the second boss of a double fight). BossStages runs on any of them.
 */
export interface BossFighter {
  /** Portrait / placeholder id (`ui/bosses/<id>.png`, `<id>_stage2.png`...). */
  id: BossId;
  name: string;
  stages: [BossStage, BossStage, BossStage];
  /** Projectile looks for bolts (and volleys) and blasts. Stun and Ultimate keep the spell effects. */
  skins: { bolt: ProjectileSkin; blast: ProjectileSkin };
  /** Robe and spell colours used by the placeholder model and the boss's spells. */
  palette: TeamPalette;
  /** Base AI for stage 1; later stages scale it by CONFIG.campaign.stageAI. */
  ai: AIProfile;
  /**
   * HP of each stage's own health bar (stage 1, 2, 3). When a bar empties the boss transforms into
   * the next stage and comes back with that stage's full bar (overflow from the hit is lost); only
   * emptying the last bar is a KO. Sized so a stage lasts about five minutes against a competent
   * player (the soak's reference AI).
   */
  stageHealth: [number, number, number];
  /** Multiplies all damage the boss deals. */
  damageMultiplier: number;
}

/**
 * The second boss of a double fight (Bitcoin Obama's The Midget). A full wizard of its own
 * (Game.partner): its own health bar, stages, AI, skins and palette, fighting alongside the boss.
 */
export interface BossPartner extends BossFighter {
  /** Collision capsule in meters. Spells aim at (and hit) this body: chest, wand and HUD tag follow its height. */
  hitbox: { radius: number; height: number };
}

/** One campaign fight: who you face, where, and how hard they are. */
export interface BossDef extends BossFighter {
  /** Epithet shown under the name, e.g. "the RugMaster". */
  title: string;
  /** One line for the pre-fight card. */
  intro: string;
  theme: ArenaThemeId;
  /** Stage 1's model (same as `stages[0].model`). */
  model: ModelKey;
  /** A second boss fought at the same time (a double fight): the round is won once both are down. */
  partner?: BossPartner;
}

/** Everyone the player faces in this fight: the boss, then its partner if any. */
export const bossFighters = (boss: BossDef): BossFighter[] => (boss.partner ? [boss, boss.partner] : [boss]);

/** The fight's name for cards, banners and results: "Sahil", or "Bitcoin Obama & The Midget". */
export const bossDisplayName = (boss: BossDef): string => (boss.partner ? `${boss.name} & ${boss.partner.name}` : boss.name);

type BossInput = Omit<BossDef, 'model'>;
const boss = (b: BossInput): BossDef => ({ ...b, model: b.stages[0].model });

const NONE: StageAttacks = { blast: false, stun: false, ultimate: false };
const SPELLS: StageAttacks = { blast: true, stun: true, ultimate: false };
const ALL: StageAttacks = { blast: true, stun: true, ultimate: true };

/**
 * The boss ladder, easiest first. A gauntlet fight is one life against all three stages, each with
 * its own health bar (`stageHealth`, sized for about five minutes a stage), so a fight runs 15+
 * minutes. Bosses hit hard (`damageMultiplier`, raised again per stage by stageDamage) but pick
 * their moments: slow bursts, wide aim and rare big spells keep the damage per second low enough
 * for one health bar and three life packs to last. Within a fight every boss evolves twice and
 * unlocks more attacks each time; `ai` is stage 1 and CONFIG.campaign.stageAI sharpens it. Fight 1
 * is very easy; each fight after it is a clear step up, and Tinubu is close to impossible. Fight 2
 * is a double fight (`partner`): the pair together is tuned as one step on the ladder.
 * Tuned with `__duel.qa.campaignSoak` (reference win rates: README / the final report).
 */
export const BOSSES: BossDef[] = [
  boss({
    id: 'sahil',
    name: 'Sahil',
    title: 'the RugMaster',
    intro: 'Every rug comes with a lifetime guarantee. The rug pull is free.',
    theme: 'desert',
    stages: [
      // A staff with a gem in its head, held in his right hand.
      { name: 'Friendly Discount', model: 'bossSahil1', attacks: NONE, muzzle: staffMuzzle([0.15, 0.895, 0.265]) },
      { name: 'No Refunds', model: 'bossSahil2', attacks: SPELLS, muzzle: staffMuzzle([0.21, 0.894, 0.311], 1.15) },
      {
        name: 'Full Rug Pull',
        model: 'bossSahil3',
        muzzle: staffMuzzle([0.166, 0.893, 0.329], 1.3),
        attacks: { ...ALL, volley: { name: 'Rug Barrage', count: 3, spreadDeg: 22, interval: 0, cooldown: 5, damageScale: 0.8 } },
      },
    ],
    skins: { bolt: 'rugRoll', blast: 'carpet' },
    palette: { name: 'Sahil', robe: 0x7a1f2b, trim: 0xe8b04a, spell: 0xff9a3c, blast: 0xd94a2a, stun: 0xffe2b0, ultimate: 0xffb347 },
    ai: {
      label: 'Sahil',
      reactionTime: 0.85,
      aimError: 0.34,
      leadFactor: 0,
      dodgeChance: 0.08,
      shieldPreference: 0.2,
      perfectShieldChance: 0,
      burst: [1, 2],
      burstPause: [2.3, 3.6],
      blastChance: 0.02,
      stunChance: 0.008,
      punishChance: 0.02,
      strafeSpeed: 0.4,
      preferredRange: [10, 15],
    },
    stageHealth: [1490, 1660, 1710],
    damageMultiplier: 0.77,
  }),
  boss({
    // A double fight: Bitcoin Obama (tall) and The Midget at the same time, each with his own
    // health bar and stages. Tuned as a pair to sit between Sahil and Broccoli Head.
    id: 'obama',
    name: 'Bitcoin Obama',
    title: 'the Pump & Dump Duo',
    intro: 'Shiller shills',
    theme: 'void',
    stages: [
      // A phone in his raised right hand, then one in each hand, then fists (phones drawn in code).
      { name: 'Pump', model: 'bossObama1', attacks: NONE, muzzle: phoneMuzzle([0.162, 0.676, 0.195]) },
      {
        name: 'Hype Cycle',
        model: 'bossObama2',
        attacks: { blast: true, stun: false, ultimate: false },
        muzzle: twoPhones([0.048, 0.622, 0.289], [0.093, 0.604, -0.261]),
      },
      {
        name: 'Dump',
        model: 'bossObama3',
        muzzle: twoPhones([0.031, 0.467, 0.235], [0.09, 0.455, -0.196], true),
        attacks: { ...ALL, volley: { name: 'Pump & Dump', count: 4, spreadDeg: 30, interval: 0, cooldown: 4.5, damageScale: 0.7 } },
      },
    ],
    skins: { bolt: 'phone', blast: 'pig' },
    palette: { name: 'Bitcoin Obama', robe: 0x18181f, trim: 0xe0b23a, spell: 0xf7931a, blast: 0x3fb8ff, stun: 0xfff0c0, ultimate: 0xf7931a },
    ai: {
      label: 'Bitcoin Obama',
      reactionTime: 0.45,
      aimError: 0.45,
      leadFactor: 0.05,
      dodgeChance: 0.25,
      shieldPreference: 0.3,
      perfectShieldChance: 0.05,
      burst: [1, 2],
      burstPause: [2.8, 4],
      blastChance: 0.015,
      stunChance: 0.008,
      punishChance: 0.04,
      strafeSpeed: 0.65,
      preferredRange: [10, 15],
    },
    // As a pair: Obama is the glass cannon (smaller bars, hits hardest), The Midget the tank (bigger
    // bars, closes in). Knock out the nearest first and you face an enraged Obama; a sharp player
    // drops Obama first.
    stageHealth: [380, 440, 500],
    damageMultiplier: 0.98,
    partner: {
      // Quicker and jumpier than Obama, a little less accurate, likes to get close, and takes more beating.
      id: 'midget',
      name: 'The Midget',
      stages: [
        // A phone in his left hand, then one in each hand, then fists (phones drawn in code).
        { name: 'Small Cap', model: 'bossMidget1', attacks: NONE, muzzle: phoneMuzzle([0.18, 0.596, -0.248]) },
        {
          name: 'To the Moon',
          model: 'bossMidget2',
          attacks: { blast: true, stun: false, ultimate: false },
          muzzle: twoPhones([0.193, 0.618, 0.221], [0.2, 0.618, -0.214]),
        },
        {
          name: 'Short Squeeze',
          model: 'bossMidget3',
          muzzle: twoPhones([0.081, 0.491, 0.231], [0.025, 0.484, -0.325], true),
          attacks: { blast: true, stun: true, ultimate: false, volley: { name: 'Moon Shot', count: 3, spreadDeg: 4, interval: 0.1, cooldown: 5, damageScale: 0.6 } },
        },
      ],
      skins: { bolt: 'phone', blast: 'pig' },
      palette: { name: 'The Midget', robe: 0x1f3f9a, trim: 0xc08a3e, spell: 0x4f86ff, blast: 0xd09a4a, stun: 0xd8e6ff, ultimate: 0x6fa0ff },
      ai: {
        label: 'The Midget',
        reactionTime: 0.38,
        aimError: 0.47,
        leadFactor: 0.04,
        dodgeChance: 0.3,
        shieldPreference: 0.15,
        perfectShieldChance: 0.03,
        burst: [1, 2],
        burstPause: [2.6, 3.8],
        blastChance: 0.015,
        stunChance: 0.008,
        punishChance: 0.05,
        strafeSpeed: 0.85,
        preferredRange: [7, 12],
        hopRate: 0.45,
      },
      stageHealth: [500, 570, 625],
      damageMultiplier: 0.77,
      hitbox: { radius: 0.32, height: 1.25 },
    },
  }),
  boss({
    id: 'broccoli',
    name: 'Broccoli Head',
    title: 'the Floret Lord',
    intro: 'Leads the LA Vape Cabal.',
    theme: 'city',
    stages: [
      // The vape grows: a pen's mouthpiece, a box mod's, then the cannon's outlet (bigger puffs each time).
      { name: 'Sprout', model: 'bossBroccoli1', attacks: NONE, muzzle: vapeMuzzle([0.139, 0.754, 0.152], 1) },
      { name: 'Overgrown', model: 'bossBroccoli2', attacks: SPELLS, muzzle: vapeMuzzle([0.197, 0.74, 0.183], 1.6) },
      {
        name: 'Floret Colossus',
        model: 'bossBroccoli3',
        muzzle: vapeMuzzle([0.414, 0.45, 0.103], 2.6),
        attacks: { ...ALL, volley: { name: 'Floret Spray', count: 5, spreadDeg: 36, interval: 0, cooldown: 4, damageScale: 0.6 } },
      },
    ],
    skins: { bolt: 'floret', blast: 'broccoli' },
    palette: { name: 'Broccoli Head', robe: 0x2f5a1f, trim: 0x9bd35a, spell: 0x6fe03a, blast: 0x3a9a2a, stun: 0xe6ffd0, ultimate: 0x8fff5a },
    ai: {
      label: 'Broccoli Head',
      reactionTime: 0.28,
      aimError: 0.75,
      leadFactor: 0.12,
      dodgeChance: 0.4,
      shieldPreference: 0.45,
      perfectShieldChance: 0.15,
      burst: [1, 3],
      burstPause: [2.6, 4.1],
      blastChance: 0.012,
      stunChance: 0.012,
      punishChance: 0.04,
      strafeSpeed: 0.85,
      preferredRange: [9, 14],
    },
    stageHealth: [880, 900, 1000],
    damageMultiplier: 1.03,
  }),
  boss({
    id: 'agent',
    name: 'Glowie',
    title: 'Government Enforcement',
    intro: 'Unknown',
    theme: 'office',
    stages: [
      // Barrels: a pistol at his side, an SMG across the chest, a minigun at the hip.
      { name: 'Routine Inquiry', model: 'bossAgent1', attacks: NONE, muzzle: gunMuzzle([0.085, 0.343, 0.243], 0.8) },
      {
        name: 'Armed Response',
        model: 'bossAgent2',
        muzzle: gunMuzzle([0.202, 0.682, -0.111], 1),
        attacks: { blast: true, stun: false, ultimate: false, volley: { name: 'Burst Fire', count: 3, spreadDeg: 3, interval: 0.09, cooldown: 4.5, damageScale: 0.6 } },
      },
      {
        name: 'Black Ops',
        model: 'bossAgent3',
        muzzle: gunMuzzle([0.454, 0.4, -0.206], 1.5),
        attacks: { ...ALL, volley: { name: 'Full Auto', count: 7, spreadDeg: 7, interval: 0.07, cooldown: 5, damageScale: 0.4 } },
      },
    ],
    skins: { bolt: 'bullet', blast: 'grenade' },
    palette: { name: 'Glowie', robe: 0x16181d, trim: 0xd8dde6, spell: 0xffd27a, blast: 0xff5a2a, stun: 0xbfe8ff, ultimate: 0xff3030 },
    ai: {
      label: 'Glowie',
      reactionTime: 0.26,
      aimError: 0.7,
      leadFactor: 0.16,
      dodgeChance: 0.42,
      shieldPreference: 0.45,
      perfectShieldChance: 0.18,
      burst: [1, 3],
      burstPause: [3, 4.3],
      blastChance: 0.022,
      stunChance: 0.01,
      punishChance: 0.05,
      strafeSpeed: 0.95,
      preferredRange: [8, 13],
    },
    stageHealth: [1015, 1035, 1180],
    damageMultiplier: 1.04,
  }),
  boss({
    id: 'tinubu',
    name: 'Tinubu',
    title: 'the Unshackled Demon',
    intro: 'Infects you to make you sell your tickets.',
    theme: 'volcano',
    stages: [
      // Bolts from his raised palm (later his right claw), blasts and volleys from his mouth.
      {
        name: 'Emi Lokan',
        model: 'bossTinubu1',
        attacks: { blast: true, stun: false, ultimate: false },
        muzzle: handAndMouth([0.238, 0.781, 0.229], [0.071, 0.793, -0.026]),
      },
      {
        name: 'Unshackled',
        model: 'bossTinubu2',
        muzzle: handAndMouth([0.167, 0.482, 0.351], [0.163, 0.782, -0.01], 1.2),
        attacks: { ...SPELLS, volley: { name: 'Hellfire', count: 3, spreadDeg: 20, interval: 0, cooldown: 4.5, damageScale: 0.7 } },
      },
      {
        name: 'Inferno Incarnate',
        model: 'bossTinubu3',
        muzzle: handAndMouth([0.179, 0.459, 0.355], [0.114, 0.788, 0.024], 1.45),
        attacks: { ...ALL, volley: { name: 'Inferno', count: 5, spreadDeg: 40, interval: 0, cooldown: 3.5, damageScale: 0.7 } },
      },
    ],
    skins: { bolt: 'hellfire', blast: 'skull' },
    palette: { name: 'Tinubu', robe: 0xe9dcc0, trim: 0xd4a017, spell: 0xff3a1a, blast: 0xff7a00, stun: 0xffd0c0, ultimate: 0xff2000 },
    ai: {
      label: 'Tinubu',
      reactionTime: 0.2,
      aimError: 0.45,
      leadFactor: 0.2,
      dodgeChance: 0.45,
      shieldPreference: 0.45,
      perfectShieldChance: 0.3,
      burst: [2, 3],
      burstPause: [3, 4.2],
      blastChance: 0.025,
      stunChance: 0.02,
      punishChance: 0.1,
      strafeSpeed: 1.05,
      preferredRange: [8, 13],
    },
    stageHealth: [1000, 1010, 1020],
    damageMultiplier: 1.27,
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
  city: 'Los Angeles',
  office: 'Government Office',
};
