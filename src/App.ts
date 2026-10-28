import * as THREE from 'three';
import { CONFIG, type Difficulty } from './config';
import { AudioManager } from './audio/AudioManager';
import { events } from './core/events';
import { bindRumble, spellLabels } from './core/Gamepad';
import type { Game } from './core/Game';
import { Match } from './core/Match';
import { AIController } from './enemy/AIController';
import { HUD } from './ui/HUD';
import { Menus, loadSettings, saveSettings, type Settings } from './ui/Menus';

type AppState = 'menu' | 'playing' | 'paused' | 'results';

const tmpRight = new THREE.Vector3();

/** Top-level flow: menus, match, pause, pointer lock, audio and settings. */
export class App {
  state: AppState = 'menu';
  readonly match: Match;
  readonly hud: HUD;
  readonly menus: Menus;
  readonly audio: AudioManager;
  readonly ai: AIController;
  private settings: Settings;
  /** Drives the player's wizard in the menu background (attract mode). */
  private readonly attract: AIController;
  private attractReset = 0;
  /** Pointer lock is required to play with mouse + keyboard; automation can turn it off with `?nolock`. */
  private lockWanted = !new URLSearchParams(location.search).has('nolock');
  /** A gamepad never needs pointer lock: while it is the active device, play runs without it. */
  get requireLock(): boolean {
    return this.lockWanted && this.game.input.pad.device !== 'gamepad';
  }
  set requireLock(v: boolean) {
    this.lockWanted = v;
  }
  private resultsTimer = 0;
  /** When the last pause happened (ms); the Esc that released pointer lock must not also resume. */
  private pausedAt = 0;

  constructor(readonly game: Game) {
    this.settings = loadSettings();
    game.input.mouseNeedsLock = this.requireLock;
    this.match = new Match(game);
    this.audio = new AudioManager();
    this.audio.bind(game);
    this.ai = new AIController(game.enemy, game.player, game.spells, game.physics, game.arena, this.settings.difficulty);
    game.enemyController = this.ai;
    this.attract = new AIController(game.player, game.enemy, game.spells, game.physics, game.arena, 'normal');
    game.onTick((dt) => this.attractTick(dt));

    this.hud = new HUD(game.ui, game, this.match);
    this.menus = new Menus(game.ui, this.settings, {
      start: (d) => this.startMatch(d),
      resume: () => this.resume(),
      restart: () => this.startMatch(this.match.difficulty),
      quit: () => this.toMenu(),
      settingsChanged: (s) => this.applySettings(s),
      uiSound: (kind) => this.audio.play(kind === 'hover' ? 'uiHover' : 'uiClick', { exactPitch: true }),
    });
    this.applySettings(this.settings);

    game.onFrame((dt) => this.frame(dt));
    events.on('matchEnd', () => (this.resultsTimer = 2.2));
    this.bindInput();
    this.toMenu();
  }

  private bindInput(): void {
    const g = this.game;
    document.addEventListener('pointerlockchange', () => {
      if (g.input.locked) {
        if (this.state === 'playing') {
          this.menus.hide();
          g.simulating = true;
        }
      } else if (this.state === 'playing' && this.lockWanted) {
        this.pause();
      }
    });
    document.addEventListener('pointerlockerror', () => {
      if (this.state === 'playing') this.menus.showClickToResume();
    });
    g.renderer.canvas.addEventListener('click', () => {
      if (this.state === 'playing' && !g.input.locked) g.input.requestLock();
    });
    this.menus.root.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.click-resume')) g.input.requestLock();
    });
    window.addEventListener('keydown', (e) => {
      if (!CONFIG.controls.pause.includes(e.code) || e.repeat) return;
      if (this.state === 'playing') this.pause();
      else if (this.state === 'paused' && performance.now() - this.pausedAt > 300) this.resume();
    });
    // Browsers only start audio after a gesture.
    const firstGesture = () => {
      if (this.state === 'menu') this.audio.playMusic('musicMenu');
      this.audio.setAmbient(true);
      window.removeEventListener('pointerdown', firstGesture);
      window.removeEventListener('keydown', firstGesture);
    };
    window.addEventListener('pointerdown', firstGesture);
    window.addEventListener('keydown', firstGesture);
    this.bindGamepad();
  }

  /** Controller: HUD prompts follow the active device, Start pauses, pad menu navigation, rumble. */
  private bindGamepad(): void {
    const g = this.game;
    const pad = g.input.pad;
    const relabel = () => {
      this.menus.padStyle = pad.style;
      this.hud.setKeyLabels(spellLabels(pad.device, pad.style));
    };
    pad.onDeviceChange((device) => {
      relabel();
      // Picked up a pad while the game waits for the mouse to be captured: just play.
      if (device === 'gamepad' && this.state === 'playing' && !g.simulating && !g.qaMode && (!this.menus.visible || this.menus.awaitingClick)) {
        this.menus.hide();
        g.simulating = true;
      }
    });
    pad.onConnectionChange((connected) => {
      relabel();
      // The pad in use was unplugged (or ran out of battery) mid-duel.
      if (!connected && pad.device === 'gamepad' && this.state === 'playing' && !g.qaMode) this.pause();
    });
    bindRumble(g);
    g.onFrame((dt) => this.padFrame(dt));
  }

  /** Per-frame controller handling outside gameplay: Start toggles pause; menus get pad navigation. */
  padFrame(dt: number): void {
    const pad = this.game.input.pad;
    pad.update();
    if (pad.wasPressed(CONFIG.gamepad.bindings.pause)) {
      if (this.state === 'playing') return this.pause();
      if (this.state === 'paused') return this.resume();
    }
    this.menus.nav.update(pad, dt);
  }

  private applySettings(s: Settings): void {
    this.settings = s;
    saveSettings(s);
    const g = this.game;
    g.rig.sensitivity = CONFIG.camera.sensitivity * s.sensitivity;
    g.rig.invertY = s.invertY;
    g.renderer.setQuality({ bloom: s.bloom, shadows: s.shadows });
    this.audio.setVolumes(s.master, s.sfx, s.music);
    g.playerController.applyPadSettings(s);
  }

  /** Menu background: both wizards duel; a KO resets the arena after a beat. */
  private attractTick(dt: number): void {
    if (this.state !== 'menu') return;
    const g = this.game;
    g.actionsLocked = false;
    this.attract.update(dt);
    if (!g.player.alive || !g.enemy.alive) {
      this.attractReset += dt;
      if (this.attractReset > 2.5) this.resetAttract();
    }
  }

  private resetAttract(): void {
    const g = this.game;
    this.attractReset = 0;
    g.resetArena();
    for (const w of g.wizards) w.resetForRound(false);
    g.spawnWizards();
    this.ai.reset();
    this.attract.reset();
  }

  startMatch(difficulty: Difficulty): void {
    const g = this.game;
    this.audio.gameplayMuted = false;
    g.player.intent.clear();
    this.settings.difficulty = difficulty;
    saveSettings(this.settings);
    this.ai.setDifficulty(difficulty);
    this.hud.setNames(['You', `Rival · ${CONFIG.ai.difficulty[difficulty].label}`]);
    this.menus.hide();
    this.hud.show(true);
    g.rig.orbit = false;
    g.playerControl = true;
    this.state = 'playing';
    this.resultsTimer = 0;
    this.match.startMatch(difficulty);
    this.audio.setPaused(false);
    this.audio.playMusic('musicBattle');
    this.audio.setAmbient(true);
    if (this.requireLock) {
      g.simulating = g.input.locked;
      g.input.requestLock();
    }
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.pausedAt = performance.now();
    this.game.simulating = false;
    this.game.input.releaseLock();
    this.menus.showPause();
    this.audio.setPaused(true);
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.menus.hide();
    this.audio.setPaused(false);
    if (this.requireLock && !this.game.input.locked) {
      // Stay frozen until the mouse is captured again.
      this.game.simulating = false;
      this.game.input.requestLock();
    } else {
      this.game.simulating = true;
    }
  }

  toMenu(): void {
    const g = this.game;
    this.state = 'menu';
    this.match.phase = 'menu';
    g.input.releaseLock();
    this.ai.setDifficulty('normal');
    this.resetAttract();
    g.simulating = true;
    g.playerControl = false;
    g.rig.orbit = true;
    this.audio.gameplayMuted = true;
    this.hud.show(false);
    this.menus.showMain();
    this.audio.setPaused(false);
    this.audio.playMusic('musicMenu');
  }

  private showResults(): void {
    const g = this.game;
    this.state = 'results';
    this.audio.gameplayMuted = true;
    g.input.releaseLock();
    g.playerControl = false;
    this.hud.show(false);
    const rounds = this.match.roundWinners.map((w) => (w === g.player ? 'win' : w ? 'lose' : 'draw') as 'win' | 'lose' | 'draw');
    const p1Won = this.match.wins[0] > this.match.wins[1];
    const label = CONFIG.ai.difficulty[this.match.difficulty].label;
    this.menus.showResults({
      title: p1Won ? 'Victory' : 'Defeat',
      subtitle: p1Won ? `You bested the ${label}.` : `The ${label} wins this time.`,
      victory: p1Won,
      names: ['You', 'Rival'],
      rounds,
      player: { ...g.player.stats },
      enemy: { ...g.enemy.stats },
    });
    this.audio.playMusic('musicMenu');
  }

  private frame(dt: number): void {
    const g = this.game;
    if (this.state === 'playing' || this.state === 'paused') this.hud.update(dt);
    if (this.resultsTimer > 0) {
      this.resultsTimer -= dt;
      if (this.resultsTimer <= 0 && this.state === 'playing') this.showResults();
    }
    const cam = g.renderer.camera;
    tmpRight.setFromMatrixColumn(cam.matrixWorld, 0);
    this.audio.setListener(cam.position, tmpRight);
  }
}
