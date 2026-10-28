import { CONFIG } from '../config';
import { padGlyph, type GamepadInput } from '../core/Gamepad';

const M = CONFIG.gamepad.menu;

type Dir = 'up' | 'down' | 'left' | 'right';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
/** What B presses: Back on sub-screens, Resume on the pause screen, or anything marked `data-back`. */
const BACK = '[data-back], [data-act="back"], [data-act="resume"]';
/** What a new screen focuses first. */
const DEFAULT = '[data-autofocus], [autofocus], button.primary';

/**
 * Gamepad navigation for whatever `.menu-screen` is mounted under `root`. Generic on purpose: it
 * queries focusable controls on every frame, so screens added later need no extra wiring.
 * D-pad / left stick move focus spatially (wrapping vertically), A activates, B backs out,
 * left/right adjust sliders. A new screen auto-focuses its primary button while a pad is active.
 */
export class MenuNav {
  private screen: Element | null = null;
  private active = false;
  private held: Dir | null = null;
  private repeatTimer = 0;
  private readonly hints: HTMLElement;
  private hintKey = '';
  /** Element wearing the `pad-focus` ring (a class, so it shows even while the window lacks focus). */
  private marked: HTMLElement | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly onMove: () => void = () => {},
  ) {
    this.hints = document.createElement('div');
    this.hints.className = 'pad-hints';
    (root.parentElement ?? root).appendChild(this.hints);
  }

  /** The control that currently has focus inside the open screen, if any. */
  get focused(): HTMLElement | null {
    const el = document.activeElement as HTMLElement | null;
    return el && this.screen?.contains(el) ? el : null;
  }

  /** Call once per rendered frame with the real frame time. */
  update(pad: GamepadInput, dt: number): void {
    pad.update();
    const active = pad.device === 'gamepad';
    if (active !== this.active) {
      this.active = active;
      this.root.classList.toggle('pad-nav', active);
    }
    const screen = this.root.querySelector('.menu-screen');
    const opened = screen !== this.screen;
    this.screen = screen;
    if (opened) this.held = null;
    this.step(pad, dt, active, screen);
    this.mark(active ? this.focused : null);
    this.updateHints(pad);
  }

  private step(pad: GamepadInput, dt: number, active: boolean, screen: Element | null): void {
    if (!active || !screen) return;
    if (!this.focused) {
      // New screen, focus lost to a mouse click, or the pad just woke up: focus first, act next frame.
      this.focusDefault(screen);
      this.held = this.direction(pad);
      return;
    }
    if (pad.justActivated) return;

    const dir = this.direction(pad);
    if (this.repeat(dir, dt) && dir) this.move(screen, dir);
    if (pad.wasPressed(['a'])) this.activate();
    else if (pad.wasPressed(['b'])) (screen.querySelector(BACK) as HTMLElement | null)?.click();
  }

  private mark(el: HTMLElement | null): void {
    if (el === this.marked) return;
    this.marked?.classList.remove('pad-focus');
    el?.classList.add('pad-focus');
    this.marked = el;
  }

  focusDefault(screen: Element): void {
    const items = this.items(screen);
    const el = items.find((e) => e.matches(DEFAULT)) ?? items[0];
    if (el) this.focus(el);
  }

  private items(screen: Element): HTMLElement[] {
    return [...screen.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.getClientRects().length > 0 && !el.closest('[inert], [aria-hidden="true"]'),
    );
  }

  private focus(el: HTMLElement): void {
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  private direction(pad: GamepadInput): Dir | null {
    if (pad.isDown(['up'])) return 'up';
    if (pad.isDown(['down'])) return 'down';
    if (pad.isDown(['left'])) return 'left';
    if (pad.isDown(['right'])) return 'right';
    const { x, y } = pad.move;
    const t = M.stickThreshold;
    if (Math.max(Math.abs(x), Math.abs(y)) < t) return null;
    return Math.abs(x) > Math.abs(y) ? (x > 0 ? 'right' : 'left') : y > 0 ? 'down' : 'up';
  }

  /** True on the first frame of a direction, then again after the repeat delay at a steady rate. */
  private repeat(dir: Dir | null, dt: number): boolean {
    if (dir !== this.held) {
      this.held = dir;
      this.repeatTimer = M.repeatDelay;
      return dir !== null;
    }
    if (!dir) return false;
    this.repeatTimer -= dt;
    if (this.repeatTimer > 0) return false;
    this.repeatTimer = Math.max(this.repeatTimer + M.repeatInterval, 0.01);
    return true;
  }

  private move(screen: Element, dir: Dir): void {
    const cur = this.focused;
    if (!cur) return;
    if (cur instanceof HTMLInputElement && cur.type === 'range' && (dir === 'left' || dir === 'right')) {
      this.adjust(cur, dir === 'right' ? 1 : -1);
      return;
    }
    const items = this.items(screen);
    let next = this.nearest(cur, items, dir);
    if (!next && (dir === 'up' || dir === 'down') && items.length > 1) {
      next = dir === 'down' ? items[0] : items[items.length - 1];
    }
    if (next && next !== cur) {
      this.focus(next);
      this.onMove();
    }
  }

  /**
   * Spatial navigation: candidates must lie entirely on the `dir` side of the current control;
   * the closest wins, with sideways offset counting a little (so a vertical list of mixed-width
   * controls still goes row by row).
   */
  private nearest(cur: HTMLElement, items: HTMLElement[], dir: Dir): HTMLElement | null {
    const a = cur.getBoundingClientRect();
    const acx = (a.left + a.right) / 2;
    const acy = (a.top + a.bottom) / 2;
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const el of items) {
      if (el === cur || el.contains(cur) || cur.contains(el)) continue;
      const b = el.getBoundingClientRect();
      let primary: number;
      let ortho: number;
      let offset: number;
      if (dir === 'up' || dir === 'down') {
        primary = dir === 'down' ? b.top - a.bottom : a.top - b.bottom;
        ortho = Math.max(0, b.left - a.right, a.left - b.right);
        offset = Math.abs((b.left + b.right) / 2 - acx);
      } else {
        primary = dir === 'right' ? b.left - a.right : a.left - b.right;
        ortho = Math.max(0, b.top - a.bottom, a.top - b.bottom);
        offset = Math.abs((b.top + b.bottom) / 2 - acy);
      }
      if (primary < -2) continue;
      const score = Math.max(0, primary) + ortho * 0.3 + offset * 0.01;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  private adjust(input: HTMLInputElement, sign: 1 | -1): void {
    const before = input.value;
    try {
      if (sign > 0) input.stepUp();
      else input.stepDown();
    } catch {
      return;
    }
    if (input.value === before) return;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    this.onMove();
  }

  private activate(): void {
    const el = this.focused;
    if (!el || (el instanceof HTMLInputElement && el.type === 'range')) return;
    el.click();
  }

  /** Button prompts in the corner while a pad drives the menus. */
  private updateHints(pad: GamepadInput): void {
    const screen = this.screen;
    const show = this.active && !!screen && this.items(screen).length > 0;
    const focused = this.focused;
    const slider = focused instanceof HTMLInputElement && focused.type === 'range';
    const back = !!screen?.querySelector(BACK);
    const key = show ? `${pad.style}|${slider}|${back}` : '';
    if (key === this.hintKey) return;
    this.hintKey = key;
    this.hints.classList.toggle('on', show);
    if (!show) return;
    const g = (b: string) => `<b class="glyph">${padGlyph(b, pad.style)}</b>`;
    this.hints.innerHTML = [
      slider ? `<span><b class="glyph">◀ ▶</b> Adjust</span>` : '',
      `<span>${g('a')} Select</span>`,
      back ? `<span>${g('b')} Back</span>` : '',
    ].join('');
  }
}
