/**
 * Guest side: client-side prediction of the guest's own wizard. Pure (no DOM, no three.js).
 *
 * Without it the guest sees its own wizard the way it sees the opponent, interpolated
 * `interpDelayMs` behind the host plus the input round trip (RTT + about 170 ms). Here the guest
 * steps its own wizard locally with the same sim-core movement the host runs (SimWizard and
 * SimArena, fixed point), one step per local input frame, so moving, jumping and dodging respond on
 * the frame they are pressed.
 *
 * Reconciliation: every snapshot carries `ack`, the last guest input tick the host has applied.
 * `reconcile` resets the predicted wizard to the snapshot's state for our seat (as of `ack`) and
 * replays the frames recorded after it. What the predictor does not model (spell knockback, stuns,
 * casts started inside the unacked window, moving cover) shows up as a small correction at the next
 * snapshot. OnlineController smooths that away (`PredictionSmoother`).
 *
 * Gameplay never reads the prediction. The host's sim stays the only authority, so this changes
 * nothing about outcomes, the input log or determinism.
 */
import { CONFIG } from '../config';
import { SimArena, isArenaId, rebuildSolids, type ArenaId } from '../sim-core/arena';
import { SimEvents } from '../sim-core/events';
import { DT, ONE, TURN, fx, len2, mul, muldiv, sec } from '../sim-core/fixed';
import { CD_DODGE, SimWizard, type SimInput } from '../sim-core/wizard';
import { quantizeMove, quantizeYaw } from '../core/simInput';
import { dequantizeAngle, type IntentFrame } from './intent';
import type { NetPhase, Snapshot, WizardState } from './state';

const TAU = Math.PI * 2;
const COYOTE = sec(CONFIG.wizard.jump.coyoteTime);
const WIZ_R = fx(CONFIG.wizard.radius);
const FIRE_PUSH = fx(CONFIG.arena.firePush);
/** How long the sim remembers a press (SimWizard.applyInput), and the ticks that spans. */
const INPUT_BUFFER = sec(CONFIG.feel.inputBuffer);
const DODGE_BUFFER = sec(CONFIG.wizard.dodge.inputBuffer);
const A_DODGE = 5;
const A_JUMP = 6;
/** The presses movement reads (the predictor casts no spells, so the others don't matter). */
const MOVE_PRESSES = (1 << A_DODGE) | (1 << A_JUMP);
const BUFFER_TICKS = Math.ceil(Math.max(INPUT_BUFFER, DODGE_BUFFER) / DT);

export interface PredictedPose {
  pos: [number, number, number];
  vel: [number, number];
  vy: number;
  facing: number;
  grounded: boolean;
  sprinting: boolean;
  dodging: boolean;
}

export interface GuestPredictorOptions {
  /** Most unacked frames replayed on a snapshot (CONFIG.net.maxPredictionReplay). */
  maxReplay: number;
}

/** A guest intent frame as the sim input the host would build from it (movement and buttons). */
export function frameToSimInput(f: IntentFrame, out: SimInput): SimInput {
  let mx = Math.max(-127, Math.min(127, f.mx)) / 127;
  let mz = Math.max(-127, Math.min(127, f.mz)) / 127;
  const len = Math.hypot(mx, mz);
  if (len > 1) {
    mx /= len;
    mz /= len;
  }
  out.move = quantizeMove(mx, mz);
  out.held = f.held & 3;
  out.press = f.press;
  out.facing = quantizeYaw(dequantizeAngle(f.facing));
  // Aim only steers spells, which the predictor does not cast.
  out.aimYaw = out.aimPitch = out.aimDist = 0;
  out.noFacing = false;
  out.noAim = true;
  return out;
}

export class GuestPredictor {
  private readonly arena: SimArena;
  private readonly events = new SimEvents();
  /** Our wizard (predicted) and the opponent (a collision body at its snapshot position). */
  readonly me: SimWizard;
  private readonly foe: SimWizard;
  private readonly bodies: SimWizard[];
  /** Recorded frames not yet acknowledged, oldest first. */
  private readonly history: IntentFrame[] = [];
  private readonly input: SimInput = { move: 0, held: 0, press: 0, facing: 0, aimYaw: 0, aimPitch: 0, aimDist: 0 };
  /** Acknowledged frames young enough that their presses may still sit in the sim's input buffer. */
  private readonly acked: IntentFrame[] = [];
  /** Our wizard's jump count just before each frame was last stepped, by frame tick. */
  private readonly jumpsBefore = new Map<number, number>();
  /** The host's phase as of the newest snapshot: inputs only move us during 'fight'. */
  private phase: NetPhase = 'intro';
  /** The first of our frame ticks the host plays in the current fight (Infinity: locked, or unknown). */
  private fightFrame = Infinity;
  /** A snapshot has been applied (before that there is nothing to predict from). */
  private synced = false;
  /** The last snapshot's ack, and how many frames its reconcile replayed (tests, debug HUD). */
  lastAck = -1;
  lastReplay = 0;
  /** Frames dropped from the front because the host fell further behind than `maxReplay`. */
  overflow = 0;

  constructor(
    readonly seat: 0 | 1,
    arenaId: string,
    private readonly opts: GuestPredictorOptions = { maxReplay: CONFIG.net.maxPredictionReplay },
  ) {
    const id: ArenaId = isArenaId(arenaId) ? arenaId : 'moonlit';
    this.arena = new SimArena(id);
    this.arena.reset();
    this.events.enabled = false;
    this.me = new SimWizard(seat, seat, this.events);
    this.foe = new SimWizard(1 - seat, (1 - seat) as 0 | 1, this.events);
    this.bodies = seat === 0 ? [this.me, this.foe] : [this.foe, this.me];
  }

  get ready(): boolean {
    return this.synced;
  }

  /** Unacknowledged frames held for replay. */
  get pending(): number {
    return this.history.length;
  }

  /** A local frame was sent: remember it and step the prediction by one tick. */
  record(frame: IntentFrame): void {
    this.history.push(frame);
    // The host never replays more than maxInputLagTicks behind: keep the buffer bounded.
    const cap = Math.max(this.opts.maxReplay, 1) * 4;
    if (this.history.length > cap) for (const f of this.history.splice(0, this.history.length - cap)) this.jumpsBefore.delete(f.tick);
    if (this.synced) this.step(frame);
  }

  /**
   * The host's view of the world arrived: our wizard as of `snap.ack`. Reset to it and replay the
   * frames after it. Returns false when the snapshot has no state for our seat.
   */
  reconcile(snap: Snapshot): boolean {
    const mine = snap.wizards[this.seat];
    if (!mine) return false;
    this.phase = snap.match.phase;
    // The first of our frames the host plays in the fight (the ones before it are locked: no
    // movement, presses dropped). From an intro snapshot: the countdown ends `phaseTime` after it
    // (a whole number of ticks; the wire rounds it to centiseconds), and the host plays frame f at
    // snap.tick + (f - ack). A fight snapshot keeps what the intro said, or, never having seen the
    // intro (a reconnect), takes every frame after its ack as a fight frame. After a round ends
    // everything is locked until the next intro.
    if (this.phase === 'intro') this.fightFrame = snap.ack + Math.round(sec(snap.match.phaseTime) / DT) + 1;
    else if (this.phase === 'fight') {
      if (this.fightFrame === Infinity) this.fightFrame = snap.ack + 1;
    } else this.fightFrame = Infinity;
    const foe = snap.wizards[1 - this.seat];
    if (foe) setBody(this.foe, foe);
    this.syncArena(snap);
    setState(this.me, mine);
    this.synced = true;
    // Frames the host has applied are part of the snapshot's state.
    let drop = 0;
    while (drop < this.history.length && this.history[drop].tick <= snap.ack) drop++;
    if (drop) this.acked.push(...this.history.splice(0, drop));
    while (this.acked.length && this.acked[0].tick <= snap.ack - BUFFER_TICKS) this.jumpsBefore.delete(this.acked.shift()!.tick);
    this.rebuffer(snap.ack, mine.jumps);
    this.lastAck = snap.ack;
    // Too far ahead of the host (a stall): show its state rather than a long extrapolation.
    if (this.history.length > this.opts.maxReplay) {
      this.overflow += this.history.length - this.opts.maxReplay;
      for (const f of this.history.splice(0, this.history.length - this.opts.maxReplay)) this.jumpsBefore.delete(f.tick);
    }
    this.lastReplay = this.history.length;
    for (const f of this.history) this.step(f);
    return true;
  }

  /** Forget the recorded frames and the synced state (a new round, a reconnect). */
  reset(): void {
    this.history.length = 0;
    this.acked.length = 0;
    this.jumpsBefore.clear();
    this.fightFrame = Infinity;
    this.synced = false;
    this.lastAck = -1;
    this.lastReplay = 0;
  }

  /** The predicted wizard in metres and radians. */
  pose(out: PredictedPose): PredictedPose {
    const w = this.me;
    out.pos[0] = w.pos.x / ONE;
    out.pos[1] = w.pos.y / ONE;
    out.pos[2] = w.pos.z / ONE;
    out.vel[0] = w.vel.x / ONE;
    out.vel[1] = w.vel.z / ONE;
    out.vy = w.vy / ONE;
    out.facing = (((w.facing / TURN) * TAU) % TAU + TAU) % TAU;
    out.grounded = w.grounded;
    out.sprinting = w.sprinting;
    out.dodging = w.dodging;
    return out;
  }

  /**
   * The wire does not carry the sim's input buffer: a jump or roll the host has played may still
   * be waiting there (pressed in the air, it fires on landing). Put back what is left of those
   * presses from the last few acknowledged frames, unless the host has used them: a jump is used
   * once the host's jump count has passed what it was before that frame, and a roll leaves the
   * roll on cooldown, which stops a second one anyway.
   */
  private rebuffer(ack: number, hostJumps: number): void {
    const w = this.me;
    for (const f of this.acked) {
      const press = f.press & MOVE_PRESSES;
      if (!press || f.tick < this.fightFrame) continue;
      // The step that buffers a press also ages it (updateTimers runs after applyInput).
      const age = (ack - f.tick + 1) * DT;
      if (press & (1 << A_DODGE)) w.buffered[A_DODGE] = Math.max(w.buffered[A_DODGE], DODGE_BUFFER - age);
      if (press & (1 << A_JUMP) && hostJumps <= (this.jumpsBefore.get(f.tick) ?? -1)) {
        w.buffered[A_JUMP] = Math.max(w.buffered[A_JUMP], INPUT_BUFFER - age);
      }
    }
  }

  /** One host tick of movement for our wizard: SimWorld.step's order, movement only. */
  private step(frame: IntentFrame): void {
    const w = this.me;
    this.jumpsBefore.set(frame.tick, w.jumps);
    const f = frameToSimInput(frame, this.input);
    if (frame.tick >= this.fightFrame) w.applyInput(f);
    else {
      w.latch(f);
      w.clearIntent();
    }
    w.updateTimers(DT);
    w.updateMovement(DT, this.arena, this.bodies);
    this.ringPush(w);
  }

  /** The fire ring's inward push (SimWorld.updateFire, without the burn). */
  private ringPush(w: SimWizard): void {
    if (!w.alive) return;
    const r = len2(w.pos.x, w.pos.z);
    if (r + WIZ_R <= this.arena.fireRadius) return;
    const rr = r || ONE;
    const ix = -muldiv(w.pos.x, ONE, rr), iz = -muldiv(w.pos.z, ONE, rr);
    const inward = mul(w.knock.x, ix) + mul(w.knock.z, iz);
    if (inward < FIRE_PUSH) w.addKnockback(ix, iz, FIRE_PUSH - inward);
  }

  /** Broken cover and the fire ring as of the snapshot (moving cover stays at its rail start). */
  private syncArena(snap: Snapshot): void {
    this.arena.fireRadius = fx(snap.arena.fireRadius);
    const obs = this.arena.obstacles;
    for (let i = 0; i < obs.length && i < snap.arena.pillars.length; i++) {
      const alive = snap.arena.pillars[i] >= 0;
      if (obs[i].alive === alive) continue;
      obs[i].alive = alive;
      rebuildSolids(obs[i]);
    }
  }
}

const fxAngle = (a: number) => Math.round((((a % TAU) + TAU) % TAU) / TAU * TURN) % TURN;

/** A snapshot wizard as a collision body (position and liveness are all pushes need). */
function setBody(w: SimWizard, s: WizardState): void {
  w.pos.x = fx(s.pos[0]);
  w.pos.y = fx(s.pos[1]);
  w.pos.z = fx(s.pos[2]);
  w.alive = s.alive;
}

/** Our wizard's movement state from a snapshot (what the wire carries; the rest is reset). */
function setState(w: SimWizard, s: WizardState): void {
  setBody(w, s);
  w.vel.x = fx(s.vel[0]);
  w.vel.y = 0;
  w.vel.z = fx(s.vel[1]);
  w.vy = fx(s.vy);
  w.grounded = s.grounded;
  w.coyote = s.grounded ? COYOTE : 0;
  w.groundY = s.grounded ? w.pos.y : 0;
  w.facing = fxAngle(s.facing);
  w.knock.x = w.knock.y = w.knock.z = 0;
  w.mana = fx(s.mana);
  w.manaBoost = sec(s.manaBoost);
  w.sprintExhausted = w.mana <= 0;
  w.sprinting = s.sprinting;
  for (let i = 0; i < w.cd.length && i < s.cd.length; i++) w.cd[i] = sec(s.cd[i]);
  w.cd[CD_DODGE] = sec(s.cd[CD_DODGE] ?? 0);
  w.dodgeTime = sec(s.dodgeTime);
  w.iframes = sec(s.iframes);
  w.dodgeDir.x = fx(s.dodgeDir[0]);
  w.dodgeDir.z = fx(s.dodgeDir[1]);
  w.stunTime = sec(s.stunTime);
  w.shieldTime = sec(s.shieldTime);
  w.cast = s.cast ? { spell: s.cast.spell, elapsed: sec(s.cast.elapsed), duration: sec(s.cast.duration) } : null;
  w.jumps = s.jumps;
  w.landings = s.landings;
  for (let i = 0; i < w.buffered.length; i++) w.buffered[i] = 0;
}

/**
 * Hides corrections: after a reconcile moves the predicted wizard, the shown wizard keeps its old
 * place and eases onto the prediction (time constant `tauMs`). Jumps past `snapDistance` (a
 * respawn, a long stall) are shown at once.
 */
export class PredictionSmoother {
  readonly offset: [number, number, number] = [0, 0, 0];

  constructor(
    private readonly tauMs = 90,
    private readonly snapDistance = 2,
  ) {}

  /** The prediction moved from `before` to `after` (metres): carry the difference as an offset. */
  correct(before: readonly number[], after: readonly number[]): void {
    const dx = before[0] + this.offset[0] - after[0];
    const dy = before[1] + this.offset[1] - after[1];
    const dz = before[2] + this.offset[2] - after[2];
    if (Math.hypot(dx, dy, dz) > this.snapDistance) this.clear();
    else {
      this.offset[0] = dx;
      this.offset[1] = dy;
      this.offset[2] = dz;
    }
  }

  /** Let `dtMs` of easing pass. */
  decay(dtMs: number): void {
    const k = Math.exp(-Math.max(0, dtMs) / this.tauMs);
    for (let i = 0; i < 3; i++) this.offset[i] = Math.abs(this.offset[i] * k) < 1e-4 ? 0 : this.offset[i] * k;
  }

  clear(): void {
    this.offset[0] = this.offset[1] = this.offset[2] = 0;
  }
}
