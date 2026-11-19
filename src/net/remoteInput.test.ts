import { describe, expect, it } from 'vitest';
import type { IntentFrame } from './intent';
import { RemoteInputBuffer } from './RemoteInputBuffer';

const frame = (tick: number, press = 0, mx = 50): IntentFrame => ({ tick, mx, mz: 0, facing: 0, aim: [0, 0, 0], held: 1, press });
const buf = () => new RemoteInputBuffer({ delay: 2, maxLag: 30 });

describe('RemoteInputBuffer', () => {
  it('starts once delay frames are buffered, then plays in order', () => {
    const b = buf();
    expect(b.next()).toBeNull();
    b.push([frame(100)]);
    expect(b.next()).toBeNull();
    b.push([frame(101), frame(102)]);
    expect(b.next()?.tick).toBe(100);
    expect(b.next()?.tick).toBe(101);
    expect(b.next()?.tick).toBe(102);
    expect(b.lastApplied).toBe(102);
  });

  it('ignores duplicates from redundant resends', () => {
    const b = buf();
    b.push([frame(10, 1), frame(11)]);
    b.push([frame(10, 1), frame(11), frame(12), frame(13)]);
    const played = [b.next(), b.next(), b.next()].map((f) => f?.tick);
    expect(played).toEqual([10, 11, 12]);
    expect(b.next()?.tick).toBe(13);
  });

  it('holds movement but never repeats a press on underrun', () => {
    const b = buf();
    b.push([frame(1), frame(2, 4)]);
    expect(b.next()?.tick).toBe(1);
    expect(b.next()?.press).toBe(4);
    const hold = b.next();
    expect(hold?.press).toBe(0);
    expect(hold?.mx).toBe(50);
    expect(hold?.held).toBe(1);
    expect(b.underruns).toBe(1);
    expect(b.delay).toBe(3);
  });

  it('keeps a late press and merges skipped presses forward', () => {
    const b = buf();
    b.push([frame(1), frame(2)]);
    b.next(); // 1
    b.next(); // 2
    b.push([frame(4)]);
    b.next(); // underrun at 3
    b.push([frame(3, 8)]); // 3 shows up after the underrun: it still plays (playhead waited)
    expect(b.next()?.press).toBe(8);
    // A frame for a tick already played only gives its press to the next frame.
    b.push([frame(2, 16)]);
    expect(b.next()?.press).toBe(0); // tick 2 was seen already: its resend adds nothing
    b.push([frame(5), frame(6)]);
    const late = new RemoteInputBuffer({ delay: 2, maxLag: 30 });
    late.push([frame(1), frame(2)]);
    late.next();
    late.next();
    late.push([frame(4)]);
    late.next(); // underrun: playhead still 3
    late.push([frame(5)]);
    late.push([frame(3, 2)]);
    expect([late.next()?.tick, late.next()?.tick]).toEqual([3, 4]);
  });

  it('skips ahead on overrun without losing presses', () => {
    const b = buf();
    b.push([frame(0), frame(1)]);
    b.next();
    b.next();
    b.push([frame(2, 32), frame(3), frame(4), frame(5), frame(6), frame(7), frame(8)]);
    const f = b.next();
    expect(b.overruns).toBe(1);
    expect(f?.tick).toBe(3);
    expect(f!.press & 32).toBe(32);
  });

  it('clears held input when the peer drops', () => {
    const b = buf();
    b.push([frame(1), frame(2)]);
    b.next();
    b.next();
    b.clearHeld();
    const hold = b.next();
    expect([hold?.mx, hold?.held, hold?.press]).toEqual([0, 0, 0]);
  });
});

describe('RemoteInputBuffer catch-up', () => {
  const f = (tick: number, press = 0) => ({ tick, mx: 0, mz: 0, facing: 0, aim: [0, 0, 0] as [number, number, number], held: 0, press });

  it('jumps to the newest frames after an outage instead of crawling', () => {
    const b = new RemoteInputBuffer({ delay: 2, maxLag: 30 });
    b.push([f(0), f(1), f(2)]);
    for (let i = 0; i < 3; i++) b.next();
    // 2 s with nothing arriving: the host keeps ticking (holds).
    for (let i = 0; i < 120; i++) b.next();
    // Then the guest's frames land at once (a rejoin): an old press and a recent one.
    const late = [];
    for (let t = 3; t < 183; t++) late.push(f(t, t === 10 ? 1 : t === 170 ? 2 : 0));
    b.push(late);
    const out = b.next()!;
    expect(b.catchUps).toBe(1);
    // `delay` frames before the newest (the delay grew while the buffer ran dry).
    expect(out.tick).toBe(182 - b.delay + 1);
    // The press from 3 s ago does not fire; the one from 0.2 s ago does.
    expect(out.press).toBe(2);
    expect(b.lastApplied).toBe(out.tick);
  });

  it('a backlog without an outage (the host did not tick) still skips one frame per tick', () => {
    const b = new RemoteInputBuffer({ delay: 2, maxLag: 30 });
    const frames = [];
    for (let t = 0; t < 60; t++) frames.push(f(t, t === 5 ? 1 : 0));
    b.push(frames);
    let presses = 0;
    for (let x = b.next(); x; x = b.next()) {
      presses |= x.press;
      if (b.depth === 0) break;
    }
    expect(b.catchUps).toBe(0);
    expect(presses).toBe(1);
  });

  it('keeps skipping one frame per tick for a small backlog', () => {
    const b = new RemoteInputBuffer({ delay: 2, maxLag: 30 });
    const frames = [];
    for (let t = 0; t < 12; t++) frames.push(f(t));
    b.push(frames);
    b.next();
    expect(b.catchUps).toBe(0);
    expect(b.overruns).toBe(1);
  });

  it('reports idle holds after the peer left', () => {
    const b = new RemoteInputBuffer({ delay: 1, maxLag: 30 });
    b.push([f(0)]);
    b.next();
    expect(b.played).toBe(0);
    b.next();
    expect(b.played).toBe(-1);
    b.clearHeld();
    expect(b.next()!.mx).toBe(0);
    expect(b.played).toBe(-2);
    b.push([f(1)]);
    b.next();
    expect(b.played).toBe(1);
  });

  it('reset(keepAck) keeps the last acknowledged tick', () => {
    const b = new RemoteInputBuffer({ delay: 1, maxLag: 30 });
    b.push([f(5)]);
    b.next();
    expect(b.lastApplied).toBe(5);
    b.reset(true);
    expect(b.lastApplied).toBe(5);
    // Copies of frames already played (INPUT repeats the last few) are not played again.
    b.push([f(4, 1), f(5, 1), f(6), f(7)]);
    expect(b.next()!.tick).toBe(6);
    expect(b.next()!.press).toBe(0);
    expect(b.lastApplied).toBe(7);
    b.reset();
    expect(b.lastApplied).toBe(-1);
  });
});
