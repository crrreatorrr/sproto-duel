import { describe, expect, it } from 'vitest';
import { assignDevices } from './assignDevices';

describe('assignDevices', () => {
  it('needs a pad', () => {
    expect(assignDevices([], true)).toBeNull();
  });
  it('one pad: P1 keyboard + mouse, P2 the pad', () => {
    expect(assignDevices([2], true)).toEqual([{ keyboardMouse: true, pad: null }, { keyboardMouse: false, pad: 2 }]);
  });
  it('two pads: P1 keyboard + mouse and the first, P2 the next', () => {
    expect(assignDevices([1, 0], true)).toEqual([{ keyboardMouse: true, pad: 0 }, { keyboardMouse: false, pad: 1 }]);
  });
  it('the pad that joined is P2', () => {
    expect(assignDevices([0, 1, 3], true, 0)).toEqual([{ keyboardMouse: true, pad: 1 }, { keyboardMouse: false, pad: 0 }]);
    expect(assignDevices([0], true, 5)).toEqual([{ keyboardMouse: true, pad: null }, { keyboardMouse: false, pad: 0 }]);
  });
  it('without keyboard + mouse each player needs a pad', () => {
    expect(assignDevices([0], false)).toBeNull();
    expect(assignDevices([0, 1], false)).toEqual([{ keyboardMouse: false, pad: 0 }, { keyboardMouse: false, pad: 1 }]);
  });
});
