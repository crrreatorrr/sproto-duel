import * as THREE from 'three';

/** Pooled stone chunks (one InstancedMesh) with cheap ballistic physics and floor bounces. */
export class Debris {
  private readonly mesh: THREE.InstancedMesh;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly rot: Float32Array;
  private readonly spin: Float32Array;
  private readonly scale: Float32Array;
  private readonly life: Float32Array;
  private next = 0;
  private readonly dummy = new THREE.Object3D();
  /** The material the debris was built with (the moonlit look). */
  readonly defaultMaterial: THREE.Material;

  /** `floor`: how far a chunk's centre rests above the floor per unit of its scale (the default rock's radius). */
  constructor(scene: THREE.Scene, private readonly capacity = 160, material?: THREE.Material, geometry?: THREE.BufferGeometry, private readonly floor = 0.22) {
    this.defaultMaterial = material ?? new THREE.MeshStandardMaterial({ color: 0x8a8394, roughness: 0.95, flatShading: true });
    this.mesh = new THREE.InstancedMesh(
      geometry ?? new THREE.DodecahedronGeometry(0.22, 0),
      this.defaultMaterial,
      capacity,
    );
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.rot = new Float32Array(capacity * 3);
    this.spin = new Float32Array(capacity * 3);
    this.scale = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, this.dummy.matrix);
    scene.add(this.mesh);
  }

  private emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    for (let k = 0; k < 3; k++) {
      this.rot[i3 + k] = Math.random() * 6.28;
      this.spin[i3 + k] = (Math.random() - 0.5) * 14;
    }
    this.scale[i] = size;
    this.life[i] = life;
  }

  /** Show or hide the whole pool (a pool unused by the current arena costs no draw call). */
  set visible(v: boolean) {
    this.mesh.visible = v;
  }

  get material(): THREE.Material {
    return this.mesh.material as THREE.Material;
  }

  /** Re-skin the chunks for an environment theme. */
  setMaterial(material: THREE.Material): void {
    this.mesh.material = material;
  }

  /** Small chips flying off a hit point. */
  spawn(point: THREE.Vector3, count: number, size: number): void {
    for (let k = 0; k < count; k++) {
      this.emit(point.x, point.y, point.z,
        (Math.random() - 0.5) * 6, 2 + Math.random() * 4, (Math.random() - 0.5) * 6,
        size * (0.3 + Math.random() * 0.5), 1.2 + Math.random());
    }
  }

  /** One piece thrown from `point` at a given velocity (a spent casing ejected from a gun). */
  throw(point: THREE.Vector3, vx: number, vy: number, vz: number, size: number, life: number): void {
    this.emit(point.x, point.y, point.z, vx, vy, vz, size, life);
  }

  /** Re-shape the chunks for an environment theme (e.g. flat partition panels in the office). */
  setGeometry(geometry: THREE.BufferGeometry): void {
    this.mesh.geometry = geometry;
  }

  get geometry(): THREE.BufferGeometry {
    return this.mesh.geometry;
  }

  /** A whole column collapsing (chunks start between `minY` and `minY + height`). */
  spawnColumn(base: THREE.Vector3, height: number, radius: number, count: number, minY = 0.8): void {
    for (let k = 0; k < count; k++) {
      const a = Math.random() * Math.PI * 2;
      const y = minY + Math.random() * height;
      const out = 1 + Math.random() * 4;
      this.emit(base.x + Math.cos(a) * radius * 0.8, y, base.z + Math.sin(a) * radius * 0.8,
        Math.cos(a) * out, Math.random() * 3, Math.sin(a) * out,
        1.2 + Math.random() * 1.6, 2.5 + Math.random() * 1.5);
    }
  }

  update(dt: number): void {
    if (dt <= 0) return;
    const d = this.dummy;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const i3 = i * 3;
      this.vel[i3 + 1] -= 22 * dt;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const r = this.floor * this.scale[i];
      if (this.pos[i3 + 1] < r) {
        this.pos[i3 + 1] = r;
        this.vel[i3 + 1] *= -0.3;
        this.vel[i3] *= 0.6;
        this.vel[i3 + 2] *= 0.6;
        for (let k = 0; k < 3; k++) this.spin[i3 + k] *= 0.6;
      }
      for (let k = 0; k < 3; k++) this.rot[i3 + k] += this.spin[i3 + k] * dt;
      const fade = Math.min(1, this.life[i] / 0.4);
      d.position.set(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2]);
      d.rotation.set(this.rot[i3], this.rot[i3 + 1], this.rot[i3 + 2]);
      d.scale.setScalar(this.life[i] > 0 ? this.scale[i] * fade : 0);
      d.updateMatrix();
      this.mesh.setMatrixAt(i, d.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let i = 0; i < this.capacity; i++) {
      this.life[i] = 0;
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
