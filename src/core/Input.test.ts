// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Input } from './Input';

describe('Input', () => {
  it('a key a menu already used (preventDefault) is held but not a fresh gameplay press', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const input = new Input(el);
    const used = (e: KeyboardEvent) => e.preventDefault();
    document.addEventListener('keydown', used);
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true }));
    } finally {
      document.removeEventListener('keydown', used);
    }
    expect(input.isDown(['Space'])).toBe(true);
    expect(input.wasPressed(['Space'])).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
    input.endFrame();
    // An ordinary press still counts.
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', cancelable: true }));
    expect(input.wasPressed(['Space'])).toBe(true);
  });
});
