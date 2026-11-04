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
