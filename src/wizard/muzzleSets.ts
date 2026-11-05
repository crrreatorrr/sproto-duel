/**
 * Muzzle data that needs no three.js (types and the set builders), so the boss table in
 * src/campaign/levels.ts can be read by the deterministic sim (src/sim-core). See muzzles.ts.
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

