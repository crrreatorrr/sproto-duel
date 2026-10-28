import * as THREE from 'three';
import type { PlaceholderVariant } from './WizardVisual';

/**
 * Muzzles: where each caster's spells come out (the staff orb, a phone, the vape's mouthpiece, a
 * gun barrel, Tinubu's palm and mouth) and which effect plays there (src/fx/MuzzleFx.ts).
 *
 * Boss stage muzzles live with the stages (levels.ts `BossStage.muzzle`), the player's on its model
 * entry (manifest.ts `ModelAsset.muzzle`), found per GLB by campaign/muzzleIndex.ts; the primitive
 * placeholders' are below. A look without any (an unknown GLB) casts from the old generic wand
 * offset (Wizard.castPoint).
 */

/** The thing a spell leaves from, which picks its effects. */
export type MuzzleType = 'staff' | 'phone' | 'vape' | 'gun' | 'hand' | 'mouth';

/** What is being cast: a volley's shots and a held bolt may use different muzzles (Tinubu). */
export type CastKind = 'bolt' | 'volley' | 'blast' | 'stun' | 'ultimate';

export const CAST_KINDS: readonly CastKind[] = ['bolt', 'volley', 'blast', 'stun', 'ultimate'];

/** [forward, up, right] (see MuzzlePoint.at). */
export type MuzzleCoords = readonly [number, number, number];

export interface MuzzlePoint {
  type: MuzzleType;
  /**
   * Position as [forward, up, right] fractions of the model's height, measured from the centre of
   * its feet (the 12 % lowest vertices, like the loader's anchor 'feet'), as the character faces in
   * game. Multiplied by the model's fitHeight. A placeholder's are in meters (height 1).
   */
  at: MuzzleCoords;
  /** Effect scale: the vape's size per stage, a gun's calibre. Default 1. */
  size?: number;
  /** The model's hand is empty here: draw a small code-built prop (a phone in a fist). */
  prop?: boolean;
}

export interface MuzzleSet {
  /** Named points on the model. */
  points: Readonly<Record<string, MuzzlePoint>>;
  /**
   * Which point(s) each kind of cast leaves from. Projectiles alternate through a list shot by shot
   * (two phones); the Ultimate flares at every point in its list. A kind not listed uses `bolt`'s,
   * and `bolt` defaults to every point.
   */
  use?: Partial<Record<CastKind, readonly string[]>>;
}

/** One point in the look's frame: meters, feet at the origin, +Z forward, +X the model's left. */
export interface ResolvedMuzzle {
  name: string;
  type: MuzzleType;
  local: THREE.Vector3;
  size: number;
  prop: boolean;
}

export interface ResolvedMuzzles {
  points: ResolvedMuzzle[];
  /** Indices into `points` per cast kind (never empty). */
  use: Record<CastKind, number[]>;
}

/** A point at `at` ([forward, up, right]) on a look `height` tall, scaled by `scale`, in the look's frame. */
export function muzzleLocal(at: MuzzleCoords, height: number, scale: number, out: THREE.Vector3): THREE.Vector3 {
  const k = height * scale;
  return out.set(-at[2] * k, at[1] * k, at[0] * k);
}

/** Resolve a set for a look `height` m tall (fitHeight; 1 for placeholder sets in meters), scaled by `scale`. */
export function resolveMuzzles(set: MuzzleSet, height: number, scale = 1): ResolvedMuzzles {
  const names = Object.keys(set.points);
  const points = names.map<ResolvedMuzzle>((name) => {
    const p = set.points[name];
    return { name, type: p.type, local: muzzleLocal(p.at, height, scale, new THREE.Vector3()), size: p.size ?? 1, prop: !!p.prop };
  });
  const indices = (list: readonly string[] | undefined) =>
    (list ?? []).map((n) => names.indexOf(n)).filter((i) => i >= 0);
  const all = points.map((_, i) => i);
  const bolt = indices(set.use?.bolt);
  const use = {} as Record<CastKind, number[]>;
  for (const kind of CAST_KINDS) {
    const own = indices(set.use?.[kind]);
    use[kind] = own.length ? own : bolt.length ? bolt : all;
  }
  return { points, use };
}

// ------------------------------------------------------------ set builders

/** A staff: everything leaves from its orb or gem. */
export const staffMuzzle = (at: MuzzleCoords, size = 1): MuzzleSet => ({ points: { staff: { type: 'staff', at, size } } });

/** One phone. */
export const phoneMuzzle = (at: MuzzleCoords, prop = false): MuzzleSet => ({ points: { phone: { type: 'phone', at, prop } } });

/** A phone in each hand: shots alternate right, left. */
export const twoPhones = (right: MuzzleCoords, left: MuzzleCoords, prop = false): MuzzleSet => ({
  points: { phoneR: { type: 'phone', at: right, prop }, phoneL: { type: 'phone', at: left, prop } },
});

/** A vape: `size` scales the puffs (pen, box mod, cannon). */
export const vapeMuzzle = (at: MuzzleCoords, size: number): MuzzleSet => ({ points: { vape: { type: 'vape', at, size } } });

/** A gun barrel: `size` scales the flash (pistol, SMG, minigun). */
export const gunMuzzle = (at: MuzzleCoords, size: number): MuzzleSet => ({ points: { gun: { type: 'gun', at, size } } });

/** Tinubu: bolts and stuns from the hand, blasts and volleys from the mouth, the Ultimate from both. */
export const handAndMouth = (hand: MuzzleCoords, mouth: MuzzleCoords, size = 1): MuzzleSet => ({
  points: { hand: { type: 'hand', at: hand, size }, mouth: { type: 'mouth', at: mouth, size } },
  use: { bolt: ['hand'], stun: ['hand'], blast: ['mouth'], volley: ['mouth'], ultimate: ['hand', 'mouth'] },
});

// ------------------------------------------------------------ placeholders

/**
 * The primitive placeholders' props (WizardVisual builds them in the right hand): meters at the
 * standard build, before a short boss's scale-down. The hand sits at about (-0.34, 1.37, 0.46).
 */
export const PLACEHOLDER_MUZZLES: Record<PlaceholderVariant, MuzzleSet> = {
  wizard: staffMuzzle([0.44, 1.8, 0.34]),
  sahil: staffMuzzle([0.44, 1.8, 0.34]),
  obama: phoneMuzzle([0.485, 1.43, 0.34]),
  midget: phoneMuzzle([0.485, 1.43, 0.34]),
  broccoli: vapeMuzzle([0.46, 1.5, 0.34], 1),
  agent: gunMuzzle([0.7, 1.39, 0.34], 0.8),
  tinubu: handAndMouth([0.52, 1.38, 0.34], [0.2, 1.53, 0]),
};
