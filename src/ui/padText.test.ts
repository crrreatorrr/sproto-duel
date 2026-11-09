// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { ROOM_ALPHABET, ROOM_CODE_LENGTH } from '../net/protocol';
import { ROOM_CODE_CHARS, ROOM_CODE_MAX } from './Menus';
import { editPadText, startPadText, type PadText, type PadTextOp } from './padText';

const CH = 'ABC';
const run = (t: PadText, ops: PadTextOp[], max = 4) => ops.reduce((s, op) => editPadText(s, op, CH, max), t);

describe('pad text entry', () => {
  it('starts on the first empty slot, or the last slot when full', () => {
    expect(startPadText('', 4)).toEqual({ value: '', cursor: 0 });
    expect(startPadText('AB', 4)).toEqual({ value: 'AB', cursor: 2 });
    expect(startPadText('ABCA', 4)).toEqual({ value: 'ABCA', cursor: 3 });
  });
  it('up / down cycle the character under the cursor and wrap around the alphabet', () => {
    const t = startPadText('', 4);
    expect(run(t, ['next'])).toEqual({ value: 'A', cursor: 0 });
    expect(run(t, ['prev'])).toEqual({ value: 'C', cursor: 0 });
    expect(run(t, ['next', 'next', 'next', 'next'])).toEqual({ value: 'A', cursor: 0 });
    expect(run(t, ['next', 'prev'])).toEqual({ value: 'C', cursor: 0 });
  });
  it('right moves onto the empty slot after the last character, never past the cap', () => {
    const t = startPadText('', 2);
    expect(run(t, ['right'], 2)).toEqual({ value: '', cursor: 0 });
    expect(run(t, ['next', 'right', 'next', 'right', 'right'], 2)).toEqual({ value: 'AA', cursor: 1 });
  });
  it('left / right edit in the middle; lowercase or foreign characters restart the cycle', () => {
    const t = run({ value: 'ab', cursor: 0 }, ['next', 'right', 'next']);
    expect(t).toEqual({ value: 'BC', cursor: 1 });
    expect(run({ value: 'Z', cursor: 0 }, ['next'])).toEqual({ value: 'A', cursor: 0 });
    expect(run({ value: 'ABC', cursor: 2 }, ['left', 'left', 'left'])).toEqual({ value: 'ABC', cursor: 0 });
  });
  it('delete removes the character under the cursor, or backspaces from the end', () => {
    expect(run({ value: 'ABC', cursor: 1 }, ['delete'])).toEqual({ value: 'AC', cursor: 1 });
    expect(run({ value: 'AB', cursor: 2 }, ['delete'])).toEqual({ value: 'A', cursor: 1 });
    expect(run({ value: '', cursor: 0 }, ['delete'])).toEqual({ value: '', cursor: 0 });
  });
  it('the menu room code alphabet matches the online protocol', () => {
    expect(ROOM_CODE_CHARS).toBe(ROOM_ALPHABET);
    expect(ROOM_CODE_MAX).toBe(ROOM_CODE_LENGTH);
  });
});
