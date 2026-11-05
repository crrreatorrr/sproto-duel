/**
 * Boss special powers in the sim: the deterministic port of src/spells/BossPowers.ts (strike,
 * barrage, march, rings, sweep, cone, seekers, flash, cloud). STUB: the interface the world and
 * the AI use; the port fills in the bodies.
 */
import type { PowerDef } from '../campaign/levels';
import type { V3 } from './fixed';
import type { SimWizard } from './wizard';
import type { SimWorld } from './world';

export type HazardKind = 'zone' | 'flash' | 'cloud' | 'ring' | 'sweep' | 'cone' | 'seeker';

/** One telegraphed piece of a power in play (BossPowers Hazard), in sim units (Q16, TU, angle units). */
export interface SimHazard {
  active: boolean;
  id: number;
  kind: HazardKind;
  power: PowerDef;
  owner: SimWizard;
  target: SimWizard | null;
  index: number;
  /** TU before it appears. */
  delay: number;
  placeOnAppear: boolean;
  readonly at: V3;
  radius: number;
  track: number;
  warn: number;
  warnTotal: number;
  t: number;
  life: number;
  speed: number;
  /** Headings in angle units (yaw: atan2(x, z)); arc in angle units; dir +1/-1. */
  angle: number;
  start: number;
  arc: number;
  dir: number;
  prev: number;
  fired: boolean;
  linger: number;
  /** Wizard indices it already hit or that evaded it. */
  done: number[];
  readonly vel: V3;
  passUntil: number;
  tick: number;
}

export class SimPowers {
  readonly hazards: SimHazard[] = [];

  constructor(protected readonly world: SimWorld) {}

  /** TU until `w` can use `def` again (0: ready). */
  cooldown(_w: SimWizard, _def: PowerDef): number {
    return 0;
  }

  setCooldown(_w: SimWizard, _def: PowerDef, _tu: number): void {}

  /** The recharge (TU) `def` starts with after use in boss stage `stage`. */
  recharge(_def: PowerDef, _stage: number): number {
    return 0;
  }

  /** CONFIG.powers.gap has passed since anyone's last power. */
  get open(): boolean {
    return false;
  }

  channeling(_w: SimWizard): boolean {
    return false;
  }

  /** The yaw (angle units) a channelling caster faces, or -1. */
  channelFacing(_w: SimWizard): number {
    return -1;
  }

  busy(_w: SimWizard): boolean {
    return false;
  }

  cast(_w: SimWizard, _def: PowerDef, _target: SimWizard, _stage: number): boolean {
    return false;
  }

  update(_dt: number): void {}

  /** Call off everything `w` has in play (a KO'd or transforming boss). */
  cancel(_w: SimWizard): void {}

  clear(): void {
    this.hazards.length = 0;
  }
}
