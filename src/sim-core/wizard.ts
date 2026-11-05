/**
 * A wizard in the sim: the deterministic port of src/wizard/Wizard.ts (state, timers, mana,
 * movement, jumps, dodge rolls, Momentum blinks, knockback) in fixed point. Spells live in spells.ts.
 */
import { CONFIG } from '../config';
import type { SimArena, Body } from './arena';
import {
  DT, ONE, QUARTER, abs, atan2, clamp, cos, fx, len2, max, min, mul, muldiv, sec, setLength2, sin, vt, type V3,
} from './fixed';
import type { SimEvents } from './events';

const W = CONFIG.wizard;
const J = W.jump;
const T = CONFIG.tickets;

/** Every action a frame can press, in intent-frame bit order (src/net/intent.ts ACTION_BITS). */
export const ACTIONS = ['bolt', 'blast', 'shield', 'stun', 'ultimate', 'dodge', 'jump', 'carpet', 'pump', 'vape', 'lockon', 'breath'] as const;
export type Action = (typeof ACTIONS)[number];
export const A_BOLT = 0, A_BLAST = 1, A_SHIELD = 2, A_STUN = 3, A_ULT = 4, A_DODGE = 5, A_JUMP = 6;
export const A_CARPET = 7, A_PUMP = 8, A_VAPE = 9, A_LOCKON = 10, A_BREATH = 11;
export const ACTION_COUNT = 12;

/** Cooldowns in wire order (src/net/state.ts COOLDOWNS). */
export const CD_BOLT = 0, CD_BLAST = 1, CD_SHIELD = 2, CD_STUN = 3, CD_DODGE = 4, CD_BLINK = 5;

export const HELD_BOLT = 1;
export const HELD_SPRINT = 2;

/**
 * One tick of one seat's input, already quantized (this is exactly what the input log stores).
 *
 * Movement, held buttons and presses apply every tick. Facing and aim are read lazily: the sim
 * pulls them only on ticks where something uses them (a spell leaving the muzzle, a roll with no
 * direction, a boss flash checking where you look), and the log keeps them only for those ticks.
 * See docs/SERVER-SIM.md "Input log".
 */
export interface SimInput {
  /** 0: no move; else 1 + (direction 0..31 << 2 | magnitude 0..3): 32 directions, 1/4..4/4 speed. */
  move: number;
  /** HELD_BOLT | HELD_SPRINT. */
  held: number;
  /** One bit per ACTIONS entry: pressed this tick. */
  press: number;
  /** Facing yaw in 1/1024 turn (0..1023). */
  facing: number;
  /** Aim from the chest: yaw 1/1024 turn (0..1023), pitch 1/1024 turn (-256..256), distance bucket (0..31). */
  aimYaw: number;
  aimPitch: number;
  aimDist: number;
  /** Replay only: whether this tick carries facing / aim (live input always does). */
  noFacing?: boolean;
  noAim?: boolean;
}

export function emptyInput(): SimInput {
  return { move: 0, held: 0, press: 0, facing: 0, aimYaw: 0, aimPitch: 0, aimDist: 0 };
}

/** Aim distance buckets (Q16 m): 0.5 m x 1.25^k, k = 0..31 (0.5 m to ~500 m). */
export const AIM_DIST: readonly number[] = (() => {
  const out: number[] = [];
  let d = fx(0.5);
  for (let k = 0; k < 32; k++) {
    out.push(d);
    d = mul(d, fx(1.25));
  }
  return out;
})();

/** Move code to a Q16 direction vector (length 1/4..1). */
export function moveVector(code: number, out: { x: number; z: number }): void {
  if (code <= 0 || code > 128) {
    out.x = out.z = 0;
    return;
  }
  const c = code - 1;
  const a = (c >> 2) * 2048;
  const mag = ((c & 3) + 1) * (ONE >> 2);
  out.x = mul(sin(a), mag);
  out.z = mul(cos(a), mag);
}

/** Gameplay fields of a staff (src/staff/catalog.ts), in sim units. */
export interface StaffStats {
  id: string;
  /** Bolt damage multiplier (Q16). */
  boltDamage: number;
  /** Bolt fire interval multiplier (Q16). */
  boltInterval: number;
  /** Bolt knockback (Q16 m/s), or -1 for the stock bolt. */
  boltKnockback: number;
  blink: { dist: number; travel: number; iframes: number; cooldown: number; trailDps: number; trailTime: number; trailWidth: number } | null;
}

/** A muzzle in the look's frame (Q16 m: x the look's left, y up, z forward). */
export interface Muzzle {
  x: number;
  y: number;
  z: number;
}

/** Where a look's spells leave from, per cast kind (alternating through a list). */
export interface MuzzleSet {
  points: Muzzle[];
  bolt: number[];
  volley: number[];
  blast: number[];
  stun: number[];
  ultimate: number[];
}

export type CastKind = 'bolt' | 'volley' | 'blast' | 'stun' | 'ultimate';

export interface PendingCast {
  spell: 'blast' | 'stun' | 'ultimate';
  elapsed: number;
  duration: number;
}

export interface WizardStats {
  damageDealt: number;
  casts: number;
  hits: number;
  perfects: number;
  dodges: number;
}

const ACCEL = fx(W.acceleration);
const DECEL = fx(W.deceleration);
const MOVE = fx(W.moveSpeed);
const SPRINT = fx(W.sprintSpeed);
const SPRINT_MANA = fx(W.sprintManaPerSecond);
const SPRINT_RECOVER = fx(W.sprintRecoverMana);
const CAST_MOVE = fx(W.castMoveMultiplier);
const MAX_MANA = fx(W.maxMana);
const REGEN = fx(W.manaRegen);
const REGEN_DELAY = sec(W.manaRegenDelay);
const HIT_FLASH = sec(W.hitFlashTime);
const DODGE_SPEED = fx(W.dodge.speed);
const DODGE_TIME = sec(W.dodge.duration);
const DODGE_IFRAMES = sec(W.dodge.iframes);
const DODGE_CD = sec(W.dodge.duration + W.dodge.cooldown);
const JUMP_V = fx(J.velocity);
const GRAVITY = fx(J.gravity);
const MAX_FALL = fx(J.maxFallSpeed);
const AIR_CONTROL = fx(J.airControl);
const AIR_BRAKE = fx(J.airBrake);
const COYOTE = sec(J.coyoteTime);
const GROUND_PROBE = fx(J.groundProbe);
const HEAD_SLIDE = fx(J.headSlide);
const ULT_MAX = fx(CONFIG.spells.ultimate.chargeMax);
const ULT_PER_TAKEN = fx(CONFIG.spells.ultimate.chargePerDamageTaken);
const BOOST_MAX_MANA = mul(MAX_MANA, fx(T.maxManaMultiplier));
const BOOST_REGEN = mul(REGEN, fx(T.regenMultiplier));
const BOOST_DELAY = sec(T.regenDelay);
const INPUT_BUFFER = sec(CONFIG.feel.inputBuffer);
/** exp(-knockbackDamping dt) per tick. */
const KNOCK_DECAY = 57835;
/** 1 - exp(-12 dt): a frozen wizard's velocity bleed per tick. */
const FROZEN_DECAY = 11880;
/** Below this the wizard counts as standing on the floor (Wizard FLOOR_EPS). */
const FLOOR_EPS = fx(1e-3);
const STD_HEIGHT = fx(W.height);
/** Scratch objects for hot paths (never held across calls). */
const SCRATCH_MV = { x: 0, z: 0 };
const SCRATCH_AT = { x: 0, z: 0 };
const SCRATCH_DIR = { x: 0, y: 0, z: 0 };
const CHEST = fx(1.2);
const RS = CONFIG.rewardSpells;
const CARPET_TIME = sec(RS.carpet.duration);
const CARPET_SPEED = fx(RS.carpet.speedMultiplier);
const CARPET_BOOST = fx(RS.carpet.boost);
const CARPET_BOOST_TIME = sec(RS.carpet.boostTime);
const CARPET_ACCEL = fx(RS.carpet.acceleration);
const CARPET_DECEL = fx(RS.carpet.deceleration);
const CARPET_LEAP = fx(RS.carpet.leap);
const CARPET_HOVER = fx(RS.carpet.hover);
const CARPET_CLIMB = fx(RS.carpet.climb);
const CARPET_RISE = fx(RS.carpet.rise);
const CARPET_SINK = fx(RS.carpet.sink);
/** Look-ahead (s) as a Q16 fraction of a second: reach = radius + speed x look. */
const CARPET_LOOK = fx(RS.carpet.lookAhead);
const BREATH_MOVE = fx(RS.breath.moveMultiplier);
const FL = CONFIG.campaign.flight;
const FLY_CLIMB = fx(FL.climb);
const FLY_RISE = fx(FL.rise);
const FLY_SINK = fx(FL.sink);
const FLY_LOOK = fx(FL.lookAhead);
const FLY_BOB = fx(FL.bob);
/** Bob rate in angle units per second. */
const FLY_BOB_RATE = Math.round((FL.bobRate / (2 * Math.PI)) * 65536);
/** Where along the look-ahead to check for low cover (Wizard LOOK_STEPS). */
const LOOK_STEPS = [fx(0.3), fx(0.6), ONE];
const PUMP_ULT = fx(CONFIG.rewardSpells.pump.ultChargeMultiplier);
const K_0_02 = fx(0.02);
const K_0_1 = fx(0.1);
const K_0_55 = fx(0.55);
const K_0_15 = fx(0.15);
const K_0_9 = fx(0.9);
const K_0_2 = fx(0.2);
const K_WAND_X = fx(-0.34);
const K_WAND_Y = fx(1.36);
const K_WAND_Z = fx(0.72);

export class SimWizard {
  readonly pos: V3 = { x: 0, y: 0, z: 0 };
  readonly vel: V3 = { x: 0, y: 0, z: 0 };
  readonly knock: V3 = { x: 0, y: 0, z: 0 };
  vy = 0;
  grounded = true;
  groundY = 0;
  coyote = 0;
  jumps = 0;
  landings = 0;
  landSpeed = 0;
  facing = 0;
  /** Aim point (Q16 world): set by an AI, or rebuilt from the input when read. */
  readonly aim: V3 = { x: 0, y: 0, z: 0 };
  /** Driven by the sim's own AI: facing and aim are set directly, never read from input. */
  ai = false;
  /** This tick's raw facing / aim input, and whether the sim read them (the log keeps those). */
  inFacing = 0;
  inAimYaw = 0;
  inAimPitch = 0;
  inAimDist = 0;
  inNoFacing = false;
  inNoAim = false;
  facingRead = false;
  aimRead = false;
  /** Set when the sim needed a facing or aim the replayed log did not carry. */
  missingInput = false;

  maxHealth = fx(W.maxHealth);
  health = fx(W.maxHealth);
  mana = MAX_MANA;
  ult = 0;
  manaDelay = 0;
  manaBoost = 0;
  /** Cooldowns (TU) by CD_* index. */
  readonly cd = [0, 0, 0, 0, 0, 0];
  dodgeTime = 0;
  iframes = 0;
  readonly dodgeDir: V3 = { x: 0, y: 0, z: 0 };
  blinkTime = 0;
  blinkDuration = 0;
  readonly blinkFrom: V3 = { x: 0, y: 0, z: 0 };
  readonly blinkTo: V3 = { x: 0, y: 0, z: 0 };
  stunTime = 0;
  evolveTime = 0;
  shieldTime = 0;
  shieldAge = 0;
  cast: PendingCast | null = null;
  sprinting = false;
  sprintExhausted = false;
  hitFlash = 0;
  castPulse = 0;
  sinceAttack = 1e9;
  muzzleTurn = 0;
  burnTimer = 0;
  burning = false;
  alive = true;
  /** In the fight (a parked partner is not). */
  active = true;
  ultAnnounced = false;

  /** Intent for this tick. */
  moveX = 0;
  moveZ = 0;
  sprint = false;
  holdBolt = false;
  /** Remaining buffer (TU) per action. */
  readonly buffered = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

  radius = fx(W.radius);
  height = fx(W.height);
  /** Height relative to a standard wizard (Q16) and the chest height, kept in step by setHitbox. */
  sizeScale = ONE;
  chestY = CHEST;
  /** Look-frame scale (a boss stage grows; Q16). */
  lookScale = ONE;
  staff: StaffStats | null = null;
  muzzles: MuzzleSet | null = null;

  readonly stats: WizardStats = { damageDealt: 0, casts: 0, hits: 0, perfects: 0, dodges: 0 };
  damageMultiplier = ONE;
  spellDamageScale = ONE;
  speedMultiplier = ONE;
  groundSlow = ONE;
  clashPowerMultiplier = ONE;
  ultChargeMultiplier = ONE;
  immune = false;
  infiniteMana = false;
  noCooldowns = false;
  /** A blink started: the world lays its trail (SpellSystem's blink listener). */
  onBlink: ((w: SimWizard) => void) | null = null;
  /** A boss with another stage left keeps standing at 0 HP (BossStages). */
  koGuard: (() => boolean) | null = null;
  /** Boss reward spells this wizard may cast: bit i = REWARDS[i] (only the player ever has any). */
  learned = 0;
  /** Reward spell cooldowns (TU) by REWARDS index, started on cast. */
  readonly rcd = [0, 0, 0, 0, 0];
  /** Seconds (TU) left riding the Magic Carpet, of Pump It, of Lock-On, channelling Hellfire Breath. */
  carpetTime = 0;
  pumpTime = 0;
  lockTime = 0;
  breathTime = 0;
  /** Burning from Hellfire Breath: TU left, who lit it (index, -1 none), TU to the next tick. */
  scorchTime = 0;
  scorchBy = -1;
  scorchTimer = 0;
  /** Hover height of a flying boss stage (0 walks), and the bob clock (TU). */
  flyHeight = 0;
  flyClock = 0;

  constructor(
    readonly index: number,
    readonly side: 0 | 1,
    private readonly events: SimEvents,
  ) {}

  get dodging(): boolean {
    return this.dodgeTime > 0;
  }
  get blinking(): boolean {
    return this.blinkTime > 0;
  }
  get invulnerable(): boolean {
    return this.iframes > 0;
  }
  get stunned(): boolean {
    return this.stunTime > 0;
  }
  get evolving(): boolean {
    return this.evolveTime > 0;
  }
  get shielded(): boolean {
    return this.shieldTime > 0;
  }
  get riding(): boolean {
    return this.carpetTime > 0;
  }
  get pumped(): boolean {
    return this.pumpTime > 0;
  }
  get breathing(): boolean {
    return this.breathTime > 0;
  }
  get lockedOn(): boolean {
    return this.lockTime > 0;
  }
  get scorched(): boolean {
    return this.scorchTime > 0;
  }
  knows(spell: number): boolean {
    return (this.learned & (1 << spell)) !== 0;
  }
  get flying(): boolean {
    return this.flyHeight > 0 && this.alive && !this.stunned;
  }
  get fireproof(): boolean {
    return this.riding || this.flying;
  }
  get maxMana(): number {
    return this.manaBoost > 0 ? BOOST_MAX_MANA : MAX_MANA;
  }
  get airHeight(): number {
    return this.grounded ? 0 : max(0, this.pos.y - this.groundY);
  }
  get canJump(): boolean {
    return this.alive && !this.stunned && !this.evolving && !this.dodging && !this.riding && !this.flying && (this.grounded || this.coyote > 0);
  }
  get canAct(): boolean {
    return this.alive && !this.stunned && !this.evolving && !this.dodging && !this.blinking && this.cast === null && !this.riding && !this.breathing;
  }
  /** Resize the collision cylinder (a short boss): chest, muzzle and shield follow. */
  setHitbox(radius: number, height: number): void {
    this.radius = radius;
    this.height = height;
    this.sizeScale = muldiv(height, ONE, STD_HEIGHT);
    this.chestY = mul(CHEST, this.sizeScale);
  }
  get shieldCenterY(): number {
    return this.sizeScale;
  }

  /** Press an action now (the sim's AI; inputs do it through applyInput). */
  press(a: number): void {
    this.buffered[a] = INPUT_BUFFER;
  }

  wants(a: number): boolean {
    return this.buffered[a] > 0;
  }
  consume(a: number): void {
    this.buffered[a] = 0;
  }

  /** Apply one tick of input (presses buffer for CONFIG.feel.inputBuffer). */
  applyInput(f: SimInput): void {
    const mv = SCRATCH_MV;
    moveVector(f.move, mv);
    this.moveX = mv.x;
    this.moveZ = mv.z;
    this.holdBolt = (f.held & HELD_BOLT) !== 0;
    this.sprint = (f.held & HELD_SPRINT) !== 0;
    for (let i = 0; i < ACTION_COUNT; i++) if (f.press & (1 << i)) this.buffered[i] = INPUT_BUFFER;
    this.latch(f);
  }

  /** Take this tick's facing / aim input without the rest (locked phases). */
  latch(f: SimInput | null): void {
    this.facingRead = this.aimRead = false;
    if (!f) {
      this.inNoFacing = this.inNoAim = true;
      return;
    }
    this.inFacing = f.facing & 1023;
    this.inAimYaw = f.aimYaw & 1023;
    this.inAimPitch = clamp(f.aimPitch | 0, -256, 256);
    this.inAimDist = clamp(f.aimDist | 0, 0, 31);
    this.inNoFacing = !!f.noFacing;
    this.inNoAim = !!f.noAim;
  }

  /** Locked phases (countdown, round end): no movement, buttons or buffered presses. */
  clearIntent(): void {
    this.moveX = this.moveZ = 0;
    this.sprint = this.holdBolt = false;
    for (let i = 0; i < ACTION_COUNT; i++) this.buffered[i] = 0;
  }

  /** The facing, pulled from this tick's input the first time anything needs it. */
  face(): number {
    if (this.ai || this.facingRead) return this.facing;
    this.facingRead = true;
    if (this.inNoFacing) this.missingInput = true;
    else this.facing = this.inFacing * 64;
    return this.facing;
  }

  /** The aim point, rebuilt from this tick's input (chest + direction x distance) when first needed. */
  aimPoint(): V3 {
    if (this.ai || this.aimRead) return this.aim;
    this.aimRead = true;
    if (this.inNoAim) {
      this.missingInput = true;
      return this.aim;
    }
    const yaw = this.inAimYaw * 64, pitch = this.inAimPitch * 64;
    const d = AIM_DIST[this.inAimDist];
    const h = mul(cos(pitch), d);
    this.aim.x = this.pos.x + mul(sin(yaw), h);
    this.aim.y = this.pos.y + this.chestY + mul(sin(pitch), d);
    this.aim.z = this.pos.z + mul(cos(yaw), h);
    return this.aim;
  }

  /** Q16 unit forward vector. */
  forwardX(): number {
    return sin(this.face());
  }
  forwardZ(): number {
    return cos(this.face());
  }

  muzzleIndex(kind: CastKind): number {
    const m = this.muzzles;
    if (!m) return -1;
    const list = m[kind];
    return list.length ? list[this.muzzleTurn % list.length] : -1;
  }

  /** Where `kind` leaves this wizard (static muzzle points, Wizard.castPoint). */
  castPoint(kind: CastKind, out: V3, index = this.muzzleIndex(kind)): V3 {
    let lx: number, ly: number, lz: number;
    const m = this.muzzles;
    if (m && index >= 0 && index < m.points.length) {
      const p = m.points[index];
      lx = p.x;
      ly = p.y;
      lz = p.z;
    } else {
      const k = this.sizeScale;
      lx = mul(K_WAND_X, k);
      ly = mul(K_WAND_Y, k);
      lz = mul(K_WAND_Z, k);
    }
    lx = mul(lx, this.lookScale);
    ly = mul(ly, this.lookScale);
    lz = mul(lz, this.lookScale);
    const f = this.face();
    const s = sin(f), c = cos(f);
    out.x = this.pos.x + mul(lx, c) + mul(lz, s);
    out.y = this.pos.y + ly;
    out.z = this.pos.z - mul(lx, s) + mul(lz, c);
    return out;
  }

  advanceMuzzle(): void {
    this.muzzleTurn++;
  }

  /** This wizard's query body (one reused object). */
  private readonly ownBody: Body = { index: 0, x: 0, y: 0, z: 0, r: 0, h: 0 };

  body(out: Body = this.ownBody): Body {
    out.index = this.index;
    out.x = this.pos.x;
    out.y = this.pos.y;
    out.z = this.pos.z;
    out.r = this.radius;
    out.h = this.height;
    return out;
  }

  spawn(x: number, z: number, facing: number): void {
    this.pos.x = x;
    this.pos.y = 0;
    this.pos.z = z;
    this.facing = facing & 0xffff;
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.knock.x = this.knock.y = this.knock.z = 0;
    this.vy = this.groundY = this.coyote = 0;
    this.grounded = true;
    this.carpetTime = this.breathTime = 0;
  }

  resetForRound(keepUlt: boolean): void {
    this.health = this.maxHealth;
    this.mana = MAX_MANA;
    if (!keepUlt) this.ult = 0;
    this.ultAnnounced = this.ult >= ULT_MAX;
    this.manaDelay = this.manaBoost = 0;
    this.groundSlow = ONE;
    for (let i = 0; i < this.cd.length; i++) this.cd[i] = 0;
    this.dodgeTime = this.blinkTime = this.iframes = this.stunTime = this.evolveTime = this.shieldTime = this.shieldAge = 0;
    this.cast = null;
    this.hitFlash = this.castPulse = this.burnTimer = 0;
    this.sinceAttack = 1e9;
    this.burning = false;
    this.sprintExhausted = false;
    for (let i = 0; i < this.rcd.length; i++) this.rcd[i] = 0;
    this.endRewardEffects();
    this.alive = true;
    this.clearIntent();
  }

  /** Every reward spell effect off at once (round reset, KO, parked). */
  endRewardEffects(): void {
    this.carpetTime = this.pumpTime = this.lockTime = this.breathTime = this.scorchTime = this.scorchTimer = 0;
    this.scorchBy = -1;
  }

  /** Step off the Magic Carpet now (time up, pressed again, stunned): fall from the hover height. */
  endRide(): void {
    this.carpetTime = 0;
    if (this.pos.y > FLOOR_EPS) {
      this.grounded = false;
      this.vy = 0;
      this.coyote = 0;
    }
    this.events.push('rewardEnd', this.index, 'carpet');
  }

  resetStats(): void {
    const s = this.stats;
    s.damageDealt = s.casts = s.hits = s.perfects = s.dodges = 0;
  }

  spendMana(amount: number): boolean {
    if (this.infiniteMana) return true;
    if (this.mana < amount) return false;
    this.mana -= amount;
    if (amount > 0) this.manaDelay = REGEN_DELAY;
    return true;
  }

  addUlt(amount: number): void {
    let a = mul(amount, this.ultChargeMultiplier);
    if (this.pumped) a = mul(a, PUMP_ULT);
    this.ult = min(ULT_MAX, this.ult + a);
    if (this.ult >= ULT_MAX && !this.ultAnnounced) {
      this.ultAnnounced = true;
      this.events.push('ultReady', this.index);
    }
  }

  /** Raw damage (shields and i-frames are resolved by the caller). Returns HP removed. */
  takeDamage(amount: number): number {
    if (!this.alive) return 0;
    const dealt = min(this.health, amount);
    this.health -= dealt;
    this.hitFlash = HIT_FLASH;
    this.addUlt(mul(dealt, ULT_PER_TAKEN));
    if (this.health <= 0) {
      this.health = 0;
      if (this.koGuard && this.koGuard()) return dealt;
      this.alive = false;
      this.cast = null;
      this.shieldTime = 0;
      this.endRewardEffects();
    }
    return dealt;
  }

  addKnockback(dx: number, dz: number, speed: number): void {
    let l = len2(dx, dz);
    if (l < 1) {
      // Math.hypot(...) || 1: a zero direction gives no push.
      l = ONE;
    }
    this.knock.x += muldiv(dx, speed, l);
    this.knock.z += muldiv(dz, speed, l);
  }

  applyStun(t: number): void {
    if (this.evolving || this.immune) return;
    this.stunTime = max(this.stunTime, t);
    this.cast = null;
    if (this.riding) this.endRide();
    this.breathTime = 0;
    this.vel.x = mul(this.vel.x, K_0_2);
    this.vel.z = mul(this.vel.z, K_0_2);
  }

  /** Once per tick before movement. */
  updateTimers(dt: number): void {
    const bdt = this.dodging || this.blinking ? 0 : dt;
    for (let i = 0; i < ACTION_COUNT; i++) if (this.buffered[i] > 0) this.buffered[i] = max(0, this.buffered[i] - bdt);
    for (let i = 0; i < this.cd.length; i++) if (this.cd[i] > 0) this.cd[i] = max(0, this.cd[i] - dt);
    if (this.dodgeTime > 0) this.dodgeTime = max(0, this.dodgeTime - dt);
    if (this.iframes > 0) this.iframes = max(0, this.iframes - dt);
    if (this.stunTime > 0) this.stunTime = max(0, this.stunTime - dt);
    if (this.evolveTime > 0) this.evolveTime = max(0, this.evolveTime - dt);
    if (this.shieldTime > 0) {
      this.shieldTime = max(0, this.shieldTime - dt);
      this.shieldAge += dt;
    }
    if (this.hitFlash > 0) this.hitFlash = max(0, this.hitFlash - dt);
    if (this.castPulse > 0) this.castPulse = max(0, this.castPulse - dt * 5);
    this.sinceAttack += dt;

    if (this.manaBoost > 0) {
      this.manaBoost = max(0, this.manaBoost - dt);
      this.manaDelay = min(this.manaDelay, BOOST_DELAY);
      if (this.manaBoost === 0) {
        this.mana = min(this.mana, MAX_MANA);
        this.events.push('manaBoostEnd', this.index);
      }
    }
    const regen = this.manaBoost > 0 ? BOOST_REGEN : REGEN;
    if (this.manaDelay > 0) this.manaDelay -= dt;
    else if (!this.sprinting) this.mana = min(this.maxMana, this.mana + vt(regen, dt));
    if (this.infiniteMana) this.mana = this.maxMana;
    if (this.noCooldowns) {
      this.cd[CD_BLAST] = this.cd[CD_SHIELD] = this.cd[CD_STUN] = 0;
      this.addUlt(ULT_MAX);
    }
    for (let i = 0; i < this.rcd.length; i++) if (this.rcd[i] > 0) this.rcd[i] = this.noCooldowns ? 0 : max(0, this.rcd[i] - dt);
    if (this.carpetTime > 0) {
      this.carpetTime = max(0, this.carpetTime - dt);
      if (this.carpetTime === 0) this.endRide();
    }
    if (this.pumpTime > 0) this.pumpTime = max(0, this.pumpTime - dt);
    if (this.lockTime > 0) this.lockTime = max(0, this.lockTime - dt);
    if (this.breathTime > 0) this.breathTime = max(0, this.breathTime - dt);
  }

  /** Momentum Staff: a swept dash along the unit direction (dx, dz). */
  private startBlink(dx: number, dz: number, arena: SimArena): void {
    const b = this.staff!.blink!;
    const dist = arena.sweepBody(this.pos.x, this.pos.y, this.pos.z, this.radius, this.height, dx, dz, b.dist);
    this.blinkFrom.x = this.pos.x;
    this.blinkFrom.y = this.pos.y;
    this.blinkFrom.z = this.pos.z;
    this.blinkTo.x = this.pos.x + mul(dx, dist);
    this.blinkTo.y = this.pos.y;
    this.blinkTo.z = this.pos.z + mul(dz, dist);
    this.blinkDuration = b.travel;
    this.blinkTime = b.travel;
    this.iframes = b.iframes;
    this.cd[CD_BLINK] = b.cooldown;
    this.dodgeDir.x = dx;
    this.dodgeDir.z = dz;
    this.cast = null;
    this.breathTime = 0;
    this.stats.dodges++;
    this.events.push('dodge', this.index);
    this.events.push('blink', this.index);
    if (this.onBlink) this.onBlink(this);
  }

  /** Movement, dodge and knockback through the sim's character controller. */
  updateMovement(dt: number, arena: SimArena, others: readonly SimWizard[]): void {
    const frozen = this.stunned || this.evolving;

    const footing = this.grounded || this.coyote > 0;
    const blinkReady = !!(this.staff && this.staff.blink) && this.sprint && this.cd[CD_BLINK] <= 0;
    if (this.wants(A_DODGE) && footing && this.alive && !frozen && !this.dodging && !this.blinking && !this.riding && (blinkReady || this.cd[CD_DODGE] <= 0)) {
      this.consume(A_DODGE);
      const dir = SCRATCH_DIR;
      dir.x = dir.y = dir.z = 0;
      // A move shorter than 0.1 rolls backwards (Wizard: lengthSq < 0.01).
      if (this.moveX * this.moveX + this.moveZ * this.moveZ < K_0_1 * K_0_1 || !setLength2(dir, this.moveX, this.moveZ, ONE)) {
        dir.x = -this.forwardX();
        dir.z = -this.forwardZ();
      }
      if (blinkReady) this.startBlink(dir.x, dir.z, arena);
      else {
        this.dodgeDir.x = dir.x;
        this.dodgeDir.z = dir.z;
        this.dodgeTime = DODGE_TIME;
        this.iframes = DODGE_IFRAMES;
        this.cd[CD_DODGE] = DODGE_CD;
        this.cast = null;
        this.breathTime = 0;
        this.stats.dodges++;
        this.events.push('dodge', this.index);
      }
    }

    // Jump off the Magic Carpet: a leap higher than a jump, keeping the carpet's speed.
    if (this.wants(A_JUMP) && this.riding && this.alive && !frozen) {
      this.consume(A_JUMP);
      this.endRide();
      this.vy = mul(JUMP_V, CARPET_LEAP);
      this.grounded = false;
      this.coyote = 0;
      this.jumps++;
      this.events.push('jump', this.index);
    }
    if (this.wants(A_JUMP) && this.canJump && !this.blinking) {
      this.consume(A_JUMP);
      this.vy = JUMP_V;
      this.grounded = false;
      this.coyote = 0;
      this.jumps++;
      this.events.push('jump', this.index);
    }

    this.sprinting = false;
    const moving = this.moveX * this.moveX + this.moveZ * this.moveZ > K_0_1 * K_0_1;
    if (!this.alive || frozen) {
      this.blinkTime = 0;
      this.vel.x -= mul(this.vel.x, FROZEN_DECAY);
      this.vel.z -= mul(this.vel.z, FROZEN_DECAY);
    } else if (this.blinking) {
      const step = min(dt, this.blinkTime);
      const u = this.blinkDuration > 0 ? ONE - muldiv(this.blinkTime - step, ONE, this.blinkDuration) : ONE;
      this.blinkTime -= step;
      const x = this.blinkFrom.x + mul(this.blinkTo.x - this.blinkFrom.x, u);
      const z = this.blinkFrom.z + mul(this.blinkTo.z - this.blinkFrom.z, u);
      this.vel.x = muldiv(x - this.pos.x, 6000, dt);
      this.vel.z = muldiv(z - this.pos.z, 6000, dt);
    } else if (this.dodging) {
      const t = ONE - muldiv(this.dodgeTime, ONE, DODGE_TIME);
      const speed = mul(DODGE_SPEED, ONE - mul(K_0_55, mul(t, t)));
      this.vel.x = mul(this.dodgeDir.x, speed);
      this.vel.z = mul(this.dodgeDir.z, speed);
    } else if (this.riding) {
      // Magic Carpet: much faster, snappy, no sprint (and no mana drain), a burst at takeoff.
      const boost = ONE + mul(CARPET_BOOST, clamp(muldiv(this.carpetTime - (CARPET_TIME - CARPET_BOOST_TIME), ONE, CARPET_BOOST_TIME), 0, ONE));
      const speed = mul(mul(MOVE, CARPET_SPEED), boost);
      approach(this.vel, mul(this.moveX, speed), mul(this.moveZ, speed), vt(moving ? CARPET_ACCEL : CARPET_DECEL, dt));
    } else {
      let speed = mul(MOVE, this.speedMultiplier);
      if (this.sprintExhausted && this.mana >= SPRINT_RECOVER) this.sprintExhausted = false;
      if (this.sprint && moving && this.cast === null && !this.sprintExhausted) {
        speed = mul(SPRINT, this.speedMultiplier);
        this.sprinting = true;
        this.mana = max(0, this.mana - vt(SPRINT_MANA, dt));
        this.manaDelay = REGEN_DELAY;
        if (this.mana <= 0) this.sprintExhausted = true;
      }
      if (this.cast) speed = mul(speed, CAST_MOVE);
      speed = mul(speed, this.groundSlow);
      if (this.breathing) {
        speed = mul(MOVE, BREATH_MOVE);
        this.sprinting = false;
      }
      const tx = mul(this.moveX, speed), tz = mul(this.moveZ, speed);
      let rate = mul(moving ? ACCEL : DECEL, this.speedMultiplier);
      if (!this.grounded) rate = mul(rate, moving ? AIR_CONTROL : AIR_BRAKE);
      approach(this.vel, tx, tz, vt(rate, dt));
    }

    this.knock.x = mul(this.knock.x, KNOCK_DECAY);
    this.knock.z = mul(this.knock.z, KNOCK_DECAY);
    const mx = vt(this.vel.x + this.knock.x, dt);
    const mz = vt(this.vel.z + this.knock.z, dt);

    let dy = 0;
    const riding = this.riding && this.alive && !frozen;
    const flying = !riding && this.flying && !this.evolving;
    if (riding) {
      dy = this.hoverStep(dt, arena, CARPET_HOVER, CARPET_CLIMB, CARPET_RISE, CARPET_SINK, CARPET_LOOK, false);
      this.vy = 0;
    } else if (flying) {
      this.flyClock += dt;
      dy = this.hoverStep(dt, arena, this.flyHeight + mul(sin(muldiv(this.flyClock, FLY_BOB_RATE, 6000)), FLY_BOB), FLY_CLIMB, FLY_RISE, FLY_SINK, FLY_LOOK, true);
      this.vy = 0;
    } else if (!this.grounded) {
      // Exact constant-gravity step: vy dt - g dt^2 / 2.
      dy = vt(this.vy, dt) - Math.floor(vt(vt(GRAVITY, dt), dt) / 2);
      this.vy = max(-MAX_FALL, this.vy - vt(GRAVITY, dt));
    } else if (this.pos.y > FLOOR_EPS) {
      dy = -GROUND_PROBE;
    }
    if (this.pos.y + dy < 0) dy = -this.pos.y;

    this.moveCharacter(mx, dy, mz, arena, others, dt, riding || flying);
  }

  /**
   * Vertical step for one hovering tick (the carpet, a flying boss stage): toward `hover` above the
   * highest surface under the wizard, or under the point ahead when that is low cover (at most
   * `climb` above what is underneath), so it swoops over rug piles and car hoods. Wizard.rideStep /
   * flyStep; `floorIfTall`: the flyer treats unclimbable cover below as the floor.
   */
  private hoverStep(dt: number, arena: SimArena, hover: number, climb: number, rise: number, sink: number, look: number, floorIfTall: boolean): number {
    const r = mul(this.radius, K_0_9);
    const under = arena.surfaceBelow(this.pos.x, this.pos.z, r, this.pos.y + K_0_02);
    let base = under >= 0 ? under : floorIfTall ? 0 : this.pos.y;
    const speed = len2(this.vel.x, this.vel.z);
    if (speed > ONE) {
      const reach = this.radius + mul(speed, look);
      const floor = base;
      for (let i = 0; i < LOOK_STEPS.length; i++) {
        const k = mul(reach, LOOK_STEPS[i]);
        const ahead = arena.surfaceBelow(this.pos.x + muldiv(this.vel.x, k, speed), this.pos.z + muldiv(this.vel.z, k, speed), r, floor + climb);
        if (ahead >= 0) base = max(base, ahead);
      }
    }
    const d = base + hover - this.pos.y;
    return clamp(d, -vt(sink, dt), vt(rise, dt));
  }

  /** What the last move ended on (Physics.support). */
  private supportGrounded = false;
  private onWizard: SimWizard | null = null;

  /**
   * Slide by (mx, dy, mz) against cover, the wall and the other wizards, then settle the footing
   * (landing, walking off ledges, coyote time, heads).
   */
  private moveCharacter(mx: number, dy: number, mz: number, arena: SimArena, others: readonly SimWizard[], dt: number, hovering: boolean): void {
    const p = this.pos;
    const startY = p.y;
    // Horizontal: substeps of at most 0.15 m, pushed out of anything solid after each.
    const dist = len2(mx, mz);
    const steps = max(1, Math.ceil(dist / K_0_15));
    const at = SCRATCH_AT;
    at.x = p.x;
    at.z = p.z;
    for (let i = 1; i <= steps; i++) {
      at.x = p.x + Math.floor((mx * i) / steps) - Math.floor((mx * (i - 1)) / steps);
      at.z = p.z + Math.floor((mz * i) / steps) - Math.floor((mz * (i - 1)) / steps);
      arena.depenetrate(at, p.y, this.radius, this.height);
      this.pushFromWizards(at, others);
      p.x = at.x;
      p.z = at.z;
    }

    // Vertical.
    this.supportGrounded = false;
    this.onWizard = null;
    let movedY = dy;
    if (dy < 0) {
      const top = arena.topBelow(p.x, p.z, this.radius, p.y + dy, p.y + K_0_02);
      const head = this.headBelow(p.y + dy, p.y + K_0_02, others);
      if (head && (top < 0 || head.pos.y + head.height >= top)) {
        movedY = head.pos.y + head.height - p.y;
        this.onWizard = head;
      } else if (top >= 0) {
        movedY = top - p.y;
        this.supportGrounded = true;
      }
    } else if (dy > 0) {
      const roof = arena.ceilingAbove(p.x, p.z, this.radius, p.y + this.height, p.y + this.height + dy);
      if (roof >= 0) movedY = max(0, roof - (p.y + this.height));
    }
    p.y = max(0, startY + movedY);
    if (hovering) {
      // The carpet (or the air) is the footing: the jump and landing logic stays out.
      this.grounded = true;
      this.coyote = 0;
      this.groundY = p.y;
      return;
    }
    this.updateFooting(dt, dy, movedY, arena);
  }

  /** The other wizard whose head top lies in [minY, maxY] under this one's footprint. */
  private headBelow(minY: number, maxY: number, others: readonly SimWizard[]): SimWizard | null {
    for (const o of others) {
      if (o === this || !o.active || !o.alive) continue;
      const top = o.pos.y + o.height;
      if (top < minY || top > maxY) continue;
      if (len2(this.pos.x - o.pos.x, this.pos.z - o.pos.z) < this.radius + o.radius) return o;
    }
    return null;
  }

  private pushFromWizards(at: { x: number; z: number }, others: readonly SimWizard[]): void {
    for (const o of others) {
      if (o === this || !o.active || !o.alive || !this.alive) continue;
      // Vertical overlap only (someone mid-jump passes over).
      if (o.pos.y >= this.pos.y + this.height || this.pos.y >= o.pos.y + o.height) continue;
      const want = this.radius + o.radius + K_0_02;
      const dx = at.x - o.pos.x, dz = at.z - o.pos.z;
      const d = len2(dx, dz);
      if (d >= want) continue;
      if (d < 4) {
        at.x = o.pos.x + want;
        continue;
      }
      at.x = o.pos.x + muldiv(dx, want, d);
      at.z = o.pos.z + muldiv(dz, want, d);
    }
  }

  private updateFooting(dt: number, dy: number, movedY: number, arena: SimArena): void {
    const wasGrounded = this.grounded;
    const onFloor = this.pos.y <= FLOOR_EPS && dy <= 0;
    if (onFloor) this.pos.y = 0;
    this.grounded = onFloor || (dy <= 0 && this.supportGrounded);

    if (this.onWizard) {
      const o = this.onWizard;
      let dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z;
      if (len2(dx, dz) < 4) {
        dx = this.forwardX();
        dz = this.forwardZ();
      }
      const n = SCRATCH_DIR;
      if (setLength2(n, dx, dz, ONE)) {
        const along = mul(this.knock.x, n.x) + mul(this.knock.z, n.z);
        if (along < HEAD_SLIDE) {
          this.knock.x += mul(n.x, HEAD_SLIDE - along);
          this.knock.z += mul(n.z, HEAD_SLIDE - along);
        }
      }
      if (this.vy < 0) this.vy = 0;
    } else if (dy > 0 && movedY < (dy >> 1)) {
      this.vy = min(this.vy, 0);
    }

    if (this.grounded) {
      if (!wasGrounded) {
        this.landSpeed = max(0, -this.vy);
        this.landings++;
        this.events.push('land', this.index);
      }
      this.vy = 0;
      this.coyote = COYOTE;
      this.groundY = this.pos.y;
    } else {
      if (this.coyote > 0) this.coyote = max(0, this.coyote - dt);
      const top = arena.topBelow(this.pos.x, this.pos.z, mul(this.radius, K_0_9), 0, this.pos.y);
      this.groundY = top > 0 ? min(this.pos.y, top) : 0;
    }
  }
}

/** Move (vx, vz) toward (tx, tz) by at most `step` (Q16 m/s): crisp starts and stops. */
export function approach(v: V3, tx: number, tz: number, step: number): void {
  const dx = tx - v.x, dz = tz - v.z;
  const l = len2(dx, dz);
  if (l <= step) {
    v.x = tx;
    v.z = tz;
    return;
  }
  v.x += muldiv(dx, step, l);
  v.z += muldiv(dz, step, l);
}

/** Facing (angle units) from a direction; re-exported for spells and AI. */
export function yawOf(x: number, z: number): number {
  return atan2(x, z);
}

export { QUARTER, DT, abs };
