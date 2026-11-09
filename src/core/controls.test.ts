import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';

const K = CONFIG.controls;

/** Every gameplay key binding (the arrays in CONFIG.controls; `menu` is a separate context). */
function gameplayBindings(): [string, string[]][] {
  return Object.entries(K).filter((e): e is [string, string[]] => Array.isArray(e[1]));
}

describe('keyboard layout (Sproto keyboard convention)', () => {
  it('WASD and the arrows both move', () => {
    expect(K.forward).toEqual(['KeyW', 'ArrowUp']);
    expect(K.back).toEqual(['KeyS', 'ArrowDown']);
    expect(K.left).toEqual(['KeyA', 'ArrowLeft']);
    expect(K.right).toEqual(['KeyD', 'ArrowRight']);
  });
  it('Space jumps, Shift sprints, Esc / P pause; the roll has its own key', () => {
    expect(K.jump[0]).toBe('Space');
    expect(K.jump).toContain('KeyF');
    expect(K.sprint).toEqual(['ShiftLeft', 'ShiftRight']);
    expect(K.pause).toEqual(['Escape', 'KeyP']);
    expect(K.dodge).toEqual(['KeyC']);
    expect(K.dodge).not.toContain('Space');
  });
  it('no key does two gameplay actions', () => {
    const used = new Map<string, string>();
    for (const [action, codes] of gameplayBindings()) {
      for (const code of codes) {
        expect(used.get(code), `${code}: ${used.get(code)} and ${action}`).toBeUndefined();
        used.set(code, action);
      }
    }
  });
  it('the god-mode cheat key (9) is never a binding', () => {
    for (const [, codes] of gameplayBindings()) for (const c of CONFIG.debug.godCheatKeys) expect(codes).not.toContain(c);
  });
  it('menus: arrows and W / S move, Enter and Space confirm, Esc backs out', () => {
    expect(K.menu.up).toEqual(['ArrowUp', 'KeyW']);
    expect(K.menu.down).toEqual(['ArrowDown', 'KeyS']);
    expect(K.menu.confirm).toEqual(expect.arrayContaining(['Enter', 'Space']));
    expect(K.menu.back).toEqual(['Escape']);
  });
  it('the README controls table matches the bindings', () => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    expect(readme).toContain('| W A S D / arrows | Move |');
    expect(readme).toContain('| Space / F | Jump:');
    expect(readme).toContain('| C | Dodge roll');
    expect(readme).toContain('| Esc / P | Pause |');
  });
});
