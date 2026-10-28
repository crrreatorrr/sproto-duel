import { CONFIG } from '../config';
import { events } from './events';
import type { Game } from './Game';

const G = CONFIG.gamepad;

export type InputDevice = 'kbm' | 'gamepad';
/** Which face-button glyphs to show. Mapping is positional either way ("a" = bottom face button). */
export type PadStyle = 'xbox' | 'playstation' | 'nintendo';
export type PadButton =
  | 'a' | 'b' | 'x' | 'y' | 'lb' | 'rb' | 'lt' | 'rt' | 'back' | 'start'
  | 'l3' | 'r3' | 'up' | 'down' | 'left' | 'right' | 'home';

/** W3C "standard" gamepad mapping, in button-index order. */
export const PAD_BUTTONS: readonly PadButton[] = [
  'a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'back', 'start', 'l3', 'r3', 'up', 'down', 'left', 'right', 'home',
];
const INDEX = new Map<string, number>(PAD_BUTTONS.map((b, i) => [b, i]));
const LT = 6;
const RT = 7;

const GLYPHS: Record<PadStyle, Record<PadButton, string>> = {
  xbox: {
    a: 'A', b: 'B', x: 'X', y: 'Y', lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT', back: 'View', start: 'Menu',
    l3: 'LS', r3: 'RS', up: 'D-pad ↑', down: 'D-pad ↓', left: 'D-pad ←', right: 'D-pad →', home: 'Xbox',
  },
  playstation: {
    a: '✕', b: '○', x: '□', y: '△', lb: 'L1', rb: 'R1', lt: 'L2', rt: 'R2', back: 'Create', start: 'Options',
    l3: 'L3', r3: 'R3', up: 'D-pad ↑', down: 'D-pad ↓', left: 'D-pad ←', right: 'D-pad →', home: 'PS',
  },
  nintendo: {
    a: 'B', b: 'A', x: 'Y', y: 'X', lb: 'L', rb: 'R', lt: 'ZL', rt: 'ZR', back: '−', start: '+',
    l3: 'LS', r3: 'RS', up: 'D-pad ↑', down: 'D-pad ↓', left: 'D-pad ←', right: 'D-pad →', home: 'Home',
  },
};

/** Label for a button on the given pad style, e.g. ('rt', 'playstation') -> 'R2'. */
export function padGlyph(button: string, style: PadStyle): string {
  return GLYPHS[style][button as PadButton] ?? button.toUpperCase();
}

/** Guess the glyph set from the pad id (vendor 045e = Microsoft, 054c = Sony, 057e = Nintendo). */
export function padStyleFromId(id: string): PadStyle {
  // Xbox first: "Xbox Wireless Controller" would otherwise match the DualShock 4's bare "Wireless Controller".
  if (/045e|xbox|xinput/i.test(id)) return 'xbox';
  if (/054c|playstation|dualshock|dualsense|^wireless controller/i.test(id)) return 'playstation';
  if (/057e|nintendo|pro controller|joy-con/i.test(id)) return 'nintendo';
  return 'xbox';
}

function keyLabel(code: string): string {
  return code.replace(/^Key|^Digit/, '').replace(/(Left|Right)$/, '');
}

/** Labels for the five HUD spell slots (bolt, blast, shield, stun, ultimate) on the given device. */
export function spellLabels(device: InputDevice, style: PadStyle): string[] {
  if (device === 'gamepad') {
    const b = G.bindings;
    return [b.bolt, b.blast, b.shield, b.stun, b.ultimate].map((x) => padGlyph(x[0], style));
  }
  const K = CONFIG.controls;
  const mouse = (button: number) => (button === 0 ? 'LMB' : button === 2 ? 'RMB' : 'MMB');
  return [mouse(K.mouseBolt), mouse(K.mouseBlast), keyLabel(K.shield[0]), keyLabel(K.stun[0]), keyLabel(K.ultimate[0])];
}

/** Labels for the five reward-spell slots (carpet, pump, vape, lock-on, breath) on the given device. */
export function rewardLabels(device: InputDevice, style: PadStyle): string[] {
  const ids = ['carpet', 'pump', 'vape', 'lockon', 'breath'] as const;
  // D-pad directions as bare arrows: the reward slots are small.
  if (device === 'gamepad') return ids.map((id) => padGlyph(G.bindings[id][0], style).replace(/^D-pad /, ''));
  return ids.map((id) => keyLabel(CONFIG.controls[id][0]));
}

/**
 * Radial deadzone + response curve. Writes the shaped stick into `out` (same direction as the
 * input, magnitude 0..1) and returns the shaped magnitude.
 */
export function shapeStick(x: number, y: number, deadzone: number, curve: number, out: { x: number; y: number }): number {
  const m = Math.hypot(x, y);
  if (!(m > deadzone)) {
    out.x = out.y = 0;
    return 0;
  }
  const n = Math.min(1, (m - deadzone) / Math.max(1e-6, G.outerDeadzone - deadzone));
  const shaped = Math.pow(n, curve);
  out.x = (x / m) * shaped;
  out.y = (y / m) * shaped;
  return shaped;
}

interface Rumble {
  strong: number;
  weak: number;
  ms: number;
}

/**
 * Gamepad state for one rendered frame. `update()` polls `navigator.getGamepads()` at most once
 * per frame (Input.endFrame marks the state stale), so gameplay and menus read the same edges and
 * a press is consumed by whichever reads it that frame. Tracks the active device (last used:
 * keyboard + mouse or gamepad) and connect/disconnect by polling, which also covers injected pads.
 */
export class GamepadInput {
  device: InputDevice = 'kbm';
  /** A standard-mapping pad is connected (it may not be the active device). */
  connected = false;
  id = '';
  style: PadStyle = 'xbox';
  /** Shaped sticks (deadzone + curve), -1..1, +y = down as the API reports it. */
  readonly move = { x: 0, y: 0 };
  readonly look = { x: 0, y: 0 };
  /** Trigger travel 0..1. */
  lt = 0;
  rt = 0;
  /** Seconds since the previous poll (0 on the first one). */
  dt = 0;
  /** True on the frame the pad took over from keyboard + mouse (menus swallow that press). */
  justActivated = false;
  /** Set from Settings. */
  rumbleEnabled: boolean = G.rumble.enabled;

  private readonly down = new Uint8Array(PAD_BUTTONS.length);
  private readonly prev = new Uint8Array(PAD_BUTTONS.length);
  private index = -1;
  private stale = true;
  private lastPoll = 0;
  private rumbleUntil = 0;
  private rumbleLevel = 0;
  private readonly deviceListeners: ((d: InputDevice) => void)[] = [];
  private readonly connectionListeners: ((connected: boolean, id: string) => void)[] = [];

  onDeviceChange(fn: (device: InputDevice) => void): void {
    this.deviceListeners.push(fn);
  }

  onConnectionChange(fn: (connected: boolean, id: string) => void): void {
    this.connectionListeners.push(fn);
  }

  setDevice(device: InputDevice): void {
    if (device === this.device) return;
    this.device = device;
    for (const fn of this.deviceListeners) fn(device);
  }

  /** Called by Input on real keyboard / mouse use. */
  useKeyboardMouse(): void {
    this.setDevice('kbm');
  }

  /** Mark the state stale; the next `update()` reads the hardware. Called by Input.endFrame. */
  endFrame(): void {
    this.stale = true;
  }

  /** Poll once per rendered frame. Extra calls in the same frame are free no-ops. */
  update(now = performance.now()): void {
    if (!this.stale) return;
    this.stale = false;
    this.dt = this.lastPoll ? Math.max(0, Math.min(0.1, (now - this.lastPoll) / 1000)) : 0;
    this.lastPoll = now;
    this.justActivated = false;
    this.prev.set(this.down);

    const pad = this.pick();
    if (!pad) {
      this.clearState();
      if (this.connected) {
        this.connected = false;
        // Listeners still see `device === 'gamepad'` if the lost pad was in use.
        for (const fn of this.connectionListeners) fn(false, this.id);
        this.setDevice('kbm');
      }
      return;
    }
    if (!this.connected || pad.id !== this.id) {
      this.connected = true;
      this.id = pad.id;
      this.style = padStyleFromId(pad.id);
      for (const fn of this.connectionListeners) fn(true, pad.id);
    }

    const buttons = pad.buttons;
    const tz = G.deadzone.trigger;
    for (let i = 0; i < this.down.length; i++) {
      const b = buttons[i];
      if (!b) {
        this.down[i] = 0;
      } else if (i === LT || i === RT) {
        // Analog triggers with a little hysteresis so a resting finger doesn't chatter.
        this.down[i] = b.value > (this.prev[i] ? tz * 0.7 : tz) || (b.pressed && b.value === 0) ? 1 : 0;
      } else {
        this.down[i] = b.pressed ? 1 : 0;
      }
    }
    this.lt = buttons[LT]?.value ?? 0;
    this.rt = buttons[RT]?.value ?? 0;
    const ax = pad.axes;
    shapeStick(ax[0] ?? 0, ax[1] ?? 0, G.deadzone.move, G.curve.move, this.move);
    shapeStick(ax[2] ?? 0, ax[3] ?? 0, G.deadzone.look, G.curve.look, this.look);

    if (this.device !== 'gamepad' && this.activity(pad)) {
      this.setDevice('gamepad');
      this.justActivated = true;
    }
  }

  isDown(buttons: readonly string[]): boolean {
    for (const b of buttons) {
      const i = INDEX.get(b);
      if (i !== undefined && this.down[i]) return true;
    }
    return false;
  }

  /** Went down this frame. Held buttons never re-trigger. */
  wasPressed(buttons: readonly string[]): boolean {
    for (const b of buttons) {
      const i = INDEX.get(b);
      if (i !== undefined && this.down[i] && !this.prev[i]) return true;
    }
    return false;
  }

  /** Forget all state (QA uses this around injected pads). Doesn't notify listeners. */
  reset(): void {
    this.clearState();
    this.prev.fill(0);
    this.index = -1;
    this.connected = false;
    this.id = '';
    this.style = 'xbox';
    this.lastPoll = 0;
    this.stale = true;
    this.justActivated = false;
    this.rumbleUntil = this.rumbleLevel = 0;
  }

  /**
   * Dual-motor rumble on the active pad, scaled by CONFIG.gamepad.rumble.intensity. A weaker
   * effect never cuts off a stronger one that is still playing. Silently skipped if unsupported.
   */
  rumble(fx: Rumble, scale = 1): void {
    if (!this.rumbleEnabled || this.device !== 'gamepad' || this.index < 0) return;
    const k = G.rumble.intensity * scale;
    const strong = Math.min(1, Math.max(0, fx.strong * k));
    const weak = Math.min(1, Math.max(0, fx.weak * k));
    if (strong + weak <= 0 || fx.ms <= 0) return;
    const now = performance.now();
    const level = strong + weak;
    if (now < this.rumbleUntil && level < this.rumbleLevel) return;
    try {
      const pad = navigator.getGamepads?.()[this.index] as (Gamepad & { vibrationActuator?: unknown }) | null | undefined;
      const act = pad?.vibrationActuator as
        | { playEffect?: (type: string, params: Record<string, number>) => Promise<unknown> }
        | null
        | undefined;
      if (!act || typeof act.playEffect !== 'function') return;
      this.rumbleUntil = now + fx.ms;
      this.rumbleLevel = level;
      act.playEffect('dual-rumble', { startDelay: 0, duration: fx.ms, strongMagnitude: strong, weakMagnitude: weak })?.catch?.(() => {});
    } catch {
      // Unsupported effect type or no actuator: rumble is optional.
    }
  }

  /** The pad to read: the last one used, else the first standard-mapping pad. */
  private pick(): Gamepad | null {
    let pads: readonly (Gamepad | null)[];
    try {
      pads = navigator.getGamepads?.() ?? [];
    } catch {
      return null; // blocked by permissions policy
    }
    let current: Gamepad | null = null;
    let first: Gamepad | null = null;
    for (const p of pads) {
      if (!p || !p.connected || p.mapping !== 'standard') continue;
      first ??= p;
      if (p.index === this.index) current = p;
      else if (this.activity(p)) {
        // Another pad was just used: it becomes the active one.
        current = p;
        this.index = p.index;
        this.prev.fill(0);
        break;
      }
    }
    const pad = current ?? first;
    if (pad && pad.index !== this.index) {
      this.index = pad.index;
      this.prev.fill(0);
    }
    if (!pad) this.index = -1;
    return pad;
  }

  /** Deliberate use: a face/shoulder press or a stick/trigger pushed well past drift. */
  private activity(p: Gamepad): boolean {
    const t = G.activateThreshold;
    for (let i = 0; i < p.buttons.length; i++) {
      const b = p.buttons[i];
      if (i === LT || i === RT ? b.value > t : b.pressed) {
        if (p.index !== this.index || !this.prev[i]) return true;
      }
    }
    const a = p.axes;
    return Math.hypot(a[0] ?? 0, a[1] ?? 0) > t || Math.hypot(a[2] ?? 0, a[3] ?? 0) > t;
  }

  private clearState(): void {
    this.down.fill(0);
    this.move.x = this.move.y = this.look.x = this.look.y = 0;
    this.lt = this.rt = 0;
  }
}

/**
 * Rumble on the local player's big moments: taking damage, landing big hits, perfect reflects and
 * KOs. Only while the player is in control (not in the attract-mode duel behind the menus).
 */
export function bindRumble(game: Game): void {
  const pad = game.input.pad;
  const R = G.rumble;
  const live = () => game.playerControl && pad.device === 'gamepad';
  events.on('damage', (e) => {
    if (!live()) return;
    const me = game.player;
    if (e.target === me) {
      if (e.kind === 'fire') pad.rumble(R.burn);
      else {
        const extra = e.amount * R.hurt.perDamage;
        pad.rumble({ strong: R.hurt.strong + extra, weak: R.hurt.weak + extra, ms: R.hurt.ms + e.amount * 3 });
      }
    } else if (e.source === me && e.amount >= R.bigHit.minDamage) {
      pad.rumble(R.bigHit);
    }
  });
  events.on('block', (e) => {
    if (live() && e.perfect && e.wizard === game.player) pad.rumble(R.perfect);
  });
  events.on('ko', (e) => {
    if (live() && (e.loser === game.player || e.winner === game.player)) pad.rumble(R.ko);
  });
}
