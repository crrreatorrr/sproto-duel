import { fx } from './fixed';
import type { MuzzleSet } from './wizard';

/** Muzzle points given as [forward, up, right] fractions of a look `height` m tall. */
export function muzzleSet(points: [number, number, number][], height: number, use?: Partial<Record<'bolt' | 'volley' | 'blast' | 'stun' | 'ultimate', number[]>>): MuzzleSet {
  const all: number[] = [];
  const pts = points.map((p, i) => {
    all.push(i);
    return { x: fx(-p[2] * height), y: fx(p[1] * height), z: fx(p[0] * height) };
  });
  const bolt = use && use.bolt ? use.bolt : all;
  return {
    points: pts,
    bolt,
    volley: use && use.volley ? use.volley : bolt,
    blast: use && use.blast ? use.blast : bolt,
    stun: use && use.stun ? use.stun : bolt,
    ultimate: use && use.ultimate ? use.ultimate : bolt,
  };
}

