import { describe, expect, it } from 'vitest';
import { assignDevices } from './assignDevices';
import { joinStep, newJoinState, p1PadOf, type JoinInput } from './versusJoin';

const idle = (pads: number[]): JoinInput => ({ pads, aHeld: [], bHeld: [] });
const a = (pads: number[], ...held: number[]): JoinInput => ({ pads, aHeld: held, bHeld: [] });
const b = (pads: number[], ...held: number[]): JoinInput => ({ pads, aHeld: [], bHeld: held });

describe('Local Versus join screen', () => {
  it('ignores the A still held from picking Local Versus', () => {
    const s = newJoinState();
    expect(joinStep(s, a([0], 0))).toBe('none');
    expect(joinStep(s, a([0], 0))).toBe('none');
    expect(s.p2).toBeNull();
    expect(joinStep(s, idle([0]))).toBe('none');
    expect(joinStep(s, a([0], 0))).toBe('joined');
    expect(s.p2).toBe(0);
  });
  it('one pad: it joins as P2, A again starts', () => {
    const s = newJoinState();
    joinStep(s, idle([0]));
    expect(joinStep(s, a([0], 0))).toBe('joined');
    expect(joinStep(s, a([0], 0))).toBe('none'); // still held
    joinStep(s, idle([0]));
    expect(joinStep(s, a([0], 0))).toBe('start');
    expect(assignDevices([0], true, s.p2!)).toEqual([{ keyboardMouse: true, pad: null }, { keyboardMouse: false, pad: 0 }]);
  });
  it('two pads: controller 1 is P1 and never takes P2\'s seat; controller 2 joins', () => {
    const s = newJoinState();
    joinStep(s, idle([0, 1]));
    expect(p1PadOf([1, 0])).toBe(0);
    expect(joinStep(s, a([0, 1], 0))).toBe('none');
    expect(s.p2).toBeNull();
    joinStep(s, idle([0, 1]));
    expect(joinStep(s, a([0, 1], 1))).toBe('joined');
    expect(assignDevices([0, 1], true, s.p2!)).toEqual([{ keyboardMouse: true, pad: 0 }, { keyboardMouse: false, pad: 1 }]);
    joinStep(s, idle([0, 1]));
    // Either player starts once P2 is in.
    expect(joinStep(s, a([0, 1], 0))).toBe('start');
  });
  it('B unjoins P2, then B again goes back; each press is one step', () => {
    const s = newJoinState();
    joinStep(s, idle([0, 1]));
    joinStep(s, a([0, 1], 1));
    joinStep(s, idle([0, 1]));
    expect(joinStep(s, b([0, 1], 1))).toBe('left');
    expect(s.p2).toBeNull();
    expect(joinStep(s, b([0, 1], 1))).toBe('none'); // held: not also "back"
    joinStep(s, idle([0, 1]));
    expect(joinStep(s, b([0, 1], 0))).toBe('back');
  });
  it('with no pad connected nothing happens', () => {
    const s = newJoinState();
    expect(joinStep(s, idle([]))).toBe('none');
    expect(p1PadOf([])).toBeNull();
  });
});
