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

export const MODELS = {
  wizardPlayer: { path: 'models/wizard_player.glb', fitHeight: 1.85, clips: WIZARD_CLIPS },
  wizardRival: { path: 'models/wizard_rival.glb', fitHeight: 1.85, clips: WIZARD_CLIPS },
  pillar: { path: 'models/pillar.glb', fitHeight: 5.5 },
  pillarBroken: { path: 'models/pillar_broken.glb', fitHeight: 1.0 },
  pillarDebris: { path: 'models/pillar_debris.glb', fitHeight: 0.5, maxTriangles: 400 },
  arenaRuins: { path: 'models/arena_ruins.glb', fitHeight: 6 },
  brazier: { path: 'models/brazier.glb', fitHeight: 1.6 },
  // Campaign bosses (static meshes; the game animates them procedurally).
  bossBramble: { path: 'models/bosses/bramble.glb', fitHeight: 2.0 },
  bossCinder: { path: 'models/bosses/cinder.glb', fitHeight: 2.0 },
  bossYsolde: { path: 'models/bosses/ysolde.glb', fitHeight: 2.1 },
  bossKhepri: { path: 'models/bosses/khepri.glb', fitHeight: 2.2 },
  bossMorvane: { path: 'models/bosses/morvane.glb', fitHeight: 2.5 },
} satisfies Record<string, ModelAsset>;

export const TEXTURES = {
  floor: { path: 'textures/arena_floor.jpg', color: true },
  floorNormal: { path: 'textures/arena_floor_normal.jpg', color: false },
  pillar: { path: 'textures/pillar_stone.jpg', color: true, repeat: [2, 2] },
  sky: { path: 'textures/sky_night.jpg', color: true },
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
  pillar: { path: `models/themes/${id}/pillar.glb`, fitHeight: 5.5, maxTriangles: 5000 },
  prop: { path: `models/themes/${id}/prop.glb`, fitHeight: propHeight, maxTriangles: 8000 },
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

/** Boss portraits for the campaign screens (square PNG/WebP). */
export const BOSS_PORTRAITS = {
  bramble: 'ui/bosses/bramble.png',
  cinder: 'ui/bosses/cinder.png',
  ysolde: 'ui/bosses/ysolde.png',
  khepri: 'ui/bosses/khepri.png',
  morvane: 'ui/bosses/morvane.png',
} as const;

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
