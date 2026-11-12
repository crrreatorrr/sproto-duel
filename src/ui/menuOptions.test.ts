// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import { CONTROLS_STORAGE_KEY, applyControlPrefs, defaultControlPrefs } from '../input/controlPrefs';
import { Menus, loadSettings, type MenuHandlers } from './Menus';

const noop = () => {};

function makeHandlers(over: Partial<MenuHandlers> = {}): MenuHandlers & { calls: string[] } {
  const calls: string[] = [];
  const h: MenuHandlers = {
    start: noop,
    gauntlet: noop,
    continueGauntlet: noop,
    gauntletStatus: () => ({ canContinue: false, next: null, nextIndex: 0, clears: 0 }),
    resume: () => calls.push('resume'),
    restart: noop,
    quit: () => calls.push('quit'),
    settingsChanged: (s) => calls.push(`settings:rumble=${s.rumble}`),
    godMode: () => false,
    setGodMode: noop,
    uiSound: noop,
    learnedSpells: () => new Set(),
    savedSpells: () => new Set(),
    forgetSpells: noop,
    hubStatus: () => ({ connected: false, balance: null, ticketsCapLeft: null, error: null }) as unknown as ReturnType<MenuHandlers['hubStatus']>,
    exchangeTickets: () => Promise.reject(new Error('unused')),
    exitHub: () => calls.push('exitHub'),
    toHub: () => calls.push('toHub'),
    controlsChanged: () => calls.push('controlsChanged'),
    staffRack: () => ({ owned: [], selected: '', ranked: false }),
    selectStaff: noop,
    ...over,
  };
  return Object.assign(h, { calls });
}

const stats = { damageDealt: 1, casts: 1, hits: 1, perfects: 0, dodges: 0 };

/** Every menu screen the player can open, with whether it is the main menu. */
function screens(m: Menus): [string, () => void, boolean][] {
  const h = { cancel: noop };
  return [
    ['main', () => m.showMain(), true],
    ['howto', () => m.showHowTo(noop), false],
    ['settings', () => m.showSettings(noop), false],
    ['exchange', () => m.showExchange(), false],
    ['versus-join', () => m.showVersusJoin({ p1: 'Keyboard + mouse', p2: null, pads: 0 }, { start: noop, back: noop }), false],
    ['pause', () => m.showPause('Sub'), false],
    ['online-pause', () => m.showOnlinePause({ resume: noop, forfeit: noop }), false],
    ['practice-done', () => m.showPracticeDone({ earned: 1, count: 8, rival: 'Apprentice' }, { duel: noop, again: noop, menu: noop }), false],
    ['complete', () => m.showCampaignComplete({ clears: 1 }, { again: noop, menu: noop }), false],
    ['results', () => m.showResults({ title: 'Victory', subtitle: '', victory: true, names: ['You', 'Rival'], rounds: ['win'], player: stats, enemy: stats }), false],
    ['online', () => m.showOnline({ quick: noop, create: noop, join: noop, back: noop }), false],
    ['online-status', () => m.showOnlineStatus('Room Created', 'Waiting', h, 'ABC234'), false],
    ['searching', () => m.showSearching({ elapsedS: 3, online: 1, queued: 0, note: '', rttMs: 20 }, h), false],
    ['match-found', () => m.showMatchFound({ names: ['A', 'B'], accepted: [false, false], seat: 0, leftS: 5, totalS: 10, rttMs: 20 }, { accept: noop, decline: noop }), false],
    ['reveal', () => m.showSpellReveal('carpet', { next: { label: 'Next', action: noop }, menu: noop }), false],
    ['controls', () => m.showControls({ main: true, hub: true, reopen: noop }), false],
  ];
}

let fsEnabled = true;
let fsElement: Element | null = null;
const fsCalls: string[] = [];

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  fsEnabled = true;
  fsElement = null;
  fsCalls.length = 0;
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => fsEnabled });
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fsElement });
  document.documentElement.requestFullscreen = () => {
    fsCalls.push('request');
    fsElement = document.documentElement;
    document.dispatchEvent(new Event('fullscreenchange'));
    return Promise.resolve();
  };
  document.exitFullscreen = () => {
    fsCalls.push('exit');
    fsElement = null;
    document.dispatchEvent(new Event('fullscreenchange'));
    return Promise.resolve();
  };
});

afterEach(() => applyControlPrefs(defaultControlPrefs()));

function setup(over: Partial<MenuHandlers> = {}) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const h = makeHandlers(over);
  const m = new Menus(parent, loadSettings(), h);
  return { m, h, root: m.root };
}

describe('every menu offers Main Menu, Hub, Controller Settings and Full Screen', () => {
  it('on each screen (Main Menu everywhere but the main menu itself)', () => {
    const { m, root } = setup();
    for (const [name, show, isMain] of screens(m)) {
      show();
      const has = (sel: string) => root.querySelectorAll(sel).length;
      expect(has('[data-sys="main"], [data-sys-main]'), `${name}: Main Menu`).toBe(isMain ? 0 : 1);
      expect(has('[data-sys="hub"], [data-sys-hub]'), `${name}: Hub`).toBe(1);
      expect(has('[data-sys="controls"]'), `${name}: Controller Settings`).toBe(name === 'controls' ? 0 : 1);
      expect(has('[data-sys="fullscreen"]'), `${name}: Full Screen`).toBe(1);
      // B / Esc still find the screen's own Back first, never a bar button.
      const back = root.querySelector('[data-back], [data-act="back"], [data-act="resume"]');
      if (back) expect(back.closest('.sys-bar')).toBeNull();
    }
  });

  it('Full Screen is hidden when the browser cannot do it', () => {
    fsEnabled = false;
    const { m, root } = setup();
    m.showMain();
    expect(root.querySelector('[data-sys="fullscreen"]')).toBeNull();
    expect(root.querySelector('[data-sys="controls"]')).not.toBeNull();
  });

  it('Full Screen requests and exits from the click, and its label follows the page', async () => {
    const { m, root } = setup();
    m.showPause();
    const btn = () => root.querySelector<HTMLButtonElement>('[data-sys="fullscreen"]')!;
    expect(btn().textContent).toContain('Off');
    btn().click();
    expect(fsCalls).toEqual(['request']); // synchronously, inside the click
    await Promise.resolve();
    expect(btn().getAttribute('aria-pressed')).toBe('true');
    expect(btn().textContent).toContain('On');
    // F11 / Esc leaving full screen outside the button: the label still follows.
    fsElement = null;
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(btn().textContent).toContain('Off');
    btn().click();
    expect(fsCalls).toEqual(['request', 'request']);
  });

  it('Main Menu and Hub leave at once outside a fight', () => {
    const { m, h, root } = setup({ inFight: () => null });
    m.showHowTo(noop);
    root.querySelector<HTMLButtonElement>('[data-sys="main"]')!.click();
    m.showOnline({ quick: noop, create: noop, join: noop, back: noop });
    root.querySelector<HTMLButtonElement>('[data-sys="hub"]')!.click();
    m.showMain();
    root.querySelector<HTMLButtonElement>('[data-sys="hub"]')!.click();
    expect(h.calls).toEqual(['quit', 'toHub', 'toHub']);
  });

  it('mid-fight, Main Menu and Hub ask first; Keep Fighting returns to the screen', () => {
    const { m, h, root } = setup({ inFight: () => 'local' });
    m.showPause('Fight 1');
    root.querySelector<HTMLButtonElement>('[data-sys-main]')!.click();
    expect(m.current).toBe('exit-confirm');
    expect(root.textContent).toContain('Quit to Main Menu?');
    root.querySelector<HTMLButtonElement>('[data-act="stay"]')!.click();
    expect(m.current).toBe('pause');
    // From a pause sub-screen's bar too.
    root.querySelector<HTMLButtonElement>('.menu-panel [data-act="settings"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-sys="hub"]')!.click();
    expect(root.textContent).toContain('Return to Hub?');
    root.querySelector<HTMLButtonElement>('[data-act="leave"]')!.click();
    expect(h.calls).toEqual(['toHub']);
  });

  it('online, leaving is a forfeit and says so', () => {
    const { m, h, root } = setup({ inFight: () => 'online' });
    m.showOnlinePause({ resume: noop, forfeit: noop });
    root.querySelector<HTMLButtonElement>('[data-sys-main]')!.click();
    expect(root.textContent).toContain('forfeit');
    root.querySelector<HTMLButtonElement>('[data-act="leave"]')!.click();
    expect(h.calls).toEqual(['quit']);
  });
});

describe('Controller Settings', () => {
  const slot = (root: HTMLElement, kind: string, action: string, s = 0) =>
    root.querySelector<HTMLButtonElement>(`[data-bind="${kind}"][data-action="${action}"][data-slot="${s}"]`)!;
  const key = (code: string) => window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));

  it('lists every action with its keys and pad button', () => {
    const { m, root } = setup();
    m.showControls({ reopen: noop });
    expect(slot(root, 'key', 'jump').textContent).toBe('Space');
    expect(slot(root, 'key', 'jump', 1).textContent).toBe('F');
    expect(slot(root, 'pad', 'ultimate').textContent).toBe('Y');
    expect(slot(root, 'key', 'pause').disabled).toBe(true);
    for (const a of ['forward', 'back', 'left', 'right', 'sprint', 'dodge', 'bolt', 'blast', 'shield', 'stun', 'carpet', 'pump', 'vape', 'lockon', 'breath']) {
      expect(slot(root, 'key', a), a).not.toBeNull();
    }
    expect(root.querySelector('[data-rumble]')).not.toBeNull();
    expect(root.querySelector('[data-deadzone]')).not.toBeNull();
  });

  it('press-to-bind remaps a key live, saves it, and keeps the key from the game', () => {
    const { m, h, root } = setup();
    let leaked = 0;
    const leak = () => leaked++;
    window.addEventListener('keydown', leak);
    m.showControls({ reopen: noop });
    slot(root, 'key', 'jump').click();
    expect(m.capturing).toBe(true);
    key('KeyJ');
    expect(m.capturing).toBe(false);
    expect(CONFIG.controls.jump).toEqual(['KeyJ', 'KeyF']);
    expect(slot(root, 'key', 'jump').textContent).toBe('J');
    expect(JSON.parse(localStorage.getItem(CONTROLS_STORAGE_KEY)!).keys.jump).toEqual(['KeyJ', 'KeyF']);
    expect(h.calls).toContain('controlsChanged');
    expect(leaked).toBe(0);
    // A conflict swaps, and the note says so.
    slot(root, 'key', 'jump', 1).click();
    key('KeyC');
    expect(CONFIG.controls.dodge).toEqual(['KeyF']);
    expect(root.querySelector('[data-bind-note]')!.textContent).toContain('Dodge roll');
    // Esc cancels without changing anything or leaving the screen.
    slot(root, 'key', 'shield').click();
    key('Escape');
    expect(m.capturing).toBe(false);
    expect(m.current).toBe('controller');
    expect(CONFIG.controls.shield).toEqual(['KeyQ', 'Digit3']);
    // A reserved key is refused with a reason.
    slot(root, 'key', 'shield').click();
    key('KeyN');
    expect(CONFIG.controls.shield).toEqual(['KeyQ', 'Digit3']);
    expect(root.querySelector('[data-bind-note]')!.classList.contains('warn')).toBe(true);
    window.removeEventListener('keydown', leak);
    expect(leaked).toBe(0);
  });

  it('pad buttons bind through the menu navigation; B cancels', () => {
    const { m, root } = setup();
    m.showControls({ reopen: noop });
    slot(root, 'pad', 'ultimate').click();
    expect(m.nav.capture).not.toBeNull();
    m.nav.capture!('x');
    expect(CONFIG.gamepad.bindings.ultimate).toEqual(['x']);
    expect(CONFIG.gamepad.bindings.breath).toEqual(['y']);
    expect(m.nav.capture).toBeNull();
    slot(root, 'pad', 'jump').click();
    m.nav.capture!('b');
    expect(CONFIG.gamepad.bindings.jump).toEqual(['a']);
    expect(m.capturing).toBe(false);
  });

  it('vibration, dead zone and Reset to Defaults', () => {
    const { m, h, root } = setup();
    m.showControls({ reopen: noop });
    const rumble = root.querySelector<HTMLInputElement>('[data-rumble]')!;
    rumble.checked = false;
    rumble.dispatchEvent(new Event('input'));
    expect(h.calls).toContain('settings:rumble=false');
    const dz = root.querySelector<HTMLInputElement>('[data-deadzone]')!;
    dz.value = '0.3';
    dz.dispatchEvent(new Event('input'));
    expect(CONFIG.gamepad.deadzone.move).toBe(0.3);
    slot(root, 'key', 'jump').click();
    key('KeyJ');
    root.querySelector<HTMLButtonElement>('[data-act="reset-controls"]')!.click();
    expect(CONFIG.controls.jump).toEqual(['Space', 'KeyF']);
    expect(CONFIG.gamepad.deadzone.move).toBe(0.2);
    expect(h.calls).toContain('settings:rumble=true');
    expect(slot(root, 'key', 'jump').textContent).toBe('Space');
  });

  it('Back (Esc / B) returns to the screen it was opened from; leaving the screen ends a bind', () => {
    const { m, root } = setup();
    m.showPause();
    root.querySelector<HTMLButtonElement>('[data-sys="controls"]')!.click();
    expect(m.current).toBe('controller');
    slot(root, 'key', 'jump').click();
    m.showControls({ reopen: () => m.showPause() });
    expect(m.capturing).toBe(false);
    expect(m.back()).toBe(true);
    expect(m.current).toBe('pause');
  });
});
