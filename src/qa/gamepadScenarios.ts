import * as THREE from 'three';
import type { App } from '../App';
import { CONFIG } from '../config';
import type { Game } from '../core/Game';
import { PAD_BUTTONS, shapeStick, spellLabels, type GamepadInput, type PadButton } from '../core/Gamepad';
import { wrapAngle } from '../core/math';
import { MenuNav } from '../ui/MenuNav';
import type { ActionKey } from '../wizard/Wizard';
import type { QAHarness } from './QAHarness';

const DT = CONFIG.sim.fixedDt;
const G = CONFIG.gamepad;
const W = CONFIG.wizard;

const XBOX_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
const DUALSENSE_ID = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)';

interface FakeButton {
  pressed: boolean;
  touched: boolean;
  value: number;
}

/** A scripted standard-mapping pad, shaped like the Gamepad snapshots Chrome returns. */
class FakePad {
  readonly index = 0;
  readonly mapping = 'standard';
  connected = true;
  timestamp = 0;
  readonly axes = [0, 0, 0, 0];
  readonly buttons: FakeButton[] = PAD_BUTTONS.map(() => ({ pressed: false, touched: false, value: 0 }));
  readonly rumbles: { type: string; params: Record<string, number> }[] = [];
  vibrationActuator: { playEffect(type: string, params: Record<string, number>): Promise<string> } | null = {
    playEffect: (type, params) => {
      this.rumbles.push({ type, params });
      return Promise.resolve('complete');
    },
  };

  constructor(public id = XBOX_ID) {}

  set(button: PadButton, value: number): void {
    this.buttons[PAD_BUTTONS.indexOf(button)] = { pressed: value > 0.5, touched: value > 0, value };
  }

  stick(side: 'left' | 'right', x: number, y: number): void {
    const o = side === 'left' ? 0 : 2;
    this.axes[o] = x;
    this.axes[o + 1] = y;
  }

  releaseAll(): void {
    for (const b of PAD_BUTTONS) this.set(b, 0);
    this.axes.fill(0);
  }
}

interface PadRig {
  pad: FakePad;
  gp: GamepadInput;
  /**
   * One rendered frame, ordered like Game.frame: one poll, the player controller samples input
   * (unless `control` is false), then `after` (menus / App hooks), then the frame's edges end.
   */
  frame(control?: boolean, after?: () => void): void;
  /** `frame()` then one fixed sim tick. */
  tick(): void;
  /** Bring the camera along as the render loop would. */
  camera(): void;
  /** Tap: down for one frame, up for the next. */
  tap(button: PadButton, control?: boolean): void;
}

/**
 * Inject a fake pad by overriding navigator.getGamepads for the duration of `fn`, then restore the
 * real API, the pad state, the active device, HUD labels and the controller settings.
 */
function withPad(game: Game, app: App, fn: (r: PadRig) => void, pad = new FakePad()): void {
  const gp = game.input.pad;
  const pc = game.playerController;
  const own = Object.getOwnPropertyDescriptor(navigator, 'getGamepads');
  const savedDevice = gp.device;
  const savedSettings = pc.padSettings;
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, writable: true, value: () => [pad, null, null, null] });
  gp.reset();
  let now = 1000;
  const r: PadRig = {
    pad,
    gp,
    frame(control = true, after) {
      now += DT * 1000;
      gp.update(now);
      if (control) {
        pc.look();
        pc.update();
      }
      after?.();
      game.input.endFrame();
    },
    tick() {
      r.frame();
      game.tick(DT);
    },
    camera() {
      game.rig.update(DT, game.player.pos, game.physics, false, false);
    },
    tap(button, control = true) {
      pad.set(button, 1);
      r.frame(control);
      pad.set(button, 0);
      r.frame(control);
    },
  };
  try {
    fn(r);
  } finally {
    if (own) Object.defineProperty(navigator, 'getGamepads', own);
    else delete (navigator as unknown as Record<string, unknown>).getGamepads;
    gp.reset();
    gp.setDevice(savedDevice);
    pc.applyPadSettings(savedSettings);
    app.hud.setKeyLabels(spellLabels(gp.device, gp.style));
    app.menus.padStyle = gp.style;
    game.player.intent.clear();
  }
}

const ACTIONS: [PadButton, ActionKey][] = [
  [G.bindings.bolt[0] as PadButton, 'bolt'],
  [G.bindings.blast[0] as PadButton, 'blast'],
  [G.bindings.shield[0] as PadButton, 'shield'],
  [G.bindings.stun[0] as PadButton, 'stun'],
  [G.bindings.ultimate[0] as PadButton, 'ultimate'],
  [G.bindings.jump[0] as PadButton, 'jump'],
  [G.bindings.dodge[0] as PadButton, 'dodge'],
];

const hudLabels = (app: App) => [...app.hud.root.querySelectorAll('.slot kbd')].map((k) => k.textContent ?? '');

export function registerGamepadScenarios(qa: QAHarness, game: Game, app: App): void {
  qa.add('pad.left_stick_moves_camera_relative', (c) => {
    for (const yaw of [0.7, -2.0]) {
      for (const [sx, sy, label] of [[0, -1, 'up'], [1, 0, 'right']] as const) {
        c.setup({ player: [0, 0], enemy: [0, -15] });
        withPad(game, app, (r) => {
          game.rig.yaw = yaw;
          r.pad.stick('left', sx, sy);
          const start = c.player.pos.clone();
          c.step(0.6, () => {
            r.frame();
            r.camera();
          });
          const d = c.player.pos.clone().sub(start).setY(0);
          const want = new THREE.Vector3();
          const fwd = new THREE.Vector3();
          game.rig.basis(fwd, want);
          if (label === 'up') want.copy(fwd);
          c.expect(d.length() > 2, `stick ${label} at yaw ${yaw}: moved only ${d.length().toFixed(2)} m`);
          const dot = d.normalize().dot(want);
          c.expect(dot > 0.97, `stick ${label} at yaw ${yaw}: moved off the camera-relative direction (dot=${dot.toFixed(3)})`);
        });
      }
    }
    // Analog: a 60% push walks at the shaped fraction of full speed.
    c.setup({ player: [0, -10], enemy: [-14, -10] });
    withPad(game, app, (r) => {
      r.pad.stick('left', 0, -0.6);
      c.step(0.4, () => r.frame());
      const a = c.player.pos.clone();
      c.step(1, () => r.frame());
      const expected = shapeStick(0, -0.6, G.deadzone.move, G.curve.move, { x: 0, y: 0 }) * W.moveSpeed;
      c.near(c.player.pos.distanceTo(a), expected, 0.15, 'analog m/s');
      // L3 held: sprint.
      r.pad.stick('left', 0, -1);
      r.pad.set('l3', 1);
      c.step(0.5, () => r.frame());
      const b = c.player.pos.clone();
      c.step(0.5, () => r.frame());
      c.near(c.player.pos.distanceTo(b) * 2, W.sprintSpeed, 0.25, 'L3 sprint m/s');
    });
  });

  qa.add('pad.right_stick_turns_camera', (c) => {
    c.setup({ player: [0, 0], enemy: [0, -15] });
    const rig = game.rig;
    withPad(game, app, (r) => {
      const frame = () => {
        r.frame();
        r.camera();
      };
      rig.yaw = 0;
      r.pad.stick('right', 1, 0);
      const y0 = rig.yaw;
      for (let i = 0; i < 15; i++) frame();
      const half = y0 - rig.yaw;
      for (let i = 0; i < 15; i++) frame();
      const turned = y0 - rig.yaw;
      c.expect(turned > 1.4 && turned < 2.5, `full right stick for 0.5 s turned ${turned.toFixed(2)} rad`);
      c.expect(turned - half > half * 1.1, `no turn acceleration (first ${half.toFixed(2)}, second ${(turned - half).toFixed(2)})`);
      c.note(`yaw 0.5s=${turned.toFixed(2)} rad`);

      r.pad.stick('right', 0, -1); // push up = look up
      const p0 = rig.pitch;
      for (let i = 0; i < 12; i++) frame();
      c.expect(rig.pitch - p0 > 0.25, `stick up raised pitch by only ${(rig.pitch - p0).toFixed(2)}`);

      game.playerController.applyPadSettings({ ...game.playerController.padSettings, padInvertY: true });
      const p1 = rig.pitch;
      for (let i = 0; i < 12; i++) frame();
      c.expect(rig.pitch < p1 - 0.25, `invert Y: stick up should lower pitch (${p1.toFixed(2)} -> ${rig.pitch.toFixed(2)})`);
    });
  });

  qa.add('pad.rt_holds_fire', (c) => {
    c.setup();
    withPad(game, app, (r) => {
      // Below the trigger threshold: nothing.
      r.pad.set('rt', G.deadzone.trigger * 0.6);
      c.step(0.5, () => {
        r.frame();
        r.camera();
      });
      c.expect(c.player.stats.casts === 0, `a resting finger on RT cast ${c.player.stats.casts} bolts`);
      r.pad.set('rt', 1);
      c.step(1, () => {
        r.frame();
        r.camera();
      });
      const casts = c.player.stats.casts;
      const expected = Math.floor(1 / CONFIG.spells.bolt.fireInterval) + 1;
      c.expect(Math.abs(casts - expected) <= 1, `RT held 1 s: ${casts} casts, expected ~${expected}`);
      c.expect(c.player.intent.holdBolt, 'holdBolt not set while RT is held');
      r.pad.set('rt', 0);
      c.step(0.5, () => r.frame());
      c.expect(c.player.stats.casts === casts, 'kept firing after RT was released');
      c.expect(!c.player.intent.holdBolt, 'holdBolt still set after release');
      c.note(`casts=${casts}`);
    });
  });

  qa.add('pad.buttons_map_to_actions', (c) => {
    c.setup();
    const intent = c.player.intent;
    withPad(game, app, (r) => {
      for (const [button, action] of ACTIONS) {
        intent.clear();
        r.pad.set(button, 1);
        r.frame();
        const lit = (Object.keys(intent.buffered) as ActionKey[]).filter((k) => intent.buffered[k] > 0);
        c.expect(lit.length === 1 && lit[0] === action, `${button} buffered [${lit.join(',')}], expected ${action}`);
        r.pad.set(button, 0);
        r.frame();
      }
      r.pad.set('l3', 1);
      r.pad.stick('left', 0, -1);
      r.frame();
      c.expect(intent.sprint, 'L3 held did not sprint');
      r.pad.releaseAll();
      r.frame();
      c.expect(!intent.sprint, 'sprint stuck after L3 release');
      r.pad.set('start', 1);
      r.frame();
      c.expect(r.gp.wasPressed(G.bindings.pause), 'Start not seen as the pause button');
      r.pad.releaseAll();
      r.frame();

      // Start toggles pause through App (exercised from the main menu by faking a running match).
      if (app.state === 'menu') {
        app.state = 'playing';
        try {
          const appFrame = () => r.frame(false, () => app.padFrame(DT));
          const state = (): string => app.state;
          r.pad.set('start', 1);
          appFrame();
          c.expect(state() === 'paused', `Start did not pause (state=${state()})`);
          appFrame();
          c.expect(state() === 'paused', 'held Start toggled pause again');
          r.pad.set('start', 0);
          appFrame();
          r.pad.set('start', 1);
          appFrame();
          c.expect(state() === 'playing', `Start did not resume (state=${state()})`);
          c.expect(game.simulating, 'resumed with a pad but the game still waits for pointer lock');
        } finally {
          app.state = 'menu';
          app.menus.showMain();
        }
      } else c.note(`pause toggle skipped (app state ${app.state})`);

      // Keyboard keeps working with a pad connected.
      intent.clear();
      window.dispatchEvent(new KeyboardEvent('keydown', { code: CONFIG.controls.shield[0] }));
      r.frame(); // the key went down between frames, as in the real loop
      window.dispatchEvent(new KeyboardEvent('keyup', { code: CONFIG.controls.shield[0] }));
      c.expect(intent.wants('shield'), 'keyboard Shield ignored while a pad is connected');
    });
  });

  qa.add('pad.held_button_does_not_retrigger', (c) => {
    c.setup({ player: [0, 3], enemy: [0, 12] });
    const intent = c.player.intent;
    withPad(game, app, (r) => {
      r.pad.set('b', 1);
      r.frame();
      c.expect(intent.wants('dodge'), 'B press not buffered');
      intent.consume('dodge');
      for (let i = 0; i < 10; i++) r.frame();
      c.expect(!intent.wants('dodge'), 'holding B re-buffered a dodge');
      // In the sim: two seconds of holding B is one roll, not one per cooldown.
      c.step(2, () => r.frame());
      c.expect(c.player.stats.dodges === 0, `held B rolled ${c.player.stats.dodges} times after the press was consumed`);
      r.pad.set('b', 0);
      r.frame();
      r.tap('b');
      c.step(W.dodge.duration + W.dodge.cooldown + 0.05, () => r.frame());
      r.pad.set('b', 1);
      c.step(2, () => r.frame());
      c.expect(c.player.stats.dodges === 2, `tap then hold should roll twice, rolled ${c.player.stats.dodges}`);
    });
  });

  qa.add('pad.deadzone_ignores_drift', (c) => {
    c.setup({ player: [0, 0], enemy: [0, -15] });
    withPad(game, app, (r) => {
      r.gp.setDevice('kbm');
      // Typical worn-stick drift, inside both radial deadzones.
      r.pad.stick('left', 0.1, -0.09);
      r.pad.stick('right', 0.07, 0.06);
      const yaw = game.rig.yaw;
      const pitch = game.rig.pitch;
      const start = c.player.pos.clone();
      c.step(1, () => r.frame());
      const moved = c.player.pos.distanceTo(start);
      c.expect(moved < 0.01, `drift moved the wizard ${moved.toFixed(3)} m`);
      c.expect(game.rig.yaw === yaw && game.rig.pitch === pitch, 'drift turned the camera');
      c.expect(r.gp.device === 'kbm', 'stick drift stole the active device from keyboard + mouse');
      // Radial, not per-axis: a diagonal just past the radius moves (an axial deadzone would not).
      r.pad.stick('left', 0.14, -0.14);
      c.step(0.5, () => r.frame());
      c.expect(c.player.pos.distanceTo(start) > 0.05, 'diagonal past the radial deadzone did not move');
    });
  });

  qa.add('pad.active_device_relabels_hud', (c) => {
    c.setup();
    const kbm = spellLabels('kbm', 'xbox');
    const gp = game.input.pad;
    withPad(game, app, (r) => {
      r.gp.setDevice('kbm');
      c.expect(hudLabels(app).join() === kbm.join(), `kbm labels: ${hudLabels(app).join()}`);
      r.tap('x', false);
      c.expect(r.gp.device === 'gamepad', 'pad press did not make the pad the active device');
      c.expect(hudLabels(app).join() === 'RT,LT,LB,RB,Y', `Xbox labels: ${hudLabels(app).join()}`);
      window.dispatchEvent(new MouseEvent('mousemove', { movementX: 6, movementY: 2 }));
      c.expect(r.gp.device === 'kbm', 'mouse movement did not switch back to keyboard + mouse');
      c.expect(hudLabels(app).join() === kbm.join(), `labels after mouse: ${hudLabels(app).join()}`);
      r.pad.id = DUALSENSE_ID;
      r.tap('x', false);
      c.expect(r.gp.style === 'playstation', `DualSense id detected as ${r.gp.style}`);
      c.expect(hudLabels(app).join() === 'R2,L2,L1,R1,△', `PlayStation labels: ${hudLabels(app).join()}`);
      c.expect(app.menus.padStyle === 'playstation', 'How to Play would show the wrong glyphs');
      c.note(hudLabels(app).join(' '));
    });
    const restored = spellLabels(gp.device, gp.style).join();
    c.expect(hudLabels(app).join() === restored, `labels not restored after the fake pad went away: ${hudLabels(app).join()}`);
  });

  qa.add('pad.menu_navigation', (c) => {
    // A throwaway screen: same structure the real menus mount, invisible.
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:420px;height:640px;opacity:0;pointer-events:none;z-index:-1';
    const box = document.createElement('div');
    box.style.cssText = 'position:absolute;inset:0';
    box.innerHTML = `
      <div class="menu-screen"><div class="menu-panel" style="display:grid;gap:10px;width:300px">
        <button id="t1" style="height:40px">One</button>
        <button id="t2" style="height:40px">Two</button>
        <div style="display:flex;gap:10px"><button id="l" style="flex:1;height:40px">L</button><button id="r" style="flex:1;height:40px">R</button></div>
        <input id="rng" type="range" min="0" max="2" step="0.1" value="0.5">
        <button id="go" class="primary" style="height:40px">Go</button>
        <button id="back" data-act="back" style="height:40px">Back</button>
      </div></div>`;
    host.appendChild(box);
    document.body.appendChild(host);
    const $ = (id: string) => box.querySelector<HTMLElement>(`#${id}`)!;
    const clicks: Record<string, number> = {};
    box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => (clicks[b.id] = (clicks[b.id] ?? 0) + 1)));
    let inputs = 0;
    $('rng').addEventListener('input', () => inputs++);
    let moves = 0;
    const nav = new MenuNav(box, () => moves++);
    try {
      withPad(game, app, (r) => {
        const step = () => r.frame(false, () => nav.update(r.gp, DT));
        const press = (b: PadButton) => {
          r.pad.set(b, 1);
          step();
          r.pad.set(b, 0);
          step();
        };
        const focused = () => (document.activeElement as HTMLElement | null)?.id ?? '';
        // The first press only wakes the pad: it focuses the primary button, it doesn't click it.
        r.pad.set('a', 1);
        step();
        c.expect(r.gp.device === 'gamepad', 'pad not active');
        c.expect(focused() === 'go', `auto-focus went to "${focused()}", expected the primary button`);
        r.pad.set('a', 0);
        step();
        c.expect(!clicks.go, 'the waking press also activated the button');
        c.expect(box.classList.contains('pad-nav'), 'no pad-nav class for the focus ring');

        press('up');
        c.expect(focused() === 'rng', `up from Go focused "${focused()}"`);
        press('right');
        c.expect(($('rng') as HTMLInputElement).value === '0.6' && inputs === 1, `slider right: value ${($('rng') as HTMLInputElement).value}, inputs ${inputs}`);
        // Held direction repeats after the delay.
        r.pad.set('right', 1);
        for (let t = 0; t < G.menu.repeatDelay + 2.5 * G.menu.repeatInterval; t += DT) step();
        r.pad.set('right', 0);
        step();
        const v = Number(($('rng') as HTMLInputElement).value);
        c.expect(v >= 0.85 && v <= 1.15, `held right: slider ${v}, expected 3 steps of repeat`);
        press('up');
        c.expect(focused() === 'l', `up from slider focused "${focused()}"`);
        press('right');
        c.expect(focused() === 'r', `right from L focused "${focused()}"`);
        press('up');
        c.expect(focused() === 't2', `up from R focused "${focused()}"`);
        press('up');
        press('up');
        c.expect(focused() === 'back', `up from the top should wrap to the bottom, got "${focused()}"`);
        press('down');
        c.expect(focused() === 't1', `down from the bottom should wrap to the top, got "${focused()}"`);
        // Left stick navigates too.
        r.pad.stick('left', 0, 0.9);
        step();
        r.pad.stick('left', 0, 0);
        step();
        c.expect(focused() === 't2', `left stick down focused "${focused()}"`);

        $('go').focus();
        r.pad.set('a', 1);
        for (let i = 0; i < 10; i++) step();
        r.pad.set('a', 0);
        step();
        c.expect(clicks.go === 1, `A held for 10 frames clicked ${clicks.go ?? 0} times`);
        press('b');
        c.expect(clicks.back === 1, 'B did not press Back');
        c.expect(moves > 5, `no hover feedback on focus moves (${moves})`);

        // The real menus: a fresh screen auto-focuses its primary button; the D-pad moves on.
        if (app.state === 'menu' && app.menus.visible) {
          (document.activeElement as HTMLElement | null)?.blur();
          app.menus.showMain();
          const appNav = () => r.frame(false, () => app.menus.nav.update(r.gp, DT));
          appNav();
          const primary = app.menus.root.querySelector('button.primary');
          c.expect(document.activeElement === primary, 'main menu did not focus Quick Duel');
          r.pad.set('up', 1);
          appNav();
          r.pad.set('up', 0);
          appNav();
          c.expect(!!(document.activeElement as HTMLElement | null)?.matches('.gauntlet-btn'), 'up from Quick Duel did not reach the Boss Gauntlet');
          (document.activeElement as HTMLElement | null)?.blur();
        } else c.note(`main menu check skipped (app state ${app.state})`);
      });
    } finally {
      host.remove();
    }
  });

  qa.add('pad.aim_assist_and_magnetism', (c) => {
    const rig = game.rig;
    const chest = new THREE.Vector3();
    const err = () => {
      c.enemy.chest(chest);
      const cam = rig.camera.position;
      return wrapAngle(Math.atan2(chest.x - cam.x, chest.z - cam.z) - rig.yaw);
    };
    /** Put the crosshair `deg` degrees to the side of the opponent, camera settled. */
    const offset = (r: PadRig, deg: number) => {
      rig.snap(c.player.pos, 0);
      for (let i = 0; i < 90; i++) r.camera();
      for (let i = 0; i < 4; i++) {
        rig.yaw += err() + THREE.MathUtils.degToRad(deg);
        r.camera();
      }
    };
    c.setup({ player: [0, -6], enemy: [0, 6] });
    withPad(game, app, (r) => {
      r.tap('a', false);
      const pc = game.playerController;
      // Magnetism: only with input, eases toward the target without snapping.
      for (const [assist, input] of [[1, true], [1, false], [0, true]] as const) {
        pc.applyPadSettings({ ...pc.padSettings, aimAssist: assist });
        offset(r, 4);
        const e0 = err();
        r.pad.stick('left', input ? 0.5 : 0, 0);
        for (let i = 0; i < 30; i++) {
          r.frame();
          r.camera();
        }
        r.pad.stick('left', 0, 0);
        const e1 = err();
        const deg = (x: number) => THREE.MathUtils.radToDeg(x).toFixed(2);
        if (assist > 0 && input) {
          c.expect(Math.abs(e1) < Math.abs(e0) * 0.9, `magnetism did not pull: ${deg(e0)}° -> ${deg(e1)}°`);
          c.expect(Math.abs(e1) > THREE.MathUtils.degToRad(0.3), `magnetism snapped (${deg(e1)}°): should be subtle`);
          c.note(`magnetism ${deg(e0)}° -> ${deg(e1)}° in 0.5 s`);
        } else {
          c.expect(Math.abs(e1 - e0) < 2e-3, `camera drifted ${deg(e1 - e0)}° (assist ${assist}, input ${input})`);
        }
      }
      // Wider bolt-assist cone with the pad: 8° off is outside the mouse cone, inside the pad cone.
      pc.applyPadSettings({ ...pc.padSettings, aimAssist: 1 });
      const miss = (device: 'kbm' | 'gamepad') => {
        r.gp.setDevice(device);
        offset(r, 8);
        r.frame();
        c.enemy.chest(chest);
        return c.player.aimPoint.distanceTo(chest);
      };
      const kbm = miss('kbm');
      const pad = miss('gamepad');
      c.expect(pad < kbm - 0.5, `pad aim assist cone not wider (aim miss kbm ${kbm.toFixed(2)} m, pad ${pad.toFixed(2)} m)`);
    });
  });

  qa.add('pad.rumble_on_hits', (c) => {
    c.setup();
    const saved = game.playerControl;
    const pc = game.playerController;
    const pad = new FakePad();
    try {
      withPad(game, app, (r) => {
        r.tap('a', false);
        game.playerControl = true;
        pc.applyPadSettings({ ...pc.padSettings, rumble: true });
        const hit = (target: typeof c.player, source: typeof c.player, amount: number) =>
          game.spells.dealDamage(target, source, amount, target.pos, 'bolt');
        hit(c.enemy, c.player, 4);
        c.expect(pad.rumbles.length === 0, 'a small hit dealt should not rumble');
        hit(c.enemy, c.player, 20);
        c.expect(pad.rumbles.length === 1, `big hit dealt: ${pad.rumbles.length} effects`);
        hit(c.player, c.enemy, 12);
        c.expect(pad.rumbles.length === 2, `damage taken: ${pad.rumbles.length} effects`);
        const fx = pad.rumbles[1];
        c.expect(fx.type === 'dual-rumble', `effect type ${fx.type}`);
        const p = fx.params;
        c.expect(p.strongMagnitude > 0 && p.strongMagnitude <= 1 && p.weakMagnitude > 0 && p.weakMagnitude <= 1 && p.duration > 0, `bad params ${JSON.stringify(p)}`);
        c.expect(p.strongMagnitude > pad.rumbles[0].params.strongMagnitude, 'getting hit should rumble harder than landing a hit');
        hit(c.enemy, c.player, 20);
        c.expect(pad.rumbles.length === 2, 'a weaker effect cut off a stronger one still playing');

        pc.applyPadSettings({ ...pc.padSettings, rumble: false });
        hit(c.player, c.enemy, 30);
        c.expect(pad.rumbles.length === 2, 'rumbled with vibration turned off');
        pc.applyPadSettings({ ...pc.padSettings, rumble: true });
        game.playerControl = false;
        hit(c.player, c.enemy, 30);
        c.expect(pad.rumbles.length === 2, 'rumbled during the attract-mode duel');
        game.playerControl = true;
        pad.vibrationActuator = null;
        hit(c.player, c.enemy, 30); // must not throw
        c.note(`effects=${pad.rumbles.length}`);
      }, pad);
    } finally {
      game.playerControl = saved;
    }
  });

  qa.add('pad.restores_navigator', (c) => {
    c.expect(!Object.prototype.hasOwnProperty.call(navigator, 'getGamepads'), 'navigator.getGamepads still overridden');
    c.expect(typeof navigator.getGamepads === 'function', 'navigator.getGamepads missing');
    c.expect(!game.input.pad.connected || game.input.pad.id !== XBOX_ID, 'fake pad still connected');
  });
}
