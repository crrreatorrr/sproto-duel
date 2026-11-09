/**
 * Fuzz: random input logs (valid streams of random inputs, and random bytes) replay twice to the
 * same hash, and replay never throws.
 */
import { describe, expect, it } from 'vitest';
import { LOG_SCHEMA, SeatWriter, toBase64, type DuelLog } from './log';
import { replay } from './replay';
import { Rng } from './rng';
import type { SimInput } from './wizard';

const any = { anyVersion: true };
const RULES = ['online', 'versus', 'quick', 'gauntlet'] as const;
const BOSSES = ['sahil', 'obama', 'broccoli', 'agent', 'tinubu'];
const STAFFS = [null, 'duel_staff_sproto', 'duel_staff_momentum', 'duel_staff_moonward', 'duel_staff_nobu', 'duel_staff_fighters_might', 'duel_staff_alien_ray'];

/** A random but well-formed log: every tick carries facing and aim, so nothing the sim reads is missing. */
function randomLog(seed: number): DuelLog {
  const r = new Rng(seed);
  const rules = RULES[r.range(0, 3)];
  const seats = rules === 'online' || rules === 'versus' ? 2 : 1;
  const ticks = r.range(200, 2400);
  const writers: SeatWriter[] = [];
  for (let s = 0; s < seats; s++) {
    const w = new SeatWriter();
    let move = 0, held = 0;
    for (let t = 0; t < ticks; t++) {
      if (r.range(0, 30) === 0) move = r.range(0, 128);
      if (r.range(0, 60) === 0) held = r.range(0, 3);
      const f: SimInput = { move, held, press: r.range(0, 40) === 0 ? 1 << r.range(0, 11) : 0, facing: r.range(0, 1023), aimYaw: r.range(0, 1023), aimPitch: r.range(-256, 256), aimDist: r.range(0, 31) };
      w.push(f, true, true);
    }
    writers.push(w);
  }
  const log: DuelLog = {
    schema: LOG_SCHEMA, simVersion: 'any', seed: r.next() | 0, rules, staffs: [STAFFS[r.range(0, STAFFS.length - 1)], STAFFS[r.range(0, STAFFS.length - 1)]], ticks,
    inputs: writers.map((w) => w.encode()),
  };
  if (rules === 'gauntlet') log.bossId = BOSSES[r.range(0, 4)];
  return log;
}

describe('fuzz', () => {
  it('random logs replay deterministically and never throw', () => {
    for (let i = 0; i < 24; i++) {
      const log = randomLog(1000 + i);
      const a = replay(JSON.parse(JSON.stringify(log)), any);
      const b = replay(JSON.parse(JSON.stringify(log)), any);
      expect(a.endHash, `log ${i}`).toBe(b.endHash);
      expect(a.ok).toBe(b.ok);
      expect(a.ticks).toBe(b.ticks);
      // Every tick carries facing and aim, so unread ones are reported (ok:false), never a throw.
      expect(typeof a.error === 'string' || a.ok).toBe(true);
    }
  });

  it('random bytes as streams never throw', () => {
    const r = new Rng(9);
    for (let i = 0; i < 200; i++) {
      const bytes: number[] = [];
      for (let k = r.range(0, 200); k > 0; k--) bytes.push(r.range(0, 255));
      const log = { schema: 1, simVersion: 'any', seed: i, rules: 'online', staffs: [null, null], ticks: r.range(1, 3000), inputs: [toBase64(bytes), toBase64(bytes.slice().reverse())] };
      const res = replay(log as DuelLog, any);
      expect(res.ok).toBe(false);
      expect(typeof res.endHash).toBe('string');
    }
  });
});
