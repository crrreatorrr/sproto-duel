import * as THREE from 'three';
import { CONFIG } from '../config';
import { feel } from '../core/feel';
import { clamp, damp, dampVec3 } from '../core/math';
import { GROUP, type Physics } from '../physics/Physics';

const C = CONFIG.camera;
const J = CONFIG.wizard.jump;


/**
 * Over-the-shoulder third-person camera. Mouse rotation is applied raw (no smoothing) so aim
 * feels crisp; only the follow position is smoothed. Shake is trauma-based (trauma^2).
 */
export class CameraRig {
  yaw = 0;
  pitch = -0.07;
  sensitivity = C.sensitivity;
  invertY = false;
  private readonly pivot = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private distance: number = C.distance;
  private shoulder: number = C.shoulder;
  private fovBoost = 0;
  private time = 0;
  /** Extra pull-back for cinematic moments (ultimate windup). Decays back to 0 on its own. */
  pullBack = 0;
  private pullBackTarget = 0;
  /** Menu mode: slow orbit around the arena instead of following the player. */
  orbit = false;
  private orbitAngle = 0.6;

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  /** Aim direction (camera forward). */
  getForward(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.forward);
  }

  /** Horizontal movement basis from the camera yaw. */
  basis(fwd: THREE.Vector3, right: THREE.Vector3): void {
    fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    right.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
  }

  rotate(dx: number, dy: number): void {
    this.yaw -= dx * this.sensitivity;
    this.pitch -= dy * this.sensitivity * (this.invertY ? -1 : 1);
    this.pitch = clamp(this.pitch, C.minPitch, C.maxPitch);
  }

  /** Point the camera at a target instantly (round start). */
  snap(target: THREE.Vector3, yaw: number): void {
    this.yaw = yaw;
    // Slightly downward so the crosshair sits on the opponent's chest at spawn distance.
    this.pitch = -0.07;
    this.pivot.set(target.x, target.y + C.height, target.z);
    this.distance = C.distance;
  }

  updateOrbit(dt: number): void {
    this.orbitAngle += dt * 0.07;
    const cam = this.camera;
    cam.position.set(Math.sin(this.orbitAngle) * 17, 6.5, Math.cos(this.orbitAngle) * 17);
    cam.lookAt(0, 1.6, 0);
    if (cam.fov !== C.fov) {
      cam.fov = C.fov;
      cam.updateProjectionMatrix();
    }
  }

  /** Briefly widen the view by `meters`. */
  kickBack(meters: number): void {
    this.pullBackTarget = Math.max(this.pullBackTarget, meters);
  }

  update(dt: number, target: THREE.Vector3, physics: Physics, sprinting: boolean, dodging: boolean): void {
    this.time += dt;
    this.pullBack = damp(this.pullBack, this.pullBackTarget, 10, dt);
    this.pullBackTarget = damp(this.pullBackTarget, 0, 1.6, dt);
    this.tmp.set(target.x, target.y + C.height, target.z);
    const lastY = this.pivot.y;
    dampVec3(this.pivot, this.tmp, C.followSharpness, dt);
    // Height has its own follow: rise lazily (a jump doesn't yank the crosshair off target, and
    // never trails more than cameraMaxLag), but drop with the player so landings never lag.
    const ty = this.tmp.y;
    this.pivot.y = ty > lastY ? Math.max(damp(lastY, ty, J.cameraRiseSharpness, dt), ty - J.cameraMaxLag) : ty;
    if (!Number.isFinite(this.pivot.x + this.pivot.y + this.pivot.z)) this.pivot.copy(this.tmp);

    const cp = Math.cos(this.pitch);
    this.forward.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    this.right.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));

    // Shoulder point, then pull back along -forward. Both legs are sphere casts (not rays) so the
    // near plane can never slice into a pillar the camera only just misses.
    const wantDist = C.distance + this.pullBack;
    const r = C.collisionRadius;
    this.desired.copy(this.right).multiplyScalar(C.shoulder);
    const sideHit = physics.sphereCast(this.pivot, this.desired, r, GROUP.WORLD);
    const allowedShoulder = sideHit ? Math.max(0, sideHit.distance - 0.02) : C.shoulder;
    // Snap inward (never sit inside geometry), ease back out (no sideways jolt when it clears).
    this.shoulder = allowedShoulder < this.shoulder ? allowedShoulder : damp(this.shoulder, allowedShoulder, 8, dt);
    const shoulder = this.tmp.copy(this.pivot).addScaledVector(this.right, this.shoulder);

    this.desired.copy(this.forward).multiplyScalar(-wantDist);
    const backHit = physics.sphereCast(shoulder, this.desired, r, GROUP.WORLD);
    // Never place the camera past the hit point, however close the obstacle is.
    const maxDist = backHit ? Math.max(0, backHit.distance - 0.02) : wantDist;
    // Pull in instantly when blocked, ease back out.
    this.distance = maxDist < this.distance ? maxDist : damp(this.distance, maxDist, 6, dt);
    this.desired.copy(this.forward).negate();

    const cam = this.camera;
    cam.position.copy(shoulder).addScaledVector(this.desired, this.distance);
    if (cam.position.y < 0.3) cam.position.y = 0.3;

    // Trauma shake (positional + roll), driven by smooth noise.
    const shake = feel.trauma * feel.trauma;
    const t = this.time * 38;
    const ox = (Math.sin(t * 1.1) + Math.sin(t * 2.3 + 1.7) * 0.5) * shake * C.maxShakeOffset;
    const oy = (Math.sin(t * 1.3 + 4.1) + Math.sin(t * 2.9) * 0.5) * shake * C.maxShakeOffset;
    cam.position.addScaledVector(this.right, ox);
    cam.position.y += oy;

    this.tmp.copy(cam.position).add(this.forward);
    cam.lookAt(this.tmp);
    cam.rotateZ((Math.sin(t * 0.9 + 2.2) + Math.sin(t * 1.9) * 0.5) * shake * C.maxShakeRoll);

    const boost = (sprinting ? C.sprintFovBoost : 0) + (dodging ? C.dodgeFovBoost : 0);
    this.fovBoost = damp(this.fovBoost, boost, 8, dt);
    const fov = C.fov + this.fovBoost;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }
}
