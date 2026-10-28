import { CONFIG, type Difficulty } from '../config';
import { padGlyph, type PadStyle } from '../core/Gamepad';
import { MenuNav } from './MenuNav';

export interface Settings {
  /** Multiplier on CONFIG.camera.sensitivity. */
  sensitivity: number;
  invertY: boolean;
  master: number;
  music: number;
  sfx: number;
  bloom: boolean;
  shadows: boolean;
  difficulty: Difficulty;
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
    difficulty: 'normal',
    padSensitivity: 1,
    padInvertY: false,
    aimAssist: CONFIG.gamepad.aimAssist.strength,
    rumble: CONFIG.gamepad.rumble.enabled,
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
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
}

export interface MenuHandlers {
  start(difficulty: Difficulty): void;
  resume(): void;
  restart(): void;
  quit(): void;
  settingsChanged(s: Settings): void;
  uiSound(kind: 'hover' | 'click'): void;
}

const DIFFICULTIES: { id: Difficulty; blurb: string }[] = [
  { id: 'easy', blurb: 'Slow to react, rarely shields. Learn the spells.' },
  { id: 'normal', blurb: 'Dodges, shields and punishes mistakes.' },
  { id: 'hard', blurb: 'Reflects your spells. Every whiff costs you.' },
];

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
  private settings: Settings;
  private screen: HTMLElement | null = null;

  constructor(parent: HTMLElement, initial: Settings, private readonly h: MenuHandlers) {
    this.settings = { ...initial };
    this.root = document.createElement('div');
    this.root.className = 'menus';
    parent.appendChild(this.root);
    this.nav = new MenuNav(this.root, () => this.h.uiSound('hover'));
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
    const s = this.mount(`
      <div class="menu-panel main">
        <h1 class="title">Arcane<span>Duel</span></h1>
        <p class="tagline">Wands up. Best of three.</p>
        <div class="difficulty">
          ${DIFFICULTIES.map((d) => `
            <button class="diff ${d.id === this.settings.difficulty ? 'selected' : ''}" data-diff="${d.id}">
              <b>${CONFIG.ai.difficulty[d.id].label}</b><small>${d.blurb}</small>
            </button>`).join('')}
        </div>
        <button class="primary" data-act="start">Begin Duel</button>
        <div class="row">
          <button class="ghost" data-act="howto">How to Play</button>
          <button class="ghost" data-act="settings">Settings</button>
        </div>
        <p class="tip">Tip: raise your Shield just as a spell arrives to send it back.</p>
      </div>`, 'main');
    this.on(s, '[data-diff]', (e) => {
      const btn = (e.currentTarget as HTMLElement);
      this.settings.difficulty = btn.dataset.diff as Difficulty;
      s.querySelectorAll('.diff').forEach((n) => n.classList.toggle('selected', n === btn));
      this.h.settingsChanged({ ...this.settings });
    });
    this.on(s, '[data-act="start"]', () => this.h.start(this.settings.difficulty));
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
        <button class="primary" data-act="back">Back</button>
      </div>`, 'settings');
    s.querySelectorAll('input').forEach((input) => {
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

  showPause(): void {
    const s = this.mount(`
      <div class="menu-panel pause">
        <h2>Paused</h2>
        <button class="primary" data-act="resume">Resume</button>
        <button data-act="restart">Restart Match</button>
        <button data-act="howto">How to Play</button>
        <button data-act="settings">Settings</button>
        <button class="ghost" data-act="quit">Quit to Menu</button>
      </div>`, 'pause');
    this.on(s, '[data-act="resume"]', () => this.h.resume());
    this.on(s, '[data-act="restart"]', () => this.h.restart());
    this.on(s, '[data-act="howto"]', () => this.showHowTo(() => this.showPause()));
    this.on(s, '[data-act="settings"]', () => this.showSettings(() => this.showPause()));
    this.on(s, '[data-act="quit"]', () => this.h.quit());
  }

  showResults(r: ResultData): void {
    const acc = (x: ResultData['player']) => (x.casts ? `${Math.round((x.hits / x.casts) * 100)}%` : '–');
    const row = (label: string, a: string | number, b: string | number) => `<span>${a}</span><b>${label}</b><span>${b}</span>`;
    const s = this.mount(`
      <div class="menu-panel results ${r.victory ? 'victory' : 'defeat'}">
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
        <button class="primary" data-act="rematch">Rematch</button>
        <button class="ghost" data-act="quit">Main Menu</button>
      </div>`, 'results');
    this.on(s, '[data-act="rematch"]', () => this.h.restart());
    this.on(s, '[data-act="quit"]', () => this.h.quit());
  }

  /** Overlay shown when the game needs a click to (re)capture the mouse. */
  showClickToResume(): void {
    this.mount(`<div class="click-resume">Click to resume</div>`, 'click');
  }
}
