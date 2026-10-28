import * as THREE from 'three';
import { CONFIG, type AIProfile } from '../config';
import { MODELS, type ModelKey } from '../assets/manifest';
import { events } from '../core/events';
import { feel } from '../core/feel';
import { clamp } from '../core/math';
import type { Game } from '../core/Game';
import { glowTexture } from '../fx/textures';
import type { Wizard } from '../wizard/Wizard';
import type { BossFighter, BossPartner, BossStage, StageAttacks } from './levels';

const C = CONFIG.campaign;
const W = CONFIG.wizard;
/** Every boss has three stages (levels.ts `BossDef.stages`). */
export const STAGE_COUNT = 3;

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpColor = new THREE.Color();
const tmpColor2 = new THREE.Color();
const WHITE = new THREE.Color(1, 1, 1);

const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** The boss's base AI scaled for `stage` (0..2) by CONFIG.campaign.stageAI. A fresh object each call. */
export function stageProfile(boss: BossFighter, stage: number): AIProfile {
  const s = clamp(Math.floor(stage), 0, STAGE_COUNT - 1);
  const A = C.stageAI;
  const b = boss.ai;
  const cap = (v: number) => Math.min(A.maxChance, v);
  return {
    ...b,
    reactionTime: b.reactionTime * A.reactionTime[s],
    aimError: b.aimError * A.aimError[s],
    leadFactor: Math.min(1, b.leadFactor + A.leadBonus[s]),
    burst: [b.burst[0] + A.burstBonus[s], b.burst[1] + A.burstBonus[s]],
    burstPause: [b.burstPause[0] * A.burstPause[s], b.burstPause[1] * A.burstPause[s]],
    strafeSpeed: b.strafeSpeed * A.strafeSpeed[s],
    dodgeChance: cap(b.dodgeChance * A.dodgeChance[s]),
    perfectShieldChance: cap(b.perfectShieldChance * A.perfectShieldChance[s]),
    blastChance: cap(b.blastChance * A.blastChance[s]),
    stunChance: cap(b.stunChance * A.stunChance[s]),
    punishChance: cap(b.punishChance * A.punishChance[s]),
  };
}

/** What a stage brings, for menus: stage 1 lists what it can cast, later stages what they add. */
export function stageAttackSummary(boss: BossFighter, stage: number): string {
  const a = boss.stages[stage].attacks;
  const prev = stage > 0 ? boss.stages[stage - 1].attacks : null;
  const parts: string[] = [];
  if (a.blast && !prev?.blast) parts.push('Blast');
  if (a.stun && !prev?.stun) parts.push('Stun');
  if (a.ultimate && !prev?.ultimate) parts.push('Ultimate');
  if (a.volley && a.volley.name !== prev?.volley?.name) parts.push(a.volley.name);
  if (!prev) return ['Bolts', ...parts].join(' · ');
  return parts.length ? `+ ${parts.join(' · ')}` : 'Sharper and faster';
}

/** A transformation under way. */
interface Transform {
  from: number;
  /** Health fraction the bar refills from (0 when the old stage's bar ran out). */
  refillFrom: number;
  /** Progress 0 -> 1. */
  t: number;
  enraged: boolean;
}

/**
 * Boss stages. A Boss Gauntlet fight starts the boss in stage 1, and every stage has its own health
 * bar (levels.ts `stageHealth`): when it runs out the boss doesn't fall (Wizard.koGuard) but
 * transforms into the next stage, and its next bar refills during the transformation. The hit that
 * emptied a bar loses its overflow. Only emptying the last stage's bar is a KO. Each stage brings
 * its attacks (levels.ts StageAttacks), a sharper AI (`stageAI`, picked up from the `bossStage`
 * event), harder hits (`stageDamage`) and a hurtbox that fits its model (`hurtbox`).
 *
 * A transformation freezes the boss and makes it immune. Headless (QA, soaks) it runs on sim time
 * over `evolveTime`, with a shockwave and a pillar of light. In a live gauntlet fight BossCinematic
 * freezes the world instead and drives it (`drive`, `release`) through its cinematic. Part way
 * through the boss puts on the stage's model; without that GLB its current look grows instead
 * (`placeholderScale`, `aura`).
 *
 * Everything is keyed to one `owner` wizard and its own bars, so each boss wizard has its own
 * instance: Game.stages for the rival and Game.partnerStages for a double fight's partner. Game
 * calls `setBoss` from setupEnemy, `reset` from resetArena (every round start), `update` every
 * tick, and `enrage` on the survivor when one of a pair falls. With no boss (Quick Duel, the
 * default rival, a parked partner) it idles.
 */
export class BossStages {
  /** The boss the owner is dressed as, or null (then nothing here runs). */
  boss: BossFighter | null = null;
  /** Current stage, 0..2. Set when a transformation starts, so it leads the look by half a transform. */
  stage = 0;
  /**
   * QA scenarios run on stock stats (Game.useDefaultStats): no per-stage bars (a 0 HP boss is
   * KO'd), no stage damage, no enrage and no `bossStage` events, so the AI keeps every attack.
   */
  suspended = false;
  /** Stage model currently on the rival, or null for the primitive placeholder. */
  private shownModel: ModelKey | null = null;
  /** Visual-root scale for the current look, before the transformation pop. */
  private scale = 1;
  private swapPending = false;
  /** The partner fell mid-transformation: enrage as soon as this one is done. */
  private enragePending = false;
  private tf: Transform | null = null;
  /** BossCinematic is driving the current transformation (no sim-time progress). */
  private driven = false;
  private moteTimer = 0;
  private time = 0;
  private auraLevel = 0;
  /** Glow, ground ring and motes around the boss; parented to the rival's visual root so it follows. */
  private readonly aura = new THREE.Group();
  private readonly auraGlow: THREE.Sprite;
  private readonly auraRing: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;

  /**
   * `owner`: the boss wizard whose health drives the stages (`game.enemy` or `game.partner`).
   * `target`: who the evolution shockwave pushes (the player).
   */
  constructor(private readonly game: Game, readonly owner: Wizard, private readonly target: Wizard) {
    this.auraGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false,
    }));
    this.auraGlow.position.y = 1.1;
    this.auraGlow.renderOrder = 10;
    this.auraRing = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1.3, 48),
      new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    this.auraRing.rotation.x = -Math.PI / 2;
    this.auraRing.position.y = 0.04;
    this.aura.add(this.auraGlow, this.auraRing);
    this.aura.visible = false;
    owner.visual.root.add(this.aura);

    // An emptied bar with a stage still to come is not a KO: the boss transforms instead.
    owner.koGuard = () => this.active && this.stage < STAGE_COUNT - 1;
    events.on('damage', (e) => {
      if (e.target === owner && e.amount > 0) this.checkHealth();
    });
    game.onFrame((dt) => this.frame(dt));
  }

  /** A boss fight's stages are running (a boss, and not suspended for QA). */
  get active(): boolean {
    return this.boss !== null && !this.suspended;
  }

  /** The current stage's definition, or null without a boss. */
  get current(): BossStage | null {
    return this.boss ? this.boss.stages[this.stage] : null;
  }

  /** What the boss may cast right now, or null (no boss: everything). */
  get attacks(): StageAttacks | null {
    return this.current?.attacks ?? null;
  }

  /** The boss is mid-transformation (or in the short grace after a cinematic): frozen and immune. */
  get evolving(): boolean {
    return this.boss !== null && this.owner.evolving;
  }

  /** A transformation is under way (its look and health bar are still changing). */
  get transforming(): boolean {
    return this.tf !== null;
  }

  /** 0 -> 1 through the current transformation (1 when not transforming). */
  get evolveProgress(): number {
    return this.tf ? this.tf.t : 1;
  }

  /** The current transformation is the enraged one (a double fight's survivor). */
  get enragedTransform(): boolean {
    return !!this.tf?.enraged;
  }

  /** Model key on the boss right now (null: the primitive placeholder). */
  get modelShown(): ModelKey | null {
    return this.shownModel;
  }

  /** Visual-root scale of the current look (placeholder growth), without the transformation pop. */
  get lookScale(): number {
    return this.scale;
  }

  /** HP of `stage`'s bar for this boss (stock max health without a boss). */
  stageHealth(stage = this.stage): number {
    return this.boss ? this.boss.stageHealth[clamp(stage, 0, STAGE_COUNT - 1)] : W.maxHealth;
  }

  /** Called by Game.setupEnemy after it dressed the owner (stage 1's model, or the default rival). */
  setBoss(boss: BossFighter | null): void {
    if (boss !== this.boss) {
      // setupEnemy just put on stage 1's model (or the placeholder when that GLB is missing).
      this.shownModel = boss && this.owner.visual.usesModel ? boss.stages[0].model : null;
      if (boss) {
        this.auraGlow.material.color.setHex(boss.palette.spell).multiplyScalar(1.6);
        this.auraRing.material.color.setHex(boss.palette.ultimate).multiplyScalar(1.4);
      }
    }
    this.boss = boss;
    this.toStage(0);
  }

  /** Round start (Game.resetArena): back to stage 1 and its bar, at once. */
  reset(): void {
    this.toStage(0);
  }

  /**
   * Start the transformation into `stage` (1 or 2) now. An emptied bar calls this; public for QA
   * and screenshots. Ignored without a boss, mid-transformation, or for a stage not above the current.
   * `enraged`: the partner fell (see `enrage`), announced as such.
   */
  evolveTo(stage: number, enraged = false): void {
    const boss = this.boss;
    const g = this.game;
    const e = this.owner, p = this.target;
    if (!boss || !e.alive || e.evolving || stage <= this.stage || stage >= STAGE_COUNT) return;
    const from = this.stage;
    const refillFrom = e.maxHealth > 0 ? clamp(e.health / e.maxHealth, 0, 1) : 0;
    this.stage = stage;
    this.swapPending = true;
    this.driven = false;
    this.applyStats();
    this.tf = { from, refillFrom, t: 0, enraged };
    // The new bar starts where the old one left off (empty, or the survivor's share) and refills.
    if (this.active) e.health = e.maxHealth * refillFrom;

    // Frozen and immune for the whole transformation; whatever it was doing stops.
    e.evolveTime = C.evolveTime;
    e.cast = null;
    e.shieldTime = e.stunTime = e.dodgeTime = 0;
    e.vel.set(0, 0, 0);
    e.knock.set(0, 0, 0);
    e.intent.clear();

    // Shockwave: shoves the player away if close (full strength at the centre, half at the edge).
    tmpA.set(p.pos.x - e.pos.x, 0, p.pos.z - e.pos.z);
    const d = tmpA.length();
    if (p.alive && d < C.evolveRadius) {
      if (d < 1e-3) e.forward(tmpA);
      p.addKnockback(tmpA.x, tmpA.z, C.evolveKnockback * (1 - 0.5 * (d / C.evolveRadius)));
    }

    // A burst in the boss's colours (no smoke). A live fight's cinematic brings the rest of the show.
    const pal = boss.palette;
    e.chest(tmpB);
    this.paletteBurst(tmpB, 1.4);
    g.fx.ring(e.pos, pal.spell, C.evolveRadius, 0.5);
    if (!g.transformCinematics) {
      g.fx.light(tmpB, pal.ultimate, 28, C.evolveTime * 0.5);
      // Pillar of light: a vertical beam from the pooled spell beams.
      tmpA.set(e.pos.x, 0, e.pos.z);
      tmpB.set(e.pos.x, C.pillarHeight, e.pos.z);
      g.spells.spellFx.beam(tmpA, tmpB, pal.ultimate, C.pillarTime, C.pillarWidth);
      feel.freeze(C.evolveHitStopMs);
      feel.screenFlash(pal.ultimate, C.evolveFlash);
      feel.shakeAt(e.pos, C.evolveShake, 40);
    }

    events.emit('bossEvolve', { wizard: e, boss, stage, from, pos: e.pos, enraged });
    this.announce();
  }

  /**
   * A double fight's other boss just fell: go straight to the last stage (its AI, attacks, damage,
   * look and a full last-stage bar) with an "enraged" transformation, unless already there.
   * Mid-transformation it waits for the current one to finish. Ignored while suspended (QA stock
   * stats), without a boss, or KO'd. Returns true if this boss will enrage.
   */
  enrage(): boolean {
    const last = STAGE_COUNT - 1;
    if (!this.active || !this.owner.alive || this.stage >= last) return false;
    if (this.owner.evolving) this.enragePending = true;
    else this.evolveTo(last, true);
    return true;
  }

  /**
   * BossCinematic: take over the current transformation, then set its progress (0..1, it only
   * moves forward). The health bar refills and the look swaps with it, as on sim time.
   */
  drive(progress: number): void {
    const tf = this.tf;
    if (!tf) return;
    this.driven = true;
    tf.t = Math.max(tf.t, clamp(progress, 0, 1));
    // Keep the owner frozen and immune however long the cinematic runs.
    this.owner.evolveTime = Math.max(this.owner.evolveTime, 1e-3);
    this.applyTransform();
  }

  /**
   * BossCinematic is done: finish the transformation at once (full bar, new look) and keep the boss
   * frozen and immune for `grace` more seconds of sim time.
   */
  release(grace: number): void {
    if (!this.tf) return;
    this.tf.t = 1;
    this.applyTransform();
    this.finishTransform();
    this.owner.evolveTime = Math.max(0, grace);
  }

  /** Every fixed tick (Game.tick): the transformation's progress, aura motes, a waiting enrage. */
  update(dt: number): void {
    const boss = this.boss;
    if (!boss) return;
    const e = this.owner;
    const tf = this.tf;
    if (tf && !this.driven) {
      tf.t = e.evolving ? Math.max(tf.t, 1 - e.evolveTime / C.evolveTime) : 1;
      this.applyTransform();
      if (tf.t >= 1) this.finishTransform();
    }
    // Never stand at 0 HP with a stage left (a refused transformation): transform now.
    if (this.active && e.alive && !e.evolving && e.health <= 0) this.checkHealth();
    if (this.enragePending && !e.evolving) {
      this.enragePending = false;
      if (e.alive && this.active) this.evolveTo(STAGE_COUNT - 1, true);
    }
    if (this.tf && !this.driven) this.emitPillar(boss);
    else if (this.auraLevel > 0 && e.alive && dt > 0) this.emitMotes(boss, dt);
  }

  /**
   * The stage this boss belongs in right now, never below the current one. The single place a
   * stage change is decided: the next stage once the current stage's own bar is empty.
   * (`enrage` is the only other trigger.)
   */
  desiredStage(): number {
    const e = this.owner;
    return e.health <= 0 && this.stage < STAGE_COUNT - 1 ? this.stage + 1 : this.stage;
  }

  // ------------------------------------------------------------------ internals

  /** After every hit on the owner: transform if its stage's bar is empty and a stage remains. */
  private checkHealth(): void {
    const e = this.owner;
    if (!this.active || !e.alive || e.evolving) return;
    const target = this.desiredStage();
    if (target > this.stage) this.evolveTo(target);
  }

  /** Health refill and the look swap at the transformation's current progress. */
  private applyTransform(): void {
    const tf = this.tf!;
    const e = this.owner;
    if (this.active && e.alive) {
      const k = smoothstep(C.refill[0], C.refill[1], tf.t);
      e.health = e.maxHealth * (tf.refillFrom + (1 - tf.refillFrom) * k);
    }
    if (this.swapPending && tf.t >= C.evolveSwapAt) {
      this.swapPending = false;
      this.applyLook(this.stage);
      // The new form bursts out.
      this.paletteBurst(e.chest(tmpA), 1);
      if (!this.driven) feel.shakeAt(e.pos, C.evolveShake * 0.5, 40);
    }
  }

  private finishTransform(): void {
    const e = this.owner;
    if (this.swapPending) {
      this.swapPending = false;
      this.applyLook(this.stage);
    }
    if (this.active && e.alive) e.health = e.maxHealth;
    this.tf = null;
    this.driven = false;
  }

  /** Jump to `stage` without a transformation (round start, a new boss). */
  private toStage(stage: number): void {
    const e = this.owner;
    this.stage = stage;
    this.swapPending = false;
    this.enragePending = false;
    this.tf = null;
    this.driven = false;
    e.evolveTime = 0;
    this.applyStats();
    if (this.boss) {
      this.applyLook(stage);
    } else {
      this.scale = 1;
      this.auraLevel = 0;
      e.visual.root.scale.setScalar(1);
      if (this.owner === this.game.enemy) e.setHitbox(W.radius, W.height);
    }
    this.announce();
  }

  /**
   * Per stage: the boss hits harder (CONFIG.campaign.stageDamage) and has that stage's bar as its
   * max health. Left alone while suspended (QA stock stats).
   */
  private applyStats(): void {
    if (!this.boss || this.suspended) return;
    this.owner.damageMultiplier = this.boss.damageMultiplier * C.stageDamage[this.stage];
    this.owner.maxHealth = this.stageHealth();
  }

  private announce(): void {
    if (!this.suspended) events.emit('bossStage', { wizard: this.owner, boss: this.boss, stage: this.stage });
  }

  /** The capsule this boss has at stage 1 size: a short partner's own, else the standard one. */
  private baseHitbox(): { radius: number; height: number } {
    const b = this.boss as BossPartner | null;
    return b?.hitbox ?? { radius: W.radius, height: W.height };
  }

  /**
   * Put on `stage`'s look: its GLB if there is one; otherwise keep the latest earlier stage's model
   * (or the placeholder) and grow it by placeholderScale relative to that stage. The aura and the
   * hurtbox follow the stage either way.
   */
  private applyLook(stage: number): void {
    const boss = this.boss!;
    const e = this.owner;
    const v = e.visual;
    let look = -1;
    for (let s = stage; s >= 0 && look < 0; s--) {
      const key = boss.stages[s].model;
      if (key === this.shownModel) {
        look = s;
        break;
      }
      const model = this.game.assets.instantiate(key);
      if (model) {
        v.setAppearance(boss.palette, model, MODELS[key], boss.id);
        this.shownModel = key;
        look = s;
      }
    }
    if (look < 0) {
      if (this.shownModel !== null) v.setAppearance(boss.palette, null, MODELS[boss.stages[0].model], boss.id);
      this.shownModel = null;
      look = 0;
    }
    this.scale = C.placeholderScale[stage] / C.placeholderScale[look];
    v.root.scale.setScalar(this.scale);
    this.auraLevel = C.aura[stage];
    // Hurtbox: as tall as most of the look (never below the stage 1 capsule), wider each stage.
    const base = this.baseHitbox();
    const height = Math.max(base.height, C.hurtbox.modelHeight * v.topHeight * this.scale);
    e.setHitbox(C.hurtbox.radius[stage] * (base.radius / W.radius), height);
    // The aura sits around the body, so a short boss gets a lower, smaller one.
    const k = e.sizeScale;
    this.auraGlow.position.y = 1.1 * Math.min(k, 1.2) / this.scale;
    this.aura.scale.setScalar(Math.max(0.6, Math.min(k, 1.2)) / this.scale);
  }

  /** A burst of sparks and light in the boss's colours (no dark smoke). */
  private paletteBurst(at: THREE.Vector3, size: number): void {
    const boss = this.boss!;
    const fx = this.game.fx;
    tmpColor.setHex(boss.palette.spell);
    tmpColor2.setHex(boss.palette.ultimate).lerp(WHITE, 0.45);
    fx.sparks.burst(at, Math.round(60 * size), tmpColor, 3, 3 * size, 11 * size, 0.24, 0.7, { gravity: 3, drag: 2.2 });
    fx.sparks.burst(at, Math.round(26 * size), tmpColor2, 3.5, 1, 4 * size, 0.36, 0.45, { drag: 4 });
    fx.flash(at, boss.palette.ultimate, 4.5 * size, 0.18);
  }

  /** Sparks streaming up the light pillar while the boss transforms. */
  private emitPillar(boss: BossFighter): void {
    const fx = this.game.fx;
    const pos = this.owner.pos;
    tmpColor.setHex(boss.palette.ultimate);
    tmpColor2.setHex(boss.palette.spell).lerp(WHITE, 0.4);
    for (let i = 0; i < 4; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 0.25 + Math.random() * 1.1;
      const swirl = 3 + Math.random() * 3;
      fx.sparks.emit(
        pos.x + Math.sin(a) * r, Math.random() * 1.8, pos.z + Math.cos(a) * r,
        Math.cos(a) * swirl, 7 + Math.random() * 9, -Math.sin(a) * swirl,
        i % 2 ? tmpColor : tmpColor2, 2.6, 0.12 + Math.random() * 0.12, 0.7 + Math.random() * 0.5, { drag: 1.2, gravity: -2 },
      );
    }
  }

  /** A few motes drifting up off a stage 2/3 boss. */
  private emitMotes(boss: BossFighter, dt: number): void {
    this.moteTimer -= dt * this.auraLevel;
    if (this.moteTimer > 0) return;
    this.moteTimer = 0.07;
    const pos = this.owner.pos;
    const a = Math.random() * Math.PI * 2;
    const r = (0.4 + Math.random() * 0.5) * this.scale;
    tmpColor.setHex(Math.random() < 0.5 ? boss.palette.spell : boss.palette.ultimate);
    this.game.fx.sparks.emit(
      pos.x + Math.sin(a) * r, pos.y + Math.random() * 1.6 * this.scale, pos.z + Math.cos(a) * r,
      0, 1.2 + Math.random() * 1.6, 0,
      tmpColor, 2, 0.1 + Math.random() * 0.08, 0.8 + Math.random() * 0.5, { drag: 0.6, gravity: -0.4 },
    );
  }

  /** Render frames: aura pulse and (headless-style) the crouch-and-burst pop through a transformation. */
  private frame(dt: number): void {
    const e = this.owner;
    this.time += dt;
    const transforming = this.tf !== null;
    const level = this.boss && e.alive ? (transforming ? Math.max(this.auraLevel, C.aura[STAGE_COUNT - 1]) * 1.5 : this.auraLevel) : 0;
    this.aura.visible = level > 0;
    if (this.aura.visible) {
      const pulse = 0.85 + 0.15 * Math.sin(this.time * 4.2);
      this.auraGlow.material.opacity = 0.3 * level * pulse;
      this.auraGlow.scale.setScalar(2.4 + level * 0.9 + (transforming ? 1.2 * Math.sin(this.evolveProgress * Math.PI) : 0));
      this.auraRing.material.opacity = 0.42 * level * pulse;
      this.auraRing.scale.setScalar(1 + 0.12 * Math.sin(this.time * 2.6));
      this.auraRing.rotation.z = this.time * 0.6;
    }
    if (!this.boss) return;
    let pop = 1;
    if (transforming && !this.driven) {
      // Crouch into the swap, then burst out past the new size and settle.
      const p = this.evolveProgress, at = C.evolveSwapAt;
      pop = p < at ? 1 - 0.14 * Math.sin((p / at) * Math.PI * 0.5) : 1 + 0.1 * Math.sin(((p - at) / (1 - at)) * Math.PI);
    }
    // The cinematic (a later frame hook) poses the root itself while it drives the transformation.
    e.visual.root.scale.setScalar(this.scale * pop);
  }
}
