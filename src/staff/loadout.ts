import { SPROTO_STAFF, STAFF_IDS, isStaffId, staffName, type StaffId } from './catalog';

/**
 * The only place Sproto Duel reads which staffs are owned and which one is equipped.
 *
 * A hub visit passes the relic ids `init` already returned (`setSessionRelics`). Ownership is
 * the starter staff plus the staff for each relic that unlocks one in this game. Tinubu's Crown
 * is earned here and unlocks nothing. With no session, the local `arcane-duel-loadout` cache is
 * the fallback (starter only when that cache is empty).
 *
 * Equipping writes that cache's staff slot. It does not grant a Relic, change Tickets, touch the
 * campaign save, or post a score. Server loadout and `equip_change` come later. Do not add hub
 * SDK, Ticket or RPC calls in this file.
 */
export const LOADOUT_STORAGE_KEY = 'arcane-duel-loadout';

/**
 * Relic → staff in this game. One staff slot, so these never stack.
 * Absent on purpose: `tinubu_crown` (earned in Duel).
 */
const STAFF_BY_RELIC: Readonly<Record<string, StaffId>> = {
  hpos10i_core: 'duel_staff_momentum',
  genesis_shard: 'duel_staff_moonward',
  cones_tip: 'duel_staff_nobu',
};

/** Relics from the current hub init, or null when this visit has no session. */
let sessionRelics: readonly string[] | null = null;

export interface StaffLoadout {
  staff: StaffId;
  owned: StaffId[];
  /** Name or id of a saved staff that was not owned or not known, cleared back to Sproto. */
  replaced: string | null;
}

interface Save {
  v: 1;
  game: 'sproto';
  slots: { staff: string };
  owned: string[];
  seq: number;
  updated_at: string;
  cachedAt: number;
}

const warned = new Set<string>();

function warnUnknown(id: string): void {
  if (!id || warned.has(id)) return;
  warned.add(id);
  console.warn(`[staff] unknown item id ${id}`);
}

function fresh(): Save {
  return {
    v: 1,
    game: 'sproto',
    slots: { staff: SPROTO_STAFF },
    owned: [SPROTO_STAFF],
    seq: 0,
    updated_at: new Date(0).toISOString(),
    cachedAt: 0,
  };
}

function read(): Save {
  try {
    const raw = localStorage.getItem(LOADOUT_STORAGE_KEY);
    if (!raw) return fresh();
    const parsed = JSON.parse(raw) as Partial<Save>;
    return {
      v: 1,
      game: 'sproto',
      slots: { staff: typeof parsed.slots?.staff === 'string' ? parsed.slots.staff : SPROTO_STAFF },
      owned: Array.isArray(parsed.owned) ? parsed.owned.filter((id): id is string => typeof id === 'string') : [],
      seq: typeof parsed.seq === 'number' && Number.isFinite(parsed.seq) ? parsed.seq : 0,
      updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : new Date(0).toISOString(),
      cachedAt: typeof parsed.cachedAt === 'number' ? parsed.cachedAt : 0,
    };
  } catch {
    return fresh();
  }
}

function write(save: Save): void {
  try {
    localStorage.setItem(LOADOUT_STORAGE_KEY, JSON.stringify(save));
  } catch {
    // Private mode and full disks: the rack still works for this session.
  }
}

/**
 * Remember relic ids the hub init result already contained.
 * Null means there is no hub session, so ownership falls back to the local cache.
 * This stores a snapshot for `getOwnedStaffs` and refreshes that cache's owned list.
 * It does not write Relics, Tickets, beaten flags, or leaderboards.
 */
export function setSessionRelics(relics: readonly string[] | null): void {
  sessionRelics = relics === null ? null : relics.slice();
  if (sessionRelics === null) return;
  const save = read();
  const owned = staffsForRelics(sessionRelics);
  if (sameIds(save.owned, owned)) return;
  write({ ...save, owned, cachedAt: Date.now() });
}

/**
 * Staffs the player owns. Sproto is always included.
 * An empty relic list (a hub visit that owns none) is not the local cache: only a null session is.
 */
export function getOwnedStaffs(): StaffId[] {
  if (sessionRelics !== null) return staffsForRelics(sessionRelics);
  return staffsFromCache();
}

/** Starter, plus one staff per relic that unlocks one here. Stable catalog order. */
function staffsForRelics(relics: readonly string[]): StaffId[] {
  const unlocked = new Set<StaffId>();
  for (const relic of relics) {
    const staff = STAFF_BY_RELIC[relic];
    if (staff) unlocked.add(staff);
  }
  return STAFF_IDS.filter((id) => id === SPROTO_STAFF || unlocked.has(id));
}

/** Local fallback. Unknown ids are ignored. Sproto is always included. */
function staffsFromCache(): StaffId[] {
  const save = read();
  const owned: StaffId[] = [SPROTO_STAFF];
  for (const id of save.owned) {
    if (id === SPROTO_STAFF) continue;
    if (isStaffId(id) && !owned.includes(id)) owned.push(id);
    else warnUnknown(id);
  }
  return owned;
}

function sameIds(saved: readonly string[], owned: readonly StaffId[]): boolean {
  if (saved.length !== owned.length) return false;
  const seen = new Set(saved);
  if (seen.size !== saved.length) return false;
  return owned.every((id) => seen.has(id));
}

/**
 * The equipped staff, checked against what is owned. A missing, unknown or unowned id
 * falls back to Sproto and the corrected save is written.
 */
export function getLoadout(): StaffLoadout {
  const save = read();
  const owned = getOwnedStaffs();
  const saved = save.slots.staff;
  let staff: StaffId = SPROTO_STAFF;
  let replaced: string | null = null;
  if (!saved || saved === SPROTO_STAFF) {
    staff = SPROTO_STAFF;
  } else if (!isStaffId(saved)) {
    warnUnknown(saved);
    replaced = saved;
  } else if (!owned.includes(saved)) {
    replaced = staffName(saved);
  } else {
    staff = saved;
  }
  if (replaced) {
    write({ ...save, slots: { staff: SPROTO_STAFF }, owned, cachedAt: Date.now() });
  }
  return { staff, owned, replaced };
}

/**
 * Persist the one equipped staff. Returns false when it is unknown or not owned (the save is unchanged).
 * One slot: the previous staff is replaced. This does not grant ownership.
 */
export function setSelectedStaff(id: string): boolean {
  if (!isStaffId(id)) {
    warnUnknown(id);
    return false;
  }
  const owned = getOwnedStaffs();
  if (!owned.includes(id)) return false;
  const save = read();
  write({
    ...save,
    slots: { staff: id },
    owned,
    seq: save.seq + 1,
    updated_at: new Date().toISOString(),
    cachedAt: Date.now(),
  });
  return true;
}
