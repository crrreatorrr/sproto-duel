/**
 * Typing a short code (an online room code) with a controller, no keyboard: the D-pad / left
 * stick cycles the character under a cursor through a fixed alphabet and moves the cursor. Pure,
 * so MenuNav stays a thin DOM layer over it.
 */
export interface PadText {
  value: string;
  /** Character slot being edited, 0..min(value.length, maxLen - 1). */
  cursor: number;
}

/** next / prev: cycle the character under the cursor; left / right: move; delete: remove it. */
export type PadTextOp = 'next' | 'prev' | 'left' | 'right' | 'delete';

/** Start editing `value`: the cursor sits on the first empty slot (or the last one when full). */
export function startPadText(value: string, maxLen: number): PadText {
  const v = value.slice(0, maxLen);
  return { value: v, cursor: Math.max(0, Math.min(v.length, maxLen - 1)) };
}

export function editPadText(t: PadText, op: PadTextOp, chars: string, maxLen: number): PadText {
  const value = t.value.slice(0, maxLen);
  const cursor = Math.max(0, Math.min(t.cursor, value.length, maxLen - 1));
  const n = chars.length;
  switch (op) {
    case 'next':
    case 'prev': {
      if (n === 0 || maxLen <= 0) return { value, cursor };
      const cur = value[cursor];
      const i = cur === undefined ? -1 : chars.indexOf(cur.toUpperCase());
      // An empty slot (or a character outside the alphabet) starts from either end.
      const ch = i < 0 ? chars[op === 'next' ? 0 : n - 1] : chars[(i + (op === 'next' ? 1 : n - 1)) % n];
      return { value: value.slice(0, cursor) + ch + value.slice(cursor + 1), cursor };
    }
    case 'left':
      return { value, cursor: Math.max(0, cursor - 1) };
    case 'right':
      // Onto the next character, or the empty slot after the last one (never past the length cap).
      return { value, cursor: Math.min(cursor + 1, value.length, maxLen - 1) };
    case 'delete': {
      if (cursor < value.length) return { value: value.slice(0, cursor) + value.slice(cursor + 1), cursor };
      if (cursor === 0) return { value, cursor };
      // On the empty slot at the end: backspace.
      return { value: value.slice(0, cursor - 1), cursor: cursor - 1 };
    }
  }
}
