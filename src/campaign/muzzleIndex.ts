import { MODELS, type ModelAsset } from '../assets/manifest';
import type { MuzzleSet } from '../wizard/muzzles';
import { BOSSES, bossFighters } from './levels';

/** Boss stage muzzles by model path, built on first use from levels.ts. */
let byPath: Map<string, MuzzleSet> | null = null;

/**
 * The muzzles of a GLB look: its manifest entry's own (the player), else those of the boss stage
 * that wears it (levels.ts `BossStage.muzzle`, partners included), else null (generic wand offset).
 * Keyed by model, not by stage, so a stage still wearing an earlier stage's GLB (its own is
 * missing) fires from that model's props.
 */
export function muzzleSetFor(spec: ModelAsset): MuzzleSet | null {
  if (spec.muzzle) return spec.muzzle;
  if (!byPath) {
    byPath = new Map();
    for (const boss of BOSSES) {
      for (const f of bossFighters(boss)) for (const s of f.stages) byPath.set(MODELS[s.model].path, s.muzzle);
    }
  }
  return byPath.get(spec.path) ?? null;
}
