import * as THREE from 'three';
import { ParticleSystem } from './ParticleSystem';
import { glowTexture } from './textures';

const RING_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const RING_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uProgress;
  varying vec2 vUv;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    float w = 0.08 + 0.12 * (1.0 - uProgress);
    float band = smoothstep(uProgress - w, uProgress, r) * (1.0 - smoothstep(uProgress, uProgress + 0.02, r));
    float a = band * (1.0 - uProgress);
    gl_FragColor = vec4(uColor * (1.0 + 2.0 * band), a);
  }
`;

interface Timed {
  active: boolean;
  t: number;
  duration: number;
}

interface Flash extends Timed {
  sprite: THREE.Sprite;
  size: number;
}

interface Ring extends Timed {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  radius: number;
}

interface LightFlash extends Timed {
  light: THREE.PointLight;
  intensity: number;
}

const tmpColor = new THREE.Color();
const tmpPoint = new THREE.Vector3();
const tmpColor2 = new THREE.Color();
const SMOKE = new THREE.Color(0x2a2633);
const WHITE = new THREE.Color(1, 1, 1);

/** High-level effect recipes on top of pooled particles, sprites, rings and lights. */
export class Effects {
  readonly sparks = new ParticleSystem(4000, true);
  readonly smoke = new ParticleSystem(900, false);
  private readonly flashes: Flash[] = [];
  private readonly rings: Ring[] = [];
  private readonly lights: LightFlash[] = [];

  constructor(scene: THREE.Scene) {
    scene.add(this.sparks.points, this.smoke.points);

    for (let i = 0; i < 24; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false,
      }));
      sprite.visible = false;
      sprite.renderOrder = 12;
      scene.add(sprite);
      this.flashes.push({ active: false, t: 0, duration: 0, sprite, size: 1 });
    }

    const ringGeo = new THREE.PlaneGeometry(2, 2);
    for (let i = 0; i < 10; i++) {
      const mesh = new THREE.Mesh(ringGeo, new THREE.ShaderMaterial({
        vertexShader: RING_VERT, fragmentShader: RING_FRAG,
        uniforms: { uColor: { value: new THREE.Color() }, uProgress: { value: 0 } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
      }));
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      mesh.renderOrder = 8;
      scene.add(mesh);
      this.rings.push({ active: false, t: 0, duration: 0, mesh, radius: 1 });
    }

    // Lights always exist (intensity 0 when idle) so the shader light count never changes.
    for (let i = 0; i < 2; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 14, 2);
      scene.add(light);
      this.lights.push({ active: false, t: 0, duration: 0, light, intensity: 0 });
    }
  }

  setPointScale(scale: number): void {
    this.sparks.setPointScale(scale);
    this.smoke.setPointScale(scale);
  }

  /** Small glowing motes left behind a projectile. */
  trail(pos: THREE.Vector3, color: number, size: number, count = 1): void {
    tmpColor.setHex(color);
    for (let i = 0; i < count; i++) {
      this.sparks.emit(
        pos.x + (Math.random() - 0.5) * size * 0.3, pos.y + (Math.random() - 0.5) * size * 0.3, pos.z + (Math.random() - 0.5) * size * 0.3,
        (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.8 + 0.3, (Math.random() - 0.5) * 0.8,
        tmpColor, 2.2, size, 0.22 + Math.random() * 0.12, { drag: 3 },
      );
    }
  }

  /** Burst at the wand when a spell is released. */
  muzzle(pos: THREE.Vector3, dir: THREE.Vector3, color: number, scale = 1): void {
    tmpColor.setHex(color);
    for (let i = 0; i < 6 * scale; i++) {
      const s = 3 + Math.random() * 5;
      this.sparks.emit(pos.x, pos.y, pos.z,
        dir.x * s + (Math.random() - 0.5) * 3, dir.y * s + (Math.random() - 0.5) * 3, dir.z * s + (Math.random() - 0.5) * 3,
        tmpColor, 2.5, 0.12 * scale, 0.18, { drag: 6 });
    }
    this.flash(pos, color, 0.9 * scale, 0.08);
  }

  /** Gunshot at the muzzle: a white-hot flash, a tight cone of fast sparks, a smoke wisp, a light pulse. */
  muzzleFlash(pos: THREE.Vector3, dir: THREE.Vector3, color: number, size: number, light: number, duration: number): void {
    tmpColor.setHex(color).lerp(WHITE, 0.5);
    for (let i = 0; i < 10; i++) {
      const s = 14 + Math.random() * 18;
      this.sparks.emit(pos.x, pos.y, pos.z,
        (dir.x + (Math.random() - 0.5) * 0.25) * s, (dir.y + (Math.random() - 0.5) * 0.25) * s, (dir.z + (Math.random() - 0.5) * 0.25) * s,
        tmpColor, 3.2, 0.05 + Math.random() * 0.04, 0.05 + Math.random() * 0.06, { drag: 9 });
    }
    tmpPoint.copy(pos).addScaledVector(dir, 0.25);
    for (let i = 0; i < 2; i++) {
      this.smoke.emit(tmpPoint.x, tmpPoint.y, tmpPoint.z,
        dir.x * 1.6 + (Math.random() - 0.5) * 0.4, dir.y * 1.6 + 0.3, dir.z * 1.6 + (Math.random() - 0.5) * 0.4,
        tmpColor2.setHex(0x8a8580), 0.55, 0.16, 0.45, { drag: 3, gravity: -0.8, sizeEnd: 0.7 });
    }
    this.flash(tmpPoint.copy(pos).addScaledVector(dir, 0.12), 0xfff2c8, size, duration);
    this.flash(tmpPoint.copy(pos).addScaledVector(dir, 0.4), color, size * 0.55, duration * 0.8);
    // The light pops a little ahead of the barrel: a gun held at the hip doesn't scorch its own leg white.
    this.light(tmpPoint.copy(pos).addScaledVector(dir, 0.6), color, light, duration);
  }

  /** Spell hitting something. */
  impact(pos: THREE.Vector3, normal: THREE.Vector3 | null, color: number, scale = 1): void {
    tmpColor.setHex(color);
    const n = Math.round(14 * scale);
    for (let i = 0; i < n; i++) {
      let x = Math.random() * 2 - 1, y = Math.random() * 2 - 1, z = Math.random() * 2 - 1;
      if (normal) {
        x += normal.x * 1.2; y += normal.y * 1.2; z += normal.z * 1.2;
      }
      const l = Math.hypot(x, y, z) || 1;
      const s = (4 + Math.random() * 7) * Math.sqrt(scale);
      this.sparks.emit(pos.x, pos.y, pos.z, (x / l) * s, (y / l) * s + 1, (z / l) * s,
        Math.random() < 0.3 ? WHITE : tmpColor, 2.5, 0.1 + Math.random() * 0.08 * scale, 0.3 + Math.random() * 0.2,
        { gravity: 9, drag: 2.5 });
    }
    this.flash(pos, color, 1.4 * scale, 0.1);
  }

  /** Big area explosion (Blast, clashes, ultimate). */
  explosion(pos: THREE.Vector3, color: number, radius: number): void {
    tmpColor.setHex(color);
    tmpColor2.copy(tmpColor).lerp(WHITE, 0.6);
    this.sparks.burst(pos, Math.round(50 * radius / 3), tmpColor, 3, radius * 2, radius * 4.5, 0.22, 0.6, { gravity: 6, drag: 2.2 });
    this.sparks.burst(pos, 18, tmpColor2, 3.5, radius * 0.8, radius * 2.5, 0.35, 0.35, { drag: 4 });
    for (let i = 0; i < 14; i++) {
      this.smoke.emit(
        pos.x + (Math.random() - 0.5) * radius, pos.y + Math.random() * 0.5, pos.z + (Math.random() - 0.5) * radius,
        (Math.random() - 0.5) * 3, 1 + Math.random() * 2, (Math.random() - 0.5) * 3,
        SMOKE, 1, 1.2 + Math.random() * radius * 0.5, 0.9 + Math.random() * 0.6,
        { drag: 1.5, gravity: -0.6, sizeEnd: 2.5 + radius * 0.6 },
      );
    }
    this.flash(pos, color, radius * 2.4, 0.16);
    this.flash(pos, 0xffffff, radius * 1.1, 0.08);
    this.ring(pos, color, radius * 1.2, 0.4);
    this.light(pos, color, 40 * radius / 3, 0.25);
  }

  /** Two spells colliding mid-air. */
  clash(pos: THREE.Vector3, colorA: number, colorB: number, scale: number): void {
    this.sparks.burst(pos, 26, tmpColor.setHex(colorA), 3, 5, 12 * scale, 0.16, 0.45, { gravity: 4, drag: 2 });
    this.sparks.burst(pos, 26, tmpColor.setHex(colorB), 3, 5, 12 * scale, 0.16, 0.45, { gravity: 4, drag: 2 });
    this.flash(pos, 0xffffff, 2.2 * scale, 0.12);
    this.light(pos, 0xffffff, 25 * scale, 0.15);
  }

  /** Dust and chips (pillar hits, crumbles). */
  dust(pos: THREE.Vector3, amount: number, spread: number): void {
    for (let i = 0; i < amount; i++) {
      this.smoke.emit(
        pos.x + (Math.random() - 0.5) * spread, pos.y + Math.random() * spread * 0.5, pos.z + (Math.random() - 0.5) * spread,
        (Math.random() - 0.5) * 2, Math.random() * 1.5, (Math.random() - 0.5) * 2,
        tmpColor.setHex(0x6d6670), 1, 0.6 + Math.random() * 0.8, 0.8 + Math.random() * 0.8,
        { drag: 1.2, gravity: -0.3, sizeEnd: 2.2 },
      );
    }
  }

  /** Dust burst and a team-colored streak where a roll starts. */
  roll(pos: THREE.Vector3, dir: THREE.Vector3, color: number): void {
    this.dust(tmpPoint.set(pos.x, pos.y + 0.15, pos.z), 6, 0.6);
    tmpColor.setHex(color);
    for (let i = 0; i < 12; i++) {
      const s = 2 + Math.random() * 4;
      this.sparks.emit(
        pos.x + (Math.random() - 0.5) * 0.5, pos.y + 0.4 + Math.random() * 1.2, pos.z + (Math.random() - 0.5) * 0.5,
        -dir.x * s, Math.random() * 0.5, -dir.z * s,
        tmpColor, 1.8, 0.12, 0.25, { drag: 5 },
      );
    }
  }

  /** A puff of dust kicked up by running feet. */
  footDust(pos: THREE.Vector3): void {
    this.smoke.emit(
      pos.x + (Math.random() - 0.5) * 0.4, 0.1, pos.z + (Math.random() - 0.5) * 0.4,
      (Math.random() - 0.5) * 0.6, 0.4 + Math.random() * 0.4, (Math.random() - 0.5) * 0.6,
      tmpColor.setHex(0x5d5662), 0.8, 0.35, 0.5, { drag: 2, sizeEnd: 0.9 },
    );
  }

  flash(pos: THREE.Vector3, color: number, size: number, duration: number): void {
    const f = this.take(this.flashes);
    if (!f) return;
    f.sprite.position.copy(pos);
    f.sprite.material.color.setHex(color).multiplyScalar(3);
    f.size = size;
    f.duration = duration;
    f.sprite.visible = true;
  }

  ring(pos: THREE.Vector3, color: number, radius: number, duration: number): void {
    const r = this.take(this.rings);
    if (!r) return;
    r.mesh.position.set(pos.x, 0.05, pos.z);
    r.mesh.material.uniforms.uColor.value.setHex(color).multiplyScalar(2);
    r.radius = radius;
    r.duration = duration;
    r.mesh.visible = true;
  }

  light(pos: THREE.Vector3, color: number, intensity: number, duration: number): void {
    const l = this.take(this.lights) ?? this.lights[0];
    l.active = true;
    l.t = 0;
    l.light.position.copy(pos);
    l.light.color.setHex(color);
    l.intensity = intensity;
    l.duration = duration;
  }

  private take<T extends Timed>(pool: T[]): T | null {
    let oldest: T | null = null;
    for (const item of pool) {
      if (!item.active) {
        oldest = item;
        break;
      }
      if (!oldest || item.t / item.duration > oldest.t / oldest.duration) oldest = item;
    }
    if (oldest) {
      oldest.active = true;
      oldest.t = 0;
    }
    return oldest;
  }

  update(dt: number): void {
    this.sparks.update(dt);
    this.smoke.update(dt);
    for (const f of this.flashes) {
      if (!f.active) continue;
      f.t += dt;
      const p = f.t / f.duration;
      if (p >= 1) {
        f.active = false;
        f.sprite.visible = false;
        continue;
      }
      f.sprite.scale.setScalar(f.size * (0.6 + 0.6 * p));
      f.sprite.material.opacity = 1 - p * p;
    }
    for (const r of this.rings) {
      if (!r.active) continue;
      r.t += dt;
      const p = r.t / r.duration;
      if (p >= 1) {
        r.active = false;
        r.mesh.visible = false;
        continue;
      }
      r.mesh.scale.setScalar(r.radius);
      r.mesh.material.uniforms.uProgress.value = 1 - (1 - p) * (1 - p);
    }
    for (const l of this.lights) {
      if (!l.active) continue;
      l.t += dt;
      const p = l.t / l.duration;
      if (p >= 1) {
        l.active = false;
        l.light.intensity = 0;
        continue;
      }
      l.light.intensity = l.intensity * (1 - p);
    }
  }

  clear(): void {
    this.sparks.clear();
    this.smoke.clear();
    for (const f of this.flashes) {
      f.active = false;
      f.sprite.visible = false;
    }
    for (const r of this.rings) {
      r.active = false;
      r.mesh.visible = false;
    }
    for (const l of this.lights) {
      l.active = false;
      l.light.intensity = 0;
    }
  }
}
