import * as THREE from 'three';
import { CONFIG, type TeamPalette } from '../config';
import type { ProjectileSkin } from '../campaign/levels';
import type { Effects } from '../fx/Effects';
import { glowTexture } from '../fx/textures';
import type { Wizard } from '../wizard/Wizard';
import { ProjectileSkins, type SkinSlot, type SkinTarget } from './ProjectileSkins';

export type ProjectileKind = 'bolt' | 'blast';

const ORB_VERT = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vP;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vP = position;
    vN = normalize(mat3(modelMatrix) * normal);
    vV = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const ORB_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vP;
  void main() {
    float f = abs(dot(normalize(vN), normalize(vV)));
    float n = sin(vP.x * 9.0 + uTime * 7.0) * sin(vP.y * 8.0 - uTime * 6.0) * sin(vP.z * 10.0 + uTime * 5.0);
    float swirl = 0.5 + 0.5 * sin(atan(vP.z, vP.x) * 5.0 + vP.y * 6.0 - uTime * 10.0);
    vec3 c = uColor * (1.5 + n * 0.9 + swirl * 0.8) + vec3(1.0) * pow(f, 5.0) * 2.5;
    gl_FragColor = vec4(c, 1.0);
  }
`;

/**
 * Shared visual resources, one set per wizard index so reflection is just a material swap.
 * Indices beyond CONFIG.teams (extra wizards) get a set on first use, in their own palette.
 */
class ProjectileMaterials {
  readonly boltCore: THREE.MeshBasicMaterial[] = [];
  readonly boltGlow: THREE.SpriteMaterial[] = [];
  readonly blastCore: THREE.ShaderMaterial[] = [];
  readonly blastGlow: THREE.SpriteMaterial[] = [];

  constructor() {
    for (const team of CONFIG.teams) this.add(team);
  }

  private add(team: TeamPalette): void {
    const spell = new THREE.Color(team.spell);
    const blast = new THREE.Color(team.blast);
    this.boltCore.push(new THREE.MeshBasicMaterial({ color: spell.clone().lerp(new THREE.Color(1, 1, 1), 0.55).multiplyScalar(3.2), toneMapped: false }));
    this.boltGlow.push(this.glow(spell, 1.8));
    this.blastCore.push(new THREE.ShaderMaterial({
      vertexShader: ORB_VERT,
      fragmentShader: ORB_FRAG,
      uniforms: { uColor: { value: blast.clone() }, uTime: { value: 0 } },
      toneMapped: false,
    }));
    this.blastGlow.push(this.glow(blast, 1.6));
  }

  /** Make sure wizard `index` has materials (created in `team`'s palette if new). */
  ensure(index: number, team: TeamPalette): void {
    while (this.boltCore.length <= index) this.add(team);
  }

  /** Recolour one team's materials in place (campaign bosses). Same formulas as the constructor. */
  setTeam(index: number, team: TeamPalette): void {
    this.ensure(index, team);
    const spell = new THREE.Color(team.spell);
    const blast = new THREE.Color(team.blast);
    this.boltCore[index].color.copy(spell).lerp(new THREE.Color(1, 1, 1), 0.55).multiplyScalar(3.2);
    this.boltGlow[index].color.copy(spell).multiplyScalar(1.8);
    (this.blastCore[index].uniforms.uColor.value as THREE.Color).copy(blast);
    this.blastGlow[index].color.copy(blast).multiplyScalar(1.6);
  }

  private glow(color: THREE.Color, intensity: number): THREE.SpriteMaterial {
    return new THREE.SpriteMaterial({
      map: glowTexture(),
      color: color.clone().multiplyScalar(intensity),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      toneMapped: false,
    });
  }

  tick(time: number): void {
    for (const m of this.blastCore) m.uniforms.uTime.value = time;
  }
}

export class Projectile implements SkinTarget {
  active = false;
  owner!: Wizard;
  /** Who originally cast it (for perfect reflects homing back). */
  caster!: Wizard;
  readonly pos = new THREE.Vector3();
  readonly prevPos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  radius = 0;
  damage = 0;
  power = 0;
  /** Power at cast time; clashes shrink a surviving spell relative to this. */
  basePower = 0;
  life = 0;
  reflected = false;
  homing: Wizard | null = null;
  /**
   * Lock-On (a reward spell): the enemy this bolt gently curves toward (CONFIG.rewardSpells.lockon).
   * Dropped when it is reflected or deflected, its target falls, or it flies past it.
   */
  seek: Wizard | null = null;
  /** Ticks alive. */
  age = 0;
  /** Wizard this projectile already passed through during a dodge (for the EVADE callout). */
  evaded: Wizard | null = null;
  /** Bit per wizard index: set once that wizard's AI has evaluated this projectile. Cleared on spawn. */
  seenMask = 0;
  /**
   * What it looks like in flight: the caster's skin for this kind (`Wizard.skins`), picked at
   * launch and kept for life, so a reflected phone flies back as a phone. 'orb' = the spell orb.
   */
  skin: ProjectileSkin = 'orb';
  readonly group = new THREE.Group();
  private readonly core: THREE.Mesh;
  private readonly glow: THREE.Sprite;
  /** The object's instance when skinned. */
  private slot: SkinSlot | null = null;
  /** Set by the first refreshLook after spawn (casters set owner/caster/pos/vel, then refresh). */
  private launched = false;

  constructor(
    readonly kind: ProjectileKind,
    private readonly mats: ProjectileMaterials,
    geo: THREE.SphereGeometry,
    private readonly skins: ProjectileSkins,
  ) {
    this.core = new THREE.Mesh(geo, kind === 'bolt' ? mats.boltCore[0] : mats.blastCore[0]);
    this.glow = new THREE.Sprite(kind === 'bolt' ? mats.boltGlow[0] : mats.blastGlow[0]);
    this.group.add(this.core, this.glow);
    this.group.visible = false;
  }

  /** The object's instance while skinned (QA). */
  get skinSlot(): SkinSlot | null {
    return this.slot;
  }

  get color(): number {
    const team = this.owner.team;
    return this.kind === 'bolt' ? team.spell : team.blast;
  }

  /**
   * Apply owner team materials and scale. Called on spawn, reflect, and clash shrink. The first
   * call after spawn also launches the caster's skin. Objects keep a smaller glow in the owner's
   * colour, so they still read as spells (and show who sent a reflected one back).
   */
  refreshLook(): void {
    if (!this.launched) this.launch();
    const team = this.owner.index;
    this.mats.ensure(team, this.owner.team);
    const glow = this.slot ? CONFIG.projectileSkins.glowScale[this.kind] * this.skins.glowSize(this.slot.skin) : 1;
    if (this.kind === 'bolt') {
      this.core.material = this.mats.boltCore[team];
      this.glow.material = this.mats.boltGlow[team];
      this.glow.scale.setScalar(this.radius * 9 * glow);
    } else {
      this.core.material = this.mats.blastCore[team];
      this.glow.material = this.mats.blastGlow[team];
      this.glow.scale.setScalar(this.radius * 6.5 * glow);
    }
    this.core.scale.setScalar(this.radius);
  }

  private launch(): void {
    this.launched = true;
    const skin = this.caster?.skins?.[this.kind] ?? 'orb';
    this.slot = skin === 'orb' ? null : this.skins.acquire(skin, this.caster.index, this);
    this.skin = this.slot ? skin : 'orb'; // a full batch falls back to the orb
    this.core.visible = !this.slot;
    if (this.slot) this.skins.launched(this.slot, this);
  }

  /** Back to the pool: return the object instance. */
  recycle(): void {
    if (this.slot) {
      this.skins.ended(this.slot, this);
      this.skins.release(this.slot);
    }
    this.slot = null;
    this.skin = 'orb';
    this.launched = false;
    this.core.visible = true;
  }

  /** Per-tick trail: glowing motes for the orb, the object's own trail (smoke, crumbs...) otherwise. */
  trail(fx: Effects): void {
    if (this.slot) this.skins.trail(this.slot, this);
    else fx.trail(this.pos, this.color, this.kind === 'bolt' ? 0.22 : 0.5 * (this.radius / CONFIG.spells.blast.radius), this.kind === 'bolt' ? 1 : 3);
  }

  /** Render-time placement with interpolation; bolts stretch along their velocity. Objects pose in ProjectileSkins.sync. */
  sync(alpha: number, time: number): void {
    this.group.position.lerpVectors(this.prevPos, this.pos, alpha);
    if (this.slot) return;
    if (this.kind === 'bolt') {
      const speed = this.vel.length();
      this.core.scale.set(this.radius * 0.8, this.radius * 0.8, this.radius * (1 + speed * 0.06));
      if (speed > 0.01) this.core.lookAt(this.group.position.x + this.vel.x, this.group.position.y + this.vel.y, this.group.position.z + this.vel.z);
    } else {
      const pulse = 1 + Math.sin(time * 18) * 0.06;
      this.core.scale.setScalar(this.radius * pulse);
      this.core.rotation.y = time * 3;
    }
  }
}

/** Fixed pool of projectiles. Nothing is allocated after construction. */
export class ProjectilePool {
  readonly active: Projectile[] = [];
  private readonly free: Record<ProjectileKind, Projectile[]> = { bolt: [], blast: [] };
  private readonly mats = new ProjectileMaterials();
  /** Object looks for skinned projectiles (boss rugs, phones, bullets...). */
  readonly skins: ProjectileSkins;

  /** `fx` draws the objects' launch cues and trails (optional for headless tools). */
  constructor(scene: THREE.Scene, fx: Effects | null = null, boltCount = 64, blastCount = 12) {
    this.skins = new ProjectileSkins(scene, fx);
    const geo = new THREE.SphereGeometry(1, 12, 10);
    for (let i = 0; i < boltCount; i++) this.add(scene, new Projectile('bolt', this.mats, geo, this.skins));
    for (let i = 0; i < blastCount; i++) this.add(scene, new Projectile('blast', this.mats, geo, this.skins));
  }

  private add(scene: THREE.Scene, p: Projectile): void {
    scene.add(p.group);
    this.free[p.kind].push(p);
  }

  spawn(kind: ProjectileKind): Projectile | null {
    const p = this.free[kind].pop();
    if (!p) return null;
    p.active = true;
    p.reflected = false;
    p.homing = null;
    p.seek = null;
    p.evaded = null;
    p.seenMask = 0;
    p.age = 0;
    p.group.visible = true;
    this.active.push(p);
    return p;
  }

  release(p: Projectile): void {
    if (!p.active) return;
    p.active = false;
    p.group.visible = false;
    p.recycle();
    const i = this.active.indexOf(p);
    if (i >= 0) {
      this.active[i] = this.active[this.active.length - 1];
      this.active.pop();
    }
    this.free[p.kind].push(p);
  }

  releaseAll(): void {
    while (this.active.length) this.release(this.active[this.active.length - 1]);
  }

  /**
   * Re-skin a team's projectiles at runtime (the rival takes each campaign boss's spell colours).
   * Materials are shared per team, so live projectiles change colour too.
   */
  setTeamPalette(index: number, team: TeamPalette): void {
    this.mats.setTeam(index, team);
    this.skins.setTeam(index, team);
  }

  /**
   * Get a team's object looks ready (Game.setupEnemy, with the boss's skins): builds them now so
   * nothing compiles mid-fight, and frees looks the team no longer uses.
   */
  prepareSkins(index: number, skins: Readonly<{ bolt: ProjectileSkin; blast: ProjectileSkin }> | null): void {
    this.skins.prepare(index, skins ? [skins.bolt, skins.blast] : []);
  }

  /** Current bolt glow colour of a team (QA). */
  teamBoltColor(index: number): THREE.Color {
    this.mats.ensure(index, CONFIG.teams[index % CONFIG.teams.length]);
    return this.mats.boltGlow[index].color;
  }

  sync(alpha: number, time: number): void {
    this.mats.tick(time);
    for (const p of this.active) p.sync(alpha, time);
    this.skins.sync(time);
  }
}
