import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import {
  CONTROLS_STORAGE_KEY, DEADZONE_MAX, KEY_ACTIONS, PAD_ACTIONS, applyControlPrefs, bindKey, bindPad, clearKey,
  defaultControlPrefs, keyLabel, loadControlPrefs, sanitizeControlPrefs, saveControlPrefs,
} from './controlPrefs';

const K = CONFIG.controls as unknown as Record<string, string[]>;
const P = CONFIG.gamepad.bindings as unknown as Record<string, string[]>;

function memoryStorage(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  } as unknown as Storage & { data: Map<string, string> };
}

afterEach(() => applyControlPrefs(defaultControlPrefs()));

describe('controller settings: defaults', () => {
  it('match the shipped CONFIG layout', () => {
    const d = defaultControlPrefs();
    expect(d.keys.jump).toEqual(['Space', 'KeyF']);
    expect(d.keys.dodge).toEqual(['KeyC', '']);
    expect(d.keys.pause).toEqual(['Escape', 'KeyP']);
    expect(d.pad.ultimate).toEqual(['y']);
    expect(d.moveDeadzone).toBe(0.2);
    for (const a of KEY_ACTIONS) expect(d.keys[a].filter(Boolean)).toEqual(K[a]);
    for (const a of PAD_ACTIONS) expect(d.pad[a]).toEqual(P[a]);
  });
});

describe('controller settings: storage', () => {
  it('round-trips through its own localStorage key', () => {
    const store = memoryStorage();
    const r = bindKey(defaultControlPrefs(), 'jump', 0, 'KeyJ');
    if (!r.ok) throw new Error(r.reason);
    saveControlPrefs({ ...r.prefs, moveDeadzone: 0.3 }, store);
    expect([...store.data.keys()]).toEqual([CONTROLS_STORAGE_KEY]);
    const back = loadControlPrefs(store);
    expect(back.keys.jump).toEqual(['KeyJ', 'KeyF']);
    expect(back.moveDeadzone).toBe(0.3);
  });

  it('falls back to the defaults on broken or blocked storage', () => {
    const broken = memoryStorage();
    broken.setItem(CONTROLS_STORAGE_KEY, '{not json');
    expect(loadControlPrefs(broken)).toEqual(defaultControlPrefs());
    const blocked = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(loadControlPrefs(blocked)).toEqual(defaultControlPrefs());
    expect(() => saveControlPrefs(defaultControlPrefs(), blocked)).not.toThrow();
    expect(loadControlPrefs(null)).toEqual(defaultControlPrefs());
  });

  it('sanitizes saved data: reserved and duplicate keys, unknown buttons, Esc stays on pause, dead zone clamped', () => {
    const p = sanitizeControlPrefs({
      keys: { jump: ['KeyN', 'KeyF'], dodge: ['KeyF'], pause: ['KeyP', ''], bolt: ['<img>'], shield: 'KeyQ' },
      pad: { jump: ['home'], dodge: ['a'], bolt: ['zz'] },
      moveDeadzone: 9,
    });
    expect(p.keys.jump).toEqual(['', 'KeyF']); // N is the feedback key
    expect(p.keys.dodge.filter(Boolean)).toEqual(['KeyC']); // F taken by jump: back to its default
    expect(p.keys.pause).toEqual(['Escape', '']);
    expect(p.keys.bolt.filter(Boolean)).toEqual(['Digit1']);
    expect(p.keys.shield).toEqual(['KeyQ', 'Digit3']);
    expect(p.pad.dodge).toEqual(['a']);
    expect(p.pad.jump).toEqual([]);
    expect(p.pad.bolt).toEqual(['rt']);
    expect(p.moveDeadzone).toBe(DEADZONE_MAX);
    expect(sanitizeControlPrefs(null)).toEqual(defaultControlPrefs());
    expect(sanitizeControlPrefs('x')).toEqual(defaultControlPrefs());
  });
});

describe('controller settings: remapping', () => {
  it('a key in use swaps with the slot being bound', () => {
    const r = bindKey(defaultControlPrefs(), 'jump', 1, 'KeyC');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.prefs.keys.jump).toEqual(['Space', 'KeyC']);
    expect(r.prefs.keys.dodge).toEqual(['KeyF', '']);
    expect(r.swapped).toBe('dodge');
  });

  it('an empty slot takes a key from another action only when that action keeps one', () => {
    const d = defaultControlPrefs();
    const refused = bindKey(d, 'dodge', 1, 'KeyE'); // E is Stun's main key; Stun keeps 4
    expect(refused.ok && refused.prefs.keys.stun).toEqual(['', 'Digit4']);
    const only = bindKey(d, 'dodge', 1, 'KeyZ'); // Z is Magic Carpet's only key
    expect(only.ok).toBe(false);
    if (!only.ok) expect(only.reason).toMatch(/only key/);
  });

  it('refuses reserved keys and the locked Esc, swaps within one action', () => {
    const d = defaultControlPrefs();
    expect(bindKey(d, 'jump', 0, 'Escape').ok).toBe(false);
    expect(bindKey(d, 'jump', 0, 'KeyN').ok).toBe(false);
    expect(bindKey(d, 'pause', 0, 'KeyO').ok).toBe(false);
    const own = bindKey(d, 'jump', 0, 'KeyF');
    expect(own.ok && own.prefs.keys.jump).toEqual(['KeyF', 'Space']);
  });

  it('clears an alternate key but never the last one', () => {
    const d = defaultControlPrefs();
    const r = clearKey(d, 'jump', 1);
    expect(r.ok && r.prefs.keys.jump).toEqual(['Space', '']);
    expect(clearKey(d, 'dodge', 0).ok).toBe(false);
    expect(clearKey(d, 'pause', 0).ok).toBe(false);
  });

  it('pad buttons swap between actions; Home cannot be bound', () => {
    const r = bindPad(defaultControlPrefs(), 'ultimate', 'x');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.prefs.pad.ultimate).toEqual(['x']);
    expect(r.prefs.pad.breath).toEqual(['y']);
    expect(r.swapped).toBe('breath');
    expect(bindPad(defaultControlPrefs(), 'jump', 'home').ok).toBe(false);
  });

  it('applying writes the live layout into the existing CONFIG arrays (input layer only)', () => {
    const jump = K.jump;
    const ult = P.ultimate;
    const r = bindKey(defaultControlPrefs(), 'jump', 0, 'KeyJ');
    const s = r.ok ? bindPad(r.prefs, 'ultimate', 'x') : r;
    if (!s.ok) throw new Error('bind failed');
    applyControlPrefs({ ...s.prefs, moveDeadzone: 0.3 });
    expect(K.jump).toBe(jump);
    expect(K.jump).toEqual(['KeyJ', 'KeyF']);
    expect(P.ultimate).toBe(ult);
    expect(P.ultimate).toEqual(['x']);
    expect(P.breath).toEqual(['y']);
    expect(CONFIG.gamepad.deadzone.move).toBe(0.3);
    applyControlPrefs(defaultControlPrefs());
    expect(K.jump).toEqual(['Space', 'KeyF']);
    expect(CONFIG.gamepad.deadzone.move).toBe(0.2);
  });

  it('names keys for the screen', () => {
    expect(keyLabel('KeyW')).toBe('W');
    expect(keyLabel('Digit3')).toBe('3');
    expect(keyLabel('ArrowUp')).toBe('↑');
    expect(keyLabel('ShiftLeft')).toBe('L Shift');
    expect(keyLabel('Escape')).toBe('Esc');
  });
});
