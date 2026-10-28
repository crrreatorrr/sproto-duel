/**
 * Arena environment themes. 'moonlit' is the default (quick duel); each campaign boss has its own.
 * Visual definitions live with the arena code; asset paths live in assets/manifest.ts (THEME_ASSETS).
 */
export const THEME_IDS = ['moonlit', 'grove', 'volcano', 'glacier', 'desert', 'void'] as const;
export type ArenaThemeId = (typeof THEME_IDS)[number];
