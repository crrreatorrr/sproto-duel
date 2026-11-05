import { imul } from './fixed';

/**
 * Two-lane FNV-1a over 32-bit words: a 64-bit state fingerprint printed as 16 hex digits.
 * Inputs are integers (Q16 values, counters, flags). Pure ES5.
 */
export class Hasher {
  private h1 = 0x811c9dc5 | 0;
  private h2 = 0x01000193 ^ 0x5bd1e995;

  /** Mix one integer (any safe integer; split into two 32-bit halves). */
  int(v: number): this {
    const lo = v | 0;
    const hi = Math.floor(v / 4294967296) | 0;
    this.word(lo);
    this.word(hi);
    return this;
  }

  bool(b: boolean): this {
    return this.word(b ? 1 : 0);
  }

  str(s: string): this {
    this.word(s.length);
    for (let i = 0; i < s.length; i++) this.word(s.charCodeAt(i));
    return this;
  }

  private word(w: number): this {
    for (let k = 0; k < 4; k++) {
      const byte = (w >>> (k * 8)) & 0xff;
      this.h1 = imul(this.h1 ^ byte, 0x01000193);
      this.h2 = imul(this.h2 ^ byte, 0x01000193) ^ (this.h1 >>> 13);
    }
    return this;
  }

  hex(): string {
    return hex8(this.h1) + hex8(this.h2);
  }
}

function hex8(v: number): string {
  const s = (v >>> 0).toString(16);
  return '00000000'.substr(0, 8 - s.length) + s;
}
