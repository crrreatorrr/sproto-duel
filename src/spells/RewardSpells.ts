import * as THREE from 'three';
import { CONFIG } from '../config';
import { events } from '../core/events';
import { clamp } from '../core/math';
import type { Arena } from '../arena/Arena';
import type { Effects } from '../fx/Effects';
import { RewardFx } from '../fx/RewardFx';
import type { Physics } from '../physics/Physics';
import type { Wizard } from '../wizard/Wizard';
import type { Projectile } from './Projectile';
import { REWARD_SPELLS, REWARD_SPELL_INFO, type RewardSpellId } from './rewardCatalog';

const RS = CONFIG.rewardSpells;

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const tmpTarget = new THREE.Vector3();
const tmpPoint = new THREE.Vector3();

/** What blocks a reward spell press right now, or null if it can be cast. */
export type RewardBlock = 'unlearned' | 'cooldown' | 'mana' | 'busy';

/**
 * The boss reward spells' rules (CONFIG.rewardSpells): casting (learned, cooldown, mana, a free
 * caster), the Magic Carpet's ride (Wizard.updateMovement does the flying), Pump It's damage and
 * charge (SpellSystem.dealDamage, Wizard.addUlt), the vape cloud (Arena.addSmoke hides; healing
 * here), Lock-On's homing bolts (SpellSystem.launchBolt / steerSeek) and Hellfire Breath's cone and
 * burning. Only wizards with the spell in `learned` can cast it: the player, never a boss.
 */
export class RewardSpells {
  readonly fx: RewardFx;
  /** Time to the next breath damage tick, per channelling caster. */
  private readonly breathTick = new Map<Wizard, number>();
  /** Vape-cloud healing not yet shown as a popup, per wizard. */
  private readonly healShown = new Map<Wizard, number>();
  /** Sim time of the last "BLOCK" callout a shield made against the breath, per shielder. */
  private readonly blockShownAt = new Map<Wizard, number>();
  private time = 0;

  constructor(
    scene: THREE.Scene,
    private readonly physics: Physics,
    fx: Effects,
    private readonly wizards: Wizard[],
    private readonly arena: Arena,
    /** SpellSystem.dealDamage. */
    private readonly damage: (target: Wizard, source: Wizard | null, amount: number, point: THREE.Vector3, kind: 'breath' | 'scorch') => number,
    /** SpellSystem's NO MANA feedback. */
    private readonly noMana: (w: Wizard) => void,
  ) {
    this.fx = new RewardFx(scene, fx, wizards);
  }

  /** Why `w` can't cast `id` now, or null if it can. */
  blocked(w: Wizard, id: RewardSpellId): RewardBlock | null {
    if (!w.learned.has(id)) return 'unlearned';
    if (!w.canAct) return 'busy';
    if (w.rcd[id] > 0) return 'cooldown';
    if (!w.infiniteMana && w.mana < RS[id].manaCost) return 'mana';
    return null;
  }

  /** `w` could cast `id` right now. */
  ready(w: Wizard, id: RewardSpellId): boolean {
    return this.blocked(w, id) === null;
  }

  /**
   * Turn buffered reward-spell presses into casts. Runs every tick before the core spells. Pressing
   * the carpet while riding lands it; presses of spells still cooling down stay buffered.
   */
  handleIntents(w: Wizard): void {
    const intent = w.intent;
    if (!w.alive || w.stunned || w.evolving) return;
    for (const id of REWARD_SPELLS) {
      if (!intent.wants(id)) continue;
      if (id === 'carpet' && w.riding) {
        intent.consume(id);
        w.endRide();
        continue;
      }
      const why = this.blocked(w, id);
      if (why === 'cooldown' || why === 'busy') continue; // stays buffered until ready
      intent.consume(id);
      if (why === 'unlearned') {
        if (w.side === 0) events.emit('callout', { pos: w.chest(new THREE.Vector3()), text: 'NOT LEARNED', style: 'info' });
        continue;
      }
      if (why === 'mana') {
        this.noMana(w);
        continue;
      }
      this.cast(w, id);
      return; // one cast per tick
    }
  }

  /** Cast `id` for `w` (rules already checked). */
  private cast(w: Wizard, id: RewardSpellId): void {
    const S = RS[id];
    w.spendMana(S.manaCost);
    w.rcd[id] = S.cooldown;
    w.stats.casts++;
    w.castPulse = 1;
    const pos = w.pos.clone();
    switch (id) {
      case 'carpet':
        w.carpetTime = RS.carpet.duration;
        w.intent.holdBolt = false;
        break;
      case 'pump':
        w.pumpTime = RS.pump.duration;
        break;
      case 'vape': {
        const V = RS.vape;
        this.arena.addSmoke(w, w.pos.x, w.pos.z, V.radius, V.height, V.duration);
        break;
      }
      case 'lockon':
        w.lockTime = RS.lockon.duration;
        break;
      case 'breath':
        w.breathTime = RS.breath.duration;
        // The first lick lands at once.
        this.breathTick.set(w, 0);
        break;
    }
    if (RS.popups) events.emit('callout', { pos: w.chest(new THREE.Vector3()).setY(w.pos.y + 2.1 * w.sizeScale), text: REWARD_SPELL_INFO[id].callout, style: 'spell' });
    events.emit('rewardCast', { wizard: w, spell: id, pos });
  }

  /** One fixed tick of the effects that act over time: the breath's cone, burning, the vape cloud's healing. */
  update(dt: number): void {
    this.time += dt;
    for (const w of this.wizards) {
      if (w.breathing && w.alive) this.breathe(w, dt);
      else if (this.breathTick.has(w)) {
        this.breathTick.delete(w);
        events.emit('rewardEnd', { wizard: w, spell: 'breath' });
      }
      if (w.scorched) this.burn(w, dt);
    }
    this.healInSmoke(dt);
  }

  /** Hellfire Breath: every `tick` s, damage and set alight every enemy inside the cone. */
  private breathe(w: Wizard, dt: number): void {
    const B = RS.breath;
    let t = (this.breathTick.get(w) ?? 0) - dt;
    if (t > 0) {
      this.breathTick.set(w, t);
      return;
    }
    t += B.tick;
    this.breathTick.set(w, t);
    const origin = w.castPoint('blast', tmpA);
    const dir = this.aimDir(w, origin, tmpDir);
    for (const o of this.wizards) {
      if (o.side === w.side || !o.alive || !o.active) continue;
      const point = this.inCone(origin, dir, o, tmpPoint);
      if (!point) continue;
      if (o.invulnerable) continue; // rolling through the flames
      if (o.shielded) {
        o.visual.shieldImpact(false);
        const last = this.blockShownAt.get(o) ?? -1e9;
        if (this.time - last > 0.6) {
          this.blockShownAt.set(o, this.time);
          events.emit('callout', { pos: o.chest(new THREE.Vector3()), text: 'BLOCK', style: 'block' });
        }
        continue;
      }
      this.damage(o, w, B.dps * B.tick, point, 'breath');
      if (!o.alive) continue;
      if (!o.scorched) o.scorchTimer = B.burnTick;
      o.scorchTime = B.burnTime;
      o.scorchBy = w;
    }
  }

  /**
   * The point of `o`'s body (feet, chest or head height) inside the breath's cone from `origin`
   * along unit `dir`, in range and in sight, or null. Its body width widens the cone a little.
   */
  inCone(origin: THREE.Vector3, dir: THREE.Vector3, o: Wizard, out: THREE.Vector3): THREE.Vector3 | null {
    const B = RS.breath;
    const half = THREE.MathUtils.degToRad(B.coneDegrees / 2);
    for (const h of [1.2, 0.5, 1.75]) {
      out.set(o.pos.x, o.pos.y + h * o.sizeScale, o.pos.z);
      const v = tmpB.subVectors(out, origin);
      const d = v.length();
      if (d > B.range + o.radius) continue;
      if (d > 1e-3) {
        const angle = Math.acos(clamp(v.dot(dir) / d, -1, 1));
        if (angle > half + Math.atan2(o.radius, Math.max(0.3, d))) continue;
      }
      if (!this.physics.lineOfSight(origin, out)) continue;
      return out;
    }
    return null;
  }

  /** The burning debuff's damage over time. */
  private burn(w: Wizard, dt: number): void {
    const B = RS.breath;
    w.scorchTime = Math.max(0, w.scorchTime - dt);
    w.scorchTimer -= dt;
    while (w.scorchTimer <= 1e-9 && w.alive) {
      w.scorchTimer += B.burnTick;
      this.damage(w, w.scorchBy, B.burnDps * B.burnTick, w.chest(tmpTarget), 'scorch');
    }
    if (w.scorchTime <= 0) {
      w.scorchTime = 0;
      w.scorchBy = null;
    }
  }

  /** Each dropped smoke screen heals its owner while it stands inside. */
  private healInSmoke(dt: number): void {
    const V = RS.vape;
    for (const s of this.arena.smokes) {
      const w = s.owner;
      if (!w.alive || !w.active || w.pos.y > s.height) continue;
      if (Math.hypot(w.pos.x - s.x, w.pos.z - s.z) >= s.radius) continue;
      const before = w.health;
      w.health = Math.min(w.maxHealth, w.health + V.healPerSecond * dt);
      const healed = w.health - before;
      if (healed <= 0) continue;
      const shown = (this.healShown.get(w) ?? 0) + healed;
      // One popup per few HP, so the heal reads without a stream of numbers.
      if (shown >= V.healPerSecond) {
        events.emit('rewardHeal', { wizard: w, amount: shown });
        this.healShown.set(w, 0);
      } else this.healShown.set(w, shown);
    }
  }

  /** Unit direction from `from` toward `w`'s aim point (its facing if the aim point is too close). */
  aimDir(w: Wizard, from: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    out.subVectors(w.aimPoint, from);
    if (out.lengthSq() < 1) w.forward(out);
    return out.normalize();
  }

  /**
   * Lock-On's target for `w`: the nearest standing enemy inside the cone around its aim, within
   * range (CONFIG.rewardSpells.lockon), or null.
   */
  lockTarget(w: Wizard): Wizard | null {
    const L = RS.lockon;
    const origin = w.chest(tmpA);
    const dir = this.aimDir(w, origin, tmpDir);
    const half = THREE.MathUtils.degToRad(L.coneDegrees / 2);
    let best: Wizard | null = null;
    let bestD = Infinity;
    for (const o of this.wizards) {
      if (o.side === w.side || !o.alive || !o.active) continue;
      const v = o.chest(tmpB).sub(origin);
      const d = v.length();
      if (d > L.range || d < 1e-3) continue;
      if (Math.acos(clamp(v.dot(dir) / d, -1, 1)) > half) continue;
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }

  /** Lock-On homing for one bolt this tick: turn toward its target at the gentle `turnRate`. */
  steer(p: Projectile, dt: number): void {
    const L = RS.lockon;
    const t = p.seek!;
    if (!t.alive || !t.active || t.side === p.owner.side) {
      p.seek = null;
      return;
    }
    const speed = p.vel.length();
    if (speed < 1e-3) return;
    t.chest(tmpTarget).sub(p.pos).normalize();
    tmpDir.copy(p.vel).divideScalar(speed);
    const angle = Math.acos(clamp(tmpDir.dot(tmpTarget), -1, 1));
    if (angle > THREE.MathUtils.degToRad(L.dropDegrees)) {
      p.seek = null; // flew past it
      return;
    }
    const maxTurn = L.turnRate * dt;
    if (angle > 1e-4) tmpDir.lerp(tmpTarget, Math.min(1, maxTurn / angle)).normalize();
    p.vel.copy(tmpDir).multiplyScalar(speed);
  }

  /** Per rendered frame. */
  sync(dt: number, projectiles: readonly Projectile[]): void {
    this.fx.update(dt, projectiles);
  }

  clear(): void {
    this.breathTick.clear();
    this.healShown.clear();
    this.blockShownAt.clear();
    this.fx.clear();
  }
}
