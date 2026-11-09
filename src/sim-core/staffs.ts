/**
 * Staff gameplay in the sim (src/staff/catalog.ts and CONFIG.staffs). Ids are the hub item ids.
 * `duel_staff_fighters_might` (Fist Bolt: 2x bolt damage, 1.85x fire interval) is defined here for
 * the hub's loadout even though the game's Staff Rack has no mesh for it yet.
 * `duel_staff_alien_ray` (Alien Ray: 3x bolt damage, stock fire rate) comes from Sproto Arcade's Breakwater Coin.
 */
import { CONFIG } from '../config';
import { ONE, fx, sec } from './fixed';
import type { StaffStats } from './wizard';

const S = CONFIG.staffs;
const B = S.momentum.blink;

export const STAFFS: Readonly<Record<string, StaffStats>> = {
  duel_staff_sproto: { id: 'duel_staff_sproto', boltDamage: ONE, boltInterval: ONE, boltKnockback: -1, blink: null },
  duel_staff_momentum: {
    id: 'duel_staff_momentum', boltDamage: ONE, boltInterval: ONE, boltKnockback: -1,
    blink: { dist: fx(B.dist), travel: sec(B.travel), iframes: sec(B.iframes), cooldown: sec(B.cooldown), trailDps: fx(B.trailDps), trailTime: sec(B.trailTime), trailWidth: fx(B.trailWidth) },
  },
  duel_staff_moonward: { id: 'duel_staff_moonward', boltDamage: fx(S.moonward.boltDamageMult), boltInterval: ONE, boltKnockback: -1, blink: null },
  duel_staff_nobu: { id: 'duel_staff_nobu', boltDamage: ONE, boltInterval: ONE, boltKnockback: fx(S.nobu.boltKnockback), blink: null },
  duel_staff_fighters_might: { id: 'duel_staff_fighters_might', boltDamage: fx(2), boltInterval: fx(1.85), boltKnockback: -1, blink: null },
  duel_staff_alien_ray: { id: 'duel_staff_alien_ray', boltDamage: fx(S.alien_ray.boltDamageMult), boltInterval: ONE, boltKnockback: -1, blink: null },
};

export const STAFF_IDS = Object.keys(STAFFS);

export function staffStats(id: string | null | undefined): StaffStats | null {
  if (!id) return null;
  return Object.prototype.hasOwnProperty.call(STAFFS, id) ? STAFFS[id] : null;
}
