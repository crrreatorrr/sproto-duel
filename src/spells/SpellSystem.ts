import * as THREE from 'three';
import { CONFIG } from '../config';
import { events, type DamageKind, type GameEvents } from '../core/events';
import { feel } from '../core/feel';
import { clamp, lerp, segmentSphere } from '../core/math';
import { GROUP, type ColliderTag, type Physics, type QueryHit } from '../physics/Physics';
import type { Arena } from '../arena/Arena';
import type { VolleyDef } from '../campaign/levels';
import type { Pillar } from '../arena/Pillar';
import type { Effects } from '../fx/Effects';
import { MuzzleFx } from '../fx/MuzzleFx';
import { SpellFx, type WaveFx } from '../fx/SpellFx';
import type { CastKind } from '../wizard/muzzles';
import type { Wizard } from '../wizard/Wizard';
import { ProjectilePool, type Projectile } from './Projectile';
import { RewardSpells } from './RewardSpells';
import type { ChanneledSpell } from './types';

const S = CONFIG.spells;
const PROJECTILE_MASK = GROUP.WORLD | GROUP.WIZARD | GROUP.GROUND;
/** Clash detection is a little generous so mid-air collisions actually happen. */
const CLASH_RADIUS_SCALE = 1.6;

/** A burst volley still firing (VolleyDef.interval > 0). */
interface PendingVolley {
  active: boolean;
  wizard: Wizard | null;
  def: VolleyDef | null;
  /** Shots fired so far. */
  fired: number;
  /** Seconds until the next shot. */
  timer: number;
}

interface UltWave {
  owner: Wizard;
  origin: THREE.Vector3;
  radius: number;
  hitWizards: Set<Wizard>;
  hitPillars: Set<Pillar>;
  fx: WaveFx | null;
}

const tmpDir = new THREE.Vector3();
const tmpMotion = new THREE.Vector3();
const tmpPoint = new THREE.Vector3();
const tmpCenter = new THREE.Vector3();
const tmpNormal = new THREE.Vector3();
const tmpTarget = new THREE.Vector3();
const tmpColor = new THREE.Color();
const tmpFrom = new THREE.Vector3();
const tmpAxisPoint = new THREE.Vector3();
const tmpSpan = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/**
 * Owns casting rules (mana, cooldowns, windups), projectiles and every spell interaction:
 * shields, reflects, clashes, beams, explosions and the ultimate wave.
 * Controllers only set intents; this turns intents into spells.
 *
 * Teams (Wizard.side): nothing hurts, stuns, pushes or blocks its own side. Bolts, blasts and beams
 * pass through allies, splash and the Ultimate wave skip them, an ally's shield ignores your
 * spells, and same-side projectiles never clash. A reflect hands the spell to the shielder's side.
 * `wizards` is Game.wizards, shared by reference (a double fight's partner joins it while active).
 */
export class SpellSystem {
  readonly pool: ProjectilePool;
  readonly spellFx: SpellFx;
  /** What plays at the caster's staff, phone, vape, gun, palm or mouth as a spell leaves it. */
  readonly muzzleFx: MuzzleFx;
  /** The boss reward spells (carpet, pump, vape, lock-on, breath): their rules and effects. */
  readonly rewards: RewardSpells;
  private readonly waves: UltWave[] = [];
  /** Burst volleys in flight, matched by caster (one per caster at a time); grows only if every slot is busy. */
  private readonly volleys: PendingVolley[];

  constructor(
    scene: THREE.Scene,
    private readonly physics: Physics,
    private readonly fx: Effects,
    private readonly wizards: Wizard[],
    private readonly arena: Arena,
  ) {
    this.pool = new ProjectilePool(scene, fx);
    this.spellFx = new SpellFx(scene);
    this.muzzleFx = new MuzzleFx(scene, fx);
    this.volleys = wizards.map(() => this.newVolleySlot());
    this.rewards = new RewardSpells(scene, physics, fx, wizards, arena, (t, s, a, p, k) => this.dealDamage(t, s, a, p, k), (w) => this.noMana(w));
  }

  /** Side of the spell being traced (`skipQuery`): allies on that side are passed through. */
  private querySide = -1;
  /** Projectiles and beams pass through rolling (i-frames) and knocked-out wizards, and their own side. */
  private readonly skipQuery = (tag: ColliderTag) =>
    tag.kind === 'wizard' && (tag.wizard.invulnerable || !tag.wizard.alive || tag.wizard.side === this.querySide);

  update(dt: number): void {
    for (const w of this.wizards) {
      this.updateCast(w, dt);
      this.handleIntents(w);
    }
    this.rewards.update(dt);
    this.updateVolleys(dt);
    this.updateProjectiles(dt);
    this.resolveClashes();
    this.updateWaves(dt);
  }

  clear(): void {
    this.pool.releaseAll();
    for (const w of this.waves) if (w.fx) this.spellFx.releaseWave(w.fx);
    this.waves.length = 0;
    for (const v of this.volleys) v.active = false;
    this.spellFx.clear();
    this.muzzleFx.clear();
    this.rewards.clear();
  }

  /** Remove everything `w` has in flight (a boss partner leaving the fight). */
  releaseOwned(w: Wizard): void {
    const list = this.pool.active;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].owner === w) this.pool.release(list[i]);
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const wave = this.waves[i];
      if (wave.owner !== w) continue;
      if (wave.fx) this.spellFx.releaseWave(wave.fx);
      this.waves.splice(i, 1);
    }
    for (const v of this.volleys) if (v.wizard === w) v.active = false;
  }

  /** Render-time sync (interpolation, shader time). */
  sync(alpha: number, time: number, dt: number): void {
    this.pool.sync(alpha, time);
    this.spellFx.update(dt);
    this.muzzleFx.update(dt, this.wizards);
    this.rewards.sync(dt, this.pool.active);
  }

  private callout(pos: THREE.Vector3, text: string, style: GameEvents['callout']['style']): void {
    events.emit('callout', { pos: pos.clone(), text, style });
  }

  // =================================================================== casting

  private handleIntents(w: Wizard): void {
    if (!w.alive || w.stunned || w.evolving) return;
    const intent = w.intent;

    // Shield is the panic button: it may interrupt a windup or the fire breath, but not a roll (or a carpet ride).
    if (intent.wants('shield') && !w.dodging && !w.shielded && !w.riding) {
      if (this.raiseShield(w)) intent.consume('shield');
    }
    // Boss reward spells (only wizards that learned them: the player).
    if (w.learned.size > 0 || w.side === 0) this.rewards.handleIntents(w);
    if (!w.canAct) return;

    for (const spell of ['ultimate', 'stun', 'blast'] as const) {
      if (intent.wants(spell) && this.beginCast(w, spell)) {
        intent.consume(spell);
        return;
      }
    }
    if (intent.holdBolt || intent.wants('bolt')) {
      if (this.castBolt(w)) intent.consume('bolt');
    }
  }

  /** Direction from `from` toward the wizard's aim point (falls back to facing). */
  private aimDirection(w: Wizard, from: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    out.subVectors(w.aimPoint, from);
    if (out.lengthSq() < 1) w.forward(out);
    return out.normalize();
  }

  /**
   * Where `kind` leaves `w` now: muzzle `index` (Wizard.castPoint: staff orb, phone, gun barrel...),
   * kept on the caster's side of walls and obstacles (see clearOrigin).
   */
  muzzleOrigin(w: Wizard, kind: CastKind, index: number, radius: number, out: THREE.Vector3): THREE.Vector3 {
    w.castPoint(kind, out, index);
    return this.clearOrigin(w, out, radius);
  }

  /**
   * Keep a spawn point from starting inside or beyond a wall, pillar, car or pane of glass: trace from
   * the caster's own axis (inside its collider, which its spells ignore; at the muzzle's height, or
   * the chest's if the muzzle is higher) out to the muzzle, and pull the point back short of anything
   * in the way by the spell's `radius`.
   * A caster hugging cover then fires into the cover, never through it.
   */
  private clearOrigin(w: Wizard, point: THREE.Vector3, radius: number): THREE.Vector3 {
    // From no higher than the chest: a staff raised over a low wall must not reach past it.
    tmpAxisPoint.set(w.pos.x, Math.min(point.y, w.pos.y + 1.2 * w.sizeScale), w.pos.z);
    tmpSpan.subVectors(point, tmpAxisPoint);
    const len = tmpSpan.length();
    if (len < 1e-4) return point;
    tmpSpan.divideScalar(len);
    const hit = this.physics.raycast(tmpAxisPoint, tmpSpan, len + radius, GROUP.WORLD);
    let reach = hit ? Math.max(0, Math.min(len, hit.distance - radius)) : len;
    // The arena's outer wall is low: a raised staff can reach over it. Stay inside its radius.
    const edge = CONFIG.arena.wallRadius - radius;
    const ax = tmpAxisPoint.x, az = tmpAxisPoint.z, dx = tmpSpan.x, dz = tmpSpan.z;
    const ex = ax + dx * reach, ez = az + dz * reach;
    if (ex * ex + ez * ez > edge * edge) {
      const a = dx * dx + dz * dz, b = 2 * (ax * dx + az * dz), cc = ax * ax + az * az - edge * edge;
      const disc = b * b - 4 * a * cc;
      if (a > 1e-8 && disc >= 0) reach = Math.max(0, Math.min(reach, (-b + Math.sqrt(disc)) / (2 * a)));
    }
    if (reach < len) point.copy(tmpAxisPoint).addScaledVector(tmpSpan, reach);
    return point;
  }

  /** "NO MANA" over the caster. */
  noMana(w: Wizard): void {
    this.callout(w.chest(tmpPoint), 'NO MANA', 'info');
    events.emit('noMana', { wizard: w });
  }

  /** Start a windup. Returns true if the press was handled (started, or rejected with feedback). */
  private beginCast(w: Wizard, spell: ChanneledSpell): boolean {
    if (spell === 'ultimate') {
      if (w.ult < S.ultimate.chargeMax) {
        this.callout(w.chest(tmpPoint), 'NOT CHARGED', 'info');
        return true;
      }
    } else {
      if (w.cd[spell] > 0) return false; // stay buffered until ready
      if (w.mana < S[spell].manaCost) {
        this.noMana(w);
        return true;
      }
    }
    w.cast = { spell, elapsed: 0, duration: S[spell].castTime };
    events.emit('castStart', { wizard: w, spell, pos: w.pos });
    return true;
  }

  private updateCast(w: Wizard, dt: number): void {
    const c = w.cast;
    if (!c) return;
    if (!w.alive || w.stunned || w.evolving) {
      w.cast = null;
      return;
    }
    c.elapsed += dt;
    if (c.elapsed < c.duration) return;
    w.cast = null;
    if (c.spell === 'blast') this.releaseBlast(w);
    else if (c.spell === 'stun') this.releaseStun(w);
    else this.releaseUltimate(w);
  }

  private castBolt(w: Wizard): boolean {
    const B = S.bolt;
    if (w.cd.bolt > 0) return false;
    if (!w.spendMana(B.manaCost)) {
      if (w.intent.wants('bolt')) this.noMana(w);
      w.cd.bolt = B.fireInterval * 2;
      return true;
    }
    w.cd.bolt = B.fireInterval;
    const muzzle = w.muzzleIndex('bolt');
    this.muzzleOrigin(w, 'bolt', muzzle, B.radius, tmpFrom);
    if (this.launchBolt(w, tmpFrom, this.aimDirection(w, tmpFrom, tmpDir), B.damage, 'bolt', muzzle)) w.castPulse = 1;
    return true;
  }

  /**
   * Spawn one bolt owned by `w` from `from` along unit `dir`. Every bolt goes through here (held fire
   * and volleys), so they all clash, reflect, pool and skin the same way. `muzzle` is the muzzle it
   * left from (its effects play there; the next shot may use the other hand).
   */
  private launchBolt(w: Wizard, from: THREE.Vector3, dir: THREE.Vector3, damage: number, kind: 'bolt' | 'volley', muzzle: number): Projectile | null {
    const B = S.bolt;
    const p = this.pool.spawn('bolt');
    if (!p) return null;
    p.pos.copy(from);
    p.prevPos.copy(from);
    p.vel.copy(dir).multiplyScalar(B.speed);
    p.owner = p.caster = w;
    p.radius = B.radius;
    p.damage = damage;
    p.power = p.basePower = B.power * w.clashPowerMultiplier;
    p.life = B.lifetime;
    // Lock-On: the bolt curves toward the nearest enemy in front of the caster.
    if (w.lockedOn) p.seek = this.rewards.lockTarget(w);
    p.refreshLook();
    w.stats.casts++;
    this.muzzleFx.cast(w, kind, muzzle, p.pos, dir);
    w.advanceMuzzle();
    events.emit('cast', { wizard: w, spell: 'bolt', pos: p.pos });
    return p;
  }

  /**
   * A boss's signature multi-shot: `def.count` bolts at `def.damageScale` x bolt damage (the caster's
   * damage multiplier applies on hit, as for every spell). With `interval` 0 they leave at once,
   * fanned evenly across `spreadDeg`; otherwise one every `interval` s, sweeping across the spread
   * and re-aimed each shot. Needs a free caster (no windup, roll, stun or transformation) and
   * CONFIG.campaign.volley.manaCost. The AI owns the cooldown. Returns true if it started.
   */
  castVolley(w: Wizard, def: VolleyDef): boolean {
    if (!w.canAct || this.volleyFiring(w) || def.count < 1) return false;
    if (!w.spendMana(CONFIG.campaign.volley.manaCost)) return false;
    w.castPulse = 1;
    w.chest(tmpPoint);
    events.emit('volley', { wizard: w, name: def.name, count: def.count, pos: tmpPoint });
    if (def.interval <= 0) {
      for (let i = 0; i < def.count; i++) this.volleyShot(w, def, i);
      return true;
    }
    this.volleyShot(w, def, 0);
    if (def.count > 1) {
      let slot = this.volleys.find((v) => !v.active);
      if (!slot) this.volleys.push((slot = this.newVolleySlot()));
      slot.active = true;
      slot.wizard = w;
      slot.def = def;
      slot.fired = 1;
      slot.timer = def.interval;
    }
    return true;
  }

  /** The caster's burst volley is still firing. */
  volleyFiring(w: Wizard): boolean {
    for (const v of this.volleys) if (v.active && v.wizard === w) return true;
    return false;
  }

  private newVolleySlot(): PendingVolley {
    return { active: false, wizard: null, def: null, fired: 0, timer: 0 };
  }

  private updateVolleys(dt: number): void {
    for (const v of this.volleys) {
      if (!v.active) continue;
      const w = v.wizard!, def = v.def!;
      // A stun, a KO or a transformation cuts the burst short.
      if (!w.alive || w.stunned || w.evolving) {
        v.active = false;
        continue;
      }
      v.timer -= dt;
      while (v.timer <= 1e-9 && v.fired < def.count) {
        this.volleyShot(w, def, v.fired++);
        v.timer += def.interval;
      }
      if (v.fired >= def.count) v.active = false;
    }
  }

  /** Shot `i` of a volley: aimed like a bolt, then turned across the spread (left to right). */
  private volleyShot(w: Wizard, def: VolleyDef, i: number): void {
    const t = def.count > 1 ? i / (def.count - 1) - 0.5 : 0;
    const muzzle = w.muzzleIndex('volley');
    this.muzzleOrigin(w, 'volley', muzzle, S.bolt.radius, tmpFrom);
    this.aimDirection(w, tmpFrom, tmpDir).applyAxisAngle(Y_AXIS, -t * THREE.MathUtils.degToRad(def.spreadDeg));
    this.launchBolt(w, tmpFrom, tmpDir, S.bolt.damage * def.damageScale, 'volley', muzzle);
  }

  private releaseBlast(w: Wizard): void {
    const B = S.blast;
    if (!w.spendMana(B.manaCost)) {
      this.noMana(w);
      return;
    }
    w.cd.blast = B.cooldown;
    const p = this.pool.spawn('blast');
    if (!p) return;
    const muzzle = w.muzzleIndex('blast');
    this.muzzleOrigin(w, 'blast', muzzle, B.radius, p.pos);
    p.prevPos.copy(p.pos);
    this.aimDirection(w, p.pos, tmpDir);
    p.vel.copy(tmpDir).multiplyScalar(B.speed);
    p.owner = p.caster = w;
    p.radius = B.radius;
    p.damage = B.damage;
    p.power = p.basePower = B.power * w.clashPowerMultiplier;
    p.life = B.lifetime;
    p.refreshLook();
    w.castPulse = 1;
    w.stats.casts++;
    this.muzzleFx.cast(w, 'blast', muzzle, p.pos, tmpDir);
    w.advanceMuzzle();
    feel.shakeAt(p.pos, 0.12, 6);
    events.emit('cast', { wizard: w, spell: 'blast', pos: p.pos });
  }

  private raiseShield(w: Wizard): boolean {
    const SH = S.shield;
    if (w.cd.shield > 0) return false;
    if (!w.spendMana(SH.manaCost)) {
      this.noMana(w);
      return true;
    }
    w.cast = null;
    w.breathTime = 0; // the shield goes up instead of the flames
    w.shieldTime = SH.duration;
    w.shieldAge = 0;
    w.cd.shield = SH.cooldown;
    w.stats.casts++;
    events.emit('shieldUp', { wizard: w });
    events.emit('cast', { wizard: w, spell: 'shield', pos: w.pos });
    return true;
  }

  private releaseStun(w: Wizard): void {
    const St = S.stun;
    if (!w.spendMana(St.manaCost)) {
      this.noMana(w);
      return;
    }
    w.cd.stun = St.cooldown;
    w.castPulse = 1;
    w.stats.casts++;
    const muzzle = w.muzzleIndex('stun');
    const origin = this.muzzleOrigin(w, 'stun', muzzle, 0, new THREE.Vector3());
    const dir = this.aimDirection(w, origin, new THREE.Vector3());
    events.emit('cast', { wizard: w, spell: 'stun', pos: origin });
    this.muzzleFx.cast(w, 'stun', muzzle, origin, dir);
    w.advanceMuzzle();
    this.fireBeam(w, origin, dir, false);
  }

  /** Hitscan stun beam. Shields block it; a perfect shield bounces it back onto the caster. */
  private fireBeam(caster: Wizard, origin: THREE.Vector3, dir: THREE.Vector3, reflected: boolean): void {
    const St = S.stun;
    const range = St.range;
    const color = caster.team.stun;
    const span = new THREE.Vector3().copy(dir).multiplyScalar(range);

    let shieldDist = Infinity;
    let shieldOwner: Wizard | null = null;
    for (const o of this.wizards) {
      if (o.side === caster.side || !o.alive || !o.shielded) continue;
      tmpCenter.set(o.pos.x, o.pos.y + o.shieldCenterY, o.pos.z);
      const t = segmentSphere(origin, span, tmpCenter, S.shield.radius);
      if (t >= 0 && t * range < shieldDist) {
        shieldDist = t * range;
        shieldOwner = o;
      }
    }
    this.querySide = caster.side;
    const hit = this.physics.raycast(origin, dir, range, PROJECTILE_MASK, caster.collider, this.skipQuery);
    const hitDist = hit ? hit.distance : range;
    const reach = Math.min(hitDist, shieldDist);

    // Rolling through the beam.
    span.copy(dir).multiplyScalar(reach);
    for (const o of this.wizards) {
      if (o.side === caster.side || !o.alive || !o.invulnerable) continue;
      if (segmentSphere(origin, span, o.chest(tmpCenter), 0.8) >= 0) {
        this.callout(tmpCenter, 'DODGE', 'info');
        events.emit('dodgeEvade', { wizard: o, pos: tmpCenter.clone() });
      }
    }

    const end = new THREE.Vector3().copy(origin).addScaledVector(dir, reach);
    this.spellFx.beam(origin, end, color, St.beamVisualTime);
    // A caster's beam flares at its muzzle (releaseStun); a reflected one bursts off the shield.
    if (reflected) this.fx.muzzle(origin, dir, color, 1.2);

    if (shieldOwner && shieldDist <= hitDist) {
      const perfect = shieldOwner.shieldAge <= S.shield.perfectWindow;
      shieldOwner.visual.shieldImpact(perfect);
      events.emit('block', { wizard: shieldOwner, pos: end.clone(), perfect, spell: 'stun' });
      this.fx.impact(end, null, color, 1);
      if (perfect && !reflected && caster.alive) {
        this.perfectFeedback(shieldOwner, end);
        const back = caster.chest(new THREE.Vector3()).sub(end).normalize();
        this.fireBeam(shieldOwner, end, back, true);
      } else {
        this.callout(end, 'BLOCK', 'block');
      }
      return;
    }

    if (!hit) return;
    if (hit.tag.kind === 'wizard') {
      const target = hit.tag.wizard;
      const stuns = !target.evolving; // a transforming boss shrugs it off ("IMMUNE")
      target.applyStun(St.duration);
      this.dealDamage(target, caster, St.damage, end, 'stun');
      this.fx.impact(end, hit.normal, color, 1.2);
      this.fx.flash(end, color, 1.4, 0.12);
      feel.freeze(St.hitStopMs);
      feel.shakeAt(end, 0.35);
      if (!stuns) return;
      events.emit('stunned', { wizard: target });
      this.callout(target.chest(tmpPoint), 'STUNNED', 'stun');
    } else if (hit.tag.kind === 'pillar') {
      hit.tag.pillar.damage(St.damage, end);
      this.fx.impact(end, hit.normal, color, 0.8);
    } else {
      this.fx.impact(end, hit.normal, color, 0.6);
    }
  }

  private releaseUltimate(w: Wizard): void {
    const U = S.ultimate;
    w.ult = 0;
    w.ultAnnounced = false;
    w.castPulse = 1;
    w.stats.casts++;
    // The shockwave runs along the floor even if the caster is airborne or on a stump.
    const origin = new THREE.Vector3(w.pos.x, 0, w.pos.z);
    const color = w.team.ultimate;
    this.waves.push({
      owner: w,
      origin,
      radius: 0.6,
      hitWizards: new Set(),
      hitPillars: new Set(),
      fx: this.spellFx.wave(color),
    });
    // Every muzzle the Ultimate uses flares at once (Tinubu: palm and mouth together).
    const list = w.visual.muzzles?.use.ultimate;
    const n = list ? list.length : 1;
    for (let i = 0; i < n; i++) {
      const muzzle = list ? list[i] : -1;
      w.castPoint('ultimate', tmpFrom, muzzle);
      this.muzzleFx.cast(w, 'ultimate', muzzle, tmpFrom, this.aimDirection(w, tmpFrom, tmpDir));
    }
    const chest = w.chest(new THREE.Vector3());
    this.fx.explosion(chest, color, 2.0);
    this.fx.ring(origin, color, U.maxRadius, U.maxRadius / U.waveSpeed);
    this.fx.light(chest, color, 30, 0.5);
    feel.shake(0.55);
    feel.screenFlash(color, 0.5);
    events.emit('cast', { wizard: w, spell: 'ultimate', pos: origin });
    events.emit('ultWave', { wizard: w, pos: origin });
  }

  // =============================================================== projectiles

  private updateProjectiles(dt: number): void {
    const list = this.pool.active;
    // Backwards: release() swaps the last element into the current slot.
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      if (!p.active) continue;
      p.age++;
      p.prevPos.copy(p.pos);
      p.life -= dt;
      if (p.life <= 0) {
        if (p.kind === 'blast') this.explode(p.pos, p.owner, p.damage, null);
        else this.fx.impact(p.pos, null, p.color, 0.4);
        this.pool.release(p);
        continue;
      }

      if (p.homing) this.steerHoming(p, dt);
      else if (p.seek) this.rewards.steer(p, dt);

      tmpMotion.copy(p.vel).multiplyScalar(dt);
      if (this.checkShields(p, tmpMotion)) continue;
      this.checkEvade(p, tmpMotion);

      this.querySide = p.owner.side;
      const hit = this.physics.sphereCast(p.pos, tmpMotion, p.radius, PROJECTILE_MASK, p.owner.collider, this.skipQuery);
      if (hit) {
        p.pos.addScaledVector(tmpMotion.normalize(), hit.distance);
        this.impact(p, hit);
        continue;
      }
      p.pos.add(tmpMotion);
      p.trail(this.fx);
    }
  }

  /** Perfect reflects curve toward the original caster. */
  private steerHoming(p: Projectile, dt: number): void {
    const target = p.homing!;
    if (!target.alive) {
      p.homing = null;
      return;
    }
    const speed = p.vel.length();
    target.chest(tmpTarget).sub(p.pos).normalize();
    tmpDir.copy(p.vel).divideScalar(speed || 1);
    const angle = Math.acos(clamp(tmpDir.dot(tmpTarget), -1, 1));
    const maxTurn = 7 * dt;
    if (angle > 1e-3) tmpDir.lerp(tmpTarget, Math.min(1, maxTurn / angle)).normalize();
    p.vel.copy(tmpDir).multiplyScalar(speed);
  }

  /** Returns true if the projectile hit a shield this tick (it was reflected, deflected or absorbed). */
  private checkShields(p: Projectile, motion: THREE.Vector3): boolean {
    for (const o of this.wizards) {
      if (o.side === p.owner.side || !o.alive || !o.shielded) continue;
      tmpCenter.set(o.pos.x, o.pos.y + o.shieldCenterY, o.pos.z);
      const t = segmentSphere(p.pos, motion, tmpCenter, S.shield.radius + p.radius);
      if (t < 0) continue;
      tmpPoint.copy(p.pos).addScaledVector(motion, t);
      this.shieldBlock(p, o, tmpCenter, tmpPoint);
      return true;
    }
    return false;
  }

  private shieldBlock(p: Projectile, o: Wizard, center: THREE.Vector3, point: THREE.Vector3): void {
    const SH = S.shield;
    const perfect = o.shieldAge <= SH.perfectWindow;
    const normal = tmpNormal.subVectors(point, center).normalize();
    o.visual.shieldImpact(perfect);
    events.emit('block', { wizard: o, pos: point.clone(), perfect, spell: p.kind });

    if (perfect) {
      // Send it straight back at whoever cast it, faster and stronger.
      const victim = p.owner;
      p.owner = o;
      p.reflected = true;
      p.seek = null;
      p.homing = victim.alive ? victim : null;
      victim.chest(tmpTarget);
      const speed = (p.kind === 'bolt' ? S.bolt.speed : S.blast.speed) * SH.reflectSpeedMultiplier;
      p.vel.subVectors(tmpTarget, point).normalize().multiplyScalar(speed);
      p.damage *= SH.reflectDamageMultiplier;
      p.life = p.kind === 'bolt' ? S.bolt.lifetime : S.blast.lifetime;
      p.pos.copy(center).addScaledVector(normal, SH.radius + p.radius + 0.05);
      p.prevPos.copy(p.pos);
      p.refreshLook();
      this.fx.impact(point, normal, o.team.spell, 1.4);
      this.perfectFeedback(o, point);
      return;
    }

    this.callout(point, 'BLOCK', 'block');
    if (p.kind === 'blast') {
      // The shield eats the orb: it bursts on the surface without hurting the shielder.
      this.explode(point, p.owner, p.damage, o);
      this.pool.release(p);
      return;
    }
    // Deflect: glance off the bubble in a scattered direction and fizzle out.
    const vn = p.vel.dot(normal);
    p.vel.addScaledVector(normal, -2 * vn);
    tmpDir.set(Math.random() - 0.5, 0.6 + Math.random() * 0.4, Math.random() - 0.5);
    p.vel.normalize().add(tmpDir).normalize().multiplyScalar(S.bolt.speed * 0.6);
    p.owner = o;
    p.seek = null;
    p.damage *= SH.deflectDamageMultiplier;
    p.life = Math.min(p.life, 0.35);
    p.pos.copy(center).addScaledVector(normal, SH.radius + p.radius + 0.05);
    p.prevPos.copy(p.pos);
    p.refreshLook();
    this.fx.impact(point, normal, o.team.spell, 0.7);
    feel.freeze(22, true);
  }

  private perfectFeedback(o: Wizard, point: THREE.Vector3): void {
    o.stats.perfects++;
    o.addUlt(S.shield.perfectUltCharge);
    this.fx.flash(point, 0xffffff, 4, 0.18);
    this.fx.light(point, o.team.spell, 40, 0.3);
    feel.freeze(S.shield.hitStopMs);
    feel.slowMo(CONFIG.feel.perfectSlowMoScale, CONFIG.feel.perfectSlowMoTime);
    feel.shakeAt(point, 0.3);
    this.callout(point, 'PERFECT!', 'perfect');
  }

  /** "DODGE" when a projectile passes through a rolling wizard. */
  private checkEvade(p: Projectile, motion: THREE.Vector3): void {
    for (const o of this.wizards) {
      if (o.side === p.owner.side || !o.invulnerable || p.evaded === o || !o.alive) continue;
      if (segmentSphere(p.pos, motion, o.chest(tmpCenter), 0.75 + p.radius) < 0) continue;
      p.evaded = o;
      this.callout(tmpCenter, 'DODGE', 'info');
      events.emit('dodgeEvade', { wizard: o, pos: tmpCenter.clone() });
    }
  }

  private impact(p: Projectile, hit: QueryHit): void {
    const tag = hit.tag;
    if (p.kind === 'blast') {
      this.explode(p.pos, p.owner, p.damage, null, tag.kind === 'wizard' ? tag.wizard : null);
      events.emit('impact', { pos: p.pos, spell: 'blast', surface: tag.kind === 'wizard' ? 'wizard' : tag.kind === 'pillar' ? 'pillar' : 'floor' });
      this.pool.release(p);
      return;
    }
    const color = p.color;
    if (tag.kind === 'wizard') {
      const target = tag.wizard;
      tmpDir.copy(p.vel).setY(0);
      this.dealDamage(target, p.owner, p.damage, p.pos, 'bolt', tmpDir, S.bolt.knockback);
      this.fx.impact(p.pos, hit.normal, color, p.reflected ? 1.6 : 1);
      feel.freeze(S.bolt.hitStopMs, !p.reflected);
      if (target === feel.local || p.owner === feel.local) feel.shake(S.bolt.shake);
      else feel.shakeAt(p.pos, S.bolt.shake);
      events.emit('impact', { pos: p.pos, spell: 'bolt', surface: 'wizard' });
    } else if (tag.kind === 'pillar') {
      tag.pillar.damage(p.damage, p.pos);
      this.fx.impact(p.pos, hit.normal, color, 0.8);
      this.fx.dust(p.pos, 3, 0.4);
      events.emit('impact', { pos: p.pos, spell: 'bolt', surface: 'pillar' });
    } else {
      this.fx.impact(p.pos, hit.normal, color, 0.6);
      events.emit('impact', { pos: p.pos, spell: 'bolt', surface: tag.kind === 'wall' ? 'wall' : 'floor' });
    }
    this.pool.release(p);
  }

  /** Blast explosion: splash damage with falloff, blocked by pillars, shields and i-frames. */
  private explode(pos: THREE.Vector3, owner: Wizard, damage: number, ignore: Wizard | null, direct: Wizard | null = null): void {
    const B = S.blast;
    const radius = B.splashRadius;
    let hitAny = false;
    const origin = new THREE.Vector3(pos.x, Math.max(pos.y, 0.4), pos.z);
    for (const o of this.wizards) {
      if (!o.alive || o.side === owner.side || o === ignore) continue;
      // Distance to the wizard's vertical body segment.
      const y = clamp(origin.y, o.pos.y + 0.3 * o.sizeScale, o.pos.y + 1.6 * o.sizeScale);
      tmpTarget.set(o.pos.x, y, o.pos.z);
      const d = Math.max(0, origin.distanceTo(tmpTarget) - o.radius);
      if (d > radius) continue;
      o.chest(tmpCenter);
      if (o.invulnerable) {
        this.callout(tmpCenter, 'DODGE', 'info');
        events.emit('dodgeEvade', { wizard: o, pos: tmpCenter.clone() });
        continue;
      }
      if (o.shielded) {
        o.visual.shieldImpact(false);
        this.callout(tmpCenter, 'BLOCK', 'block');
        events.emit('block', { wizard: o, pos: tmpCenter.clone(), perfect: false, spell: 'blast' });
        continue;
      }
      if (!this.physics.lineOfSight(origin, tmpCenter)) continue;
      const falloff = o === direct ? 1 : lerp(1, B.splashFalloff, d / radius);
      tmpDir.subVectors(o.pos, origin).setY(0);
      if (tmpDir.lengthSq() < 1e-4) tmpDir.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      this.dealDamage(o, owner, damage * falloff, tmpCenter, 'blast', tmpDir, B.knockback * falloff);
      hitAny = true;
    }
    for (const pillar of this.arena.pillars) {
      if (!pillar.alive) continue;
      const d = pillar.surfaceDistance(origin.x, origin.z);
      if (d > radius) continue;
      pillar.closestPoint(origin.x, origin.z, tmpPoint).y = origin.y;
      pillar.damage(damage * lerp(1, 0.35, Math.max(0, d) / radius), tmpPoint);
    }
    this.fx.explosion(origin, owner.team.blast, radius);
    feel.freeze(hitAny ? B.hitStopMs : 25);
    feel.shakeAt(origin, B.shake);
    events.emit('explosion', { pos: origin, radius, owner });
  }

  // ==================================================================== clashes

  private resolveClashes(): void {
    const list = this.pool.active;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a.owner.side === b.owner.side) continue;
        // Closest approach of the two swept paths over this tick.
        const rx = a.prevPos.x - b.prevPos.x, ry = a.prevPos.y - b.prevPos.y, rz = a.prevPos.z - b.prevPos.z;
        const dx = a.pos.x - a.prevPos.x - (b.pos.x - b.prevPos.x);
        const dy = a.pos.y - a.prevPos.y - (b.pos.y - b.prevPos.y);
        const dz = a.pos.z - a.prevPos.z - (b.pos.z - b.prevPos.z);
        const dd = dx * dx + dy * dy + dz * dz;
        const t = dd > 1e-9 ? clamp(-(rx * dx + ry * dy + rz * dz) / dd, 0, 1) : 0;
        const cx = rx + dx * t, cy = ry + dy * t, cz = rz + dz * t;
        const reach = (a.radius + b.radius) * CLASH_RADIUS_SCALE;
        if (cx * cx + cy * cy + cz * cz > reach * reach) continue;
        this.clash(a, b);
        i = -1; // the list changed; rescan
        break;
      }
    }
  }

  /** Two spells collide mid-air. The bigger one survives, weakened by what it beat. */
  private clash(a: Projectile, b: Projectile): void {
    const pos = tmpPoint.addVectors(a.pos, b.pos).multiplyScalar(0.5);
    const colorA = a.color;
    const colorB = b.color;
    const scale = clamp((a.power + b.power) / 3, 0.7, 2.5);
    let winner: Projectile | null = null;
    if (a.power === b.power) {
      if (a.kind === 'blast' || b.kind === 'blast') this.fx.explosion(pos, colorA, 2.2);
      this.pool.release(a);
      this.pool.release(b);
    } else {
      winner = a.power > b.power ? a : b;
      const loser = winner === a ? b : a;
      const before = winner.power;
      winner.power -= loser.power;
      winner.damage *= winner.power / before;
      winner.radius = (winner.kind === 'bolt' ? S.bolt.radius : S.blast.radius) * Math.max(0.5, Math.sqrt(winner.power / winner.basePower));
      winner.vel.multiplyScalar(CONFIG.clash.winnerSpeedKeep);
      winner.refreshLook();
      this.pool.release(loser);
    }
    this.fx.clash(pos, colorA, colorB, scale);
    feel.freeze(CONFIG.clash.hitStopMs);
    feel.shakeAt(pos, CONFIG.clash.shake);
    events.emit('clash', { pos: pos.clone(), winner: winner ? winner.kind : null });
  }

  // =================================================================== ultimate

  private updateWaves(dt: number): void {
    const U = S.ultimate;
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const wave = this.waves[i];
      const prev = wave.radius;
      wave.radius += U.waveSpeed * dt;

      for (const pillar of this.arena.pillars) {
        if (!pillar.alive || wave.hitPillars.has(pillar)) continue;
        const d = pillar.surfaceDistance(wave.origin.x, wave.origin.z);
        if (d > wave.radius) continue;
        wave.hitPillars.add(pillar);
        tmpPoint.copy(pillar.position).setY(1.5);
        pillar.damage(U.pillarDamage, tmpPoint);
      }

      for (const o of this.wizards) {
        if (o.side === wave.owner.side || !o.alive || wave.hitWizards.has(o)) continue;
        const d = Math.hypot(o.pos.x - wave.origin.x, o.pos.z - wave.origin.z) - o.radius;
        if (d > wave.radius) continue;
        wave.hitWizards.add(o);
        this.waveHit(wave, o);
      }

      // The wave sweeps enemy spells out of the air.
      const list = this.pool.active;
      for (let k = list.length - 1; k >= 0; k--) {
        const p = list[k];
        if (p.owner.side === wave.owner.side) continue;
        const d = Math.hypot(p.pos.x - wave.origin.x, p.pos.z - wave.origin.z);
        if (d > wave.radius + 0.3 || d < prev - 1.5) continue;
        this.fx.clash(p.pos, p.color, wave.owner.team.ultimate, 0.8);
        this.pool.release(p);
      }

      // Sparks riding the wavefront.
      tmpColor.setHex(wave.owner.team.ultimate);
      for (let k = 0; k < 10; k++) {
        const a = Math.random() * Math.PI * 2;
        this.fx.sparks.emit(
          wave.origin.x + Math.sin(a) * wave.radius, 0.2 + Math.random() * 2.5, wave.origin.z + Math.cos(a) * wave.radius,
          Math.sin(a) * 4, 2 + Math.random() * 3, Math.cos(a) * 4,
          tmpColor, 1.8, 0.22, 0.4, { drag: 2 },
        );
      }

      const t = wave.radius / U.maxRadius;
      if (wave.fx) this.spellFx.setWave(wave.fx, wave.origin, wave.radius, 1 - t * t);
      if (wave.radius >= U.maxRadius) {
        if (wave.fx) this.spellFx.releaseWave(wave.fx);
        this.waves.splice(i, 1);
      }
    }
  }

  private waveHit(wave: UltWave, o: Wizard): void {
    const U = S.ultimate;
    const chest = o.chest(new THREE.Vector3());
    // Rolling through it, or feet high enough above the ground as the wavefront passes underneath.
    if (o.invulnerable || o.airHeight >= CONFIG.wizard.jump.waveClearance) {
      this.callout(chest, 'EVADED', 'perfect');
      events.emit('dodgeEvade', { wizard: o, pos: chest });
      return;
    }
    tmpPoint.set(wave.origin.x, 1.2, wave.origin.z);
    if (!this.physics.lineOfSight(tmpPoint, chest)) {
      this.callout(chest, 'COVER', 'info');
      return;
    }
    let damage = U.damage;
    let knock = U.knockback;
    if (o.shielded) {
      damage *= U.shieldMultiplier;
      knock *= 0.4;
      o.visual.shieldImpact(false);
      this.callout(chest, 'BLOCK', 'block');
      events.emit('block', { wizard: o, pos: chest, perfect: false, spell: 'ultimate' });
    }
    tmpDir.subVectors(o.pos, wave.origin).setY(0);
    this.dealDamage(o, wave.owner, damage, chest, 'ultimate', tmpDir, knock);
    this.fx.impact(chest, null, wave.owner.team.ultimate, 2.2);
    feel.freeze(U.hitStopMs);
    feel.shakeAt(chest, 0.8);
  }

  // ===================================================================== damage

  /**
   * The single place damage is applied: source multiplier (boss tuning, god mode), immunity,
   * stats, ult charge, knockback, events, KO. Never between allies (a source on the target's side
   * other than the target itself deals nothing, with no event).
   */
  dealDamage(
    target: Wizard,
    source: Wizard | null,
    amount: number,
    point: THREE.Vector3,
    kind: DamageKind,
    knockDir?: THREE.Vector3,
    knockback = 0,
  ): number {
    if (!target.alive) return 0;
    if (source && source !== target && source.side === target.side) return 0;
    // Boss tuning and god mode, and Pump It's surge.
    if (source && source !== target) amount *= source.damageMultiplier * (source.pumped ? CONFIG.rewardSpells.pump.damageMultiplier : 1);
    if (target.immune || target.evolving) {
      // God mode or a transforming boss: the hit still reads (flash, sound, "IMMUNE" popup) but
      // removes no HP. God mode still takes the knockback; a transforming boss stands its ground.
      target.hitFlash = CONFIG.wizard.hitFlashTime;
      if (source && source !== target) source.stats.hits++;
      if (knockDir && knockback > 0 && !target.evolving) target.addKnockback(knockDir.x, knockDir.z, knockback);
      events.emit('damage', { target, source, amount: 0, point: point.clone(), kind });
      return 0;
    }
    const dealt = target.takeDamage(amount);
    if (dealt <= 0) return 0;
    if (source && source !== target) {
      source.stats.damageDealt += dealt;
      source.stats.hits++;
      // The ultimate never refills itself.
      if (kind !== 'ultimate') source.addUlt(dealt * S.ultimate.chargePerDamageDealt);
    }
    if (knockDir && knockback > 0) target.addKnockback(knockDir.x, knockDir.z, knockback);
    events.emit('damage', { target, source, amount: dealt, point: point.clone(), kind });
    if (!target.alive) {
      events.emit('ko', { loser: target, winner: source && source !== target ? source : null });
    }
    return dealt;
  }
}
