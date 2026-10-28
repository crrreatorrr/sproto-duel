import * as THREE from 'three';
import { CONFIG, type AIProfile } from '../config';
import { MODELS, type ModelKey } from '../assets/manifest';
import { events } from '../core/events';
import { feel } from '../core/feel';
import { clamp, rand } from '../core/math';
import type { Game } from '../core/Game';
import { glowTexture } from '../fx/textures';
import type { Wizard } from '../wizard/Wizard';
import type { BossDef, BossStage, StageAttacks } from './levels';

const C = CONFIG.campaign;
/** Every boss has three stages (levels.ts `BossDef.stages`). */
export const STAGE_COUNT = 3;

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpAim = new THREE.Vector3();
const tmpColor = new THREE.Color();
const tmpColor2 = new THREE.Color();
const WHITE = new THREE.Color(1, 1, 1);

/** The stage a boss belongs in at this health fraction (0..1): 0 above the first threshold, then 1, then 2. */
export function stageForHealth(fraction: number): number {
  const [second, third] = C.stageThresholds;
  return fraction <= third ? 2 : fraction <= second ? 1 : 0;
}

/** The boss's base AI scaled for `stage` (0..2) by CONFIG.campaign.stageAI. A fresh object each call. */
export function stageProfile(boss: BossDef, stage: number): AIProfile {
  const s = clamp(Math.floor(stage), 0, STAGE_COUNT - 1);
  const A = C.stageAI;
  const b = boss.ai;
  return {
    ...b,
    reactionTime: b.reactionTime * A.reactionTime[s],
    aimError: b.aimError * A.aimError[s],
    burst: [b.burst[0] + A.burstBonus[s], b.burst[1] + A.burstBonus[s]],
    burstPause: [b.burstPause[0] * A.burstPause[s], b.burstPause[1] * A.burstPause[s]],
    strafeSpeed: b.strafeSpeed * A.strafeSpeed[s],
    dodgeChance: Math.min(A.maxChance, b.dodgeChance * A.dodgeChance[s]),
    perfectShieldChance: Math.min(A.maxChance, b.perfectShieldChance * A.perfectShieldChance[s]),
  };
}

/** What a stage brings, for menus: stage 1 lists what it can cast, later stages what they add. */
export function stageAttackSummary(boss: BossDef, stage: number): string {
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

/**
 * Boss stages. In every round of a Boss Gauntlet fight the boss starts in stage 1 and evolves at
 * CONFIG.campaign.stageThresholds of its health (one health bar spans all three stages; a big hit
 * can skip a stage, with a single transformation). Evolving takes `evolveTime`: the boss is frozen
 * and immune, a shockwave pushes the player back, a pillar of light rises, and part way through it
 * puts on the stage's model. Without that GLB the current look grows and glows instead
 * (`placeholderScale`, `aura`). Each stage also brings its attacks (levels.ts StageAttacks) and a
 * sharper AI (`stageAI`), which the AI picks up from the `bossStage` event; stages with
 * `sidekickFires` have the boss's companion throw bolts too, while CONFIG.campaign.sidekick.enabled.
 *
 * Everything is keyed to one `owner` wizard and its own health bar, so a second boss wizard can get
 * its own instance. Game owns one for the rival: `setBoss` from setupEnemy, `reset` from resetArena
 * (every round start), `update` every tick. With no boss (Quick Duel, the default rival) it idles.
 */
export class BossStages {
  /** The boss the rival is dressed as, or null (then nothing here runs). */
  boss: BossDef | null = null;
  /** Current stage, 0..2. Set when a transformation starts, so it leads the look by half a transform. */
  stage = 0;
  /**
   * QA scenarios run on stock stats (Game.useDefaultStats): no health-triggered evolution, no
   * sidekick bolts and no `bossStage` events, so the AI keeps every attack.
   */
  suspended = false;
  /** Stage model currently on the rival, or null for the primitive placeholder. */
  private shownModel: ModelKey | null = null;
  /** Visual-root scale for the current look, before the transformation pop. */
  private scale = 1;
  private swapPending = false;
  private sidekickTimer = 0;
  private moteTimer = 0;
  private time = 0;
  private auraLevel = 0;
  /** Glow, ground ring and motes around the boss; parented to the rival's visual root so it follows. */
  private readonly aura = new THREE.Group();
  private readonly auraGlow: THREE.Sprite;
  private readonly auraRing: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;

  /**
   * `owner`: the boss wizard whose health drives the stages (the rival, `game.enemy`). `target`: who
   * the evolution shockwave and sidekick bolts are aimed at (the player).
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

  /** The boss is mid-transformation. */
  get evolving(): boolean {
    return this.boss !== null && this.owner.evolving;
  }

  /** 0 -> 1 through the current transformation (1 when not transforming). */
  get evolveProgress(): number {
    return this.evolving ? 1 - this.owner.evolveTime / C.evolveTime : 1;
  }

  /** Model key on the boss right now (null: the primitive placeholder). */
  get modelShown(): ModelKey | null {
    return this.shownModel;
  }

  /** Visual-root scale of the current look (placeholder growth), without the transformation pop. */
  get lookScale(): number {
    return this.scale;
  }

  /** Called by Game.setupEnemy after it dressed the rival (stage 1's model, or the default rival). */
  setBoss(boss: BossDef | null): void {
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

  /** Round start (Game.resetArena): back to stage 1, at once. */
  reset(): void {
    this.toStage(0);
  }

  /**
   * Start the transformation into `stage` (1 or 2) now. Health thresholds call this; public for QA
   * and screenshots. Ignored without a boss, mid-transformation, or for a stage not above the current.
   */
  evolveTo(stage: number): void {
    const boss = this.boss;
    const g = this.game;
    const e = this.owner, p = this.target;
    if (!boss || !e.alive || e.evolving || stage <= this.stage || stage >= STAGE_COUNT) return;
    const from = this.stage;
    this.stage = stage;
    this.swapPending = true;
    this.applyDamage();

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

    const pal = boss.palette;
    e.chest(tmpB);
    g.fx.explosion(tmpB, pal.ultimate, 2.4);
    g.fx.ring(e.pos, pal.spell, C.evolveRadius, 0.5);
    g.fx.light(tmpB, pal.ultimate, 28, C.evolveTime * 0.5);
    // Pillar of light: a vertical beam from the pooled spell beams.
    tmpA.set(e.pos.x, 0, e.pos.z);
    tmpB.set(e.pos.x, C.pillarHeight, e.pos.z);
    g.spells.spellFx.beam(tmpA, tmpB, pal.ultimate, C.pillarTime, C.pillarWidth);
    feel.freeze(C.evolveHitStopMs);
    feel.screenFlash(pal.ultimate, C.evolveFlash);
    feel.shakeAt(e.pos, C.evolveShake, 40);

    events.emit('bossEvolve', { wizard: e, boss, stage, from, pos: e.pos });
    this.announce();
  }

  /** Every fixed tick (Game.tick): the look swap, the light pillar, aura motes, sidekick bolts. */
  update(dt: number): void {
    const boss = this.boss;
    if (!boss) return;
    const g = this.game;
    const e = this.owner;
    if (this.swapPending && (this.evolveProgress >= C.evolveSwapAt || !e.evolving)) {
      this.swapPending = false;
      this.applyLook(this.stage);
      // The new form bursts out.
      g.fx.explosion(e.chest(tmpA), boss.palette.spell, 1.6);
      feel.shakeAt(e.pos, C.evolveShake * 0.5, 40);
    }
    if (e.evolving) this.emitPillar(boss);
    else if (this.auraLevel > 0 && e.alive) this.emitMotes(boss, dt);
    this.updateSidekick(dt);
  }

  // ------------------------------------------------------------------ internals

  private checkHealth(): void {
    const e = this.owner;
    if (!this.active || !e.alive || e.evolving) return;
    const target = stageForHealth(e.health / e.maxHealth);
    if (target > this.stage) this.evolveTo(target);
  }

  /** Jump to `stage` without a transformation (round start, a new boss). */
  private toStage(stage: number): void {
    const e = this.owner;
    this.stage = stage;
    this.swapPending = false;
    e.evolveTime = 0;
    this.sidekickTimer = rand(C.sidekick.interval[0], C.sidekick.interval[1]);
    this.applyDamage();
    if (this.boss) {
      this.applyLook(stage);
    } else {
      this.scale = 1;
      this.auraLevel = 0;
      e.visual.root.scale.setScalar(1);
    }
    this.announce();
  }

  /** The boss hits harder each stage (CONFIG.campaign.stageDamage). Left alone while suspended (QA stock stats). */
  private applyDamage(): void {
    if (this.boss && !this.suspended) this.owner.damageMultiplier = this.boss.damageMultiplier * C.stageDamage[this.stage];
  }

  private announce(): void {
    if (!this.suspended) events.emit('bossStage', { wizard: this.owner, boss: this.boss, stage: this.stage });
  }

  /**
   * Put on `stage`'s look: its GLB if there is one; otherwise keep the latest earlier stage's model
   * (or the placeholder) and grow it by placeholderScale relative to that stage. The aura follows
   * the stage either way.
   */
  private applyLook(stage: number): void {
    const boss = this.boss!;
    const v = this.owner.visual;
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
  }

  /** Sparks streaming up the light pillar while the boss transforms. */
  private emitPillar(boss: BossDef): void {
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
  private emitMotes(boss: BossDef, dt: number): void {
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

  /**
   * Stages with `sidekickFires`: the companion throws one of the boss's bolts at the target every
   * CONFIG.campaign.sidekick.interval s, from WizardVisual.companionMuzzle (no companion, no throw).
   * Never during round intros/ends, a transformation, or while the boss is stunned. Off unless
   * CONFIG.campaign.sidekick.enabled (Obama's partner is to become a wizard of his own).
   */
  private updateSidekick(dt: number): void {
    const g = this.game;
    const e = this.owner, p = this.target;
    if (!C.sidekick.enabled || !this.attacks?.sidekickFires || this.suspended || g.actionsLocked) return;
    if (!e.alive || !p.alive || e.evolving || e.stunned) return;
    this.sidekickTimer -= dt;
    if (this.sidekickTimer > 0) return;
    const S = C.sidekick;
    this.sidekickTimer = rand(S.interval[0], S.interval[1]);
    if (!e.visual.companionMuzzle(tmpA)) return;
    // Lead the player a little, plus some wobble.
    const travel = tmpA.distanceTo(p.pos) / CONFIG.spells.bolt.speed;
    p.chest(tmpAim).addScaledVector(p.vel, travel * S.lead);
    tmpB.subVectors(tmpAim, tmpA).normalize();
    tmpB.x += rand(-1, 1) * S.aimError;
    tmpB.y += rand(-0.5, 0.5) * S.aimError;
    tmpB.z += rand(-1, 1) * S.aimError;
    g.spells.castSidekickBolt(e, tmpA, tmpB.normalize());
  }

  /** Render frames: aura pulse and the crouch-and-burst pop through a transformation. */
  private frame(dt: number): void {
    const e = this.owner;
    this.time += dt;
    const evolving = this.evolving;
    const level = this.boss && e.alive ? (evolving ? Math.max(this.auraLevel, C.aura[STAGE_COUNT - 1]) * 1.5 : this.auraLevel) : 0;
    this.aura.visible = level > 0;
    if (this.aura.visible) {
      const pulse = 0.85 + 0.15 * Math.sin(this.time * 4.2);
      this.auraGlow.material.opacity = 0.3 * level * pulse;
      this.auraGlow.scale.setScalar(2.4 + level * 0.9 + (evolving ? 1.2 * Math.sin(this.evolveProgress * Math.PI) : 0));
      this.auraRing.material.opacity = 0.42 * level * pulse;
      this.auraRing.scale.setScalar(1 + 0.12 * Math.sin(this.time * 2.6));
      this.auraRing.rotation.z = this.time * 0.6;
    }
    if (!this.boss) return;
    let pop = 1;
    if (evolving) {
      // Crouch into the swap, then burst out past the new size and settle.
      const p = this.evolveProgress, at = C.evolveSwapAt;
      pop = p < at ? 1 - 0.14 * Math.sin((p / at) * Math.PI * 0.5) : 1 + 0.1 * Math.sin(((p - at) / (1 - at)) * Math.PI);
    }
    e.visual.root.scale.setScalar(this.scale * pop);
  }
}
