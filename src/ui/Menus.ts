import { CONFIG, type Difficulty } from '../config';
import type { ExchangeView, HubStatus } from '../hub/link';
import { padGlyph, type InputDevice, type PadButton, type PadStyle } from '../core/Gamepad';
import {
  ACTION_LABELS, DEADZONE_MAX, DEADZONE_MIN, applyControlPrefs, bindKey, bindPad, clearKey, defaultControlPrefs,
  keyLabel, loadControlPrefs, saveControlPrefs, type BindResult, type ControlPrefs, type KeyAction, type PadAction,
} from '../input/controlPrefs';
import { fullscreenSupported, isFullscreen, toggleFullscreen } from './fullscreen';
import { REWARD_SPELLS, REWARD_SPELL_INFO, type RewardSpellId } from '../spells/rewardCatalog';
import { rewardIcon } from './icons';
import { MENU_BACK, MenuNav } from './MenuNav';
import { resolveImage } from '../assets/AssetLoader';
import { bossStagePortrait } from '../assets/manifest';
import { STAGE_COUNT, stageAttackSummary } from '../campaign/BossStages';
import { ARENA_NAMES, BOSSES, bossDisplayName, type BossDef, type BossFighter } from '../campaign/levels';
import { bossPortraitHtml, bossStyleVars } from '../campaign/portrait';
import { ticketChipLabel, ticketChipText } from './ticketChip';

/**
 * Room code alphabet and length for typing a code with a controller (MenuNav's pad text entry).
 * Same as ROOM_ALPHABET / ROOM_CODE_LENGTH in net/protocol (a test keeps them equal); not imported,
 * so the online protocol stays in its lazily loaded chunk.
 */
export const ROOM_CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROOM_CODE_MAX = 6;

export interface Settings {
  /** Multiplier on CONFIG.camera.sensitivity. */
  sensitivity: number;
  invertY: boolean;
  master: number;
  music: number;
  sfx: number;
  bloom: boolean;
  shadows: boolean;
  /** Controller: multiplier on CONFIG.gamepad.sensitivity. */
  padSensitivity: number;
  padInvertY: boolean;
  /** Controller aim assist strength (0 = off, 1 = default). */
  aimAssist: number;
  rumble: boolean;
  /** Quick Duel's rival: Apprentice ('easy'), Adept ('normal') or Archmage ('hard'). */
  quickDifficulty: Difficulty;
}

const DIFFICULTY_ORDER: readonly Difficulty[] = ['easy', 'normal', 'hard'];
const DIFFICULTY_BLURB: Record<Difficulty, string> = {
  easy: 'slower to react, misses more',
  normal: 'dodges, shields and punishes',
  hard: 'fast, accurate, reflects your spells',
};

const STORAGE_KEY = 'arcane-duel-settings';

export function loadSettings(): Settings {
  const defaults: Settings = {
    sensitivity: 1,
    invertY: false,
    master: CONFIG.audio.master,
    music: CONFIG.audio.music,
    sfx: CONFIG.audio.sfx,
    bloom: CONFIG.render.bloom,
    shadows: CONFIG.render.shadows,
    padSensitivity: 1,
    padInvertY: false,
    aimAssist: CONFIG.gamepad.aimAssist.strength,
    rumble: CONFIG.gamepad.rumble.enabled,
    quickDifficulty: 'easy',
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      // Older saves carried a `difficulty` from before the single Rival; the choice now lives in
      // `quickDifficulty` and starts at Apprentice. `practiceDone` moved into the campaign's progress
      // store (it is progress, kept per hub account); an old value stays in the save untouched for
      // the device copy to read.
      const { difficulty: _legacy, ...saved } = JSON.parse(raw) as Partial<Settings> & { difficulty?: unknown };
      const out = { ...defaults, ...saved };
      if (!DIFFICULTY_ORDER.includes(out.quickDifficulty)) out.quickDifficulty = defaults.quickDifficulty;
      return out;
    }
  } catch {
    // Storage unavailable (private mode, blocked): defaults are fine.
  }
  return defaults;
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Not critical.
  }
}

export interface ResultData {
  title: string;
  subtitle: string;
  /** Styles the screen in player 1's colour (true) or player 2's / the rival's (false). */
  victory: boolean;
  names: [string, string];
  rounds: ('win' | 'lose' | 'draw')[];
  /** Boss Gauntlet (one round): facts shown instead of the round strip, e.g. fight time and stage reached. */
  facts?: { label: string; value: string }[];
  /** A pill above the title, e.g. "God mode · progress not saved". */
  tag?: string;
  player: { damageDealt: number; casts: number; hits: number; perfects: number; dodges: number };
  enemy: { damageDealt: number; casts: number; hits: number; perfects: number; dodges: number };
  /** Small line above the title, e.g. "Fight 2 of 5". */
  eyebrow?: string;
  /** Campaign boss for the portrait and colours. */
  boss?: BossDef;
  /** Main button; defaults to "Rematch" (MenuHandlers.restart). */
  primary?: MenuAction;
  /** A reward spell this win taught for the first time (its name): a chip, then the reveal screen. */
  learned?: string;
}

/** A button: its label, an optional second line (e.g. the next boss's name), and what it does. */
export interface MenuAction {
  label: string;
  sub?: string;
  action(): void;
}

/**
 * Why beating the boss on the card would save nothing: 'god', god mode is on; 'skipped', earlier
 * fights of this run were won in god mode (App.rewardNote).
 */
export type UnsavedReason = 'god' | 'skipped';

/** What the boss intro card shows. */
export interface BossIntro {
  boss: BossDef;
  /** 0-based fight number. */
  index: number;
  total: number;
  /** The player already knows this boss's reward spell. */
  rewardLearned?: boolean;
  /** A win here would not be saved (the reward line says so instead of "Defeat to learn"). */
  rewardNote?: UnsavedReason | null;
  /** A line under Begin, e.g. that it replaces the saved run (New Gauntlet). */
  beginNote?: string;
}

/** A boss's current stage, for the pause screen. */
export interface StageInfo {
  /** 0-based stage. */
  index: number;
  name: string;
  /** Whose stage, in a double fight (shown before it); '' for a lone boss. */
  who?: string;
  /** That boss is knocked out this round. */
  down?: boolean;
}

const NUMERALS = ['I', 'II', 'III'];

/** Actions that have a controller button (the rest are on the sticks). */
const PAD_ACTION_SET: ReadonlySet<string> = new Set<PadAction>(['sprint', 'jump', 'dodge', 'bolt', 'blast', 'shield', 'stun', 'ultimate', 'carpet', 'pump', 'vape', 'lockon', 'breath', 'pause']);
const DEFAULT_BIND_NOTE = 'Pick a slot, then press the new key or button. One already in use swaps with it.';

/** Saved gauntlet progress, for the main menu. */
export interface GauntletStatus {
  canContinue: boolean;
  /** Boss that Continue would start. */
  next: BossDef | null;
  nextIndex: number;
  clears: number;
}

/** Quick-match search screen. `rttMs` is -1 until a sample exists. */
export interface SearchView {
  elapsedS: number;
  online: number | null;
  queued: number | null;
  note: string;
  rttMs: number;
}

/** Match-found accept window. `leftS` counts down from `totalS`. */
export interface FoundView {
  names: [string, string];
  accepted: [boolean, boolean];
  seat: 0 | 1;
  leftS: number;
  totalS: number;
  rttMs: number;
}

/** Rematch prompt on the results screen. */
export interface RematchView {
  leftS: number;
  totalS: number;
  offeredBy: 'you' | 'them' | null;
  youOffered: boolean;
}

/** Local Versus join screen state (App polls the pads and repaints it). */
export interface VersusJoinView {
  /** What P1 plays with, e.g. "Keyboard + mouse" or "Keyboard + mouse + Controller 1". */
  p1: string;
  /** What P2 plays with once joined, or null while waiting for a pad. */
  p2: string | null;
  /** Connected controllers. */
  pads: number;
}

export interface MenuHandlers {
  /** Quick Duel against the Rival at Settings.quickDifficulty. */
  start(): void;
  /** Practice: the playable tutorial against a training dummy. Missing hides the button. */
  practice?(): void;
  /** The Practice lessons were finished once (progress): the main menu stops pointing at them. */
  practiceDone?(): boolean;
  /** Local Versus: open the join screen. */
  versus?(): void;
  /** Online Duel on the main menu. Null hides the button. `why` is the second line; a disabled button still shows. */
  online?(): { enabled: boolean; why: string } | null;
  openOnline?(): void;
  /** Boss Gauntlet from fight 1. */
  gauntlet(): void;
  /** Resume the saved gauntlet. */
  continueGauntlet(): void;
  gauntletStatus(): GauntletStatus;
  resume(): void;
  /** Open the hub feedback window (the pause menus' Send Feedback). */
  feedback?(): void;
  restart(): void;
  quit(): void;
  settingsChanged(s: Settings): void;
  /** God mode (testing) is session-only, so it lives outside the saved Settings. */
  godMode(): boolean;
  setGodMode(on: boolean): void;
  uiSound(kind: 'hover' | 'click'): void;
  /** Reward spells the player can cast now (saved ones, plus all five in god mode). */
  learnedSpells(): ReadonlySet<RewardSpellId>;
  /** Reward spells the campaign save has learned. */
  savedSpells(): ReadonlySet<RewardSpellId>;
  /** Settings: forget the learned reward spells. */
  forgetSpells(): void;
  /** Hub session, if this visit was opened from a portal. */
  hubStatus(): HubStatus;
  /** Spend Tickets for Verse. The server enforces the rate and the daily cap. */
  exchangeTickets(tickets: number): Promise<ExchangeView>;
  /** Close the hub session and go back to the Sproto Duel portal. */
  exitHub(): void;
  /** Re-read the Ticket balance for the main menu's chip (read only; standalone does nothing). */
  refreshTickets?(): Promise<unknown>;
  /** Owned staffs and the equipped one. Sproto is always owned. */
  staffRack(): { owned: { id: string; name: string; line: string; accent: string; bolt: string }[]; selected: string; ranked: boolean };
  /** Equip a staff. No-op mid-fight. */
  selectStaff(id: string): void;
  /** Character skins (look only): every one, locked until its boss is beaten, and the chosen one. */
  characterRack?(): { skins: { id: string; name: string; line: string; accent: string; locked: boolean }[]; selected: string };
  /** Wear a character skin. No-op mid-fight; a locked one says how to unlock it. */
  selectCharacter?(id: string): void;
  /** The main menu's slot for the title screen's live Wizard Sproto (App fills it). */
  titleStage?(slot: HTMLElement): void;
  /**
   * A fight is going on behind the menu: 'local' (paused), 'online' (a live match that never
   * pauses), or null. Main Menu and Hub ask before leaving one.
   */
  inFight?(): 'local' | 'online' | null;
  /** Leave for the hub from any menu (an online search or match is closed first). Defaults to exitHub. */
  toHub?(): void;
  /** Controller settings changed the bindings: relabel what shows them (the HUD). */
  controlsChanged?(): void;
}

/**
 * The standard options a menu screen offers in its top-right bar, besides Full Screen (always
 * there when the browser supports it). `reopen` brings the screen back after Controller Settings.
 * A screen whose own panel already has Main Menu or Return to Hub (marked data-sys-main /
 * data-sys-hub) leaves that one out of the bar.
 */
export interface SysOptions {
  main?: boolean;
  hub?: boolean;
  /** Controller Settings (false on that screen itself). Default true. */
  controls?: boolean;
  reopen(): void;
}

/** A key's printed name: KeyW -> W, Digit1 -> 1, ShiftLeft -> Shift, Escape -> Esc. */
export function keyName(code: string): string {
  if (code === 'Escape') return 'Esc';
  return code.replace(/^Key|^Digit|^Numpad/, '').replace(/(Left|Right)$/, '');
}

/** Keys for an action, deduplicated ("Shift", not "Shift / Shift"). */
const keys = (codes: readonly string[]) => [...new Set(codes.map(keyName))].join(' / ');

/** How to Play's keyboard rows, from CONFIG.controls (so they always match the real bindings). */
export function keyboardControls(): [string, string][] {
  const K = CONFIG.controls;
  return [
    ['W A S D / arrows', 'Move'],
    [keys(K.sprint), 'Sprint (drains mana)'],
    [keys(K.jump), 'Jump'],
    [keys(K.dodge), 'Dodge roll (brief invulnerability)'],
    [`Left click / ${keys(K.bolt)}`, 'Bolt: fast, cheap, hold to fire'],
    [`Right click / ${keys(K.blast)}`, 'Blast: slow orb, area damage'],
    [keys(K.shield), 'Shield: blocks. Perfect timing reflects'],
    [keys(K.stun), 'Stun beam: freezes for 1s'],
    [keys(K.ultimate), 'Ultimate: arena-wide shockwave'],
    [keys(K.pause), 'Pause'],
    ['Arrows / W S, Enter / Space, Esc', 'Menus: move, select, back'],
  ];
}

/** Controller rows for How to Play, from CONFIG.gamepad.bindings, in the pad's own glyphs. */
function padControls(style: PadStyle): [string, string][] {
  const b = CONFIG.gamepad.bindings;
  const g = (x: readonly string[]) => x.map((n) => padGlyph(n, style)).join(' / ');
  return [
    ['Left stick', 'Move (analog)'],
    ['Right stick', 'Camera'],
    [`${g(b.sprint)} (hold)`, 'Sprint'],
    [`${g(b.dodge)}`, 'Dodge roll'],
    [`${g(b.jump)}`, 'Jump'],
    [`${g(b.bolt)} (hold)`, 'Bolt'],
    [g(b.blast), 'Blast'],
    [g(b.shield), 'Shield (perfect timing reflects)'],
    [g(b.stun), 'Stun beam'],
    [g(b.ultimate), 'Ultimate'],
    [g(b.pause), 'Pause'],
    [`D-pad, ${padGlyph('a', style)} / ${padGlyph('b', style)}`, 'Menus: move, select, back'],
  ];
}

/** The boss that teaches reward spell `id`. */
const teacher = (id: RewardSpellId): BossDef => BOSSES.find((b) => b.reward === id)!;

/** Key and pad buttons for a reward spell, e.g. "Z · D-pad ←". */
function rewardKeys(id: RewardSpellId, style: PadStyle): string {
  const key = CONFIG.controls[id][0].replace(/^Key|^Digit/, '');
  return `${key} · ${CONFIG.gamepad.bindings[id].map((b) => padGlyph(b, style)).join(' / ')}`;
}

/** Main menu, pause, settings and results screens (DOM overlays). */
export class Menus {
  readonly root: HTMLElement;
  /** Gamepad navigation over whichever screen is open (App drives it each frame). */
  readonly nav: MenuNav;
  /** Glyph set for controller prompts; App keeps it in sync with the connected pad. */
  padStyle: PadStyle = 'xbox';
  /** The active input device (the reveal screen names the key or the pad button first). */
  padDevice: InputDevice = 'kbm';
  private readonly toastEl: HTMLElement;
  private settings: Settings;
  private screen: HTMLElement | null = null;
  /** The boss card on screen (its reward line follows god mode: setBossRewardNote). */
  private bossIntro: BossIntro | null = null;
  /** Controller settings being edited (the live layout: applied and saved on every change). */
  private controls: ControlPrefs = loadControlPrefs();
  /** Press-to-bind in progress on the controller screen. */
  private capture: { kind: 'key' | 'pad'; action: string; slot: number; btn: HTMLButtonElement } | null = null;

  constructor(parent: HTMLElement, initial: Settings, private readonly h: MenuHandlers) {
    this.settings = { ...initial };
    this.root = document.createElement('div');
    this.root.className = 'menus';
    parent.appendChild(this.root);
    this.nav = new MenuNav(this.root, () => this.h.uiSound('hover'));
    this.toastEl = document.createElement('div');
    this.toastEl.className = 'toast';
    this.toastEl.setAttribute('role', 'status');
    parent.appendChild(this.toastEl);
    // UI sounds for every button.
    this.root.addEventListener('pointerover', (e) => {
      const btn = (e.target as HTMLElement).closest('button');
      if (btn && !btn.contains(e.relatedTarget as Node)) this.h.uiSound('hover');
    });
    this.root.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) this.h.uiSound('click');
    });
    // Staff Rack: arrows move between staffs, [ ] equips the neighbour. Then the menu keys
    // (arrows / W / S move, Enter / Space press; MenuNav.key). Esc is App's.
    document.addEventListener('keydown', (e) => {
      this.onStaffKey(e);
      this.nav.key(e);
    });
    // Press-to-bind takes the next key before anything else sees it (Input, App's Esc, MenuNav).
    window.addEventListener('keydown', (e) => this.onCaptureKey(e), true);
    // A click anywhere but a binding slot cancels a bind in progress.
    document.addEventListener('pointerdown', (e) => {
      if (this.capture && !(e.target as Element | null)?.closest?.('[data-bind]')) this.cancelCapture();
    }, true);
    // F11 or Esc can leave full screen without the button: every visible toggle follows.
    document.addEventListener('fullscreenchange', () => this.paintFullscreen());
  }

  private onStaffKey(e: KeyboardEvent): void {
    const rack = this.screen?.querySelector('[data-staff-rack]');
    if (!rack) return;
    if ((e.target as HTMLElement | null)?.matches('input, textarea, select')) return;
    const buttons = [...rack.querySelectorAll<HTMLButtonElement>('[data-staff]')];
    if (!buttons.length) return;
    if (e.key === '[' || e.key === ']') {
      e.preventDefault();
      const equipped = buttons.findIndex((b) => b.classList.contains('equipped'));
      const dir = e.key === ']' ? 1 : -1;
      const next = buttons[(equipped + dir + buttons.length) % buttons.length];
      next.click();
      next.focus();
      return;
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const current = document.activeElement as HTMLElement | null;
    const i = buttons.findIndex((b) => b === current);
    if (i < 0 && !rack.contains(current)) return;
    e.preventDefault();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const from = i < 0 ? 0 : i;
    buttons[(from + dir + buttons.length) % buttons.length].focus();
  }

  /** Horizontal staff buttons. `autofocus` marks the equipped one so a pad starts there. */
  private staffRackHtml(autofocus: boolean, kicker = 'Staff'): string {
    const view = this.h.staffRack();
    const picks = view.owned.map((s) => {
      const on = s.id === view.selected;
      return `<button type="button" class="staff-pick${on ? ' equipped' : ''}" data-staff="${escapeHtml(s.id)}" style="--accent:${s.accent};--bolt:${s.bolt}" aria-pressed="${on}"${on && autofocus ? ' data-autofocus' : ''}>
        <i class="staff-orb" aria-hidden="true"></i><span class="staff-copy"><b>${escapeHtml(s.name)}</b><small>${escapeHtml(s.line)}</small></span></button>`;
    }).join('');
    const note = view.ranked ? '<p class="staff-ranked">Ranked: staff look only, starter stats</p>' : '';
    return `<div class="staff-rack" data-staff-rack><span class="staff-kicker">${escapeHtml(kicker)}</span>${picks}</div>${note}`;
  }

  /** Character skins, Wizard Sproto first; locked ones show the boss that unlocks them. */
  private characterRackHtml(): string {
    const view = this.h.characterRack?.();
    if (!view) return '';
    const picks = view.skins.map((s) => {
      const on = s.id === view.selected;
      return `<button type="button" class="staff-pick char-pick${on ? ' equipped' : ''}${s.locked ? ' locked' : ''}" data-skin="${escapeHtml(s.id)}" style="--accent:${s.accent};--bolt:${s.locked ? '#4a4366' : s.accent}" aria-pressed="${on}"${s.locked ? ' aria-disabled="true"' : ''}>
        <i class="staff-orb" aria-hidden="true"></i><span class="staff-copy"><b>${escapeHtml(s.name)}</b><small>${escapeHtml(s.line)}</small></span></button>`;
    }).join('');
    return `<div class="staff-rack char-rack" data-char-rack><span class="staff-kicker">Character</span>${picks}</div>`;
  }

  private bindCharacter(root: ParentNode): void {
    root.querySelectorAll<HTMLButtonElement>('[data-skin]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.h.selectCharacter?.(btn.dataset.skin ?? '');
        this.paintCharacter(root);
      });
    });
  }

  private paintCharacter(root: ParentNode): void {
    const view = this.h.characterRack?.();
    if (!view) return;
    root.querySelectorAll<HTMLButtonElement>('[data-skin]').forEach((btn) => {
      const on = btn.dataset.skin === view.selected;
      btn.classList.toggle('equipped', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  private bindStaff(root: ParentNode): void {
    root.querySelectorAll<HTMLButtonElement>('[data-staff]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.h.selectStaff(btn.dataset.staff ?? '');
        this.paintStaff(root);
      });
    });
  }

  private paintStaff(root: ParentNode): void {
    const view = this.h.staffRack();
    root.querySelectorAll<HTMLButtonElement>('[data-staff]').forEach((btn) => {
      const on = btn.dataset.staff === view.selected;
      btn.classList.toggle('equipped', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  private staffName(): string {
    const view = this.h.staffRack();
    return view.owned.find((s) => s.id === view.selected)?.name ?? 'Sproto Staff';
  }

  get visible(): boolean {
    return this.screen !== null;
  }

  /** The "Click to resume" overlay is up (waiting for pointer lock). */
  get awaitingClick(): boolean {
    return !!this.screen?.classList.contains('click');
  }

  /** Which screen is showing ('main', 'boss', 'results', 'complete', ...), or null. */
  /** A setting the app changed itself (not through a menu): the menus' copy and the save follow. */
  updateSettings(patch: Partial<Settings>): void {
    Object.assign(this.settings, patch);
    saveSettings(this.settings);
    this.h.settingsChanged(this.settings);
  }

  get current(): string | null {
    return this.screen?.classList[1] ?? null;
  }

  /**
   * Esc on a menu: press the screen's Back (or Cancel, Keep Fighting...: the same control as the
   * pad's B). False when the screen has none (main menu, results), so Esc there does nothing.
   */
  back(): boolean {
    const el = this.screen?.querySelector<HTMLElement>(MENU_BACK);
    if (!el || (el as HTMLButtonElement).disabled) return false;
    el.click();
    return true;
  }

  /** Short notice at the top of the screen, over menus and the HUD alike (e.g. "God Mode On"). */
  toast(text: string, sub = '', style = ''): void {
    const el = this.toastEl;
    el.innerHTML = `<b></b>${sub ? '<small></small>' : ''}`;
    el.querySelector('b')!.textContent = text;
    if (sub) el.querySelector('small')!.textContent = sub;
    el.className = `toast ${style}`;
    void el.offsetWidth; // restart the animation
    el.classList.add('show');
  }

  /** Keep the Settings checkbox in step when god mode is toggled elsewhere (F9, "99"). */
  syncGodMode(on: boolean): void {
    const box = this.root.querySelector<HTMLInputElement>('input[data-god]');
    if (box) box.checked = on;
  }

  hide(): void {
    this.endCapture();
    this.root.innerHTML = '';
    this.screen = null;
    this.root.classList.remove('open');
    this.root.parentElement?.classList.remove('menu-open');
  }

  private mount(html: string, cls: string): HTMLElement {
    this.endCapture();
    this.bossIntro = null;
    this.root.innerHTML = `<div class="menu-screen ${cls}">${html}</div>`;
    this.root.classList.add('open');
    // The HUD steps aside behind every menu (pause, its settings...), except the click-to-resume hint.
    this.root.parentElement?.classList.toggle('menu-open', cls !== 'click');
    this.screen = this.root.firstElementChild as HTMLElement;
    return this.screen;
  }

  private on(el: ParentNode, sel: string, fn: (e: Event) => void): void {
    el.querySelectorAll(sel).forEach((n) => n.addEventListener('click', fn));
  }

  // ------------------------------------------------------------------ Standard options

  /**
   * The top-right bar every menu screen carries: Main Menu, Hub and Controller Settings where
   * `o` asks for them, and Full Screen. `extra` goes at its end (the main menu's Ticket chip).
   */
  private sysBarHtml(o: SysOptions, extra = ''): string {
    const fs = fullscreenSupported()
      ? `<button type="button" class="sys-btn" data-sys="fullscreen" aria-pressed="${isFullscreen()}">Full Screen<small data-fs-state>${isFullscreen() ? 'On' : 'Off'}</small></button>`
      : '';
    return `<nav class="sys-bar" aria-label="Game options">
      ${o.main ? '<button type="button" class="sys-btn" data-sys="main">Main Menu</button>' : ''}
      ${o.hub ? '<button type="button" class="sys-btn" data-sys="hub">Hub</button>' : ''}
      ${o.controls !== false ? '<button type="button" class="sys-btn" data-sys="controls">Controller Settings</button>' : ''}
      ${fs}${extra}</nav>`;
  }

  /** Add the bar to screen `s` (after its panel, so a pad starts on the panel) and wire it. */
  private sysBar(s: HTMLElement, o: SysOptions, extra = ''): void {
    s.insertAdjacentHTML('beforeend', this.sysBarHtml(o, extra));
    this.bindSys(s, o);
  }

  private bindSys(s: HTMLElement, o: SysOptions): void {
    this.on(s, '[data-sys="main"]', () => this.goMain(o.reopen));
    this.on(s, '[data-sys="hub"]', () => this.goHub(o.reopen));
    this.on(s, '[data-sys="controls"]', () => this.showControls({ main: true, hub: true, ...o, controls: false }));
    s.querySelectorAll<HTMLButtonElement>('[data-sys="fullscreen"]').forEach((btn) => {
      // The request runs inside this click (or the key that pressed it): browsers need the gesture.
      btn.addEventListener('click', () => {
        void toggleFullscreen().then((ok) => {
          if (!ok) this.toast('Full screen unavailable', 'Click the button, or press F11');
          this.paintFullscreen();
        });
      });
    });
  }

  /** Full Screen buttons say whether the page is in full screen now. */
  private paintFullscreen(): void {
    const on = isFullscreen();
    this.root.querySelectorAll<HTMLButtonElement>('[data-sys="fullscreen"]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(on));
      const state = btn.querySelector('[data-fs-state]');
      if (state) state.textContent = on ? 'On' : 'Off';
    });
  }

  /** Main Menu from any screen: a fight in progress asks first. */
  private goMain(reopen: () => void): void {
    const fight = this.h.inFight?.() ?? null;
    if (fight) this.showExitConfirm(reopen, 'menu', fight === 'online');
    else this.h.quit();
  }

  /** Hub from any screen: a fight in progress asks first. */
  private goHub(reopen: () => void): void {
    const fight = this.h.inFight?.() ?? null;
    if (fight) this.showExitConfirm(reopen, 'hub', fight === 'online');
    else this.leaveForHub();
  }

  private leaveForHub(): void {
    if (this.h.toHub) this.h.toHub();
    else this.h.exitHub();
  }

  // ------------------------------------------------------------------ Controller settings

  /** A press-to-bind is waiting for a key or button. */
  get capturing(): boolean {
    return this.capture !== null;
  }

  /**
   * Controller Settings: every action's keys and pad button, press-to-bind remapping (Esc / B
   * cancels, a key or button already in use swaps), vibration, the left-stick dead zone and
   * Reset to Defaults. Changes apply at once and are saved (src/input/controlPrefs.ts).
   * `o.reopen` is Back.
   */
  showControls(o: SysOptions): void {
    const keySlot = (a: KeyAction, slot: number) =>
      `<button type="button" class="bind" data-bind="key" data-action="${a}" data-slot="${slot}"${a === 'pause' && slot === 0 ? ' disabled' : ''}></button>`;
    const padSlot = (a: PadAction) => `<button type="button" class="bind pad" data-bind="pad" data-action="${a}" data-slot="0"></button>`;
    const fixed = (t: string) => `<span class="bind-fixed">${t}</span>`;
    const row = (label: string, keys: string, pad: string) => `<div class="bind-row"><span class="bind-label">${label}</span>${keys}${pad}</div>`;
    const action = (a: KeyAction, note = '') =>
      row(`${ACTION_LABELS[a]}${note ? `<small>${note}</small>` : ''}`, `${keySlot(a, 0)}${keySlot(a, 1)}`, (PAD_ACTION_SET.has(a) ? padSlot(a as PadAction) : fixed('Left stick')));
    const head = `<div class="bind-row bind-head"><span>Action</span><span>Key</span><span>Alt key</span><span>Controller</span></div>`;
    const colA = [
      action('forward'), action('back'), action('left'), action('right'),
      row('Look / aim', fixed('Mouse') + fixed(''), fixed('Right stick')),
      action('sprint'), action('jump'), action('dodge'),
      action('bolt', 'and left click'), action('blast', 'and right click'),
    ].join('');
    const colB = [
      action('shield'), action('stun'), action('ultimate'),
      action('carpet'), action('pump'), action('vape'), action('lockon'), action('breath'),
      action('pause'),
      row('Menus', fixed('Arrows, Enter') + fixed('Esc back'), fixed(`D-pad, ${padGlyph('a', this.padStyle)} / ${padGlyph('b', this.padStyle)}`)),
    ].join('');
    const dz = this.controls.moveDeadzone;
    const s = this.mount(`
      <div class="menu-panel controls-panel">
        <h2>Controller Settings</h2>
        <p class="note bind-note" data-bind-note role="status"></p>
        <div class="bind-list">
          <div class="bind-col">${head}${colA}</div>
          <div class="bind-col">${head}${colB}</div>
        </div>
        <div class="controls-options">
          <label class="setting toggle"><span>Vibration</span><input type="checkbox" data-rumble ${this.settings.rumble ? 'checked' : ''}><i></i></label>
          <label class="setting"><span>Left stick dead zone</span>
            <input type="range" min="${DEADZONE_MIN}" max="${DEADZONE_MAX}" step="0.01" value="${dz}" data-deadzone>
            <output>${dz.toFixed(2)}</output></label>
        </div>
        <div class="menu-actions row">
          <button class="ghost" data-act="reset-controls">Reset to Defaults</button>
          <button class="primary" data-act="back">Back</button>
        </div>
      </div>`, 'controller');
    // Keep Fighting on a Main Menu / Hub check comes back here; Back goes to where this was opened.
    this.sysBar(s, { ...o, controls: false, reopen: () => this.showControls(o) });
    this.paintBinds();
    this.setBindNote(DEFAULT_BIND_NOTE);
    s.querySelectorAll<HTMLButtonElement>('[data-bind]').forEach((btn) => btn.addEventListener('click', () => this.startCapture(btn)));
    const rumble = s.querySelector<HTMLInputElement>('[data-rumble]')!;
    rumble.addEventListener('input', () => {
      this.settings.rumble = rumble.checked;
      this.h.settingsChanged({ ...this.settings });
    });
    const dzInput = s.querySelector<HTMLInputElement>('[data-deadzone]')!;
    dzInput.addEventListener('input', () => {
      const v = Number(dzInput.value);
      dzInput.parentElement!.querySelector('output')!.textContent = v.toFixed(2);
      this.commitControls({ ...this.controls, moveDeadzone: v });
    });
    this.on(s, '[data-act="reset-controls"]', () => {
      this.commitControls(defaultControlPrefs());
      this.settings.rumble = CONFIG.gamepad.rumble.enabled;
      this.h.settingsChanged({ ...this.settings });
      rumble.checked = this.settings.rumble;
      dzInput.value = String(this.controls.moveDeadzone);
      dzInput.parentElement!.querySelector('output')!.textContent = this.controls.moveDeadzone.toFixed(2);
      this.paintBinds();
      this.setBindNote('Back to the default layout.');
    });
    this.on(s, '[data-act="back"]', () => o.reopen());
  }

  /** Save, apply (input layer) and announce a new layout. */
  private commitControls(next: ControlPrefs): void {
    this.controls = next;
    saveControlPrefs(next);
    applyControlPrefs(next);
    this.h.controlsChanged?.();
  }

  /** Write every slot's key or button name. */
  private paintBinds(): void {
    this.screen?.querySelectorAll<HTMLButtonElement>('[data-bind]').forEach((btn) => {
      if (this.capture?.btn === btn) return;
      const a = btn.dataset.action!;
      const slot = Number(btn.dataset.slot);
      const label = ACTION_LABELS[a as KeyAction];
      if (btn.dataset.bind === 'key') {
        const code = this.controls.keys[a as KeyAction][slot] ?? '';
        btn.textContent = code ? keyLabel(code) : '—';
        btn.classList.toggle('empty', !code);
        btn.setAttribute('aria-label', `${label}, ${slot ? 'alternate key' : 'key'}: ${code ? keyLabel(code) : 'none'}`);
      } else {
        const names = this.controls.pad[a as PadAction].map((b) => padGlyph(b, this.padStyle)).join(' / ');
        btn.textContent = names || '—';
        btn.classList.toggle('empty', !names);
        btn.setAttribute('aria-label', `${label}, controller: ${names || 'none'}`);
      }
      btn.classList.remove('capturing');
    });
  }

  private setBindNote(text: string, warn = false): void {
    const el = this.screen?.querySelector<HTMLElement>('[data-bind-note]');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('warn', warn);
  }

  private startCapture(btn: HTMLButtonElement): void {
    this.endCapture();
    const kind = btn.dataset.bind === 'pad' ? 'pad' : 'key';
    const action = btn.dataset.action ?? '';
    const slot = Number(btn.dataset.slot) || 0;
    this.capture = { kind, action, slot, btn };
    btn.classList.add('capturing');
    btn.textContent = kind === 'key' ? 'Press a key' : 'Press a button';
    const label = ACTION_LABELS[action as KeyAction];
    this.setBindNote(kind === 'key'
      ? `Press a key for ${label}. Esc or ${padGlyph('b', this.padStyle)} cancels${slot ? ', Backspace clears it' : ''}.`
      : `Press a controller button for ${label}. ${padGlyph('b', this.padStyle)} or Esc cancels.`);
    this.nav.capture = (b) => this.onCapturePad(b);
  }

  /** Stop listening without a message (a new screen, the menus closing). */
  private endCapture(): void {
    this.capture = null;
    this.nav.capture = null;
  }

  private cancelCapture(): void {
    if (!this.capture) return;
    this.endCapture();
    this.paintBinds();
    this.setBindNote('Cancelled. ' + DEFAULT_BIND_NOTE);
  }

  private onCaptureKey(e: KeyboardEvent): void {
    const c = this.capture;
    if (!c) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    if (e.code === 'Escape') return this.cancelCapture();
    if (c.kind === 'pad') {
      this.setBindNote(`Press a controller button for ${ACTION_LABELS[c.action as PadAction]}. Esc cancels.`);
      return;
    }
    const action = c.action as KeyAction;
    const result = e.code === 'Backspace' || e.code === 'Delete'
      ? clearKey(this.controls, action, c.slot)
      : bindKey(this.controls, action, c.slot, e.code);
    this.finishCapture(result, keyLabel(e.code));
  }

  private onCapturePad(b: PadButton): void {
    const c = this.capture;
    if (!c) return;
    if (b === 'b') return this.cancelCapture();
    if (c.kind === 'key') return;
    this.finishCapture(bindPad(this.controls, c.action as PadAction, b), padGlyph(b, this.padStyle));
  }

  private finishCapture(result: BindResult, name: string): void {
    const c = this.capture!;
    const btn = c.btn;
    this.endCapture();
    if (!result.ok) {
      this.paintBinds();
      this.setBindNote(result.reason, true);
      btn.focus({ preventScroll: true });
      return;
    }
    this.commitControls(result.prefs);
    this.paintBinds();
    const label = ACTION_LABELS[c.action as KeyAction];
    const other = result.swapped;
    let note = `${label}: ${name}.`;
    if (other) {
      const now = c.kind === 'key'
        ? this.controls.keys[other as KeyAction].filter(Boolean).map(keyLabel).join(' / ')
        : this.controls.pad[other as PadAction].map((x) => padGlyph(x, this.padStyle)).join(' / ');
      note += ` Swapped: ${ACTION_LABELS[other]} is now ${now || 'unbound'}.`;
    }
    this.setBindNote(note);
    btn.focus({ preventScroll: true });
  }

  showMain(): void {
    const g = this.h.gauntletStatus();
    const practiceDone = this.h.practiceDone?.() ?? false;
    const cont = g.canContinue && g.next
      ? `<button class="gauntlet-btn continue" data-act="continue" style="${bossStyleVars(g.next)}">
           <b>Continue</b><small>Fight ${g.nextIndex + 1} of ${BOSSES.length} · ${bossDisplayName(g.next)}</small>
         </button>`
      : '';
    // A heading only labels the Continue / New Gauntlet pair: it never repeats a button's own title.
    const s = this.mount(`
      <div class="menu-panel main">
        <h1 class="title">Sproto<span>Duel</span></h1>
        <p class="tagline">Staffs up. One life against each boss.</p>
        <div class="mode-block gauntlet-block">
          ${g.canContinue ? '<h3>Boss Gauntlet</h3>' : ''}
          <div class="row">
            ${cont}
            <button class="gauntlet-btn" data-act="gauntlet">
              <b>${g.canContinue ? 'New Gauntlet' : 'Boss Gauntlet'}</b><small>${g.canContinue ? 'Start again at fight 1' : `${BOSSES.length} bosses, one life each${g.clears ? ` · cleared ×${g.clears}` : ''}`}</small>
            </button>
          </div>
        </div>
        <div class="mode-block">
          <button class="primary quick-duel" data-act="start">Quick Duel<small data-quick-line></small></button>
          ${this.difficultyHtml()}
          ${this.h.versus ? '<button class="ghost versus-btn" data-act="versus">Local Versus<small>Two players, one screen</small></button>' : ''}
          ${this.onlineButtonHtml()}
        </div>
        <div class="row help-row">
          ${this.h.practice ? `<button class="ghost practice-btn${practiceDone ? '' : ' suggest'}" data-act="practice">Practice${practiceDone ? '' : '<small>New here? Start with this</small>'}</button>` : ''}
          <button class="ghost" data-act="howto">How to Play</button>
          <button class="ghost" data-act="settings">Settings</button>
        </div>
        ${this.characterRackHtml()}
        ${this.staffRackHtml(false)}
        <div class="row">
          <button class="ghost" data-act="exchange">Exchange<small>${CONFIG.hub.ticketsPerVerse} Tickets = 1 Verse</small></button>
        </div>
        <p class="tip">Tip: raise your Shield just as a spell arrives to send it back.</p>
      </div>
      <div class="title-slot" data-title-slot></div>`, 'main');
    // Hub leaves at once from here (nothing to lose); it sits with the other standard options.
    this.sysBar(s, { hub: true, reopen: () => this.showMain() }, '<div class="ticket-chip" data-ticket-chip role="status"><span>Tickets</span><b></b></div>');
    this.on(s, '[data-act="start"]', () => this.h.start());
    this.paintTicketChip(s);
    this.on(s, '[data-act="practice"]', () => this.h.practice?.());
    this.on(s, '[data-act="versus"]', () => this.h.versus?.());
    this.on(s, '[data-act="online"]', () => this.h.openOnline?.());
    this.on(s, '[data-act="gauntlet"]', () => this.h.gauntlet());
    this.on(s, '[data-act="continue"]', () => this.h.continueGauntlet());
    this.on(s, '[data-act="howto"]', () => this.showHowTo(() => this.showMain()));
    this.on(s, '[data-act="settings"]', () => this.showSettings(() => this.showMain()));
    this.on(s, '[data-act="exchange"]', () => this.showExchange());
    this.bindCharacter(s);
    this.bindStaff(s);
    this.bindDifficulty(s);
    this.h.titleStage?.(s.querySelector<HTMLElement>('[data-title-slot]')!);
  }

  /** Quick Duel's rival: Apprentice, Adept or Archmage (CONFIG.ai.difficulty), remembered in Settings. */
  private difficultyHtml(): string {
    const picks = DIFFICULTY_ORDER.map((d) => {
      const on = d === this.settings.quickDifficulty;
      return `<button type="button" class="diff-pick${on ? ' on' : ''}" data-difficulty="${d}" role="radio" aria-checked="${on}" title="${escapeHtml(DIFFICULTY_BLURB[d])}">${escapeHtml(CONFIG.ai.difficulty[d].label)}</button>`;
    }).join('');
    return `<div class="difficulty-pick" role="radiogroup" aria-label="Quick Duel rival">${picks}</div>`;
  }

  private bindDifficulty(root: ParentNode): void {
    const paint = () => {
      const d = this.settings.quickDifficulty;
      root.querySelectorAll<HTMLButtonElement>('[data-difficulty]').forEach((btn) => {
        const on = btn.dataset.difficulty === d;
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      const line = root.querySelector('[data-quick-line]');
      if (line) line.textContent = `Best of three against the ${CONFIG.ai.difficulty[d].label}: ${DIFFICULTY_BLURB[d]}`;
    };
    root.querySelectorAll<HTMLButtonElement>('[data-difficulty]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const d = btn.dataset.difficulty as Difficulty;
        if (!DIFFICULTY_ORDER.includes(d)) return;
        this.settings.quickDifficulty = d;
        saveSettings(this.settings);
        this.h.settingsChanged(this.settings);
        paint();
      });
    });
    paint();
  }

  private onlineButtonHtml(): string {
    const o = this.h.online?.();
    if (!o) return '';
    return `<button class="ghost online-btn" data-act="online"${o.enabled ? '' : ' disabled'}>Online Duel<small>${escapeHtml(o.why)}</small></button>`;
  }

  /** The always-visible Ticket chip: the balance now, then again once a fresh read lands. */
  private paintTicketChip(s: HTMLElement): void {
    const chip = s.querySelector<HTMLElement>('[data-ticket-chip]');
    if (!chip) return;
    const paint = () => {
      const status = this.h.hubStatus();
      chip.querySelector('b')!.textContent = ticketChipText(status);
      chip.title = ticketChipLabel(status);
      chip.setAttribute('aria-label', chip.title);
      chip.classList.toggle('linked', status.connected);
    };
    paint();
    void this.h.refreshTickets?.().then(() => {
      if (chip.isConnected) paint();
    });
  }

  /**
   * Local Versus join screen: P1 is already in (keyboard + mouse, plus a pad when there are two);
   * P2 joins by pressing A on a controller (App polls the pads and calls updateVersusJoin). Then
   * either player starts. Needs one controller at least.
   */
  showVersusJoin(view: VersusJoinView, h: { start(): void; back(): void }): void {
    const s = this.mount(`
      <div class="menu-panel versus-join">
        <h2>Local Versus</h2>
        <p class="note">Two players, one screen, best of three. No reward spells, life packs or god mode, and nothing is reported to the hub.</p>
        <div class="join-seats">
          <div class="join-seat ready" data-seat="1"><b>Player 1</b><span class="join-dev"></span></div>
          <div class="join-seat" data-seat="2"><b>Player 2</b><span class="join-dev"></span></div>
        </div>
        <p class="join-hint"></p>
        <div class="menu-actions">
          <button class="primary" data-act="start" disabled>Fight</button>
          <button data-act="back" data-back>Back</button>
        </div>
      </div>`, 'versus-join');
    this.sysBar(s, { main: true, hub: true, reopen: () => this.showVersusJoin(view, h) });
    this.on(s, '[data-act="start"]', () => h.start());
    this.on(s, '[data-act="back"]', () => h.back());
    this.updateVersusJoin(view);
  }

  updateVersusJoin(view: VersusJoinView): void {
    const s = this.screen;
    if (!s?.classList.contains('versus-join')) return;
    s.querySelector('[data-seat="1"] .join-dev')!.textContent = view.p1;
    const p2 = s.querySelector('[data-seat="2"]')!;
    p2.classList.toggle('ready', view.p2 !== null);
    // Controller 1 is P1's when there are two or more, so P2 joins with another one.
    const waiting = view.pads >= 2 ? 'Press A on Controller 2' : view.pads ? 'Press A on a controller' : 'Connect a controller, then press A';
    p2.querySelector('.join-dev')!.textContent = view.p2 ?? waiting;
    s.querySelector<HTMLButtonElement>('[data-act="start"]')!.disabled = view.p2 === null;
    s.querySelector('.join-hint')!.textContent = view.p2 === null
      ? 'Player 2 plays with a controller. Player 1 keeps keyboard + mouse (and Controller 1, when there are two). B goes back.'
      : 'Press A again (or Fight) to start, B to unjoin Player 2. Start pauses from either side.';
  }

  /** Tickets to Verse. The rate is fixed; the daily cap is enforced by the hub. */
  showExchange(): void {
    const rate = CONFIG.hub.ticketsPerVerse;
    const cap = CONFIG.hub.verseDailyCap;
    const s = this.mount(`
      <div class="menu-panel exchange">
        <h2>Exchange</h2>
        <p class="note">Spend Tickets for Verse. ${rate} Tickets = 1 Verse, and this game can grant at most ${cap} Verse a day. The hub enforces the cap.</p>
        <p class="note hub-balance"></p>
        <label class="setting"><span>Verse</span>
          <input type="range" min="1" max="${cap}" step="1" value="1" data-verse data-autofocus>
          <output>1</output></label>
        <p class="note exchange-cost"></p>
        <p class="exchange-result" role="status"></p>
        <div class="menu-actions">
          <button class="primary" data-act="confirm">Exchange</button>
          <button data-act="back" data-back>Back</button>
        </div>
      </div>`, 'exchange');
    this.sysBar(s, { main: true, hub: true, reopen: () => this.showExchange() });
    const balance = s.querySelector('.hub-balance')!;
    const cost = s.querySelector('.exchange-cost')!;
    const result = s.querySelector('.exchange-result')!;
    const slider = s.querySelector<HTMLInputElement>('[data-verse]')!;
    const output = s.querySelector('output')!;
    const paintStatus = () => {
      const now = this.h.hubStatus();
      if (now.error) balance.textContent = now.error;
      else if (!now.connected) balance.textContent = 'Not linked to the hub. Enter Sproto Duel from a portal to exchange.';
      else if (now.balance === null) {
        const left = now.ticketsCapLeft === null ? '' : ` Tickets still earnable today: ${now.ticketsCapLeft}.`;
        balance.textContent = `Linked to the hub.${left} Your Ticket balance shows after a win or an exchange.`;
      } else {
        balance.textContent = `Tickets: ${now.balance}`;
      }
    };
    const paintCost = () => {
      const verse = Number(slider.value);
      output.textContent = String(verse);
      cost.textContent = `${verse * rate} Tickets = ${verse} Verse`;
    };
    paintStatus();
    paintCost();
    slider.addEventListener('input', paintCost);
    this.on(s, '[data-act="back"]', () => this.showMain());
    this.on(s, '[data-act="confirm"]', () => {
      const button = s.querySelector<HTMLButtonElement>('[data-act="confirm"]')!;
      const tickets = Number(slider.value) * rate;
      button.disabled = true;
      result.className = 'exchange-result';
      result.textContent = 'Exchanging…';
      void this.h.exchangeTickets(tickets).then((view) => {
        button.disabled = false;
        paintStatus();
        if (view.ok) {
          result.className = 'exchange-result ok';
          result.textContent = `Received ${view.verse} Verse. Tickets left: ${view.ticketsLeft}. Receipt ${view.receiptId}.`;
        } else {
          result.className = 'exchange-result err';
          result.textContent = view.message;
        }
      });
    });
  }

  showHowTo(back: () => void): void {
    const s = this.mount(`
      <div class="menu-panel howto">
        <h2>How to Play</h2>
        <div class="control-cols">
          <div><h3>Keyboard &amp; Mouse</h3><div class="controls">${keyboardControls().map(([k, v]) => `<kbd>${k}</kbd><span>${v}</span>`).join('')}</div></div>
          <div><h3>Controller</h3><div class="controls">${padControls(this.padStyle).map(([k, v]) => `<kbd>${k}</kbd><span>${v}</span>`).join('')}</div></div>
        </div>

        <ul class="tips">
          <li>Spells that collide mid-air clash. The bigger spell survives, weakened.</li>
          <li>A Shield raised in the last instant reflects the spell back, faster and stronger.</li>
          <li>Roll through the Ultimate's wave, or hide behind a pillar. Pillars crumble.</li>
          <li>The ring of fire burns. When time runs low, it closes in.</li>
          <li>Deal damage to charge your Ultimate. It carries over between rounds.</li>
          <li>Boss Gauntlet: one life per boss. Each boss stage has its own health bar; empty it and the boss transforms. Grab the life packs (three per fight).</li>
          <li>New to this? Practice on the main menu teaches mana, Blast, the roll, the Shield and Golden Tickets against a training dummy.</li>
          <li>Checkpoints: fall in a boss's second or third stage and that stage starts over once, with a life pack back. Fall again in the same stage and the fight is lost.</li>
          <li>Every boss you beat teaches you its spell for good, in every later fight and in Quick Duel.</li>
        </ul>
        <h3 class="reward-head">Boss spells</h3>
        <ul class="reward-list">${this.rewardRows()}</ul>
        <div class="menu-actions"><button class="primary" data-act="back">Back</button></div>
      </div>`, 'howto');
    this.sysBar(s, { main: true, hub: true, reopen: () => this.showHowTo(back) });
    this.on(s, '[data-act="back"]', back);
  }

  /** How to Play's boss spell list: icon, name, keys, what it does, and whether you know it yet. */
  private rewardRows(): string {
    const learned = this.h.learnedSpells();
    return REWARD_SPELLS.map((id) => {
      const info = REWARD_SPELL_INFO[id];
      const b = teacher(id);
      const status = learned.has(id) ? '<em class="learned">Learned</em>' : `<em>Beat ${bossDisplayName(b)}</em>`;
      return `<li class="${learned.has(id) ? 'learned' : 'locked'}" style="--accent:${info.color}">
        <span class="reward-icon">${rewardIcon(id)}</span>
        <span class="reward-text"><b>${info.name}</b><kbd>${rewardKeys(id, this.padStyle)}</kbd>${status}<small>${info.short}</small></span></li>`;
    }).join('');
  }

  showSettings(back: () => void): void {
    const st = this.settings;
    const slider = (key: keyof Settings, label: string, min: number, max: number, step: number) => `
      <label class="setting"><span>${label}</span>
        <input type="range" min="${min}" max="${max}" step="${step}" value="${st[key]}" data-key="${key}">
        <output>${Number(st[key]).toFixed(step < 1 ? 2 : 0)}</output></label>`;
    const toggle = (key: keyof Settings, label: string) => `
      <label class="setting toggle"><span>${label}</span><input type="checkbox" data-key="${key}" ${st[key] ? 'checked' : ''}><i></i></label>`;
    const known = this.h.savedSpells().size;
    // Two columns: mouse, display and sound on the left; controller, progress and testing on the right.
    const s = this.mount(`
      <div class="menu-panel settings">
        <h2>Settings</h2>
        <div class="settings-cols">
          <div class="settings-col">
            <h3>Mouse &amp; Display</h3>
            ${slider('sensitivity', 'Mouse sensitivity', 0.3, 2.5, 0.05)}
            ${toggle('invertY', 'Invert Y')}
            ${toggle('bloom', 'Bloom (glow)')}
            ${toggle('shadows', 'Shadows')}
            <h3>Sound</h3>
            ${slider('master', 'Master volume', 0, 1, 0.05)}
            ${slider('music', 'Music', 0, 1, 0.05)}
            ${slider('sfx', 'Effects', 0, 1, 0.05)}
          </div>
          <div class="settings-col">
            <h3>Controller</h3>
            ${slider('padSensitivity', 'Look sensitivity', 0.3, 2.5, 0.05)}
            ${toggle('padInvertY', 'Invert Y (controller)')}
            ${slider('aimAssist', 'Aim assist', 0, 1.5, 0.05)}
            ${toggle('rumble', 'Vibration')}
            <h3>Progress &amp; Testing</h3>
            <div class="setting forget-setting"><span>Boss spells<small>${known ? `${known} of ${REWARD_SPELLS.length} learned` : 'None learned yet'}</small></span>
              <button class="ghost small" data-act="forget" ${known ? '' : 'disabled'}>Forget learned spells</button></div>
            <label class="setting toggle god-setting"><span>God mode (testing)<small>No damage, unlimited mana, no cooldowns, all boss spells, ${CONFIG.debug.godPowerMultiplier}× damage · 99 or ${CONFIG.debug.godHotkey} · resets on reload</small></span>
              <input type="checkbox" data-god ${this.h.godMode() ? 'checked' : ''}><i></i></label>
          </div>
        </div>
        <div class="menu-actions"><button class="primary" data-act="back">Back</button></div>
      </div>`, 'settings');
    this.sysBar(s, { main: true, hub: true, reopen: () => this.showSettings(back) });
    const god = s.querySelector<HTMLInputElement>('input[data-god]')!;
    god.addEventListener('input', () => this.h.setGodMode(god.checked));
    // Forgetting is permanent: the first press asks, a second within 4 s confirms.
    const forget = s.querySelector<HTMLButtonElement>('[data-act="forget"]')!;
    let armed = -1e9;
    forget.addEventListener('click', () => {
      if (performance.now() - armed > 4000) {
        armed = performance.now();
        forget.textContent = 'Press again to forget';
        forget.classList.add('armed');
        return;
      }
      this.h.forgetSpells();
      forget.textContent = 'Forgotten';
      forget.disabled = true;
      forget.classList.remove('armed');
      const note = forget.parentElement!.querySelector('small');
      if (note) note.textContent = 'None learned yet';
    });
    s.querySelectorAll<HTMLInputElement>('input[data-key]').forEach((input) => {
      input.addEventListener('input', () => {
        const key = input.dataset.key as keyof Settings;
        const value = input.type === 'checkbox' ? input.checked : Number(input.value);
        (this.settings as unknown as Record<string, unknown>)[key] = value;
        const out = input.parentElement!.querySelector('output');
        if (out) out.textContent = Number(value).toFixed(Number(input.step) < 1 ? 2 : 0);
        this.h.settingsChanged({ ...this.settings });
      });
    });
    this.on(s, '[data-act="back"]', back);
  }

  /**
   * `subtitle`: e.g. the boss being fought in the gauntlet; `stages`: each boss's current stage (two
   * in a double fight); `restartLabel`: "Restart Fight" in a boss fight.
   */
  showPause(subtitle = '', stages: StageInfo[] = [], restartLabel = 'Restart Match'): void {
    const line = (st: StageInfo) => {
      const pips = Array.from({ length: STAGE_COUNT }, (_, i) => `<i class="${i < st.index ? 'done' : i === st.index ? 'on' : ''}"></i>`).join('');
      const who = st.who ? `${escapeHtml(st.who)}: ` : '';
      return `<p class="pause-stage${st.down ? ' down' : ''}"><span class="stage-pips">${pips}</span>${who}Stage ${st.index + 1} of ${STAGE_COUNT} · ${escapeHtml(st.name)}${st.down ? ' (down)' : ''}</p>`;
    };
    const s = this.mount(`
      <div class="menu-panel pause">
        <h2>Paused</h2>
        ${subtitle ? `<p class="note pause-sub">${escapeHtml(subtitle)}</p>` : ''}
        ${stages.map(line).join('')}
        <p class="note staff-lock">Staff: ${escapeHtml(this.staffName())} · change it before the next fight</p>
        <button class="primary" data-act="resume">Resume</button>
        <button data-act="restart">${restartLabel}</button>
        <button data-act="howto">How to Play</button>
        <button data-act="settings">Settings</button>
        <button data-act="feedback">Send Feedback</button>
        <button class="ghost" data-act="quit" data-sys-main>Main Menu</button>
        <button class="ghost" data-act="exit" data-sys-hub>Return to Hub</button>
      </div>`, 'pause');
    const reopen = () => this.showPause(subtitle, stages, restartLabel);
    this.sysBar(s, { reopen });
    this.on(s, '[data-act="resume"]', () => this.h.resume());
    this.on(s, '[data-act="restart"]', () => this.h.restart());
    this.on(s, '[data-act="howto"]', () => this.showHowTo(reopen));
    this.on(s, '[data-act="settings"]', () => this.showSettings(reopen));
    this.on(s, '[data-act="feedback"]', () => this.h.feedback?.());
    // Leaving mid-fight asks first, like Return to Hub.
    this.on(s, '[data-act="quit"]', () => this.showExitConfirm(reopen, 'menu'));
    this.on(s, '[data-act="exit"]', () => this.showExitConfirm(reopen));
  }

  /**
   * Return to Hub or Main Menu mid-fight asks first: leaving ends this fight with no result (the
   * main menu's Return to Hub leaves at once). Online, leaving is a forfeit.
   */
  showExitConfirm(back: () => void, to: 'hub' | 'menu' = 'hub', online = false): void {
    const where = to === 'hub' ? 'the Hub' : 'the Main Menu';
    const note = online
      ? 'Leaving counts as a forfeit: the match is lost. 0 Tickets either way.'
      : 'This fight ends here and counts for nothing. Saved gauntlet progress, learned spells and your staff are kept.';
    const s = this.mount(`
      <div class="menu-panel pause exit-confirm">
        <h2>${to === 'hub' ? 'Return to Hub?' : 'Quit to Main Menu?'}</h2>
        <p class="note">${note}</p>
        <button class="primary" data-act="stay" data-back data-autofocus>Keep Fighting</button>
        <button class="ghost" data-act="leave">${online ? 'Forfeit and Leave' : `Leave for ${where}`}</button>
      </div>`, 'exit-confirm');
    this.on(s, '[data-act="stay"]', back);
    this.on(s, '[data-act="leave"]', () => (to === 'hub' ? this.leaveForHub() : this.h.quit()));
  }

  /** The five-step gauntlet ladder: cleared, current and locked fights. */
  private ladderHtml(current: number, cleared: number): string {
    return `<ol class="boss-ladder">${BOSSES.map((b, i) => {
      const state = i < cleared ? 'cleared' : i === current ? 'current' : 'locked';
      return `<li class="${state}" style="${bossStyleVars(b)}" title="${i < cleared || i === current ? bossDisplayName(b) : '???'}"><span>${i < cleared ? '✓' : i + 1}</span></li>`;
    }).join('')}</ol>`;
  }

  /** A boss's three stages: concept art (or a numeral), name, and what each one unlocks. */
  private stagesHtml(b: BossFighter, cls = '', style = ''): string {
    return `<ol class="boss-stages${cls}"${style ? ` style="${style}"` : ''}>${b.stages.map((st, i) => {
      const art = resolveImage(bossStagePortrait(b.id, i));
      return `<li><div class="stage-art">${art ? `<img src="${art}" alt="${st.name}" draggable="false">` : NUMERALS[i]}</div>
        <b><i>${NUMERALS[i]}</i>${st.name}</b><small>${stageAttackSummary(b, i)}</small></li>`;
    }).join('')}</ol>`;
  }

  /**
   * Pre-fight card: portrait, name, title, intro line, fight number, and the three stages. A double
   * fight names both bosses, lists both health pools, and shows each one's stages under its name.
   */
  showBossIntro(info: BossIntro, actions: { begin(): void; back(): void }): void {
    const b = info.boss;
    const pair = b.partner;
    // Every stage has its own bar: list all three.
    const hpOf = (f: BossFighter) => f.stageHealth.join(' · ');
    const hp = pair ? `${b.name.split(' ').pop()} ${hpOf(b)}<br>${pair.name.replace(/^The /, '')} ${hpOf(pair)}` : `${hpOf(b)} HP`;
    const threat = BOSSES.map((_, i) => `<i class="${i <= info.index ? 'on' : ''}"></i>`).join('');
    const stages = pair
      ? `<p class="boss-stages-who">${b.name}</p>${this.stagesHtml(b)}
        <p class="boss-stages-who partner" style="${bossStyleVars(pair)}">${pair.name}</p>${this.stagesHtml(pair, ' partner', bossStyleVars(pair))}`
      : this.stagesHtml(b);
    const head = `${this.ladderHtml(info.index, info.index)}
        <div class="boss-card-body">
          ${bossPortraitHtml(b, 'large')}
          <div class="boss-text">
            <p class="boss-fight">Fight ${info.index + 1} of ${info.total}</p>
            <h1 class="boss-name${pair ? ' duo' : ''}">${pair ? `<span>${b.name}</span> <span>&amp; ${pair.name}</span>` : b.name}</h1>
            <p class="boss-title">${b.title}</p>
            <p class="boss-intro">${b.intro}</p>
            <dl class="boss-facts">
              <dt>Arena</dt><dd>${ARENA_NAMES[b.theme]}</dd>
              <dt>Lives</dt><dd>One. ${CONFIG.lifePacks.maxPerFight} life packs</dd>
              <dt>Stage bars</dt><dd>${hp}</dd>
              <dt>Threat</dt><dd class="threat">${threat}</dd>
            </dl>
          </div>
        </div>`;
    const foot = `${this.staffRackHtml(true)}
        <div class="menu-actions row"><button class="primary" data-act="begin">${this.label({ label: 'Begin', sub: info.beginNote })}</button>
        <button class="ghost" data-act="menu" data-back data-sys-main>Main Menu</button></div>`;
    // A double fight has two stage lists: its card takes two columns (intro and reward | stages,
    // staff and buttons) so it fits 1366x768 and 900x560 without scrolling.
    const s = this.mount(pair
      ? `
      <div class="menu-panel boss-card duo" style="${bossStyleVars(b)}">
        <div class="boss-card-col">${head}
        ${this.rewardLine(info)}</div>
        <div class="boss-card-col">${stages}
        ${foot}</div>
      </div>`
      : `
      <div class="menu-panel boss-card" style="${bossStyleVars(b)}">
        ${head}
        ${stages}
        ${this.rewardLine(info)}
        ${foot}
      </div>`, 'boss');
    this.sysBar(s, { hub: true, reopen: () => this.showBossIntro(info, actions) });
    this.bossIntro = { ...info };
    this.on(s, '[data-act="begin"]', () => actions.begin());
    this.on(s, '[data-act="menu"]', () => actions.back());
    this.bindStaff(s);
  }

  /** God mode was toggled on the boss card: its reward line says whether a win would be saved. */
  setBossRewardNote(note: UnsavedReason | null): void {
    const info = this.bossIntro;
    const line = this.screen?.querySelector('.boss-reward');
    if (!info || !line) return;
    info.rewardNote = note;
    line.outerHTML = this.rewardLine(info);
  }

  /**
   * The boss card's reward line: "Defeat to learn: <icon> Magic Carpet", that you know it already,
   * or that a win would not be saved (god mode on, or earlier wins of this run used it).
   */
  private rewardLine(intro: BossIntro): string {
    const id = intro.boss.reward;
    const info = REWARD_SPELL_INFO[id];
    const note = intro.rewardNote;
    const head = note === 'god' ? 'God mode: progress not saved'
      : note === 'skipped' ? 'Not saved · earlier wins used god mode'
        : intro.rewardLearned ? 'Reward · already learned' : 'Defeat to learn';
    const cls = note ? ' unsaved' : intro.rewardLearned ? ' learned' : '';
    return `<div class="boss-reward${cls}" style="--accent:${info.color}">
      <span class="reward-icon">${rewardIcon(id)}</span>
      <span class="reward-text"><small>${head}</small><b>${info.name}</b><i>${info.short}</i></span></div>`;
  }

  /** A button's inner HTML: its label and, if any, a second line (both plain text, escaped). */
  private label(a: { label: string; sub?: string }): string {
    return a.sub ? `${escapeHtml(a.label)}<small>${escapeHtml(a.sub)}</small>` : escapeHtml(a.label);
  }

  /**
   * "NEW SPELL LEARNED": the reward spell a gauntlet win just taught (after the results). `next` is
   * where the results were heading (the next boss card, or the completion screen).
   */
  showSpellReveal(id: RewardSpellId, actions: { next: MenuAction; menu(): void }): void {
    const info = REWARD_SPELL_INFO[id];
    const b = teacher(id);
    const key = CONFIG.controls[id][0].replace(/^Key|^Digit/, '');
    const pad = CONFIG.gamepad.bindings[id].map((x) => padGlyph(x, this.padStyle)).join(' / ');
    const keys = this.padDevice === 'gamepad'
      ? `<kbd class="pad">${pad}</kbd><span>or</span><kbd>${key}</kbd>`
      : `<kbd>${key}</kbd><span>or</span><kbd class="pad">${pad}</kbd>`;
    const s = this.mount(`
      <div class="menu-panel reveal" style="--accent:${info.color};${bossStyleVars(b)}">
        <p class="boss-fight">New spell learned</p>
        <div class="reveal-icon"><i class="reveal-rays"></i>${rewardIcon(id)}</div>
        <h1 class="reveal-name">${info.name}</h1>
        <p class="reveal-from">Taken from ${bossDisplayName(b)}, ${b.title}</p>
        <p class="reveal-desc">${info.description}</p>
        <p class="reveal-keys">${keys}</p>
        <p class="note">Yours for good: in every fight from now on, and in Quick Duel.</p>
        <div class="menu-actions"><button class="primary" data-act="continue" data-autofocus>${this.label(actions.next)}</button>
        <button class="ghost" data-act="menu" data-sys-main>Main Menu</button></div>
      </div>`, 'reveal');
    this.sysBar(s, { hub: true, reopen: () => this.showSpellReveal(id, actions) });
    this.on(s, '[data-act="continue"]', () => actions.next.action());
    this.on(s, '[data-act="menu"]', () => actions.menu());
  }

  /** Shown after the final boss falls. `unsaved`: why this clear is not counted (god mode now, or earlier in the run). */
  showCampaignComplete(info: { clears: number; unsaved?: UnsavedReason | null }, actions: { again(): void; menu(): void }): void {
    const s = this.mount(`
      <div class="menu-panel complete">
        <p class="boss-fight">Boss Gauntlet</p>
        <h1 class="result-title">Conquered</h1>
        <p class="tagline">All ${BOSSES.length} bosses have fallen to your wand.</p>
        <ol class="complete-roll">
          ${BOSSES.map((b) => `<li style="${bossStyleVars(b)}">${bossPortraitHtml(b, 'small')}<b>${bossDisplayName(b)}</b><small>${b.title}</small></li>`).join('')}
        </ol>
        <p class="note">${info.unsaved === 'god' ? 'God mode was on: this clear is not counted.' : info.unsaved === 'skipped' ? 'Earlier wins used god mode: this clear is not counted.' : info.clears > 1 ? `Gauntlet cleared ${info.clears} times.` : 'First clear. Well duelled.'}</p>
        <button class="primary" data-act="again">Run It Again</button>
        <button class="ghost" data-act="menu" data-sys-main>Main Menu</button>
      </div>`, 'complete');
    this.sysBar(s, { hub: true, reopen: () => this.showCampaignComplete(info, actions) });
    this.on(s, '[data-act="again"]', () => actions.again());
    this.on(s, '[data-act="menu"]', () => actions.menu());
  }

  /** After the Practice lessons: what was covered, and a first Quick Duel. */
  showPracticeDone(info: { earned: number; count: number; rival: string }, actions: { duel(): void; again(): void; menu(): void }): void {
    const s = this.mount(`
      <div class="menu-panel practice-done">
        <p class="boss-fight">Practice</p>
        <h2>Ready to duel</h2>
        <p class="note">${info.earned >= info.count ? `All ${info.count} lessons done.` : `${info.earned} of ${info.count} lessons done, the rest skipped.`}</p>
        <ul class="tips">
          <li>Held fire runs your mana down. Let go for two seconds before a Blast or a Shield.</li>
          <li>The roll needs a moment between uses; a Shield raised at the last instant sends the spell back.</li>
          <li>Golden Tickets give you more mana for a while. Get to them before your rival does.</li>
          <li>Not covered here: Stun freezes a rival for a second, and your Ultimate charges as you deal and take damage.</li>
        </ul>
        <div class="menu-actions">
          <button class="primary" data-act="duel" data-autofocus>Quick Duel<small>Best of three against the ${escapeHtml(info.rival)}</small></button>
          <button class="ghost" data-act="again">Practice Again</button>
          <button class="ghost" data-act="menu" data-back data-sys-main>Main Menu</button>
        </div>
      </div>`, 'practice-done');
    this.sysBar(s, { hub: true, reopen: () => this.showPracticeDone(info, actions) });
    this.on(s, '[data-act="duel"]', () => actions.duel());
    this.on(s, '[data-act="again"]', () => actions.again());
    this.on(s, '[data-act="menu"]', () => actions.menu());
  }

  showResults(r: ResultData): void {
    const acc = (x: ResultData['player']) => (x.casts ? `${Math.round((x.hits / x.casts) * 100)}%` : '–');
    const row = (label: string, a: string | number, b: string | number) => `<span>${a}</span><b>${label}</b><span>${b}</span>`;
    const primary = r.primary ?? { label: 'Rematch', action: () => this.h.restart() };
    const head = `${r.boss ? `<div class="results-boss">${bossPortraitHtml(r.boss, 'small')}<p class="boss-fight">${escapeHtml(r.eyebrow ?? '')}</p></div>` : r.eyebrow ? `<p class="boss-fight">${escapeHtml(r.eyebrow)}</p>` : ''}
        ${r.tag ? `<p class="result-tag">${escapeHtml(r.tag)}</p>` : ''}
        <h1 class="result-title">${escapeHtml(r.title)}</h1>
        ${r.learned ? `<p class="result-learned">✦ New spell learned: <b>${escapeHtml(r.learned)}</b></p>` : ''}
        <p class="tagline">${escapeHtml(r.subtitle)}</p>
        ${r.facts
          ? `<dl class="fight-facts">${r.facts.map((f) => `<div><dt>${escapeHtml(f.label)}</dt><dd>${escapeHtml(f.value)}</dd></div>`).join('')}</dl>`
          : `<div class="round-strip">${r.rounds.map((x, i) => `<i class="${x}" title="Round ${i + 1}">${i + 1}</i>`).join('')}</div>`}`;
    const tail = `<div class="stats">
          <span class="you">${escapeHtml(r.names[0])}</span><b></b><span class="them">${escapeHtml(r.names[1])}</span>
          ${row('Damage dealt', Math.round(r.player.damageDealt), Math.round(r.enemy.damageDealt))}
          ${row('Accuracy', acc(r.player), acc(r.enemy))}
          ${row('Perfect reflects', r.player.perfects, r.enemy.perfects)}
          ${row('Dodges', r.player.dodges, r.enemy.dodges)}
        </div>
        ${this.staffRackHtml(false, 'Change Staff')}
        <div class="menu-actions row"><button class="primary" data-act="rematch">${this.label(primary)}</button>
        <button class="ghost" data-act="quit" data-sys-main>Main Menu</button></div>`;
    // Boss results (portrait, tag, learned spell, fight facts) are taller than a duel's: two
    // columns, headline | stats, staff and buttons, so they fit 1366x768 and 900x560.
    const s = this.mount(`
      <div class="menu-panel results ${r.victory ? 'victory' : 'defeat'}${r.boss ? ' boss-results' : ''}" style="${r.boss ? bossStyleVars(r.boss) : ''}">
        ${r.boss ? `<div class="results-col">${head}</div><div class="results-col">${tail}</div>` : `${head}
        ${tail}`}
      </div>`, 'results');
    this.sysBar(s, { hub: true, reopen: () => this.showResults(r) });
    this.on(s, '[data-act="rematch"]', () => primary.action());
    this.on(s, '[data-act="quit"]', () => this.h.quit());
    this.bindStaff(s);
  }

  /** Online Duel: quick match, private room (create or join by code), back. */
  showOnline(h: { quick(): void; create(): void; join(code: string): void; back(): void }, note = ''): void {
    const s = this.mount(`
      <div class="menu-panel online">
        <h2>Online Duel</h2>
        <p class="note">One best-of-three against another player. Even fight: starter staff stats, no reward spells or god mode. No Ticket stake and no wager: 0 T.</p>
        ${note ? `<p class="note online-note" role="status">${escapeHtml(note)}</p>` : ''}
        <p class="note online-counts" role="status"></p>
        <button class="primary" data-act="quick" data-autofocus>Quick Match<small>Play whoever is searching</small></button>
        <button data-act="create">Create Room<small>Get a code to share</small></button>
        <div class="row join-row">
          <input class="room-code" maxlength="7" placeholder="CODE" autocomplete="off" spellcheck="false" aria-label="Room code" data-pad-chars="${ROOM_CODE_CHARS}" data-pad-max="${ROOM_CODE_MAX}">
          <button data-act="join">Join Room</button>
        </div>
        <button class="ghost" data-act="back" data-back>Back</button>
      </div>`, 'online');
    this.sysBar(s, { main: true, hub: true, reopen: () => this.showOnline(h, note) });
    const input = s.querySelector<HTMLInputElement>('.room-code')!;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') h.join(input.value);
    });
    this.on(s, '[data-act="quick"]', () => h.quick());
    this.on(s, '[data-act="create"]', () => h.create());
    this.on(s, '[data-act="join"]', () => h.join(input.value));
    this.on(s, '[data-act="back"]', () => h.back());
  }

  /** Waiting for an opponent (a room code to share, joining, connecting). Cancel backs out. */
  showOnlineStatus(title: string, sub: string, h: { cancel(): void }, code: string | null = null): void {
    const s = this.mount(`
      <div class="menu-panel online-status">
        <h2>${escapeHtml(title)}</h2>
        ${code ? `<button type="button" class="room-code-big" data-act="copy" aria-label="Copy room code">${escapeHtml(code)}</button>
        <div class="row room-actions"><button type="button" data-act="copy">Copy</button><button type="button" data-act="share">Share</button></div>` : ''}
        <p class="note online-sub" role="status">${escapeHtml(sub)}</p>
        <button class="ghost" data-act="cancel" data-back data-autofocus>Cancel</button>
      </div>`, 'online-status');
    this.sysBar(s, { main: true, hub: true, reopen: () => this.showOnlineStatus(title, sub, h, code) });
    this.on(s, '[data-act="cancel"]', () => h.cancel());
    this.on(s, '[data-act="copy"]', () => { void this.copyCode(code ?? ''); });
    this.on(s, '[data-act="share"]', () => { void this.shareCode(code ?? ''); });
  }

  /** Quick-match search: elapsed time, who's online, ping, and Cancel (removes the ticket). */
  showSearching(view: SearchView, h: { cancel(): void }): void {
    const s = this.mount(`
      <div class="menu-panel online-status" data-search>
        <h2>Searching</h2>
        <p class="search-time" data-elapsed>0:00</p>
        <p class="note online-counts" role="status"></p>
        <p class="note online-note" data-note role="status"></p>
        <p class="note latency" data-ping>Ping …</p>
        <p class="note">0 Tickets. No wager.</p>
        <button class="ghost" data-act="cancel" data-back data-autofocus>Cancel</button>
      </div>`, 'online-status');
    this.sysBar(s, { main: true, hub: true, reopen: () => this.showSearching(view, h) });
    this.on(s, '[data-act="cancel"]', () => h.cancel());
    this.setSearching(view);
  }

  /** Patch the searching screen. No-op if that screen is not up. */
  setSearching(view: SearchView): void {
    const root = this.screen?.querySelector('[data-search]');
    if (!root) return;
    this.setText(root, '[data-elapsed]', clock(view.elapsedS));
    this.setText(root, '.online-counts', countsLine(view.online, view.queued));
    this.setText(root, '[data-note]', view.note);
    const note = root.querySelector<HTMLElement>('[data-note]');
    if (note) note.hidden = !view.note;
    this.setText(root, '[data-ping]', pingLine(view.rttMs));
  }

  /** Quick-match accept window. Decline is also Back. */
  showMatchFound(view: FoundView, h: { accept(): void; decline(): void }): void {
    const s = this.mount(`
      <div class="menu-panel match-found">
        <h2>Match Found</h2>
        <div class="accept-head">${ringHtml()}<p class="note">Both must accept</p></div>
        <ul class="accept-seats">
          <li data-seat="0"><b></b><small></small></li>
          <li data-seat="1"><b></b><small></small></li>
        </ul>
        <p class="note">0 Tickets. No wager.</p>
        <p class="note latency" data-ping></p>
        <button class="primary" data-act="accept" data-autofocus>Accept</button>
        <button class="ghost" data-act="decline" data-back>Decline</button>
      </div>`, 'match-found');
    this.sysBar(s, { main: true, hub: true, reopen: () => this.showMatchFound(view, h) });
    this.on(s, '[data-act="accept"]', () => {
      h.accept();
      const btn = s.querySelector<HTMLButtonElement>('[data-act="accept"]');
      if (btn) btn.disabled = true;
    });
    this.on(s, '[data-act="decline"]', () => {
      h.decline();
      s.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    });
    this.setMatchFound(view);
  }

  setMatchFound(view: FoundView): void {
    const root = this.screen?.querySelector('.match-found');
    if (!root) return;
    paintRing(root, view.leftS, view.totalS);
    for (const seat of [0, 1] as const) {
      const li = root.querySelector<HTMLElement>(`[data-seat="${seat}"]`);
      if (!li) continue;
      li.classList.toggle('yes', view.accepted[seat]);
      const raw = view.names[seat] || (seat === view.seat ? 'You' : 'Opponent');
      const who = seat === view.seat && !/^you$/i.test(raw) ? `${raw} (you)` : raw;
      this.setText(li, 'b', who);
      this.setText(li, 'small', view.accepted[seat] ? 'Accepted' : 'Waiting');
    }
    this.setText(root, '[data-ping]', pingLine(view.rttMs));
  }

  /**
   * Rematch prompt on the results screen. Yes / No replace the results buttons while it is open.
   * Returns false when the results screen is not up.
   */
  showRematch(view: RematchView, h: { yes(): void; no(): void }): void {
    const panel = this.screen?.querySelector('.menu-panel.results');
    if (!panel) return;
    let bar = panel.querySelector<HTMLElement>('[data-rematch]');
    if (!bar) {
      panel.querySelector('.menu-actions')?.setAttribute('hidden', '');
      bar = document.createElement('div');
      bar.className = 'rematch-bar';
      bar.setAttribute('data-rematch', '');
      bar.innerHTML = `${ringHtml()}<div class="rematch-copy"><b>Rematch?</b><p class="note" data-rematch-note></p></div>
        <div class="row"><button class="primary" data-act="rematch-yes">Yes</button><button class="ghost" data-act="rematch-no" data-back>No</button></div>`;
      panel.appendChild(bar);
      this.on(bar, '[data-act="rematch-yes"]', () => h.yes());
      this.on(bar, '[data-act="rematch-no"]', () => h.no());
    }
    this.setRematch(view);
  }

  setRematch(view: RematchView): void {
    const bar = this.screen?.querySelector<HTMLElement>('[data-rematch]');
    if (!bar) return;
    paintRing(bar, view.leftS, view.totalS);
    const note = view.offeredBy === 'you' ? 'You offered. Waiting.' : view.offeredBy === 'them' ? 'Opponent wants a rematch.' : '0 Tickets. No wager.';
    this.setText(bar, '[data-rematch-note]', note);
    const yes = bar.querySelector<HTMLButtonElement>('[data-act="rematch-yes"]');
    if (yes) yes.disabled = view.youOffered;
  }

  /** Who's online, on the online menu. No-op on other screens. */
  setOnlineCounts(online: number | null, queued: number | null): void {
    const el = this.screen?.querySelector('.menu-panel.online > .online-counts');
    if (!el) return;
    el.textContent = countsLine(online, queued);
  }

  private setText(root: ParentNode, sel: string, text: string): void {
    const el = root.querySelector(sel);
    if (el && el.textContent !== text) el.textContent = text;
  }

  private async copyCode(code: string): Promise<void> {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      this.toast('Copied', code);
    } catch {
      this.toast('Copy failed', code);
    }
  }

  private async shareCode(code: string): Promise<void> {
    if (!code) return;
    const text = `Sproto Duel room ${code}`;
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'Sproto Duel', text });
        return;
      } catch {
        // The sheet was cancelled, or share is unavailable. Copy instead.
      }
    }
    await this.copyCode(code);
  }

  /** In an online match, Esc / Start: the fight never pauses; you can only resume or forfeit. */
  showOnlinePause(h: { resume(): void; forfeit(): void }): void {
    const s = this.mount(`
      <div class="menu-panel pause online-pause">
        <h2>Online Duel</h2>
        <p class="note">The fight keeps going while this is open.</p>
        <button class="primary" data-act="resume" data-autofocus>Resume</button>
        <button data-act="feedback">Send Feedback</button>
        <button class="ghost" data-act="forfeit">Forfeit</button>
        <button class="ghost" data-act="quit" data-sys-main>Main Menu</button>
        <button class="ghost" data-act="exit" data-sys-hub>Return to Hub</button>
      </div>`, 'online-pause');
    const reopen = () => this.showOnlinePause(h);
    this.sysBar(s, { reopen });
    this.on(s, '[data-act="quit"]', () => this.showExitConfirm(reopen, 'menu', true));
    this.on(s, '[data-act="exit"]', () => this.showExitConfirm(reopen, 'hub', true));
    this.on(s, '[data-act="resume"]', () => h.resume());
    this.on(s, '[data-act="feedback"]', () => this.h.feedback?.());
    this.on(s, '[data-act="forfeit"]', () => h.forfeit());
  }

  /** The results screen's line under the title (online: the server's verdict once it arrives). */
  setResultNote(text: string): void {
    const el = this.screen?.classList.contains('results') ? this.screen.querySelector('.tagline') : null;
    if (el) el.textContent = text;
  }

  /** Overlay shown when the game needs a click to (re)capture the mouse. */
  showClickToResume(): void {
    this.mount(`<div class="click-resume">Click to resume</div>`, 'click');
  }
}

/**
 * Escape plain text for an HTML template. Every string that is not a literal in this file (names,
 * reasons and room codes from the server or hub, labels passed in by App) goes through this before
 * it is interpolated into innerHTML; all games share one origin with the hub session.
 */
function escapeHtml(t: string): string {
  return t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const RING_R = 16;
const RING_C = 2 * Math.PI * RING_R;

function ringHtml(): string {
  return `<span class="count-ring"><svg viewBox="0 0 40 40" aria-hidden="true"><circle class="track" cx="20" cy="20" r="${RING_R}"/><circle class="arc" cx="20" cy="20" r="${RING_R}"/></svg><b>0</b></span>`;
}

/** Move the countdown ring. No CSS animation: the dash is the time left. */
function paintRing(root: ParentNode, left: number, total: number): void {
  const ring = root.querySelector<HTMLElement>('.count-ring');
  if (!ring) return;
  const p = total <= 0 ? 0 : Math.max(0, Math.min(1, left / total));
  const arc = ring.querySelector<SVGCircleElement>('.arc');
  if (arc) arc.setAttribute('stroke-dasharray', `${(p * RING_C).toFixed(2)} ${RING_C.toFixed(2)}`);
  const label = String(Math.max(0, Math.ceil(left)));
  const b = ring.querySelector('b');
  if (b && b.textContent !== label) b.textContent = label;
}

function clock(seconds: number): string {
  const n = Math.max(0, Math.floor(seconds));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

function countsLine(online: number | null, queued: number | null): string {
  if (online === null || queued === null) return 'Checking who is online…';
  return `${online} online · ${queued} queued`;
}

function pingLine(ms: number): string {
  return ms < 0 ? 'Ping …' : `${Math.round(ms)} ms`;
}
