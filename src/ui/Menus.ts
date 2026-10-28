import { CONFIG } from '../config';
import { padGlyph, type PadStyle } from '../core/Gamepad';
import { MenuNav } from './MenuNav';
import { ARENA_NAMES, BOSSES, type BossDef } from '../campaign/levels';
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
  player: { damageDealt: number; casts: number; hits: number; perfects: number; dodges: number };
  enemy: { damageDealt: number; casts: number; hits: number; perfects: number; dodges: number };
  /** Small line above the title, e.g. "Fight 2 of 5". */
  eyebrow?: string;
  /** Campaign boss for the portrait and colours. */
  boss?: BossDef;
  /** Main button; defaults to "Rematch" (MenuHandlers.restart). */
  primary?: { label: string; action(): void };
}

/** What the boss intro card shows. */
export interface BossIntro {
  boss: BossDef;
  /** 0-based fight number. */
  index: number;
  total: number;
}

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

/** Main menu, pause, settings and results screens (DOM overlays). */
export class Menus {
  readonly root: HTMLElement;
  /** Gamepad navigation over whichever screen is open (App drives it each frame). */
  readonly nav: MenuNav;
  /** Glyph set for controller prompts; App keeps it in sync with the connected pad. */
  padStyle: PadStyle = 'xbox';
  private readonly toastEl: HTMLElement;
  private settings: Settings;
  private screen: HTMLElement | null = null;

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
  }

  private mount(html: string, cls: string): HTMLElement {
    this.root.innerHTML = `<div class="menu-screen ${cls}">${html}</div>`;
    this.root.classList.add('open');
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
           <b>Continue</b><small>Fight ${g.nextIndex + 1} of ${BOSSES.length} · ${g.next.name}</small>
         </button>`
      : '';
    const s = this.mount(`
      <div class="menu-panel main">
        <h1 class="title">Arcane<span>Duel</span></h1>
        <p class="tagline">Wands up. Best of three.</p>
        <div class="mode-block gauntlet-block">
          <h3>Boss Gauntlet</h3>
          <div class="row">
            ${cont}
            <button class="gauntlet-btn" data-act="gauntlet">
              <b>${g.canContinue ? 'New Gauntlet' : 'Boss Gauntlet'}</b><small>${g.canContinue ? 'Start again at fight 1' : `${BOSSES.length} bosses, ${BOSSES.length} arenas${g.clears ? ` · cleared ×${g.clears}` : ''}`}</small>
            </button>
          </div>
        </div>
        <div class="mode-block">
          <h3>Quick Duel</h3>
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
        </ul>
        <button class="primary" data-act="back">Back</button>
      </div>`, 'howto');
    this.on(s, '[data-act="back"]', back);
  }

  showSettings(back: () => void): void {
    const st = this.settings;
    const slider = (key: keyof Settings, label: string, min: number, max: number, step: number) => `
      <label class="setting"><span>${label}</span>
        <input type="range" min="${min}" max="${max}" step="${step}" value="${st[key]}" data-key="${key}">
        <output>${Number(st[key]).toFixed(step < 1 ? 2 : 0)}</output></label>`;
    const toggle = (key: keyof Settings, label: string) => `
      <label class="setting toggle"><span>${label}</span><input type="checkbox" data-key="${key}" ${st[key] ? 'checked' : ''}><i></i></label>`;
    const s = this.mount(`
      <div class="menu-panel settings">
        <h2>Settings</h2>
        ${slider('sensitivity', 'Mouse sensitivity', 0.3, 2.5, 0.05)}
        ${toggle('invertY', 'Invert Y')}
        ${slider('master', 'Master volume', 0, 1, 0.05)}
        ${slider('music', 'Music', 0, 1, 0.05)}
        ${slider('sfx', 'Effects', 0, 1, 0.05)}
        ${toggle('bloom', 'Bloom (glow)')}
        ${toggle('shadows', 'Shadows')}
        <h3>Controller</h3>
        ${slider('padSensitivity', 'Look sensitivity', 0.3, 2.5, 0.05)}
        ${toggle('padInvertY', 'Invert Y (controller)')}
        ${slider('aimAssist', 'Aim assist', 0, 1.5, 0.05)}
        ${toggle('rumble', 'Vibration')}
        <h3>Testing</h3>
        <label class="setting toggle god-setting"><span>God mode (testing)<small>No damage, unlimited mana, ${CONFIG.debug.godPowerMultiplier}× damage · type 99 or press ${CONFIG.debug.godHotkey} · resets on reload</small></span>
          <input type="checkbox" data-god ${this.h.godMode() ? 'checked' : ''}><i></i></label>
        <button class="primary" data-act="back">Back</button>
      </div>`, 'settings');
    const god = s.querySelector<HTMLInputElement>('input[data-god]')!;
    god.addEventListener('input', () => this.h.setGodMode(god.checked));
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

  /** `subtitle`: e.g. the boss being fought in the gauntlet. */
  showPause(subtitle = ''): void {
    const s = this.mount(`
      <div class="menu-panel pause">
        <h2>Paused</h2>
        ${subtitle ? `<p class="note pause-sub">${subtitle}</p>` : ''}
        <button class="primary" data-act="resume">Resume</button>
        <button data-act="restart">Restart Match</button>
        <button data-act="howto">How to Play</button>
        <button data-act="settings">Settings</button>
        <button class="ghost" data-act="quit">Quit to Menu</button>
      </div>`, 'pause');
    this.on(s, '[data-act="resume"]', () => this.h.resume());
    this.on(s, '[data-act="restart"]', () => this.h.restart());
    this.on(s, '[data-act="howto"]', () => this.showHowTo(() => this.showPause(subtitle)));
    this.on(s, '[data-act="settings"]', () => this.showSettings(() => this.showPause(subtitle)));
    this.on(s, '[data-act="quit"]', () => this.h.quit());
  }

  /** The five-step gauntlet ladder: cleared, current and locked fights. */
  private ladderHtml(current: number, cleared: number): string {
    return `<ol class="boss-ladder">${BOSSES.map((b, i) => {
      const state = i < cleared ? 'cleared' : i === current ? 'current' : 'locked';
      return `<li class="${state}" style="${bossStyleVars(b)}" title="${i < cleared || i === current ? b.name : '???'}"><span>${i < cleared ? '✓' : i + 1}</span></li>`;
    }).join('')}</ol>`;
  }

  /** Pre-fight card: portrait, name, title, intro line, fight number. */
  showBossIntro(info: BossIntro, actions: { begin(): void; back(): void }): void {
    const b = info.boss;
    const hp = Math.round(CONFIG.wizard.maxHealth * b.healthMultiplier);
    const threat = BOSSES.map((_, i) => `<i class="${i <= info.index ? 'on' : ''}"></i>`).join('');
    const s = this.mount(`
      <div class="menu-panel boss-card" style="${bossStyleVars(b)}">
        ${this.ladderHtml(info.index, info.index)}
        <div class="boss-card-body">
          ${bossPortraitHtml(b, 'large')}
          <div class="boss-text">
            <p class="boss-fight">Fight ${info.index + 1} of ${info.total}</p>
            <h1 class="boss-name">${b.name}</h1>
            <p class="boss-title">${b.title}</p>
            <p class="boss-intro">${b.intro}</p>
            <dl class="boss-facts">
              <dt>Arena</dt><dd>${ARENA_NAMES[b.theme]}</dd>
              <dt>Vitality</dt><dd>${hp} HP</dd>
              <dt>Threat</dt><dd class="threat">${threat}</dd>
            </dl>
          </div>
        </div>
        <button class="primary" data-act="begin">Begin</button>
        <button class="ghost" data-act="menu">Main Menu</button>
      </div>`, 'boss');
    this.on(s, '[data-act="begin"]', () => actions.begin());
    this.on(s, '[data-act="menu"]', () => actions.back());
  }

  /** Shown after the final boss falls. */
  showCampaignComplete(info: { clears: number }, actions: { again(): void; menu(): void }): void {
    const s = this.mount(`
      <div class="menu-panel complete">
        <p class="boss-fight">Boss Gauntlet</p>
        <h1 class="result-title">Conquered</h1>
        <p class="tagline">All ${BOSSES.length} bosses have fallen to your wand.</p>
        <ol class="complete-roll">
          ${BOSSES.map((b) => `<li style="${bossStyleVars(b)}">${bossPortraitHtml(b, 'small')}<b>${b.name}</b><small>${b.title}</small></li>`).join('')}
        </ol>
        <p class="note">${info.clears > 1 ? `Gauntlet cleared ${info.clears} times.` : 'First clear. Well duelled.'}</p>
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
        <h1 class="result-title">${r.title}</h1>
        <p class="tagline">${r.subtitle}</p>
        <div class="round-strip">${r.rounds.map((x, i) => `<i class="${x}" title="Round ${i + 1}">${i + 1}</i>`).join('')}</div>
        <div class="stats">
          <span class="you">${r.names[0]}</span><b></b><span class="them">${r.names[1]}</span>
          ${row('Damage dealt', Math.round(r.player.damageDealt), Math.round(r.enemy.damageDealt))}
          ${row('Accuracy', acc(r.player), acc(r.enemy))}
          ${row('Perfect reflects', r.player.perfects, r.enemy.perfects)}
          ${row('Dodges', r.player.dodges, r.enemy.dodges)}
        </div>
        <button class="primary" data-act="rematch">${primary.label}</button>
        <button class="ghost" data-act="quit">Main Menu</button>
      </div>`, 'results');
    this.on(s, '[data-act="rematch"]', () => primary.action());
    this.on(s, '[data-act="quit"]', () => this.h.quit());
  }

  /** Overlay shown when the game needs a click to (re)capture the mouse. */
  showClickToResume(): void {
    this.mount(`<div class="click-resume">Click to resume</div>`, 'click');
  }
}
