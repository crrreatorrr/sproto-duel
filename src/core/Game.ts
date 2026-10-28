import * as THREE from 'three';
import { CONFIG } from '../config';
import { AssetLoader } from '../assets/AssetLoader';
import { MODELS, type ModelKey } from '../assets/manifest';
import type { BossDef, BossPartner } from '../campaign/levels';
import { BossStages } from '../campaign/BossStages';
import { Arena } from '../arena/Arena';
import { FireRing } from '../arena/FireRing';
import { GoldenTickets } from '../arena/GoldenTickets';
import { LifePacks } from '../arena/LifePacks';
import { CameraRig } from '../camera/CameraRig';
import { Effects } from '../fx/Effects';
import { Physics } from '../physics/Physics';
import { PlayerController } from '../player/PlayerController';
import { Renderer } from '../render/Renderer';
import { SpellSystem } from '../spells/SpellSystem';
import { DamageNumbers } from '../ui/DamageNumbers';
import { Wizard } from '../wizard/Wizard';
import { WizardVisual } from '../wizard/WizardVisual';
import { events } from './events';
import { feel } from './feel';
import { Input } from './Input';

/** Anything that drives a wizard from inside the fixed tick (AI, training dummy). */
export interface TickController {
  update(dt: number): void;
  reset?(): void;
}

const tmp = new THREE.Vector3();
const tmpEye = new THREE.Vector3();
const FADE = CONFIG.camera.bossFade;

/** The standing wizard in `list` nearest `from`, or null if all are down. */
export function nearestStanding(from: Wizard, list: readonly Wizard[]): Wizard | null {
  let best: Wizard | null = null;
  let bestD = Infinity;
  for (const w of list) {
    if (!w.alive) continue;
    const d = w.pos.distanceToSquared(from.pos);
    if (d < bestD) {
      bestD = d;
      best = w;
    }
  }
  return best;
}

export class Game {
  readonly renderer: Renderer;
  readonly input: Input;
  readonly rig: CameraRig;
  readonly arena: Arena;
  readonly fx: Effects;
  readonly fire: FireRing;
  readonly spells: SpellSystem;
  /**
   * Every wizard in the fight, the single source of truth (SpellSystem holds this same array).
   * [player, enemy], plus `partner` while a double fight is on. Mutated in place, never replaced.
   */
  readonly wizards: Wizard[];
  readonly player: Wizard;
  /** The rival (index 1, side 1): the Quick Duel opponent or the campaign boss. */
  readonly enemy: Wizard;
  /**
   * A double fight's second boss (index 2, side 1), created once. Only in `wizards` (and solid and
   * visible) while the current boss has a `partner`; otherwise parked. See setupPartner.
   */
  readonly partner: Wizard;
  /** The player's opponents in this fight, alive or not: [enemy], or [enemy, partner]. Mutated in place. */
  readonly enemies: Wizard[];
  readonly playerController: PlayerController;
  readonly popups: DamageNumbers;
  /** Golden-ticket pickups (mana boost). Match enables spawning during the fight phase. */
  readonly tickets: GoldenTickets;
  /** Life packs (health pickups, Boss Gauntlet only): Match enables them during a gauntlet fight. */
  readonly lifePacks: LifePacks;
  /** Drives the enemies inside the fixed tick (App: the rival's AI, and the partner's in a double fight). */
  enemyController: TickController | null = null;
  /** The campaign boss the rival is dressed as, or null for the default rival. */
  boss: BossDef | null = null;
  /** The boss's three in-round stages (evolution, stage looks and attacks). Idle without a boss. */
  readonly stages: BossStages;
  /** The partner's own stages, keyed to its own health bar. Idle outside a double fight. */
  readonly partnerStages: BossStages;
  private enemyLook = 'rival';
  private partnerLook = '';

  /** False while paused or in menus: the simulation doesn't advance. */
  simulating = true;
  /** Player input is read only while true. */
  playerControl = true;
  /** When true (countdowns, round end) nobody can move or cast; the camera still turns. */
  actionsLocked = false;
  /** Set by the QA harness: match flow and other tick hooks stay out of scenario runs. */
  qaMode = false;
  /**
   * Plays boss transformations as cinematics (App's BossCinematic). While it is `live` (a gauntlet
   * fight being played, not QA or a soak) BossStages leaves the light show to it.
   */
  presenter: { readonly live: boolean } | null = null;
  /**
   * Time scale a cinematic applies to the simulation, on top of hit-stop and slow-mo: 1 normal, 0
   * frozen (no ticks: nobody moves, casts, burns or takes damage). Below 1 the player's input is
   * ignored, and effects (particles, flashes, rings) run on real time so the cinematic stays alive.
   */
  cinematicScale = 1;
  /** Takes over the camera each frame after the rig has placed it (BossCinematic), or null. */
  director: ((realDt: number) => void) | null = null;
  /** Total simulated time. */
  simTime = 0;
  /** Smoothed frame stats for the QA harness / perf overlay. */
  readonly perf = { fps: 0, frameMs: 0, worstMs: 0, frames: 0 };

  private accumulator = 0;
  private lastTime = 0;
  private renderTime = 0;
  private readonly tickHooks: ((dt: number) => void)[] = [];
  private readonly frameHooks: ((realDt: number, alpha: number) => void)[] = [];

  static async create(container: HTMLElement, ui: HTMLElement): Promise<Game> {
    const [physics, assets] = await Promise.all([Physics.create(), (async () => {
      const a = new AssetLoader();
      await a.loadAll();
      return a;
    })()]);
    return new Game(container, ui, physics, assets);
  }

  private constructor(
    container: HTMLElement,
    readonly ui: HTMLElement,
    readonly physics: Physics,
    readonly assets: AssetLoader,
  ) {
    this.renderer = new Renderer(container);
    const scene = this.renderer.scene;
    this.input = new Input(this.renderer.canvas);
    this.rig = new CameraRig(this.renderer.camera);
    this.arena = new Arena(scene, physics, assets);
    this.fx = new Effects(scene);
    this.fire = new FireRing(scene, this.fx);
    this.arena.attach(this.fire);

    const makeWizard = (index: 0 | 1 | 2) => {
      const team = CONFIG.teams[index === 0 ? 0 : 1];
      const modelKey = index === 0 ? 'wizardPlayer' : 'wizardRival';
      const visual = new WizardVisual(team, assets.instantiate(modelKey), MODELS[modelKey]);
      scene.add(visual.root);
      return new Wizard(index, index === 0 ? 0 : 1, team, team.name, visual, physics);
    };
    this.player = makeWizard(0);
    this.enemy = makeWizard(1);
    this.partner = makeWizard(2);
    this.wizards = [this.player, this.enemy];
    this.enemies = [this.enemy];
    feel.local = this.player;

    this.spells = new SpellSystem(scene, physics, this.fx, this.wizards, this.arena);
    this.tickets = new GoldenTickets(scene, physics, this.fx, this.wizards, this.arena, assets);
    this.lifePacks = new LifePacks(scene, physics, this.fx, this.player, this.enemies, this.tickets, this.arena, () => this.furthestStage(), assets);
    this.playerController = new PlayerController(this.input, this.rig, this.player, physics, () => this.enemies);
    this.popups = new DamageNumbers(ui, this.renderer.camera);
    this.stages = new BossStages(this, this.enemy, this.player);
    this.partnerStages = new BossStages(this, this.partner, this.player);
    this.parkPartner();
    // A double fight: when one boss falls, the other is enraged (straight to its last stage).
    events.on('ko', (e) => {
      if (!this.partnerActive || e.loser.side !== 1) return;
      const survivor = e.loser === this.enemy ? this.partner : e.loser === this.partner ? this.enemy : null;
      if (survivor?.alive) this.stagesOf(survivor)?.enrage();
    });

    const syncPointScale = () => {
      this.fx.setPointScale(this.renderer.pointScale);
      this.arena.setPointScale(this.renderer.pointScale);
    };
    this.renderer.onResize(syncPointScale);
    syncPointScale();

    this.bindPopups();
    this.spawnWizards();
  }

  private dustTimer = 0;
  /** Sim time of each wizard's last IMMUNE popup (rate limit). */
  private readonly immunePopupAt = new Map<Wizard, number>();

  private bindPopups(): void {
    events.on('dodge', (e) => this.fx.roll(e.wizard.pos, e.wizard.dodgeDir, e.wizard.team.spell));
    events.on('jump', (e) => this.fx.dust(tmp.set(e.pos.x, e.pos.y + 0.1, e.pos.z), 2, 0.5));
    events.on('land', (e) => this.fx.dust(tmp.set(e.pos.x, e.pos.y + 0.1, e.pos.z), Math.round(2 + e.speed * 0.6), 1.1));
    events.on('damage', (e) => {
      if ((e.target.immune || e.target.evolving) && e.amount <= 0) {
        // Rate-limited per target: bursts and the fire ring would otherwise stack them illegibly.
        const last = this.immunePopupAt.get(e.target) ?? -1e9;
        if (this.simTime - last >= CONFIG.ui.immunePopupInterval) {
          this.immunePopupAt.set(e.target, this.simTime);
          this.popups.spawn(e.target.chest(tmp), 'IMMUNE', 'block');
        }
        return;
      }
      const style = e.target === this.player ? 'dmgSelf' : e.amount >= 15 ? 'dmgBig' : e.kind === 'fire' ? 'burn' : 'dmg';
      this.popups.spawn(e.target.chest(tmp), String(Math.round(e.amount)), style);
    });
    events.on('callout', (e) => this.popups.spawn(e.pos, e.text, e.style));
    events.on('ticketPickup', (e) => this.popups.spawn(e.wizard.chest(tmp), '+MANA', e.wizard === this.player ? 'mana' : 'manaFoe'));
  }

  private readonly fireDamage = (w: Wizard, amount: number, point: THREE.Vector3) => {
    this.spells.dealDamage(w, null, amount, point, 'fire');
  };

  /** Clear every spell, effect and popup and restore pillars and the fire ring. */
  resetArena(): void {
    this.spells.clear();
    this.tickets.clear();
    this.lifePacks.clearPack();
    this.arena.reset();
    this.fx.clear();
    this.popups.clear();
    feel.reset();
    this.accumulator = 0;
    this.stages.reset();
    this.partnerStages.reset();
  }

  /**
   * Dress the rival as a campaign boss (name, palette, model, max health, damage), or restore the
   * default rival with `null`. The AI profile and arena theme are set by the caller (App).
   */
  setupEnemy(boss: BossDef | null): void {
    const e = this.enemy;
    const team = boss ? boss.palette : CONFIG.teams[1];
    const modelKey: ModelKey = boss ? boss.model : 'wizardRival';
    this.boss = boss;
    e.team = team;
    e.name = boss ? boss.name : team.name;
    e.maxHealth = boss ? boss.stageHealth[0] : CONFIG.wizard.maxHealth;
    e.health = Math.min(e.health, e.maxHealth);
    e.damageMultiplier = boss?.damageMultiplier ?? 1;
    this.spells.pool.setTeamPalette(e.index, team);
    // The boss throws its objects (rugs, phones, bullets...); the default rival casts orbs.
    e.skins = boss ? boss.skins : null;
    this.spells.pool.prepareSkins(e.index, e.skins);
    const look = boss ? boss.id : 'rival';
    if (look !== this.enemyLook) {
      this.enemyLook = look;
      e.visual.setAppearance(team, this.assets.instantiate(modelKey), MODELS[modelKey], boss ? boss.id : 'wizard');
    }
    this.stages.setBoss(boss);
    this.setupPartner(boss?.partner ?? null);
  }

  /** A double fight is on: the partner is in `wizards` and `enemies`. */
  get partnerActive(): boolean {
    return this.enemies.length > 1;
  }

  /**
   * How far the fight has come: every boss's stage plus one per boss knocked out. It changes on
   * every transformation and KO (the gauntlet's stage cap restarts then).
   */
  fightProgress(): number {
    let n = 0;
    for (const w of this.enemies) n += (this.stagesOf(w)?.stage ?? 0) + (w.alive ? 0 : 1);
    return n;
  }

  /** The furthest stage (0..2) any boss of this fight has reached (life packs unlock one per stage). */
  furthestStage(): number {
    return this.partnerActive ? Math.max(this.stages.stage, this.partnerStages.stage) : this.stages.stage;
  }

  /** The stages driving boss wizard `w` (the rival's or the partner's), or null for anyone else. */
  stagesOf(w: Wizard): BossStages | null {
    return w === this.enemy ? this.stages : w === this.partner ? this.partnerStages : null;
  }

  /**
   * Dress the partner as a double fight's second boss and bring it into the fight (`def`), or park
   * it (`null`). Called by setupEnemy with the boss's `partner`; public so QA can bench it.
   * Parked: out of `wizards`/`enemies`, collider disabled, visual hidden, nothing in flight.
   */
  setupPartner(def: BossPartner | null): void {
    const w = this.partner;
    if (!def) {
      this.partnerStages.setBoss(null);
      this.parkPartner();
      return;
    }
    w.team = def.palette;
    w.name = def.name;
    w.maxHealth = def.stageHealth[0];
    w.damageMultiplier = def.damageMultiplier;
    w.setHitbox(def.hitbox.radius, def.hitbox.height);
    this.spells.pool.setTeamPalette(w.index, def.palette);
    w.skins = def.skins;
    this.spells.pool.prepareSkins(w.index, w.skins);
    if (this.partnerLook !== def.id) {
      this.partnerLook = def.id;
      const key = def.stages[0].model;
      w.visual.setAppearance(def.palette, this.assets.instantiate(key), MODELS[key], def.id);
    }
    if (!this.partnerActive) {
      this.wizards.push(w);
      this.enemies.push(w);
      w.setEnabled(true);
      w.resetForRound(false);
      w.resetStats();
      w.visual.root.visible = true;
      const [x, z, facing] = this.spawnSpot(w);
      w.spawn(x, z, facing);
    }
    w.health = Math.min(w.health, w.maxHealth);
    this.partnerStages.setBoss(def);
  }

  private parkPartner(): void {
    const w = this.partner;
    const i = this.wizards.indexOf(w);
    if (i >= 0) this.wizards.splice(i, 1);
    const j = this.enemies.indexOf(w);
    if (j >= 0) this.enemies.splice(j, 1);
    this.spells.releaseOwned(w);
    // Free its object looks (phones, pigs...): nothing of its is in flight any more.
    this.spells.pool.prepareSkins(w.index, null);
    w.setEnabled(false);
    w.visual.root.visible = false;
    // It may be wearing a later stage's model (parked mid-fight): dress it afresh next time, in stage 1's.
    this.partnerLook = '';
  }

  /** God mode for the player (CONFIG.debug): no damage taken, unlimited mana, extra damage and clash power. */
  setGodMode(on: boolean): void {
    const D = CONFIG.debug;
    D.godMode = on;
    const p = this.player;
    p.immune = on;
    p.infiniteMana = on;
    p.noCooldowns = on;
    if (on) p.mana = CONFIG.wizard.maxMana;
    p.damageMultiplier = on ? D.godPowerMultiplier : 1;
    p.clashPowerMultiplier = on ? D.godClashMultiplier : 1;
  }

  /**
   * Give every wizard default combat stats, and suspend boss stages, until the returned function is
   * called (QA scenarios assume stock health and damage, whatever boss or god mode is active).
   */
  useDefaultStats(): () => void {
    const saved = this.wizards.map((w) => ({
      w, max: w.maxHealth, mult: w.damageMultiplier, clash: w.clashPowerMultiplier, immune: w.immune, mana: w.infiniteMana, cds: w.noCooldowns, ultk: w.ultChargeMultiplier,
    }));
    for (const w of this.wizards) {
      w.maxHealth = CONFIG.wizard.maxHealth;
      w.damageMultiplier = w.clashPowerMultiplier = w.ultChargeMultiplier = 1;
      w.immune = w.infiniteMana = w.noCooldowns = false;
    }
    const stagesSuspended = this.stages.suspended;
    const partnerSuspended = this.partnerStages.suspended;
    this.stages.suspended = this.partnerStages.suspended = true;
    return () => {
      for (const s of saved) {
        s.w.maxHealth = s.max;
        s.w.health = Math.min(s.w.health, s.max);
        s.w.damageMultiplier = s.mult;
        s.w.clashPowerMultiplier = s.clash;
        s.w.ultChargeMultiplier = s.ultk;
        s.w.immune = s.immune;
        s.w.infiniteMana = s.mana;
        s.w.noCooldowns = s.cds;
      }
      this.stages.suspended = stagesSuspended;
      this.partnerStages.suspended = partnerSuspended;
    };
  }

  /**
   * Spawn mark (x, z, facing) for `w`: the player and the rival face each other across the arena;
   * in a double fight the two bosses stand side by side, CONFIG.campaign.duo.spawnSpacing apart.
   */
  spawnSpot(w: Wizard): [number, number, number] {
    const d = CONFIG.arena.spawnDistance / 2;
    if (w.side === 0) return [0, -d, 0];
    const half = this.partnerActive ? CONFIG.campaign.duo.spawnSpacing / 2 : 0;
    return [w === this.partner ? -half : half, d, Math.PI];
  }

  /** Put every wizard on its spawn mark, facing the other side. */
  spawnWizards(): void {
    for (const w of this.wizards) {
      const [x, z, facing] = this.spawnSpot(w);
      w.spawn(x, z, facing);
      w.aimPoint.set(x, 1.2, -z);
    }
    this.physics.step();
    this.rig.snap(this.player.pos, 0);
  }

  onTick(fn: (dt: number) => void): void {
    this.tickHooks.push(fn);
  }

  onFrame(fn: (realDt: number, alpha: number) => void): void {
    this.frameHooks.push(fn);
  }

  start(): void {
    this.lastTime = performance.now();
    requestAnimationFrame(this.frame);
  }

  /** Boss transformations play as cinematics right now (headless otherwise). */
  get transformCinematics(): boolean {
    return !!this.presenter?.live;
  }

  private readonly frame = (now: number) => {
    requestAnimationFrame(this.frame);
    // Clamp both ways: long stalls (tab switch) and clocks going backwards must never explode smoothing.
    const realDt = Math.max(0, Math.min(0.1, (now - this.lastTime) / 1000));
    this.lastTime = now;
    this.advance(realDt);
  };

  /** One rendered frame: input, simulation steps, render. The rAF loop calls it; QA may too (no new loop). */
  advance(realDt: number): void {
    this.trackPerf(realDt);

    // A cinematic freezes the fight: no aiming, moving or casting until it hands control back.
    if (this.playerControl && this.simulating && this.cinematicScale >= 1) {
      this.playerController.look();
      this.playerController.update();
    } else {
      this.input.consumeMouseDelta();
    }

    // Hit-stop, slow-mo and cinematics scale simulated time; camera and UI keep running on real time.
    const scale = this.simulating ? feel.update(realDt) * this.cinematicScale : 0;
    const fixed = CONFIG.sim.fixedDt;
    this.accumulator += realDt * scale;
    let steps = 0;
    while (this.accumulator >= fixed && steps < CONFIG.sim.maxStepsPerFrame) {
      this.tick(fixed);
      this.accumulator -= fixed;
      steps++;
      if (feel.hitStop > 0) break; // freeze lands on the impact frame
    }
    if (steps >= CONFIG.sim.maxStepsPerFrame) this.accumulator = 0;
    const alpha = Math.min(1, this.accumulator / fixed);

    // Effects keep real time through a cinematic (the world is frozen, its light show isn't).
    const fxDt = this.simulating && this.cinematicScale < 1 ? realDt : realDt * scale;
    this.renderFrame(realDt, realDt * scale, alpha, fxDt);
    this.input.endFrame();
  }

  /** One fixed simulation step. Deterministic given the same intents. */
  tick(dt: number): void {
    this.simTime += dt;
    if (this.actionsLocked) {
      for (const w of this.wizards) {
        const facing = w.intent.facing;
        w.intent.clear();
        w.intent.facing = facing;
      }
    } else {
      this.enemyController?.update(dt);
    }
    for (const w of this.wizards) w.updateTimers(dt);
    this.stages.update(dt);
    this.partnerStages.update(dt);
    this.spells.update(dt);
    for (const w of this.wizards) w.updateMovement(dt, this.physics);
    this.physics.step();
    this.arena.update(dt);
    this.fire.updateDamage(dt, this.arena.fireRadius, this.wizards, this.fireDamage);
    this.tickets.update(dt);
    this.lifePacks.update(dt);
    if (!this.qaMode) for (const fn of this.tickHooks) fn(dt);
  }

  private renderFrame(realDt: number, simDt: number, alpha: number, fxDt = simDt): void {
    this.renderTime += simDt;
    // Muzzle glows sit on the camera's side of their props (last frame's camera is close enough).
    WizardVisual.viewer.copy(this.renderer.camera.position);
    for (const w of this.wizards) w.visual.update(w, simDt, alpha);
    this.spells.sync(alpha, this.renderTime, simDt);
    this.fire.updateVisual(simDt, this.arena.fireRadius);
    this.arena.updateVisual(simDt, this.renderer.camera.position);
    this.tickets.updateVisual(simDt, this.renderer.camera.position);
    this.lifePacks.updateVisual(simDt, this.renderer.camera.position);
    this.dustTimer -= simDt;
    if (this.dustTimer <= 0) {
      this.dustTimer = 0.06;
      for (const w of this.wizards) if (w.sprinting && w.grounded && w.pos.y === 0) this.fx.footDust(w.pos);
    }
    this.fx.update(fxDt);

    tmp.copy(this.player.visual.root.position);
    feel.listener.copy(tmp);
    if (this.rig.orbit) this.rig.updateOrbit(realDt);
    else this.rig.update(realDt, tmp, this.physics, this.player.sprinting, this.player.dodging);
    if (this.director) {
      this.director(realDt);
      this.renderer.camera.updateMatrixWorld();
    }
    this.updateOcclusionFade(realDt);
    this.popups.update(realDt);
    for (const fn of this.frameHooks) fn(realDt, alpha);
    this.renderer.render();
  }

  /**
   * See-through bosses: an enemy look within CONFIG.camera.bossFade.near m of the camera, or standing
   * between the camera and the player, is dithered out (WizardVisual.setFade) so a 3 m stage-3 boss
   * never hides the player; within `clear` m of its bounds it vanishes at once, so nothing is ever
   * drawn inside the near plane. Every render frame, after the camera moved; public for QA.
   */
  updateOcclusionFade(dt: number): void {
    const cam = this.renderer.camera.position;
    for (const w of this.wizards) {
      if (w !== this.player) w.visual.setFade(this.occlusionTarget(w, cam), dt);
    }
  }

  /** How visible enemy `w`'s look should be from `cam` (0..1). */
  occlusionTarget(w: Wizard, cam: THREE.Vector3): number {
    const v = w.visual;
    const base = v.root.position;
    const scale = v.root.scale.x;
    const r = v.boundsRadius * scale;
    const top = base.y + v.topHeight * scale;
    // Distance from the camera to the look's bounding cylinder (0 inside it).
    const out = Math.max(0, Math.hypot(cam.x - base.x, cam.z - base.z) - r);
    const vert = Math.max(0, base.y - cam.y, cam.y - top);
    const dist = Math.hypot(out, vert);
    if (dist <= FADE.clear) return 0;
    // A cinematic frames the boss on purpose (BossCinematic keeps its camera clear of him).
    if (this.director) return 1;
    let target = 1;
    if (dist < FADE.near) {
      const t = (dist - FADE.clear) / (FADE.near - FADE.clear);
      target = FADE.minVisible + (1 - FADE.minVisible) * t * t * (3 - 2 * t);
    }
    // Between the camera and the player's chest or head: see-through.
    const p = this.player.visual.root.position;
    const k = this.player.sizeScale;
    const rr = r * FADE.radius;
    if (this.segmentCrosses(cam, tmpEye.set(p.x, p.y + 1.2 * k, p.z), base, rr, top) ||
      this.segmentCrosses(cam, tmpEye.set(p.x, p.y + 1.75 * k, p.z), base, rr, top)) {
      target = Math.min(target, FADE.occluded);
    }
    return target;
  }

  /** Does the segment a -> b pass through the upright cylinder (radius `r`, from `base` up to `top`) before reaching b? */
  private segmentCrosses(a: THREE.Vector3, b: THREE.Vector3, base: THREE.Vector3, r: number, top: number): boolean {
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 1e-8 ? Math.max(0, Math.min(1, ((base.x - a.x) * dx + (base.z - a.z) * dz) / len2)) : 0;
    if (t >= 0.98) return false; // the boss is behind the player, not in front
    const cx = a.x + dx * t - base.x, cz = a.z + dz * t - base.z;
    if (cx * cx + cz * cz > r * r) return false;
    const y = a.y + (b.y - a.y) * t;
    return y >= base.y && y <= top;
  }

  private trackPerf(dt: number): void {
    const ms = dt * 1000;
    const p = this.perf;
    p.frames++;
    p.frameMs = p.frameMs ? p.frameMs * 0.95 + ms * 0.05 : ms;
    p.fps = 1000 / p.frameMs;
    p.worstMs = Math.max(p.worstMs * 0.995, ms);
  }
}
