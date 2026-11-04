import { describe, expect, it } from 'vitest';
import { decodeSnapshot, encodeSnapshot, SnapshotVersionError, type ProjectileState, type Snapshot, type WizardState } from './state';

function wizard(i: number): WizardState {
  return {
    pos: [3.217 * (i + 1), 0.6, -11.94], vel: [4.5, -2.25], vy: -3.3, grounded: false, facing: 5.1,
    health: 87.5, maxHealth: 150, mana: 42.3, manaBoost: 3.27, ult: 61.2,
    cd: [0.12, 2.4, 0, 6.5, 0.4, 0], stunTime: 0, shieldTime: 0.9, shieldAge: 0.11, dodgeTime: 0, iframes: 0.08,
    dodgeDir: [0.6, -0.8], cast: { spell: 'stun', elapsed: 0.21, duration: 0.45 }, castPulse: 0.5, hitFlash: 0.13,
    burning: true, alive: true, sprinting: true, jumps: 4, landings: 3,
    stats: { damageDealt: 412, casts: 51, hits: 27, perfects: 2, dodges: 6 },
  };
}

function projectile(id: number): ProjectileState {
  return { id, kind: id % 5 === 0 ? 'blast' : 'bolt', owner: id % 2, pos: [-12.34 + id, 1.21, 17.89 - id], vel: [-31.2, 0.4, 41.7], radius: id % 5 === 0 ? 0.5 : id % 4 === 0 ? 0.12 : 0.16, reflected: id % 7 === 0, skin: id % 3 ? 'orb' : 'phone' };
}

function typical(): Snapshot {
  return {
    v: 1, tick: 123457, ack: 123450,
    wizards: [wizard(0), wizard(1)],
    projectiles: Array.from({ length: 30 }, (_, i) => projectile(1000 + i)),
    arena: { fireRadius: 24.33, pillars: [500, 500, -1, 312, 500, 500, 87, 500, 500, -1, 500, 500], tickets: [{ id: 3, x: 4.2, z: -7.7, age: 3.1 }, { id: 4, x: -9.1, z: 2.2, age: 1.0 }, { id: 5, x: 0.5, z: 11.4, age: 0.2 }] },
    match: { phase: 'fight', round: 2, wins: [1, 0], timer: 41.37, phaseTime: 0, lastWinnerSeat: 0 },
  };
}

describe('snapshot codec', () => {
  it('round-trips within quantization', () => {
    const s = { ...typical(), tick: 123450 };
    const back = decodeSnapshot(JSON.parse(JSON.stringify(encodeSnapshot(s))));
    expect(back.tick).toBe(s.tick);
    expect(back.ack).toBe(s.ack);
    const a = s.wizards[1], b = back.wizards[1];
    for (let i = 0; i < 3; i++) expect(Math.abs(b.pos[i] - a.pos[i])).toBeLessThanOrEqual(0.005);
    expect(Math.abs(b.facing - a.facing)).toBeLessThan(1e-4);
    expect(b.health).toBeCloseTo(a.health, 1);
    expect(b.cd.map((x) => +x.toFixed(2))).toEqual(a.cd);
    expect(b.cast).toEqual(a.cast);
    expect(b.dodgeDir).toEqual(a.dodgeDir);
    expect([b.grounded, b.burning, b.alive, b.sprinting]).toEqual([a.grounded, a.burning, a.alive, a.sprinting]);
    expect(b.stats).toEqual(a.stats);
    expect([b.jumps, b.landings, b.hitFlash, b.castPulse]).toEqual([a.jumps, a.landings, a.hitFlash, a.castPulse]);
    const p = s.projectiles[0], q = back.projectiles[0];
    expect({ ...q, pos: 0, vel: 0 }).toEqual({ ...p, pos: 0, vel: 0 });
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(q.pos[i] - p.pos[i])).toBeLessThanOrEqual(0.005);
      expect(Math.abs(q.vel[i] - p.vel[i])).toBeLessThanOrEqual(0.05);
    }
    expect(back.projectiles.find((x) => x.id === 1001)?.reflected).toBe(true);
    expect(back.projectiles.find((x) => x.id === 1005)?.kind).toBe('blast');
    expect(back.projectiles.find((x) => x.id === 1004)?.radius).toBe(0.12);
    expect(back.projectiles.map((x) => x.id)).toEqual(s.projectiles.map((x) => x.id));
    expect(back.arena.pillars).toEqual(s.arena.pillars);
    expect(back.arena.tickets).toEqual(s.arena.tickets);
    expect(back.arena.fireRadius).toBeCloseTo(24.33, 2);
    expect(back.match).toEqual(s.match);
  });

  it('keeps a typical snapshot under 1.5 KB of JSON', () => {
    const bytes = JSON.stringify(encodeSnapshot(typical())).length;
    expect(bytes).toBeLessThan(1500);
  });

  it('sends stats now and then during a fight, always outside one', () => {
    expect(decodeSnapshot(encodeSnapshot(typical())).wizards[0].stats).toBeUndefined();
    const end = typical();
    end.match.phase = 'matchEnd';
    expect(decodeSnapshot(encodeSnapshot(end)).wizards[0].stats).toEqual(wizard(0).stats);
  });

  it('rejects another version and skips malformed entries', () => {
    expect(() => decodeSnapshot({ v: 99 })).toThrow(SnapshotVersionError);
    expect(() => decodeSnapshot(null)).toThrow(SnapshotVersionError);
    const enc = encodeSnapshot(typical()) as unknown as { p: unknown[]; w: unknown[] };
    enc.p.push(['x'], 5);
    enc.w.push([1, 2]);
    const back = decodeSnapshot(enc);
    expect(back.projectiles).toHaveLength(30);
    expect(back.wizards).toHaveLength(2);
  });
});
