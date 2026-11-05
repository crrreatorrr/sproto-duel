/**
 * Seeded PRNG for the sim (sfc32: additions, xors and shifts on 32-bit ints only, so it is
 * bit-identical on every engine). The seed is part of the input log; the sim never reads any other
 * source of randomness.
 */
export class Rng {
  private a = 0;
  private b = 0;
  private c = 0;
  private d = 0;

  constructor(seed: number) {
    this.reseed(seed);
  }

  reseed(seed: number): void {
    this.a = 0x9e3779b9;
    this.b = 0x243f6a88;
    this.c = 0xb7e15162;
    this.d = seed | 0;
    for (let i = 0; i < 16; i++) this.next();
  }

  /** Next unsigned 32-bit integer. */
  next(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Integer in [lo, hi) (hi > lo; the span must stay below 2^21 for exactness). */
  int(lo: number, hi: number): number {
    return lo + Math.floor(((this.next() / 4294967296) * (hi - lo)));
  }

  /** Integer in [lo, hi], exact for spans up to 2^21 (TU and Q16 ranges used by the sim). */
  range(lo: number, hi: number): number {
    if (hi <= lo) return lo;
    return lo + Math.floor((this.next() * (hi - lo + 1)) / 4294967296);
  }

  /** Q16 fraction in [0, ONE). */
  frac(): number {
    return this.next() >>> 16;
  }

  /** True with probability p (Q16). */
  chance(p: number): boolean {
    return this.frac() < p;
  }

  state(): [number, number, number, number] {
    return [this.a, this.b, this.c, this.d];
  }
}
