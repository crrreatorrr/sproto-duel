import { describe, expect, it } from 'vitest';
import { emptyPose, SnapshotBuffer } from './SnapshotBuffer';
import type { Snapshot, WizardState } from './state';

const TICK = 1000 / 60;

function wiz(x: number, facing = 0): WizardState {
  return {
    pos: [x, 0, 0], vel: [0, 0], vy: 0, grounded: true, facing, health: 150, maxHealth: 150, mana: 100, manaBoost: 0, ult: 0,
    cd: [0, 0, 0, 0, 0, 0], stunTime: 0, shieldTime: 0, shieldAge: 0, dodgeTime: 0, iframes: 0, dodgeDir: [0, 0], cast: null,
    castPulse: 0, hitFlash: 0, burning: false, alive: true, sprinting: false, jumps: 0, landings: 0,
  };
}

function snap(tick: number, x: number, facing = 0, projectiles: Snapshot['projectiles'] = []): Snapshot {
  return {
    v: 1, tick, ack: -1, wizards: [wiz(x, facing), wiz(-x, facing)], projectiles,
    arena: { fireRadius: 27, pillars: [], tickets: [] },
    match: { phase: 'fight', round: 1, wins: [0, 0], timer: 60, phaseTime: 0, lastWinnerSeat: -1 },
  };
}

const make = () => new SnapshotBuffer({ interpDelayMs: 100, extrapolateMaxMs: 150, tickMs: TICK });

describe('SnapshotBuffer', () => {
  it('interpolates between the snapshots around render time', () => {
    const b = make();
    // Snapshots every 2 ticks (30 Hz), x advancing 1 m per snapshot, arriving 50 ms after host time.
    for (let i = 0; i < 10; i++) b.push(snap(i * 2, i), i * 2 * TICK + 50);
    const pose = emptyPose();
    // Local now = host 9 snapshots in (tick 18 = 300 ms) + 50 ms; render 100 ms behind = host 200 ms = tick 12 = x 6.
    expect(b.sampleWizard(0, 18 * TICK + 50, pose)).toBe(true);
    expect(pose.pos[0]).toBeCloseTo(6, 1);
    // Halfway between two snapshots.
    b.sampleWizard(0, 18 * TICK + 50 + TICK, pose);
    expect(pose.pos[0]).toBeCloseTo(6.5, 1);
    b.sampleWizard(1, 18 * TICK + 50, pose);
    expect(pose.pos[0]).toBeCloseTo(-6, 1);
  });

  it('wraps facing the short way', () => {
    const b = make();
    b.push(snap(0, 0, Math.PI * 2 - 0.1), 0);
    b.push(snap(2, 0, 0.1), 2 * TICK);
    const pose = emptyPose();
    b.sampleWizard(0, TICK + 100, pose);
    const d = Math.min(pose.facing, Math.PI * 2 - pose.facing);
    expect(d).toBeLessThan(0.02);
  });

  it('ignores out-of-order snapshots and survives jitter', () => {
    const b = make();
    expect(b.push(snap(4, 2), 100)).toBe(true);
    expect(b.push(snap(2, 1), 110)).toBe(false);
    expect(b.size).toBe(1);
    // A late packet does not move the clock estimate backwards.
    b.push(snap(6, 3), 6 * TICK + 200);
    expect(b.renderHostMs(1000)).toBeCloseTo(1000 - (100 - 4 * TICK) - 100, 0);
  });

  it('extrapolates projectiles, clamped', () => {
    const b = make();
    b.push(snap(0, 0, 0, [{ id: 1, kind: 'bolt', owner: 0, pos: [0, 1, 0], vel: [10, 0, 0], radius: 0.16, reflected: false, skin: 'orb' }]), 0);
    expect(b.extrapolatedProjectiles(50)[0].pos[0]).toBeCloseTo(0.5, 3);
    expect(b.extrapolatedProjectiles(5000)[0].pos[0]).toBeCloseTo(1.5, 3);
  });

  it('holds the newest when render time runs past it', () => {
    const b = make();
    b.push(snap(0, 0), 0);
    b.push(snap(2, 4), 2 * TICK);
    const pose = emptyPose();
    b.sampleWizard(0, 10_000, pose);
    expect(pose.pos[0]).toBe(4);
  });
});
