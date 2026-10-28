import * as THREE from 'three';
import { CONFIG } from '../config';
import { events } from '../core/events';
import type { Effects } from '../fx/Effects';
import type { Wizard } from '../wizard/Wizard';

const A = CONFIG.arena;

const FLAME_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const FLAME_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uIntensity;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.1; a *= 0.5; }
    return v;
  }
  void main() {
    vec2 p = vec2(vUv.x * 180.0 + uSeed, vUv.y * 2.2 - uTime * 1.6);
    float n = fbm(p);
    float h = vUv.y;
    // Sharp tongues: noise must beat a threshold that rises with height.
    float flame = smoothstep(h * 0.9 + 0.12, h * 0.9 + 0.2, n);
    vec3 col = mix(vec3(1.0, 0.62, 0.18), vec3(0.95, 0.22, 0.05), smoothstep(0.0, 0.35, h));
    col = mix(col, vec3(0.55, 0.05, 0.12), smoothstep(0.35, 0.8, h));
    float a = flame * (1.0 - smoothstep(0.5, 0.95, h)) * 0.75;
    // Only the hot base goes above 1.0, so bloom catches the flame roots, not the whole horizon.
    gl_FragColor = vec4(col * (0.5 + 0.7 * (1.0 - h) * (1.0 - h)) * uIntensity, a);
  }
`;

const GLOW_VERT = /* glsl */ `
  varying vec2 vXZ;
  void main() {
    vXZ = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const GLOW_FRAG = /* glsl */ `
  uniform float uInner;
  uniform float uTime;
  varying vec2 vXZ;
  void main() {
    float r = length(vXZ);
    float edge = smoothstep(uInner - 0.6, uInner + 0.4, r);
    float flicker = 0.85 + 0.15 * sin(uTime * 13.0 + atan(vXZ.y, vXZ.x) * 9.0);
    vec3 c = vec3(1.0, 0.38, 0.08) * (0.35 + 0.8 * (1.0 - smoothstep(uInner, uInner + 1.4, r))) * flicker;
    gl_FragColor = vec4(c, edge * 0.45);
  }
`;

const EMBER = new THREE.Color(1, 0.55, 0.15);

/**
 * Ring of magic fire at the arena edge. Touching it burns (damage ticks) and shoves you inward.
 * The radius shrinks during sudden death.
 */
export class FireRing {
  private readonly walls: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>[] = [];
  private readonly glow: THREE.Mesh<THREE.RingGeometry, THREE.ShaderMaterial>;
  private time = 0;
  private emberAcc = 0;

  constructor(scene: THREE.Scene, private readonly fx: Effects) {
    // Two flame layers at slightly different radii give the ring thickness.
    for (const [offset, height, seed] of [[0.35, 2.6, 0], [1.1, 3.4, 57]] as const) {
      const geo = new THREE.CylinderGeometry(1, 1, height, 160, 1, true);
      geo.translate(0, height / 2, 0);
      const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
        vertexShader: FLAME_VERT, fragmentShader: FLAME_FRAG,
        uniforms: { uTime: { value: 0 }, uSeed: { value: seed }, uIntensity: { value: 1 } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
      }));
      mesh.userData.offset = offset;
      mesh.renderOrder = 7;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.walls.push(mesh);
    }
    this.glow = new THREE.Mesh(
      new THREE.RingGeometry(A.suddenDeathMinRadius - 1, A.wallRadius + 0.5, 128, 1),
      new THREE.ShaderMaterial({
        vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
        uniforms: { uInner: { value: A.fireRadius }, uTime: { value: 0 } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
      }),
    );
    this.glow.rotation.x = -Math.PI / 2;
    this.glow.position.y = 0.04;
    this.glow.renderOrder = 6;
    scene.add(this.glow);
    this.setRadius(A.fireRadius);
  }

  setRadius(r: number): void {
    for (const m of this.walls) {
      const rr = Math.min(A.wallRadius + 0.3, r + (m.userData.offset as number));
      m.scale.set(rr, 1, rr);
    }
    this.glow.material.uniforms.uInner.value = r;
  }

  /** Visuals; runs on render time. */
  updateVisual(dt: number, radius: number): void {
    this.time += dt;
    for (const m of this.walls) m.material.uniforms.uTime.value = this.time;
    this.glow.material.uniforms.uTime.value = this.time;
    this.setRadius(radius);
    // Rising embers along the ring.
    this.emberAcc += dt * 45;
    while (this.emberAcc >= 1) {
      this.emberAcc -= 1;
      const a = Math.random() * Math.PI * 2;
      const r = radius + 0.3 + Math.random() * 1.2;
      this.fx.sparks.emit(Math.sin(a) * r, 0.2 + Math.random() * 1.5, Math.cos(a) * r,
        (Math.random() - 0.5) * 0.6, 1.5 + Math.random() * 2.5, (Math.random() - 0.5) * 0.6,
        EMBER, 1.6, 0.1 + Math.random() * 0.08, 0.8 + Math.random() * 0.8, { drag: 0.6 });
    }
  }

  /** Burn and push back wizards touching the fire. Runs on the fixed tick. */
  updateDamage(
    dt: number,
    radius: number,
    wizards: Wizard[],
    damage: (w: Wizard, amount: number, point: THREE.Vector3) => void,
  ): void {
    for (const w of wizards) {
      if (!w.alive) continue;
      const r = Math.hypot(w.pos.x, w.pos.z);
      const touching = r + CONFIG.wizard.radius > radius;
      if (!touching) {
        w.burning = false;
        w.burnTimer = 0;
        continue;
      }
      if (!w.burning) {
        w.burning = true;
        w.burnTimer = A.fireTickInterval; // first tick lands immediately
      }
      // Shove inward, at least at firePush speed.
      const ix = -w.pos.x / (r || 1), iz = -w.pos.z / (r || 1);
      const inward = w.knock.x * ix + w.knock.z * iz;
      if (inward < A.firePush) w.addKnockback(ix, iz, A.firePush - inward);
      w.burnTimer += dt;
      while (w.burnTimer >= A.fireTickInterval) {
        w.burnTimer -= A.fireTickInterval;
        const p = new THREE.Vector3(w.pos.x, 1.0, w.pos.z);
        damage(w, A.fireDps * A.fireTickInterval, p);
        events.emit('burn', { wizard: w });
        this.fx.impact(p, null, 0xff7a2a, 0.5);
      }
    }
  }
}
