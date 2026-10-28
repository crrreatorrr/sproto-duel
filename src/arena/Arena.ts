import * as THREE from 'three';
import { CONFIG } from '../config';
import type { AssetLoader } from '../assets/AssetLoader';
import { arenaFloorTexture, glowTexture, stoneTexture } from '../fx/textures';
import type { Physics } from '../physics/Physics';
import { Debris } from './Debris';
import { Pillar } from './Pillar';
import type { ArenaThemeId } from './themes';

const A = CONFIG.arena;
/** Visible wall height; the collider matches it so spells never burst on invisible geometry. */
const WALL_HEIGHT = 1.4;

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }
`;
const SKY_FRAG = /* glsl */ `
  varying vec3 vDir;
  float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
  void main() {
    float h = vDir.y;
    vec3 top = vec3(0.025, 0.03, 0.09);
    vec3 mid = vec3(0.12, 0.07, 0.2);
    vec3 horizon = vec3(0.32, 0.13, 0.22);
    vec3 c = mix(horizon, mid, smoothstep(-0.05, 0.18, h));
    c = mix(c, top, smoothstep(0.18, 0.7, h));
    // Stars.
    vec3 cell = floor(vDir * 220.0);
    float s = hash(cell);
    float star = step(0.997, s) * smoothstep(0.05, 0.3, h);
    c += vec3(star) * (0.25 + 0.35 * hash(cell + 1.0));
    // Moon.
    vec3 moonDir = normalize(vec3(-0.45, 0.42, -0.78));
    float m = dot(vDir, moonDir);
    c += vec3(0.9, 0.95, 1.2) * smoothstep(0.9988, 0.9993, m) * 1.6;
    c += vec3(0.25, 0.3, 0.5) * pow(max(m, 0.0), 60.0) * 0.5;
    gl_FragColor = vec4(c, 1.0);
  }
`;

export class Arena {
  readonly pillars: Pillar[] = [];
  readonly debris: Debris;
  /** Current inner radius of the fire ring (shrinks during sudden death). */
  fireRadius: number = A.fireRadius;
  /** Active environment theme. */
  theme: ArenaThemeId = 'moonlit';
  private time = 0;
  private readonly brazierFlames: THREE.Sprite[] = [];

  constructor(scene: THREE.Scene, physics: Physics, assets: AssetLoader) {
    scene.background = new THREE.Color(0x07060f);
    scene.fog = new THREE.Fog(0x140c22, 34, 95);

    this.buildSky(scene, assets);
    this.buildLights(scene);
    this.buildFloor(scene, assets);
    this.buildWall(scene, assets);
    this.buildBraziers(scene, assets);

    physics.addFloor(A.floorRadius + 10);
    physics.addRingWall(A.wallRadius, WALL_HEIGHT);

    this.debris = this.makeDebris(scene, assets);
    const stone = assets.texture('pillar') ?? stoneTexture();
    const P = A.pillars;
    for (let i = 0; i < P.count; i++) {
      // Offset by half a step so pillars never sit on the spawn line (z axis).
      const a = ((i + 0.5) / P.count) * Math.PI * 2;
      this.pillars.push(new Pillar(scene, physics, Math.sin(a) * P.ringRadius, Math.cos(a) * P.ringRadius, stone, assets, this.debris));
    }
  }

  private buildSky(scene: THREE.Scene, assets: AssetLoader): void {
    const tex = assets.texture('sky');
    if (tex) {
      tex.mapping = THREE.EquirectangularReflectionMapping;
      scene.background = tex;
      return;
    }
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(300, 32, 16),
      new THREE.ShaderMaterial({ vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false }),
    );
    sky.renderOrder = -1;
    scene.add(sky);
  }

  private buildLights(scene: THREE.Scene): void {
    scene.add(new THREE.HemisphereLight(0x6a78c8, 0x2a1a24, 1.1));
    const moon = new THREE.DirectionalLight(0xc4d2ff, 2.2);
    moon.position.set(-14, 28, -18);
    moon.castShadow = CONFIG.render.shadows;
    const s = moon.shadow;
    s.mapSize.set(CONFIG.render.shadowMapSize, CONFIG.render.shadowMapSize);
    const ext = A.wallRadius + 2;
    s.camera.left = -ext;
    s.camera.right = ext;
    s.camera.top = ext;
    s.camera.bottom = -ext;
    s.camera.near = 5;
    s.camera.far = 80;
    s.bias = -0.0008;
    s.normalBias = 0.03;
    scene.add(moon);
    // Warm bounce from the fire ring.
    const fire = new THREE.DirectionalLight(0xff7a3a, 0.35);
    fire.position.set(10, 3, 14);
    scene.add(fire);
  }

  private buildFloor(scene: THREE.Scene, assets: AssetLoader): void {
    const map = assets.texture('floor') ?? arenaFloorTexture();
    const material = new THREE.MeshStandardMaterial({ map, roughness: 0.92, metalness: 0.02 });
    const normalMap = assets.texture('floorNormal');
    if (normalMap) material.normalMap = normalMap;
    const floor = new THREE.Mesh(new THREE.CircleGeometry(A.wallRadius + 0.6, 96), material);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // Dark ground outside the wall.
    const outer = new THREE.Mesh(
      new THREE.RingGeometry(A.wallRadius + 0.5, 140, 64, 1),
      new THREE.MeshStandardMaterial({ color: 0x1a1420, roughness: 1 }),
    );
    outer.rotation.x = -Math.PI / 2;
    outer.position.y = -0.02;
    outer.receiveShadow = true;
    scene.add(outer);
  }

  /** Uses the generated debris chunk if present, otherwise flat-shaded dodecahedrons. */
  private makeDebris(scene: THREE.Scene, assets: AssetLoader): Debris {
    const model = assets.instantiate('pillarDebris');
    let mesh: THREE.Mesh | null = null;
    model?.root.updateMatrixWorld(true);
    model?.root.traverse((o) => {
      if (!mesh && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh;
    });
    if (!mesh) return new Debris(scene);
    const m = mesh as THREE.Mesh;
    // Bake the fitted transform, then normalize to the 0.22 m chunk radius the debris sim expects.
    const geo = m.geometry.clone().applyMatrix4(m.matrixWorld);
    geo.center();
    geo.computeBoundingSphere();
    const k = 0.22 / (geo.boundingSphere!.radius || 1);
    geo.scale(k, k, k);
    return new Debris(scene, 160, m.material as THREE.Material, geo);
  }

  private buildBraziers(scene: THREE.Scene, assets: AssetLoader): void {
    const count = 8;
    const bowlMat = new THREE.MeshStandardMaterial({ color: 0x3a3030, roughness: 0.6, metalness: 0.5 });
    for (let i = 0; i < count; i++) {
      const a = ((i + 0.5) / count) * Math.PI * 2 + Math.PI / count;
      const r = A.wallRadius + 0.45;
      const group = new THREE.Group();
      group.position.set(Math.sin(a) * r, 1.4, Math.cos(a) * r);
      const model = assets.instantiate('brazier');
      if (model) {
        group.add(model.root);
      } else {
        const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.22, 0.35, 12, 1, true), bowlMat);
        bowl.position.y = 0.32;
        bowl.castShadow = true;
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.12, 0.3, 8), bowlMat);
        stem.position.y = 0.08;
        group.add(bowl, stem);
      }
      const flame = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture(), color: new THREE.Color(1.0, 0.45, 0.12).multiplyScalar(2.2),
        blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false,
      }));
      flame.position.y = 0.75;
      flame.scale.set(1.0, 1.4, 1);
      group.add(flame);
      this.brazierFlames.push(flame);
      scene.add(group);
    }
  }

  private buildWall(scene: THREE.Scene, assets: AssetLoader): void {
    const stone = stoneTexture().clone();
    stone.repeat.set(24, 1);
    stone.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({ map: stone, roughness: 0.95, color: 0x8a8296, side: THREE.DoubleSide });
    const r = A.wallRadius;
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(r, r, WALL_HEIGHT, 96, 1, true), mat);
    wall.position.y = WALL_HEIGHT / 2;
    wall.receiveShadow = true;
    scene.add(wall);
    const cap = new THREE.Mesh(new THREE.RingGeometry(r, r + 0.8, 96), mat);
    cap.rotation.x = -Math.PI / 2;
    cap.position.y = WALL_HEIGHT;
    scene.add(cap);
    const outerFace = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.8, r + 0.8, WALL_HEIGHT, 96, 1, true), mat);
    outerFace.position.y = WALL_HEIGHT / 2;
    scene.add(outerFace);

    // Decorative ruins outside the wall: the generated model if present, else standing stones.
    const ruins = assets.instantiate('arenaRuins');
    if (ruins) {
      for (let i = 0; i < 6; i++) {
        const copy = i === 0 ? ruins.root : ruins.root.clone(true);
        const a = (i / 6) * Math.PI * 2 + 0.3;
        copy.position.set(Math.sin(a) * (A.wallRadius + 7), 0, Math.cos(a) * (A.wallRadius + 7));
        copy.rotation.y = a + Math.PI;
        scene.add(copy);
      }
      return;
    }
    const count = 28;
    const stones = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x3c3646, roughness: 1, flatShading: true }),
      count,
    );
    const d = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + (i % 3) * 0.05;
      const rr = A.wallRadius + 5 + (i % 4) * 1.6;
      const h = 3 + ((i * 37) % 7);
      d.position.set(Math.sin(a) * rr, h / 2 - 0.3, Math.cos(a) * rr);
      d.rotation.set(((i * 13) % 5) * 0.03, -a, ((i * 7) % 5) * 0.04);
      d.scale.set(1.6, h, 1.1);
      d.updateMatrix();
      stones.setMatrixAt(i, d.matrix);
    }
    stones.castShadow = true;
    scene.add(stones);
  }

  /** Switch the environment (sky, fog, lighting, floor, pillars, props, fire colour). */
  applyTheme(id: ArenaThemeId): void {
    this.theme = id;
  }

  reset(): void {
    this.fireRadius = A.fireRadius;
    for (const p of this.pillars) p.reset();
    this.debris.clear();
  }

  update(dt: number): void {
    this.time += dt;
    for (let i = 0; i < this.brazierFlames.length; i++) {
      const f = this.brazierFlames[i];
      const flicker = 1 + Math.sin(this.time * 17 + i * 3.1) * 0.08 + Math.sin(this.time * 31 + i) * 0.05;
      f.scale.set(1.0 * flicker, 1.4 * flicker, 1);
    }
    for (const p of this.pillars) p.update(dt, this.time);
    this.debris.update(dt);
  }
}
