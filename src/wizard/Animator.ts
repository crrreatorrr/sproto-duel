import * as THREE from 'three';
import { CONFIG } from '../config';
import type { ModelInstance } from '../assets/AssetLoader';
import type { ModelAsset, WizardClip } from '../assets/manifest';
import { clipHalves, isLowerBodyTrack, rootBone } from '../assets/rig';
import { clamp, damp, wrapAngle } from '../core/math';
import type { PendingCast } from '../spells/types';
import type { Wizard } from './Wizard';

/**
 * Clip state machine for a rigged look (skinned GLB with baked clips, src/assets/rig.ts).
 *
 * Two layers, each cross-fading between "sources" with normalized weights (so the pose never blends
 * toward the bind pose):
 * - **legs** (hips and legs): idle, locomotion, jump, dodge, hit, stun, victory, defeat, and a cast
 *   when standing still;
 * - **upper body** (spine, head, arms, props): follows the legs, except that casts and hit
 *   reactions play here over running, so the legs keep running while the arms cast.
 *
 * Locomotion is a directional blend of run / strafe_l / strafe_r / run_back from the velocity
 * relative to facing (wizards face their target while they strafe), phase-synced so the feet don't
 * pop, at a rate from the speed. Missing strafes fall back to run; a missing run_back plays run
 * backwards.
 *
 * Every clip's time is set here (actions never advance themselves): casts are scrubbed so the hand
 * reaches its peak exactly when the spell is released, hits hold for HIT_HOLD, the ice of a stun
 * freezes the pose once it has formed, hit-stop freezes everything. One clip per character: clips
 * are never shared between characters, only between copies of one model.
 */

/** What a layer cross-fades between ('loco' is the directional run blend). */
export const ANIM_SOURCES = ['idle', 'loco', 'jump', 'cast', 'castBig', 'dodge', 'hit', 'stunned', 'victory', 'defeat'] as const;
export type AnimSource = (typeof ANIM_SOURCES)[number];
const enum Src { idle, loco, jump, cast, castBig, dodge, hit, stunned, victory, defeat }
const SOURCE_COUNT = ANIM_SOURCES.length;

const LOCO: readonly WizardClip[] = ['run', 'strafeL', 'strafeR', 'runBack'];

/** Which source a clip plays under. */
const SOURCE_OF: Record<WizardClip, Src> = {
  idle: Src.idle, run: Src.loco, strafeL: Src.loco, strafeR: Src.loco, runBack: Src.loco, jump: Src.jump,
  cast: Src.cast, castBig: Src.castBig, dodge: Src.dodge, hit: Src.hit, stunned: Src.stunned, victory: Src.victory, defeat: Src.defeat,
};

/** Cross-fade time into each source (s). */
const FADE: Record<AnimSource, number> = {
  idle: 0.2, loco: 0.16, jump: 0.1, cast: 0.08, castBig: 0.1, dodge: 0.06, hit: 0.06, stunned: 0.08, victory: 0.25, defeat: 0.18,
};

/** Seconds into cast / cast_big of the release (the clip library's timing), unless the manifest says. */
const CAST_PEAK = 0.45;
const CAST_BIG_PEAK = 0.62;
/** A windup may compress the clip's anticipation up to this much to fit it before the release. */
const MAX_WINDUP_RATE = 2;
/** An instant cast (bolt, volley shot) starts this far before the peak: a quick snap forward. */
const SNAP_LEAD = 0.06;
/** Most of the clip played after the release before handing back to the base layer. */
const FOLLOW: Record<'cast' | 'castBig', number> = { cast: 0.36, castBig: 0.6 };
/** How long a hit reaction holds (hitFlash itself lasts 0.09 s), and when a new hit may restart it. */
export const HIT_HOLD = 0.35;
const HIT_RESTART = 0.12;
/** Locomotion: clip rate per m/s and its cap (a little foot slide is fine), slowed run in the air without a jump clip. */
const RUN_RATE_PER_MS = 1 / 2.1;
const RUN_RATE_MIN = 0.55;
const RUN_RATE_MAX = 1.9;
const AIR_RUN_RATE = 0.3;
/** Above / below this ground speed the legs switch to / from locomotion (hysteresis). */
const MOVE_ON = 0.6;
const MOVE_OFF = 0.3;

/** Most the hips turn toward the travel direction when a strafe has no clip of its own (rad), and how much of it the spine turns back. */
const HIP_YAW_MAX = 1.2;
const SPINE_COUNTER = 0.85;

/**
 * Facing. The library's mocap stands turned (idle ~-25° at the hips, a hit ~-60°), so these clips
 * get a constant hips turn, measured at load, that points their average chest straight ahead.
 * Locomotion is directional, the cast aims its side-on staff thrust at the target, and roll, jump
 * and defeat move on their own, so those keep their yaw.
 */
const YAW_FIXED: readonly Src[] = [Src.idle, Src.hit, Src.castBig, Src.victory, Src.stunned];
/**
 * Then the head looks back at the target (the look's forward): how much each source allows, and the
 * share of the turn the chest, neck and head each take.
 */
const LOOK: Record<AnimSource, number> = { idle: 1, loco: 1, jump: 0.8, cast: 1, castBig: 1, dodge: 0, hit: 0.6, stunned: 0.3, victory: 0.5, defeat: 0 };
const LOOK_SHARE = [0.15, 0.35, 0.5];
const LOOK_MAX = 1.2;

const J = CONFIG.wizard.jump;
const AIRTIME = (2 * J.velocity) / J.gravity;
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpQ3 = new THREE.Quaternion();
const tmpAxis = new THREE.Vector3();
const tmpF = new THREE.Vector3();

/** Per-frame inputs the visual already computed (one shared object, no allocation). */
export interface AnimInput {
  /** Horizontal speed, m/s (movement plus knockback). */
  speed: number;
  /** Velocity in the character's frame: +x its left, +z forward. */
  localX: number;
  localZ: number;
  /** Victory pose wanted (WizardVisual.celebrate). */
  celebrate: boolean;
  /** The stun's ice shell has formed: the pose freezes inside it. */
  iceFormed: boolean;
  /** MotionStyle weight 0..1: heavier characters idle and stride slower. */
  weight: number;
}

interface ClipSlot {
  readonly clip: WizardClip;
  readonly src: Src;
  /** Index into LOCO, or -1. */
  readonly loco: number;
  readonly upper: THREE.AnimationAction;
  readonly lower: THREE.AnimationAction;
  readonly duration: number;
}

/** One layer: normalized source weights and the source it is fading to. */
class Layer {
  readonly w = new Float32Array(SOURCE_COUNT);
  target: Src = Src.idle;
  private fade = 0.2;

  constructor() {
    this.w[Src.idle] = 1;
  }

  set(target: Src): void {
    if (target === this.target) return;
    this.target = target;
    this.fade = FADE[ANIM_SOURCES[target]];
  }

  /** Move toward the target: it gains dt/fade, the others share what's left in proportion. */
  step(dt: number): void {
    const w = this.w;
    const t = this.target;
    let others = 0;
    for (let i = 0; i < SOURCE_COUNT; i++) if (i !== t) others += w[i];
    let wt = Math.min(1, w[t] + (this.fade > 0 ? dt / this.fade : 1));
    if (others < 1e-4) wt = 1;
    const k = others > 1e-4 ? (1 - wt) / others : 0;
    for (let i = 0; i < SOURCE_COUNT; i++) if (i !== t) w[i] = w[i] * k < 1e-4 ? 0 : w[i] * k;
    w[t] = wt;
  }

  reset(to: Src): void {
    this.w.fill(0);
    this.w[to] = 1;
    this.target = to;
  }
}

/** Find `name` among a model's clips: exact (case-insensitive) first, then a substring not claimed exactly by another wanted clip. */
function findClip(clips: THREE.AnimationClip[], name: string, claimed: Set<string>): THREE.AnimationClip | undefined {
  const want = name.toLowerCase();
  return clips.find((a) => a.name.toLowerCase() === want)
    ?? clips.find((a) => {
      const n = a.name.toLowerCase();
      return n.includes(want) && !claimed.has(n);
    });
}

export class Animator {
  /** Live animators across the game (QA: no growth over look swaps). */
  static live = 0;
  readonly mixer: THREE.AnimationMixer;
  private readonly root: THREE.Object3D;
  private readonly slots: ClipSlot[] = [];
  private readonly byClip = new Map<WizardClip, ClipSlot>();
  /** 1 for sources this look has a clip for. A layer only ever targets these, so its weights always land on real clips. */
  private readonly sources = new Uint8Array(SOURCE_COUNT);
  private readonly legs = new Layer();
  private readonly arms = new Layer();
  /** Seconds into each source's clip (loco uses `phase`). */
  private readonly clock = new Float32Array(SOURCE_COUNT);
  /** Locomotion cycle, 0..1, shared by run, strafes and run_back. */
  private phase = 0;
  /** Smoothed movement direction in the character's frame (+x left, +z forward). */
  private dirX = 0;
  private dirZ = 1;
  /** Directional weights of run, strafeL, strafeR, runBack (sum 1). */
  private readonly locoW = new Float32Array(4);
  /** run plays backwards (no run_back clip, moving mostly backwards). */
  private runReversed = false;
  private moving = false;
  private readonly castPeak: number;
  private readonly castBigPeak: number;
  /** The windup being tracked, and which cast source it plays. */
  private castRef: PendingCast | null = null;
  private castSrc: Src.cast | Src.castBig = Src.cast;
  /** Seconds of follow-through left after a release (0: no cast playing unless winding up). */
  private castFollow = 0;
  private hitHold = 0;
  private lastPulse = 0;
  private lastHitFlash = 0;
  private wasAlive = true;
  private wasDodging = false;
  private wasStunned = false;
  private wasCelebrating = false;
  private seenJumps = -1;
  private disposed = false;
  /**
   * Strafing without a strafe clip: the hips turn toward the travel direction (radians about their
   * parent's up axis) so the run's legs go where the character goes, and the spine turns back so the
   * chest still faces the target.
   */
  private hipYaw = 0;
  private hips: THREE.Object3D | null;
  private spine: THREE.Object3D | null;
  private readonly up = new THREE.Vector3(0, 1, 0);
  /** Constant hips turn per source (rad, see YAW_FIXED). */
  private readonly yawFix = new Float32Array(SOURCE_COUNT);
  /** Chest, neck and head (the look-at chain), and the head's and chest's yaw in the run clip (straight ahead). */
  private readonly lookBones: THREE.Object3D[] = [];
  private headRef = 0;
  private chestRef = 0;
  /**
   * Bones the corrections above turn, and their clip pose from the last evaluation. three's mixer
   * only writes a bone when its blended value changes, so a held pose (hit-stop, the stun's ice, a
   * clip's clamped last frame) would otherwise pile the corrections up frame after frame: each
   * evaluation starts from the clip pose again.
   */
  private readonly corrected: THREE.Object3D[] = [];
  private readonly clipPose: THREE.Quaternion[] = [];

  constructor(model: ModelInstance, spec: ModelAsset) {
    this.root = model.root;
    this.mixer = new THREE.AnimationMixer(model.root);
    this.hips = rootBone(model.root);
    this.spine = this.hips?.children.find((c) => (c as THREE.Bone).isBone && !isLowerBodyTrack(`${c.name}.quaternion`)) ?? null;
    if (this.hips?.parent) {
      // The world's up in the hips' parent frame (the Armature; the look is only ever yawed).
      model.root.updateMatrixWorld(true);
      this.up.applyQuaternion(this.hips.parent.getWorldQuaternion(tmpQ).invert()).normalize();
    }
    this.castPeak = model.rig?.castPeak ?? CAST_PEAK;
    this.castBigPeak = model.rig?.castBigPeak ?? CAST_BIG_PEAK;
    const wanted = Object.entries(spec.clips ?? {}) as [WizardClip, string][];
    const claimed = new Set(wanted.map(([, n]) => n.toLowerCase()));
    const skip = model.rig?.skipClips ?? [];
    for (const [clip, name] of wanted) {
      if (skip.includes(clip)) continue;
      const found = findClip(model.animations, name, claimed);
      if (!found || this.byClip.has(clip)) continue;
      const halves = clipHalves(found);
      const make = (c: THREE.AnimationClip) => {
        const a = this.mixer.clipAction(c);
        a.setLoop(THREE.LoopRepeat, Infinity);
        a.play();
        a.setEffectiveWeight(0);
        return a;
      };
      const slot: ClipSlot = {
        clip, src: SOURCE_OF[clip], loco: LOCO.indexOf(clip),
        upper: make(halves.upper), lower: make(halves.lower), duration: Math.max(1e-3, found.duration),
      };
      this.slots.push(slot);
      this.byClip.set(clip, slot);
      this.sources[slot.src] = 1;
    }
    // Locomotion needs run itself (the strafes blend around it).
    if (!this.byClip.has('run')) this.sources[Src.loco] = 0;
    // The hip turn is re-applied on top of the clips every frame, so both bones must be driven by them.
    const run = this.byClip.get('run');
    const driven = (o: THREE.Object3D | null) => !!o && !!run && [...run.lower.getClip().tracks, ...run.upper.getClip().tracks].some((t) => t.name === `${o.name}.quaternion`);
    if (!driven(this.hips) || !driven(this.spine)) this.hips = this.spine = null;
    this.measureFacing(model.root, driven);
    for (const b of [this.hips, this.spine, ...this.lookBones]) {
      if (b && !this.corrected.includes(b)) {
        this.corrected.push(b);
        this.clipPose.push(b.quaternion.clone());
      }
    }
    const start = this.sources[Src.idle] ? Src.idle : (this.slots[0]?.src ?? Src.idle);
    this.legs.reset(start);
    this.arms.reset(start);
    Animator.live++;
    this.apply();
  }

  /**
   * Find the look-at chain (the head bone and its two parents) and measure, by playing each clip
   * alone, how far the mocap turns the chest and head from straight ahead (the run clip): the
   * constant hips turn per YAW_FIXED source, and the head's forward reference.
   */
  private measureFacing(root: THREE.Object3D, driven: (o: THREE.Object3D | null) => boolean): void {
    let head: THREE.Object3D | null = null;
    root.traverse((o) => {
      if (!head && (o as THREE.Bone).isBone && /^head$/i.test(o.name)) head = o;
    });
    const neck = (head as THREE.Object3D | null)?.parent ?? null;
    const chest = neck?.parent ?? null;
    if (!head || !(neck as THREE.Bone | null)?.isBone || !(chest as THREE.Bone | null)?.isBone) return;
    if (![chest, neck, head].every(driven)) return;
    this.lookBones.push(chest!, neck!, head);
    const run = this.byClip.get('run');
    const average = (slot: ClipSlot | undefined, bone: THREE.Object3D): number => {
      if (!slot) return 0;
      for (const o of this.slots) {
        o.upper.setEffectiveWeight(o === slot ? 1 : 0);
        o.lower.setEffectiveWeight(o === slot ? 1 : 0);
      }
      let sx = 0, sz = 0;
      for (let i = 0; i < 8; i++) {
        slot.upper.time = slot.lower.time = (slot.duration * i) / 8;
        this.mixer.update(0);
        const yaw = this.yawOf(bone);
        sx += Math.sin(yaw);
        sz += Math.cos(yaw);
      }
      return Math.atan2(sx, sz);
    };
    this.chestRef = average(run, chest!);
    this.headRef = average(run, head);
    if (this.hips) {
      for (const src of YAW_FIXED) {
        const slot = this.slots.find((o) => o.src === src);
        if (slot) this.yawFix[src] = clamp(-wrapAngle(average(slot, chest!) - this.chestRef), -LOOK_MAX, LOOK_MAX);
      }
    }
  }

  /** Yaw of a bone's forward (+Z) in the look's own frame (0: straight ahead). */
  private yawOf(bone: THREE.Object3D): number {
    this.root.getWorldQuaternion(tmpQ3).invert().multiply(bone.getWorldQuaternion(tmpQ2));
    tmpF.set(0, 0, 1).applyQuaternion(tmpQ3);
    return Math.atan2(tmpF.x, tmpF.z);
  }

  /** The head's yaw from straight ahead, rad (QA: the look-at keeps it on the target). */
  headYaw(): number {
    const head = this.lookBones[2];
    return head ? wrapAngle(this.yawOf(head) - this.headRef) : 0;
  }

  /** The chest's yaw from straight ahead, rad (QA). */
  chestYaw(): number {
    const chest = this.lookBones[0];
    return chest ? wrapAngle(this.yawOf(chest) - this.chestRef) : 0;
  }

  /** The look has this clip. */
  has(clip: WizardClip): boolean {
    return this.byClip.has(clip);
  }

  /** Clip names this look plays (QA, logs). */
  get clips(): WizardClip[] {
    return this.slots.map((s) => s.clip);
  }

  /** What the legs are doing (QA). */
  get legsState(): AnimSource {
    return ANIM_SOURCES[this.legs.target];
  }

  /** What the upper body is doing (QA). */
  get upperState(): AnimSource {
    return ANIM_SOURCES[this.arms.target];
  }

  /** Effective weight of a clip on either layer this frame, 0..1 (QA). */
  weight(clip: WizardClip): number {
    const s = this.byClip.get(clip);
    return s ? Math.max(s.upper.getEffectiveWeight(), s.lower.getEffectiveWeight()) : 0;
  }

  /** Current time of a clip, seconds (QA). */
  time(clip: WizardClip): number {
    return this.byClip.get(clip)?.upper.time ?? 0;
  }

  /** Current hip turn toward the travel direction (rad; strafing without a strafe clip). */
  get hipTurn(): number {
    return this.hipYaw;
  }

  /** Release peak of the cast or cast_big clip (seconds). */
  peak(clip: 'cast' | 'castBig'): number {
    return clip === 'cast' ? this.castPeak : this.castBigPeak;
  }

  /** Per render frame, before reading bones (sockets). `dt` is simulated time (0 in hit-stop). */
  update(w: Wizard, dt: number, inp: AnimInput): void {
    if (this.disposed) return;
    this.events(w, inp);
    const stunClip = this.has('stunned');
    // Frozen: hit-stop (dt 0), or a stun's ice has formed (or there is no stun clip to play).
    const frozen = w.stunned && (!stunClip || inp.iceFormed);
    const t = frozen ? 0 : dt;
    this.pickTargets(w, inp);
    this.legs.step(t);
    this.arms.step(t);
    this.advance(w, t, inp);
    this.apply();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    Animator.live--;
  }

  // ------------------------------------------------------------------ internals

  /** Edges in the wizard's state: windups, releases, hits, deaths, rolls, jumps, stuns, wins. */
  private events(w: Wizard, inp: AnimInput): void {
    const c = this.clock;
    // A windup started (a new PendingCast): blast and Ultimate use cast_big, stun the plain cast.
    if (w.cast && w.cast !== this.castRef) {
      this.castRef = w.cast;
      this.castSrc = w.cast.spell === 'blast' || w.cast.spell === 'ultimate' ? this.bigOr() : Src.cast;
      this.castFollow = 0;
      c[this.castSrc] = this.windupTime(w.cast);
    }
    // A spell left (castPulse jumps to 1).
    const pulse = w.castPulse;
    if (pulse > 0.9 && pulse > this.lastPulse + 0.05) {
      if (this.castRef && !w.cast) {
        // The tracked windup released: keep its clip (the Ultimate stays on cast_big), from the peak on.
        c[this.castSrc] = Math.max(c[this.castSrc], this.peakOf(this.castSrc) - 0.02);
      } else {
        // An instant cast (bolt, volley): snap the plain cast in just before its peak.
        this.castSrc = Src.cast;
        c[Src.cast] = Math.max(0, this.castPeak - SNAP_LEAD);
      }
      this.castRef = null;
      this.castFollow = FOLLOW[this.castSrc === Src.castBig ? 'castBig' : 'cast'] + SNAP_LEAD;
    } else if (this.castRef && !w.cast) {
      // Cancelled (rolled out of it, stunned, KO'd): no follow-through.
      this.castRef = null;
      this.castFollow = 0;
    }
    this.lastPulse = pulse;

    // Hit: hitFlash is set on every hit. Hold the reaction; a later hit restarts it.
    if (w.hitFlash > this.lastHitFlash + 1e-4 && w.alive) {
      if (this.hitHold <= 0 || c[Src.hit] > HIT_RESTART) c[Src.hit] = 0;
      this.hitHold = HIT_HOLD;
    }
    this.lastHitFlash = w.hitFlash;

    if (!w.alive && this.wasAlive) c[Src.defeat] = 0;
    if (w.alive && !this.wasAlive) {
      // Back up (round reset): straight to idle.
      this.legs.reset(Src.idle);
      this.arms.reset(Src.idle);
      this.castFollow = this.hitHold = 0;
      this.castRef = null;
    }
    this.wasAlive = w.alive;
    if (w.dodging && !this.wasDodging) c[Src.dodge] = 0;
    this.wasDodging = w.dodging;
    if (w.stunned && !this.wasStunned) c[Src.stunned] = 0;
    this.wasStunned = w.stunned;
    if (inp.celebrate && !this.wasCelebrating) c[Src.victory] = 0;
    this.wasCelebrating = inp.celebrate;
    if (this.seenJumps < 0) this.seenJumps = w.jumps;
    if (w.jumps !== this.seenJumps) {
      this.seenJumps = w.jumps;
      c[Src.jump] = 0;
    }
  }

  /** cast_big if the look has it, else the plain cast. */
  private bigOr(): Src.cast | Src.castBig {
    return this.has('castBig') ? Src.castBig : Src.cast;
  }

  private peakOf(src: Src): number {
    return src === Src.castBig ? this.castBigPeak : this.castPeak;
  }

  /** Where a windup's clip should be now: reaching the peak exactly at release, anticipation compressed up to 2x. */
  private windupTime(cast: PendingCast): number {
    const peak = this.peakOf(this.castSrc);
    const rate = clamp(peak / Math.max(1e-3, cast.duration), 1, MAX_WINDUP_RATE);
    return clamp(peak - (cast.duration - cast.elapsed) * rate, 0, peak);
  }

  /** A source this look can play, else its idle (or whatever it has). */
  private ok(src: Src): Src {
    if (this.sources[src]) return src;
    if (src === Src.castBig && this.sources[Src.cast]) return Src.cast;
    return this.sources[Src.idle] ? Src.idle : this.legs.target;
  }

  private pickTargets(w: Wizard, inp: AnimInput): void {
    const has = this.sources;
    const casting = (!!w.cast || this.castFollow > 0) && has[this.castSrc] === 1;
    if (this.moving ? inp.speed < MOVE_OFF : inp.speed > MOVE_ON) this.moving = !this.moving;
    let legs: Src;
    if (!w.alive) legs = Src.defeat;
    else if (inp.celebrate) legs = Src.victory;
    else if (w.stunned) legs = has[Src.stunned] ? Src.stunned : this.legs.target;
    else if (w.dodging && has[Src.dodge]) legs = Src.dodge;
    else if (!w.grounded && has[Src.jump]) legs = Src.jump;
    else if (this.hitHold > 0 && !this.moving && has[Src.hit]) legs = Src.hit;
    else if (casting && !this.moving && w.grounded) legs = this.castSrc;
    else if (this.moving && has[Src.loco]) legs = Src.loco;
    else legs = Src.idle;
    legs = this.ok(legs);
    this.legs.set(legs);

    let arms = legs;
    const free = w.alive && !inp.celebrate && !w.stunned && !(w.dodging && has[Src.dodge]);
    if (free && casting) arms = this.castSrc;
    else if (free && this.hitHold > 0 && has[Src.hit]) arms = Src.hit;
    this.arms.set(arms);
  }

  /** Advance every source's clock by `dt` (0 when frozen). */
  private advance(w: Wizard, dt: number, inp: AnimInput): void {
    const c = this.clock;
    const heavy = clamp(inp.weight, 0, 1);
    c[Src.idle] += dt * (1 - 0.25 * heavy);

    // Locomotion: direction blend and phase.
    if (inp.speed > 0.2) {
      const inv = 1 / inp.speed;
      this.dirX = damp(this.dirX, inp.localX * inv, 12, dt);
      this.dirZ = damp(this.dirZ, inp.localZ * inv, 12, dt);
    }
    this.locoWeights();
    this.hipYaw = damp(this.hipYaw, this.hipYawTarget(), 10, dt);
    const run = this.byClip.get('run');
    if (run) {
      const rate = !w.grounded ? AIR_RUN_RATE : clamp(inp.speed * RUN_RATE_PER_MS, RUN_RATE_MIN, RUN_RATE_MAX) * (1 - 0.12 * heavy);
      this.phase = (this.phase + (dt * rate) / run.duration) % 1;
    }

    // Casts: scrub a windup toward its peak, then play the follow-through.
    if (w.cast && this.castRef === w.cast) {
      const target = this.windupTime(w.cast);
      const peak = this.peakOf(this.castSrc);
      c[this.castSrc] = Math.min(peak, Math.max(c[this.castSrc] + dt * clamp(peak / Math.max(1e-3, w.cast.duration), 1, MAX_WINDUP_RATE), target));
    } else if (this.castFollow > 0) {
      c[this.castSrc] += dt;
      this.castFollow = Math.max(0, this.castFollow - dt);
    }
    if (this.hitHold > 0) {
      c[Src.hit] += dt;
      this.hitHold = Math.max(0, this.hitHold - dt);
    }
    const dodge = this.byClip.get('dodge');
    if (w.dodging && dodge) c[Src.dodge] += dt * clamp(dodge.duration / CONFIG.wizard.dodge.duration, 0.8, 3);
    const jump = this.byClip.get('jump');
    if (!w.grounded && jump) c[Src.jump] += dt * clamp(jump.duration / AIRTIME, 0.7, 1.8);
    if (w.stunned) c[Src.stunned] += dt;
    if (inp.celebrate) c[Src.victory] += dt;
    if (!w.alive) c[Src.defeat] += dt;
  }

  /** Split the locomotion weight between run, the strafes and run_back by direction; missing clips fold into run. */
  private locoWeights(): void {
    const len = Math.hypot(this.dirX, this.dirZ) || 1;
    const x = this.dirX / len, z = this.dirZ / len;
    let f = Math.max(0, z), b = Math.max(0, -z);
    let l = Math.max(0, x), r = Math.max(0, -x);
    if (!this.byClip.has('strafeL')) {
      if (z >= 0) f += l;
      else b += l;
      l = 0;
    }
    if (!this.byClip.has('strafeR')) {
      if (z >= 0) f += r;
      else b += r;
      r = 0;
    }
    this.runReversed = false;
    if (!this.byClip.has('runBack')) {
      this.runReversed = b > f;
      f += b;
      b = 0;
    }
    const sum = f + l + r + b || 1;
    this.locoW[0] = f / sum;
    this.locoW[1] = l / sum;
    this.locoW[2] = r / sum;
    this.locoW[3] = b / sum;
  }

  /** Hip turn for the part of a strafe no strafe clip covers (see `hipYaw`), times how much the legs run. */
  private hipYawTarget(): number {
    if (!this.hips || !this.spine || !this.sources[Src.loco]) return 0;
    const len = Math.hypot(this.dirX, this.dirZ) || 1;
    const x = this.dirX / len, z = this.dirZ / len;
    if (this.byClip.has(x >= 0 ? 'strafeL' : 'strafeR')) return 0;
    // Running forward the hips face the travel; running backward (run_back or run reversed) they face away from it.
    const yaw = z >= 0 ? Math.atan2(x, z) : wrapAngle(Math.atan2(-x, -z));
    return clamp(yaw, -HIP_YAW_MAX, HIP_YAW_MAX) * this.legs.w[Src.loco];
  }

  /** Push clocks and weights into the actions and evaluate the pose. */
  private apply(): void {
    const legs = this.legs.w, arms = this.arms.w;
    for (const s of this.slots) {
      let wl = legs[s.src], wu = arms[s.src];
      let time: number;
      if (s.src === Src.loco) {
        const k = this.locoW[s.loco];
        wl *= k;
        wu *= k;
        time = (s.clip === 'run' && this.runReversed ? 1 - this.phase : this.phase) * s.duration;
      } else if (s.src === Src.idle || s.src === Src.stunned || s.src === Src.victory) {
        time = this.clock[s.src] % s.duration;
      } else {
        time = this.clock[s.src];
      }
      time = clamp(time, 0, s.duration - 1e-3);
      s.lower.time = s.upper.time = time;
      s.lower.setEffectiveWeight(wl);
      s.upper.setEffectiveWeight(wu);
    }
    const bones = this.corrected, pose = this.clipPose;
    for (let i = 0; i < bones.length; i++) bones[i].quaternion.copy(pose[i]);
    this.mixer.update(0);
    for (let i = 0; i < bones.length; i++) pose[i].copy(bones[i].quaternion);
    // Turn the hips toward the travel and the spine back toward the target (on top of the clips).
    const hips = this.hips, spine = this.spine;
    if (hips && spine && Math.abs(this.hipYaw) > 1e-3) {
      // spine' = H^-1 * R(-k*yaw) * H * spine keeps the chest's turn at (1 - k) * yaw.
      tmpQ2.setFromAxisAngle(this.up, -this.hipYaw * SPINE_COUNTER);
      tmpQ.copy(hips.quaternion).invert().multiply(tmpQ2).multiply(hips.quaternion);
      spine.quaternion.premultiply(tmpQ);
      hips.quaternion.premultiply(tmpQ2.setFromAxisAngle(this.up, this.hipYaw));
    }
    // Face forward: the constant turn of the mocap's stance (on the legs, so the whole body turns).
    let fix = 0;
    for (const src of YAW_FIXED) fix += legs[src] * this.yawFix[src];
    if (hips && Math.abs(fix) > 1e-3) hips.quaternion.premultiply(tmpQ2.setFromAxisAngle(this.up, fix));
    // Eyes on the target: turn the chest, neck and head back toward straight ahead.
    let look = 0;
    for (let i = 0; i < SOURCE_COUNT; i++) look += arms[i] * LOOK[ANIM_SOURCES[i]];
    const chain = this.lookBones;
    if (chain.length === 3 && look > 1e-3) {
      const turn = -clamp(wrapAngle(this.yawOf(chain[2]) - this.headRef), -LOOK_MAX, LOOK_MAX) * look;
      // The look's up in the world (it leans with the procedural pivot).
      tmpAxis.set(0, 1, 0).applyQuaternion(this.root.getWorldQuaternion(tmpQ3));
      for (let i = 0; i < 3; i++) {
        const bone = chain[i];
        // local' = Pw^-1 * R(world axis) * Pw * local
        bone.parent!.getWorldQuaternion(tmpQ);
        tmpQ2.setFromAxisAngle(tmpAxis, turn * LOOK_SHARE[i]);
        tmpQ3.copy(tmpQ).invert().multiply(tmpQ2).multiply(tmpQ);
        bone.quaternion.premultiply(tmpQ3);
      }
    }
  }
}
