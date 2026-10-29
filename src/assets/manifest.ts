/**
 * Asset manifest: every external asset the game can use, keyed by name.
 *
 * Paths are relative to `public/assets/`. If a file is missing the game uses a built-in
 * placeholder (primitives for models, procedural textures, synthesized sounds), so you can
 * drop generated files in one at a time. Game code only ever refers to the keys below.
 *
 * Audio and textures may use any common extension: if `audio/bolt_cast.mp3` is listed but you
 * save `audio/bolt_cast.wav`, it is still found. See ASSETS.md for what each asset should be.
 */

import type { ObstacleKind } from '../arena/Pillar';
import type { ArenaThemeId } from '../arena/themes';
import type { MuzzleSet } from '../wizard/muzzles';
import { CONFIG } from '../config';

/**
 * The game's animation states. Locomotion (run and the strafes/backpedal), jump and dodge drive the
 * legs; cast/castBig/hit can play on the upper body over running (src/wizard/Animator.ts).
 */
export type WizardClip =
  | 'idle' | 'run' | 'strafeL' | 'strafeR' | 'runBack' | 'jump'
  | 'cast' | 'castBig' | 'dodge' | 'hit' | 'stunned' | 'victory' | 'defeat';

/**
 * A point carried by a bone of a rigged model: `offset` is in the bone's local frame and units
 * (centimetres for the Meshy/Higgsfield rigs, whose Armature is scaled 0.01).
 */
export interface BoneSocket {
  bone: string;
  /** The muzzle point (the game's measured muzzle) in the bone's frame. */
  offset: readonly [number, number, number];
  /** Where the glow belongs (the gem's or flame's centre), if not exactly `offset`. */
  glowOffset?: readonly [number, number, number];
}

/**
 * A skinned, animated version of a model (`models/rigged/`). Loaded instead of `path` when the file
 * is on disk; the static mesh (animated procedurally) is the fallback. It keeps the entry's
 * `fitHeight`, `anchor`, `doubleSided` and `clips`.
 */
export interface RiggedModel {
  path: string;
  /** Extra yaw in degrees. The rigs face +Z already, so 0 (the static Tripo meshes need -90). */
  rotationY?: number;
  /**
   * Visual muzzle sockets by muzzle point name (staff, phoneR, phoneL, vape, gun, hand, mouth; see
   * src/wizard/muzzles.ts): the glows and muzzle effects ride these bones. Spells still leave from
   * the static muzzle point (Wizard.castPoint), the deterministic gameplay origin.
   */
  sockets?: Readonly<Record<string, BoneSocket>>;
  /** Seconds into `cast` / `cast_big` of the release (the thrust). Defaults 0.45 / 0.62 (the clip library's). */
  castPeak?: number;
  castBigPeak?: number;
  /** Clips this model must not play (Tinubu's rigid wings and robe go through the floor in a roll or jump). */
  skipClips?: readonly WizardClip[];
  /**
   * A long prop held in one hand (the player's staff): its two ends in the bone's local centimetres.
   * Every frame the hand turns it just enough to keep the shaft out of the body, head and legs (the
   * mocap was made empty-handed). See Animator `keepStaffClear`.
   */
  staff?: StaffSpec;
}

type Vec3 = readonly [number, number, number];

export interface StaffSpec {
  bone: string;
  /** The grip (left alone within `gripReach` m of it) and the two ends, in the bone's local cm. */
  grip: Vec3;
  tip: Vec3;
  butt: Vec3;
  gripReach: number;
  /** Body stand-ins: capsules between two bones (by name), radius in metres at the model's fitted size. */
  body: readonly { from: string; to: string; radius: number }[];
}

/** How a character carries itself (procedural motion and clip speeds). Both 0..1, default 0. */
export interface MotionStyle {
  /** Heavier: slower, deeper idle and stride, bigger landings. */
  weight?: number;
  /** A late boss stage looming: slow side-to-side sway, a forward hunch, deep breathing. */
  menace?: number;
}

export interface ModelAsset {
  path: string;
  /** Uniformly rescale so the model's bounding box is this tall, in meters. Leave unset to keep authored scale. */
  fitHeight?: number;
  /** Extra yaw in degrees if the model doesn't face +Z (glTF forward). */
  rotationY?: number;
  /** Raise or lower the model after fitting, in meters. */
  yOffset?: number;
  /** Animation clip names inside the GLB. Matched case-insensitively; substrings are fine ("run" matches "Armature|Run"). */
  clips?: Partial<Record<WizardClip, string>>;
  /** Console warning above this count. */
  maxTriangles?: number;
  /** Render both faces of every material (thin capes and robes from image-to-3D tools). */
  doubleSided?: boolean;
  /**
   * How to centre the model on its origin across the ground: 'bounds' (default) uses the bounding
   * box; 'feet' uses the vertices near the ground, so a gun, wing or cape sticking out to one side
   * doesn't shift the body off its collider.
   */
  anchor?: 'bounds' | 'feet';
  /**
   * Where spells leave the model (staff orb, phone, gun barrel...), for models that aren't a boss
   * stage (boss stages set `muzzle` in levels.ts). See src/wizard/muzzles.ts and ASSETS.md.
   */
  muzzle?: MuzzleSet;
  /** Skinned, animated variant, preferred when its file exists (see RiggedModel). */
  rigged?: RiggedModel;
  /** Procedural motion style (boss stages get heavier and more menacing). */
  motion?: MotionStyle;
}

export interface TextureAsset {
  path: string;
  /** Texture repeat (u, v). */
  repeat?: [number, number];
  /** True for color maps (sRGB), false for data maps like normals. */
  color?: boolean;
}

export interface SoundAsset {
  path: string;
  volume: number;
  loop?: boolean;
  /** Music tracks follow the music volume slider and crossfade. */
  music?: boolean;
  /** Max simultaneous instances; extra plays steal the oldest. */
  maxVoices?: number;
}

/** Game clip -> action name in the rigged GLBs (models/rigged/, see ASSETS.md). Missing clips are fine. */
export const WIZARD_CLIPS: Readonly<Partial<Record<WizardClip, string>>> = {
  idle: 'idle',
  run: 'run',
  strafeL: 'strafe_l',
  strafeR: 'strafe_r',
  runBack: 'run_back',
  jump: 'jump',
  cast: 'cast',
  castBig: 'cast_big',
  dodge: 'roll',
  hit: 'hit',
  stunned: 'stun',
  victory: 'victory',
  defeat: 'defeat',
};

/**
 * Visual muzzle sockets of the rigged models, by manifest key then muzzle point name (the rig
 * agents measure them: `{ bone, offset }`, offset in the bone's local centimetres). Paste new
 * entries from the rigging pipeline's sockets.json here; a rigged model without one keeps its
 * glows on the static muzzle point.
 */
export const RIG_SOCKETS: Readonly<Record<string, Readonly<Record<string, BoneSocket>>>> = {
  wizardPlayer: { staff: { bone: 'RightHand', offset: [-30.08, 25.8, -55.03], glowOffset: [-36.09, 24.47, -58.72] } },
  bossSahil1: { staff: { bone: 'RightHand', offset: [52.73, -17.56, -47.45] } },
  bossSahil2: { staff: { bone: 'RightHand', offset: [-55.68, 11.52, -19.31], glowOffset: [-56.42, 9.89, -18.23] } },
  bossSahil3: { staff: { bone: 'RightHand', offset: [33.72, 20.7, -52.72], glowOffset: [35.59, 24.86, -47.73] } },
  // Stage 1s hold one phone (muzzle 'phone'): Obama's in his right hand, The Midget's in his left.
  bossObama1: { phone: { bone: 'RightHand', offset: [0.3, 9.98, 4.68] } },
  bossObama2: { phoneR: { bone: 'RightHand', offset: [-2.1, 13.81, 4.87] }, phoneL: { bone: 'LeftHand', offset: [0.83, 20.24, 3.98] } },
  bossObama3: { phoneR: { bone: 'RightHand', offset: [-5.13, 17.09, -1.33] }, phoneL: { bone: 'LeftHand', offset: [1.28, 16.54, -1.37] } },
  bossMidget1: { phone: { bone: 'LeftHand', offset: [0.12, 8.03, -1.66] } },
  bossMidget2: { phoneR: { bone: 'RightHand', offset: [-4.48, 9.1, 2.08] }, phoneL: { bone: 'LeftHand', offset: [5.17, 10.55, 2.76] } },
  bossMidget3: { phoneR: { bone: 'RightHand', offset: [-0.29, 9.13, -0.22] }, phoneL: { bone: 'LeftHand', offset: [0.5, 9.37, 4.38] } },
  bossBroccoli1: { vape: { bone: 'RightHand', offset: [-13.63, 14.86, 6.37] } },
  bossBroccoli2: { vape: { bone: 'RightHand', offset: [-6.95, 17.63, -15.3] } },
  bossBroccoli3: { vape: { bone: 'RightForeArm', offset: [-114.36, 63.83, -9] } },
  bossAgent1: { gun: { bone: 'RightHand', offset: [2.82, 40.28, -1.78] } },
  bossAgent2: { gun: { bone: 'RightHand', offset: [-33.52, 39.65, -39.52] } },
  bossAgent3: { gun: { bone: 'RightHand', offset: [0.63, 133.16, -36.55] } },
  bossTinubu1: { hand: { bone: 'RightHand', offset: [-0.61, 17.42, -4.43] }, mouth: { bone: 'Head', offset: [0.81, 6.55, 11.94] } },
  bossTinubu2: { hand: { bone: 'RightHand', offset: [-8.33, 22.98, -4.6] }, mouth: { bone: 'Head', offset: [-0.63, 0.76, 29.72] } },
  bossTinubu3: { hand: { bone: 'RightHand', offset: [-23.94, 22.29, 35.52] }, mouth: { bone: 'Head', offset: [5.79, 4.71, 48.92] } },
};

/**
 * Release times (s into cast / cast_big, the throwing hand furthest forward) of the rigs whose
 * throws are their own clips rather than the library's: Bitcoin Obama pitches and crouch-throws,
 * The Midget whips an over-shoulder throw and slams. Others keep the library's defaults.
 */
const RIG_CAST_PEAKS: Readonly<Record<string, { castPeak: number; castBigPeak: number }>> = {
  bossObama1: { castPeak: 0.667, castBigPeak: 0.933 },
  bossObama2: { castPeak: 0.667, castBigPeak: 0.9 },
  bossObama3: { castPeak: 0.667, castBigPeak: 0.9 },
  bossMidget1: { castPeak: 0.733, castBigPeak: 0.9 },
  bossMidget2: { castPeak: 0.733, castBigPeak: 0.9 },
  bossMidget3: { castPeak: 0.733, castBigPeak: 0.867 },
};

/**
 * The player's staff, measured from the rig (the shaft's principal axis through the vertices bound to
 * the right hand): a full-length walking staff, the orb at `tip`. The coat makes the legs about 0.2 m
 * thick, the spiky hair the head about 0.22 m.
 */
const PLAYER_STAFF: StaffSpec = {
  bone: 'RightHand',
  grip: [-4.2, 9.7, -10.3],
  tip: [-40.5, 39.1, -61.8],
  butt: [58.7, -41.2, 78.6],
  gripReach: 0.25,
  body: [
    { from: 'Hips', to: 'neck', radius: 0.2 },
    { from: 'neck', to: 'head_end', radius: 0.22 },
    { from: 'LeftUpLeg', to: 'LeftLeg', radius: 0.19 },
    { from: 'LeftLeg', to: 'LeftFoot', radius: 0.17 },
    { from: 'RightUpLeg', to: 'RightLeg', radius: 0.19 },
    { from: 'RightLeg', to: 'RightFoot', radius: 0.17 },
  ],
};

/** Clips a boss's rigs must not play: Tinubu's rigid wings and robe go through the floor in a roll or jump (procedural flip instead). */
const RIG_SKIP_CLIPS: Readonly<Record<string, readonly WizardClip[]>> = { tinubu: ['dodge', 'jump'] };

/**
 * Boss motion by stage: each stage moves heavier, and the last one looms (MotionStyle). The Midget
 * stays quick on his feet.
 */
const STAGE_MOTION: readonly MotionStyle[] = [{ weight: 0.25 }, { weight: 0.5, menace: 0.35 }, { weight: 0.75, menace: 1 }];
const LIGHT_STAGE_MOTION: readonly MotionStyle[] = [{ weight: 0 }, { weight: 0.15, menace: 0.25 }, { weight: 0.3, menace: 0.8 }];

/**
 * `boss<Id>1..3` model entries at `models/bosses/<id>/stage1..3.glb`, one fit height per stage,
 * each with its rigged variant at `models/rigged/<id>_stage1..3.glb`.
 */
function bossStages<Id extends string>(id: Id, heights: [number, number, number], motion = STAGE_MOTION) {
  const name = `boss${id[0].toUpperCase()}${id.slice(1)}` as `boss${Capitalize<Id>}`;
  const out = {} as Record<`${typeof name}${1 | 2 | 3}`, ModelAsset>;
  heights.forEach((fitHeight, i) => {
    const key = `${name}${(i + 1) as 1 | 2 | 3}` as const;
    out[key] = {
      path: `models/bosses/${id}/stage${i + 1}.glb`, fitHeight, rotationY: -90, doubleSided: true, anchor: 'feet', clips: WIZARD_CLIPS,
      rigged: { path: `models/rigged/${id}_stage${i + 1}.glb`, sockets: RIG_SOCKETS[key], skipClips: RIG_SKIP_CLIPS[id], ...RIG_CAST_PEAKS[key] },
      motion: motion[i],
    };
  });
  return out;
}

/** The Midget's stages. Stage 1's mesh has a ~4.6° yaw baked into its node (2 and 3 don't): cancel it so the swap doesn't twist him. */
const MIDGET_STAGES = bossStages('midget', [1.25, 1.4, 1.6], LIGHT_STAGE_MOTION);
MIDGET_STAGES.bossMidget1.rotationY = -94.6;

export const MODELS = {
  // Player: Higgsfield/Tripo static mesh (faces +X), animated procedurally like the bosses, or its
  // skinned version (models/rigged/, faces +Z) with clips when that file is there.
  // His magical sproto staff: every spell leaves from the glowing orb on top (right hand).
  wizardPlayer: {
    path: 'models/wizard_player.glb', fitHeight: 1.9, rotationY: -90, doubleSided: true, anchor: 'feet', clips: WIZARD_CLIPS,
    muzzle: { points: { staff: { type: 'staff', at: [0.076, 0.916, 0.203] } } },
    rigged: { path: 'models/rigged/wizard_player.glb', sockets: RIG_SOCKETS.wizardPlayer, staff: PLAYER_STAFF },
  },
  wizardRival: { path: 'models/wizard_rival.glb', fitHeight: 1.85, clips: WIZARD_CLIPS },
  pillar: { path: 'models/pillar.glb', fitHeight: 5.5 },
  pillarBroken: { path: 'models/pillar_broken.glb', fitHeight: 1.0 },
  pillarDebris: { path: 'models/pillar_debris.glb', fitHeight: 0.5, maxTriangles: 400 },
  arenaRuins: { path: 'models/arena_ruins.glb', fitHeight: 6 },
  brazier: { path: 'models/brazier.glb', fitHeight: 1.6 },
  // Campaign bosses: one model per fight stage (the boss evolves at 2/3 and 1/3 health), static
  // meshes the game animates procedurally. Higgsfield/Tripo exports face +X, hence rotationY -90;
  // thin robes and capes render double-sided. Each stage stands a little taller.
  ...bossStages('sahil', [2.0, 2.25, 2.55]),
  ...bossStages('obama', [2.1, 2.3, 2.55]),
  // Bitcoin Obama's partner in the double fight: short (his hitbox is 1.25 m), a little bigger each stage.
  ...MIDGET_STAGES,
  ...bossStages('broccoli', [2.0, 2.35, 2.8]),
  ...bossStages('agent', [2.0, 2.2, 2.5]),
  ...bossStages('tinubu', [2.1, 2.45, 2.9]),
  // Boss Gauntlet health pickup (src/arena/LifePacks.ts): a red potion flask; a code-built one without it.
  lifePack: { path: 'models/pickups/life_pack.glb', fitHeight: CONFIG.lifePacks.size, rotationY: -90, maxTriangles: 3000 },
} satisfies Record<string, ModelAsset>;

export const TEXTURES = {
  floor: { path: 'textures/arena_floor.jpg', color: true },
  floorNormal: { path: 'textures/arena_floor_normal.jpg', color: false },
  pillar: { path: 'textures/pillar_stone.jpg', color: true, repeat: [2, 2] },
  sky: { path: 'textures/sky_night.jpg', color: true },
  /** Golden ticket face, 2:1 with a transparent background (a canvas-drawn face is used without it). */
  goldenTicket: { path: 'textures/golden_ticket.png', color: true },
} satisfies Record<string, TextureAsset>;

export const SOUNDS = {
  boltCast: { path: 'audio/bolt_cast.mp3', volume: 0.35, maxVoices: 6 },
  boltHit: { path: 'audio/bolt_hit.mp3', volume: 0.5, maxVoices: 6 },
  fizzle: { path: 'audio/fizzle.mp3', volume: 0.3, maxVoices: 4 },
  blastCharge: { path: 'audio/blast_charge.mp3', volume: 0.45 },
  blastCast: { path: 'audio/blast_cast.mp3', volume: 0.6 },
  blastExplode: { path: 'audio/blast_explode.mp3', volume: 0.85, maxVoices: 3 },
  shieldUp: { path: 'audio/shield_up.mp3', volume: 0.55 },
  shieldBlock: { path: 'audio/shield_block.mp3', volume: 0.6, maxVoices: 3 },
  shieldPerfect: { path: 'audio/shield_perfect.mp3', volume: 0.8 },
  stunCharge: { path: 'audio/stun_charge.mp3', volume: 0.5 },
  stunBeam: { path: 'audio/stun_beam.mp3', volume: 0.65 },
  stunHit: { path: 'audio/stun_hit.mp3', volume: 0.7 },
  ultReady: { path: 'audio/ult_ready.mp3', volume: 0.6 },
  ultCharge: { path: 'audio/ult_charge.mp3', volume: 0.8 },
  ultWave: { path: 'audio/ult_wave.mp3', volume: 1.0 },
  clash: { path: 'audio/clash.mp3', volume: 0.75, maxVoices: 3 },
  dodge: { path: 'audio/dodge.mp3', volume: 0.45 },
  hurt: { path: 'audio/hurt.mp3', volume: 0.6, maxVoices: 3 },
  noMana: { path: 'audio/no_mana.mp3', volume: 0.35 },
  pillarHit: { path: 'audio/pillar_hit.mp3', volume: 0.45, maxVoices: 4 },
  pillarCrumble: { path: 'audio/pillar_crumble.mp3', volume: 0.9 },
  fireBurn: { path: 'audio/fire_burn.mp3', volume: 0.5, maxVoices: 2 },
  fireLoop: { path: 'audio/fire_loop.mp3', volume: 0.18, loop: true },
  countdown: { path: 'audio/countdown.mp3', volume: 0.5 },
  roundStart: { path: 'audio/round_start.mp3', volume: 0.8 },
  roundWin: { path: 'audio/round_win.mp3', volume: 0.7 },
  roundLose: { path: 'audio/round_lose.mp3', volume: 0.7 },
  victory: { path: 'audio/victory.mp3', volume: 0.8 },
  defeat: { path: 'audio/defeat.mp3', volume: 0.8 },
  uiHover: { path: 'audio/ui_hover.mp3', volume: 0.25 },
  uiClick: { path: 'audio/ui_click.mp3', volume: 0.45 },
  // Boss objects leaving the hand (ProjectileSkins), in place of the bolt/blast cast sound.
  gunshot: { path: 'audio/gunshot.mp3', volume: 0.5, maxVoices: 6 },
  grenadeThump: { path: 'audio/grenade_thump.mp3', volume: 0.6, maxVoices: 3 },
  rugWhoosh: { path: 'audio/rug_whoosh.mp3', volume: 0.5, maxVoices: 4 },
  phoneBlip: { path: 'audio/phone_blip.mp3', volume: 0.35, maxVoices: 4 },
  pigOink: { path: 'audio/pig_oink.mp3', volume: 0.55, maxVoices: 3 },
  veggieCrunch: { path: 'audio/veggie_crunch.mp3', volume: 0.5, maxVoices: 4 },
  fireRoar: { path: 'audio/fire_roar.mp3', volume: 0.5, maxVoices: 4 },
  ticketSpawn: { path: 'audio/ticket_spawn.mp3', volume: 0.4, maxVoices: 3 },
  ticketPickup: { path: 'audio/ticket_pickup.mp3', volume: 0.75, maxVoices: 3 },
  ticketExpire: { path: 'audio/ticket_expire.mp3', volume: 0.45, maxVoices: 3 },
  // Boss transformation cinematics (BossCinematic) and life packs.
  bossRise: { path: 'audio/boss_rise.mp3', volume: 0.75 },
  bossRoar: { path: 'audio/boss_roar.mp3', volume: 0.9 },
  bossSlam: { path: 'audio/boss_slam.mp3', volume: 0.95 },
  lifePackSpawn: { path: 'audio/life_pack_spawn.mp3', volume: 0.5 },
  lifePackPickup: { path: 'audio/life_pack_pickup.mp3', volume: 0.8 },
  // Boss reward spells (src/spells/RewardSpells.ts) and the "new spell learned" reveal.
  carpetWhoosh: { path: 'audio/carpet_whoosh.mp3', volume: 0.6, maxVoices: 2 },
  pumpCoin: { path: 'audio/pump_coin.mp3', volume: 0.65, maxVoices: 2 },
  vapePuff: { path: 'audio/vape_puff.mp3', volume: 0.6, maxVoices: 2 },
  lockBeep: { path: 'audio/lock_beep.mp3', volume: 0.5, maxVoices: 2 },
  breathRoar: { path: 'audio/breath_roar.mp3', volume: 0.7, maxVoices: 2 },
  spellLearned: { path: 'audio/spell_learned.mp3', volume: 0.8 },
  musicMenu: { path: 'audio/music_menu.mp3', volume: 0.6, loop: true, music: true },
  musicBattle: { path: 'audio/music_battle.mp3', volume: 0.55, loop: true, music: true },
} satisfies Record<string, SoundAsset>;

/** Per-environment assets. Missing files fall back to procedural textures and primitive meshes. */
export interface ThemeAssets {
  /** Top-down circular arena floor (square image, centred circle). */
  floor: string;
  /** 2:1 equirectangular sky panorama. */
  sky: string;
  /** Tileable surface texture for the wall and placeholder pillars. */
  stone: string;
  /**
   * Cover piece. Ring layouts: a column, roughly cylindrical (collision is a cylinder, the shaft is
   * fitted to it). The office's cubicle layout: a cubicle, fitted per axis to its square box collider.
   */
  pillar: ModelAsset;
  /** Decorative set piece placed around the outside of the wall. */
  prop: ModelAsset;
}

const themeAssets = (id: string, propHeight: number, pillarHeight = CONFIG.arena.pillars.height): ThemeAssets => ({
  floor: `textures/themes/${id}/floor.jpg`,
  sky: `textures/themes/${id}/sky.jpg`,
  stone: `textures/themes/${id}/stone.jpg`,
  // Higgsfield/Tripo exports face +X; rotate so the front faces +Z like every other model.
  pillar: { path: `models/themes/${id}/pillar.glb`, fitHeight: pillarHeight, maxTriangles: 5000, rotationY: -90 },
  prop: { path: `models/themes/${id}/prop.glb`, fitHeight: propHeight, maxTriangles: 8000, rotationY: -90, doubleSided: true },
});

export const THEME_ASSETS: Record<ArenaThemeId, ThemeAssets> = {
  moonlit: {
    floor: 'textures/arena_floor.jpg',
    sky: 'textures/sky_night.jpg',
    stone: 'textures/pillar_stone.jpg',
    pillar: MODELS.pillar,
    prop: MODELS.arenaRuins,
  },
  grove: themeAssets('grove', 5),
  volcano: themeAssets('volcano', 5),
  glacier: themeAssets('glacier', 5),
  desert: themeAssets('desert', 5),
  void: themeAssets('void', 6),
  // A palm tree (its fronds are single-sided, hence doubleSided).
  city: themeAssets('city', 9),
  // A cubicle (fitted to the cubicle box collider) and a row of filing cabinets with a water cooler.
  office: themeAssets('office', 1.35, CONFIG.arena.cubicles.height),
};

/**
 * Optional generated models for boss-arena obstacles. Each is fitted per axis to its obstacle's
 * collider bounds (turned 90 degrees first if its long side runs the other way), so proportions
 * should roughly match the collider in CONFIG.arena.obstacles. Missing files keep the code-built
 * look. Tripo exports face +X, hence rotationY -90.
 */
const obstacle = (file: string, maxTriangles = 6000): ModelAsset => ({ path: `models/obstacles/${file}`, rotationY: -90, maxTriangles, doubleSided: true });
export const OBSTACLE_MODELS: Partial<Record<ObstacleKind, ModelAsset>> = {
  stall: obstacle('market_stall.glb'),
  rugs: obstacle('rug_pile.glb'),
  car: obstacle('parked_car.glb'),
  truck: obstacle('food_truck.glb'),
  dumpster: obstacle('dumpster.glb'),
  rockA: obstacle('rock_outcrop.glb'),
  rockB: obstacle('rock_outcrop.glb'),
};

/** Boss portraits for the campaign screens (square PNG/WebP). `obama` shows the duo; `midget` is his partner alone. */
export const BOSS_PORTRAITS = {
  sahil: 'ui/bosses/sahil.png',
  obama: 'ui/bosses/obama.png',
  midget: 'ui/bosses/midget.png',
  broccoli: 'ui/bosses/broccoli.png',
  agent: 'ui/bosses/agent.png',
  tinubu: 'ui/bosses/tinubu.png',
} as const;

/** Concept art per boss stage (index 0 = the portrait above); used on stage banners and cards. */
export const bossStagePortrait = (id: keyof typeof BOSS_PORTRAITS, stage: number): string =>
  stage === 0 ? BOSS_PORTRAITS[id] : `ui/bosses/${id}_stage${stage + 1}.png`;

/** Optional HUD icons (square PNG/WebP, transparent background). Built-in SVG glyphs are used otherwise. */
export const UI_ICONS = {
  bolt: 'ui/icon_bolt.png',
  blast: 'ui/icon_blast.png',
  shield: 'ui/icon_shield.png',
  stun: 'ui/icon_stun.png',
  ultimate: 'ui/icon_ultimate.png',
} as const;

export type ModelKey = keyof typeof MODELS;
export type TextureKey = keyof typeof TEXTURES;
export type SoundKey = keyof typeof SOUNDS;
