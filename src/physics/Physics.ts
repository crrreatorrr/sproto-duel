import RAPIER from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three';
import type { ObstacleShape, Pillar } from '../arena/Pillar';
import type { Wizard } from '../wizard/Wizard';

/** What a collider belongs to, so query hits can be routed to gameplay objects. */
export type ColliderTag =
  | { kind: 'floor' }
  | { kind: 'wall' }
  | { kind: 'pillar'; pillar: Pillar }
  | { kind: 'wizard'; wizard: Wizard };

/** Collision group bits. */
export const GROUP = {
  WORLD: 1 << 0, // walls + pillars
  WIZARD: 1 << 1,
  GROUND: 1 << 2,
  /** Invisible wall extension that only wizards collide with, so jumps can't clear the low wall. */
  BARRIER: 1 << 3,
} as const;

const groups = (membership: number, filter: number) => ((membership & 0xffff) << 16) | (filter & 0xffff);
const capsuleHalfHeight = (radius: number, height: number) => Math.max(0.05, height / 2 - radius);
/** How far the wizards-only barrier reaches above the visible wall. */
const BARRIER_HEIGHT = 6;

export interface QueryHit {
  tag: ColliderTag;
  /** Distance along the query direction. */
  distance: number;
  point: Vector3;
  normal: Vector3;
}

/** What the last `moveCharacter` call ended up standing on. */
export interface CharacterSupport {
  /** Resting on a walkable surface (stump top). The floor is handled by the caller. */
  grounded: boolean;
  /** Resting on another wizard's head: not walkable, slide off. */
  onWizard: Wizard | null;
}

export class Physics {
  readonly world: RAPIER.World;
  private readonly tags = new Map<number, ColliderTag>();
  private readonly characterController: RAPIER.KinematicCharacterController;
  private readonly ball = new Map<number, RAPIER.Ball>();
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  private readonly identity = { x: 0, y: 0, z: 0, w: 1 };
  private readonly unitDir = { x: 0, y: 0, z: 0 };
  private readonly losDir = new Vector3();
  private readonly collision = new RAPIER.CharacterCollision();
  private readonly down = { x: 0, y: -1, z: 0 };
  private readonly probePos = { x: 0, y: 0, z: 0 };
  /** Result of the latest `moveCharacter`. */
  readonly support: CharacterSupport = { grounded: false, onWizard: null };
  /** One persistent predicate so per-projectile queries don't allocate closures. */
  private activeSkip: ((tag: ColliderTag) => boolean) | null = null;
  private readonly predicate = (c: RAPIER.Collider) => {
    const tag = this.tags.get(c.handle);
    return !tag || !this.activeSkip || !this.activeSkip(tag);
  };

  static async create(): Promise<Physics> {
    await RAPIER.init();
    return new Physics();
  }

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    this.characterController = this.world.createCharacterController(0.02);
    this.characterController.setSlideEnabled(true);
    this.characterController.setApplyImpulsesToDynamicBodies(false);
    // Vertical motion is ours (gravity, jumps): no snapping down ledges, no auto-climbing stumps.
    this.characterController.disableSnapToGround();
    this.characterController.disableAutostep();
  }

  tagOf(collider: RAPIER.Collider): ColliderTag | undefined {
    return this.tags.get(collider.handle);
  }

  addFloor(radius: number): void {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    const desc = RAPIER.ColliderDesc.cylinder(0.5, radius).setCollisionGroups(groups(GROUP.GROUND, 0xffff));
    this.tags.set(this.world.createCollider(desc, body).handle, { kind: 'floor' });
  }

  /** A ring of boxes approximating a circular wall. */
  addRingWall(radius: number, height: number, segments = 40): void {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const thickness = 1;
    const halfLen = Math.tan(Math.PI / segments) * (radius + thickness) + 0.05;
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const r = radius + thickness / 2;
      const q = { x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) };
      const desc = RAPIER.ColliderDesc.cuboid(halfLen, height / 2, thickness / 2)
        .setTranslation(Math.sin(a) * r, height / 2, Math.cos(a) * r)
        .setRotation(q)
        .setCollisionGroups(groups(GROUP.WORLD, 0xffff));
      this.tags.set(this.world.createCollider(desc, body).handle, { kind: 'wall' });
      // Wizards-only extension above the visible wall. Spells, camera and line of sight ignore it.
      const barrier = RAPIER.ColliderDesc.cuboid(halfLen, BARRIER_HEIGHT / 2, thickness / 2)
        .setTranslation(Math.sin(a) * r, height + BARRIER_HEIGHT / 2, Math.cos(a) * r)
        .setRotation(q)
        .setCollisionGroups(groups(GROUP.BARRIER, GROUP.WIZARD));
      this.tags.set(this.world.createCollider(barrier, body).handle, { kind: 'wall' });
    }
  }

  /**
   * An obstacle's colliders: one per part (boxes and cylinders, turned by `shape.yaw` and their own
   * yaw), plus short stump colliders for the floor parts that take over once it crumbles (none if
   * `stumpHeight` is 0). `moving` obstacles get a kinematic body (Pillar.moveTo slides it).
   */
  addPillar(x: number, z: number, shape: ObstacleShape, pillar: Pillar, moving = false) {
    const half = shape.yaw / 2;
    const desc = moving ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.fixed();
    const body = this.world.createRigidBody(desc.setTranslation(x, 0, z).setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }));
    const make = (p: ObstacleShape['parts'][number], top: number, scale: number, enabled: boolean) => {
      const h = top - p.y0;
      const d = p.shape === 'box'
        ? RAPIER.ColliderDesc.cuboid(p.halfX * scale, h / 2, p.halfZ * scale)
        : RAPIER.ColliderDesc.cylinder(h / 2, p.radius * scale);
      d.setTranslation(p.x, p.y0 + h / 2, p.z)
        .setRotation({ x: 0, y: Math.sin(p.yaw / 2), z: 0, w: Math.cos(p.yaw / 2) })
        .setCollisionGroups(groups(GROUP.WORLD, 0xffff))
        .setEnabled(enabled);
      const c = this.world.createCollider(d, body);
      this.tags.set(c.handle, { kind: 'pillar', pillar });
      return c;
    };
    const full = shape.parts.map((p) => make(p, p.height, 1, true));
    const stump = shape.stumpHeight > 0
      ? shape.parts.filter((p) => p.y0 === 0).map((p) => make(p, Math.min(p.height, shape.stumpHeight), shape.stumpScale, false))
      : [];
    return { body, full, stump };
  }

  /** True if a wizard's capsule overlaps a box (half extents, turned by `yaw`) centred at (x, y, z). */
  boxTouchesWizard(x: number, y: number, z: number, hx: number, hy: number, hz: number, yaw: number): boolean {
    const box = new RAPIER.Cuboid(hx, hy, hz);
    const hit = this.world.intersectionWithShape(
      { x, y, z }, { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, box,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(0xffff, GROUP.WIZARD),
    );
    return hit !== null;
  }

  /** Kinematic capsule whose bottom sits on y = 0 when the body is at `capsuleCenterY`. */
  addWizard(radius: number, height: number, wizard: Wizard) {
    const centerY = height / 2 + 0.02;
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, centerY, 0));
    const desc = RAPIER.ColliderDesc.capsule(capsuleHalfHeight(radius, height), radius).setCollisionGroups(groups(GROUP.WIZARD, 0xffff));
    const collider = this.world.createCollider(desc, body);
    this.tags.set(collider.handle, { kind: 'wizard', wizard });
    return { body, collider, centerY };
  }

  /** Reshape a wizard capsule (a short boss). Returns the new body centre height (see addWizard). */
  resizeWizard(collider: RAPIER.Collider, radius: number, height: number): number {
    collider.setRadius(radius);
    collider.setHalfHeight(capsuleHalfHeight(radius, height));
    return height / 2 + 0.02;
  }

  /**
   * A knocked-out wizard stops being solid: nothing walks into, aims at or hits the body (its own
   * moves still slide against the world). An inactive one (a parked boss partner) is removed from
   * the world entirely with `enabled` false.
   */
  setWizardSolid(collider: RAPIER.Collider, solid: boolean, enabled = true): void {
    collider.setCollisionGroups(groups(solid ? GROUP.WIZARD : 0, 0xffff));
    collider.setEnabled(enabled);
  }

  /**
   * Slide a wizard capsule by `delta` (3D) against walls, pillars, stumps and the other wizard.
   * Writes the allowed movement into `out` and what it ended up resting on into `support`.
   * The floor is not part of this query: callers keep y >= 0 themselves.
   */
  moveCharacter(collider: RAPIER.Collider, delta: Vector3, out: Vector3): Vector3 {
    const kcc = this.characterController;
    kcc.computeColliderMovement(
      collider,
      { x: delta.x, y: delta.y, z: delta.z },
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      groups(0xffff, GROUP.WORLD | GROUP.WIZARD | GROUP.BARRIER),
    );
    const m = kcc.computedMovement();
    this.support.grounded = kcc.computedGrounded();
    this.support.onWizard = null;
    for (let i = 0, n = kcc.numComputedCollisions(); i < n; i++) {
      const hit = kcc.computedCollision(i, this.collision);
      if (!hit?.collider || hit.normal1.y < 0.3) continue;
      const tag = this.tags.get(hit.collider.handle);
      if (tag?.kind === 'wizard') this.support.onWizard = tag.wizard;
    }
    if (this.support.onWizard) this.support.grounded = false;
    return out.set(m.x, m.y, m.z);
  }

  /**
   * Height of the highest walkable thing (floor, stump top) under a disc of `radius` at `pos`,
   * searching down from `pos.y`. Used for airborne ground markers and wave clearance.
   */
  groundHeightBelow(pos: Vector3, radius: number): number {
    if (pos.y <= 0) return 0;
    let shape = this.ball.get(radius);
    if (!shape) this.ball.set(radius, (shape = new RAPIER.Ball(radius)));
    this.probePos.x = pos.x;
    this.probePos.y = pos.y + radius;
    this.probePos.z = pos.z;
    const hit = this.world.castShape(
      this.probePos, this.identity, this.down, shape, 0, pos.y + radius, true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(0xffff, GROUP.WORLD),
    );
    return hit ? Math.max(0, Math.min(pos.y, hit.witness1.y)) : 0;
  }

  /**
   * Height of the highest walkable top (WORLD colliders: cover, stumps) under a disc of `radius` at
   * (x, z), looking down from `maxY`; 0 when only the floor is there. Infinity when something there
   * reaches above `maxY` (too tall to stand on from here). The Magic Carpet uses it to hover.
   */
  surfaceBelow(x: number, z: number, radius: number, maxY: number): number {
    if (maxY <= 0) return 0;
    let shape = this.ball.get(radius);
    if (!shape) this.ball.set(radius, (shape = new RAPIER.Ball(radius)));
    this.probePos.x = x;
    this.probePos.y = maxY + radius;
    this.probePos.z = z;
    const hit = this.world.castShape(
      this.probePos, this.identity, this.down, shape, 0, maxY, true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(0xffff, GROUP.WORLD),
    );
    if (!hit) return 0;
    if (hit.time_of_impact < 1e-4) return Infinity;
    return Math.max(0, maxY - hit.time_of_impact);
  }

  /**
   * Sweep a sphere from `origin` along `motion`. Returns the first hit within the motion length.
   * `skip` lets callers ignore colliders (e.g. a wizard with i-frames).
   */
  sphereCast(
    origin: Vector3,
    motion: Vector3,
    radius: number,
    mask: number,
    exclude?: RAPIER.Collider,
    skip?: (tag: ColliderTag) => boolean,
  ): QueryHit | null {
    const len = motion.length();
    if (len < 1e-6) return null;
    let shape = this.ball.get(radius);
    if (!shape) this.ball.set(radius, (shape = new RAPIER.Ball(radius)));
    this.activeSkip = skip ?? null;
    this.unitDir.x = motion.x / len;
    this.unitDir.y = motion.y / len;
    this.unitDir.z = motion.z / len;
    const hit = this.world.castShape(
      origin,
      this.identity,
      this.unitDir,
      shape,
      0,
      len,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      groups(0xffff, mask),
      exclude,
      undefined,
      skip ? this.predicate : undefined,
    );
    this.activeSkip = null;
    if (!hit) return null;
    const tag = this.tags.get(hit.collider.handle);
    if (!tag) return null;
    const t = hit.time_of_impact;
    return {
      tag,
      distance: t,
      point: new Vector3(hit.witness1.x, hit.witness1.y, hit.witness1.z),
      normal: new Vector3(hit.normal1.x, hit.normal1.y, hit.normal1.z),
    };
  }

  raycast(
    origin: Vector3,
    dir: Vector3,
    maxDistance: number,
    mask: number,
    exclude?: RAPIER.Collider,
    skip?: (tag: ColliderTag) => boolean,
  ): QueryHit | null {
    this.ray.origin = { x: origin.x, y: origin.y, z: origin.z };
    this.ray.dir = { x: dir.x, y: dir.y, z: dir.z };
    this.activeSkip = skip ?? null;
    const hit = this.world.castRayAndGetNormal(
      this.ray,
      maxDistance,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      groups(0xffff, mask),
      exclude,
      undefined,
      skip ? this.predicate : undefined,
    );
    this.activeSkip = null;
    if (!hit) return null;
    const tag = this.tags.get(hit.collider.handle);
    if (!tag) return null;
    const d = hit.timeOfImpact;
    return {
      tag,
      distance: d,
      point: new Vector3(origin.x + dir.x * d, origin.y + dir.y * d, origin.z + dir.z * d),
      normal: new Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
    };
  }

  /** True if nothing in the WORLD group (pillars/walls) blocks the line a -> b. Glass doesn't. */
  lineOfSight(a: Vector3, b: Vector3): boolean {
    const dir = this.losDir.subVectors(b, a);
    const len = dir.length();
    if (len < 1e-4) return true;
    dir.divideScalar(len);
    return this.raycast(a, dir, len, GROUP.WORLD, undefined, this.seeThrough) === null;
  }

  /**
   * True if nothing in the WORLD group blocks a -> b, glass included: for damage that cover stops
   * (Hellfire Breath). Sight (lineOfSight) sees through glass; spells don't pass it.
   */
  clearPath(a: Vector3, b: Vector3): boolean {
    const dir = this.losDir.subVectors(b, a);
    const len = dir.length();
    if (len < 1e-4) return true;
    dir.divideScalar(len);
    return this.raycast(a, dir, len, GROUP.WORLD) === null;
  }

  /** Skip transparent cover (glass partitions) in sight checks. */
  private readonly seeThrough = (tag: ColliderTag) => tag.kind === 'pillar' && tag.pillar.shape.seeThrough;

  step(): void {
    this.world.step();
  }
}
