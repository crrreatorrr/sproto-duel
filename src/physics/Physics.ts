import RAPIER from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three';
import type { Pillar } from '../arena/Pillar';
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
} as const;

const groups = (membership: number, filter: number) => ((membership & 0xffff) << 16) | (filter & 0xffff);

export interface QueryHit {
  tag: ColliderTag;
  /** Distance along the query direction. */
  distance: number;
  point: Vector3;
  normal: Vector3;
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
    }
  }

  /** Full column collider plus a short stump collider that takes over once the pillar crumbles. */
  addPillar(x: number, z: number, radius: number, height: number, stumpHeight: number, pillar: Pillar) {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, 0, z));
    const full = this.world.createCollider(
      RAPIER.ColliderDesc.cylinder(height / 2, radius).setTranslation(0, height / 2, 0).setCollisionGroups(groups(GROUP.WORLD, 0xffff)),
      body,
    );
    const stump = this.world.createCollider(
      RAPIER.ColliderDesc.cylinder(stumpHeight / 2, radius * 1.15).setTranslation(0, stumpHeight / 2, 0)
        .setCollisionGroups(groups(GROUP.WORLD, 0xffff)).setEnabled(false),
      body,
    );
    this.tags.set(full.handle, { kind: 'pillar', pillar });
    this.tags.set(stump.handle, { kind: 'pillar', pillar });
    return { full, stump };
  }

  /** Kinematic capsule whose bottom sits on y = 0 when the body is at `capsuleCenterY`. */
  addWizard(radius: number, height: number, wizard: Wizard) {
    const halfHeight = Math.max(0.05, height / 2 - radius);
    const centerY = height / 2 + 0.02;
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, centerY, 0));
    const desc = RAPIER.ColliderDesc.capsule(halfHeight, radius).setCollisionGroups(groups(GROUP.WIZARD, 0xffff));
    const collider = this.world.createCollider(desc, body);
    this.tags.set(collider.handle, { kind: 'wizard', wizard });
    return { body, collider, centerY };
  }

  /**
   * Slide a wizard capsule by `delta` against walls, pillars and the other wizard.
   * Writes the allowed movement into `out`.
   */
  moveCharacter(collider: RAPIER.Collider, delta: Vector3, out: Vector3): Vector3 {
    this.characterController.computeColliderMovement(
      collider,
      { x: delta.x, y: 0, z: delta.z },
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      groups(0xffff, GROUP.WORLD | GROUP.WIZARD),
    );
    const m = this.characterController.computedMovement();
    return out.set(m.x, 0, m.z);
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

  /** True if nothing in the WORLD group (pillars/walls) blocks the line a -> b. */
  lineOfSight(a: Vector3, b: Vector3): boolean {
    const dir = this.losDir.subVectors(b, a);
    const len = dir.length();
    if (len < 1e-4) return true;
    dir.divideScalar(len);
    return this.raycast(a, dir, len, GROUP.WORLD) === null;
  }

  step(): void {
    this.world.step();
  }
}
