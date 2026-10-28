import * as THREE from 'three';
import { CONFIG } from '../config';
import type { Input } from '../core/Input';
import { clamp, wrapAngle } from '../core/math';
import { GROUP, type Physics } from '../physics/Physics';
import type { CameraRig } from '../camera/CameraRig';
import type { Wizard } from '../wizard/Wizard';

const K = CONFIG.controls;
const G = CONFIG.gamepad;
const PB = G.bindings;
const AA = G.aimAssist;
const AIM_RANGE = 90;

/** Controller options from the Settings screen. */
export interface PadSettings {
  /** Multiplier on CONFIG.gamepad.sensitivity. */
  padSensitivity: number;
  padInvertY: boolean;
  /** Multiplier on CONFIG.gamepad.aimAssist (0 = off). */
  aimAssist: number;
  rumble: boolean;
}

/**
 * Turns keyboard + mouse and gamepad into a WizardIntent. Both devices work at the same time.
 * Runs once per rendered frame (not per physics tick) so presses are never missed during
 * hit-stop; actions are buffered on the intent.
 */
export class PlayerController {
  private readonly fwd = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly camFwd = new THREE.Vector3();
  private readonly toEnemy = new THREE.Vector3();
  private readonly enemyChest = new THREE.Vector3();
  private padSensitivity = 1;
  private padInvertY = false;
  private aimAssist: number = AA.strength;
  /** Seconds the right stick has been held at the edge (turn acceleration). */
  private edgeTime = 0;
  /** 0..1: how close the crosshair is to the opponent, for look friction. */
  private onTarget = 0;
  private sprintLatched = false;

  constructor(
    private readonly input: Input,
    private readonly rig: CameraRig,
    private readonly wizard: Wizard,
    private readonly physics: Physics,
    private readonly getOpponent: () => Wizard | null,
  ) {}

  get padSettings(): PadSettings {
    return { padSensitivity: this.padSensitivity, padInvertY: this.padInvertY, aimAssist: this.aimAssist, rumble: this.input.pad.rumbleEnabled };
  }

  applyPadSettings(s: PadSettings): void {
    this.padSensitivity = s.padSensitivity;
    this.padInvertY = s.padInvertY;
    this.aimAssist = s.aimAssist;
    this.input.pad.rumbleEnabled = s.rumble;
  }

  /** Mouse + right-stick look. Runs even while the wizard is stunned/dead so the camera stays responsive. */
  look(): void {
    const d = this.input.consumeMouseDelta();
    this.rig.rotate(d.x, d.y);
    const pad = this.input.pad;
    pad.update();
    if (!this.input.enabled || !pad.connected) {
      this.edgeTime = 0;
      return;
    }
    const dt = pad.dt;
    const { x, y } = pad.look;
    // Turn acceleration: after a beat at the edge of the stick, ramp in extra yaw speed.
    const A = G.acceleration;
    this.edgeTime = Math.abs(x) >= A.threshold ? this.edgeTime + dt : 0;
    const ramp = clamp((this.edgeTime - A.delay) / A.rampTime, 0, 1);
    const s = this.padSensitivity;
    const friction = 1 - Math.min(0.9, AA.friction * this.aimAssist) * this.onTarget;
    const yawSpeed = (G.sensitivity.yaw * x + Math.sign(x) * A.extraYaw * ramp) * s * (ramp > 0 ? 1 : friction);
    const pitchSpeed = G.sensitivity.pitch * y * s * friction * (this.padInvertY ? -1 : 1);
    this.rig.yaw -= yawSpeed * dt;
    this.rig.pitch = clamp(this.rig.pitch - pitchSpeed * dt, CONFIG.camera.minPitch, CONFIG.camera.maxPitch);
    const moving = pad.move.x !== 0 || pad.move.y !== 0;
    this.magnetism(dt, pad.device === 'gamepad', moving || x !== 0 || y !== 0);
  }

  update(): void {
    const w = this.wizard;
    const intent = w.intent;
    const input = this.input;
    const pad = input.pad;
    pad.update();
    const usePad = input.enabled && pad.connected;

    this.rig.basis(this.fwd, this.right);
    let f = (input.isDown(K.forward) ? 1 : 0) - (input.isDown(K.back) ? 1 : 0);
    let r = (input.isDown(K.right) ? 1 : 0) - (input.isDown(K.left) ? 1 : 0);
    if (usePad) {
      // Analog: half a stick is half speed. Stick y is +down.
      f -= pad.move.y;
      r += pad.move.x;
    }
    intent.move.set(0, 0, 0).addScaledVector(this.fwd, f).addScaledVector(this.right, r);
    if (intent.move.lengthSq() > 1) intent.move.normalize();
    intent.sprint = input.isDown(K.sprint) || (usePad && this.padSprint());
    intent.facing = this.rig.yaw;

    const held = (b: readonly string[]) => usePad && pad.isDown(b);
    const tap = (b: readonly string[]) => usePad && pad.wasPressed(b);
    intent.holdBolt = input.isMouseDown(K.mouseBolt) || input.isDown(K.bolt) || held(PB.bolt);
    if (input.wasMousePressed(K.mouseBolt) || input.wasPressed(K.bolt) || tap(PB.bolt)) intent.press('bolt');
    if (input.wasMousePressed(K.mouseBlast) || input.wasPressed(K.blast) || tap(PB.blast)) intent.press('blast');
    if (input.wasPressed(K.shield) || tap(PB.shield)) intent.press('shield');
    if (input.wasPressed(K.stun) || tap(PB.stun)) intent.press('stun');
    if (input.wasPressed(K.ultimate) || tap(PB.ultimate)) intent.press('ultimate');
    if (input.wasPressed(K.dodge) || tap(PB.dodge)) intent.press('dodge');
    if (input.wasPressed(K.jump) || tap(PB.jump)) intent.press('jump');

    this.updateAim(usePad && pad.device === 'gamepad');
  }

  private padSprint(): boolean {
    const pad = this.input.pad;
    if (!G.sprintToggle) return pad.isDown(PB.sprint);
    if (pad.wasPressed(PB.sprint)) this.sprintLatched = !this.sprintLatched;
    if (Math.hypot(pad.move.x, pad.move.y) < 0.2) this.sprintLatched = false;
    return this.sprintLatched;
  }

  /**
   * Gamepad camera magnetism: inside a small cone around the crosshair, ease the view toward the
   * opponent's chest, strongest mid-cone and fading to nothing at the center and the edge. Only
   * while the player is moving or looking, so the camera never drifts on its own.
   */
  private magnetism(dt: number, padActive: boolean, hasInput: boolean): void {
    this.onTarget = 0;
    const enemy = this.getOpponent();
    if (!padActive || this.aimAssist <= 0 || !enemy || !enemy.alive || dt <= 0) return;
    const cam = this.rig.camera.position;
    enemy.chest(this.enemyChest);
    const dx = this.enemyChest.x - cam.x;
    const dy = this.enemyChest.y - cam.y;
    const dz = this.enemyChest.z - cam.z;
    const yawErr = wrapAngle(Math.atan2(dx, dz) - this.rig.yaw);
    const pitchErr = Math.atan2(dy, Math.hypot(dx, dz)) - this.rig.pitch;
    const err = Math.hypot(yawErr * Math.cos(this.rig.pitch), pitchErr);
    const cone = THREE.MathUtils.degToRad(AA.magnetismDegrees);
    if (err >= cone || !this.physics.lineOfSight(cam, this.enemyChest)) return;
    const t = 1 - err / cone;
    this.onTarget = t;
    if (!hasInput) return;
    const pull = 1 - Math.exp(-AA.magnetismRate * this.aimAssist * t * dt);
    this.rig.yaw += yawErr * pull;
    this.rig.pitch = clamp(this.rig.pitch + pitchErr * pull * AA.pitchScale, CONFIG.camera.minPitch, CONFIG.camera.maxPitch);
  }

  /** Aim-assist cone: wider with a gamepad, scaled by the Settings strength. */
  private aimCone(pad: boolean): number {
    const base = CONFIG.camera.aimAssistDegrees;
    const deg = pad ? base + (AA.coneDegrees - base) * this.aimAssist : base;
    return THREE.MathUtils.degToRad(Math.max(0, deg));
  }

  /** Raycast through the crosshair; nudge toward the opponent inside the aim-assist cone. */
  private updateAim(pad: boolean): void {
    const cam = this.rig.camera;
    const dir = this.rig.getForward(this.camFwd);
    const hit = this.physics.raycast(cam.position, dir, AIM_RANGE, GROUP.WORLD | GROUP.WIZARD | GROUP.GROUND, this.wizard.collider);
    const aim = this.wizard.aimPoint;
    if (hit) aim.copy(hit.point);
    else aim.copy(cam.position).addScaledVector(dir, AIM_RANGE);

    const enemy = this.getOpponent();
    if (!enemy || !enemy.alive) return;
    enemy.chest(this.enemyChest);
    this.toEnemy.subVectors(this.enemyChest, cam.position);
    const dist = this.toEnemy.length();
    this.toEnemy.divideScalar(dist);
    const angle = Math.acos(Math.min(1, this.toEnemy.dot(dir)));
    const cone = this.aimCone(pad);
    if (angle < cone && (!hit || hit.distance > dist - 1) && this.physics.lineOfSight(cam.position, this.enemyChest)) {
      // Lead assist: aim where the opponent will be when a bolt arrives, so on-target shots land.
      const travel = this.wizard.pos.distanceTo(enemy.pos) / CONFIG.spells.bolt.speed;
      this.enemyChest.addScaledVector(enemy.vel, travel);
      // Blend strength: full at the center of the cone, none at its edge.
      const t = 1 - angle / cone;
      aim.lerp(this.enemyChest, Math.min(1, t * 1.6));
    }
  }
}
