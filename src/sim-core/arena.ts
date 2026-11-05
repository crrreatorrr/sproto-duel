/**
 * The arena in the sim: the circular wall, the floor plane, every obstacle of the layout (pillars,
 * cubicles, stalls, cars, rocks...) with health, crumbling to stumps and sliding on rails, lava
 * pools and drifting vape clouds. Also the collision queries that replace Rapier: ray and sphere
 * casts, character sliding and ground probes, all in fixed point.
 *
 * Shapes are vertical extrusions: a box (turned by a yaw) or a cylinder, each with a bottom and a
 * top, exactly like the Rapier colliders the game used (src/physics/Physics.ts addPillar). Wizards
 * are vertical cylinders (Rapier used capsules; see docs/SERVER-SIM.md "Differences").
 */
import { CONFIG, type ColliderPartDef, type LayoutDef, type ObstacleDef } from '../config';
import {
  ONE, QUARTER, HALF, abs, clamp, cos, div, fx, isqrt, len2, max, min, mul, muldiv, rad, sin, vt,
} from './fixed';

const A = CONFIG.arena;
const C = A.cubicles;

/** Arena ids are the game's theme ids; each picks a cover layout. */
export const ARENA_LAYOUTS = {
  moonlit: 'rings',
  grove: 'rings',
  glacier: 'rings',
  volcano: 'caldera',
  desert: 'bazaar',
  void: 'exchange',
  city: 'streets',
  office: 'cubicles',
} as const;
export type ArenaId = keyof typeof ARENA_LAYOUTS;
export type LayoutId = (typeof ARENA_LAYOUTS)[ArenaId];
export const ARENA_IDS = Object.keys(ARENA_LAYOUTS) as ArenaId[];

export function isArenaId(id: unknown): id is ArenaId {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(ARENA_LAYOUTS, id);
}

/** Wall, floor and ring numbers in Q16. */
export const WALL_RADIUS = fx(A.wallRadius);
/** The visible outer wall's height: spells above it fly out (wizards are always held in). */
export const WALL_HEIGHT = fx(1.4);
/** Rapier's character offset: wizards stop this far short of anything solid. */
const SKIN = fx(0.02);

/** One solid piece of an obstacle in world space. */
export interface Solid {
  ob: number;
  box: boolean;
  x: number;
  z: number;
  r: number;
  hx: number;
  hz: number;
  /** cos and sin of the world yaw (boxes). */
  c: number;
  s: number;
  y0: number;
  y1: number;
  /** Radius of a circle around (x, z) holding the footprint (cheap rejects). */
  br: number;
}

interface PartDef {
  box: boolean;
  x: number;
  z: number;
  hx: number;
  hz: number;
  r: number;
  yaw: number;
  y0: number;
  y1: number;
}

export interface Mover {
  axis: 'x' | 'z';
  cx: number;
  cz: number;
  half: number;
  speed: number;
  /** Position along the rail, Q16 in -ONE..ONE, and the direction of travel. */
  t: number;
  dir: 1 | -1;
  start: number;
  startDir: 1 | -1;
}

export interface Obstacle {
  index: number;
  kind: string;
  x: number;
  z: number;
  yaw: number;
  parts: PartDef[];
  maxHp: number;
  hp: number;
  alive: boolean;
  destructible: boolean;
  stumpHeight: number;
  /** Stump footprint scale (Q16). */
  stumpScale: number;
  seeThrough: boolean;
  cover: boolean;
  /** Highest top of the standing piece. */
  height: number;
  /** Bounds half extents in the obstacle's own frame (mover rails, AI). */
  halfX: number;
  halfZ: number;
  mover: Mover | null;
  solids: Solid[];
}

export interface Hazard {
  x: number;
  z: number;
  r: number;
}

export interface Cloud {
  x: number;
  z: number;
  r: number;
  height: number;
  drift: number;
  /** Period in TU and phase in angle units. */
  period: number;
  phase: number;
  cx: number;
  cz: number;
}

/** What a query hit. */
export const HIT_NONE = 0;
export const HIT_OBSTACLE = 1;
export const HIT_WALL = 2;
export const HIT_FLOOR = 3;
export const HIT_WIZARD = 4;

export interface Hit {
  kind: number;
  /** Obstacle or wizard index. */
  index: number;
  /** Distance along the (unit) direction, Q16. */
  t: number;
}

/** A vertical cylinder standing in for a wizard in queries. */
export interface Body {
  index: number;
  x: number;
  y: number;
  z: number;
  r: number;
  h: number;
}

// ------------------------------------------------------------------ layout data

function part(p: ColliderPartDef): PartDef {
  const box = p.shape === 'box';
  const r = p.radius ?? Math.min(p.halfX ?? 0.5, p.halfZ ?? 0.5);
  return {
    box,
    x: fx(p.x ?? 0),
    z: fx(p.z ?? 0),
    hx: fx(box ? p.halfX ?? 0.5 : r),
    hz: fx(box ? p.halfZ ?? 0.5 : r),
    r: fx(r),
    yaw: rad(p.yaw ?? 0),
    y0: fx(p.y0 ?? 0),
    y1: fx(p.height),
  };
}

const OFFICE_DEFS: Record<string, ObstacleDef> = {
  cubicle: { parts: [{ shape: 'box', halfX: C.size / 2, halfZ: C.size / 2, height: C.height }], hp: C.hp, stumpHeight: C.stumpHeight, cover: true },
  cabinet: { parts: [{ shape: 'box', halfX: C.cabinet.halfX, halfZ: C.cabinet.halfZ, height: C.cabinet.height }], hp: C.cabinet.hp, stumpHeight: C.cabinet.stumpHeight, cover: C.cabinet.cover },
  copier: { parts: [{ shape: 'box', halfX: C.copier.halfX, halfZ: C.copier.halfZ, height: C.copier.height }], hp: C.copier.hp, stumpHeight: C.copier.stumpHeight, cover: C.copier.cover },
  cooler: { parts: [{ shape: 'cylinder', radius: C.cooler.radius, height: C.cooler.height }], hp: C.cooler.hp, stumpHeight: C.cooler.stumpHeight, cover: C.cooler.cover },
  glass: { parts: [{ shape: 'box', halfX: C.glass.halfX, halfZ: C.glass.halfZ, height: C.glass.height }], hp: C.glass.hp, stumpHeight: C.glass.stumpHeight, cover: C.glass.cover, seeThrough: true },
};

const PILLAR_DEF: ObstacleDef = {
  parts: [{ shape: 'cylinder', radius: A.pillars.radius, height: A.pillars.height }],
  hp: A.pillars.hp, stumpHeight: 0.9, cover: true,
};

function defOf(kind: string): ObstacleDef {
  if (kind === 'pillar') return PILLAR_DEF;
  if (OFFICE_DEFS[kind]) return OFFICE_DEFS[kind];
  const d = (A.obstacles as Record<string, ObstacleDef>)[kind];
  if (!d) throw new Error('unknown obstacle kind ' + kind);
  return d;
}

function layoutDef(layout: LayoutId): LayoutDef {
  if (layout === 'cubicles') {
    const entries = [];
    for (const q of C.quadrant) entries.push({ kind: 'cubicle', x: q.x, z: q.z, turn: q.turn });
    for (const o of C.obstructions) entries.push({ kind: o.kind as string, x: o.x, z: o.z, turn: o.turn });
    return { entries };
  }
  if (layout === 'rings') return { entries: [] };
  return A.layouts[layout] as LayoutDef;
}

interface Mirror {
  x: number;
  z: number;
  yaw: number;
  sign: 1 | -1;
}

/** Copies of a +x/+z entry (src/arena/layouts.ts mirrored), yaw in angle units. */
function mirrored(x: number, z: number, yaw: number, mode: string): Mirror[] {
  if (mode === 'none') return [{ x, z, yaw, sign: 1 }];
  if (mode === 'point') {
    const out: Mirror[] = [{ x, z, yaw, sign: 1 }];
    if (x !== 0 || z !== 0) out.push({ x: -x, z: -z, yaw: yaw + HALF, sign: -1 });
    return out;
  }
  const out: Mirror[] = [];
  const sxs = x === 0 || mode === 'z' ? [1] : [1, -1];
  const szs = z === 0 || mode === 'x' ? [1] : [1, -1];
  for (let i = 0; i < sxs.length; i++) {
    for (let j = 0; j < szs.length; j++) {
      const sx = sxs[i], sz = szs[j];
      let y = yaw;
      if (sx < 0) y = -y;
      if (sz < 0) y = HALF - y;
      out.push({ x: x * sx, z: z * sz, yaw: y, sign: (sx * sz) as 1 | -1 });
    }
  }
  return out;
}

function buildObstacle(index: number, kind: string, def: ObstacleDef, x: number, z: number, yaw: number, height?: number): Obstacle {
  const parts: PartDef[] = [];
  for (let i = 0; i < def.parts.length; i++) {
    const p = def.parts[i];
    parts.push(part(height !== undefined && def.parts.length === 1 ? { ...p, height } : p));
  }
  let top = 0;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of parts) {
    top = max(top, p.y1);
    const c = abs(cos(p.yaw)), s = abs(sin(p.yaw));
    const ex = p.box ? mul(c, p.hx) + mul(s, p.hz) : p.r;
    const ez = p.box ? mul(s, p.hx) + mul(c, p.hz) : p.r;
    x0 = min(x0, p.x - ex);
    x1 = max(x1, p.x + ex);
    z0 = min(z0, p.z - ez);
    z1 = max(z1, p.z + ez);
  }
  const hp = fx(def.hp);
  return {
    index, kind, x, z, yaw, parts,
    maxHp: hp, hp, alive: true, destructible: def.hp > 0,
    stumpHeight: fx(def.stumpHeight),
    stumpScale: kind === 'pillar' ? fx(1.15) : ONE,
    seeThrough: !!def.seeThrough,
    cover: def.cover,
    height: top,
    halfX: (x1 - x0) >> 1,
    halfZ: (z1 - z0) >> 1,
    mover: null,
    solids: [],
  };
}

/** Every obstacle of a layout, in the game's order (index i matches Arena.pillars[i]). */
export function buildObstacles(layout: LayoutId): Obstacle[] {
  const out: Obstacle[] = [];
  if (layout === 'rings') {
    for (const ring of A.pillars.rings) {
      for (let i = 0; i < ring.count; i++) {
        const a = Math.round(((i + ring.offset) / ring.count) * 65536);
        const r = fx(ring.radius);
        out.push(buildObstacle(out.length, 'pillar', PILLAR_DEF, mul(sin(a), r), mul(cos(a), r), 0));
      }
    }
  } else {
    for (const e of layoutDef(layout).entries) {
      const yaw = e.yaw !== undefined ? rad(e.yaw) : (e.turn ?? 0) * QUARTER;
      for (const m of mirrored(fx(e.x), fx(e.z), yaw, e.mirror ?? 'quad')) {
        const def = defOf(e.kind);
        // A single pillar ignores the yaw (the classic column).
        const ob = buildObstacle(out.length, e.kind, def, m.x, m.z, e.kind === 'pillar' ? 0 : m.yaw, e.height);
        if (e.move) {
          const mv = e.move;
          const start = fx(mv.start) * m.sign;
          const dir = ((m.sign > 0 ? 1 : -1) * (mv.start <= 0 ? 1 : -1)) as 1 | -1;
          ob.mover = { axis: mv.axis, cx: m.x, cz: m.z, half: fx(mv.span / 2), speed: fx(mv.speed), t: start, dir, start, startDir: dir };
          const off = mul(start, ob.mover.half);
          if (mv.axis === 'x') ob.x += off;
          else ob.z += off;
        }
        out.push(ob);
      }
    }
  }
  for (const ob of out) rebuildSolids(ob);
  return out;
}

export function buildHazards(layout: LayoutId): Hazard[] {
  const out: Hazard[] = [];
  for (const h of layoutDef(layout).hazards ?? []) {
    for (const m of mirrored(fx(h.x), fx(h.z), 0, h.mirror ?? 'none')) out.push({ x: m.x, z: m.z, r: fx(h.radius) });
  }
  return out;
}

export function buildClouds(layout: LayoutId): Cloud[] {
  const out: Cloud[] = [];
  for (const s of layoutDef(layout).soft ?? []) {
    for (const m of mirrored(fx(s.x), fx(s.z), 0, s.mirror ?? 'none')) {
      out.push({ x: m.x, z: m.z, r: fx(s.radius), height: fx(s.height), drift: fx(s.drift), period: Math.round(s.period * 6000), phase: m.sign > 0 ? 0 : HALF, cx: m.x, cz: m.z });
    }
  }
  return out;
}

/** World-space solids of the live piece (standing parts, or the stump parts). */
export function rebuildSolids(ob: Obstacle): void {
  const list: Solid[] = [];
  const oc = cos(ob.yaw), os = sin(ob.yaw);
  for (const p of ob.parts) {
    let y1 = p.y1;
    let k = ONE;
    if (!ob.alive) {
      if (ob.stumpHeight <= 0 || p.y0 !== 0) continue;
      y1 = min(p.y1, ob.stumpHeight);
      k = ob.stumpScale;
    }
    const wy = ob.yaw + p.yaw;
    const hx = mul(p.hx, k), hz = mul(p.hz, k), r = mul(p.r, k);
    list.push({
      ob: ob.index,
      box: p.box,
      x: ob.x + mul(p.x, oc) + mul(p.z, os),
      z: ob.z - mul(p.x, os) + mul(p.z, oc),
      r,
      hx,
      hz,
      c: cos(wy),
      s: sin(wy),
      y0: p.y0,
      y1,
      br: p.box ? isqrt(hx * hx + hz * hz) + 2 : r + 2,
    });
  }
  ob.solids = list;
}

// ------------------------------------------------------------------ primitive tests

/** Could a disc of radius `r` at (x, z) touch the solid's footprint? (bounding-circle box test) */
function near(s: Solid, x: number, z: number, r: number): boolean {
  const reach = s.br + r;
  return x - s.x <= reach && s.x - x <= reach && z - s.z <= reach && s.z - z <= reach;
}

/** Horizontal distance from (x, z) to a solid's footprint (0 inside), expanded by nothing. */
export function solidDistance(s: Solid, x: number, z: number): number {
  const dx = x - s.x, dz = z - s.z;
  if (!s.box) return max(0, len2(dx, dz) - s.r);
  const lx = mul(dx, s.c) - mul(dz, s.s);
  const lz = mul(dx, s.s) + mul(dz, s.c);
  return len2(max(0, abs(lx) - s.hx), max(0, abs(lz) - s.hz));
}

/** Footprint distance from (x, z) to the obstacle's live solids (Infinity when nothing is left). */
export function obstacleDistance(ob: Obstacle, x: number, z: number): number {
  let best = Infinity;
  for (const s of ob.solids) best = min(best, solidDistance(s, x, z));
  return best;
}

/** Closest point of the obstacle's live footprint to (x, z). */
export function obstacleClosest(ob: Obstacle, x: number, z: number, out: { x: number; z: number }): void {
  let best = Infinity;
  out.x = ob.x;
  out.z = ob.z;
  for (const s of ob.solids) {
    const dx = x - s.x, dz = z - s.z;
    let qx: number, qz: number;
    if (!s.box) {
      const d = len2(dx, dz);
      if (d > s.r && d > 0) {
        qx = s.x + muldiv(dx, s.r, d);
        qz = s.z + muldiv(dz, s.r, d);
      } else {
        qx = x;
        qz = z;
      }
    } else {
      const lx = clamp(mul(dx, s.c) - mul(dz, s.s), -s.hx, s.hx);
      const lz = clamp(mul(dx, s.s) + mul(dz, s.c), -s.hz, s.hz);
      qx = s.x + mul(lx, s.c) + mul(lz, s.s);
      qz = s.z - mul(lx, s.s) + mul(lz, s.c);
    }
    const d = len2(x - qx, z - qz);
    if (d < best) {
      best = d;
      out.x = qx;
      out.z = qz;
    }
  }
}

/** Shared scratch for the slab tests: entry and exit distances. */
const span = { a: 0, b: 0 };
const NEG = -1e15;
const POS = 1e15;

/** Entry/exit (Q16 distance along the unit direction) of a ray in a circle; false on a miss. */
function rayCircle(ox: number, oz: number, dx: number, dz: number, cx: number, cz: number, r: number): boolean {
  // Q10 internally keeps b*b and a*c below 2^53.
  const px = Math.floor((ox - cx) / 64), pz = Math.floor((oz - cz) / 64);
  if (abs(px) > 65536 || abs(pz) > 65536) return false;
  const ux = Math.floor(dx / 64), uz = Math.floor(dz / 64);
  const rr = Math.floor(r / 64);
  const c = px * px + pz * pz - rr * rr;
  const a = ux * ux + uz * uz;
  if (a === 0) {
    if (c > 0) return false;
    span.a = NEG;
    span.b = POS;
    return true;
  }
  const b = px * ux + pz * uz;
  const disc = b * b - a * c;
  if (disc < 0) return false;
  const s = isqrt(disc);
  span.a = Math.floor(((-b - s) * ONE) / a);
  span.b = Math.floor(((-b + s) * ONE) / a);
  return true;
}

/** Entry/exit of a ray in the slab |o + t d| <= h (one axis). */
function slab(o: number, d: number, lo: number, hi: number): boolean {
  if (d === 0) {
    if (o < lo || o > hi) return false;
    span.a = NEG;
    span.b = POS;
    return true;
  }
  let t1 = div(lo - o, d), t2 = div(hi - o, d);
  if (t1 > t2) {
    const t = t1;
    t1 = t2;
    t2 = t;
  }
  span.a = t1;
  span.b = t2;
  return true;
}

/**
 * First contact distance of a ray (origin o, unit direction d, Q16) with a solid grown by `grow`
 * (a sphere of that radius swept along the ray), or -1. Starting inside gives 0.
 */
function raySolid(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, s: Solid, grow: number, maxT: number): number {
  if (!slab(oy, dy, s.y0 - grow, s.y1 + grow)) return -1;
  let enter = span.a, exit = span.b;
  if (!s.box) {
    if (!rayCircle(ox, oz, dx, dz, s.x, s.z, s.r + grow)) return -1;
    enter = max(enter, span.a);
    exit = min(exit, span.b);
  } else {
    const rx = ox - s.x, rz = oz - s.z;
    const lx = mul(rx, s.c) - mul(rz, s.s);
    const lz = mul(rx, s.s) + mul(rz, s.c);
    const ldx = mul(dx, s.c) - mul(dz, s.s);
    const ldz = mul(dx, s.s) + mul(dz, s.c);
    if (!slab(lx, ldx, -s.hx - grow, s.hx + grow)) return -1;
    enter = max(enter, span.a);
    exit = min(exit, span.b);
    if (!slab(lz, ldz, -s.hz - grow, s.hz + grow)) return -1;
    enter = max(enter, span.a);
    exit = min(exit, span.b);
  }
  if (enter > exit || exit < 0 || enter > maxT) return -1;
  return max(0, enter);
}

function rayBody(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, b: Body, grow: number, maxT: number): number {
  if (!slab(oy, dy, b.y - grow, b.y + b.h + grow)) return -1;
  let enter = span.a, exit = span.b;
  if (!rayCircle(ox, oz, dx, dz, b.x, b.z, b.r + grow)) return -1;
  enter = max(enter, span.a);
  exit = min(exit, span.b);
  if (enter > exit || exit < 0 || enter > maxT) return -1;
  return max(0, enter);
}

// ------------------------------------------------------------------ the arena

export interface ArenaQuery {
  /** Obstacles (and the outer wall) block. */
  world: boolean;
  /** Glass does not block (sight). */
  seeThrough: boolean;
  /** The floor blocks (spells). */
  floor: boolean;
  /** Wizard bodies to test (already filtered by the caller). */
  bodies: readonly Body[] | null;
}

export class SimArena {
  readonly id: ArenaId;
  readonly layout: LayoutId;
  readonly obstacles: Obstacle[];
  readonly hazards: Hazard[];
  readonly clouds: Cloud[];
  /** Fire ring inner edge (Q16) and the most an arena shift allows. */
  fireRadius = fx(A.fireRadius);
  ringCap = fx(A.fireRadius);
  /** TU since the round started (drives clouds). */
  time = 0;

  constructor(id: ArenaId) {
    this.id = id;
    this.layout = ARENA_LAYOUTS[id];
    this.obstacles = buildObstacles(this.layout);
    this.hazards = buildHazards(this.layout);
    this.clouds = buildClouds(this.layout);
  }

  reset(): void {
    this.fireRadius = this.ringCap = fx(A.fireRadius);
    this.time = 0;
    for (const ob of this.obstacles) {
      ob.hp = ob.maxHp;
      ob.alive = true;
      const m = ob.mover;
      if (m) {
        m.t = m.start;
        m.dir = m.startDir;
        this.placeMover(ob);
      }
      rebuildSolids(ob);
    }
    this.driftClouds();
  }

  private placeMover(ob: Obstacle): void {
    const m = ob.mover!;
    const off = mul(m.t, m.half);
    ob.x = m.axis === 'x' ? m.cx + off : m.cx;
    ob.z = m.axis === 'x' ? m.cz : m.cz + off;
  }

  /**
   * One tick: slide moving cover (turning back instead of moving into a wizard) and drift clouds.
   */
  update(dt: number, bodies: readonly Body[]): void {
    this.time += dt;
    for (const ob of this.obstacles) {
      const m = ob.mover;
      if (!m) continue;
      let t = m.t + Math.floor((m.dir * vt(m.speed, dt) * ONE) / m.half);
      if (t > ONE || t < -ONE) {
        t = clamp(t, -ONE, ONE);
        m.dir = -m.dir as 1 | -1;
      }
      const off = mul(t, m.half);
      const nx = m.axis === 'x' ? m.cx + off : m.cx;
      const nz = m.axis === 'x' ? m.cz : m.cz + off;
      if (this.boxTouches(ob, nx, nz, fx(0.08), bodies)) {
        m.dir = -m.dir as 1 | -1;
        continue;
      }
      m.t = t;
      ob.x = nx;
      ob.z = nz;
      rebuildSolids(ob);
    }
    this.driftClouds();
  }

  /** Would the obstacle's bounds (grown by pad) at (x, z) touch any body? */
  private boxTouches(ob: Obstacle, x: number, z: number, pad: number, bodies: readonly Body[]): boolean {
    const c = cos(ob.yaw), s = sin(ob.yaw);
    for (const b of bodies) {
      if (b.y > ob.height) continue;
      const dx = b.x - x, dz = b.z - z;
      const lx = mul(dx, c) - mul(dz, s);
      const lz = mul(dx, s) + mul(dz, c);
      const ex = max(0, abs(lx) - ob.halfX - pad), ez = max(0, abs(lz) - ob.halfZ - pad);
      if (len2(ex, ez) < b.r) return true;
    }
    return false;
  }

  private driftClouds(): void {
    for (const c of this.clouds) {
      const a = c.phase + Math.floor(((this.time % c.period) * 65536) / c.period);
      c.cx = c.x + mul(cos(a), c.drift);
      c.cz = c.z + mul(sin(a), c.drift);
    }
  }

  /** Damage an obstacle (spells). Returns true when this hit broke it. */
  damageObstacle(ob: Obstacle, amount: number): boolean {
    if (!ob.alive || !ob.destructible) return false;
    ob.hp -= mul(amount, fx(A.pillars.spellDamageMultiplier));
    if (ob.hp <= 0) {
      ob.hp = 0;
      ob.alive = false;
      rebuildSolids(ob);
      return true;
    }
    return false;
  }

  /** The lava pool at (x, z) (margin around it), or null. */
  hazardAt(x: number, z: number, margin: number, extra: readonly Hazard[]): Hazard | null {
    for (const h of this.hazards) if (len2(x - h.x, z - h.z) < h.r + margin) return h;
    for (const h of extra) if (len2(x - h.x, z - h.z) < h.r + margin) return h;
    return null;
  }

  // ---------------------------------------------------------------- queries

  /**
   * Cast a ray (or a sphere of radius `grow`) from o along the unit direction d up to `maxT`.
   * Returns the nearest hit in `out` (kind HIT_NONE when nothing).
   */
  cast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, grow: number, q: ArenaQuery, out: Hit): Hit {
    out.kind = HIT_NONE;
    out.index = -1;
    out.t = maxT;
    const ex = ox + mul(dx, maxT), ez = oz + mul(dz, maxT);
    const x0 = min(ox, ex) - grow, x1 = max(ox, ex) + grow, z0 = min(oz, ez) - grow, z1 = max(oz, ez) + grow;
    if (q.world) {
      for (const ob of this.obstacles) {
        if (q.seeThrough && ob.seeThrough) continue;
        for (const s of ob.solids) {
          if (s.x + s.br < x0 || s.x - s.br > x1 || s.z + s.br < z0 || s.z - s.br > z1) continue;
          const t = raySolid(ox, oy, oz, dx, dy, dz, s, grow, out.t);
          if (t >= 0 && (out.kind === HIT_NONE || t < out.t)) {
            out.kind = HIT_OBSTACLE;
            out.index = ob.index;
            out.t = t;
          }
        }
      }
      // The outer wall: leaving the circle below its top (both ends inside: no crossing).
      const wr = WALL_RADIUS - grow;
      const wr2 = wr * wr;
      if ((ox * ox + oz * oz > wr2 || ex * ex + ez * ez > wr2) && rayCircle(ox, oz, dx, dz, 0, 0, wr)) {
        const t = max(0, span.b);
        if (t <= out.t && (out.kind === HIT_NONE || t < out.t)) {
          const y = oy + mul(dy, t);
          if (y < WALL_HEIGHT + grow) {
            out.kind = HIT_WALL;
            out.index = -1;
            out.t = t;
          }
        }
      }
    }
    if (q.floor && dy < 0) {
      const t = oy <= grow ? 0 : div(oy - grow, -dy);
      if (t <= out.t && (out.kind === HIT_NONE || t < out.t)) {
        out.kind = HIT_FLOOR;
        out.index = -1;
        out.t = t;
      }
    } else if (q.floor && oy <= grow && out.kind === HIT_NONE) {
      // Resting on the floor already counts as touching it only when moving into it; skip.
    }
    if (q.bodies) {
      for (const b of q.bodies) {
        if (b.x + b.r + 2 < x0 || b.x - b.r - 2 > x1 || b.z + b.r + 2 < z0 || b.z - b.r - 2 > z1) continue;
        const t = rayBody(ox, oy, oz, dx, dy, dz, b, grow, out.t);
        if (t >= 0 && (out.kind === HIT_NONE || t < out.t)) {
          out.kind = HIT_WIZARD;
          out.index = b.index;
          out.t = t;
        }
      }
    }
    return out;
  }

  /** Is the straight line a -> b clear of cover (and the wall)? Glass blocks only when `glass`. */
  clear(ax: number, ay: number, az: number, bx: number, by: number, bz: number, glass: boolean): boolean {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const l = isqrt(dx * dx + dy * dy + dz * dz);
    if (l < 7) return true;
    const ux = muldiv(dx, ONE, l), uy = muldiv(dy, ONE, l), uz = muldiv(dz, ONE, l);
    sightQuery.seeThrough = !glass;
    this.cast(ax, ay, az, ux, uy, uz, l, 0, sightQuery, scratchHit);
    return scratchHit.kind === HIT_NONE;
  }

  /**
   * How far a wizard (cylinder r, feet y..y+h) can move from (x, z) along the horizontal unit
   * direction (dx, dz) before cover or the wall, at most `maxT`.
   */
  sweepBody(x: number, y: number, z: number, r: number, h: number, dx: number, dz: number, maxT: number): number {
    let best = maxT;
    for (const ob of this.obstacles) {
      for (const s of ob.solids) {
        if (s.y1 <= y + SKIN || s.y0 >= y + h || !near(s, x + (mul(dx, maxT) >> 1), z + (mul(dz, maxT) >> 1), r + (maxT >> 1) + 2)) continue;
        const t = raySolid(x, s.y0, z, dx, 0, dz, s, r, best);
        if (t >= 0 && t < best) best = t;
      }
    }
    if (rayCircle(x, z, dx, dz, 0, 0, WALL_RADIUS - r - SKIN)) best = min(best, max(0, span.b));
    return max(0, best);
  }

  /**
   * Push a wizard footprint (circle r at (x, z), feet y, height h) out of cover and the wall.
   * Returns true when it was moved. `p` is updated in place.
   */
  depenetrate(p: { x: number; z: number }, y: number, r: number, h: number): boolean {
    let moved = false;
    const rr = r + SKIN;
    for (let pass = 0; pass < 3; pass++) {
      let any = false;
      for (const ob of this.obstacles) {
        for (const s of ob.solids) {
          if (s.y1 <= y + SKIN || s.y0 >= y + h || !near(s, p.x, p.z, rr)) continue;
          if (pushOut(p, s, rr)) any = true;
        }
      }
      const lim = WALL_RADIUS - rr;
      const d = p.x * p.x + p.z * p.z > lim * lim ? len2(p.x, p.z) : 0;
      if (d > lim) {
        p.x = muldiv(p.x, lim, d);
        p.z = muldiv(p.z, lim, d);
        any = true;
      }
      if (!any) break;
      moved = true;
    }
    return moved;
  }

  /**
   * Highest walkable top (cover or stump) under a disc of radius r at (x, z) that is at most `maxY`
   * and at least `minY`; -1 if none.
   */
  topBelow(x: number, z: number, r: number, minY: number, maxY: number): number {
    let best = -1;
    for (const ob of this.obstacles) {
      for (const s of ob.solids) {
        if (s.y1 > maxY || s.y1 < minY || s.y1 <= best || !near(s, x, z, r)) continue;
        if (solidDistance(s, x, z) < r) best = s.y1;
      }
    }
    return best;
  }

  /** Lowest underside of cover above `y` overlapping the disc (a roof), or -1. */
  ceilingAbove(x: number, z: number, r: number, y: number, maxY: number): number {
    let best = -1;
    for (const ob of this.obstacles) {
      for (const s of ob.solids) {
        if (s.y0 < y || s.y0 > maxY || !near(s, x, z, r)) continue;
        if (best >= 0 && s.y0 >= best) continue;
        if (solidDistance(s, x, z) < r) best = s.y0;
      }
    }
    return best;
  }

  /**
   * Height of the highest walkable top under a disc at (x, z) searching down from y (0 for the
   * floor); Infinity-like (-2) when something there reaches above `maxY` (too tall to hover over).
   */
  surfaceBelow(x: number, z: number, r: number, maxY: number): number {
    let best = 0;
    for (const ob of this.obstacles) {
      for (const s of ob.solids) {
        if (!near(s, x, z, r) || solidDistance(s, x, z) >= r) continue;
        if (s.y0 > maxY) continue;
        if (s.y1 > maxY) return -2;
        if (s.y1 > best) best = s.y1;
      }
    }
    return best;
  }

  /** Any solid within `clear` of (x, z) between the floor and `top` (pickup spawn spots). */
  blocked(x: number, z: number, clear: number, top: number): boolean {
    for (const ob of this.obstacles) {
      for (const s of ob.solids) {
        if (s.y0 > top || !near(s, x, z, clear)) continue;
        if (solidDistance(s, x, z) < clear) return true;
      }
    }
    return len2(x, z) > WALL_RADIUS - clear;
  }
}

const sightQuery: ArenaQuery = { world: true, seeThrough: true, floor: false, bodies: null };
const scratchHit: Hit = { kind: 0, index: -1, t: 0 };

/** Push a circle (r) at p out of a solid's footprint. */
function pushOut(p: { x: number; z: number }, s: Solid, r: number): boolean {
  const dx = p.x - s.x, dz = p.z - s.z;
  if (!s.box) {
    const want = s.r + r;
    const d = len2(dx, dz);
    if (d >= want) return false;
    if (d < 4) {
      p.x = s.x + want;
      return true;
    }
    p.x = s.x + muldiv(dx, want, d);
    p.z = s.z + muldiv(dz, want, d);
    return true;
  }
  const lx = mul(dx, s.c) - mul(dz, s.s);
  const lz = mul(dx, s.s) + mul(dz, s.c);
  const qx = clamp(lx, -s.hx, s.hx), qz = clamp(lz, -s.hz, s.hz);
  const ex = lx - qx, ez = lz - qz;
  const d = len2(ex, ez);
  if (d >= r) return false;
  let nx: number, nz: number;
  if (d >= 4) {
    nx = qx + muldiv(ex, r, d);
    nz = qz + muldiv(ez, r, d);
  } else {
    // Centre inside the box: out through the nearest face.
    const px = s.hx - abs(lx), pz = s.hz - abs(lz);
    if (px < pz) {
      nx = (lx < 0 ? -1 : 1) * (s.hx + r);
      nz = lz;
    } else {
      nx = lx;
      nz = (lz < 0 ? -1 : 1) * (s.hz + r);
    }
  }
  p.x = s.x + mul(nx, s.c) + mul(nz, s.s);
  p.z = s.z - mul(nx, s.s) + mul(nz, s.c);
  return true;
}
