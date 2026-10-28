import * as THREE from 'three';
import { CONFIG } from '../config';
import type { Input } from '../core/Input';
import { GROUP, type Physics } from '../physics/Physics';
import type { CameraRig } from '../camera/CameraRig';
import type { Wizard } from '../wizard/Wizard';

const K = CONFIG.controls;
const AIM_RANGE = 90;

/**
 * Turns keyboard + mouse into a WizardIntent. Runs once per rendered frame (not per physics
 * tick) so presses are never missed during hit-stop; actions are buffered on the intent.
 */
export class PlayerController {
  private readonly fwd = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly camFwd = new THREE.Vector3();
  private readonly toEnemy = new THREE.Vector3();
  private readonly enemyChest = new THREE.Vector3();

  constructor(
    private readonly input: Input,
    private readonly rig: CameraRig,
    private readonly wizard: Wizard,
    private readonly physics: Physics,
    private readonly getOpponent: () => Wizard | null,
  ) {}

  /** Mouse look. Runs even while the wizard is stunned/dead so the camera stays responsive. */
  look(): void {
    const d = this.input.consumeMouseDelta();
    this.rig.rotate(d.x, d.y);
  }

  update(): void {
    const w = this.wizard;
    const intent = w.intent;
    const input = this.input;

    this.rig.basis(this.fwd, this.right);
    const f = (input.isDown(K.forward) ? 1 : 0) - (input.isDown(K.back) ? 1 : 0);
    const r = (input.isDown(K.right) ? 1 : 0) - (input.isDown(K.left) ? 1 : 0);
    intent.move.set(0, 0, 0).addScaledVector(this.fwd, f).addScaledVector(this.right, r);
    if (intent.move.lengthSq() > 1) intent.move.normalize();
    intent.sprint = input.isDown(K.sprint);
    intent.facing = this.rig.yaw;

    intent.holdBolt = input.isMouseDown(K.mouseBolt) || input.isDown(K.bolt);
    if (input.wasMousePressed(K.mouseBolt) || input.wasPressed(K.bolt)) intent.press('bolt');
    if (input.wasMousePressed(K.mouseBlast) || input.wasPressed(K.blast)) intent.press('blast');
    if (input.wasPressed(K.shield)) intent.press('shield');
    if (input.wasPressed(K.stun)) intent.press('stun');
    if (input.wasPressed(K.ultimate)) intent.press('ultimate');
    if (input.wasPressed(K.dodge)) intent.press('dodge');
    if (input.wasPressed(K.jump)) intent.press('jump');

    this.updateAim();
  }

  /** Raycast through the crosshair; nudge toward the opponent inside the aim-assist cone. */
  private updateAim(): void {
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
    const cone = THREE.MathUtils.degToRad(CONFIG.camera.aimAssistDegrees);
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
