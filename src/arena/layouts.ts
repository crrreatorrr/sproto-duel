import { CONFIG, type ColliderPartDef, type LayoutDef, type ObstacleDef } from '../config';
import { PILLAR_SHAPE, type ColliderPart, type ObstacleKind, type ObstacleShape } from './Pillar';

const A = CONFIG.arena;
const C = A.cubicles;

/**
 * How an arena's cover is arranged. 'rings' is the classic two rings of pillars
 * (CONFIG.arena.pillars), 'cubicles' the office grid (CONFIG.arena.cubicles); the rest are the
 * boss arenas in CONFIG.arena.layouts.
 */
export type ArenaLayout = 'rings' | 'cubicles' | keyof typeof A.layouts;

/** A moving obstacle's rail, in world space. */
export interface MoverDef {
  axis: 'x' | 'z';
  /** Rail centre and half length (m). */
  cx: number;
  cz: number;
  half: number;
  speed: number;
  /** Start position along the rail, -1..1, and the first direction of travel. */
  start: number;
  dir: 1 | -1;
}

export interface ObstacleSpot {
  x: number;
  z: number;
  shape: ObstacleShape;
  mover?: MoverDef;
}

export interface SoftZone {
  /** Anchor the cloud drifts around. */
  x: number;
  z: number;
  radius: number;
  height: number;
  drift: number;
  period: number;
  phase: number;
}

export interface Hazard {
  x: number;
  z: number;
  radius: number;
}

const QUARTER = Math.PI / 2;

/** Copies of a +x/+z entry: 'quad' in all four quadrants (axis points not doubled), 'point' at (x, z) and (-x, -z). */
function mirrored(x: number, z: number, yaw: number, mode: 'quad' | 'point' | 'x' | 'z' | 'none'): { x: number; z: number; yaw: number; sign: 1 | -1 }[] {
  if (mode === 'none') return [{ x, z, yaw, sign: 1 }];
  if (mode === 'point') {
    const out: { x: number; z: number; yaw: number; sign: 1 | -1 }[] = [{ x, z, yaw, sign: 1 }];
    if (x !== 0 || z !== 0) out.push({ x: -x, z: -z, yaw: yaw + Math.PI, sign: -1 });
    return out;
  }
  const out: { x: number; z: number; yaw: number; sign: 1 | -1 }[] = [];
  for (const sx of x === 0 || mode === 'z' ? [1] : [1, -1]) {
    for (const sz of z === 0 || mode === 'x' ? [1] : [1, -1]) {
      // Mirroring x maps yaw -> -yaw; mirroring z maps yaw -> pi - yaw.
      let y = yaw;
      if (sx < 0) y = -y;
      if (sz < 0) y = Math.PI - y;
      out.push({ x: x * sx, z: z * sz, yaw: y, sign: (sx * sz) as 1 | -1 });
    }
  }
  return out;
}

function part(p: ColliderPartDef): ColliderPart {
  const box = p.shape === 'box';
  const r = p.radius ?? Math.min(p.halfX ?? 0.5, p.halfZ ?? 0.5);
  return {
    shape: p.shape, x: p.x ?? 0, z: p.z ?? 0,
    halfX: box ? p.halfX ?? 0.5 : r, halfZ: box ? p.halfZ ?? 0.5 : r, radius: r,
    yaw: p.yaw ?? 0, y0: p.y0 ?? 0, height: p.height,
  };
}

/** Build an obstacle shape from a type, turned by `yaw`, optionally with its height overridden. */
export function shapeFrom(kind: ObstacleKind, def: ObstacleDef, yaw: number, height?: number): ObstacleShape {
  const parts = def.parts.map((p) => part(height !== undefined && def.parts.length === 1 ? { ...p, height } : p));
  // Bounds of the whole collider in its own frame (for model fits and quick checks).
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, top = 0;
  for (const p of parts) {
    const ex = p.shape === 'box' ? Math.abs(Math.cos(p.yaw)) * p.halfX + Math.abs(Math.sin(p.yaw)) * p.halfZ : p.radius;
    const ez = p.shape === 'box' ? Math.abs(Math.sin(p.yaw)) * p.halfX + Math.abs(Math.cos(p.yaw)) * p.halfZ : p.radius;
    x0 = Math.min(x0, p.x - ex);
    x1 = Math.max(x1, p.x + ex);
    z0 = Math.min(z0, p.z - ez);
    z1 = Math.max(z1, p.z + ez);
    top = Math.max(top, p.height);
  }
  const hx = (x1 - x0) / 2, hz = (z1 - z0) / 2;
  const single = parts.length === 1 && parts[0].x === 0 && parts[0].z === 0 && parts[0].yaw === 0 && parts[0].y0 === 0;
  return {
    kind,
    collider: single ? parts[0].shape : 'compound',
    parts,
    radius: single && parts[0].shape === 'cylinder' ? parts[0].radius : Math.min(hx, hz),
    halfX: hx,
    halfZ: hz,
    cx: (x0 + x1) / 2,
    cz: (z0 + z1) / 2,
    yaw,
    height: top,
    stumpHeight: def.stumpHeight,
    stumpScale: 1,
    hp: def.hp,
    cover: def.cover,
    destructible: def.hp > 0,
    seeThrough: !!def.seeThrough,
    shadow: def.shadow ?? false,
    variant: 0,
  };
}

const OFFICE_DEFS: Record<'cubicle' | 'cabinet' | 'copier' | 'cooler' | 'glass', ObstacleDef> = {
  cubicle: { parts: [{ shape: 'box', halfX: C.size / 2, halfZ: C.size / 2, height: C.height }], hp: C.hp, stumpHeight: C.stumpHeight, cover: true, shadow: true },
  cabinet: { parts: [{ shape: 'box', halfX: C.cabinet.halfX, halfZ: C.cabinet.halfZ, height: C.cabinet.height }], hp: C.cabinet.hp, stumpHeight: C.cabinet.stumpHeight, cover: C.cabinet.cover, shadow: true },
  copier: { parts: [{ shape: 'box', halfX: C.copier.halfX, halfZ: C.copier.halfZ, height: C.copier.height }], hp: C.copier.hp, stumpHeight: C.copier.stumpHeight, cover: C.copier.cover, shadow: true },
  cooler: { parts: [{ shape: 'cylinder', radius: C.cooler.radius, height: C.cooler.height }], hp: C.cooler.hp, stumpHeight: C.cooler.stumpHeight, cover: C.cooler.cover, shadow: true },
  glass: { parts: [{ shape: 'box', halfX: C.glass.halfX, halfZ: C.glass.halfZ, height: C.glass.height }], hp: C.glass.hp, stumpHeight: C.glass.stumpHeight, cover: C.glass.cover, seeThrough: true },
};

/** The type of a layout entry's kind ('pillar' uses CONFIG.arena.pillars). */
function defOf(kind: string): ObstacleDef | null {
  if (kind in OFFICE_DEFS) return OFFICE_DEFS[kind as keyof typeof OFFICE_DEFS];
  return (A.obstacles as Record<string, ObstacleDef>)[kind] ?? null;
}

function layoutDef(layout: ArenaLayout): LayoutDef {
  if (layout === 'cubicles') {
    return {
      entries: [
        ...C.quadrant.map((q) => ({ kind: 'cubicle', x: q.x, z: q.z, turn: q.turn })),
        ...C.obstructions.map((o) => ({ kind: o.kind, x: o.x, z: o.z, turn: o.turn })),
      ],
    };
  }
  if (layout === 'rings') return { entries: [] };
  return A.layouts[layout] as LayoutDef;
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
  let variant = 0;
  for (const e of layoutDef(layout).entries) {
    const yaw = e.yaw ?? (e.turn ?? 0) * QUARTER;
    for (const m of mirrored(e.x, e.z, yaw, e.mirror ?? 'quad')) {
      let shape: ObstacleShape;
      if (e.kind === 'pillar') {
        shape = PILLAR_SHAPE;
      } else {
        const def = defOf(e.kind);
        if (!def) throw new Error(`layout ${layout}: unknown obstacle kind '${e.kind}'`);
        shape = shapeFrom(e.kind as ObstacleKind, def, m.yaw, e.height);
      }
      shape = { ...shape, variant: variant++ };
      const spot: ObstacleSpot = { x: m.x, z: m.z, shape };
      if (e.move) {
        const mv = e.move;
        spot.mover = { axis: mv.axis, cx: m.x, cz: m.z, half: mv.span / 2, speed: mv.speed, start: mv.start * m.sign, dir: (m.sign > 0 ? 1 : -1) * (mv.start <= 0 ? 1 : -1) as 1 | -1 };
        const off = spot.mover.start * spot.mover.half;
        if (mv.axis === 'x') spot.x += off;
        else spot.z += off;
      }
      spots.push(spot);
    }
  }
  return spots;
}

/** A layout's soft cover (vape clouds), mirrored. */
export function layoutSoftZones(layout: ArenaLayout): SoftZone[] {
  const out: SoftZone[] = [];
  for (const s of layoutDef(layout).soft ?? []) {
    for (const m of mirrored(s.x, s.z, 0, s.mirror ?? 'none')) {
      out.push({ x: m.x, z: m.z, radius: s.radius, height: s.height, drift: s.drift, period: s.period, phase: m.sign > 0 ? 0 : Math.PI });
    }
  }
  return out;
}

/** A layout's floor hazards (lava pools), mirrored. */
export function layoutHazards(layout: ArenaLayout): Hazard[] {
  const out: Hazard[] = [];
  for (const h of layoutDef(layout).hazards ?? []) {
    for (const m of mirrored(h.x, h.z, 0, h.mirror ?? 'none')) out.push({ x: m.x, z: m.z, radius: h.radius });
  }
  return out;
}
