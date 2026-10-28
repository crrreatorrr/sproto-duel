import { CONFIG } from '../config';
import { padGlyph, type InputDevice, type PadStyle } from '../core/Gamepad';
import { REWARD_SPELLS, REWARD_SPELL_INFO, type RewardSpellId } from '../spells/rewardCatalog';
import { rewardIcon } from './icons';
import { MenuNav } from './MenuNav';
import { resolveImage } from '../assets/AssetLoader';
import { bossStagePortrait } from '../assets/manifest';
import { STAGE_COUNT, stageAttackSummary } from '../campaign/BossStages';
import { ARENA_NAMES, BOSSES, bossDisplayName, type BossDef, type BossFighter } from '../campaign/levels';
import { bossPortraitHtml, bossStyleVars } from '../campaign/portrait';

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
}

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
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      // Older saves carried a difficulty choice; there is only one Quick Duel opponent now.
      const { difficulty: _legacy, ...saved } = JSON.parse(raw) as Partial<Settings> & { difficulty?: unknown };
      return { ...defaults, ...saved };
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

/** Saved gauntlet progress, for the main menu. */
export interface GauntletStatus {
  canContinue: boolean;
  /** Boss that Continue would start. */
  next: BossDef | null;
  nextIndex: number;
  clears: number;
}

export interface MenuHandlers {
  /** Quick Duel against the Rival (one fixed opponent). */
  start(): void;
  /** Boss Gauntlet from fight 1. */
  gauntlet(): void;
  /** Resume the saved gauntlet. */
  continueGauntlet(): void;
  gauntletStatus(): GauntletStatus;
  resume(): void;
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
}

const CONTROLS: [string, string][] = [
  ['W A S D', 'Move'],
  ['Shift', 'Sprint (drains mana)'],
  ['Space', 'Dodge roll (brief invulnerability)'],
  ['F / C', 'Jump'],
  ['Left click / 1', 'Bolt: fast, cheap, hold to fire'],
  ['Right click / 2', 'Blast: slow orb, area damage'],
  ['Q / 3', 'Shield: blocks. Perfect timing reflects'],
  ['E / 4', 'Stun beam: freezes for 1s'],
  ['R / 5', 'Ultimate: arena-wide shockwave'],
  ['Esc / P', 'Pause'],
];

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
  }

  get visible(): boolean {
    return this.screen !== null;
  }

  /** The "Click to resume" overlay is up (waiting for pointer lock). */
  get awaitingClick(): boolean {
    return !!this.screen?.classList.contains('click');
  }

  /** Which screen is showing ('main', 'boss', 'results', 'complete', ...), or null. */
  get current(): string | null {
    return this.screen?.classList[1] ?? null;
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
    this.root.innerHTML = '';
    this.screen = null;
    this.root.classList.remove('open');
    this.root.parentElement?.classList.remove('menu-open');
  }

  private mount(html: string, cls: string): HTMLElement {
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

  showMain(): void {
    const g = this.h.gauntletStatus();
    const cont = g.canContinue && g.next
      ? `<button class="gauntlet-btn continue" data-act="continue" style="${bossStyleVars(g.next)}">
           <b>Continue</b><small>Fight ${g.nextIndex + 1} of ${BOSSES.length} · ${bossDisplayName(g.next)}</small>
         </button>`
      : '';
    // A heading only labels the Continue / New Gauntlet pair: it never repeats a button's own title.
    const s = this.mount(`
      <div class="menu-panel main">
        <h1 class="title">Arcane<span>Duel</span></h1>
        <p class="tagline">Wands up. One life against each boss.</p>
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
          <button class="primary quick-duel" data-act="start">Quick Duel<small>One best-of-three against the Rival</small></button>
        </div>
        <div class="row">
          <button class="ghost" data-act="howto">How to Play</button>
          <button class="ghost" data-act="settings">Settings</button>
        </div>
        <p class="tip">Tip: raise your Shield just as a spell arrives to send it back.</p>
      </div>`, 'main');
    this.on(s, '[data-act="start"]', () => this.h.start());
    this.on(s, '[data-act="gauntlet"]', () => this.h.gauntlet());
    this.on(s, '[data-act="continue"]', () => this.h.continueGauntlet());
    this.on(s, '[data-act="howto"]', () => this.showHowTo(() => this.showMain()));
    this.on(s, '[data-act="settings"]', () => this.showSettings(() => this.showMain()));
  }

  showHowTo(back: () => void): void {
    const s = this.mount(`
      <div class="menu-panel howto">
        <h2>How to Play</h2>
        <div class="control-cols">
          <div><h3>Keyboard &amp; Mouse</h3><div class="controls">${CONTROLS.map(([k, v]) => `<kbd>${k}</kbd><span>${v}</span>`).join('')}</div></div>
          <div><h3>Controller</h3><div class="controls">${padControls(this.padStyle).map(([k, v]) => `<kbd>${k}</kbd><span>${v}</span>`).join('')}</div></div>
        </div>

        <ul class="tips">
          <li>Spells that collide mid-air clash. The bigger spell survives, weakened.</li>
          <li>A Shield raised in the last instant reflects the spell back, faster and stronger.</li>
          <li>Roll through the Ultimate's wave, or hide behind a pillar. Pillars crumble.</li>
          <li>The ring of fire burns. When time runs low, it closes in.</li>
          <li>Deal damage to charge your Ultimate. It carries over between rounds.</li>
          <li>Boss Gauntlet: one life per boss. Each boss stage has its own health bar; empty it and the boss transforms. Grab the life packs (three per fight).</li>
          <li>Every boss you beat teaches you its spell for good, in every later fight and in Quick Duel.</li>
        </ul>
        <h3 class="reward-head">Boss spells</h3>
        <ul class="reward-list">${this.rewardRows()}</ul>
        <div class="menu-actions"><button class="primary" data-act="back">Back</button></div>
      </div>`, 'howto');
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
      const who = st.who ? `${st.who}: ` : '';
      return `<p class="pause-stage${st.down ? ' down' : ''}"><span class="stage-pips">${pips}</span>${who}Stage ${st.index + 1} of ${STAGE_COUNT} · ${st.name}${st.down ? ' (down)' : ''}</p>`;
    };
    const s = this.mount(`
      <div class="menu-panel pause">
        <h2>Paused</h2>
        ${subtitle ? `<p class="note pause-sub">${subtitle}</p>` : ''}
        ${stages.map(line).join('')}
        <button class="primary" data-act="resume">Resume</button>
        <button data-act="restart">${restartLabel}</button>
        <button data-act="howto">How to Play</button>
        <button data-act="settings">Settings</button>
        <button class="ghost" data-act="quit">Quit to Menu</button>
      </div>`, 'pause');
    this.on(s, '[data-act="resume"]', () => this.h.resume());
    this.on(s, '[data-act="restart"]', () => this.h.restart());
    this.on(s, '[data-act="howto"]', () => this.showHowTo(() => this.showPause(subtitle, stages, restartLabel)));
    this.on(s, '[data-act="settings"]', () => this.showSettings(() => this.showPause(subtitle, stages, restartLabel)));
    this.on(s, '[data-act="quit"]', () => this.h.quit());
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
    const s = this.mount(`
      <div class="menu-panel boss-card" style="${bossStyleVars(b)}">
        ${this.ladderHtml(info.index, info.index)}
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
        </div>
        ${stages}
        ${this.rewardLine(info)}
        <div class="menu-actions row"><button class="primary" data-act="begin">${this.label({ label: 'Begin', sub: info.beginNote })}</button>
        <button class="ghost" data-act="menu">Main Menu</button></div>
      </div>`, 'boss');
    this.bossIntro = { ...info };
    this.on(s, '[data-act="begin"]', () => actions.begin());
    this.on(s, '[data-act="menu"]', () => actions.back());
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

  /** A button's inner HTML: its label and, if any, a second line. */
  private label(a: { label: string; sub?: string }): string {
    return a.sub ? `${a.label}<small>${a.sub}</small>` : a.label;
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
        <button class="ghost" data-act="menu">Main Menu</button></div>
      </div>`, 'reveal');
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
        <button class="ghost" data-act="menu">Main Menu</button>
      </div>`, 'complete');
    this.on(s, '[data-act="again"]', () => actions.again());
    this.on(s, '[data-act="menu"]', () => actions.menu());
  }

  showResults(r: ResultData): void {
    const acc = (x: ResultData['player']) => (x.casts ? `${Math.round((x.hits / x.casts) * 100)}%` : '–');
    const row = (label: string, a: string | number, b: string | number) => `<span>${a}</span><b>${label}</b><span>${b}</span>`;
    const primary = r.primary ?? { label: 'Rematch', action: () => this.h.restart() };
    const s = this.mount(`
      <div class="menu-panel results ${r.victory ? 'victory' : 'defeat'}${r.boss ? ' boss-results' : ''}" style="${r.boss ? bossStyleVars(r.boss) : ''}">
        ${r.boss ? `<div class="results-boss">${bossPortraitHtml(r.boss, 'small')}<p class="boss-fight">${r.eyebrow ?? ''}</p></div>` : r.eyebrow ? `<p class="boss-fight">${r.eyebrow}</p>` : ''}
        ${r.tag ? `<p class="result-tag">${r.tag}</p>` : ''}
        <h1 class="result-title">${r.title}</h1>
        ${r.learned ? `<p class="result-learned">✦ New spell learned: <b>${r.learned}</b></p>` : ''}
        <p class="tagline">${r.subtitle}</p>
        ${r.facts
          ? `<dl class="fight-facts">${r.facts.map((f) => `<div><dt>${f.label}</dt><dd>${f.value}</dd></div>`).join('')}</dl>`
          : `<div class="round-strip">${r.rounds.map((x, i) => `<i class="${x}" title="Round ${i + 1}">${i + 1}</i>`).join('')}</div>`}
        <div class="stats">
          <span class="you">${r.names[0]}</span><b></b><span class="them">${r.names[1]}</span>
          ${row('Damage dealt', Math.round(r.player.damageDealt), Math.round(r.enemy.damageDealt))}
          ${row('Accuracy', acc(r.player), acc(r.enemy))}
          ${row('Perfect reflects', r.player.perfects, r.enemy.perfects)}
          ${row('Dodges', r.player.dodges, r.enemy.dodges)}
        </div>
        <div class="menu-actions row"><button class="primary" data-act="rematch">${this.label(primary)}</button>
        <button class="ghost" data-act="quit">Main Menu</button></div>
      </div>`, 'results');
    this.on(s, '[data-act="rematch"]', () => primary.action());
    this.on(s, '[data-act="quit"]', () => this.h.quit());
  }

  /** Overlay shown when the game needs a click to (re)capture the mouse. */
  showClickToResume(): void {
    this.mount(`<div class="click-resume">Click to resume</div>`, 'click');
  }
}
