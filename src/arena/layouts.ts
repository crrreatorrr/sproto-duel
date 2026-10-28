import { CONFIG } from '../config';
import { PILLAR_SHAPE, type ObstacleShape } from './Pillar';

const A = CONFIG.arena;
const C = A.cubicles;

/**
 * How the destructible cover is arranged. 'rings' is the classic two rings of pillars
 * (CONFIG.arena.pillars); 'cubicles' is the office grid (CONFIG.arena.cubicles).
 */
export type ArenaLayout = 'rings' | 'cubicles';

export interface ObstacleSpot {
  x: number;
  z: number;
  shape: ObstacleShape;
}

const QUARTER = Math.PI / 2;

/**
 * Copies of a +x/+z quadrant entry in all four quadrants (points on an axis are not doubled). Yaw
 * mirrors with the position, so the layout is symmetric for both spawns.
 */
function mirrored(x: number, z: number, turn: number): { x: number; z: number; yaw: number }[] {
  const out: { x: number; z: number; yaw: number }[] = [];
  for (const sx of x === 0 ? [1] : [1, -1]) {
    for (const sz of z === 0 ? [1] : [1, -1]) {
      // Mirroring x maps yaw -> -yaw; mirroring z maps yaw -> pi - yaw.
      let yaw = turn * QUARTER;
      if (sx < 0) yaw = -yaw;
      if (sz < 0) yaw = Math.PI - yaw;
      out.push({ x: x * sx, z: z * sz, yaw });
    }
  }
  return out;
}

function boxShape(kind: ObstacleShape['kind'], d: { halfX: number; halfZ: number; height: number; stumpHeight: number; hp: number; cover: boolean }, yaw: number): ObstacleShape {
  return {
    kind, collider: 'box', radius: Math.min(d.halfX, d.halfZ), halfX: d.halfX, halfZ: d.halfZ, yaw,
    height: d.height, stumpHeight: d.stumpHeight, stumpScale: 1, hp: d.hp, cover: d.cover,
  };
}

/** Every obstacle of a layout, in a fixed order (index 0.. matches `Arena.pillars`). */
export function layoutSpots(layout: ArenaLayout): ObstacleSpot[] {
  const spots: ObstacleSpot[] = [];
  if (layout === 'rings') {
    for (const ring of A.pillars.rings) {
      for (let i = 0; i < ring.count; i++) {
        const a = ((i + ring.offset) / ring.count) * Math.PI * 2;
        spots.push({ x: Math.sin(a) * ring.radius, z: Math.cos(a) * ring.radius, shape: PILLAR_SHAPE });
      }
    }
    return spots;
  }
  const half = C.size / 2;
  const cubicle = { halfX: half, halfZ: half, height: C.height, stumpHeight: C.stumpHeight, hp: C.hp, cover: true };
  for (const q of C.quadrant) {
    for (const m of mirrored(q.x, q.z, q.turn)) spots.push({ x: m.x, z: m.z, shape: boxShape('cubicle', cubicle, m.yaw) });
  }
  for (const o of C.obstructions) {
    for (const m of mirrored(o.x, o.z, o.turn)) {
      if (o.kind === 'cooler') {
        const d = C.cooler;
        spots.push({
          x: m.x, z: m.z,
          shape: {
            kind: 'cooler', collider: 'cylinder', radius: d.radius, halfX: d.radius, halfZ: d.radius, yaw: m.yaw,
            height: d.height, stumpHeight: d.stumpHeight, stumpScale: 1, hp: d.hp, cover: d.cover,
          },
        });
      } else {
        spots.push({ x: m.x, z: m.z, shape: boxShape(o.kind, C[o.kind], m.yaw) });
      }
    }
  }
  return spots;
}
