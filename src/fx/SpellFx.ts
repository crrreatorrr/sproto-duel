import * as THREE from 'three';

const BEAM_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const BEAM_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uOpacity;
  uniform float uCore;
  varying vec2 vUv;
  void main() {
    float across = abs(vUv.x - 0.5) * 2.0;           // 0 center .. 1 edge (around the cylinder)
    float flow = 0.6 + 0.4 * sin(vUv.y * 60.0 - uTime * 50.0);
    float edge = 1.0 - smoothstep(0.2, 1.0, across);
    vec3 c = mix(uColor, vec3(1.0), uCore) * (1.5 + flow * 1.5);
    gl_FragColor = vec4(c, edge * uOpacity * (0.55 + 0.45 * flow));
  }
`;

const WAVE_VERT = BEAM_VERT;
const WAVE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    float h = vUv.y;
    float bands = 0.5 + 0.5 * sin(vUv.x * 160.0 + uTime * 12.0) * sin(vUv.x * 37.0 - uTime * 7.0);
    float a = pow(1.0 - h, 1.8) * (0.45 + 0.55 * bands) * 0.75;
    vec3 c = uColor * (0.7 + 1.1 * (1.0 - h)) + vec3(0.6) * pow(1.0 - h, 10.0);
    gl_FragColor = vec4(c, a * uOpacity);
  }
`;

interface Beam {
  group: THREE.Group;
  core: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>;
  glow: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>;
  t: number;
  duration: number;
  active: boolean;
}

export interface WaveFx {
  mesh: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>;
  active: boolean;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const tmp = new THREE.Vector3();

function beamMaterial(core: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: BEAM_VERT,
    fragmentShader: BEAM_FRAG,
    uniforms: { uColor: { value: new THREE.Color() }, uTime: { value: 0 }, uOpacity: { value: 1 }, uCore: { value: core } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  });
}

/** Stun beams and ultimate shockwaves. Pooled; nothing allocated during play. */
export class SpellFx {
  private readonly beams: Beam[] = [];
  private readonly waves: WaveFx[] = [];
  private time = 0;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
    geo.translate(0, 0.5, 0); // origin at one end so scale.y = length
    for (let i = 0; i < 3; i++) {
      const group = new THREE.Group();
      const core = new THREE.Mesh(geo, beamMaterial(0.75));
      const glow = new THREE.Mesh(geo, beamMaterial(0));
      core.renderOrder = glow.renderOrder = 12;
      group.add(core, glow);
      group.visible = false;
      scene.add(group);
      this.beams.push({ group, core, glow, t: 0, duration: 0, active: false });
    }
    const waveGeo = new THREE.CylinderGeometry(1, 1, 5, 96, 1, true);
    waveGeo.translate(0, 2.5, 0);
    for (let i = 0; i < 2; i++) {
      const mesh = new THREE.Mesh(waveGeo, new THREE.ShaderMaterial({
        vertexShader: WAVE_VERT, fragmentShader: WAVE_FRAG,
        uniforms: { uColor: { value: new THREE.Color() }, uTime: { value: 0 }, uOpacity: { value: 1 } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
      }));
      mesh.visible = false;
      mesh.renderOrder = 12;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.waves.push({ mesh, active: false });
    }
  }

  beam(from: THREE.Vector3, to: THREE.Vector3, color: number, duration: number, width = 0.07): void {
    const b = this.beams.find((x) => !x.active) ?? this.beams[0];
    b.active = true;
    b.t = 0;
    b.duration = duration;
    const dir = tmp.subVectors(to, from);
    const len = dir.length();
    b.group.position.copy(from);
    b.group.quaternion.setFromUnitVectors(Y_AXIS, dir.divideScalar(len || 1));
    b.core.scale.set(width, len, width);
    b.glow.scale.set(width * 4, len, width * 4);
    b.core.material.uniforms.uColor.value.setHex(color);
    b.glow.material.uniforms.uColor.value.setHex(color);
    b.group.visible = true;
  }

  /** Claim a shockwave mesh; the spell system drives its radius each tick. */
  wave(color: number): WaveFx | null {
    const w = this.waves.find((x) => !x.active);
    if (!w) return null;
    w.active = true;
    w.mesh.material.uniforms.uColor.value.setHex(color);
    w.mesh.visible = true;
    return w;
  }

  setWave(w: WaveFx, center: THREE.Vector3, radius: number, opacity: number): void {
    w.mesh.position.set(center.x, 0, center.z);
    w.mesh.scale.set(radius, 1, radius);
    w.mesh.material.uniforms.uOpacity.value = opacity;
  }

  releaseWave(w: WaveFx): void {
    w.active = false;
    w.mesh.visible = false;
  }

  update(dt: number): void {
    this.time += dt;
    for (const b of this.beams) {
      if (!b.active) continue;
      b.t += dt;
      const p = b.t / b.duration;
      if (p >= 1) {
        b.active = false;
        b.group.visible = false;
        continue;
      }
      const o = 1 - p * p;
      for (const m of [b.core.material, b.glow.material]) {
        m.uniforms.uTime.value = this.time;
        m.uniforms.uOpacity.value = o;
      }
      const pulse = 1 + (1 - p) * 0.6;
      b.core.scale.x = b.core.scale.z = 0.07 * pulse;
    }
    for (const w of this.waves) if (w.active) w.mesh.material.uniforms.uTime.value = this.time;
  }

  clear(): void {
    for (const b of this.beams) {
      b.active = false;
      b.group.visible = false;
    }
    for (const w of this.waves) this.releaseWave(w);
  }
}
