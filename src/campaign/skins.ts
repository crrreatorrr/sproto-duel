/**
 * Character skins: the player's look, cosmetic only. Wizard Sproto is always available; beating a
 * boss in the Boss Gauntlet (a saved win) unlocks that boss's stage-1 look (the double fight unlocks
 * both Bitcoin Obama and The Midget). God mode unlocks every skin for the session, like the reward
 * spells. A skin never changes stats: the hitbox, health, speed, muzzles and staff stats stay the
 * player's, and the look is scaled to the player's height.
 */
import { MODELS, type ModelKey } from '../assets/manifest';
import { BOSSES, bossDisplayName, bossFighters } from './levels';

export interface SkinDef {
  /** 'sproto' or a boss fighter id. */
  id: string;
  name: string;
  model: ModelKey;
  /** The fight that unlocks it ('' for Sproto). */
  unlockedBy: string;
  /** Accent for the menu's pick (the boss's spell colour). */
  accent: string;
}

export const DEFAULT_SKIN = 'sproto';
export const SKIN_STORAGE_KEY = 'arcane-duel-skin';

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

export const SKINS: readonly SkinDef[] = [
  { id: DEFAULT_SKIN, name: 'Wizard Sproto', model: 'wizardPlayer', unlockedBy: '', accent: '#8fb4ff' },
  ...BOSSES.flatMap((b) => bossFighters(b).map((f) => ({ id: f.id, name: f.name, model: f.stages[0].model, unlockedBy: bossDisplayName(b), accent: hex(f.palette.spell) }))),
];

export function skinDef(id: string): SkinDef | null {
  return SKINS.find((s) => s.id === id) ?? null;
}

/** Every fighter id a fight's win unlocks. */
export const SKIN_IDS: readonly string[] = SKINS.map((s) => s.id);

/** The skin's height on the player: its look is scaled by this so it matches the player's hitbox. */
export function skinScale(skin: SkinDef): number {
  const fit = MODELS[skin.model].fitHeight ?? MODELS.wizardPlayer.fitHeight;
  return MODELS.wizardPlayer.fitHeight / fit;
}

/** The saved choice (it may since have become locked: App falls back to Sproto). */
export function getSelectedSkin(): string {
  try {
    const id = localStorage.getItem(SKIN_STORAGE_KEY);
    if (id && skinDef(id)) return id;
  } catch {
    // Storage blocked: the default.
  }
  return DEFAULT_SKIN;
}

export function setSelectedSkin(id: string): boolean {
  if (!skinDef(id)) return false;
  try {
    localStorage.setItem(SKIN_STORAGE_KEY, id);
  } catch {
    // Storage blocked: this session only (App keeps the choice applied).
  }
  return true;
}
