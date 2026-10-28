import { resolveImage } from '../assets/AssetLoader';
import { UI_ICONS } from '../assets/manifest';
import { REWARD_SPELL_INFO, type RewardSpellId } from '../spells/rewardCatalog';
import type { SpellId } from '../spells/types';

/** Built-in SVG glyphs, used when no generated icon exists in public/assets/ui/. */
const GLYPHS: Record<SpellId, string> = {
  bolt: '<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>',
  blast: '<circle cx="12" cy="12" r="5"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4M4.2 4.2l2.8 2.8M17 17l2.8 2.8M4.2 19.8 7 17M17 7l2.8-2.8" stroke-width="2" stroke="currentColor" fill="none"/>',
  shield: '<path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z"/>',
  stun: '<path d="M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7M9 3.5l3 2.5 3-2.5M9 20.5l3-2.5 3 2.5" stroke-width="2" stroke="currentColor" fill="none" stroke-linecap="round"/>',
  ultimate: '<path d="m12 1 2.6 7.4L22 9l-5.8 4.8L18 22l-6-4.4L6 22l1.8-8.2L2 9l7.4-.6z"/>',
};

export function spellIcon(spell: SpellId): string {
  const url = resolveImage(UI_ICONS[spell]);
  if (url) return `<img src="${url}" alt="" draggable="false">`;
  return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${GLYPHS[spell]}</svg>`;
}

/** Fallback glyphs for the boss reward spells (their generated icons live in ui/spells/). */
const REWARD_GLYPHS: Record<RewardSpellId, string> = {
  carpet: '<path d="M3 9c3-2 6 2 9 0s6-2 9 0v6c-3-2-6 2-9 0s-6-2-9 0z"/>',
  pump: '<path d="M3 19 9 12l4 3 7-9" stroke-width="2.4" stroke="currentColor" fill="none" stroke-linecap="round"/><path d="m15 5 6 0 0 6z"/>',
  vape: '<circle cx="8" cy="13" r="5"/><circle cx="15" cy="10" r="6"/><circle cx="17" cy="16" r="4"/>',
  lockon: '<circle cx="12" cy="12" r="7" stroke-width="2" stroke="currentColor" fill="none"/><path d="M12 1v6M12 17v6M1 12h6M17 12h6" stroke-width="2" stroke="currentColor"/>',
  breath: '<path d="M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-6 0 3 1 4 2 4 0-4-1-6 1-10z"/>',
};

/** A reward spell's icon: the generated PNG, or a built-in glyph. */
export function rewardIcon(id: RewardSpellId): string {
  const url = resolveImage(REWARD_SPELL_INFO[id].icon);
  if (url) return `<img src="${url}" alt="" draggable="false">`;
  return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${REWARD_GLYPHS[id]}</svg>`;
}
