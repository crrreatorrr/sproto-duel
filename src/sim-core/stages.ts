/**
 * Boss stages in the sim (src/campaign/BossStages.ts gameplay). Every stage has its own health
 * bar; emptying one with a stage left transforms the boss instead of a KO.
 *
 * The live game plays each transformation as a cinematic that freezes the world, then hands the
 * fight back with the new bar full and the boss immune for `cinematic.grace` s. The sim does exactly
 * that, in no ticks: the game stops stepping the sim while its cinematic plays (presentation only),
 * so the input log has no ticks for it.
 */
import { CONFIG, type AIProfile } from '../config';
import type { BossFighter, StageAttacks } from '../campaign/levels';
import { fighterStages, type SimStage } from './bosses';
import { ONE, fx, len2, mul, muldiv, sec } from './fixed';
import type { SimWizard } from './wizard';
import type { SimWorld } from './world';

const C = CONFIG.campaign;
const GRACE = sec(C.cinematic.grace);
const EVOLVE_R = fx(C.evolveRadius);
const EVOLVE_KNOCK = fx(C.evolveKnockback);
const SPELL_DAMAGE = fx(C.aggression.spellDamage);
const ULT_CHARGE = fx(C.ultCharge);

/** The boss's base AI scaled for `stage` (BossStages.stageProfile), as floats for the AI to convert. */
export function stageProfile(boss: BossFighter, stage: number): AIProfile {
  const s = Math.max(0, Math.min(2, Math.floor(stage)));
  const A = C.stageAI;
  const G = C.aggression;
  const b = boss.ai;
  const cap = (v: number) => Math.min(A.maxChance, v);
  return {
    label: b.label,
    reactionTime: b.reactionTime * A.reactionTime[s],
    aimError: b.aimError * A.aimError[s],
    leadFactor: Math.min(1, b.leadFactor + A.leadBonus[s]),
    burst: [b.burst[0] + A.burstBonus[s], b.burst[1] + A.burstBonus[s] + G.burstExtra],
    burstPause: [b.burstPause[0] * A.burstPause[s] * G.burstPause, b.burstPause[1] * A.burstPause[s] * G.burstPause],
    strafeSpeed: b.strafeSpeed * A.strafeSpeed[s] * G.strafeSpeed,
    preferredRange: [b.preferredRange[0] * G.range, b.preferredRange[1] * G.range],
    dodgeChance: cap(b.dodgeChance * A.dodgeChance[s]),
    shieldPreference: b.shieldPreference,
    perfectShieldChance: cap(b.perfectShieldChance * A.perfectShieldChance[s]),
    blastChance: cap(b.blastChance * A.blastChance[s] * G.blastChance),
    stunChance: cap(b.stunChance * A.stunChance[s] * G.stunChance),
    punishChance: cap(b.punishChance * A.punishChance[s] * G.punishChance),
    hopRate: b.hopRate,
  };
}

export class SimStages {
  stage = 0;
  readonly stats: SimStage[];
  /** Called on every stage set (round start, transformation): the AI picks up attacks and profile. */
  onStage: ((stage: number) => void) | null = null;

  constructor(
    private readonly world: SimWorld,
    readonly boss: BossFighter,
    readonly owner: SimWizard,
    private readonly target: SimWizard,
  ) {
    this.stats = fighterStages(boss);
    owner.koGuard = () => this.stage < 2;
    world.events.on('damage', (e) => {
      if (e.w === owner.index && e.n > 0) this.checkHealth();
    });
  }

  get attacks(): StageAttacks {
    return this.boss.stages[this.stage].attacks;
  }

  /** Round start: stage 1 and its bar, at once. */
  reset(): void {
    this.toStage(0);
    this.owner.health = this.owner.maxHealth;
  }

  update(): void {
    const e = this.owner;
    if (e.alive && !e.evolving && e.health <= 0) this.checkHealth();
  }

  private checkHealth(): void {
    const e = this.owner;
    if (!e.alive || e.evolving || e.health > 0 || this.stage >= 2) return;
    this.evolveTo(this.stage + 1);
  }

  private evolveTo(stage: number): void {
    const e = this.owner, p = this.target;
    const from = this.stage;
    this.toStage(stage);
    e.health = e.maxHealth;
    e.evolveTime = GRACE;
    e.cast = null;
    e.shieldTime = e.stunTime = e.dodgeTime = 0;
    e.vel.x = e.vel.z = 0;
    e.knock.x = e.knock.z = 0;
    e.clearIntent();
    // The shockwave shoves the player away if close (full at the centre, half at the edge).
    let dx = p.pos.x - e.pos.x, dz = p.pos.z - e.pos.z;
    const d = len2(dx, dz);
    if (p.alive && d < EVOLVE_R) {
      if (d < 66) {
        dx = e.forwardX();
        dz = e.forwardZ();
      }
      p.addKnockback(dx, dz, mul(EVOLVE_KNOCK, ONE - (muldiv(d, ONE, EVOLVE_R) >> 1)));
    }
    this.world.powers.cancel(e);
    this.world.events.push('bossEvolve', e.index, this.boss.id, stage, -1, e.pos.x, e.pos.y, e.pos.z, from > 0);
  }

  private toStage(stage: number): void {
    const e = this.owner;
    const st = this.stats[stage];
    this.stage = stage;
    e.evolveTime = 0;
    e.flyHeight = st.fly;
    e.damageMultiplier = st.damageMultiplier;
    e.spellDamageScale = this.boss.spellDamage !== undefined ? fx(this.boss.spellDamage) : SPELL_DAMAGE;
    e.maxHealth = st.maxHealth;
    e.ultChargeMultiplier = ULT_CHARGE;
    e.setHitbox(st.radius, st.height);
    e.muzzles = st.muzzles;
    this.world.events.push('bossStage', e.index, this.boss.id, stage);
    if (this.onStage) this.onStage(stage);
    this.world.onBossStage();
  }
}
