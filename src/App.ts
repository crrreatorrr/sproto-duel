import * as THREE from 'three';
import { CONFIG, type TeamPalette } from './config';
import { AudioManager } from './audio/AudioManager';
import { BossCinematic } from './campaign/BossCinematic';
import { Campaign } from './campaign/Campaign';
import { BOSSES, bossDisplayName, type BossDef } from './campaign/levels';
import { DoubleTap } from './core/DoubleTap';
import { events } from './core/events';
import { bindRumble, connectedPadIndices, GamepadInput, padHolding, rewardLabels, spellLabels } from './core/Gamepad';
import { bossModelKeys, nearestStanding, type Game } from './core/Game';
import { Match } from './core/Match';
import { ONLINE, QUICK, VERSUS, type MatchRules } from './core/rules';
import type { OnlineController } from './net/OnlineController';
import type { OnlineLobby, OnlineSession, SessionState } from './net/OnlineSession';
import type { OutcomeMsg, StartMsg } from './net/protocol';
/** The online stack, loaded on first use (keeps it out of the boot bundle). */
type NetStack = typeof import('./net/onlineStack');
import type { TickController } from './core/Game';
import { assignDevices } from './input/assignDevices';
import type { DeviceBinding } from './input/IntentSource';
import { LocalHumanSource } from './player/PlayerController';
import { AIController } from './enemy/AIController';
import { HUD } from './ui/HUD';
import { TitleStaffPreview } from './ui/TitleStaffPreview';
import { titleStaffCycle } from './ui/titleStaffs';
import { Menus, loadSettings, saveSettings, type MenuAction, type ResultData, type Settings, type StageInfo, type UnsavedReason } from './ui/Menus';
import { HubLink } from './hub/link';
import { equipStaff, isStaffId, staffCard, staffModelPath } from './staff/catalog';
import { getLoadout, setSelectedStaff, setSessionRelics } from './staff/loadout';
import { REWARD_SPELLS, REWARD_SPELL_INFO, type RewardSpellId } from './spells/rewardCatalog';
import type { Wizard } from './wizard/Wizard';

type AppState = 'menu' | 'playing' | 'paused' | 'results';
/**
 * Quick Duel (one fixed rival), the Boss Gauntlet campaign (the difficulty ladder), Local Versus
 * (two players, split-screen) or an online 1v1.
 */
export type GameMode = 'quick' | 'gauntlet' | 'versus' | 'online';

const tmpRight = new THREE.Vector3();
const WHITE = new THREE.Color(1, 1, 1);
/** What an online match that ended without a result says on the online menu. */
const ONLINE_REASONS: Record<string, string> = {
  version_mismatch: 'Your opponent is on another version of Sproto Duel. Reload to update.',
  join_timeout: 'Your opponent did not connect in time.',
  start_timeout: 'The match did not start in time.',
  opponent_left: 'Your opponent left before the start.',
  room_expired: 'Nobody joined the room in time.',
  room_not_found: 'No open room with that code.',
  bad_code: 'Room codes are 6 letters and digits.',
  disconnected: 'Lost the connection to the server.',
  match_ended: 'The match ended.',
  wrong_scope: 'Enter Sproto Duel from the hub portal to play online.',
  cancelled: 'Search cancelled.',
};

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
  /** Drives the rival (and partner) in single player: Game.enemyController outside Local Versus. */
  private readonly aiDriver: TickController;
  /** Local Versus: P2's own pad, and P2's seat (built on first use). */
  readonly p2Pad = new GamepadInput();
  private p2Source: LocalHumanSource | null = null;
  /** Local Versus is set up (split-screen, P2's seat, no AI): leaveVersus undoes it. */
  private versusOn = false;
  /** The device split of the current (or last) Local Versus, for Rematch. */
  private versusDevices: [DeviceBinding, DeviceBinding] | null = null;
  /** Local Versus join screen: the pad that joined as P2, and whether A was let go since. */
  private join: { p2: number | null; released: boolean } | null = null;
  /**
   * Online Duel is in this build: VITE_ONLINE=1 (off by default until the two-machine playtest),
   * or `?online` / `?netsim=<ms>` in `npm run dev`.
   */
  readonly onlineBuilt: boolean;
  /** The current online match (or search), its game wiring, and the server's verdict. */
  onlineSession: OnlineSession | null = null;
  onlineCtl: OnlineController | null = null;
  private onlineOutcome: OutcomeMsg | null = null;
  private onlineLobbyCache: OnlineLobby | null = null;
  /** Dev only: a lobby on an in-page fake server with a scripted opponent (`?netsim=<latency ms>`). */
  devLobby: (() => OnlineLobby) | null = null;
  private net: NetStack | null = null;
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
  /** The title screen's live Wizard Sproto (its own small renderer); freed when a fight starts. */
  private titlePreview: TitleStaffPreview | null = null;
  /** When the last pause happened (ms); the Esc that released pointer lock must not also resume. */
  private pausedAt = 0;

  constructor(readonly game: Game, campaign = new Campaign(), private readonly hub = HubLink.standalone()) {
    const q = new URLSearchParams(location.search);
    this.onlineBuilt = import.meta.env.VITE_ONLINE === '1' || (import.meta.env.DEV && (q.has('online') || q.has('netsim')));
    // Relics the existing init already returned. No session: the staff cache stays the fallback.
    setSessionRelics(hub.connected ? hub.relics : null);
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
    this.p2Pad.slot = null;
    game.enemyController = this.aiDriver = {
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
      versus: () => this.showVersusJoin(),
      online: () => (!this.onlineBuilt ? null : this.onlineAvailable
        ? { enabled: true, why: 'Quick match or a private room' }
        : { enabled: false, why: 'Enter from the hub portal to play online' }),
      openOnline: () => this.openOnline(),
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
      refreshTickets: () => this.hub.refreshBalance(),
      staffRack: () => this.staffRack(),
      selectStaff: (id) => this.selectStaff(id),
      titleStage: (slot) => this.showTitleStage(slot),
      uiSound: (kind) => this.audio.play(kind === 'hover' ? 'uiHover' : 'uiClick', { exactPitch: true }),
    });
    this.applySettings(this.settings);

    game.onFrame((dt) => this.frame(dt));
    game.beforeRender.push(() => this.onlineCtl?.frame());
    events.on('matchEnd', (e) => this.onMatchEnd(e.winner));
    this.bindInput();
    this.applyStaff();
    this.toMenu();
  }

  /**
   * Equip the staff `getLoadout` allows. Ranked (`HubLink.ranked`, from the vendored SDK init)
   * keeps the mesh and colours and uses starter stats. There is no mid-fight swap: menus call
   * this, and every match start calls it again. Equipping does not report Tickets, Relics, or scores.
   */
  private applyStaff(cosmetic = false): void {
    const load = getLoadout();
    if (load.replaced) this.menus.toast('Gear unavailable', load.replaced);
    // Ranked flag is already on the hub session. Standalone play leaves it false. Versus and
    // online use the same starter stats (`cosmetic`), so the staff is only a look there.
    const ranked = this.hub.ranked || cosmetic;
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
    if (isStaffId(id)) this.titlePreview?.focus(id);
  }

  /**
   * Main menu: the live Wizard Sproto cycling the owned staffs (every staff, unowned ones locked,
   * without a hub session). Built on first use and again after a fight freed it.
   */
  private showTitleStage(slot: HTMLElement): void {
    this.titlePreview ??= TitleStaffPreview.create(this.game.assets);
    const load = getLoadout();
    this.titlePreview?.mount(slot, titleStaffCycle(this.hub.connected, load.owned, load.staff));
  }

  private disposeTitleStage(): void {
    this.titlePreview?.dispose();
    this.titlePreview = null;
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
    const split = this.game.split;
    if (split) this.p2Pad.update();
    const pause = CONFIG.gamepad.bindings.pause;
    if (pad.wasPressed(pause) || (split && this.p2Pad.wasPressed(pause))) {
      if (this.state === 'playing') return this.pause();
      if (this.state === 'paused') return this.resume();
    }
    if (this.join && this.menus.current === 'versus-join') return this.joinFrame();
    // Split-screen pause menu: whichever pad is there navigates it.
    this.menus.nav.update(split && !pad.connected ? this.p2Pad : pad, dt);
  }

  /** Local Versus join screen, once per frame: A on a pad joins P2, A again (or B to go back). */
  private joinFrame(): void {
    const j = this.join!;
    const holding = padHolding('a');
    if (holding < 0) j.released = true;
    if (j.released && holding >= 0) {
      j.released = false;
      if (j.p2 === null) {
        j.p2 = holding;
        this.audio.play('uiClick', { exactPitch: true });
      } else if (holding === j.p2 || connectedPadIndices().length > 1) {
        this.startVersusFromJoin();
        return;
      }
    }
    if (padHolding('b') >= 0 && j.p2 !== null) j.p2 = null;
    this.menus.updateVersusJoin(this.joinView());
  }

  private joinView() {
    const pads = connectedPadIndices();
    const j = this.join;
    const p2 = j?.p2 ?? null;
    const devices = p2 !== null && pads.includes(p2) ? assignDevices(pads, true, p2) : null;
    const p1Pad = devices?.[0].pad ?? null;
    return {
      p1: `Keyboard + mouse${typeof p1Pad === 'number' ? ` + Controller ${p1Pad + 1}` : ''}`,
      p2: devices ? `Controller ${p2! + 1}` : null,
      pads: pads.length,
    };
  }

  /** Local Versus: the join screen over the attract duel. */
  showVersusJoin(): void {
    this.enterMenuState('quick');
    this.join = { p2: null, released: false };
    this.menus.showVersusJoin(this.joinView(), { start: () => this.startVersusFromJoin(), back: () => this.toMenu() });
  }

  private startVersusFromJoin(): void {
    const j = this.join;
    const pads = connectedPadIndices();
    const devices = j && j.p2 !== null ? assignDevices(pads, true, j.p2) : null;
    if (!devices) {
      this.menus.toast('Player 2 needs a controller', 'Press A on a controller to join');
      return;
    }
    this.join = null;
    this.startVersus(devices);
  }

  /**
   * Local Versus: P1 (seat 0, left) against P2 (seat 1, right, the rival's look and palette) in
   * the moonlit arena, split-screen, best of three under VERSUS rules: no AI, reward spells, life
   * packs or god mode, both staffs cosmetic (starter stats), and nothing reported to the hub.
   */
  startVersus(devices: [DeviceBinding, DeviceBinding]): void {
    const g = this.game;
    this.endOnline();
    this.versusDevices = devices;
    this.mode = 'versus';
    this.dressEnemy(null);
    // P1's pad changes hands (to P2, or to a fixed slot): forget its state without the "pad
    // unplugged" notice, which would pause the match, and play P1 on keyboard + mouse until used.
    g.input.pad.reset();
    g.input.pad.slot = devices[0].pad;
    g.input.pad.excluded.clear();
    if (devices[0].keyboardMouse) g.input.pad.setDevice('kbm');
    g.playerController.kbm = devices[0].keyboardMouse;
    this.p2Pad.reset();
    this.p2Pad.slot = devices[1].pad;
    this.p2Pad.setDevice('gamepad');
    g.setSplit(true);
    this.versusOn = true;
    if (!this.p2Source) {
      this.p2Source = new LocalHumanSource(g.input, g.rigs[1], g.enemy, g.physics, () => [g.player], { keyboardMouse: false, pad: this.p2Pad });
    }
    this.p2Source.applyPadSettings(this.settings);
    g.controllers[1] = this.p2Source;
    if (!g.extraPads.includes(this.p2Pad)) g.extraPads.push(this.p2Pad);
    g.enemyController = null;
    g.enemy.intent.clear();
    this.hud.setViews(2);
    this.hud.setNames(['P1', 'P2']);
    this.beginMatch(null, VERSUS);
  }

  // ------------------------------------------------------------------ Online Duel

  /** Matchmaking for this visit: the hub realtime client, the dev fake (`?netsim`), or null standalone. */
  private onlineLobby(): OnlineLobby | null {
    if (this.devLobby) return (this.onlineLobbyCache ??= this.devLobby());
    if (this.onlineLobbyCache) return this.onlineLobbyCache;
    if (!this.hub.connected || !this.net) return null;
    const rt = this.hub.realtime(this.net.realtimeFromSdk);
    return rt ? (this.onlineLobbyCache = new this.net.HubLobby(rt)) : null;
  }

  /** Online Duel can be offered: a hub-connected visit (or the dev fake). */
  private get onlineAvailable(): boolean {
    return this.devLobby !== null || this.hub.connected;
  }

  /** The Online Duel menu over the attract duel. `note`: why the last attempt ended. */
  openOnline(note = ''): void {
    this.enterMenuState('quick');
    this.menus.showOnline({
      quick: () => this.startOnline('quick'),
      create: () => this.startOnline('create'),
      join: (code) => this.startOnline('join', code),
      back: () => this.toMenu(),
    }, note);
  }

  /** Search, open a room, or join one; START then begins the match (beginOnline). */
  startOnline(kind: 'quick' | 'create' | 'join', code = ''): void {
    if (!this.net) {
      this.menus.showOnlineStatus('Connecting…', 'Loading Online Duel', { cancel: () => this.openOnline() });
      void import('./net/onlineStack').then((net) => {
        this.net = net;
        if (this.menus.current === 'online-status') this.startOnline(kind, code);
      }, () => this.openOnline('Could not load Online Duel. Check your connection.'));
      return;
    }
    const net = this.net;
    const lobby = this.onlineLobby();
    if (!lobby) {
      this.menus.toast('Online Duel', 'Enter from the hub portal to play online');
      return;
    }
    this.endOnline();
    const N = CONFIG.net;
    const s = new net.OnlineSession(lobby, {
      scheduler: net.realScheduler,
      staff: getLoadout().staff,
      inputDelayTicks: N.inputDelayTicks,
      maxInputLagTicks: N.maxInputLagTicks,
      interpDelayMs: N.interpDelayMs,
      extrapolateMaxMs: N.extrapolateMaxMs,
      tickMs: CONFIG.sim.fixedDt * 1000,
      pingEveryMs: N.pingEveryS * 1000,
      inputEveryTicks: N.snapEveryTicks,
    });
    this.onlineSession = s;
    this.onlineOutcome = null;
    const cancel = () => this.openOnline();
    s.on('state', (st) => this.onlineState(s, st, cancel));
    s.on('start', (m) => this.beginOnline(s, m));
    s.on('peer', (p) => this.menus.toast(p.present ? 'Opponent is back' : 'Opponent disconnected', p.present ? '' : `Waiting up to ${p.graceS} s`));
    s.on('outcome', (o) => this.onOutcome(s, o));
    s.on('cancel', (reason) => this.onOnlineEnded(s, reason));
    if (kind === 'quick') void s.quickMatch();
    else if (kind === 'create') {
      void s.createRoom().then((c) => {
        if (c && s.state === 'hosting-room') this.menus.showOnlineStatus('Room Created', 'Share the code. Waiting for your opponent…', { cancel }, c);
      });
    } else void s.joinRoom(code);
  }

  private onlineState(s: OnlineSession, st: SessionState, cancel: () => void): void {
    if (s !== this.onlineSession || this.state === 'playing' || this.state === 'paused') return;
    const screens: Partial<Record<SessionState, [string, string]>> = {
      connecting: ['Connecting…', 'Opening the hub connection'],
      searching: ['Searching…', 'Looking for an opponent'],
      'hosting-room': ['Creating Room…', ''],
      'joining-room': ['Joining Room…', s.roomCode ?? ''],
      starting: ['Opponent Found', 'Starting…'],
    };
    const screen = screens[st];
    if (screen) this.menus.showOnlineStatus(screen[0], screen[1], { cancel: () => (s.leave(), cancel()) });
  }

  /** START: both sides set up their game (the host runs the sim, the guest a replica). */
  private beginOnline(s: OnlineSession, start: StartMsg): void {
    if (s !== this.onlineSession) return;
    this.leaveVersus();
    this.mode = 'online';
    this.dressEnemy(null);
    this.onlineOutcome = null;
    const ctl = (this.onlineCtl = new this.net!.OnlineController(this.game, this.match, s, this.net!.realScheduler));
    ctl.begin(start);
    this.hud.setNames(['You', start.names[1 - start.seat] || 'Opponent']);
    this.beginMatch(null, ONLINE, !s.isHost);
  }

  /** The server's verdict: shown on the results (now, if the match ended early), Tickets refreshed. */
  private onOutcome(s: OnlineSession, o: OutcomeMsg): void {
    if (s !== this.onlineSession) return;
    this.onlineOutcome = o;
    void this.hub.onOnlineOutcome(o, this.onlineLobby()?.selfId ?? null, (title, sub) => this.menus.toast(title, sub, 'tickets'));
    this.onlineCtl?.stop();
    if (this.state === 'results') this.menus.setResultNote(this.outcomeText());
    // A match that ended early (forfeit, opponent gone, stall): results now. A finished one keeps
    // its KO beat (onMatchEnd's results timer) and shows the verdict when the screen comes up.
    else if ((this.state === 'playing' || this.state === 'paused') && this.match.phase !== 'matchEnd') this.showResults();
  }

  /** Ended without an outcome: back to the online menu with the reason. */
  private onOnlineEnded(s: OnlineSession, reason: string): void {
    if (s !== this.onlineSession) return;
    const inMatch = this.state === 'playing' || this.state === 'paused';
    this.onlineCtl?.stop();
    if (reason === 'left' && !inMatch) return;
    if (this.state === 'results' && this.mode === 'online') {
      this.menus.setResultNote(this.outcomeText());
      return;
    }
    this.openOnline(ONLINE_REASONS[reason] ?? `Connection ended (${reason})`);
  }

  private outcomeText(): string {
    const o = this.onlineOutcome;
    const s = this.onlineSession;
    if (!o) return s && s.state === 'ended' ? 'The server sent no result: no Tickets' : 'Confirming with the server…';
    const me = s?.seat ?? 0;
    const won = o.winnerSeat === me;
    const paid = Object.values(o.paid).reduce((a, b) => a + b, 0);
    const self = this.onlineLobby()?.selfId;
    const myPay = (self && o.paid[self]) || 0;
    switch (o.status) {
      case 'verified':
        return won ? (myPay ? `Confirmed · +${myPay} Tickets` : 'Confirmed · no Tickets (daily limit reached)') : 'Confirmed';
      case 'forfeit':
        if (!won) return 'Forfeited';
        return paid ? `Opponent left, you win · +${myPay || paid} Tickets` : 'Opponent left, you win (too early for Tickets)';
      case 'disputed':
        return 'Disputed: the two results did not match · no Tickets';
      case 'draw':
        return 'Draw · no Tickets';
      case 'timeout':
        return 'Ran out of time · no Tickets';
      case 'both_left':
        return 'Both players left';
      default:
        return 'The server ended the match · no Tickets';
    }
  }

  /** Leave any online search or match (the server treats it as leaving) and undo its wiring. */
  private endOnline(): void {
    const s = this.onlineSession;
    const ctl = this.onlineCtl;
    this.onlineCtl = null;
    this.onlineSession = null;
    if (s?.active) s.leave();
    if (!ctl) return;
    // Only what an online match changed is put back (the AI rival, the local role).
    ctl.stop();
    if (this.game.enemyController === null) this.game.enemyController = this.aiDriver;
    this.game.role = 'local';
    this.game.fixedTimeScale = false;
  }

  /** Back to one player on one screen (every non-Versus mode starts with this). */
  private leaveVersus(): void {
    const g = this.game;
    this.join = null;
    if (!this.versusOn) return;
    this.versusOn = false;
    g.setSplit(false);
    if (g.controllers[1] === this.p2Source) g.controllers[1] = null;
    g.extraPads.length = 0;
    g.enemyController = this.aiDriver;
    g.input.pad.reset();
    g.input.pad.slot = 'any';
    g.input.pad.excluded.clear();
    g.playerController.kbm = true;
    this.p2Pad.reset();
    this.p2Pad.slot = null;
    this.hud.setViews(1);
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
    this.p2Source?.applyPadSettings(s);
    for (const r of g.rigs) r.sensitivity = CONFIG.camera.sensitivity * s.sensitivity;
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
    this.endOnline();
    this.leaveVersus();
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
    // Boss stage models load on demand (AssetLoader.loadAll skips them): wait for this boss's.
    const keys = bossModelKeys(boss);
    if (!this.game.assets.modelsReady(keys)) {
      this.menus.toast('Summoning…', bossDisplayName(boss));
      void this.game.assets.ensureModels(keys).then(() => {
        if (this.state !== 'playing' && this.state !== 'paused' && this.campaign.boss === boss) this.showBossCard(freshRun);
      });
      return;
    }
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
    this.endOnline();
    this.leaveVersus();
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
    else if (this.mode === 'versus' && this.versusDevices) this.startVersus(this.versusDevices);
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
    if (on && (this.state === 'playing' || this.state === 'paused') && !this.match.rules.godModeAllowed) {
      this.menus.toast('God mode is off here', 'Local Versus and online duels are played even');
      return;
    }
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

  private beginMatch(boss: BossDef | null, rules?: Readonly<MatchRules>, replica = false): void {
    const g = this.game;
    this.disposeTitleStage();
    const r = rules ?? (boss ? undefined : QUICK);
    const even = r !== undefined && !r.godModeAllowed;
    this.audio.gameplayMuted = false;
    g.player.intent.clear();
    this.syncLearned();
    // Versus / online: no reward spells, and the staff is the look only (starter stats).
    if (even) g.player.learned.clear();
    this.applyStaff(even);
    // God mode's stats come back on the player (the menu's background duel fights without them),
    // except where the rules forbid it: then they stay held off, whatever the flag says.
    g.holdGodMode(even);
    this.gauntletOutcome = null;
    this.winUnsaved = null;
    this.godUsed = !even && CONFIG.debug.godMode;
    this.cinematic.abort();
    this.cinematic.armed = boss !== null;
    this.menus.hide();
    this.hud.show(true);
    g.rig.orbit = false;
    g.playerControl = true;
    this.state = 'playing';
    this.resultsTimer = 0;
    if (replica) this.match.prepareReplica(r ?? ONLINE);
    else this.match.startMatch(boss, r);
    this.audio.setPaused(false);
    this.audio.playMusic('musicBattle');
    this.audio.setAmbient(true);
    if (this.requireLock) {
      // An online match never waits for the mouse: the other player's game keeps going.
      if (r?.pause !== false) g.simulating = g.input.locked;
      g.input.requestLock();
    }
  }

  pause(): void {
    if (this.state !== 'playing') return;
    if (this.mode === 'online') {
      // Online never pauses: an overlay over the running fight (Resume / Forfeit).
      this.state = 'paused';
      this.pausedAt = performance.now();
      this.game.input.releaseLock();
      this.menus.showOnlinePause({ resume: () => this.resume(), forfeit: () => this.onlineSession?.forfeit() });
      return;
    }
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
    if (this.mode === 'online') {
      if (this.requireLock) this.game.input.requestLock();
      return;
    }
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
    this.endOnline();
    this.leaveVersus();
    this.match.rules = QUICK;
    g.spells.rewardSpellsEnabled = true;
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
    // Local Versus and online report nothing from the client (rules.reportToHub; see planDuelWin).
    if (!this.game.qaMode && this.match.rules.reportToHub) {
      const bossId = this.match.boss?.id ?? null;
      void this.hub.onDuelWin(
        { mode: this.mode, playerWon: winner === this.game.player, bossId, godMode: this.godUsed, elapsed: this.match.elapsed },
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
    } else if (this.mode === 'online') {
      const o = this.onlineOutcome;
      const me = this.onlineSession?.seat ?? 0;
      const won = o && o.winnerSeat !== null ? o.winnerSeat === me : p1Won;
      const opp = this.onlineSession?.start?.names[1 - me] || 'Opponent';
      data = {
        title: o && o.winnerSeat === null && o.status !== 'disputed' ? 'No Contest' : won ? 'Victory' : 'Defeat',
        subtitle: this.outcomeText(),
        eyebrow: 'Online Duel',
        victory: won,
        names: ['You', opp],
        rounds,
        primary: { label: 'Online Menu', action: () => this.openOnline() },
        ...stats,
      };
    } else if (this.mode === 'versus') {
      const draw = this.match.wins[0] === this.match.wins[1];
      data = {
        title: draw ? 'Draw' : p1Won ? 'Player 1 wins' : 'Player 2 wins',
        subtitle: `${this.match.wins[0]} – ${this.match.wins[1]}`,
        eyebrow: 'Local Versus',
        victory: p1Won,
        names: ['P1', 'P2'],
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
    this.hud.setPing(this.onlineCtl?.active ? this.onlineSession?.rttMs ?? -1 : null);
    if (this.resultsTimer > 0) {
      this.resultsTimer -= dt;
      if (this.resultsTimer <= 0 && this.state === 'playing') this.showResults();
    }
    const cam = g.renderer.camera;
    tmpRight.setFromMatrixColumn(cam.matrixWorld, 0);
    this.audio.setListener(cam.position, tmpRight);
  }
}
