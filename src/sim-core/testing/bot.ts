/**
 * A scripted input source for tests, golden logs and size measurements: it plays one seat like a
 * busy human (strafes, bursts of held bolts, blasts, stuns, shields, rolls, jumps, turns its aim)
 * from the sim's own state and its own seeded PRNG. Not part of the server bundle.
 */
import { AIM_DIST } from '../wizard';
import { ONE, atan2, isqrt, len2 } from '../fixed';
import { Rng } from '../rng';
import type { SimInput } from '../wizard';
import type { SimWorld } from '../world';

export interface BotStyle {
  /** Chance per tick (Q16-free float, test only) of each press. */
  blast: number;
  stun: number;
  shield: number;
  dodge: number;
  jump: number;
  ult: number;
  /** Share of time holding bolt. */
  fire: number;
  /** Aim wobble (1/1024 turn). */
  wobble: number;
  /** Stand still (a dummy). */
  idle?: boolean;
  /** Walk into the fire ring. */
  suicidal?: boolean;
}

export const BUSY: BotStyle = { blast: 0.006, stun: 0.003, shield: 0.004, dodge: 0.006, jump: 0.004, ult: 0.01, fire: 0.6, wobble: 6 };
export const CALM: BotStyle = { blast: 0.002, stun: 0.001, shield: 0.002, dodge: 0.002, jump: 0.001, ult: 0.005, fire: 0.35, wobble: 3 };
export const DUMMY: BotStyle = { blast: 0, stun: 0, shield: 0, dodge: 0, jump: 0, ult: 0, fire: 0, wobble: 0, idle: true };

/** Quantize a world-space aim point (Q16) seen from `seat`'s chest into the input fields. */
export function quantizeAim(world: SimWorld, seat: number, x: number, y: number, z: number, out: SimInput): void {
  const w = world.wizards[seat];
  const dx = x - w.pos.x, dy = y - (w.pos.y + w.chestY), dz = z - w.pos.z;
  const h = len2(dx, dz);
  out.aimYaw = (atan2(dx, dz) >> 6) & 1023;
  let p = atan2(dy, h);
  if (p >= 32768) p -= 65536;
  out.aimPitch = Math.max(-256, Math.min(256, p >> 6));
  const d = isqrt(dx * dx + dy * dy + dz * dz);
  let best = 0;
  for (let k = 1; k < 32; k++) if (Math.abs(AIM_DIST[k] - d) < Math.abs(AIM_DIST[best] - d)) best = k;
  out.aimDist = best;
}

export class Bot {
  private readonly rng: Rng;
  private strafe = 1;
  private strafeLeft = 0;
  private burst = 0;
  private wob = 0;

  /** `style` for every round, or one per round (the last repeats). */
  constructor(seed: number, readonly seat: number, private readonly styles: BotStyle | BotStyle[]) {
    this.rng = new Rng(seed);
  }

  private style: BotStyle = DUMMY;

  private roll(p: number): boolean {
    return this.rng.next() / 4294967296 < p;
  }

  input(world: SimWorld): SimInput {
    const f: SimInput = { move: 0, held: 0, press: 0, facing: 0, aimYaw: 0, aimPitch: 0, aimDist: 0 };
    const list = this.styles instanceof Array ? this.styles : [this.styles];
    this.style = list[Math.min(list.length, world.match.round) - 1];
    const me = world.wizards[this.seat];
    const foe = world.wizards[this.seat === 0 ? 1 : 0];
    const dx = foe.pos.x - me.pos.x, dz = foe.pos.z - me.pos.z;
    const yaw = atan2(dx, dz);
    this.wob += this.rng.range(-this.style.wobble, this.style.wobble);
    this.wob = Math.max(-40, Math.min(40, this.wob));
    quantizeAim(world, this.seat, foe.pos.x, foe.pos.y + foe.chestY, foe.pos.z, f);
    f.aimYaw = (f.aimYaw + this.wob) & 1023;
    f.facing = f.aimYaw;
    if (this.style.idle) return f;
    if (this.style.suicidal) {
      // Run outward along +x into the fire.
      f.move = 1 + ((8 << 2) | 3);
      return f;
    }
    if (--this.strafeLeft <= 0) {
      this.strafe = this.roll(0.5) ? 1 : -1;
      this.strafeLeft = this.rng.range(30, 120);
    }
    const dist = len2(dx, dz);
    // Strafe around the foe, closing in or backing off to stay 8-15 m away.
    let dir = (yaw >> 6) / 1024 * 32;
    dir += this.strafe * 8;
    if (dist > 15 * ONE) dir -= this.strafe * 4;
    else if (dist < 8 * ONE) dir += this.strafe * 4;
    // Keep off the fire ring.
    if (len2(me.pos.x, me.pos.z) > 22 * ONE) dir = ((atan2(-me.pos.x, -me.pos.z) >> 6) / 1024) * 32;
    f.move = 1 + (((Math.round(dir) & 31) << 2) | 3);
    if (this.burst > 0) {
      this.burst--;
      f.held |= 1;
    } else if (this.roll(this.style.fire / 40)) this.burst = this.rng.range(20, 70);
    if (this.roll(0.002)) f.held |= 2;
    const s = this.style;
    if (this.roll(s.blast)) f.press |= 1 << 1;
    if (this.roll(s.stun)) f.press |= 1 << 3;
    if (this.roll(s.shield)) f.press |= 1 << 2;
    if (this.roll(s.dodge)) f.press |= 1 << 5;
    if (this.roll(s.jump)) f.press |= 1 << 6;
    if (me.ult >= 100 * ONE && this.roll(s.ult)) f.press |= 1 << 4;
    // Learned reward spells now and then (bits 7..11: carpet, pump, vape, lockon, breath).
    if (me.learned) for (let i = 0; i < 5; i++) if (me.knows(i) && this.roll(s.blast / 2)) f.press |= 1 << (7 + i);
    return f;
  }
}

