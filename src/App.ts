import * as THREE from 'three';
import { CONFIG, type TeamPalette } from './config';
import { AudioManager } from './audio/AudioManager';
import { Campaign } from './campaign/Campaign';
import { BOSSES, type BossDef } from './campaign/levels';
import { DoubleTap } from './core/DoubleTap';
import { events } from './core/events';
import { bindRumble, spellLabels } from './core/Gamepad';
import type { Game } from './core/Game';
import { Match } from './core/Match';
import { AIController } from './enemy/AIController';
import { HUD } from './ui/HUD';
import { Menus, loadSettings, saveSettings, type ResultData, type Settings } from './ui/Menus';
import type { Wizard } from './wizard/Wizard';

type AppState = 'menu' | 'playing' | 'paused' | 'results';
/** Quick Duel (one fixed rival) or the Boss Gauntlet campaign (the difficulty ladder). */
export type GameMode = 'quick' | 'gauntlet';

const tmpRight = new THREE.Vector3();
const WHITE = new THREE.Color(1, 1, 1);
/** Quick Duel has one opponent; the Boss Gauntlet is the difficulty ladder. */
const QUICK_DUEL_AI = CONFIG.ai.difficulty.normal;

/** Top-level flow: menus, match, pause, pointer lock, audio and settings. */
export class App {
  state: AppState = 'menu';
  mode: GameMode = 'quick';
  /** Boss Gauntlet progress (saved in localStorage). */
  readonly campaign: Campaign;
  /** Result of the last gauntlet win, so the results screen knows where "next" leads. */
  private gauntletOutcome: 'next' | 'complete' | null = null;
  /** The "99" god-mode cheat. Public so QA can feed it timed presses. */
  readonly godCheat = new DoubleTap(CONFIG.debug.godCheatKeys, CONFIG.debug.godCheatWindowMs);
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

  constructor(readonly game: Game, campaign = new Campaign()) {
    this.campaign = campaign;
    this.settings = loadSettings();
    // God mode is a session-only testing aid: CONFIG.debug.godMode, `?god`, Settings or F9.
    game.setGodMode(CONFIG.debug.godMode || new URLSearchParams(location.search).has('god'));
    game.input.mouseNeedsLock = this.requireLock;
    this.match = new Match(game);
    this.audio = new AudioManager();
    this.audio.bind(game);
    this.ai = new AIController(game.enemy, game.player, game.spells, game.physics, game.arena, 'normal');
    game.enemyController = this.ai;
    this.attract = new AIController(game.player, game.enemy, game.spells, game.physics, game.arena, 'normal');
    game.onTick((dt) => this.attractTick(dt));

    this.hud = new HUD(game.ui, game, this.match);
    this.menus = new Menus(game.ui, this.settings, {
      start: () => this.startMatch(),
      gauntlet: () => this.newGauntlet(),
      continueGauntlet: () => this.continueGauntlet(),
      gauntletStatus: () => {
        const c = this.campaign;
        return { canContinue: c.canContinue, next: c.canContinue ? BOSSES[c.saved.next] : null, nextIndex: c.saved.next, clears: c.saved.clears };
      },
      resume: () => this.resume(),
      restart: () => this.restart(),
      quit: () => this.toMenu(),
      settingsChanged: (s) => this.applySettings(s),
      godMode: () => CONFIG.debug.godMode,
      setGodMode: (on) => this.setGodMode(on),
      uiSound: (kind) => this.audio.play(kind === 'hover' ? 'uiHover' : 'uiClick', { exactPitch: true }),
    });
    this.applySettings(this.settings);

    game.onFrame((dt) => this.frame(dt));
    events.on('matchEnd', (e) => this.onMatchEnd(e.winner));
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
      // God mode: F9, or "99" (two presses of 9 in quick succession). 9 is not bound to anything.
      if (e.repeat) return;
      const cheat = this.godCheat.press(e.code, e.timeStamp);
      if (cheat || e.code === CONFIG.debug.godHotkey) {
        e.preventDefault();
        this.setGodMode(!CONFIG.debug.godMode);
      }
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

  /** Quick Duel: the one Rival (fixed AI profile) in the moonlit arena. */
  startMatch(): void {
    this.mode = 'quick';
    this.dressEnemy(null);
    this.ai.setProfile(QUICK_DUEL_AI);
    this.hud.setNames(['You', CONFIG.teams[1].name]);
    this.beginMatch(null);
  }

  /** Boss Gauntlet from fight 1. */
  newGauntlet(): void {
    this.campaign.startNew();
    this.showBossCard();
  }

  /** Boss Gauntlet from the saved fight. */
  continueGauntlet(): void {
    this.campaign.resume();
    this.showBossCard();
  }

  /** Pre-fight card for the current gauntlet boss, over a preview of their arena. */
  showBossCard(): void {
    const boss = this.campaign.boss;
    this.enterMenuState('gauntlet');
    this.dressEnemy(boss);
    this.resetAttract();
    this.menus.showBossIntro(
      { boss, index: this.campaign.index, total: this.campaign.total },
      { begin: () => this.startBossFight(), back: () => this.toMenu() },
    );
  }

  /** Best of three against the current gauntlet boss, in their arena. */
  startBossFight(): void {
    const boss = this.campaign.boss;
    this.mode = 'gauntlet';
    this.dressEnemy(boss);
    this.hud.setNames(['You', boss.name], ['', boss.title]);
    this.beginMatch(boss);
  }

  /** Rematch / Retry / pause "Restart": the same opponent again. */
  restart(): void {
    if (this.mode === 'gauntlet') this.startBossFight();
    else this.startMatch();
  }

  /** God mode (testing): toggled from Settings, F9 in a match, or `?god`. Never saved. */
  setGodMode(on: boolean): void {
    this.game.setGodMode(on);
    this.menus.syncGodMode(on);
    this.menus.toast(on ? 'God Mode On' : 'God Mode Off', on ? `No damage · unlimited mana · ${CONFIG.debug.godPowerMultiplier}× power` : '', on ? 'god-on' : 'god-off');
  }

  /**
   * Rival look, stats, AI profile and arena theme for a boss, or the default rival in the
   * moonlit arena (`null`). The caller sets the AI profile for Quick Duel.
   */
  private dressEnemy(boss: BossDef | null): void {
    const g = this.game;
    g.setupEnemy(boss);
    const theme = boss ? boss.theme : 'moonlit';
    if (g.arena.theme !== theme) g.arena.applyTheme(theme);
    if (boss) this.ai.setProfile(boss.ai);
    this.applyRivalColors(boss ? boss.palette : null);
  }

  /** HUD/menu accents for the rival (health bar, pips, arrow, results) follow the boss palette. */
  private applyRivalColors(team: TeamPalette | null): void {
    const style = this.game.ui.style;
    if (!team) {
      for (const k of ['--rival', '--rival-hi', '--rival-lo']) style.removeProperty(k);
      return;
    }
    const c = new THREE.Color(team.spell);
    style.setProperty('--rival', `#${c.getHexString()}`);
    style.setProperty('--rival-hi', `#${c.clone().lerp(WHITE, 0.5).getHexString()}`);
    style.setProperty('--rival-lo', `#${c.clone().multiplyScalar(0.75).getHexString()}`);
  }

  private beginMatch(boss: BossDef | null): void {
    const g = this.game;
    this.audio.gameplayMuted = false;
    g.player.intent.clear();
    this.gauntletOutcome = null;
    this.menus.hide();
    this.hud.show(true);
    g.rig.orbit = false;
    g.playerControl = true;
    this.state = 'playing';
    this.resultsTimer = 0;
    this.match.startMatch(boss);
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
    const boss = this.match.boss;
    this.menus.showPause(boss ? `Fight ${this.match.bossIndex + 1} of ${BOSSES.length} · ${boss.name}, ${boss.title}` : '');
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
    this.enterMenuState('quick');
    this.dressEnemy(null);
    this.ai.setProfile(QUICK_DUEL_AI);
    this.resetAttract();
    this.menus.showMain();
  }

  /** Shared by the main menu, boss cards and the gauntlet-complete screen: attract duel behind a menu. */
  private enterMenuState(mode: GameMode): void {
    const g = this.game;
    this.mode = mode;
    this.state = 'menu';
    this.match.phase = 'menu';
    this.match.boss = null;
    this.resultsTimer = 0;
    g.input.releaseLock();
    g.simulating = true;
    g.playerControl = false;
    g.rig.orbit = true;
    this.audio.gameplayMuted = true;
    this.hud.show(false);
    this.audio.setPaused(false);
    this.audio.playMusic('musicMenu');
  }

  private onMatchEnd(winner: Wizard | null): void {
    this.resultsTimer = 2.2;
    if (this.mode === 'gauntlet' && this.match.boss && winner === this.game.player) {
      this.gauntletOutcome = this.campaign.recordWin();
    }
  }

  /** After the final boss: the gauntlet-complete screen over the moonlit arena. */
  showCampaignComplete(): void {
    this.enterMenuState('quick');
    this.dressEnemy(null);
    this.ai.setProfile(QUICK_DUEL_AI);
    this.resetAttract();
    this.menus.showCampaignComplete({ clears: this.campaign.saved.clears }, { again: () => this.newGauntlet(), menu: () => this.toMenu() });
  }

  /** Results screen. Public so QA can finish a match without waiting for the results delay. */
  showResults(): void {
    const g = this.game;
    this.state = 'results';
    this.resultsTimer = 0;
    this.audio.gameplayMuted = true;
    g.input.releaseLock();
    g.playerControl = false;
    this.hud.show(false);
    const rounds = this.match.roundWinners.map((w) => (w === g.player ? 'win' : w ? 'lose' : 'draw') as 'win' | 'lose' | 'draw');
    const p1Won = this.match.wins[0] > this.match.wins[1];
    const stats = { player: { ...g.player.stats }, enemy: { ...g.enemy.stats } };
    const boss = this.match.boss;
    let data: ResultData;
    if (boss) {
      const c = this.campaign;
      const next = c.nextBoss;
      const primary = !p1Won
        ? { label: 'Retry', action: () => this.startBossFight() }
        : this.gauntletOutcome === 'complete' || !next
          ? { label: 'Claim Victory', action: () => this.showCampaignComplete() }
          : { label: `Next: ${next.name}`, action: () => (c.advance(), this.showBossCard()) };
      data = {
        title: p1Won ? 'Victory' : 'Defeat',
        subtitle: p1Won ? `${boss.name}, ${boss.title}, falls.` : `${boss.name}, ${boss.title}, wins this time.`,
        eyebrow: `Fight ${this.match.bossIndex + 1} of ${BOSSES.length}${p1Won ? ' cleared' : ''}`,
        boss,
        primary,
        victory: p1Won,
        names: ['You', boss.name],
        rounds,
        ...stats,
      };
    } else {
      const rival = CONFIG.teams[1].name;
      data = {
        title: p1Won ? 'Victory' : 'Defeat',
        subtitle: p1Won ? `You bested the ${rival}.` : `The ${rival} wins this time.`,
        victory: p1Won,
        names: ['You', rival],
        rounds,
        ...stats,
      };
    }
    this.menus.showResults(data);
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
