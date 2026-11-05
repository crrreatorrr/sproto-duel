import { SPROTO_STAFF, STAFF_IDS, staffCard, type StaffId } from '../staff/catalog';

/** One staff the title screen's Wizard Sproto holds up, and whether it shows as a locked silhouette. */
export interface TitleStaff {
  id: StaffId;
  name: string;
  /** One line under the name (the Staff Rack's). */
  line: string;
  /** CSS colour for the name and the glow behind the wizard. */
  accent: string;
  locked: boolean;
}

/**
 * Which staffs the title screen cycles through. Read-only: it never equips or grants anything.
 *
 * - A hub session: the staffs the player owns (`getOwnedStaffs`), none locked.
 * - No session: every staff in catalog order, so the title still shows the whole set. The ones the
 *   player doesn't own (by the local loadout cache) are locked silhouettes. The starter Sproto
 *   Staff is always owned, so it is never locked.
 *
 * The cycle starts at `start` (the equipped staff) when it is in the list.
 */
export function titleStaffCycle(signedIn: boolean, owned: readonly StaffId[], start?: StaffId): TitleStaff[] {
  const have = new Set<StaffId>([SPROTO_STAFF, ...owned]);
  const ids = signedIn ? STAFF_IDS.filter((id) => have.has(id)) : [...STAFF_IDS];
  const list = ids.map((id): TitleStaff => {
    const card = staffCard(id);
    return { id, name: card.name, line: card.line, accent: card.accent, locked: !have.has(id) };
  });
  const at = start ? list.findIndex((s) => s.id === start) : -1;
  return at > 0 ? [...list.slice(at), ...list.slice(0, at)] : list;
}
