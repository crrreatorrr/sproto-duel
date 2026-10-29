import * as THREE from 'three';
import { CONFIG, type TeamPalette } from './config';
import { AudioManager } from './audio/AudioManager';
import { BossCinematic } from './campaign/BossCinematic';
import { Campaign } from './campaign/Campaign';
import { BOSSES, bossDisplayName, type BossDef } from './campaign/levels';
import { DoubleTap } from './core/DoubleTap';
import { events } from './core/events';
import { bindRumble, rewardLabels, spellLabels } from './core/Gamepad';
import { nearestStanding, type Game } from './core/Game';
import { Match } from './core/Match';
import { AIController } from './enemy/AIController';
import { HUD } from './ui/HUD';
import { Menus, loadSettings, saveSettings, type MenuAction, type ResultData, type Settings, type StageInfo, type UnsavedReason } from './ui/Menus';
import { HubLink } from './hub/link';
import { equipStaff, staffCard, staffModelPath } from './staff/catalog';
import { getLoadout, setSelectedStaff } from './staff/loadout';
import { REWARD_SPELLS, REWARD_SPELL_INFO, type RewardSpellId } from './spells/rewardCatalog';
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
  /**
   * God mode was on at some point during this fight (until it ended): a win then saves no progress
   * and counts no clear, and the results say so.
   */
  godUsed = false;
  /**
   * Why the last gauntlet win saved nothing, decided when the fight ended (the results show this):
   * 'god', god mode was used in it; 'skipped', earlier fights of this run were won in god mode (see
   * Campaign.continuesSave). null: it was saved (or it wasn't a gauntlet win).
   */
  winUnsaved: UnsavedReason | null = null;
  /**
   * New Gauntlet's fight-1 card is up: the save starts over only once Begin is pressed, so backing
   * out to the menu keeps Continue.
   */
  private freshRun = false;
  /** Boss transformations as cinematics during a gauntlet fight. */
  readonly cinematic: BossCinematic;
  /** The "99" god-mode cheat. Public so QA can feed it timed presses. */
  readonly godCheat = new DoubleTap(CONFIG.debug.godCheatKeys, CONFIG.debug.godCheatWindowMs);
  readonly match: Match;
  readonly hud: HUD;
  readonly menus: Menus;
  readonly audio: AudioManager;
  /** The rival's AI (Quick Duel opponent or campaign boss). */
  readonly ai: AIController;
  /** A double fight's partner's AI (Game.partner); idle outside one. */
  readonly partnerAi: AIController;
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

  constructor(readonly game: Game, campaign = new Campaign(), private readonly hub = HubLink.standalone()) {
    this.campaign = campaign;
    this.settings = loadSettings();
    // God mode is a session-only testing aid: CONFIG.debug.godMode, `?god`, Settings or F9.
    game.setGodMode(CONFIG.debug.godMode || new URLSearchParams(location.search).has('god'));
    this.syncLearned();
    game.input.mouseNeedsLock = this.requireLock;
    this.match = new Match(game);
    this.audio = new AudioManager();
    this.audio.bind(game);
    this.ai = new AIController(game.enemy, game.player, game.spells, game.physics, game.arena, 'normal');
    this.partnerAi = new AIController(game.partner, game.player, game.spells, game.physics, game.arena, 'normal');
    // Both bosses of a double fight keep apart and flank; alone, the rival has nobody to space from.
    this.ai.allies = this.partnerAi.allies = game.enemies;
    this.ai.tickets = this.partnerAi.tickets = game.tickets;
    const ai = this.ai, partnerAi = this.partnerAi;
    game.enemyController = {
      update(dt) {
        ai.update(dt);
        if (game.partnerActive) partnerAi.update(dt);
      },
      reset() {
        ai.reset();
        partnerAi.reset();
      },
    };
    this.attract = new AIController(game.player, game.enemy, game.spells, game.physics, game.arena, 'normal');
    this.attract.useRewards = false; // the menu's background duel never shows off learned spells
    game.onTick((dt) => this.attractTick(dt));

    this.hud = new HUD(game.ui, game, this.match);
    this.cinematic = new BossCinematic(game, this.hud.root);
    game.presenter = this.cinematic;
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
      learnedSpells: () => new Set(this.game.player.learned),
      savedSpells: () => new Set(this.campaign.unlocked),
      forgetSpells: () => this.forgetSpells(),
      hubStatus: () => this.hub.status(),
      exchangeTickets: (tickets) => this.hub.exchangeTickets(tickets),
      exitHub: () => this.hub.exitHub(),
      staffRack: () => this.staffRack(),
      selectStaff: (id) => this.selectStaff(id),
      uiSound: (kind) => this.audio.play(kind === 'hover' ? 'uiHover' : 'uiClick', { exactPitch: true }),
    });
    this.applySettings(this.settings);

    game.onFrame((dt) => this.frame(dt));
    events.on('matchEnd', (e) => this.onMatchEnd(e.winner));
    this.bindInput();
    this.applyStaff();
    this.toMenu();
  }

  /**
   * Equip the saved staff on the player. Ranked (`HubLink.ranked`, from the vendored SDK init)
   * keeps the mesh and colours and uses starter stats. There is no mid-fight swap: menus call
   * this, and every match start calls it again.
   */
  private applyStaff(): void {
    const load = getLoadout();
    if (load.replaced) this.menus.toast('Gear unavailable', load.replaced);
    // Ranked flag is already on the hub session. Standalone play leaves it false.
    const ranked = this.hub.ranked;
    const equipped = equipStaff(load.staff, ranked);
    const player = this.game.player;
    player.staff = equipped;
    if (player.visual.mountedStaffId === equipped.id) {
      player.visual.setStaff(equipped);
      return;
    }
    const path = staffModelPath(load.staff);
    const prop = this.game.assets.instantiateProp(path);
    if (!prop) console.warn(`[staff] missing ${path}, using a placeholder staff`);
    player.visual.setStaff(equipped, prop);
  }

  private staffRack() {
    const load = getLoadout();
    return {
      owned: load.owned.map((id) => staffCard(id)),
      selected: load.staff,
      ranked: this.hub.ranked,
    };
  }

  /** Rack clicks. Ignored during a fight so a staff can't change between casts. */
  private selectStaff(id: string): void {
    if (this.state === 'playing' || this.state === 'paused') return;
    if (!setSelectedStaff(id)) {
      this.menus.toast('Gear unavailable', id);
      return;
    }
    this.applyStaff();
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
      this.menus.padDevice = pad.device;
      this.hud.setKeyLabels(spellLabels(pad.device, pad.style));
      this.hud.setRewardKeyLabels(rewardLabels(pad.device, pad.style));
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
    const foe = nearestStanding(g.player, g.enemies);
    if (foe) this.attract.setTarget(foe);
    this.attract.update(dt);
    if (!g.player.alive || !foe) {
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
    this.partnerAi.reset();
    this.attract.setTarget(g.enemy);
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

  /**
   * Boss Gauntlet from fight 1: its card. The saved run is only replaced when Begin is pressed
   * (startBossFight), so New Gauntlet then Main Menu still offers Continue.
   */
  newGauntlet(): void {
    this.campaign.index = 0;
    this.showBossCard(true);
  }

  /** Boss Gauntlet from the saved fight. */
  continueGauntlet(): void {
    this.campaign.resume();
    this.showBossCard();
  }

  /**
   * Pre-fight card for the current gauntlet boss, over a preview of their arena. `freshRun`: New
   * Gauntlet's fight-1 card (Begin starts the run over; the card says so if that replaces a save).
   */
  showBossCard(freshRun = false): void {
    const c = this.campaign;
    const boss = c.boss;
    this.enterMenuState('gauntlet');
    this.freshRun = freshRun;
    this.dressEnemy(boss);
    this.resetAttract();
    this.menus.showBossIntro(
      {
        boss, index: c.index, total: c.total, rewardLearned: c.hasLearned(boss.reward), rewardNote: this.rewardNote(),
        beginNote: freshRun && c.canContinue ? `Replaces your save at fight ${c.saved.next + 1}` : undefined,
      },
      { begin: () => this.startBossFight(), back: () => this.toMenu() },
    );
  }

  /**
   * Whether a win on the current boss card would be saved: 'god' while god mode is on, 'skipped'
   * when earlier fights of this run were won in god mode (Campaign.continuesSave), else null.
   */
  private rewardNote(): UnsavedReason | null {
    if (CONFIG.debug.godMode) return 'god';
    return this.campaign.continuesSave ? null : 'skipped';
  }

  /** One life against the current gauntlet boss (all three stages), in their arena. */
  startBossFight(): void {
    if (this.freshRun) {
      // Begin on New Gauntlet's card: now the run starts over.
      this.freshRun = false;
      this.campaign.startNew();
    }
    const boss = this.campaign.boss;
    this.mode = 'gauntlet';
    this.dressEnemy(boss);
    const names = ['You', boss.name], titles = ['', boss.title];
    if (boss.partner) names.push(boss.partner.name);
    this.hud.setNames(names, titles);
    this.beginMatch(boss);
  }

  /** Rematch / Retry / pause "Restart": the same opponent again. */
  restart(): void {
    if (this.mode === 'gauntlet') this.startBossFight();
    else this.startMatch();
  }

  /**
   * The player's reward spells: everything the campaign save has learned, plus all five while god
   * mode is on (testing; never saved). Called whenever either changes and at every match start.
   */
  syncLearned(): void {
    const learned = this.game.player.learned;
    learned.clear();
    for (const id of this.campaign.unlocked) learned.add(id);
    if (CONFIG.debug.godMode) for (const id of REWARD_SPELLS) learned.add(id);
  }

  /** Settings: "Forget learned spells". The save keeps its progress and clears. */
  forgetSpells(): void {
    this.campaign.forgetSpells();
    this.syncLearned();
    this.menus.toast('Spells Forgotten', 'Beat the bosses again to relearn them');
  }

  /**
   * God mode (testing): toggled from Settings, F9 in a match, or `?god`. Never saved. Once the fight
   * is decided (the final KO) its result is settled: a toggle before the results changes nothing.
   */
  setGodMode(on: boolean): void {
    this.game.setGodMode(on);
    this.syncLearned();
    if (on && (this.state === 'playing' || this.state === 'paused') && !this.match.decided) this.godUsed = true;
    this.menus.syncGodMode(on);
    if (this.menus.current === 'boss') this.menus.setBossRewardNote(this.rewardNote());
    this.menus.toast(on ? 'God Mode On' : 'God Mode Off', on ? `No damage · unlimited mana · no cooldowns · ${CONFIG.debug.godPowerMultiplier}× damage` : '', on ? 'god-on' : 'god-off');
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
    if (boss?.partner) this.partnerAi.setProfile(boss.partner.ai);
    this.applyRivalColors(boss ? boss.palette : null);
    this.hud.setPartnerColors(boss?.partner?.palette ?? null);
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
    this.syncLearned();
    this.applyStaff();
    // God mode's stats come back on the player (the menu's background duel fights without them).
    g.holdGodMode(false);
    this.gauntletOutcome = null;
    this.winUnsaved = null;
    this.godUsed = CONFIG.debug.godMode;
    this.cinematic.abort();
    this.cinematic.armed = boss !== null;
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
    const g = this.game;
    // Each boss's current stage (both in a double fight).
    const stages: StageInfo[] = [];
    if (boss) {
      for (const w of g.enemies) {
        const st = g.stagesOf(w);
        if (st?.current) stages.push({ index: st.stage, name: st.current.name, who: boss.partner ? w.name : '', down: !w.alive });
      }
    }
    this.menus.showPause(boss ? `Fight ${this.match.bossIndex + 1} of ${BOSSES.length} · ${bossDisplayName(boss)}, ${boss.title}` : '', stages, boss ? 'Restart Fight' : 'Restart Match');
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
    this.syncLearned();
    this.enterMenuState('quick');
    this.dressEnemy(null);
    this.ai.setProfile(QUICK_DUEL_AI);
    this.resetAttract();
    this.menus.showMain();
  }

  /** Shared by the main menu, boss cards and the gauntlet-complete screen: attract duel behind a menu. */
  private enterMenuState(mode: GameMode): void {
    const g = this.game;
    this.freshRun = false;
    this.cinematic.abort();
    this.cinematic.armed = false;
    this.mode = mode;
    this.state = 'menu';
    this.match.phase = 'menu';
    this.match.boss = null;
    g.tickets.spawnInterval = CONFIG.tickets.spawnInterval;
    this.resultsTimer = 0;
    g.input.releaseLock();
    g.simulating = true;
    g.playerControl = false;
    g.rig.orbit = true;
    this.audio.gameplayMuted = true;
    this.hud.show(false);
    this.audio.setPaused(false);
    this.audio.playMusic('musicMenu');
    // The background duel is a show, not a test drive: stock stats even with god mode on.
    g.holdGodMode(true);
  }

  /**
   * The fight's result is settled here, once, from what happened while it was live (`godUsed` ignores
   * toggles after the final KO): nothing done before the results show changes it. A gauntlet win
   * saves progress and teaches the boss's spell only if god mode was never on in it and the run so
   * far is saved (Campaign.continuesSave); otherwise it moves you on in this session only: no saved
   * progress, no clear, no spell, and the results say why.
   */
  private onMatchEnd(winner: Wizard | null): void {
    this.resultsTimer = 2.2;
    this.winUnsaved = null;
    if (this.mode === 'gauntlet' && this.match.boss && winner === this.game.player) {
      const c = this.campaign;
      this.gauntletOutcome = c.isLast ? 'complete' : 'next';
      c.lastLearned = null;
      if (this.godUsed) this.winUnsaved = 'god';
      else if (c.recordWin() === 'unsaved') this.winUnsaved = 'skipped';
      else this.syncLearned();
    }
    // Hub reports go around Campaign.recordWin: god-mode wins still earn Tickets and Tinubu's Crown.
    if (!this.game.qaMode) {
      const bossId = this.match.boss?.id ?? null;
      void this.hub.onDuelWin(
        { playerWon: winner === this.game.player, bossId, godMode: this.godUsed, elapsed: this.match.elapsed },
        (title, sub) => this.menus.toast(title, sub, 'tickets'),
      );
    }
  }

  /**
   * "NEW SPELL LEARNED": the reward spell a gauntlet win just taught, after the results. `then` is
   * where the results' primary button was going (the next boss's card, or the completion screen).
   */
  showSpellReveal(id: RewardSpellId, then: MenuAction): void {
    this.state = 'results';
    this.audio.play('spellLearned', { exactPitch: true });
    this.menus.showSpellReveal(id, { next: then, menu: () => this.toMenu() });
  }

  /** After the final boss: the gauntlet-complete screen over the moonlit arena. */
  showCampaignComplete(): void {
    this.enterMenuState('quick');
    this.dressEnemy(null);
    this.ai.setProfile(QUICK_DUEL_AI);
    this.resetAttract();
    this.menus.showCampaignComplete({ clears: this.campaign.saved.clears, unsaved: this.winUnsaved }, { again: () => this.newGauntlet(), menu: () => this.toMenu() });
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
    // A double fight's two bosses share one column.
    const enemy = { ...g.enemy.stats };
    for (const w of g.enemies) {
      if (w === g.enemy) continue;
      for (const k of Object.keys(enemy) as (keyof typeof enemy)[]) enemy[k] += w.stats[k];
    }
    const stats = { player: { ...g.player.stats }, enemy };
    const boss = this.match.boss;
    let data: ResultData;
    if (boss) {
      const c = this.campaign;
      const next = c.nextBoss;
      const onward = this.gauntletOutcome === 'complete' || !next
        ? { label: 'Claim Victory', action: () => this.showCampaignComplete() }
        : { label: 'Next Fight', sub: bossDisplayName(next), action: () => (c.advance(), this.showBossCard()) };
      // A newly learned spell is revealed on the way onward.
      const learned = p1Won ? c.lastLearned : null;
      const primary = !p1Won
        ? { label: 'Retry', action: () => this.startBossFight() }
        : learned
          ? { label: 'Continue', action: () => this.showSpellReveal(learned, onward) }
          : onward;
      const name = bossDisplayName(boss);
      const pair = !!boss.partner;
      // Settled when the fight ended (onMatchEnd), so it always matches the save.
      const unsaved = p1Won ? this.winUnsaved : this.godUsed ? 'god' : null;
      data = {
        title: p1Won ? 'Victory' : 'Defeat',
        subtitle: p1Won ? `${name}, ${boss.title}, ${pair ? 'fall' : 'falls'}.` : `${name}, ${boss.title}, ${pair ? 'win' : 'wins'} this time.`,
        eyebrow: `Fight ${this.match.bossIndex + 1} of ${BOSSES.length}${p1Won ? (unsaved ? ' · not saved' : ' cleared') : ''}`,
        boss,
        primary,
        victory: p1Won,
        names: ['You', name],
        // One life, one round: the fight's facts instead of a round strip.
        rounds: [],
        facts: this.fightFacts(p1Won),
        tag: unsaved === 'god' ? 'God mode · progress not saved' : unsaved === 'skipped' ? 'Not saved · earlier wins used god mode' : undefined,
        learned: learned ? REWARD_SPELL_INFO[learned].name : undefined,
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

  /** Gauntlet results: fight length, how far each boss got, life packs, health left. */
  private fightFacts(won: boolean): { label: string; value: string }[] {
    const g = this.game;
    const m = this.match;
    const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    const roman = ['I', 'II', 'III'];
    const reached = g.enemies
      .map((w) => {
        const st = g.stagesOf(w);
        if (!st?.current) return '';
        return g.partnerActive ? `${w.name} ${roman[st.stage]}` : `${st.stage + 1} of 3 · ${st.current.name}`;
      })
      .filter(Boolean)
      .join(' · ');
    const lp = g.lifePacks;
    const facts = [
      { label: 'Fight time', value: clock(m.elapsed) },
      { label: g.partnerActive ? 'Stages reached' : 'Stage reached', value: reached },
      { label: 'Life packs', value: `${lp.collected} of ${CONFIG.lifePacks.maxPerFight}` },
    ];
    if (won) facts.push({ label: 'Health left', value: `${Math.round((g.player.health / g.player.maxHealth) * 100)}%` });
    return facts;
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
