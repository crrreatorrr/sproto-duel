import * as THREE from 'three';
import type { App } from '../App';
import { Campaign } from '../campaign/Campaign';
import { BOSSES, bossDisplayName } from '../campaign/levels';
import { CONFIG } from '../config';
import { events } from '../core/events';
import type { Game } from '../core/Game';
import type { ResultData } from '../ui/Menus';
import { button, withStashedSave } from './campaignScenarios';
import type { QAHarness } from './QAHarness';

/**
 * Problems with the open menu screen's layout: its main button and its Back / Main Menu button must
 * sit fully inside the menus box (and any scrolling ancestor); with `noScroll`, the screen must not
 * scroll at all. Empty when it fits.
 */
export function fitProblems(app: App, name: string, noScroll = false): string[] {
  const root = app.menus.root;
  const problems: string[] = [];
  const screen = root.querySelector('.menu-screen') as HTMLElement;
  const box = root.getBoundingClientRect();
  const buttons = [...screen.querySelectorAll<HTMLButtonElement>('button.primary, [data-act="back"], [data-act="menu"], [data-act="quit"]')];
  if (!buttons.length) problems.push(`${name}: no buttons`);
  for (const b of buttons) {
    const r = b.getBoundingClientRect();
    let ok = r.height > 0 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5 && r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
    // Not clipped by a scrolling ancestor either (main menu panel, the screen).
    for (let el = b.parentElement; ok && el && el !== root; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.overflowY === 'visible' && cs.overflowX === 'visible') continue;
      const a = el.getBoundingClientRect();
      if (r.top < a.top - 0.5 || r.bottom > a.bottom + 0.5) ok = false;
    }
    if (!ok) problems.push(`${name}: "${b.textContent?.trim()}" at ${Math.round(r.top - box.top)}..${Math.round(r.bottom - box.top)} of ${Math.round(box.height)}`);
  }
  if (noScroll && screen.scrollHeight > screen.clientHeight + 1) problems.push(`${name}: scrolls (${screen.scrollHeight} > ${screen.clientHeight})`);
  return problems;
}

/** Run `fn` with the menus laid out in a `w` x `h` box (they are a size container), then restore. */
export function withMenuSize(app: App, w: number, h: number, fn: () => void): void {
  const root = app.menus.root;
  const prev = root.getAttribute('style');
  try {
    root.style.cssText = `position:absolute;left:0;top:0;right:auto;bottom:auto;width:${w}px;height:${h}px;`;
    fn();
  } finally {
    if (prev === null) root.removeAttribute('style');
    else root.setAttribute('style', prev);
  }
}

/** Lines of text a node's own text runs over (1 = it doesn't wrap). */
function lineCount(node: Node): number {
  const range = document.createRange();
  range.selectNodeContents(node);
  const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
  return tops.size;
}

/**
 * Menu flow and layout: New Gauntlet keeps the save until Begin, the results always match the save,
 * every boss card fits common laptop screens, the menus' background duel stays out of the menus (no
 * world popups over them, no god mode), and the small label fixes (main menu headings, pause, the
 * results' Next Fight button).
 */
export function registerMenuScenarios(qa: QAHarness, game: Game, app: App): void {
  qa.add('menu.new_gauntlet_back_keeps_continue', (c) => {
    withStashedSave(app, () => {
      const camp = app.campaign;
      camp.reset();
      // No saved run: the main menu's headings never repeat a button's title.
      app.toMenu();
      const titles = () => [...app.menus.root.querySelectorAll('.menu-panel.main button')].map((b) => (b.querySelector('b')?.textContent ?? b.firstChild?.textContent ?? '').trim().toLowerCase());
      const heads = () => [...app.menus.root.querySelectorAll('.menu-panel.main h3')].map((h) => (h.textContent ?? '').trim().toLowerCase());
      c.expect(!heads().some((h) => titles().includes(h)), `a main menu heading repeats a button: headings ${heads().join(', ')} / buttons ${titles().join(', ')}`);
      // A saved run at fight 3.
      camp.index = 0;
      camp.recordWin();
      camp.index = 1;
      camp.recordWin();
      app.toMenu();
      c.expect(!!button(app, 'continue') && heads().includes('boss gauntlet'), 'the main menu does not offer Continue under its Boss Gauntlet heading');
      c.expect(!heads().some((h) => titles().includes(h)), `a main menu heading repeats a button: ${heads().join(', ')}`);
      // New Gauntlet shows fight 1's card but leaves the save alone...
      button(app, 'gauntlet')!.click();
      c.expect(app.menus.current === 'boss' && camp.index === 0, `New Gauntlet showed ${app.menus.current} at fight ${camp.index + 1}`);
      c.expect(camp.saved.next === 2 && new Campaign().saved.next === 2, `New Gauntlet wiped the save before Begin: ${JSON.stringify(camp.saved)}`);
      const begin = button(app, 'begin')!;
      c.expect(/replaces your save at fight 3/i.test(begin.textContent ?? ''), `Begin does not warn it replaces the save: "${begin.textContent}"`);
      // ...so backing out keeps Continue at fight 3.
      button(app, 'menu')!.click();
      const cont = button(app, 'continue');
      c.expect(app.menus.current === 'main' && !!cont && cont.textContent!.includes(BOSSES[2].name), `Continue lost after backing out of New Gauntlet: "${cont?.textContent}"`);
      cont!.click();
      c.expect(app.menus.current === 'boss' && camp.index === 2, 'Continue did not resume at fight 3');
      c.expect(!/replaces/i.test(button(app, 'begin')!.textContent ?? ''), 'the Continue card warns about replacing the save');
      // New Gauntlet, then Begin: now the run starts over (the learned spells stay).
      button(app, 'menu')!.click();
      button(app, 'gauntlet')!.click();
      button(app, 'begin')!.click();
      c.expect(app.state === 'playing' && app.match.boss === BOSSES[0], 'Begin did not start fight 1');
      c.expect(camp.saved.next === 0 && new Campaign().saved.next === 0 && camp.unlocked.length === 2, `Begin did not start over (or forgot the spells): ${JSON.stringify(camp.saved)}`);
      // A boss fight's pause menu restarts the fight, not a match.
      app.pause();
      const restart = button(app, 'restart')!.textContent ?? '';
      c.expect(restart === 'Restart Fight', `pause in a boss fight: "${restart}"`);
      button(app, 'quit')!.click();
      c.expect(app.menus.current === 'main' && !button(app, 'continue'), 'Continue still offered after starting over');
      app.startMatch();
      app.pause();
      c.expect(button(app, 'restart')!.textContent === 'Restart Match', 'Quick Duel pause lost "Restart Match"');
    });
  });

  qa.add('results.god_toggle_after_match_end_matches_save', (c) => {
    // God mode toggled (F9 / 99) in the ~2 s between the fight's end and the results changes nothing:
    // the result was settled (and saved) when the fight ended, and the screen says what was saved.
    const prev = CONFIG.debug.godMode;
    /** The final KO (the round ends, the match is decided), then `between` (the round-end pause), then the match's end. */
    const end = (between = () => {}) => {
      const m = app.match;
      m.wins[0] = m.roundsToWin;
      m.wins[1] = 0;
      m.roundWinners = [game.player];
      m.phase = 'roundEnd';
      between();
      m.phase = 'matchEnd';
      events.emit('matchEnd', { winner: game.player });
    };
    const root = app.menus.root;
    const tag = () => root.querySelector('.result-tag')?.textContent ?? '';
    const eyebrow = () => root.querySelector('.results-boss .boss-fight')?.textContent ?? '';
    withStashedSave(app, () => {
      try {
        app.setGodMode(false);
        app.campaign.reset();
        app.newGauntlet();
        button(app, 'begin')!.click();
        // God mode on after the boss fell, before the fight's end is announced: the fight was fair.
        end(() => app.setGodMode(true));
        c.expect(!app.godUsed, 'god mode turned on after the final KO marked the fight');
        c.expect(app.campaign.saved.next === 1 && app.campaign.hasLearned(BOSSES[0].reward), `the fair win was not saved: ${JSON.stringify(app.campaign.saved)}`);
        // F9 (off), then on, off, on again before the results come up.
        window.dispatchEvent(new KeyboardEvent('keydown', { code: CONFIG.debug.godHotkey }));
        c.expect(!CONFIG.debug.godMode, 'F9 did not toggle god mode off');
        app.setGodMode(true);
        app.setGodMode(false);
        app.setGodMode(true);
        c.expect(!app.godUsed, 'a god-mode toggle after the fight ended marked it');
        app.showResults();
        c.expect(!tag() && /cleared/i.test(eyebrow()) && !/not saved/i.test(eyebrow()), `results contradict the save: tag "${tag()}", eyebrow "${eyebrow()}"`);
        c.expect((root.querySelector('.result-learned')?.textContent ?? '').includes('Magic Carpet'), 'results do not name the spell the save learned');
        // The other way round: god mode on during the fight, off once it ended: not saved, and said so.
        app.campaign.index = 1;
        app.startBossFight();
        c.expect(app.godUsed, 'god mode at the start not noted');
        end();
        app.setGodMode(false);
        app.showResults();
        c.expect(app.campaign.saved.next === 1 && !app.campaign.hasLearned(BOSSES[1].reward), `a god-mode win was saved: ${JSON.stringify(app.campaign.saved)}`);
        c.expect(/god mode/i.test(tag()) && /not saved/i.test(eyebrow()) && !root.querySelector('.result-learned'), `results: tag "${tag()}", eyebrow "${eyebrow()}"`);
      } finally {
        app.setGodMode(prev);
      }
    });
  });

  qa.add('ui.boss_cards_fit_1280x800_and_1366x768', (c) => {
    // Every boss card (the double fight's two-name card is the tallest; fight 1's New Gauntlet card
    // carries a note under Begin) fits common laptop screens without scrolling, as do the results
    // with the Next Fight button, whose label and boss name each stay on one line.
    const problems: string[] = [];
    const sizes: string[] = [];
    const stats = { damageDealt: 120, casts: 300, hits: 120, perfects: 2, dodges: 9 };
    const results = (i: number): ResultData => ({
      title: 'Victory', subtitle: `${bossDisplayName(BOSSES[i])}, ${BOSSES[i].title}, falls.`, victory: true, names: ['You', bossDisplayName(BOSSES[i])], rounds: [],
      eyebrow: `Fight ${i + 1} of 5 · not saved`, boss: BOSSES[i], tag: 'Not saved · earlier wins used god mode',
      facts: [{ label: 'Fight time', value: '17:42' }, { label: 'Stage reached', value: '3 of 3 · Final Form' }, { label: 'Life packs', value: '3 of 3' }, { label: 'Health left', value: '12%' }],
      primary: { label: 'Next Fight', sub: bossDisplayName(BOSSES[i + 1]), action() {} }, player: stats, enemy: stats,
    });
    try {
      for (const [w, h] of [[1280, 800], [1366, 768]]) {
        withMenuSize(app, w, h, () => {
          BOSSES.forEach((b, i) => {
            app.menus.showBossIntro({ boss: b, index: i, total: BOSSES.length, rewardNote: i % 2 ? 'skipped' : null, beginNote: i === 0 ? 'Replaces your save at fight 4' : undefined }, { begin() {}, back() {} });
            const screen = app.menus.root.querySelector('.menu-screen') as HTMLElement;
            sizes.push(`${w}x${h} #${i + 1} ${screen.scrollHeight}`);
            problems.push(...fitProblems(app, `${w}x${h} boss card ${i + 1}`, true));
            // The duo's names stay one per line.
            const name = app.menus.root.querySelector('.boss-name')!;
            const lines = [...name.querySelectorAll('span')].map((s) => lineCount(s));
            if (lines.some((n) => n > 1)) problems.push(`${w}x${h} boss card ${i + 1}: a name wraps (${lines.join('/')} lines)`);
          });
          for (const i of [0, 1]) {
            app.menus.showResults(results(i));
            problems.push(...fitProblems(app, `${w}x${h} results ${i + 1}`, true));
            const btn = app.menus.root.querySelector('[data-act="rematch"]')!;
            const label = lineCount(btn.firstChild!), sub = lineCount(btn.querySelector('small')!);
            if (label !== 1 || sub !== 1) problems.push(`${w}x${h} results ${i + 1}: Next Fight button runs ${label} + ${sub} lines`);
          }
        });
      }
      c.note(sizes.join(', '));
      c.expect(problems.length === 0, problems.join(' | '));
    } finally {
      app.toMenu();
    }
  });

  qa.add('ui.no_world_popups_over_menus', (c) => {
    // The menus' background duel (and a paused fight) keep their damage numbers and callouts
    // ("EVADED", "190", "IMMUNE") under the menus, and the background duel ignores god mode.
    const prev = CONFIG.debug.godMode;
    const p = game.player, e = game.enemy;
    const pos = new THREE.Vector3();
    const layer = game.ui.querySelector<HTMLElement>('.popups')!;
    /** Spawn a callout and a damage number in the world: whether they would show. */
    const shows = (): boolean => {
      game.popups.clear();
      events.emit('callout', { pos: e.chest(pos), text: 'EVADED', style: 'perfect' });
      events.emit('damage', { target: e, source: p, amount: 190, point: e.chest(pos), kind: 'blast' });
      game.popups.update(1 / 60);
      const spawned = [...layer.querySelectorAll<HTMLElement>('.popup')].map((el) => el.textContent);
      c.expect(spawned.includes('EVADED') && spawned.includes('190'), 'test setup: no popups spawned');
      return getComputedStyle(layer).visibility !== 'hidden';
    };
    try {
      app.setGodMode(false);
      const menus: [string, () => void][] = [
        ['main menu', () => app.toMenu()],
        ['boss card', () => {
          app.campaign.index = 0;
          app.showBossCard();
        }],
        ['settings', () => {
          app.toMenu();
          app.menus.showSettings(() => app.toMenu());
        }],
        ['pause', () => {
          app.startMatch();
          app.pause();
        }],
      ];
      for (const [name, show] of menus) {
        show();
        c.expect(!shows(), `${name}: world popups over the menu`);
      }
      // In play they show as usual.
      app.resume();
      app.menus.hide();
      c.expect(shows(), 'popups hidden during play');
      // God mode: never on the background duel's wizard; back on it once a match starts.
      app.toMenu();
      app.setGodMode(true);
      c.expect(!p.immune && p.damageMultiplier === 1 && p.clashPowerMultiplier === 1 && !p.infiniteMana && !p.noCooldowns, `the menu's background wizard has god mode (x${p.damageMultiplier}, immune ${p.immune})`);
      app.campaign.index = 0;
      app.showBossCard();
      c.expect(!p.immune && p.damageMultiplier === 1, 'the boss card background wizard has god mode');
      app.startMatch();
      c.expect(p.immune && p.infiniteMana && p.noCooldowns && p.damageMultiplier === CONFIG.debug.godPowerMultiplier, 'god mode not back on the player in a match');
      app.toMenu();
      c.expect(!p.immune && p.damageMultiplier === 1, 'god mode stayed on the background wizard after the match');
    } finally {
      app.setGodMode(prev);
      app.toMenu();
    }
  });
}
