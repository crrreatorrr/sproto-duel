import * as THREE from 'three';

const VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  uniform float uScale;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uScale / max(0.1, -mv.z);
  }
`;

const FRAG = /* glsl */ `
  uniform float uSoftness;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float d = length(p) * 2.0;
    float a = (1.0 - smoothstep(uSoftness, 1.0, d)) * vAlpha;
    if (a < 0.003) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

const ATTRIBUTES = ['position', 'aColor', 'aSize', 'aAlpha'] as const;

export interface EmitOptions {
  /** Downward acceleration (negative = rises). */
  gravity?: number;
  /** Velocity damping per second. */
  drag?: number;
  /** Size at end of life (start size is the `size` argument). */
  sizeEnd?: number;
}

/**
 * Fixed-capacity CPU-simulated point particles. Live particles are packed into [0, count) and
 * removed with swap-and-pop, so the GPU only draws what is alive and nothing is ever allocated.
 */
export class ParticleSystem {
  readonly points: THREE.Points;
  private count = 0;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size0: Float32Array;
  private readonly size1: Float32Array;
  private readonly grav: Float32Array;
  private readonly drag: Float32Array;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;

  constructor(readonly capacity: number, additive: boolean) {
    this.pos = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size0 = new Float32Array(capacity);
    this.size1 = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);

    const attr = (arr: Float32Array, n: number) => new THREE.BufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', attr(this.pos, 3));
    this.geometry.setAttribute('aColor', attr(this.col, 3));
    this.geometry.setAttribute('aSize', attr(this.size, 1));
    this.geometry.setAttribute('aAlpha', attr(this.alpha, 1));
    this.geometry.setDrawRange(0, 0);
    // Particles cover the whole arena; skip per-frame bounds work.
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uScale: { value: 500 }, uSoftness: { value: additive ? 0.0 : 0.35 } },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 10 : 9;
  }

  setPointScale(scale: number): void {
    this.material.uniforms.uScale.value = scale;
  }

  get alive(): number {
    return this.count;
  }

  emit(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    color: THREE.Color, intensity: number,
    size: number, life: number,
    opts?: EmitOptions,
  ): void {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.col[i3] = color.r * intensity; this.col[i3 + 1] = color.g * intensity; this.col[i3 + 2] = color.b * intensity;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size0[i] = size;
    this.size1[i] = opts?.sizeEnd ?? 0;
    this.size[i] = size;
    this.alpha[i] = 1;
    this.grav[i] = opts?.gravity ?? 0;
    this.drag[i] = opts?.drag ?? 0;
  }

  /** Emit in a random sphere direction with speed in [s0, s1]. */
  burst(
    origin: THREE.Vector3, count: number, color: THREE.Color, intensity: number,
    s0: number, s1: number, size: number, life: number, opts?: EmitOptions, upBias = 0,
  ): void {
    for (let k = 0; k < count; k++) {
      let x = Math.random() * 2 - 1, y = Math.random() * 2 - 1, z = Math.random() * 2 - 1;
      const l = Math.hypot(x, y, z) || 1;
      const s = s0 + Math.random() * (s1 - s0);
      x = (x / l) * s; y = (y / l) * s + upBias; z = (z / l) * s;
      this.emit(origin.x, origin.y, origin.z, x, y, z, color, intensity,
        size * (0.6 + Math.random() * 0.8), life * (0.6 + Math.random() * 0.6), opts);
    }
  }

  update(dt: number): void {
    if (dt <= 0 || this.count === 0) {
      this.geometry.setDrawRange(0, this.count);
      return;
    }
    let i = 0;
    while (i < this.count) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.kill(i);
        continue;
      }
      const i3 = i * 3;
      const damping = Math.exp(-this.drag[i] * dt);
      this.vel[i3] *= damping;
      this.vel[i3 + 1] = this.vel[i3 + 1] * damping - this.grav[i] * dt;
      this.vel[i3 + 2] *= damping;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      if (this.pos[i3 + 1] < 0.02 && this.vel[i3 + 1] < 0) {
        this.pos[i3 + 1] = 0.02;
        this.vel[i3 + 1] *= -0.3;
      }
      const t = this.life[i] / this.maxLife[i]; // 1 -> 0
      this.size[i] = this.size1[i] + (this.size0[i] - this.size1[i]) * t;
      this.alpha[i] = Math.min(1, t * 2.5);
      i++;
    }
    const n = this.count;
    this.geometry.setDrawRange(0, n);
    for (const name of ATTRIBUTES) {
      const a = this.geometry.getAttribute(name) as THREE.BufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = true;
    }
  }

  clear(): void {
    this.count = 0;
    this.geometry.setDrawRange(0, 0);
  }

  private kill(i: number): void {
    const last = --this.count;
    if (i === last) return;
    const i3 = i * 3, l3 = last * 3;
    for (let k = 0; k < 3; k++) {
      this.pos[i3 + k] = this.pos[l3 + k];
      this.vel[i3 + k] = this.vel[l3 + k];
      this.col[i3 + k] = this.col[l3 + k];
    }
    this.life[i] = this.life[last];
    this.maxLife[i] = this.maxLife[last];
    this.size0[i] = this.size0[last];
    this.size1[i] = this.size1[last];
    this.size[i] = this.size[last];
    this.alpha[i] = this.alpha[last];
    this.grav[i] = this.grav[last];
    this.drag[i] = this.drag[last];
  }
}
