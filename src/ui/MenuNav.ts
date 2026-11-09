import { CONFIG } from '../config';
import { padGlyph, type GamepadInput } from '../core/Gamepad';
import { editPadText, startPadText, type PadText, type PadTextOp } from './padText';

const M = CONFIG.gamepad.menu;

type Dir = 'up' | 'down' | 'left' | 'right';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
/** What a new screen focuses first. */
const DEFAULT = '[data-autofocus], [autofocus], button.primary';
/** Text fields a pad can type into: `data-pad-chars` is the alphabet, `data-pad-max` the length. */
const PAD_TEXT = 'input[data-pad-chars]';

/**
 * Menu auto-repeat, like a held key: true on the first frame of a direction, then again after
 * `delay` seconds and every `interval` seconds while it is held. Pure (no DOM).
 */
export class DirRepeat<D extends string = Dir> {
  private held: D | null = null;
  private timer = 0;

  constructor(
    private readonly delay: number,
    private readonly interval: number,
  ) {}

  /** Treat `dir` as already held (a new screen opened under a held direction): no first step. */
  hold(dir: D | null): void {
    this.held = dir;
    this.timer = this.delay;
  }

  step(dir: D | null, dt: number): boolean {
    if (dir !== this.held) {
      this.hold(dir);
      return dir !== null;
    }
    if (!dir) return false;
    this.timer -= dt;
    if (this.timer > 0) return false;
    this.timer = Math.max(this.timer + this.interval, 0.01);
    return true;
  }
}

/** What has keyboard focus in a menu, as far as the menu keys care. */
export type MenuFocus = 'none' | 'button' | 'text' | 'range';
export type MenuKey = Dir | 'confirm';

/**
 * A key in a menu (CONFIG.controls.menu), pure: arrows and W / S move, Enter / Space press. With
 * nothing focused, any of them just focuses the screen's first control. A slider keeps its own
 * left / right; a text field keeps every key but up / down (W and S are letters there, Enter is
 * its own submit). Esc is App's: back, or resume on the pause menu.
 */
export function menuKey(code: string, focus: MenuFocus): MenuKey | null {
  const K = CONFIG.controls.menu;
  if (focus === 'text') return code === 'ArrowUp' ? 'up' : code === 'ArrowDown' ? 'down' : null;
  const dir: Dir | null = K.up.includes(code) ? 'up' : K.down.includes(code) ? 'down' : K.left.includes(code) ? 'left' : K.right.includes(code) ? 'right' : null;
  if (dir) return focus === 'range' && (dir === 'left' || dir === 'right') ? null : dir;
  if (K.confirm.includes(code)) return focus === 'range' ? null : 'confirm';
  return null;
}

/** What B / Esc press: Back on sub-screens, Resume on the pause screen, or anything marked `data-back`. */
export const MENU_BACK = '[data-back], [data-act="back"], [data-act="resume"]';
const BACK = MENU_BACK;

/**
 * Gamepad and keyboard navigation for whatever `.menu-screen` is mounted under `root`. Generic on purpose: it
 * queries focusable controls on every frame, so screens added later need no extra wiring.
 * D-pad / left stick move focus spatially (wrapping vertically), A activates, B backs out,
 * left/right adjust sliders. A new screen auto-focuses its primary button while a pad is active.
 * A on a pad text field (`data-pad-chars`) starts typing with the pad: up/down picks the character,
 * left/right moves, X deletes, A finishes (and moves on to the control to the right), B finishes.
 * The keyboard drives the same focus (Menus forwards keydown to `key`; see `menuKey`).
 */
export class MenuNav {
  private screen: Element | null = null;
  private active = false;
  private readonly repeater = new DirRepeat(M.repeatDelay, M.repeatInterval);
  /** The pad text field being typed into, and where its cursor is. */
  private editing: HTMLInputElement | null = null;
  private text: PadText = { value: '', cursor: 0 };
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
    if (opened) this.repeater.hold(null);
    if (this.editing && (!active || !screen?.contains(this.editing) || this.focused !== this.editing)) this.stopEdit();
    this.step(pad, dt, active, screen);
    this.mark(active ? this.focused : null);
    this.updateHints(pad);
  }

  /**
   * A keydown anywhere (Menus forwards them): arrows / W / S move the focus like the D-pad,
   * Enter / Space press the focused control. The key is marked used (preventDefault), so Input
   * does not also count it as a gameplay press when the button resumes or starts a fight.
   */
  key(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const screen = this.root.querySelector('.menu-screen');
    if (!screen || this.items(screen).length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const cur = active && screen.contains(active) ? active : null;
    const kind: MenuFocus = !cur
      ? 'none'
      : cur instanceof HTMLInputElement && cur.type === 'range'
        ? 'range'
        : (cur instanceof HTMLInputElement && cur.type !== 'checkbox') || cur instanceof HTMLTextAreaElement || cur instanceof HTMLSelectElement
          ? 'text'
          : 'button';
    const action = menuKey(e.code, kind);
    if (!action) return;
    e.preventDefault();
    if (!cur) {
      this.focusDefault(screen);
      this.onMove();
      return;
    }
    if (action !== 'confirm') return this.move(screen, action, cur);
    if (!e.repeat) cur.click();
  }

  private step(pad: GamepadInput, dt: number, active: boolean, screen: Element | null): void {
    if (!active || !screen) return;
    if (!this.focused) {
      // New screen, focus lost to a mouse click, or the pad just woke up: focus first, act next frame.
      this.focusDefault(screen);
      this.repeater.hold(this.direction(pad));
      return;
    }
    if (pad.justActivated) return;

    const dir = this.direction(pad);
    const stepped = this.repeater.step(dir, dt) && dir;
    if (this.editing) return this.editStep(pad, screen, stepped || null);
    if (stepped) this.move(screen, stepped);
    if (pad.wasPressed(['a'])) this.activate();
    else if (pad.wasPressed(['b'])) (screen.querySelector(BACK) as HTMLElement | null)?.click();
  }

  /** Typing into a pad text field: B / A never reach the screen's Back or other buttons meanwhile. */
  private editStep(pad: GamepadInput, screen: Element, dir: Dir | null): void {
    const el = this.editing!;
    if (pad.wasPressed(['a'])) {
      this.stopEdit();
      this.move(screen, 'right');
      return;
    }
    if (pad.wasPressed(['b'])) return this.stopEdit();
    const op: PadTextOp | null = pad.wasPressed(['x'])
      ? 'delete'
      : dir === 'up' ? 'next' : dir === 'down' ? 'prev' : dir;
    if (!op) return;
    const max = this.maxLength(el);
    const before = this.text;
    this.text = editPadText(this.text, op, el.dataset.padChars ?? '', max);
    if (this.text.value !== el.value) {
      el.value = this.text.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (this.text.value !== before.value || this.text.cursor !== before.cursor) this.onMove();
    this.showCursor();
  }

  private startEdit(el: HTMLInputElement): void {
    this.editing = el;
    this.text = startPadText(el.value, this.maxLength(el));
    el.classList.add('pad-editing');
    this.showCursor();
    this.hintKey = '';
  }

  private stopEdit(): void {
    const el = this.editing;
    this.editing = null;
    el?.classList.remove('pad-editing');
    this.hintKey = '';
  }

  private maxLength(el: HTMLInputElement): number {
    const n = Number(el.dataset.padMax);
    return n > 0 ? n : el.maxLength > 0 ? el.maxLength : 16;
  }

  /** Select the character under the cursor (a caret on the empty slot at the end). */
  private showCursor(): void {
    const el = this.editing;
    if (!el) return;
    const { cursor, value } = this.text;
    try {
      el.setSelectionRange(cursor, Math.min(cursor + 1, value.length));
    } catch {
      /* not a text input */
    }
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

  private move(screen: Element, dir: Dir, cur = this.focused): void {
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
    if (el instanceof HTMLInputElement && el.matches(PAD_TEXT)) return this.startEdit(el);
    el.click();
  }

  /** Button prompts in the corner while a pad drives the menus. */
  private updateHints(pad: GamepadInput): void {
    const screen = this.screen;
    const show = this.active && !!screen && this.items(screen).length > 0;
    const focused = this.focused;
    const slider = focused instanceof HTMLInputElement && focused.type === 'range';
    const back = !!screen?.querySelector(BACK);
    const typing = !!this.editing;
    const field = !typing && focused instanceof HTMLInputElement && focused.matches(PAD_TEXT);
    const key = show ? `${pad.style}|${slider}|${back}|${typing}|${field}` : '';
    if (key === this.hintKey) return;
    this.hintKey = key;
    this.hints.classList.toggle('on', show);
    if (!show) return;
    const g = (b: string) => `<b class="glyph">${padGlyph(b, pad.style)}</b>`;
    if (typing) {
      this.hints.innerHTML = [
        `<span><b class="glyph">▲ ▼</b> Letter</span>`,
        `<span><b class="glyph">◀ ▶</b> Move</span>`,
        `<span>${g('x')} Delete</span>`,
        `<span>${g('a')} Done</span>`,
      ].join('');
      return;
    }
    if (field) {
      this.hints.innerHTML = `<span>${g('a')} Type code</span>${back ? `<span>${g('b')} Back</span>` : ''}`;
      return;
    }
    this.hints.innerHTML = [
      slider ? `<span><b class="glyph">◀ ▶</b> Adjust</span>` : '',
      `<span>${g('a')} Select</span>`,
      back ? `<span>${g('b')} Back</span>` : '',
    ].join('');
  }
}
