import type { DeviceBinding } from './IntentSource';

/**
 * Local Versus device split. One pad: P1 keyboard + mouse, P2 that pad. Two or more: P1 keyboard +
 * mouse plus the first pad, P2 the next one. No pad: null (Versus needs one). `padIndices` are the
 * connected standard pads' indices; `p2Pad` (optional) is the pad that pressed to join, which then
 * becomes P2's whatever its index. Without keyboard + mouse (`kbmPresent` false) P1 needs a pad of
 * its own, so two pads are required.
 */
export function assignDevices(padIndices: readonly number[], kbmPresent: boolean, p2Pad?: number): [DeviceBinding, DeviceBinding] | null {
  const pads = [...new Set(padIndices)].filter((i) => Number.isInteger(i) && i >= 0).sort((a, b) => a - b);
  if (pads.length === 0) return null;
  const p2 = p2Pad !== undefined && pads.includes(p2Pad) ? p2Pad : pads.length === 1 ? pads[0] : pads[1];
  const rest = pads.filter((i) => i !== p2);
  if (!kbmPresent && rest.length === 0) return null;
  const p1: DeviceBinding = { keyboardMouse: kbmPresent, pad: rest.length ? rest[0] : null };
  return [p1, { keyboardMouse: false, pad: p2 }];
}
