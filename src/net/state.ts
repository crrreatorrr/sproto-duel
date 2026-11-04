/**
 * Replicated game state for online play: what the host sends (30 Hz) so the guest's replica can
 * show the fight. Types and the wire codec only; pure (no DOM, no three.js). Capture and apply,
 * which touch the Game, live in src/net/snapshot.ts.
 *
 * Wire format (JSON): `{ v, t, a, w: number[][], p: number[][], r: number[], k: number[], m: number[], e? }`
 * with positions in integer centimetres, angles as u16 of a full turn and timers in centiseconds.
 */

import { CONFIG } from '../config';

export const SNAPSHOT_VERSION = 1;

/** Core spells a wizard can be casting, by index in the wire format. */
export const CAST_SPELLS = ['blast', 'stun', 'ultimate'] as const;
export type CastSpell = (typeof CAST_SPELLS)[number];
/** Cooldown keys in wire order. */
export const COOLDOWNS = ['bolt', 'blast', 'shield', 'stun', 'dodge', 'blink'] as const;
/** Projectile skins in wire order (index 0 = the spell orb). Unknown skins travel as the orb. */
export const SKINS = ['orb', 'rugRoll', 'carpet', 'phone', 'pig', 'floret', 'broccoli', 'bullet', 'grenade', 'hellfire', 'skull'] as const;
/** Match phases in wire order. */
export const PHASES = ['menu', 'intro', 'fight', 'roundEnd', 'matchEnd'] as const;
export type NetPhase = (typeof PHASES)[number];

export interface WizardState {
  pos: [number, number, number];
  vel: [number, number];
  vy: number;
  grounded: boolean;
  facing: number;
  health: number;
  maxHealth: number;
  mana: number;
  manaBoost: number;
  ult: number;
  /** In COOLDOWNS order. */
  cd: number[];
  stunTime: number;
  shieldTime: number;
  shieldAge: number;
  dodgeTime: number;
  iframes: number;
  dodgeDir: [number, number];
  cast: { spell: CastSpell; elapsed: number; duration: number } | null;
  castPulse: number;
  hitFlash: number;
  burning: boolean;
  alive: boolean;
  sprinting: boolean;
  jumps: number;
  landings: number;
  /** Results-screen counters. Only sent now and then (see encodeSnapshot); absent = unchanged. */
  stats?: { damageDealt: number; casts: number; hits: number; perfects: number; dodges: number };
}

export interface ProjectileState {
  /** Projectile.netId: stable for the projectile's life. */
  id: number;
  kind: 'bolt' | 'blast';
  /** Seat (wizard index) of the current owner. */
  owner: number;
  pos: [number, number, number];
  vel: [number, number, number];
  radius: number;
  reflected: boolean;
  skin: string;
}

export interface ArenaState {
  fireRadius: number;
  /** Per pillar index: health, or -1 when broken. */
  pillars: number[];
  tickets: { id: number; x: number; z: number; age: number }[];
}

export interface MatchState {
  phase: NetPhase;
  round: number;
  wins: [number, number];
  timer: number;
  phaseTime: number;
  /** Seat of the last round's winner, -1 for none (or a draw). */
  lastWinnerSeat: number;
}

export interface Snapshot {
  v: number;
  /** Host sim tick the state is from. */
  tick: number;
  /** Last guest input tick the host applied (for guest prediction). */
  ack: number;
  wizards: WizardState[];
  projectiles: ProjectileState[];
  arena: ArenaState;
  match: MatchState;
  /** Encoded host events since the previous snapshot (src/net/events.ts), passed through as is. */
  ev?: unknown[];
}

/** The wire form. */
export interface EncodedSnapshot {
  v: number;
  t: number;
  a: number;
  w: number[][];
  p: number[][];
  r: number[];
  k: number[];
  m: number[];
  e?: unknown[];
}

export class SnapshotVersionError extends Error {
  constructor(readonly got: unknown) {
    super(`snapshot version ${String(got)} is not ${SNAPSHOT_VERSION}`);
  }
}

const TAU = Math.PI * 2;
const round = (v: number, k = 1) => Math.round((Number.isFinite(v) ? v : 0) * k);
/** Centiseconds. */
const cs = (v: number) => round(v, 100);
const fromCs = (v: number) => v / 100;
const angle = (a: number) => round((((a % TAU) + TAU) % TAU) / TAU * 65536) & 0xffff;
const fromAngle = (q: number) => ((q & 0xffff) / 65536) * TAU;
const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** Numbers per encoded wizard without its stats (see encodeWizard), and the stats' count. */
const W_FIELDS = 33;
const STAT_FIELDS = 5;
/** Stats ride along once every this many ticks during a fight, and always outside one. */
export const STATS_EVERY_TICKS = 30;

export function encodeWizard(s: WizardState, withStats = true): number[] {
  const flags = (s.grounded ? 1 : 0) | (s.burning ? 2 : 0) | (s.alive ? 4 : 0) | (s.sprinting ? 8 : 0);
  const c = s.cast;
  return [
    round(s.pos[0], 100), round(s.pos[1], 100), round(s.pos[2], 100),
    round(s.vel[0], 100), round(s.vel[1], 100), round(s.vy, 100),
    angle(s.facing), round(s.health, 10), round(s.maxHealth, 10), round(s.mana, 10), cs(s.manaBoost), round(s.ult, 10),
    ...COOLDOWNS.map((_, i) => cs(s.cd[i] ?? 0)),
    cs(s.stunTime), cs(s.shieldTime), cs(s.shieldAge), cs(s.dodgeTime), cs(s.iframes),
    round(s.dodgeDir[0], 100), round(s.dodgeDir[1], 100),
    c ? CAST_SPELLS.indexOf(c.spell) : -1, c ? cs(c.elapsed) : 0, c ? cs(c.duration) : 0,
    round(s.castPulse, 100), round(s.hitFlash, 100), flags, s.jumps, s.landings,
    ...(withStats && s.stats ? [round(s.stats.damageDealt), s.stats.casts, s.stats.hits, s.stats.perfects, s.stats.dodges] : []),
  ];
}

export function decodeWizard(a: unknown): WizardState | null {
  if (!Array.isArray(a) || a.length < W_FIELDS) return null;
  const n = (i: number) => num(a[i]);
  const cast = n(25);
  const flags = n(30);
  return {
    pos: [n(0) / 100, n(1) / 100, n(2) / 100],
    vel: [n(3) / 100, n(4) / 100],
    vy: n(5) / 100,
    facing: fromAngle(n(6)),
    health: n(7) / 10,
    maxHealth: n(8) / 10,
    mana: n(9) / 10,
    manaBoost: fromCs(n(10)),
    ult: n(11) / 10,
    cd: COOLDOWNS.map((_, i) => fromCs(n(12 + i))),
    stunTime: fromCs(n(18)),
    shieldTime: fromCs(n(19)),
    shieldAge: fromCs(n(20)),
    dodgeTime: fromCs(n(21)),
    iframes: fromCs(n(22)),
    dodgeDir: [n(23) / 100, n(24) / 100],
    cast: cast >= 0 && cast < CAST_SPELLS.length ? { spell: CAST_SPELLS[cast], elapsed: fromCs(n(26)), duration: fromCs(n(27)) } : null,
    castPulse: n(28) / 100,
    hitFlash: n(29) / 100,
    grounded: (flags & 1) !== 0,
    burning: (flags & 2) !== 0,
    alive: (flags & 4) !== 0,
    sprinting: (flags & 8) !== 0,
    jumps: n(31),
    landings: n(32),
    stats: a.length >= W_FIELDS + STAT_FIELDS ? { damageDealt: n(33), casts: n(34), hits: n(35), perfects: n(36), dodges: n(37) } : undefined,
  };
}

/** A projectile's radius at launch; the wire omits it while unchanged (clashes shrink it). */
const defaultRadius = (kind: 'bolt' | 'blast') => CONFIG.spells[kind].radius;

/**
 * [idDelta, flags, x, y, z (cm), vx, vy, vz (dm/s), radius cm?]. `idDelta` is the id minus the
 * previous projectile's (the first one's is absolute); the radius only travels when it isn't the
 * kind's default.
 */
export function encodeProjectile(p: ProjectileState, prevId = 0): number[] {
  const skin = Math.max(0, (SKINS as readonly string[]).indexOf(p.skin));
  // kind | reflected | owner (2 bits) | skin (5 bits)
  const flags = (p.kind === 'blast' ? 1 : 0) | (p.reflected ? 2 : 0) | ((p.owner & 3) << 2) | ((skin & 31) << 4);
  const out = [p.id - prevId, flags, round(p.pos[0], 100), round(p.pos[1], 100), round(p.pos[2], 100), round(p.vel[0], 10), round(p.vel[1], 10), round(p.vel[2], 10)];
  const r = round(p.radius, 100);
  if (r !== round(defaultRadius(p.kind), 100)) out.push(r);
  return out;
}

export function decodeProjectile(a: unknown, prevId = 0): ProjectileState | null {
  if (!Array.isArray(a) || a.length < 8 || !a.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  const f = a[1] as number;
  const kind = f & 1 ? 'blast' : 'bolt';
  return {
    id: prevId + (a[0] as number),
    kind,
    reflected: (f & 2) !== 0,
    owner: (f >> 2) & 3,
    skin: SKINS[(f >> 4) & 31] ?? 'orb',
    radius: a.length > 8 ? (a[8] as number) / 100 : defaultRadius(kind),
    pos: [(a[2] as number) / 100, (a[3] as number) / 100, (a[4] as number) / 100],
    vel: [(a[5] as number) / 10, (a[6] as number) / 10, (a[7] as number) / 10],
  };
}

export function encodeSnapshot(s: Snapshot): EncodedSnapshot {
  const out: EncodedSnapshot = {
    v: SNAPSHOT_VERSION,
    t: s.tick,
    a: s.ack,
    w: s.wizards.map((w) => encodeWizard(w, s.match.phase !== 'fight' || s.tick % STATS_EVERY_TICKS === 0)),
    p: s.projectiles.map((p, i, all) => encodeProjectile(p, i > 0 ? all[i - 1].id : 0)),
    r: [round(s.arena.fireRadius, 100), ...s.arena.pillars.map((h) => (h < 0 ? -1 : round(h)))],
    k: s.arena.tickets.flatMap((t) => [t.id, round(t.x, 100), round(t.z, 100), cs(t.age)]),
    m: [Math.max(0, PHASES.indexOf(s.match.phase)), s.match.round, s.match.wins[0], s.match.wins[1], cs(s.match.timer), cs(s.match.phaseTime), s.match.lastWinnerSeat],
  };
  if (s.ev && s.ev.length) out.e = s.ev;
  return out;
}

/** Decode a wire snapshot. Throws SnapshotVersionError on another version; skips malformed entries. */
export function decodeSnapshot(raw: unknown): Snapshot {
  const o = (raw ?? {}) as Partial<EncodedSnapshot>;
  if (o.v !== SNAPSHOT_VERSION) throw new SnapshotVersionError(o.v);
  const wizards = (Array.isArray(o.w) ? o.w : []).map(decodeWizard).filter((w): w is WizardState => w !== null);
  const projectiles: ProjectileState[] = [];
  let prevId = 0;
  for (const entry of Array.isArray(o.p) ? o.p : []) {
    const p = decodeProjectile(entry, prevId);
    if (!p) continue;
    projectiles.push(p);
    prevId = p.id;
  }
  const r = Array.isArray(o.r) ? o.r : [];
  const k = Array.isArray(o.k) ? o.k : [];
  const m = Array.isArray(o.m) ? o.m : [];
  const tickets: ArenaState['tickets'] = [];
  for (let i = 0; i + 4 <= k.length; i += 4) tickets.push({ id: num(k[i]), x: num(k[i + 1]) / 100, z: num(k[i + 2]) / 100, age: fromCs(num(k[i + 3])) });
  return {
    v: SNAPSHOT_VERSION,
    tick: num(o.t),
    ack: num(o.a, -1),
    wizards,
    projectiles,
    arena: { fireRadius: num(r[0]) / 100, pillars: r.slice(1).map((h) => (num(h, -1) < 0 ? -1 : num(h))), tickets },
    match: {
      phase: PHASES[num(m[0])] ?? 'fight',
      round: num(m[1], 1),
      wins: [num(m[2]), num(m[3])],
      timer: fromCs(num(m[4])),
      phaseTime: fromCs(num(m[5])),
      lastWinnerSeat: num(m[6], -1),
    },
    ev: Array.isArray(o.e) ? o.e : undefined,
  };
}
