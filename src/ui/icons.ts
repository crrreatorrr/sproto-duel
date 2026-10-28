import { resolveImage } from '../assets/AssetLoader';
import { UI_ICONS } from '../assets/manifest';
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
