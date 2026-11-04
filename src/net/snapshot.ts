/**
 * Capture the host's game into a Snapshot, and apply one onto a replica (the online guest). Every
 * replicated field is listed here explicitly; anything not listed stays local presentation.
 * The wire codec is src/net/state.ts.
 */
import type { Game } from '../core/Game';
import type { Match, Phase } from '../core/Match';
import type { Projectile } from '../spells/Projectile';
import type { Wizard } from '../wizard/Wizard';
import { COOLDOWNS, SNAPSHOT_VERSION, type ArenaState, type ProjectileState, type Snapshot, type WizardState } from './state';

export function captureWizard(w: Wizard): WizardState {
  const c = w.cast;
  return {
    pos: [w.pos.x, w.pos.y, w.pos.z],
    vel: [w.vel.x, w.vel.z],
    vy: w.vy,
    grounded: w.grounded,
    facing: w.facing,
    health: w.health,
    maxHealth: w.maxHealth,
    mana: w.mana,
    manaBoost: w.manaBoost,
    ult: w.ult,
    cd: COOLDOWNS.map((k) => w.cd[k]),
    stunTime: w.stunTime,
    shieldTime: w.shieldTime,
    shieldAge: w.shieldAge,
    dodgeTime: w.dodgeTime,
    iframes: w.iframes,
    dodgeDir: [w.dodgeDir.x, w.dodgeDir.z],
    cast: c ? { spell: c.spell, elapsed: c.elapsed, duration: c.duration } : null,
    castPulse: w.castPulse,
    hitFlash: w.hitFlash,
    burning: w.burning,
    alive: w.alive,
    sprinting: w.sprinting,
    jumps: w.jumps,
    landings: w.landings,
    stats: { ...w.stats },
  };
}

export function captureProjectile(p: Projectile, seats?: readonly Wizard[]): ProjectileState {
  const seat = seats ? seats.indexOf(p.owner) : p.owner.index;
  return {
    id: p.netId,
    kind: p.kind,
    owner: seat < 0 ? 0 : seat,
    pos: [p.pos.x, p.pos.y, p.pos.z],
    vel: [p.vel.x, p.vel.y, p.vel.z],
    radius: p.radius,
    reflected: p.reflected,
    skin: p.skin,
  };
}

/**
 * The host's state at `tick`. `ack`: the last guest input tick it applied. `seats`: the wizards by
 * network seat (default [player, enemy]); wins and owners are by seat too. Projectiles sorted by id.
 */
export function captureSnapshot(game: Game, match: Match, tick: number, ack = -1, seats: readonly Wizard[] = [game.player, game.enemy]): Snapshot {
  const arena: ArenaState = {
    fireRadius: game.arena.fireRadius,
    pillars: game.arena.pillars.map((p) => (p.alive ? p.hp : -1)),
    tickets: game.tickets.pool.filter((t) => t.active).map((t) => ({ id: t.id, x: t.pos.x, z: t.pos.z, age: t.age })),
  };
  const projectiles = game.spells.pool.active.map((p) => captureProjectile(p, seats)).sort((a, b) => a.id - b.id);
  const phase = match.phase;
  return {
    v: SNAPSHOT_VERSION,
    tick,
    ack,
    wizards: seats.map(captureWizard),
    projectiles,
    arena,
    match: {
      phase,
      round: match.round,
      wins: [match.wins[seats[0].side], match.wins[seats[1].side]],
      timer: match.timer,
      phaseTime: match.phaseTime,
      lastWinnerSeat: match.lastWinner ? seats.indexOf(match.lastWinner) : -1,
    },
  };
}

export interface ApplyOptions {
  /** The wizards by network seat (default [player, enemy]). */
  seats?: readonly Wizard[];
  /** Seats whose movement fields the caller sets itself (guest prediction, interpolation). */
  skipMovement?: readonly number[];
  /** Apply projectiles (default true). */
  projectiles?: boolean;
}

/** Put one wizard in the captured state. Movement fields are skipped with `movement` false. */
export function applyWizard(w: Wizard, s: WizardState, movement = true): void {
  if (movement) {
    w.prevPos.copy(w.pos);
    w.pos.set(s.pos[0], s.pos[1], s.pos[2]);
    w.vel.set(s.vel[0], 0, s.vel[1]);
    w.vy = s.vy;
    w.grounded = s.grounded;
    w.prevFacing = w.facing;
    w.facing = s.facing;
    w.intent.facing = s.facing;
    w.placeBody();
  }
  w.maxHealth = s.maxHealth;
  w.health = s.health;
  w.mana = s.mana;
  w.manaBoost = s.manaBoost;
  w.ult = s.ult;
  COOLDOWNS.forEach((k, i) => (w.cd[k] = s.cd[i] ?? 0));
  w.stunTime = s.stunTime;
  w.shieldTime = s.shieldTime;
  w.shieldAge = s.shieldAge;
  w.dodgeTime = s.dodgeTime;
  w.iframes = s.iframes;
  w.dodgeDir.set(s.dodgeDir[0], 0, s.dodgeDir[1]);
  w.cast = s.cast ? { spell: s.cast.spell, elapsed: s.cast.elapsed, duration: s.cast.duration } : null;
  w.castPulse = s.castPulse;
  w.hitFlash = s.hitFlash;
  w.burning = s.burning;
  w.sprinting = s.sprinting;
  w.jumps = s.jumps;
  w.landings = s.landings;
  if (s.stats) Object.assign(w.stats, s.stats);
  w.setAlive(s.alive);
}

/**
 * Make the replica's live projectiles match `list` by id: unknown ids are spawned (owner, look,
 * position), known ones moved, and ones the host no longer has released. No events are emitted:
 * the host's own cast / impact events are re-emitted separately (src/net/events.ts).
 */
export function applyProjectiles(game: Game, list: readonly ProjectileState[], seats: readonly Wizard[] = [game.player, game.enemy]): void {
  const pool = game.spells.pool;
  const want = new Map<number, ProjectileState>();
  for (const s of list) want.set(s.id, s);
  for (let i = pool.active.length - 1; i >= 0; i--) {
    const p = pool.active[i];
    if (!want.has(p.netId)) pool.release(p);
  }
  const have = new Map<number, Projectile>();
  for (const p of pool.active) have.set(p.netId, p);
  for (const s of list) {
    const owner = seats[s.owner] ?? game.enemy;
    let p = have.get(s.id);
    if (!p) {
      const fresh = pool.spawn(s.kind);
      if (!fresh) continue;
      p = fresh;
      p.netId = s.id;
      p.owner = p.caster = owner;
      p.pos.set(s.pos[0], s.pos[1], s.pos[2]);
      p.prevPos.copy(p.pos);
      p.vel.set(s.vel[0], s.vel[1], s.vel[2]);
      p.radius = s.radius;
      p.reflected = s.reflected;
      p.refreshLook();
      continue;
    }
    p.prevPos.copy(p.pos);
    p.pos.set(s.pos[0], s.pos[1], s.pos[2]);
    p.vel.set(s.vel[0], s.vel[1], s.vel[2]);
    const relook = p.owner !== owner || p.radius !== s.radius;
    p.owner = owner;
    p.radius = s.radius;
    p.reflected = s.reflected;
    if (relook) p.refreshLook();
  }
}

/** Arena: fire ring, pillars by index, golden tickets by id (spawned / removed without events). */
export function applyArena(game: Game, a: ArenaState): void {
  game.arena.fireRadius = a.fireRadius;
  const pillars = game.arena.pillars;
  for (let i = 0; i < pillars.length && i < a.pillars.length; i++) pillars[i].setNetState(a.pillars[i]);
  game.tickets.applyNetState(a.tickets);
}

/** Apply a whole snapshot onto the replica `game` / `match`. */
export function applySnapshot(game: Game, match: Match, snap: Snapshot, opts: ApplyOptions = {}): void {
  const seats = opts.seats ?? [game.player, game.enemy];
  snap.wizards.forEach((s, i) => {
    const w = seats[i];
    if (w) applyWizard(w, s, !opts.skipMovement?.includes(i));
  });
  if (opts.projectiles !== false) applyProjectiles(game, snap.projectiles, seats);
  applyArena(game, snap.arena);
  const m = snap.match;
  match.phase = m.phase as Phase;
  match.round = m.round;
  seats.forEach((w, i) => (match.wins[w.side] = m.wins[i] ?? 0));
  match.timer = m.timer;
  match.phaseTime = m.phaseTime;
  match.lastWinner = m.lastWinnerSeat >= 0 ? seats[m.lastWinnerSeat] ?? null : null;
  game.actionsLocked = m.phase !== 'fight';
}
