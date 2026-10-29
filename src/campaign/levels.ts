import type { AIProfile, TeamPalette } from '../config';
import type { ArenaThemeId } from '../arena/themes';
import type { ModelKey } from '../assets/manifest';
import { BOSS_PORTRAITS } from '../assets/manifest';
import { gunMuzzle, handAndMouth, phoneMuzzle, staffMuzzle, twoPhones, vapeMuzzle, type MuzzleSet } from '../wizard/muzzles';
import type { RewardSpellId } from '../spells/rewardCatalog';
import type { TransformStyleId } from './transformStyles';

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

/**
 * A boss special power (src/spells/BossPowers.ts): telegraphed on the floor, then it fires; it
 * recharges on its own cooldown. Each kind is evaded its own way:
 * - `strike`: a reticle follows you for `track` s, then locks for `warn` s and is hit from above.
 *   Get out of the circle after it locks (or roll as it lands).
 * - `barrage`: `count` circles land round you over `duration` s, each `warn` s after it appears.
 *   Keep moving between them.
 * - `march`: a line of eruptions from the boss toward where you stood, one after another
 *   (`step` s apart). Sidestep the line.
 * - `rings`: `count` shockwaves roll out along the floor from the boss. Jump them or roll through.
 * - `sweep`: a low beam turns `arc` degrees round the boss in `duration` s. Jump it or roll.
 * - `cone`: a cone toward you locks, then blasts (knocks you back). Get out of it, or behind cover.
 * - `seekers`: `count` slow homing objects chase you. Roll through one as it arrives (it loses its
 *   lock and flies on), shield, or put cover between you and them. `drain`: a hit also drains mana and ends a golden-ticket boost.
 * - `flash`: a grenade lands and pops: anyone in range looking at it is blinded (stunned). Look away.
 * - `cloud`: a toxic cloud forms where you stand and hurts every second you stay in it. Get out.
 * Rolling (i-frames) evades every kind. Damage is per hit, before the boss's multipliers.
 */
interface PowerBase {
  name: string;
  /** First stage (0, 1 or 2) that has it. */
  from: number;
  /** Seconds to recharge after it fires (later stages recharge faster: CONFIG.powers.stageRecharge). */
  cooldown: number;
  damage: number;
  /** Farthest the target may be to start it (m). */
  range: number;
  /** What falls, flies or is thrown: one of the boss's own projectile looks. */
  skin?: Exclude<ProjectileSkin, 'orb'>;
}
export type PowerDef =
  | (PowerBase & { kind: 'strike'; radius: number; track: number; warn: number })
  | (PowerBase & { kind: 'barrage'; count: number; radius: number; spread: number; duration: number; warn: number })
  | (PowerBase & { kind: 'march'; count: number; spacing: number; radius: number; warn: number; step: number })
  | (PowerBase & { kind: 'rings'; count: number; interval: number; speed: number; maxRadius: number; warn: number })
  | (PowerBase & { kind: 'sweep'; arc: number; duration: number; length: number; warn: number })
  | (PowerBase & { kind: 'cone'; angle: number; length: number; warn: number; knockback: number })
  | (PowerBase & { kind: 'seekers'; count: number; speed: number; turn: number; life: number; drain?: boolean })
  | (PowerBase & { kind: 'flash'; radius: number; warn: number; stun: number; facing: number })
  | (PowerBase & { kind: 'cloud'; radius: number; warn: number; life: number });
export type PowerKind = PowerDef['kind'];

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
  /**
   * This stage flies: it hovers this high (m) over whatever is underneath, over low cover, fire and
   * lava (CONFIG.campaign.flight); a stun drops it to the ground until it wears off.
   */
  fly?: number;
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
  /**
   * His ordinary spells' share of that (bolts, blasts, stuns, the Ultimate), now that bosses fire
   * them far more often (CONFIG.campaign.aggression); default `aggression.spellDamage`.
   */
  spellDamage?: number;
  /** Multiplies walk and sprint speed (and acceleration); default 1. */
  speed?: number;
  /**
   * His own transformation cinematic (src/campaign/transformStyles.ts): how he moves, what he
   * brings and how he sounds when a bar breaks (CONFIG.campaign.cinematic.styles).
   */
  transform: TransformStyleId;
  /** His special powers (PowerDef): each unlocks at its stage and recharges on its own. */
  powers: PowerDef[];
}

/**
 * The second boss of a double fight (Bitcoin Obama's The Midget). A full wizard of its own
 * (Game.partner): its own health bar, stages, AI, skins and palette, fighting alongside the boss.
 */
export interface BossPartner extends BossFighter {
  /** Collision capsule in meters. Spells aim at (and hit) this body: chest, wand and HUD tag follow its height. */
  hitbox: { radius: number; height: number };
}

/**
 * How a boss's arena changes as the fight goes on (src/arena/ArenaShifts.ts, CONFIG.arenaShifts):
 * when the fight reaches stage 2 hazard pools open and a healing spring wells up; at stage 3 vents
 * start erupting. Everything is in the boss's theme and hurts (or heals) anyone, boss or player.
 */
export interface ArenaShiftDef {
  /** The light and fog turn toward this colour, more each stage. */
  mood: number;
  /** Stage 2: pools that burn anyone standing in them (feet on the floor), `slow` scaling their speed. */
  pools: { name: string; color: number; dps: number; look: 'sand' | 'liquid' | 'magma' | 'electric'; slow?: number };
  /** Stage 2: a spring that heals anyone standing in it until it runs dry (stage 3 fills it again). */
  spring: { name: string; color: number };
  /** Stage 3: vents that warn, then erupt: damage and a shove out of them. */
  vents: { name: string; color: number; damage: number };
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
  /**
   * The spell beating this fight teaches the player for good (src/spells/rewardCatalog.ts; a double
   * fight teaches one, once both bosses are down). Bosses never cast these themselves.
   */
  reward: RewardSpellId;
  /** How the arena changes at stages 2 and 3 (in a double fight, at the furthest stage either boss reaches). */
  shift: ArenaShiftDef;
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
 * Each fight is tuned for a player who arrives with the boss spells (`reward`) of every fight before
 * it: fight N against spells 1..N-1. Tuned with `__duel.qa.campaignSoak` (its reference AI uses those
 * spells; reference win rates: README / the final report).
 */
export const BOSSES: BossDef[] = [
  boss({
    id: 'sahil',
    name: 'Sahil',
    title: 'the RugMaster',
    reward: 'carpet',
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
    transform: 'bazaar',
    shift: { mood: 0xff9a3c, pools: { name: 'Quicksand', color: 0xd9b26a, dps: 4, look: 'sand', slow: 0.5 }, spring: { name: 'Oasis', color: 0x4fe0c8 }, vents: { name: 'Sand Geysers', color: 0xffc070, damage: 9 } },
    powers: [
      { kind: 'sweep', name: 'Carpet Sweep', from: 0, cooldown: 15, damage: 7, range: 15, arc: 200, duration: 1.9, length: 15, warn: 1.1, skin: 'carpet' },
      { kind: 'barrage', name: 'Bazaar Rain', from: 1, cooldown: 17, damage: 7, range: 30, count: 7, radius: 2, spread: 5, duration: 2.4, warn: 1.15, skin: 'rugRoll' },
      { kind: 'strike', name: 'Magic Carpet Drop', from: 2, cooldown: 16, damage: 13, range: 30, radius: 2.7, track: 1.6, warn: 0.85, skin: 'carpet' },
    ],
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
    spellDamage: 0.45,
  }),
  boss({
    // A double fight: Bitcoin Obama (tall) and The Midget at the same time, each with his own
    // health bar and stages. Tuned as a pair to sit between Sahil and Broccoli Head.
    id: 'obama',
    name: 'Bitcoin Obama',
    title: 'the Pump & Dump Duo',
    reward: 'pump',
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
    transform: 'shill',
    shift: { mood: 0xf7931a, pools: { name: 'Liquidation Pits', color: 0xff3346, dps: 11, look: 'liquid' }, spring: { name: 'Airdrop', color: 0x5dff8a }, vents: { name: 'Gas Fees', color: 0xb26bff, damage: 10 } },
    powers: [
      { kind: 'march', name: 'Green Candles', from: 0, cooldown: 15, damage: 8, range: 22, count: 7, spacing: 2.6, radius: 1.5, warn: 0.95, step: 0.14 },
      { kind: 'seekers', name: 'Shill Calls', from: 1, cooldown: 17, damage: 6, range: 26, count: 3, speed: 8.5, turn: 2.2, life: 5, skin: 'phone' },
      { kind: 'rings', name: 'Liquidation', from: 2, cooldown: 18, damage: 10, range: 22, count: 3, interval: 0.75, speed: 13, maxRadius: 24, warn: 0.95 },
    ],
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
    // bars, closes in). Two separate bosses: each changes stage only when its own bar empties, and
    // knocking one out leaves the other as it is; a sharp player drops Obama first.
    stageHealth: [380, 440, 500],
    damageMultiplier: 0.64,
    spellDamage: 0.5,
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
          // His final form flies.
          fly: 1.7,
          muzzle: twoPhones([0.081, 0.491, 0.231], [0.025, 0.484, -0.325], true),
          attacks: { blast: true, stun: true, ultimate: false, volley: { name: 'Moon Shot', count: 3, spreadDeg: 4, interval: 0.1, cooldown: 5, damageScale: 0.6 } },
        },
      ],
      skins: { bolt: 'phone', blast: 'pig' },
      transform: 'tantrum',
      powers: [
        { kind: 'rings', name: 'Tantrum Stomp', from: 0, cooldown: 19, damage: 7, range: 16, count: 2, interval: 0.6, speed: 12, maxRadius: 18, warn: 0.85 },
        { kind: 'strike', name: 'To the Moon', from: 1, cooldown: 20, damage: 10, range: 30, radius: 2.4, track: 1.4, warn: 0.85, skin: 'phone' },
        { kind: 'barrage', name: 'Pig Rain', from: 2, cooldown: 21, damage: 6, range: 28, count: 9, radius: 1.6, spread: 6, duration: 2.4, warn: 0.95, skin: 'pig' },
      ],
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
      // Much faster than anyone else (1.5x walk and sprint), but a little lighter: less health, softer hits.
      stageHealth: [450, 515, 560],
      damageMultiplier: 0.46,
      spellDamage: 0.5,
      speed: 1.5,
      hitbox: { radius: 0.32, height: 1.25 },
    },
  }),
  boss({
    id: 'broccoli',
    name: 'Broccoli Head',
    title: 'the Floret Lord',
    reward: 'vape',
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
    transform: 'vape',
    shift: { mood: 0x7dff5a, pools: { name: 'Toxic Runoff', color: 0x7dff5a, dps: 12, look: 'liquid' }, spring: { name: 'Fire Hydrant', color: 0x5ab8ff }, vents: { name: 'Sewer Steam', color: 0xdfe8e0, damage: 10 } },
    powers: [
      { kind: 'barrage', name: 'Floret Mortar', from: 0, cooldown: 14, damage: 11, range: 30, count: 8, radius: 2, spread: 5.5, duration: 2.4, warn: 1.0, skin: 'floret' },
      { kind: 'cloud', name: 'Hotbox', from: 1, cooldown: 18, damage: 8, range: 26, radius: 4.2, warn: 0.95, life: 6 },
      { kind: 'cone', name: 'Big Exhale', from: 2, cooldown: 14, damage: 20, range: 12, angle: 60, length: 13, warn: 1.05, knockback: 9 },
    ],
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
    damageMultiplier: 0.76,
    spellDamage: 0.97,
  }),
  boss({
    id: 'agent',
    name: 'Glowie',
    title: 'Government Enforcement',
    reward: 'lockon',
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
    transform: 'glitch',
    shift: { mood: 0x4fd8ff, pools: { name: 'Live Wires', color: 0x5ae0ff, dps: 13, look: 'electric' }, spring: { name: 'Water Cooler', color: 0x8fd8ff }, vents: { name: 'Server Meltdown', color: 0xffd04a, damage: 11 } },
    powers: [
      { kind: 'strike', name: 'Drone Strike', from: 0, cooldown: 14, damage: 17, range: 40, radius: 2.6, track: 1.8, warn: 0.75, skin: 'grenade' },
      { kind: 'flash', name: 'Flashbang', from: 1, cooldown: 15, damage: 6, range: 22, radius: 7, warn: 1.15, stun: 1.6, facing: 110, skin: 'grenade' },
      { kind: 'sweep', name: 'Suppressing Fire', from: 2, cooldown: 15, damage: 13, range: 22, arc: 240, duration: 1.6, length: 22, warn: 0.95, skin: 'bullet' },
    ],
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
    // Retuned for the player's carpet, Pump It and vape cloud (the cloud's healing and cover especially).
    stageHealth: [1096, 1118, 1274],
    damageMultiplier: 0.86,
    spellDamage: 1.15,
  }),
  boss({
    id: 'tinubu',
    name: 'Tinubu',
    title: 'the Unshackled Demon',
    reward: 'breath',
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
    transform: 'hellfire',
    shift: { mood: 0xff4a1a, pools: { name: 'Magma Fissures', color: 0xff5a1a, dps: 16, look: 'magma' }, spring: { name: 'Hot Spring', color: 0x6fe8ff }, vents: { name: 'Eruptions', color: 0xff7a2a, damage: 13 } },
    powers: [
      { kind: 'march', name: 'Hellfire Pillars', from: 0, cooldown: 12, damage: 13, range: 24, count: 8, spacing: 2.6, radius: 1.7, warn: 0.85, step: 0.12 },
      { kind: 'seekers', name: 'Infection', from: 1, cooldown: 15, damage: 8, range: 28, count: 4, speed: 9, turn: 2.6, life: 5.5, skin: 'skull', drain: true },
      { kind: 'rings', name: 'Inferno Rings', from: 2, cooldown: 16, damage: 12, range: 22, count: 3, interval: 0.6, speed: 14, maxRadius: 26, warn: 0.85 },
      { kind: 'barrage', name: 'Meteor Rain', from: 2, cooldown: 15, damage: 17, range: 30, count: 10, radius: 2.2, spread: 6, duration: 2.6, warn: 0.95, skin: 'hellfire' },
    ],
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
    // Retuned for the four spells the player brings (bigger bars keep stages at ~5 minutes).
    stageHealth: [1100, 1111, 800],
    damageMultiplier: 0.74,
    spellDamage: 0.8,
  }),
];

/** The reward spells a player holds on reaching fight `index` for the first time: one per boss before it. */
export const rewardsBefore = (index: number): RewardSpellId[] => BOSSES.slice(0, Math.max(0, index)).map((b) => b.reward);

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
