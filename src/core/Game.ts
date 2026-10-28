import * as THREE from 'three';
import { CONFIG } from '../config';
import { AssetLoader } from '../assets/AssetLoader';
import { MODELS, type ModelKey } from '../assets/manifest';
import type { BossDef } from '../campaign/levels';
import { Arena } from '../arena/Arena';
import { FireRing } from '../arena/FireRing';
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

export class Game {
  readonly renderer: Renderer;
  readonly input: Input;
  readonly rig: CameraRig;
  readonly arena: Arena;
  readonly fx: Effects;
  readonly fire: FireRing;
  readonly spells: SpellSystem;
  readonly wizards: Wizard[];
  readonly player: Wizard;
  readonly enemy: Wizard;
  readonly playerController: PlayerController;
  readonly popups: DamageNumbers;
  enemyController: TickController | null = null;
  /** The campaign boss the rival is dressed as, or null for the default rival. */
  boss: BossDef | null = null;
  private enemyLook = 'rival';

  /** False while paused or in menus: the simulation doesn't advance. */
  simulating = true;
  /** Player input is read only while true. */
  playerControl = true;
  /** When true (countdowns, round end) nobody can move or cast; the camera still turns. */
  actionsLocked = false;
  /** Set by the QA harness: match flow and other tick hooks stay out of scenario runs. */
  qaMode = false;
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

    const makeWizard = (index: 0 | 1) => {
      const team = CONFIG.teams[index];
      const modelKey = index === 0 ? 'wizardPlayer' : 'wizardRival';
      const visual = new WizardVisual(team, assets.instantiate(modelKey), MODELS[modelKey]);
      scene.add(visual.root);
      return new Wizard(index, team, team.name, visual, physics);
    };
    this.player = makeWizard(0);
    this.enemy = makeWizard(1);
    this.wizards = [this.player, this.enemy];
    feel.local = this.player;

    this.spells = new SpellSystem(scene, physics, this.fx, this.wizards, this.arena);
    this.playerController = new PlayerController(this.input, this.rig, this.player, physics, () => this.enemy);
    this.popups = new DamageNumbers(ui, this.renderer.camera);

    const syncPointScale = () => this.fx.setPointScale(this.renderer.pointScale);
    this.renderer.onResize(syncPointScale);
    syncPointScale();

    this.bindPopups();
    this.spawnWizards();
  }

  private dustTimer = 0;

  private bindPopups(): void {
    events.on('dodge', (e) => this.fx.roll(e.wizard.pos, e.wizard.dodgeDir, e.wizard.team.spell));
    events.on('damage', (e) => {
      if (e.target.immune && e.amount <= 0) {
        this.popups.spawn(e.target.chest(tmp), 'IMMUNE', 'block');
        return;
      }
      const style = e.target === this.player ? 'dmgSelf' : e.amount >= 15 ? 'dmgBig' : e.kind === 'fire' ? 'burn' : 'dmg';
      this.popups.spawn(e.target.chest(tmp), String(Math.round(e.amount)), style);
    });
    events.on('callout', (e) => this.popups.spawn(e.pos, e.text, e.style));
  }

  private readonly fireDamage = (w: Wizard, amount: number, point: THREE.Vector3) => {
    this.spells.dealDamage(w, null, amount, point, 'fire');
  };

  /** Clear every spell, effect and popup and restore pillars and the fire ring. */
  resetArena(): void {
    this.spells.clear();
    this.arena.reset();
    this.fx.clear();
    this.popups.clear();
    feel.reset();
    this.accumulator = 0;
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
    e.maxHealth = Math.round(CONFIG.wizard.maxHealth * (boss?.healthMultiplier ?? 1));
    e.health = Math.min(e.health, e.maxHealth);
    e.damageMultiplier = boss?.damageMultiplier ?? 1;
    this.spells.pool.setTeamPalette(e.index, team);
    const look = boss ? boss.id : 'rival';
    if (look !== this.enemyLook) {
      this.enemyLook = look;
      e.visual.setAppearance(team, this.assets.instantiate(modelKey), MODELS[modelKey], boss ? boss.id : 'wizard');
    }
  }

  /** God mode for the player (CONFIG.debug): no damage taken, unlimited mana, extra damage and clash power. */
  setGodMode(on: boolean): void {
    const D = CONFIG.debug;
    D.godMode = on;
    const p = this.player;
    p.immune = on;
    p.infiniteMana = on;
    if (on) p.mana = CONFIG.wizard.maxMana;
    p.damageMultiplier = on ? D.godPowerMultiplier : 1;
    p.clashPowerMultiplier = on ? D.godClashMultiplier : 1;
  }

  /**
   * Give both wizards default combat stats until the returned function is called (QA scenarios
   * assume stock health and damage, whatever boss or god mode is active).
   */
  useDefaultStats(): () => void {
    const saved = this.wizards.map((w) => ({
      w, max: w.maxHealth, mult: w.damageMultiplier, clash: w.clashPowerMultiplier, immune: w.immune, mana: w.infiniteMana,
    }));
    for (const w of this.wizards) {
      w.maxHealth = CONFIG.wizard.maxHealth;
      w.damageMultiplier = w.clashPowerMultiplier = 1;
      w.immune = w.infiniteMana = false;
    }
    return () => {
      for (const s of saved) {
        s.w.maxHealth = s.max;
        s.w.health = Math.min(s.w.health, s.max);
        s.w.damageMultiplier = s.mult;
        s.w.clashPowerMultiplier = s.clash;
        s.w.immune = s.immune;
        s.w.infiniteMana = s.mana;
      }
    };
  }

  /** Put both wizards on their spawn marks facing each other. */
  spawnWizards(): void {
    const d = CONFIG.arena.spawnDistance / 2;
    this.player.spawn(0, -d, 0);
    this.enemy.spawn(0, d, Math.PI);
    this.player.aimPoint.set(0, 1.2, d);
    this.enemy.aimPoint.set(0, 1.2, -d);
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

  private readonly frame = (now: number) => {
    requestAnimationFrame(this.frame);
    // Clamp both ways: long stalls (tab switch) and clocks going backwards must never explode smoothing.
    const realDt = Math.max(0, Math.min(0.1, (now - this.lastTime) / 1000));
    this.lastTime = now;
    this.trackPerf(realDt);

    if (this.playerControl && this.simulating) {
      this.playerController.look();
      this.playerController.update();
    } else {
      this.input.consumeMouseDelta();
    }

    // Hit-stop and slow-mo scale simulated time; camera and UI keep running on real time.
    const scale = this.simulating ? feel.update(realDt) : 0;
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

    this.renderFrame(realDt, realDt * scale, alpha);
    this.input.endFrame();
  };

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
    this.spells.update(dt);
    for (const w of this.wizards) w.updateMovement(dt, this.physics);
    this.physics.step();
    this.arena.update(dt);
    this.fire.updateDamage(dt, this.arena.fireRadius, this.wizards, this.fireDamage);
    if (!this.qaMode) for (const fn of this.tickHooks) fn(dt);
  }

  private renderFrame(realDt: number, simDt: number, alpha: number): void {
    this.renderTime += simDt;
    for (const w of this.wizards) w.visual.update(w, simDt, alpha);
    this.spells.sync(alpha, this.renderTime, simDt);
    this.fire.updateVisual(simDt, this.arena.fireRadius);
    this.dustTimer -= simDt;
    if (this.dustTimer <= 0) {
      this.dustTimer = 0.06;
      for (const w of this.wizards) if (w.sprinting) this.fx.footDust(w.pos);
    }
    this.fx.update(simDt);

    tmp.copy(this.player.visual.root.position);
    feel.listener.copy(tmp);
    if (this.rig.orbit) this.rig.updateOrbit(realDt);
    else this.rig.update(realDt, tmp, this.physics, this.player.sprinting, this.player.dodging);
    this.popups.update(realDt);
    for (const fn of this.frameHooks) fn(realDt, alpha);
    this.renderer.render();
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
