import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG } from '../config';
import type { AssetLoader } from '../assets/AssetLoader';
import { events } from '../core/events';
import { rand } from '../core/math';
import type { Effects } from '../fx/Effects';
import { glowTexture } from '../fx/textures';
import { GROUP, type Physics } from '../physics/Physics';
import type { Wizard } from '../wizard/Wizard';
import type { Arena } from './Arena';

const T = CONFIG.tickets;
/** Ticket gold (sparkles, glow, beam). */
const GOLD = 0xffc53d;
const GOLD_HI = 0xfff0b0;
/** Spawn pop: seconds to grow in (with overshoot) and to shrink away when collected or expired. */
const POP_TIME = 0.45;
const VANISH_TIME = 0.28;
/** Boosted-wizard auras (ground glow + ring) available at once; more boosted wizards still sparkle. */
const AURA_POOL = 4;

const BEAM_VERT = /* glsl */ `
  varying vec2 vUv;
  varying float vFacing;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * normal);
    vFacing = abs(dot(n, normalize(-mv.xyz)));
    gl_Position = projectionMatrix * mv;
  }
`;
const BEAM_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uTime;
  varying vec2 vUv;
  varying float vFacing;
  void main() {
    float fade = pow(1.0 - vUv.y, 1.6);
    float shimmer = 0.75 + 0.25 * sin(vUv.y * 28.0 - uTime * 5.0);
    float a = fade * shimmer * pow(vFacing, 1.4) * uOpacity;
    gl_FragColor = vec4(uColor * (1.0 + 1.5 * fade), a);
  }
`;

const tmpColor = new THREE.Color();
const tmpColor2 = new THREE.Color();
const tmpPos = new THREE.Vector3();

/** One pooled ticket. Gameplay state plus its meshes; `id` is new on every spawn. */
export class GoldenTicket {
  active = false;
  id = 0;
  /** Centre at hover height (without the bob). */
  readonly pos = new THREE.Vector3();
  /** Seconds on the floor (counts only during the fight). */
  age = 0;
  readonly root = new THREE.Group();
  readonly card = new THREE.Group();
  readonly glow: THREE.Sprite;
  readonly beam: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>;
  readonly floorGlow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  /** Visual clocks: time since spawn, time left of the vanish animation. */
  popTime = 0;
  vanishTime = 0;
  spin = 0;
  phase = 0;
  sparkAcc = 0;

  constructor(cardMaterial: THREE.Material, cardGeo: THREE.PlaneGeometry, beamGeo: THREE.CylinderGeometry, floorGeo: THREE.PlaneGeometry) {
    // Two faces back to back, so the art reads the right way round from both sides.
    const front = new THREE.Mesh(cardGeo, cardMaterial);
    const back = new THREE.Mesh(cardGeo, cardMaterial);
    back.rotation.y = Math.PI;
    front.castShadow = back.castShadow = true;
    this.card.add(front, back);
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), color: GOLD, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, opacity: 0.55,
    }));
    this.glow.renderOrder = 11;
    this.beam = new THREE.Mesh(beamGeo, new THREE.ShaderMaterial({
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      uniforms: { uColor: { value: new THREE.Color(GOLD) }, uOpacity: { value: 0.5 }, uTime: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    }));
    this.beam.renderOrder = 10;
    this.floorGlow = new THREE.Mesh(floorGeo, new THREE.MeshBasicMaterial({
      map: glowTexture(), color: GOLD, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, opacity: 0.5,
    }));
    this.floorGlow.position.y = 0.03;
    this.floorGlow.renderOrder = 8;
    this.root.add(this.card, this.glow, this.beam, this.floorGlow);
    this.root.visible = false;
  }

  /** Seconds before it disappears. */
  get remaining(): number {
    return T.lifetime - this.age;
  }
}

interface Aura {
  root: THREE.Group;
  disc: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
}

function horizontalDistance(a: THREE.Vector3, x: number, z: number): number {
  return Math.hypot(a.x - x, a.z - z);
}

/**
 * Golden tickets: up to `CONFIG.tickets.maxActive` floating pickups during the fight phase. Any
 * wizard that touches one gets a mana boost (`Wizard.manaBoost`): max mana x1.5 and refilled (regen per
 * CONFIG.tickets), for 15 s; another ticket refreshes it. Spawn spots are random open floor inside the
 * fire ring, checked with a physics shape query (so any obstacle shape counts), away from wizards.
 *
 * Fixed-tick `update` owns spawning, lifetimes and pickups; `updateVisual` animates the pooled
 * meshes (three cards, never more) and the boosted-wizard auras. Announces ticketSpawn, ticketPickup
 * and ticketExpire; Wizard announces manaBoostEnd.
 */
export class GoldenTickets {
  /** Spawning, ageing and pickups run only while true: the fight phase (Match sets it; QA and the soak too). */
  enabled = false;
  /** Fixed pool: one entry (and one set of meshes) per possible ticket. */
  readonly pool: GoldenTicket[] = [];
  /** Seconds until the next spawn attempt (counts down while fewer than maxActive exist). */
  spawnTimer = 0;
  /** Seconds between spawns [min, max]: CONFIG.tickets.spawnInterval, or bossSpawnInterval in a gauntlet fight (Match sets it). */
  spawnInterval: readonly [number, number] = T.spawnInterval;
  private nextId = 1;
  private visualTime = 0;
  private readonly auras: Aura[] = [];
  private readonly cardMaterial: THREE.MeshStandardMaterial;
  private readonly probe = new RAPIER.Cylinder((T.hoverHeight + 1.5) / 2, T.obstacleClearance);
  private readonly probePos = { x: 0, y: 0, z: 0 };
  private readonly identity = { x: 0, y: 0, z: 0, w: 1 };
  /** Everything solid except the floor and wizards: pillars, stumps, walls and any future obstacle. */
  private readonly queryGroups = (0xffff << 16) | (0xffff & ~(GROUP.WIZARD | GROUP.GROUND));
  private readonly solidOnly = (c: RAPIER.Collider) => {
    const tag = this.physics.tagOf(c);
    return tag?.kind !== 'floor' && tag?.kind !== 'wizard';
  };

  constructor(
    scene: THREE.Scene,
    private readonly physics: Physics,
    private readonly fx: Effects,
    /** The live wizard list (any number of wizards). */
    private readonly wizards: readonly Wizard[],
    private readonly arena: Arena,
    assets: AssetLoader,
  ) {
    const face = assets.texture('goldenTicket') ?? ticketFaceTexture();
    face.anisotropy = 4;
    this.cardMaterial = new THREE.MeshStandardMaterial({
      map: face,
      emissiveMap: face,
      emissive: 0xffffff,
      emissiveIntensity: 0.4,
      metalness: 0.3,
      roughness: 0.32,
      alphaTest: 0.5,
    });
    const cardGeo = new THREE.PlaneGeometry(T.width, T.height);
    // The beam starts just above the card, so it never washes the art out.
    const beamGeo = new THREE.CylinderGeometry(0.36, 0.2, T.beamHeight, 18, 1, true).translate(0, T.beamHeight / 2 + T.hoverHeight + 0.45, 0);
    const floorGeo = new THREE.PlaneGeometry(2.6, 2.6).rotateX(-Math.PI / 2);
    for (let i = 0; i < T.maxActive; i++) {
      const t = new GoldenTicket(this.cardMaterial, cardGeo, beamGeo, floorGeo);
      scene.add(t.root);
      this.pool.push(t);
    }

    const discGeo = new THREE.PlaneGeometry(2.4, 2.4).rotateX(-Math.PI / 2);
    const ringGeo = new THREE.RingGeometry(0.78, 0.9, 48).rotateX(-Math.PI / 2);
    for (let i = 0; i < AURA_POOL; i++) {
      const disc = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial({
        map: glowTexture(), color: GOLD, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, opacity: 0.6,
      }));
      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        color: GOLD, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, opacity: 0.7, side: THREE.DoubleSide,
      }));
      disc.position.y = 0.035;
      ring.position.y = 0.05;
      disc.renderOrder = ring.renderOrder = 8;
      const root = new THREE.Group();
      root.add(disc, ring);
      root.visible = false;
      scene.add(root);
      this.auras.push({ root, disc, ring });
    }
    this.clear();
  }

  /** Tickets on the floor right now. */
  get activeCount(): number {
    let n = 0;
    for (const t of this.pool) if (t.active) n++;
    return n;
  }

  /** Boosted-wizard auras currently shown (QA). */
  get visibleAuras(): number {
    let n = 0;
    for (const a of this.auras) if (a.root.visible) n++;
    return n;
  }

  /** Remove every ticket at once (round reset) and restart the spawn clock. Boosts live on the wizards. */
  clear(): void {
    for (const t of this.pool) {
      t.active = false;
      t.vanishTime = 0;
      t.root.visible = false;
    }
    for (const a of this.auras) a.root.visible = false;
    this.spawnTimer = rand(T.firstSpawnDelay[0], T.firstSpawnDelay[1]);
  }

  // ------------------------------------------------------------------ simulation (fixed tick)

  update(dt: number): void {
    const fire = this.arena.fireRadius - T.fireBurnMargin;
    for (const t of this.pool) {
      if (!t.active) continue;
      if (Math.hypot(t.pos.x, t.pos.z) > fire) {
        this.expire(t, 'fire');
        continue;
      }
      if (!this.enabled) continue;
      t.age += dt;
      if (t.age >= T.lifetime) {
        this.expire(t, 'timeout');
        continue;
      }
      const w = this.toucher(t);
      if (w) this.collect(t, w);
    }
    if (!this.enabled || this.activeCount >= T.maxActive) return;
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = this.spawn() ? rand(this.spawnInterval[0], this.spawnInterval[1]) : T.retryDelay;
    }
  }

  /** The closest living wizard touching `t`, if any. */
  private toucher(t: GoldenTicket): Wizard | null {
    let best: Wizard | null = null;
    let bestD = T.pickupRadius;
    for (const w of this.wizards) {
      if (!w.alive || w.pos.y > T.pickupMaxHeight) continue;
      const d = horizontalDistance(w.pos, t.pos.x, t.pos.z);
      if (d <= bestD) {
        bestD = d;
        best = w;
      }
    }
    return best;
  }

  /** Give `w` the mana boost (or refresh it to the full duration; it never stacks) and remove the ticket. */
  collect(t: GoldenTicket, w: Wizard): void {
    const refreshed = w.manaBoost > 0;
    w.manaBoost = T.boostDuration;
    w.mana = w.maxMana;
    this.remove(t);
    tmpColor.setHex(GOLD);
    tmpColor2.setHex(GOLD_HI);
    const fx = this.fx;
    fx.sparks.burst(t.pos, 46, tmpColor, 3, 3, 9, 0.2, 0.75, { gravity: 5, drag: 2.2 }, 2);
    fx.sparks.burst(t.pos, 22, tmpColor2, 3.5, 1, 4, 0.3, 0.4, { drag: 4 });
    fx.flash(t.pos, GOLD, 3.6, 0.22);
    fx.ring(w.pos, GOLD, 2.8, 0.45);
    // A spiral of motes up the wizard.
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 4;
      fx.sparks.emit(w.pos.x + Math.sin(a) * 0.7, w.pos.y + 0.1 + i * 0.07, w.pos.z + Math.cos(a) * 0.7,
        Math.cos(a) * 1.2, 1.6, -Math.sin(a) * 1.2, tmpColor, 2.6, 0.13, 0.7, { drag: 1.5 });
    }
    events.emit('ticketPickup', { id: t.id, pos: t.pos, wizard: w, refreshed });
  }

  private expire(t: GoldenTicket, reason: 'timeout' | 'fire'): void {
    this.remove(t);
    tmpColor.setHex(reason === 'fire' ? 0xff8a3a : GOLD);
    this.fx.sparks.burst(t.pos, 20, tmpColor, 2, 1, 3.5, 0.13, 0.5, { gravity: reason === 'fire' ? -2 : 3, drag: 2.5 });
    this.fx.flash(t.pos, reason === 'fire' ? 0xff8a3a : GOLD, 1.6, 0.14);
    events.emit('ticketExpire', { id: t.id, pos: t.pos, reason });
  }

  private remove(t: GoldenTicket): void {
    t.active = false;
    t.vanishTime = VANISH_TIME;
  }

  /** Try random spots until one is valid; false if none was found this time. */
  spawn(): boolean {
    const radius = this.arena.fireRadius - T.fireMargin;
    if (radius < 1) return false;
    for (let i = 0; i < T.spawnAttempts; i++) {
      const r = radius * Math.sqrt(Math.random());
      const a = Math.random() * Math.PI * 2;
      const x = Math.sin(a) * r, z = Math.cos(a) * r;
      if (this.isValidSpot(x, z)) return this.spawnAt(x, z) !== null;
    }
    return false;
  }

  /** Put a ticket at (x, z) without any checks (QA). Null if the pool is full. */
  spawnAt(x: number, z: number): GoldenTicket | null {
    const t = this.pool.find((p) => !p.active);
    if (!t) return null;
    t.active = true;
    t.id = this.nextId++;
    t.age = 0;
    t.pos.set(x, T.hoverHeight, z);
    t.popTime = 0;
    t.vanishTime = 0;
    t.spin = Math.random() * Math.PI * 2;
    t.phase = Math.random() * Math.PI * 2;
    t.sparkAcc = 0;
    t.root.position.set(x, 0, z);
    t.root.visible = true;
    tmpColor.setHex(GOLD);
    this.fx.sparks.burst(t.pos, 30, tmpColor, 2.8, 2, 6, 0.16, 0.6, { gravity: 2, drag: 2.5 }, 1);
    this.fx.flash(t.pos, GOLD, 3, 0.25);
    this.fx.ring(t.pos, GOLD, 2.4, 0.5);
    events.emit('ticketSpawn', { id: t.id, pos: t.pos });
    return t;
  }

  /**
   * Open floor for a ticket: inside the (current) fire ring with a margin, at least
   * `minWizardDistance` from every wizard and `minTicketDistance` from other tickets, and no solid
   * collider within `obstacleClearance` (a physics shape query, so cylinders, boxes and stumps all count).
   */
  isValidSpot(x: number, z: number): boolean {
    if (Math.hypot(x, z) > this.arena.fireRadius - T.fireMargin) return false;
    // Not in lava, inside a vape cloud, or on a sliding block's rail.
    if (this.arena.excludesPickup(x, z)) return false;
    for (const w of this.wizards) if (horizontalDistance(w.pos, x, z) < T.minWizardDistance) return false;
    for (const t of this.pool) if (t.active && horizontalDistance(t.pos, x, z) < T.minTicketDistance) return false;
    return !this.blocked(x, z);
  }

  /** True if a solid collider is within `obstacleClearance` of (x, z), from the floor to above the card. */
  blocked(x: number, z: number): boolean {
    this.probePos.x = x;
    this.probePos.y = this.probe.halfHeight + 0.05;
    this.probePos.z = z;
    const hit = this.physics.world.intersectionWithShape(
      this.probePos, this.identity, this.probe, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, this.queryGroups,
      undefined, undefined, this.solidOnly,
    );
    return hit !== null;
  }

  /**
   * AI helper: the nearest ticket within `range` of `self` that it can see, and that is closer to it
   * than to `rival` (any distance if `anyDistance`, e.g. on low mana). Null if none.
   */
  bestFor(self: Wizard, rival: Wizard, range: number, anyDistance: boolean): GoldenTicket | null {
    let best: GoldenTicket | null = null;
    let bestD = range;
    for (const t of this.pool) {
      if (!t.active) continue;
      const d = horizontalDistance(self.pos, t.pos.x, t.pos.z);
      if (d > bestD) continue;
      if (!anyDistance && horizontalDistance(rival.pos, t.pos.x, t.pos.z) <= d) continue;
      if (!this.physics.lineOfSight(self.chest(tmpPos), t.pos)) continue;
      bestD = d;
      best = t;
    }
    return best;
  }

  // ------------------------------------------------------------------ visuals (per frame)

  /** `eye`: camera position (the glow sits just behind the card from the viewer, so it never covers the art). */
  updateVisual(dt: number, eye?: THREE.Vector3): void {
    this.visualTime += dt;
    const time = this.visualTime;
    tmpColor.setHex(GOLD);
    tmpColor2.setHex(GOLD_HI);
    for (const t of this.pool) {
      if (!t.root.visible) continue;
      let scale: number;
      let alpha = 1;
      if (t.active) {
        t.popTime += dt;
        const p = Math.min(1, t.popTime / POP_TIME);
        scale = easeOutBack(p);
        t.spin += T.spinSpeed * dt;
        // Blink faster and faster through the last seconds.
        const left = t.remaining;
        if (left < T.blinkTime) {
          const hz = 3 + (1 - left / T.blinkTime) * 7;
          alpha = Math.sin(time * hz * Math.PI * 2) > -0.2 ? 1 : 0.15;
        }
        t.sparkAcc += dt * T.sparkleRate;
        while (t.sparkAcc >= 1) {
          t.sparkAcc -= 1;
          const a = Math.random() * Math.PI * 2;
          const r = 0.35 + Math.random() * 0.5;
          this.fx.sparks.emit(
            t.pos.x + Math.sin(a) * r, t.pos.y - 0.6 + Math.random() * 1.1, t.pos.z + Math.cos(a) * r,
            Math.sin(a) * 0.25, 0.7 + Math.random() * 0.8, Math.cos(a) * 0.25,
            Math.random() < 0.3 ? tmpColor2 : tmpColor, 2.4, 0.07 + Math.random() * 0.07, 0.6 + Math.random() * 0.5, { drag: 1.2 },
          );
        }
      } else {
        t.vanishTime -= dt;
        if (t.vanishTime <= 0) {
          t.root.visible = false;
          continue;
        }
        const p = t.vanishTime / VANISH_TIME; // 1 -> 0
        scale = p * (1.4 - 0.4 * p);
        alpha = p;
      }
      const bob = Math.sin(time * T.bobSpeed + t.phase) * T.bobAmplitude;
      t.card.position.y = t.pos.y + bob;
      t.card.rotation.set(0.12 * Math.sin(time * 1.3 + t.phase), t.spin, 0);
      t.card.scale.setScalar(Math.max(0.001, scale));
      t.card.visible = alpha > 0.5;
      t.glow.position.set(0, t.card.position.y, 0);
      // Far away, the beam and glow widen so a ticket still reads from across the arena.
      let far = 1;
      if (eye) {
        tmpPos.set(t.root.position.x - eye.x, 0, t.root.position.z - eye.z);
        far = Math.min(2.6, Math.max(1, tmpPos.length() / 16));
        tmpPos.normalize();
        t.glow.position.x = tmpPos.x * 0.4;
        t.glow.position.z = tmpPos.z * 0.4;
      }
      t.glow.scale.setScalar(2.3 * Math.max(0.001, scale) * (0.92 + 0.08 * Math.sin(time * 4 + t.phase)) * (1 + (far - 1) * 0.5));
      t.glow.material.opacity = 0.5 * alpha;
      const beam = t.beam.material.uniforms;
      beam.uTime.value = time;
      const themeBoost = T.beamThemeBoost[this.arena.theme] ?? 1;
      beam.uOpacity.value = Math.min(1, 0.55 * themeBoost) * alpha * Math.min(1, t.active ? t.popTime / POP_TIME : 1) * (0.85 + 0.15 * Math.sin(time * 2.5 + t.phase));
      t.beam.scale.set(scale * far, 1, scale * far);
      t.floorGlow.material.opacity = 0.5 * alpha * (0.8 + 0.2 * Math.sin(time * 3 + t.phase));
    }
    this.cardMaterial.emissiveIntensity = 0.38 + 0.12 * Math.sin(time * 3.2);
    this.updateAuras(dt, time);
  }

  /** Gold ground glow, ring and rising sparkles on every boosted wizard (player or enemy). */
  private updateAuras(dt: number, time: number): void {
    let used = 0;
    for (const w of this.wizards) {
      if (w.manaBoost <= 0 || !w.alive) continue;
      const at = w.visual.root.position;
      // Warn in the last 3 s: the aura flickers.
      const ending = w.manaBoost < 3;
      const flicker = ending && Math.sin(time * 18) < 0 ? 0.25 : 1;
      if (used < this.auras.length) {
        const a = this.auras[used++];
        a.root.visible = true;
        a.root.position.set(at.x, at.y, at.z);
        a.ring.rotation.y = time * 1.5;
        const pulse = 1 + 0.08 * Math.sin(time * 5);
        a.ring.scale.setScalar(pulse);
        a.disc.material.opacity = 0.55 * flicker;
        a.ring.material.opacity = 0.75 * flicker;
      }
      const rate = T.auraSparkleRate * dt * flicker;
      const n = Math.floor(rate) + (Math.random() < rate % 1 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 0.45 + Math.random() * 0.35;
        this.fx.sparks.emit(
          at.x + Math.sin(a) * r, at.y + Math.random() * 1.9, at.z + Math.cos(a) * r,
          0, 0.9 + Math.random() * 0.9, 0,
          Math.random() < 0.3 ? tmpColor2 : tmpColor, 2.2, 0.07 + Math.random() * 0.06, 0.55 + Math.random() * 0.35, { drag: 1 },
        );
      }
    }
    for (let i = used; i < this.auras.length; i++) this.auras[i].root.visible = false;
  }
}

function easeOutBack(p: number): number {
  const c = 2.2;
  const x = p - 1;
  return 1 + (c + 1) * x * x * x + c * x * x;
}

/** Canvas-drawn ticket face, used when textures/golden_ticket.png is not on disk. */
export function ticketFaceTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 512;
  const g = c.getContext('2d')!;
  /** Ticket outline inset by `i` px: concave corners and a semicircular notch in each short side. */
  const shape = (i: number) => {
    const x0 = 12 + i, y0 = 12 + i, x1 = 1012 - i, y1 = 500 - i, k = 44, n = 58, my = 256;
    g.beginPath();
    g.moveTo(x0 + k, y0);
    g.lineTo(x1 - k, y0);
    g.arc(x1, y0, k, Math.PI, Math.PI / 2, true);
    g.lineTo(x1, my - n);
    g.arc(x1, my, n, -Math.PI / 2, Math.PI / 2, true);
    g.lineTo(x1, y1 - k);
    g.arc(x1, y1, k, -Math.PI / 2, -Math.PI, true);
    g.lineTo(x0 + k, y1);
    g.arc(x0, y1, k, 0, -Math.PI / 2, true);
    g.lineTo(x0, my + n);
    g.arc(x0, my, n, Math.PI / 2, -Math.PI / 2, true);
    g.lineTo(x0, y0 + k);
    g.arc(x0, y0, k, Math.PI / 2, 0, true);
    g.closePath();
  };
  const gold = g.createLinearGradient(0, 0, 1024, 512);
  gold.addColorStop(0, '#fff1a6');
  gold.addColorStop(0.3, '#f2c240');
  gold.addColorStop(0.55, '#ffe58a');
  gold.addColorStop(0.8, '#c8901a');
  gold.addColorStop(1, '#ffe07a');
  shape(0);
  g.fillStyle = gold;
  g.fill();
  g.lineWidth = 6;
  g.strokeStyle = '#8a5a08';
  g.stroke();
  // Art-deco double border.
  shape(26);
  g.lineWidth = 5;
  g.strokeStyle = '#7a4d06';
  g.stroke();
  shape(40);
  g.lineWidth = 2.5;
  g.strokeStyle = '#fff4c0';
  g.stroke();
  // Fans at the top and bottom centre.
  g.fillStyle = '#9a6a0c';
  for (const [y, dir] of [[40, 1], [472, -1]] as const) {
    for (let r = 0; r < 7; r++) {
      const a = Math.PI * (0.15 + (r / 6) * 0.7);
      g.beginPath();
      g.moveTo(512, y);
      g.lineTo(512 + Math.cos(a) * 46, y + dir * Math.sin(a) * 46);
      g.lineTo(512 + Math.cos(a + 0.09) * 46, y + dir * Math.sin(a + 0.09) * 46);
      g.closePath();
      g.fill();
    }
  }
  const star = (x: number, y: number, r: number) => {
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 ? r * 0.45 : r;
      g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    g.closePath();
    g.fill();
  };
  g.fillStyle = '#6e4405';
  star(180, 256, 20);
  star(844, 256, 20);
  star(512, 118, 16);
  star(512, 396, 16);
  // Lettering: a light bevel under dark engraved text.
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = 'bold 132px Georgia, "Times New Roman", serif';
  for (const [text, y] of [['GOLDEN', 200], ['TICKET', 318]] as const) {
    g.fillStyle = '#fff6c8';
    g.fillText(text, 514, y + 4, 600);
    g.fillStyle = '#5a3604';
    g.fillText(text, 512, y, 600);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
