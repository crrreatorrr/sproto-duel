import * as THREE from 'three';
import { CONFIG } from '../config';
import { events } from '../core/events';
import { feel } from '../core/feel';
import type { Game } from '../core/Game';
import type { ArenaShiftDef } from '../campaign/levels';
import type { Wizard } from '../wizard/Wizard';
import type { Hazard } from './layouts';

const S = CONFIG.arenaShifts;
const A = CONFIG.arena;

/**
 * One decal shader for every feature. Kinds: 0 a hazard pool (looks: 0 sand, a slow spiral; 1
 * liquid, churning; 2 magma, a cracked crust; 3 electric, a dark puddle with flickering arcs);
 * 1 a spring (rippling, as bright as it is full); 2 a vent (a cracked crater, filling red as it
 * warns). `uGrow` fades a new feature in from its centre, its rim blinking while it is harmless.
 */
const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uGrow;
  uniform float uFill;
  uniform float uSeed;
  uniform int uKind;
  uniform int uLook;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    // A ragged edge (pools and craters are not perfect circles).
    float ang = atan(p.y, p.x);
    float edge = 0.93 + 0.06 * noise(vec2(ang * 2.5 + uSeed, uSeed));
    float grow = uGrow * edge;
    if (r > grow) discard;
    float w = fwidth(r) * 1.5;
    float rim = smoothstep(w + 0.05, 0.0, abs(r - grow + 0.03));
    float body = 1.0 - smoothstep(grow - 0.12, grow, r);
    float shade = 0.0, glow = 0.0;
    vec3 col = uColor;
    if (uKind == 0) {
      if (uLook == 0) {
        // Sand: a slow spiral sinking to the middle.
        // A dark sink at the middle, pale ridges turning round it.
        float s = smoothstep(0.2, 1.0, sin(ang * 3.0 + r * 10.0 - uTime * 1.4 + uSeed));
        shade = body * (0.9 + 0.9 * (1.0 - r));
        glow = body * s * 0.28 * r + rim * 0.45;
      } else if (uLook == 2) {
        // Magma: dark crust plates, bright cracks between them, pulsing.
        vec2 q = p * 3.2 + uSeed;
        float n = noise(q) + 0.5 * noise(q * 2.3 + uTime * 0.15);
        float crack = smoothstep(0.08, 0.0, abs(fract(n * 2.2) - 0.5) - 0.38);
        float pulse = 0.75 + 0.25 * sin(uTime * 2.3 + uSeed);
        shade = body;
        glow = body * (0.1 + crack * 0.75 * pulse) + rim * 0.7;
      } else if (uLook == 3) {
        // Live wires: a dark puddle, arcs flickering across it.
        float arc = smoothstep(0.06, 0.0, abs(sin(p.x * 5.0 + noise(p * 4.0 + floor(uTime * 12.0)) * 4.0) * 0.5 - p.y * 0.6));
        float flick = step(0.45, hash(vec2(floor(uTime * 14.0), uSeed)));
        shade = body * 0.9;
        glow = body * (0.1 + arc * flick * 0.9) + rim * (0.55 + 0.45 * flick);
      } else {
        // Liquid: churning, brighter at its edge.
        vec2 q = p * 2.6 + uSeed;
        float n = noise(q + vec2(uTime * 0.35, -uTime * 0.25)) * noise(q * 1.7 - vec2(uTime * 0.2, uTime * 0.3));
        float bubble = smoothstep(0.82, 0.9, noise(p * 7.0 + uSeed + uTime * 0.6));
        shade = body;
        glow = body * (0.05 + 1.1 * n * n + bubble * 0.5) + rim * 0.75;
      }
    } else if (uKind == 1) {
      // Spring: ripples running out from the middle, as bright as it is full.
      float ripple = smoothstep(0.35, 1.0, sin(r * 16.0 - uTime * 3.2)) * (1.0 - r);
      float full = 0.25 + 0.75 * uFill;
      shade = body * 0.6;
      glow = body * (0.15 + ripple * 0.6) * full + rim * (0.35 + 0.6 * uFill);
    } else {
      // Vent: a crater with cracks; the warning fills it from the middle, blinking at the end.
      float cracks = smoothstep(0.1, 0.0, abs(fract(ang * 1.2732 + noise(p * 3.0 + uSeed) * 0.6) - 0.5) - 0.42) * step(0.3, r);
      float fill = (1.0 - smoothstep(uFill - 0.03, uFill, r)) * step(0.001, uFill);
      float blink = uFill > 0.75 ? 0.55 + 0.45 * step(0.5, fract(uTime * 9.0)) : 1.0;
      shade = body * (1.6 - 0.8 * r);
      glow = body * cracks * 0.16 + fill * 0.65 + rim * (0.18 + 0.75 * step(0.001, uFill) * blink);
      col = mix(uColor, vec3(1.0, 0.16, 0.08), step(0.001, uFill) * 0.6);
    }
    // Fading in: harmless, the outline blinking.
    if (uGrow < 1.0) glow = glow * 0.5 + rim * (0.5 + 0.5 * step(0.5, fract(uTime * 6.0)));
    float a = clamp(shade * 0.4 + glow, 0.0, 0.95);
    vec3 c = mix(col * 0.1, col * 1.3, clamp(glow / (shade * 0.4 + glow + 1e-3), 0.0, 1.0));
    gl_FragColor = vec4(c, a);
  }
`;

type Kind = 'pool' | 'spring' | 'vent';
const KIND_ID: Record<Kind, number> = { pool: 0, spring: 1, vent: 2 };
const LOOK_ID = { sand: 0, liquid: 1, magma: 2, electric: 3 } as const;

/** A pool, spring or vent the arena grew. */
export interface ShiftFeature {
  readonly kind: Kind;
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  /** Seconds since it appeared; it does nothing until `growTime`. */
  age: number;
  /** Spring: health left in it (0 = dry until the next stage fills it). */
  charge: number;
  /** Vent: seconds into its cycle, the cycle's length, and whether this cycle has warned. */
  clock: number;
  period: number;
  warned: boolean;
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  /** Kept-out floor for the AI (pools and vents; springs are welcome). */
  readonly hazard: Hazard | null;
  /** Particle emission carry-over. */
  emitAcc: number;
}

const tmpPos = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpColor = new THREE.Color();
const tmpColor2 = new THREE.Color();
const HEAL = new THREE.Color(0x6dff8f);
const rand = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * Arena shifts: each boss stage changes a Boss Gauntlet arena in the boss's theme (levels.ts
 * `shift`, CONFIG.arenaShifts). When the fight reaches stage 2, hazard pools open (they burn,
 * and quicksand slows, anyone standing in them) and a spring wells up that heals whoever stands in
 * it until it runs dry (stage 3 fills it again); at stage 3 vents start erupting (a warning, then damage and a shove). The
 * fire ring pulls in a little each stage and the light turns toward the boss's colour. Everything
 * waits for the transformation to finish, fades in harmless, and stays until the round ends.
 * Pools and vents count as kept-out floor (Arena.shiftHazards): the AI steers round them and
 * pickups stay out. Simulation in `update` (fixed tick), looks in `updateVisual`.
 */
export class ArenaShifts {
  readonly features: ShiftFeature[] = [];
  /** The stage whose shift is in place (0 = the arena as built). */
  stage = 0;
  private shift: ArenaShiftDef | null = null;
  private mood = 0;
  private time = 0;
  /** Burn tick timers per wizard (pools), and heal not yet shown per wizard (springs). */
  private readonly burnTimer = new Map<Wizard, number>();
  private readonly healShown = new Map<Wizard, { amount: number; t: number }>();
  private readonly geometry = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);

  /** Pooled decals, one per feature a shift can grow (built at start; the fight's warm-up compiles them). */
  private readonly meshes: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>[] = [];

  constructor(scene: THREE.Scene, private readonly game: Game) {
    for (let i = 0; i < S.pool.count + 1 + S.vent.count; i++) {
      const m = new THREE.Mesh(this.geometry, new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: FRAG,
        uniforms: {
          uColor: { value: new THREE.Color() }, uTime: { value: 0 }, uGrow: { value: 0 }, uFill: { value: 0 },
          uSeed: { value: 0 }, uKind: { value: 0 }, uLook: { value: 0 },
        },
        transparent: true, depthWrite: false, toneMapped: false,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      }));
      m.visible = false;
      m.renderOrder = 7;
      m.name = 'shift:decal';
      scene.add(m);
      this.meshes.push(m);
    }
    // One shader program for all of them: show one while the warm-up compiles.
    game.warmHooks.push(() => {
      const m = this.meshes[this.meshes.length - 1];
      const was = m.visible;
      m.visible = true;
      return () => { m.visible = was; };
    });
  }

  /** The pools, springs or vents in play. */
  of(kind: Kind): ShiftFeature[] {
    return this.features.filter((f) => f.kind === kind);
  }

  /** Fixed tick: bring in a reached stage's shift, ease the ring in, then pools, springs and vents. */
  update(dt: number): void {
    const g = this.game;
    for (const w of g.wizards) w.groundSlow = 1;
    const shift = this.sync();
    if (!shift) return;
    // A transformation in progress (its cinematic included) finishes first.
    const want = g.furthestStage();
    if (want > this.stage && !g.enemies.some((e) => e.evolving)) this.applyStage(want);

    const arena = g.arena;
    const ring = S.ringRadius[this.stage];
    if (arena.ringCap > ring) arena.ringCap = Math.max(ring, arena.ringCap - S.ringSpeed * dt);
    // Match keeps the ring within the cap too (its clock sets fireRadius each tick).
    arena.fireRadius = Math.min(arena.fireRadius, arena.ringCap);

    for (const f of this.features) {
      f.age += dt;
      if (f.age < S.growTime) continue;
      if (f.kind === 'pool') this.updatePool(f, shift, dt);
      else if (f.kind === 'spring') this.updateSpring(f, dt);
      else this.updateVent(f, shift, dt);
    }
    // Show what the springs healed about once a second.
    for (const [w, h] of this.healShown) {
      h.t += dt;
      if (h.amount >= 1 && (h.t >= 1 || !this.inSpring(w))) {
        events.emit('springHeal', { wizard: w, amount: h.amount, pos: w.pos });
        h.amount = 0;
        h.t = 0;
      }
    }
  }

  /** Put stages up to `stage` in place (QA calls it directly). */
  applyStage(stage: number): void {
    const shift = this.sync();
    if (!shift) return;
    while (this.stage < Math.min(stage, 2)) {
      this.stage++;
      if (this.stage === 1) {
        for (let i = 0; i < S.pool.count; i++) this.place('pool', rand(S.pool.radius[0], S.pool.radius[1]), shift.pools.color);
        this.place('spring', S.spring.radius, shift.spring.color);
      } else {
        for (let i = 0; i < S.vent.count; i++) this.place('vent', S.vent.radius, shift.vents.color);
        // The spring wells up again.
        for (const f of this.features) if (f.kind === 'spring') f.charge = S.spring.charge;
      }
      events.emit('arenaShift', { stage: this.stage, shift });
    }
  }

  /** The current boss's shift; a different boss (or none) clears the last one's first. */
  private sync(): ArenaShiftDef | null {
    const shift = this.game.boss?.shift ?? null;
    if (shift !== this.shift) {
      this.clear();
      this.shift = shift;
    }
    return shift;
  }

  /** Round start or a new boss: the arena as built (Game.resetArena; the ring is reset by Arena.reset). */
  clear(): void {
    for (const f of this.features) f.mesh.visible = false;
    this.features.length = 0;
    this.game.arena.shiftHazards.length = 0;
    this.stage = 0;
    this.burnTimer.clear();
    this.healShown.clear();
    if (this.mood !== 0 && this.shift) this.game.arena.setMood(this.shift.mood, 0);
    this.mood = 0;
    for (const w of this.game.wizards) w.groundSlow = 1;
  }

  /** Inside a pool (feet down, centre within it) that is live. */
  poolAt(w: Wizard): ShiftFeature | null {
    if (w.pos.y > 0.15 || w.fireproof) return null;
    for (const f of this.features) {
      if (f.kind === 'pool' && f.age >= S.growTime && Math.hypot(w.pos.x - f.x, w.pos.z - f.z) < f.radius) return f;
    }
    return null;
  }

  inSpring(w: Wizard): ShiftFeature | null {
    if (w.pos.y > 0.4) return null;
    for (const f of this.features) {
      if (f.kind === 'spring' && f.age >= S.growTime && Math.hypot(w.pos.x - f.x, w.pos.z - f.z) < f.radius) return f;
    }
    return null;
  }

  /** AI helper: a spring with health in it within `range` of `self`, as a pickup-like goal (or null). */
  springFor(self: Wizard, range: number): { readonly active: boolean; readonly id: number; readonly pos: THREE.Vector3 } | null {
    let best: ShiftFeature | null = null, bestD = range;
    for (const f of this.features) {
      if (f.kind !== 'spring' || f.age < S.growTime || f.charge <= 0) continue;
      const d = Math.hypot(self.pos.x - f.x, self.pos.z - f.z);
      if (d < bestD) { best = f; bestD = d; }
    }
    if (!best) return null;
    const f = best;
    // Its id stays the same while it lasts; it stops being a goal once dry or the wizard is healed.
    return { get active() { return f.charge > 0 && self.health < self.maxHealth - 1; }, id: 900000 + this.features.indexOf(f), pos: new THREE.Vector3(f.x, 0, f.z) };
  }

  private updatePool(f: ShiftFeature, shift: ArenaShiftDef, dt: number): void {
    const P = shift.pools;
    for (const w of this.game.wizards) {
      if (!w.alive || this.poolAt(w) !== f) continue;
      if (P.slow !== undefined) w.groundSlow = Math.min(w.groundSlow, P.slow);
      if (P.dps <= 0) continue;
      let t = (this.burnTimer.get(w) ?? A.fireTickInterval) + dt;
      while (t >= A.fireTickInterval) {
        t -= A.fireTickInterval;
        tmpPos.set(w.pos.x, 0.3, w.pos.z);
        this.game.spells.dealDamage(w, null, P.dps * A.fireTickInterval, tmpPos, P.look === 'magma' ? 'fire' : 'pool');
        this.game.fx.impact(tmpPos, null, P.color, 0.4);
      }
      this.burnTimer.set(w, t);
    }
    // Out of every pool: the next one burns at once.
    for (const [w] of this.burnTimer) if (!this.poolAt(w)) this.burnTimer.delete(w);
  }

  private updateSpring(f: ShiftFeature, dt: number): void {
    if (f.charge <= 0) return;
    for (const w of this.game.wizards) {
      if (!w.alive || w.health >= w.maxHealth || this.inSpring(w) !== f) continue;
      const amount = Math.min(S.spring.heal * dt, f.charge, w.maxHealth - w.health);
      w.health += amount;
      f.charge -= amount;
      const h = this.healShown.get(w) ?? { amount: 0, t: 0 };
      h.amount += amount;
      this.healShown.set(w, h);
      if (f.charge <= 0) {
        f.charge = 0;
        break;
      }
    }
  }

  private updateVent(f: ShiftFeature, shift: ArenaShiftDef, dt: number): void {
    f.clock += dt;
    tmpPos.set(f.x, 0.1, f.z);
    if (!f.warned && f.clock >= f.period - S.vent.warn) {
      f.warned = true;
      events.emit('ventWarn', { pos: tmpPos, color: shift.vents.color });
    }
    if (f.clock < f.period) return;
    f.clock = 0;
    f.period = rand(S.vent.period[0], S.vent.period[1]);
    f.warned = false;
    // Eruption: everyone over it (a roll's i-frames slip through) takes the hit and is thrown out.
    for (const w of this.game.wizards) {
      if (!w.alive || w.invulnerable) continue;
      const dx = w.pos.x - f.x, dz = w.pos.z - f.z;
      const d = Math.hypot(dx, dz);
      if (d > f.radius + w.radius || w.pos.y > 4) continue;
      tmpB.set(dx, 0, dz);
      if (d < 1e-3) tmpB.set(1, 0, 0);
      tmpB.normalize();
      w.chest(tmpPos);
      this.game.spells.dealDamage(w, null, shift.vents.damage, tmpPos, 'vent', tmpB, S.vent.knockback);
    }
    this.erupt(f, shift.vents.color);
  }

  private erupt(f: ShiftFeature, color: number): void {
    const fx = this.game.fx;
    tmpPos.set(f.x, 0.1, f.z);
    tmpB.set(f.x, 7, f.z);
    this.game.spells.spellFx.beam(tmpPos, tmpB, color, 0.45, f.radius * 0.55);
    tmpColor.setHex(color);
    tmpPos.y = 0.4;
    fx.sparks.burst(tmpPos, 70, tmpColor, 2.6, 4, 12, 0.2, 0.9, { gravity: 9, drag: 0.8 }, 3);
    fx.ring(tmpPos, color, f.radius + 1.2, 0.45);
    fx.flash(tmpPos, color, 4, 0.25);
    fx.light(tmpPos, color, 26, 0.45);
    fx.dust(tmpPos, 10, f.radius);
    feel.shakeAt(tmpPos, 0.35, 14);
    events.emit('ventErupt', { pos: tmpPos, color });
  }

  /** Grow a feature on open floor: clear of wizards, cover, other features, lava and the ring. */
  private place(kind: Kind, radius: number, color: number): ShiftFeature | null {
    const g = this.game, arena = g.arena;
    const ring = S.ringRadius[2] - S.ringMargin - radius;
    for (let i = 0; i < S.attempts; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * ring;
      const x = Math.sin(a) * d, z = Math.cos(a) * d;
      if (!this.isOpen(x, z, radius)) continue;
      const mesh = this.meshes.find((m) => !this.features.some((f) => f.mesh === m));
      if (!mesh) return null;
      const u = mesh.material.uniforms;
      u.uColor.value.setHex(color);
      u.uKind.value = KIND_ID[kind];
      u.uLook.value = LOOK_ID[this.shift?.pools.look ?? 'liquid'];
      u.uSeed.value = Math.random() * 50;
      u.uGrow.value = u.uFill.value = 0;
      // Above the floor's road paint and patches (some themes lay them a few cm up).
      mesh.position.set(x, 0.08, z);
      mesh.scale.setScalar(radius);
      mesh.visible = true;
      const hazard = kind === 'spring' ? null : { x, z, radius };
      if (hazard) arena.shiftHazards.push(hazard);
      const f: ShiftFeature = {
        kind, x, z, radius, age: 0, charge: kind === 'spring' ? S.spring.charge : 0,
        clock: 0, period: rand(S.vent.period[0], S.vent.period[1]), warned: false, mesh, hazard, emitAcc: 0,
      };
      // Vents start at a random point of their cycle (never inside the first warning), so they don't fire together.
      if (kind === 'vent') f.clock = rand(0, f.period - S.vent.warn - 0.5);
      this.features.push(f);
      tmpPos.set(x, 0.2, z);
      g.fx.ring(tmpPos, color, radius + 0.6, 0.6);
      g.fx.dust(tmpPos, 8, radius);
      return f;
    }
    return null;
  }

  /** Open floor for a feature of `radius` at (x, z). */
  isOpen(x: number, z: number, radius: number): boolean {
    const g = this.game, arena = g.arena;
    if (Math.hypot(x, z) + radius > S.ringRadius[2] - S.ringMargin) return false;
    if (arena.hazardAt(x, z, radius + S.spacing) || arena.excludesPickup(x, z)) return false;
    for (const f of this.features) if (Math.hypot(x - f.x, z - f.z) < f.radius + radius + S.spacing) return false;
    for (const w of g.wizards) if (w.alive && Math.hypot(w.pos.x - x, w.pos.z - z) < radius + S.wizardClearance) return false;
    for (const p of arena.pillars) if (p.surfaceDistance(x, z) < radius + S.coverClearance) return false;
    // Not on the spawn lane (the next round starts there).
    if (Math.abs(x) < radius + 2 && Math.abs(z) < A.spawnDistance / 2 + radius + 2) return false;
    return true;
  }

  /** Render time: fade in, animate, deepen the mood, and particles over pools, springs and vents. */
  updateVisual(dt: number): void {
    this.time += dt;
    const shift = this.shift;
    if (!shift) return;
    const target = S.mood[this.stage];
    if (this.mood !== target) {
      const step = dt * (S.mood[2] / S.moodTime);
      this.mood = this.mood < target ? Math.min(target, this.mood + step) : Math.max(target, this.mood - step);
      this.game.arena.setMood(shift.mood, this.mood);
    }
    const fx = this.game.fx;
    for (const f of this.features) {
      const u = f.mesh.material.uniforms;
      u.uTime.value = this.time;
      u.uGrow.value = Math.min(1, 0.15 + 0.85 * Math.min(1, f.age / S.growTime));
      if (f.age < S.growTime) u.uGrow.value = Math.min(0.999, u.uGrow.value);
      if (f.kind === 'spring') u.uFill.value = f.charge / S.spring.charge;
      if (f.kind === 'vent') u.uFill.value = f.clock > f.period - S.vent.warn && f.age >= S.growTime ? (f.clock - (f.period - S.vent.warn)) / S.vent.warn : 0;
      // Particles: bubbles and sparks over pools, motes over a full spring, wisps from vents.
      const rate = f.kind === 'pool' ? 5 * f.radius : f.kind === 'spring' ? (f.charge > 0 ? 7 : 0) : 2 + 10 * u.uFill.value;
      f.emitAcc += dt * rate;
      while (f.emitAcc >= 1) {
        f.emitAcc -= 1;
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * f.radius * 0.9;
        const x = f.x + Math.sin(a) * r, z = f.z + Math.cos(a) * r;
        if (f.kind === 'spring') {
          fx.sparks.emit(x, 0.1, z, 0, 1.2 + Math.random(), 0, HEAL, 1.6, 0.1, 1.1, { drag: 0.8 });
        } else if (f.kind === 'pool' && shift.pools.look === 'sand') {
          fx.smoke.emit(x, 0.15, z, (Math.random() - 0.5) * 0.4, 0.3, (Math.random() - 0.5) * 0.4, tmpColor.setHex(shift.pools.color), 0.5, 0.35, 1.2, { sizeEnd: 0.8, drag: 1 });
        } else {
          const c = f.kind === 'pool' ? shift.pools.color : shift.vents.color;
          tmpColor2.setHex(c);
          fx.sparks.emit(x, 0.1, z, (Math.random() - 0.5) * 0.5, 0.8 + Math.random() * (f.kind === 'vent' ? 3 : 1.2), (Math.random() - 0.5) * 0.5, tmpColor2, 1.8, 0.09, 0.8, { drag: 1.2 });
        }
      }
    }
  }
}
