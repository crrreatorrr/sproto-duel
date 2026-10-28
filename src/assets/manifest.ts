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

import type { ArenaThemeId } from '../arena/themes';

export type WizardClip = 'idle' | 'run' | 'cast' | 'castBig' | 'dodge' | 'hit' | 'stunned' | 'victory' | 'defeat';

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

const WIZARD_CLIPS: ModelAsset['clips'] = {
  idle: 'idle',
  run: 'run',
  cast: 'cast',
  castBig: 'cast_big',
  dodge: 'roll',
  hit: 'hit',
  stunned: 'stun',
  victory: 'victory',
  defeat: 'defeat',
};

/** `boss<Id>1..3` model entries at `models/bosses/<id>/stage1..3.glb`, one fit height per stage. */
function bossStages<Id extends string>(id: Id, heights: [number, number, number]) {
  const name = `boss${id[0].toUpperCase()}${id.slice(1)}` as `boss${Capitalize<Id>}`;
  const out = {} as Record<`${typeof name}${1 | 2 | 3}`, ModelAsset>;
  heights.forEach((fitHeight, i) => {
    out[`${name}${(i + 1) as 1 | 2 | 3}`] = { path: `models/bosses/${id}/stage${i + 1}.glb`, fitHeight, rotationY: -90, doubleSided: true, anchor: 'feet' };
  });
  return out;
}

/** The Midget's stages. Stage 1's mesh has a ~4.6° yaw baked into its node (2 and 3 don't): cancel it so the swap doesn't twist him. */
const MIDGET_STAGES = bossStages('midget', [1.25, 1.4, 1.6]);
MIDGET_STAGES.bossMidget1.rotationY = -94.6;

export const MODELS = {
  // Player: Higgsfield/Tripo static mesh (faces +X), animated procedurally like the bosses.
  wizardPlayer: { path: 'models/wizard_player.glb', fitHeight: 1.9, rotationY: -90, doubleSided: true, anchor: 'feet', clips: WIZARD_CLIPS },
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
  /** Cover column, roughly cylindrical (collision is a cylinder). */
  pillar: ModelAsset;
  /** Decorative set piece placed around the outside of the wall. */
  prop: ModelAsset;
}

const themeAssets = (id: string, propHeight: number): ThemeAssets => ({
  floor: `textures/themes/${id}/floor.jpg`,
  sky: `textures/themes/${id}/sky.jpg`,
  stone: `textures/themes/${id}/stone.jpg`,
  // Higgsfield/Tripo exports face +X; rotate so the front faces +Z like every other model.
  pillar: { path: `models/themes/${id}/pillar.glb`, fitHeight: 5.5, maxTriangles: 5000, rotationY: -90 },
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
