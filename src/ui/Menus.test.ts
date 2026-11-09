// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { Menus, loadSettings, type MenuHandlers, type ResultData } from './Menus';

/**
 * Server and hub strings (opponent names, reasons, room codes) reach the menus. They must render as
 * text: all games share one origin with the hub session, so markup in a name must never become DOM.
 */
const PAYLOADS = ['<b>x</b>', '<img src=x onerror=alert(1)>'];

const noop = () => {};
const handlers: MenuHandlers = {
  start: noop,
  gauntlet: noop,
  continueGauntlet: noop,
  gauntletStatus: () => ({ canContinue: false, next: null, nextIndex: 0, clears: 0 }),
  resume: noop,
  restart: noop,
  quit: noop,
  settingsChanged: noop,
  godMode: () => false,
  setGodMode: noop,
  uiSound: noop,
  learnedSpells: () => new Set(),
  savedSpells: () => new Set(),
  forgetSpells: noop,
  hubStatus: () => ({ connected: false, balance: null, ticketsCapLeft: null, error: null }) as unknown as ReturnType<MenuHandlers['hubStatus']>,
  exchangeTickets: () => Promise.reject(new Error('unused')),
  exitHub: noop,
  staffRack: () => ({ owned: [], selected: '', ranked: false }),
  selectStaff: noop,
};

const stats = { damageDealt: 10, casts: 4, hits: 2, perfects: 1, dodges: 0 };

function results(over: Partial<ResultData> = {}): ResultData {
  return {
    title: 'Victory',
    subtitle: 'Confirmed · 0 Tickets',
    eyebrow: 'Online Duel',
    victory: true,
    names: ['You', 'Opponent'],
    rounds: ['win', 'win'],
    player: stats,
    enemy: stats,
    ...over,
  };
}

/** No element anywhere under `root` came from a payload. */
function expectNoInjected(root: ParentNode): void {
  expect(root.querySelector('img')).toBeNull();
  expect(root.querySelector('[onerror]')).toBeNull();
  for (const b of root.querySelectorAll('b')) expect(b.textContent).not.toBe('x');
}

describe('Menus escapes server and user strings', () => {
  let parent: HTMLElement;
  let menus: Menus;

  beforeEach(() => {
    document.body.innerHTML = '';
    parent = document.createElement('div');
    document.body.appendChild(parent);
    menus = new Menus(parent, loadSettings(), handlers);
  });

  it('online results: player names render as literal text, no elements', () => {
    for (const [a, b] of [PAYLOADS, [...PAYLOADS].reverse()]) {
      menus.showResults(results({ names: [a, b] }));
      const you = menus.root.querySelector('.stats .you')!;
      const them = menus.root.querySelector('.stats .them')!;
      expect(you.textContent).toBe(a);
      expect(them.textContent).toBe(b);
      expect(you.children.length).toBe(0);
      expect(them.children.length).toBe(0);
      expectNoInjected(menus.root);
    }
  });

  it('results: every text field (title, subtitle, eyebrow, tag, facts, learned, button) is literal', () => {
    const p = PAYLOADS[1];
    menus.showResults(results({
      title: p,
      subtitle: p,
      eyebrow: p,
      tag: p,
      learned: p,
      facts: [{ label: p, value: p }],
      primary: { label: p, sub: p, action: noop },
    }));
    expectNoInjected(menus.root);
    expect(menus.root.querySelector('.result-title')!.textContent).toBe(p);
    expect(menus.root.querySelector('.tagline')!.textContent).toBe(p);
    expect(menus.root.querySelector('.result-tag')!.textContent).toBe(p);
    expect(menus.root.querySelector('.fight-facts dt')!.textContent).toBe(p);
    expect(menus.root.querySelector('.fight-facts dd')!.textContent).toBe(p);
    expect(menus.root.querySelector('[data-act="rematch"]')!.textContent).toBe(`${p}${p}`);
  });

  it('online menu note, status screen and room code are literal', () => {
    const p = PAYLOADS[1];
    menus.showOnline({ quick: noop, create: noop, join: noop, back: noop }, `Connection ended (${p})`);
    expectNoInjected(menus.root);
    expect(menus.root.querySelector('.online-note')!.textContent).toBe(`Connection ended (${p})`);
    menus.showOnlineStatus(p, p, { cancel: noop }, p);
    expectNoInjected(menus.root);
    expect(menus.root.querySelector('.room-code-big')!.textContent).toBe(p);
  });

  it('match found seats and pause subtitle are literal', () => {
    const p = PAYLOADS[1];
    menus.showMatchFound({ names: [p, PAYLOADS[0]], accepted: [false, false], seat: 1, leftS: 5, totalS: 10, rttMs: -1 }, { accept: noop, decline: noop });
    expectNoInjected(menus.root);
    expect(menus.root.querySelector('[data-seat="0"] b')!.textContent).toBe(p);
    menus.showPause(p, [{ index: 0, name: p, who: p }]);
    expectNoInjected(menus.root);
    expect(menus.root.querySelector('.pause-sub')!.textContent).toBe(p);
  });
});

describe('Character rack', () => {
  it('lists skins in the main menu, marks the chosen one, dims locked ones and reports clicks', () => {
    document.body.innerHTML = '';
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    let selected = 'sproto';
    const picked: string[] = [];
    const menus = new Menus(parent, loadSettings(), {
      ...handlers,
      characterRack: () => ({
        skins: [
          { id: 'sproto', name: 'Wizard Sproto', line: 'The original', accent: '#8fb4ff', locked: false },
          { id: 'sahil', name: 'Sahil', line: 'Boss skin · look only', accent: '#ff9a3c', locked: false },
          { id: 'tinubu', name: 'Tinubu', line: 'Beat Tinubu', accent: '#ffffff', locked: true },
        ],
        selected,
      }),
      selectCharacter: (id) => {
        picked.push(id);
        if (id !== 'tinubu') selected = id;
      },
    });
    menus.showMain();
    const btn = (id: string) => menus.root.querySelector<HTMLButtonElement>(`[data-skin="${id}"]`)!;
    expect(menus.root.querySelectorAll('[data-char-rack] [data-skin]').length).toBe(3);
    expect(btn('sproto').classList.contains('equipped')).toBe(true);
    expect(btn('tinubu').classList.contains('locked')).toBe(true);
    btn('sahil').click();
    btn('tinubu').click();
    expect(picked).toEqual(['sahil', 'tinubu']);
    expect(btn('sahil').classList.contains('equipped')).toBe(true);
    expect(btn('sproto').classList.contains('equipped')).toBe(false);
  });
});
