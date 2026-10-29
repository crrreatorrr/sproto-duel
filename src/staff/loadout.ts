import { SPROTO_STAFF, isStaffId, staffName, type StaffId } from './catalog';

/**
 * Offline stand-in for the hub session loadout.
 *
 * Ownership and the equipped staff are read here, and only here. Sproto is always owned.
 * M3 can later swap this module for the server `loadout/sproto` RPC without touching the
 * rack or the gameplay. Do not add hub SDK, Ticket or RPC calls in this file.
 */
export const LOADOUT_STORAGE_KEY = 'arcane-duel-loadout';

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

/** Staffs the player owns. Sproto is always included. Unknown ids are ignored. */
export function getOwnedStaffs(): StaffId[] {
  const save = read();
  const owned: StaffId[] = [SPROTO_STAFF];
  for (const id of save.owned) {
    if (id === SPROTO_STAFF) continue;
    if (isStaffId(id) && !owned.includes(id)) owned.push(id);
    else warnUnknown(id);
  }
  return owned;
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

/** Persist a new staff. Returns false when it is unknown or not owned (the save is unchanged). */
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
