import { Color, Vector3 } from 'three';
import { CONFIG } from '../config';

/**
 * Global "juice" state: hit-stop, slow motion, camera trauma and screen flash.
 * Gameplay pokes it; the game loop, camera and screen overlay read it.
 */
class Feel {
  hitStop = 0;
  slowMoScale = 1;
  slowMoTime = 0;
  trauma = 0;
  flash = 0;
  readonly flashColor = new Color(1, 1, 1);
  /** Position the camera cares about (the local player). Set by the game each frame. */
  readonly listener = new Vector3();
  /** The locally controlled wizard: hits it deals or takes shake at full strength. */
  local: object | null = null;
  private minorCooldown = 0;

  /** Hit-stop. Minor freezes (bolts) are rate-limited so sustained fire doesn't stutter. */
  freeze(ms: number, minor = false): void {
    if (minor) {
      if (this.minorCooldown > 0) return;
      this.minorCooldown = CONFIG.feel.minorHitStopCooldown;
    }
    this.hitStop = Math.max(this.hitStop, ms / 1000);
  }

  slowMo(scale: number, seconds: number): void {
    this.slowMoScale = Math.min(this.slowMoScale, scale);
    this.slowMoTime = Math.max(this.slowMoTime, seconds);
  }

  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Shake scaled by distance from the local player. */
  shakeAt(pos: Vector3, amount: number, radius = 18): void {
    const d = pos.distanceTo(this.listener);
    if (d < radius) this.shake(amount * (1 - d / radius));
  }

  screenFlash(color: number, strength: number): void {
    if (strength >= this.flash) this.flashColor.setHex(color);
    this.flash = Math.max(this.flash, strength);
  }

  /** Advance real-time effects. Returns the time scale for this frame (0 during hit-stop). */
  update(realDt: number): number {
    if (this.minorCooldown > 0) this.minorCooldown -= realDt;
    this.trauma = Math.max(0, this.trauma - CONFIG.camera.shakeDecay * realDt);
    this.flash = Math.max(0, this.flash - CONFIG.feel.flashDecay * realDt * Math.max(this.flash, 0.25));
    if (this.hitStop > 0) {
      this.hitStop -= realDt;
      return 0;
    }
    if (this.slowMoTime > 0) {
      this.slowMoTime -= realDt;
      if (this.slowMoTime <= 0) this.slowMoScale = 1;
      return this.slowMoScale;
    }
    return 1;
  }

  reset(): void {
    this.hitStop = 0;
    this.slowMoScale = 1;
    this.slowMoTime = 0;
    this.trauma = 0;
    this.flash = 0;
    this.minorCooldown = 0;
  }
}

export const feel = new Feel();
