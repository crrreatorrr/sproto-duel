import { CONFIG } from '../config';

/**
 * Sproto Duel staffs (M3). Gameplay numbers live in `CONFIG.staffs` (the dev console exposes
 * CONFIG). Colours are the 3D delivery (`staffs.json` vfx).
 *
 * The character attaches the LOD1 mesh (`staff_<name>-lod1.glb`). This game has no distance LOD;
 * LOD1 is the mesh the socketed wizard was authored with, and together with the empty rig it stays
 * under the 10k triangle budget. The full `staff_<name>.glb` files sit beside it for a later close-up.
 */
export type StaffId = 'duel_staff_sproto' | 'duel_staff_momentum' | 'duel_staff_moonward' | 'duel_staff_nobu';

export const STAFF_IDS: readonly StaffId[] = [
  'duel_staff_sproto',
  'duel_staff_momentum',
  'duel_staff_moonward',
  'duel_staff_nobu',
];

export const SPROTO_STAFF: StaffId = 'duel_staff_sproto';

const SLUG: Record<StaffId, 'sproto' | 'momentum' | 'moonward' | 'nobu'> = {
  duel_staff_sproto: 'sproto',
  duel_staff_momentum: 'momentum',
  duel_staff_moonward: 'moonward',
  duel_staff_nobu: 'nobu',
};

export interface StaffPulse {
  material: string;
  min: number;
  max: number;
  hz: number;
  onCast: number;
  onBlink?: number;
}

export interface StaffBlink {
  dist: number;
  travel: number;
  iframes: number;
  cooldown: number;
  trailDps: number;
  trailTime: number;
  trailWidth: number;
}

/** What the player is holding. Gameplay fields are the starter values while ranked. */
export interface EquippedStaff {
  id: StaffId;
  name: string;
  /** One line under the name on the Staff Rack. */
  line: string;
  slug: string;
  clip: string;
  boltDamageMult: number;
  /** Null: use CONFIG.spells.bolt.knockback. */
  boltKnockback: number | null;
  boltLabel: string;
  blink: StaffBlink | null;
  boltColor: number;
  trailColor: number;
  accent: string;
  boltCss: string;
  pulse: StaffPulse | null;
}

export interface StaffCard {
  id: StaffId;
  name: string;
  line: string;
  accent: string;
  bolt: string;
}

export const cssHex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

export function isStaffId(id: string): id is StaffId {
  return (STAFF_IDS as readonly string[]).includes(id);
}

export function staffSlug(id: StaffId): string {
  return SLUG[id];
}

/** LOD1 prop, relative to `public/assets/`. Loaded through `import.meta.env.BASE_URL`. */
export function staffModelPath(id: StaffId): string {
  return `models/staffs/staff_${SLUG[id]}-lod1.glb`;
}

export function staffName(id: StaffId): string {
  return CONFIG.staffs[SLUG[id]].name;
}

export function staffLine(id: StaffId): string {
  const s = CONFIG.staffs;
  const damage = CONFIG.spells.bolt.damage;
  switch (id) {
    case 'duel_staff_sproto':
      return 'Stock bolt';
    case 'duel_staff_momentum':
      return `Blink Dash ${s.momentum.blink.dist} m`;
    case 'duel_staff_moonward':
      return `COOM Bolt · damage ${damage * s.moonward.boltDamageMult}`;
    case 'duel_staff_nobu':
      return `Bark Bolt · knockback ${s.nobu.boltKnockback}`;
  }
}

export function staffCard(id: StaffId): StaffCard {
  const def = CONFIG.staffs[SLUG[id]];
  return { id, name: def.name, line: staffLine(id), accent: cssHex(def.accent), bolt: cssHex(def.bolt) };
}

/**
 * Resolve the equipped staff. `ranked` strips gameplay (starter bolt, no blink) and keeps the mesh
 * and the bolt, trail and accent colours.
 */
export function equipStaff(id: StaffId, ranked: boolean): EquippedStaff {
  const slug = SLUG[id];
  const def = CONFIG.staffs[slug];
  const blink = !ranked && 'blink' in def ? def.blink : null;
  const mult = !ranked && 'boltDamageMult' in def ? def.boltDamageMult : 1;
  const knock = !ranked && 'boltKnockback' in def ? def.boltKnockback : null;
  const label = ranked ? 'Bolt' : 'boltLabel' in def ? def.boltLabel : 'Bolt';
  return {
    id,
    name: def.name,
    line: staffLine(id),
    slug,
    clip: `staff_${slug}_idle`,
    boltDamageMult: mult,
    boltKnockback: knock,
    boltLabel: label,
    blink,
    boltColor: def.bolt,
    trailColor: def.trail,
    accent: cssHex(def.accent),
    boltCss: cssHex(def.bolt),
    pulse: def.pulse,
  };
}
