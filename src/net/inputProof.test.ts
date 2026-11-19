import { describe, expect, it } from 'vitest';
import { GuestTickMap, InputDigest, digestFrames } from './inputProof';
import { packFrames, unpackFrames, type IntentFrame } from './intent';

const f = (tick: number, mx = 0, press = 0): IntentFrame => ({ tick, mx, mz: -5, facing: 1234, aim: [100, -20, 300], held: 1, press });

describe('InputDigest', () => {
  it('matches the server-side reference over relayed copies (repeats, any order)', () => {
    const d = new InputDigest();
    const sent: IntentFrame[] = [];
    for (let t = 0; t < 50; t++) {
      const frame = f(t, t % 7, t === 9 ? 64 : 0);
      d.add(frame);
      sent.push(frame);
    }
    // The server's view: INPUT messages of 4 frames every 2 ticks (each frame twice), through the
    // wire format, the messages out of order.
    const relayed: IntentFrame[] = [];
    for (let t = 1; t < 50; t += 2) relayed.unshift(...unpackFrames(packFrames(sent.slice(Math.max(0, t - 3), t + 1))));
    expect(digestFrames(relayed)).toEqual(d.value);
    expect(d.value.n).toBe(50);
    expect(d.value.first).toBe(0);
    expect(d.value.last).toBe(49);
    expect(d.value.fnv).toMatch(/^[0-9a-f]{8}$/);
  });

  it('changes when any frame does', () => {
    const a = digestFrames([f(0), f(1), f(2)]);
    expect(digestFrames([f(0), f(1, 1), f(2)])).not.toEqual(a);
    expect(digestFrames([f(0), f(1, 0, 1), f(2)])).not.toEqual(a);
    expect(digestFrames([f(0), f(2)])).not.toEqual(a);
  });

  it('hashes each tick once', () => {
    const d = new InputDigest();
    d.add(f(3));
    d.add(f(3, 9));
    d.add(f(2));
    expect(d.value).toEqual(digestFrames([f(3)]));
  });
});

describe('GuestTickMap', () => {
  it('stores runs and answers per sim tick', () => {
    const m = new GuestTickMap();
    for (let s = 0; s < 3; s++) m.record(s, -1);
    for (let s = 3; s < 10; s++) m.record(s, s - 3);
    m.record(10, -1);
    for (let s = 11; s < 15; s++) m.record(s, s - 3 + 1);
    expect(m.runs).toEqual([[0, -1, 3], [3, 0, 7], [10, -1, 1], [11, 9, 4]]);
    expect(m.at(1)).toBe(-1);
    expect(m.at(5)).toBe(2);
    expect(m.at(10)).toBe(-1);
    expect(m.at(14)).toBe(12);
    expect(m.at(15)).toBeNull();
  });
});
