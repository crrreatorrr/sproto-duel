import { GamepadInput } from './Gamepad';

/** Keys whose browser default (scrolling, quick-find, focus change) would interrupt play. */
const BLOCK_DEFAULT = new Set(['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Slash', 'Quote']);

/**
 * Raw keyboard + mouse state. Edges ("pressed this frame") are cleared at the end of every
 * rendered frame, so controllers must sample once per frame (they buffer actions themselves).
 */
export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  private mouseDown = [false, false, false];
  private mousePressed = [false, false, false];
  private dx = 0;
  private dy = 0;
  locked = false;
  /** Set by the debug API to drive the game without a real mouse. */
  enabled = true;
  /** Ignore mouse buttons while unlocked, so the click that captures the mouse doesn't cast. */
  mouseNeedsLock = true;
  /** Controller state, polled once per frame; also tracks which device was used last. */
  readonly pad = new GamepadInput();

  constructor(private readonly element: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (BLOCK_DEFAULT.has(e.code) && !(e.target instanceof HTMLInputElement)) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.down.add(e.code);
      this.pad.useKeyboardMouse();
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => {
      this.down.clear();
      this.mouseDown = [false, false, false];
    });
    element.addEventListener('mousedown', (e) => {
      if (e.button > 2 || (this.mouseNeedsLock && !this.locked)) return;
      this.mouseDown[e.button] = true;
      this.mousePressed[e.button] = true;
    });
    window.addEventListener('mousedown', () => this.pad.useKeyboardMouse());
    window.addEventListener('mouseup', (e) => {
      if (e.button <= 2) this.mouseDown[e.button] = false;
    });
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      // Deliberate movement only: browsers send zero-delta moves when the layout shifts.
      if (Math.abs(e.movementX) + Math.abs(e.movementY) > 1) this.pad.useKeyboardMouse();
      if (!this.locked) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.element;
    });
  }

  requestLock(): void {
    if (this.locked) return;
    const req = this.element.requestPointerLock() as unknown as Promise<void> | undefined;
    req?.catch?.(() => {});
  }

  releaseLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  isDown(codes: readonly string[]): boolean {
    if (!this.enabled) return false;
    for (const c of codes) if (this.down.has(c)) return true;
    return false;
  }

  wasPressed(codes: readonly string[]): boolean {
    if (!this.enabled) return false;
    for (const c of codes) if (this.pressed.has(c)) return true;
    return false;
  }

  isMouseDown(button: number): boolean {
    return this.enabled && this.mouseDown[button];
  }

  wasMousePressed(button: number): boolean {
    return this.enabled && this.mousePressed[button];
  }

  consumeMouseDelta(): { x: number; y: number } {
    const d = { x: this.dx, y: this.dy };
    this.dx = 0;
    this.dy = 0;
    return d;
  }

  endFrame(): void {
    this.pressed.clear();
    this.mousePressed = [false, false, false];
    this.pad.endFrame();
  }
}
