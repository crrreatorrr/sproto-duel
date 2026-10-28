import { MOONLIT_FLOOR, MOONLIT_STONE, type FloorStyle, type GroundKind, type StoneStyle } from '../fx/textures';
import type { ArenaLayout } from './layouts';

/**
 * Arena environment themes. 'moonlit' is the default (quick duel); each campaign boss has its own.
 * Visual definitions live here; asset paths live in assets/manifest.ts (THEME_ASSETS).
 * `Arena.applyTheme(id)` switches everything below in one call.
 */
export const THEME_IDS = ['moonlit', 'grove', 'volcano', 'glacier', 'desert', 'void', 'city', 'office'] as const;
export type ArenaThemeId = (typeof THEME_IDS)[number];

export function isThemeId(id: unknown): id is ArenaThemeId {
  return typeof id === 'string' && (THEME_IDS as readonly string[]).includes(id);
}

/** Linear RGB (shader colours; values above 1 glow). */
export type RGB = [number, number, number];

export type PillarStyle = 'column' | 'grove' | 'basalt' | 'ice' | 'obelisk' | 'monolith' | 'freeway' | 'cubicle';
export type PropStyle = 'stones' | 'forest' | 'spires' | 'shards' | 'ruins' | 'asteroids' | 'city' | 'office';
export type AmbientKind = 'none' | 'fireflies' | 'embers' | 'snow' | 'sand' | 'motes' | 'vape' | 'dust';

export interface SkyDef {
  top: RGB;
  mid: RGB;
  horizon: RGB;
  /** Hash threshold per star cell (higher = fewer stars, 1 = none). */
  stars: number;
  starBrightness: number;
  starsBelowHorizon?: boolean;
  /** Colour below the horizon (only visible where there is no ground, e.g. the void). */
  below?: RGB;
  moonDir: RGB;
  moonColor: RGB;
  /** smoothstep edges on dot(view, moonDir): smaller numbers = bigger disc. */
  moonSize: [number, number];
  moonGlow: RGB;
  moonGlowPower: number;
  aurora?: { a: RGB; b: RGB; strength: number };
  /** Drifting cloud / nebula layer. */
  clouds?: { a: RGB; b: RGB; strength: number };
  /** Horizon silhouette (tree line, peaks, dunes). */
  silhouette?: { color: RGB; height: number; amplitude: number; frequency: number; jagged: number };
  /** Hazy band hugging the horizon (city smog); `height` is how far up it reaches (sin of elevation). */
  smog?: { color: RGB; strength: number; height: number };
  /**
   * City skyline on the horizon: two layers of blocky buildings with lit windows, a downtown
   * cluster, and `palms` palm-tree silhouettes in front. `density` = buildings around the horizon.
   */
  skyline?: { color: RGB; window: RGB; height: number; amplitude: number; density: number; palms: number };
}

export interface ArenaTheme {
  id: ArenaThemeId;
  label: string;
  /** How the cover is arranged: 'rings' of pillars (default) or a boss arena's own obstacle layout (layouts.ts). */
  layout?: ArenaLayout;
  /** Indoors: a ceiling with light panels overhead and room walls around (theme kit terrain). */
  interior?: boolean;
  /** scene.background behind the sky dome. */
  background: number;
  sky: SkyDef;
  /** Fog colour; `density` scales CONFIG.render fog distances (2 = twice as close). */
  fog: { color: number; density: number };
  hemi: { sky: number; ground: number; intensity: number };
  /** Key light (moon / sun) direction is from `position` toward the arena centre. */
  sun: { color: number; intensity: number; position: [number, number, number] };
  /** Low fill light from the fire ring side. */
  bounce: { color: number; intensity: number };
  floor: { style: FloorStyle; roughness: number; metalness: number; /** Self-glow of bright texels (lava, runes). */ emissive: number };
  stone: StoneStyle;
  wall: { color: number; emissive: number };
  /** Terrain outside the wall; null = none (floating arena). */
  ground: { color: number; texture?: GroundKind; repeat?: number; emissive?: number } | null;
  /** Rocky underside below the arena disc (floating island). */
  island?: boolean;
  pillar: { style: PillarStyle; color: number; stump: number; accent: number; trim?: number };
  props: { style: PropStyle; color: number; accent: number };
  /** Crumble chunks: stone lumps (default) or flat partition panels. */
  debris: { color: number; emissive: number; shape?: 'chunk' | 'panel' };
  brazier: { bowl: number; flame: RGB };
  fire: { root: RGB; mid: RGB; tip: RGB; glow: RGB; ember: RGB; burn: number; intensity: number };
  ambient: { kind: AmbientKind; rate: number; color: RGB; color2: RGB };
}

export const THEMES: Record<ArenaThemeId, ArenaTheme> = {
  moonlit: {
    id: 'moonlit',
    label: 'Moonlit Ruins',
    background: 0x07060f,
    sky: {
      top: [0.025, 0.03, 0.09],
      mid: [0.12, 0.07, 0.2],
      horizon: [0.32, 0.13, 0.22],
      stars: 0.997,
      starBrightness: 1,
      moonDir: [-0.45, 0.42, -0.78],
      moonColor: [0.9 * 1.6, 0.95 * 1.6, 1.2 * 1.6],
      moonSize: [0.9988, 0.9993],
      moonGlow: [0.25 * 0.5, 0.3 * 0.5, 0.5 * 0.5],
      moonGlowPower: 60,
    },
    fog: { color: 0x140c22, density: 1 },
    hemi: { sky: 0x6a78c8, ground: 0x2a1a24, intensity: 1.1 },
    sun: { color: 0xc4d2ff, intensity: 2.2, position: [-14, 28, -18] },
    bounce: { color: 0xff7a3a, intensity: 0.35 },
    floor: { style: MOONLIT_FLOOR, roughness: 0.92, metalness: 0.02, emissive: 0 },
    stone: MOONLIT_STONE,
    wall: { color: 0x8a8296, emissive: 0 },
    ground: { color: 0x1a1420 },
    pillar: { style: 'column', color: 0xb9b2c4, stump: 0x8f889a, accent: 0x7fb2ff },
    props: { style: 'stones', color: 0x3c3646, accent: 0x7fb2ff },
    debris: { color: 0x8a8394, emissive: 0 },
    brazier: { bowl: 0x3a3030, flame: [1.0, 0.45, 0.12] },
    fire: {
      root: [1.0, 0.62, 0.18], mid: [0.95, 0.22, 0.05], tip: [0.55, 0.05, 0.12],
      glow: [1.0, 0.38, 0.08], ember: [1, 0.55, 0.15], burn: 0xff7a2a, intensity: 1,
    },
    ambient: { kind: 'none', rate: 0, color: [1, 1, 1], color2: [1, 1, 1] },
  },

  // Twilight enchanted forest glade, green and gold (Broccoli Head's original arena).
  grove: {
    id: 'grove',
    label: 'Twilight Grove',
    background: 0x060c08,
    sky: {
      top: [0.01, 0.025, 0.045],
      mid: [0.05, 0.1, 0.1],
      horizon: [0.45, 0.32, 0.1],
      stars: 0.998,
      starBrightness: 0.7,
      moonDir: [0.55, 0.32, -0.77],
      moonColor: [1.7, 1.6, 0.95],
      moonSize: [0.9989, 0.99935],
      moonGlow: [0.22, 0.2, 0.06],
      moonGlowPower: 30,
      silhouette: { color: [0.004, 0.012, 0.008], height: -0.01, amplitude: 0.075, frequency: 30, jagged: 0.85 },
    },
    fog: { color: 0x0e1a14, density: 1.05 },
    hemi: { sky: 0x5f8494, ground: 0x1c1a10, intensity: 0.75 },
    sun: { color: 0xffc274, intensity: 2.2, position: [24, 20, -26] },
    bounce: { color: 0x9cff6a, intensity: 0.3 },
    floor: {
      style: {
        gap: '#1e2218', stone: [50, 52, 42], stoneRange: 22, grit: [28, 34, 22], gritRange: 46, gritAlpha: 0.25,
        rune: 'rgba(200,235,110,0.6)', glyph: 'rgba(240,220,120,0.75)', mark: 'rgba(255,255,220,0.12)', extras: 'moss',
      },
      roughness: 0.95, metalness: 0, emissive: 0,
    },
    stone: { bg: '#4f5a46', brick: [80, 90, 68], brickRange: 28, grit: [36, 44, 30], gritRange: 50, gritAlpha: 0.25, extras: 'moss' },
    wall: { color: 0x8c9a7c, emissive: 0 },
    ground: { color: 0xa8b894, texture: 'grass', repeat: 40 },
    pillar: { style: 'grove', color: 0xa6b292, stump: 0x7c8a6c, accent: 0xd8f070, trim: 0x1f4a2e },
    props: { style: 'forest', color: 0x3e2e22, accent: 0xc8ff70 },
    debris: { color: 0x6a7458, emissive: 0 },
    brazier: { bowl: 0x3a3a28, flame: [0.5, 1.0, 0.3] },
    fire: {
      root: [0.65, 1.0, 0.5], mid: [0.2, 0.85, 0.28], tip: [0.04, 0.35, 0.22],
      glow: [0.3, 0.95, 0.35], ember: [0.8, 1.0, 0.4], burn: 0x8aff5a, intensity: 0.9,
    },
    ambient: { kind: 'fireflies', rate: 24, color: [0.8, 1.0, 0.3], color2: [1.0, 0.82, 0.3] },
  },

  // Tinubu: basalt over lava under a red ash sky.
  volcano: {
    id: 'volcano',
    layout: 'caldera',
    label: 'Ashen Caldera',
    background: 0x0c0302,
    sky: {
      top: [0.03, 0.006, 0.005],
      mid: [0.16, 0.03, 0.015],
      horizon: [0.75, 0.16, 0.03],
      stars: 1,
      starBrightness: 0,
      moonDir: [0.3, 0.22, -0.92],
      moonColor: [2.2, 0.7, 0.18],
      moonSize: [0.9975, 0.9984],
      moonGlow: [0.4, 0.09, 0.02],
      moonGlowPower: 10,
      clouds: { a: [0.03, 0.008, 0.006], b: [0.55, 0.12, 0.03], strength: 0.85 },
      silhouette: { color: [0.02, 0.006, 0.004], height: 0.025, amplitude: 0.14, frequency: 7, jagged: 0.3 },
    },
    fog: { color: 0x2a0c06, density: 1.15 },
    hemi: { sky: 0xff7a4a, ground: 0x401006, intensity: 0.95 },
    sun: { color: 0xffa070, intensity: 1.7, position: [16, 30, -26] },
    bounce: { color: 0xff5a1a, intensity: 0.9 },
    floor: {
      style: {
        gap: '#d8420a', stone: [30, 25, 24], stoneRange: 16, grit: [10, 8, 8], gritRange: 30, gritAlpha: 0.3,
        rune: 'rgba(255,140,40,0.8)', glyph: 'rgba(255,180,70,0.9)', mark: 'rgba(255,200,150,0.12)', extras: 'lava',
      },
      roughness: 0.85, metalness: 0.05, emissive: 0.75,
    },
    stone: { bg: '#1a1616', brick: [44, 38, 38], brickRange: 18, grit: [10, 10, 10], gritRange: 30, gritAlpha: 0.3, extras: 'veins' },
    wall: { color: 0x6a5a58, emissive: 0.6 },
    ground: { color: 0xffffff, texture: 'lava', repeat: 30, emissive: 1.1 },
    pillar: { style: 'basalt', color: 0x8a7a76, stump: 0x6a5c58, accent: 0xff6a1a },
    props: { style: 'spires', color: 0x2c2626, accent: 0xff5010 },
    debris: { color: 0x3a3030, emissive: 0 },
    brazier: { bowl: 0x2a2222, flame: [1.0, 0.35, 0.06] },
    fire: {
      root: [1.0, 0.8, 0.3], mid: [1.0, 0.32, 0.03], tip: [0.6, 0.05, 0.02],
      glow: [1.0, 0.32, 0.05], ember: [1, 0.45, 0.1], burn: 0xff5a1a, intensity: 1.15,
    },
    ambient: { kind: 'embers', rate: 40, color: [1.0, 0.45, 0.1], color2: [0.32, 0.28, 0.27] },
  },

  // Ice and aurora night, lilac and ice blue (the Agent's original arena).
  glacier: {
    id: 'glacier',
    label: 'Aurora Glacier',
    background: 0x03050c,
    sky: {
      top: [0.006, 0.012, 0.04],
      mid: [0.03, 0.06, 0.14],
      horizon: [0.14, 0.16, 0.32],
      stars: 0.996,
      starBrightness: 1.2,
      moonDir: [-0.3, 0.5, -0.81],
      moonColor: [1.3, 1.4, 1.8],
      moonSize: [0.9988, 0.9993],
      moonGlow: [0.15, 0.18, 0.35],
      moonGlowPower: 50,
      aurora: { a: [0.1, 0.95, 0.6], b: [0.65, 0.3, 1.0], strength: 1 },
      silhouette: { color: [0.02, 0.03, 0.065], height: 0.0, amplitude: 0.09, frequency: 9, jagged: 0.12 },
    },
    fog: { color: 0x0c1428, density: 1 },
    hemi: { sky: 0x7a90d0, ground: 0x283048, intensity: 0.95 },
    sun: { color: 0xc8d8ff, intensity: 2.1, position: [-14, 28, -18] },
    bounce: { color: 0x8ab8ff, intensity: 0.4 },
    floor: {
      style: {
        gap: '#8094b8', stone: [58, 74, 106], stoneRange: 24, grit: [90, 110, 140], gritRange: 50, gritAlpha: 0.2,
        rune: 'rgba(200,150,255,0.8)', glyph: 'rgba(215,180,255,0.9)', mark: 'rgba(255,255,255,0.18)', extras: 'frost',
      },
      roughness: 0.35, metalness: 0.1, emissive: 0.05,
    },
    stone: { bg: '#71809c', brick: [104, 122, 156], brickRange: 26, grit: [150, 166, 196], gritRange: 40, gritAlpha: 0.25, extras: 'frost' },
    wall: { color: 0xaab8d8, emissive: 0 },
    ground: { color: 0xa8b6d2, texture: 'snow', repeat: 30 },
    pillar: { style: 'ice', color: 0x8cbcf0, stump: 0x7aa4d4, accent: 0xc8a0ff },
    props: { style: 'shards', color: 0x7aa8e0, accent: 0xc0cce4 },
    debris: { color: 0xb0d0f0, emissive: 0.1 },
    brazier: { bowl: 0x4a5670, flame: [0.55, 0.8, 1.0] },
    fire: {
      root: [0.9, 0.97, 1.0], mid: [0.35, 0.65, 1.0], tip: [0.45, 0.25, 0.95],
      glow: [0.4, 0.7, 1.0], ember: [0.75, 0.9, 1.0], burn: 0x8ac8ff, intensity: 1,
    },
    ambient: { kind: 'snow', rate: 48, color: [0.92, 0.95, 1.0], color2: [0.8, 0.85, 1.0] },
  },

  // Sahil: sandstone ruins at golden dusk, teal and gold.
  desert: {
    id: 'desert',
    layout: 'bazaar',
    label: 'Sunken Sands',
    background: 0x140a06,
    sky: {
      top: [0.03, 0.05, 0.14],
      mid: [0.32, 0.2, 0.2],
      horizon: [1.0, 0.5, 0.16],
      stars: 0.9985,
      starBrightness: 0.5,
      moonDir: [0.72, 0.1, -0.69],
      moonColor: [3.0, 1.8, 0.7],
      moonSize: [0.9966, 0.9976],
      moonGlow: [0.6, 0.3, 0.08],
      moonGlowPower: 8,
      clouds: { a: [0.5, 0.2, 0.14], b: [1.0, 0.55, 0.22], strength: 0.22 },
      silhouette: { color: [0.16, 0.07, 0.04], height: 0.012, amplitude: 0.06, frequency: 5, jagged: 0.05 },
    },
    fog: { color: 0x2e1a12, density: 0.9 },
    hemi: { sky: 0xc89aa0, ground: 0x3a2010, intensity: 0.75 },
    sun: { color: 0xffa258, intensity: 2.3, position: [27, 15, -26] },
    bounce: { color: 0xff9a40, intensity: 0.4 },
    floor: {
      style: {
        gap: '#5e4028', stone: [136, 102, 66], stoneRange: 24, grit: [120, 90, 60], gritRange: 50, gritAlpha: 0.25,
        rune: 'rgba(50,200,190,0.8)', glyph: 'rgba(235,190,80,0.9)', mark: 'rgba(255,240,200,0.15)', extras: 'sand',
      },
      roughness: 0.95, metalness: 0, emissive: 0,
    },
    stone: { bg: '#9a7a52', brick: [176, 142, 98], brickRange: 30, grit: [120, 90, 60], gritRange: 50, gritAlpha: 0.25, extras: 'sand' },
    wall: { color: 0xd8c0a0, emissive: 0 },
    ground: { color: 0xd8b888, texture: 'sand', repeat: 26 },
    pillar: { style: 'obelisk', color: 0xd8bc94, stump: 0xc8ae86, accent: 0x40e0d0, trim: 0xffc860 },
    props: { style: 'ruins', color: 0xc8a070, accent: 0xd8b07a },
    debris: { color: 0x8a6a48, emissive: 0, shape: 'panel' },
    brazier: { bowl: 0x6a5030, flame: [1.0, 0.75, 0.25] },
    fire: {
      root: [1.0, 0.92, 0.6], mid: [1.0, 0.62, 0.12], tip: [0.65, 0.25, 0.05],
      glow: [1.0, 0.68, 0.18], ember: [1.0, 0.82, 0.35], burn: 0xffb040, intensity: 1,
    },
    ambient: { kind: 'sand', rate: 70, color: [0.86, 0.68, 0.44], color2: [0.95, 0.82, 0.6] },
  },

  // Bitcoin Obama: a floating arena in a cosmic void, purple and green.
  void: {
    id: 'void',
    layout: 'exchange',
    label: 'The Void',
    background: 0x020005,
    sky: {
      top: [0.008, 0.002, 0.02],
      mid: [0.03, 0.008, 0.06],
      horizon: [0.09, 0.03, 0.14],
      stars: 0.995,
      starBrightness: 1.3,
      starsBelowHorizon: true,
      below: [0.004, 0.001, 0.012],
      moonDir: [0.4, 0.35, 0.85],
      moonColor: [1.2, 2.0, 1.3],
      moonSize: [0.9991, 0.99945],
      moonGlow: [0.08, 0.25, 0.12],
      moonGlowPower: 22,
      clouds: { a: [0.35, 0.05, 0.6], b: [0.04, 0.4, 0.24], strength: 1 },
    },
    fog: { color: 0x0e0818, density: 0.8 },
    hemi: { sky: 0x9a6ad8, ground: 0x1c2438, intensity: 1.0 },
    sun: { color: 0xd0b0ff, intensity: 2.0, position: [-14, 28, -18] },
    bounce: { color: 0x60ff9a, intensity: 0.22 },
    floor: {
      style: {
        gap: '#6a2aa0', stone: [24, 20, 32], stoneRange: 14, grit: [10, 8, 16], gritRange: 30, gritAlpha: 0.3,
        rune: 'rgba(120,255,170,0.8)', glyph: 'rgba(200,140,255,0.9)', mark: 'rgba(230,200,255,0.12)', extras: 'void',
      },
      roughness: 0.6, metalness: 0.2, emissive: 0.7,
    },
    stone: { bg: '#1a1424', brick: [40, 34, 54], brickRange: 16, grit: [12, 10, 18], gritRange: 30, gritAlpha: 0.3, extras: 'void' },
    wall: { color: 0x7a6a90, emissive: 0.8 },
    ground: null,
    island: true,
    pillar: { style: 'monolith', color: 0x7a62a0, stump: 0x4a3e5c, accent: 0xb070ff, trim: 0x60ffa0 },
    props: { style: 'asteroids', color: 0x3a3048, accent: 0xb070ff },
    debris: { color: 0x2a2238, emissive: 0.15 },
    brazier: { bowl: 0x2a2238, flame: [0.75, 0.4, 1.0] },
    fire: {
      root: [0.95, 0.65, 1.0], mid: [0.6, 0.15, 0.95], tip: [0.1, 0.55, 0.3],
      glow: [0.6, 0.2, 1.0], ember: [0.7, 0.4, 1.0], burn: 0xb060ff, intensity: 1,
    },
    ambient: { kind: 'motes', rate: 30, color: [0.75, 0.4, 1.0], color2: [0.4, 1.0, 0.6] },
  },
  // Broccoli Head: a Los Angeles intersection at sunset, smog, palms and neon, hot pink and teal.
  city: {
    id: 'city',
    layout: 'streets',
    label: 'Los Angeles',
    background: 0x24102a,
    sky: {
      top: [0.05, 0.025, 0.16],
      mid: [0.4, 0.08, 0.26],
      horizon: [0.72, 0.22, 0.05],
      stars: 0.9993,
      starBrightness: 0.35,
      // Low in the +x sky, where the sunset panorama (sky.jpg) puts its sun.
      moonDir: [0.95, 0.11, -0.28],
      moonColor: [3.0, 1.4, 0.55],
      moonSize: [0.9962, 0.9973],
      moonGlow: [0.7, 0.2, 0.06],
      moonGlowPower: 7,
      clouds: { a: [0.3, 0.06, 0.18], b: [0.72, 0.22, 0.12], strength: 0.5 },
      smog: { color: [0.62, 0.24, 0.16], strength: 0.5, height: 0.09 },
      skyline: { color: [0.07, 0.03, 0.09], window: [1.6, 0.85, 0.42], height: -0.004, amplitude: 0.08, density: 150, palms: 26 },
    },
    fog: { color: 0x5a2c4a, density: 0.9 },
    hemi: { sky: 0xc07aa8, ground: 0x3a2228, intensity: 0.95 },
    sun: { color: 0xffa070, intensity: 2.3, position: [28, 11, -8] },
    bounce: { color: 0x30e8d8, intensity: 0.55 },
    floor: {
      style: {
        pattern: 'plaza',
        gap: '#7e7a74', stone: [52, 50, 52], stoneRange: 14, grit: [30, 28, 30], gritRange: 50, gritAlpha: 0.3,
        rune: 'rgba(236,230,214,0.88)', glyph: 'rgba(236,196,60,0.85)', mark: 'rgba(255,90,170,0.7)',
      },
      roughness: 0.85, metalness: 0.02, emissive: 0,
    },
    stone: { bg: '#8a8680', brick: [128, 124, 120], brickRange: 8, grit: [70, 66, 64], gritRange: 40, gritAlpha: 0.3, extras: 'graffiti' },
    wall: { color: 0x9a8c96, emissive: 0 },
    ground: { color: 0xb4a8b0, texture: 'asphalt', repeat: 40 },
    pillar: { style: 'freeway', color: 0xb0a8a6, stump: 0x8e8884, accent: 0xff3ca0, trim: 0x30e8d8 },
    props: { style: 'city', color: 0x2a1e2e, accent: 0xff3ca0 },
    debris: { color: 0x8e8884, emissive: 0 },
    brazier: { bowl: 0x2c2c34, flame: [1.0, 0.3, 0.62] },
    fire: {
      root: [1.0, 0.78, 0.6], mid: [1.0, 0.22, 0.55], tip: [0.5, 0.08, 0.85],
      glow: [1.0, 0.28, 0.58], ember: [1.0, 0.55, 0.3], burn: 0xff4aa0, intensity: 1.05,
    },
    ambient: { kind: 'vape', rate: 7, color: [1.0, 0.62, 0.88], color2: [0.6, 1.0, 0.9] },
  },

  // Glowie: an open-plan government office under fluorescent tubes, with a green glow.
  office: {
    id: 'office',
    label: 'Government Office',
    background: 0x2a302c,
    layout: 'cubicles',
    interior: true,
    sky: {
      // Indoors: the room and ceiling hide the sky; keep it a dim neutral with no stars or sun.
      top: [0.16, 0.18, 0.16],
      mid: [0.2, 0.22, 0.2],
      horizon: [0.26, 0.28, 0.25],
      stars: 1,
      starBrightness: 0,
      moonDir: [0, 1, 0],
      moonColor: [0, 0, 0],
      moonSize: [0.999, 0.9995],
      moonGlow: [0, 0, 0],
      moonGlowPower: 1,
    },
    fog: { color: 0x4a544c, density: 1.1 },
    hemi: { sky: 0xd8ead8, ground: 0x4a5250, intensity: 0.75 },
    // Overhead fluorescent "key": nearly straight down, cool white with a green cast.
    sun: { color: 0xeefff2, intensity: 1.25, position: [-5, 30, -9] },
    bounce: { color: 0x58ff96, intensity: 0.3 },
    floor: {
      style: {
        pattern: 'carpet',
        gap: '#3e4652', stone: [70, 80, 96], stoneRange: 10, grit: [40, 46, 56], gritRange: 40, gritAlpha: 0.25,
        rune: 'rgba(90,255,150,0.85)', glyph: 'rgba(214,214,200,0.85)', mark: 'rgba(240,200,40,0.85)',
      },
      roughness: 0.97, metalness: 0, emissive: 0.06,
    },
    stone: { bg: '#d6c8a4', brick: [214, 200, 164], brickRange: 4, grit: [150, 140, 116], gritRange: 30, gritAlpha: 0.15, extras: 'office' },
    wall: { color: 0xe8e0d4, emissive: 0 },
    ground: { color: 0xa8b0bc, texture: 'carpet', repeat: 120 },
    pillar: { style: 'cubicle', color: 0x8a9098, stump: 0x6e737a, accent: 0x58ff96, trim: 0xb8bcc2 },
    props: { style: 'office', color: 0x8c8a7c, accent: 0x58ff96 },
    debris: { color: 0x7d838c, emissive: 0, shape: 'panel' },
    brazier: { bowl: 0x55585c, flame: [1.0, 0.5, 0.14] },
    fire: {
      root: [1.0, 0.62, 0.22], mid: [0.92, 0.3, 0.05], tip: [0.3, 0.08, 0.04],
      glow: [1.0, 0.48, 0.12], ember: [1.0, 0.7, 0.3], burn: 0xff8a2a, intensity: 1.0,
    },
    ambient: { kind: 'dust', rate: 26, color: [0.92, 0.96, 0.88], color2: [0.75, 1.0, 0.8] },
  },
};
