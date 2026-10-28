import { Vector3 } from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG, type TeamPalette } from '../config';
import { events } from '../core/events';
import { dampAngle } from '../core/math';
import type { Physics } from '../physics/Physics';
import type { PendingCast } from '../spells/types';
import type { ProjectileSkin } from '../campaign/levels';
import type { WizardVisual } from './WizardVisual';
import type { CastKind } from './muzzles';

export type ActionKey = 'bolt' | 'blast' | 'shield' | 'stun' | 'ultimate' | 'dodge' | 'jump';
export type CooldownKey = 'bolt' | 'blast' | 'shield' | 'stun' | 'dodge';

/** What a controller (keyboard, AI) wants the wizard to do this tick. */
export class WizardIntent {
  /** World-space XZ direction, length 0..1. */
  readonly move = new Vector3();
  sprint = false;
  /** Bolt auto-fires while held. */
  holdBolt = false;
  /** Desired facing yaw (radians). */
  facing = 0;
  /** Remaining buffer time per action; > 0 means "do this as soon as you can". */
  readonly buffered: Record<ActionKey, number> = { bolt: 0, blast: 0, shield: 0, stun: 0, ultimate: 0, dodge: 0, jump: 0 };

  press(action: ActionKey): void {
    this.buffered[action] = CONFIG.feel.inputBuffer;
  }

  wants(action: ActionKey): boolean {
    return this.buffered[action] > 0;
  }

  consume(action: ActionKey): void {
    this.buffered[action] = 0;
  }

  tick(dt: number): void {
    for (const k in this.buffered) {
      const key = k as ActionKey;
      if (this.buffered[key] > 0) this.buffered[key] = Math.max(0, this.buffered[key] - dt);
    }
  }

  clear(): void {
    this.move.set(0, 0, 0);
    this.sprint = false;
    this.holdBolt = false;
    for (const k in this.buffered) this.buffered[k as ActionKey] = 0;
  }
}

const W = CONFIG.wizard;
const J = W.jump;
const T = CONFIG.tickets;
const tmpMove = new Vector3();
const tmpTarget = new Vector3();
/** Below this the wizard counts as standing on the floor (y = 0). */
const FLOOR_EPS = 1e-3;

export class Wizard {
  readonly pos = new Vector3();
  readonly prevPos = new Vector3();
  readonly vel = new Vector3();
  readonly knock = new Vector3();
  /** Vertical velocity (m/s). `vel` stays horizontal. */
  vy = 0;
  /** Standing on the floor or a stump top. */
  grounded = true;
  /** Height of whatever is under the wizard: 0 for the floor, the top of a stump. */
  groundY = 0;
  /** Jump grace left after walking off a ledge. */
  private coyote = 0;
  /** Takeoff / touchdown counters, so per-frame visuals never miss one between ticks. */
  jumps = 0;
  landings = 0;
  /** Downward speed at the last touchdown (m/s). */
  landSpeed = 0;
  facing = 0;
  prevFacing = 0;
  /** Where spells are aimed (world space). Controllers update this. */
  readonly aimPoint = new Vector3();

  /** Per-wizard max health (campaign bosses scale it). Round resets refill to this. */
  maxHealth: number = W.maxHealth;
  health: number = W.maxHealth;
  mana = W.maxMana;
  ult = 0;
  private manaDelay = 0;
  /** Golden-ticket mana boost: seconds left (0 = none). Raises max mana and regen (src/arena/GoldenTickets.ts). */
  manaBoost = 0;

  readonly cd: Record<CooldownKey, number> = { bolt: 0, blast: 0, shield: 0, stun: 0, dodge: 0 };
  dodgeTime = 0;
  iframes = 0;
  readonly dodgeDir = new Vector3();
  stunTime = 0;
  /**
   * Seconds left of a campaign boss's transformation into its next stage (src/campaign/BossStages):
   * it can't move, act or be stunned, and hits deal no damage.
   */
  evolveTime = 0;
  shieldTime = 0;
  /** Seconds since the shield was raised (for the perfect-reflect window). */
  shieldAge = 0;
  cast: PendingCast | null = null;
  sprinting = false;
  /** Set when sprint ran dry; cleared once mana recovers past sprintRecoverMana. */
  private sprintExhausted = false;

  hitFlash = 0;
  /** 1 on release of a spell, decays to 0. Drives the cast animation. */
  castPulse = 0;
  /** Projectiles fired so far: picks the muzzle when a look alternates between several (castPoint). */
  muzzleTurn = 0;
  burnTimer = 0;
  burning = false;
  alive = true;
  ultAnnounced = false;

  readonly intent = new WizardIntent();
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  private centerY: number;
  /** Collision capsule (m). CONFIG.wizard's for everyone but short bosses (see setHitbox). */
  radius: number = W.radius;
  height: number = W.height;
  /** Whether the collider currently blocks anything (a KO'd wizard doesn't). */
  private solid = true;
  /** False while this wizard sits out the fight (a boss partner outside its double fight). */
  private enabled = true;

  readonly stats = { damageDealt: 0, casts: 0, hits: 0, perfects: 0, dodges: 0 };

  /** Multiplies all damage this wizard deals (boss tuning, god mode). Applied in SpellSystem.dealDamage. */
  damageMultiplier = 1;
  /** Multiplies the clash power of this wizard's projectiles (god mode). */
  clashPowerMultiplier = 1;
  /** Takes no damage and can't be stunned (god mode). Hits still flash and knock back. */
  immune = false;
  /** Mana never runs out (god mode): spells cost nothing and sprint never exhausts. */
  infiniteMana = false;
  /** No spell cooldowns (god mode): Blast, Shield and Stun are ready at once, the Ultimate stays charged. */
  noCooldowns = false;
  /**
   * What this wizard's bolts and blasts look like in flight (boss objects: rugs, phones, bullets...).
   * Read from the caster at launch, so any wizard can throw objects. null = the spell orb.
   */
  skins: Readonly<{ bolt: ProjectileSkin; blast: ProjectileSkin }> | null = null;

  constructor(
    readonly index: number,
    /**
     * Team: 0 the player, 1 the enemies (the rival, or both bosses of a double fight). Spells never
     * hurt, stun, push, block or clash with their own side.
     */
    readonly side: 0 | 1,
    /** Robe and spell colours. Mutable: campaign bosses re-skin the rival (see Game.setupEnemy). */
    public team: TeamPalette,
    public name: string,
    readonly visual: WizardVisual,
    private readonly physics: Physics,
  ) {
    const p = physics.addWizard(W.radius, W.height, this);
    this.body = p.body;
    this.collider = p.collider;
    this.centerY = p.centerY;
  }

  get dodging(): boolean {
    return this.dodgeTime > 0;
  }
  get invulnerable(): boolean {
    return this.iframes > 0;
  }
  get stunned(): boolean {
    return this.stunTime > 0;
  }
  /** Mid-transformation (campaign bosses): frozen and immune. */
  get evolving(): boolean {
    return this.evolveTime > 0;
  }
  get shielded(): boolean {
    return this.shieldTime > 0;
  }
  /** Mana cap: the normal max, raised while a golden-ticket boost lasts. */
  get maxMana(): number {
    return this.manaBoost > 0 ? W.maxMana * T.maxManaMultiplier : W.maxMana;
  }
  /** Feet height above whatever is underneath (0 when grounded). */
  get airHeight(): number {
    return this.grounded ? 0 : Math.max(0, this.pos.y - this.groundY);
  }
  /** Can leave the ground: standing, or just walked off a ledge (coyote time). No double jump. */
  get canJump(): boolean {
    return this.alive && !this.stunned && !this.evolving && !this.dodging && (this.grounded || this.coyote > 0);
  }
  /** Can start a new action (cast/dodge). */
  get canAct(): boolean {
    return this.alive && !this.stunned && !this.evolving && !this.dodging && this.cast === null;
  }

  /** Height relative to a standard wizard (1 = CONFIG.wizard.height). Aim points scale with it. */
  get sizeScale(): number {
    return this.height / W.height;
  }

  /** Centre of the body: where spells aim and popups spawn (1.2 m up on a standard wizard). */
  chest(out: Vector3): Vector3 {
    return out.set(this.pos.x, this.pos.y + 1.2 * this.sizeScale, this.pos.z);
  }

  /** Height of the shield bubble's centre above the feet. */
  get shieldCenterY(): number {
    return 1.0 * this.sizeScale;
  }

  /** Lowest height above the feet for the HUD health tag (it also clears the model's top). */
  get tagHeight(): number {
    return 2.45 * this.sizeScale;
  }

  /**
   * Resize the collision capsule (a short boss partner). Chest, wand tip, shield and HUD tag
   * follow `height`; every spell and the character controller use the new capsule.
   */
  setHitbox(radius: number, height: number): void {
    if (radius === this.radius && height === this.height) return;
    this.radius = radius;
    this.height = height;
    this.centerY = this.physics.resizeWizard(this.collider, radius, height);
    this.placeBody();
  }

  /** In the fight, or parked (a boss partner between double fights): a parked wizard collides with nothing. */
  get active(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.alive = false;
      this.cast = null;
      this.shieldTime = this.stunTime = this.evolveTime = 0;
      this.intent.clear();
      this.pos.set(0, -50, 0);
      this.prevPos.copy(this.pos);
      this.vel.set(0, 0, 0);
      this.knock.set(0, 0, 0);
      this.placeBody();
    }
    this.syncSolid();
  }

  /** Keep the collider in step with alive/enabled: KO'd wizards don't block shots or movement. */
  private syncSolid(): void {
    const solid = this.alive && this.enabled;
    if (solid === this.solid && this.collider.isEnabled() === this.enabled) return;
    this.solid = solid;
    this.physics.setWizardSolid(this.collider, solid, this.enabled);
  }

  forward(out: Vector3): Vector3 {
    return out.set(Math.sin(this.facing), 0, Math.cos(this.facing));
  }

  /** Which of the look's muzzles the next `kind` leaves from (WizardVisual muzzles), or -1 for the generic wand. */
  muzzleIndex(kind: CastKind): number {
    return this.visual.muzzleIndex(kind, this.muzzleTurn);
  }

  /**
   * Where `kind` leaves this wizard, in world space: the current look's muzzle (the staff orb, a
   * phone, the vape, a gun barrel, Tinubu's palm or mouth), turned by the facing, scaled by the
   * look's stage scale (BossStages' `visual.root.scale`) and lifted with the feet (jumps, stumps).
   * Looks without muzzle data fall back to the generic wand offset in front of the right hand,
   * scaled with the body. `index` picks a muzzle (default: the one `kind` uses next).
   * Pure simulation state: the procedural lean/bob/squash of the render pose is not included.
   */
  castPoint(kind: CastKind, out: Vector3, index = this.muzzleIndex(kind)): Vector3 {
    const v = this.visual;
    if (index >= 0 && v.muzzles && index < v.muzzles.points.length) v.muzzlePoint(index, out);
    else {
      const k = this.sizeScale;
      out.set(-0.34 * k, 1.36 * k, 0.72 * k);
    }
    const scale = v.root.scale.x;
    const lx = out.x * scale, ly = out.y * scale, lz = out.z * scale;
    const s = Math.sin(this.facing), c = Math.cos(this.facing);
    return out.set(this.pos.x + lx * c + lz * s, this.pos.y + ly, this.pos.z - lx * s + lz * c);
  }

  /** A projectile left the current muzzle: the next one alternates (a phone in each hand). */
  advanceMuzzle(): void {
    this.muzzleTurn++;
  }

  /** The bolt's cast point (older name for `castPoint('bolt', out)`). */
  wandTip(out: Vector3): Vector3 {
    return this.castPoint('bolt', out);
  }

  spawn(x: number, z: number, facing: number): void {
    this.pos.set(x, 0, z);
    this.prevPos.copy(this.pos);
    this.facing = this.prevFacing = this.intent.facing = facing;
    this.vel.set(0, 0, 0);
    this.knock.set(0, 0, 0);
    this.vy = this.groundY = this.coyote = 0;
    this.grounded = true;
    this.placeBody();
    this.syncBody();
  }

  resetForRound(keepUlt: boolean): void {
    this.health = this.maxHealth;
    this.mana = W.maxMana;
    if (!keepUlt) this.ult = 0;
    this.ultAnnounced = this.ult >= CONFIG.spells.ultimate.chargeMax;
    this.manaDelay = this.manaBoost = 0;
    for (const k in this.cd) this.cd[k as CooldownKey] = 0;
    this.dodgeTime = this.iframes = this.stunTime = this.evolveTime = this.shieldTime = this.shieldAge = 0;
    this.cast = null;
    this.hitFlash = this.castPulse = this.burnTimer = 0;
    this.burning = false;
    this.sprintExhausted = false;
    this.alive = true;
    this.intent.clear();
    this.syncSolid();
  }

  resetStats(): void {
    this.stats.damageDealt = this.stats.casts = this.stats.hits = this.stats.perfects = this.stats.dodges = 0;
  }

  spendMana(amount: number): boolean {
    if (this.infiniteMana) return true;
    if (this.mana < amount) return false;
    this.mana -= amount;
    if (amount > 0) this.manaDelay = W.manaRegenDelay;
    return true;
  }

  addUlt(amount: number): void {
    const max = CONFIG.spells.ultimate.chargeMax;
    this.ult = Math.min(max, this.ult + amount);
    if (this.ult >= max && !this.ultAnnounced) {
      this.ultAnnounced = true;
      events.emit('ultReady', { wizard: this });
    }
  }

  /** Raw damage application (shields/i-frames are resolved by the caller). Returns HP removed. */
  takeDamage(amount: number): number {
    if (!this.alive) return 0;
    const dealt = Math.min(this.health, amount);
    this.health -= dealt;
    this.hitFlash = W.hitFlashTime;
    this.addUlt(dealt * CONFIG.spells.ultimate.chargePerDamageTaken);
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.cast = null;
      this.shieldTime = 0;
      this.syncSolid();
    }
    return dealt;
  }

  addKnockback(dirX: number, dirZ: number, speed: number): void {
    const l = Math.hypot(dirX, dirZ) || 1;
    this.knock.x += (dirX / l) * speed;
    this.knock.z += (dirZ / l) * speed;
  }

  applyStun(seconds: number): void {
    if (this.evolving || this.immune) return;
    this.stunTime = Math.max(this.stunTime, seconds);
    this.cast = null;
    this.vel.multiplyScalar(0.2);
  }

  /** Called once per fixed tick before movement. */
  updateTimers(dt: number): void {
    // Presses made mid-roll are held until the roll ends instead of expiring.
    this.intent.tick(this.dodging ? 0 : dt);
    for (const k in this.cd) {
      const key = k as CooldownKey;
      if (this.cd[key] > 0) this.cd[key] = Math.max(0, this.cd[key] - dt);
    }
    if (this.dodgeTime > 0) this.dodgeTime = Math.max(0, this.dodgeTime - dt);
    if (this.iframes > 0) this.iframes = Math.max(0, this.iframes - dt);
    if (this.stunTime > 0) this.stunTime = Math.max(0, this.stunTime - dt);
    if (this.evolveTime > 0) this.evolveTime = Math.max(0, this.evolveTime - dt);
    if (this.shieldTime > 0) {
      this.shieldTime = Math.max(0, this.shieldTime - dt);
      this.shieldAge += dt;
    }
    if (this.hitFlash > 0) this.hitFlash = Math.max(0, this.hitFlash - dt);
    if (this.castPulse > 0) this.castPulse = Math.max(0, this.castPulse - dt * 5);

    // Golden-ticket boost: faster regen with no delay; when it ends, mana clamps to the normal max.
    if (this.manaBoost > 0) {
      this.manaBoost = Math.max(0, this.manaBoost - dt);
      this.manaDelay = Math.min(this.manaDelay, T.regenDelay);
      if (this.manaBoost === 0) {
        this.mana = Math.min(this.mana, W.maxMana);
        events.emit('manaBoostEnd', { wizard: this });
      }
    }
    const regen = this.manaBoost > 0 ? W.manaRegen * T.regenMultiplier : W.manaRegen;
    if (this.manaDelay > 0) this.manaDelay -= dt;
    else if (!this.sprinting) this.mana = Math.min(this.maxMana, this.mana + regen * dt);
    if (this.infiniteMana) this.mana = this.maxMana;
    if (this.noCooldowns) {
      this.cd.blast = this.cd.shield = this.cd.stun = 0;
      this.addUlt(CONFIG.spells.ultimate.chargeMax);
    }
  }

  /** Movement, dodge and knockback integration through the character controller. */
  updateMovement(dt: number, physics: Physics): void {
    this.prevPos.copy(this.pos);
    this.prevFacing = this.facing;
    const intent = this.intent;
    const frozen = this.stunned || this.evolving;

    if (this.alive && !frozen) {
      this.facing = dampAngle(this.facing, intent.facing, 30, dt);
    }

    // Start a dodge roll. Cancels any windup: rolling out of a cast should always be possible.
    // Rolls need footing: in the air the press stays buffered and fires if you land in time.
    const footing = this.grounded || this.coyote > 0;
    if (intent.wants('dodge') && footing && this.alive && !frozen && !this.dodging && this.cd.dodge <= 0) {
      intent.consume('dodge');
      const dir = tmpMove.copy(intent.move);
      if (dir.lengthSq() < 0.01) this.forward(dir).negate();
      dir.y = 0;
      this.dodgeDir.copy(dir.normalize());
      this.dodgeTime = W.dodge.duration;
      this.iframes = W.dodge.iframes;
      this.cd.dodge = W.dodge.duration + W.dodge.cooldown;
      this.cast = null;
      this.stats.dodges++;
      events.emit('dodge', { wizard: this });
    }

    // Jump. Casting continues through it; a press during a roll waits for the roll to end.
    if (intent.wants('jump') && this.canJump) {
      intent.consume('jump');
      this.vy = J.velocity;
      this.grounded = false;
      this.coyote = 0;
      this.jumps++;
      events.emit('jump', { wizard: this, pos: this.pos });
    }

    this.sprinting = false;
    if (!this.alive || frozen) {
      tmpTarget.set(0, 0, 0);
      this.vel.lerp(tmpTarget, 1 - Math.exp(-12 * dt));
    } else if (this.dodging) {
      const t = 1 - this.dodgeTime / W.dodge.duration; // 0 -> 1
      const speed = W.dodge.speed * (1 - 0.55 * t * t);
      this.vel.copy(this.dodgeDir).multiplyScalar(speed);
    } else {
      let speed = W.moveSpeed;
      const moving = intent.move.lengthSq() > 0.01;
      if (this.sprintExhausted && this.mana >= W.sprintRecoverMana) this.sprintExhausted = false;
      if (intent.sprint && moving && this.cast === null && !this.sprintExhausted) {
        speed = W.sprintSpeed;
        this.sprinting = true;
        this.mana = Math.max(0, this.mana - W.sprintManaPerSecond * dt);
        this.manaDelay = W.manaRegenDelay;
        if (this.mana <= 0) this.sprintExhausted = true;
      }
      if (this.cast) speed *= W.castMoveMultiplier;
      tmpTarget.copy(intent.move).multiplyScalar(speed);
      let rate = moving ? W.acceleration : W.deceleration;
      // Reduced air control: steer a little, and momentum mostly carries without input.
      if (!this.grounded) rate *= moving ? J.airControl : J.airBrake;
      // Move velocity toward target at a fixed rate: crisp starts and stops.
      tmpMove.subVectors(tmpTarget, this.vel);
      const len = tmpMove.length();
      const step = rate * dt;
      if (len <= step) this.vel.copy(tmpTarget);
      else this.vel.addScaledVector(tmpMove, step / len);
    }

    this.knock.multiplyScalar(Math.exp(-W.knockbackDamping * dt));
    tmpMove.copy(this.vel).add(this.knock).multiplyScalar(dt);

    // Vertical: exact constant-gravity step in the air; on a raised surface, a short probe down
    // to notice walking off it. The floor is the plane y = 0.
    let dy = 0;
    if (!this.grounded) {
      dy = this.vy * dt - 0.5 * J.gravity * dt * dt;
      this.vy = Math.max(-J.maxFallSpeed, this.vy - J.gravity * dt);
    } else if (this.pos.y > FLOOR_EPS) {
      dy = -J.groundProbe;
    }
    if (this.pos.y + dy < 0) dy = -this.pos.y;
    tmpMove.y = dy;

    physics.moveCharacter(this.collider, tmpMove, tmpTarget);
    this.pos.x += tmpTarget.x;
    this.pos.z += tmpTarget.z;
    this.pos.y = Math.max(0, this.pos.y + tmpTarget.y);
    this.updateFooting(dt, dy, tmpTarget.y, physics);
    this.syncBody();
  }

  /** Ground contact after a move: landing, walking off ledges, coyote time, heads. */
  private updateFooting(dt: number, dy: number, movedY: number, physics: Physics): void {
    const support = physics.support;
    const wasGrounded = this.grounded;
    const onFloor = this.pos.y <= FLOOR_EPS && dy <= 0;
    if (onFloor) this.pos.y = 0;
    this.grounded = onFloor || (dy <= 0 && support.grounded);

    if (support.onWizard) {
      // Nobody stands on heads: stop sinking into it and slide off sideways.
      const o = support.onWizard;
      tmpMove.set(this.pos.x - o.pos.x, 0, this.pos.z - o.pos.z);
      if (tmpMove.lengthSq() < 1e-6) this.forward(tmpMove);
      tmpMove.normalize();
      const along = this.knock.x * tmpMove.x + this.knock.z * tmpMove.z;
      if (along < J.headSlide) this.knock.addScaledVector(tmpMove, J.headSlide - along);
      if (this.vy < 0) this.vy = 0;
    } else if (dy > 0 && movedY < dy * 0.5) {
      this.vy = Math.min(this.vy, 0); // bumped into something above
    }

    if (this.grounded) {
      if (!wasGrounded) {
        this.landSpeed = Math.max(0, -this.vy);
        this.landings++;
        events.emit('land', { wizard: this, pos: this.pos, speed: this.landSpeed });
      }
      this.vy = 0;
      this.coyote = J.coyoteTime;
      this.groundY = this.pos.y;
    } else {
      // Walking off a ledge starts the fall from rest; the coyote window counts down.
      if (this.coyote > 0) this.coyote = Math.max(0, this.coyote - dt);
      this.groundY = physics.groundHeightBelow(this.pos, this.radius * 0.9);
    }
  }

  syncBody(): void {
    this.body.setNextKinematicTranslation({ x: this.pos.x, y: this.centerY + this.pos.y, z: this.pos.z });
  }

  /** Teleport the physics body immediately (round resets). */
  placeBody(): void {
    this.body.setTranslation({ x: this.pos.x, y: this.centerY + this.pos.y, z: this.pos.z }, true);
  }
}
