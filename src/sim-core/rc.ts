/**
 * An adaptive binary range coder (the LZMA scheme: 11-bit probabilities, shift-5 adaptation) for
 * the input log. Integer arithmetic only, so encoder and decoder agree on every engine; the server
 * bundle only ever decodes. `low` is kept in a plain number (up to 2^40), never in a bitwise op.
 */

const TOP = 16777216; // 2^24
const BITS = 11;
const ONE_P = 1 << BITS;
const MOVE = 5;

/** Probabilities for one 8-bit symbol (a bit tree). */
export class ByteModel {
  readonly p: number[] = [];
  constructor() {
    for (let i = 0; i < 256; i++) this.p.push(ONE_P >> 1);
  }
}

export class RangeEncoder {
  private low = 0;
  private range = 0xffffffff;
  private cache = 0;
  private cacheSize = 1;
  readonly out: number[] = [];

  bit(p: number[], i: number, bit: number): void {
    const bound = (this.range >>> BITS) * p[i];
    if (bit === 0) {
      this.range = bound;
      p[i] += (ONE_P - p[i]) >> MOVE;
    } else {
      this.low += bound;
      this.range -= bound;
      p[i] -= p[i] >> MOVE;
    }
    while (this.range < TOP) {
      this.range = this.range * 256;
      this.shiftLow();
    }
  }

  private shiftLow(): void {
    if (this.low < 0xff000000 || this.low >= 4294967296) {
      const carry = this.low >= 4294967296 ? 1 : 0;
      let temp = this.cache;
      do {
        this.out.push((temp + carry) & 255);
        temp = 255;
      } while (--this.cacheSize !== 0);
      this.cache = Math.floor((this.low % 4294967296) / TOP);
    }
    this.cacheSize++;
    this.low = (this.low % TOP) * 256;
  }

  /** Encode a byte with a bit-tree model. */
  byte(m: ByteModel, v: number): void {
    let ctx = 1;
    for (let k = 7; k >= 0; k--) {
      const b = (v >> k) & 1;
      this.bit(m.p, ctx, b);
      ctx = (ctx << 1) | b;
      if (ctx >= 256) ctx &= 255;
    }
  }

  finish(): number[] {
    for (let i = 0; i < 5; i++) this.shiftLow();
    return this.out;
  }
}

export class RangeDecoder {
  private range = 0xffffffff;
  private code = 0;
  private pos = 0;
  /** Bytes read past the end (a truncated stream). */
  overrun = 0;

  constructor(private readonly data: number[], start: number) {
    this.pos = start;
    for (let i = 0; i < 5; i++) this.code = (this.code * 256 + this.next()) % 4294967296;
  }

  private next(): number {
    if (this.pos < this.data.length) return this.data[this.pos++];
    this.overrun++;
    return 0;
  }

  bit(p: number[], i: number): number {
    const bound = (this.range >>> BITS) * p[i];
    let b: number;
    if (this.code < bound) {
      this.range = bound;
      p[i] += (ONE_P - p[i]) >> MOVE;
      b = 0;
    } else {
      this.code -= bound;
      this.range -= bound;
      p[i] -= p[i] >> MOVE;
      b = 1;
    }
    while (this.range < TOP) {
      this.range = this.range * 256;
      this.code = this.code * 256 + this.next();
    }
    return b;
  }

  byte(m: ByteModel): number {
    let ctx = 1, v = 0;
    for (let k = 7; k >= 0; k--) {
      const b = this.bit(m.p, ctx);
      v = (v << 1) | b;
      ctx = (ctx << 1) | b;
      if (ctx >= 256) ctx &= 255;
    }
    return v;
  }
}
