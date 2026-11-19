import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import { ONE, TU, TURN } from '../sim-core/fixed';
import { SimWorld } from '../sim-core/world';
import type { SimWizard } from '../sim-core/wizard';
import { GuestPredictor, PredictionSmoother, frameToSimInput } from './GuestPredictor';
import { ACTION_BITS, quantizeAngle, type IntentFrame } from './intent';
import { RemoteInputBuffer } from './RemoteInputBuffer';
import { COOLDOWNS, decodeWizard, encodeWizard, type Snapshot, type WizardState } from './state';

const TAU = Math.PI * 2;
const N = CONFIG.net;

/** The host's sim wizard as the wire carries it (encoded and decoded, so quantized like a real snapshot). */
function wireState(w: SimWizard): WizardState {
  const s: WizardState = {
    pos: [w.pos.x / ONE, w.pos.y / ONE, w.pos.z / ONE],
    vel: [w.vel.x / ONE, w.vel.z / ONE],
    vy: w.vy / ONE,
    grounded: w.grounded,
    facing: (w.facing / TURN) * TAU,
    health: w.health / ONE,
    maxHealth: w.maxHealth / ONE,
    mana: w.mana / ONE,
    manaBoost: w.manaBoost / TU,
    ult: w.ult / ONE,
    cd: COOLDOWNS.map((_, i) => (w.cd[i] ?? 0) / TU),
    stunTime: w.stunTime / TU,
    shieldTime: w.shieldTime / TU,
    shieldAge: w.shieldAge / TU,
    dodgeTime: w.dodgeTime / TU,
    iframes: w.iframes / TU,
    dodgeDir: [w.dodgeDir.x / ONE, w.dodgeDir.z / ONE],
    cast: w.cast ? { spell: w.cast.spell, elapsed: w.cast.elapsed / TU, duration: w.cast.duration / TU } : null,
    castPulse: 0,
    hitFlash: 0,
    burning: w.burning,
    alive: w.alive,
    sprinting: w.sprinting,
    jumps: w.jumps,
    landings: w.landings,
  };
  return decodeWizard(encodeWizard(s, false))!;
}

/** Small deterministic PRNG for the scripted player and the lossy link. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

const DODGE = 1 << ACTION_BITS.indexOf('dodge');
const JUMP = 1 << ACTION_BITS.indexOf('jump');

/** A guest who walks, sprints, turns, jumps and dodges for `moveTicks`, then stands still. */
function script(seed: number, moveTicks: number) {
  const r = rng(seed);
  let dir = 0, sprint = false;
  return (tick: number): Omit<IntentFrame, 'tick'> => {
    if (tick >= moveTicks) return { mx: 0, mz: 0, facing: quantizeAngle(dir), aim: [0, 100, 0], held: 0, press: 0 };
    if (tick % 30 === 0) {
      dir = r() * TAU;
      sprint = r() < 0.4;
    }
    let press = 0;
    if (r() < 0.02) press |= JUMP;
    if (r() < 0.01) press |= DODGE;
    return {
      mx: Math.round(Math.sin(dir) * 127), mz: Math.round(Math.cos(dir) * 127), facing: quantizeAngle(dir),
      aim: [0, 100, 0], held: sprint ? 2 : 0, press,
    };
  };
}

interface LinkResult {
  /** Worst distance (m) between the prediction shown for frame t and the host's state after frame t. */
  maxError: number;
  /** Distance (m) between prediction and host once the guest has stood still for 2 s. */
  finalError: number;
  /** Frames the host played (acked). */
  acked: number;
}

/**
 * Host sim (SimWorld, online rules) and a guest predictor joined by a link `oneWayTicks` long each
 * way that drops `loss` of the packets. Inputs go out every 2 ticks with 4 frames (OnlineSession's
 * defaults), snapshots every snapEveryTicks; the host plays the guest through RemoteInputBuffer.
 */
function runLink(oneWayTicks: number, loss: number, seed = 7): LinkResult {
  const world = new SimWorld({ seed: 1234, rules: 'online', arena: 'moonlit', staffs: [null, null] });
  const guestSeat = 1 as const;
  const predictor = new GuestPredictor(guestSeat, 'moonlit');
  const buffer = new RemoteInputBuffer({ delay: N.inputDelayTicks, maxLag: N.maxInputLagTicks });
  const drop = rng(seed * 31 + 5);
  const play = script(seed, 60 * 8);
  const toHost: { at: number; frames: IntentFrame[] }[] = [];
  const toGuest: { at: number; snap: Snapshot }[] = [];
  const sent: IntentFrame[] = [];
  const predicted = new Map<number, [number, number, number]>();
  const pose = { pos: [0, 0, 0] as [number, number, number], vel: [0, 0] as [number, number], vy: 0, facing: 0, grounded: true, sprinting: false, dodging: false };
  let maxError = 0;
  let lastPlayed = -1;
  const total = 60 * 12;
  // The fight starts after the intro (2.4 s); the guest keeps sending through it.
  for (let t = 0; t < total; t++) {
    // Guest: snapshots that arrived, then this tick's frame.
    for (let i = toGuest.length - 1; i >= 0; i--) {
      if (toGuest[i].at > t) continue;
      predictor.reconcile(toGuest[i].snap);
      toGuest.splice(i, 1);
    }
    const frame: IntentFrame = { tick: t, ...play(t) };
    predictor.record(frame);
    if (predictor.ready) predicted.set(t, [...predictor.pose(pose).pos]);
    sent.push(frame);
    if (sent.length > 4) sent.shift();
    if (t % 2 === 1 && drop() >= loss) toHost.push({ at: t + oneWayTicks, frames: sent.map((f) => ({ ...f })) });

    // Host: arrived inputs, one frame played, one sim step, a snapshot every snapEveryTicks.
    for (let i = toHost.length - 1; i >= 0; i--) {
      if (toHost[i].at > t) continue;
      buffer.push(toHost[i].frames);
      toHost.splice(i, 1);
    }
    const f = buffer.next();
    world.step([null, f ? frameToSimInput(f, { move: 0, held: 0, press: 0, facing: 0, aimYaw: 0, aimPitch: 0, aimDist: 0 }) : null]);
    if (buffer.lastApplied !== lastPlayed && f) {
      lastPlayed = buffer.lastApplied;
      const host = world.wizards[guestSeat].pos;
      const p = predicted.get(lastPlayed);
      // Only judge frames played in step (an underrun's hold, or a skip, plays a different tick).
      if (p && world.match.phase === 'fight' && buffer.underruns === 0 && buffer.overruns === 0) {
        maxError = Math.max(maxError, Math.hypot(p[0] - host.x / ONE, p[2] - host.z / ONE));
      }
    }
    if (world.tick % N.snapEveryTicks === 0 && drop() >= loss) {
      const snap: Snapshot = {
        v: 1, tick: world.tick, ack: buffer.lastApplied,
        wizards: world.wizards.map(wireState),
        projectiles: [],
        arena: { fireRadius: world.arena.fireRadius / ONE, pillars: world.arena.obstacles.map((o) => (o.alive ? o.hp / ONE : -1)), tickets: [] },
        match: { phase: world.match.phase, round: world.match.round, wins: world.match.wins, timer: world.match.timer / TU, phaseTime: world.match.phaseTime / TU, lastWinnerSeat: -1 },
      };
      toGuest.push({ at: t + oneWayTicks, snap });
    }
  }
  const host = world.wizards[guestSeat].pos;
  predictor.pose(pose);
  const finalError = Math.hypot(pose.pos[0] - host.x / ONE, pose.pos[1] - host.y / ONE, pose.pos[2] - host.z / ONE);
  return { maxError, finalError, acked: lastPlayed };
}

describe('GuestPredictor', () => {
  it('builds the same sim input the host does from a frame', () => {
    const out = frameToSimInput({ tick: 3, mx: 127, mz: 0, facing: quantizeAngle(Math.PI / 2), aim: [0, 0, 0], held: 2, press: JUMP }, { move: 0, held: 0, press: 0, facing: 0, aimYaw: 0, aimPitch: 0, aimDist: 0 });
    // East (+x) at full speed: direction 8 of 32, magnitude 4/4.
    expect(out.move).toBe(1 + ((8 << 2) | 3));
    expect(out.held).toBe(2);
    expect(out.press).toBe(JUMP);
    expect(out.facing).toBe(256);
  });

  for (const [label, oneWay] of [['0 ms', 0], ['60 ms', 2], ['150 ms', 5]] as const) {
    it(`tracks the host with no drift at ${label} RTT`, () => {
      const r = runLink(oneWay, 0);
      if (process.env.PRED_REPORT) console.log(`report ${label} loss 0: max ${r.maxError.toFixed(4)} final ${r.finalError.toFixed(4)} acked ${r.acked}`);
      expect(r.acked).toBeGreaterThan(600);
      // Quantization only (snapshots carry centimetres).
      expect(r.maxError).toBeLessThan(0.04);
      expect(r.finalError).toBeLessThan(0.01);
    });
    it(`converges after 5% packet loss at ${label} RTT`, () => {
      const r = runLink(oneWay, 0.05, 11);
      if (process.env.PRED_REPORT) console.log(`report ${label} loss 5%: max ${r.maxError.toFixed(4)} final ${r.finalError.toFixed(4)} acked ${r.acked}`);
      expect(r.acked).toBeGreaterThan(600);
      expect(r.finalError).toBeLessThan(0.01);
    });
  }

  it('drops acknowledged frames and caps the replay', () => {
    const p = new GuestPredictor(0, 'moonlit', { maxReplay: 5 });
    const snap = (ack: number): Snapshot => ({
      v: 1, tick: ack, ack,
      wizards: [wireState(new SimWorld({ seed: 1, rules: 'online', arena: 'moonlit', staffs: [null, null] }).wizards[0])],
      projectiles: [], arena: { fireRadius: 27.8, pillars: [], tickets: [] },
      match: { phase: 'fight', round: 1, wins: [0, 0], timer: 0, phaseTime: 0, lastWinnerSeat: -1 },
    });
    for (let t = 0; t < 20; t++) p.record({ tick: t, mx: 127, mz: 0, facing: 0, aim: [0, 0, 0], held: 0, press: 0 });
    expect(p.ready).toBe(false);
    expect(p.reconcile(snap(17))).toBe(true);
    expect(p.pending).toBe(2);
    expect(p.lastReplay).toBe(2);
    p.reconcile(snap(3));
    // 16 newer than ack 3 were left; 5 are kept and replayed.
    expect(p.lastReplay).toBeLessThanOrEqual(5);
    p.reset();
    expect(p.ready).toBe(false);
    expect(p.pending).toBe(0);
  });
});

describe('PredictionSmoother', () => {
  it('eases a small correction away and snaps a large one', () => {
    const s = new PredictionSmoother(90, 2);
    s.correct([1, 0, 0], [1.3, 0, 0]);
    expect(s.offset[0]).toBeCloseTo(-0.3);
    s.decay(90);
    expect(s.offset[0]).toBeCloseTo(-0.3 * Math.exp(-1));
    for (let i = 0; i < 20; i++) s.decay(50);
    expect(s.offset[0]).toBe(0);
    s.correct([0, 0, 0], [5, 0, 0]);
    expect(s.offset).toEqual([0, 0, 0]);
  });
});
