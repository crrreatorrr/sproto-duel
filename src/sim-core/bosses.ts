/**
 * The story bosses as the sim sees them (src/campaign/levels.ts BOSSES): hub ids, arenas, and per
 * stage the hurtbox, muzzles, damage and health in sim units.
 *
 * Hub story-boss ids: sahil, obama, broccoli, agent, tinubu. `obama` is the double fight with
 * The Midget (levels.ts `partner`); beating both is one `obama` defeat.
 */
import { CONFIG } from '../config';
import { MODELS } from '../assets/manifest';
import { BOSSES, type BossDef, type BossFighter, type BossPartner } from '../campaign/levels';
import type { ArenaId } from './arena';
import { ONE, fx, max, mul } from './fixed';
import type { MuzzleSet } from './wizard';
import { muzzleSet } from './muzzles';

const C = CONFIG.campaign;
const W = CONFIG.wizard;

export const BOSS_IDS = ['sahil', 'obama', 'broccoli', 'agent', 'tinubu'] as const;
export type BossId = (typeof BOSS_IDS)[number];

export function isBossId(x: unknown): x is BossId {
  return typeof x === 'string' && (BOSS_IDS as readonly string[]).indexOf(x) >= 0;
}

export function bossDef(id: string): BossDef | null {
  for (let i = 0; i < BOSSES.length; i++) if (BOSSES[i].id === id) return BOSSES[i];
  return null;
}

/** The arena a boss fight is played in (its theme). */
export function bossArena(id: string): ArenaId {
  const b = bossDef(id);
  return (b ? b.theme : 'moonlit') as ArenaId;
}

/** One stage of one fighter, in sim units. */
export interface SimStage {
  radius: number;
  height: number;
  muzzles: MuzzleSet;
  /** Hover height (Q16) for a flying stage, 0 when it walks. */
  fly: number;
  maxHealth: number;
  damageMultiplier: number;
}

/**
 * Per-stage numbers for a fighter (BossStages.applyStats / applyLook), assuming every stage's
 * model is present (they ship in public/assets/models/bosses). The hurtbox is as tall as
 * `hurtbox.modelHeight` x the model's fit height (never below the stage-1 capsule).
 */
export function fighterStages(f: BossFighter): SimStage[] {
  const base = (f as BossPartner).hitbox || { radius: W.radius, height: W.height };
  const out: SimStage[] = [];
  for (let s = 0; s < 3; s++) {
    const st = f.stages[s];
    const fit = MODELS[st.model].fitHeight || W.height;
    const pts: [number, number, number][] = [];
    const names = Object.keys(st.muzzle.points);
    for (const n of names) {
      const p = st.muzzle.points[n].at;
      pts.push([p[0], p[1], p[2]]);
    }
    const use: Record<string, number[]> = {};
    const kinds = ['bolt', 'volley', 'blast', 'stun', 'ultimate'] as const;
    for (const k of kinds) {
      const list = st.muzzle.use && st.muzzle.use[k];
      if (list) use[k] = list.map((n) => names.indexOf(n)).filter((i) => i >= 0);
    }
    out.push({
      radius: fx(C.hurtbox.radius[s] * (base.radius / W.radius)),
      height: max(fx(base.height), fx(C.hurtbox.modelHeight * fit)),
      muzzles: muzzleSet(pts, fit, use),
      fly: fx(st.fly || 0),
      maxHealth: fx(f.stageHealth[s]),
      damageMultiplier: mul(fx(f.damageMultiplier), fx(C.stageDamage[s])),
    });
  }
  return out;
}

export { ONE };
